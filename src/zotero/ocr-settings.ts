/** OCR 独立设置内容：Manager 子页面和原生偏好共用，安装复用首次全文任务入口。 */
import type { ZoteroLike } from './runtime'
import { checkLocalOCR, installLocalOCR, OCR_MODEL_SOURCE_PREF, readOCRModelSource, type OCREnvironment } from './local-ocr'
import { createJdxSelect } from './custom-select'
import { uiText } from './ui-preferences'

/** 卸载只停止 UI 更新，不取消其他全文任务正在等待的共享安装。 */
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
  const note = make('p', uiText('全文 Markdown 和全文翻译使用本机 OCR。首次使用也会自动检查环境并安装依赖。', 'Full Markdown and full translation use local OCR. First use also checks the environment and installs dependencies automatically.'))
  note.className = 'jdx-manager-settings-note jdx-pref-note'
  const environment = make('p', uiText('尚未检查环境。', 'Environment has not been checked.'))
  const dependencies = make('p', uiText('OCR 依赖状态未知。', 'OCR dependency status is unknown.'))
  const path = make('p'); path.className = 'jdx-ocr-path'
  const actions = make('div'); actions.className = 'jdx-actions'
  const check = make('button', uiText('检查环境', 'Check environment')); check.type = 'button'
  const install = make('button', uiText('安装 OCR 依赖', 'Install OCR dependencies')); install.type = 'button'
  check.className = 'jdx-button'; install.className = 'jdx-button jdx-button-primary'
  check.dataset.ocrAction = 'check'; install.dataset.ocrAction = 'install'
  const status = make('p'); status.className = 'jdx-manager-inline-status jdx-pref-status'; status.setAttribute('role', 'status')
  const help = make('p', uiText('优先使用已有 uv，不可用时自动下载。依赖安装在插件独立环境中；模型将在首次识别时下载和加载。', 'Uses an existing uv when available, otherwise downloads it automatically. Dependencies stay in the plugin’s own environment; models download and load on first recognition.'))
  help.className = note.className
  const sourceTitle = make('p', uiText('OCR 模型下载源', 'OCR model download source'))
  const sourceRoot = make('div'); sourceRoot.dataset.ocrSetting = 'model-source'
  const sourceSelect = createJdxSelect(sourceRoot, { ariaLabel: sourceTitle.textContent || '', popupWidth: 300 })
  const sourceHelp = make('p', uiText('默认连接 Hugging Face（或已配置的环境地址）。连接超时时可选择第三方 HF-Mirror 镜像，仅下载公开 OCR 模型，PDF 仍在本机识别。更改后重新点击“全文翻译”即可，无需重装依赖或重启 Zotero；正在运行的任务不受影响。', 'Uses Hugging Face or your configured environment endpoint by default. If connections time out, you can choose the third-party HF-Mirror to download public OCR models; PDF recognition stays local. Click Translate full text again after changing this setting. No dependency reinstall or Zotero restart is needed; running jobs are unchanged.'))
  const syncSource = () => sourceSelect.setOptions([
    { value: 'default', label: uiText('默认（Hugging Face / 环境配置）', 'Default (Hugging Face / environment)') },
    { value: 'hf-mirror', label: uiText('HF-Mirror（第三方镜像）', 'HF-Mirror (third-party mirror)') },
  ], readOCRModelSource(host))
  sourceSelect.onChange(value => {
    try { host.Prefs?.set?.(OCR_MODEL_SOURCE_PREF, value === 'hf-mirror' ? value : 'default', true); status.textContent = uiText('下载源已保存，请重新尝试全文翻译。', 'Download source saved. Retry full translation.'); status.removeAttribute('data-tone') }
    catch { status.textContent = uiText('下载源保存失败，请重试。', 'Could not save download source. Please retry.'); status.dataset.tone = 'error' }
    syncSource()
  })
  syncSource()
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(OCR_MODEL_SOURCE_PREF, syncSource, true) } catch { /* 可选跨窗同步不阻断设置。 */ }
  actions.append(check, install); body.append(title, note, environment, dependencies, path, actions, status, sourceTitle, sourceRoot, sourceHelp, help); root.append(body)
  let disposed = false, busy = false
  const render = (value: OCREnvironment) => {
    environment.textContent = value.uvPath
      ? `${value.uvVersion} · ${value.uvSource === 'user' ? uiText('用户环境', 'User environment') : uiText('插件环境', 'Plugin environment')}\n${value.uvPath}`
      : uiText('未检测到兼容的 uv，安装时将自动下载。', 'No compatible uv found. Installation will download it automatically.')
    dependencies.textContent = value.ready ? uiText('OCR 依赖已安装。', 'OCR dependencies are installed.') : uiText('OCR 依赖尚未安装完成。', 'OCR dependencies are not fully installed.')
    path.textContent = uiText('安装日志（安装后生成）：', 'Installation log (created after installation): ') + value.logPath
  }
  const run = async (installing: boolean) => {
    if (busy) return
    busy = true; check.disabled = true; install.disabled = true; body.setAttribute('aria-busy', 'true')
    status.textContent = installing ? uiText('正在准备 OCR 依赖…', 'Preparing OCR dependencies…') : uiText('正在检查环境…', 'Checking environment…')
    status.removeAttribute('data-tone')
    try {
      if (installing) await installLocalOCR(host, text => { if (!disposed) status.textContent = text })
      const value = await checkLocalOCR(host)
      if (!disposed) { render(value); status.textContent = installing ? uiText('OCR 依赖已就绪。', 'OCR dependencies are ready.') : uiText('环境检查完成。', 'Environment check complete.') }
    } catch (error) {
      if (!disposed) { status.textContent = error instanceof Error ? error.message : String(error); status.dataset.tone = 'error' }
    } finally {
      busy = false
      if (!disposed) { check.disabled = false; install.disabled = false; body.removeAttribute('aria-busy') }
    }
  }
  check.addEventListener('click', () => { void run(false) })
  install.addEventListener('click', () => { void run(true) })
  return () => { disposed = true; if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); sourceSelect.destroy(); body.remove() }
}
