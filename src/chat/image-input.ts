/**
 * Chat 多模态输入与本地附件引用；消息只保存引用，图片字节由 Zotero 附件存储管理。
 */
export type ChatImageInput = {
  dataUrl: string
  mimeType: "image/png" | "image/jpeg"
  name?: string
}

export type LocalChatImage = {
  id: string
  name: string
  origin: "upload" | "figure"
}

/** 历史引用不能授予任意路径访问；额外字段不进入附件的文件系统边界。 */
export function normalizeLocalChatImage(value: unknown): LocalChatImage | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  if (typeof row.id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(row.id)) return undefined
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name.slice(0, 200) : "图片",
    origin: row.origin === "figure" ? "figure" : "upload",
  }
}

const INLINE_CHAT_IMAGE = /data:image\/(?:png|jpeg);base64,[-_a-z\d+/=]*/giu

/** Provider 错误不可信；禁止其把请求中的图片字节回显进本地历史或状态。 */
export function redactChatImageDataUrls(value: string) {
  return value.replace(INLINE_CHAT_IMAGE, "[图片数据已移除]")
}
