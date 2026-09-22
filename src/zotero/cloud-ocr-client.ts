/** 云 OCR 协议边界：独立适配结构，网络超时/取消不重放提交，结果仅保留文档字段。 */
import { unzipSync, strFromU8 } from 'fflate'
import type { CloudOCRConfig } from './cloud-ocr-config'
import { requireCloudOCR } from './cloud-ocr-config'
import type { PdfRect } from './pdf-document'

export type OCRBlock = { text: string; kind?: string; bbox?: PdfRect; image?: string }
export type CloudPage = { blocks: OCRBlock[]; warning?: string }
export type CloudIO = { fetch: typeof fetch; signal: AbortSignal; progress(text: string): void;
  batchID?: string; saveBatch?(id: string): Promise<void> }
type Row = Record<string, unknown>
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown) => typeof value === 'string' ? value : ''
export const OCR_IMAGE_LIMIT = 8 * 1024 * 1024
const RESULT_LIMIT = 64 * 1024 * 1024

/** 只使用固定错误标签，第三方响应/URL/正文不可进入日志或异常。 */
export class CloudOCRError extends Error {
  constructor(public code: string, public status?: number) { super(`云 OCR / Cloud OCR: ${code}${status ? ` (${status})` : ''}`); this.name = 'CloudOCRError' }
}
export async function cloudRequest(io: CloudIO, url: string, init: RequestInit = {}, limit = RESULT_LIMIT): Promise<Uint8Array> {
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password) throw new CloudOCRError('UNSAFE_URL')
  io.signal.throwIfAborted()
  const controller = new AbortController(), abort = () => controller.abort()
  io.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 120000)
  try {
    const response = await io.fetch(url, { ...init, signal: controller.signal, credentials: 'omit', redirect: 'error' })
    if (!response.ok) throw new CloudOCRError(response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 || response.status === 402 ? 'RATE_LIMIT_OR_QUOTA' : response.status === 400 ? 'PROVIDER_REJECTED' : 'HTTP', response.status)
    if (Number(response.headers.get('content-length')) > limit) throw new CloudOCRError('RESULT_TOO_LARGE')
    const reader = response.body?.getReader()
    if (!reader) return new Uint8Array()
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) throw new CloudOCRError('RESULT_TOO_LARGE')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const result = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
    return result
  } catch (error) {
    io.signal.throwIfAborted()
    if (error instanceof CloudOCRError) throw error
    throw new CloudOCRError(controller.signal.aborted ? 'TIMEOUT_RESULT_UNCERTAIN' : 'NETWORK_RESULT_UNCERTAIN')
  } finally { clearTimeout(timer); io.signal.removeEventListener('abort', abort) }
}
async function json(io: CloudIO, url: string, config: CloudOCRConfig, body?: unknown) {
  const bytes = await cloudRequest(io, url, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try { return row(JSON.parse(new TextDecoder().decode(bytes))) } catch { throw new CloudOCRError('INVALID_JSON') }
}
/** 图片链接不自动加载；云端 HTML 表格转为可读 Markdown，不传入 HTML 渲染器。 */
export function cleanOCRText(text: string) {
  text = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/giu, (_table, body: string) => {
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map(match => [...match[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/giu)].map(cell => cell[1].replace(/<[^>]*>/gu, '').replace(/\|/gu, '\\|').trim()))
    if (!rows.length) return body
    const width = Math.max(...rows.map(r => r.length))
    return '\n' + [rows[0], Array(width).fill('---'), ...rows.slice(1)].map(r => '| ' + Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ') + ' |').join('\n') + '\n'
  })
  return text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '').replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/<\|det\|>[\s\S]*?<\|\/det\|>/gu, '').replace(/<\|[^>]+\|>/gu, '')
    .replace(/<br\s*\/?\s*>/giu, '\n').replace(/<\/(?:td|th)>\s*<(?:td|th)[^>]*>/giu, ' | ')
    .replace(/<tr[^>]*>/giu, '\n| ').replace(/<\/tr>/giu, ' |\n').replace(/<\/?(?:img|a|div|span|p|table|tbody|thead|td|th|iframe|object|embed|style|link)\b[^>]*>/giu, '').trim()
}
function box(value: unknown): PdfRect | undefined {
  return Array.isArray(value) && value.length === 4 && value.every(v => typeof v === 'number' && Number.isFinite(v)) && value[2] > value[0] && value[3] > value[1] ? value as PdfRect : undefined
}
export function glmPage(value: unknown): CloudPage {
  const result = row(value), details = list(list(result.layout_details)[0])
  const blocks = details.map(value => { const r = row(value); return { text: cleanOCRText(string(r.content)), kind: string(r.label), bbox: box(r.bbox_2d) } }).filter(b => b.text || (b.bbox && /^(image|figure|picture)$/u.test(b.kind)))
  return { blocks: blocks.length ? blocks : [{ text: cleanOCRText(string(result.md_results)) }].filter(b => b.text) }
}
export function bytesBase64(bytes: Uint8Array) {
  let value = ''
  for (let i = 0; i < bytes.length; i += 16384) value += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return btoa(value)
}
/** 未可信 ZIP 从不落盘；校验路径、数量、解压前声明长度与解压后总量。 */
export function mineruArchive(bytes: Uint8Array): CloudPage[] {
  let total = 0, count = 0
  const files = unzipSync(bytes, { filter(file) {
    if (++count > 5000 || /(^[/\\]|^[a-z]:|(?:^|[/\\])\.\.(?:[/\\]|$))/iu.test(file.name)) throw new CloudOCRError('UNSAFE_ARCHIVE')
    total += file.originalSize
    if (total > 256 * 1024 * 1024 || file.originalSize > 32 * 1024 * 1024) throw new CloudOCRError('ARCHIVE_TOO_LARGE')
    return /(?:_content_list\.json|\.(?:png|jpe?g))$/iu.test(file.name)
  } })
  if (Object.values(files).reduce((n, v) => n + v.length, 0) > 256 * 1024 * 1024) throw new CloudOCRError('ARCHIVE_TOO_LARGE')
  const entry = Object.entries(files).find(([name]) => name.endsWith('_content_list.json'))
  if (!entry) throw new CloudOCRError('MISSING_PAGE_RESULTS')
  let content: unknown
  try { content = JSON.parse(strFromU8(entry[1])) } catch { throw new CloudOCRError('INVALID_JSON') }
  const pages: CloudPage[] = []
  for (const item of list(content)) {
    const block = row(item), index = block.page_idx
    if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= 200) continue
    const page = pages[Number(index)] ??= { blocks: [] }
    const type = string(block.type)
    const captions = [...list(block.image_caption), ...list(block.table_caption), ...list(block.table_footnote)].map(string).join('\n')
    let text = cleanOCRText([string(block.text) || string(block.table_body), captions].filter(Boolean).join('\n'))
    if (type === 'equation' && text && !text.startsWith('$$')) text = `$$\n${text}\n$$`
    if (block.text_level === 1 && text) text = `## ${text}`
    const imagePath = string(block.img_path)
    const prefix = entry[0].slice(0, entry[0].lastIndexOf('/') + 1)
    const image = files[prefix + imagePath]
    const format = image && image.length <= OCR_IMAGE_LIMIT ? image[0] === 137 && image[1] === 80 && image[2] === 78 && image[3] === 71 ? 'png' : image[0] === 255 && image[1] === 216 ? 'jpeg' : '' : ''
    if (text || format) page.blocks.push({ text, kind: type, bbox: box(block.bbox), ...(format ? { image: `data:image/${format};base64,${bytesBase64(image)}` } : {}) })
    else if (imagePath) page.warning = 'OCR 图片资源不可用 / OCR image resource unavailable'
  }
  return Array.from({ length: pages.length }, (_, i) => pages[i] ?? { blocks: [] })
}
async function delay(io: CloudIO, ms: number) {
  io.signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(io.signal.reason) }
    const timer = setTimeout(() => { io.signal.removeEventListener('abort', abort); resolve() }, ms)
    io.signal.addEventListener('abort', abort, { once: true })
  })
}
export async function mineruRecognize(config: CloudOCRConfig, bytes: Uint8Array, name: string, io: CloudIO): Promise<CloudPage[]> {
  requireCloudOCR(config)
  let id = io.batchID
  if (!id) {
    io.progress('正在上传至 MinerU / Uploading to MinerU')
    const result = await json(io, `${config.endpoint}/file-urls/batch`, config, { files: [{ name, is_ocr: true }], model_version: config.model, enable_formula: true, enable_table: true })
    const data = row(result.data)
    id = string(data.batch_id)
    const url = string(list(data.file_urls)[0])
    if (result.code !== 0 || !id || !url) throw new CloudOCRError('SUBMISSION_REJECTED')
    await io.saveBatch?.(id)
    // 预签名地址仅接收文件，不携带服务 API Key。
    await cloudRequest(io, url, { method: 'PUT', body: bytes as unknown as BodyInit })
  }
  let errors = 0
  for (let n = 0; n < 360; n++) {
    io.signal.throwIfAborted()
    let result: Row
    try { result = await json(io, `${config.endpoint}/extract-results/batch/${encodeURIComponent(id)}`, config); errors = 0 }
    catch (error) {
      if (error instanceof CloudOCRError && error.status !== 401 && error.status !== 403 && errors++ < 3) { await delay(io, 5000); continue }
      throw error
    }
    if (result.code !== 0) throw new CloudOCRError('POLL_REJECTED')
    const state = row(list(row(result.data).extract_result)[0])
    if (state.state === 'done') return mineruArchive(await cloudRequest(io, string(state.full_zip_url)))
    if (state.state === 'failed') { await io.saveBatch?.(''); throw new CloudOCRError('REMOTE_FAILED_MANUAL_RETRY') }
    if (state.state === 'waiting-file' && n >= 3) { await io.saveBatch?.(''); throw new CloudOCRError('UPLOAD_UNCERTAIN_MANUAL_RETRY') }
    const progress = row(state.extract_progress)
    io.progress(`MinerU: ${Number(progress.extracted_pages) || 0} / ${Number(progress.total_pages) || '?'} · 等待结果 / Waiting`)
    await delay(io, Math.min(5000, 1000 + n * 500))
  }
  throw new CloudOCRError('POLL_TIMEOUT_RESUME_AVAILABLE')
}
export async function recognizeImage(config: CloudOCRConfig, image: string, io: CloudIO): Promise<CloudPage> {
  requireCloudOCR(config)
  if (config.engine === 'mineru') {
    const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), c => c.charCodeAt(0))
    return (await mineruRecognize(config, bytes, image.startsWith('data:image/jpeg') ? 'page.jpg' : 'page.png', io))[0] ?? { blocks: [] }
  }
  if (config.engine === 'glm') return glmPage(await json(io, config.endpoint, config, { model: config.model, file: image, return_crop_images: false }))
  let content: unknown, finish: unknown
  if (config.engine === 'aliyun') {
    const result = await json(io, config.endpoint, config, { model: config.model, input: { messages: [{ role: 'user', content: [{ image }] }] }, parameters: { ocr_options: { task: 'document_parsing' } } })
    if (result.code) throw new CloudOCRError('PROVIDER_REJECTED')
    const choice = row(list(row(result.output).choices)[0]); content = row(choice.message).content; finish = choice.finish_reason
  } else {
    const prompt = /deepseek.*ocr/iu.test(config.model) ? '<image>\n<|grounding|>Convert the document to markdown.' : /paddleocr/iu.test(config.model) ? 'OCR:' : 'Transcribe this image faithfully into Markdown. Preserve tables and LaTeX equations. Do not explain, translate or invent text.'
    const result = await json(io, `${config.endpoint.replace(/\/chat\/completions$/u, '')}/chat/completions`, config, { model: config.model, stream: false, max_tokens: 8192, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: prompt }] }] })
    const choice = row(list(result.choices)[0]); content = row(choice.message).content; finish = choice.finish_reason
  }
  if (finish === 'length') throw new CloudOCRError('OUTPUT_TRUNCATED')
  const text = cleanOCRText(typeof content === 'string' ? content : list(content).map(v => string(row(v).text)).join('\n'))
  if (!text) throw new CloudOCRError('EMPTY_RESULT')
  return { blocks: [{ text }] }
}
