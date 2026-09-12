# 更新说明 / Changelog

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
