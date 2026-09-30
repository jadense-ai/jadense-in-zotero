import type { RequestIssue, RequestProgress } from '@/chat/request-feedback'
/** 简阅译文独立 profile 存储；单文件原子提交块结果和请求身份，跨窗口共享实例。 */
import { requestHash } from '@/chat/temporary-request-store'
import type { TranslationLanguages } from '@/chat/translation-languages'
import type { DocumentIdentity } from './pdf-document'
import { pdfPlatform } from './pdf-translation-runtime'
import { SIMPLE_READING_STRATEGY, validBlockOutput, type ReadingBlock } from './simple-reading-blocks'

export type ReadingIdentity = { source: DocumentIdentity; fingerprint: string; sdtHash: string; contentHash: string }
export type ReadingRequest = { id: string; operation: string; blocks: ReadingBlock[]; state: 'pending' | 'complete' | 'failed'; output?: Record<string, string>; single?: boolean; promptVersion?: 2 }
export type ReadingTask = ReadingIdentity & {
  version: 1; strategy: string; id: string; createdAt: string; languages: TranslationLanguages; configuration: string
  status: 'running' | 'partial' | 'complete' | 'cancelled' | 'interrupted'; outputs: Record<string, string>; requests: ReadingRequest[]
  progress?: RequestProgress & { stageStartedAt: number }; issue?: RequestIssue
  total: number; error?: string; storageWarning?: boolean; metrics?: { firstBlockMs?: number; totalMs: number; requests: number }
}
export function sameReadingSource(a: ReadingIdentity, b: ReadingIdentity) {
  return a.source.itemID === b.source.itemID && a.source.libraryID === b.source.libraryID && a.source.itemKey === b.source.itemKey
    && a.fingerprint === b.fingerprint && a.sdtHash === b.sdtHash && a.contentHash === b.contentHash
}
export const readingIdentityKey = (value: ReadingIdentity, languages: TranslationLanguages) => requestHash(JSON.stringify([
  value.source.libraryID, value.source.itemKey, value.source.itemID, value.fingerprint, value.sdtHash, value.contentHash, languages, SIMPLE_READING_STRATEGY,
]))

export class SimpleReadingStore {
  private tails = new Map<string, Promise<void>>()
  private platform = pdfPlatform()
  constructor(platform = pdfPlatform()) { this.platform = platform }
  private root() { const p = this.platform.PathUtils; return p.join(p.profileDir, 'jadense-simple-reading') }
  private file(id: string) {
    // 文件路径只接受本模块生成的摘要，保护 profile 目录边界。
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid reading task identity')
    return this.platform.PathUtils.join(this.root(), `${id}.json`)
  }
  async save(task: ReadingTask) {
    const file = this.file(task.id), text = JSON.stringify(task), io = this.platform.IOUtils
    const next = (this.tails.get(task.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await io.makeDirectory(this.root(), { ignoreExisting: true }); await io.writeUTF8(file, text, { tmpPath: `${file}.tmp` })
    })
    this.tails.set(task.id, next)
    try { await next } finally { if (this.tails.get(task.id) === next) this.tails.delete(task.id) }
  }
  async list(): Promise<ReadingTask[]> {
    const io = this.platform.IOUtils, paths = this.platform.PathUtils
    if (!await io.exists(this.root())) return []
    const tasks: ReadingTask[] = []
    for (const file of await io.getChildren(this.root())) {
      if (!/^[a-f0-9]{64}\.json$/u.test(paths.filename(file))) continue
      try {
        const value = JSON.parse(await io.readUTF8(file))
        if (value.version !== 1 || `${value.id}.json` !== paths.filename(file) || !Number.isSafeInteger(value.source?.itemID)
          || !Number.isSafeInteger(value.source?.libraryID) || typeof value.source?.itemKey !== 'string'
          || ![value.fingerprint, value.sdtHash, value.contentHash].every(v => typeof v === 'string') || typeof value.languages?.targetLanguage !== 'string') continue
        const outputs = Object.fromEntries(Object.entries(value.outputs ?? {}).filter(([id, text]) => /^\d+(?:\.\d+)*$/u.test(id) && typeof text === 'string')) as Record<string, string>
        const requests = Array.isArray(value.requests) ? value.requests.filter((r: ReadingRequest) => typeof r.id === 'string' && typeof r.operation === 'string' && Array.isArray(r.blocks) && r.blocks.every(b => typeof b.id === 'string' && typeof b.text === 'string')) : []
        tasks.push({ ...value, createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
          strategy: typeof value.strategy === 'string' ? value.strategy : '', configuration: typeof value.configuration === 'string' ? value.configuration : '',
          total: Number.isSafeInteger(value.total) && value.total >= 0 ? value.total : Object.keys(outputs).length,
          outputs, requests, status: ['complete', 'partial', 'cancelled'].includes(value.status) ? value.status : 'interrupted' })
      } catch { /* 损坏记录只影响本版本，其他成果继续展示。 */ }
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

/** 内容摘要已匹配仍逐块校验缓存，以容纳单个损坏块并补译。 */
export function usableReadingOutputs(task: ReadingTask, blocks: ReadingBlock[]) {
  return Object.fromEntries(blocks.filter(block => validBlockOutput(block, task.outputs[block.id])).map(block => [block.id, task.outputs[block.id]]))
}
