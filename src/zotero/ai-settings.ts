/**
 * Zotero 本地功能模型选择与 BYOK 提供商、模型目录。
 * 旧通道仅用于升级迁移；功能偏好与目录编辑独立，兼容未知附加字段。
 */
import {
  DEFAULT_BYOK_MAX_OUTPUT_TOKENS,
  DEFAULT_BYOK_PROTOCOL,
  byokConfigurationIssue,
  defaultByokBaseUrl,
  defaultByokConfig,
  isByokProtocol,
  type ByokConfig,
  type ByokProtocol,
} from "@/chat/byok-chat"
import type { JadenseChatSelection } from "@/jadense/api"
import { readConnection, type ZoteroLike } from "./runtime"

const PREF_AI_ROUTE = "extensions.jadenseInZotero.aiRoute"
const PREF_BYOK_CONFIG = "extensions.jadenseInZotero.byokConfig"
export const JADENSE_CHAT_MODEL_PREF_KEY = "extensions.jadenseInZotero.jadenseChatModel"
export const PAPER_ANALYSIS_MODEL_PREF_KEY = "extensions.jadenseInZotero.paperAnalysisModel"

export type AiRoute = "jadense" | "byok"

export type FeatureModelSelection =
  | { route: "jadense"; selection?: JadenseChatSelection }
  | { route: "byok"; modelId: string }

export type PaperAnalysisModelSelection = FeatureModelSelection

export const AI_FEATURES = ["chat", "translation", "analysis", "figure"] as const
export type AiFeature = typeof AI_FEATURES[number]
export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  chat: "AI 对话", translation: "实时翻译", analysis: "文献解析", figure: "图片解读",
}
export const FEATURE_MODEL_PREF_KEYS: Record<AiFeature, string> = {
  chat: "extensions.jadenseInZotero.chatModel",
  translation: "extensions.jadenseInZotero.translationModel",
  analysis: PAPER_ANALYSIS_MODEL_PREF_KEY,
  figure: "extensions.jadenseInZotero.figureModel",
}

export type ByokProvider = {
  id: string
  name: string
  protocol: ByokProtocol
  baseUrl: string
  apiKey: string
}

export type ByokModel = {
  id: string
  providerId: string
  name: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
}

export type ByokSettings = {
  version: 2
  activeProviderId: string
  activeModelId: string
  providers: ByokProvider[]
  models: ByokModel[]
}

function prefString(zotero: ZoteroLike, key: string) {
  try {
    const value = zotero.Prefs?.get(key)
    return typeof value === "string" ? value : ""
  } catch {
    return ""
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function trimBaseUrl(value: string) {
  return value.trim().replace(/\/+$/g, "")
}

function defaultProvider(): ByokProvider {
  return {
    id: "default-provider",
    name: "OpenAI",
    protocol: DEFAULT_BYOK_PROTOCOL,
    baseUrl: defaultByokBaseUrl(DEFAULT_BYOK_PROTOCOL),
    apiKey: "",
  }
}

export function defaultByokSettings(): ByokSettings {
  return { version: 2, activeProviderId: "default-provider", activeModelId: "", providers: [defaultProvider()], models: [] }
}

function normalizeProvider(value: unknown): ByokProvider | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const id = text(row.id)
  if (!id) return null
  const protocol = isByokProtocol(row.protocol) ? row.protocol : DEFAULT_BYOK_PROTOCOL
  return {
    id,
    name: text(row.name) || "自定义提供商",
    protocol,
    baseUrl: trimBaseUrl(text(row.baseUrl)) || defaultByokBaseUrl(protocol),
    apiKey: text(row.apiKey),
  }
}

function normalizeModel(value: unknown, providerIds: Set<string>): ByokModel | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const id = text(row.id)
  const providerId = text(row.providerId)
  if (!id || !providerIds.has(providerId)) return null
  const model = text(row.model)
  const contextWindow = positiveInteger(row.contextWindow)
  const maxOutputTokens = positiveInteger(row.maxOutputTokens)
  return {
    id,
    providerId,
    name: text(row.name) || model || "未命名模型",
    model,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }
}

