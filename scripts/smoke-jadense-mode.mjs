/** 真实 XPI/Gecko 的模式、账号门槛、OCR 图片派发及跨窗口状态验收；只用合成响应。 */
export async function verifyJadenseMode({ Zotero, reader, assert, waitFor, screenshot, report, findManager, findWindowContaining }) {
  const main = Zotero.getMainWindow(), original = main.fetch, jobs = Zotero.__jadenseDocumentJobs
  const originalToken = Zotero.Prefs.get('extensions.jadenseInZotero.token')
  let authorized = true, calls = 0, switchDuringCall = false, toggle
  const payloads = []
  main.fetch = async (url, init) => {
    if (!String(url).includes('/api/extension/zotero/ai/')) return original.call(main, url, init)
    assert(init.credentials === 'omit' && init.redirect === 'error', 'Plugin AI request permits cookies or redirects')
    const cap = { enabled: true, available: authorized, authorized, revision: 1, modelId: 'synthetic-model', displayName: 'Synthetic Model', reason: authorized ? null : 'insufficient_scope' }
    if (String(url).endsWith('/capabilities')) return new main.Response(JSON.stringify({ userId: 'synthetic-user', decision: cap, ocr: cap }), { status: 200 })
    const body = JSON.parse(init.body); payloads.push(body); calls++
    assert(String(url).endsWith('/ocr') && body.image?.startsWith('data:image/'), 'Expected only rendered OCR images')
    if (switchDuringCall) { switchDuringCall = false; toggle.click() }
    return new main.Response(JSON.stringify({ text: 'Synthetic OCR 测试', markdown: '# Synthetic OCR 测试', blocks: [{ text: 'Synthetic OCR 测试', box: { coordinates: [50, 50, 900, 150], system: 'normalized-1000' } }], warnings: [], billingStatus: 'settled', operationId: body.operationId, revision: 1, modelId: 'synthetic-model' }), { status: 200 })
  }
  try {
    Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown', true)
    Zotero.Prefs.set('extensions.jadenseInZotero.ocrReady', 'removed', true)
    const readerToolbar = await waitFor(() => reader._iframeWindow.document.querySelector('[data-jadense-reader-tools="renderToolbar"]'), 'reader toolbar')
    assert(!readerToolbar.querySelector('[role="switch"]'), 'Mode switch must not occupy the PDF toolbar')
    assert(readerToolbar.querySelector('.jadense-reader-brand svg') && !readerToolbar.querySelector('.jadense-reader-brand svg').hasAttribute('hidden'), 'Original PDF logo missing')
    Zotero.Prefs.set('extensions.jadenseInZotero.jadenseModeConsent', true, true)
    main.openDialog('chrome://jadense-in-zotero/content/manager.xhtml?section=settings-connection', 'jadense-mode-smoke', 'chrome,dialog=no,titlebar,resizable,width=1100,height=800', { zotero: Zotero, section: 'settings-connection', pluginID: 'jadense-in-zotero@jadense.cn' })
    const manager = await waitFor(() => findManager()?.document.querySelector('#jadense-settings-panel-connection') && findManager(), 'connection settings')
    manager.document.querySelector('.jdx-quick-start-dialog[open]')?.close()
    toggle = await waitFor(() => manager.document.querySelector('#jadense-titlebar #jadense-home [role="switch"]'), 'workspace titlebar mode switch')
    assert(toggle.getAttribute('aria-checked') === 'false', 'Mode should default off')
    assert(toggle.querySelector('.jdx-mode-thumb .jdx-mode-logo'), 'Logo must be inside the moving thumb')
    const logo = toggle.querySelector('.jdx-mode-logo'), thumb = toggle.querySelector('.jdx-mode-thumb')
    assert(logo.getBoundingClientRect().width <= thumb.getBoundingClientRect().width - 8, 'Logo lacks thumb padding')
    const offColor = manager.getComputedStyle(logo).color
    assert(logo.querySelectorAll('path').length === 3, 'Inline brand logo geometry missing')
    await screenshot('jadense-mode-workspace-off', manager)
    toggle.click()
    await waitFor(() => {
      const error = toggle.parentElement.querySelector('.jdx-mode-status[data-state="error"]')
      if (error?.textContent) throw new Error(`Mode activation failed: ${error.textContent}`)
      return Zotero.Prefs.get('extensions.jadenseInZotero.ocrEngine', true) === 'jadense'
    }, 'automatic OCR selection')
    assert(!manager.document.querySelector('#jadense-settings-panel-connection [role="switch"]'), 'Connection page must not duplicate the switch')
    await waitFor(() => manager.getComputedStyle(thumb).transform === 'matrix(1, 0, 0, 1, 20, 0)', 'mode thumb transition complete')
    const onColor = manager.getComputedStyle(logo).color, onTransform = manager.getComputedStyle(thumb).transform
    assert(onColor !== offColor && onTransform.includes('20'), `Logo color/thumb position did not change on enable: ${offColor} -> ${onColor}, transform=${onTransform}, checked=${toggle.getAttribute('aria-checked')}`)
    report.checks.push('mode-workspace-toolbar-logo-switch', 'mode-pdf-toolbar-restored', 'mode-default-off', 'mode-auto-ocr-unready', 'mode-no-connection-switch')
    await screenshot('jadense-mode-workspace-on', manager)
    await screenshot('jadense-mode-toolbar', main)
    await screenshot('jadense-mode-connection', manager)
    manager.document.getElementById('jadense-settings-tab-ocr').click()
    await waitFor(() => manager.document.querySelector('[aria-label="识别引擎"], [aria-label="OCR engine"]'), 'OCR selector')
    await screenshot('jadense-mode-ocr', manager)
    assert(calls === 0, 'Opening settings dispatched a paid model call')
    report.checks.push('mode-settings-no-paid-call')
    await jobs.ready
    switchDuringCall = true
    const task = await jobs.start('extraction', reader.itemID, true, { useOCR: true })
    assert(task.status === 'complete', 'Jadense OCR extraction failed: ' + task.error)
    const result = await jobs.store.extraction(task.id)
    assert(result?.ocr?.engine === 'jadense' && result.markdown.includes('Synthetic OCR'), 'Jadense provenance missing')
    assert(calls >= 2 && payloads.every(body => body.bindingRevision === 1), 'All pages must use frozen cloud config')
    assert(Zotero.Prefs.get('extensions.jadenseInZotero.jadenseMode', true) === false && Zotero.Prefs.get('extensions.jadenseInZotero.ocrEngine', true) === 'local', 'Disabling must restore local OCR')
    report.checks.push('mode-inflight-config-frozen', 'mode-real-page-render', 'mode-ocr-provenance', 'mode-off-restores-local')
    toggle.click(); await waitFor(() => Zotero.Prefs.get('extensions.jadenseInZotero.jadenseMode', true) === true, 'mode reenabled')
    const previous = calls
    const cached = await jobs.start('extraction', reader.itemID, true, { useOCR: true })
    assert(cached.status === 'complete' && calls === previous, 'Completed pages were dispatched twice')
    report.checks.push('mode-ocr-cache-no-repeat')
    toggle.click(); Zotero.Prefs.set('extensions.jadenseInZotero.ocrEngine', 'glm', true); toggle.click()
    await waitFor(() => Zotero.Prefs.get('extensions.jadenseInZotero.jadenseMode', true) === true, 'mode with existing cloud')
    assert(Zotero.Prefs.get('extensions.jadenseInZotero.ocrEngine', true) === 'glm', 'Existing cloud selection overwritten')
    report.checks.push('mode-keeps-existing-cloud')
    toggle.click(); authorized = false; toggle.click()
    await Zotero.Promise.delay(500)
    assert(Zotero.Prefs.get('extensions.jadenseInZotero.jadenseMode', true) === false, 'Old token enabled mode')
    await Zotero.Promise.delay(5100)
    assert(!toggle.parentElement.querySelector('.jdx-mode-status').textContent, 'Error feedback remained after 5 seconds')
    toggle.click()
    await Zotero.Promise.delay(3100)
    assert(!toggle.parentElement.querySelector('.jdx-mode-status').textContent, 'Cancel feedback remained after 3 seconds')
    await screenshot('jadense-mode-cancel-expired', manager)
    report.checks.push('mode-feedback-expires')
    authorized = true
    Zotero.Prefs.clear('extensions.jadenseInZotero.token')
    Zotero.Prefs.set('extensions.jadenseInZotero.token', originalToken)
    await Zotero.Promise.delay(200)
    assert(Zotero.Prefs.get('extensions.jadenseInZotero.jadenseMode', true) === false, 'Canceled activation resumed on reconnect')
    report.checks.push('mode-connect-cancel')
    authorized = false; toggle.click(); await Zotero.Promise.delay(200)
    Zotero.Prefs.clear('extensions.jadenseInZotero.token')
    await Zotero.Promise.delay(100)
    authorized = true; Zotero.Prefs.set('extensions.jadenseInZotero.token', originalToken)
    await waitFor(() => Zotero.Prefs.get('extensions.jadenseInZotero.jadenseMode', true) === true, 'pending mode after reconnect')
    report.checks.push('mode-old-token-needs-grant', 'mode-connect-completes-activation')
    manager.document.getElementById('jadense-settings-tab-connection').click()
    Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', '150', true)
    for (const theme of ['light', 'dark']) {
      Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
      manager.resizeTo(720, 800); await Zotero.Promise.delay(150)
      await screenshot(`jadense-mode-${theme}-narrow`, manager)
    }
    await Promise.resolve(Zotero.Utilities.Internal.openPreferences('jadense-in-zotero-preferences'))
    const preferences = await waitFor(() => findWindowContaining('jadense-in-zotero-preferences-pane'), 'native preferences')
    assert(!preferences.document.querySelector('[role="switch"].jdx-mode-switch'), 'Native connection settings must not duplicate the switch')
    report.checks.push('mode-no-native-connection-switch', 'mode-font-scale-150')
    preferences.close()
  } finally { main.fetch = original }
}
