/**
 * 解析专用检查点：插件运行时拥有调度，runner 保存来源快照、模型终态和原生写入账本。
 * 只保存非敏感账号摘要与语义配置，不保存凭据；身份落盘失败时不得开始新的收费请求或原生写入。
 */
import type { PaperAnalysisRecord } from '@/chat/paper-analysis-history'
import type { RequestIssue } from '@/chat/request-feedback'
import type { PdfAnalysisSnapshot, AnalysisAnnotationLedger } from './reader-tools'
import { uiText } from './ui-preferences'

export type AnalysisTask = {
  version: 1; id: string; itemID: number; createdAt: string
  status: 'queued' | 'running' | 'waiting' | 'paused' | 'needs_action' | 'complete'
  stage: 'preparing' | 'generating' | 'annotations' | 'complete'
  account?: string; configuration?: string; route?: 'jadense' | 'byok'
  requestID: string; previousRequestID?: string; generation: 'new' | 'pending' | 'complete' | 'terminal'
  operationID?: string; repair?: { attempt: number; retained: string }
  snapshot?: PdfAnalysisSnapshot; response?: string; record?: PaperAnalysisRecord
  annotations: AnalysisAnnotationLedger
  referenceTaskID?: string; issue?: RequestIssue; retries?: number; retryAt?: number
  pauseReason?: 'user' | 'shutdown' | 'configuration'; storageWarning?: boolean
  /** 已确认的历史/批注交付错误；与覆盖范围提示分离，冷启动仍可反馈。 */
  deliveryError?: string
  resumeRequested?: boolean
}
type IO = {
  makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>
  writeUTF8(path: string, text: string, options: { tmpPath: string }): Promise<unknown>
  readUTF8(path: string): Promise<string>; getChildren(path: string): Promise<string[]>
}
type Paths = { profileDir: string; join(...parts: string[]): string; filename(path: string): string }
const validID = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(value)

export function newAnalysisTask(itemID: number): AnalysisTask {
  return { version: 1, id: crypto.randomUUID(), itemID, createdAt: new Date().toISOString(), status: 'queued', stage: 'preparing',
    requestID: crypto.randomUUID(), generation: 'new', annotations: {} }
}

/** 原子串行写入并保留未落盘副本；同一存储实例中失败不会把完整模型结果回退到 pending。 */
export class AnalysisTaskStore {
  private cache = new Map<string, AnalysisTask>()
  private writes = new Map<string, Promise<boolean>>()
  constructor(private io = (globalThis as unknown as { IOUtils?: IO }).IOUtils,
    private paths = (globalThis as unknown as { PathUtils?: Paths }).PathUtils) {}
  private path(id?: string) {
    if (!this.paths || id && !validID(id)) throw new Error('Analysis storage unavailable')
    return this.paths.join(this.paths.profileDir, 'jadense-analysis-tasks', ...(id ? [`${id}.json`] : []))
  }
  async save(task: AnalysisTask): Promise<boolean> {
    const snapshot = structuredClone(task)
    this.cache.set(task.id, snapshot)
    const write = (this.writes.get(task.id) ?? Promise.resolve(true)).then(async () => {
      try {
        if (!this.io) return false
        await this.io.makeDirectory(this.path(), { ignoreExisting: true })
        const path = this.path(task.id)
        await this.io.writeUTF8(path, JSON.stringify(snapshot), { tmpPath: `${path}.tmp` })
        return true
      } catch { return false }
    })
    this.writes.set(task.id, write)
    try { return await write } finally { if (this.writes.get(task.id) === write) this.writes.delete(task.id) }
  }
  async list(): Promise<AnalysisTask[]> {
    const tasks = new Map(this.cache)
    try {
      for (const path of await this.io!.getChildren(this.path())) {
        const name = this.paths!.filename(path), id = name.replace(/\.json$/u, '')
        if (!name.endsWith('.json') || !validID(id) || tasks.has(id)) continue
        try {
          const task = JSON.parse(await this.io!.readUTF8(this.path(id))) as AnalysisTask
          // 已有任务的派发身份不可猜测；坏记录单独跳过，不影响其他文献或只读历史。
          if (task.version !== 1 || task.id !== id || !Number.isSafeInteger(task.itemID) || task.itemID < 1 || !validID(task.requestID)
            || !['new', 'pending', 'complete', 'terminal'].includes(task.generation)
            || !['preparing', 'generating', 'annotations', 'complete'].includes(task.stage)) continue
          if (!['queued', 'running', 'waiting', 'paused', 'needs_action', 'complete'].includes(task.status)) task.status = 'needs_action'
          if (typeof task.createdAt !== 'string') task.createdAt = new Date(0).toISOString()
          if (!task.annotations || typeof task.annotations !== 'object' || Array.isArray(task.annotations)) task.annotations = {}
          if (task.generation === 'complete' && typeof task.response !== 'string') task.status = 'needs_action'
          tasks.set(id, task)
        } catch { /* 一个损坏文件不阻断其他任务。 */ }
      }
    } catch { /* 首次使用尚无目录；创建身份前仍必须验证实际写入。 */ }
    return [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

export class AnalysisStorageError extends Error {
  readonly code = 'ANALYSIS_STORAGE'
  constructor() { super(uiText('解析进度尚未保存；正在保留结果并重试本地保存。', 'Analysis progress is not saved; retaining results and retrying local storage.')) }
}
