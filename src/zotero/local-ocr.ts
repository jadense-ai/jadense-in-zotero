/** 全文专用本机 OCR：管理插件自己的 Python 环境和进程，其他功能不依赖此服务。 */
import type { ZoteroLike } from './runtime'
import { checkCancelled, validateDocument, type DocumentHost, type PdfTextDocument, type PdfRect } from './pdf-document'
import { uiText } from './ui-preferences'

type Process = { stdin: { write(value: string): Promise<unknown>; close(): Promise<unknown> }; stdout: { readString(): Promise<string | null> }; wait(): Promise<{ exitCode: number }>; kill(): void }
type Platform = {
  IOUtils: { makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; writeUTF8(path: string, text: string): Promise<unknown>; exists(path: string): Promise<boolean>; read(path: string): Promise<Uint8Array> }
  PathUtils: { profileDir: string; join(...parts: string[]): string }
  ChromeUtils: { importESModule(uri: string): { Subprocess: { getEnvironment(): Record<string, string>; pathSearch(name: string): Promise<string>; call(options: { command: string; arguments: string[]; stderr: string }): Promise<Process> } } }
}
type SharedHost = ZoteroLike & { __jadenseOCR?: Promise<{ url: string; token: string; process: Process }>; __jadenseOCRInstall?: Promise<string> }
const resource = 'chrome://jadense-in-zotero/content/ocr/'
const platform = () => globalThis as unknown as Platform
const windows = (host: ZoteroLike) => (host.getMainWindow?.()?.navigator.platform ?? globalThis.navigator?.platform ?? '').toLowerCase().startsWith('win')
const network = (host: ZoteroLike) => { const win = host.getMainWindow?.(); return win?.fetch.bind(win) ?? globalThis.fetch.bind(globalThis) }

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

export type OCREnvironment = { uvPath: string; uvVersion: string; uvSource: string; ready: boolean; logPath: string }

/** 仅返回 OCR 相关环境状态，不读取其他 Python 项目。 */
export async function checkLocalOCR(host: ZoteroLike): Promise<OCREnvironment> {
  const active = (host as SharedHost).__jadenseOCRInstall
  if (active) await active.catch(() => {})
  const root = await prepareOCR(host)
  const process = await runInstaller(host, root, true)
  let output = '', chunk: string | null
  while ((chunk = await process.stdout.readString())) output += chunk
  if ((await process.wait()).exitCode !== 0) throw new Error(uiText('OCR 环境检查失败。', 'OCR environment check failed.') + '\n' + output.slice(-2000))
  const fields = Object.fromEntries(output.split(/\r?\n/u).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  return { uvPath: fields.uvPath ?? '', uvVersion: fields.uvVersion ?? '', uvSource: fields.uvSource ?? '', ready: fields.ready === 'true', logPath: platform().PathUtils.join(root, 'install.log') }
}

/** 失败不留 ready 标记，下次仍可重试；手动配置与全文任务共享并发安装。 */
export async function installLocalOCR(host: ZoteroLike, progress: (text: string) => void = () => {}) {
  const shared = host as SharedHost
  if (shared.__jadenseOCRInstall) return shared.__jadenseOCRInstall
  shared.__jadenseOCRInstall = (async () => {
    const { IOUtils: io, PathUtils: paths } = platform()
    const root = await prepareOCR(host)
    const python = paths.join(root, '.venv', windows(host) ? 'Scripts' : 'bin', windows(host) ? 'python.exe' : 'python')
    if (!await io.exists(python) || !await io.exists(paths.join(root, 'ready-2.126.0-3.9.2'))) {
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

async function service(host: ZoteroLike, progress: (text: string) => void) {
  const shared = host as SharedHost
  if (!shared.__jadenseOCR) shared.__jadenseOCR = (async () => {
    const root = await installLocalOCR(host, progress)
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
  })().catch(error => { delete shared.__jadenseOCR; throw error })
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
  return { source, ocrVersion: 1, pages: result.pages.map((page, pageIndex) => ({ pageIndex, pageLabel: String(pageIndex + 1), lines: [],
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
  const local = await service(host, progress); checkCancelled(signal)
  const headers = { Authorization: `Bearer ${local.token}` }
  const request = async (path: string, init?: RequestInit) => {
    const response = await network(host)(local.url + path, { ...init, headers: { ...headers, ...init?.headers }, credentials: 'omit' })
    if (!response.ok) throw new Error(uiText(`本机 OCR 请求失败（${response.status}）`, `Local OCR request failed (${response.status})`))
    return response.json()
  }
  const bytes = await platform().IOUtils.read(await item.getFilePathAsync()); checkCancelled(signal)
  // 上传成功后才登记取消钩子，取消与响应同时到达时仍显式清理服务器任务。
  const job = await request('/jobs', { method: 'POST', body: bytes as unknown as BodyInit })
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
      if (status.state === 'error' || status.state === 'cancelled') throw new Error(String(status.error || 'OCR cancelled'))
      progress(status.page ? uiText(`正在识别第 ${status.page} / ${status.total} 页`, `Recognizing page ${status.page} / ${status.total}`) : uiText('正在加载 OCR 模型（首次使用需要下载）…', 'Loading OCR models (download required on first use)…'))
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally { signal.removeEventListener('abort', cancel) }
}
