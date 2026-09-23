import { selectSettingsGroup, wireSettingsNavigation } from './settings-navigation'
/** 两个设置宿主共用用途控件；仅显式开启全文增强时检查引擎，状态摘要不发请求。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { wireSelectionSettings } from './selection-settings'
import { wireTranslationInterface } from './translation-interface'
import { wireReferenceAISetting } from './reference-ai-settings'
import { mountClassificationSettings } from './classification-ui'
import { DOCUMENT_OCR_PREF, documentOCREnabled } from './document-extraction'
import { checkOCREngine } from './cloud-ocr'
import { CLOUD_OCR_SERVICES, OCR_ENGINE_PREF, ocrEngine } from './cloud-ocr-config'
import { cachedOCR, OCR_READY_PREF, isLocalOCRPreparing, observeOCRProgress } from './local-ocr'
import { migrateTranslationConfiguration } from './translation-config-migration'
import { wirePDFTranslationSettings } from './pdf-translation-settings'

export function wireFeatureSettings(host: ZoteroLike | null, root: HTMLElement, ocrRoot: HTMLElement, show: (ocr: boolean) => void) {
  if (!host) return () => {}
  migrateTranslationConfiguration(host)
  const doc = root.ownerDocument
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text; return node
  }
  const stops = [
    wireSelectionSettings(host, root.querySelector('[data-selection-settings-host]')),
    wireTranslationInterface(host, root.querySelector('[data-translation-scope="selection"]'), 'selection'),
    wireTranslationInterface(host, root.querySelector('[data-translation-scope="document"]'), 'document'),
    wirePDFTranslationSettings(host, root.querySelector('[data-translation-scope="document"]'), () => { show(true); selectSettingsGroup(ocrRoot, 'layout'); ocrRoot.querySelector<HTMLElement>('[data-pdf-engine-settings]')?.scrollIntoView?.({ block: 'start' }); ocrRoot.querySelector<HTMLElement>('[data-pdf-engine-settings] button')?.focus() }),
    wireReferenceAISetting(host, root.querySelector('[data-feature-group="analysis"]')),
    mountClassificationSettings(doc, host, root.querySelector<HTMLElement>('[data-classification-settings-host]')),
  ]
  const section = root.querySelector<HTMLElement>('[data-document-ocr-host]')!
  const label = make('label'), enabled = make('input'); enabled.type = 'checkbox'; enabled.dataset.ocrSetting = 'document'
  label.className = 'jdx-manager-checkbox jdx-pref-checkbox'
  label.append(enabled, make('span', uiText('全文提取 OCR 增强', 'Enhance document extraction with OCR')))
  const help = make('p', uiText('用于后续全文 Markdown、文献解析和参考文献提取。默认使用文字层，OCR 失败时回退；扫描页需 OCR。翻译和对话可复用原文，已有成果不变。', 'Applies to future Markdown, analysis and reference extraction. Uses the text layer by default and on OCR failure; scanned pages need OCR. Translation and chat reuse the source; saved results stay unchanged.'))
  help.className = 'jdx-manager-settings-note jdx-pref-card-note'
  const status = make('p'); status.setAttribute('role', 'status')
  const ocrRow = make('div'); ocrRow.className = 'jdx-feature-model-row'
  const description = make('div'); description.append(make('h3', uiText('内容提取', 'Content extraction')))
  const controls = make('div'); controls.append(label, help, status); controls.dataset.ocrSummaryHost = ''
  ocrRow.append(description, controls); section.append(ocrRow)
  let disposed = false, generation = 0
  const syncEnabled = () => { enabled.checked = documentOCREnabled(host) }
  enabled.addEventListener('change', () => { void (async () => {
    const current = ++generation, requested = enabled.checked, engine = ocrEngine(host)
    enabled.disabled = true
    status.textContent = requested ? uiText('正在检查所选 OCR 引擎…', 'Checking the selected OCR engine…') : ''
    try {
      if (requested) await checkOCREngine(host)
      if (disposed || current !== generation) return
      if (engine !== ocrEngine(host)) { status.textContent = uiText('引擎已变更，请重新开启。', 'The engine changed. Enable again.'); return }
      if (!host.Prefs?.set) throw new Error('Preferences unavailable')
      host.Prefs.set(DOCUMENT_OCR_PREF, requested, true)
      status.textContent = requested ? uiText('已开启，下次提取生效。', 'Enabled for the next extraction.') : ''
    } catch { if (!disposed) status.textContent = uiText('未能开启或保存，请在 OCR 配置检查引擎后重试。', 'Could not enable or save. Check OCR configuration and retry.') }
    finally { if (!disposed && current === generation) { enabled.disabled = false; syncEnabled() } }
  })() })
  const summaries: HTMLElement[] = []
  for (const parent of [root.querySelector<HTMLElement>('[data-selection-settings-host]')!, section]) {
    const row = make('div'); row.className = 'jdx-ocr-summary'
    const summary = make('span'); summary.setAttribute('role', 'status'); summaries.push(summary)
    const button = make('button', uiText('配置 OCR', 'Configure OCR')); button.type = 'button'; button.className = 'jdx-button'
    button.addEventListener('click', () => { show(true); selectSettingsGroup(ocrRoot, 'ocr'); ocrRoot.scrollIntoView?.({ block: 'start' }); ocrRoot.querySelector<HTMLElement>('button, input, select')?.focus() })
    row.append(summary, button); (parent.querySelector('[data-ocr-summary-host]') || parent).append(row)
    stops.push(() => row.remove())
  }
  const syncSummary = () => {
    const engine = ocrEngine(host), name = engine === 'local' ? uiText('本机', 'Local') : CLOUD_OCR_SERVICES[engine].name
    const localState = ocrRoot.querySelector<HTMLElement>('[data-ocr-state]')
    const cloudState = ocrRoot.querySelector<HTMLElement>(`[data-ocr-engine="${engine}"]`)?.dataset.ocrSummaryState
    const cloudLabels: Record<string, string> = { configured: uiText('已配置 · 尚未测试', 'Configured · Not tested'), verified: uiText('测试通过', 'Test passed'), checking: uiText('正在检查', 'Checking'), error: uiText('检查失败', 'Check failed') }
    const state = engine === 'local'
      ? isLocalOCRPreparing(host) ? uiText('正在准备', 'Preparing') : cachedOCR(host) ? uiText('已就绪', 'Ready') : localState?.textContent || uiText('尚未检查', 'Not checked')
      : cloudLabels[cloudState || ''] || uiText('尚未检查', 'Not checked')
    for (const summary of summaries) summary.textContent = `OCR：${name} · ${state}`
  }
  const observers: unknown[] = []
  for (const key of [DOCUMENT_OCR_PREF, OCR_ENGINE_PREF, OCR_READY_PREF]) {
    try { const id = host.Prefs?.registerObserver?.(key, () => { if (key === OCR_ENGINE_PREF && !enabled.disabled) status.textContent = ''; syncEnabled(); syncSummary() }, true); if (id !== undefined) observers.push(id) } catch { /* 可选同步不得阻断设置。 */ }
  }
  const Observer = doc.defaultView?.MutationObserver
  const observer = Observer ? new Observer(syncSummary) : null
  observer?.observe(ocrRoot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-ocr-state', 'data-ocr-summary-state', 'data-ocr-engine'] })
  stops.push(observeOCRProgress(host, syncSummary))
  // 说明跟随所属控件，避免长说明撑宽标签列。
  for (const row of Array.from(root.querySelectorAll<HTMLElement>('.jdx-feature-model-row'))) {
    const [labelColumn, existingControl] = Array.from(row.children)
    if (labelColumn?.tagName.toLowerCase() !== 'div' || !existingControl) continue
    let controlColumn = existingControl
    if (existingControl.tagName.toLowerCase() === 'label') {
      controlColumn = make('div'); existingControl.replaceWith(controlColumn); controlColumn.append(existingControl)
    }
    for (const note of Array.from(labelColumn.querySelectorAll(':scope > p'))) controlColumn.append(note)
  }
  const follow = root.querySelector('[id$="auto-follow-chat-model"]')?.closest('label')
  const followRow = follow?.closest('.jdx-feature-model-row')
  if (follow && followRow?.firstElementChild === follow.parentElement) {
    followRow.lastElementChild?.prepend(follow)
    followRow.firstElementChild?.append(make('h3', uiText('模型跟随', 'Model defaults')))
  }
  const pdfScope = root.querySelector('[data-translation-scope="document"]')
  const capacity = pdfScope?.querySelector(':scope > details')
  if (capacity) pdfScope?.append(capacity)
  for (const note of Array.from(root.querySelectorAll<HTMLElement>('[data-model-follow]'))) {
    note.textContent = uiText('跟随当前对话模型。', 'Follows the current Chat model.')
    const change = make('button', uiText('调整跟随规则', 'Change follow settings')); change.type = 'button'; change.className = 'jdx-settings-link'
    change.addEventListener('click', () => { selectSettingsGroup(root, 'chat'); root.querySelector<HTMLElement>('[id$="auto-follow-chat-model"]')?.focus() })
    note.append(doc.createTextNode(' '), change)
    stops.push(() => change.remove())
  }
  stops.push(wireSettingsNavigation(root, '[data-settings-task]', 'chat'))
  syncEnabled(); syncSummary()
  return () => {
    disposed = true; generation++; observer?.disconnect()
    for (const id of observers) host.Prefs?.unregisterObserver?.(id)
    stops.forEach(stop => stop()); ocrRow.remove()
  }
}
