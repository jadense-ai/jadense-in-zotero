# 本机 OCR 依赖安装与使用指南

> **0.5.0：**全文任务默认读取 PDF 文字层，无需先安装 OCR。在「设置 → OCR配置」按需开启全文 OCR 增强；不可用时尝试文字层并提示。扫描页没有文字层时仍需 OCR。下文强制准备 OCR 的说明对应 0.4.x 正式版；安装和排障步骤仍可用于可选 OCR。

0.5.0 的全文 Markdown、全文翻译和参考文献提取默认使用文字层，不需要 Python；扫描页可选用本机 OCR。建议先通过设置页准备，失败后按本机系统手动安装。

> 版本范围：统一准备入口已包含在正式版 **0.4.9**。细分下载进度、超时提示及「删除依赖 / 重新安装 OCR」是 正式版 **0.4.10** 的改进，v0.4.9 已发布 XPI 不一定有这些控件。源码版本号相同不代表安装包内容相同；旧版以实际界面为准。

- [设置界面操作](#settings)
- [环境要求与下载来源](#requirements)
- [手动安装前：目录和文件](#manual-preparation)
- [Windows 手动安装](#windows)
- [Linux 手动安装](#linux)
- [macOS 手动安装](#macos)
- [模型准备与验证](#models)
- [手动取得 uv](#uv-download)
- [修复、删除与重装](#repair)
- [常见故障](#troubleshooting)
- [全文使用、数据位置与验证范围](#usage)

<a id="settings"></a>

## 1. 设置界面操作（推荐）

1. 在 Zotero 打开 Jadense 工作台，点击左下角设置，进入 **OCR配置**。Zotero 原生设置中的 Jadense OCR 区域使用同一套状态与操作。
2. 在 **模型下载源** 选择来源：默认是 Hugging Face（或系统 `HF_ENDPOINT`）；连接困难时可选 **魔搭 ModelScope（中国国内）** 或 **HF-Mirror（第三方镜像）**。切换来源保留已有缓存，仅影响后续模型下载，不改变 Python 包下载源或翻译服务。
3. 点击 **启用本机 OCR**，插件自动检查 uv、安装独立 Python 及依赖、准备模型，最后用合成样例离线验证。不需要填写 Python 路径、端口、API Key 或攻玉令牌。
4. 等待 **已就绪 · 可以开始全文任务**。可以离开设置页，但应保持 Zotero 运行。当前源码显示阶段、文件/批次、下载量、平均速度和等待时间；总大小未知时显示不定进度，不应直接视为卡死。组件安装和模型准备各最多 30 分钟。
5. 显示 **识别组件已安装 · 还需准备模型** 时，点击 **继续准备**。失败后展开 **环境与故障排查**，查看最近错误及日志路径；模型下载失败可换源后继续，完整文件会复用。
6. 打开一个本机 PDF，在阅读器侧栏 **全文 Markdown → 提取原文** 验证正文提取。全文翻译还需配置对应的 AI 或 Bing/Google 翻译服务。

**重新检查**检查环境及已有模型，不负责联网安装或下载；**修复识别组件**重新同步锁定依赖并验证模型，保留已下载模型。每次打开设置会自动读取状态，就绪后无需反复修复。

| 状态 | 下一步 |
| --- | --- |
| 尚未启用 | 点击「启用本机 OCR」 |
| 识别组件已安装 · 还需准备模型 | 点击「继续准备」 |
| 已就绪 · 可以开始全文任务 | 直接提取原文或运行全文任务 |
| 准备未完成 · 已下载内容会保留 | 看错误，修复网络/空间或换模型源，再继续 |
| 暂时无法读取状态 | 「重新读取状态」仅重读；持续失败时查看日志 |
| 依赖已删除 · 需要重新安装（0.4.10） | 点击「重新安装 OCR」；历史成果仍可阅读 |

选文 OCR 是独立的可选功能：在 **设置 → 功能配置 → 选中文本 → OCR增强选中文本内容提取** 开启，默认关闭。选文公式使用额外的 CodeFormulaV2 模型，首次使用时另行准备；全文就绪不代表该模型已就绪。识别失败时提示并沿用原选文，不阻断引用和选文翻译。

<a id="requirements"></a>

## 2. 环境要求与下载来源

| 项目 | 当前要求 |
| --- | --- |
| Python | CPython **3.12**（`>=3.12,<3.13`）；自动安装无需预装 Python |
| Python 依赖 | `docling[rapidocr]==2.126.0`、`rapidocr==3.9.2`；间接依赖由 [uv.lock](../content/ocr/uv.lock) 固定 |
| 安装工具 | 优先复用 uv **>=0.9.3**，否则下载插件专用 uv 0.9.3 并校验官方 SHA-256 |
| Windows | 自动下载目标为 **x64**，需要 Windows PowerShell；不宣称支持 Windows ARM64 原生安装 |
| Linux | 脚本提供 **x86_64 / aarch64** 的 GNU/Linux uv，建议 glibc 发行版；Alpine/musl 不在此安装路径范围内 |
| macOS | 脚本提供 **Intel x86_64 / Apple Silicon arm64**；依赖是否有兼容 wheel 仍取决于系统版本和架构 |
| Unix 工具 | `/bin/sh`、`curl`、`tar`、`shasum`、`awk`、`cut` 等常见命令 |
| 资源 | 稳定 HTTPS 网络、数 GB 可用磁盘空间；默认 CPU、4 个 Docling 计算线程，无需 CUDA |

依赖和模型使用不同下载来源：

- uv/Python：GitHub 的 `astral-sh/uv` 与 Python 发行资产。
- Python 包：锁文件中的 PyPI 索引及发行文件；OCR 设置中的模型源不能解决 PyPI 下载失败。
- 版面/表格/公式模型：Hugging Face、HF-Mirror 或 ModelScope。全文版面使用 [Egret Large](https://huggingface.co/docling-project/docling-layout-egret-large)。
- 文字识别模型：RapidOCR 3.9.2 内置的官方 ModelScope 来源，不完全随 Python 包提供，首次识别仍可能下载。

ModelScope 适配固定的 `ds4sd/docling-layout-egret-large`、`ds4sd/docling-models`、`ds4sd/CodeFormulaV2`，文件经 SHA-256 核验；重试复用完整文件，不是字节级断点续传。切换模型源不要求重装环境。这些公开模型不需要模型站点密钥。

<a id="manual-preparation"></a>

## 3. 手动安装前：目录和文件

### 找到当前 profile

运行目录是当前 Zotero **profile 配置目录**下的 `jadense-ocr/v1/`，不是存放论文和 `zotero.sqlite` 的文献数据目录。

打开 **OCR配置 → 环境与故障排查 → 本机日志**，查看 `install.log` 的完整路径，其父目录就是运行目录。默认位置参见 [Zotero 官方说明](https://www.zotero.org/support/kb/profile_directory)：

| 系统 | 常见 profile 位置 |
| --- | --- |
| Windows | `%APPDATA%\Zotero\Zotero\Profiles\<profile>` |
| Linux | `~/.zotero/zotero/<profile>` |
| macOS | `~/Library/Application Support/Zotero/Profiles/<profile>` |

自定义 profile、多 profile 或沙盒安装可能不同，以日志路径为准。不要用通配符同时安装到所有 profile。下文 `<profile>` 和源码路径都须替换为自己的真实位置。

### 准备同一版本的五个文件

点击过安装按钮后，运行目录通常已经有 `install.ps1`、`install.sh`、`server.py`、`pyproject.toml`、`uv.lock`。齐全时跳过下面各系统的复制步骤。

如果缺少文件，从与插件匹配的源码包 **content/ocr/** 复制这五个文件。已发布插件可使用对应 Release 的 **Source code** 压缩包；main 构建的插件使用同一次源码。Source code 仅用于取得文件，不能作为 `.xpi` 安装。不要混用不同版本的服务脚本和锁文件，不要复制他人的 `.venv`、模型就绪标记或整个 profile。

**手动操作前等待准备任务结束，并退出 Zotero**，避免并发修改环境。只有安装系统工具时按包管理器要求提升权限，不以管理员/root 身份运行 OCR 安装器。

<a id="windows"></a>

## 4. Windows 手动安装（PowerShell）

### 4.1 准备目录与文件

在普通 PowerShell 中替换实际路径；五个文件已存在时只设置 `$ocrRuntime`，跳过复制：

```powershell
$ocrRuntime = Join-Path $env:APPDATA 'Zotero\Zotero\Profiles\<profile>\jadense-ocr\v1'
$ocrSource = 'C:\path\to\jadense-in-zotero\content\ocr'
New-Item -ItemType Directory -Force -Path $ocrRuntime | Out-Null
foreach ($name in @('install.ps1', 'install.sh', 'server.py', 'pyproject.toml', 'uv.lock')) {
    Copy-Item -LiteralPath (Join-Path $ocrSource $name) -Destination (Join-Path $ocrRuntime $name) -ErrorAction Stop
}
```

### 4.2 运行安装器

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ocrRuntime\install.ps1" -RuntimeDirectory $ocrRuntime
if ($LASTEXITCODE -ne 0) { throw 'OCR 依赖安装失败；先解决上面的错误，再继续。' }
```

`Bypass` 只作用于这次进程，不修改系统执行策略。脚本探测 PATH、`%USERPROFILE%\.local\bin`、`%USERPROFILE%\.cargo\bin` 和运行目录中的 uv，不覆盖用户 uv。构建缓存使用 `%LOCALAPPDATA%\Jadense\uv`，Python 与虚拟环境仍属于当前 profile。

### 4.3 不运行安装脚本：手动使用 uv

这是 4.2 的替代方案，无需重复执行。按 [uv 官方安装说明](https://docs.astral.sh/uv/getting-started/installation/)安装 uv，例如已有 WinGet 时运行 `winget install --id=astral-sh.uv -e`，重开终端并检查 `uv --version` >=0.9.3；不在 PATH 时使用绝对路径。

在同一 PowerShell 会话中设置 `$ocrRuntime` 后执行：

```powershell
$env:UV_PYTHON_INSTALL_DIR = Join-Path $ocrRuntime 'python'
$env:UV_CACHE_DIR = Join-Path $env:LOCALAPPDATA 'Jadense\uv'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $ocrRuntime '.venv'
Remove-Item -LiteralPath (Join-Path $ocrRuntime 'ready-2.126.0-3.9.2') -ErrorAction SilentlyContinue
uv sync --project $ocrRuntime --python 3.12 --frozen
if ($LASTEXITCODE -ne 0) { throw '锁定依赖同步失败' }
& "$ocrRuntime\.venv\Scripts\python.exe" -c 'from docling.document_converter import DocumentConverter; from rapidocr import RapidOCR; import onnxruntime'
if ($LASTEXITCODE -ne 0) { throw '依赖导入失败，不得写入就绪标记' }
Set-Content -LiteralPath (Join-Path $ocrRuntime 'ready-2.126.0-3.9.2') -Value 'ready'
```

不要以 Python 3.13/3.14 替代 3.12，不要用只锁两个直接依赖的 `pip install` 代替 `uv.lock`。安装后继续[模型准备与验证](#models)。

<a id="linux"></a>

## 5. Linux 手动安装（终端）

### 5.1 检查系统工具

```sh
uname -m
command -v sh curl tar shasum awk cut
```

Debian/Ubuntu 缺少工具时：

```sh
sudo apt-get update
sudo apt-get install curl ca-certificates tar perl
```

Fedora 可使用 `sudo dnf install curl ca-certificates tar perl-Digest-SHA`。其他发行版使用自己的包管理器提供相同命令。确认全部命令存在后，以下操作使用运行 Zotero 的普通用户。

### 5.2 准备文件并运行安装器

五个文件已存在时，只设置 `ocr_runtime` 并运行最后的安装命令：

```sh
ocr_runtime="$HOME/.zotero/zotero/<profile>/jadense-ocr/v1"
ocr_source='/path/to/jadense-in-zotero/content/ocr'
(
  set -eu
  mkdir -p "$ocr_runtime"
  for name in install.ps1 install.sh server.py pyproject.toml uv.lock; do
    cp "$ocr_source/$name" "$ocr_runtime/$name"
  done
)
# 上面复制成功后执行；任何报错都应解决后再继续。
sh "$ocr_runtime/install.sh" "$ocr_runtime"
```

确认最后命令退出码为 0（`echo $?`）。脚本选择 x86_64 或 aarch64 的 GNU/Linux uv。用 `sh` 执行不要求脚本有可执行权限。

### 5.3 不运行安装脚本：手动使用 uv

这是 5.2 安装命令的替代方案，仍须先准备五个文件。按 [uv 官方说明](https://docs.astral.sh/uv/getting-started/installation/)安装 uv，或按[手动取得 uv](#uv-download)放到运行目录，确认版本 >=0.9.3。

```sh
# 使用运行目录内 uv 时改为 uv_bin="$ocr_runtime/uv"。
uv_bin=uv
(
  set -eu
  export UV_PYTHON_INSTALL_DIR="$ocr_runtime/python"
  export UV_CACHE_DIR="$ocr_runtime/uv-cache"
  export UV_PROJECT_ENVIRONMENT="$ocr_runtime/.venv"
  rm -f "$ocr_runtime/ready-2.126.0-3.9.2"
  "$uv_bin" sync --project "$ocr_runtime" --python 3.12 --frozen
  "$ocr_runtime/.venv/bin/python" -c 'from docling.document_converter import DocumentConverter; from rapidocr import RapidOCR; import onnxruntime'
  printf 'ready\n' > "$ocr_runtime/ready-2.126.0-3.9.2"
)
```

子 shell 的 `set -eu` 确保同步或导入失败后不写成功标记。不使用 `sudo uv sync` 或 `sudo pip`。Flatpak/Snap 中的 profile、PATH 和宿主程序访问可能不同，宿主终端安装成功不证明沙盒插件可用；此类环境未验收。完成后继续[模型准备与验证](#models)。

<a id="macos"></a>

## 6. macOS 手动安装（Terminal）

### 6.1 确认架构并准备文件

五个文件已存在时，只设置 `ocr_runtime`，无需复制：

```sh
uname -m
command -v sh curl tar shasum awk cut
ocr_runtime="$HOME/Library/Application Support/Zotero/Profiles/<profile>/jadense-ocr/v1"
ocr_source='/path/to/jadense-in-zotero/content/ocr'
(
  set -eu
  mkdir -p "$ocr_runtime"
  for name in install.ps1 install.sh server.py pyproject.toml uv.lock; do
    cp "$ocr_source/$name" "$ocr_runtime/$name"
  done
)
```

Apple Silicon 原生终端通常显示 `arm64`，Intel 为 `x86_64`。不要在同一虚拟环境混用两种架构。Finder 可用「前往 → 前往文件夹」打开 `~/Library/Application Support/Zotero/Profiles/`；实际目录仍以插件日志为准。

### 6.2 运行安装器

```sh
sh "$ocr_runtime/install.sh" "$ocr_runtime"
```

确认退出码为 0（`echo $?`）。脚本自动选择 Apple Silicon 或 Intel 的 uv，不需要预装 Homebrew/Python；也探测 `/opt/homebrew/bin/uv`、`/usr/local/bin/uv`、`~/.local/bin/uv` 和 `~/.cargo/bin/uv`，适配桌面程序不继承终端 PATH 的情况。

### 6.3 不运行安装脚本：手动使用 uv

这是 6.2 的替代方案。已有 Homebrew 时可执行 `brew install uv`，用 `uv --version` 确认 >=0.9.3；没有 Homebrew 可直接按 [uv 官方说明](https://docs.astral.sh/uv/getting-started/installation/)取得二进制。

```sh
uv_bin=uv
(
  set -eu
  export UV_PYTHON_INSTALL_DIR="$ocr_runtime/python"
  export UV_CACHE_DIR="$ocr_runtime/uv-cache"
  export UV_PROJECT_ENVIRONMENT="$ocr_runtime/.venv"
  rm -f "$ocr_runtime/ready-2.126.0-3.9.2"
  "$uv_bin" sync --project "$ocr_runtime" --python 3.12 --frozen
  "$ocr_runtime/.venv/bin/python" -c 'from docling.document_converter import DocumentConverter; from rapidocr import RapidOCR; import onnxruntime'
  printf 'ready\n' > "$ocr_runtime/ready-2.126.0-3.9.2"
)
```

若 uv 放在运行目录，将 `uv_bin=uv` 改为 `uv_bin="$ocr_runtime/uv"`。路径含空格，保留所有引号。没有对应系统/架构 wheel 时，记录具体包名和系统版本；不要混用架构或随意升级锁定依赖。继续下一节。

<a id="models"></a>

## 7. 模型准备与验证

### 7.1 回到设置页完成（推荐）

重开 Zotero，在 **设置 → OCR配置** 点击 **重新检查**（刷新手动安装前的缓存状态），再点击 **继续准备**。等到“已就绪”，用小型本机 PDF 执行全文 Markdown 提取。`ready-2.126.0-3.9.2` 仅表示 Python 组件安装完成，不能代替模型验证。

### 7.2 完全通过终端准备模型

适合观察完整输出；保持 Zotero 退出，沿用前文运行目录变量。来源值为 `default`、`hf-mirror` 或 `modelscope`，以下以 ModelScope 为例。环境变量只影响当前终端及子进程，**不保存插件设置页选项**。

Windows PowerShell：

```powershell
$env:JADENSE_OCR_MODEL_SOURCE = 'modelscope'
$env:JADENSE_OCR_SETUP_PROGRESS = '1'
& "$ocrRuntime\.venv\Scripts\python.exe" "$ocrRuntime\server.py" --prepare-models $ocrRuntime
if ($LASTEXITCODE -ne 0) { throw '模型准备或样例识别失败' }
& "$ocrRuntime\.venv\Scripts\python.exe" "$ocrRuntime\server.py" --check-models $ocrRuntime
if ($LASTEXITCODE -ne 0) { throw '模型尚未就绪' }
```

Linux / macOS（`ocr_runtime` 使用对应系统前文设置的值）：

```sh
JADENSE_OCR_MODEL_SOURCE=modelscope JADENSE_OCR_SETUP_PROGRESS=1 \
  "$ocr_runtime/.venv/bin/python" "$ocr_runtime/server.py" --prepare-models "$ocr_runtime"
# 上一步成功退出后再检查。
"$ocr_runtime/.venv/bin/python" "$ocr_runtime/server.py" --check-models "$ocr_runtime"
```

最后应看到 `{"modelsReady": true}` 且退出码为 0。`--prepare-models` 先验证已有缓存，必要时下载缺失文件，再通过合成 PDF 识别写入 `models-ready.json`；`--check-models` 只检查就绪凭据。不要手工创建或从另一台电脑复制模型就绪 JSON。

提前准备**选文公式模型**时，将准备命令中的 `--prepare-models` 换成 `--prepare-selection-models`，成功后生成独立的 `selection-models-ready.json`；它不能替代全文模型准备。普通全文提取用户可跳过。

命令行输出默认留在终端，不保证写入设置页日志，排障时保存当前终端输出。不要无参数启动 `server.py` 来配置固定端口：插件会管理随机本机端口、会话凭证和服务退出。

<a id="uv-download"></a>

## 8. 安装器无法下载 uv 时

从 [uv 0.9.3 官方发行页](https://github.com/astral-sh/uv/releases/tag/0.9.3)取得对应压缩包和同名 `.sha256` 文件：

| 环境 | 压缩包 |
| --- | --- |
| Windows x64 | `uv-x86_64-pc-windows-msvc.zip` |
| Linux x64 | `uv-x86_64-unknown-linux-gnu.tar.gz` |
| Linux ARM64 | `uv-aarch64-unknown-linux-gnu.tar.gz` |
| macOS Intel | `uv-x86_64-apple-darwin.tar.gz` |
| macOS Apple Silicon | `uv-aarch64-apple-darwin.tar.gz` |

Windows 用 `Get-FileHash -Algorithm SHA256 'C:\path\to\uv-....zip'`，Linux/macOS 用 `shasum -a 256 '/path/to/uv-....tar.gz'`，与官方 `.sha256` 内容核对。通过后解压，将 `uv.exe`（Windows）或 `uv`（Unix）直接放进运行目录，不多套一层 `uv-<target>/`。Unix 确认可执行，必要时运行 `chmod +x "$ocr_runtime/uv"`，然后重跑安装器。

这只是离线取得 uv，不是完整离线安装：Python、锁定依赖及模型仍需下载或已有完整缓存；不同系统的 `.venv` 不能直接互拷。

<a id="repair"></a>

## 9. 修复、删除与重装

0.4.7–0.4.10 使用相同的 `jadense-ocr/v1/` 和当前锁定依赖，无需仅因升级就删除环境；0.4.8 新增选文公式模型需额外准备。有效模型凭据直接复用，旧缓存缺少凭据时可先离线验证再补写。

1. **下载失败**：修复网络或换模型源，再点击「继续准备」。
2. **组件损坏或持续无法启动**：点击「修复识别组件」，重新同步依赖、检查关键模块导入并验证模型，保留已下载模型。
3. **修复仍失败**（以下按钮自 0.4.10 提供）：展开「环境与故障排查 → 删除与重装」，点击「删除依赖…」。默认不勾选「同时删除已下载模型」；怀疑模型损坏或确需释放空间时才勾选。确认后先停止服务，再删除插件专用依赖。
4. 删除成功后点击「重新安装 OCR」，等待依赖和模型重新验证。删除本身不自动开始下载。

删除范围包括运行目录内 `.venv`、插件专用 Python/uv、安装缓存及就绪标记，默认保留 `models/`。PDF、已保存原文/翻译/解析成果、识别缓存 `cache/`、日志及用户自行安装的 Python/uv 均保留；Windows 共享缓存 `%LOCALAPPDATA%\Jadense\uv` 不由此操作清理。随 Python 包安装的少量模型仍可能重下，保留 `models/` 不等于完全免下载。

OCR 或准备任务进行中应先结束任务再删除；文件占用/停止超时会报错，可重启 Zotero 再试。旧版没有删除按钮时优先修复或重跑安装器，不要删除整个 profile。

<a id="troubleshooting"></a>

## 10. 常见故障

| 现象 | 检查与处理 |
| --- | --- |
| uv 下载失败 / SHA-256 不匹配 | 检查 GitHub 发行资产访问、代理及下载完整性；从官方来源重新下载核验，不关闭校验 |
| Python 或依赖下载失败 | 确认 Python 3.12、uv >=0.9.3、网络和空间；查看完整输出。模型源设置不影响 PyPI |
| `shasum: not found` | Linux 安装发行版的 Perl/Digest::SHA 工具后重试 |
| Unix 出现 `\r` / `bad interpreter` | 使用原始 LF 文件；Windows 克隆可用 `git -c core.autocrlf=false clone https://github.com/jadense-ai/jadense-in-zotero.git`，避免编辑器改成 CRLF |
| Windows 长路径构建错误 | 使用安装器的 `%LOCALAPPDATA%\Jadense\uv` 缓存，避免深层 profile 构建路径；按具体包错误排查 |
| `DLL load failed` / 缺少 `.so` / 无兼容 wheel | 确认失败模块、系统和 CPU 架构，补齐对应官方运行库/发行版包后重做导入检查；不手工伪造 ready 标记 |
| 组件已安装，仍提示需要准备 | 模型未验证；点「继续准备」或运行模型命令，不只看 Python 文件是否存在 |
| 模型下载停滞/超时 | 查看阶段和日志，选择 ModelScope/HF-Mirror 后继续，已完成文件保留，不必先删全部缓存 |
| 手动安装后界面仍显示旧状态 | 确认当前 profile，重开 Zotero 后「重新检查」；“已删除”状态也需要刷新 |
| 选文公式失败但全文可用 | 额外 CodeFormulaV2 未准备/加载失败；查看 `selection-models-prepare.log` |
| 权限错误/文件占用 | 退出 Zotero 后再手动修改；确认目录属于当前用户且可写、空间足够 |

设置页安装的 `install.log` 每次安装覆盖；模型准备看 `models-prepare.log`，选文公式看 `selection-models-prepare.log`。反馈时提供插件/Zotero/系统版本、架构、失败阶段和脱敏错误片段，不提交整个 profile 或含论文正文的缓存。

<a id="usage"></a>

## 11. 全文使用、数据位置与验证范围

### 全文提取与翻译

阅读器侧栏提供「对话 / 全文 Markdown / 全文翻译 / 选中翻译历史 / 解析结果」。在全文 Markdown 点击「提取原文」，检查正文、表格、图片和公式；提取不会自动翻译。全文翻译复用已有原文，缺少时先提取。重新提取会创建新版本，旧译文仍对应旧原文，历史不自动重译。

Docling + RapidOCR 本机处理 PDF，Egret Large 重建阅读顺序；公式以本机原图保留，正文请求中为占位符。翻译把提取文字发给所选 AI、Bing 或 Google，PDF 和公式裁图不上传 OCR 模型下载站点。Bing/Google 每片分别最多 1,000/5,000 UTF-16 字符，不保证逐句对齐。

生成期间禁用定位，暂停/失败/完成后可定位已完成内容。未完成内容是当前会话内草稿；继续只请求未完成片段。网络中断后重试片段可能产生额外费用，限流后按提示手动继续，不自动换服务。工作台「解析历史」按文献汇总成果，详情可切换 PDF 和历史；图片缺失不影响已保存文字阅读。

### 本机数据

`.venv/` 保存依赖，`models/` 保存模型，`cache/` 按 PDF 内容摘要和解析版本保存识别结果，可能包含论文正文，由当前用户目录权限保护。服务仅监听随机回环端口，凭证经进程 stdin 传入，不接收任意文件路径、不提供 CORS；退出 Zotero 会停止服务和识别子进程。

XPI 只包含五个安装/服务源文件，不包含 Python、模型或缓存。已有完整有效缓存时本机识别可离线运行，翻译仍有自己的网络和账号要求。复杂公式、表格、字体与混合栏版式应对照原 PDF；OCR 不保证识别正确。

### 开发者验证

在源码根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm build
uv sync --project content/ocr --python 3.12 --frozen
content/ocr/.venv/Scripts/python.exe -m unittest discover -s content/ocr -p test_server.py
node scripts/smoke-local-ocr.mjs content/ocr/.venv/Scripts/python.exe content/ocr/.cache
node scripts/smoke-local-ocr.mjs content/ocr/.venv/Scripts/python.exe content/ocr/.cache --complex --scan
```

Linux/macOS 将 Python 路径改为 `content/ocr/.venv/bin/python`。原生检查遵循[贡献指南](../CONTRIBUTING.md#开发与本机验证)，使用隔离 profile，不使用真实资料库。

历史 Windows 原生一键安装与流式阅读已有实测；0.4.10 标签原包通过 Windows 11 / Zotero 10.0.3 三次冷启动、后台解析专项及从 0.4.9 升级，详见 [Release 验收范围](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.10)；单元/静态/构建检查通过，**不代表重新完成首次全量下载、macOS/Linux 安装或真实翻译服务验收**。合成复杂 PDF 回归不能替代真实论文对照。

## 0.5.1 云 OCR 与用途开关

OCR 用途开关现位于功能配置，引擎和凭证仍在 OCR 配置。无需本机 Python 的云 OCR、上传确认、费用和排障见[配置指南](usage-guide.md#settings-051)。本页的依赖安装步骤仅适用于本机 OCR。
