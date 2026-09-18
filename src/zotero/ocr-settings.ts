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
  const panel = make('div'); panel.className = 'jdx-runtime-status'
  const announcement = make('div'); announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite'); announcement.setAttribute('aria-atomic', 'true')
  const state = make('p'); state.className = 'jdx-runtime-status-title'; state.dataset.ocrState = 'loading'
  const status = make('p'); status.className = 'jdx-runtime-status-description'
  const progressBar = make('progress'); progressBar.hidden = true; progressBar.setAttribute('aria-label', uiText('本机 OCR 准备进度', 'Local OCR setup progress'))
  const actions = make('div'); actions.className = 'jdx-actions'
  const install = make('button', uiText('启用本机 OCR', 'Enable local OCR')); install.type = 'button'
  install.className = 'jdx-button jdx-button-primary'; install.dataset.ocrAction = 'install'
  const check = make('button', uiText('重新检查', 'Check again')); check.type = 'button'; check.className = 'jdx-button'; check.dataset.ocrAction = 'check'
  const repair = make('button', uiText('修复识别组件', 'Repair recognition components')); repair.type = 'button'; repair.className = 'jdx-button'; repair.dataset.ocrAction = 'repair'
  repair.title = uiText('重新同步依赖并验证模型，保留已下载模型。', 'Synchronize dependencies and verify models, retaining downloaded models.')
  announcement.append(state, status); actions.append(install, check, repair); panel.append(announcement, progressBar, actions); overview.append(heading, panel)

  const source = make('section'); source.className = 'jdx-ocr-section'
  const sourceTitle = make('h4', uiText('模型下载源', 'Model download source'))
  const sourceRoot = make('div'); sourceRoot.dataset.ocrSetting = 'model-source'
  const sourceSelect = createJdxSelect(sourceRoot, { ariaLabel: sourceTitle.textContent || '', popupWidth: 300 })
  const sourceHelp = make('p', uiText('模型是本机识别所需的文件。默认使用 Hugging Face；连接困难时可改用魔搭或 HF-Mirror。已有模型继续复用，更换下载源不会重新安装。文字识别模型使用 RapidOCR 官方魔搭源。', 'Models are files required for local recognition. Use ModelScope or HF-Mirror if Hugging Face is unavailable. Changing the source reuses existing models without reinstalling. Text recognition models use RapidOCR’s official ModelScope source.'))
  const sourceStatus = make('p'); sourceStatus.className = 'jdx-manager-inline-status jdx-pref-status'; sourceStatus.setAttribute('role', 'status'); sourceStatus.setAttribute('aria-atomic', 'true')
  source.append(sourceTitle, sourceRoot, sourceHelp, sourceStatus)
  const tip = make('section'); tip.className = 'jdx-ocr-tip'
  const tipTitle = make('h4', uiText('💡 使用提示', '💡 Good to know'))
  tip.append(tipTitle, make('p', uiText('首次启用需要联网下载，可能持续数分钟。完成后无需反复检查，重开设置会自动显示状态。选文公式增强在首次使用时另行加载，不影响全文 OCR。PDF 不会发送到模型下载站点；全文翻译仍会将提取的内容发送给你选择的翻译服务。', 'First setup downloads files and may take several minutes. Once ready, no repeated checks are needed; settings refresh automatically. Selection formula enhancement loads separately on first use. PDFs are never sent to model download sites; full translation still sends extracted content to your chosen translation service.')))

  const details = make('details'); details.className = 'jdx-ocr-section'
  details.append(make('summary', uiText('环境与故障排查', 'Environment and troubleshooting')))
  const environment = make('p', uiText('正在读取组件信息…', 'Reading component information…'))
  const path = make('p'); path.className = 'jdx-ocr-path'
  const errorDetails = make('p'); errorDetails.className = 'jdx-ocr-path'; errorDetails.hidden = true
  const params = make('p', uiText('Python 是识别组件的运行环境，uv 负责安装，均由插件自动管理，不需要手动填写路径或环境变量。模型缓存使用当前 Zotero 配置目录。默认下载源可沿用系统 HF_ENDPOINT；镜像选项只对 OCR 子进程生效，不修改系统设置。', 'Python runs recognition components and uv installs them. The plugin manages both; no paths or environment variables need to be entered. Models are cached in the current Zotero profile. The default source honors the system HF_ENDPOINT; mirror choices apply only to OCR subprocesses and do not change system settings.'))
  details.append(make('h4', uiText('安装工具 · uv', 'Installation tool · uv')), environment, make('h4', uiText('运行环境与参数', 'Runtime and parameters')), params, make('h4', uiText('本机日志', 'Local logs')), path, make('p', uiText('仅在组件损坏或持续无法启动时使用修复。将重新同步依赖并自动验证，保留已下载模型。下载失败时，先更换上方下载源，再点击“继续准备”。', 'Repair only if components are damaged or cannot start. Dependencies will be synchronized and verified while retaining models. For download failures, change the source above and choose Continue setup.')))
  details.append(errorDetails)
  body.append(title, note, overview, source, tip, details); root.append(body)
  let disposed = false, busy = false, retryRead = false
  // 单一状态出口：替换旧语义，保留可发现的手动兜底，不抑制进度播报。
  const showState = (kind: string, title: string, description: string) => {
    state.dataset.ocrState = kind; panel.dataset.state = kind
    state.textContent = title; status.textContent = description
    progressBar.hidden = !['loading', 'working'].includes(kind)
  }
  const syncSource = () => sourceSelect.setOptions([
    { value: 'default', label: uiText('默认（Hugging Face / 系统配置）', 'Default (Hugging Face / system setting)') },
    { value: 'hf-mirror', label: uiText('HF-Mirror（第三方镜像）', 'HF-Mirror (third-party mirror)') },
    { value: 'modelscope', label: uiText('魔搭 ModelScope（中国国内）', 'ModelScope (China)') },
  ], readOCRModelSource(host))
  sourceSelect.onChange(value => {
    try {
      host.Prefs?.set?.(OCR_MODEL_SOURCE_PREF, value === 'hf-mirror' || value === 'modelscope' ? value : 'default', true)
      sourceStatus.textContent = uiText('下载源已保存，将用于接下来缺失文件的下载；已就绪模型可继续使用。', 'Source saved for future missing files; ready models remain usable.')
      sourceStatus.dataset.kind = 'success'
    } catch { sourceStatus.textContent = uiText('下载源保存失败，请重试。', 'Could not save download source. Please retry.'); sourceStatus.dataset.kind = 'error' }
    syncSource()
  })
  syncSource()
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(OCR_MODEL_SOURCE_PREF, syncSource, true) } catch { /* 可选跨窗同步不阻断设置。 */ }
  const render = (value: OCREnvironment) => {
    const ready = value.ready && value.modelsReady
    showState(ready ? 'ready' : 'missing', ready ? uiText('已就绪 · 可以开始全文任务', 'Ready · You can start full-document tasks') : value.ready ? uiText('识别组件已安装 · 还需准备模型', 'Components installed · Models need preparation') : uiText('尚未启用', 'Not enabled'),
      ready ? uiText('可直接使用全文 Markdown、全文翻译和参考文献解析。', 'Full Markdown, full translation and reference extraction are available.') : value.ready ? uiText('继续下载并验证模型，已下载内容会复用。', 'Continue downloading and verifying models. Existing downloads will be reused.') : uiText('首次启用将自动安装识别组件、下载并验证模型，可能需要数分钟。', 'First setup installs components, downloads and verifies models. This may take several minutes.'))
    install.hidden = !!ready
    check.hidden = false
    install.textContent = value.ready ? uiText('继续准备', 'Continue setup') : uiText('启用本机 OCR', 'Enable local OCR')
    environment.textContent = value.uvPath ? `${value.uvVersion} · ${value.uvSource === 'user' ? uiText('复用已有安装', 'Using existing installation') : uiText('由插件管理', 'Managed by the plugin')}\n${value.uvPath}` : uiText('尚未找到兼容的 uv，启用时会自动下载，无需自行安装。', 'Compatible uv not found. Setup will download it automatically.')
    path.textContent = `${uiText('安装日志：', 'Installation log: ')}${value.logPath}\n${uiText('模型准备日志：', 'Model setup log: ')}${value.logPath.replace(/install\.log$/u, 'models-prepare.log')}`
  }
  const run = async (setup = false, repairing = false) => {
    if (busy || disposed) return
    busy = true; retryRead = false; install.disabled = true; check.disabled = true; repair.disabled = true; sourceSelect.setDisabled(true)
    errorDetails.hidden = true; errorDetails.textContent = ''
    showState(setup ? 'working' : 'loading', setup ? uiText('正在准备本机 OCR', 'Setting up local OCR') : uiText('正在读取本机状态…', 'Reading local status…'), setup ? uiText('可离开此页面，准备会继续。', 'You can leave this page while setup continues.') : uiText('正在检查识别组件和模型，已有缓存将自动复用。', 'Checking components and models; cached files will be reused.'))
    try {
      const progress = (text: string) => { if (!disposed) status.textContent = text }
      if (repairing) await installLocalOCR(host, progress, true)
      if (setup) await prepareLocalOCRModels(host, progress)
      const value = await checkLocalOCR(host)
      if (!disposed) render(value)
    } catch (error) {
      if (!disposed) {
        retryRead = !setup
        showState('error', setup ? uiText('准备未完成 · 已下载内容会保留', 'Setup incomplete · Downloads are retained') : uiText('暂时无法读取状态', 'Status temporarily unavailable'), setup ? uiText('请重试；下载失败时可更换下方下载源。错误详情见“环境与故障排查”。', 'Retry, or change the source below if downloads fail. See Environment and troubleshooting for error details.') : uiText('请重新读取状态；此操作不会安装或下载。错误详情见“环境与故障排查”。', 'Read the status again; this will not install or download files. See Environment and troubleshooting for error details.'))
        errorDetails.textContent = `${uiText('最近错误：', 'Latest error: ')}${error instanceof Error ? error.message : String(error)}`; errorDetails.hidden = false
        check.hidden = retryRead
        install.hidden = false; install.textContent = setup ? uiText('继续准备', 'Continue setup') : uiText('重新读取状态', 'Read status again')
      }
    } finally {
      busy = false
      if (!disposed) { install.disabled = false; check.disabled = false; repair.disabled = false; sourceSelect.setDisabled(false) }
    }
  }
  install.addEventListener('click', () => { void run(!retryRead) })
  check.addEventListener('click', () => { void run() })
  repair.addEventListener('click', () => { void run(true, true) })
  // 回到窗口时重新投影，多个窗口共用进行中的读取；不定时轮询或自动下载。
  const refresh = () => { if (!busy && !disposed) void run() }
  doc.defaultView?.addEventListener('focus', refresh)
  void run()
  return () => { disposed = true; doc.defaultView?.removeEventListener('focus', refresh); if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); sourceSelect.destroy(); body.remove() }
}
