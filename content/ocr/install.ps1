param([Parameter(Mandatory=$true)][string]$RuntimeDirectory, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
# Zotero 可能继承 PowerShell 7 的模块路径；补入当前 Windows PowerShell 模块。
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$runtimePath = [IO.Path]::GetFullPath($RuntimeDirectory)
# 只探测用户可执行文件，不执行 shell 配置，也不修改用户 uv。
$uvPath = $null
$uvVersion = $null
$uvSource = $null
$userCommand = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue
$candidates = @($userCommand.Source, (Join-Path $HOME '.local\bin\uv.exe'), (Join-Path $HOME '.cargo\bin\uv.exe'), (Join-Path $runtimePath 'uv.exe'))
foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $versionText = & $candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and "$versionText" -match '^uv (\d+\.\d+\.\d+)' -and [version]$Matches[1] -ge [version]'0.9.3') {
            $uvPath = $candidate; $uvVersion = "$versionText"
            $uvSource = if ($candidate -eq (Join-Path $runtimePath 'uv.exe')) { 'plugin' } else { 'user' }
            break
        }
    } catch { continue }
}
if ($CheckOnly) {
    $ready = (Test-Path -LiteralPath (Join-Path $runtimePath '.venv\Scripts\python.exe')) -and (Test-Path -LiteralPath (Join-Path $runtimePath 'ready-2.126.0-3.9.2'))
    Write-Output "uvPath=$uvPath"
    Write-Output "uvVersion=$uvVersion"
    Write-Output "uvSource=$uvSource"
    Write-Output "ready=$($ready.ToString().ToLowerInvariant())"
    exit 0
}
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
if (-not $uvPath) {
    $uvPath = Join-Path $runtimePath 'uv.exe'
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
    # 不依赖 Zotero 可能继承的 Archive 模块版本，只覆盖插件目录中的固定文件。
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -in @('uv.exe', 'uvw.exe', 'uvx.exe')) {
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtimePath $entry.FullName), $true)
            }
        }
    } finally { $zip.Dispose() }
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimePath 'python'
# 避免 profile 深层缓存将旧依赖的 wheel 构建路径推到 MAX_PATH。
$env:UV_CACHE_DIR = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Jadense\uv'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $runtimePath '.venv'
Write-Output "Using uv: $uvPath"
Write-Output 'Installing Python 3.12 and OCR dependencies...'
& $uvPath sync --project $runtimePath --python 3.12 --frozen
if ($LASTEXITCODE -ne 0) { throw 'OCR dependency installation failed. Retry or follow the manual installation README.' }
Write-Output 'OCR runtime ready'
