/** profile 专用任务目录：摘要与逐页正文分开，原子替换；失败时会话缓存保留可读成果。 */
import type { ReferenceEntry } from "@/chat/reference-list"
import { normalizeTranslationLanguages, type TranslationLanguages } from "@/chat/translation-languages"
import type { DocumentIdentity, DocumentPage } from "./pdf-document"
import type { TranslationReadingIndex, TranslationReadingPosition } from "./translation-reading"

export type DocumentTask = {
  referenceAI?: { unavailable?: boolean; pausedReason?: string; batches: Array<{ id: string; requestId: string; previousRequestId?: string; entryIds: string[]; prompt: string; model: string; status: 'pending' | 'complete' | 'failed' }> }
  version: 1; id: string; kind: "translation" | "references"; source: DocumentIdentity; createdAt: string
  status: "running" | "paused" | "complete" | "partial" | "error"; totalPages: number; completed: number; total: number
  languages?: TranslationLanguages; models: string[]; warnings: string[]; storageWarning?: boolean; error?: string; extractionVersion?: number
}
export type TranslationPage = DocumentPage & { translations: Record<string, string>; pieces: Array<{ id: string; paragraphID: string; text: string }> }
export type TaskIO = {
  makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>
  writeUTF8(path: string, text: string, options?: { tmpPath: string }): Promise<unknown>
  readUTF8(path: string): Promise<string>; getChildren(path: string): Promise<string[]>
  remove(path: string): Promise<unknown>
}
type Paths = { profileDir: string; join(...parts: string[]): string; filename(path: string): string }
const validID = (id: string) => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(id)

