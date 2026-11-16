# Both bundle installers run under an exclusive per-engine lock. Never traverse links in a retained tree.
function Get-StageDigest($Directory) {
    $files = [Collections.Generic.SortedDictionary[string,string]]::new([StringComparer]::Ordinal)
    $stack = [Collections.Generic.Stack[string]]::new()
    $stack.Push($Directory)
    while ($stack.Count) {
        foreach ($item in [IO.DirectoryInfo]::new($stack.Pop()).EnumerateFileSystemInfos()) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return '' }
            if ($item -is [IO.DirectoryInfo]) { $stack.Push($item.FullName); continue }
            $name = $item.FullName.Substring($Directory.Length + 1).Replace('\','/')
            $files.Add($name, (Hash $item.FullName))
        }
    }
    $list = [Text.StringBuilder]::new()
    foreach ($item in $files.GetEnumerator()) { [void]$list.Append($item.Value).Append('  ').Append($item.Key).Append([char]10) }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($list.ToString()))).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

# PowerShell 5.1 may follow directory junctions during recursive removal. Delete links as leaves.
function Remove-EngineTree([string]$Directory) {
    $item = [IO.DirectoryInfo]::new($Directory)
    if (-not $item.Exists) { return }
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        foreach ($child in $item.EnumerateFileSystemInfos()) {
            if ($child -is [IO.DirectoryInfo]) { Remove-EngineTree $child.FullName } else { $child.Delete() }
        }
    }
    $item.Delete()
}

function Install-CheckedBundle($Engine,$Root,$Archive,$Entry,$Target,$ArchivePath) {
    $stage = Join-Path $Root 's-cache'
    $destination = Join-Path $Root 'runtime'
    $backup = Join-Path $Root 'runtime-previous'
    foreach ($path in @($stage,$destination,$backup)) {
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)) -ne $Root.TrimEnd('\')) { throw 'Unsafe installation path' }
        if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation directory cannot be a link' }
    }
    # The previous runtime is the recovery point until final-path verification succeeds.
    if (Test-Path -LiteralPath $backup) {
        if (Test-Path -LiteralPath $destination) {
            Remove-EngineTree $stage
            Move-Item -LiteralPath $destination -Destination $stage
        }
        Move-Item -LiteralPath $backup -Destination $destination
    }
    $reused = $false
    if (Test-Path -LiteralPath $stage) {
        if ($Entry.requirements.treeSha256 -and (Get-Item -LiteralPath $stage).LastWriteTimeUtc -gt [DateTime]::UtcNow.AddDays(-7)) {
            Progress 'checksum' 'Verifying retained staging files'
            $reused = (Get-StageDigest $stage) -eq $Entry.requirements.treeSha256
        }
        if (-not $reused) { Remove-EngineTree $stage }
    }
    if (-not $reused) {
        Progress 'extract' 'Extracting verified engine'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
        try {
            $required = [long](($zip.Entries | Measure-Object -Property Length -Sum).Sum)
            $volume = [IO.Path]::GetPathRoot($Root)
            if ($volume -match '^[A-Za-z]:' -and [IO.DriveInfo]::new($volume).AvailableFreeSpace -lt $required) {
                Write-PDFInstallError 'disk' 'extract'; throw "Insufficient disk space: need $required free bytes."
            }
            [IO.Directory]::CreateDirectory($stage) | Out-Null
            $index = 0
            foreach ($file in $zip.Entries) {
                $path = [IO.Path]::GetFullPath((Join-Path $stage $file.FullName))
                if (-not $path.StartsWith($stage + '\',[StringComparison]::OrdinalIgnoreCase) -or $file.FullName.Contains(':')) { throw 'Unsafe archive entry' }
                if (-not $file.Name) { continue }
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($file,$path,$false)
                if ((++$index % 200) -eq 0) { Progress 'extract' 'Extracting engine' $index $zip.Entries.Count }
            }
        } catch { Remove-EngineTree $stage; throw } finally { $zip.Dispose() }
    }

    $meta = Get-Content -LiteralPath (Join-Path $stage 'bundle.json') -Raw | ConvertFrom-Json
    $python = Join-Path $stage 'python/python.exe'
    if ($meta.platform -ne $Target -or $meta.version -ne $Entry.version -or $meta.engine -ne $Entry.engine -or ('windows-' + (Get-PythonArchitecture $python)) -ne $Target) {
        Write-PDFInstallError 'integrity' 'verify'; throw 'Engine identity mismatch'
    }
    $env:PYTHONDONTWRITEBYTECODE = '1'
    Test-EngineNative $Engine $python $Root $Entry.requirements.msvcMinVersion $ArchivePath
    if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination $backup }
    $moved = $false
    try {
        Move-Item -LiteralPath $stage -Destination $destination
        $moved = $true
        $python = Join-Path $destination 'python/python.exe'
        if ($Engine -eq 'ocr') {
            Progress 'offline' 'Checking offline service and OCR recognition'
            $env:HF_HUB_OFFLINE = '1'; $env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
            $env:JADENSE_OCR_MODEL_SOURCE = 'modelscope'
            & $python -s (Join-Path $Root 'server.py') --verify-models $destination
        } else {
            Progress 'check' 'Checking offline PDF rendering and layout inference'
            $config = ConvertTo-Json -Compress @{operation='check';root=$destination;assetRoot=(Join-Path $destination 'assets')}
            $config | & $python -s (Join-Path $Root 'worker.py')
        }
        if ($LASTEXITCODE -ne 0) { throw "Offline engine check failed (exit $LASTEXITCODE). See installation diagnostics." }
    } catch {
        if ($moved) { Move-Item -LiteralPath $destination -Destination $stage }
        if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destination }
        throw
    }
    # Rename before cleanup so interruption while deleting old files cannot restore half a backup.
    if (Test-Path -LiteralPath $backup) {
        $discard = Join-Path $Root ('verified-old-' + [Guid]::NewGuid().ToString('N'))
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($discard)) -ne $Root.TrimEnd('\')) { throw 'Unsafe backup path' }
        Move-Item -LiteralPath $backup -Destination $discard
        try { Remove-EngineTree $discard } catch { Write-Warning 'Old engine cleanup incomplete' }
    }
    Progress 'installed' 'Offline package installed and verified'
}
