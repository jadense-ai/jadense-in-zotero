/** 本机附件解析与 UUID 存储；文档永不作为 HTML 插入宿主，外部资源不加载。 */
import { unzipSync } from 'fflate'
import { MAX_CHAT_FILE_BYTES, MAX_CHAT_FILE_TEXT, normalizeLocalChatFile, type ChatFileInput, type ChatUploadInput, type LocalChatFile } from '@/chat/file-input'
import { normalizeFigureImage } from './reader-figure-tools'
import { uiText } from './ui-preferences'

const memory = new Map<string, ChatFileInput>()
type PdfModule = typeof import('pdfjs-dist')
const pdfModules = new WeakMap<Document, Promise<PdfModule>>()
/** Reader 代码运行在 bootstrap 沙箱，没有 ScriptLoader；模块必须由真实窗口加载。 */
function loadPdfModule(doc: Document, base: string): Promise<PdfModule> {
  const cached = pdfModules.get(doc)
  if (cached) return cached
  const loading = new Promise<PdfModule>((resolve, reject) => {
    const script = doc.createElementNS('http://www.w3.org/1999/xhtml', 'script') as HTMLScriptElement
    script.type = 'module'; script.src = `${base}loader.mjs`
    script.onload = () => {
      script.remove()
      const module = (doc.defaultView as Window & { __jadenseChatPdfJS?: PdfModule }).__jadenseChatPdfJS
      if (module) resolve(module); else reject(new Error(uiText('PDF 解析组件未加载，请重试。', 'PDF parser did not load. Try again.')))
    }
    script.onerror = () => { script.remove(); reject(new Error(uiText('无法加载本机 PDF 解析组件。', 'Cannot load the local PDF parser.'))) }
    doc.documentElement.append(script)
  }).catch(error => { pdfModules.delete(doc); throw error })
  pdfModules.set(doc, loading)
  return loading
}
type Storage = { IOUtils: { makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; writeUTF8(path: string, text: string): Promise<unknown>; readUTF8(path: string): Promise<string>; getChildren(path: string): Promise<string[]>; remove(path: string): Promise<void> }; PathUtils: { profileDir: string; join(...parts: string[]): string; filename(path: string): string } }
let cleanup = Promise.resolve()
function storage() {
  const { IOUtils: io, PathUtils: paths } = globalThis as unknown as Storage
  return { io, paths, directory: paths.join(paths.profileDir, 'jadense-chat-files') }
}

/** 只展开 Word 正文条目，在解压前限制声明体积，避免解压无关媒体。 */
export function wordXml(buffer: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(buffer), { filter: entry => {
    if (entry.name !== 'word/document.xml') return false
    if (entry.originalSize > MAX_CHAT_FILE_BYTES) throw new Error(uiText('Word 解压内容过大，请拆分文件。', 'The Word content is too large. Split the file.'))
    return true
  } })
  const bytes = files['word/document.xml']
  if (!bytes) throw new Error(uiText('Word 文档损坏或格式不正确。', 'The Word document is damaged or invalid.'))
  return new TextDecoder().decode(bytes)
}

