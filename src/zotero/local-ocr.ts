import { diagnostics } from "./diagnostics"
/** 本机 OCR：管理独立 Python 环境；全文及显式开启的选文增强使用该服务。 */
import type { ZoteroLike } from './runtime'
import { checkCancelled, validateDocument, type DocumentHost, type PdfTextDocument, type PdfRect } from './pdf-document'
import { uiText } from './ui-preferences'

type Process = { stdin: { write(value: string): Promise<unknown>; close(): Promise<unknown> }; stdout: { readString(): Promise<string | null> }; wait(): Promise<{ exitCode: number }>; kill(): void }
type Platform = {
  IOUtils: { makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; writeUTF8(path: string, text: string): Promise<unknown>; exists(path: string): Promise<boolean>; read(path: string): Promise<Uint8Array> }
  PathUtils: { profileDir: string; join(...parts: string[]): string }
  ChromeUtils: { importESModule(uri: string): { Subprocess: { getEnvironment(): Record<string, string>; pathSearch(name: string): Promise<string>; call(options: { command: string; arguments: string[]; stderr: string; environment?: Record<string, string> }): Promise<Process> } } }
}
type SharedHost = ZoteroLike & { __jadenseOCR?: Promise<{ url: string; token: string; process: Process }>; __jadenseOCRInstall?: Promise<string>; __jadenseOCRModels?: Promise<void>; __jadenseOCRCheck?: Promise<OCREnvironment> }
const resource = 'chrome://jadense-in-zotero/content/ocr/'
const platform = () => globalThis as unknown as Platform
const windows = (host: ZoteroLike) => (host.getMainWindow?.()?.navigator.platform ?? globalThis.navigator?.platform ?? '').toLowerCase().startsWith('win')
const network = (host: ZoteroLike) => { const win = host.getMainWindow?.(); return win?.fetch.bind(win) ?? globalThis.fetch.bind(globalThis) }

export const OCR_MODEL_SOURCE_PREF = 'extensions.jadenseInZotero.ocrModelSource'
export const OCR_SELECTION_PREF = 'extensions.jadenseInZotero.ocrSelection'
/** 默认关闭；损坏或未知配置不能让普通选文依赖 OCR。 */
export function readSelectionOCR(host: ZoteroLike): boolean {
  try { return host.Prefs?.get(OCR_SELECTION_PREF, true) === true } catch { return false }
}

export type OCRSelectionRegion = { pageIndex: number; rects: number[][] }

