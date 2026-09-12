/** 隔离原生 profile 中验证实际 XPI 的设置、全文分流和可选公网连通性。 */
/* global Components */
export async function verifyMachineTranslation({ Zotero, reader, manager, waitFor, assert, screenshot, report, findWindowContaining, live }) {
  const pref = 'extensions.jadenseInZotero.translationInterface'
  const doc = manager.document
  const quickStart = doc.getElementById('jadense-quick-start-dialog')
  if (quickStart) {
    await waitFor(() => quickStart.open || Zotero.Prefs.get('extensions.jadenseInZotero.quickStartShown') === true, 'quick start')
    if (quickStart.open) doc.getElementById('jadense-quick-start-close').click()
  }
  doc.getElementById('jadense-manager-nav-settings').click()
  doc.getElementById('jadense-settings-tab-features').click()
  await Promise.resolve(Zotero.Utilities.Internal.openPreferences('jadense-in-zotero-preferences'))
  const native = await waitFor(() => findWindowContaining('jadense-in-zotero-preferences-pane'), 'native preferences')
  const nativeRoot = native.document.getElementById('jadense-in-zotero-preferences-pane')
  await waitFor(() => nativeRoot.querySelector('[data-translation-setting="kind"] .jdx-select-trigger'), 'native translation setting')
  const choose = (root, name, index) => {
    const select = root.querySelector(`[data-translation-setting="${name}"]`)
    select.querySelector('.jdx-select-trigger').click()
    select.querySelectorAll('[role="option"]')[index].click()
  }
  const config = () => JSON.parse(Zotero.Prefs.get(pref, true) || '{"kind":"ai","service":"bing"}')
  assert(config().kind === 'ai', 'Legacy profiles must remain on AI')
  choose(doc, 'kind', 1)
  await waitFor(() => config().kind === 'machine' && nativeRoot.querySelector('[data-translation-setting="kind"] .jdx-select-value').textContent === doc.querySelector('[data-translation-setting="kind"] .jdx-select-value').textContent, 'kind synchronization')
  choose(nativeRoot, 'service', 1)
  await waitFor(() => doc.querySelector('[data-translation-setting="service"] .jdx-select-value').textContent === 'Google', 'service synchronization')
  const oldModel = doc.getElementById('jadense-feature-translation-model').closest('.jdx-feature-model-row')
  assert(oldModel.hidden && manager.getComputedStyle(oldModel).display === 'none', 'Machine translation still shows AI model controls')
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    await Zotero.Promise.delay(150)
    for (const [win, root, name] of [[manager, doc, 'manager'], [native, nativeRoot, 'native']]) {
      const tip = root.querySelector('.jdx-translation-tip'), help = root.querySelector('.jdx-translation-tooltip')
      win.focus(); tip.scrollIntoView({ block: 'center' }); tip.focus(); await Zotero.Promise.delay(100)
      assert(win.getComputedStyle(help).display !== 'none' && tip.getAttribute('aria-describedby') === help.id, 'Keyboard tooltip is unavailable')
      assert(win.getComputedStyle(help).backgroundColor !== 'rgba(0, 0, 0, 0)', 'Tooltip has no opaque theme background')
      await screenshot(`machine-${name}-${theme}`, win)
      tip.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      assert(win.getComputedStyle(help).display === 'none', 'Escape did not dismiss the tooltip')
    }
  }
  manager.resizeTo(760, 660)
  await Zotero.Promise.delay(150)
  const settings = doc.querySelector('.jdx-translation-interface')
  for (const control of settings.querySelectorAll('.jdx-select-trigger')) {
    const bounds = control.getBoundingClientRect(), parent = settings.getBoundingClientRect()
    assert(bounds.width > 0 && bounds.left >= parent.left && bounds.right <= parent.right + 1, 'Translation control overflows a narrow window')
  }
  await screenshot('machine-manager-narrow', manager)
  choose(doc, 'kind', 0)
  assert(!oldModel.hidden && config().service === 'google', 'Switching to AI lost the saved service')
  const capacity = nativeRoot.querySelector('[data-capacity="contextWindow"]')
  assert(capacity, 'OCR capacity configuration is missing')
  capacity.value = '32768'; capacity.dispatchEvent(new native.Event('change', { bubbles: true }))
  await waitFor(() => doc.querySelector('[data-capacity="contextWindow"]').value === '32768', 'capacity synchronization')
  choose(doc, 'kind', 1)
  native.close()
  const jobs = Zotero.__jadenseDocumentJobs
  await jobs.ready
  const originalFetch = jobs.fetchImpl
  const main = Zotero.getMainWindow(), originalWindowFetch = main.fetch
  Zotero.Prefs.clear('extensions.jadenseInZotero.token')
  Zotero.Prefs.set('extensions.jadenseInZotero.translationModel', JSON.stringify({ route: 'byok', modelId: 'missing-smoke-model' }), true)
  const requests = []
  jobs.fetchImpl = async (url, options) => {
    if (!String(url).startsWith('https://translate.google.com/m?')) return originalWindowFetch.call(main, url, options)
    assert(options.credentials === 'omit', 'Machine request includes credentials')
    requests.push(String(url))
    assert(String(url).startsWith('https://translate.google.com/m?'), 'Traditional translation dispatched AI')
    return new (Zotero.getMainWindow().Response)('<div class="result-container">原生传统翻译验证</div>')
  }
  main.fetch = jobs.fetchImpl
  try {
    const task = await jobs.start('translation', reader.itemID, true)
    await jobs.idle()
    assert(task.status === 'complete' && task.models.includes('Google'), `Native machine translation failed: ${task.error}`)
    assert((await jobs.reading(task.id)).every(row => row.text), 'Native translation lost paragraphs')
    const view = reader._internalReader._primaryView, readerDoc = reader._iframeWindow.document
    main.focus(); main.Zotero_Tabs.select(reader.tabID)
    const position = { pageIndex: 0, rects: [[50, 737.5, 350, 748.7]] }
    await view.navigateToPosition(Components.utils.cloneInto(position, reader._iframeWindow))
    view._setSelectionRanges(Components.utils.cloneInto([{
      pageIndex: 0, position, sortIndex: '00000|000000|00000',
      text: 'Our method reduces measured error by twenty percent.', collapsed: false, anchor: true, head: true, anchorOffset: 0, headOffset: 10,
    }], reader._iframeWindow))
    const popup = await waitFor(() => readerDoc.querySelector('[data-jadense-reader-tools="renderTextSelectionPopup"]'), 'native machine selection')
    popup.querySelector('[data-jadense-action="translate"]').click()
    await waitFor(() => JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.translationHistory') || '{}').records?.some(row => row.result.text === '原生传统翻译验证'), 'native machine selection history')
    assert(readerDoc.querySelector('.jadense-translation-result')?.textContent.includes('原生传统翻译验证'), 'Native selection result is missing')
    await screenshot('machine-selection', reader._iframeWindow)
    report.checks.push('machine-default-ai', 'machine-two-settings-sync', 'ocr-capacity-settings-sync', 'machine-accessible-themed-tips', 'machine-native-full-without-ai', 'machine-native-selection-without-ai', 'machine-native-history')
  } finally { jobs.fetchImpl = originalFetch; main.fetch = originalWindowFetch }
  if (live) {
    report.liveTranslation = []
    for (const service of ['bing', 'google']) {
      Zotero.Prefs.set(pref, JSON.stringify({ kind: 'machine', service }), true)
      const task = await jobs.start('translation', reader.itemID, true)
      await jobs.idle()
      report.liveTranslation.push({ service, status: task.status, completed: task.completed, total: task.total, error: task.error })
    }
  }
}
