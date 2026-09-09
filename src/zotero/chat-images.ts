import { uiText } from "@/zotero/ui-preferences"
/**
 * Manager 图片附件存储：仅操作当前 profile 的专用目录，不访问用户原始图片路径。
 * Prefs 保存 UUID 引用；读取/写入失败局部降级，模型 Markdown 不获得此能力。
 */
import { normalizeLocalChatImage, type ChatImageInput, type LocalChatImage } from "@/chat/image-input"

type ImageHost = {
  IOUtils?: {
    makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<void>
    writeUTF8(path: string, value: string): Promise<unknown>
    readUTF8(path: string): Promise<string>
    getChildren(path: string): Promise<string[]>
    remove(path: string): Promise<void>
  }
  PathUtils?: { profileDir: string; join(...parts: string[]): string; filename(path: string): string }
}

const unsavedImages = new Map<string, ChatImageInput>()
let cleanup = Promise.resolve()

function imageStorage() {
  const { IOUtils: io, PathUtils: paths } = globalThis as typeof globalThis & ImageHost
  if (!io || !paths) throw new Error(uiText("本地图片存储不可用", "Local image storage is unavailable"))
  return { io, paths, directory: paths.join(paths.profileDir, "jadense-chat-images") }
}

/** 保存已归一化图片；存储不可用时本窗口仍可显示和发送。 */
export async function saveChatImage(image: ChatImageInput, origin: LocalChatImage["origin"]) {
  const attachment: LocalChatImage = { id: crypto.randomUUID(), name: image.name || "图片", origin }
  try {
    await cleanup
    const { io, paths, directory } = imageStorage()
    await io.makeDirectory(directory, { ignoreExisting: true })
    await io.writeUTF8(paths.join(directory, `${attachment.id}.txt`), image.dataUrl)
    return { attachment, saved: true }
  } catch {
    unsavedImages.set(attachment.id, image)
    return { attachment, saved: false }
  }
}

/** 只回读受控 UUID 对应的 PNG/JPEG；丢失或损坏的附件不阻断文字消息。 */
export async function readChatImage(value: LocalChatImage): Promise<ChatImageInput | null> {
  const attachment = normalizeLocalChatImage(value)
  if (!attachment) return null
  const cached = unsavedImages.get(attachment.id)
  if (cached) return cached
  try {
    const { io, paths, directory } = imageStorage()
    const dataUrl = await io.readUTF8(paths.join(directory, `${attachment.id}.txt`))
    const match = /^data:(image\/(?:png|jpeg));base64,[a-z\d+/]+={0,2}$/iu.exec(dataUrl)
    if (!match || dataUrl.length > 8 * 1024 * 1024 + 100) return null
    return { dataUrl, mimeType: match[1].toLowerCase() as ChatImageInput["mimeType"], name: attachment.name }
  } catch {
    return null
  }
}

/** 仅删除本插件生成且不再被历史引用的附件；不递归、不碰其他文件。 */
export function pruneChatImages(attachments: readonly LocalChatImage[]) {
  cleanup = cleanup.then(async () => {
    const retained = new Set(attachments.map(image => image.id))
    for (const id of unsavedImages.keys()) if (!retained.has(id)) unsavedImages.delete(id)
    try {
      const { io, paths, directory } = imageStorage()
      for (const path of await io.getChildren(directory)) {
        const name = paths.filename(path)
        const id = name.endsWith(".txt") ? name.slice(0, -4) : ""
        if (normalizeLocalChatImage({ id }) && !retained.has(id)) {
          await io.remove(paths.join(directory, name))
        }
      }
    } catch {
      // 清理属于可选维护，不影响消息读取、发送或 Manager 启动。
    }
  })
  return cleanup
}
