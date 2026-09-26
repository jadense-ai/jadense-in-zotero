# PDF 版面解析与翻译引擎安装（0.6.6 待发布）

[返回 README](../README.md) · [English](pdf-engine.en.md) · [使用对照翻译](usage-guide.md#pdf-translation-060)

版面解析引擎负责识别 PDF 布局并排版译文，使用 BabelDOC 0.6.4，与识别扫描文字的 OCR 独立。普通问答、选文翻译和文字层 Markdown 提取不需要它。对照翻译需要引擎和已配置的全文翻译服务；模型请求仍可能收费。扫描页保持原文，安装此引擎不等于启用 OCR。

## 1. 从设置自动安装

1. 打开工作台 **设置 → 外置依赖配置 → 版面解析引擎**；也可从 **功能配置 → 全文翻译 → 外置依赖** 跳转。
2. 点击 **准备 PDF 翻译引擎**，等待依赖、模型和字体准备完成。首次进入对照翻译也会准备引擎。
3. 看到 **PDF 翻译引擎已就绪** 后开始翻译。已有安装可点击 **检测已安装引擎**，检测本身不下载、不调用翻译服务。

Windows x64 正式版可自动下载引擎包；网络不可用时可按下文导入完整离线套装中的引擎 ZIP。自动下载支持中断后继续，并由插件检查下载结果。手动选择离线包后，插件会直接解压并检查 Python、模型、字体及 PDF 渲染，确认可用才替换旧引擎。

安装目录显示在设置中，位于 Zotero **profile** 下的 `jadense-pdf-translation/`，不一定是文献数据目录。单独导入建议至少预留 3 GiB，供下载、解压和修复时保留旧环境。

## 2. 手动下载与离线导入

自动下载不可达时，在另一台电脑打开 [GitHub Releases](https://github.com/jadense-ai/jadense-in-zotero/releases)，从 **v0.6.6** 页面下载 `jadense-in-zotero-v0.6.6-windows-x64-offline.zip`，复制到目标电脑并解压外层 ZIP。该版本发布前请勿把其他版本的套装当作 v0.6.6 使用。

1. 从解压目录安装其中的 `jadense-in-zotero-v0.6.6.xpi`，重启 Zotero。
2. 打开 **设置 → 外置依赖配置 → 版面解析引擎 → 导入离线包**，选择解压目录中的 `jadense-pdf-engine-*.zip`，**不要解压这个引擎 ZIP**。
3. 等待“PDF 翻译引擎已就绪”。导入或修复会保留 `tasks/` 中的成果与原 PDF。

完整包包含 Python、依赖、模型和字体，无需管理员权限、Python 或 uv。其他平台不要使用 Windows x64 包。

插件以 `-ExecutionPolicy Bypass` 在独立 PowerShell 子进程中运行安装器，Windows 默认执行策略通常无需修改。若出现脚本或文件被拦截，请按 [ZIP 指南的环境排障](usage-guide.md#windows-x64-zip-离线安装)查看当前用户执行策略、Windows 安全中心的保护历史记录和具体拦截程序，再重试导入。

若报缺少 VC++ 运行库，或自定义 Zotero profile 路径很深时出现类似 DLL 加载错误，按同一指南检查官方 x64 运行库及路径。若出现 `Unexpected UTF-8 BOM`，先升级到 0.6.6 插件，再重新导入原始引擎 ZIP；旧安装器的 Python 读取入口无法处理带 BOM 的请求。

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

这些设置仅影响该窗口及子进程，关闭窗口即结束；不保存系统配置。旧版 PowerShell 下载 uv 不保证识别 `HTTPS_PROXY`，因此显式设置 .NET 代理，并用 `&` 在同一进程运行脚本。此示例使用无需认证的本机 HTTP 端点，不是 SOCKS 端点。若执行策略阻止脚本，请按 [ZIP 指南的具体步骤](usage-guide.md#windows-x64-zip-离线安装)检查当前用户策略和拦截记录。

单位明确禁止 PowerShell/Python、外网下载或写入 profile 时，先通过 Windows 安全中心和事件查看器确定被拦截的程序与规则。证书错误应检查系统时间和受信任的单位证书。仅有“无法连接远程服务器”不能证明需要管理员权限。

## 4. 失败后的处理

| 现象 | 操作 |
| --- | --- |
| 自动安装下载失败 | 检查提示中的下载阶段；重试准备，或导入匹配的完整离线包。源码安装仍需要第三方下载源可达 |
| ZIP 解压失败 | 从当前版本的官方完整套装中重新取得引擎 ZIP，直接导入；确认磁盘空间充足，0.6.6 已缩短临时目录路径 |
| `Unexpected UTF-8 BOM` | 升级到 0.6.6 插件并重新导入原始引擎 ZIP |
| 缺少模型、字体或资源哈希不符 | 点击修复引擎，或重新导入完整包，再检测 |
| 模型/DLL 加载失败 | 保留错误提示，检查系统运行库或企业子进程限制；更换翻译模型不能修复本机引擎 |
| 只有安装记录，没有就绪状态 | 点击检测；不要手工创建 ready 标记 |
| 已有译文但部分翻译失败 | 在任务中阅读/导出已有结果，再使用仅补缺；无需重装正常引擎 |

安装器错误输出记录在安装目录的 `install.log`（有错误输出时才写入）。分享前检查本机路径等个人信息。引擎只在本地排版；翻译文字按所选服务发送，OCR 下载源设置不会改变 PDF 排版引擎的下载源。

维护者可使用 [build-pdf-engine.py](../scripts/build-pdf-engine.py) 从锁定环境构建完整包，使用 [check-pdf-engine-install.py](../scripts/check-pdf-engine-install.py) 检查安装。源码目录附 [许可证](../content/pdf-translation/LICENSE)，依赖许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。仓库源码不是预装环境；不要把个人 profile、任务成果或凭据打进分发包。
