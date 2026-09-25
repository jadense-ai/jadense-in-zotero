/** PDF 排版引擎的独立环境和 stdio 边界；凭据始终留在 Zotero 请求层。 */
import type { ZoteroLike } from './runtime'
import { checkCancelled } from './pdf-document'
import { uiText } from './ui-preferences'

export const PDF_ENGINE = 'babeldoc-0.6.4-v1'
export const PDF_ADAPTER = 'batch-v4'
export type PDFEngineProgress = (stage: string, detail?: Record<string, unknown>) => void
type Process = { pid?: number; stdin: { write(text: string): Promise<unknown>; close(): Promise<unknown> }; stdout: { readString(): Promise<string | null> }; stderr: { readString(): Promise<string | null> }; wait(): Promise<{ exitCode: number }>; kill(): void }
export type PDFPlatform = {
  IOUtils: { exists(path: string): Promise<boolean>; makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown>; read(path: string): Promise<Uint8Array>; readUTF8(path: string): Promise<string>; writeUTF8(path: string, text: string, options?: { tmpPath: string }): Promise<unknown>; copy(from: string, to: string): Promise<unknown>; remove(path: string, options?: { ignoreAbsent: boolean }): Promise<unknown>; getChildren(path: string): Promise<string[]> }
  PathUtils: { profileDir: string; join(...parts: string[]): string; filename(path: string): string }
  ChromeUtils: { importESModule(uri: string): { Subprocess: { getEnvironment(): Record<string, string>; call(options: { command: string; arguments: string[]; environment?: Record<string, string>; stderr: string }): Promise<Process> } } }
}
export const pdfPlatform = () => globalThis as unknown as PDFPlatform
export const pdfRuntimeRoot = () => { const p = pdfPlatform().PathUtils; return p.join(p.profileDir, 'jadense-pdf-translation') }
export const pdfTaskDirectory = (id: string) => {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid PDF task identity')
  return pdfPlatform().PathUtils.join(pdfRuntimeRoot(), 'tasks', id)
}
const isWindows = (host: ZoteroLike) => (host.getMainWindow?.()?.navigator.platform ?? '').toLowerCase().startsWith('win')

/** 安装失败按阶段给出恢复入口；仅使用固定类别，不回显下载地址或代理凭据。 */
function installationFailure(stage: string, category = '') {
  const stages: Record<string, string> = {
    uv: uiText('下载安装工具 uv', 'Downloading the uv installer'),
    download: uiText('下载完整 PDF 引擎包', 'Downloading the complete PDF engine'),
    dependencies: uiText('安装 Python 和引擎依赖', 'Installing Python and engine dependencies'),
    imports: uiText('加载引擎依赖', 'Loading engine dependencies'),
    extract: uiText('解压 PDF 引擎', 'Extracting the PDF engine'),
    verify: uiText('校验安装包', 'Verifying the installation package'),
    check: uiText('检测模型、字体和 PDF 渲染', 'Checking models, fonts and PDF rendering'),
    environment: uiText('检查安装环境', 'Checking the installation environment'),
  }
  const causes: Record<string, string> = {
    proxy: uiText('请检查安装器代理地址、HTTP 端口及代理认证。', 'Check the installer proxy address, HTTP port and authentication.'),
    tls: uiText('安全连接或证书校验失败，请检查系统时间及单位证书配置。', 'The secure connection or certificate check failed. Check system time and managed certificates.'),
    dns: uiText('无法解析下载站地址，请检查网络和 DNS。', 'The download host could not be resolved. Check the network and DNS.'),
    connect: uiText('无法连接下载站或代理，请检查网络和代理是否可用。', 'Cannot connect to the download host or proxy. Check network and proxy access.'),
    timeout: uiText('下载超时，请检查网络后重试。', 'The download timed out. Check the network and retry.'),
    http: uiText('下载站拒绝请求或文件不可用。', 'The download was rejected or the file is unavailable.'),
    integrity: uiText('安装包校验失败，请重新获取与插件匹配的官方包。', 'Package verification failed. Download the matching official package again.'),
    permission: uiText('无法写入安装目录，请检查目录权限或联系管理员。', 'Cannot write to the installation directory. Check permissions or contact your administrator.'),
    disk: uiText('读写安装文件失败，请检查磁盘空间和目录权限。', 'Cannot read or write installation files. Check disk space and permissions.'),
  }
  return (stages[stage] ?? uiText('准备 PDF 引擎', 'Preparing the PDF engine')) + uiText('失败。', ' failed. ')
    + (causes[category] ?? uiText('请重试，并查看安装目录中的 install.log。', 'Retry and inspect install.log in the installation directory.'))
    + uiText(' Windows x64 可在设置 → 外置依赖配置中导入官方离线包，无需预装 Python 或 uv。安装与环境说明见“GitHub 下载与手动安装指南”。', ' On Windows x64, import the official offline package in Settings → External dependencies; Python and uv need not be preinstalled. See “GitHub downloads and manual installation” for environment setup.')
}

