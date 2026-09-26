# 更新说明 / Changelog

## 0.6.5 — 2026-09-26

- Windows x64 新增包含插件、PDF 版面引擎与全文 OCR 引擎的完整离线 ZIP。解压后安装其中的 XPI，再分别导入两个引擎 ZIP；无需预装 Python/uv 或管理员权限。
- PDF 引擎优先使用固定版本的完整包，并改进代理继承、可恢复下载及阶段化错误说明。完整性或离线健康检查失败时保留已有引擎。
- 本机 OCR 增加匹配版本的离线引擎导入，包含全文识别模型；选文公式增强仍在首次使用时另行下载。AI 翻译仍需要服务与网络。
- 固定 Docling TableFormer 的 ModelScope 下载提交，避免镜像分支前移导致离线引擎构建摘要不匹配。
- Windows x64 gains a complete offline ZIP containing the plugin, PDF layout engine and full-document OCR engine. Extract it, install the included XPI, then import each engine ZIP; preinstalled Python/uv and administrator access are unnecessary.
- PDF setup prefers the fixed full bundle, with improved proxy inheritance, resumable downloads and stage-specific errors. The existing engine is retained if integrity or offline health checks fail.
- Local OCR can import the matching offline engine bundle, including full-document recognition models. Selection formula enhancement still downloads separately on first use; AI translation still requires a service and network access.
- Pin the Docling TableFormer ModelScope commit so offline engine builds do not drift when the mirror branch advances.
- 已公开发布；完整离线套装仅覆盖 Windows x64。Windows 11 / Zotero 10.0.3 通过 XPI 冷启动、普通用户环境下两种引擎离线安装与识别/渲染检查；其他系统及 Zotero 8/9 未实测。
- Released publicly. The complete offline suite targets Windows x64. Windows 11 / Zotero 10.0.3 passed XPI cold starts and both engines' offline installation and recognition/rendering checks in a standard-user environment; other systems and Zotero 8/9 were not tested.

## 0.6.3 — 2026-09-24

- 关联 PDF 超出模型上下文时，AI 对话和图片解读默认选取问题相关的原文片段，不再自动发起多轮全文概括；新建图片对话本身不会整理全文。
- 如需分批概括全文，可在「设置 → 功能配置 → AI 对话 → 关联 PDF 长文处理」明确开启；图片解读沿用同一设置。开启后按模型输入容量尽量填满每批，减少不必要的整理请求及等待。
- AI 请求长时间没有输出时会结束等待并提示；停止请求后界面及时解除加载。长文结果仍需对照 PDF 原文核查，真实 Provider 的速度和质量取决于服务端。
- Linked PDFs that exceed the model context now use question-relevant source passages by default in chat and figure interpretation, without automatic full-document summaries. Starting a figure conversation alone does not summarize the PDF.
- Opt in to full-document batch summaries under Settings → Feature settings → AI chat → Linked PDF long text. Figure interpretation shares this setting; enabled batches fill the model input budget more efficiently.
- Requests with no output for an extended period end with a visible notice, and stopping a request clears the loading state. Check answers against the PDF; provider latency and quality vary.

## 0.6.2 — 2026-09-24

- 自动更新提示和手动检查更新窗口显示 GitHub 最新正式版的更新要点；Release 正文从本版起使用固定的中英文 Markdown 栏目，旧版说明仍可回退读取。更新内容获取失败时仍可查看版本和下载入口。
- 「对照翻译」归入统一阅读操作，窄窗口下进入「•••」菜单；运行时图标显示进度，阅读器侧栏遵循 Zotero 原生侧栏的收起与重新展开状态。
- 不新增设置或数据迁移；继续使用现有 PDF 排版引擎，Windows x64 离线引擎包仍见 v0.6.0 附件。GitHub 发布不会自动更新官网安装清单。
- The automatic update prompt and manual update check show highlights from the latest GitHub Release. Release bodies use fixed bilingual Markdown sections from this version onward, with a fallback for older notes.
- Parallel translation joins the reading actions menu when space is tight; the running icon shows progress, and the plugin sidebar follows Zotero's native pane state. Existing settings and the v0.6.0 layout-engine bundle remain compatible.

## 0.6.1 — 2026-09-23

- 移除设置 → 功能配置底部的“查看待恢复 AI 请求”按钮及专用结果面板，清理关联样式；任务与聊天内部的恢复机制不变。
- 不增加配置项或数据迁移；已有 AI 服务、字号、历史与版面解析引擎可继续使用。引擎离线包继续使用 v0.6.0 附件。
- Remove the “Show pending AI requests” button and its dedicated panel from feature settings; task and chat recovery remain unchanged. Existing settings, history and the v0.6.0 layout-engine bundle remain compatible.

## 0.6.0 — 2026-09-23

## 本次更新

v0.6.0 相比 v0.5.1，重点新增 **PDF 对照与原位翻译**：保留论文版面阅读译文，边生成边查看，失败后保留已有成果并继续补译。同时改进翻译请求调度、长文处理和设置体验。

### PDF 对照阅读与导出

- 从 PDF 阅读操作进入「对照翻译」，并排查看原文和译文；可切换为整页译文，也可打开独立窗口用于多屏阅读。
- 支持连续滚动、同步/解除同步滚动，方便按自己的节奏对照核读。
- 「保存译文」导出仅译文 PDF，「保存对照」导出原文与译文对照 PDF；不会覆盖原附件。
- 新功能与原有侧栏段落翻译并存，可根据阅读习惯选择。

### 精简、完整与部分成果

- 默认「精简」：翻译正文、图表说明和学术脚注，出版信息与参考文献保留原文；「完整」翻译所有可译文字。
- 整理文段并聚合请求，减少碎片化翻译；完成内容逐步显示，不必等待全文结束。
- 部分段落失败时，已完成成果仍可阅读和导出；点击「补译未完成部分」复用已完成片段。
- 改进临时网络错误、限流、模型输出不完整和版面处理异常的恢复提示。重试和补译可能继续产生服务费用，不代表原请求一定未计费。

### 翻译与设置体验

- 全文翻译新增「请求与速度（高级）」：按服务地址设置并发、每分钟 HTTP 请求数和 PDF 每批原文 token，并查看在途及排队状态。多个翻译入口共享相应服务额度。
- OCR 与 PDF 排版引擎集中到「外置依赖配置」，功能设置提供跳转入口。
- 「界面字号」改为滑块：80%–200%、1% 微调，显示当前百分比，拖动即时生效，可恢复 100%；工作台与原生设置共用偏好。
- 改进长文提取、翻译成果读取与文件处理，减少重复工作；保留已有设置及历史。

## 操作与配置

### 1. 安装与升级

下载本页 `jadense-in-zotero-v0.6.0.xpi`，在 Zotero「工具 → 插件 → 齿轮 → 从文件安装插件」选择它，安装后重启 Zotero。

GitHub v0.5.1 用户可直接覆盖安装；相同 `.cn` 插件身份保留设置及本地历史。不要删除 Zotero profile。仍使用 `jadense-in-zotero@jadense.com` 的旧版用户，先禁用旧插件再安装，避免两套插件同时启用。GitHub Release 与官网自动更新渠道独立；未收到更新时请手动安装。

### 2. 选择翻译服务、模型与范围

1. **BYOK**：在「设置 → BYOK」添加服务商，填写 API Key、Base URL、协议与模型 ID；不需要攻玉账号。也可在「设置 → 连接攻玉」保存插件令牌，使用账号可用模型。
2. 在「设置 → 功能配置 → 全文翻译」选择翻译接口、AI 模型和精简/完整范围；目标语言按翻译入口选择。选文翻译与全文翻译独立配置。
3. 检查模型输出上限及服务商额度。首次建议保持默认速度，用较短的文字版 PDF 验证；遇到限流时降低并发或 HTTP 请求/分钟，不要同时启动大量任务。
4. 若需调整，展开「请求与速度（高级）」并保存：并发数为 1–8；RPM 包含检查和恢复请求。新速度用于尚未发送的请求，单批原文容量用于新任务。Bing/Google 网页翻译保持串行。

