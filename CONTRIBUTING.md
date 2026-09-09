# 贡献与 GitHub 发布

本仓库可以独立开发和构建，无需私有主应用、数据库、账号令牌或 `.env`。GitHub PR 与 Release 按本文执行；官网发布和自动更新不属于此流程。

## 开发与本机验证

使用 `.node-version` 中的 Node 版本和 `packageManager` 中的 pnpm 版本：

Windows 初次克隆建议使用 `git -c core.autocrlf=false clone https://github.com/jadense-ai/jadense-in-zotero.git` 保留仓库的 LF 换行；部分现有源码匹配测试依赖 LF。无需修改全局 Git 配置。

```powershell
pnpm install --frozen-lockfile
pnpm test
node --test .github/scripts/release.test.mjs
pnpm run lint
pnpm run build
```

`build` 已包含类型检查、XPI 打包和制品校验。运行功能测试位于 `src/`，GitHub 发布边界测试位于 `.github/scripts/`；后者只使用临时 Git 仓库和模拟发布命令。

当前固定 Node **24.10.0**、pnpm **10.19.0**。构建产物位于 `release/zotero/v<package.json 版本>/`，包括 `jadense-in-zotero-v<版本>.xpi`、`release-metadata.json` 和 `SHA256SUMS`；`manifest.json`、`build/`、`release/` 均为生成物，不提交。XPI 包含项目许可证和打包依赖的完整许可证声明。

安装本机 Zotero 后，可运行隔离冒烟；请将路径替换为自己的可执行文件路径：

```powershell
pnpm run smoke:installed -- 'C:/Program Files/Zotero/zotero.exe' --keep-temp
pnpm run smoke:research -- 'C:/Program Files/Zotero/zotero.exe' --keep-temp
pnpm run smoke:research -- 'C:/Program Files/Zotero/zotero.exe' --appearance-language en-US --screenshots
pnpm run smoke:research -- 'C:/Program Files/Zotero/zotero.exe' --appearance-language zh-CN --screenshots
pnpm run preview:research
```

冒烟创建临时 profile、合成 PDF 和本地模拟接口，不使用真实账号或资料库。`smoke:installed` 验证三次冷启动；`smoke:research` 覆盖阅读器、AI 通道、翻译、解析、账号连接和元数据/PDF 上传，包括无 PDF 条目的独立跳过和关闭 PDF 后仅发送元数据。`--appearance-language` 验证中英文界面、常规设置及主题联动。模拟接口通过不等于生产 Provider 已验证；`preview:research` 用于查看研究工作台的界面状态。

## 提交 PR

1. 从最新 `main` 创建短期功能分支；外部贡献者使用 fork，PR 的目标分支为 `main`。
2. 一份 PR 解决一个明确问题，说明修改前后的行为、验证结果，以及兼容性或用户数据影响。推荐标题前缀 `feat`、`fix`、`docs`、`test`、`ci`、`chore`，不强制格式检查。
3. UI 修改提供去除个人信息的截图。涉及阅读器、批注、本地历史或升级的修改，补充实际 Zotero/操作系统版本及针对性验证；没有环境时明确尚未验证的范围。
4. 普通 PR 不改版本号，不提交 `build/`、`release/`、生成的 `manifest.json`、profile、日志或凭据。升级打包依赖时同步更新 `THIRD_PARTY_NOTICES.md`。
5. 维护者解决评审讨论、确保分支与最新 `main` 同步且 `verify` 成功后 squash merge。只保留 `main` 作为长期开发分支，合并后删除功能分支。

当前采用单维护者规则：所有改动经过 PR，强制批准人数为 0；外部 PR 仍由维护者审阅后合并。没有自动合并、强制 CODEOWNERS 审批、提交签名或日常管理员绕过。安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

## 维护者：上游回流

现有商业插件目录继续作为开发上游。外部 PR 通过公开 CI 和评审后，维护者将同一补丁回流私有上游并完成相关验证，再合并公开 PR，拉取公开结果并核对两侧受管文件一致。保留原作者署名和公开 PR 关联；贡献者不需要私有仓库权限。

内部开发通过白名单同步形成公开 PR，也经过相同检查。同步冲突必须先协调代码，不能强制覆盖公开侧贡献。受管内容一致后，维护者运行现有同步工具的 `--write` 刷新本地摘要，再以 `--check` 确认无差异。

README 中英文、CHANGELOG、本文、SECURITY 和 `.github/` 在公开仓库独立维护；CI 流程脚本放在 `.github/scripts/`，不进入插件 XPI，也不纳入上游源码同步白名单。

源码同步完成后，单独核对公开文档和已知文案分支：README 中英文的功能、入口、版本与链接应一致；CHANGELOG 按版本保留历史事实；CONTRIBUTING、SECURITY 与 DESIGN 应描述当前行为。不能把源码白名单同步通过当作全部文档已经发布。

## CI 与仓库设置

| 触发 | 行为 |
| --- | --- |
| PR → `main` | 冻结安装、测试、发布边界测试、lint、build；`verify` 是合并必过检查 |
| 推送到 `main` | 验证实际合并结果 |
| 推送 `v*` 标签 | 验证稳定版本、标签来源，构建后创建草稿 Release |
| `workflow_dispatch` | 只验证并上传 Actions 制品，即使选择标签也不创建 Release |

`verify` 超时 20 分钟，`draft-release` 超时 10 分钟。新 PR 提交取消同 PR 旧检查；标签运行按标签串行，不取消已在进行的发布。Actions 制品保留 30 天。Node/pnpm 使用项目固定版本，Actions 固定完整 commit SHA；更新 Actions 时必须核验上游仓库的目标提交。

仓库设置作为本流程的一部分维护：

