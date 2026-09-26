param([Parameter(Mandatory=$true)][string]$RuntimeDirectory, [string]$ArchivePath = '')
# 自动下载使用 XPI 清单校验；用户明确选择的离线 ZIP 直接导入。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
if (-not $env:PATHEXT) { $env:PATHEXT = '.COM;.EXE;.BAT;.CMD' }
$root = [IO.Path]::GetFullPath($RuntimeDirectory)
. (Join-Path $PSScriptRoot 'install-network.ps1')
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = ''; $env:PYTHONHOME = ''
function Progress($stage, $message, $bytes = 0, $total = 0) {
    Write-Output ('JADENSE_OCR_PROGRESS ' + (ConvertTo-Json -Compress @{ stage=$stage; file=$message; completed=$bytes; total=$total; unit='B' }))
}
function Hash($file) {
    $stream = [IO.File]::OpenRead($file); $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$target = if ($nativeArch -eq 'ARM64') { 'windows-arm64' } else { 'windows-x64' }
$catalog = Get-Content -LiteralPath (Join-Path $root 'bundles.json') -Raw | ConvertFrom-Json
$entry = $catalog.$target
if (-not $entry -or (-not $ArchivePath -and $entry.sha256 -notmatch '^[a-f0-9]{64}$')) { throw "No offline package for $target. Use the manual installation guide." }
if (-not $ArchivePath -and -not $entry.published) { throw 'This package is not published yet. Import the offline ZIP.' }
$archive = if ($ArchivePath) { [IO.Path]::GetFullPath($ArchivePath) } else { Join-Path $root ($entry.file + '.part') }
if (-not $ArchivePath) {
    Initialize-PDFNetwork
    $downloaded = $false
    $category = 'network'
    foreach ($url in $entry.urls) {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $response = $null; $inputStream = $null; $outputStream = $null
            try {
                $offset = if (Test-Path -LiteralPath $archive) { (Get-Item -LiteralPath $archive).Length } else { 0 }
                if ($offset -ne [long]$entry.size) {
                    if ($offset -gt [long]$entry.size) { [IO.File]::WriteAllBytes($archive, [byte[]]@()); $offset = 0 }
                    Progress 'download' "Downloading engine (attempt $attempt/3)" $offset $entry.size
                    $request = [Net.HttpWebRequest]::Create($url)
                    $request.Timeout = 60000; $request.ReadWriteTimeout = 60000
                    $request.UserAgent = 'Jadense-OCR-Engine'; $request.AllowAutoRedirect = $true
                    if ($offset -gt 0) { $request.AddRange([long]$offset) }
                    $response = $request.GetResponse()
                    if ($offset -gt 0 -and [int]$response.StatusCode -ne 206) { $offset = 0 }
                    if ($offset -gt 0 -and $response.Headers['Content-Range'] -notlike "bytes $offset-*") { throw 'Invalid resume response' }
                    $mode = if ($offset -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
                    $outputStream = [IO.File]::Open($archive, $mode, [IO.FileAccess]::Write)
                    $inputStream = $response.GetResponseStream()
                    $buffer = New-Object byte[] 262144
                    $last = [DateTime]::UtcNow
                    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $outputStream.Write($buffer, 0, $count); $offset += $count
                        if (([DateTime]::UtcNow - $last).TotalMilliseconds -ge 500) {
                            Progress 'download' 'Downloading engine' $offset $entry.size; $last = [DateTime]::UtcNow
                        }
                    }
                    $outputStream.Dispose(); $outputStream = $null
                }
                if ($offset -lt [long]$entry.size) { throw 'Download incomplete; retaining bytes for resume' }
                Progress 'verify' 'Verifying download' $offset $entry.size
                if ((Hash $archive) -ne $entry.sha256) {
                    [IO.File]::WriteAllBytes($archive, [byte[]]@())
                    $mismatch = [IO.InvalidDataException]::new('Engine checksum mismatch; downloading again')
                    $mismatch.Data['PDFCategory'] = 'integrity'
                    throw $mismatch
                }
                $downloaded = $true; break
            } catch {
                # 不输出带查询参数的请求地址、代理凭据或响应内容。
                $category = if ($_.Exception.Data['PDFCategory']) { $_.Exception.Data['PDFCategory'] } else { Get-PDFDownloadFailure $_ }
                if ($category -in @('proxy', 'tls', 'http', 'permission', 'disk')) { break }
                if ($attempt -lt 3) { Progress 'retry' "Download interrupted (attempt $attempt/3); keeping completed bytes" }
                if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
            } finally {
                if ($outputStream) { $outputStream.Dispose() }; if ($inputStream) { $inputStream.Dispose() }; if ($response) { $response.Dispose() }
            }
        }
        if ($downloaded) { break }
    }
    if (-not $downloaded) { Write-PDFInstallError $category 'download'; throw 'Engine download failed. Retry to resume, or download the offline ZIP from GitHub and import it.' }
}
if (-not $ArchivePath) {
    Progress 'verify' 'Verifying download'
    if ((Hash $archive) -ne $entry.sha256) {
        # 损坏的自动下载分段不能永久阻止重试。
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($archive)) -eq $root.TrimEnd('\')) { Remove-Item -LiteralPath $archive -Force }
        Write-PDFInstallError 'integrity' 'verify'
        throw 'Engine download is incomplete. Retry the download or import the offline ZIP.'
    }
}
# 短暂存目录避免深层 Zotero profile 与依赖包长文件名叠加触发 MAX_PATH。
$stage = Join-Path $root ('s-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$destination = Join-Path $root 'runtime'
$backup = Join-Path $root ('runtime-backup-' + [Guid]::NewGuid().ToString('N'))
# 删除和移动只涉及 root 中明确生成的目录，不接触 tasks 或用户文献。
foreach ($path in @($stage, $destination, $backup)) {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)) -ne $root.TrimEnd('\')) { throw 'Unsafe installation path' }
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation directory cannot be a link' }
}
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Progress 'extract' 'Extracting engine'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $index = 0
        foreach ($file in $zip.Entries) {
            $path = [IO.Path]::GetFullPath((Join-Path $stage $file.FullName))
            if (-not $path.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase) -or $file.FullName.Contains(':')) { throw 'Unsafe archive entry' }
            if (-not $file.Name) { continue }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($file, $path, $false)
            $index++
            if ($index % 200 -eq 0) { Progress 'extract' 'Extracting engine' $index $zip.Entries.Count }
        }
    } finally { $zip.Dispose() }
    Progress 'offline' 'Checking offline Python and OCR recognition'
    $env:HF_HUB_OFFLINE = '1'
    $env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
    $env:JADENSE_OCR_MODEL_SOURCE = 'modelscope'
    & (Join-Path $stage 'python/python.exe') -s (Join-Path $root 'server.py') --verify-models $stage
    if ($LASTEXITCODE -ne 0) { throw "Offline engine check failed (exit $LASTEXITCODE); the previous installation was retained." }
    if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination $backup }
    try { Move-Item -LiteralPath $stage -Destination $destination }
    catch { if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destination }; throw }
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
    Progress 'installed' 'Offline package installed'
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