/** 复用附件校验和本机服务；选区任务只返回正文与公式 Markdown，不保存全文成果。 */
export async function readOCRSelection(host: ZoteroLike, itemID: number, regions: OCRSelectionRegion[], signal: AbortSignal, progress: (text: string) => void): Promise<string> {
  const item = await (host as unknown as DocumentHost).Items?.get?.(itemID) as { libraryID: number; key: string; attachmentModificationTime?: number | Promise<number>; getFilePathAsync(): Promise<string> } | undefined
  const source = { itemID, libraryID: item?.libraryID ?? -1, itemKey: item?.key ?? '', title: 'PDF', modificationTime: await item?.attachmentModificationTime }
  await validateDocument(host as unknown as DocumentHost, source); checkCancelled(signal)
  const local = await service(host, progress); checkCancelled(signal)
  const request = async (path: string, init?: RequestInit) => {
    const response = await network(host)(local.url + path, { ...init, credentials: 'omit', headers: { Authorization: `Bearer ${local.token}`, ...init?.headers } })
    if (!response.ok) throw new Error(`Selection OCR (${response.status})`)
    return response.json()
  }
  const bytes = await platform().IOUtils.read(await item!.getFilePathAsync!()); checkCancelled(signal)
  const job = await request('/selection-jobs', { method: 'POST', body: bytes as unknown as BodyInit,
    headers: { 'X-Jadense-OCR-Model-Source': readOCRModelSource(host), 'X-Jadense-OCR-Selection': JSON.stringify(regions) } })
  const cancel = () => { void request(`/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) { cancel(); checkCancelled(signal) }
    for (;;) {
      const status = await request(`/jobs/${job.id}`, { signal }); checkCancelled(signal)
      if (status.state === 'complete') {
        await validateDocument(host as unknown as DocumentHost, source); checkCancelled(signal)
        const text = typeof status.result?.text === 'string' ? status.result.text.trim() : ''
        if (!text) throw new Error('Selection OCR returned no text')
        return text
      }
      if (status.state === 'error' || status.state === 'cancelled') throw new Error(String(status.error || 'Selection OCR cancelled'))
      progress(uiText('正在 OCR 提取选文与公式，首次使用需要下载模型…', 'Extracting selected text and formulas with OCR; first use downloads models…'))
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally { signal.removeEventListener('abort', cancel) }
}
/** 未知偏好沿用宿主环境；镜像必须由用户明确选择。 */
export function readOCRModelSource(host: ZoteroLike): 'default' | 'hf-mirror' | 'modelscope' {
  try {
    const value = host.Prefs?.get(OCR_MODEL_SOURCE_PREF, true)
    return value === 'hf-mirror' || value === 'modelscope' ? value : 'default'
  } catch { return 'default' }
}

/** 模型准备失败与翻译 Provider 无关；原始诊断仍保留在本机 OCR 任务中。 */
export function ocrFailureMessage(error: unknown): string {
  const text = String(error || 'OCR cancelled')
  if (/snapshot folder|files on the Hub|huggingface|LocalEntryNotFound|ConnectTimeout|ReadTimeout|WinError 10060/iu.test(text)) {
    return uiText('OCR 模型下载或加载失败，全文翻译尚未开始。请在设置 → OCR配置中选择可访问的模型下载源，检查网络后重新点击“全文翻译”。无需更换翻译模型；完成 OCR 配置后可继续翻译已保存的全文 Markdown。', 'OCR model download or loading failed; full translation has not started. Choose an accessible model download source in Settings → OCR configuration, check your network, then click Translate full text again. No translation model change is needed. Complete OCR setup to translate saved full Markdown.')
  }
  return text
}

/** 设置与首次全文任务共用固定安装资源。 */
async function prepareOCR(host: ZoteroLike) {
  const { IOUtils: io, PathUtils: paths } = platform()
  const root = paths.join(paths.profileDir, 'jadense-ocr', 'v1')
  await io.makeDirectory(root, { ignoreExisting: true })
  for (const name of ['pyproject.toml', 'uv.lock', 'server.py', 'install.ps1', 'install.sh']) {
    const response = await network(host)(resource + name)
    if (!response.ok) throw new Error(`OCR resource unavailable: ${name}`)
    const text = await response.text()
    // Windows PowerShell 5.1 无 BOM 时按系统代码页读取，中文注释可能吞掉下一行。
    await io.writeUTF8(paths.join(root, name), name === 'install.ps1' ? '\uFEFF' + text.replace(/^\uFEFF/u, '') : text)
  }
  return root
}

/** 参数单独传递，用户目录不会成为 shell 代码；检查模式不下载依赖。 */
async function runInstaller(host: ZoteroLike, root: string, checkOnly = false) {
  const { PathUtils: paths, ChromeUtils } = platform()
  const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs')
  const environment = Subprocess.getEnvironment()
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows'
  return Subprocess.call({
    command: windows(host) ? paths.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh',
    arguments: windows(host)
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.join(root, 'install.ps1'), '-RuntimeDirectory', root, ...(checkOnly ? ['-CheckOnly'] : [])]
      : [paths.join(root, 'install.sh'), root, ...(checkOnly ? ['--check'] : [])], stderr: 'stdout',
  })
}

export type OCREnvironment = { uvPath: string; uvVersion: string; uvSource: string; ready: boolean; logPath: string; modelsReady?: boolean; issue?: string }

/** 仅返回 OCR 相关环境状态，不读取其他 Python 项目。 */
export async function checkLocalOCR(host: ZoteroLike): Promise<OCREnvironment> {
  const shared = host as SharedHost
  if (shared.__jadenseOCRCheck) return shared.__jadenseOCRCheck
  shared.__jadenseOCRCheck = readOCREnvironment(host)
  try { return await shared.__jadenseOCRCheck } finally { delete shared.__jadenseOCRCheck }
}

async function readOCREnvironment(host: ZoteroLike): Promise<OCREnvironment> {
  const shared = host as SharedHost
  await shared.__jadenseOCRModels?.catch(() => {})
  await shared.__jadenseOCRInstall?.catch(() => {})
  const root = await prepareOCR(host)
  const process = await runInstaller(host, root, true)
  let output = '', chunk: string | null
  while ((chunk = await process.stdout.readString())) output += chunk
  if ((await process.wait()).exitCode !== 0) throw new Error(uiText('OCR 环境检查失败。', 'OCR environment check failed.') + '\n' + output.slice(-2000))
  const fields = Object.fromEntries(output.split(/\r?\n/u).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  const modelsReady = fields.ready === 'true' ? await checkModels(host, root).catch(() => false) : false
  return { modelsReady, uvPath: fields.uvPath ?? '', uvVersion: fields.uvVersion ?? '', uvSource: fields.uvSource ?? '', ready: fields.ready === 'true', logPath: platform().PathUtils.join(root, 'install.log') }
}


export class OCRNotReadyError extends Error {
  constructor(message = uiText('OCR 依赖或模型尚未就绪。请前往 OCR 配置，点击“启用本机 OCR”或“继续准备”。', 'OCR dependencies or models are not ready. Open OCR configuration and choose Enable local OCR or Continue setup.'), readonly code = 'OCR_NOT_READY') { super(message) }
}

/** 仅设置操作允许下载；准入检查不会安装、下载或读取用户 PDF。 */
async function checkModels(host: ZoteroLike, root: string, prepare = false, progress: (text: string) => void = () => {}) {
  const { PathUtils: paths, ChromeUtils } = platform()
  const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs')
  const environment = { ...Subprocess.getEnvironment(), HF_HOME: paths.join(root, 'models'), HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', JADENSE_OCR_MODEL_SOURCE: readOCRModelSource(host) }
  if (readOCRModelSource(host) === 'hf-mirror') Object.assign(environment, { HF_ENDPOINT: 'https://hf-mirror.com' })
  if (!prepare) Object.assign(environment, { HF_HUB_OFFLINE: '1' })
  const process = await Subprocess.call({ command: paths.join(root, '.venv', windows(host) ? 'Scripts' : 'bin', windows(host) ? 'python.exe' : 'python'),
    arguments: ['-u', paths.join(root, 'server.py'), prepare ? '--prepare-models' : '--verify-models', root], environment, stderr: 'stdout' })
  let output = '', chunk: string | null
  while ((chunk = await process.stdout.readString())) {
    output += chunk
    progress(uiText('正在检查已有模型，缺失时下载并验证识别，请稍候…', 'Checking cached models, downloading missing files and verifying recognition…'))
  }
  const success = (await process.wait()).exitCode === 0 && /"modelsReady":\s*true/u.test(output)
  if (prepare) {
    const logPath = paths.join(root, 'models-prepare.log')
    try { await platform().IOUtils.writeUTF8(logPath, output) } catch { /* 可选日志不能阻断模型准备。 */ }
    if (!success) throw new OCRNotReadyError(uiText('OCR 模型准备或识别检查失败，已有依赖和缓存已保留。请检查下载源后重试。诊断日志：', 'OCR model preparation or verification failed. Existing dependencies and cache were preserved. Check the source and retry. Diagnostic log: ') + logPath)
  }
  return success
}

export async function prepareLocalOCRModels(host: ZoteroLike, progress: (text: string) => void = () => {}) {
  const shared = host as SharedHost
  if (shared.__jadenseOCRModels) return shared.__jadenseOCRModels
  const pendingCheck = shared.__jadenseOCRCheck
  shared.__jadenseOCRModels = (async () => {
    // 已开始的离线验证先完成，避免两个子进程覆盖同一个合成样例/凭据。
    await pendingCheck?.catch(() => {})
    progress(uiText('1 / 2 · 正在准备识别组件…', '1 / 2 · Preparing recognition components…'))
    const root = await installLocalOCR(host, progress)
    progress(uiText('2 / 2 · 正在准备模型并自动验证，首次使用可能需要几分钟…', '2 / 2 · Preparing models and verifying automatically; first use may take several minutes…'))
    if (!await checkModels(host, root, true, progress)) throw new OCRNotReadyError(uiText('OCR 模型准备或识别检查失败，请检查下载源后重试。', 'OCR model preparation or recognition verification failed. Check the download source and retry.'))
    // 选文公式属于可选增强，首次使用时按需加载，不能阻断全文 OCR 配置。
  })()
  try { await shared.__jadenseOCRModels } finally { delete shared.__jadenseOCRModels }
}

/** 三类全文执行的统一门槛；正在安装也不让任务等待后偷偷开始。 */
export async function ensureLocalOCR(host: ZoteroLike) {
  const shared = host as SharedHost
  if (shared.__jadenseOCRInstall || shared.__jadenseOCRModels) throw new OCRNotReadyError(uiText('OCR 正在准备，请完成后重新启动任务。', 'OCR is being prepared. Start the task again when preparation finishes.'), 'OCR_PREPARING')
  let value: OCREnvironment
  try { value = await checkLocalOCR(host) } catch { throw new OCRNotReadyError() }
  if (!value.ready) throw new OCRNotReadyError(uiText('OCR 依赖尚未安装完成，请前往 OCR 配置安装。', 'OCR dependencies are incomplete. Install them in OCR configuration.'), 'OCR_DEPENDENCIES_MISSING')
  if (!value.modelsReady) throw new OCRNotReadyError(uiText('OCR 模型需要补充准备，请前往 OCR 配置点击“继续准备”，已有组件会自动复用。', 'OCR models need preparation. Choose Continue setup in OCR configuration; existing components will be reused.'), 'OCR_MODELS_MISSING')
}

/** 失败不留 ready 标记，下次仍可重试；手动配置与全文任务共享并发安装。 */
export async function installLocalOCR(host: ZoteroLike, progress: (text: string) => void = () => {}, repair = false) {
  const shared = host as SharedHost
  if (shared.__jadenseOCRInstall) return shared.__jadenseOCRInstall
  shared.__jadenseOCRInstall = (async () => {
    const { IOUtils: io, PathUtils: paths } = platform()
    const root = await prepareOCR(host)
    const python = paths.join(root, '.venv', windows(host) ? 'Scripts' : 'bin', windows(host) ? 'python.exe' : 'python')
    if (repair || !await io.exists(python) || !await io.exists(paths.join(root, 'ready-2.126.0-3.9.2'))) {
      const process = await runInstaller(host, root)
      progress(uiText('正在安装本机 OCR，首次安装需要下载 Python 和模型依赖…', 'Installing local OCR; the first installation downloads Python and model dependencies…'))
      let log = '', chunk: string | null
      while ((chunk = await process.stdout.readString())) { log += chunk }
      const exitCode = (await process.wait()).exitCode
      const logPath = paths.join(root, 'install.log')
      try { await io.writeUTF8(logPath, log) } catch { /* 可选诊断日志不能阻止安装成功或掩盖原始错误。 */ }
      if (exitCode !== 0) throw new Error(uiText('OCR 安装失败。请在设置 → OCR配置中重试。安装日志：', 'OCR installation failed. Retry in Settings → OCR configuration. Installation log: ') + logPath + '\n' + log.slice(-2000))
      await io.writeUTF8(paths.join(root, 'ready-2.126.0-3.9.2'), 'ready')
    }
    return root
  })()
  try { return await shared.__jadenseOCRInstall } finally { delete shared.__jadenseOCRInstall }
}

async function service(host: ZoteroLike, progress: (text: string) => void, allowInstall = true) {
  const shared = host as SharedHost
  if (!shared.__jadenseOCR) shared.__jadenseOCR = (async () => {
    if (!allowInstall) await ensureLocalOCR(host)
    const root = allowInstall ? await installLocalOCR(host, progress) : await prepareOCR(host)
    const { PathUtils: paths, ChromeUtils } = platform()
    const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs')
    const process = await Subprocess.call({ command: paths.join(root, '.venv', windows(host) ? 'Scripts' : 'bin', windows(host) ? 'python.exe' : 'python'), arguments: ['-u', paths.join(root, 'server.py')], stderr: 'stdout' })
    const token = crypto.randomUUID() + crypto.randomUUID()
    await process.stdin.write(JSON.stringify({ root, token }) + '\n')
    let output = ''
    for (;;) {
      const part = await process.stdout.readString()
      if (!part) throw new Error(uiText('本机 OCR 服务启动失败，请重新安装后重试。', 'Local OCR could not start. Reinstall and retry.'))
      output += part
      const line = output.split('\n').find(line => /^\{"port":/u.test(line))
      if (line) {
        const { port } = JSON.parse(line)
        if (!Number.isInteger(port) || port < 1 || port > 65535) { process.kill(); throw new Error('Invalid local OCR port') }
        // 模型库会写运行日志；必须持续消费，避免长文处理堵塞 stdout。
        void (async () => { while (await process.stdout.readString()) { /* drain */ } })().catch(() => {})
        void process.wait().finally(() => { delete shared.__jadenseOCR })
        return { url: `http://127.0.0.1:${port}`, token, process }
      }
    }
  })().catch(error => { diagnostics()?.record("ocr", "service_start", error); delete shared.__jadenseOCR; throw error })
  return shared.__jadenseOCR
}

