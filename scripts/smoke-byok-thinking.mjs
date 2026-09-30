/** 隔离 Zotero profile 中验收 BYOK 模型档位编辑，沿用研究 smoke 的安装与截图夹具。 */
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function verifyByokThinking({ Zotero, manager, waitFor, assert, screenshot, report, findWindowContaining }) {
  const pref = 'extensions.jadenseInZotero.byokConfig'
  const saved = () => JSON.parse(Zotero.Prefs.get(pref))
  const modelId = 'byok-thinking-smoke'
  const managerDoc = manager.document
  const get = id => managerDoc.getElementById(id)
  get('jadense-manager-nav-settings').click()
  get('jadense-settings-tab-ai').click()
  const list = get('jadense-manager-byok-model-select')
  const row = await waitFor(() => list.querySelector(`button[data-model-id="${modelId}"]`), 'BYOK model row')
  row.click()
  const editor = get('jadense-manager-byok-model-editor')
  const activeRow = list.querySelector(`button[data-model-id="${modelId}"]`)
  assert(activeRow && !activeRow.hidden && activeRow.nextElementSibling === editor && !editor.hidden, 'Manager model row disappeared or editor was misplaced')
  const control = get('jadense-manager-byok-thinking-levels')
  const trigger = control.querySelector('.jdx-byok-thinking-trigger')
  assert(trigger.textContent.includes('low, medium'), 'Saved custom values were not loaded')
  trigger.click()
  const popup = control.querySelector('.jdx-byok-thinking-popup')
  const options = [...control.querySelectorAll('.jdx-byok-thinking-option input')]
  assert(options.length === 8 && trigger.getAttribute('aria-expanded') === 'true', 'Manager multi-select did not open common presets')
  const search = control.querySelector('input[type=search]')
  search.value = 'ultra'; search.dispatchEvent(new manager.Event('input', { bubbles: true }))
  assert(control.querySelectorAll('.jdx-byok-thinking-option').length === 1, 'Manager effort search did not filter')
  control.querySelector('input[data-effort="ultra"]').click()
  const custom = control.querySelector('.jdx-byok-thinking-add input')
  custom.value = 'native-extra'
  custom.dispatchEvent(new manager.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert(trigger.textContent.includes('ultra') && trigger.textContent.includes('native-extra'), 'Manager custom effort was not added')
  search.dispatchEvent(new manager.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert(popup.hidden && managerDoc.activeElement === trigger, 'Manager Escape did not restore focus')
  trigger.click()
  for (const [theme, width] of [['light', 1100], ['dark', 700]]) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    manager.resizeTo(width, 800)
    await Zotero.Promise.delay(300)
    activeRow.scrollIntoView({ block: 'center' })
    const bounds = popup.getBoundingClientRect()
    assert(bounds.width > 0 && bounds.left >= 0 && bounds.right <= manager.innerWidth + 2, `Manager ${theme} popup overflow`)
    assert(editor.getBoundingClientRect().width <= manager.innerWidth + 2, `Manager ${theme} editor overflow`)
    await screenshot(`byok-thinking-manager-row-${theme}-${width}`, manager)
    control.scrollIntoView({ block: 'center' })
    await Zotero.Promise.delay(100)
    assert(popup.getBoundingClientRect().bottom <= manager.innerHeight + 2, `Manager ${theme} popup bottom is clipped`)
    await screenshot(`byok-thinking-manager-popup-${theme}-${width}`, manager)
  }
  get('jadense-manager-byok-save').click()
  await waitFor(() => saved().models.find(model => model.id === modelId)?.thinkingEfforts?.includes('native-extra'), 'Manager saved custom efforts')
  assert(saved().models.find(model => model.id === modelId).thinkingEfforts.join(',') === 'low,medium,ultra,native-extra', 'Manager saved incorrect effort set')
  report.checks.push('byok-manager-row-retained', 'byok-manager-search-multiselect-custom-keyboard', 'byok-manager-light-dark-narrow')

  await Promise.resolve(Zotero.Utilities.Internal.openPreferences('jadense-in-zotero-preferences'))
  const preferences = await waitFor(() => findWindowContaining('jadense-in-zotero-preferences-pane'), 'native BYOK Preferences')
  const nativeDoc = preferences.document
  const native = id => nativeDoc.getElementById(id)
  const nativeList = native('jadense-in-zotero-byok-model-select')
  const nativeRow = await waitFor(() => nativeList.querySelector(`button[data-model-id="${modelId}"]`), 'native BYOK model row')
  nativeRow.click()
  const nativeEditor = native('jadense-in-zotero-byok-model-editor')
  const activeNativeRow = nativeList.querySelector(`button[data-model-id="${modelId}"]`)
  assert(activeNativeRow && !activeNativeRow.hidden && activeNativeRow.nextElementSibling === nativeEditor && !nativeEditor.hidden, 'Preferences model row disappeared or editor was misplaced')
  await waitFor(() => activeNativeRow.getBoundingClientRect().height >= 44, 'native model row stylesheet')
  const nativeControl = native('jadense-in-zotero-byok-thinking-levels')
  const nativeTrigger = nativeControl.querySelector('.jdx-byok-thinking-trigger')
  assert(nativeTrigger.textContent.includes('native-extra'), 'Preferences did not reload custom effort')
  nativeTrigger.click()
  const nativeSearch = nativeControl.querySelector('input[type=search]')
  nativeSearch.value = 'max'; nativeSearch.dispatchEvent(new preferences.Event('input', { bubbles: true }))
  assert(nativeControl.querySelectorAll('.jdx-byok-thinking-option').length === 1, 'Preferences effort search did not filter')
  nativeControl.querySelector('input[data-effort="max"]').click()
  const nativeCustom = nativeControl.querySelector('.jdx-byok-thinking-add input')
  nativeCustom.value = 'native-second'
  nativeCustom.dispatchEvent(new preferences.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert(nativeTrigger.textContent.includes('max') && nativeTrigger.textContent.includes('native-second'), 'Preferences custom effort was not added')
  for (const [theme, width] of [['light', 980], ['dark', 700]]) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    preferences.resizeTo(width, 760)
    await Zotero.Promise.delay(300)
    activeNativeRow.scrollIntoView({ block: 'center' })
    const bounds = nativeControl.querySelector('.jdx-byok-thinking-popup').getBoundingClientRect()
    assert(bounds.width > 0 && bounds.left >= 0 && bounds.right <= preferences.innerWidth + 2, `Preferences ${theme} popup overflow`)
    await screenshot(`byok-thinking-preferences-row-${theme}-${width}`, preferences)
    nativeControl.scrollIntoView({ block: 'center' })
    await Zotero.Promise.delay(100)
    const nativePopup = nativeControl.querySelector('.jdx-byok-thinking-popup')
    await screenshot(`byok-thinking-preferences-popup-${theme}-${width}`, preferences)
    const popupBounds = nativePopup.getBoundingClientRect()
    assert(popupBounds.bottom <= preferences.innerHeight + 2, `Preferences ${theme} popup bottom is clipped: ${JSON.stringify({ top: popupBounds.top, bottom: popupBounds.bottom, innerHeight: preferences.innerHeight })}`)
    assert(nativeControl.querySelector('.jdx-byok-thinking-option input').getBoundingClientRect().width <= 20, `Preferences ${theme} checkbox is stretched`)
  }
  native('jadense-in-zotero-byok-save').click()
  await waitFor(() => saved().models.find(model => model.id === modelId)?.thinkingEfforts?.includes('native-second'), 'Preferences saved custom efforts')
  nativeList.querySelector(`button[data-model-id="${modelId}"]`).click()
  nativeControl.querySelector('.jdx-byok-thinking-trigger').click()
  nativeControl.querySelector('.jdx-byok-thinking-reset').click()
  native('jadense-in-zotero-byok-save').click()
  await waitFor(() => !saved().models.find(model => model.id === modelId)?.thinkingEfforts, 'Preferences restored default efforts')
  preferences.close()
  report.checks.push('byok-preferences-row-retained', 'byok-preferences-search-multiselect-custom', 'byok-preferences-restore-default', 'byok-preferences-light-dark-narrow')
}

const directory = path.dirname(fileURLToPath(import.meta.url))
let source = await readFile(path.join(directory, 'smoke-research.mjs'), 'utf8')
const start = source.indexOf('    if (config.modelToastOnly) {')
const end = source.indexOf('    if (config.selectionOnly) {', start)
if (start < 0 || end < 0) throw new Error('Model smoke insertion seam changed')
source = source.slice(0, start) + source.slice(end)
const entry = source.lastIndexOf('    if (config.featureSettingsOnly) {')
if (entry < 0) throw new Error('Settings smoke insertion seam changed')
source = source.slice(0, entry) + `    if (config.modelToastOnly) {
      Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown', true);
      Zotero.Prefs.set('extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, activeProviderId: 'default-provider', activeModelId: 'byok-thinking-smoke', providers: [{ id: 'default-provider', name: 'Synthetic provider', protocol: 'openai-chat-completions', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic' }], models: [{ id: 'byok-thinking-smoke', providerId: 'default-provider', name: 'Synthetic BYOK', model: 'synthetic-model', thinkingEfforts: ['low', 'medium'] }] }));
      Zotero.getMainWindow().openDialog('chrome://jadense-in-zotero/content/manager.xhtml', 'jadense-byok-thinking-smoke', 'chrome,dialog=no,titlebar,resizable,width=1100,height=800', { zotero: Zotero, pluginID: 'jadense-in-zotero@jadense.cn' });
      manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), 'BYOK Manager');
      await (${verifyByokThinking.toString()})({ Zotero, manager, waitFor, assert, screenshot, report, findWindowContaining });
      report.state = 'passed'; report.stage = 'complete'; await persist(); return;
    }\n` + source.slice(entry)
const generated = path.join(directory, `byok-thinking-smoke-${process.pid}.generated.mjs`)
await writeFile(generated, source)
try {
  const child = spawn(process.execPath, [generated, ...process.argv.slice(2), '--model-toast-only', '--documents-only', '--screenshots', '--keep-temp'], { stdio: 'inherit', windowsHide: true })
  process.exitCode = await new Promise(resolve => { child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1)) })
} finally { await unlink(generated) }
