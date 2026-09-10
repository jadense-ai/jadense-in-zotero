/** 原生设置后备入口：共享功能模型偏好，并独立管理攻玉连接与 BYOK 目录。 */
import { getUiLocale, initializeUiLocale, observeDisplayLanguage, observeTheme, readDisplayLanguage, readTheme, saveDisplayLanguage, saveTheme, uiText, wireReadingPreferences } from "./ui-preferences"
import {
  clearConnection,
  favoriteFolderOptionLabel,
  readCollectionUploadIncludePdfDefault,
  readConnection,
  readFavoriteFoldersCache,
  refreshFavoriteFoldersCache,
  saveCollectionUploadIncludePdfDefault,
  saveConnection,
  saveDefaultFolderId,
  type FavoriteFolderOption,
  type FavoriteFoldersRefreshResult,
  type ZoteroLike,
} from "./runtime"
import {
  ByokChatClient,
  BYOK_TEST_MAX_OUTPUT_TOKENS,
  byokEndpoint,
  defaultByokBaseUrl,
  type ByokConfig,
  type ByokProtocol,
} from "@/chat/byok-chat"
import {
  AI_FEATURES,
  featureModelSelectionKey,
  featureModelSelectionFromKey,
  readFeatureModelSelection,
  saveFeatureModelSelection,
  type AiFeature,
  clearByokConfig,
  deleteByokModel,
  deleteByokProvider,
  readByokSettings,
  saveByokModel,
  saveByokProvider,
  selectByokModel,
  selectByokProvider,
  type ByokModel,
  type ByokProvider,
} from "./ai-settings"
import { JadenseApiClient, type JadenseChatModelCatalog } from "@/jadense/api"
import { buildFeatureModelSelectOptions } from "./ai-model-select"
import { createJdxSelect, type JdxSelect } from "./custom-select"
import {
  applyStrings,
  copyTextToClipboard,
  formatRelativeTime,
  maskToken,
  selectPreferencesStrings,
  type PreferencesStrings,
} from "./connection-display"

declare const Zotero: ZoteroLike

const IDS = {
  connectionStatus: "jadense-in-zotero-connection-status",
  connectionStatusText: "jadense-in-zotero-connection-status-text",
  connectionUpdated: "jadense-in-zotero-connection-updated",
  tokenDisplay: "jadense-in-zotero-token-display",
  tokenMask: "jadense-in-zotero-token-mask",
  tokenCopy: "jadense-in-zotero-token-copy",
  tokenEdit: "jadense-in-zotero-token-edit",
  tokenEditRow: "jadense-in-zotero-token-edit-row",
  tokenInput: "jadense-in-zotero-token-input",
  tokenSave: "jadense-in-zotero-token-save",
  tokenCancel: "jadense-in-zotero-token-cancel",
  folderSelect: "jadense-in-zotero-folder-select",
  folderStatus: "jadense-in-zotero-folder-status",
  folderRetry: "jadense-in-zotero-folder-retry",
  includePdf: "jadense-in-zotero-include-pdf",
  disconnect: "jadense-in-zotero-disconnect",
  status: "jadense-in-zotero-status",
  helpSteps: "jadense-in-zotero-help-steps",
  byokProviderSelect: "jadense-in-zotero-byok-provider-select",
  byokProviderName: "jadense-in-zotero-byok-provider-name",
  byokProviderNew: "jadense-in-zotero-byok-provider-new",
  byokProviderDelete: "jadense-in-zotero-byok-provider-delete",
  byokProviderSave: "jadense-in-zotero-byok-provider-save",
  byokProtocol: "jadense-in-zotero-byok-protocol",
  byokBaseUrl: "jadense-in-zotero-byok-base-url",
  byokEndpoint: "jadense-in-zotero-byok-endpoint",
  byokKeyMask: "jadense-in-zotero-byok-key-mask",
  byokKeyInput: "jadense-in-zotero-byok-key-input",
  byokModelSelect: "jadense-in-zotero-byok-model-select",
  byokModelName: "jadense-in-zotero-byok-model-name",
  byokModel: "jadense-in-zotero-byok-model",
  byokContextWindow: "jadense-in-zotero-byok-context-window",
  byokMaxOutputTokens: "jadense-in-zotero-byok-max-output-tokens",
  byokModelNew: "jadense-in-zotero-byok-model-new",
  byokModelDelete: "jadense-in-zotero-byok-model-delete",
  byokStatus: "jadense-in-zotero-byok-status",
  byokClear: "jadense-in-zotero-byok-clear",
  byokTest: "jadense-in-zotero-byok-test",
  byokSave: "jadense-in-zotero-byok-save",
} as const

