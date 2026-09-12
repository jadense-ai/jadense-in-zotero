import { uiText } from "@/zotero/ui-preferences"
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
  readonly retryAfter: string | null

  constructor(input: { status: number; code?: string | null; body: string; message: string; retryAfter?: string | null }) {
    super(input.message)
    this.name = "JadenseApiError"
    this.status = input.status
    this.code = input.code ?? null
    this.body = input.body
    this.retryAfter = input.retryAfter ?? null
  }
}

/** 模型与路由订阅拒绝共用恢复指引；令牌、积分和 BYOK 错误保持各自语义。 */
export function jadenseModelSubscriptionErrorMessage(error: unknown): string | null {
  if (!(error instanceof JadenseApiError)) return null
  if (!["AI_MODEL_SELECTION_PLAN_REQUIRED", "AI_USER_ROUTE_PLAN_REQUIRED"].includes(error.code?.toUpperCase() ?? "")) return null
  return uiText("当前订阅不支持所选模型或路由。请在「设置 → 功能配置」更换可用模型，或升级订阅后重试。充值积分不会解除此限制。", "Your subscription does not include this model or route. Choose an available model in Settings → Feature settings, or upgrade your subscription and retry. Buying points does not remove this restriction.")
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
  return new Error(uiText(`攻玉${endpoint}响应格式无效，请稍后重试。`, `The Jadense ${endpoint} response is invalid. Please try again later.`))
}

function parseProfile(value: unknown): JadenseProfile {
  const profile = objectValue(value)
  const subscription = objectValue(profile?.subscription)
  const userId = nonEmptyText(profile?.userId)
  const code = nonEmptyText(subscription?.code)
  const label = nonEmptyText(subscription?.label)
  if (!profile || !userId || (!code && !label)) throw invalidPayload(uiText("账号资料", "account profile"))
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
  ) throw invalidPayload(uiText("积分状态", "points status"))
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
    throw invalidPayload(uiText("签到", "check-in"))
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
  if (!root || !Array.isArray(root.options)) throw invalidPayload(uiText("模型目录", "model catalog"))
  return {
    options: root.options.flatMap(option => parseChatModelOption(option) ?? []),
    defaultSelection: parseChatSelection(root.defaultSelection),
  }
}

export async function readJadenseApiError(response: Response, fallback = uiText("攻玉请求失败", "The Jadense request failed"), showPlainText = false) {
  let readFailed = false
  const body = await response.text().catch(() => { readFailed = true; return "" })
  let code: string | null = null
  let message: string | null = null
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown; message?: unknown }
    code = nonEmptyText(parsed.code)
    message = nonEmptyText(parsed.error) ?? nonEmptyText(parsed.message)
  } catch {
    // 简短纯文本业务拒绝需要可见；HTML 代理页及长正文只保留在错误对象中。
    const plain = body.trim()
    if (showPlainText && plain && plain.length <= 300 && !/[<>]/u.test(plain)) message = `${fallback}（${response.status}）：${plain}`
  }
  if (showPlainText && !message) {
    const reason = readFailed
      ? uiText('响应正文读取失败，无法取得服务端错误详情。', 'The response body could not be read; server error details are unavailable.')
      : !body.trim()
        ? uiText('响应正文为空，服务端未提供错误详情。', 'The response body is empty; the server provided no error details.')
        : /<\s*(?:!doctype|html|head|body)\b/iu.test(body)
          ? uiText('服务器返回了 HTML 错误页，未提供可显示的业务错误详情。', 'The server returned an HTML error page without displayable application error details.')
          : uiText('响应中没有可显示的错误详情。', 'The response contains no displayable error details.')
    message = `${fallback}（${response.status}）：${reason}`
  }
  if (showPlainText) {
    // 只展示有限字符的关联 ID，不读取认证头、Cookie 或请求正文。
    const requestID = response.headers?.get?.('x-request-id')
    if (requestID && /^[a-z\d_.:-]{1,128}$/iu.test(requestID)) message += uiText(` 请求 ID：${requestID}`, ` Request ID: ${requestID}`)
  }
  return new JadenseApiError({
    status: response.status,
    retryAfter: response.headers?.get?.('Retry-After') ?? null,
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
    return parseProfile(await this.requestJson<unknown>("/api/extension/profile/me", { signal }, uiText("账号资料", "account profile")))
  }

  async getPointsStatus(signal?: AbortSignal) {
    return parsePointsStatus(await this.requestJson<unknown>("/api/extension/points/status", { signal }, uiText("积分状态", "points status")))
  }

  async checkInPoints(signal?: AbortSignal) {
    return parsePointsCheckIn(await this.requestJson<unknown>("/api/extension/points/check-in", {
      method: "POST",
      signal,
    }, uiText("签到", "check-in")))
  }

  async getChatModels(signal?: AbortSignal) {
    return parseJadenseChatModelCatalog(await this.requestJson<unknown>(
      "/api/extension/chat/models",
      { signal },
      uiText("模型目录", "model catalog"),
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