function normalizeV2(row: Record<string, unknown>): ByokSettings {
  const providers = (Array.isArray(row.providers) ? row.providers : [])
    .map(normalizeProvider)
    .filter((provider): provider is ByokProvider => Boolean(provider))
  if (providers.length === 0) providers.push(defaultProvider())
  const providerIds = new Set(providers.map((provider) => provider.id))
  const models = (Array.isArray(row.models) ? row.models : [])
    .map((model) => normalizeModel(model, providerIds))
    .filter((model): model is ByokModel => Boolean(model))
  const requestedProviderId = text(row.activeProviderId)
  const requestedModelId = text(row.activeModelId)
  const selectedModel = models.find((model) => model.id === requestedModelId)
  const activeProviderId = selectedModel?.providerId
    ?? (providerIds.has(requestedProviderId) ? requestedProviderId : providers[0].id)
  const activeModelId = selectedModel?.id
    ?? models.find((model) => model.providerId === activeProviderId)?.id
    ?? ""
  return { version: 2, activeProviderId, activeModelId, providers, models }
}

function migrateLegacy(row: Record<string, unknown>): ByokSettings {
  const fallback = defaultByokConfig()
  const protocol = isByokProtocol(row.protocol) ? row.protocol : fallback.protocol
  const configuredBaseUrl = trimBaseUrl(text(row.baseUrl))
  const provider: ByokProvider = {
    id: "default-provider",
    name: configuredBaseUrl && configuredBaseUrl !== defaultByokBaseUrl(protocol)
      ? "自定义提供商"
      : protocol === "anthropic-messages" ? "Anthropic" : "OpenAI",
    protocol,
    baseUrl: configuredBaseUrl || defaultByokBaseUrl(protocol),
    apiKey: text(row.apiKey),
  }
  const modelId = text(row.model)
  const model: ByokModel | null = modelId ? {
    id: "default-model",
    providerId: provider.id,
    name: modelId,
    model: modelId,
    maxOutputTokens: positiveInteger(row.maxOutputTokens) ?? DEFAULT_BYOK_MAX_OUTPUT_TOKENS,
  } : null
  return {
    version: 2,
    activeProviderId: provider.id,
    activeModelId: model?.id ?? "",
    providers: [provider],
    models: model ? [model] : [],
  }
}

export function readAiRoute(zotero: ZoteroLike): AiRoute {
  return prefString(zotero, PREF_AI_ROUTE) === "byok" ? "byok" : "jadense"
}

export function saveAiRoute(zotero: ZoteroLike, route: AiRoute) {
  zotero.Prefs?.set(PREF_AI_ROUTE, route)
}

const DEFAULT_JADENSE_MODEL = { kind: "model", modelId: "deepseek-v4-flash-vision-exp" } as const

/** 缺省与旧版账号默认选择统一到具体模型；是否已连接仍由功能运行状态判断。 */
export function normalizeJadenseChatSelection(value: unknown): Exclude<JadenseChatSelection, { kind: "default" }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_JADENSE_MODEL
  const row = value as Record<string, unknown>
  const routeTier = text(row.routeTier)
  const modelId = text(row.modelId)
  if (row.kind === "route" && routeTier) return { kind: "route", routeTier }
  if (row.kind === "model" && modelId) return { kind: "model", modelId }
  return DEFAULT_JADENSE_MODEL
}

/** 读取旧偏好用于功能迁移，保留具体选择并替换已移除的账号默认选项。 */
export function readJadenseChatSelection(zotero: ZoteroLike): JadenseChatSelection {
  try {
    const raw = prefString(zotero, JADENSE_CHAT_MODEL_PREF_KEY)
    return raw ? normalizeJadenseChatSelection(JSON.parse(raw)) : DEFAULT_JADENSE_MODEL
  } catch {
    return DEFAULT_JADENSE_MODEL
  }
}

