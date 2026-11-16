# Optional progress records never decide readiness. Only phase changes touch disk.
function Save-EngineStage($Root,$Stage,[switch]$Failed) {
    if (-not $Root -or (-not $Failed -and $script:setupStage -eq $Stage)) { return }
    $script:setupStage = $Stage
    try {
        $path = Join-Path $Root 'setup-state.json'
        $state = @{stage=$Stage; failed=[bool]$Failed; updated=[DateTime]::UtcNow.ToString('o')}
        [IO.File]::WriteAllText("$path.tmp", (ConvertTo-Json -Compress $state))
        if ([IO.File]::Exists($path)) { [IO.File]::Replace("$path.tmp",$path,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move("$path.tmp",$path) }
    } catch {}
}

# Shared by the two user-level engine installers. Only a verified Microsoft redist may elevate.
function Get-EngineArchitecture {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw "Unsupported Windows engine architecture: $arch" }
    }
}

function Get-PythonArchitecture($Python) {
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Python))
    try {
        $reader.BaseStream.Position = 60
        $reader.BaseStream.Position = $reader.ReadInt32()
        if ($reader.ReadUInt32() -ne 0x4550) { throw 'Invalid engine executable' }
        switch ($reader.ReadUInt16()) {
            0x8664 { return 'x64' }
            0xAA64 { return 'arm64' }
            default { throw 'Unsupported engine executable architecture' }
        }
    } finally { $reader.Dispose() }
}

function Get-EngineMSVC($Architecture) {
    $installed = $null
    foreach ($view in @('Registry32','Registry64')) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', $view)
        try {
            $key = $base.OpenSubKey("SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\$Architecture")
            if ($key) {
                try {
                    $version = $null
                    if ($key.GetValue('Installed') -eq 1 -and [version]::TryParse(([string]$key.GetValue('Version')).TrimStart('v'), [ref]$version) -and $version -gt $installed) { $installed = $version }
                } finally { $key.Dispose() }
            }
        } finally { $base.Dispose() }
    }
    $system = if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { 'Sysnative' } else { 'System32' }
    $files = @{}
    foreach ($name in @('msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll')) {
        $file = Get-Item -LiteralPath (Join-Path $env:SystemRoot "$system\$name") -ErrorAction SilentlyContinue
        if ($file) { $info = $file.VersionInfo; $files[$name] = [version]::new($info.FileMajorPart,$info.FileMinorPart,$info.FileBuildPart,$info.FilePrivatePart) }
    }
    return @{ version=$installed; dll=$files }
}

function Stop-EngineSetup($Category, $Message) {
    Write-PDFInstallError $Category 'msvc'
    throw "$Category - $Message"
}

function Get-RedistResult([int]$Code) {
    switch ($Code) {
        0 { 'probe' }; 3010 { 'restart-pending' }; 1641 { 'restarting' }
        1638 { 'recheck' }; -2147023258 { 'recheck' }; 1223 { 'cancelled' }
        default { 'failed' }
    }
}

function Write-EngineStage($Engine,$Stage) {
    Save-EngineStage $Root $Stage
    if ($Engine -eq 'ocr') { Write-Output ('JADENSE_OCR_PROGRESS ' + (ConvertTo-Json -Compress @{stage=$Stage})) }
    else { Write-Output (ConvertTo-Json -Compress @{type='progress';stage=$Stage}) }
}

function Assert-EngineRedist($exe,$name,$Architecture) {
    $sig = Get-AuthenticodeSignature -LiteralPath $exe
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.GetNameInfo('SimpleName',$false) -ne 'Microsoft Corporation' -or $info.OriginalFilename -ne $name -or $info.ProductName -notmatch 'Visual C\+\+.*Redistributable' -or $info.ProductName -notmatch [regex]::Escape($Architecture)) {
        Stop-EngineSetup 'MSVC_SIGNATURE_INVALID' 'Microsoft Visual C++ Redistributable signature or product mismatch.'
    }
}

