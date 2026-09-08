import type { ZoteroLike } from "./runtime"

// 偏好面板与 Manager 共用的连接展示工具:令牌掩码、相对时间、剪贴板与面板文案。
// 显示与编辑分离的交互由 preferences-page.ts / manager-page.ts 各自实现,这里只放纯展示逻辑。

export function maskToken(token: string) {
  const trimmed = token.trim()
  if (!trimmed) return ""
  // 固定 8 个掩码圆点,避免泄露令牌真实长度;仅暴露尾 4 位便于用户对号。
  return trimmed.length > 4 ? `••••••••${trimmed.slice(-4)}` : "••••••••"
}

export function formatRelativeTime(iso: string, locale: string | undefined) {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return ""
  const zh = locale?.toLowerCase().startsWith("zh") ?? false
  const diffMs = Date.now() - timestamp
  if (diffMs < 45_000) return zh ? "刚刚" : "just now"
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} hr ago`
  const days = Math.round(hours / 24)
  return zh ? `${days} 天前` : `${days} d ago`
}

// Zotero 各文档(chrome 面板/主窗口)的 clipboard 可用性不一致,逐个候选尝试。
export async function copyTextToClipboard(zotero: ZoteroLike | null, text: string): Promise<boolean> {
  const candidates = [
    typeof navigator !== "undefined" ? navigator : undefined,
    zotero?.getMainWindow?.()?.navigator,
  ]
  for (const candidate of candidates) {
    try {
      if (candidate?.clipboard?.writeText) {
        await candidate.clipboard.writeText(text)
        return true
      }
    } catch {
      // 当前文档不允许写剪贴板时尝试下一个候选。
    }
  }
  return false
}

export type PreferencesStrings = {
  note: string
  routeLabel: string
  routeJadense: string
  routeByok: string
  jadenseSectionTitle: string
  jadenseSectionNote: string
  connectionTitle: string
  statusConnected: string
  statusNotConfigured: string
  statusChecking: string
  statusFailed: string
  updatedAgo: (relative: string) => string
  tokenLabel: string
  tokenNotConfigured: string
  copy: string
  copied: string
  copyFailed: string
  edit: string
  cancel: string
  saveToken: string
  tokenInputPlaceholder: string
  tokenSaved: string
  disconnect: string
  disconnected: string
  folderTitle: string
  folderNote: string
  folderLoading: string
  folderEmpty: string
  folderSelectPlaceholder: string
  folderSaved: string
  folderRetry: string
  optionsTitle: string
  includePdfLabel: string
  optionSaved: string
  helpTitle: string
  helpSteps: string[]
  helpNote: string
  byokSectionTitle: string
  byokSectionNote: string
  byokProviderTitle: string
  byokProviderSelectLabel: string
  byokProviderNameLabel: string
  byokProviderNew: string
  byokProviderDelete: string
  byokProviderSave: string
  byokProtocolLabel: string
  byokBaseUrlLabel: string
  byokEndpointLabel: string
  byokSavedKeyLabel: string
  byokKeyLabel: string
  byokKeyPlaceholder: string
  byokModelCatalogTitle: string
  byokModelCatalogNote: string
  byokModelSelectLabel: string
  byokModelSelectPlaceholder: string
  byokModelEmpty: string
  byokModelNameLabel: string
  byokModelLabel: string
  byokModelPlaceholder: string
  byokContextWindowLabel: string
  byokModelNew: string
  byokModelDelete: string
  byokMaxTokensLabel: string
  byokWarning: string
  byokClear: string
  byokTest: string
  byokSave: string
  byokSaved: string
  byokNewProviderName: string
  byokNewModelName: string
  byokProviderAdded: string
  byokProviderDeleted: string
  byokProviderSaved: string
  byokModelAdded: string
  byokModelDeleted: string
  byokModelSaved: string
  byokCleared: string
  byokTesting: string
  byokTestSucceeded: string
  unexpectedError: string
}

const ZH_STRINGS: PreferencesStrings = {
  note: "选择 AI 请求通道，并分别管理攻玉上传连接与本地 BYOK Provider。",
  routeLabel: "AI 请求通道",
  routeJadense: "攻玉",
  routeByok: "BYOK",
  jadenseSectionTitle: "连接攻玉",
  jadenseSectionNote: "攻玉令牌只用于攻玉聊天与上传；上传始终通过攻玉完成。",
  connectionTitle: "连接",
  statusConnected: "已连接",
  statusNotConfigured: "未配置令牌",
  statusChecking: "正在验证连接…",
  statusFailed: "连接失败",
  updatedAgo: (relative) => `更新于 ${relative}`,
  tokenLabel: "令牌",
  tokenNotConfigured: "未配置",
  copy: "复制",
  copied: "已复制",
  copyFailed: "复制失败",
  edit: "编辑",
  cancel: "取消",
  saveToken: "保存",
  tokenInputPlaceholder: "粘贴新的攻玉令牌",
  tokenSaved: "令牌已保存。",
  disconnect: "断开连接",
  disconnected: "已断开连接,令牌已从这台电脑的 Zotero 中移除。",
  folderTitle: "攻玉收藏夹",
  folderNote: "上传的 Zotero 条目会进入这里选择的收藏夹,选择后立即生效。",
  folderLoading: "正在加载收藏夹…",
  folderEmpty: "尚未加载到收藏夹",
  folderSelectPlaceholder: "选择攻玉收藏夹",
  folderSaved: "已保存目标收藏夹。",
  folderRetry: "重试",
  optionsTitle: "选项",
  includePdfLabel: "收藏夹上传时默认同时上传可读的 PDF 附件",
  optionSaved: "选项已保存。",
  helpTitle: "如何获取令牌",
  helpSteps: [
    "打开攻玉客户端并登录,进入「设置中心」。",
    "在「集成」区域找到「连接 Jadense in Zotero」。",
    "输入令牌名称并选择有效期(30 / 90 / 365 天),点击「生成 Token」。",
    "立即复制生成的令牌——明文只显示一次——然后粘贴到上方的「令牌」中。",
  ],
  helpNote: "令牌只保存在这台电脑的 Zotero 中;遗失或过期时,回到攻玉设置中心重新生成即可。",
  byokSectionTitle: "BYOK 配置",
  byokSectionNote: "先配置 Provider，再为它维护模型目录。聊天、翻译和论文解析会从当前 Zotero 客户端直接请求 Provider，不经过攻玉服务器。",
  byokProviderTitle: "Provider",
  byokProviderSelectLabel: "当前 Provider",
  byokProviderNameLabel: "显示名称",
  byokProviderNew: "新增",
  byokProviderDelete: "删除",
  byokProviderSave: "保存 Provider",
  byokProtocolLabel: "协议",
  byokBaseUrlLabel: "API Base URL",
  byokEndpointLabel: "请求地址",
  byokSavedKeyLabel: "已保存 Key",
  byokKeyLabel: "API Key（留空保留旧 Key）",
  byokKeyPlaceholder: "输入新 Key 以保存或测试",
  byokModelCatalogTitle: "模型目录",
  byokModelCatalogNote: "显示名称只用于界面；Model ID 会原样发送给 Provider。",
  byokModelSelectLabel: "当前模型",
  byokModelSelectPlaceholder: "选择模型",
  byokModelEmpty: "尚未添加模型",
  byokModelNameLabel: "显示名称",
  byokModelLabel: "Model ID",
  byokModelPlaceholder: "例如 mimo-v2.5",
  byokContextWindowLabel: "上下文窗口（可选）",
  byokModelNew: "添加模型",
  byokModelDelete: "删除",
  byokMaxTokensLabel: "最大输出 token",
  byokWarning: "Key 和关联文献内容会直接发送到当前请求地址。测试配置会发起最多 3000 token 的真实请求，可能产生费用。",
  byokClear: "清除 BYOK",
  byokTest: "测试配置",
  byokSave: "保存模型",
  byokSaved: "BYOK 配置已保存；保存操作未联网。",
  byokNewProviderName: "新 Provider",
  byokNewModelName: "新模型",
  byokProviderAdded: "已添加 Provider；请填写并保存连接信息。",
  byokProviderDeleted: "Provider 及其模型已删除。",
  byokProviderSaved: "Provider 已保存；保存操作未联网。",
  byokModelAdded: "已添加模型；请填写 Model ID 后保存。",
  byokModelDeleted: "模型已删除。",
  byokModelSaved: "模型已保存；保存操作未联网。",
  byokCleared: "BYOK 配置已清除，攻玉连接和当前通道未改变。",
  byokTesting: "正在发送最多 3000 token 的测试请求…",
  byokTestSucceeded: "测试成功。表单未保存，也未写入聊天历史。",
  unexpectedError: "操作失败,请重试。",
}

const EN_STRINGS: PreferencesStrings = {
  note: "Choose the AI request route and manage the Jadense upload connection and local BYOK provider separately.",
  routeLabel: "AI request route",
  routeJadense: "Jadense",
  routeByok: "BYOK",
  jadenseSectionTitle: "Connect Jadense",
  jadenseSectionNote: "The Jadense token is used for Jadense chat and uploads. Uploads always use Jadense.",
  connectionTitle: "Connection",
  statusConnected: "Connected",
  statusNotConfigured: "No token configured",
  statusChecking: "Verifying connection…",
  statusFailed: "Connection failed",
  updatedAgo: (relative) => `Updated ${relative}`,
  tokenLabel: "Token",
  tokenNotConfigured: "Not configured",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copy failed",
  edit: "Edit",
  cancel: "Cancel",
  saveToken: "Save",
  tokenInputPlaceholder: "Paste a new Jadense plugin token",
  tokenSaved: "Token saved.",
  disconnect: "Disconnect",
  disconnected: "Disconnected. The token was removed from this computer's Zotero.",
  folderTitle: "Jadense favorite folder",
  folderNote: "Uploaded Zotero items go to the folder selected here. Changes take effect immediately.",
  folderLoading: "Loading favorite folders…",
  folderEmpty: "No favorite folders loaded yet",
  folderSelectPlaceholder: "Select a Jadense folder",
  folderSaved: "Target folder saved.",
  folderRetry: "Retry",
  optionsTitle: "Options",
  includePdfLabel: "Upload readable PDF attachments by default for collection uploads",
  optionSaved: "Option saved.",
  helpTitle: "Where to find your token",
  helpSteps: [
    "Open the Jadense app, sign in, and go to Settings.",
    "Find “Connect Jadense in Zotero” in the Integrations area.",
    "Name the token, pick a validity period (30 / 90 / 365 days), and click “Generate Token”.",
    "Copy the token right away — it is shown only once — and paste it into “Token” above.",
  ],
  helpNote: "The token is stored only in this computer's Zotero. If it is lost or expires, generate a new one in Jadense Settings.",
  byokSectionTitle: "BYOK configuration",
  byokSectionNote: "Configure a provider first, then maintain its model catalog. Requests go directly from this Zotero client to the provider, without the Jadense server.",
  byokProviderTitle: "Provider",
  byokProviderSelectLabel: "Current provider",
  byokProviderNameLabel: "Display name",
  byokProviderNew: "Add",
  byokProviderDelete: "Delete",
  byokProviderSave: "Save provider",
  byokProtocolLabel: "Protocol",
  byokBaseUrlLabel: "API Base URL",
  byokEndpointLabel: "Request endpoint",
  byokSavedKeyLabel: "Saved key",
  byokKeyLabel: "API Key (leave blank to keep the saved key)",
  byokKeyPlaceholder: "Enter a new key to save or test",
  byokModelCatalogTitle: "Model catalog",
  byokModelCatalogNote: "The display name is local. Model ID is sent to the provider unchanged.",
  byokModelSelectLabel: "Current model",
  byokModelSelectPlaceholder: "Select a model",
  byokModelEmpty: "No models added",
  byokModelNameLabel: "Display name",
  byokModelLabel: "Model ID",
  byokModelPlaceholder: "For example, mimo-v2.5",
  byokContextWindowLabel: "Context window (optional)",
  byokModelNew: "Add model",
  byokModelDelete: "Delete",
  byokMaxTokensLabel: "Maximum output tokens",
  byokWarning: "Your key and related literature content are sent directly to this endpoint. Testing sends a real request capped at 3,000 tokens and may incur charges.",
  byokClear: "Clear BYOK",
  byokTest: "Test configuration",
  byokSave: "Save model",
  byokSaved: "BYOK configuration saved. Saving did not make a network request.",
  byokNewProviderName: "New provider",
  byokNewModelName: "New model",
  byokProviderAdded: "Provider added. Fill in and save its connection details.",
  byokProviderDeleted: "Provider and its models deleted.",
  byokProviderSaved: "Provider saved. No network request was made.",
  byokModelAdded: "Model added. Enter its Model ID and save.",
  byokModelDeleted: "Model deleted.",
  byokModelSaved: "Model saved. No network request was made.",
  byokCleared: "BYOK configuration cleared. The Jadense connection and current route were not changed.",
  byokTesting: "Sending a real test request capped at 3,000 tokens…",
  byokTestSucceeded: "Test succeeded. The form was not saved and chat history was unchanged.",
  unexpectedError: "Something went wrong. Please try again.",
}

export function selectPreferencesStrings(locale: string | undefined): PreferencesStrings {
  return locale?.toLowerCase().startsWith("zh") ? ZH_STRINGS : EN_STRINGS
}

// 面板 XHTML 只放 data-i18n-key 占位,文案统一由 JS 填充,避免依赖 FTL 是否注入懒加载的 Settings pane。
export function applyStrings(root: ParentNode, strings: PreferencesStrings) {
  root.querySelectorAll<HTMLElement>("[data-i18n-key]").forEach((element) => {
    const key = element.dataset.i18nKey as keyof PreferencesStrings
    const value = strings[key]
    if (typeof value === "string") element.textContent = value
  })
  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    const key = element.dataset.i18nAriaLabel as keyof PreferencesStrings
    const value = strings[key]
    if (typeof value === "string") element.setAttribute("aria-label", value)
  })
}
