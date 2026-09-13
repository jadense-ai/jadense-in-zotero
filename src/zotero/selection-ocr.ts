/** 选文可选增强边界：原文与范围由 Reader 同步捕获，失败只影响 OCR，不阻断引用或翻译。 */
import { readOCRSelection, readSelectionOCR, type OCRSelectionRegion } from './local-ocr'
import type { ZoteroLike } from './runtime'
import { checkCancelled } from './pdf-document'
import { uiText } from './ui-preferences'

export async function enhanceSelection<T extends { itemID: number; text?: string }>(host: ZoteroLike, selection: T,
  regions: OCRSelectionRegion[] | undefined, signal: AbortSignal, progress: (text: string) => void,
  warning: (text: string) => void): Promise<T> {
  if (!readSelectionOCR(host)) return selection
  checkCancelled(signal)
  if (!regions?.length) {
    warning(uiText('无法确认选区坐标，已使用原选文。', 'Selection coordinates could not be verified. Using the original selection.'))
    return selection
  }
  try {
    progress(uiText('正在 OCR 提取选文与公式…', 'Extracting selected text and formulas with OCR…'))
    const text = await readOCRSelection(host, selection.itemID, regions, signal, progress)
    checkCancelled(signal)
    return { ...selection, text }
  } catch {
    checkCancelled(signal)
    warning(uiText('选文 OCR 未完成，已使用原选文。请在设置 → OCR配置中检查依赖及模型下载源。', 'Selection OCR did not complete. Using the original selection. Check dependencies and model source in Settings → OCR configuration.'))
    return selection
  }
}
