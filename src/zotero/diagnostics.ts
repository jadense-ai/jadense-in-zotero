/** 插件本地诊断：共享宿主实例、字段投影和有界持久化；任何诊断失败不得改变业务执行。 */
export type DiagnosticCategory = 'running' | 'success' | 'error' | 'cancelled' | 'business'
export type DiagnosticEvent = { at: string; stage: string; code?: string; name?: string; source?: string; status?: number; stack?: string }
export type DiagnosticRecord = {
  id: string; session: string; startedAt: string; endedAt?: string; category: DiagnosticCategory
  environment?: Record<string,string>; context: Record<string, string>; events: DiagnosticEvent[]; firstError?: DiagnosticEvent
  bytes: number; characters: number; firstDataAt?: string; firstTextAt?: string; lastDataAt?: string
}
type IO = { makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; readUTF8(path: string): Promise<string>; writeUTF8(path: string, text: string, options: { tmpPath: string }): Promise<unknown> }
type Platform = { IOUtils?: IO; PathUtils?: { profileDir: string; join(...parts: string[]): string } }
type Host = object & { __jadenseDiagnostics?: Diagnostics; version?: string; platform?: string }
const CONTEXT = ['feature', 'provider', 'protocol', 'model', 'clientRequestId', 'conversationId', 'taskId', 'operationId', 'transportAttemptId', 'executionId', 'diagnosticId', 'window', 'operation', 'chunkIndex', 'chunkTotal']
const LIMIT = 2 * 1024 * 1024, MAX_AGE = 7 * 86400000
const safe = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(v) && !/^(?:https?:|file:|data:|Bearer|sk-|eyJ)/i.test(v) && !v.includes('\\') && !v.startsWith('/') ? v : undefined
const time = () => new Date().toISOString()
const id = () => globalThis.crypto?.randomUUID?.() ?? `diag-${Date.now()}-${Math.random().toString(16).slice(2)}`
function context(input: Record<string, unknown>) { const result: Record<string, string> = {}; for (const key of CONTEXT) { const value = safe(input[key]); if (value) result[key] = value } return result }
/** 不序列化异常 message/cause/body；外部可能在这些字段回显正文或凭据。 */
function errorFields(error: unknown): Pick<DiagnosticEvent, 'code' | 'name' | 'status' | 'stack'> {
  try {
    const value = error as { code?: unknown; name?: unknown; status?: unknown; stack?: unknown; cause?: { code?: unknown; cause?: { code?: unknown } } }
    const frames = typeof value?.stack === 'string' ? (value.stack.match(/(?:manager|bootstrap|preferences)\.js:\d+:\d+/g) ?? []).slice(0,8).join('\n') : undefined
    const code = value?.code ?? value?.cause?.code ?? value?.cause?.cause?.code
    return { stack: frames || undefined, code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(code) ? code : undefined,
      name: ['Error','TypeError','AbortError','TimeoutError','SyntaxError','JadenseApiError','ByokResponseError','ResponseAborted'].includes(String(value?.name)) ? String(value.name) : 'Error',
      status: typeof value?.status === 'number' && value.status >= 100 && value.status <= 599 ? value.status : undefined }
  } catch { return { name: 'Error' } }
}
function project(value: unknown): DiagnosticRecord | undefined {
  const r = value as DiagnosticRecord
  if (!r || !safe(r.id) || !Number.isFinite(Date.parse(r.startedAt))) return
  const event = (e: DiagnosticEvent): DiagnosticEvent => ({ at: Number.isFinite(Date.parse(e?.at)) ? e.at : r.startedAt, stage: safe(e?.stage) ?? 'unknown', ...errorFields(e), source: safe(e?.source) })
  return { id: r.id, session: safe(r.session) ?? 'unknown', startedAt: r.startedAt, endedAt: r.endedAt && Number.isFinite(Date.parse(r.endedAt)) ? r.endedAt : undefined,
    environment: Object.fromEntries(['plugin','zotero','os'].map(k => [k,safe(r.environment?.[k]) ?? 'unknown'])),
    category: ['running','success','error','cancelled','business'].includes(r.category) ? r.category : 'error', context: context(r.context ?? {}),
    events: Array.isArray(r.events) ? r.events.slice(0,32).map(event) : [], firstError: r.firstError ? event(r.firstError) : undefined,
    bytes: Number.isFinite(r.bytes) ? Math.max(0,r.bytes) : 0, characters: Number.isFinite(r.characters) ? Math.max(0,r.characters) : 0,
    ...Object.fromEntries(['firstDataAt','firstTextAt','lastDataAt'].filter(k => Number.isFinite(Date.parse((r as unknown as Record<string,string>)[k]))).map(k => [k,(r as unknown as Record<string,string>)[k]])) }
}

