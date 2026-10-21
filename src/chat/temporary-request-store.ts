/** 本地临时请求日志：身份先落盘再联网，正文与回执不写入偏好或日志；不保存令牌。 */
import { uiText } from '@/zotero/ui-preferences'
export type LocalTemporaryRequest = {
  id: string; account: string; fingerprint: string; body: Record<string, unknown>; createdAt: string
  status: 'pending' | 'completed' | 'failed'; text?: string; error?: string
  resultState?: 'partial' | 'failed' | 'cancelled'; issue?: import('./request-feedback').RequestIssue
}
type IO = { makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; writeUTF8(path: string, text: string, options: { tmpPath: string }): Promise<unknown>; readUTF8(path: string): Promise<string>; getChildren(path: string): Promise<string[]> }
type Paths = { profileDir: string; join(...parts: string[]): string; filename(path: string): string }
// 同一宿主中短暂磁盘错误不丢弃已收到正文；磁盘 pending 仍是跨重启的执行围栏。
const buffers = new WeakMap<IO, Map<string, LocalTemporaryRequest>>()
const writers = new WeakMap<IO, Map<string, Promise<unknown>>>()
export class TemporaryRequestStore {
  constructor(private io = (globalThis as unknown as { IOUtils?: IO }).IOUtils, private paths = (globalThis as unknown as { PathUtils?: Paths }).PathUtils) {}
  private root() { if (!this.io || !this.paths) throw new Error(uiText('无法保存请求身份，请检查本地存储后继续。', 'Cannot persist request identity. Check local storage before continuing.')); return this.paths.join(this.paths.profileDir, 'jadense-ai-requests') }
  async list(scope?: { account: string; conversation: string }): Promise<LocalTemporaryRequest[]> {
    const root = this.root(); await this.io!.makeDirectory(root, { ignoreExisting: true })
    const rows: LocalTemporaryRequest[] = []
    // 目录用 96-bit 短摘要，记录内保留完整身份；避免 Windows profile 路径超过原生写入上限。
    const taskRoot = scope ? this.paths!.join(root, scope.account.slice(0, 24), (await requestHash(scope.conversation)).slice(0, 24)) : null
    if (taskRoot && scope) { await this.io!.makeDirectory(this.paths!.join(root, scope.account.slice(0, 24)), { ignoreExisting: true }); await this.io!.makeDirectory(taskRoot, { ignoreExisting: true }) }
    const taskRoots: string[] = taskRoot ? [taskRoot] : []
    if (!scope) for (const account of await this.io!.getChildren(root)) {
      if (!/^[a-f\d]{24}$/i.test(this.paths!.filename(account))) continue
      for (const task of await this.io!.getChildren(account)) if (/^[a-f\d]{24}$/i.test(this.paths!.filename(task))) taskRoots.push(task)
    }
    for (const directory of taskRoots) for (const path of await this.io!.getChildren(directory)) {
      const name = this.paths!.filename(path)
      if (!/^[a-f\d-]{36}\.json$/i.test(name)) continue
      try {
      const row = JSON.parse(await this.io!.readUTF8(this.paths!.join(directory, name))) as LocalTemporaryRequest
      // 已拥有的执行日志损坏可能丢失去重身份，不能把它当作从未执行后重新派发。
      if (row.id + '.json' !== name || typeof row.account !== 'string' || typeof row.fingerprint !== 'string' || !row.body || typeof row.body.clientRequestId !== 'string' || !['pending','completed','failed'].includes(row.status)) throw new Error(uiText('AI 请求身份日志损坏；请先恢复本地记录。', 'AI request identity is damaged. Restore the local record before continuing.'))
      if (typeof row.createdAt !== 'string') row.createdAt = '1970-01-01T00:00:00.000Z'
      if (row.status === 'completed' && typeof row.text !== 'string') row.status = 'pending'
      rows.push(row)
      } catch (error) { if (scope) throw error /* 历史浏览局部降级；只有该任务的新 AI 派发需要身份完整。 */ }
    }
    const merged = new Map(rows.map(row => [row.id, row]))
    for (const [path, row] of buffers.get(this.io!) ?? []) {
      if (!path.startsWith(`${root}|`) || scope && (row.account !== scope.account || row.body.temporaryConversationId !== scope.conversation)) continue
      // 只补本地保存；失败仍可将真实正文交给文档自己的检查点，不再次访问模型。
      await this.save(row).catch(() => {})
      merged.set(row.id, structuredClone(row))
    }
    return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async save(row: LocalTemporaryRequest) {
    if (!/^[a-f\d-]{36}$/i.test(row.id)) throw new Error('Invalid local request identity')
    if (!/^[a-f\d]{64}$/i.test(row.account) || typeof row.body.temporaryConversationId !== 'string') throw new Error('Invalid local request scope')
    const base = this.root(), account = this.paths!.join(base, row.account.slice(0, 24))
    const key = `${base}|${row.account}|${row.id}`
    let pending = buffers.get(this.io!)
    if (!pending) { pending = new Map(); buffers.set(this.io!, pending) }
    let tails = writers.get(this.io!)
    if (!tails) { tails = new Map(); writers.set(this.io!, tails) }
    const snapshot = structuredClone(row)
    pending.set(key, snapshot)
    const write = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const root = this.paths!.join(account, (await requestHash(String(snapshot.body.temporaryConversationId))).slice(0, 24))
      const path = this.paths!.join(root, `${snapshot.id}.json`)
      for (const directory of [base, account, root]) await this.io!.makeDirectory(directory, { ignoreExisting: true })
      await this.io!.writeUTF8(path, JSON.stringify(snapshot), { tmpPath: `${path}.tmp` })
      if (pending.get(key) === snapshot) pending.delete(key)
    })
    tails.set(key, write)
    try { await write } catch {
      throw Object.assign(new Error(uiText('请求记录尚未保存，将保留已有结果并重试保存。', 'The request record is not saved yet. Existing output is retained for a storage retry.')), { code: 'LOCAL_REQUEST_PERSISTENCE_FAILED' })
    } finally { if (tails.get(key) === write) tails.delete(key) }
  }
}
export async function requestHash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
