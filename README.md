# Jadense in Zotero

在 Zotero 内与文献对话、翻译选文、解读图片，并生成带原文定位的文献解析。完整客户端以 MIT 开源，同时支持 **BYOK** 和 **连接攻玉**，两种方式使用同一份安装包。

当前版本为 **0.4.0**，保留官网 0.3.2 的完整客户端功能，并完善默认模型、订阅提示及插件身份迁移；具体差异见 [更新说明](CHANGELOG.md)。仓库只包含 Zotero 客户端，不包含攻玉主应用、服务端或服务凭据。攻玉账号服务仍按其账号权限、订阅及积分规则提供。

## 安装

1. 从本仓库的 [Releases](https://github.com/jadense-ai/jadense-in-zotero/releases) 下载 `jadense-in-zotero-v0.4.0.xpi`，或按下方步骤自行构建。安装过旧 `.com` ID 版本时，先在插件管理器中禁用旧 Jadense 插件。
2. 在 Zotero 的插件管理器中选择「从文件安装插件」，选择 XPI。
3. 从 Zotero 的 Jadense 入口打开工作台，选择所需 AI 通道。

Manifest 声明兼容 Zotero 8.0 至 10.0.*；原生功能主要在 Zotero 10.0.1 验证。自动识图需要 Zotero 10.0.1+ 的普通 PDF 视图与可用的原生裁图能力，旧版本或无 SDT 的 PDF 不提供相同的自动识别能力。

插件 ID 为 `jadense-in-zotero@jadense.cn`。官网 0.3.2 使用旧 `.com` ID，两者不会自动覆盖升级，不能同时启用；请先禁用旧插件再手动安装新版。新版沿用原有本地偏好命名空间与历史保存位置，不要删除 Zotero profile。插件仍读取 [攻玉官方更新源](https://jadense.cn/plugins/zotero/jadense-in-zotero/updates.json)，但 GitHub 发布不修改该更新清单，不能据此假设官网已提供新版自动更新。

## 使用 BYOK

1. 在工作台齿轮「设置 → BYOK」添加 Provider，选择 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 协议，填写 Base URL 和自己的 API Key。
2. 为 Provider 添加模型，填写模型 ID，并按服务商要求设置输出上限；可使用连接测试检查配置。
3. 在「设置 → 功能配置」分别为 AI 对话、实时翻译、文献解析和图片解读选择 BYOK 模型。BYOK 直接请求配置的 Provider，无需攻玉账号。
4. 「文献解析 → 解析配置」与功能配置共用解析模型选择；对话输入框也可切换当前功能的模型。

Provider/模型配置保存在本机 Zotero profile。更换或删除模型不会自动把失败请求改投其他 Provider。默认 AI 通道仍为攻玉，首次使用 BYOK 需要主动切换。

## 连接攻玉

1. 在 [攻玉](https://jadense.cn) 的「设置 → 集成 → 连接 Jadense in Zotero」创建令牌。
2. 在插件「连接攻玉 → 连接配置」粘贴攻玉插件令牌并保存连接；插件使用内置的攻玉站点地址。
3. 「用户信息」显示账号、订阅、积分来源及签到；在功能配置中选择账号可访问的模型。新配置默认使用 `deepseek-v4-flash-vision-exp`，已有明确模型、路由和 BYOK 选择保持不变。
4. 「文献同步」选择攻玉收藏夹及是否包含 PDF，再上传 Zotero 当前选中条目或收藏夹。上传始终使用攻玉连接，与 BYOK 通道独立。

旧令牌可能缺少积分权限，账号卡片会提示更新令牌；其他已获授权功能继续可用。上传是 Zotero → 攻玉的单向操作，元数据和 PDF 分别报告结果。

受限模型会显示「需升级」及所需订阅档位。遇到模型订阅限制时，请更换可用模型或升级订阅；充值积分不会解锁受限模型。旧版已保存 GLM 具体模型的用户需要主动更换，升级不会覆盖该选择。

## 阅读与解析

- 「对话」支持关联 Zotero 文献、PDF 和选文，并可上传、粘贴或拖入 PNG/JPEG 图片；会话、文字历史和图片附件保存在本地。
- PDF 工具条可提问、解析、翻译或引用选文。解析独立保存总结和可恢复笔记，并写入 Zotero 原生批注，不覆盖人工批注。
- 选文后按 `Ctrl+Alt+T`（macOS：`⌘+Alt+T`）翻译；文章与本句语言可分别设置，历史保留准确页码。
- 图片悬停识别或 `Ctrl+Alt+S`（macOS：`⌘+Alt+S`）手动截图后，可开启新对话或追加到当前对话。快捷键可在设置中修改。

## 数据与凭据

| 操作 | 数据去向 |
| --- | --- |
| 保存设置、对话、图片附件、翻译和解析历史 | 本机 Zotero profile；API Key 和攻玉令牌也保存在该 profile，不能把它当作公开文件分享 |
| BYOK 对话、翻译、解析或图片解读 | 所选 Provider 接收请求中的文本、文献上下文及按需图片；BYOK Key 用于该 Provider 的认证 |
| 攻玉 AI 功能 | 攻玉接收临时 Chat 请求及所需上下文，附带插件版本与功能类型供问题定位，使用用户令牌鉴权；客户端不创建 Webapp 持久对话，但服务端仍按其规则处理请求、计费和运行记录 |
| 文献同步 | 显式上传所选元数据；仅在选择包含 PDF 时上传本地 PDF |
| 插件自动更新 | Zotero 请求官网更新清单及安装包 |

图片显示在对应消息中，支持点击放大；关闭并重新打开后仍可查看，并携带最近一张可读取图片继续追问。每条消息可新附一张图片，需要支持图片输入的模型；旧版本未保存的图片不能自动恢复。已关联 PDF 的可提取文字可能成为 AI 请求上下文。配置攻玉连接后，账号卡片等功能可以独立请求攻玉，切换 BYOK 并不代表整个插件不再访问攻玉。

## 独立开发与验证

使用 `.node-version` 固定的 Node **24.10.0** 和 `packageManager` 固定的 pnpm **10.19.0**。无需主应用源码、数据库或 `.env`。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run lint
pnpm run build
```

`build` 包含类型检查、打包和制品校验，产物位于 `release/zotero/v0.4.0/`：

- `jadense-in-zotero-v0.4.0.xpi`
- `release-metadata.json`
- `SHA256SUMS`

`manifest.json`、`build/` 和 `release/` 是生成物，不提交。XPI 包含项目许可证及打包依赖的完整许可证声明。

安装本机 Zotero 后，可运行隔离冒烟；将下列路径替换为自己的可执行文件路径：

```powershell
pnpm run smoke:installed -- 'C:/Program Files/Zotero/zotero.exe' --keep-temp
pnpm run smoke:research -- 'C:/Program Files/Zotero/zotero.exe' --keep-temp
pnpm run preview:research
```

冒烟创建临时 profile、合成 PDF 和本地模拟接口，不使用真实账号或资料库。`smoke:installed` 验证三次冷启动；`smoke:research` 覆盖阅读器、AI 通道、翻译、解析、账号连接和元数据/PDF 上传，包括无 PDF 条目的独立跳过和关闭 PDF 后仅发送元数据。模拟接口通过不等于生产 Provider 已验证。

## 同步与发布

贡献、PR 合并规则、CI 触发条件和 GitHub 草稿 Release 的完整操作流程见 [贡献与 GitHub 发布指南](CONTRIBUTING.md)。`main` 上的改动都经过 PR 与 `verify`，由维护者审阅后 squash merge。

当前商业插件目录是开发上游。本仓库是通过明确文件白名单导出的独立仓库，维护者在私有主仓库使用 `scripts/local/sync-zotero-opensource.mjs` 预览、`--write` 同步、`--check` 核对。该工具不属于插件运行依赖；公开仓库可以独立开发与构建。公开侧代码修改需先回到上游再同步，避免覆盖独立改动。

公开侧 README、安全说明和 `.github/` 由本仓库维护；同步不复制主仓库历史、环境文件、profile 或旧发布目录。修改打包依赖时需同步更新 `THIRD_PARTY_NOTICES.md`。

CI 在指向 `main` 的 PR、主分支推送和手动运行时执行完整检查。推送与 `package.json` 版本一致、且目标提交已包含在 `main` 的稳定 `vX.Y.Z` 标签后，工作流创建 **草稿 Release**，附同一次构建的一份 XPI、元数据和 SHA-256。维护者下载草稿制品，完成隔离 Zotero 安装、功能及适用的升级冒烟后人工公开；手动运行只验证，不创建 Release。GitHub 自带的 Source code 归档对应公开标签源码。

发布流程使用 GitHub 为当前仓库提供的短期 `GITHUB_TOKEN`，不需要攻玉服务凭据；只有草稿发布任务获得 `contents: write`。参见 [GitHub 权限说明](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) 和 [草稿 Release 命令](https://cli.github.com/manual/gh_release_create)。同名 Release 已存在时停止，不覆盖附件；公开后由 Release immutability 锁定标签和制品。如需更换已正式发布的字节，应提升版本后重新发布。官网发布与自动更新不属于本 GitHub 流程。

## 许可证

插件代码采用 [MIT](LICENSE)，打包依赖见 [第三方声明](THIRD_PARTY_NOTICES.md)。本仓库许可证仅覆盖此处发布的内容，不将攻玉主应用或在线服务一并开源，也不授予以官方身份运营或冒用商标的权利。安全问题处理方式见 [SECURITY.md](SECURITY.md)。