export function saveJadenseChatSelection(zotero: ZoteroLike, selection: JadenseChatSelection) {
  const normalized = normalizeJadenseChatSelection(selection)
  zotero.Prefs?.set(JADENSE_CHAT_MODEL_PREF_KEY, JSON.stringify(normalized))
  return normalized
}

export function jadenseChatSelectionKey(selection: JadenseChatSelection) {
  const normalized = normalizeJadenseChatSelection(selection)
  return normalized.kind === "route" ? `route:${normalized.routeTier}` : `model:${normalized.modelId}`
}

export function jadenseChatSelectionFromKey(value: string): JadenseChatSelection {
  const [kind, ...parts] = value.split(":")
  const id = parts.join(":").trim()
  if (kind === "route" && id) return { kind, routeTier: id }
  if (kind === "model" && id) return { kind, modelId: id }
  return DEFAULT_JADENSE_MODEL
}

function normalizeFeatureModelSelection(value: unknown): FeatureModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.route === "jadense") {
    const selection = normalizeJadenseChatSelection(row.selection)
    return { route: "jadense", selection }
  }
  // 保留升级时尚未配置模型的 BYOK 目的地，不自动改发攻玉。
  return row.route === "byok" ? { route: "byok", modelId: text(row.modelId) } : null
}

function storedFeatureModelSelection(zotero: ZoteroLike, feature: AiFeature) {
  try { return normalizeFeatureModelSelection(JSON.parse(prefString(zotero, FEATURE_MODEL_PREF_KEYS[feature]))) }
  catch { return null }
}

/** 在首次读取或目录编辑前固定旧配置；迁移保存失败不影响原有请求能力。 */
export function initializeFeatureModelSelections(zotero: ZoteroLike) {
  const inherited: FeatureModelSelection = readAiRoute(zotero) === "byok"
    ? { route: "byok", modelId: readByokSettings(zotero).activeModelId }
    : { route: "jadense" }
  const selections = {} as Record<AiFeature, FeatureModelSelection>
  for (const feature of AI_FEATURES) {
    const stored = storedFeatureModelSelection(zotero, feature)
    const legacyChat = (feature === "chat" || feature === "figure") && inherited.route === "jadense"
      ? { ...inherited, selection: readJadenseChatSelection(zotero) } : inherited
    selections[feature] = stored ?? normalizeFeatureModelSelection(legacyChat)!
    if (!stored) {
      try { zotero.Prefs?.set(FEATURE_MODEL_PREF_KEYS[feature], JSON.stringify(selections[feature])) }
      catch { /* 旧偏好仍可在本次请求中使用。 */ }
    }
  }
  return selections
}

export function readFeatureModelSelection(zotero: ZoteroLike, feature: AiFeature): FeatureModelSelection {
  return storedFeatureModelSelection(zotero, feature) ?? initializeFeatureModelSelections(zotero)[feature]
}

/** 选择只写所属功能；不改变 BYOK 编辑器当前项或其他功能。 */
export function saveFeatureModelSelection(zotero: ZoteroLike, feature: AiFeature, selection: FeatureModelSelection) {
  const normalized = normalizeFeatureModelSelection(selection)
  // 目的地完整性：不能把不完整的显式选择默认成另一个提供商。
  if (!normalized || (normalized.route === "byok" && !normalized.modelId)) throw new Error("BYOK 模型不能为空。")
  initializeFeatureModelSelections(zotero)
  zotero.Prefs?.set(FEATURE_MODEL_PREF_KEYS[feature], JSON.stringify(normalized))
  return normalized
}

export function readPaperAnalysisModelSelection(zotero: ZoteroLike) {
  return readFeatureModelSelection(zotero, "analysis")
}

export function savePaperAnalysisModelSelection(zotero: ZoteroLike, selection: PaperAnalysisModelSelection) {
  return saveFeatureModelSelection(zotero, "analysis", selection)
}