模型 Key 只填自己的服务商凭据，不要使用文档示例。翻译会将所需文字发送到选定服务；本机排版不代表 AI 离线运行。

### 3. 安装 PDF 版面解析引擎

普通问答、选文翻译及文字层 Markdown 提取不需要排版引擎；对照翻译需要它。**排版引擎与 OCR 独立**。

**自动安装**：在「设置 → 外置依赖配置 → 版面解析引擎」点击「准备 PDF 翻译引擎」，等待“已就绪”。也可从「功能配置 → 全文翻译 → 外置依赖」跳转。此版本自动准备使用随插件的安装器，下载独立 Python 3.12、锁定依赖、模型和字体，无需预装 Python；需能访问相关下载站。

**手动离线安装（Windows x64）**：下载本 Release 的 `jadense-pdf-engine-0.6.4-1-windows-x64.zip`，点击「导入离线包」选择 ZIP，无需解压、管理员权限或预装 Python/uv。可以在另一台电脑下载后复制过来。插件按固定 SHA-256 校验，在临时目录检测模型及 PDF 渲染，通过后替换引擎，保留任务成果及原 PDF。

- 包大小：462102143 字节（约 441 MiB）；建议至少预留 3 GiB。
- SHA-256：`b9b160f727f3bb962df8011a14131250c20753f64faac1793e902dbf6b6cf887`。
- 完整 ZIP 的自动下载开关在本版本仍未开启；自动准备与离线导入是两条不同安装路径。

**库内备用安装**：使用仓库 `content/pdf-translation/` 内的安装器、锁文件和适配器，按指南手动安装后点击「检测已安装引擎」。此备用源是安装源码，仍需联网下载依赖和资产，不是另一份模型镜像。请勿混用不同插件版本的文件。

检测不下载、不调用翻译服务；缺少模型或字体时使用「修复引擎」或重新导入匹配的离线包。不要关闭哈希校验或自行创建就绪标记。

