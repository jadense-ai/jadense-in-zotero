import type { JadenseZoteroImportItem } from "@/sync/metadata"

export type JadenseApiOptions = {
  baseUrl: string
  token: string
  fetchImpl?: typeof fetch
  formDataFactory?: () => FormData
}

export type JadenseProfile = {
  userId: string
  displayName: string | null
  avatarUrl: string | null
  avatarSrc: string | null
  subscription: {
    code: string
    label: string
  }
}

export type JadensePointsStatus = {
  billing: {
    sourceKind: "personal" | "team"
    teamId: string | null
    balancePoints: number
    primaryBalancePoints: number
    fallbackBalancePoints: number | null
  }
  checkIn: {
    signedToday: boolean
    currentStreakDays: number
    todayReward: {
      grantedPoints: number
    }
  }
}

export type JadensePointsCheckInResult = {
  alreadyCheckedIn: boolean
  balanceAfter: number
  grantedPoints: number
}

export type JadenseChatSelection =
  | { kind: "default" }
  | { kind: "route"; routeTier: string }
  | { kind: "model"; modelId: string }

type JadenseChatModelOptionBase = {
  displayName: string
  description: string
  locked: boolean
  lockReason?: string
  minimumPlanCode?: string
  sortOrder?: number
}

export type JadenseChatModelOption =
  | (JadenseChatModelOptionBase & { kind: "route"; routeTier: string })
  | (JadenseChatModelOptionBase & {
      kind: "model"
      modelId: string
      capabilities: string[]
      consumptionMultiplier?: number
    })

export type JadenseChatModelCatalog = {
  options: JadenseChatModelOption[]
  defaultSelection: Exclude<JadenseChatSelection, { kind: "default" }> | null
}

/** 保留服务端状态、稳定错误码与原始响应，供各 UI 区域独立决定恢复方式。 */
export class JadenseApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly body: string

  constructor(input: { status: number; code?: string | null; body: string; message: string }) {
    super(input.message)
    this.name = "JadenseApiError"
    this.status = input.status
    this.code = input.code ?? null
    this.body = input.body
  }
}

/** 模型与路由订阅拒绝共用恢复指引；令牌、积分和 BYOK 错误保持各自语义。 */
export function jadenseModelSubscriptionErrorMessage(error: unknown): string | null {
  if (!(error instanceof JadenseApiError)) return null
  if (!["AI_MODEL_SELECTION_PLAN_REQUIRED", "AI_USER_ROUTE_PLAN_REQUIRED"].includes(error.code?.toUpperCase() ?? "")) return null
  return "当前订阅不支持所选模型或路由。请在「设置 → 功能配置」更换可用模型，或升级订阅后重试。充值积分不会解除此限制。"
}

function nonEmptyText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function invalidPayload(endpoint: string) {
  return new Error(`攻玉${endpoint}响应格式无效，请稍后重试。`)
}

function parseProfile(value: unknown): JadenseProfile {
  const profile = objectValue(value)
  const subscription = objectValue(profile?.subscription)
  const userId = nonEmptyText(profile?.userId)
  const code = nonEmptyText(subscription?.code)
  const label = nonEmptyText(subscription?.label)
  if (!profile || !userId || (!code && !label)) throw invalidPayload("账号资料")
  return {
    userId,
    displayName: nonEmptyText(profile.displayName),
    avatarUrl: nonEmptyText(profile.avatarUrl),
    avatarSrc: nonEmptyText(profile.avatarSrc),
    subscription: {
      code: code ?? label!,
      label: label ?? code!,
    },
  }
}

