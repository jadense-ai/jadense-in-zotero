import { requestIssue, type RequestIssue } from '@/chat/request-feedback'
import { traceRequest, diagnosticFetch } from "@/zotero/diagnostics"
import { uiText } from "@/zotero/ui-preferences"
import type { JadenseZoteroImportItem } from "@/sync/metadata"
import { uploadFileSha256, uploadRequestId } from "@/sync/pdf-upload-platform"

export type JadenseApiOptions = {
  baseUrl: string
  token: string
  fetchImpl?: typeof fetch
  formDataFactory?: () => FormData
  computeSha256?: (file: Blob) => Promise<string | undefined>
  requestIdFactory?: () => string
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
    sourceKind: "personal"
    balancePoints: number


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
  | { kind: "model"; modelId: string; thinkingEffort?: string }

type JadenseChatModelOptionBase = {
  defaultThinkingEffort?: string
  reasoningConfig?: { reasoningEfforts: string[]; reasoningRequired?: boolean }
  contextWindow?: number
  maxOutputTokens?: number
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
      baseConsumptionMultiplier?: number
      sourceMultiplier?: number
      sourcePricePrefix?: string
    })

export type JadenseChatModelCatalog = {
  thinkingContractVersion?: number
  options: JadenseChatModelOption[]
  defaultSelection: Exclude<JadenseChatSelection, { kind: "default" }> | null
}

/** 保留服务端状态、稳定错误码与原始响应，供各 UI 区域独立决定恢复方式。 */
export class JadenseApiError extends Error {
  readonly requestId?: string
  readonly executionId?: string
  readonly diagnosticId?: string
  readonly stage?: string
  readonly causeCode?: string
  readonly status: number
  readonly code: string | null
  readonly body: string
  readonly retryAfter: string | null
  readonly assetFileId?: string
  readonly retryAssociationOnly?: boolean

  constructor(input: Omit<RequestIssue, "code"> & { status: number; code?: string | null; body: string; message: string; retryAfter?: string | null; assetFileId?: string; retryAssociationOnly?: boolean }) {
    super(input.message)
    Object.assign(this, requestIssue(input))
    this.name = "JadenseApiError"
    this.status = input.status
    this.code = input.code ?? null
    this.body = input.body
    this.retryAfter = input.retryAfter ?? null
    this.assetFileId = input.assetFileId
    this.retryAssociationOnly = input.retryAssociationOnly
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
  const sourceKind = "personal" as const
  const balancePoints = finiteNumber(billing?.balancePoints)
  const signedToday = checkIn?.signedToday
  const currentStreakDays = finiteNumber(checkIn?.currentStreakDays)
  const grantedPoints = finiteNumber(todayReward?.grantedPoints)
  if (
    !root || !billing || !checkIn || !todayReward
    || balancePoints === null
    || typeof signedToday !== "boolean" || currentStreakDays === null || grantedPoints === null
  ) throw invalidPayload(uiText("积分状态", "points status"))
  return {
    billing: { sourceKind, balancePoints },
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
    ...(nonEmptyText(row.defaultThinkingEffort) ? { defaultThinkingEffort: nonEmptyText(row.defaultThinkingEffort)! } : {}),
    ...(objectValue(row.reasoningConfig) ? { reasoningConfig: {
      reasoningEfforts: [...new Set(stringList(objectValue(row.reasoningConfig)?.reasoningEfforts))],
      reasoningRequired: objectValue(row.reasoningConfig)?.reasoningRequired === true,
    } } : {}),
    ...(typeof row.contextWindow === 'number' && Number.isFinite(row.contextWindow) && row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {}),
    ...(typeof row.maxOutputTokens === 'number' && Number.isFinite(row.maxOutputTokens) && row.maxOutputTokens > 0 ? { maxOutputTokens: row.maxOutputTokens } : {}),
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
    ...(finiteNumber(row.sourceMultiplier) !== null ? { sourceMultiplier: finiteNumber(row.sourceMultiplier)! } : {}),
    ...(typeof row.sourcePricePrefix === "string" && row.sourcePricePrefix.trim() ? { sourcePricePrefix: row.sourcePricePrefix.trim() } : {}),
    ...(finiteNumber(row.baseConsumptionMultiplier) !== null ? { baseConsumptionMultiplier: finiteNumber(row.baseConsumptionMultiplier)! } : {}),
  }
}

/** 模型目录是可选展示数据：丢弃不认识的行和附加字段，只要求顶层 options 可枚举。 */
export function parseJadenseChatModelCatalog(value: unknown): JadenseChatModelCatalog {
  const root = objectValue(value)
  if (!root || !Array.isArray(root.options)) throw invalidPayload(uiText("模型目录", "model catalog"))
  return {
    options: root.options.flatMap(option => parseChatModelOption(option) ?? []),
    defaultSelection: parseChatSelection(root.defaultSelection),
    ...(root.thinkingContractVersion === 1 ? { thinkingContractVersion: 1 } : {}),
  }
}

export async function readJadenseApiError(response: Response, fallback = uiText("攻玉请求失败", "The Jadense request failed"), showPlainText = false) {
  let readFailed = false
  const body = await response.text().catch(() => { readFailed = true; return "" })
  let issue: RequestIssue = requestIssue({ requestId: response.headers?.get?.("x-request-id"), executionId: response.headers?.get?.("x-execution-id"), diagnosticId: response.headers?.get?.("x-diagnostic-id") }, { stage: "http" })
  let code: string | null = null
  let message: string | null = null
  let savedFile: { assetFileId?: string; retryAssociationOnly?: boolean } = {}
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown; message?: unknown; assetFileId?: unknown; retryAssociationOnly?: unknown }
    issue = requestIssue(parsed, issue)
    code = nonEmptyText(parsed.code)
    message = nonEmptyText(parsed.error) ?? nonEmptyText(parsed.message)
    const assetFileId = nonEmptyText(parsed.assetFileId)
    if (assetFileId) savedFile = { assetFileId, retryAssociationOnly: parsed.retryAssociationOnly === true }
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
    ...issue,
    ...savedFile,
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
  conflicts?: { message: string }[]
}

