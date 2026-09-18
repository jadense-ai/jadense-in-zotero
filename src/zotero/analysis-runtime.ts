/** 阅读器解析任务归插件所有；工具条与成果视图只订阅，不因窗口关闭中断生成。 */
import { appendPaperAnalysisRecord, readPaperAnalysisHistory, type PaperAnalysisRecord } from '@/chat/paper-analysis-history'
import { runIndependentPaperAnalysis } from './paper-analysis-runner'
import { collectSourceForItem } from './research-context'
import { documentJobs } from './document-jobs'
import type { AnalysisRunView } from './analysis-workspace'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { markDiagnosticAbort } from './diagnostics'
import { FEATURE_MODEL_PREF_KEYS, AUTO_FOLLOW_CHAT_MODEL_PREF_KEY } from './ai-settings'

export class AnalysisRuntime {
  private runs = new Map<number, AnalysisRunView>()
  private controllers = new Map<number, AbortController>()
  private retained = new Map<string, PaperAnalysisRecord>()
  private listeners = new Set<() => void>()
  private observers: unknown[] = []
  constructor(private host: ZoteroLike, private run = runIndependentPaperAnalysis) {
    for (const key of ['extensions.jadenseInZotero.token', 'extensions.jadenseInZotero.baseUrl', 'extensions.jadenseInZotero.byokConfig', AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, FEATURE_MODEL_PREF_KEYS.analysis]) {
      try {
        const id = host.Prefs?.registerObserver?.(key, () => { for (const itemID of this.controllers.keys()) this.stop(itemID) })
        if (id !== undefined) this.observers.push(id)
      } catch { /* 旧宿主可能不支持偏好监听。 */ }
    }
  }
  get(itemID: number) { return this.runs.get(itemID) }
  list() { return [...this.runs.values()] }
  records() { return [...new Map([...(this.host.Prefs ? readPaperAnalysisHistory(this.host.Prefs).records : []), ...this.retained.values()].map(record => [record.id, record])).values()] }
  unsaved(id: string) { return this.retained.has(id) }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private emit() { for (const fn of this.listeners) { try { fn() } catch { /* 展示失败不影响生成和保存。 */ } } }
  stop(itemID: number) {
    const controller = this.controllers.get(itemID)
    if (controller) { markDiagnosticAbort(controller.signal, 'user_stop'); controller.abort() }
    const view = this.get(itemID)
    if (view?.busy) { view.message = uiText('正在停止，保留已收到的内容…', 'Stopping; retaining received content…'); this.emit() }
  }
  /** 同一附件的重复点击只复用运行；不同 PDF 状态互不覆盖。 */
  async start(itemID: number) {
    if (this.controllers.has(itemID)) return
    const controller = new AbortController(), signal = controller.signal
    this.controllers.set(itemID, controller)
    const view: AnalysisRunView = { source: { itemID, libraryID: -1, itemKey: '', title: 'PDF', authors: [] }, busy: true, createdAt: new Date().toISOString(), message: uiText('正在准备文献解析…', 'Preparing analysis…') }
    this.runs.set(itemID, view); this.emit()
    let resultID: string | undefined
    const linkReferences = () => {
      const record = this.records().find(value => value.id === resultID)
      if (!record || !view.referenceTaskID) return
      const linked = { ...record, referenceTaskID: view.referenceTaskID }
      if (this.retained.has(record.id)) this.retained.set(record.id, linked)
      else try { if (this.host.Prefs) appendPaperAnalysisRecord(this.host.Prefs, linked) } catch { /* 可选关联不影响完整结果。 */ }
    }
    try {
      const source = await new Promise<Awaited<ReturnType<typeof collectSourceForItem>>>((resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        collectSourceForItem(this.host, itemID, { includeText: false }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
      signal.throwIfAborted()
      if (source?.kind === 'file') view.source = { ...source, title: source.parentItem?.title || source.title, authors: [] }
      const jobs = documentJobs(this.host)
      view.references = { running: true, message: uiText('正在读取参考文献…', 'Reading references…') }
      void jobs.start('references', itemID, false, { signal, onProgress: message => { view.references = { running: true, message }; this.emit() } }).then(task => {
        view.referenceTaskID = task.id
        linkReferences()
        if (signal.aborted) jobs.pause(task.id)
        else if (['paused', 'error'].includes(task.status)) jobs.resume(task.id)
      }).catch(error => { view.references = { running: false, error: signal.aborted ? uiText('参考文献提取已停止', 'Reference extraction stopped') : String(error) } }).finally(() => { if (view.references) view.references.running = false; this.emit() })
      signal.addEventListener('abort', () => { if (view.referenceTaskID) jobs.pause(view.referenceTaskID) }, { once: true })
      const win = this.host.getMainWindow?.()
      const result = await this.run({ zotero: this.host, itemID, signal, fetchImpl: win?.fetch.bind(win) ?? globalThis.fetch.bind(globalThis),
        onProgress: message => { if (!signal.aborted) { view.message = message; this.emit() } },
      })
      view.source = result.record.source
      if (!result.historySaved || result.historyError) this.retained.set(result.record.id, result.record)
      resultID = result.record.id; linkReferences()
      view.error = !result.historySaved || Boolean(result.historyError) || Boolean(result.annotationError) || Boolean(result.record.warnings?.length) || signal.aborted
      view.message = result.historyError || (view.error ? uiText('解析内容已保留，请查看结果提示。', 'Analysis retained; review the result notices.') : uiText('解析完成，总结与笔记已保存。', 'Analysis complete. Summary and notes saved.'))
    } catch (error) {
      view.error = true
      view.message = signal.aborted ? uiText('解析已停止，已有结果仍可阅读。', 'Analysis stopped. Existing results remain readable.') : error instanceof Error ? error.message : String(error)
    } finally { view.busy = false; this.controllers.delete(itemID); this.emit() }
  }
  dispose() { for (const id of this.controllers.keys()) this.stop(id); for (const id of this.observers) this.host.Prefs?.unregisterObserver?.(id); this.listeners.clear() }
}
type Host = ZoteroLike & { __jadenseAnalysisRuntime?: AnalysisRuntime }
export function analysisRuntime(host: ZoteroLike) { return (host as Host).__jadenseAnalysisRuntime ??= new AnalysisRuntime(host) }
export function stopAnalysisRuntime(host: ZoteroLike) { (host as Host).__jadenseAnalysisRuntime?.dispose(); delete (host as Host).__jadenseAnalysisRuntime }
