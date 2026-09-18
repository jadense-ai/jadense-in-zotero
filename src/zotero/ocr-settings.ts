/** OCR 共用设置：自动读取本机状态，一个入口完成依赖和模型准备。 */
import type { ZoteroLike } from './runtime'
import { checkLocalOCR, installLocalOCR, prepareLocalOCRModels, OCR_MODEL_SOURCE_PREF, readOCRModelSource, type OCREnvironment } from './local-ocr'
import { createJdxSelect } from './custom-select'
import { uiText } from './ui-preferences'

/** 卸载只停止 UI 更新，不取消其他窗口共享的准备任务。 */
export function wireOCRSettings(host: ZoteroLike | null, root: HTMLElement | null) {
  if (!host || !root) return () => {}
  const doc = root.ownerDocument
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text
    return node
  }
  const body = make('div'); body.className = 'jdx-ocr-settings'
  const title = make('h3', uiText('OCR配置', 'OCR configuration'))
  const note = make('p', uiText('将 PDF 中的文字、表格和版面转为可用内容，供全文 Markdown、全文翻译和参考文献解析使用。识别在本机完成。', 'Extract text, tables and layout from PDFs for full Markdown, translation and references. Recognition runs locally.'))
  const overview = make('section'); overview.className = 'jdx-ocr-section'
  const heading = make('h4', uiText('本机 OCR', 'Local OCR'))
  const state = make('p', uiText('正在读取本机状态…', 'Reading local status…')); state.dataset.ocrState = 'loading'
  const steps = make('p', uiText('自动准备：识别组件 → 模型下载与验证 → 可以使用', 'Automatic setup: components → models and verification → ready to use'))
  const actions = make('div'); actions.className = 'jdx-actions'
  const install = make('button', uiText('启用本机 OCR', 'Enable local OCR')); install.type = 'button'
  install.className = 'jdx-button jdx-button-primary'; install.dataset.ocrAction = 'install'
  const status = make('p'); status.className = 'jdx-manager-inline-status jdx-pref-status'; status.setAttribute('role', 'status')
  actions.append(install); overview.append(heading, state, steps, actions, status)

  const source = make('section'); source.className = 'jdx-ocr-section'
  const sourceTitle = make('h4', uiText('模型下载源', 'Model download source'))
  const sourceRoot = make('div'); sourceRoot.dataset.ocrSetting = 'model-source'
  const sourceSelect = createJdxSelect(sourceRoot, { ariaLabel: sourceTitle.textContent || '', popupWidth: 300 })
  const sourceHelp = make('p', uiText('模型是本机识别所需的文件。默认使用 Hugging Face；连接困难时可改用魔搭或 HF-Mirror。已有模型继续复用，更换下载源不会重新安装。文字识别模型使用 RapidOCR 官方魔搭源。', 'Models are files required for local recognition. Use ModelScope or HF-Mirror if Hugging Face is unavailable. Changing the source reuses existing models without reinstalling. Text recognition models use RapidOCR’s official ModelScope source.'))
  source.append(sourceTitle, sourceRoot, sourceHelp)
  const tip = make('section'); tip.className = 'jdx-ocr-tip'
  const tipTitle = make('h4', uiText('💡 使用提示', '💡 Good to know'))
  tip.append(tipTitle, make('p', uiText('首次启用需要联网下载，可能持续数分钟。完成后无需反复检查，重开设置会自动显示状态。选文公式增强在首次使用时另行加载，不影响全文 OCR。PDF 不会发送到模型下载站点；全文翻译仍会将提取的内容发送给你选择的翻译服务。', 'First setup downloads files and may take several minutes. Once ready, no repeated checks are needed; settings refresh automatically. Selection formula enhancement loads separately on first use. PDFs are never sent to model download sites; full translation still sends extracted content to your chosen translation service.')))

  const details = make('details'); details.className = 'jdx-ocr-section'
  details.append(make('summary', uiText('环境与故障排查', 'Environment and troubleshooting')))
  const environment = make('p', uiText('正在读取组件信息…', 'Reading component information…'))
  const path = make('p'); path.className = 'jdx-ocr-path'
  const params = make('p', uiText('Python 是识别组件的运行环境，uv 负责安装，均由插件自动管理，不需要手动填写路径或环境变量。模型缓存使用当前 Zotero 配置目录。默认下载源可沿用系统 HF_ENDPOINT；镜像选项只对 OCR 子进程生效，不修改系统设置。', 'Python runs recognition components and uv installs them. The plugin manages both; no paths or environment variables need to be entered. Models are cached in the current Zotero profile. The default source honors the system HF_ENDPOINT; mirror choices apply only to OCR subprocesses and do not change system settings.'))
  const repair = make('button', uiText('修复识别组件', 'Repair recognition components')); repair.type = 'button'; repair.className = 'jdx-button'; repair.dataset.ocrAction = 'repair'
  details.append(make('h4', uiText('安装工具 · uv', 'Installation tool · uv')), environment, make('h4', uiText('运行环境与参数', 'Runtime and parameters')), params, make('h4', uiText('本机日志', 'Local logs')), path, make('p', uiText('仅在组件损坏或持续无法启动时使用修复。将重新同步依赖并自动验证，保留已下载模型。下载失败时，先更换上方下载源，再点击“继续准备”。', 'Repair only if components are damaged or cannot start. Dependencies will be synchronized and verified while retaining models. For download failures, change the source above and choose Continue setup.')), repair)
  body.append(title, note, overview, source, tip, details); root.append(body)
  let disposed = false, busy = false
  const syncSource = () => sourceSelect.setOptions([
    { value: 'default', label: uiText('默认（Hugging Face / 系统配置）', 'Default (Hugging Face / system setting)') },
    { value: 'hf-mirror', label: uiText('HF-Mirror（第三方镜像）', 'HF-Mirror (third-party mirror)') },
    { value: 'modelscope', label: uiText('魔搭 ModelScope（中国国内）', 'ModelScope (China)') },
  ], readOCRModelSource(host))
  sourceSelect.onChange(value => {
    try {
      host.Prefs?.set?.(OCR_MODEL_SOURCE_PREF, value === 'hf-mirror' || value === 'modelscope' ? value : 'default', true)
      status.textContent = uiText('下载源已保存，将用于接下来缺失文件的下载；已就绪模型可继续使用。', 'Source saved for future missing files; ready models remain usable.')
      status.removeAttribute('data-tone')
    } catch { status.textContent = uiText('下载源保存失败，请重试。', 'Could not save download source. Please retry.'); status.dataset.tone = 'error' }
    syncSource()
  })
  syncSource()
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(OCR_MODEL_SOURCE_PREF, syncSource, true) } catch { /* 可选跨窗同步不阻断设置。 */ }
  const render = (value: OCREnvironment) => {
    const ready = value.ready && value.modelsReady
    state.dataset.ocrState = ready ? 'ready' : 'missing'
    state.textContent = ready ? uiText('已就绪 · 可以开始全文任务', 'Ready · You can start full-document tasks') : value.ready ? uiText('识别组件已安装 · 还需准备模型', 'Components installed · Models need preparation') : uiText('尚未启用 · 点击下方按钮自动完成准备', 'Not enabled · Use the button below to set up automatically')
    install.hidden = !!ready
    install.textContent = value.ready ? uiText('继续准备', 'Continue setup') : uiText('启用本机 OCR', 'Enable local OCR')
    environment.textContent = value.uvPath ? `${value.uvVersion} · ${value.uvSource === 'user' ? uiText('复用已有安装', 'Using existing installation') : uiText('由插件管理', 'Managed by the plugin')}\n${value.uvPath}` : uiText('尚未找到兼容的 uv，启用时会自动下载，无需自行安装。', 'Compatible uv not found. Setup will download it automatically.')
    path.textContent = `${uiText('安装日志：', 'Installation log: ')}${value.logPath}\n${uiText('模型准备日志：', 'Model setup log: ')}${value.logPath.replace(/install\.log$/u, 'models-prepare.log')}`
  }
  const run = async (setup = false, repairing = false) => {
    if (busy || disposed) return
    busy = true; install.disabled = true; repair.disabled = true; sourceSelect.setDisabled(true); body.setAttribute('aria-busy', 'true')
    status.textContent = setup ? uiText('正在自动准备，可离开此页面，准备会继续…', 'Setting up automatically; you can leave this page while setup continues…') : uiText('正在读取本机状态，已有缓存将自动复用…', 'Reading local status and reusing cached models…')
    status.removeAttribute('data-tone')
    try {
      const progress = (text: string) => { if (!disposed) status.textContent = text }
      if (repairing) await installLocalOCR(host, progress, true)
      if (setup) await prepareLocalOCRModels(host, progress)
      const value = await checkLocalOCR(host)
      if (!disposed) { render(value); status.textContent = value.modelsReady ? uiText('之后直接使用即可，无需再次验证。', 'You can use OCR directly without verifying again.') : '' }
    } catch (error) {
      if (!disposed) {
        state.textContent = setup ? uiText('准备未完成 · 已下载内容会保留', 'Setup incomplete · Downloads are retained') : uiText('暂时无法读取状态', 'Status temporarily unavailable')
        state.dataset.ocrState = 'error'
        status.textContent = error instanceof Error ? error.message : String(error); status.dataset.tone = 'error'
        install.hidden = false; install.textContent = uiText('继续准备', 'Continue setup')
      }
    } finally {
      busy = false
      if (!disposed) { install.disabled = false; repair.disabled = false; sourceSelect.setDisabled(false); body.removeAttribute('aria-busy') }
    }
  }
  install.addEventListener('click', () => { void run(true) })
  repair.addEventListener('click', () => { void run(true, true) })
  // 回到窗口时重新投影，多个窗口共用进行中的读取；不定时轮询或自动下载。
  const refresh = () => { if (!busy && !disposed) void run() }
  doc.defaultView?.addEventListener('focus', refresh)
  void run()
  return () => { disposed = true; doc.defaultView?.removeEventListener('focus', refresh); if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); sourceSelect.destroy(); body.remove() }
}