export class Diagnostics {
  readonly session = id()
  readonly abortSources = new WeakMap<AbortSignal,string>()
  environment: Record<string,string> = {}
  enabled = false
  storageAvailable = true
  private rows: DiagnosticRecord[] = []
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private writes: Promise<unknown> = Promise.resolve()
  private generation = 0
  private disposed = false
  readonly ready: Promise<void>
  constructor(private platform: Platform = globalThis as Platform) { this.ready = this.restore() }
  private path() { const p = this.platform.PathUtils; return p?.join(p.profileDir, 'jadense-diagnostics', 'records.json') }
  private async restore() {
    const generation = this.generation
    try {
      const path = this.path(); if (!path || !this.platform.IOUtils) { this.storageAvailable = false; return }
      const raw = await this.platform.IOUtils.readUTF8(path)
      if (raw.length > LIMIT) return
      const saved = JSON.parse(raw)
      if (generation !== this.generation || !Array.isArray(saved.records)) return
      const old = saved.records.map(project).filter(Boolean) as DiagnosticRecord[]
      for (const row of old) if (row.category === 'running') { row.category = 'error'; row.events.push({ at: time(), stage: 'previous_session_unfinished' }) }
      this.rows = [...old, ...this.rows]; this.trim(); this.notify()
    } catch { /* 新安装没有文件，损坏文件只丢弃诊断，不阻断启动。 */ }
  }
  private trim(checkBytes = true) {
    this.rows = this.rows.filter(r => Date.parse(r.startedAt) >= Date.now() - MAX_AGE).slice(-500)
    if (!checkBytes) return
    let bytes = 4096
    const encoder = new TextEncoder()
    for (let i = this.rows.length - 1; i >= 0; i--) {
      bytes += encoder.encode(JSON.stringify(project(this.rows[i]))).length + 1
      if (bytes > LIMIT) { this.rows = this.rows.slice(i + 1); break }
    }
  }
  private notify() { for (const callback of this.listeners) try { callback() } catch { /* 关闭的窗口不影响收集。 */ } }
  changed(immediate = false) {
    if (this.disposed) return
    this.notify()
    if (immediate) { if (this.timer) clearTimeout(this.timer); this.timer = undefined; void this.flush() }
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 1000)
  }
  async flush() {
    const generation = this.generation
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await this.ready
      if (generation !== this.generation) return
      const path = this.path(), io = this.platform.IOUtils, p = this.platform.PathUtils
      if (!path || !io || !p) { this.storageAvailable = false; return }
      this.trim()
      try { await io.makeDirectory(p.join(p.profileDir,'jadense-diagnostics'), { ignoreExisting: true }); await io.writeUTF8(path, JSON.stringify({ version: 1, records: this.rows.map(project).filter(Boolean) }), { tmpPath: `${path}.tmp` }); this.storageAvailable = true }
      catch { this.storageAvailable = false }
    })
    await this.writes.catch(() => { this.storageAvailable = false })
  }
  start(input: Record<string,unknown> = {}, signal?: AbortSignal) { const row: DiagnosticRecord = { id: id(), session: this.session, startedAt: time(), category: 'running', context: context(input), environment: { ...this.environment }, events: [], bytes: 0, characters: 0 }; this.rows.push(row); this.trim(false); return new RequestDiagnostic(this, row, signal) }
  record(feature: string, stage: string, error: unknown) { const trace = this.start({ feature }); trace.fail(error, stage); if (errorFields(error).name === 'AbortError') trace.row.category = 'cancelled'; trace.end() }
  list() { this.trim(); return this.rows.map(r => project(r)!).reverse() }
  subscribe(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  setEnabled(value: boolean) { this.enabled = value; this.notify() }
  export(records = this.list(), filters: Record<string,string> = {}) { return JSON.stringify({ version: 1, exportedAt: time(), environment: this.environment, filters, notice: 'Local metadata only. Abrupt shutdown may lose unflushed events.', records: records.map(project).filter(Boolean) }, null, 2) }
  async clear() { this.generation++; this.rows = []; this.notify(); if (this.timer) clearTimeout(this.timer); this.timer = undefined; await this.flush() }
  dispose() { this.enabled = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; void this.flush(); this.listeners.clear(); this.disposed = true }
}