type ConnectionState = "unconfigured" | "checking" | "connected" | "failed"

type PreferenceElements = {
  featureModels: Record<AiFeature, JdxSelect>
  featureModelStatus: HTMLElement
  connectionStatus: HTMLElement
  connectionStatusText: HTMLElement
  connectionUpdated: HTMLElement
  tokenDisplay: HTMLElement
  tokenMask: HTMLElement
  tokenCopy: HTMLButtonElement
  tokenEdit: HTMLButtonElement
  tokenEditRow: HTMLElement
  tokenInput: HTMLInputElement
  tokenSave: HTMLButtonElement
  tokenCancel: HTMLButtonElement
  folderSelect: JdxSelect
  folderStatus: HTMLElement
  folderRetry: HTMLButtonElement
  includePdf: HTMLInputElement
  disconnect: HTMLButtonElement
  status: HTMLElement
  helpSteps: HTMLElement
  byokProviderSelect: JdxSelect
  byokProviderName: HTMLInputElement
  byokProviderNew: HTMLButtonElement
  byokProviderDelete: HTMLButtonElement
  byokProviderSave: HTMLButtonElement
  byokProtocol: JdxSelect
  byokBaseUrl: HTMLInputElement
  byokEndpoint: HTMLElement
  byokKeyMask: HTMLElement
  byokKeyInput: HTMLInputElement
  byokModelSelect: JdxSelect
  byokModelName: HTMLInputElement
  byokModel: HTMLInputElement
  byokContextWindow: HTMLInputElement
  byokMaxOutputTokens: HTMLInputElement
  byokModelNew: HTMLButtonElement
  byokModelDelete: HTMLButtonElement
  byokStatus: HTMLElement
  byokClear: HTMLButtonElement
  byokTest: HTMLButtonElement
  byokSave: HTMLButtonElement
}

