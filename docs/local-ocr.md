# 本机 OCR 安装与全文翻译

## 全文翻译与本机 OCR

设置 → 功能配置 → 翻译中点击 **安装并启动本机 OCR**。首次全文翻译也会准备相同环境。插件先使用 Docling + RapidOCR 在本机识别完整 PDF，再将有序正文发送给所选 AI 或 Bing/Google；PDF 文件和公式裁图不会上传给 OCR 云服务。其他功能不要求安装 Python。

整页 OCR 使用 Docling 的 [Egret Large 版面模型](https://huggingface.co/docling-project/docling-layout-egret-large) 重建阅读顺序，段落和跨页正文按容量组成请求，不再逐个文字层碎片请求。AI 返回 Markdown 并流式显示；Bing、Google 每片分别最多 1,000、5,000 UTF-16 字符。公式在本机以原图保留，随正文发送的是占位符。页码采用 PDF 实际第 1～N 页，定位范围对应当前容量片覆盖的来源区域；机器翻译不保证逐句与原文一一对齐。

生成期间禁用定位；暂停、失败或完成后可以定位已完成内容。未完成内容标为草稿，仅保存在当前插件会话内。继续只请求未完成的切片；限流显示可继续时间，不自动重试或换服务。网络中断后手动继续会重新请求该未完成片，先前请求可能已产生费用。旧历史不会自动重译，需要主动点击「重新翻译」使用 OCR。

## 安装环境

自动安装在当前 Zotero **配置目录**（不是文献数据目录）的 `jadense-ocr/v1/` 中进行：

- Windows x64：系统 Windows PowerShell、HTTPS 网络；无需预装 Python 或管理员权限。
- macOS Intel/Apple Silicon、Linux x64/ARM64：`/bin/sh`、`curl`、`tar`、`shasum`。平台与 Python 依赖的 wheel 支持以实际安装结果为准。
- uv 0.9.3（校验官方 SHA-256）、独立 CPython 3.12、Docling 2.126.0、RapidOCR 3.9.2；间接依赖由 [uv.lock](../content/ocr/uv.lock) 固定。
- 默认 CPU、4 个 Docling 计算线程；无需 CUDA。首次下载 Python、PyTorch/ONNX 依赖和版面模型，需数 GB 可用磁盘空间及稳定网络。首次加载比后续慢，识别速度随 CPU 和页数变化。
- 下载来源：GitHub 的 astral-sh/uv 与 Python 发行资产、PyPI、Hugging Face 的 Docling 模型。RapidOCR 模型随其安装包提供；不需要攻玉令牌或模型下载密钥。

环境目录中的 `.venv/` 是 Python 依赖，`models/` 是模型缓存，`cache/` 是按 PDF 内容摘要与解析版本缓存的识别结果。缓存包含本机论文正文，使用操作系统当前用户目录权限保护。服务只监听随机本机回环端口，凭证仅经进程 stdin 传入；不接收任意文件路径，不提供 CORS。插件退出会关闭其服务与正在识别的子进程。

## 自动安装失败后的手动步骤

先重试设置页安装按钮。界面保留安装错误末尾信息；网络受限、磁盘不足或依赖下载失败时，不会改用云端 OCR。修复网络或空间后可以再次安装，成功标记仅在安装完整结束后写入。

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

macOS/Linux 对应命令使用 `python3.12 -m venv .venv` 与 `.venv/bin/python`；依赖导入检查成功后执行 `touch ready-2.126.0-3.9.2`。随后回到插件点击安装启动或全文翻译，插件会管理随机端口和会话凭证，无需手动运行 HTTP 服务。

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
