/** 攻玉 OCR 投影：页面图片 → 网关 → 现有 CloudPage；未知坐标不创建矩形。 */
import { snapshotJadenseAi, type JadenseOcrResult } from './jadense-ai'
import { JadenseApiError } from '@/jadense/api'
import { CloudOCRError, type CloudIO, type CloudPage } from './cloud-ocr-client'
import type { ZoteroLike } from './runtime'
export type JadenseOCRSnapshot = Awaited<ReturnType<typeof jadenseOCRSnapshot>>
export async function jadenseOCRSnapshot(host: ZoteroLike, signal?: AbortSignal) {
  const snapshot = await snapshotJadenseAi(host, 'ocr', signal)
  return { ...snapshot, engine: 'jadense' as const, model: `${snapshot.userId}:${snapshot.model}` }
}
export async function recognizeJadenseImage(config: JadenseOCRSnapshot, image: string, io: CloudIO): Promise<CloudPage> {
  const operationId = io.batchID ?? crypto.randomUUID()
  // 派发前保存身份；结果不确定时同一页不能因重启生成新身份重扣费。
  if (!io.batchID) await io.saveBatch?.(operationId)
  try {
    const result = await config.client.zoteroAiRequest<JadenseOcrResult>('ocr', { operationId, image, bindingRevision: config.config.revision }, io.signal)
    const blocks = (Array.isArray(result.blocks) ? result.blocks : []).filter(block => block && typeof block.text === 'string').map(block => ({ text: block.text, kind: block.kind,
      ...(block.box?.system === 'normalized-1000' && Array.isArray(block.box.coordinates) && block.box.coordinates.length === 4 && block.box.coordinates.every(value => Number.isFinite(value) && value >= 0 && value <= 1000) ? { bbox: block.box.coordinates } : {}) }))
    if (!blocks.length && (result.markdown || result.text)) blocks.push({ text: result.markdown || result.text, kind: undefined })
    return { blocks, warning: [...(Array.isArray(result.warnings) ? result.warnings.filter(value => typeof value === 'string') : []), ...(result.billingStatus === 'reconciliation_required' ? ['费用待核对 / Billing pending reconciliation'] : [])].join(' · ') || undefined }
  } catch (error) {
    if (error instanceof JadenseApiError) {
      const code = error.status === 401 || error.status === 403 ? 'AUTH' : error.status === 429 || error.status === 402 ? 'RATE_LIMIT_OR_QUOTA' : 'PROVIDER_REJECTED'
      const projected = new CloudOCRError(code, error.status)
      projected.message = `${error.message}${error.code ? ` (${error.code})` : ''}`
      throw projected
    }
    throw error
  }
}
