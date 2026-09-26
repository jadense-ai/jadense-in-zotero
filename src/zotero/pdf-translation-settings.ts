/** 对照翻译偏好与外置版面引擎分别挂载；浏览设置不下载引擎或启动翻译。 */
import type { ZoteroLike } from './runtime'
import { PDF_ENGINE, pdfPlatform, pdfRuntimeRoot, type PDFEngineProgress } from './pdf-translation-runtime'
import { pdfTranslationJobs } from './pdf-translation-jobs'
import { uiText } from './ui-preferences'
import { readPDFTranslationMode, savePDFTranslationMode, pdfModeLabel, type PDFTranslationMode } from './pdf-translation-policy'
import { wireTranslationSpeedSettings } from './translation-speed-settings'
import { createJdxSelect } from './custom-select'

export function wirePDFEngineSettings(host: ZoteroLike, root: HTMLElement | null) {
  if (!root) return () => {}
  const doc = root.ownerDocument, element = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
  const row = element('div'), description = element('div'), controls = element('div'), title = element('h3'), note = element('p'), status = element('p')
  row.className = 'jdx-feature-model-row'; row.dataset.pdfEngineSettings = ''
  title.textContent = uiText('版面解析引擎', 'Layout parsing engine')
  note.className = 'jdx-manager-settings-note jdx-pref-card-note'
  note.textContent = uiText('用于对照翻译的 PDF 版面解析与译文排版。首次下载独立引擎、模型和字体；翻译服务、模型与范围在功能配置中设置。', 'Parses PDF layouts and typesets translated PDFs. Downloads a separate engine, models and fonts once. Choose translation service, model and scope in Feature settings.')
  status.setAttribute('role', 'status'); description.append(note, status)
  controls.className = 'jdx-settings-controls'
  const actions = element('div'); actions.className = 'jdx-manager-actions'
  const prepare = element('button'), repair = element('button'), cancel = element('button'), check = element('button'), offline = element('button')
  for (const button of [prepare, repair, cancel, check, offline]) button.type = 'button'
  check.textContent = uiText('检测已安装引擎', 'Check installed engine'); check.dataset.pdfEngineCheck = ''
  offline.textContent = uiText('导入离线包', 'Import offline package'); offline.dataset.pdfEngineImport = ''
  prepare.textContent = uiText('准备 PDF 翻译引擎', 'Prepare PDF translation engine'); repair.textContent = uiText('修复引擎', 'Repair engine'); cancel.textContent = uiText('取消', 'Cancel'); cancel.hidden = true
  const help = element('a'); help.textContent = uiText('GitHub 下载与手动安装指南', 'GitHub downloads and manual installation')
  help.href = 'https://github.com/jadense-ai/jadense-in-zotero/blob/main/docs/pdf-engine.md'; help.target = '_blank'; help.rel = 'noopener noreferrer'
  help.addEventListener('click', event => {
    event.preventDefault()
    try {
      const open = (host as ZoteroLike & { launchURL?: (url: string) => void }).launchURL
      if (!open) throw new Error('System browser unavailable')
      open.call(host, help.href)
    } catch {
      status.textContent = uiText('无法打开浏览器，请复制指南链接到浏览器访问。', 'Could not open the browser. Copy the guide link into your browser.')
    }
  })
  const location = element('p'); location.className = 'jdx-manager-settings-note jdx-pref-card-note'; location.style.overflowWrap = 'anywhere'
  try { location.textContent = uiText('安装目录：', 'Install directory: ') + pdfRuntimeRoot() } catch { /* 不影响设置展示。 */ }
  actions.append(prepare, repair, offline, check, cancel); controls.append(actions, help, location); row.append(description, controls); root.append(title, row)
  let disposed = false, controller: AbortController | undefined
  const progress: PDFEngineProgress = (stage, detail) => {
    if (disposed) return
    const labels: Record<string, string> = {
      environment: uiText('检查安装环境', 'Checking installation environment'), uv: uiText('下载安装工具 uv', 'Downloading the uv installer'),
      imports: uiText('加载引擎依赖', 'Loading engine dependencies'),
      download: uiText('下载完整引擎包', 'Downloading engine package'), retry: uiText('下载中断，正在重试；已下载内容保留', 'Download interrupted; retrying with retained bytes'),
      verify: uiText('校验安装包', 'Verifying package'), extract: uiText('解压引擎', 'Extracting engine'), check: uiText('离线检测模型、字体和 PDF 渲染', 'Checking models, fonts and PDF rendering offline'),
      assets: uiText('准备模型和字体', 'Preparing models and fonts'), installed: uiText('引擎已安装，正在检测', 'Engine installed; checking'),
    }
    const bytes = Number(detail?.bytes), total = Number(detail?.total)
    const amount = total > 0 ? stage === 'download' ? ` · ${(bytes / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : ` · ${Math.round(bytes / total * 100)}%` : ''
    const label = stage === 'retry' && detail?.downloadStage === 'uv' ? uiText('安装工具下载中断，正在重试', 'Installer download interrupted; retrying') : labels[stage]
    status.textContent = (label ?? uiText('安装 Python 和引擎依赖', 'Installing Python and engine dependencies')) + amount + '…'
  }
  const run = async (operation: 'prepare' | 'repair' | 'check' | 'import') => {
    if (controller) return
    controller = new AbortController(); for (const button of [prepare, repair, check, offline]) button.disabled = true; cancel.hidden = false
    status.textContent = uiText('等待准备引擎…', 'Waiting to prepare the engine…')
    try {
      let archive: string | undefined
      if (operation === 'import') {
        const platform = globalThis as unknown as { ChromeUtils: { importESModule(url: string): { FilePicker: new () => { init(win: Window, title: string, mode: number): void; modeOpen: number; returnCancel: number; appendFilter(label: string, pattern: string): void; show(): Promise<number>; file: string } } } }
        const { FilePicker } = platform.ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs')
        const picker = new FilePicker(); picker.init(host.getMainWindow?.() ?? doc.defaultView!, uiText('选择官方离线引擎包', 'Choose official offline engine package'), picker.modeOpen); picker.appendFilter('ZIP', '*.zip')
        if (await picker.show() === picker.returnCancel || !picker.file) { status.textContent = uiText('已取消', 'Cancelled'); return }
        archive = picker.file
      }
      if (operation === 'check') await pdfTranslationJobs(host).checkEngine(controller.signal, progress)
      else await pdfTranslationJobs(host).prepare(controller.signal, progress, operation === 'repair', archive)
      if (!disposed) status.textContent = uiText('PDF 翻译引擎已就绪', 'PDF translation engine ready')
    } catch (error) { if (!disposed) status.textContent = controller.signal.aborted ? uiText('已取消，已下载内容保留；再次准备可继续。', 'Cancelled; downloaded bytes retained. Prepare again to continue.') : error instanceof Error ? error.message : String(error) } finally { controller = undefined; for (const button of [prepare, repair, check, offline]) button.disabled = false; cancel.hidden = true }
  }
  prepare.addEventListener('click', () => { void run('prepare') }); repair.addEventListener('click', () => { void run('repair') }); check.addEventListener('click', () => { void run('check') }); offline.addEventListener('click', () => { void run('import') }); cancel.addEventListener('click', () => controller?.abort())
  void Promise.resolve().then(() => pdfPlatform().IOUtils.exists(pdfPlatform().PathUtils.join(pdfRuntimeRoot(), PDF_ENGINE))).then(ready => { if (!disposed && !controller) status.textContent = ready ? uiText('已有引擎安装记录，可点击检测确认。', 'An installation was recorded. Check to verify it.') : uiText('首次使用时准备，也可导入离线包或检测手动安装。', 'Prepare on first use, import an offline package, or check a manual installation.') }).catch(() => {})
  return () => { disposed = true; controller?.abort(); title.remove(); row.remove() }
}

/** 功能偏好复用运行时现有键；不改变历史任务身份，范围用于新任务，同步滚动用于下次打开。 */
export function wirePDFTranslationSettings(host: ZoteroLike, root: HTMLElement | null, showDependencies: () => void) {
  if (!root) return () => {}
  const doc = root.ownerDocument, make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text; return node
  }
  const body = make('div'); body.dataset.pdfTranslationSettings = ''
  const row = make('div'), description = make('div'), controls = make('div')
  row.className = 'jdx-feature-model-row'; controls.className = 'jdx-settings-controls'
  const title = make('h3', uiText('默认翻译范围', 'Default translation scope'))
  const note = make('p', uiText('精简：翻译正文、图表说明与学术脚注，出版信息及参考文献保留原文。完整：翻译所有可译文字。仅影响新任务，阅读器可单次覆盖。', 'Concise translates content, captions and academic footnotes while preserving publication details and references. Full translates all prose. Applies to new tasks; the reader can override it once.'))
  note.className = 'jdx-manager-settings-note jdx-pref-card-note'
  const selectRoot = make('div'); selectRoot.dataset.pdfTranslationMode = ''
  const select = createJdxSelect(selectRoot, { ariaLabel: title.textContent! })
  const status = make('p'); status.setAttribute('role', 'status')
  description.append(title, note); controls.append(selectRoot, status); row.append(description, controls)
  const linkedRow = make('div'); linkedRow.className = 'jdx-feature-model-row'
  const linkedDescription = make('div'), linkedLabel = make('label'), linked = make('input'); linked.type = 'checkbox'; linked.dataset.pdfLinkedScroll = ''
  linkedLabel.className = 'jdx-manager-checkbox jdx-pref-checkbox'
  linkedLabel.append(linked, make('span', uiText('同步滚动', 'Synchronized scrolling')))
  const linkedNote = make('p', uiText('下次打开对照阅读时生效；阅读器中仍可随时切换。', 'Applies when opening the next bilingual view; you can also toggle it in the reader.')); linkedNote.className = note.className
  linkedDescription.append(make('h3', uiText('对照阅读', 'Bilingual reading')), linkedNote); linkedRow.append(linkedDescription, linkedLabel)
  const dependencyRow = make('div'); dependencyRow.className = 'jdx-feature-model-row'
  const button = make('button', uiText('配置版面解析引擎', 'Configure layout engine')); button.type = 'button'; button.className = 'jdx-button'; button.addEventListener('click', showDependencies)
  const actions = make('div'); actions.className = 'jdx-manager-actions'; actions.append(button)
  dependencyRow.append(make('h3', uiText('外置依赖', 'External dependencies')), actions)
  body.append(row, linkedRow, dependencyRow); root.append(body)
  const key = 'extensions.jadenseInZotero.pdfLinkedScroll'
  const sync = () => { select.setOptions((['concise', 'full'] as const).map(value => ({ value, label: pdfModeLabel(value) })), readPDFTranslationMode(host)); linked.checked = host.Prefs?.get(key, true) !== false }
  const save = (work: () => void) => { try { work(); status.textContent = '' } catch { status.textContent = uiText('设置保存失败，请重试。', 'Could not save settings. Please retry.') } sync() }
  select.onChange(value => save(() => savePDFTranslationMode(host, value as PDFTranslationMode)))
  linked.addEventListener('change', () => save(() => host.Prefs?.set(key, linked.checked, true)))
  const observers: unknown[] = []
  for (const pref of [key, 'extensions.jadenseInZotero.pdfTranslationMode']) {
    try { const id = host.Prefs?.registerObserver?.(pref, sync, true); if (id !== undefined) observers.push(id) } catch { /* 跨窗同步不可用不阻断设置。 */ }
  }
  const stopSpeed = wireTranslationSpeedSettings(host, body)
  sync()
  return () => { stopSpeed(); select.destroy(); observers.forEach(id => host.Prefs?.unregisterObserver?.(id)); body.remove() }
}