export function featureModelSelectionKey(selection: FeatureModelSelection) {
  return selection.route === "byok" ? `byok:${selection.modelId}` : jadenseChatSelectionKey(selection.selection ?? { kind: "default" })
}

export function featureModelSelectionFromKey(value: string): FeatureModelSelection {
  return value.startsWith("byok:") ? { route: "byok", modelId: value.slice(5) }
    : { route: "jadense", selection: jadenseChatSelectionFromKey(value) }
}

/** 所选模型失效只影响所属功能，不跨提供商回退；目录加载不参与运行时准入。 */
export function featureModelState(zotero: ZoteroLike, feature: AiFeature, invalidToken: string | null = null) {
  const selection = readFeatureModelSelection(zotero, feature)
  if (selection.route === "jadense") {
    const token = readConnection(zotero).token
    const invalid = Boolean(token && token === invalidToken)
    return { selection, route: selection.route, ready: Boolean(token) && !invalid, label: "攻玉", issue: token
      ? invalid ? "攻玉令牌无效或已过期，请在「连接攻玉」中更新令牌。" : ""
      : "请先在「连接攻玉」中配置攻玉令牌。" }
  }
  const config = readByokConfigForModel(zotero, selection.modelId)
  return { selection, route: selection.route, ready: Boolean(config), label: config ? `BYOK · ${config.model}` : "BYOK · 已失效模型",
    issue: config ? "" : `已选择的 BYOK 模型已删除或配置不完整；请在「设置 → 功能配置」中重新选择${AI_FEATURE_LABELS[feature]}模型，或前往 BYOK 修复。`,
    ...(config ? { config } : {}) }
}

export function readByokSettings(zotero: ZoteroLike): ByokSettings {
  let parsed: unknown
  try {
    const raw = prefString(zotero, PREF_BYOK_CONFIG)
    if (!raw) return defaultByokSettings()
    parsed = JSON.parse(raw)
  } catch {
    return defaultByokSettings()
  }
  if (!parsed || typeof parsed !== "object") return defaultByokSettings()
  const row = parsed as Record<string, unknown>
  return row.version === 2 ? normalizeV2(row) : migrateLegacy(row)
}

function persist(zotero: ZoteroLike, settings: ByokSettings) {
  initializeFeatureModelSelections(zotero)
  const canonical = normalizeV2(settings as unknown as Record<string, unknown>)
  zotero.Prefs?.set(PREF_BYOK_CONFIG, JSON.stringify(canonical))
  return canonical
}

function byokConfig(provider: ByokProvider, model?: ByokModel): ByokConfig {
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: model?.model ?? "",
    maxOutputTokens: model?.maxOutputTokens ?? DEFAULT_BYOK_MAX_OUTPUT_TOKENS,
  }
}

/** 按稳定 modelId 解析完整 Provider + Model 配置；缺失时不回退到全局 active model。 */
export function readByokConfigForModel(zotero: ZoteroLike, modelId: string): ByokConfig | null {
  const settings = readByokSettings(zotero)
  const model = settings.models.find((item) => item.id === modelId.trim())
  if (!model) return null
  const provider = settings.providers.find((item) => item.id === model.providerId)
  const config = provider ? byokConfig(provider, model) : null
  return config && !byokConfigurationIssue(config) ? config : null
}

export function readByokConfig(zotero: ZoteroLike): ByokConfig {
  const settings = readByokSettings(zotero)
  const provider = settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  const model = settings.models.find((item) => item.id === settings.activeModelId && item.providerId === provider.id)
  return byokConfig(provider, model)
}