export function parsePDFMessage(line: string): Record<string, unknown> | null {
  try {
    if (line.startsWith('JADENSE_PDF_PROGRESS ')) return { ...JSON.parse(line.slice('JADENSE_PDF_PROGRESS '.length)), type: 'progress' }
    const value = JSON.parse(line); return value && typeof value.type === 'string' ? value : null
  } catch { return null }
}

/** Gecko 管道 EOF 为 null 或空串；跨 chunk 拼接 JSON，不等待不存在的下一行。 */
export async function* readPDFMessages(stream: { readString(): Promise<string | null> }, activity = () => {}) {
  let pending = '', chunk: string | null
  while ((chunk = await stream.readString())) {
    activity()
    pending += chunk
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const message = parsePDFMessage(pending.slice(0, newline)); pending = pending.slice(newline + 1)
      if (message) yield message
    }
  }
  const last = parsePDFMessage(pending)
  if (last) yield last
}

/** 持续消费两条输出流，翻译回复串行写回；取消和超时终止所启动的进程树。 */
async function processRun(host: ZoteroLike, command: string, args: string[], signal: AbortSignal, onMessage: (value: Record<string, unknown>) => Promise<unknown>, initial?: unknown, timeout = 30 * 60_000, finishSignal?: AbortSignal) {
  checkCancelled(signal)
  const { Subprocess } = pdfPlatform().ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs')
  const environment = { ...Subprocess.getEnvironment(), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' }
  delete (environment as Record<string, string>).PYTHONPATH; delete (environment as Record<string, string>).PYTHONHOME
  const process = await Subprocess.call({ command, arguments: args, stderr: 'pipe', environment })
  let terminated = false, timedOut = false
  let releaseTermination!: () => void
  const termination = new Promise<void>(resolve => { releaseTermination = resolve })
  const kill = () => {
    if (terminated) return
    terminated = true
    releaseTermination()
    if (isWindows(host) && process.pid) {
      const env = Subprocess.getEnvironment()
      void Subprocess.call({ command: pdfPlatform().PathUtils.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe'), arguments: ['/PID', String(process.pid), '/T', '/F'], stderr: 'stdout' })
        .then(async child => { while (await child.stdout.readString()) { /* drain */ } await child.wait() }).catch(() => process.kill())
    } else process.kill()
  }
  signal.addEventListener('abort', kill, { once: true })
  let lastProgress = Date.now()
  const pending = new Set<Promise<void>>()
  let writeTail: Promise<unknown> = Promise.resolve(), dispatchError: unknown
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (finishTimer) return
    finishTimer = setTimeout(() => { timedOut = true; kill() }, 120_000)
    writeTail = writeTail.then(() => process.stdin.write(JSON.stringify({ type: 'cancel' }) + '\n'))
    void writeTail.catch(error => { dispatchError ??= error; kill() })
  }
  // 模型/配额等待由请求层管理，不计为排版引擎无进展。
  const timer = setInterval(() => { if (!pending.size && Date.now() - lastProgress >= timeout) { timedOut = true; kill() } }, 1000)
  let complete = false
  // 不把引擎日志（可能含原文）保存到插件诊断；只显示结构化阶段与错误。
  let installationLog = ''
  let installationStage = 'environment', installationCategory = ''
  const drain = (async () => { let text: string | null; while ((text = await process.stderr.readString())) { lastProgress = Date.now(); if (!initial) installationLog = (installationLog + text).slice(-3000) } })()
  try {
    checkCancelled(signal)
    if (initial) await process.stdin.write(JSON.stringify(initial) + '\n')
    finishSignal?.addEventListener('abort', finish, { once: true })
    if (finishSignal?.aborted) finish()
    for await (const message of readPDFMessages(process.stdout, () => { lastProgress = Date.now() })) {
        checkCancelled(signal)
        lastProgress = Date.now()
        if (!initial && message.type === 'install-error') {
          installationStage = String(message.stage ?? installationStage); installationCategory = String(message.category ?? '')
          continue
        }
        if (!initial && message.type === 'progress' && message.stage !== 'retry') installationStage = String(message.stage ?? installationStage)
        if (message.type === 'error') throw new Error(message.category === 'incomplete' ? uiText(`翻译已暂停：补缺一次后仍有 ${Number(message.missing) || 1} 个文段未完成，已保留成功译文。`, `Translation paused: ${Number(message.missing) || 1} passages remain incomplete after one repair. Successful translations were retained.`) : String(message.message ?? 'PDF translation failed'))
        if (message.type === 'complete') complete = true
        if (message.type !== 'translate') { await onMessage(message); continue }
        const operation = Promise.resolve().then(() => onMessage(message)).then(reply => {
          if (signal.aborted || terminated) return
          writeTail = writeTail.then(() => process.stdin.write(JSON.stringify(reply) + '\n'))
          return writeTail
        }).then(() => {}).catch(error => { dispatchError ??= error; kill() }).finally(() => { pending.delete(operation); lastProgress = Date.now() })
        pending.add(operation)
        // 有界回压；worker 本身也只保留有限 future。
        if (pending.size >= 8) await Promise.race([...pending, termination])
        if (terminated) break
    }
    if (dispatchError) throw dispatchError
    await Promise.race([Promise.all(pending), termination])
    if (dispatchError) throw dispatchError
    const result = await process.wait()
    // 等待 stderr EOF 后再构造错误；避免快速退出时丢失最后一段安装日志。
    await drain
    checkCancelled(signal)
    if (timedOut) throw new Error(finishSignal?.aborted ? uiText('保存已完成译文超时，已保留最近成果和译文缓存，请重试。', 'Saving translations timed out. The latest PDF and cached translations were retained. Retry.') : uiText('PDF 翻译阶段超时，请重试。', 'PDF translation stage timed out. Retry.'))
    if (result.exitCode !== 0 || (initial && !complete)) throw new Error(!initial ? installationFailure(installationStage, installationCategory) : uiText('PDF 引擎未完成，请修复引擎或重试。', 'PDF engine did not finish. Repair the engine or retry.'))
  } catch (error) { kill(); throw error } finally {
    clearInterval(timer); signal.removeEventListener('abort', kill)
    if (finishTimer) clearTimeout(finishTimer)
    finishSignal?.removeEventListener('abort', finish)
    await drain.catch(() => {})
    // 仅安装器输出落盘，翻译原文和 Provider 消息从不写入该日志。
    if (!initial && installationLog) await pdfPlatform().IOUtils.writeUTF8(pdfPlatform().PathUtils.join(pdfRuntimeRoot(), 'install.log'), installationLog.replace(/https?:\/\/\S+/gu, '[download URL]')).catch(() => {})
  }
}

async function deployPDFResources(host: ZoteroLike, signal: AbortSignal) {
  const { IOUtils: io, PathUtils: paths } = pdfPlatform(), root = pdfRuntimeRoot()
  await io.makeDirectory(root, { ignoreExisting: true })
  const window = host.getMainWindow?.()
  if (!window) throw new Error('Zotero window unavailable')
  const network = window.fetch.bind(window)
  for (const name of ['pyproject.toml', 'uv.lock', 'worker.py', 'batch_adapter.py', 'progressive_pipeline.py', 'install.ps1', 'install.sh', 'install-bundle.ps1', 'install-network.ps1', 'bundles.json']) {
    checkCancelled(signal)
    const response = await network(`chrome://jadense-in-zotero/content/pdf-translation/${name}`, { signal })
    if (!response.ok) throw new Error(`Cannot load PDF engine resource: ${name}`)
    const text = await response.text()
    // Windows PowerShell 5.1 按 ANSI 读取无 BOM 脚本，中文注释也可能破坏解析。
    await io.writeUTF8(paths.join(root, name), name.endsWith('.ps1') ? '\uFEFF' + text.replace(/^\uFEFF/u, '') : text)
  }
}

/** 显式检测手动安装；不下载、不调用 Provider，失败清理过期就绪标记。 */
export async function checkPDFEngine(host: ZoteroLike, signal: AbortSignal, progress: PDFEngineProgress) {
  await deployPDFResources(host, signal)
  try {
    const { IOUtils: io, PathUtils: paths } = pdfPlatform(), root = pdfRuntimeRoot()
    const portable = paths.join(root, 'runtime', 'python', ...(isWindows(host) ? ['python.exe'] : ['bin', 'python3']))
    const legacy = paths.join(root, '.venv', isWindows(host) ? 'Scripts' : 'bin', isWindows(host) ? 'python.exe' : 'python')
    if (!await io.exists(portable) && !await io.exists(legacy)) throw new Error(uiText('尚未安装 PDF 引擎。请点击准备或导入离线包；手动安装请使用下方目录。', 'PDF engine is not installed. Prepare or import an offline package, or install manually in the directory below.'))
    await runPDFWorker(host, { operation: 'check' }, signal, async message => progress(String(message.stage ?? 'check'), message))
  }
  catch (error) {
    for (const marker of [PDF_ENGINE, PDF_ADAPTER]) await pdfPlatform().IOUtils.remove(pdfPlatform().PathUtils.join(pdfRuntimeRoot(), marker), { ignoreAbsent: true })
    throw error
  }
}

/** 自动准备和离线导入共用队列、校验和健康检查；旧 .venv 手动安装继续兼容。 */
export async function preparePDFEngine(host: ZoteroLike, signal: AbortSignal, progress: PDFEngineProgress, repair = false, archive?: string) {
  const { IOUtils: io, PathUtils: paths } = pdfPlatform(), root = pdfRuntimeRoot()
  await deployPDFResources(host, signal)
  if (!repair && !archive) {
    try { await checkPDFEngine(host, signal, progress); return } catch { checkCancelled(signal) }
  }
  for (const marker of [PDF_ENGINE, PDF_ADAPTER]) await io.remove(paths.join(root, marker), { ignoreAbsent: true })
  progress('dependencies')
  const { Subprocess } = pdfPlatform().ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs')
  const env = Subprocess.getEnvironment()
  const catalog = JSON.parse(await io.readUTF8(paths.join(root, 'bundles.json'))) as Record<string, { published?: boolean } | undefined>
  const target = (env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE ?? '').toUpperCase() === 'ARM64' ? 'windows-arm64' : 'windows-x64'
  // 本地包可先验收离线导入；公开附件验证前不将普通用户导向不存在的下载地址。
  const bundled = isWindows(host) && Boolean(catalog[target]) && (Boolean(archive) || catalog[target]?.published === true)
  if (archive && !bundled) throw new Error(uiText('此平台尚无已验证离线包，请按安装指南手动安装后检测。', 'No verified offline package for this platform. Follow the manual installation guide and check the engine.'))
  await processRun(host, isWindows(host) ? paths.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh',
    isWindows(host) ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.join(root, bundled ? 'install-bundle.ps1' : 'install.ps1'), root, ...(archive ? [archive] : [])] : [paths.join(root, 'install.sh'), root], signal, async message => progress(String(message.stage ?? 'dependencies'), message))
  progress(bundled ? 'check' : 'assets')
  await runPDFWorker(host, { operation: bundled ? 'check' : 'prepare' }, signal, async message => progress(String(message.stage ?? 'assets'), message))
}

export async function runPDFWorker(host: ZoteroLike, config: Record<string, unknown>, signal: AbortSignal, onMessage: (message: Record<string, unknown>) => Promise<unknown>, finishSignal?: AbortSignal) {
  const paths = pdfPlatform().PathUtils, root = pdfRuntimeRoot()
  const portable = paths.join(root, 'runtime', 'python', ...(isWindows(host) ? ['python.exe'] : ['bin', 'python3']))
  const command = await pdfPlatform().IOUtils.exists(portable) ? portable : paths.join(root, '.venv', isWindows(host) ? 'Scripts' : 'bin', isWindows(host) ? 'python.exe' : 'python')
  return processRun(host, command, ['-s', '-u', paths.join(root, 'worker.py')], signal, onMessage, { ...config, root }, undefined, finishSignal)
}
