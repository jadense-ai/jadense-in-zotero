/**
 * Chat 图片只用于当前请求的多模态投影，不属于本地消息或持久化会话结构。
 */
export type ChatImageInput = {
  dataUrl: string
  mimeType: "image/png" | "image/jpeg"
  name?: string
}

const INLINE_CHAT_IMAGE = /data:image\/(?:png|jpeg);base64,[-_a-z\d+/=]*/giu

/** Provider 错误不可信；禁止其把请求中的图片字节回显进本地历史或状态。 */
export function redactChatImageDataUrls(value: string) {
  return value.replace(INLINE_CHAT_IMAGE, "[图片数据已移除]")
}
