# PDF 安装器共用的网络边界；只改变当前子进程，不保存代理地址、凭据或响应正文。
function Write-PDFInstallError([string]$Category, [string]$Stage) {
    Write-Output (ConvertTo-Json -Compress @{ type='install-error'; category=$Category; stage=$Stage })
}

# Windows PowerShell 不自动使用终端的 HTTPS_PROXY；保留未配置时的系统代理/PAC。
function Initialize-PDFNetwork {
    if ([Net.ServicePointManager]::SecurityProtocol -ne [Net.SecurityProtocolType]::SystemDefault) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    $configured = @($env:HTTPS_PROXY, $env:HTTP_PROXY, $env:ALL_PROXY) | Where-Object { $_ } | Select-Object -First 1
    if (-not $configured) { return }
    try {
        $uri = [Uri]$configured
        # 不静默绕过用户指定的路由；SOCKS 用户可使用代理软件的 HTTP 端口或离线导入。
        if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'http' -or -not $uri.Host) { throw 'Unsupported proxy' }
        $proxy = [Net.WebProxy]::new([Uri]($uri.GetLeftPart([UriPartial]::Authority)))
        if ($uri.UserInfo) {
            $parts = $uri.UserInfo -split ':', 2
            $password = if ($parts.Length -gt 1) { [Uri]::UnescapeDataString($parts[1]) } else { '' }
            $proxy.Credentials = [Net.NetworkCredential]::new([Uri]::UnescapeDataString($parts[0]), $password)
        }
        $bypass = @()
        foreach ($item in ($env:NO_PROXY -split ',')) {
            $item = $item.Trim()
            if (-not $item) { continue }
            if ($item -eq '*') { $bypass += '.*'; continue }
            # 支持主机、域名后缀与可选端口；不将输入当作正则执行。
            $suffix = [Regex]::Escape($item.TrimStart('.'))
            $bypass += ('^https?://([^/:]+\.)*' + $suffix + $(if ($item -match ':\d+$') { '$' } else { '(:\d+)?$' }))
        }
        $proxy.BypassList = $bypass
        [Net.WebRequest]::DefaultWebProxy = $proxy
    } catch {
        Write-PDFInstallError 'proxy' 'environment'
        throw 'PDF proxy configuration is invalid. Use an HTTP proxy endpoint or import the offline package.'
    }
}

# 仅归类异常，不回传可能包含认证信息的 Message/URL/响应内容。
function Get-PDFDownloadFailure($Failure) {
    $exception = $Failure.Exception
    while ($exception) {
        if ($exception -is [Net.WebException]) {
            if ($exception.Response) {
                $status = [int]$exception.Response.StatusCode
                $exception.Response.Close()
                if ($status -eq 407) { return 'proxy' }
                if ($status -in @(408, 429) -or $status -ge 500) { return 'temporary' }
                return 'http'
            }
            switch ($exception.Status.ToString()) {
                'NameResolutionFailure' { return 'dns' }
                'ProxyNameResolutionFailure' { return 'proxy' }
                'ConnectFailure' { return 'connect' }
                'Timeout' { return 'timeout' }
                'TrustFailure' { return 'tls' }
                'SecureChannelFailure' { return 'tls' }
            }
            return 'network'
        }
        if ($exception -is [UnauthorizedAccessException]) { return 'permission' }
        if ($exception -is [IO.IOException]) { return 'disk' }
        $exception = $exception.InnerException
    }
    return 'network'
}

# uv 引导文件较小，失败重下；完整引擎包仍由 install-bundle.ps1 按 Range 续传。
function Save-PDFBootstrapDownload([string]$Url, [string]$Path) {
    $category = 'network'
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            # 隐藏 PowerShell 的逐字节进度，插件通过结构化阶段显示状态。
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing -TimeoutSec 60 -ErrorAction Stop
            return
        } catch {
            $category = Get-PDFDownloadFailure $_
            if ($category -in @('proxy', 'tls', 'http', 'permission', 'disk') -or $attempt -eq 3) { break }
            Write-Output (ConvertTo-Json -Compress @{ type='progress'; stage='retry'; downloadStage='uv'; attempt=$attempt; category=$category })
            Start-Sleep -Seconds $attempt
        }
    }
    Write-PDFInstallError $category 'uv'
    throw 'PDF bootstrap download failed. Check network/proxy settings or import the offline engine package.'
}
