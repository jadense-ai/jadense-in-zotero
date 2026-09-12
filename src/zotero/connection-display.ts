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
  generalTitle: string
  displayLanguageLabel: string
  themeLabel: string
  followZotero: string
  lightTheme: string
  darkTheme: string
  languageRestartNote: string
  languageSaved: string
  preferenceSaveFailed: string

  featureConfigTitle: string
  autoFollowChatModelLabel: string
  autoFollowChatModelNote: string
  autoFollowChatModelEnabled: string
  autoFollowChatModelDisabled: string
  featureChatLabel: string
  featureTranslationLabel: string
  featureAnalysisLabel: string
  featureFigureLabel: string
  featureModelSearch: string
  featureModelConnect: string
  featureModelLoading: string
  featureModelReady: string
  featureModelUnavailable: string
  featureModelSaved: string

  note: string
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
  byokProviderSidebarNote: string
  byokProviderConnectionTitle: string
  byokProviderConnectionNote: string
  byokProviderSelectLabel: string
  byokProviderNameLabel: string
  byokProviderNew: string
  byokProviderDelete: string
  byokProviderSave: string
  byokProtocolLabel: string
  byokBaseUrlLabel: string
  byokBaseUrlPlaceholder: string
  byokEndpointLabel: string
  byokSavedKeyLabel: string
  byokKeyLabel: string
  byokKeyPlaceholder: string
  byokShowKey: string
  byokHideKey: string
  byokModelCatalogTitle: string
  byokModelCatalogNote: string
  byokModelSelectLabel: string
  byokModelSelectPlaceholder: string
  byokModelEmpty: string
  byokModelEditorTitle: string
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
  generalTitle: "常规",
  displayLanguageLabel: "显示语言",
  themeLabel: "主题设置",
  followZotero: "跟随 Zotero",
  lightTheme: "浅色",
  darkTheme: "深色",
  languageRestartNote: "显示语言在重启 Zotero 后生效；主题设置立即生效。",
  languageSaved: "显示语言已保存，重启 Zotero 后生效。",
  preferenceSaveFailed: "无法保存显示偏好，请重试。",

  featureConfigTitle: "功能配置",
  autoFollowChatModelLabel: "自动跟随当前对话模型",
  autoFollowChatModelNote: "开启后，其他 AI 功能使用当前对话模型；关闭后可分别配置。翻译接口不受此开关影响。",
  autoFollowChatModelEnabled: "已开启自动跟随当前对话模型。",
  autoFollowChatModelDisabled: "已关闭自动跟随，可逐项配置功能模型。",
  featureChatLabel: "AI 对话",
  featureTranslationLabel: "实时翻译",
  featureAnalysisLabel: "文献解析",
  featureFigureLabel: "图片解读",
  featureModelSearch: "搜索模型或提供商",
  featureModelConnect: "连接攻玉后可加载内置模型；BYOK 模型可独立使用。",
  featureModelLoading: "正在加载攻玉模型；BYOK 模型仍可选择。",
  featureModelReady: "其他 AI 功能默认跟随对话模型；关闭自动跟随后可逐项配置。翻译接口独立使用。",
  featureModelUnavailable: "攻玉模型目录暂不可用；可继续使用当前选择或 BYOK 模型。",
  featureModelSaved: "模型选择已保存。",

  note: "为各项 AI 功能选择模型，并管理攻玉连接与 BYOK 提供商。",
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
    "输入令牌名称并选择有效期(30 / 90 / 365 天),点击「生成令牌」。",
    "立即复制生成的令牌——明文只显示一次——然后粘贴到上方的「令牌」中。",
  ],
  helpNote: "令牌只保存在这台电脑的 Zotero 中;遗失或过期时,回到攻玉设置中心重新生成即可。",
  byokSectionTitle: "BYOK 配置",
  byokSectionNote: "先配置提供商，再为它维护模型目录。聊天、翻译和论文解析会从当前 Zotero 客户端直接请求提供商，不经过攻玉服务器。",
  byokProviderTitle: "提供商",
  byokProviderSidebarNote: "切换或编辑已保存的提供商",
  byokProviderConnectionTitle: "提供商连接",
  byokProviderConnectionNote: "每个提供商独立保存地址和密钥",
  byokProviderSelectLabel: "当前提供商",
  byokProviderNameLabel: "显示名称",
  byokProviderNew: "新增",
  byokProviderDelete: "删除",
  byokProviderSave: "保存提供商",
  byokProtocolLabel: "协议",
  byokBaseUrlLabel: "API base url",
  byokBaseUrlPlaceholder: "例如 https://api.example.com/v1",
  byokEndpointLabel: "请求地址",
  byokSavedKeyLabel: "已保存密钥",
  byokKeyLabel: "API key",
  byokKeyPlaceholder: "输入或替换 API 密钥",
  byokShowKey: "显示 API 密钥",
  byokHideKey: "隐藏 API 密钥",
  byokModelCatalogTitle: "当前提供商的模型目录",
  byokModelCatalogNote: "显示名称只用于界面；模型 ID 会原样发送给当前提供商。",
  byokModelSelectLabel: "当前模型",
  byokModelSelectPlaceholder: "选择模型",
  byokModelEmpty: "尚未添加模型",
  byokModelEditorTitle: "编辑当前模型",
  byokModelNameLabel: "显示名称",
  byokModelLabel: "Model id",
  byokModelPlaceholder: "例如 mimo-v2.5",
  byokContextWindowLabel: "上下文窗口（可选）",
  byokModelNew: "添加模型",
  byokModelDelete: "删除",
  byokMaxTokensLabel: "最大输出量（词元）",
  byokWarning: "密钥和关联文献内容会直接发送到当前请求地址。测试配置会发起最多 3000 个词元的真实请求，可能产生费用。",
  byokClear: "清除 BYOK",
  byokTest: "测试配置",
  byokSave: "保存模型",
  byokSaved: "BYOK 配置已保存；保存操作未联网。",
  byokNewProviderName: "新提供商",
  byokNewModelName: "新模型",
  byokProviderAdded: "已添加提供商；请填写并保存连接信息。",
  byokProviderDeleted: "提供商及其模型已删除。",
  byokProviderSaved: "提供商已保存；保存操作未联网。",
  byokModelAdded: "已打开添加模型表单；填写模型 ID 后保存。",
  byokModelDeleted: "模型已删除。",
  byokModelSaved: "模型已保存；保存操作未联网。",
  byokCleared: "BYOK 配置已清除，攻玉连接与各功能的模型选择未改变。",
  byokTesting: "正在发送最多 3000 个词元的测试请求…",
  byokTestSucceeded: "测试成功。表单未保存，也未写入聊天历史。",
  unexpectedError: "操作失败,请重试。",
}

