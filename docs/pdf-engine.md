# PDF 版面解析与翻译引擎安装（0.6.0）

[返回 README](../README.md) · [English](pdf-engine.en.md) · [使用对照翻译](usage-guide.md#pdf-translation-060)

版面解析引擎负责识别 PDF 布局并排版译文，使用 BabelDOC 0.6.4，与识别扫描文字的 OCR 独立。普通问答、选文翻译和文字层 Markdown 提取不需要它。对照翻译需要引擎和已配置的全文翻译服务；模型请求仍可能收费。扫描页保持原文，安装此引擎不等于启用 OCR。

## 1. 从设置自动安装

1. 打开工作台 **设置 → 外置依赖配置 → 版面解析引擎**；也可从 **功能配置 → 全文翻译 → 外置依赖** 跳转。
2. 点击 **准备 PDF 翻译引擎**，等待依赖、模型和字体准备完成。首次进入对照翻译也会准备引擎。
3. 看到 **PDF 翻译引擎已就绪** 后开始翻译。已有安装可点击 **检测已安装引擎**，检测本身不下载、不调用翻译服务。

**当前分发状态：**v0.6.0 中，[包清单](../content/pdf-translation/bundles.json)的 Windows x64 完整包仍为 `published: false`，自动安装走库内 `install.ps1` / `install.sh`：复用可用的 uv 或下载 uv，在独立目录安装 Python 3.12、锁定依赖，再准备模型与字体。需要访问 GitHub、Python 下载源、PyPI 和模型资源站；不需要预装 Python，也不修改系统 Python。

只有完整包正式公开、核验并启用清单后，Windows x64 自动安装才改为下载固定版本 ZIP。该流程支持分段续传、每个源最多三次尝试、SHA-256 校验、解压和离线检测；不支持续传的服务器会重新下载。完整包已作为 v0.6.0 附件公开，可手动下载导入；本版本尚未启用 ZIP 自动下载。

安装目录显示在设置中，位于 Zotero **profile** 下的 `jadense-pdf-translation/`，不一定是文献数据目录。完整包约 441 MiB，展开约 940 MiB；建议至少预留 3 GiB，供下载、解压和修复时保留旧环境。

## 2. 手动下载与离线导入

自动下载不可达时，可在另一台电脑下载与清单匹配的完整包，复制到目标电脑。请以 [Releases](https://github.com/jadense-ai/jadense-in-zotero/releases) 实际提供的附件为准；可从 [v0.6.0 附件](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.0)下载。

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
