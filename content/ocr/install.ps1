param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
# Zotero 可能继承 PowerShell 7 的模块路径；补入当前 Windows PowerShell 模块。
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$runtimePath = [IO.Path]::GetFullPath($RuntimeDirectory)
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$uvPath = Join-Path $runtimePath 'uv.exe'
if (-not (Test-Path -LiteralPath $uvPath)) {
    Write-Output 'Downloading uv...'
    $archive = Join-Path $runtimePath 'uv.zip'
    $url = 'https://github.com/astral-sh/uv/releases/download/0.9.3/uv-x86_64-pc-windows-msvc.zip'
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    $checksumBody = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content
    if ($checksumBody -is [byte[]]) { $checksumBody = [Text.Encoding]::UTF8.GetString($checksumBody) }
    $expected = ($checksumBody.Trim() -split '\s+')[0]
    $stream = [IO.File]::OpenRead($archive)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
    if ($actual -ne $expected.ToLowerInvariant()) { throw 'uv checksum mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $runtimePath)
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimePath 'python'
$env:UV_CACHE_DIR = Join-Path $runtimePath 'uv-cache'
Write-Output 'Installing Python 3.12 and OCR dependencies...'
& $uvPath sync --project $runtimePath --python 3.12 --frozen
if ($LASTEXITCODE -ne 0) { throw 'OCR dependency installation failed. Retry or follow the manual installation README.' }
Write-Output 'OCR runtime ready'