export async function startLocalOCR(host: ZoteroLike, progress?: (text: string) => void) { await service(host, progress ?? (() => {})) }
export function stopLocalOCR(host: ZoteroLike) {
  const shared = host as SharedHost
  void shared.__jadenseOCR?.then(value => value.process.stdin.close()).catch(() => {})
  delete shared.__jadenseOCR
}

export type OCRResult = { pages: Array<{ pageIndex: number; blocks: Array<{ text: string; kind?: string; image?: string; locations: Array<{ pageIndex: number; rects: PdfRect[] }> }> }> }

/** 物理页码由数组序号决定；未知字段忽略，公式图片只接受本机生成的 PNG。 */
export function projectOCR(result: OCRResult, source: PdfTextDocument['source']): PdfTextDocument {
  let next = 0
  return { source, ocrVersion: 1, pages: result.pages.map((page, pageIndex) => ({ pageIndex, pageLabel: String(pageIndex + 1), lines: page.blocks.flatMap((block, blockIndex) => block.image ? [] : block.text.split(/\r?\n/u).filter(text => text.trim()).map((text, lineIndex) => ({ id: `ocr-line-${pageIndex}-${blockIndex}-${lineIndex}`, text, pageIndex, pageLabel: String(pageIndex + 1), rects: block.locations.flatMap(location => location.rects) }))),
    paragraphs: page.blocks.map(block => {
      const id = `ocr-${next++}`, marker = `⟦${block.kind === 'picture' ? 'I' : 'F'}${next}⟧`
      const image = /^data:image\/png;base64,[a-z\d+/]+=*$/iu.test(block.image ?? '') ? block.image : undefined
      return { id, text: image ? marker : block.kind === 'section_header' ? `## ${block.text}` : block.kind === 'list_item' ? `- ${block.text}` : block.text,
        pageIndex, pageLabel: String(pageIndex + 1), rects: block.locations.flatMap(location => location.rects), lineIDs: [],
        locations: block.locations.map(location => ({ ...location, pageLabel: String(location.pageIndex + 1) })),
        ...(image ? { formulas: { [marker]: image } } : {}) }
    }) })) }
}

