/** 设置宿主专项：复用隔离安装夹具，检查真实 Zotero 偏好与工作台的可见性和交互。 */
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 此函数只在夹具核验过的隔离 profile 中执行，不读取用户真实设置。 */
async function verifySettingsHosts({ Zotero, manager, waitFor, assert, screenshot, report, findWindowContaining, lifecycleOnly }) {
  const pause = () => Zotero.Promise.delay(250)
  const measure = (win, root, label) => {
    const bounds = root.getBoundingClientRect()
    const ancestors = []
    for (let node = root; node; node = node.parentElement) {
      const box = node.getBoundingClientRect(), style = win.getComputedStyle(node)
      ancestors.push({ tag: node.localName, id: node.id, width: box.width, height: box.height, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, overflow: style.overflow, display: style.display })
    }
    ;(report.settingsHosts ??= []).push({ label, viewport: [win.innerWidth, win.innerHeight], root: bounds.toJSON(), ancestors })
  }
  const managerDoc = manager.document
  managerDoc.getElementById('jadense-manager-nav-settings').click()
  managerDoc.getElementById('jadense-settings-tab-general').click()
  await pause()
  measure(manager, managerDoc.getElementById('jadense-manager-section-settings'), 'manager-baseline')
  await screenshot('settings-host-manager-before', manager)

  const activeObservers = new Map()
  const belongsToPane = observer => observer.source?.includes('/content/preferences.js')
  const register = Zotero.Prefs.registerObserver, unregister = Zotero.Prefs.unregisterObserver
  Zotero.Prefs.registerObserver = function (...args) {
    const id = register.apply(this, args)
    activeObservers.set(id, { key: args[0], source: new Error().stack })
    return id
  }
  Zotero.Prefs.unregisterObserver = function (id) {
    activeObservers.delete(id)
    return unregister.call(this, id)
  }
  await Promise.resolve(Zotero.Utilities.Internal.openPreferences('jadense-in-zotero-preferences'))
  const preferences = await waitFor(() => findWindowContaining('jadense-in-zotero-preferences-pane'), 'settings preferences window')
  const doc = preferences.document
  const root = doc.getElementById('jadense-in-zotero-preferences-pane')
  await waitFor(() => root.querySelector('[data-classification-settings-host] input'), 'native settings initialization')
  report.preferencesObserversRegistered = [...activeObservers.values()].filter(belongsToPane).length
  assert(report.preferencesObserversRegistered > 10, 'Native preference observer accounting did not capture the pane')
  const selectNative = key => {
    doc.getElementById(`jadense-in-zotero-settings-tab-${key}`).click()
    root.scrollIntoView({ block: 'start' })
  }
  const native = id => doc.getElementById(`jadense-in-zotero-${id}`)
  const savedByok = () => JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.byokConfig'))
  const tabs = [...root.querySelectorAll('.jdx-pref-tabs [role="tab"]')]
  assert(tabs.length === 5 && tabs.filter(tab => tab.tabIndex === 0).length === 1, 'Native tab navigation is incomplete')
  tabs[0].dispatchEvent(new preferences.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  assert(tabs.at(-1).getAttribute('aria-selected') === 'true' && doc.activeElement === tabs.at(-1), 'End did not select BYOK')
  tabs.at(-1).dispatchEvent(new preferences.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  assert(tabs[0].getAttribute('aria-selected') === 'true', 'Home did not select General')
  report.checks.push('settings-native-keyboard-tabs')

  selectNative('byok')
  const keyIcon = native('byok-key-toggle').querySelector('svg')
  await waitFor(() => keyIcon.getBoundingClientRect().width >= 14, 'native key visibility icon styles')
  report.keyVisibilityIcon = { namespace: keyIcon.namespaceURI, bounds: keyIcon.getBoundingClientRect().toJSON() }
  assert(keyIcon.namespaceURI === 'http://www.w3.org/2000/svg' && keyIcon.getBoundingClientRect().width > 0, 'Native key visibility icon is missing')
  native('byok-key-toggle').click()
  assert(native('byok-key-input').type === 'text', 'Native key visibility toggle did not reveal the field')
  native('byok-key-toggle').click()
  assert(native('byok-key-input').type === 'password', 'Native key visibility toggle did not mask the field')
  native('byok-provider-name').value = 'Synthetic settings provider'
  native('byok-base-url').value = 'https://synthetic.invalid/v1'
  native('byok-key-input').value = 'synthetic-settings-key'
  native('byok-provider-save').click()
  assert(savedByok().providers.some(provider => provider.name === 'Synthetic settings provider'), 'Native provider was not saved')
  native('byok-model-new').click()
  native('byok-model-name').value = 'Synthetic settings model'
  native('byok-model').value = 'synthetic-settings-model'
  native('byok-context-window').value = '32000'
  native('byok-max-output-tokens').value = '4096'
  native('byok-save').click()
  assert(savedByok().models.some(model => model.model === 'synthetic-settings-model'), 'Native model was not saved')
  native('byok-provider-name').value = 'Unsaved provider draft'
  selectNative('general'); selectNative('byok')
  assert(native('byok-provider-name').value === 'Unsaved provider draft', 'Native tab switching discarded the provider draft')
  selectNative('jadense')
  const savedToken = Zotero.Prefs.get('extensions.jadenseInZotero.token')
  native('token-edit').click(); native('token-input').value = 'synthetic-unsaved-token'
  selectNative('general'); selectNative('jadense')
  assert(native('token-input').value === 'synthetic-unsaved-token', 'Tab switching discarded the token draft')
  native('token-cancel').click()
  assert(Zotero.Prefs.get('extensions.jadenseInZotero.token') === savedToken && native('token-edit-row').hidden, 'Token Cancel changed saved credentials')
  report.checks.push('settings-native-provider-model-save', 'settings-native-tab-drafts', 'settings-native-token-cancel')

  const assertPanel = (win, panel, label) => {
    const box = panel.getBoundingClientRect()
    assert(box.width > 150 && panel.scrollWidth <= panel.clientWidth + 2, `${label} overflows: ${panel.scrollWidth}/${panel.clientWidth}`)
    assert(box.left >= 0 && box.right <= win.innerWidth + 2, `${label} is outside the window`)
    for (const button of panel.querySelectorAll('button')) {
      if (!button.getBoundingClientRect().width) continue
      assert(button.scrollHeight <= button.clientHeight + 2, `${label} clips button text: ${button.textContent}`)
    }
  }
  for (const width of [1100, 720]) {
    preferences.resizeTo(width, 760)
    selectNative('general')
    await pause()
    measure(preferences, root, `preferences-baseline-${width}`)
    await screenshot(`settings-host-preferences-general-${width}`, preferences)
    const general = root.querySelector('[data-settings-section="general"]')
    const box = general.getBoundingClientRect()
    assert(box.width > 200 && box.height > 0, `Native General has no usable area: ${JSON.stringify(box.toJSON())}`)
    assert(box.right <= preferences.innerWidth + 2, `Native settings overflow the window at ${width}: ${box.right} > ${preferences.innerWidth}`)
    const byok = root.querySelector('[data-settings-section="byok"]')
    selectNative('byok')
    byok.scrollIntoView({ block: 'start' })
    await pause()
    const byokBox = byok.getBoundingClientRect()
    assert(byokBox.top >= -2 && byokBox.top < preferences.innerHeight, `Native BYOK is unreachable at ${width}: ${JSON.stringify(byokBox.toJSON())}`)
    const layout = byok.querySelector('.jdx-pref-byok-layout')
    const columns = preferences.getComputedStyle(layout).gridTemplateColumns
    const provider = byok.querySelector('[data-provider-id]')
    ;(report.nativeByok ??= []).push({ width: layout.clientWidth, columns, providerHeight: provider.clientHeight, providerScrollHeight: provider.scrollHeight })
    await screenshot(`settings-host-preferences-byok-${width}`, preferences)
    assert(layout.clientWidth > 700 || columns.split(' ').length === 1, `Native BYOK did not stack in its ${layout.clientWidth}px container: ${columns}`)
    assert(provider.scrollHeight <= provider.clientHeight + 2, `Native provider content is clipped: ${provider.scrollHeight} > ${provider.clientHeight}`)
  }
  report.checks.push('settings-host-native-initialization', 'settings-host-native-width', 'settings-host-native-scroll')

  for (const theme of lifecycleOnly ? [] : ['light', 'dark']) for (const [width, scale] of [[1100, 100], [720, 150]]) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', String(scale), true)
    preferences.resizeTo(width, 760); manager.resizeTo(width, 800)
    await pause()
    for (const key of ['general', 'features', 'ocr', 'jadense', 'byok']) {
      selectNative(key); await pause()
      const panel = root.querySelector(`[data-settings-section="${key}"]`)
      assertPanel(preferences, panel, `Native ${key} ${theme}/${width}/${scale}`)
      assert([...root.querySelectorAll('.jdx-pref-grid > section')].filter(node => node.getBoundingClientRect().height > 0).length === 1, 'Hidden native panels occupy layout space')
      if (key === 'features') {
        for (const button of panel.querySelectorAll('.jdx-settings-directory button')) {
          button.click(); assertPanel(preferences, panel, `Native feature ${button.dataset.settingsTarget}`)
        }
        panel.querySelector('[data-settings-target="chat"]').click()
      }
      if (key === 'ocr') {
        panel.querySelector('[data-settings-target="layout"]').click()
        assertPanel(preferences, panel, 'Native layout engine')
        panel.querySelector('[data-settings-target="ocr"]').click()
      }
      await screenshot(`settings-host-native-${root.lang}-${key}-${theme}-${width}-${scale}`, preferences)
    }
    for (const key of ['general', 'features', 'ocr', 'shortcuts', 'connection', 'ai']) {
      managerDoc.getElementById(`jadense-settings-tab-${key}`).click()
      await pause()
      const panel = managerDoc.getElementById(`jadense-settings-panel-${key}`)
      assertPanel(manager, panel, `Manager ${key} ${theme}/${width}/${scale}`)
      await screenshot(`settings-host-manager-${root.lang}-${key}-${theme}-${width}-${scale}`, manager)
    }
    measure(preferences, root, `native-${theme}-${width}-${scale}`)
  }
  if (!lifecycleOnly) report.checks.push('settings-both-hosts-all-categories', 'settings-light-dark-actual-widths', 'settings-150-percent-no-overflow')

  selectNative('byok')
  native('byok-model-select').querySelector('[data-model-id]').click()
  const thinking = native('byok-thinking-levels')
  thinking.scrollIntoView({ block: 'center' })
  thinking.querySelector('.jdx-byok-thinking-trigger').click()
  await pause()
  const thinkingBox = thinking.querySelector('.jdx-byok-thinking-popup').getBoundingClientRect()
  assert(thinkingBox.top >= 0 && thinkingBox.bottom <= preferences.innerHeight + 2 && thinkingBox.right <= preferences.innerWidth + 2, 'Native thinking popup is clipped')
  thinking.dispatchEvent(new preferences.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  report.checks.push('settings-native-key-visibility', 'settings-native-model-edit-popup')

  selectNative('features')
  const features = root.querySelector('[data-settings-section="features"]')
  features.querySelector('[data-settings-target="document"]').click()
  features.querySelector('[data-settings-task="document"] .jdx-ocr-summary button').click()
  assert(!root.querySelector('[data-settings-section="ocr"]').hidden, 'Configure OCR did not select the native dependency tab')
  selectNative('features')
  features.querySelector('[data-settings-target="pdf-translation"]').click()
  features.querySelector('[data-pdf-translation-settings] .jdx-manager-actions button').click()
  assert(!root.querySelector('[data-external-dependency="layout"]').hidden && !root.querySelector('[data-settings-section="ocr"]').hidden, 'Configure layout engine did not reveal the dependency section')
  managerDoc.getElementById('jadense-settings-tab-features').click()
  selectNative('features'); features.querySelector('[data-settings-target="chat"]').click()
  native('auto-follow-chat-model').click()
  await waitFor(() => managerDoc.getElementById('jadense-auto-follow-chat-model').checked === native('auto-follow-chat-model').checked, 'model-follow cross-window synchronization')
  report.checks.push('settings-native-dependency-navigation', 'settings-native-manager-preference-sync')

  preferences.close()
  await pause()
  report.preferencesObserversAfterClose = [...activeObservers.values()].filter(belongsToPane).length
  report.remainingPreferenceObservers = [...activeObservers.values()]
  Zotero.Prefs.registerObserver = register
  Zotero.Prefs.unregisterObserver = unregister
  assert(report.preferencesObserversAfterClose === 0, `Native preferences leaked ${report.preferencesObserversAfterClose} preference observers after closing`)
  // 工作台关闭后，原生偏好仍是独立后备入口；反复重开不复用已销毁的沙箱。
  manager.close()
  for (let attempt = 0; attempt < 2; attempt++) {
    await Promise.resolve(Zotero.Utilities.Internal.openPreferences('jadense-in-zotero-preferences'))
    const reopened = await waitFor(() => findWindowContaining('jadense-in-zotero-preferences-pane'), 'reopened native settings')
    await waitFor(() => reopened.document.querySelector('.jdx-pref-tabs [role="tab"]'), 'reopened native tabs')
    reopened.document.getElementById('jadense-in-zotero-settings-tab-byok').click()
    assert(reopened.document.getElementById('jadense-in-zotero-byok-provider-name').value === 'Synthetic settings provider', 'Reopened settings did not restore the saved provider')
    assert(reopened.document.querySelector('[data-model-id]')?.textContent.includes('Synthetic settings model'), 'Reopened settings lost the saved model')
    reopened.close(); await pause()
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', attempt ? 'dark' : 'light', true)
  }
  report.checks.push('settings-native-unload-no-observer-leak', 'settings-native-reopen-without-manager', 'settings-saved-provider-model-restore')
}

const directory = path.dirname(fileURLToPath(import.meta.url))
let source = await readFile(path.join(directory, 'smoke-research.mjs'), 'utf8')
const entry = source.lastIndexOf('    if (config.featureSettingsOnly) {')
if (entry < 0) throw new Error('Settings smoke insertion seam changed')
source = source.slice(0, entry) + `    if (config.modelToastOnly) {
      Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown', true);
      await Promise.resolve(Zotero.Utilities.Internal.openPreferences('jadense-in-zotero-preferences'));
      const firstNative = await waitFor(() => findWindowContaining('jadense-in-zotero-preferences-pane'), 'native settings before Manager');
      await waitFor(() => firstNative.document.getElementById('jadense-in-zotero-preferences-pane')?.getAttribute('data-jadense-initialized') === 'true', 'native first initialization');
      firstNative.close(); await Zotero.Promise.delay(250);
      report.checks.push('settings-native-first-without-manager');
      Zotero.getMainWindow().openDialog('chrome://jadense-in-zotero/content/manager.xhtml', 'jadense-settings-hosts-smoke', 'chrome,dialog=no,titlebar,resizable,width=1100,height=800', { zotero: Zotero, pluginID: config.pluginID });
      manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), 'Settings Manager');
      await (${verifySettingsHosts.toString()})({ Zotero, manager, waitFor, assert, screenshot, report, findWindowContaining, lifecycleOnly: ${process.argv.includes('--lifecycle-only')} });
      report.state = 'passed'; report.stage = 'complete'; await persist(); return;
    }\n` + source.slice(entry)
const generated = path.join(directory, `settings-hosts-smoke-${process.pid}.generated.mjs`)
await writeFile(generated, source)
try {
  const child = spawn(process.execPath, [generated, ...process.argv.slice(2), '--model-toast-only', '--documents-only', '--screenshots', '--keep-temp'], { stdio: 'inherit', windowsHide: true })
  process.exitCode = await new Promise(resolve => { child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1)) })
} finally { await unlink(generated) }
