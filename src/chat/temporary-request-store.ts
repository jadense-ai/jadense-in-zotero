/** 本地临时请求日志：身份先落盘再联网，正文与回执不写入偏好或日志；不保存令牌。 */
import { uiText } from '@/zotero/ui-preferences'
export type LocalTemporaryRequest = {
  id: string; account: string; fingerprint: string; body: Record<string, unknown>; createdAt: string
  status: 'pending' | 'completed' | 'failed'; text?: string; error?: string
}
type IO = { makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; writeUTF8(path: string, text: string, options: { tmpPath: string }): Promise<unknown>; readUTF8(path: string): Promise<string>; getChildren(path: string): Promise<string[]> }
type Paths = { profileDir: string; join(...parts: string[]): string; filename(path: string): string }
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
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async save(row: LocalTemporaryRequest) {
    if (!/^[a-f\d-]{36}$/i.test(row.id)) throw new Error('Invalid local request identity')
    if (!/^[a-f\d]{64}$/i.test(row.account) || typeof row.body.temporaryConversationId !== 'string') throw new Error('Invalid local request scope')
    const base = this.root(), account = this.paths!.join(base, row.account.slice(0, 24))
    const root = this.paths!.join(account, (await requestHash(row.body.temporaryConversationId)).slice(0, 24))
    for (const directory of [base, account, root]) await this.io!.makeDirectory(directory, { ignoreExisting: true })
    const path = this.paths!.join(root, `${row.id}.json`)
    await this.io!.writeUTF8(path, JSON.stringify(row), { tmpPath: `${path}.tmp` })
  }
}
export async function requestHash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