export class RequestDiagnostic {
  private done = false
  private onAbort = () => this.event('abort', { source: this.store.abortSources.get(this.signal!) ?? 'unknown' })
  constructor(private store: Diagnostics, readonly row: DiagnosticRecord, private signal?: AbortSignal) { this.event('start'); signal?.addEventListener('abort', this.onAbort, { once: true }); if (signal?.aborted) this.onAbort() }
  event(stage: string, fields: Partial<DiagnosticEvent> = {}) {
    if (this.done) return
    const entry: DiagnosticEvent = { at: time(), stage: safe(stage) ?? 'unknown', ...(fields.name || fields.code || fields.status ? errorFields(fields) : {}), source: safe(fields.source) }
    if (this.row.events.length >= 32) { const index = this.row.events.findIndex(e => !['start','error','abort','cleanup_cancel','finish','DONE','end'].includes(e.stage)); this.row.events.splice(index >= 0 ? index : 1,1) }
    this.row.events.push(entry); this.store.changed(stage === 'error' || stage === 'abort')
  }
  data(bytes: number) { if (!bytes) return; const at = time(); this.row.bytes += bytes; this.row.lastDataAt = at; if (!this.row.firstDataAt) { this.row.firstDataAt = at; this.event('first_data') } }
  text(characters: number) { this.row.characters += characters; if (characters && !this.row.firstTextAt) { this.row.firstTextAt = time(); this.event('first_text') } }
  identify(input: Record<string,unknown>) { Object.assign(this.row.context,context(input)) }
  fail(error: unknown, stage = 'error') {
    const fields = errorFields(error); this.event(stage,fields)
    if (this.row.firstError) return
    this.row.firstError = { at: time(), stage, ...fields }
    const source = this.signal && this.store.abortSources.get(this.signal)
    this.row.category = ['POINTS_INSUFFICIENT','insufficient_scope','PROJECT_RESOURCE_OUT_OF_SCOPE','AI_MODEL_SELECTION_PLAN_REQUIRED','AI_USER_ROUTE_PLAN_REQUIRED'].includes(fields.code ?? '') || (fields.status === 402 && this.row.context.provider !== 'byok') ? 'business'
      : this.signal?.aborted && source && source !== 'unknown' ? 'cancelled' : 'error'
  }
  end() { if (this.done) return; if (this.row.category === 'running') this.row.category = this.signal?.aborted ? 'cancelled' : 'success'; this.event('end'); this.row.endedAt = time(); this.done = true; this.signal?.removeEventListener('abort',this.onAbort); this.store.changed(true) }
}

const realmId = id()
let current: Diagnostics | undefined
const abortSources = new WeakMap<AbortSignal,string>()
/** 只旁记取消来源，原 abort(reason) 参数和语义保持不变。 */
export function markDiagnosticAbort(signal: AbortSignal | undefined, source: string) { if (signal && !signal.aborted) (current?.abortSources ?? abortSources).set(signal,source) }
export function diagnostics(host?: Host) {
  if (host) current = host.__jadenseDiagnostics ??= new Diagnostics()
  return current
}
export function stopDiagnostics(host: Host) { host.__jadenseDiagnostics?.dispose(); delete host.__jadenseDiagnostics; current = undefined }
export type DiagnosticInput = { diagnostic?: RequestDiagnostic; signal?: AbortSignal; clientFeature?: string; clientOperation?: string; chunkIndex?: number; chunkTotal?: number; clientRequestId?: string; conversationId?: string; taskId?: string; operationId?: string }
/** 同一次调用跨 reliable/base 客户端复用记录，不额外派发，不改变原返回值和异常。 */
export async function traceRequest<T extends DiagnosticInput,R>(input: T, detail: Record<string,unknown>, run: (input: T) => Promise<R>): Promise<R> {
  if (input.diagnostic || !current) return run(input)
  const trace = current.start({ window: realmId, ...detail, operation: input.clientOperation, chunkIndex: input.chunkIndex?.toString(), chunkTotal: input.chunkTotal?.toString(), feature: input.clientFeature ?? detail.feature ?? 'chat', clientRequestId: input.clientRequestId, conversationId: input.conversationId, taskId: input.taskId, operationId: input.operationId },input.signal)
  try { return await run({ ...input, diagnostic: trace }) } catch (error) { trace.fail(error); throw error } finally { trace.end() }
}
export async function diagnosticFetch(trace: RequestDiagnostic | undefined, request: typeof fetch, input: RequestInfo | URL, init?: RequestInit) {
  trace?.event('dispatch', { source: init?.method ?? 'GET' })
  try { const response = await request(input, init); trace?.event('headers', { status: response.status }); trace?.identify({ diagnosticId: response.headers.get('x-diagnostic-id'), executionId: response.headers.get('x-execution-id') }); return response }
  catch (error) { trace?.fail(error,'fetch_error'); throw error }
}
