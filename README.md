<p align="center">
  <a href="https://jadense.cn/"><img src="content/icons/logo-padded.png" width="128" height="128" alt="Jadense Logo"></a>
</p>
<h1 align="center">Jadense in Zotero</h1>
<p align="center">攻玉学术 · Zotero AI 阅读助手</p>
<p align="center">
  <a href="https://www.zotero.org/download/"><img src="https://img.shields.io/badge/Zotero-8%20%7C%209%20%7C%2010-bb2222" alt="Zotero 8 / 9 / 10"></a>
  <a href="https://github.com/jadense-ai/jadense-in-zotero/releases/latest"><img src="https://img.shields.io/github/v/release/jadense-ai/jadense-in-zotero" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Non--Commercial-16a36a" alt="Non-commercial license"></a>
  <a href="docs/usage-guide.md"><img src="https://img.shields.io/badge/BYOK-supported-16a36a" alt="BYOK supported"></a>
</p>

**简体中文** · [English](README.en.md)

**在 Zotero 中读懂论文，把阅读所得变成下一步研究的起点。**

[论文问答](docs/usage-guide.md#paper-chat) · [原文批注](docs/usage-guide.md#paper-analysis) · [选文翻译](docs/usage-guide.md#selection-translation) · [全文翻译与本机 OCR](docs/usage-guide.md#full-translation) · [图表解读](docs/usage-guide.md#figures) · [参考文献核验与导入](docs/usage-guide.md#references)

Jadense in Zotero 是[攻玉学术（Jadense）](https://jadense.cn/)推出的源码公开 AI 阅读助手。围绕正在读的论文提问，把解析重点留在原文旁，遇到难懂的段落或图表时继续追问，让阅读、理解与核对在 Zotero 中连起来。

**非商业自用免费 · 禁止商用 · 支持自带 API Key（BYOK）· 攻玉账号可选**

**[下载插件](https://github.com/jadense-ai/jadense-in-zotero/releases/latest)** · [先看依赖与安装方式](#requirements) · [快速开始](#quick-start) · [了解攻玉学术](#continue-research)

插件源码公开，使用须遵守[非商业许可证](LICENSE)；模型调用费用由所选服务商或攻玉账号的订阅、积分规则决定。


**v0.6.2 已发布：**更新弹窗可直接查看最新版更新要点；对照翻译入口归入阅读操作，插件侧栏遵循 Zotero 原生收起状态。[更新与升级指引](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.2)

**v0.6.3 待发布：**关联长 PDF 默认截取与问题相关的原文，不再自动分批概括；需要全文概括时，可在「设置 → 功能配置 → AI 对话」明确开启。图片解读沿用此设置。

<!-- release-summary:start -->
## 最近版本

- [v0.6.2](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.2) — 更新弹窗显示版本要点，统一对照翻译入口并改进侧栏收起行为。
- [v0.6.1](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.1) — 移除待恢复 AI 请求按钮，精简功能配置页。
- [v0.6.0](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.0) — PDF 对照翻译、部分成果与补译、多屏阅读、引擎离线包及字号滑块。

- [v0.5.1](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.5.1) — 云 OCR 可选引擎、独立翻译配置及设置界面优化。
- [v0.5.0](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.5.0) — 新增文献分类、文件问答与长 PDF 阅读；全文任务默认文字层，OCR 按需启用，参考文献候选更清楚。

[完整版本历史](CHANGELOG.md)
<!-- release-summary:end -->

<a id="api-recommendation"></a>

## API推荐：Toodoo AI，让好模型用得起、用得顺

**读论文、做翻译、理思路，想用好 AI，又想把钱花在刀刃上？来看看 [Toodoo AI（toodooai.com）](https://toodooai.com/)。** 从 GPT 到智谱 GLM、小米 MiMo 等先进国产模型，一个平台按需选择，为你的 Zotero 接上得力的 AI 助手。

Toodoo AI 主打**低价、正品模型、稳定接入**：这是平台的服务定位；具体模型与渠道说明以平台展示为准。官网提供模型比价、逐次调用费用记录和接入支持，让你选之前能比价、用之后能查账。日常翻译、文献问答、摘要整理，可以先从实惠的模型试起，再按任务需要选择更强的模型，把预算用在真正需要的地方。

### API 是什么？不懂编程，也能用！

把 **API** 想成“软件与 AI 之间的连接插口”：你在 Zotero 里点击翻译或提问，插件就通过这个插口把内容交给 AI，再把回答送回阅读界面。**API Key 是你的专属通行证**，用来识别账号并扣除相应额度；在插件中填好服务地址、密钥和模型即可使用，无需自己写代码。

对读论文的人来说，API 的好处很直接：

- **少复制粘贴，阅读更连贯**：在支持的插件功能中直接翻译、提问，把时间留给理解论文。
- **用多少，付多少**：文本模型通常按输入和输出的 Token 计费。Token 可以粗略理解为 AI 处理的小段文字，并不等于字数；发给 AI 的正文、历史对话和生成的回答都可能计费。偶尔使用也能灵活安排预算。
- **模型自由选，省钱有方法**：同一平台比较不同模型，按自己的译文效果、响应速度和价格选择，不必给每个模型都单独购买月度会员。
- **开支看得见**：查看每次调用的用量与费用，给密钥设置额度，让花费心中有数。

### GPT、GLM、MiMo：选模型，也要看优惠

**GPT 低至 0.2 折，MiMo 福利价 1 折，国产模型也有好价！** 以下优惠于 **2026-09-23** 根据平台有效模型价格与分组倍率核对：

| 模型与适用分组 | 当前折扣 | 可以从这些任务开始试用 |
| --- | --- | --- |
| GPT-6 Sol · GPT PLUS 组 | **0.2 折**，按站内模型基准价的 2% 计费，省 98% | 英文论文阅读、复杂问题讨论、写作润色 |
| GPT-6 Sol · GPT PRO 组 | **0.55 折**，按站内模型基准价的 5.5% 计费，省 94.5% | 按账号可用分组选择 GPT 接入 |
| MiMo-V2.6-Flash / Pro、MiMo-V2.5 / Pro · 福利模型（不定期）组 | **1 折**，按站内模型基准价的 10% 计费，省 90% | 日常问答、推理辅助、文献内容整理 |
| GLM-5.2 · 国产模型组 | **7 折**，比平台列示的官方参考价省 30% | 中文文献问答、摘要整理、中英文翻译 |
| GLM-5.1 / GLM-5.3 · 国产模型组 | **8 折**，比平台列示的官方参考价省 20% | 根据论文难度与实际效果选择型号 |
| Qwen3.8-Flash · 国产模型组 | **9 折**，比平台列示的官方参考价省 10% | 日常翻译、文本整理 |
| Kimi-K2.6 · 国产模型组 | **8 折**，比平台列示的官方参考价省 20% | 长文阅读、内容归纳 |
| DeepSeek-V4-Flash · 国产模型组 | **8 折**，对比同一时段的平台官方参考价；另有夜间低价 | 推理问答、文献分析 |

**小数点别看错：0.2 折是付 2%，不是付 20%。** 例如 GPT-6 Sol 在输入长度不超过 272,000 Token、选择 GPT PLUS 组时，每百万 Token 的输入价约 **¥0.28**、输出价约 **¥1.40**；MiMo-V2.6-Flash 在上述福利组的输入价为 **¥0.10**、输出价为 **¥0.20**。这里的“每百万”是计价单位，不是最低购买量；实际按用量计算。输入是“交给 AI 的内容”，输出是“AI 写给你的回答”，两部分分别收费。

选购时留意以下几点，就能把优惠用明白：

- **选对型号和分组**：GLM、Qwen、Kimi、DeepSeek 上述优惠对应模型名前带 `bailian/` 的渠道，不代表整个品牌所有型号同价。GPT PLUS / GPT PRO 是本站 **API 分组名称**，不代表购买了 ChatGPT Plus / Pro 会员。
- **按账号资格使用**：分组可用性及累计充值门槛以登录后展示为准；MiMo 所在分组为“不定期福利”，活动可能调整。GPT 与 MiMo 的折数以站内模型基准价为分母，不等同于已逐项核验所有原厂价。
- **长文和时段也会影响价格**：GPT 长上下文另有价档；上述 DeepSeek 型号在北京时间 22:00 至次日 08:00 的输入、输出价为日间的一半。缓存等额外计费项按模型详情执行，表中折扣不另行叠加充值赠额。

**[查看最新价格对比 →](https://toodooai.com/price-comparison)** · **[浏览全部模型 →](https://toodooai.com/pricing)**。价格表是本次核对的快照，实际价格、模型可用性和活动条件以平台实时展示为准。

### 想直接用 ChatGPT？也有 GPT 会员代订阅服务

如果你更习惯在 ChatGPT 网页或 App 中直接聊天，Toodoo AI 还提供 **GPT 会员代订阅服务**，具体套餐、价格、交付方式与售后请向平台咨询。

**怎么选？** 想在 Zotero 插件中调用模型，选择 API 服务；想在 ChatGPT 网页或 App 中使用会员功能，了解会员代订阅。两者分别计费，购买会员不会自动获得插件可用的 API 余额。

**[前往 Toodoo AI，挑选你的 AI 助手 →](https://toodooai.com/)** 先用一小段熟悉的论文试试效果，再决定适合自己的模型和预算。首次配置可查看[平台接入文档](https://toodooai.com/docs)，或通过官网 QQ 群 **658248617** 咨询。使用 API 时，所选内容会发送给服务平台处理；密钥请妥善保管，不要发到群聊或公开截图中。

<a id="requirements"></a>

## 先看：依赖、安装方式与功能入口

### 插件依赖

- **宿主程序**：需要 [Zotero 桌面版 8.0–10.0.*](https://www.zotero.org/download/)。自动识别 PDF 图片需要 Zotero 10.0.1 及以上版本的兼容 PDF 阅读器。
- **AI 接入**：要使用 AI 功能，需要配置一种 AI 服务。可以使用 [BYOK 自带 API Key](docs/usage-guide.md#byok-provider)（Provider 的 API Key、Base URL 和模型 ID，不需要攻玉账号），也可以[连接攻玉学术](docs/usage-guide.md#connect)（攻玉账号和插件令牌）。模型调用费用按所选服务商或攻玉账号规则计算。
- **本机 OCR**：问答和默认选文翻译不需要 Python；全文 Markdown、翻译和参考文献提取默认使用 PDF 文字层，无需 Python；仅在启用[可选 OCR](docs/local-ocr.md)识别扫描页时需要本机运行环境、Python 依赖和模型。首次安装需要联网并预留数 GB 磁盘空间。
- **插件之外的文献工具**：Zotero Connector 不是本插件的依赖；它只负责从浏览器收集文献，是否安装不影响本插件在 Zotero 中阅读本地文献和 PDF。

### 当前可用的安装方式

| 安装方式 | 操作 | 说明 |
| --- | --- | --- |
| [官网插件详情页](https://jadense.cn/plugin/zotero) | 在页面的下载入口获取 `.xpi`，再按 [Zotero 官方插件安装说明](https://www.zotero.org/support/plugins) 导入 | 以官网页面当前显示的版本、兼容范围和下载状态为准 |
| [GitHub Release](https://github.com/jadense-ai/jadense-in-zotero/releases/latest) | 下载 `jadense-in-zotero-v0.6.2.xpi`，在 Zotero「工具 → 插件 → 齿轮 → 从文件安装插件」中打开 | 当前公开版本为 [v0.6.2](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.2)，同时提供元数据和 SHA-256 校验和 |
| Zotero 自动更新 | 在 Zotero「工具 → 插件 → 齿轮 → Check for Updates」中检查 | 使用[攻玉官方更新清单](https://jadense.cn/plugins/zotero/jadense-in-zotero/updates.json)；该渠道与 GitHub Release 独立维护，若未出现新版本请使用上面的手动安装方式 |
| 从源码构建 | 按[贡献指南](CONTRIBUTING.md#开发与本机验证)使用 Node 24、pnpm 10.19.0 构建，再安装 `release/zotero/v0.6.2/jadense-in-zotero-v0.6.2.xpi` | 构建当前源码；仅需本仓库与所列构建依赖 |

以上渠道最终安装的都是 Zotero `.xpi` 插件：不要把 GitHub 的 **Source code** 压缩包当作安装包，也不要同时启用旧的 `.com` 插件身份。旧版本升级和身份迁移见[升级说明](#upgrade)。


<a id="ocr-installation"></a>

## OCR 依赖安装

0.5.0 的全文 Markdown、全文翻译和参考文献提取默认使用文字层；识别扫描页可按需安装 OCR。普通问答和默认选文翻译无需 Python。在 **设置 → 外置依赖配置** 点击 **启用本机 OCR**，等待“已就绪”；失败后查看日志并点击 **继续准备**。首次需联网下载 Python、依赖和模型，预留数 GB 空间，无需预装 Python 或配置 CUDA。

**[详细 OCR 安装指南](docs/local-ocr.md)**：包含[设置界面操作](docs/local-ocr.md#settings)、[Windows](docs/local-ocr.md#windows)、[Linux](docs/local-ocr.md#linux)、[macOS](docs/local-ocr.md#macos) 手动安装，以及[模型验证](docs/local-ocr.md#models)、[修复与重装](docs/local-ocr.md#repair)。指南说明 v0.4.10 的操作与旧版差异。

<a id="pdf-engine-installation"></a>

## 版面解析引擎安装（0.6.0）

1. **系统自动安装**：进入 **设置 → 外置依赖配置 → 版面解析引擎 → 准备 PDF 翻译引擎**。当前源码自动安装独立 Python、锁定依赖、模型和字体；完整包自动下载尚未启用。
2. **手动/离线安装**：取得匹配的 Windows x64 完整 ZIP 后点击 **导入离线包**，无需预装 Python 或管理员权限。完整包见 [v0.6.0 附件](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.0)。
3. **库内备用源**：使用[仓库内安装器与锁定源码](content/pdf-translation/)手动安装，再点击 **检测已安装引擎**。此备用路径仍需下载依赖与资产，不是离线二进制镜像。

[查看完整安装指南、平台限制与故障处理](docs/pdf-engine.md)。版面解析引擎与 OCR 独立，不影响普通文字层阅读。

## 目录

- [API推荐：Toodoo AI](#api-recommendation)
- [先看：依赖、安装方式与功能入口](#requirements)
- [OCR 依赖安装](#ocr-installation)
- [版面解析引擎安装](#pdf-engine-installation)
- [如何使用本插件](#quick-start)
  - [1. 安装与打开工作台](#安装)
  - [2. 选择 AI 接入方式](#ai-connection)
    - [2.1 自带 API Key（BYOK）](#使用-byok)
    - [2.2 连接攻玉](#连接攻玉)
  - [3. 完成第一次阅读](#first-reading)
    - [问答、选文翻译与解析](#first-reading)
    - [全文翻译、参考文献与图片解读](#more-reading)
  - [4. 设置显示语言与主题](#显示语言与主题)
- [阅读与解析：功能介绍](#阅读与解析)
- [Zotero 入门指南](docs/zotero-guide.md) · [完整图文指南](docs/usage-guide.md)
- [常见问题](#常见问题)
  - [账号与费用](#必须注册吗是否免费) · [数据与凭据](#数据与凭据)
  - [兼容范围与阅读限制](#支持哪些版本有哪些阅读限制) · [升级说明](#upgrade)
- [在攻玉继续研究](#continue-research)
  - [认识攻玉学术](#jadense-introduction) · [把文献带入研究项目](#research-project)
- [如何支持我们](#support) · [微信 / 支付宝赞助页](support/README.md)
- [参与和反馈](#参与和反馈) · [发布流程](CONTRIBUTING.md#发布正式版本)
- [许可证](#许可证)

<a id="quick-start"></a>

## 如何使用本插件

**安装插件 → 配置一种 AI 接入方式 → 选择模型 → 打开 PDF 开始阅读。** 问答与默认选文翻译无需 Python；文字层全文任务无需 Python；扫描页需要 OCR 时，在「设置 → 外置依赖配置」准备依赖与模型，首次预留数 GB 空间。BYOK 需要能访问所配置的模型 API。[OCR 安装与故障处理](docs/local-ocr.md)。

下面给出最短上手步骤。[完整图文使用指南](docs/usage-guide.md)逐步说明提供商、模型、攻玉令牌和阅读操作。新接触 Zotero 的用户可先读 [Zotero 入门](docs/zotero-guide.md)。

<a id="安装"></a>

### 1. 安装与打开工作台

1. 从 [最新 Release](https://github.com/jadense-ai/jadense-in-zotero/releases/latest) 下载 `.xpi` 插件文件，当前正式版为 **0.6.2**。安装过旧版的用户请先查看下方[升级说明](#upgrade)。
2. 在 Zotero 插件管理器中选择「从文件安装插件」，选中下载的 XPI。
3. 从 Zotero 的 Jadense 入口打开工作台，按自己的需要选择一种接入方式。

<a id="ai-connection"></a>

### 2. 选择 AI 接入方式

两种方式使用同一安装包，均可用于文献问答、翻译、解析和图片解读；图片能力取决于所选模型。

| 接入方式 | 适合你，如果…… | 准备什么 |
| --- | --- | --- |
| 自带 API Key（BYOK） | 已有模型服务，希望自己选择提供商和模型 | 服务商的 API Key、Base URL 和模型 ID，无需攻玉账号 |
| 连接攻玉 | 希望使用攻玉账号的模型服务，并把文献用于后续研究 | 攻玉账号与插件令牌 |

攻玉 AI 请求需要服务端支持临时执行 V1 协议；旧服务端会提示升级。待确认请求可在「恢复结果」中读取已有结果，打开历史不会自动重发。BYOK 可独立使用，未确认的第三方请求不会自动重发。参考文献批量 AI 默认关闭，可在功能配置中显式开启。

<a id="使用-byok"></a>

#### 2.1 自带 API Key（BYOK）

1. 在工作台齿轮「设置 → BYOK」添加 Provider，选择 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 协议，填写 Base URL 和 API Key。
2. 添加模型，填写模型 ID，并按服务商要求设置输出上限；可用连接测试检查配置。
3. 在「设置 → 功能配置」为需要使用的功能选择该 BYOK 模型。默认开启「自动跟随当前对话模型」，其他功能使用当前对话模型；关闭后可分别选择实时翻译、文献解析和图片解读模型。

![在 BYOK 中配置提供商、协议、API 基础地址与密钥](docs/images/guide-byok-provider.png)

图示为当前插件构建的浏览器预览，使用虚构配置；请替换示例地址和密钥，不要直接照抄。[下一步：添加模型并选择功能模型](docs/usage-guide.md#byok-model)。

插件直接向你配置的 Provider 发起 BYOK 模型请求。「文献解析 → 解析配置」也可调整解析模型，与功能配置中的选择共用；更换或删除模型不会把失败请求自动转发给其他 Provider。

<a id="连接攻玉"></a>

#### 2.2 连接攻玉

1. 在[攻玉学术](https://jadense.cn/)的「设置 → 集成 → 连接 Jadense in Zotero」创建令牌。
2. 在插件「设置 → 连接攻玉」粘贴插件令牌并保存。
3. 在「设置 → 功能配置」选择账号可用的模型。「攻玉学术 → 用户信息」的「你的攻玉」集中显示账号、订阅、可用积分及来源，以及签到奖励和连续天数。

「用户信息」顶部提供「前往攻玉 / 打开签到页 / 订阅与用量」三个网页入口，未连接时也可打开。签到在网页完成后，可在「你的攻玉」标题右侧刷新状态；账号和积分分别加载，单项失败不影响另一项显示。

<a id="first-reading"></a>

### 3. 完成第一次阅读

#### 3.1 从选文翻译到论文问答

打开一篇可选中文字的 PDF，选中一个暂时没读懂的段落，按翻译快捷键查看译文。再点击 PDF 工具条的「提问」，输入：

> 请解释这篇论文的核心研究问题，并指出我应该重点核对哪些方法与实验结果。

准备精读时，点击「解析」查看总结、笔记和原文批注。更多操作说明就在工作台的「上手指南」中。

![Zotero PDF 选文工具条中的智能翻译与对话入口](docs/images/guide-selection-actions.png)

图示为 Zotero 10.0.2 隔离环境的合成论文；选中文本后使用「智能翻译」，或开启/追加对话。

<a id="more-reading"></a>

#### 3.2 继续全文阅读、追踪引用与看图

- [全文翻译](docs/usage-guide.md#full-translation)：按段阅读译文，在定位模式回到原文。
- [文献解析](docs/usage-guide.md#paper-analysis)：查看总结、笔记及批注。
- [参考文献](docs/usage-guide.md#references)：核验来源后导入已验证条目。
- [图片解读](docs/usage-guide.md#figures)：自动识图、手动框选或上传图片。

<a id="显示语言与主题"></a>

### 4. 设置显示语言与主题

在「设置 → 常规」选择适合你的界面语言和主题；Zotero 原生插件设置也提供相同配置。

- **显示语言**：跟随 Zotero、简体中文或 English，默认跟随。中文 Zotero 使用简体中文，其他语言使用英文。保存后重启 Zotero 生效，仅重开工作台不会切换；界面语言不改变翻译方向、AI 输出要求、文献或既有历史。
- **主题设置**：跟随 Zotero、浅色或深色，默认跟随，立即同步已打开的插件界面。原有浅深偏好继续生效；侧栏按钮也可切换并保存主题，草稿和进行中的生成会保留。
- **字号与翻译浮窗**：插件字号支持 12–24px；可选择普通或毛玻璃浮窗并调整背景透明度。选文浮窗可拖动标题、从边角缩放，左下角「外观」可直接调整样式。全文侧栏使用不透明背景与独立正文排版，可调整宽度。透明度只影响背景；毛玻璃需要宿主图形能力，不可用时保留普通背景。

工作台、阅读器工具、指南、原生设置、菜单和提示均支持中英文。Zotero 窗口外框、系统标题栏和 PDF 页面外观继续由 Zotero 管理。

## 阅读与解析

### [先把一篇论文的重点留在原文旁](docs/usage-guide.md#paper-analysis)

在 PDF 工具条点击「解析」，查看论文总结与详细笔记，并通过 Zotero 原生批注回到对应段落核对。生成的批注可编辑、筛选和随 PDF 导出，不覆盖你的人工批注；未能定位到原文的内容仍可在解析笔记中查看。

### [带着问题读，而不只是得到一段总结](docs/usage-guide.md#paper-chat)

点击「提问」，围绕当前论文开始对话；也可以关联 Zotero 文献、PDF 或选文，询问「作者为什么选择这种方法？」「这一结论依赖哪些条件？」。对话历史保存在本机，方便接着问、回头看。

### [遇到难懂的段落，就地翻译](docs/usage-guide.md#selection-translation)

选中文本后点击选区弹出栏的「智能翻译」，或按 `Ctrl+Alt+T`（macOS：`⌘+Alt+T`），在阅读器浮窗中查看译文。支持 32 种语言选项，可临时调整当前选文的翻译方向；已有文章语言偏好继续生效。阅读操作中的「对照翻译」进入 PDF 排版翻译，侧栏「全文翻译」用于段落译文；选文翻译使用选区入口或快捷键。

### [翻译整篇 PDF，随时回到原文核对](docs/usage-guide.md#full-translation)

在阅读操作中选择「全文翻译」，按段查看译文并定位原文。全文译文在阅读器侧栏连续展示，支持目录、独立字号/行距和阅读位置恢复；阅读模式专注浏览，定位模式可点击段落核对原文。隐藏侧栏后任务继续；中断或重启后可从翻译历史手动继续，保留已经完成的部分。在「设置 → 功能配置 → 全文翻译」选择 AI 或 Bing/Google。全文翻译默认读取文字层；扫描页可启用本机 OCR，再发送提取正文。首次翻译会提示费用与稳定性，此段落阅读入口与下方新增 PDF 排版翻译独立。

### [PDF 对照与原位翻译（0.6.0）](docs/usage-guide.md#pdf-translation-060)

从 PDF 阅读操作进入「对照翻译」，并排查看原文和译文，也可切换整页译文或独立窗口用于多屏阅读。支持同步/解除同步滚动，保存仅译文 PDF 或原文与译文对照 PDF，不覆盖原附件。

默认「精简」翻译正文、图表说明和学术脚注，出版信息与参考文献保留原文；「完整」翻译所有可译文字。界面字号改为 80%–200% 滑块，支持 1% 微调与恢复默认。完成内容逐步显示；部分失败后仍可阅读、导出已有成果，点击「补译未完成部分」复用已完成片段。公式、表格和复杂版面仍需对照原文核实。只有此功能需要准备版面解析引擎。

### [从参考文献继续追踪证据](docs/usage-guide.md#references)

「解析」同时提取当前 PDF 的参考文献，在「文献解析 → 论文详情 → 参考文献」核对来源、验证 DOI，再选择核对后的候选导入 Zotero；「已选首条」表示无精确匹配时的首条候选，须特别核查。原始顺序、编号与重复项保留，无法确认的内容继续展示；导入按同库 DOI 去重，仅保存元数据与链接，不自动下载 PDF。

阅读器空间不足时，提问、解析、引用和对照翻译收在「•••」阅读操作菜单内；点击 Jadense 图标直接打开工作台。若收起 Zotero 原生侧栏，插件侧栏也会收起；需要时可再次点击阅读操作打开插件侧栏。

### [看图表时，把论文背景一起带入问题](docs/usage-guide.md#figures)

点击自动识别的图片，或按 `Ctrl+Alt+S`（macOS：`⌘+Alt+S`）框选 PDF 区域，选择开启新对话或追加到当前对话。新对话会关联当前文献及可提取的 PDF 正文；正文超出模型容量时，默认只发送与问题相关的原文片段，不额外概括全文。也可在对话中上传、粘贴或拖入 PNG/JPEG 图片；图片随对话保存在本机，重开后可继续查看和追问。

图片解读需使用支持图片输入的模型；自动识图需要 Zotero 10.0.1+ 的兼容 PDF 阅读器。无法自动识别时，可在支持原生裁图的 PDF 阅读器中手动框选。截图与翻译快捷键均可在设置中修改。

<a id="continue-research"></a>

## 读完几篇论文，接着做研究

<a id="jadense-introduction"></a>

### 认识攻玉学术

[![攻玉学术官网暗色主题首页首屏](docs/images/jadense-home-dark.png)](https://jadense.cn/)

[攻玉学术](https://jadense.cn/)官网暗色主题实拍，点击图片进入主应用官网。

读到这里，问题可能已经从「这篇论文讲了什么」，变成「这些论文的方法有什么不同，我的课题还缺什么证据？」。

**攻玉学术**可以承接这一阶段：把相关文献组织到研究项目中，围绕同一个问题持续对话，让阅读所得成为比较方法、整理证据和规划下一步的材料。

<a id="research-project"></a>

### 把阅读所得带入研究项目

1. 在 Zotero 选中与课题相关的文献，进入插件「攻玉学术 → 文献同步」。
2. 选择攻玉收藏夹及是否包含 PDF，上传所选文献。
3. 在攻玉网页端打开或创建一个项目，点击「添加上下文」，从个人收藏夹选择这些文献，再在项目中开始对话。

例如，可以带着这组资料提出一个具体任务：

> 请根据提供的文献，比较研究对象、方法和主要证据，区分作者结论与推断，列出仍需补充检索的问题，并拟一份综述提纲。资料不足的地方请明确标出。

上传是 **Zotero → 攻玉的单向操作**，PDF 由你选择是否包含，元数据与 PDF 分别报告结果。插件的对话、笔记和批注不会随文献自动同步到网页端。仅需 Zotero 内的阅读辅助时，可以继续独立使用 BYOK。

[在攻玉学术继续研究](https://jadense.cn/) · [了解项目与资料的使用方式](https://jadense.cn/docs/research-resources)

## 常见问题

更多关于 BYOK 地址、鉴权失败、模型选择、扫描件、商用与赞助的问题，见[完整 FAQ](docs/faq.md)。

### 必须注册吗？是否免费？

使用 BYOK 无需攻玉账号；插件免费下载，允许个人非商业自用、学习与研究，不要求赞助。商业用途须另行取得书面授权。第三方模型费用由对应服务商收取，攻玉服务按账号权限、订阅与积分规则提供。

攻玉受限模型会标注「需升级」和所需档位。遇到限制时，可更换可用模型或升级订阅；充值积分不会解锁受限模型。旧插件令牌缺少积分权限时，账号卡片会提示更新令牌，其他已获授权功能仍可使用。

### 数据与凭据

以下描述的是 **Zotero 插件**的数据路径。

| 操作 | 数据去向 |
| --- | --- |
| 保存设置、对话、图片附件、翻译和解析历史 | 本机 Zotero profile；API Key 和攻玉令牌也保存在此处，请勿公开分享 profile |
| 云 OCR | 确认上传及费用后，将相应 PDF 或页面图片直接发送到所选服务；凭证使用 Zotero 登录管理器，无法持久化时仅当前会话保存 |
| BYOK 模型请求 | 插件直接发送给所选 Provider，包含请求所需的文字、文献上下文及图片；API Key 用于该 Provider 认证 |
| 参考文献识别、核验与导入 | 不确定片段可交给所选解析模型；DOI/书目信息通过 Zotero 检索与 Crossref 核验，精确匹配或标记「已选首条」的候选经用户核对后导入本机资料库 |
| 攻玉 AI 功能 | 攻玉接收临时请求及所需上下文，使用插件令牌鉴权，并接收插件版本和功能类型供问题定位；服务端按其规则处理请求、计费和运行记录 |
| 文献同步 | 主动上传所选文献元数据，仅在选择包含 PDF 时上传本地 PDF |
| 插件自动更新 | Zotero 请求攻玉官网的更新清单及安装包 |

本地保存历史不等于离线运行。关联 PDF 的可提取正文可成为模型上下文，带图片的后续追问可再次发送最近一张可读取图片。插件对话不会创建攻玉网页端的持久对话；已配置攻玉连接时，账号卡片等功能仍可独立请求攻玉，BYOK 不会关闭这些请求或自动更新。凭据与安全反馈说明见 [SECURITY.md](SECURITY.md)。

### 支持哪些版本？有哪些阅读限制？

Manifest 声明兼容 Zotero **8.0 至 10.0.\***。本指南截图使用 **Windows 11 / Zotero 10.0.2** 与 0.4.4 本地构建，数据和服务均为模拟；本次截图冒烟在宽屏阅读器检查处超时，不代表全量验收通过。macOS、Linux、Zotero 8/9 和真实付费 Provider 未在本次文档工作中实测。当前正式版见 [v0.6.2 Release](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.2)；截图与原生验收记录仍以各版本发布说明为准。

全文翻译默认提取 PDF 文字层；扫描页可启用 OCR，提取后的正文会发送至你选择的翻译服务。首次全文翻译会提示费用与稳定性，取消不会发起请求。解析结果受文本可提取范围和模型输出影响，请结合原文核对；中断或部分批注写入失败时会尽可能保留已生成笔记并提示结果。每条消息可新附一张图片，旧版本未保存的图片无法自动恢复。

<a id="upgrade"></a>

### 从旧版怎样升级？

可从 GitHub 0.4.0–0.6.1 直接安装升级到正式版 0.6.2；相同 `.cn` 插件身份保留已有设置与本地历史。旧译文不会自动重译。

安装过使用 `jadense-in-zotero@jadense.com` 身份的版本（包括官网 0.3.2）时，**先禁用旧 Jadense 插件，再从文件手动安装最新正式版**。新版身份为 `jadense-in-zotero@jadense.cn`，不同身份不会自动覆盖升级，请勿同时启用。

新版沿用原有偏好命名空间与历史保存位置，请勿删除 Zotero profile。已保存的具体模型、路由与 BYOK 选择会保留。插件仍读取[攻玉官方更新源](https://jadense.cn/plugins/zotero/jadense-in-zotero/updates.json)，GitHub 发布不会自动修改官网更新清单。版本差异见 [更新说明](CHANGELOG.md)。

<a id="support"></a>

## 如何支持我们

如果插件帮助你更顺畅地阅读论文，欢迎 Star、分享、反馈问题或参与贡献。自愿赞助也能帮助我们持续维护插件和文档。

- 赞助时可在备注中留下希望出现在未来赞助名单中的**昵称与留言**；希望公开时请注明「同意公开」，否则默认匿名。
- ☕ [Wechat 微信 / Alipay 支付宝](support/README.md)

点击上方链接进入本项目独立赞助页，查看收款码、留言规则与未来名单说明。赞助不是使用门槛，不兑换订阅、积分或商业授权。

## Star 增长趋势

<a href="https://www.star-history.com/#jadense-ai/jadense-in-zotero&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=jadense-ai/jadense-in-zotero&amp;type=Date&amp;theme=dark">
    <img alt="Jadense in Zotero Star 增长趋势图" src="https://api.star-history.com/svg?repos=jadense-ai/jadense-in-zotero&amp;type=Date">
  </picture>
</a>

## 参与和反馈

欢迎通过 [Issues](https://github.com/jadense-ai/jadense-in-zotero/issues) 反馈使用问题或提出建议，附上插件版本、Zotero 版本、系统及可复现步骤，并去除账号信息和私人资料。若插件帮到了你的阅读，也欢迎 Star 或分享给同样使用 Zotero 的同学和同事。

### 独立开发与验证

插件可独立开发，无需主应用源码、数据库或 `.env`。环境准备、构建与隔离 Zotero 验证见 [贡献与 GitHub 发布指南](CONTRIBUTING.md#开发与本机验证)，产品设计见 [DESIGN.md](DESIGN.md)。

### 同步与发布

上游同步、PR 检查、草稿发布和制品核验由[贡献指南](CONTRIBUTING.md)统一说明。

## 许可证

当前代码采用 [Jadense 非商业使用许可证 1.0](LICENSE)：允许个人非商业自用、学习和研究，以及遵守许可的免费修改与分发；禁止商业使用，商业授权需另行书面取得。赞助不构成商业授权。

本项目属于源码公开项目，不再使用 MIT 或 OSI 开源许可来描述当前整体许可；[OSI 开源定义](https://opensource.org/osd)不允许限制商业用途。新许可不追溯撤销历史 MIT 版本的既有授权，也不改变第三方组件的原有许可，原声明见[第三方与历史许可声明](THIRD_PARTY_NOTICES.md)。已发布版本的 CHANGELOG 保留历史事实。本仓库不包含攻玉主应用或服务端，也不授予官方身份或商标使用权。
