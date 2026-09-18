# 本机 OCR 安装与全文翻译

> 以下准备流程适用于正式版 0.4.9。已发布 0.4.8 的界面可能不同。

## 全文翻译与本机 OCR

设置 → **OCR配置**中点击 **启用本机 OCR**，插件自动完成依赖安装、模型准备与验证；中途失败后点击 **继续准备**，复用已下载内容。打开设置自动读取状态，就绪后无需反复检查；全文 Markdown、全文翻译和参考文献任务要求提前准备完成。插件先使用 Docling + RapidOCR 在本机识别完整 PDF，再将有序正文发送给所选 AI 或 Bing/Google；PDF 文件和公式裁图不会上传给 OCR 云服务。其他功能不要求安装 Python。

整页 OCR 使用 Docling 的 [Egret Large 版面模型](https://huggingface.co/docling-project/docling-layout-egret-large) 重建阅读顺序，段落和跨页正文按容量组成请求，不再逐个文字层碎片请求。AI 返回 Markdown 并流式显示；Bing、Google 每片分别最多 1,000、5,000 UTF-16 字符。公式在本机以原图保留，随正文发送的是占位符。页码采用 PDF 实际第 1～N 页，定位范围对应当前容量片覆盖的来源区域；机器翻译不保证逐句与原文一一对齐。

生成期间禁用定位；暂停、失败或完成后可以定位已完成内容。未完成内容标为草稿，仅保存在当前插件会话内。继续只请求未完成的切片；限流显示可继续时间，不自动重试或换服务。网络中断后手动继续会重新请求该未完成片，先前请求可能已产生费用。旧历史不会自动重译，需要主动点击「重新翻译」使用 OCR。

## 安装环境

自动安装在当前 Zotero **配置目录**（不是文献数据目录）的 `jadense-ocr/v1/` 中进行：

- Windows x64：系统 Windows PowerShell、HTTPS 网络；无需预装 Python 或管理员权限。
- macOS Intel/Apple Silicon、Linux x64/ARM64：`/bin/sh`、`curl`、`tar`、`shasum`。平台与 Python 依赖的 wheel 支持以实际安装结果为准。
- 优先检测 PATH 和常见用户安装目录中的 uv（>= 0.9.3），其次使用插件已有 uv；均不可用时下载 uv 0.9.3 并校验官方 SHA-256，不修改用户 uv。独立 CPython 3.12、Docling 2.126.0、RapidOCR 3.9.2；间接依赖由 [uv.lock](../content/ocr/uv.lock) 固定。
- Windows 构建缓存使用 `%LOCALAPPDATA%\Jadense\uv`，避免在深层 profile 内构建旧依赖；`.venv` 和模型仍属于当前 profile。其他系统保持 profile 内缓存。
- 默认 CPU、4 个 Docling 计算线程；无需 CUDA。首次下载 Python、PyTorch/ONNX 依赖和版面模型，需数 GB 可用磁盘空间及稳定网络。首次加载比后续慢，识别速度随 CPU 和页数变化。
- 下载来源：GitHub 的 astral-sh/uv 与 Python 发行资产、PyPI；Docling 版面、表格和选文公式模型可选择 Hugging Face、HF-Mirror 或中国国内的魔搭 ModelScope。RapidOCR 3.9.2 的文字识别模型使用其内置的官方魔搭源，首次识别可能需要下载，并非所有权重都随 Python 包提供。不需要攻玉令牌或模型下载密钥。

### 0.4.7–0.4.9 升级后的恢复

两个正式版使用相同的 `jadense-ocr/v1/`、Docling 2.126.0、RapidOCR 3.9.2 和 Egret Large 全文模型。升级不要求删除环境或重新下载全部模型。0.4.8 新增选文公式 OCR，需要额外的 CodeFormulaV2；旧版全文可用不代表此额外模型已经下载。

当前修复版优先检查旧 HF 或魔搭缓存，避免已有模型仍因 Hub 网络查询而等待；有效凭据直接复用；缺少旧凭据时自动离线识别合成 PDF，成功后补写，无需手动检查。缺失模型仅在点击“启用本机 OCR / 继续准备”后下载并离线验证。选文公式模型首次使用时单独加载，不影响全文就绪状态。

国内网络可选择 **魔搭 ModelScope（中国国内）**。适配固定的 `ds4sd/docling-layout-egret-large`、`ds4sd/docling-models` 和 `ds4sd/CodeFormulaV2`，下载文件与已核对的 HF 模型摘要一致，SHA-256 校验成功后才替换目标文件。下载中断保留已完成文件，重试只补缺失/损坏文件；不是字节级断点续传。切换来源仍复用已有缓存，不上传 PDF，不改变翻译 Provider。

若依赖确实缺失，再点击 **安装 OCR 依赖**：显式安装不再因为旧成功标记而跳过，重新执行锁定依赖同步并验证关键模块导入；复用当前环境，不做强制全量重装。模型准备失败查看 `models-prepare.log`，选文公式失败查看 `selection-models-prepare.log`，无需盲目删除整个目录。磁盘文件损坏或系统动态库缺失仍需根据日志处理；同步不承诺修复任意文件损坏。

环境目录中的 `.venv/` 是 Python 依赖，`models/` 是模型缓存，`cache/` 是按 PDF 内容摘要与解析版本缓存的识别结果。缓存包含本机论文正文，使用操作系统当前用户目录权限保护。服务只监听随机本机回环端口，凭证仅经进程 stdin 传入；不接收任意文件路径，不提供 CORS。插件退出会关闭其服务与正在识别的子进程。

## 自动安装失败后的手动步骤

先在“设置 → OCR配置”重试安装。界面保留安装错误末尾信息，完整输出尽可能保存到环境目录的 `install.log`（每次安装覆盖）；网络受限、磁盘不足或依赖下载失败时，不会改用云端 OCR。修复网络或空间后可以再次安装，成功标记仅在安装完整结束后写入。设置检查中的“已安装”依据 Python 文件及成功标记，不代表模型已下载或复杂 PDF 识别已验证。

从 Zotero「帮助 → 调试输出日志」或配置目录入口确认当前 **profile** 路径。安装按钮会先将下面 5 个文件复制到 `jadense-ocr/v1/`；也可以手动复制仓库 `content/ocr/` 中的 `install.ps1`、`install.sh`、`server.py`、`pyproject.toml`、`uv.lock`。不要复制开发环境的 `.venv`。

Windows PowerShell（把路径替换为自己的配置目录）：

```powershell
$ocrRuntime = 'C:\path\to\profile\jadense-ocr\v1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ocrRuntime\install.ps1" -RuntimeDirectory $ocrRuntime
```

macOS / Linux：

```sh
sh '/path/to/profile/jadense-ocr/v1/install.sh' '/path/to/profile/jadense-ocr/v1'
```

如果安装脚本也无法下载 uv，可从 [uv 官方发行页](https://github.com/astral-sh/uv/releases/tag/0.9.3) 手动下载对应系统压缩包并核对 SHA-256，将 `uv.exe` 或 `uv` 放进该目录，再运行上述脚本。

最后兜底：自行安装 Python 3.12，在环境目录手动建立 venv 并安装依赖（此方式只固定直接依赖，优先使用 uv.lock）：

```powershell
Set-Location $ocrRuntime
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install 'docling[rapidocr]==2.126.0' 'rapidocr==3.9.2'
.\.venv\Scripts\python.exe -c "from docling.document_converter import DocumentConverter; from rapidocr import RapidOCR; print('OCR dependencies ready')"
Set-Content -LiteralPath 'ready-2.126.0-3.9.2' -Value 'ready'
```

macOS/Linux 对应命令使用 `python3.12 -m venv .venv` 与 `.venv/bin/python`；依赖导入检查成功后执行 `touch ready-2.126.0-3.9.2`。随后回到插件，若未自动显示就绪则点击“继续准备”，完成后启动全文任务；插件会管理随机端口和会话凭证，无需手动运行 HTTP 服务。

公式、表格、异常字体及复杂混合栏版式仍需核对原 PDF；使用开源 OCR 不等于保证识别正确。截图对应论文尚未作为此仓库的实测样本。

## 本地开发与验证

```powershell
pnpm install
pnpm test
pnpm lint
pnpm build
uv sync --project content/ocr --python 3.12 --frozen
node scripts/smoke-local-ocr.mjs content/ocr/.venv/Scripts/python.exe content/ocr/.cache
node scripts/smoke-local-ocr.mjs content/ocr/.venv/Scripts/python.exe content/ocr/.cache --complex --scan
content/ocr/.venv/Scripts/python.exe -m unittest discover -s content/ocr -p test_server.py
node scripts/smoke-research.mjs 'D:/Program Files/Zotero/zotero.exe' --documents-only --ocr-only --screenshots --keep-temp --timeout-ms 1200000
```

原生 OCR smoke 使用隔离的 Zotero profile、真实本机 OCR 和合成 AI 流，首次会下载独立环境及模型。Python 环境、模型、缓存不进入 XPI；XPI 只包含 5 个安装/服务源文件。测试不证明真实 AI 译质或 Bing/Google 当前网络可用性。

Windows 原生一键安装与流式阅读已实测；macOS/Linux 安装脚本尚未在对应系统验收。三栏、跨栏摘要、首字下沉区域、水印和密集公式使用合成 PDF 及其纯扫描版本回归，不能替代真实论文对照；首字下沉仍可能产生多余空格。

## 原文提取、翻译与成果历史

阅读器侧栏可切换「对话 / 全文 Markdown / 全文翻译 / 选中翻译历史 / 解析结果」。先在「全文 Markdown」点击「提取原文」，查看重排后的正文、表格、图片和公式；提取完成不会自动翻译。选择目标语言后，手动点击「翻译全文」。原文只读，重新提取会创建新版本，已有译文仍对应原先的版本。

工作台「文献解析」按文献汇总以上成果，同一文献的不同 PDF 可在详情中切换；「历史」展示各附件的提取、翻译及解析记录。阅读器侧栏只显示当前 PDF 的成果，对话界面仍可访问所有对话。旧翻译历史也从文献详情查看。图片仅存储在本机，缺失图片不影响已保存文字阅读。

## 0.4.8 选文 OCR

「设置 → 功能配置 → 选中文本 → OCR增强选中文本内容提取」默认关闭。开启后，引用或翻译使用本机 OCR 识别选区，包含公式；首次使用会准备依赖并下载模型。无有效坐标或识别失败时提示并保留原选文，不阻断引用和翻译。默认关闭时优化 PDF 文字层的换行、断词、连字与上下标，无需 Python。OCR 不能保证公式准确，请对照原 PDF。
