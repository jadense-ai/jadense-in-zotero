/** 版面与 OCR 共用的存储位置表单；各引擎的忙碌与健康检查仍由各自运行时负责。 */
import type { ZoteroLike } from './runtime'
import { changeEngineStorage, cleanupLegacyUVCache, engineStorageParent, engineStoragePrefKey, engineStorageRoot, previewEngineStorageRoot, retryEngineStorageCleanup, storageRecovery, type ChangeStorageOptions, type EngineStorageKind, type StorageProgress } from './engine-storage'
import { ocrStorageBusyReason } from './local-ocr'
import { pdfTranslationJobs } from './pdf-translation-jobs'
import { uiText } from './ui-preferences'

type StorageHandlers = Pick<ChangeStorageOptions, 'busy' | 'stopIdle' | 'validate' | 'committed'>

export function wireEngineStorageSettings(host: ZoteroLike, parent: HTMLElement, kind: EngineStorageKind, handlers: StorageHandlers) {
  const doc = parent.ownerDocument, make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const value = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    value.textContent = text; return value
  }
  const row = make('div'); row.className = 'jdx-feature-model-row'; row.dataset.engineStorage = kind
  const description = make('div'), controls = make('div'); controls.className = 'jdx-settings-controls'
  const title = make('h3'), label = make('label', uiText('存储位置', 'Storage location'))
  const input = make('input'); input.type = 'text'; input.className = 'jdx-engine-storage-input'; input.spellcheck = false; input.autocomplete = 'off'
  input.id = `jdx-${kind}-storage-${crypto.randomUUID()}`; label.htmlFor = input.id
  title.append(label)
  const note = make('p', uiText('填写存储父目录，插件会在其中创建专用文件夹；可直接输入尚不存在的路径。更改后迁移已安装依赖、缓存和历史成果。', 'Enter a storage parent folder; the plugin creates its own folder inside it. You can enter a path that does not exist yet. Changing it moves installed components, caches and saved results.'))
  note.className = 'jdx-manager-settings-note jdx-pref-card-note'; description.append(title, note)
  const inputRow = make('div'); inputRow.className = 'jdx-engine-storage-input-row'
  const browse = make('button', uiText('浏览…', 'Browse…')); browse.type = 'button'; browse.className = 'jdx-button'
  inputRow.append(input, browse)
  const current = make('p'), preview = make('p'); current.className = preview.className = 'jdx-manager-settings-note jdx-pref-card-note jdx-engine-storage-path'
  const actions = make('div'); actions.className = 'jdx-manager-actions'
  const save = make('button', uiText('保存并迁移', 'Save and move')); save.type = 'button'; save.className = 'jdx-button jdx-button-primary'
  const reset = make('button', uiText('使用默认位置', 'Use default location')); reset.type = 'button'; reset.className = 'jdx-button'
  const cancel = make('button', uiText('取消迁移', 'Cancel move')); cancel.type = 'button'; cancel.className = 'jdx-button'; cancel.hidden = true
  const cleanup = make('button', uiText('重试清理旧目录', 'Retry old-folder cleanup')); cleanup.type = 'button'; cleanup.className = 'jdx-button'; cleanup.hidden = true
  actions.append(save, reset, cancel, cleanup)
  const status = make('p'); status.className = 'jdx-manager-inline-status jdx-pref-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true')
  controls.append(inputRow, current, preview, actions, status); row.append(description, controls); parent.append(row)
  let disposed = false, controller: AbortController | undefined, dirty = false
  const feedback = (message: string, type: 'info' | 'success' | 'error' = 'info') => { if (!disposed) { status.textContent = message; status.dataset.kind = type } }
  const legacyCacheIdle = () => !ocrStorageBusyReason(host) && !pdfTranslationJobs(host).storageBusyReason()
  const cleanLegacyCache = () => { void cleanupLegacyUVCache(host, legacyCacheIdle).catch(error => feedback(error instanceof Error ? error.message : String(error), 'error')) }
  const render = () => {
    if (disposed) return
    if (!dirty) input.value = engineStorageParent(host, kind) === (globalThis as unknown as { PathUtils: { profileDir: string } }).PathUtils.profileDir ? '' : engineStorageParent(host, kind)
    current.textContent = uiText('当前目录：', 'Current folder: ') + engineStorageRoot(host, kind)
    try { preview.textContent = uiText('目标目录：', 'Destination: ') + previewEngineStorageRoot(host, kind, input.value) }
    catch { preview.textContent = uiText('请输入绝对文件夹路径。', 'Enter an absolute folder path.') }
    save.disabled = !!controller || !dirty
  }
  input.addEventListener('input', () => { dirty = true; render(); feedback('') })
  browse.addEventListener('click', async () => {
    if (controller) return
    try {
      const pickerHost = globalThis as unknown as { ChromeUtils: { importESModule(url: string): { FilePicker: new () => { init(win: Window, title: string, mode: number): void; modeGetFolder: number; returnCancel: number; show(): Promise<number>; file: string } } } }
      const { FilePicker } = pickerHost.ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs')
      const picker = new FilePicker()
      picker.init(host.getMainWindow?.() ?? doc.defaultView!, uiText('选择引擎存储父目录', 'Choose engine storage parent folder'), picker.modeGetFolder)
      if (await picker.show() !== picker.returnCancel && picker.file && !disposed) { input.value = picker.file; dirty = true; render(); input.focus() }
    } catch (error) { feedback(error instanceof Error ? error.message : String(error), 'error') }
  })
  reset.addEventListener('click', () => { input.value = ''; dirty = true; render(); feedback(uiText('已选择默认位置，点击“保存并迁移”生效。', 'Default location selected. Choose Save and move to apply it.')) })
  cancel.addEventListener('click', () => { controller?.abort(); cancel.disabled = true; feedback(uiText('正在停止迁移并保留原目录…', 'Stopping the move and retaining the original folder…')) })
  const phaseLabels = {
    preflight: uiText('正在检查目标目录', 'Checking destination'), copy: uiText('正在复制文件', 'Copying files'),
    verify: uiText('正在校验文件', 'Verifying files'), check: uiText('正在检查迁移后的引擎', 'Checking moved engine'),
    commit: uiText('正在切换存储位置', 'Switching storage location'), cleanup: uiText('正在清理旧目录', 'Removing old folder'),
  }
  const progress: StorageProgress = (phase, done, total) => {
    const amount = total ? ` · ${((done ?? 0) / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : ''
    feedback(`${phaseLabels[phase]}${amount}…`)
  }
  save.addEventListener('click', async () => {
    if (controller || !dirty) return
    controller = new AbortController(); browse.disabled = reset.disabled = save.disabled = true; cancel.hidden = false; cancel.disabled = false
    try {
      const result = await changeEngineStorage(host, kind, input.value, { ...handlers, signal: controller.signal, progress })
      dirty = false; render()
      if (result.cleanupError) { cleanup.hidden = false; feedback(uiText(`新位置已生效；旧目录 ${result.oldRoot} 清理失败：${result.cleanupError}`, `New location is active; old folder ${result.oldRoot} could not be removed: ${result.cleanupError}`), 'error') }
      else feedback(result.moved ? uiText('存储位置已迁移，旧目录已清理。', 'Storage moved; old folder removed.') : uiText('存储位置没有变化。', 'Storage location is unchanged.'), 'success')
      if (!result.cleanupError) cleanLegacyCache()
    } catch (error) { feedback(error instanceof Error ? error.message : String(error), controller.signal.aborted ? 'info' : 'error') }
    finally { controller = undefined; browse.disabled = reset.disabled = false; cancel.hidden = true; render() }
  })
  cleanup.addEventListener('click', async () => {
    cleanup.disabled = true
    try { if (await retryEngineStorageCleanup(host, kind, handlers.busy)) { cleanup.hidden = true; feedback(uiText('迁移遗留文件已清理。', 'Remaining move files were cleaned up.'), 'success') } }
    catch (error) { feedback(error instanceof Error ? error.message : String(error), 'error') }
    finally { cleanup.disabled = false }
  })
  void storageRecovery(kind).then(value => {
    if (disposed || !value) return
    cleanup.hidden = false
    if (value.to === engineStorageRoot(host, kind)) feedback(uiText(`上次迁移已生效，旧目录仍待清理：${value.from}`, `Previous move is active; old folder still needs cleanup: ${value.from}`), 'error')
    else feedback(uiText('上次迁移中断；请先清理暂存文件，再重新保存。', 'A previous move was interrupted. Clean up staged files before trying again.'), 'error')
  }).catch(error => feedback(error instanceof Error ? error.message : String(error), 'error'))
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(engineStoragePrefKey(kind), () => { dirty = false; render() }, true) } catch { /* 跨窗口刷新为可选展示。 */ }
  render()
  cleanLegacyCache()
  return () => { disposed = true; controller?.abort(); if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); row.remove() }
}