const EN_STRINGS: PreferencesStrings = {
  generalTitle: "General",
  displayLanguageLabel: "Display language",
  themeLabel: "Theme",
  followZotero: "Follow Zotero",
  lightTheme: "Light",
  darkTheme: "Dark",
  languageRestartNote: "Display language takes effect after restarting Zotero. Theme changes apply immediately.",
  languageSaved: "Display language saved. Restart Zotero to apply it.",
  preferenceSaveFailed: "Could not save the display preference. Please try again.",

  featureConfigTitle: "Feature settings",
  autoFollowChatModelLabel: "Automatically follow the current Chat model",
  autoFollowChatModelNote: "When enabled, other AI features use the current Chat model. Turn it off to configure them separately. Translation services are independent.",
  autoFollowChatModelEnabled: "Automatic Chat model following is enabled.",
  autoFollowChatModelDisabled: "Automatic following is disabled; feature models can be configured independently.",
  featureChatLabel: "AI Chat",
  featureTranslationLabel: "Translation",
  featureAnalysisLabel: "Literature analysis",
  featureFigureLabel: "Image interpretation",
  featureModelSearch: "Search models or providers",
  featureModelConnect: "Connect Jadense to load built-in models. BYOK works independently.",
  featureModelLoading: "Loading Jadense models. BYOK models remain selectable.",
  featureModelReady: "Other AI features follow the Chat model by default. Turn that off to configure them separately. Translation services are independent.",
  featureModelUnavailable: "The Jadense catalog is unavailable. Your saved selection and BYOK remain usable.",
  featureModelSaved: "Model selection saved.",

  note: "Choose a model for each AI feature and manage the Jadense connection and BYOK providers.",
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
  byokProviderSidebarNote: "Switch or edit a saved provider",
  byokProviderConnectionTitle: "Provider connection",
  byokProviderConnectionNote: "Each provider keeps its own endpoint and key",
  byokProviderSelectLabel: "Current provider",
  byokProviderNameLabel: "Display name",
  byokProviderNew: "Add",
  byokProviderDelete: "Delete",
  byokProviderSave: "Save provider",
  byokProtocolLabel: "Protocol",
  byokBaseUrlLabel: "API base url",
  byokBaseUrlPlaceholder: "For example, https://api.example.com/v1",
  byokEndpointLabel: "Request endpoint",
  byokSavedKeyLabel: "Saved key",
  byokKeyLabel: "API key",
  byokKeyPlaceholder: "Enter or replace the API key",
  byokShowKey: "Show API key",
  byokHideKey: "Hide API key",
  byokModelCatalogTitle: "Models for this provider",
  byokModelCatalogNote: "The display name is local. Model ID is sent to this provider unchanged.",
  byokModelSelectLabel: "Current model",
  byokModelSelectPlaceholder: "Select a model",
  byokModelEmpty: "No models added",
  byokModelEditorTitle: "Edit selected model",
  byokModelNameLabel: "Display name",
  byokModelLabel: "Model id",
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
  byokModelAdded: "The add-model form is open. Enter a Model ID and save.",
  byokModelDeleted: "Model deleted.",
  byokModelSaved: "Model saved. No network request was made.",
  byokCleared: "BYOK configuration cleared. The Jadense connection and feature selections were not changed.",
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
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((element) => {
    const key = element.dataset.i18nPlaceholder as keyof PreferencesStrings
    const value = strings[key]
    if (typeof value === "string") element.setAttribute("placeholder", value)
  })
}