- 只允许 squash merge；自动删除合并分支，关闭自动合并。
- `main`：必须 PR、GitHub Actions 来源的 `verify` 成功、最新主分支基线、所有讨论解决、线性历史；批准人数为 0，禁止强推和删除，无绕过人员。
- `v*`：创建规则只允许 `jadense-ai`；另一个无绕过规则禁止更新和删除，避免创建权限同时取得修改权限。
- 启用 Release immutability：公开后锁定标签及附件。

默认 `GITHUB_TOKEN` 只有 `contents: read`；仅草稿发布 job 获得 `contents: write`。使用 GitHub 托管 runner，不向外部 PR 提供 PAT、生产服务凭据或自托管执行环境。运行不可信 PR 不使用 `pull_request_target`。

## 发布正式版本

本流程只接受稳定版本 `X.Y.Z` 和对应 `vX.Y.Z` 标签；不支持 beta/rc。插件在 `0.x` 开发阶段采用以下项目发布策略，不因每项新增界面功能自动增加次版本：

- `0.4.x`：日常修复、界面优化和兼容的小功能，延续当前版本系列；后续版本系列沿用这一补丁版本策略。
- `0.5.0` 及后续次版本：计划中的功能里程碑，或涉及安装、数据、配置迁移的明显变化；发布说明列出兼容性影响和迁移要求。
- 每个已发布版本保持不可变。修改安装包必须使用新版本号，不同 XPI 字节不得重复使用已公开版本号。

1. 创建发布 PR，集中修改 `package.json` 版本和相关版本说明。依赖发生变化时更新锁文件；清楚列出新增、修复、兼容范围及升级注意事项。
2. 正常合并发布 PR，并确认 `main` CI 成功。维护者在最新 `main` 的预定提交创建并推送标签；以下 `0.4.1` 仅为示例，必须替换为发布 PR 中的实际版本：

   ```powershell
   git switch main
   git pull --ff-only
   git tag -a v0.4.1 -m "Jadense in Zotero v0.4.1"
   git push origin refs/tags/v0.4.1
   ```

3. 工作流要求标签与包版本精确一致，且提交已包含在 `origin/main` 历史中。`verify` 只构建一次；`draft-release` 下载同次运行的制品，重新检查哈希和元数据后创建草稿，附以下三个文件：

   - `jadense-in-zotero-vX.Y.Z.xpi`
   - `release-metadata.json`
   - `SHA256SUMS`

4. 从草稿下载这三个文件。使用标签对应的源码和测试脚本，先将 XPI 的 SHA-256 与 `SHA256SUMS` 核对，再对下载的 XPI 进行原生验收，不能重新构建后替代：

   ```powershell
   Get-FileHash ./candidate/jadense-in-zotero-v0.4.1.xpi -Algorithm SHA256
   Get-Content ./candidate/SHA256SUMS
   pnpm run smoke:installed -- --zotero 'C:/Program Files/Zotero/zotero.exe' --xpi ./candidate/jadense-in-zotero-v0.4.1.xpi
   pnpm run smoke:research -- --zotero 'C:/Program Files/Zotero/zotero.exe' --xpi ./candidate/jadense-in-zotero-v0.4.1.xpi
   pnpm run smoke:research -- --zotero 'C:/Program Files/Zotero/zotero.exe' --xpi ./candidate/jadense-in-zotero-v0.4.1.xpi --upgrade-from ./previous/jadense-in-zotero-v0.4.0.xpi
   ```

   路径和版本均替换为实际值。升级测试只用于存在同插件身份的上一正式版时；首版或身份不同则在验收记录填写不适用及原因，不将冷启动当作升级验证。冒烟使用临时 profile、合成数据和模拟接口，不上传真实用户资料或凭据。

5. 按下方文案规范完善草稿，补齐实际 Zotero/操作系统版本、功能限制和升级注意事项，确认附件齐全。Manifest 兼容范围不能代替实测记录。GitHub 自动生成的变更记录也需维护者核对；所有验收项完成后在 GitHub 人工公开草稿。

同名草稿或正式 Release 已存在时，工作流明确停止，不覆盖、删除或自动重新上传。只读查询或创建命令失败也不自动重试写入；网络中断可能已经留下部分草稿附件，应先检查远端状态。修复草稿只能补齐原 Actions 运行的已验证制品；若原制品已过期或无法确认一致性，使用新版本，不重打旧标签。公开后需要更换任何制品时必须增加版本号。

创建草稿及公开 Release 都不会执行官网发布或修改自动更新配置。

## Release 说明文案

Release 面向插件用户，重点介绍功能和更新价值。以本次版本相对上一正式版的实际变化为准，不把已有功能重新包装成新增。

- 开头用一两句话说明本次更新让哪些操作更方便、清楚或稳定。
- 主体按用户场景组织，每项说明「功能变化 → 用户收益」，必要时给出设置或操作入口。用准确、具体的描述，避免空泛宣传或承诺未经验证的效果。
- 升级方式、需要重启的设置、兼容性和影响使用的限制单独写清楚；不要用模糊措辞隐藏用户需要知道的行为变化。
- 测试和制品核验记录放在末尾简述，区分已实测环境与 Manifest 声明范围；完整技术记录链接到 PR 或 CI。测试数量、内部重构、文件路径、接口名称和提交清单不作为正文主体。
- 不披露内部产品决策动机、商业策略、私有地址、凭据或用户信息。只介绍公开功能及用户需要采取的操作。
- 发布前将 CI 草稿中的验收占位符替换为真实结果，核对自动生成的变更记录；保持说明与实际附件、功能和版本一致。

建议结构为「本次更新价值 / 功能与体验 / 升级与兼容 / 验证与下载」。小版本可合并段落，不必机械套用标题。GitHub 自动生成的提交摘要只能作为补充，不能代替面向用户的说明。
