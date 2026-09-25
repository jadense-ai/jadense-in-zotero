# PDF 版面解析与翻译引擎安装（0.6.4）

[返回 README](../README.md) · [English](pdf-engine.en.md) · [使用对照翻译](usage-guide.md#pdf-translation-060)

版面解析引擎负责识别 PDF 布局并排版译文，使用 BabelDOC 0.6.4，与识别扫描文字的 OCR 独立。普通问答、选文翻译和文字层 Markdown 提取不需要它。对照翻译需要引擎和已配置的全文翻译服务；模型请求仍可能收费。扫描页保持原文，安装此引擎不等于启用 OCR。

## 1. 从设置自动安装

1. 打开工作台 **设置 → 外置依赖配置 → 版面解析引擎**；也可从 **功能配置 → 全文翻译 → 外置依赖** 跳转。
2. 点击 **准备 PDF 翻译引擎**，等待依赖、模型和字体准备完成。首次进入对照翻译也会准备引擎。
3. 看到 **PDF 翻译引擎已就绪** 后开始翻译。已有安装可点击 **检测已安装引擎**，检测本身不下载、不调用翻译服务。

**当前分发状态：**源码及普通 PR 预览中的 [包清单](../content/pdf-translation/bundles.json)保持 `published: false`，避免指向未发布附件；这类构建从库内 `install.ps1` / `install.sh` 安装。正式发布标签构建会临时写入该 Release 的精确 URL 与 SHA-256，并把完整包放进 v0.6.4 正式 XPI，因此该 XPI 在 Windows x64 自动准备时可直接用完整包。下载、摘要或离线检查失败会给出阶段说明并保留原引擎。

正式 Release 为 Windows x64 提供固定摘要的完整引擎包。v0.6.4 标签构建会把该版本附件地址和摘要写入 XPI：自动准备优先下载完整 ZIP，支持可恢复下载、SHA-256 校验、解压及离线检测；不支持续传的服务器会重新下载。候选包公开前请继续使用已发布的 v0.6.0 PDF 引擎 ZIP 或源码安装。

安装目录显示在设置中，位于 Zotero **profile** 下的 `jadense-pdf-translation/`，不一定是文献数据目录。完整包约 441 MiB，展开约 940 MiB；建议至少预留 3 GiB，供下载、解压和修复时保留旧环境。

## 2. 手动下载与离线导入

自动下载不可达时，可在另一台电脑下载与清单匹配的完整包，复制到目标电脑。请以 [Releases](https://github.com/jadense-ai/jadense-in-zotero/releases) 实际提供的附件为准；v0.6.4 候选版尚未正式发布，正式发布后 Windows x64 完整离线套装也会包含 PDF 引擎 ZIP。发布前可使用现有 v0.6.0 PDF ZIP 或库内安装器。

| 项目 | 固定值 |
| --- | --- |
| 平台 | Windows x64 |
| 文件名 | `jadense-pdf-engine-0.6.4-1-windows-x64.zip` |
| 大小 | 462102143 字节 |
| SHA-256 | `b9b160f727f3bb962df8011a14131250c20753f64faac1793e902dbf6b6cf887` |

在设置中点击 **导入离线包**，直接选择 ZIP，无需自行解压。插件校验包哈希，在临时目录检查模型加载和 PDF 渲染，通过后替换引擎。导入或修复保留 `tasks/` 中的成果与原 PDF。可用 PowerShell 预先核对下载：

```powershell
Get-FileHash .\jadense-pdf-engine-0.6.4-1-windows-x64.zip -Algorithm SHA256
```

完整包包含 Python、依赖、模型和字体，无需管理员权限、Python 或 uv。其他平台不要使用 Windows x64 包。

插件以 `-ExecutionPolicy Bypass` 在独立 PowerShell 子进程中运行 Windows 安装器；Windows 默认 `Restricted` 执行策略通常无需修改。若运行仍被 `MachinePolicy`/`UserPolicy`、AppLocker、WDAC 或单位终端防护阻止，或 profile 写入被拒绝，请联系管理员按组织政策为 Zotero 插件进程配置限于当前用户的授权。不要永久修改整机执行策略、关闭安全软件/证书/哈希验证，也不要反复以管理员身份启动 Zotero。导入失败会显示安装阶段；先核对下载摘要和磁盘空间，再请管理员检查明确的策略拦截。

## 3. 库内备用源：用随库安装器手动安装

库内备用源是 [content/pdf-translation/](../content/pdf-translation/) 中的安装器、锁文件与适配器源码，**不是另一份完整 ZIP 或模型镜像**。它与插件内置文件对应，即使完整包尚未发布也可使用，但仍需联网下载第三方依赖和资产。

先点击 **检测已安装引擎**，插件会部署安装文件；尚未安装时提示缺少引擎是正常的。复制设置里显示的安装目录，并关闭正在运行的排版任务。若内置安装文件缺失，也可下载与所装插件版本对应的仓库源码，把以下文件复制到该目录：`pyproject.toml`、`uv.lock`、`worker.py`、`batch_adapter.py`、`progressive_pipeline.py`、`install.ps1`、`install.sh`、`install-bundle.ps1`、`bundles.json`。勿用其他版本文件混装。

### Windows

将示例路径替换为设置中显示的真实目录，在 PowerShell 执行：

```powershell
$pdfRuntime = 'C:\path\to\profile\jadense-pdf-translation'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$pdfRuntime\install.ps1" $pdfRuntime
if ($LASTEXITCODE -ne 0) { throw '引擎依赖安装失败，请检查上方错误' }
@{ operation = 'prepare'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
@{ operation = 'check'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
```

### macOS / Linux

```sh
pdf_runtime='/path/to/profile/jadense-pdf-translation'
sh "$pdf_runtime/install.sh" "$pdf_runtime"
# 仅在安装成功后执行下面两步。
printf '{"operation":"prepare","root":"%s"}\n' "$pdf_runtime" | "$pdf_runtime/.venv/bin/python" -s "$pdf_runtime/worker.py"
printf '{"operation":"check","root":"%s"}\n' "$pdf_runtime" | "$pdf_runtime/.venv/bin/python" -s "$pdf_runtime/worker.py"
```

最后回到插件点击 **检测已安装引擎**。检测检查 BabelDOC 版本、资源哈希、模型加载和 PDF 渲染；历史安装记录不能代替检测通过。Windows x64 已有安装验收记录；macOS、Linux、Windows ARM64 尚未完成对应平台验收，不保证依赖可用性。

<a id="network-environment"></a>

## 网络、代理与单位环境

GitHub 首页、AI 接口与安装器下载是不同链路。Release 附件可能重定向到其他域名；旧式安装还需访问 Python、PyPI 及模型站。浏览器代理扩展不自动覆盖 PowerShell，PDF 引擎也不使用 OCR 下载源设置。受限网络优先采用上面的完整 ZIP 离线导入，不需要管理员权限或预装 Python/uv。

如需使用已获准的本机 HTTP 代理进行手动安装，先在设置中点击「检测已安装引擎」部署安装文件，再打开临时 **Windows PowerShell** 窗口，在同一窗口执行（端口和目录必须替换）：

```powershell
$pdfRuntime = 'C:\path\to\profile\jadense-pdf-translation'
$pdfProxy = 'http://127.0.0.1:7890' # 示例，替换为代理软件的实际 HTTP 端口
$env:HTTPS_PROXY = $pdfProxy
$env:HTTP_PROXY = $pdfProxy
[Net.WebRequest]::DefaultWebProxy = [Net.WebProxy]::new($pdfProxy)
& "$pdfRuntime\install.ps1" $pdfRuntime
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络和代理，或导入完整包' }
@{ operation = 'prepare'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
if ($LASTEXITCODE -ne 0) { throw '模型准备失败，请检查下载错误，或导入完整包' }
@{ operation = 'check'; root = $pdfRuntime } | ConvertTo-Json -Compress | & "$pdfRuntime\.venv\Scripts\python.exe" -s "$pdfRuntime\worker.py"
```

这些设置仅影响该窗口及子进程，关闭窗口即结束；不保存系统配置。旧版 PowerShell 下载 uv 不保证识别 `HTTPS_PROXY`，因此显式设置 .NET 代理，并用 `&` 在同一进程运行脚本。此示例使用无需认证的本机 HTTP 端点，不是 SOCKS 端点；需认证的单位代理应咨询管理员，不要在公开日志中提供密码。如果执行策略阻止脚本，优先离线导入或联系管理员，不需要永久放宽全机执行策略。

单位明确禁止 PowerShell/Python、外网下载或写入 profile 时，安装器无法自行解除规则。证书错误应检查系统时间和受信任的单位证书，不要跳过 TLS/哈希校验。仅有“无法连接远程服务器”不能证明需要管理员权限。

## 4. 失败后的处理

| 现象 | 操作 |
| --- | --- |
| 自动安装下载失败 | 检查提示中的下载阶段；重试准备，或导入匹配的完整离线包。源码安装仍需要第三方下载源可达 |
| ZIP 校验失败 | 重新获取清单匹配的包；不要关闭校验或更改摘要 |
| 缺少模型、字体或资源哈希不符 | 点击修复引擎，或重新导入完整包，再检测 |
| 模型/DLL 加载失败 | 保留错误提示，检查系统运行库或企业子进程限制；更换翻译模型不能修复本机引擎 |
| 只有安装记录，没有就绪状态 | 点击检测；不要手工创建 ready 标记 |
| 已有译文但部分翻译失败 | 在任务中阅读/导出已有结果，再使用仅补缺；无需重装正常引擎 |

安装器错误输出记录在安装目录的 `install.log`（有错误输出时才写入）。分享前检查本机路径等个人信息。引擎只在本地排版；翻译文字按所选服务发送，OCR 下载源设置不会改变 PDF 排版引擎的下载源。

维护者可使用 [build-pdf-engine.py](../scripts/build-pdf-engine.py) 从锁定环境构建完整包，使用 [check-pdf-engine-install.py](../scripts/check-pdf-engine-install.py) 检查安装。源码目录附 [许可证](../content/pdf-translation/LICENSE)，依赖许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。仓库源码不是预装环境；不要把个人 profile、任务成果或凭据打进分发包。
