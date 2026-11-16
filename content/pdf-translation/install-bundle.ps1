param([Parameter(Mandatory=$true)][string]$RuntimeDirectory, [string]$ArchivePath = '')
# 自动下载使用 XPI 清单校验；离线 ZIP 在执行任何包内代码之前也校验同一摘要。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
if (-not $env:PATHEXT) { $env:PATHEXT = '.COM;.EXE;.BAT;.CMD' }
$root = [IO.Path]::GetFullPath($RuntimeDirectory)
. (Join-Path $PSScriptRoot 'install-network.ps1')
. (Join-Path $PSScriptRoot 'install-environment.ps1')
. (Join-Path $PSScriptRoot 'install-stage.ps1')
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONPATH = ''; $env:PYTHONHOME = ''
function Progress($stage, $message, $bytes = 0, $total = 0) {
    Save-EngineStage $root $stage
    Write-Output (ConvertTo-Json -Compress @{ type='progress'; stage=$stage; message=$message; bytes=$(if ($stage -ne 'extract') { $bytes } else { 0 }); completed=$bytes; total=$total; unit=$(if ($stage -eq 'extract') { 'files' } else { 'B' }) })
}
function Hash($file) {
    $stream = [IO.File]::OpenRead($file); $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$arch = Get-EngineArchitecture
$target = 'windows-' + $arch
$catalog = Get-Content -LiteralPath (Join-Path $root 'bundles.json') -Raw | ConvertFrom-Json
$entry = $catalog.$target
if (-not $entry -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw "No offline package for $target. Use the manual installation guide." }
$archive = if ($ArchivePath) { [IO.Path]::GetFullPath($ArchivePath) } else { Join-Path $root ($entry.file + '.part') }
# An exclusive OS handle also releases on process death; a stale filename never blocks retry.
$installLock = [IO.File]::Open((Join-Path $root 'bundle-install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
Save-EngineStage $root 'environment'
if (-not $ArchivePath) {
    Initialize-EngineMSVC 'pdf' $arch $root $entry.requirements.msvcMinVersion $ArchivePath
    $downloaded = $false
    $volume = [IO.Path]::GetPathRoot($root)
    $existing = if (Test-Path -LiteralPath $archive) { (Get-Item -LiteralPath $archive).Length } else { 0 }
    $staged = Test-Path -LiteralPath (Join-Path $root 's-cache')
    $required = [Math]::Max([long]0, [long]$entry.size - $existing)
    if (-not $staged) { $required += [long]$entry.requirements.unpackedBytes }
    if ($volume -match '^[A-Za-z]:' -and [IO.DriveInfo]::new($volume).AvailableFreeSpace -lt $required) { Write-PDFInstallError 'disk' 'download'; throw "Insufficient disk space: need $required free bytes." }
    $category = 'network'
    foreach ($url in $entry.urls) {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $response = $null; $inputStream = $null; $outputStream = $null
            try {
                $offset = if (Test-Path -LiteralPath $archive) { (Get-Item -LiteralPath $archive).Length } else { 0 }
                if ($offset -ne [long]$entry.size) {
                    if ($offset -gt [long]$entry.size) { [IO.File]::WriteAllBytes($archive, [byte[]]@()); $offset = 0 }
                    Progress 'download' "Downloading engine (attempt $attempt/3)" $offset $entry.size
                    Initialize-PDFNetwork
                    $request = [Net.HttpWebRequest]::Create($url)
                    $request.Timeout = 60000; $request.ReadWriteTimeout = 60000
                    $request.UserAgent = 'Jadense-PDF-Engine'; $request.AllowAutoRedirect = $true
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
                $archiveLock = [IO.File]::OpenRead($archive)
                if ($archiveLock.Length -ne [long]$entry.size -or (Hash $archive) -ne $entry.sha256) {
                    $archiveLock.Dispose(); $archiveLock = $null
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
# Hold the same archive read-only from verification through extraction.
if ($ArchivePath) { $archiveLock = [IO.File]::OpenRead($archive) }
try {
if ($ArchivePath) {
    Progress 'checksum' 'Checking offline package identity'
    if ($archiveLock.Length -ne [long]$entry.size -or (Hash $archive) -ne $entry.sha256) {
        Write-PDFInstallError 'integrity' 'verify'
        throw 'Offline package size or SHA-256 mismatch. Select the matching official engine ZIP.'
    }
}
if ($ArchivePath) { Initialize-EngineMSVC 'pdf' $arch $root $entry.requirements.msvcMinVersion $ArchivePath }
Install-CheckedBundle 'pdf' $root $archive $entry $target $ArchivePath
} finally { $archiveLock.Dispose() }
} catch { Save-EngineStage $root $script:setupStage -Failed; throw } finally { $installLock.Dispose() }