function Initialize-EngineMSVC($Engine,$Architecture,$Root,$Minimum,$ArchivePath,[switch]$KnownOld) {
    $state = Get-EngineMSVC $Architecture
    $min = if ($Minimum) { [version]$Minimum } else { $null }
    $reason = if (-not $state.version -or $state.dll.Count -ne 3) { 'MSVC_MISSING' }
        elseif ($KnownOld -or ($min -and ($state.version -lt $min -or @($state.dll.Values | Where-Object { $_ -lt $min }).Count))) { 'MSVC_TOO_OLD' }
    Write-Output (ConvertTo-Json -Compress @{type='environment-check';component='msvc';architecture=$Architecture;installedVersion=[string]$state.version;requiredVersion=[string]$Minimum;action=$reason})
    if (-not $reason) { return }
    Write-EngineStage $Engine 'msvc'
    $name = "vc_redist.$Architecture.exe"
    $url = "https://aka.ms/vc14/$name"
    $dir = [IO.Directory]::CreateDirectory((Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))))
    $exe = Join-Path $dir.FullName $name
    try {
        if ($ArchivePath) {
            $local = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ArchivePath))) $name
            if (-not [IO.File]::Exists($local)) { Stop-EngineSetup $reason "Place Microsoft's $name beside the offline ZIP, or install it from $url and retry." }
            [IO.File]::Copy($local,$exe)
        } else {
            Initialize-PDFNetwork
            Save-PDFBootstrapDownload $url $exe 'msvc'
        }
        $lock = [IO.File]::Open($exe,'Open','Read','Read')
        try {
            Assert-EngineRedist $exe $name $Architecture
            Write-EngineStage $Engine 'msvc_authorization'
            try {
                $process = Start-Process -FilePath $exe -Verb RunAs -WorkingDirectory ([Environment]::SystemDirectory) -ArgumentList '/install /quiet /norestart' -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
            } catch {
                $cause = $_.Exception
                while ($cause) {
                    if ($cause.NativeErrorCode -eq 1223 -or ($cause.HResult -band 0xffff) -eq 1223) { Stop-EngineSetup 'ADMIN_CANCELLED' 'Windows authorization cancelled. Retry or ask your administrator.' }
                    $cause = $cause.InnerException
                }
                Stop-EngineSetup 'MSVC_INSTALL_FAILED' 'Windows could not start the Microsoft installer. Contact your administrator.'
            }
            $result = Get-RedistResult $process.ExitCode
            Write-Output (ConvertTo-Json -Compress @{type='runtime-install';exitCode=$process.ExitCode;result=$result})
            switch ($result) {
                'cancelled' { Stop-EngineSetup 'ADMIN_CANCELLED' 'Windows authorization cancelled.' }
                'failed' { Stop-EngineSetup 'MSVC_INSTALL_FAILED' "Microsoft installer exit $($process.ExitCode); inspect its dd_vcredist log in TEMP." }
                'restarting' { Stop-EngineSetup 'RESTART_REQUIRED' 'Windows restart initiated. Resume after restarting.' }
                'restart-pending' {
                    Write-EngineStage $Engine 'restart_pending'
                    [IO.File]::WriteAllText((Join-Path $Root 'msvc-restart.json'), (ConvertTo-Json -Compress @{code=3010;date=[DateTime]::UtcNow.ToString('o')}))
                }
            }
            $after = Get-EngineMSVC $Architecture
            if (-not $after.version -or $after.dll.Count -ne 3 -or ($min -and ($after.version -lt $min -or @($after.dll.Values | Where-Object { $_ -lt $min }).Count))) {
                if ($result -eq 'restart-pending') { Stop-EngineSetup 'RESTART_REQUIRED' 'Restart Windows and resume setup.' }
                Stop-EngineSetup 'MSVC_INSTALL_FAILED' 'Windows runtime is still incomplete. Inspect the Microsoft installer log.'
            }
        } finally { $lock.Dispose() }
    } finally {
        if ([IO.File]::Exists($exe)) { [IO.File]::Delete($exe) }
        [IO.Directory]::Delete($dir.FullName)
    }
}

function Test-EngineNative($Engine,$Python,$Root,$Minimum,$ArchivePath) {
    $arch = Get-PythonArchitecture $Python
    for ($attempt=0; $attempt -lt 2; $attempt++) {
        Write-EngineStage $Engine 'imports'
        $failure = $null
        & $Python -I -B -u (Join-Path $Root 'native-probe.py') $Engine | ForEach-Object {
            Write-Output $_
            try { $row = $_ | ConvertFrom-Json; if ($row.type -eq 'install-error') { $failure = $row } } catch {}
        }
        if ($LASTEXITCODE -eq 0) { return }
        $state = Get-EngineMSVC $arch
        # Only the reproduced torch/DLL combination justifies upgrading an otherwise installed legacy runtime.
        if ($attempt -eq 0 -and $state.version -le [version]'14.26.28720.3' -and $Engine -eq 'ocr' -and $failure.module -eq 'torch' -and $failure.winerror -eq 1114 -and $state.dll['msvcp140.dll'] -eq [version]'14.26.28720.3') {
            Initialize-EngineMSVC $Engine $arch $Root $Minimum $ArchivePath -KnownOld
            continue
        }
        throw "Native probe failed: $($failure.category) $($failure.module) WinError=$($failure.winerror) exit=$LASTEXITCODE. Check loaded DLL paths in install.log."
    }
}