export function saveByokProvider(zotero: ZoteroLike, input: ByokProvider) {
  const settings = readByokSettings(zotero)
  const pristineDefault = settings.providers.length === 1
    && settings.providers[0].id === "default-provider"
    && !settings.providers[0].apiKey
    && settings.models.length === 0
  if (pristineDefault && input.id !== "default-provider") settings.providers = []
  const existing = settings.providers.find((provider) => provider.id === input.id)
  const provider = normalizeProvider({ ...input, apiKey: input.apiKey.trim() || existing?.apiKey || "" })
  if (!provider) throw new Error("提供商 ID 不能为空。")
  const index = settings.providers.findIndex((item) => item.id === provider.id)
  if (index >= 0) settings.providers[index] = provider
  else settings.providers.push(provider)
  settings.activeProviderId = provider.id
  const activeModel = settings.models.find((model) => model.id === settings.activeModelId)
  if (activeModel?.providerId !== provider.id) {
    settings.activeModelId = settings.models.find((model) => model.providerId === provider.id)?.id ?? ""
  }
  persist(zotero, settings)
  return provider
}

export function saveByokModel(zotero: ZoteroLike, input: ByokModel) {
  const settings = readByokSettings(zotero)
  const model = normalizeModel(input, new Set(settings.providers.map((provider) => provider.id)))
  if (!model) throw new Error("模型必须关联已保存的提供商。")
  const index = settings.models.findIndex((item) => item.id === model.id)
  if (index >= 0) settings.models[index] = model
  else settings.models.push(model)
  settings.activeProviderId = model.providerId
  settings.activeModelId = model.id
  persist(zotero, settings)
  return model
}

export function selectByokProvider(zotero: ZoteroLike, providerId: string) {
  const settings = readByokSettings(zotero)
  if (!settings.providers.some((provider) => provider.id === providerId)) return settings
  settings.activeProviderId = providerId
  settings.activeModelId = settings.models.find((model) => model.providerId === providerId)?.id ?? ""
  return persist(zotero, settings)
}

export function selectByokModel(zotero: ZoteroLike, modelId: string) {
  const settings = readByokSettings(zotero)
  const model = settings.models.find((item) => item.id === modelId)
  if (!model) return settings
  settings.activeProviderId = model.providerId
  settings.activeModelId = model.id
  return persist(zotero, settings)
}

export function deleteByokProvider(zotero: ZoteroLike, providerId: string) {
  const settings = readByokSettings(zotero)
  settings.providers = settings.providers.filter((provider) => provider.id !== providerId)
  settings.models = settings.models.filter((model) => model.providerId !== providerId)
  if (settings.providers.length === 0) settings.providers.push(defaultProvider())
  if (!settings.providers.some((provider) => provider.id === settings.activeProviderId)) {
    settings.activeProviderId = settings.providers[0].id
  }
  settings.activeModelId = settings.models.find((model) => model.providerId === settings.activeProviderId)?.id ?? ""
  return persist(zotero, settings)
}

export function deleteByokModel(zotero: ZoteroLike, modelId: string) {
  const settings = readByokSettings(zotero)
  settings.models = settings.models.filter((model) => model.id !== modelId)
  if (settings.activeModelId === modelId) {
    settings.activeModelId = settings.models.find((model) => model.providerId === settings.activeProviderId)?.id ?? ""
  }
  return persist(zotero, settings)
}

/** 兼容旧调用：把扁平表单保存到当前 Provider / Model。 */
export function saveByokConfig(zotero: ZoteroLike, input: ByokConfig) {
  const settings = readByokSettings(zotero)
  const provider = settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  saveByokProvider(zotero, {
    ...provider,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  })
  const refreshed = readByokSettings(zotero)
  const existingModel = refreshed.models.find((item) => item.id === refreshed.activeModelId)
  saveByokModel(zotero, {
    id: existingModel?.id ?? "default-model",
    providerId: provider.id,
    name: existingModel?.name || input.model.trim() || "未命名模型",
    model: input.model,
    ...(existingModel?.contextWindow ? { contextWindow: existingModel.contextWindow } : {}),
    maxOutputTokens: positiveInteger(input.maxOutputTokens) ?? DEFAULT_BYOK_MAX_OUTPUT_TOKENS,
  })
  return readByokConfig(zotero)
}

export function clearByokConfig(zotero: ZoteroLike) {
  initializeFeatureModelSelections(zotero)
  zotero.Prefs?.clear(PREF_BYOK_CONFIG)
}