function parsePointsStatus(value: unknown): JadensePointsStatus {
  const root = objectValue(value)
  const billing = objectValue(root?.billing)
  const checkIn = objectValue(root?.checkIn)
  const todayReward = objectValue(checkIn?.todayReward)
  const sourceKind = billing?.sourceKind
  const teamId = billing?.teamId
  const balancePoints = finiteNumber(billing?.balancePoints)
  const primaryBalancePoints = finiteNumber(billing?.primaryBalancePoints)
  const fallbackBalancePoints = billing?.fallbackBalancePoints === null
    ? null
    : finiteNumber(billing?.fallbackBalancePoints)
  const signedToday = checkIn?.signedToday
  const currentStreakDays = finiteNumber(checkIn?.currentStreakDays)
  const grantedPoints = finiteNumber(todayReward?.grantedPoints)
  if (
    !root || !billing || !checkIn || !todayReward
    || (sourceKind !== "personal" && sourceKind !== "team")
    || (teamId !== null && typeof teamId !== "string")
    || balancePoints === null || primaryBalancePoints === null
    || (fallbackBalancePoints === null && billing.fallbackBalancePoints !== null)
    || typeof signedToday !== "boolean" || currentStreakDays === null || grantedPoints === null
  ) throw invalidPayload("积分状态")
  return {
    billing: { sourceKind, teamId, balancePoints, primaryBalancePoints, fallbackBalancePoints },
    checkIn: { signedToday, currentStreakDays, todayReward: { grantedPoints } },
  }
}

function parsePointsCheckIn(value: unknown): JadensePointsCheckInResult {
  const result = objectValue(value)
  const alreadyCheckedIn = result?.alreadyCheckedIn
  const balanceAfter = finiteNumber(result?.balanceAfter)
  const grantedPoints = finiteNumber(result?.grantedPoints)
  if (!result || typeof alreadyCheckedIn !== "boolean" || balanceAfter === null || grantedPoints === null) {
    throw invalidPayload("签到")
  }
  return { alreadyCheckedIn, balanceAfter, grantedPoints }
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap(item => nonEmptyText(item) ?? []).slice(0, 32)
    : []
}

function parseChatSelection(value: unknown): JadenseChatModelCatalog["defaultSelection"] {
  const row = objectValue(value)
  const routeTier = nonEmptyText(row?.routeTier)
  const modelId = nonEmptyText(row?.modelId)
  if (row?.kind === "route" && routeTier) return { kind: "route", routeTier }
  if (row?.kind === "model" && modelId) return { kind: "model", modelId }
  return null
}

function parseChatModelOption(value: unknown): JadenseChatModelOption | null {
  const row = objectValue(value)
  const displayName = nonEmptyText(row?.displayName)
  if (!row || !displayName) return null
  const base = {
    displayName,
    description: nonEmptyText(row.description) ?? "",
    locked: row.locked === true,
    ...(nonEmptyText(row.lockReason) ? { lockReason: nonEmptyText(row.lockReason)! } : {}),
    ...(nonEmptyText(row.minimumPlanCode) ? { minimumPlanCode: nonEmptyText(row.minimumPlanCode)! } : {}),
    ...(finiteNumber(row.sortOrder) !== null ? { sortOrder: finiteNumber(row.sortOrder)! } : {}),
  }
  const routeTier = nonEmptyText(row.routeTier)
  if (row.kind === "route" && routeTier) return { ...base, kind: "route", routeTier }
  const modelId = nonEmptyText(row.modelId)
  if (row.kind !== "model" || !modelId) return null
  const consumptionMultiplier = finiteNumber(row.consumptionMultiplier)
  return {
    ...base,
    kind: "model",
    modelId,
    capabilities: stringList(row.capabilities),
    ...(consumptionMultiplier !== null ? { consumptionMultiplier } : {}),
  }
}

/** 模型目录是可选展示数据：丢弃不认识的行和附加字段，只要求顶层 options 可枚举。 */
export function parseJadenseChatModelCatalog(value: unknown): JadenseChatModelCatalog {
  const root = objectValue(value)
  if (!root || !Array.isArray(root.options)) throw invalidPayload("模型目录")
  return {
    options: root.options.flatMap(option => parseChatModelOption(option) ?? []),
    defaultSelection: parseChatSelection(root.defaultSelection),
  }
}

export async function readJadenseApiError(response: Response, fallback = "攻玉请求失败") {
  const body = await response.text().catch(() => "")
  let code: string | null = null
  let message: string | null = null
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown; message?: unknown }
    code = nonEmptyText(parsed.code)
    message = nonEmptyText(parsed.error) ?? nonEmptyText(parsed.message)
  } catch {
    // 非 JSON 响应仍保留原始文本，避免隐藏网关或代理返回的可诊断信息。
  }
  return new JadenseApiError({
    status: response.status,
    code,
    body,
    message: message ?? `${fallback}（${response.status}）`,
  })
}

export type JadenseFavoriteFolder = {
  id: string
  name: string
  isDefault: boolean
  itemCount: number
  parentId?: string | null
  sortOrder?: number
  path?: string[]
  depth?: number
  childCount?: number
}