export class DocumentStore {
  private writes = new Map<string, Promise<boolean>>()
  private cache = new Map<string, unknown>()
  constructor(private io?: TaskIO, private paths?: Paths) {
    const host = globalThis as typeof globalThis & { IOUtils?: TaskIO; PathUtils?: Paths }
    this.io ??= host.IOUtils; this.paths ??= host.PathUtils
  }
  private path(id?: string, name?: string) {
    if (!this.paths || (id && !validID(id))) throw new Error("Local document storage unavailable")
    return this.paths.join(this.paths.profileDir, "jadense-document-tasks", ...(id ? [id] : []), ...(name ? [name] : []))
  }
  private async write(id: string, name: string, value: unknown): Promise<boolean> {
    const key = `${id}/${name}`, snapshot = structuredClone(value)
    this.cache.set(key, snapshot)
    const operation = (this.writes.get(key) ?? Promise.resolve(true)).then(async () => {
    try {
      if (!this.io) return false
      await this.io.makeDirectory(this.path(), { ignoreExisting: true })
      await this.io.makeDirectory(this.path(id), { ignoreExisting: true })
      const path = this.path(id, name)
      await this.io.writeUTF8(path, JSON.stringify(snapshot), { tmpPath: `${path}.tmp` })
      if (this.cache.get(key) === snapshot) this.cache.delete(key)
      return true
    } catch { return false }
    })
    this.writes.set(key, operation)
    try { return await operation } finally { if (this.writes.get(key) === operation) this.writes.delete(key) }
  }
  private async read<T>(id: string, name: string): Promise<T | null> {
    const key = `${id}/${name}`
    if (this.cache.has(key)) return structuredClone(this.cache.get(key)) as T
    try { const value = JSON.parse(await this.io!.readUTF8(this.path(id, name))); return value as T } catch { return null }
  }
  async save(task: DocumentTask) { const saved = await this.write(task.id, "task.json", task); task.storageWarning ||= !saved; return saved }
  async page(id: string, index: number) {
    if (!Number.isSafeInteger(index) || index < 0) return null
    const value = await this.read<TranslationPage>(id, `page-${index}.json`)
    return value && value.pageIndex === index && Array.isArray(value.paragraphs) && value.paragraphs.every(row => row && typeof row.id === "string" && typeof row.text === "string" && Array.isArray(row.rects))
      && Array.isArray(value.pieces) && value.pieces.every(row => row && typeof row.id === "string" && typeof row.text === "string" && typeof row.paragraphID === "string")
      && value.translations && typeof value.translations === "object" ? value : null
  }
  savePage(id: string, page: TranslationPage) { return this.write(id, `page-${page.pageIndex}.json`, page) }
  saveReadingIndex(id: string, index: TranslationReadingIndex) { return this.write(id, "reading.json", index) }
  async readingIndex(id: string): Promise<TranslationReadingIndex | null> {
    const value = await this.read<TranslationReadingIndex>(id, "reading.json")
    return value?.version === 1 && Array.isArray(value.blocks) && value.blocks.every(block => block && typeof block.id === "string"
      && Number.isSafeInteger(block.pageIndex) && typeof block.paragraphID === "string" && Array.isArray(block.pieceIDs)) ? value : null
  }
  saveReadingPosition(id: string, position: TranslationReadingPosition) { return this.write(id, "reading-position.json", position) }
  async readingPosition(id: string): Promise<TranslationReadingPosition | null> {
    const value = await this.read<TranslationReadingPosition>(id, "reading-position.json")
    return value && typeof value.blockID === "string" && Number.isFinite(value.offset) ? value : null
  }
  async references(id: string) { const value = await this.read<ReferenceEntry[]>(id, "references.json"); return Array.isArray(value) ? value.filter(row => row && typeof row.raw === "string" && Array.isArray(row.lines) && row.fields) : [] }
  saveReferences(id: string, entries: ReferenceEntry[]) { return this.write(id, "references.json", entries) }
  async list(): Promise<DocumentTask[]> {
    const ids = new Set([...this.cache.keys()].map(key => key.split("/")[0]))
    try { for (const path of await this.io!.getChildren(this.path())) { const id = this.paths!.filename(path); if (validID(id)) ids.add(id) } } catch { /* 首次使用无目录。 */ }
    const result: DocumentTask[] = []
    for (const id of ids) {
      const task = await this.read<DocumentTask>(id, "task.json")
      if (task && task.id === id && (task.kind === "translation" || task.kind === "references") && task.source
        && Number.isSafeInteger(task.source.itemID) && Number.isSafeInteger(task.source.libraryID) && typeof task.source.itemKey === "string"
        && Number.isSafeInteger(task.totalPages) && task.totalPages >= 0 && Array.isArray(task.models) && Array.isArray(task.warnings)) {
        // 摘要的可选展示字段逐项降级；一条损坏清单不能令整个历史排序或初始化失败。
        task.createdAt = typeof task.createdAt === "string" ? task.createdAt : new Date(0).toISOString()
        task.source.title = typeof task.source.title === "string" ? task.source.title : "PDF"
        task.total = Number.isSafeInteger(task.total) && task.total >= 0 ? task.total : 0
        task.completed = Number.isSafeInteger(task.completed) && task.completed >= 0 ? task.completed : 0
        if (!["running", "paused", "complete", "partial", "error"].includes(task.status)) task.status = "error"
        if (task.kind === "translation") task.languages = normalizeTranslationLanguages(task.languages)
        if (task.referenceAI && (!Array.isArray(task.referenceAI.batches) || !task.referenceAI.batches.every(batch => batch && typeof batch.id === 'string' && typeof batch.requestId === 'string' && typeof batch.prompt === 'string' && typeof batch.model === 'string' && Array.isArray(batch.entryIds) && batch.entryIds.every(id => typeof id === 'string') && ['pending','complete','failed'].includes(batch.status)))) {
          task.referenceAI = { unavailable: true, pausedReason: 'AI 批次身份记录损坏；原文与非 AI 核验仍可使用。', batches: [] }
        }
        result.push(task)
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async delete(id: string) {
    if (!validID(id)) return
    // 仅移除本任务生成的文件；无递归删除，也不接受模型路径。
    if (this.io && this.paths) {
      let paths: string[] = []
      try { paths = await this.io.getChildren(this.path(id)) } catch { /* 未落盘记录没有目录。 */ }
        for (const path of paths.sort((a, b) => Number(this.paths!.filename(a) === "task.json") - Number(this.paths!.filename(b) === "task.json"))) {
          const name = this.paths.filename(path)
          if (/^(task|references|reading|reading-position|page-\d+)\.json(?:\.tmp)?$/u.test(name)) await this.io.remove(this.path(id, name))
        }
    }
    for (const key of this.cache.keys()) if (key.startsWith(`${id}/`)) this.cache.delete(key)
  }
}