详细步骤：[中文安装指南](https://github.com/jadense-ai/jadense-in-zotero/blob/main/docs/pdf-engine.md) · [English setup](https://github.com/jadense-ai/jadense-in-zotero/blob/main/docs/pdf-engine.en.md) · [操作指南](https://github.com/jadense-ai/jadense-in-zotero/blob/main/docs/usage-guide.md#pdf-translation-060)。

### 4. 开始对照翻译

打开文字版 PDF → 阅读操作「对照翻译」→ 选择目标语言和范围 → 等待译文逐步显示。可随时核对原文；部分完成时使用「保存译文 / 保存对照」，失败后再点「补译未完成部分」。更换范围仅影响新任务，旧历史不会自动重译。

扫描页保持原文；安装 PDF 引擎不会自动开启扫描 OCR。需要识别扫描文字时，请单独配置本机/云 OCR，并使用相应的原文提取与段落翻译流程。公式、表格和复杂版面应人工核对。

## 升级与兼容

- Manifest 声明支持 Zotero 8.0–10.0.*；实测范围见下方验收记录。
- Windows x64 提供完整引擎离线包；macOS、Linux、Windows ARM64 暂无本次验证的完整包，手动安装路径不等于已完成对应平台验收。
- 新版可复用兼容的历史成果；旧版未完成任务可能按新的分片策略重新开始，界面会提示，旧缓存仍保留。
- 原件和文献资料库不会因导出译文而被替换；翻译质量与网络可用性取决于所选模型/服务。真实付费 Provider、其他操作系统与 Zotero 8/9 不在本次实测范围。

## 验证与下载

- 使用标签 CI 原始 XPI，在 **Windows 11 build 26200 / Zotero 10.0.3** 验证三次冷启动、v0.5.1 原地升级、后台解析、中英文设置、窄窗与深浅色、150% 字号及重启保存。
- PDF 专项通过真实离线引擎导入、离线健康检查、真实排版、逐步成果、模拟 AI 批处理与共享限流、部分失败后仅补缺、同步滚动、原位切换、多屏往返、缓存与冷重启复用。翻译服务为合成回复，不代表真实模型译质。文件选择器初始化和导出流程已验证，人工确认保存对话框未端到端点击。
- 完整 PDF 专项首次在等待最新成果版本时超时，同一原包复验通过；原升级脚本的旧工具栏宽度/菜单断言已按新增入口修正，页码命中与遮挡检查保留。
- 1002 项 TypeScript 测试、Python 测试 37 项通过（1 项需显式资产路径的端到端用例跳过）、lint、类型检查、构建及制品校验通过；[发布 PR #25](https://github.com/jadense-ai/jadense-in-zotero/pull/25)、main 与[标签 CI](https://github.com/jadense-ai/jadense-in-zotero/actions/runs/35823684830)通过。
- XPI：4291117 字节；SHA-256：`e1ebc1b3b88cbef8f04c63ef37df2981e2f36444aa61abe933e658da15c9292d`。用附件 `SHA256SUMS` 核验 XPI；引擎 ZIP 使用同名 `.sha256` 文件。
- 附件包括 XPI、元数据、XPI 校验和、Windows x64 完整引擎 ZIP 与校验和、排版适配器/安装器源码包。其他平台、Zotero 8/9、真实云 OCR 与付费 Provider 未在本次验收。

---

### English

v0.6.0 adds layout-preserving parallel/in-place PDF translation, full-width and multi-screen reading, synchronized scrolling, and translated-only/bilingual PDF export. Concise mode translates body text, captions and academic footnotes while preserving publication details and references; Full mode translates all eligible prose. Results appear progressively. Partial output stays readable/exportable, and **Translate remaining passages** reuses completed segments.

Configure a provider under **Settings → BYOK**, or connect Jadense with a plugin token. Choose your translation service/model and scope under **Feature settings → Full translation**. Advanced request settings control concurrency (1–8), HTTP requests/minute and source tokens per PDF batch. Limits are shared by translation tools using the same service; Bing/Google remain serial. Retries may incur further charges.

Prepare the layout engine under **External dependencies → Layout parsing engine**. Automatic setup downloads isolated Python, locked dependencies, models and fonts. For Windows x64, import this release's complete engine ZIP without extracting it; preinstalled Python/uv and administrator access are not required. The full-bundle automatic-download switch is not enabled in this version. Repository-source manual installation still requires network downloads. See the [English installation guide](https://github.com/jadense-ai/jadense-in-zotero/blob/main/docs/pdf-engine.en.md).

The interface font setting is now an 80%–200% slider with 1% steps and an instant reset to 100%. Upgrade from v0.5.1 by installing the XPI and restarting Zotero; settings/history are retained. Do not enable the old `.com` plugin alongside the current `.cn` identity. Website automatic updates are maintained separately.

Scanned pages remain original; OCR is separate. Proofread formulas, tables and layout against the source. Windows x64 is the validated engine platform; other operating systems, Zotero 8/9 and live paid providers are not covered by this release's validation.


## 0.5.1 — 2026-09-22

- 新增可选云 OCR：MinerU、智谱 GLM-OCR、硅基流动、阿里百炼和 OpenAI 兼容服务；使用前配置密钥、模型和 HTTPS 地址，并确认文档上传及费用。普通文字层提取仍无需 OCR。
- 选文翻译和全文翻译独立配置；旧设置自动迁移，不覆盖已有独立设置。工作台与 Zotero 原生设置按任务分组，OCR 用途与引擎配置分开。
- 改进 Markdown、提取结果和更新弹窗显示。
- Optional cloud OCR supports MinerU, GLM-OCR, SiliconFlow, Alibaba Bailian and OpenAI-compatible services. Configure credentials/model/HTTPS endpoint and confirm upload and billing before use; ordinary text-layer extraction needs no OCR.
- Selection and full-document translation have separate settings. Existing settings migrate without overwriting independent preferences; workbench and native preferences group controls by task.
- Improve Markdown, extraction results and update-dialog presentation.
- 从 0.5.0 安装升级后重启；已有成果不会自动重算。Restart after upgrading from 0.5.0; existing results are not regenerated.
- [操作与配置 / Setup](docs/usage-guide.md#settings-051)。真实云服务、OCR 准确率、其他系统及 Zotero 8/9 尚未实测 / Live providers, OCR accuracy, other operating systems and Zotero 8/9 are not validated.

## 0.5.0 — 2026-09-21

## 本次更新

v0.5.0 相对 v0.4.10，新增文献分类和对话文件附件，让长 PDF 问答能按模型容量准备正文，并把全文任务的 OCR 改为按需使用。参考文献的原文、检索候选和选择状态也更清楚，便于导入前核对。

### 1. 独立文献分类窗口：先预览，再应用

- 在 Zotero 文献列表选择条目，右键「文献分类…」打开独立窗口，不必先打开对话工作台。
- 从当前文库选择候选分类目录，生成推荐后逐项核对，再应用到资料库；生成推荐本身不会修改条目，支持撤销本次归类。
- 分类独立使用 TypeSafe 的 Jev 服务，只发送所选文献的标题、摘要、标签和候选目录信息，不发送 PDF。需单独配置 TypeSafe API Key，不跟随对话模型或攻玉连接。
- 请求失败会停止后续请求，已完成的预览仍可查看；应用前会重新检查条目与目录状态，避免把过期预览写入资料库。

### 2. 对话可附文件：从论文扩展到研究材料

- 可在对话中添加 PDF、Word DOCX、HTML、Markdown 和常用文本文件，包括 CSV、TSV、JSON、BibTeX、TeX、XML、YAML、RIS；PNG/JPEG 图片入口继续可用。
- 文字在本机提取，附件信息与提取文字随本地对话保存，后续问题可继续使用相应上下文。
- 单个上传文件最大 **20 MB**，最多保留前 **60,000 字符**，超出或无可提取文字会提示。DOCX 只提取正文，不含嵌入图片、批注、页眉页脚；旧 `.doc` 请先另存为 `.docx`。
- 上传文件与关联 Zotero PDF 是两个入口。需要完整长文阅读时，请关联 Zotero PDF；上传附件仍受上述提取上限约束。

### 3. 关联长 PDF：分层阅读与页码来源

- 关联 Zotero PDF 后，在本机缓存可提取正文；短文直接准备上下文，长文按模型容量分块概括，并根据问题召回相关原文。
- 显示阅读进度、缺页提示与页码来源；追问可复用已保存的正文和概括，避免每次从头准备。
- 模型窗口、历史消息与图片共同影响本次可用上下文。分块概括和回答可能产生多次模型请求及费用，不等于一次请求读取全部原文。
- 扫描页无文字层时仍需 OCR；缺页、提取或缓存问题会提示。模型回答和页码引用仍应回到原文核对。

### 4. 全文任务默认文字层，OCR 按需开启

- 全文 Markdown、全文翻译和参考文献提取默认读取 PDF 文字层，不再要求先安装 Python、OCR 依赖和模型。
- 原文提取工具栏可为本次提取选择「不使用 OCR / 使用 OCR」；OCR 需先配置就绪。扫描文献可在「设置 → OCR配置」启用全文 OCR 增强。
- OCR 失败时尝试文字层，并保留不可读页提示；完善准备等待、取消与重试处理，避免准备状态妨碍普通阅读。
- 首次全文翻译增加积分消耗与稳定性提示，取消发生在提取和翻译请求之前；确认记录保存在当前 profile。建议先选中需要精读的段落翻译。

### 5. 参考文献更容易核对

- 修复独立年份行、跨行年份被误拆成新引用或序号的问题。
- 将「原文引用」和「检索结果」分开展示，选择框放在行首；缩短长作者列表的显示，导入使用的完整元数据仍保留。
- 优先采用精确匹配；无精确匹配时选用首条有效检索候选并显示「已选首条」。**这不是准确匹配的保证**，请核对题名、作者和年份后再导入。
- 编辑原始引用会清除旧候选，重新核验后再导入；导入仍需用户主动操作。

### 6. 阅读侧栏与本机诊断

- 改进侧栏首次加载、失效后的恢复、成果读取重试，以及阅读器重开时的初始化。
- 扩充本机生命周期与 OCR 诊断信息，便于区分界面挂载、资料读取和依赖准备问题；可从工具菜单或「帮助 → 错误诊断」查看、导出。
- 诊断保存在本机，导出后请检查内容再主动分享；没有自动上传诊断。

## 操作与配置

1. **分类**：在工作台「设置 → 功能配置」保存 TypeSafe API Key，再从 Zotero 文献右键菜单进入「文献分类…」，选择候选目录、生成预览、核对并应用。测试密钥会发送示例请求，可能消耗服务额度。
2. **文件问答**：在对话输入区添加文件；长论文优先使用「关联文件」选择 Zotero PDF。检查提取范围与缺页提示后提问。
3. **OCR**：普通文字层任务可直接开始。只有需要识别扫描页时才准备 OCR 依赖和模型，首次安装需要联网和数 GB 磁盘空间。
4. **AI 服务**：对话、解析和翻译继续使用各自配置的攻玉或 BYOK 服务；分类密钥独立配置。本地保存历史不代表离线 AI，准备好的上下文会发送到所选服务。

详细步骤见[使用指南](https://github.com/jadense-ai/jadense-in-zotero/blob/main/docs/usage-guide.md#unreleased-050)及[本机 OCR 指南](https://github.com/jadense-ai/jadense-in-zotero/blob/main/docs/local-ocr.md)。

## 升级与兼容

- 从 GitHub 0.4.0–0.4.10 使用相同 `.cn` 插件身份安装升级，保留现有设置与本地历史；建议安装后重启 Zotero。旧译文与已经拆分的参考文献不会自动重新生成，需要时主动重新提取或翻译。
- 旧 `.com` 身份安装应先禁用旧插件，再手动安装本包，不要同时启用两个身份。
- Manifest 声明支持 **Zotero 8.0–10.0.***；PDF 图片自动识别仍需 Zotero 10.0.1+ 的兼容阅读器。声明范围不等于各版本均已实测。
- 此次发布仅更新 GitHub Release，不推进官网更新清单；若 Zotero 自动更新没有出现本版，请手动安装 XPI。
- 继续遵守项目非商业使用许可证；模型、分类与翻译费用按所选服务规则计算。

## English

Compared with v0.4.10, v0.5.0 adds a standalone paper-classification window, document attachments in Chat, layered reading of linked long PDFs and optional OCR for full-document tasks.

- **Classify papers with a preview:** select Zotero items, open Paper classification from the context menu, choose candidate collections, review recommendations and apply. Undo is available. Configure a separate TypeSafe API key in Settings → Feature configuration. Classification uses Jev and sends titles, abstracts, tags and candidate collections, not PDFs. Key testing and recommendations may incur service charges.
- **Attach research files:** PDF, DOCX, HTML, Markdown and common text formats are supported. Uploaded files are limited to 20 MB and the first 60,000 extracted characters. DOCX extracts body text only; convert legacy DOC files first. Extracted text is stored locally with the conversation and used as model context.
- **Read linked long PDFs:** link a Zotero PDF to cache its extractable text, prepare chunked summaries within model limits and retrieve relevant source passages for questions. Progress, missing-page notices and page references help you check coverage. Follow-ups reuse saved text and summaries. This differs from uploaded files, whose extraction limits remain in place. Long-document preparation can require multiple billed requests; verify answers against the original.
- **Use OCR when needed:** full Markdown, translation and reference extraction default to the PDF text layer without Python. Choose configured OCR in the extraction toolbar or enable it in OCR settings for scanned pages. Failed OCR falls back to the text layer with unreadable-page warnings. The first full translation asks you to acknowledge cost and stability considerations; canceling starts no request.
- **Review reference candidates clearly:** standalone year lines remain with their citation. Original citations and search results are labeled separately. Exact matches take priority; otherwise “First result selected” identifies the fallback candidate and does not guarantee a correct match. Review before importing. Editing the citation clears its previous candidate.
- **Recover reading sessions:** improve sidebar initialization/recovery, saved-result retries, OCR cancellation/waiting and local diagnostics. Diagnostics are not automatically uploaded.

Upgrade over GitHub 0.4.0–0.4.10 using the same `.cn` plugin ID; existing settings and local history remain. Restart Zotero after installation. Existing translations and reference extractions are not regenerated automatically. Disable the legacy `.com` add-on before installing this identity. The manifest supports Zotero 8.0–10.0.*; automatic figure detection requires a compatible Zotero 10.0.1+ reader. GitHub publishing does not update the website's automatic-update channel. Local storage does not mean offline AI: selected context is sent to the configured service. The non-commercial license remains in effect.


## 验证与下载

- 发布 PR：[#21](https://github.com/jadense-ai/jadense-in-zotero/pull/21)。PR、main 与 [v0.5.0 标签 CI](https://github.com/jadense-ai/jadense-in-zotero/actions/runs/35561916138) 均通过：880 项单元测试、6 项发布边界测试、lint、类型检查、构建与制品验证。
- 从草稿下载的同一 XPI 在 **Windows 11 Pro x64 build 26200 / Zotero 10.0.3** 完成三次冷启动；分类、文件附件、81 页长 PDF 与冷重启缓存复用、v0.4.10 原位升级及后台解析、侧栏恢复、诊断、中英文外观共 **107 项专项检查**通过。
- 原生测试使用隔离 profile、合成文献与模拟服务。旧综合脚本仍等待已取消的“解析自动打开工作台”，在该步骤超时，**未全程通过**；后台解析的当前行为已由专项验证。首次完整 OCR 下载与识别、完整全文翻译链路、真实 TypeSafe/模型/翻译服务、macOS/Linux 和 Zotero 8/9 未在本次发布实测。
- 下载 **`jadense-in-zotero-v0.5.0.xpi`**，在 Zotero「工具 → 插件 → 齿轮 → 从文件安装插件」中安装，完成后重启。`Source code` 压缩包不是插件安装包。
- 附件包含 XPI、`release-metadata.json`、`SHA256SUMS`。XPI 大小 **3,219,781 bytes**，SHA-256：

```text
fd743ff4cab1ab30fe89a7268f5d367e11dc19e9d8a43527be24fdf831272705
```

Validation: PR/main/tag CI passed (880 unit tests, six release-boundary tests, lint, typecheck and build). The exact draft XPI passed three cold starts and 107 targeted checks on Windows 11 Pro x64 build 26200 / Zotero 10.0.3, including an in-process upgrade from v0.4.10. Tests use synthetic data and mocked services. The legacy combined smoke timed out waiting for the removed automatic Manager opening and did not complete; current background-analysis behavior passed its targeted test. First-time complete OCR setup/recognition, the complete full-translation flow, real providers, macOS/Linux and Zotero 8/9 were not validated for this release. Download the XPI asset, install it from Zotero's Plugins menu and restart.


## 0.4.10 — 2026-09-19

### 简体中文

- OCR 准备显示阶段、文件/批次、下载量、平均速度与等待时间；为环境检查、依赖安装和模型验证增加有界等待，复用已就绪缓存。
- 新增依赖删除与重新安装，默认保留模型，可选择同时删除模型；已保存文献成果、PDF、日志及用户自行安装的 Python/uv 保留。
- 扩展 [OCR 安装指南](docs/local-ocr.md)：设置操作、Windows/Linux/macOS 分环境手动安装、锁定依赖、模型验证与排障；中英文 README 增加独立入口。
- 验证：766 项单元测试及 CI 通过；Windows 11 / Zotero 10.0.3 的标签原包通过三次冷启动、后台解析专项及从 v0.4.9 原地升级。旧综合脚本期待已取消的自动打开工作台，完整翻译专项缺少 OCR 就绪环境，英文选文 12px 布局断言在本版与 v0.4.9 均未通过。首次完整 OCR、其他平台及真实服务未验收，详见 [Release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.10)。

### English

- Show OCR setup stages, files/batches, download size, average speed and elapsed time; bound environment checks, dependency installation and model verification, and reuse confirmed caches.
- Add dependency removal and reinstallation, retaining models by default with optional model removal; keep saved results, PDFs, logs and user-installed Python/uv.
- Expand the [OCR guide (Chinese)](docs/local-ocr.md) with settings, separate Windows/Linux/macOS manual steps, locked dependencies, model checks and troubleshooting; add dedicated sections to both READMEs.
- Validation: 766 unit tests and CI passed. The tag-built XPI passed three cold starts, background-analysis checks and in-process upgrade from v0.4.9 on Windows 11 / Zotero 10.0.3. Legacy combined checks expect the removed automatic Manager opening; full translation lacked a ready OCR environment; the English selection popup 12px layout assertion failed on both this version and v0.4.9. First-time full OCR setup, other platforms and real providers remain unverified. See the [Release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.10).

## 0.4.9 — 2026-09-18

### 简体中文

- 全文翻译正确处理流式结束，保留已完成进度；模型配置变化、积分不足和中断提供明确提示与手动继续入口。
- OCR 配置使用「启用本机 OCR / 继续准备」统一完成依赖、模型和离线验证，自动读取状态并复用已有缓存；支持魔搭 ModelScope 下载源。
- 新增本机错误诊断的筛选、复制、导出与清空；改进解析任务状态和文献成果提示。
- 验证：756 项单元测试、6 项发布边界测试、文档检查、lint、类型检查、XPI 构建与制品校验通过。当前发布环境未安装 Zotero，未重新执行原生冷启动/升级冒烟；真实服务商、macOS/Linux 与完整首次模型下载仍未实测。

### English

- Handle full-document stream completion, preserve completed progress, and show actionable notices for configuration changes, insufficient points and interruptions, with manual resume.
- Prepare OCR dependencies, models and offline verification through Enable local OCR / Continue setup; read readiness automatically, reuse existing caches and support ModelScope downloads.
- Add local diagnostic filtering, copy, export and clear actions; improve analysis task state and document-result notices.
- Validation: 756 unit tests, 6 release-boundary tests, documentation checks, lint, typecheck, XPI build and artifact verification passed. Zotero was not installed in the release environment, so native cold-start/upgrade smoke checks were not rerun; real providers, macOS/Linux and a complete first-time model download remain untested.

## 0.4.8 — 2026-09-14

### 简体中文

- 新增默认关闭的「OCR增强选中文本内容提取」。在「设置 → 功能配置 → 选中文本」开启后，引用或翻译前在本机识别选区文字和公式；失败时提示并沿用原选文。
- 默认文字层提取改善段落换行、跨行断词、连字和上下标；复杂公式仍需对照原 PDF。
- 选文浮窗记住位置与大小，可跟随选文；支持等待、自动翻译或引用到新侧栏对话，引用仅创建草稿。
- OCR 模型支持可选第三方 HF-Mirror 下载源；新增正式版更新提示。
- 安装后重启 Zotero，保留已有设置和历史。首次使用选文 OCR 需要准备本机依赖和模型。

### English

- Add opt-in local OCR before quoting or translating selected text, including formulas. Enable it under Settings → Feature configuration → Selected text. Failed recognition falls back to the original selection with a notice.
- Improve text-layer extraction of paragraphs, line-end hyphenation, ligatures and superscripts/subscripts. Check complex formulas against the PDF.
- Remember selection window geometry, optionally follow selections, translate automatically or quote into a new sidebar draft without sending.
- Add an optional third-party HF-Mirror model download source and stable-release update notices.
- Restart Zotero after installation. Existing settings and history are retained; first-time selection OCR requires local dependencies and models.

## 0.4.7 — 2026-09-13

### 简体中文

- 修复解析历史详情与设置页面混杂的问题；切换到对话、攻玉学术和指南时也会正确隐藏旧页面。
- 返回解析历史时保留原有详情，已有设置和历史无需迁移。安装 0.4.7 后重启 Zotero。

### English

- Fix analysis details remaining visible behind Settings, Chat, Jadense academic, or the guide.
- Preserve the selected details when returning to analysis history. Existing settings and history require no migration. Install 0.4.7 and restart Zotero.

## 0.4.6 — 2026-09-13

### 简体中文

- 新增逐条编辑和删除参考文献。编辑后可重新核验；删除仅移除解析结果中的引用记录。
- 去掉引用正文开头的文献序号，序号仍在列表侧边显示；原 PDF 定位保持可用。
- 已有参考文献记录在打开时清理版式换行和开头序号，改善显示与检索。

安装 0.4.6 后重启 Zotero，可保留已有设置与历史。参考文献匹配结果仍需结合原文核对。

### English

- Edit or delete individual references, then verify edited citations again. Deleting a reference removes only its analysis record.
- Remove leading citation numbers from reference text while retaining the list numbering and PDF source navigation.
- Normalize layout line breaks and leading numbers when opening saved reference records.

Install 0.4.6 and restart Zotero. Existing settings and history are retained.

## 0.4.5 — 2026-09-13

### 简体中文

- 新增独立 OCR 配置入口，改善首次安装、模型准备及启动提示。
- 清理新提取参考文献的版式换行，恢复底部全选框，并优化工作台与阅读布局。

### English

- Add dedicated OCR settings and improve first-time installation and startup feedback.
- Normalize layout line breaks in newly extracted references, restore the bottom select-all checkbox, and refine reading layouts.


## 0.4.4 — 2026-09-13

### 简体中文

- 新增按文献与附件组织的成果工作区，统一浏览原文、译文、选中翻译和解析历史。
- 新增 Bing/Google 传统翻译和本机 OCR；全文翻译先识别完整 PDF，公式保留本机原图。首次安装需下载环境与模型。
- 新增快速开始、图文指南与 FAQ。0.4.4 起采用非商业许可，历史 MIT 授权和第三方许可继续保留。

- 优化工作台顶部导航与聊天模型选择，让对话、翻译历史、文献解析和连接设置之间的切换更清晰；可继续跟随攻玉账号默认模型，也可为当前对话明确选择模型。
- 提升全文翻译在跨章节、长段落和不同上下文容量下的稳定性：只在请求内部拆分超长内容，阅读与定位仍对应完整原文段落，已有译文可继续恢复。
- 优化阅读工作区与管理界面的响应式布局、提示和上手引导，保留选文工具条的完整文字与宿主内容宽度适配。

从 GitHub 0.4.3 可直接安装更新，保留设置和历史；旧 .com 身份需先禁用再安装。攻玉 AI 需要服务端临时执行 V1 协议，旧服务端会提示升级；本客户端发布不代表生产服务已部署。BYOK 独立可用。GitHub 发布不推进官网自动更新。

### English

- Group original text, translations and analysis history by paper and attachment.
- Add Bing/Google translation and local OCR before full translation; formulas remain local images. First setup downloads the runtime and models.
- Add onboarding, illustrated guides and FAQ. Version 0.4.4 adopts the non-commercial license; prior MIT grants and third-party licenses remain intact.

- Clarify the workbench navigation and chat model selection, making it easier to move between Chat, translation history, literature analysis, and connection settings. Chat can still follow the Jadense account default or use an explicit model for the current conversation.
- Improve full-translation stability across sections, long paragraphs, and different context capacities: oversized content is split only inside requests, while reading and source navigation continue to correspond to complete original paragraphs and completed translations remain recoverable.
- Refine responsive layouts, notices, and the getting-started guide across the reader workspace and Manager while preserving full selection-toolbar labels and host-width containment.

Install over GitHub 0.4.3 to retain settings and history. Disable legacy .com builds first. Jadense AI requires the temporary-execution V1 server protocol; older servers show an upgrade message. This client release does not establish production server readiness. BYOK remains independent. Website automatic updates are unchanged.

最终验收与制品校验 / Validation and checksums: [v0.4.4 Release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.4).


## 0.4.3 — 2026-09-11

### 简体中文

- 全文译文以连续文档呈现在阅读器侧栏，提供目录、阅读/定位模式、独立字号与行距、阅读位置恢复，并支持独立 PDF 窗口。
- 优化跨页完整段落提取与翻译批次，改善换行和页边编号干扰；旧译文保留，回看不会自动重新翻译。
- 文献解析新增论文详情，将总结、笔记与参考文献放在同一处，保留搜索、筛选和导入选择。
- 参考文献批量 AI 默认关闭，支持明确开启、暂停和继续；业务拒绝后停止后续批次。
- 攻玉请求支持持久请求身份与结果恢复；BYOK 保留本地完成结果，不自动重发未确认请求。修复大字号选文工具栏溢出。

从 GitHub 0.4.2 可直接安装更新，保留设置和历史；旧 .com 身份需先禁用再安装。攻玉 AI 需要服务端临时执行 V1 协议，旧服务端会提示升级；本客户端发布不代表生产服务已部署。BYOK 独立可用。GitHub 发布不推进官网自动更新。

### English

- Read full translations as a continuous document in the reader sidebar, with a table of contents, Reading/Locate modes, independent typography, restored position, and detached PDF-window support.
- Improve complete-paragraph extraction and batching across pages, including line breaks and margin-number handling. Existing translations remain readable without automatic regeneration.
- Open paper details with summaries, notes, and references together, retaining search, filters, and import selections.
- Batched reference AI is off by default, with explicit opt-in, pause/resume, and stopping after a business rejection.
- Recover Jadense results using persistent request identities. BYOK keeps completed local results and never automatically resends uncertain requests. Fix selection-toolbar overflow at larger font sizes.

Install over GitHub 0.4.2 to retain settings and history. Disable legacy .com builds first. Jadense AI requires the temporary-execution V1 server protocol; older servers show an upgrade message. This client release does not establish production server readiness. BYOK remains independent. Website automatic updates are unchanged.

Validation and final package checksum: [v0.4.3 Release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.3).

## 0.4.2 — 2026-09-10

[简体中文](#release-042-zh) · [English](#release-042-en)

<a id="release-042-zh"></a>

本次更新将翻译从选文扩展到整篇 PDF，并把参考文献核验、导入与文献解析放在一起。阅读浮窗和字号也可以按习惯调整。

**[下载 0.4.2 插件](https://github.com/jadense-ai/jadense-in-zotero/releases/download/v0.4.2/jadense-in-zotero-v0.4.2.xpi)** · [安装与快速开始](README.md#quick-start)

### 功能与体验

- **可恢复的全文翻译**：从阅读操作选择「全文翻译」，按段阅读、复制译文并跳回原文核对。隐藏浮窗后继续处理；中断或重启后可手动继续，已完成内容保留。全文翻译与实时翻译共用模型配置。
- **参考文献核验与导入**：「解析」同时提取同一 PDF 的参考文献，在「文献解析 → 参考文献」查看原文、核验 DOI 并导入已确认条目。保留引用顺序、编号、重复项及未确认内容；同库 DOI 去重，不覆盖已有文献，不自动下载 PDF。
- **更合适的阅读外观**：「设置 → 常规」新增 12–24px 字号、普通/毛玻璃浮窗及背景透明度。选文与全文浮窗均支持标题拖动和边角缩放，也可从左下角「外观」直接调整。
- **阅读器入口更清楚**：空间不足时，提问、解析、引用与全文翻译收在「•••」菜单内，为 Zotero 页码和批注工具留出空间；点击 Jadense 图标打开工作台。选文翻译使用选区弹出栏的「智能翻译」或 `Ctrl+Alt+T`（macOS：`⌘+Alt+T`），顶部不再放置选文翻译按钮。

### 升级与兼容

从 GitHub 0.4.0 / 0.4.1 可直接从文件安装更新，插件 ID 保持 `jadense-in-zotero@jadense.cn`，保留设置和本地历史。使用旧 `.com` 身份的版本（包括官网 0.3.2）需先禁用旧插件，再安装新版；不要删除 profile 或同时启用两个身份。GitHub 发布不推进官网自动更新清单。

全文翻译需要可提取文字的 PDF，不提供 OCR 或覆盖原版式；重启后不会自动恢复模型请求，需要手动继续。参考文献核验可能因来源信息不足或服务不可用而保留为未确认；只有已验证条目可导入。毛玻璃效果依赖宿主图形能力，不可用时保留普通背景。

已知界面现象：原生截图验收中曾出现窄窗口导航未自动收起，同包复跑恢复正常，根因尚未确认；遇到时可使用侧栏收起按钮。

Manifest 声明 Zotero **8.0–10.0.***；本版原生验收使用 **Windows 11 / Zotero 10.0.2**、隔离 profile、合成资料与模拟服务。其他系统、Zotero 8/9、真实 Provider 翻译品质及实际 Crossref 命中率未实测。最终安装包校验和原生验收结果见 [v0.4.2 Release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.2)。

<a id="release-042-en"></a>

### English

Translate a whole PDF, verify and import its references alongside literature analysis, and adjust the reading panels to your preferences.

**[Download version 0.4.2](https://github.com/jadense-ai/jadense-in-zotero/releases/download/v0.4.2/jadense-in-zotero-v0.4.2.xpi)** · [Installation and quick start](README.en.md#quick-start)

- **Resumable full-document translation**: choose Full translation in the reading actions, read or copy paragraph translations, and navigate to their source. Processing continues while the panel is hidden. After interruption or restart, resume manually while keeping completed parts. It uses the real-time translation model setting.
- **Reference verification and import**: Analyze also extracts references from the same PDF. Inspect sources, verify DOIs, and import confirmed entries under Literature analysis → References. Original order, numbering, duplicates, and unconfirmed text are retained. Import deduplicates by DOI within the same library without overwriting existing items or downloading PDFs.
- **Adjustable reading appearance**: General settings now offer a 12–24px font, standard or frosted-glass panels, and background transparency. Drag either translation panel by its title and resize its edges or corners; the bottom-left Appearance menu offers the same style controls.
- **Clearer reader actions**: when space is limited, Ask, Analyze, Quote, and Full translation appear under the ••• menu. The Jadense icon opens the workbench. Translate selected text from the selection popup's AI translation action or `Ctrl+Alt+T` (`⌘+Alt+T` on macOS); the top toolbar no longer has a selection-translation button.

Install the XPI over GitHub 0.4.0 or 0.4.1 to keep settings and local history under the same `.cn` plugin ID. Disable older `.com` ID builds, including website 0.3.2, before installing; do not delete your profile or enable both identities. GitHub releases do not update the website's automatic update manifest.

Full translation requires extractable PDF text, provides no OCR or original-layout overlay, and resumes only on request after restart. Incomplete source information or unavailable services can leave references unverified; only verified entries can be imported. Frosted glass depends on host graphics support and falls back to a standard background.

Known UI behavior: a native screenshot run intermittently failed to collapse navigation in a narrow window; the same package passed on rerun, and the cause remains unconfirmed. Use the sidebar collapse button if needed.

The manifest declares Zotero **8.0–10.0.***. Native validation uses **Windows 11 / Zotero 10.0.2**, isolated profiles, synthetic documents, and mocked services. Other platforms, Zotero 8/9, real-provider translation quality, and real Crossref matching accuracy were not tested. See the [v0.4.2 release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.2) for final artifact checksums and validation results.

## 0.4.1 — 2026-09-09

[简体中文](#release-041-zh) · [English](#release-041-en)

<a id="release-041-zh"></a>

本次更新让插件更贴合你的阅读习惯：选择熟悉的界面语言，在深浅主题间切换，并集中查看攻玉账号与积分信息。

**[下载 0.4.1 插件](https://github.com/jadense-ai/jadense-in-zotero/releases/download/v0.4.1/jadense-in-zotero-v0.4.1.xpi)** · [安装与快速开始](README.md#quick-start)

### 功能与体验

- **中英文界面更完整**：工作台、阅读器工具、上手指南、设置、菜单和动态提示支持简体中文与 English，让日常阅读与配置更顺手。
- **新增「常规」设置**：在「设置 → 常规」选择跟随 Zotero、简体中文或 English；Zotero 原生插件设置提供相同配置。保存后重启 Zotero 生效，重开工作台不会提前切换。界面语言不会改变翻译方向、AI 输出要求或已有内容。
- **主题随你选择**：跟随 Zotero、浅色、深色三种模式，立即同步已打开的插件界面，保留草稿和进行中的生成。原有主题选择继续生效，侧栏主题按钮也会同步保存当前选择。
- **账号信息更集中**：「你的攻玉」汇总账号、订阅、可用积分与来源，以及签到奖励和连续天数。账号与积分分别加载，单项刷新失败不影响另一项显示。顶部提供攻玉首页、签到页、订阅与用量的网页入口；签到在网页完成后，可刷新查看状态。

### 升级与兼容

从 GitHub v0.4.0 可直接从文件安装更新，保留设置与本地历史，插件 ID 仍为 `jadense-in-zotero@jadense.cn`。官网 0.3.2 及更早旧 `.com` ID 版本需先禁用旧插件再安装，请勿删除 Zotero profile 或同时启用两个身份。GitHub 发布不修改官网自动更新清单。

Manifest 声明兼容 Zotero **8.0 至 10.0.***；自动识图需要 Zotero 10.0.1+ 的兼容 PDF 阅读器。实际验收环境为 **Zotero 10.0.1 / Windows 11 Pro x64（build 26200）**，使用隔离 profile、合成资料和模拟接口。其他系统、Zotero 8/9 及真实付费 Provider 未实测。

<details>
<summary>查看本版验收记录与安装包校验信息</summary>

- 完整 488 项测试、发布边界测试、lint、类型检查及打包校验通过；PR、主分支与标签 CI 均通过。
- 对标签 CI 的同一 XPI 完成三次冷启动、从同 ID 正式版 0.4.0 原位升级及 134 项研究检查，中英文分别通过 12 项外观检查。
- 草稿下载与公开下载的 XPI 哈希一致，三份附件的发布证明及摘要已核验；未重新构建或替换 CI 附件。

XPI：`jadense-in-zotero-v0.4.1.xpi`，**603122 bytes**。Release 同时提供 `release-metadata.json` 和 `SHA256SUMS` 用于核验。

SHA-256：

```text
5f5f9cbc20ef13b6c23c45d11f58e70d0fe48b8a2d93395ecb4a4f6d8b69649d
```

详见 [PR #3](https://github.com/jadense-ai/jadense-in-zotero/pull/3)、[标签 CI](https://github.com/jadense-ai/jadense-in-zotero/actions/runs/34320869610) 和 [v0.4.1 Release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.1)。本记录描述 0.4.1 发布验收；后续文案调整不代表重新执行验收，标签和附件保持不变。

</details>

---

<a id="release-041-en"></a>

### English

Choose the interface language and appearance that suit your reading workflow, with a clearer overview of your Jadense account.

**[Download version 0.4.1](https://github.com/jadense-ai/jadense-in-zotero/releases/download/v0.4.1/jadense-in-zotero-v0.4.1.xpi)** · [Installation and quick start](README.en.md#quick-start)

#### Features and experience

- **More complete Chinese and English support** throughout the workbench, reader tools, guide, settings, menus, and notices makes reading and configuration easier in your preferred language.
- **New General settings** let you follow Zotero’s language or choose Simplified Chinese or English under Settings → General. The native plugin preferences offer the same controls. Restart Zotero to apply language changes; reopening the workbench keeps the current language until then. Translation direction, AI output requirements, and existing content stay intact.
- **Light, dark, or follow Zotero** themes update open plugin interfaces immediately, preserving drafts and active generation. Existing theme choices remain effective, and the sidebar theme button saves its selection to the same setting.
- **Your Jadense brings account information together**: view your account, subscription, available points and their source, check-in rewards, and consecutive days in one place. Account and points information load independently, so a failed refresh of one does not hide the other. Website, check-in, and subscription-and-usage shortcuts appear at the top. Complete check-in on the website and refresh to see the updated status.

#### Upgrade and compatibility

Install over GitHub v0.4.0 from a file to update while keeping settings and local history; the plugin ID remains `jadense-in-zotero@jadense.cn`. For website version 0.3.2 or earlier releases using the old `.com` ID, disable the old plugin before installing. Do not delete your Zotero profile or enable both identities at once. This GitHub release does not change the website’s automatic-update manifest.

The manifest declares compatibility with Zotero **8.0 through 10.0.***. Automatic figure detection requires a compatible PDF reader in Zotero 10.0.1 or later. Release acceptance checks ran on **Zotero 10.0.1 / Windows 11 Pro x64 (build 26200)** using isolated profiles, synthetic materials, and simulated services. Other platforms, Zotero 8/9, and live paid providers were not tested.

<details>
<summary>Release acceptance record and package verification</summary>

- All 488 tests, release-boundary tests, lint, type checking, and package verification passed. PR, main-branch, and tag CI passed.
- The same XPI produced by tag CI passed three cold starts, an in-place upgrade from version 0.4.0 with the same plugin ID, and 134 research checks. Chinese and English each passed 12 appearance checks.
- Draft and public downloads had matching XPI hashes. Release attestations and digests for all three attachments were verified; the CI attachments were not rebuilt or replaced.

XPI: `jadense-in-zotero-v0.4.1.xpi`, **603122 bytes**. The release also provides `release-metadata.json` and `SHA256SUMS` for verification.

SHA-256:

```text
5f5f9cbc20ef13b6c23c45d11f58e70d0fe48b8a2d93395ecb4a4f6d8b69649d
```

See [PR #3](https://github.com/jadense-ai/jadense-in-zotero/pull/3), [tag CI](https://github.com/jadense-ai/jadense-in-zotero/actions/runs/34320869610), and the [v0.4.1 release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.4.1). This record describes the 0.4.1 acceptance checks. Later text edits do not imply those checks were rerun; the tag and attachments remain unchanged.

</details>

## 0.4.0 — 2026-09-09

[简体中文](#release-040-zh) · [English](#release-040-en)

<a id="release-040-zh"></a>
<a id="release-zh"></a>

**在 Zotero 中读懂论文，把阅读所得变成下一步研究的起点。**

Jadense in Zotero 迎来首个 GitHub 正式发布版本。这个由[攻玉学术（Jadense）](https://jadense.cn/)推出的开源阅读助手，把文献问答、原文批注、选文翻译和图表解读带进 Zotero。你可以自带 API Key 独立使用，也可以连接攻玉账号，两种方式使用同一安装包。

**[下载 0.4.0 插件](https://github.com/jadense-ai/jadense-in-zotero/releases/download/v0.4.0/jadense-in-zotero-v0.4.0.xpi)** · [安装与快速开始](https://github.com/jadense-ai/jadense-in-zotero#quick-start)

客户端以 MIT 开源；模型调用费用由所选服务商或攻玉账号的订阅、积分规则决定。

### 用它开始一次论文阅读

- **把重点留在原文旁**：点击「解析」生成总结、详细笔记和 Zotero 原生批注，便于回到对应段落核对，不覆盖人工批注。
- **带着问题继续读**：关联文献、PDF 或选文，围绕方法、证据和结论继续对话。
- **就地理解难读的段落**：选文翻译支持 32 种语言选项，可调整文章或当前选文的翻译方向，并从历史回到原文页。
- **结合论文背景解读图表**：自动识图或手动截图后，开启新对话或追加追问；也可上传、粘贴或拖入图片。图片随本地对话保存，重开后仍可查看。

这些阅读能力延续自官网 0.3.2。图片解读需要支持图片输入的模型，自动识图需要 Zotero 10.0.1+ 的兼容 PDF 阅读器。

### 相比官网 0.3.2，这次改进了什么？

- **攻玉模型选择更清楚**：受限模型标注「需升级」及所需订阅档位；遇到限制时，提示更换可用模型或升级订阅，减少将模型权限问题误当成积分不足的困惑。充值积分不会解锁受限模型。
- **更新新配置的默认模型**：连接攻玉后，新配置默认使用 DeepSeek V4 Flash Vision（`deepseek-v4-flash-vision-exp`）。已有具体模型、路由和 BYOK 选择会保留；旧版已保存 GLM 的用户可在「设置 → 功能配置」主动更换。
- **统一攻玉连接与插件身份**：正式连接使用 `jadense.cn`，插件身份更新为 `.cn`；BYOK 自定义服务配置保持独立。旧版安装需要按下方步骤手动迁移。
- **便于定位使用问题**：攻玉 AI 请求附带插件版本与功能标识，用于区分对话、图片解读、翻译和解析请求，原有内容处理路径保持不变。
- **提供可核验的开源安装包**：本次 GitHub Release 附 XPI、构建元数据与 SHA-256，既可直接安装，也可检查对应源码。

### 从几篇论文，走向一个研究问题

当你准备比较几篇论文的方法与证据，可以在插件「连接攻玉 → 文献同步」中，将选中文献上传到攻玉收藏夹，再到攻玉网页端的项目中「添加上下文」，选择这些资料继续讨论。

例如：「比较这些论文的研究对象、方法和证据边界，列出还需补充检索的问题，并拟一份综述提纲。」让已经读过的材料，成为下一步研究的起点。

上传为 **Zotero → 攻玉单向操作**，可自行选择是否包含 PDF；插件对话、笔记和批注不会自动同步到网页端。BYOK 阅读功能可继续独立使用。

[在攻玉学术继续研究](https://jadense.cn/) · [项目与资料使用说明](https://jadense.cn/docs/research-resources)

### 安装与旧版迁移

新用户下载上方 `.xpi` 文件，在 Zotero 插件管理器中选择「从文件安装插件」，再打开工作台配置 BYOK 或连接攻玉。详细步骤见 [README](https://github.com/jadense-ai/jadense-in-zotero#quick-start)。

**安装过官网 0.3.2 或更早旧 ID 版本时，先禁用旧 Jadense 插件，再手动安装新版。** 插件 ID 从 `jadense-in-zotero@jadense.com` 改为 `jadense-in-zotero@jadense.cn`，不同身份不会自动覆盖升级，请勿同时启用。

新版沿用原有本地偏好命名空间与历史保存位置，请勿删除 Zotero profile。GitHub 发布不修改官网自动更新清单。

### 兼容性与已知限制

Manifest 声明兼容 Zotero **8.0 至 10.0.***。本次实际验收环境为 **Windows 11 Pro x64（10.0.26200）/ Zotero 10.0.1**，使用临时 profile、合成资料与本机模拟接口；未实测 macOS、Linux、Zotero 8/9 或真实付费 Provider。

连续窗口缩放验收中，出现过一次窄窗口导航未自动收起的超时；同一 XPI、相同测试在新临时 profile 完整复跑通过，根因尚未确认。遇到时可用左上角导航收起按钮。

解析依赖 PDF 可提取正文，扫描件需先 OCR；模型生成的解释与批注请结合原文核对。本地历史不代表离线 AI，模型请求会携带所需上下文，数据路径见 [README](https://github.com/jadense-ai/jadense-in-zotero#数据与凭据)。每条消息可新附一张图片，旧版本未保存的图片无法自动恢复。

<details>
<summary>查看本版验收记录与安装包校验信息</summary>

- 已下载原草稿附件，核对 XPI、元数据、SHA256SUMS 及 GitHub asset digest。
- `smoke:installed --xpi` 三次冷启动通过。
- `smoke:research --xpi --screenshots` 完整 **131 项检查**通过，包含阅读器、图片历史恢复、翻译、解析、BYOK、功能模型及订阅提示；未通过修改测试或重建附件消除上述窗口缩放记录。
- 同 ID 上一正式版升级检查不适用：官网 0.3.2 使用旧 `.com` ID，本版为 `.cn`，需手动迁移。
- 已核对更新说明、安装迁移和三个附件，并由维护者公开。本记录来自 0.4.0 发布验收，文案调整不代表重新执行验收。

XPI：`jadense-in-zotero-v0.4.0.xpi`，**577815 bytes**。

SHA-256：

```text
ba6acbc2f6ee9d73f80462fe50091fb97abd3aa131b72222d01b28efddc17057
```

附件全部来自[同一次标签 CI](https://github.com/jadense-ai/jadense-in-zotero/actions/runs/34272736935)，源码提交为 `49cc4c6951eb38244aa0931116ad657cf3cf8495`。正式版本的标签和附件保持不变，更换制品字节必须升版。

本版包含由 [@jadense-ai](https://github.com/jadense-ai) 贡献的 [PR #1：PR 检查与不可变草稿发布](https://github.com/jadense-ai/jadense-in-zotero/pull/1)和 [PR #2：0.4.0 发布准备](https://github.com/jadense-ai/jadense-in-zotero/pull/2)。这是该账号在本仓库的首次贡献；[完整提交记录](https://github.com/jadense-ai/jadense-in-zotero/commits/v0.4.0)。

</details>

---

<a id="release-040-en"></a>
<a id="release-en"></a>

### English

**Understand papers in Zotero, and turn what you read into the next step of your research.**

This is the first official GitHub release of Jadense in Zotero. This open-source reading assistant from [Jadense (攻玉学术)](https://jadense.cn/) brings paper Q&A, annotations alongside the source text, selected-text translation, and figure interpretation into Zotero. Use your own API key independently, or connect a Jadense account. Both options use the same installation package.

**[Download version 0.4.0](https://github.com/jadense-ai/jadense-in-zotero/releases/download/v0.4.0/jadense-in-zotero-v0.4.0.xpi)** · [Installation and quick start](https://github.com/jadense-ai/jadense-in-zotero/blob/main/README.en.md#quick-start)

The client is open source under the MIT License. Model usage is subject to your chosen provider's fees or your Jadense account's subscription and points rules. In version 0.4.0, the workbench uses mainly Chinese labels; the historical instructions below retain those labels so you can find the controls in that version.

#### Start with a paper

- **Keep the key points beside the source text:** choose 「解析」 (Analyze) to generate a summary, detailed notes, and native Zotero annotations that help you return to the relevant passages. Your manual annotations are preserved.
- **Read with a question in mind:** associate papers, PDFs, or selected passages with a conversation, then ask follow-up questions about methods, evidence, and conclusions.
- **Translate difficult passages where you read them:** choose from 32 language options, set the translation direction for a paper or the current selection, and return to the original page from translation history.
- **Interpret figures with the paper as context:** use automatic figure detection or a manual screenshot, then start a new conversation or continue an existing one. You can also upload, paste, or drop images. Images are saved with the local conversation and remain available when you reopen it.

These reading features carry forward from website version 0.3.2. Figure interpretation requires a model that accepts image input. Automatic figure detection requires a compatible PDF reader in Zotero 10.0.1 or later.

#### What changed since website version 0.3.2?

- **Clearer Jadense model access:** restricted models show 「需升级」 (Upgrade required) and the required subscription tier. If a request is restricted, the message explains how to choose an available model or upgrade, helping distinguish model access from a low points balance. Buying more points does not unlock a restricted model.
- **An updated default for new configurations:** after connecting Jadense, new configurations default to DeepSeek V4 Flash Vision (`deepseek-v4-flash-vision-exp`). Existing explicit model, route, and BYOK selections are preserved. If an older installation has a GLM model saved, you can change it under 「设置 → 功能配置」 (Settings → Feature configuration).
- **Consistent Jadense connection and plugin identity:** the official connection uses `jadense.cn`, and the plugin ID now uses `.cn`. Custom BYOK provider settings remain independent. Existing installations using the old ID require the manual migration below.
- **Easier troubleshooting:** Jadense AI requests include the plugin version and feature identifier to distinguish chat, figure interpretation, translation, and paper analysis. Existing content-processing paths are unchanged.
- **A verifiable open-source package:** this GitHub release includes the XPI, build metadata, and SHA-256 checksums. Install the package directly or inspect the corresponding source code.

#### From a few papers to a research question

When you are ready to compare methods and evidence across papers, open 「连接攻玉 → 文献同步」 (Connect Jadense → Literature sync) in the plugin and upload the selected papers to a Jadense favorites folder. Then open a project in the Jadense web app, choose 「添加上下文」 (Add context), and select those materials to continue the discussion.

For example: “Compare the research subjects, methods, and limits of the evidence in these papers. List questions that need further literature searches, and draft a literature-review outline.” The papers you have read become the starting point for your next step.

Uploads are **one-way, from Zotero to Jadense**, and you choose whether to include PDFs. Plugin conversations, notes, and annotations do not automatically sync to the web app. BYOK reading features remain available independently.

[Continue your research in Jadense](https://jadense.cn/) · [Projects and research materials guide](https://jadense.cn/docs/research-resources)

#### Installation and migration from an older version

New users can download the `.xpi` file above, choose the install-from-file option (「从文件安装插件」) in Zotero's plugin manager, and then open the workbench to configure BYOK or connect Jadense. See the [English quick start](https://github.com/jadense-ai/jadense-in-zotero/blob/main/README.en.md#quick-start) for the full steps.

**If you installed website version 0.3.2 or an earlier release with the old ID, disable the old Jadense plugin before manually installing this version.** The plugin ID changes from `jadense-in-zotero@jadense.com` to `jadense-in-zotero@jadense.cn`. Different IDs do not replace each other during installation; do not enable both at once.

This version retains the existing local preference namespace and history locations. Do not delete your Zotero profile. Publishing on GitHub does not change the website's automatic-update manifest.

#### Compatibility and known limitations

The manifest declares compatibility with Zotero **8.0 through 10.0.***. Release acceptance checks ran on **Windows 11 Pro x64 (10.0.26200) / Zotero 10.0.1**, using temporary profiles, synthetic materials, and local mock endpoints. macOS, Linux, Zotero 8/9, and live paid providers were not tested in this release's acceptance run.

During repeated window-resizing checks, one run timed out because navigation did not automatically collapse in a narrow window. A complete rerun with the same XPI and tests passed in a fresh temporary profile; the cause remains unconfirmed. If this occurs, use the navigation-collapse button at the top left.

Paper analysis requires extractable PDF text; scanned documents need OCR first. Check model-generated explanations and annotations against the original paper. Local history does not mean offline AI: model requests include the context needed for the request. See [Data and credentials](https://github.com/jadense-ai/jadense-in-zotero/blob/main/README.en.md#data-and-credentials) for the data paths. Each message can include one new image; images not saved by older versions cannot be recovered automatically.

<details>
<summary>Release acceptance record and package verification</summary>

- The original draft attachments were downloaded, and the XPI, metadata, `SHA256SUMS`, and GitHub asset digest were verified.
- `smoke:installed --xpi` passed three cold starts.
- `smoke:research --xpi --screenshots` passed the full **131 checks**, covering the reader, restored image history, translation, analysis, BYOK, feature models, and subscription messages. Tests were not modified and attachments were not rebuilt to remove the window-resizing issue recorded above.
- An upgrade check from an earlier official release with the same ID does not apply: website version 0.3.2 uses the old `.com` ID, while this version uses `.cn` and requires manual migration.
- The release notes, migration instructions, and three attachments were checked before the maintainer published the release. This record describes the 0.4.0 acceptance checks; editing the release text does not imply those checks were rerun.

XPI: `jadense-in-zotero-v0.4.0.xpi`, **577815 bytes**.

SHA-256:

```text
ba6acbc2f6ee9d73f80462fe50091fb97abd3aa131b72222d01b28efddc17057
```

All attachments come from [the same tag CI run](https://github.com/jadense-ai/jadense-in-zotero/actions/runs/34272736935), built from source commit `49cc4c6951eb38244aa0931116ad657cf3cf8495`. The published tag and attachments remain unchanged. Changing artifact bytes requires a new version.

This release includes [PR #1: PR checks and immutable draft releases](https://github.com/jadense-ai/jadense-in-zotero/pull/1) and [PR #2: Preparing the 0.4.0 release](https://github.com/jadense-ai/jadense-in-zotero/pull/2), contributed by [@jadense-ai](https://github.com/jadense-ai). These are the account's first contributions to this repository. See the [full commit history](https://github.com/jadense-ai/jadense-in-zotero/commits/v0.4.0).

</details>
