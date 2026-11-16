# Windows PowerShell 5.1: exercise the real decision logic without changing the host or requesting elevation.
$ErrorActionPreference = 'Stop'
$content = Join-Path $PSScriptRoot '../content/pdf-translation'
. (Join-Path $content 'install-network.ps1')
. (Join-Path $content 'install-environment.ps1')
. (Join-Path $content 'install-stage.ps1')
function Assert-True($ok,$label) { if (-not $ok) { throw "Failed: $label" } }
function Assert-Fails($code,[scriptblock]$work) {
    try { & $work | Out-Null } catch { if ($_.Exception.Message -match $code) { return }; throw }
    throw "Expected $code"
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('jadense-probe-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $archive = Join-Path $root 'engine.zip'
    $redist = Join-Path $root 'vc_redist.x64.exe'
    [IO.File]::WriteAllText($redist,'unsigned fixture')
    Assert-Fails 'MSVC_SIGNATURE_INVALID' { Assert-EngineRedist $redist 'vc_redist.x64.exe' 'x64' }
    function Assert-EngineRedist { $script:checkedSignature = $true }
    $valid = @{version=[version]'14.50.1.2';dll=@{'msvcp140.dll'=[version]'14.50.1.2';a=[version]'14.50.1.2';b=[version]'14.50.1.2'}}
    function Get-EngineMSVC { if ($script:ran -and $script:healthyAfter) { return $valid }; return @{version=$null;dll=@{}} }
    function Start-Process {
        param($FilePath,$Verb,$WorkingDirectory,$ArgumentList,[switch]$Wait,[switch]$PassThru,$WindowStyle,$ErrorAction)
        Assert-True ($script:checkedSignature -and $Verb -eq 'RunAs' -and $ArgumentList -match '/norestart') 'signature before UAC; no restart'
        $script:ran = $true
        return @{ExitCode=$script:installerCode}
    }
    foreach ($case in @(@(0,$true,''),@(3010,$true,''),@(1641,$false,'RESTART_REQUIRED'),@(1223,$false,'ADMIN_CANCELLED'),@(1638,$true,''),@(-2147023258,$false,'MSVC_INSTALL_FAILED'),@(1603,$false,'MSVC_INSTALL_FAILED'))) {
        $script:ran = $false; $script:checkedSignature = $false
        $script:installerCode,$script:healthyAfter,$errorCode = $case
        $invoke = { Initialize-EngineMSVC 'ocr' 'x64' $root '14.30.0.0' $archive }
        if ($errorCode) { Assert-Fails $errorCode $invoke } else { & $invoke | Out-Null }
        Assert-True $script:ran "installer $script:installerCode"
    }
    Assert-True (Test-Path -LiteralPath (Join-Path $root 'msvc-restart.json')) '3010 retained'
    $script:ran = $false
    Remove-Item -LiteralPath $redist
    Assert-Fails 'MSVC_MISSING' { Initialize-EngineMSVC 'ocr' 'x64' $root $null $archive }
    Assert-True (-not $script:ran) 'offline missing installer never executes'
    Save-EngineStage $root 'environment'
    Save-EngineStage $root 'extract'
    Save-EngineStage $root 'extract' -Failed
    $saved = Get-Content -Raw -LiteralPath (Join-Path $root 'setup-state.json') | ConvertFrom-Json
    Assert-True ($saved.stage -eq 'extract' -and $saved.failed) 'atomic progress update'
    $checkedRoot = [IO.Path]::GetFullPath($root)
    $tree = Join-Path $checkedRoot 's-cache'
    [IO.Directory]::CreateDirectory($tree) | Out-Null
    function Hash($file) { (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText((Join-Path $tree 'original'),'abc')
    $before = Get-StageDigest $tree
    [IO.File]::WriteAllText((Join-Path $tree 'extra.dll'),'extra')
    Assert-True ($before -ne (Get-StageDigest $tree)) 'extra executable invalidates stage'
    # Exercise a failed final-path launch using a synthetic archive, never real engine binaries.
    $targetRoot = Join-Path $root 'rollback'
    $payload = Join-Path $root 'payload'
    [IO.Directory]::CreateDirectory((Join-Path $payload 'python')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $payload 'python/python.exe'),'not executable')
    [IO.File]::WriteAllText((Join-Path $payload 'bundle.json'),'{"platform":"windows-x64","version":"1","engine":"fixture"}')
    [IO.Directory]::CreateDirectory((Join-Path $targetRoot 'runtime')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $targetRoot 'runtime/old'),'keep')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($payload,$archive)
    $entry = @{version='1';engine='fixture';requirements=@{treeSha256=(Get-StageDigest $payload)}}
    function Get-PythonArchitecture { return 'x64' }
    function Test-EngineNative {}
    function Progress($stage) { $script:stages += $stage }
    foreach ($expected in @('extract','checksum','extract')) {
        $script:stages = @()
        if ($expected -eq 'extract' -and (Test-Path -LiteralPath (Join-Path $targetRoot 's-cache'))) {
            [IO.File]::WriteAllText((Join-Path $targetRoot 's-cache/extra.dll'),'unexpected')
        }
        Assert-Fails '.' { Install-CheckedBundle 'pdf' $targetRoot $archive $entry 'windows-x64' $archive }
        Assert-True ($script:stages -contains $expected) "staging $expected"
        if ($expected -eq 'checksum') { Assert-True ($script:stages -notcontains 'extract') 'verified tree reused' }
        Assert-True ([IO.File]::ReadAllText((Join-Path $targetRoot 'runtime/old')) -eq 'keep') 'rollback retained old runtime'
    }
    Write-Output 'Passed: signature, installer exit codes, offline fallback, durable stages, tree integrity.'
} finally {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)) -eq [IO.Path]::GetTempPath().TrimEnd('\') -and [IO.Path]::GetFileName($root).StartsWith('jadense-probe-test-')) { Remove-EngineTree $root }
}