/** 仅从已验证的当前 Zotero 附件读字节；服务接口不接受文件系统路径。 */
export async function readOCRDocument(host: ZoteroLike, itemID: number, signal: AbortSignal, progress: (text: string) => void): Promise<PdfTextDocument> {
  const item = await (host as unknown as DocumentHost).Items?.get?.(itemID) as { id: number; libraryID: number; key: string; parentItem?: { getField(key: string): unknown }; getField(key: string): unknown; getFilePathAsync(): Promise<string>; attachmentModificationTime?: number | Promise<number> }
  const source = { itemID, libraryID: item?.libraryID, itemKey: item?.key, title: String(item?.parentItem?.getField('title') || item?.getField('title') || 'PDF'), modificationTime: await item?.attachmentModificationTime }
  await validateDocument(host as unknown as DocumentHost, source); checkCancelled(signal)
  const local = await service(host, progress, false); checkCancelled(signal)
  const headers = { Authorization: `Bearer ${local.token}` }
  const request = async (path: string, init?: RequestInit) => {
    const response = await network(host)(local.url + path, { ...init, headers: { ...headers, ...init?.headers }, credentials: 'omit' })
    if (!response.ok) throw new Error(uiText(`本机 OCR 请求失败（${response.status}）`, `Local OCR request failed (${response.status})`))
    return response.json()
  }
  const bytes = await platform().IOUtils.read(await item.getFilePathAsync()); checkCancelled(signal)
  // 上传成功后才登记取消钩子，取消与响应同时到达时仍显式清理服务器任务。
  const job = await request('/jobs', { method: 'POST', body: bytes as unknown as BodyInit, headers: { 'X-Jadense-OCR-Model-Source': readOCRModelSource(host) } })
  const cancel = () => { void request(`/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) { cancel(); checkCancelled(signal) }
    for (;;) {
      const status = await request(`/jobs/${job.id}`, { signal }); checkCancelled(signal)
      if (status.state === 'complete') {
        await validateDocument(host as unknown as DocumentHost, source); checkCancelled(signal)
        return projectOCR(status.result, source)
      }
      if (status.state === 'error' || status.state === 'cancelled') throw new Error(ocrFailureMessage(status.error))
      progress(status.page ? uiText(`正在识别第 ${status.page} / ${status.total} 页`, `Recognizing page ${status.page} / ${status.total}`) : uiText('正在加载已安装的 OCR 模型…', 'Loading installed OCR models…'))
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally { signal.removeEventListener('abort', cancel) }
}