function element<T extends HTMLElement>(id: string) {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing Jadense preferences element: ${id}`)
  return found as T
}

function readElements(): PreferenceElements {
  const strings = selectPreferencesStrings(getUiLocale())
  const labels = { chat: strings.featureChatLabel, translation: strings.featureTranslationLabel, analysis: strings.featureAnalysisLabel, figure: strings.featureFigureLabel }
  return {
    featureModels: Object.fromEntries(AI_FEATURES.map(feature => [feature, createJdxSelect(element(`jadense-in-zotero-feature-${feature}-model`), { searchPlaceholder: strings.featureModelSearch, ariaLabel: labels[feature] })])) as Record<AiFeature, JdxSelect>,
    featureModelStatus: element("jadense-in-zotero-feature-model-status"),
    connectionStatus: element(IDS.connectionStatus),
    connectionStatusText: element(IDS.connectionStatusText),
    connectionUpdated: element(IDS.connectionUpdated),
    tokenDisplay: element(IDS.tokenDisplay),
    tokenMask: element(IDS.tokenMask),
    tokenCopy: element<HTMLButtonElement>(IDS.tokenCopy),
    tokenEdit: element<HTMLButtonElement>(IDS.tokenEdit),
    tokenEditRow: element(IDS.tokenEditRow),
    tokenInput: element<HTMLInputElement>(IDS.tokenInput),
    tokenSave: element<HTMLButtonElement>(IDS.tokenSave),
    tokenCancel: element<HTMLButtonElement>(IDS.tokenCancel),
    folderSelect: createJdxSelect(element(IDS.folderSelect)),
    folderStatus: element(IDS.folderStatus),
    folderRetry: element<HTMLButtonElement>(IDS.folderRetry),
    includePdf: element<HTMLInputElement>(IDS.includePdf),
    disconnect: element<HTMLButtonElement>(IDS.disconnect),
    status: element(IDS.status),
    helpSteps: element(IDS.helpSteps),
    byokProviderSelect: createJdxSelect(element(IDS.byokProviderSelect)),
    byokProviderName: element<HTMLInputElement>(IDS.byokProviderName),
    byokProviderNew: element<HTMLButtonElement>(IDS.byokProviderNew),
    byokProviderDelete: element<HTMLButtonElement>(IDS.byokProviderDelete),
    byokProviderSave: element<HTMLButtonElement>(IDS.byokProviderSave),
    byokProtocol: createJdxSelect(element(IDS.byokProtocol)),
    byokBaseUrl: element<HTMLInputElement>(IDS.byokBaseUrl),
    byokEndpoint: element(IDS.byokEndpoint),
    byokKeyMask: element(IDS.byokKeyMask),
    byokKeyInput: element<HTMLInputElement>(IDS.byokKeyInput),
    byokModelSelect: createJdxSelect(element(IDS.byokModelSelect)),
    byokModelName: element<HTMLInputElement>(IDS.byokModelName),
    byokModel: element<HTMLInputElement>(IDS.byokModel),
    byokContextWindow: element<HTMLInputElement>(IDS.byokContextWindow),
    byokMaxOutputTokens: element<HTMLInputElement>(IDS.byokMaxOutputTokens),
    byokModelNew: element<HTMLButtonElement>(IDS.byokModelNew),
    byokModelDelete: element<HTMLButtonElement>(IDS.byokModelDelete),
    byokStatus: element(IDS.byokStatus),
    byokClear: element<HTMLButtonElement>(IDS.byokClear),
    byokTest: element<HTMLButtonElement>(IDS.byokTest),
    byokSave: element<HTMLButtonElement>(IDS.byokSave),
  }
}

function setStatus(target: HTMLElement, message: string, kind: "idle" | "error" | "success" = "idle") {
  target.textContent = message
  target.dataset.kind = kind
}

function createByokId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.()
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}

function renderConnectionStatus(
  elements: PreferenceElements,
  strings: PreferencesStrings,
  state: ConnectionState,
  fetchedAt = "",
) {
  elements.connectionStatus.dataset.state = state
  elements.connectionStatusText.textContent = state === "connected"
    ? strings.statusConnected
    : state === "checking"
      ? strings.statusChecking
      : state === "failed"
        ? strings.statusFailed
        : strings.statusNotConfigured
  const relative = fetchedAt ? formatRelativeTime(fetchedAt, getUiLocale()) : ""
  elements.connectionUpdated.textContent = relative ? strings.updatedAgo(relative) : ""
}

function renderTokenDisplay(elements: PreferenceElements, strings: PreferencesStrings) {
  const token = readConnection(Zotero).token
  elements.tokenMask.textContent = token ? maskToken(token) : strings.tokenNotConfigured
  elements.tokenMask.dataset.empty = String(!token)
  elements.tokenCopy.disabled = !token
}

function renderFolderOptions(
  elements: PreferenceElements,
  strings: PreferencesStrings,
  folders: FavoriteFolderOption[],
  selectedFolderId: string,
) {
  elements.folderSelect.setOptions([
    { value: "", label: strings.folderSelectPlaceholder },
    ...folders.map((folder) => ({ value: folder.id, label: favoriteFolderOptionLabel(folder) })),
  ], selectedFolderId)
  elements.folderSelect.setDisabled(folders.length === 0)
}

function renderHelpSteps(elements: PreferenceElements, strings: PreferencesStrings) {
  elements.helpSteps.replaceChildren(...strings.helpSteps.map((step) => {
    const item = document.createElementNS("http://www.w3.org/1999/xhtml", "li")
    item.textContent = step
    return item
  }))
}

function enterTokenEdit(elements: PreferenceElements, strings: PreferencesStrings) {
  elements.tokenDisplay.hidden = true
  elements.tokenEditRow.hidden = false
  elements.tokenInput.value = ""
  elements.tokenInput.placeholder = strings.tokenInputPlaceholder
  elements.tokenInput.focus()
}

function exitTokenEdit(elements: PreferenceElements) {
  elements.tokenEditRow.hidden = true
  elements.tokenDisplay.hidden = false
  elements.tokenInput.value = ""
}

async function saveTokenFromEdit(elements: PreferenceElements, strings: PreferencesStrings) {
  const token = elements.tokenInput.value.trim()
  if (!token) {
    // 留空 = 不修改已有令牌,直接回到显示态。
    exitTokenEdit(elements)
    return
  }
  elements.tokenSave.disabled = true
  try {
    saveConnection(Zotero, { token })
    void refreshFeatureModelCatalog(elements)
    exitTokenEdit(elements)
    renderTokenDisplay(elements, strings)
    setStatus(elements.status, strings.tokenSaved, "success")
    // 保存后立即用新令牌拉取收藏夹,顺带完成连接验证。
    await refreshFolders(elements, strings)
  } catch (error) {
    setStatus(elements.status, error instanceof Error ? error.message : strings.unexpectedError, "error")
  } finally {
    elements.tokenSave.disabled = false
  }
}

function applyRefreshResult(
  elements: PreferenceElements,
  strings: PreferencesStrings,
  result: FavoriteFoldersRefreshResult,
) {
  if (result.reason === "no-token") {
    renderConnectionStatus(elements, strings, "unconfigured")
    renderFolderOptions(elements, strings, [], "")
    setStatus(elements.folderStatus, strings.folderEmpty)
    elements.folderRetry.hidden = true
    return
  }

  renderFolderOptions(elements, strings, result.folders, result.selectedFolderId)
  if (result.ok) {
    renderConnectionStatus(elements, strings, "connected", result.fetchedAt)
    setStatus(elements.folderStatus, result.folders.length === 0 ? strings.folderEmpty : "")
    elements.folderRetry.hidden = true
  } else {
    renderConnectionStatus(elements, strings, "failed", result.fetchedAt)
    setStatus(elements.folderStatus, result.message, "error")
    elements.folderRetry.hidden = false
  }
}

async function refreshFolders(elements: PreferenceElements, strings: PreferencesStrings) {
  elements.folderSelect.setDisabled(true)
  elements.folderRetry.hidden = true
  setStatus(elements.folderStatus, strings.folderLoading)
  renderConnectionStatus(elements, strings, "checking")
  const result = await refreshFavoriteFoldersCache(Zotero)
  applyRefreshResult(elements, strings, result)
}

const BYOK_PROTOCOL_OPTIONS: Array<{ value: ByokProtocol; label: string }> = [
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-responses", label: "OpenAI Responses" },
]

function currentByokProtocol(elements: PreferenceElements): ByokProtocol {
  const value = elements.byokProtocol.getValue()
  return BYOK_PROTOCOL_OPTIONS.some((option) => option.value === value)
    ? value as ByokProtocol
    : "openai-chat-completions"
}

function updateByokEndpoint(elements: PreferenceElements) {
  elements.byokEndpoint.textContent = byokEndpoint(currentByokProtocol(elements), elements.byokBaseUrl.value)
}

let featureModelCatalog: JadenseChatModelCatalog = { options: [], defaultSelection: null }
let featureCatalogGeneration = 0

function renderFeatureModels(elements: PreferenceElements) {
  for (const feature of AI_FEATURES) {
    const selection = readFeatureModelSelection(Zotero, feature)
    elements.featureModels[feature].setOptions(buildFeatureModelSelectOptions(Zotero, featureModelCatalog, selection, !getUiLocale()?.toLowerCase().startsWith("zh")), featureModelSelectionKey(selection))
  }
}

/** 目录只用于展示；加载失败保留已有选择与 BYOK，旧账号响应不得污染新连接。 */
async function refreshFeatureModelCatalog(elements: PreferenceElements) {
  const strings = selectPreferencesStrings(getUiLocale())
  const connection = readConnection(Zotero)
  const generation = ++featureCatalogGeneration
  featureModelCatalog = { options: [], defaultSelection: null }
  renderFeatureModels(elements)
  if (!connection.token) {
    setStatus(elements.featureModelStatus, strings.featureModelConnect)
    return
  }
  setStatus(elements.featureModelStatus, strings.featureModelLoading)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const ownerWindow = Zotero.getMainWindow?.()
    const catalog = await new JadenseApiClient({ ...connection, fetchImpl: ownerWindow?.fetch.bind(ownerWindow) }).getChatModels(controller.signal)
    if (generation !== featureCatalogGeneration) return
    featureModelCatalog = catalog
    setStatus(elements.featureModelStatus, strings.featureModelReady)
  } catch {
    if (generation !== featureCatalogGeneration) return
    setStatus(elements.featureModelStatus, strings.featureModelUnavailable)
  } finally {
    clearTimeout(timeout)
    if (generation === featureCatalogGeneration) renderFeatureModels(elements)
  }
}

function renderByokConfig(elements: PreferenceElements, strings: PreferencesStrings) {
  renderFeatureModels(elements)
  const settings = readByokSettings(Zotero)
  const provider = settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  const models = settings.models.filter((model) => model.providerId === provider.id)
  const model = models.find((item) => item.id === settings.activeModelId)
  elements.byokProviderSelect.setOptions(settings.providers.map((item) => ({ value: item.id, label: item.name })), provider.id)
  elements.byokProviderName.value = provider.name
  elements.byokProtocol.setOptions(BYOK_PROTOCOL_OPTIONS, provider.protocol)
  elements.byokBaseUrl.value = provider.baseUrl
  elements.byokKeyInput.value = ""
  elements.byokKeyInput.placeholder = strings.byokKeyPlaceholder
  elements.byokKeyMask.textContent = provider.apiKey ? maskToken(provider.apiKey) : strings.tokenNotConfigured
  elements.byokKeyMask.dataset.empty = String(!provider.apiKey)
  elements.byokModelSelect.setOptions([
    { value: "", label: models.length ? strings.byokModelSelectPlaceholder : strings.byokModelEmpty },
    ...models.map((item) => ({ value: item.id, label: item.name })),
  ], model?.id ?? "")
  elements.byokModelName.value = model?.name ?? ""
  elements.byokModel.value = model?.model ?? ""
  elements.byokModel.placeholder = strings.byokModelPlaceholder
  elements.byokContextWindow.value = model?.contextWindow ? String(model.contextWindow) : ""
  elements.byokMaxOutputTokens.value = String(model?.maxOutputTokens ?? 96_000)
  elements.byokModelDelete.disabled = !model
  elements.byokTest.disabled = !model
  updateByokEndpoint(elements)
}

function byokProviderDraft(elements: PreferenceElements): ByokProvider {
  const settings = readByokSettings(Zotero)
  const stored = settings.providers.find((provider) => provider.id === settings.activeProviderId) ?? settings.providers[0]
  return {
    id: stored.id,
    name: elements.byokProviderName.value.trim() || uiText("自定义提供商", "Custom provider"),
    protocol: currentByokProtocol(elements),
    baseUrl: elements.byokBaseUrl.value,
    apiKey: elements.byokKeyInput.value.trim() || stored.apiKey,
  }
}

function byokModelDraft(elements: PreferenceElements): ByokModel {
  const settings = readByokSettings(Zotero)
  const stored = settings.models.find((model) => model.id === settings.activeModelId)
  const contextWindow = Number(elements.byokContextWindow.value)
  const maxOutputTokens = Number(elements.byokMaxOutputTokens.value)
  return {
    id: stored?.id ?? createByokId("byok-model"),
    providerId: settings.activeProviderId,
    name: elements.byokModelName.value.trim() || elements.byokModel.value.trim() || uiText("未命名模型", "Untitled model"),
    model: elements.byokModel.value,
    ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
  }
}

function byokDraft(elements: PreferenceElements): ByokConfig {
  const provider = byokProviderDraft(elements)
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: elements.byokModel.value,
    maxOutputTokens: Number(elements.byokMaxOutputTokens.value),
  }
}

async function testByokDraft(elements: PreferenceElements, strings: PreferencesStrings) {
  elements.byokTest.disabled = true
  setStatus(elements.byokStatus, strings.byokTesting)
  try {
    const ownerWindow = document.defaultView
    const fetchImpl = ownerWindow?.fetch.bind(ownerWindow)
    const client = new ByokChatClient({ config: { ...byokDraft(elements), maxOutputTokens: BYOK_TEST_MAX_OUTPUT_TOKENS }, fetchImpl })
    await client.send({
      clientRequestId: `byok-test-${Date.now()}`,
      conversationId: "byok-configuration-test",
      messages: [{ id: "byok-test", role: "user", text: "Reply with OK." }],
      acceptTruncated: true,
    })
    setStatus(elements.byokStatus, strings.byokTestSucceeded, "success")
  } catch (error) {
    setStatus(elements.byokStatus, error instanceof Error ? error.message : strings.unexpectedError, "error")
  } finally {
    elements.byokTest.disabled = false
  }
}

export function initJadensePreferencesPage() {
  const root = document.getElementById("jadense-in-zotero-preferences-pane")
  if (!root || root.getAttribute("data-jadense-initialized") === "true") return
  root.setAttribute("data-jadense-initialized", "true")
  initializeUiLocale(Zotero)
  root.setAttribute("lang", getUiLocale())
  const strings = selectPreferencesStrings(getUiLocale())
  applyStrings(root, strings)
  const language = createJdxSelect(element("jadense-in-zotero-display-language"), { ariaLabel: strings.displayLanguageLabel })
  const languageOptions = [{ value: "system", label: strings.followZotero }, { value: "zh-CN", label: "简体中文" }, { value: "en-US", label: "English" }]
  const stopLanguage = observeDisplayLanguage(Zotero, value => language.setOptions(languageOptions, value))
  const theme = createJdxSelect(element("jadense-in-zotero-theme"), { ariaLabel: strings.themeLabel })
  const themeOptions = [{ value: "system", label: strings.followZotero }, { value: "light", label: strings.lightTheme }, { value: "dark", label: strings.darkTheme }]
  const generalStatus = element("jadense-in-zotero-general-status")
  const stopReading = wireReadingPreferences(Zotero, root.querySelector<HTMLElement>('[data-settings-section="general"]')!)
  const stopTheme = observeTheme(Zotero, root, () => theme.setOptions(themeOptions, readTheme(Zotero)))
  // Zotero 卸载 pane 时也会移除根节点，不让跨窗口主题 observer 引用旧 UI。
  let removalObserver: MutationObserver | null = null
  const cleanup = () => {
    stopTheme()
    stopReading()
    stopLanguage()
    removalObserver?.disconnect()
    root.ownerDocument.defaultView?.removeEventListener("unload", cleanup)
  }
  try {
    removalObserver = new MutationObserver(() => { if (!root.isConnected) cleanup() })
    removalObserver.observe(root.ownerDocument, { childList: true, subtree: true })
  } catch { /* 旧宿主缺少节点观察能力时仍可使用设置，窗口卸载负责清理。 */ }
  root.ownerDocument.defaultView?.addEventListener("unload", cleanup, { once: true })
  language.onChange(value => {
    const saved = saveDisplayLanguage(Zotero, value)
    if (!saved) language.setOptions(languageOptions, readDisplayLanguage(Zotero))
    setStatus(generalStatus, saved ? strings.languageSaved : strings.preferenceSaveFailed, saved ? "success" : "error")
  })
  theme.onChange(value => {
    const saved = saveTheme(Zotero, value)
    theme.setOptions(themeOptions, readTheme(Zotero))
    setStatus(generalStatus, saved ? strings.optionSaved : strings.preferenceSaveFailed, saved ? "success" : "error")
  })

  const elements = readElements()
  renderHelpSteps(elements, strings)
  renderTokenDisplay(elements, strings)
  void refreshFeatureModelCatalog(elements)
  renderByokConfig(elements, strings)
  elements.includePdf.checked = readCollectionUploadIncludePdfDefault(Zotero)

  // 缓存先行:命中时立即渲染列表与状态,再后台刷新;未命中且已配置令牌时进入验证态。
  const connection = readConnection(Zotero)
  const cached = readFavoriteFoldersCache(Zotero)
  if (cached && cached.folders.length > 0) {
    renderFolderOptions(
      elements,
      strings,
      cached.folders,
      connection.defaultFolderId || cached.defaultFolderId || "",
    )
    renderConnectionStatus(elements, strings, connection.token ? "connected" : "unconfigured", cached.fetchedAt)
    setStatus(elements.folderStatus, "")
  } else {
    renderFolderOptions(elements, strings, [], "")
    renderConnectionStatus(elements, strings, connection.token ? "checking" : "unconfigured")
    setStatus(elements.folderStatus, connection.token ? strings.folderLoading : strings.folderEmpty)
  }

  // 打开面板即自动拉取收藏夹,不再要求用户手动触发。
  if (connection.token) {
    void refreshFolders(elements, strings)
  }

  elements.tokenEdit.addEventListener("click", () => enterTokenEdit(elements, strings))
  elements.tokenCancel.addEventListener("click", () => exitTokenEdit(elements))
  elements.tokenSave.addEventListener("click", () => void saveTokenFromEdit(elements, strings))
  elements.tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      void saveTokenFromEdit(elements, strings)
    } else if (event.key === "Escape") {
      exitTokenEdit(elements)
    }
  })
  elements.tokenCopy.addEventListener("click", () => {
    void (async () => {
      const token = readConnection(Zotero).token
      const copied = token ? await copyTextToClipboard(Zotero, token) : false
      setStatus(elements.status, copied ? strings.copied : strings.copyFailed, copied ? "success" : "error")
    })()
  })

  elements.folderSelect.onChange((value) => {
    // 选中即保存;选回占位项时不改动已有选择。
    if (!value) return
    saveDefaultFolderId(Zotero, value)
    setStatus(elements.folderStatus, strings.folderSaved, "success")
  })
  elements.folderRetry.addEventListener("click", () => void refreshFolders(elements, strings))

  elements.includePdf.addEventListener("change", () => {
    saveCollectionUploadIncludePdfDefault(Zotero, elements.includePdf.checked)
    setStatus(elements.status, strings.optionSaved, "success")
  })

  elements.disconnect.addEventListener("click", () => {
    clearConnection(Zotero)
    void refreshFeatureModelCatalog(elements)
    exitTokenEdit(elements)
    renderTokenDisplay(elements, strings)
    renderConnectionStatus(elements, strings, "unconfigured")
    renderFolderOptions(elements, strings, [], "")
    setStatus(elements.folderStatus, strings.folderEmpty)
    elements.folderRetry.hidden = true
    elements.includePdf.checked = false
    setStatus(elements.status, strings.disconnected, "success")
  })

  for (const feature of AI_FEATURES) elements.featureModels[feature].onChange(value => {
    try {
      saveFeatureModelSelection(Zotero, feature, featureModelSelectionFromKey(value))
      renderFeatureModels(elements)
      setStatus(elements.featureModelStatus, strings.featureModelSaved, "success")
    } catch (error) {
      renderFeatureModels(elements)
      setStatus(elements.featureModelStatus, error instanceof Error ? error.message : strings.unexpectedError, "error")
    }
  })
  let previousByokProtocol = currentByokProtocol(elements)
  elements.byokProviderSelect.onChange((providerId) => {
    selectByokProvider(Zotero, providerId)
    renderByokConfig(elements, strings)
    previousByokProtocol = currentByokProtocol(elements)
  })
  elements.byokModelSelect.onChange((modelId) => {
    if (!modelId) return
    selectByokModel(Zotero, modelId)
    renderByokConfig(elements, strings)
  })
  elements.byokProtocol.onChange((value) => {
    if (!BYOK_PROTOCOL_OPTIONS.some((option) => option.value === value)) return
    const next = value as ByokProtocol
    const currentUrl = elements.byokBaseUrl.value.trim().replace(/\/+$/g, "")
    if (!currentUrl || currentUrl === defaultByokBaseUrl(previousByokProtocol)) {
      elements.byokBaseUrl.value = defaultByokBaseUrl(next)
    }
    previousByokProtocol = next
    updateByokEndpoint(elements)
  })
  elements.byokBaseUrl.addEventListener("input", () => updateByokEndpoint(elements))
  elements.byokProviderNew.addEventListener("click", () => {
    saveByokProvider(Zotero, {
      id: createByokId("byok-provider"), name: strings.byokNewProviderName,
      protocol: "openai-chat-completions", baseUrl: defaultByokBaseUrl("openai-chat-completions"), apiKey: "",
    })
    renderByokConfig(elements, strings)
    previousByokProtocol = currentByokProtocol(elements)
    setStatus(elements.byokStatus, strings.byokProviderAdded, "success")
  })
  elements.byokProviderDelete.addEventListener("click", () => {
    deleteByokProvider(Zotero, readByokSettings(Zotero).activeProviderId)
    renderByokConfig(elements, strings)
    previousByokProtocol = currentByokProtocol(elements)
    setStatus(elements.byokStatus, strings.byokProviderDeleted, "success")
  })
  elements.byokProviderSave.addEventListener("click", () => {
    try {
      saveByokProvider(Zotero, byokProviderDraft(elements))
      renderByokConfig(elements, strings)
      setStatus(elements.byokStatus, strings.byokProviderSaved, "success")
    } catch (error) {
      setStatus(elements.byokStatus, error instanceof Error ? error.message : strings.unexpectedError, "error")
    }
  })
  elements.byokModelNew.addEventListener("click", () => {
    const settings = readByokSettings(Zotero)
    saveByokModel(Zotero, {
      id: createByokId("byok-model"), providerId: settings.activeProviderId,
      name: strings.byokNewModelName, model: "", maxOutputTokens: 96_000,
    })
    renderByokConfig(elements, strings)
    setStatus(elements.byokStatus, strings.byokModelAdded, "success")
  })
  elements.byokModelDelete.addEventListener("click", () => {
    const modelId = readByokSettings(Zotero).activeModelId
    if (!modelId) return
    deleteByokModel(Zotero, modelId)
    renderByokConfig(elements, strings)
    setStatus(elements.byokStatus, strings.byokModelDeleted, "success")
  })
  elements.byokSave.addEventListener("click", () => {
    try {
      saveByokModel(Zotero, byokModelDraft(elements))
      renderByokConfig(elements, strings)
      setStatus(elements.byokStatus, strings.byokModelSaved, "success")
    } catch (error) {
      setStatus(elements.byokStatus, error instanceof Error ? error.message : strings.unexpectedError, "error")
    }
  })
  elements.byokTest.addEventListener("click", () => void testByokDraft(elements, strings))
  elements.byokClear.addEventListener("click", () => {
    clearByokConfig(Zotero)
    renderByokConfig(elements, strings)
    setStatus(elements.byokStatus, strings.byokCleared, "success")
  })
}

if (typeof document !== "undefined") {
  // Zotero PreferencePanes 先执行脚本、再插入 XHTML fragment；监听根节点的 load/showing，
  // 不能依赖偏好窗口自身早已结束的 DOMContentLoaded。
  const initializeInsertedPane = (event?: Event) => {
    if (event && (event.target as Element | null)?.id !== "jadense-in-zotero-preferences-pane") return
    initJadensePreferencesPage()
  }
  if (document.getElementById("jadense-in-zotero-preferences-pane")) initializeInsertedPane()
  document.addEventListener("load", initializeInsertedPane, true)
  document.addEventListener("showing", initializeInsertedPane, true)
}