export type JadenseZoteroImportResult = {
  importedCount: number
  skippedCount: number
  failedCount: number
  results: Array<{
    clientItemId: string | null
    status: "imported" | "skipped" | "failed"
    result?: unknown
    error?: string
  }>
}

export type JadensePdfImportResult = {
  itemKind: "literature"
  articleId: string | null
  assetFileId?: string | null
  insertedFolderIds: string[]
  skippedFolderIds: string[]
  /** 文件被回填到这些收藏夹中已存在但缺 PDF 的条目上(服务端 2026-08 起返回)。 */
  backfilledFolderIds?: string[]
}

function isFormDataBody(value: unknown) {
  return Object.prototype.toString.call(value) === "[object FormData]"
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit) {
  // Gecko 140 要求 Window.fetch 保留原始 Window 接收者。
  return globalThis.fetch(input, init)
}

export class JadenseApiClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly formDataFactory: () => FormData

  constructor(options: JadenseApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/g, "")
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? defaultFetch
    this.formDataFactory = options.formDataFactory ?? (() => new FormData())
  }

  private async requestJson<T>(path: string, init: RequestInit = {}, payloadLabel?: string): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${this.token}`)
    if (init.body && !isFormDataBody(init.body) && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    })
    if (!response.ok) {
      throw await readJadenseApiError(response)
    }
    try {
      return (await response.json()) as T
    } catch (error) {
      if (payloadLabel) throw invalidPayload(payloadLabel)
      throw error
    }
  }

  async getCurrentProfile(signal?: AbortSignal) {
    return parseProfile(await this.requestJson<unknown>("/api/extension/profile/me", { signal }, "账号资料"))
  }

  async getPointsStatus(signal?: AbortSignal) {
    return parsePointsStatus(await this.requestJson<unknown>("/api/extension/points/status", { signal }, "积分状态"))
  }

  async checkInPoints(signal?: AbortSignal) {
    return parsePointsCheckIn(await this.requestJson<unknown>("/api/extension/points/check-in", {
      method: "POST",
      signal,
    }, "签到"))
  }

  async getChatModels(signal?: AbortSignal) {
    return parseJadenseChatModelCatalog(await this.requestJson<unknown>(
      "/api/extension/chat/models",
      { signal },
      "模型目录",
    ))
  }

  listFavoriteFolders() {
    return this.requestJson<{ defaultFolderId: string | null; folders: JadenseFavoriteFolder[] }>(
      "/api/extension/favorite/folders",
    )
  }

  listFavoriteItems(folderId: string) {
    const params = new URLSearchParams({ folderId, field: "title" })
    return this.requestJson<{ items: unknown[] }>(
      `/api/extension/favorite/items?${params.toString()}`,
    )
  }

  importZoteroItems(folderIds: string[], items: JadenseZoteroImportItem[]) {
    return this.requestJson<JadenseZoteroImportResult>("/api/extension/favorite/import-zotero-items", {
      method: "POST",
      body: JSON.stringify({ folderIds, items }),
    })
  }

  importFavoritePdf(input: {
    folderIds: string[]
    item: JadenseZoteroImportItem
    file: Blob
    filename: string
  }) {
    const form = this.formDataFactory()
    form.set("file", input.file, input.filename)
    form.set("folderIds", JSON.stringify(input.folderIds))
    form.set("metadata", JSON.stringify(input.item.metadata))
    form.set("paper", JSON.stringify({
      schemaVersion: 2,
      identity: {
        doi: input.item.metadata.doi,
        source: input.item.metadata.externalSource,
        externalId: input.item.metadata.externalId,
      },
      metadata: {
        title: input.item.metadata.title,
        authors: input.item.metadata.authors,
        venueName: input.item.metadata.venueName,
        publicationDate: input.item.metadata.publicationDate,
        abstract: input.item.metadata.abstract,
        canonicalUrl: input.item.metadata.canonicalUrl,
        pageUrl: input.item.metadata.pageUrl,
        sourceMetadata: input.item.metadata.sourceMetadata,
      },
    }))
    return this.requestJson<JadensePdfImportResult>("/api/extension/favorite/import-page-pdf", {
      method: "POST",
      body: form,
    })
  }
}