function isFormDataBody(value: unknown) {
  return Object.prototype.toString.call(value) === "[object FormData]"
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit) {
  // Gecko 140 要求 Window.fetch 保留原始 Window 接收者。
  return globalThis.fetch(input, init)
}

export class JadenseApiClient {
  /** 专用请求无自动重试；取消/超时后可能已计费，稳定 operationId 禁止重复派发。 */
    async zoteroAiRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted()
    const controller = new AbortController(), abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let canceled: (() => void) | undefined
    try {
      return await Promise.race([
        this.requestJson<T>(`/api/extension/zotero/ai/${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, credentials: 'omit', redirect: 'error' }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(uiText('攻玉请求超时，未自动重发，请检查任务状态。', 'Jadense request timed out and was not replayed. Check task status.'))); abort() }, body === undefined ? 15000 : 180000) }),
        new Promise<never>((_, reject) => { canceled = () => reject(new Error(uiText('已停止等待，云端请求可能继续处理和计费。', 'Stopped waiting; the cloud request may continue processing and billing.'))); controller.signal.addEventListener('abort', canceled, { once: true }); if (controller.signal.aborted) canceled() }),
      ])
    } catch (error) {
      const operationId = body && typeof body === 'object' && 'operationId' in body ? body.operationId : null
      // 只查询原身份；取消、权限/输入失败不自动请求，任何状态均不授权再次 POST。
      if (!signal?.aborted && (path === 'decision' || path === 'ocr') && typeof operationId === 'string' &&
        (!(error instanceof JadenseApiError) || error.status >= 500 || error.code === 'SPECIALIZED_OPERATION_ALREADY_SUBMITTED')) {
        const status = await this.getZoteroAiOperation(path, operationId, signal).catch(() => null)
        const message = status?.billingStatus === 'reconciliation_required'
          ? uiText('费用待管理员核对；未重新提交。', 'Billing awaits administrator review; the request was not replayed.')
          : status?.status === 'completed'
            ? uiText('原操作已完成，请优先使用本地缓存；未重新提交。', 'The original operation completed. Use the local cache; the request was not replayed.')
            : uiText('原操作尚未确认完成，请查询状态或联系管理员；未重新提交。', 'The original operation is not confirmed complete. Check status or contact an administrator; the request was not replayed.')
        throw new JadenseApiError({ status: error instanceof JadenseApiError ? error.status : 503,
          code: error instanceof JadenseApiError ? error.code ?? 'SPECIALIZED_RESULT_UNCERTAIN' : 'SPECIALIZED_RESULT_UNCERTAIN',
          body: JSON.stringify({ operationId, status: status?.status ?? 'unknown' }), message })
      }
      throw error
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (canceled) controller.signal.removeEventListener('abort', canceled) }
  }
  /** 本人状态投影无文档正文与供应商身份，调用此入口不会产生消费。 */
  getZoteroAiOperation(capability: 'decision' | 'ocr', operationId: string, signal?: AbortSignal) {
    return this.zoteroAiRequest<{ status: string; billingStatus?: string; code?: string | null }>(`operations?capability=${capability}&operationId=${encodeURIComponent(operationId)}`, undefined, signal)
  }
  getZoteroAiCapabilities(signal?: AbortSignal) {
    return this.zoteroAiRequest<import('@/zotero/jadense-ai').AiCapabilities>('capabilities', undefined, signal)
  }
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly formDataFactory: () => FormData
  private readonly computeSha256: (file: Blob) => Promise<string | undefined>
  private readonly requestIdFactory: () => string

  constructor(options: JadenseApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/g, "")
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? defaultFetch
    this.formDataFactory = options.formDataFactory ?? (() => new FormData())
    this.computeSha256 = options.computeSha256 ?? uploadFileSha256
    this.requestIdFactory = options.requestIdFactory ?? uploadRequestId
  }

  private async requestJson<T>(path: string, init: RequestInit = {}, payloadLabel?: string): Promise<T> {
    return traceRequest({ signal: init.signal ?? undefined, diagnostic: undefined as import("@/zotero/diagnostics").RequestDiagnostic | undefined }, { feature: path.includes('/import') || path.includes('/upload') ? 'upload' : 'account' }, async input => {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${this.token}`)
    if (init.body && !isFormDataBody(init.body) && !headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }

    const response = await diagnosticFetch(input.diagnostic, this.fetchImpl, `${this.baseUrl}${path}`, {
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
    })
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
      body: JSON.stringify({ folderIds, items, requestId: this.requestIdFactory() }),
    })
  }

