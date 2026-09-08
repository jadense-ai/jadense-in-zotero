/**
 * Zotero profile 中的 AI 通道与 BYOK Provider / Model 配置所有权。
 * v2 把请求目标和模型目录分开保存；读取兼容 v1 扁平配置并忽略未知附加字段。
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
import type { ZoteroLike } from "./runtime"

const PREF_AI_ROUTE = "extensions.jadenseInZotero.aiRoute"
const PREF_BYOK_CONFIG = "extensions.jadenseInZotero.byokConfig"
export const JADENSE_CHAT_MODEL_PREF_KEY = "extensions.jadenseInZotero.jadenseChatModel"
export const PAPER_ANALYSIS_MODEL_PREF_KEY = "extensions.jadenseInZotero.paperAnalysisModel"

export type AiRoute = "jadense" | "byok"

export type PaperAnalysisModelSelection =
  | { route: "jadense" }
  | { route: "byok"; modelId: string }

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
    name: text(row.name) || "Custom Provider",
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
    name: text(row.name) || model || "Unnamed model",
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
      ? "Custom Provider"
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

function normalizeJadenseChatSelection(value: unknown): JadenseChatSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "default" }
  const row = value as Record<string, unknown>
  const routeTier = text(row.routeTier)
  const modelId = text(row.modelId)
  if (row.kind === "route" && routeTier) return { kind: "route", routeTier }
  if (row.kind === "model" && modelId) return { kind: "model", modelId }
  return { kind: "default" }
}

/** 缺省值不向服务端指定模型，继续沿用账号在 Webapp 中保存的选择。 */
export function readJadenseChatSelection(zotero: ZoteroLike): JadenseChatSelection {
  try {
    const raw = prefString(zotero, JADENSE_CHAT_MODEL_PREF_KEY)
    return raw ? normalizeJadenseChatSelection(JSON.parse(raw)) : { kind: "default" }
  } catch {
    return { kind: "default" }
  }
}

export function saveJadenseChatSelection(zotero: ZoteroLike, selection: JadenseChatSelection) {
  const normalized = normalizeJadenseChatSelection(selection)
  zotero.Prefs?.set(JADENSE_CHAT_MODEL_PREF_KEY, JSON.stringify(normalized))
  return normalized
}

export function jadenseChatSelectionKey(selection: JadenseChatSelection) {
  if (selection.kind === "route") return `route:${selection.routeTier}`
  if (selection.kind === "model") return `model:${selection.modelId}`
  return "default"
}

export function jadenseChatSelectionFromKey(value: string): JadenseChatSelection {
  const [kind, ...parts] = value.split(":")
  const id = parts.join(":").trim()
  if (kind === "route" && id) return { kind, routeTier: id }
  if (kind === "model" && id) return { kind, modelId: id }
  return { kind: "default" }
}

function normalizePaperAnalysisModelSelection(value: unknown): PaperAnalysisModelSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.route === "jadense") return { route: "jadense" }
  const modelId = text(row.modelId)
  return row.route === "byok" && modelId ? { route: "byok", modelId } : null
}

function inheritedPaperAnalysisModelSelection(zotero: ZoteroLike): PaperAnalysisModelSelection {
  if (readAiRoute(zotero) === "jadense") return { route: "jadense" }
  return { route: "byok", modelId: readByokSettings(zotero).activeModelId }
}

/** 未设置或损坏时继承全局通道；有效的独立选择不会因模型失效而被改写。 */
export function readPaperAnalysisModelSelection(zotero: ZoteroLike): PaperAnalysisModelSelection {
  try {
    const raw = prefString(zotero, PAPER_ANALYSIS_MODEL_PREF_KEY)
    if (!raw) return inheritedPaperAnalysisModelSelection(zotero)
    return normalizePaperAnalysisModelSelection(JSON.parse(raw)) ?? inheritedPaperAnalysisModelSelection(zotero)
  } catch {
    return inheritedPaperAnalysisModelSelection(zotero)
  }
}

/** 只写文献解析自己的选择，不联动全局 AI route 或 BYOK active model。 */
export function savePaperAnalysisModelSelection(
  zotero: ZoteroLike,
  selection: PaperAnalysisModelSelection,
): PaperAnalysisModelSelection {
  const normalized = normalizePaperAnalysisModelSelection(selection)
  // 请求路由完整性：BYOK 必须指向明确 modelId，不能把半有效目标写入配置。
  if (!normalized) throw new Error("文献解析的 BYOK 模型不能为空。")
  zotero.Prefs?.set(PAPER_ANALYSIS_MODEL_PREF_KEY, JSON.stringify(normalized))
  return normalized
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
  if (!provider) throw new Error("Provider ID 不能为空。")
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
  if (!model) throw new Error("模型必须关联已保存的 Provider。")
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
    name: existingModel?.name || input.model.trim() || "Unnamed model",
    model: input.model,
    ...(existingModel?.contextWindow ? { contextWindow: existingModel.contextWindow } : {}),
    maxOutputTokens: positiveInteger(input.maxOutputTokens) ?? DEFAULT_BYOK_MAX_OUTPUT_TOKENS,
  })
  return readByokConfig(zotero)
}

export function clearByokConfig(zotero: ZoteroLike) {
  zotero.Prefs?.clear(PREF_BYOK_CONFIG)
}
