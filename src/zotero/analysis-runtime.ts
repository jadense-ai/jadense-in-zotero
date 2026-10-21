/** 解析任务归插件所有：持久检查点驱动恢复，视图仅订阅；关闭窗口不终止任务。 */
import { appendPaperAnalysisRecord, readPaperAnalysisHistory, type PaperAnalysisRecord } from '@/chat/paper-analysis-history'
import { requestHash } from '@/chat/temporary-request-store'
import { resolveTemporaryAccount } from '@/chat/temporary-account'
import { ReliableTemporaryChatClient } from '@/chat/reliable-temporary-chat'
import { requestIssue, requestIssueSummary } from '@/chat/request-feedback'
import { runIndependentPaperAnalysis, paperAnalysisModelState } from './paper-analysis-runner'
import { AnalysisTaskStore, AnalysisStorageError, newAnalysisTask, type AnalysisTask } from './analysis-task-store'
import { collectSourceForItem } from './research-context'
import { documentJobs } from './document-jobs'
import type { AnalysisRunView } from './analysis-workspace'
import { readConnection, type ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { markDiagnosticAbort } from './diagnostics'
import { analysisStage } from './analysis-stage'
import { FEATURE_MODEL_PREF_KEYS, AUTO_FOLLOW_CHAT_MODEL_PREF_KEY } from './ai-settings'

type Context = { account: string; configuration: string; route: 'jadense' | 'byok' }
type RuntimeOptions = { store?: Pick<AnalysisTaskStore, 'list' | 'save'>; context?: (signal: AbortSignal) => Promise<Context>; retryDelay?: number }
function issueMessage(issue: ReturnType<typeof requestIssue>) {
  if (issue.code === 'ANALYSIS_STORAGE') return new AnalysisStorageError().message
  if (issue.code === 'ANALYSIS_TIMEOUT') return uiText('解析阶段暂未完成，稍后自动继续；已有内容保留。', 'Analysis timed out. It will continue automatically; existing work is retained.')
  if (issue.code === 'CONFIG_CHANGED') return uiText('请恢复本任务原账号与模型配置后继续，已完成内容保留。', 'Restore this task’s account and model settings to continue. Completed work is retained.')
  if (issue.code === 'ANALYSIS_SOURCE_CHANGED') return uiText('原 PDF 已更改或不可用；已保存解析仍可阅读。', 'The source PDF changed or is unavailable. Saved analysis remains readable.')
  if (issue.code === 'ANALYSIS_PERMISSION') return uiText('当前文库不可编辑；恢复权限后可继续补写批注。', 'The library is not editable. Restore permission to continue saving annotations.')
  if (issue.status) return requestIssueSummary(issue)
  return uiText('解析尚未完成，已保留进度；可继续任务或检查设置。', 'Analysis is unfinished and progress is retained. Continue the task or check settings.') + (issue.code ? ` (${issue.code})` : '')
}
/** 完成回调与冷启动共用状态投影；阅读范围等可选提示不改变执行状态。 */
function analysisViewState(task: AnalysisTask): Pick<AnalysisRunView, 'busy' | 'resumable' | 'retrying' | 'error' | 'message'> {
  const deliveryError = typeof task.deliveryError === 'string' ? task.deliveryError.trim() : ''
  return {
    busy: task.status === 'running', resumable: task.status !== 'complete', retrying: task.status === 'waiting',
    error: task.status === 'needs_action' || task.status === 'complete' && Boolean(deliveryError),
    message: task.status === 'complete' ? deliveryError || uiText('解析完成，总结与笔记已保存。', 'Analysis complete. Summary and notes saved.')
      : task.status === 'paused' ? uiText('解析已暂停，继续将复用已完成内容。', 'Analysis paused. Continue to reuse completed work.')
      : task.status === 'waiting' ? deliveryError || (task.issue ? issueMessage(task.issue) : uiText('正在等待恢复；已完成内容保留，无需重新解析。', 'Waiting to recover; completed work is retained.'))
      : task.status === 'needs_action' ? deliveryError || issueMessage(task.issue ?? {}) : uiText('正在准备文献解析…', 'Preparing analysis…'),
  }
}
/** 不保存密钥；同账号令牌轮换由服务端身份摘要确认，语义配置变化不得改写待执行任务。 */
async function analysisContext(host: ZoteroLike, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Context> {
  const model = paperAnalysisModelState(host)
  if (!model.ready) throw Object.assign(new Error(model.issue), { code: 'AI_NOT_CONFIGURED' })
  const connection = readConnection(host), config = model.config
  const semantic = { selection: model.selection, ...(config ? { protocol: config.protocol, baseUrl: config.baseUrl,
    model: config.model, maxOutputTokens: config.maxOutputTokens, thinkingEffort: config.thinkingEffort } : { origin: connection.baseUrl }) }
  const account = model.selection.route === 'jadense' ? (await resolveTemporaryAccount({ ...connection, fetchImpl, signal })).account
    : await requestHash(JSON.stringify({ provider: config!.baseUrl, protocol: config!.protocol, model: model.selection }))
  return { account, configuration: await requestHash(JSON.stringify(semantic)), route: model.selection.route }
}

export class AnalysisRuntime {
  private runs = new Map<number, AnalysisRunView>()
  private controllers = new Map<number, AbortController>()
  private active = new Map<number, Promise<void>>()
  private tasks = new Map<string, AnalysisTask>()
  private retained = new Map<string, PaperAnalysisRecord>()
  private listeners = new Set<() => void>()
  private observers: unknown[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private cancellations = new Map<string, Promise<void>>()
  private disposed = false
  private store: Pick<AnalysisTaskStore, 'list' | 'save'>
  readonly ready: Promise<void>
  constructor(private host: ZoteroLike, private run = runIndependentPaperAnalysis, private options: RuntimeOptions = {}) {
    this.store = options.store ?? new AnalysisTaskStore()
    this.ready = this.store.list().then(rows => {
      for (const task of rows) { this.tasks.set(task.id, task); if (task.record) this.retained.set(task.record.id, task.record); if (!this.runs.has(task.itemID)) this.show(task) }
      this.emit()
    })
    for (const key of ['extensions.jadenseInZotero.token', 'extensions.jadenseInZotero.baseUrl', 'extensions.jadenseInZotero.byokConfig', AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, FEATURE_MODEL_PREF_KEYS.analysis]) {
      try {
        const id = host.Prefs?.registerObserver?.(key, () => {
          for (const itemID of this.controllers.keys()) this.stop(itemID, 'configuration')
          for (const task of this.tasks.values()) if (task.status !== 'complete' && task.pauseReason !== 'user') {
            task.status = 'waiting'; this.schedule(task)
          }
        })
        if (id !== undefined) this.observers.push(id)
      } catch { /* 旧宿主可能不支持偏好监听，派发前仍核对上下文。 */ }
    }
  }
  private network() { const win = this.host.getMainWindow?.(); return win?.fetch.bind(win) ?? globalThis.fetch.bind(globalThis) }
  get(itemID: number) { return this.runs.get(itemID) }
  list() { return [...this.runs.values()] }
  records() { return [...new Map([...(this.host.Prefs ? readPaperAnalysisHistory(this.host.Prefs).records : []), ...this.retained.values()].map(record => [record.id, record])).values()] }
  unsaved(id: string) { return Boolean([...this.tasks.values()].find(task => task.record?.id === id)?.storageWarning) }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit() { for (const fn of this.listeners) { try { fn() } catch { /* 展示失败不影响执行。 */ } } }
  private taskFor(itemID: number) {
    return [...this.tasks.values()].filter(task => task.itemID === itemID && task.status !== 'complete').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }
  private show(task: AnalysisTask) {
    const view: AnalysisRunView = { source: task.record?.source ?? (task.snapshot ? { ...task.snapshot, authors: task.snapshot.metadata.authors } : { itemID: task.itemID, libraryID: -1, itemKey: '', title: 'PDF', authors: [] }),
      createdAt: task.createdAt, referenceTaskID: task.referenceTaskID, ...analysisViewState(task) }
    this.runs.set(task.itemID, view); return view
  }
  private async save(task: AnalysisTask) {
    const saved = await this.store.save(task)
    task.storageWarning = !saved
    if (task.record) this.retained.set(task.record.id, task.record)
    return saved
  }
  /** 由启动流程显式调用；用户暂停不会在重启或打开视图时重新运行。 */
  async restore() {
    await this.ready
    for (const task of this.tasks.values()) if (!this.disposed && ['queued', 'running', 'waiting'].includes(task.status) && task.pauseReason !== 'user') this.schedule(task, true)
  }
  stop(itemID: number, reason: 'user' | 'shutdown' | 'configuration' = 'user') {
    const task = this.taskFor(itemID), controller = this.controllers.get(itemID)
    if (task) {
      task.pauseReason = reason; task.status = reason === 'user' ? 'paused' : 'waiting'
      if (reason === 'user') task.resumeRequested = false
      clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id)
      void this.save(task)
      if (reason === 'user' && task.route === 'jadense' && task.generation === 'pending') {
        const connection = readConnection(this.host)
        const cancel = new ReliableTemporaryChatClient({ ...connection, fetchImpl: this.network() }).cancelOperation(task.id, task.operationID ?? task.id).catch(() => {
          // 取消回执不确定时保持用户暂停，显式继续先核对原执行。
        }).finally(() => { this.cancellations.delete(task.id) })
        this.cancellations.set(task.id, cancel)
      }
    }
    if (controller) { markDiagnosticAbort(controller.signal, reason === 'user' ? 'user_stop' : 'parent_cancel'); controller.abort(reason) }
    const view = this.get(itemID)
    if (view) { view.message = uiText('已暂停，保留已收到的内容。', 'Paused; received content is retained.'); view.resumable = true; this.emit() }
  }
  /** 继续同一未完成任务；已完成任务才创建新的模型操作。 */
  async start(itemID: number, automatic = false) {
    if (this.disposed || this.controllers.has(itemID)) return
    const controller = new AbortController()
    this.controllers.set(itemID, controller)
    const operation = (async () => {
    try {
      await this.ready
      const task = this.taskFor(itemID) ?? newAnalysisTask(itemID)
      this.tasks.set(task.id, task)
      await this.cancellations.get(task.id)
      if (controller.signal.aborted) {
        task.pauseReason = controller.signal.reason === 'shutdown' || controller.signal.reason === 'configuration' ? controller.signal.reason : 'user'
        task.status = task.pauseReason === 'user' ? 'paused' : 'waiting'
        this.show(task); await this.save(task); this.emit(); return
      }
      // 恢复轮询不能授予新收费操作；只有用户继续可承接已确认取消或余额拒绝的执行。
      if (!automatic && (task.pauseReason === 'user' || task.status === 'needs_action')) task.resumeRequested = true
      delete task.pauseReason
      await this.execute(task, controller)
    } finally { this.controllers.delete(itemID) }
    })()
    this.active.set(itemID, operation)
    try { await operation } finally { if (this.active.get(itemID) === operation) this.active.delete(itemID) }
  }
  private schedule(task: AnalysisTask, immediate = false) {
    if (this.disposed || task.pauseReason === 'user' || this.timers.has(task.id)) return
    const backoff = immediate ? 0 : this.options.retryDelay ?? Math.min(300_000, 5000 * 2 ** Math.min(task.retries ?? 0, 6)) + Math.floor(Math.random() * 1000)
    const delay = Math.max(backoff, (task.retryAt ?? 0) - Date.now())
    task.retryAt = Date.now() + delay
    this.timers.set(task.id, setTimeout(() => {
      this.timers.delete(task.id)
      if (!this.disposed && task.pauseReason !== 'user') void this.start(task.itemID, true)
    }, delay))
    // 退避期限也属于检查点；重启后不能把持续故障重新变成无间隔请求。
    void this.save(task)
  }
  private async execute(task: AnalysisTask, controller: AbortController) {
    const signal = controller.signal
    clearTimeout(this.timers.get(task.id)); this.timers.delete(task.id)
    delete task.retryAt
    delete task.deliveryError
    task.status = 'running'
    const view = this.show(task); this.emit()
    try {
      // 完整模型结果后的工作仅使用本地来源与批注，不依赖账号网络或当前模型。
      if (task.generation !== 'complete') {
        const context = await analysisStage(signal, uiText('检查解析配置', 'Checking analysis configuration'), 30_000,
          child => this.options.context?.(child) ?? analysisContext(this.host, this.network(), child))
        if (task.account && (task.account !== context.account || task.configuration !== context.configuration)) {
          throw Object.assign(new Error('Analysis configuration changed'), { code: 'CONFIG_CHANGED' })
        }
        Object.assign(task, context)
      }
      if (!(await this.save(task))) throw new AnalysisStorageError()
      signal.throwIfAborted()
      if (!task.snapshot) {
        const source = await analysisStage(signal, uiText('准备文献', 'Preparing document'), 120_000,
          () => collectSourceForItem(this.host, task.itemID, { includeText: false }))
        signal.throwIfAborted()
        if (source?.kind === 'file') view.source = { ...source, title: source.parentItem?.title || source.title, authors: [] }
      }
      // 参考文献初始化也属于可选任务边界，不能阻断核心总结。
      try {
        const jobs = documentJobs(this.host)
        view.references = { running: true, message: uiText('正在读取参考文献…', 'Reading references…') }
        void jobs.start('references', task.itemID, false, { signal }).then(reference => {
          task.referenceTaskID = reference.id; view.referenceTaskID = reference.id
          if (task.record) { task.record.referenceTaskID = reference.id; try { if (this.host.Prefs) appendPaperAnalysisRecord(this.host.Prefs, task.record) } catch { /* 可选关联。 */ } }
          void this.save(task)
          if (signal.aborted) jobs.pause(reference.id)
        }).catch(() => { view.references = { running: false, error: uiText('参考文献暂不可用，解析继续。', 'References unavailable; analysis continues.') } })
          .finally(() => { if (view.references) view.references.running = false; this.emit() })
      } catch { view.references = { running: false, error: uiText('参考文献暂不可用，解析继续。', 'References unavailable; analysis continues.') } }
      const result = await this.run({ zotero: this.host, itemID: task.itemID, signal, fetchImpl: this.network(), task, checkpoint: value => this.save(value),
        referenceTaskID: task.referenceTaskID,
        onProgress: message => { if (!signal.aborted) { view.message = message; this.emit() } },
        onRetry: retrying => { view.retrying = retrying; this.emit() } })
      task.record = result.record; this.retained.set(result.record.id, result.record); view.source = result.record.source
      if (!signal.aborted) {
        task.status = result.continuation ?? 'complete'
        if (!result.historySaved || result.historyError) task.storageWarning = true
        task.deliveryError = result.historyError || result.annotationError
          || (result.annotations.failed || result.annotations.unprocessed
            ? uiText('原生批注未能全部写入；解析笔记已保留，可展开查看和复制。', 'Some native annotations could not be written. Expand the retained analysis notes to review or copy them.')
            : !result.historySaved ? uiText('解析内容已保留，请查看结果提示。', 'Analysis retained; review the result notices.') : undefined)
      }
    } catch (error) {
      if (!signal.aborted) {
        task.issue = requestIssue(error, { code: 'ANALYSIS_FAILED' })
        const retryAfter = (error as { retryAfter?: string | null })?.retryAfter
        if (task.issue.status === 429 && retryAfter) {
          const seconds = Number(retryAfter), until = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter)
          if (Number.isFinite(until)) task.retryAt = until
        }
        const retryable = error instanceof AnalysisStorageError || task.issue.status === 429 || (task.issue.status ?? 0) >= 500
          || ['ANALYSIS_TIMEOUT', 'RECOVERY_PENDING', 'NETWORK_ERROR', 'STREAM_EARLY_EOF', 'STREAM_FAILED', 'STREAM_INCOMPLETE'].includes(task.issue.code ?? '')
          || (error as { name?: string })?.name === 'TypeError'
        task.status = retryable && !(task.route === 'byok' && task.generation === 'pending' && !(error instanceof AnalysisStorageError) && task.issue.status !== 429) ? 'waiting' : 'needs_action'
      }
    } finally {
      if (!(await this.save(task)) && task.status === 'complete') { task.status = 'waiting'; task.issue = { code: 'ANALYSIS_STORAGE' } }
      Object.assign(view, analysisViewState(task))
      if (task.status === 'waiting' && !this.disposed) { task.retries = (task.retries ?? 0) + 1; this.schedule(task) }
      this.emit()
    }
  }
  async dispose() {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const id of this.controllers.keys()) this.stop(id, 'shutdown')
    for (const id of this.observers) this.host.Prefs?.unregisterObserver?.(id)
    this.listeners.clear()
    await Promise.allSettled([...this.active.values(), ...this.cancellations.values()])
    await Promise.allSettled([...this.tasks.values()].map(task => this.save(task)))
  }
}
type Host = ZoteroLike & { __jadenseAnalysisRuntime?: AnalysisRuntime }
export function analysisRuntime(host: ZoteroLike) { return (host as Host).__jadenseAnalysisRuntime ??= new AnalysisRuntime(host) }
export function stopAnalysisRuntime(host: ZoteroLike) { const runtime = (host as Host).__jadenseAnalysisRuntime; delete (host as Host).__jadenseAnalysisRuntime; return runtime?.dispose() ?? Promise.resolve() }