  /** 同一未完成意图保留回执；已保存文件只关联，预检明确未命中才传字节。 */
  async importFavoritePdf(input: {
    folderIds: string[]
    item: JadenseZoteroImportItem
    file?: Blob
    filename: string
    requestId?: string
    sha256?: string
    assetFileId?: string
    signal?: AbortSignal
    onStage?: (stage: "preflight" | "uploading" | "association") => void
    onSavedFile?: (assetFileId: string, retryAssociationOnly: boolean) => void
  }) {
    const requestId = input.requestId ?? this.requestIdFactory()
    const sha256 = input.assetFileId ? undefined : input.sha256 ?? (input.file ? await this.computeSha256(input.file).catch(() => undefined) : undefined)
    const notifyStage = (stage: "preflight" | "uploading" | "association") => { try { input.onStage?.(stage) } catch { /* 展示/本地保存失败不阻断上传。 */ } }
    const request = async (body: BodyInit, timeout: number) => {
      input.signal?.throwIfAborted()
      const controller = new AbortController(), abort = () => controller.abort(input.signal?.reason)
      input.signal?.addEventListener("abort", abort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined
      try {
        return await Promise.race([
          this.requestJson<unknown>("/api/extension/favorite/import-page-pdf", { method: "POST", body, signal: controller.signal }),
          new Promise<never>((_, reject) => {
            stop = () => reject(controller.signal.reason ?? new Error(uiText("已停止等待上传，重试将继续原请求。", "Stopped waiting for upload. Retry continues the original request.")))
            controller.signal.addEventListener("abort", stop, { once: true })
            timer = setTimeout(() => controller.abort(new Error(uiText("上传等待超时，重试将继续原请求。", "Upload timed out. Retry continues the original request."))), timeout)
          }),
        ])
      } catch (error) {
        if (error instanceof JadenseApiError && error.assetFileId) {
          try { input.onSavedFile?.(error.assetFileId, error.retryAssociationOnly === true) } catch { /* 本机状态可在当前会话恢复。 */ }
        }
        throw error
      } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); if (stop) controller.signal.removeEventListener("abort", stop) }
    }
    const result = (value: unknown): JadensePdfImportResult => {
      const row = objectValue(value)
      const assetFileId = nonEmptyText(row?.assetFileId)
      if (assetFileId) { try { input.onSavedFile?.(assetFileId, true) } catch { /* 最终回执仍可继续消费。 */ } }
      // 缺少回执不能证明是否已写入；禁止因此继续上传另一份字节。
      if (!row || !Array.isArray(row.insertedFolderIds) || !Array.isArray(row.skippedFolderIds)) throw invalidPayload(uiText("PDF 上传", "PDF upload"))
      return { ...row, insertedFolderIds: row.insertedFolderIds.filter((id): id is string => typeof id === "string"),
        skippedFolderIds: row.skippedFolderIds.filter((id): id is string => typeof id === "string"),
        backfilledFolderIds: Array.isArray(row.backfilledFolderIds) ? row.backfilledFolderIds.filter((id): id is string => typeof id === "string") : undefined,
        conflicts: Array.isArray(row.conflicts) ? row.conflicts.flatMap(raw => { const conflict=objectValue(raw);return typeof conflict?.message === "string" ? [{...conflict,message:conflict.message}] : [] }) : undefined,
      } as JadensePdfImportResult
    }
    if (input.assetFileId || sha256) {
      notifyStage(input.assetFileId ? "association" : "preflight")
      const preflight = objectValue(await request(JSON.stringify({ allowReuse: true, sha256, size: input.file?.size,
        assetFileId: input.assetFileId, filename: input.filename, requestId, folderIds: input.folderIds, metadata: input.item.metadata }), 60000))
      if (preflight?.reused === true) return result(preflight.result)
      if (preflight?.reused !== false || input.assetFileId) throw invalidPayload(uiText("PDF 上传预检", "PDF upload preparation"))
    }
    if (!input.file) throw new Error(uiText("原 PDF 不可读取，请重新选择附件。", "The original PDF cannot be read. Select the attachment again."))
    notifyStage("uploading")
    const form = this.formDataFactory()
    form.set("requestId",requestId)
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
    return result(await request(form, 1800000))
  }
}