/** 从本地文件读取；只支持可解释的格式，失败不替换调用者原草稿。 */
export async function readChatUpload(file: File, doc: Document): Promise<ChatUploadInput> {
  if (file.size > MAX_CHAT_FILE_BYTES) throw new Error(uiText('单个文件最大 20 MB，请拆分后上传。', 'Files can be up to 20 MB. Split the file and try again.'))
  const win = doc.defaultView as Window & typeof globalThis
  const read = (mode: 'data' | 'buffer') => new Promise<string | ArrayBuffer>((resolve, reject) => {
    const reader = new win.FileReader()
    reader.onload = () => resolve(reader.result as string | ArrayBuffer)
    reader.onerror = () => reject(new Error(uiText('无法读取文件，请重新选择。', 'Cannot read the file. Select it again.')))
    if (mode === 'data') reader.readAsDataURL(file); else reader.readAsArrayBuffer(file)
  })
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (/^image\/(png|jpeg)$/.test(file.type) || /^(png|jpe?g)$/.test(extension)) return normalizeFigureImage(await read('data') as string, doc, file.name)
  if (extension === 'doc') throw new Error(uiText('请在 Word 中将 .doc 另存为 .docx 后上传。', 'Save the .doc file as .docx in Word and upload it again.'))
  if (!/^(pdf|docx|html?|md|markdown|txt|csv|tsv|json|bib|tex|xml|yaml|yml|ris)$/.test(extension)) throw new Error(uiText('请选择 PDF、Word (.docx)、HTML、Markdown 或常用文本文件。', 'Choose PDF, Word (.docx), HTML, Markdown or a supported text file.'))
  const buffer = await read('buffer') as ArrayBuffer
  let text = '', warning = '', mimeType = file.type || 'text/plain'
  if (extension === 'pdf') {
    mimeType = 'application/pdf'
    const base = /^https?:$/.test(doc.location.protocol) ? new URL('/pdfjs/', doc.location.href).href : 'chrome://jadense-in-zotero/content/pdfjs/'
    const pdfjs = await loadPdfModule(doc, base)
    pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.mjs`
    const task = pdfjs.getDocument({ data: buffer, isEvalSupported: false, useSystemFonts: true, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/` })
    let emptyPages = 0
    try {
      const pdf = await task.promise
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent()
        const value = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim()
        if (!value) emptyPages++
        text += `\n\n[${uiText('第', 'Page')} ${page} ${uiText('页', '')}]\n${value}`
        if (text.length > MAX_CHAT_FILE_TEXT) { warning = uiText('内容较长，仅提取前 60,000 字符。', 'Long document: only the first 60,000 characters were extracted.'); break }
      }
      if (emptyPages) warning += uiText(` ${emptyPages} 页无可提取文字，扫描内容需先 OCR。`, ` ${emptyPages} pages have no extractable text; scanned content needs OCR.`)
    } finally { await task.destroy() }
  } else if (extension === 'docx') {
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const xml = new win.DOMParser().parseFromString(wordXml(buffer), 'application/xml')
    if (xml.querySelector('parsererror')) throw new Error(uiText('无法解析 Word 文档。', 'Cannot parse the Word document.'))
    text = Array.from(xml.getElementsByTagNameNS('*', 'p')).map(p => Array.from(p.getElementsByTagNameNS('*', 't')).map(t => t.textContent).join('')).join('\n')
    warning = uiText('已提取正文文字；不含嵌入图片、批注及页眉页脚。', 'Body text extracted; embedded images, comments, headers and footers are excluded.')
  } else {
    const bytes = new Uint8Array(buffer)
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
    text = new TextDecoder(encoding).decode(buffer)
    if (/^html?$/.test(extension)) {
      mimeType = 'text/html'
      // template 的内容位于惰性文档，解析时也不执行脚本或请求图片/iframe。
      const template = doc.createElementNS('http://www.w3.org/1999/xhtml', 'template') as HTMLTemplateElement
      template.innerHTML = text
      const html = template.content
      html.querySelectorAll('script,style,template,noscript,iframe,object,embed,img,link').forEach(node => node.remove())
      html.querySelectorAll('p,div,br,li,tr,h1,h2,h3,h4,section,article').forEach(node => node.append('\n'))
      text = html.textContent || ''
    }
  }
  if (text.length > MAX_CHAT_FILE_TEXT && !warning.includes('60,000')) warning += uiText(' 内容较长，仅提取前 60,000 字符。', ' Long document: only the first 60,000 characters were extracted.')
  if (!text.trim()) warning = uiText('文件没有可提取文字，请检查内容或先执行 OCR。', 'No extractable text. Check the content or run OCR first.')
  return { name: file.name, size: file.size, mimeType, text: text.slice(0, MAX_CHAT_FILE_TEXT), ...(warning ? { warning: warning.trim() } : {}) }
}

export async function saveChatFile(file: ChatFileInput) {
  const attachment = normalizeLocalChatFile({ ...file, id: crypto.randomUUID() })!
  const canonical = { ...attachment, text: file.text.slice(0, MAX_CHAT_FILE_TEXT) }
  try {
    await cleanup
    const { io, paths, directory } = storage()
    await io.makeDirectory(directory, { ignoreExisting: true })
    await io.writeUTF8(paths.join(directory, `${attachment.id}.json`), JSON.stringify(canonical))
    return { attachment, saved: true }
  } catch { memory.set(attachment.id, canonical); return { attachment, saved: false } }
}

export async function readChatFile(value: LocalChatFile): Promise<ChatFileInput | null> {
  const attachment = normalizeLocalChatFile(value)
  if (!attachment) return null
  if (memory.has(attachment.id)) return memory.get(attachment.id)!
  try {
    const { io, paths, directory } = storage()
    const row = JSON.parse(await io.readUTF8(paths.join(directory, `${attachment.id}.json`)))
    return typeof row.text === 'string' ? { ...attachment, text: row.text.slice(0, MAX_CHAT_FILE_TEXT) } : null
  } catch { return null }
}

export function pruneChatFiles(attachments: readonly LocalChatFile[]) {
  cleanup = cleanup.then(async () => {
    const retained = new Set(attachments.map(file => file.id))
    for (const id of memory.keys()) if (!retained.has(id)) memory.delete(id)
    try {
      const { io, paths, directory } = storage()
      for (const path of await io.getChildren(directory)) {
        const name = paths.filename(path)
        if (name.endsWith('.json') && normalizeLocalChatFile({ id: name.slice(0, -5) }) && !retained.has(name.slice(0, -5))) await io.remove(paths.join(directory, name))
      }
    } catch { /* 可选清理失败不阻断对话。 */ }
  })
  return cleanup
}
