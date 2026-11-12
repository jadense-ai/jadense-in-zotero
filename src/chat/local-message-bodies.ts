/** 长消息正文位于profile专用文件；Prefs仅保存预览与UUID，失败保留内存，不截断实际请求。 */
import { normalizeLocalChatImage } from './image-input'

type BodyMessage = { text: string; textRef?: string }
type IO = { makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; writeUTF8(path: string, text: string, options?: { tmpPath: string }): Promise<unknown>; readUTF8(path: string): Promise<string>; getChildren?(path: string): Promise<string[]>; remove?(path: string): Promise<unknown> }
type Paths = { profileDir: string; join(...parts: string[]): string }
export const MESSAGE_PREVIEW_CHARS = 20000
const UNAVAILABLE_NOTICE = '\n\n【本地长消息正文暂不可用，当前仅显示预览】'
const validRef = (value: unknown) => normalizeLocalChatImage({ id: value })?.id

export class LocalMessageBodies {
  private cache = new Map<string, string>()
  private writes = new Map<string, Promise<void>>()
  private failed = new Set<string>()
  private cleanup = Promise.resolve()
  private failureListeners = new Set<() => void>()
  subscribeFailures(listener: () => void) { this.failureListeners.add(listener); return () => { this.failureListeners.delete(listener) } }
  hasFailures(messages: readonly BodyMessage[]) { return messages.some(message => Boolean(message.textRef && this.failed.has(message.textRef))) }
  constructor(private platform = () => globalThis as unknown as { IOUtils?: IO; PathUtils?: Paths }) {}
  private path(id: string) {
    const { IOUtils: io, PathUtils: paths } = this.platform()
    if (!io || !paths) throw new Error('Message body storage unavailable')
    const directory = paths.join(paths.profileDir, 'jadense-chat-message-bodies')
    return { io, directory, path: paths.join(directory, `${id}.txt`) }
  }
  restore(message: BodyMessage): BodyMessage {
    const id = validRef(message.textRef)
    return { text: id ? this.cache.get(id) ?? (message.text.endsWith(UNAVAILABLE_NOTICE) ? message.text : message.text + UNAVAILABLE_NOTICE) : message.text, ...(id ? { textRef: id } : {}) }
  }
  /** 冷启动未读到正文时绝不拿预览覆盖原文件；写入串行，迟到旧流不能覆盖新正文。 */
  project(message: BodyMessage): BodyMessage {
    if (!message.textRef && message.text.length <= MESSAGE_PREVIEW_CHARS) return message
    const previous = validRef(message.textRef), id = previous ?? crypto.randomUUID()
    if (!previous || this.cache.has(id)) {
      if (this.cache.get(id) !== message.text || this.failed.has(id)) {
        this.cache.set(id, message.text)
        const text = message.text
        const pending = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
          const { io, directory, path } = this.path(id)
          await io.makeDirectory(directory, { ignoreExisting: true })
          await io.writeUTF8(path, text, { tmpPath: `${path}.tmp` })
        })
        this.writes.set(id, pending)
        void pending.then(() => this.failed.delete(id), () => {
          this.failed.add(id)
          for (const listener of this.failureListeners) { try { listener() } catch { /* 可选展示不影响正文。 */ } }
        }).finally(() => { if (this.writes.get(id) === pending) this.writes.delete(id) })
      }
    }
    return { text: message.text.slice(0, MESSAGE_PREVIEW_CHARS), textRef: id }
  }
  async hydrate(messages: readonly BodyMessage[]) {
    await Promise.all(messages.map(async message => {
      const id = validRef(message.textRef)
      if (!id || this.cache.has(id)) return
      try { const { io, path } = this.path(id); const text = await io.readUTF8(path); if (!this.cache.has(id)) this.cache.set(id, text) } catch { /* 丢失文件仅保留可读预览。 */ }
    }))
  }
  async flush() { await Promise.allSettled(this.writes.values()) }
  /** 删除会话后仅清理本插件无引用UUID文件，实时复核引用，避免跨窗口迟到清理删除新正文。 */
  prune(retained: () => readonly BodyMessage[]) {
    this.cleanup = this.cleanup.then(async () => {
      await this.flush()
      const used = (id: string) => retained().some(message => message.textRef === id)
      for (const id of this.cache.keys()) if (!used(id) && !this.writes.has(id)) { this.cache.delete(id); this.failed.delete(id) }
      try {
        const { io, directory } = this.path(crypto.randomUUID())
        for (const file of await io.getChildren?.(directory) ?? []) {
          const name = file.split(/[\\/]/u).at(-1) ?? '', id = name.endsWith('.txt') ? validRef(name.slice(0, -4)) : undefined
          if (id && !used(id) && !this.writes.has(id)) await io.remove?.(this.path(id).path)
        }
      } catch { /* 可选维护不能影响会话CRUD。 */ }
    }).catch(() => {})
    return this.cleanup
  }
}
export let localMessageBodies = new LocalMessageBodies()
/** Manager/Reader在不同bundle中运行，但同一Zotero宿主只拥有一份正文缓存。 */
export function bindLocalMessageBodies(host: object) {
  const owner = host as { __jadenseMessageBodiesV1?: LocalMessageBodies }
  localMessageBodies = owner.__jadenseMessageBodiesV1 ??= new LocalMessageBodies()
  return localMessageBodies
}
