import { wireSettingsNavigation } from './settings-navigation'
/** OCR 共用设置：自动读取本机状态，一个入口完成依赖和模型准备。 */
import type { ZoteroLike } from './runtime'
import { checkLocalOCR, installLocalOCR, prepareLocalOCRModels, removeLocalOCR, observeOCRProgress, isLocalOCRPreparing, OCR_MODEL_SOURCE_PREF, readOCRModelSource, type OCREnvironment, type OCRProgress } from './local-ocr'
import { createJdxSelect } from './custom-select'
import { uiText } from './ui-preferences'
import { lifecycleTrace } from './lifecycle-diagnostics'
import { wireCloudOCRSettings } from './cloud-ocr-settings'
import { wirePDFEngineSettings } from './pdf-translation-settings'

/** 卸载只停止 UI 更新，不取消其他窗口共享的准备任务。 */
export function wireOCRSettings(host: ZoteroLike | null, root: HTMLElement | null) {
  if (!host || !root) return () => {}
  const doc = root.ownerDocument
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text
    return node
  }
  const headingPage = make('h3', uiText('外置依赖配置', 'External dependencies'))
  const body = make('div'); body.className = 'jdx-ocr-settings jdx-settings-task'; body.dataset.externalDependency = 'ocr'
  const layout = make('section'); layout.className = 'jdx-settings-task'; layout.dataset.externalDependency = 'layout'
  root.append(headingPage, layout)
  const stopEngine = wirePDFEngineSettings(host, layout)
  const title = make('h3', uiText('OCR配置', 'OCR configuration'))
  const note = make('p', uiText('将 PDF 中的文字、表格和版面转为可用内容，供全文 Markdown、文献解析和参考文献提取使用。可选择本机或云端服务。', 'Extract text, tables and layout for Markdown, literature analysis and references using a local or cloud engine.'))
  const overview = make('section'); overview.className = 'jdx-ocr-section'
  const heading = make('h4', uiText('本机 OCR', 'Local OCR'))
  const panel = make('div'); panel.className = 'jdx-runtime-status'
  const announcement = make('div'); announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite'); announcement.setAttribute('aria-atomic', 'true')
  const state = make('p'); state.className = 'jdx-runtime-status-title'; state.dataset.ocrState = 'loading'
  const status = make('p'); status.className = 'jdx-runtime-status-description'
  const progressBar = make('progress'); progressBar.hidden = true; progressBar.setAttribute('aria-label', uiText('本机 OCR 准备进度', 'Local OCR setup progress'))
  const stage = make('p'); stage.className = 'jdx-ocr-stage'; stage.hidden = true
  const metrics = make('dl'); metrics.className = 'jdx-ocr-metrics'; metrics.hidden = true
  const elapsed = make('p'); elapsed.className = 'jdx-ocr-elapsed'; elapsed.hidden = true
  const actions = make('div'); actions.className = 'jdx-actions'
  const install = make('button', uiText('启用本机 OCR', 'Enable local OCR')); install.type = 'button'
  install.className = 'jdx-button jdx-button-primary'; install.dataset.ocrAction = 'install'
  const check = make('button', uiText('重新检查', 'Check again')); check.type = 'button'; check.className = 'jdx-button'; check.dataset.ocrAction = 'check'
  const repair = make('button', uiText('修复识别组件', 'Repair recognition components')); repair.type = 'button'; repair.className = 'jdx-button'; repair.dataset.ocrAction = 'repair'
  const offline = make('button', uiText('导入离线包', 'Import offline package')); offline.type = 'button'; offline.className = 'jdx-button'; offline.dataset.ocrAction = 'import'
  repair.title = uiText('重新同步依赖并验证模型，保留已下载模型。', 'Synchronize dependencies and verify models, retaining downloaded models.')
  announcement.append(state, status, stage); actions.append(install, check, repair, offline); panel.append(announcement, progressBar, metrics, elapsed, actions); overview.append(heading, panel)

  const source = make('section'); source.className = 'jdx-ocr-section'
  const sourceTitle = make('h4', uiText('模型下载源', 'Model download source'))
  const sourceRoot = make('div'); sourceRoot.dataset.ocrSetting = 'model-source'
  const sourceSelect = createJdxSelect(sourceRoot, { ariaLabel: sourceTitle.textContent || '', popupWidth: 300 })
  const sourceHelp = make('p', uiText('模型是本机识别所需的文件。默认使用 Hugging Face；连接困难时可改用魔搭或 HF-Mirror。已有模型继续复用，更换下载源不会重新安装。文字识别模型使用 RapidOCR 官方魔搭源。', 'Models are files required for local recognition. Use ModelScope or HF-Mirror if Hugging Face is unavailable. Changing the source reuses existing models without reinstalling. Text recognition models use RapidOCR’s official ModelScope source.'))
  const sourceStatus = make('p'); sourceStatus.className = 'jdx-manager-inline-status jdx-pref-status'; sourceStatus.setAttribute('role', 'status'); sourceStatus.setAttribute('aria-atomic', 'true')
  source.append(sourceTitle, sourceRoot, sourceHelp, sourceStatus)
  const tip = make('section'); tip.className = 'jdx-ocr-tip'
  const tipTitle = make('h4', uiText('💡 使用提示', '💡 Good to know'))
  tip.append(tipTitle, make('p', uiText('可联网准备，也可导入匹配版本的完整离线包，无需预装 Python。完成后无需反复检查，重开设置会自动显示状态。选文公式增强在首次使用时另行下载，不影响全文 OCR。PDF 不会发送到模型下载站点；全文翻译仍会将提取的内容发送给你选择的翻译服务。', 'Set up online or import a matching complete offline package; Python need not be preinstalled. Once ready, settings refresh automatically. Selection formula enhancement downloads separately on first use. PDFs are never sent to model download sites; full translation still sends extracted content to your chosen translation service.')))

  const details = make('details'); details.className = 'jdx-ocr-section'
  details.append(make('summary', uiText('环境与故障排查', 'Environment and troubleshooting')))
  const environment = make('p', uiText('正在读取组件信息…', 'Reading component information…'))
  const path = make('p'); path.className = 'jdx-ocr-path'
  const errorDetails = make('p'); errorDetails.className = 'jdx-ocr-path'; errorDetails.hidden = true
  const params = make('p', uiText('Python 是识别组件的运行环境，uv 负责安装，均由插件自动管理，不需要手动填写路径或环境变量。模型缓存使用当前 Zotero 配置目录。默认下载源可沿用系统 HF_ENDPOINT；镜像选项只对 OCR 子进程生效，不修改系统设置。', 'Python runs recognition components and uv installs them. The plugin manages both; no paths or environment variables need to be entered. Models are cached in the current Zotero profile. The default source honors the system HF_ENDPOINT; mirror choices apply only to OCR subprocesses and do not change system settings.'))
  details.append(make('h4', uiText('安装工具 · uv', 'Installation tool · uv')), environment, make('h4', uiText('运行环境与参数', 'Runtime and parameters')), params, make('h4', uiText('本机日志', 'Local logs')), path, make('p', uiText('仅在组件损坏或持续无法启动时使用修复。将重新同步依赖并自动验证，保留已下载模型。下载失败时，先更换上方下载源，再点击“继续准备”。', 'Repair only if components are damaged or cannot start. Dependencies will be synchronized and verified while retaining models. For download failures, change the source above and choose Continue setup.')))
  details.append(errorDetails)
  const removal = make('section'); removal.className = 'jdx-ocr-removal'
  const remove = make('button', uiText('删除依赖…', 'Remove dependencies…')); remove.type = 'button'; remove.className = 'jdx-button jdx-ocr-danger'; remove.dataset.ocrAction = 'remove'
  removal.append(make('h4', uiText('删除与重装', 'Remove and reinstall')), make('p', uiText('修复后仍无法使用时，可删除插件专用依赖，再重新安装。PDF、已保存的解析与翻译结果、日志，以及你自行安装的 Python / uv 均会保留。', 'If repair does not help, remove the plugin’s dependencies and reinstall. PDFs, saved extraction and translation results, logs, and your own Python / uv installations are retained.')), remove)
  const confirmation = make('div'); confirmation.className = 'jdx-ocr-remove-confirmation'; confirmation.hidden = true; confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-labelledby', 'jdx-ocr-remove-title')
  const removalTitle = make('h4', uiText('确认删除 OCR 依赖？', 'Remove OCR dependencies?')); removalTitle.id = 'jdx-ocr-remove-title'
  const scope = make('p', uiText('将删除插件专用 Python、识别依赖及安装工具。删除后，新的 OCR 任务需重新安装才能使用；阅读历史成果不受影响。', 'Removes the plugin’s Python, recognition dependencies and installation tools. New OCR tasks require reinstallation afterward; saved results remain readable.'))
  const modelOption = make('label'); modelOption.className = 'jdx-ocr-remove-models'
  const removeModels = make('input'); removeModels.type = 'checkbox'
  modelOption.append(removeModels, make('span', uiText('同时删除已下载模型', 'Also remove downloaded models')))
  const modelHelp = make('p', uiText('默认保留模型缓存，减少重装下载量；少量随依赖安装的模型仍需重新下载。怀疑模型损坏时勾选，重装将重新下载模型，可能耗时较长。', 'Keep the model cache by default to reduce downloads; models bundled with dependencies may still download again. Select this if models may be damaged. Reinstallation will download them again and may take longer.')); modelHelp.className = 'jdx-ocr-removal-help'
  const confirmActions = make('div'); confirmActions.className = 'jdx-actions'
  const cancelRemove = make('button', uiText('取消', 'Cancel')); cancelRemove.type = 'button'; cancelRemove.className = 'jdx-button'
  const confirmRemove = make('button', uiText('确认删除依赖', 'Remove dependencies')); confirmRemove.type = 'button'; confirmRemove.className = 'jdx-button jdx-ocr-danger'
  confirmActions.append(cancelRemove, confirmRemove)
  confirmation.append(removalTitle, scope, modelOption, modelHelp, confirmActions); removal.append(confirmation); details.append(removal)
  const cloudRoot = make('div')
  details.append(source)
  body.append(title, note, cloudRoot, overview, tip, details); layout.before(body)
  let disposed = false, busy = false, retryRead = false
  // 单一状态出口：替换旧语义，保留可发现的手动兜底，不抑制进度播报。
  const showState = (kind: string, title: string, description: string) => {
    state.dataset.ocrState = kind; panel.dataset.state = kind
    state.textContent = title; status.textContent = description
    progressBar.hidden = !['loading', 'working'].includes(kind)
    progressBar.removeAttribute('value'); stage.hidden = true; metrics.hidden = true; elapsed.hidden = progressBar.hidden
  }
  const stages: Record<string, string> = {
    resources: uiText('读取插件内置安装资源', 'Reading bundled setup resources'),
    service_start: uiText('启动本机 OCR 服务', 'Starting local OCR service'),
    environment: uiText('1 / 5 · 检查安装工具与运行环境', '1 / 5 · Checking tools and runtime'),
    uv: uiText('1 / 5 · 下载并校验安装工具 uv', '1 / 5 · Downloading and checking uv'),
    dependencies: uiText('2 / 5 · 安装 Python 与识别依赖', '2 / 5 · Installing Python and dependencies'),
    imports: uiText('2 / 5 · 检查识别组件能否加载', '2 / 5 · Checking component imports'),
    cache: uiText('3 / 5 · 读取已下载模型的就绪凭据', '3 / 5 · Reading cached model readiness'),
    offline: uiText('3 / 5 · 离线验证已有模型', '3 / 5 · Verifying cached models offline'),
    models: uiText('4 / 5 · 加载模型并下载缺失文件', '4 / 5 · Loading models and downloading missing files'),
    download: uiText('下载引擎或模型', 'Downloading engine or models'),
    extract: uiText('解压完整引擎包', 'Extracting engine package'),
    retry: uiText('下载中断，正在续传', 'Download interrupted; resuming'),
    checksum: uiText('4 / 5 · 校验模型文件完整性', '4 / 5 · Checking model file integrity'),
    verify: uiText('5 / 5 · 使用合成样例验证识别', '5 / 5 · Verifying recognition with a synthetic sample'),
  }
  const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`
  const showProgress = (value: OCRProgress) => {
    if (disposed || !busy) return
    stage.textContent = stages[value.stage] ?? uiText('正在准备…', 'Preparing…'); stage.hidden = false
    progressBar.removeAttribute('value'); metrics.replaceChildren(); metrics.hidden = true
    const metric = (label: string, text: string) => { const entry = make('div'); entry.append(make('dt', label), make('dd', text)); metrics.append(entry); metrics.hidden = false }
    if (value.file) metric(uiText('当前文件 / 下载批次', 'Current file / batch'), value.file)
    if (value.stage === 'download' && value.unit === 'B' && Number.isFinite(value.completed)) {
      const completed = Math.max(0, value.completed!)
      const total = Number.isFinite(value.total) && value.total! > 0 ? value.total! : undefined
      if (total) { progressBar.max = total; progressBar.value = Math.min(completed, total) }
      metric(uiText('已下载', 'Downloaded'), total ? `${bytes(completed)} / ${bytes(total)} (${Math.min(100, completed / total * 100).toFixed(0)}%)` : `${bytes(completed)} · ${uiText('总大小未知', 'Total unknown')}`)
      metric(uiText('平均速度', 'Average speed'), Number.isFinite(value.speed) ? `${bytes(Math.max(0, value.speed!))}/s` : '—')
    }
  }
  let unobserve = () => {}
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
    if (value.removed) {
      showState('missing', uiText('依赖已删除 · 需要重新安装', 'Dependencies removed · Reinstall to use OCR'), uiText('已保存的文献成果仍可阅读。点击“重新安装 OCR”恢复识别功能。', 'Saved results remain readable. Choose Reinstall OCR to restore recognition.'))
      install.textContent = uiText('重新安装 OCR', 'Reinstall OCR')
    }
    environment.textContent = value.uvPath ? `${value.uvVersion} · ${value.uvSource === 'user' ? uiText('复用已有安装', 'Using existing installation') : uiText('由插件管理', 'Managed by the plugin')}\n${value.uvPath}` : value.ready ? uiText('复用已确认的运行环境；“重新检查”可更新工具详情。', 'Using the confirmed runtime. Check again to refresh tool details.') : uiText('尚未找到兼容的 uv，启用时会自动下载，无需自行安装。', 'Compatible uv not found. Setup will download it automatically.')
    path.textContent = `${uiText('安装日志：', 'Installation log: ')}${value.logPath}\n${uiText('模型准备日志：', 'Model setup log: ')}${value.logPath.replace(/install\.log$/u, 'models-prepare.log')}`
  }
  const run = async (setup = false, repairing = false, force = false, archive?: string) => {
    if (busy || disposed) return
    const trace = lifecycleTrace(host, 'ocr-settings', repairing ? 'repair' : setup ? 'prepare' : 'check')
    let currentStage = 'environment', outcome: 'success' | 'error' = 'success'
    busy = true; retryRead = false; install.disabled = true; check.disabled = true; repair.disabled = true; offline.disabled = true; sourceSelect.setDisabled(true)
    remove.disabled = true; confirmRemove.disabled = true; cancelRemove.disabled = true; removeModels.disabled = true; confirmation.hidden = true; remove.hidden = false
    const preparing = setup || isLocalOCRPreparing(host)
    errorDetails.hidden = true; errorDetails.textContent = ''
    showState(preparing ? 'working' : 'loading', preparing ? uiText('正在准备本机 OCR', 'Setting up local OCR') : uiText('正在读取本机状态…', 'Reading local status…'), preparing ? uiText('可离开此页面，准备会继续。', 'You can leave this page while setup continues.') : uiText('正在读取已保存的状态；尚未确认的环境才需要检查。', 'Reading saved status; only unconfirmed environments need checking.'))
    unobserve = observeOCRProgress(host, value => { if (currentStage !== value.stage) { currentStage = value.stage; trace.event(currentStage) }; showProgress(value) })
    const started = Date.now()
    const tick = () => { if (!disposed) elapsed.textContent = `${uiText('本次等待', 'Waiting')} ${Math.floor((Date.now() - started) / 60000)}:${String(Math.floor((Date.now() - started) / 1000) % 60).padStart(2, '0')} · ${preparing ? uiText('组件安装、模型准备各最多 30 分钟', 'Components and models: up to 30 minutes each') : uiText('环境检查最多 2 分钟，模型检查最多 5 分钟', 'Environment: up to 2 minutes; models: up to 5 minutes')}` }
    tick(); const timer = setInterval(tick, 1000)
    try {
      // 阶段由结构化订阅更新；说明行稳定保留后台运行提示。
      const progress = () => {}
      if (repairing || archive) await installLocalOCR(host, progress, repairing, archive)
      if (setup) await prepareLocalOCRModels(host, progress)
      const value = await checkLocalOCR(host, force)
      if (!disposed) render(value)
    } catch (error) {
      outcome = 'error'; trace.fail(error, currentStage)
      if (!disposed) {
        retryRead = !setup
        const modelStage = ['models', 'download', 'verify', 'offline', 'cache'].includes(currentStage)
        const guidance = modelStage ? uiText('模型准备失败：检查模型下载源后继续准备，或重新验证已有模型。', 'Model setup failed: check the model source and continue, or verify existing models.') : uiText('组件准备失败：请查看当前阶段的错误详情并修复识别组件。模型下载源不影响 uv、Python 或依赖安装。', 'Component setup failed: inspect this stage and repair components. The model source does not affect uv, Python or dependency installation.')
        showState('error', setup ? uiText('准备未完成 · 已下载内容会保留', 'Setup incomplete · Downloads are retained') : uiText('暂时无法读取状态', 'Status temporarily unavailable'), setup ? guidance : uiText('请重新读取状态；此操作不会安装或下载。错误详情见“环境与故障排查”。', 'Read the status again; this will not install or download files. See Environment and troubleshooting for error details.'))
        errorDetails.textContent = `${uiText('最近错误：', 'Latest error: ')}${error instanceof Error ? error.message : String(error)}`; errorDetails.hidden = false
        check.hidden = retryRead
        install.hidden = false; install.textContent = setup ? uiText('继续准备', 'Continue setup') : uiText('重新读取状态', 'Read status again')
      }
    } finally {
      trace.end(outcome)
      clearInterval(timer)
      unobserve()
      busy = false
      if (!disposed) { install.disabled = false; check.disabled = false; repair.disabled = false; offline.disabled = false; sourceSelect.setDisabled(false) }
      if (!disposed) { remove.disabled = false; confirmRemove.disabled = false; cancelRemove.disabled = false; removeModels.disabled = false }
    }
  }
  install.addEventListener('click', () => { void run(!retryRead) })
  check.addEventListener('click', () => { void run(false, false, true) })
  repair.addEventListener('click', () => { void run(true, true) })
  offline.addEventListener('click', async () => {
    if (busy || disposed) return
    try {
      const pickerHost = globalThis as unknown as { ChromeUtils: { importESModule(url: string): { FilePicker: new () => { init(win: Window, title: string, mode: number): void; modeOpen: number; returnCancel: number; appendFilter(label: string, pattern: string): void; show(): Promise<number>; file: string } } } }
      const { FilePicker } = pickerHost.ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs')
      const picker = new FilePicker()
      picker.init(host.getMainWindow?.() ?? doc.defaultView!, uiText('选择 OCR 离线引擎包', 'Choose OCR offline engine package'), picker.modeOpen)
      picker.appendFilter('ZIP', '*.zip')
      if (await picker.show() !== picker.returnCancel && picker.file) await run(true, false, true, picker.file)
    } catch (error) { if (!disposed) showState('error', uiText('离线导入失败', 'Offline import failed'), error instanceof Error ? error.message : String(error)) }
  })
  remove.addEventListener('click', () => { confirmation.hidden = false; remove.hidden = true; removeModels.checked = false; cancelRemove.focus() })
  cancelRemove.addEventListener('click', () => { confirmation.hidden = true; remove.hidden = false; remove.focus() })
  confirmRemove.addEventListener('click', async () => {
    if (busy || disposed) return
    busy = true
    for (const button of [install, check, repair, offline, remove, confirmRemove, cancelRemove]) button.disabled = true
    removeModels.disabled = true; sourceSelect.setDisabled(true)
    errorDetails.hidden = true
    showState('working', uiText('正在删除 OCR 依赖', 'Removing OCR dependencies'), uiText('正在停止本机服务并清理所选组件，请稍候。', 'Stopping the local service and removing selected components. Please wait.'))
    elapsed.hidden = true
    try {
      await removeLocalOCR(host, removeModels.checked)
      if (!disposed) {
        retryRead = false; confirmation.hidden = true; remove.hidden = false
        render(await checkLocalOCR(host)); details.open = false; install.focus()
      }
    } catch (error) {
      if (!disposed) {
        showState('error', uiText('依赖未能完全删除', 'Dependencies could not be fully removed'), uiText('请查看下方原因。若文件被占用，请停止 OCR 任务或重启 Zotero 后重试。', 'See the reason below. If files are in use, stop OCR tasks or restart Zotero and retry.'))
        errorDetails.textContent = error instanceof Error ? error.message : String(error); errorDetails.hidden = false; details.open = true
      }
    } finally {
      busy = false
      if (!disposed) {
        for (const button of [install, check, repair, offline, remove, confirmRemove, cancelRemove]) button.disabled = false
        removeModels.disabled = false; sourceSelect.setDisabled(false)
        if (confirmation.hidden) install.focus()
      }
    }
  })
  // 回到窗口时重新投影，多个窗口共用进行中的读取；不定时轮询或自动下载。
  const refresh = () => { if (!overview.hidden && !busy && !disposed && confirmation.hidden) void run() }
  doc.defaultView?.addEventListener('focus', refresh)
  const stopCloud = wireCloudOCRSettings(host, cloudRoot, engine => {
    for (const node of [overview, source, tip, details]) node.hidden = engine !== 'local'
    if (engine === 'local') refresh()
  })
  const stopNavigation = wireSettingsNavigation(root, '[data-external-dependency]', 'ocr')
  return () => {
    stopNavigation(); stopEngine(); layout.remove(); headingPage.remove(); disposed = true; stopCloud(); unobserve(); doc.defaultView?.removeEventListener('focus', refresh); if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); sourceSelect.destroy(); body.remove() }
}
