/** 全文提取策略：传统文字层默认可用，OCR 只由设置启用，失败不阻断传统提取。 */
import type { ZoteroLike } from './runtime'
import { checkCancelled, readTextDocument, type DocumentHost } from './pdf-document'
import { ensureLocalOCR, readOCRDocument, waitForOCR } from './local-ocr'
import { uiText } from './ui-preferences'

export const DOCUMENT_OCR_PREF = 'extensions.jadenseInZotero.documentOCR'
export function documentOCREnabled(host: ZoteroLike) { return host.Prefs?.get(DOCUMENT_OCR_PREF, true) === true }

export async function readDocument(host: ZoteroLike, itemID: number, signal: AbortSignal, progress: (text: string) => void = () => {}, useOCR = documentOCREnabled(host)) {
  let warning = ''
  if (useOCR) {
    try {
      await waitForOCR(ensureLocalOCR(host), signal); checkCancelled(signal)
      return await readOCRDocument(host, itemID, signal, progress)
    } catch {
      checkCancelled(signal)
      warning = uiText('OCR 增强不可用，已使用传统文字层提取。可前往 OCR 配置重新检查。', 'OCR enhancement is unavailable; extracted the text layer instead. Check OCR configuration.')
      progress(warning)
    }
  }
  const document = await readTextDocument(host as unknown as DocumentHost, itemID, signal, (page, total) => progress(uiText(`正在提取文字：${page.pageIndex + 1} / ${total} 页`, `Extracting text: ${page.pageIndex + 1} / ${total} pages`)))
  for (const page of document.pages) if (!page.paragraphs.some(paragraph => paragraph.text.trim())) {
    page.warning = [page.warning, uiText('此页没有可读文字层，扫描内容需要 OCR。', 'This page has no readable text layer; scanned content needs OCR.')].filter(Boolean).join('\n')
  }
  if (warning && document.pages[0]) document.pages[0].warning = [document.pages[0].warning, warning].filter(Boolean).join('\n')
  return document
}
