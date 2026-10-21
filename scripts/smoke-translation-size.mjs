/** 真实 Gecko 中的译文大小验收；只操作隔离 smoke 的合成文档与展示偏好。 */
export async function verifySelectionTranslationSize({ Zotero, reader, panel, assert, waitFor, screenshot, report }) {
  const doc = panel.ownerDocument, win = doc.defaultView
  const key = 'extensions.jadenseInZotero.selectionTranslationFontScale'
  const globalKey = 'extensions.jadenseInZotero.fontScale', themeKey = 'extensions.jadenseInZotero.theme'
  const previousGlobal = Zotero.Prefs.get(globalKey, true), previousTheme = Zotero.Prefs.get(themeKey, true)
  const appearance = panel.querySelector('.jdx-window-appearance')
  const range = panel.querySelector('[data-jdx-selection-translation-font-size]')
  const reset = panel.querySelector('[data-jdx-selection-translation-font-reset]')
  const result = panel.querySelector('.jadense-translation-result')
  const source = panel.querySelector('.jadense-translation-source .jadense-translation-text')
  const header = panel.querySelector('header strong')
  const pdf = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer
  await waitFor(() => panel.querySelector('.jadense-translation-actions > button')?.disabled === false, 'selection translation completes before appearance-only checks')
  const history = Zotero.Prefs.get('extensions.jadenseInZotero.translationHistory')
  const size = node => Number.parseFloat(win.getComputedStyle(node).fontSize)
  const set = value => { range.value = String(value); range.dispatchEvent(new win.Event('input', { bubbles: true })) }
  assert(range && reset && source && header, 'Selection translation size controls or content are missing')
  assert(range.min === '80' && range.max === '200' && range.step === '10', 'Selection translation range has incorrect bounds')
  appearance.open = true
  const before = { result: size(result), source: size(source), header: size(header), pdf: pdf.currentScale }
  range.focus(); assert(doc.activeElement === range, 'Selection size range cannot receive keyboard focus')
  set(160)
  await waitFor(() => Math.abs(size(result) - before.result * 1.6) < .2, 'selection translated text grows')
  assert(size(source) === before.source && size(header) === before.header && pdf.currentScale === before.pdf, 'Selection size changed original text, controls, or PDF')
  assert(String(Zotero.Prefs.get(key, true)) === '160' && range.getAttribute('aria-valuetext') === '160%', 'Selection size was not saved or announced')
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set(themeKey, theme, true)
    await Zotero.Promise.delay(120)
    await screenshot('selection-text-size-160-' + theme)
  }
  set(80); await waitFor(() => Math.abs(size(result) - before.result * .8) < .2, 'selection smaller text')
  set(200); await waitFor(() => Math.abs(size(result) - before.result * 2) < .2, 'selection maximum text')
  reset.click()
  assert(range.value === '100' && reset.disabled && Math.abs(size(result) - before.result) < .2, 'Selection size reset did not restore default')
  set(160)
  const frame = reader._iframe, oldStyle = frame.getAttribute('style'), oldWidth = win.innerWidth
  try {
    Zotero.Prefs.set(globalKey, 150, true)
    frame.style.cssText += ';width:320px!important;min-width:0!important;max-width:320px!important;flex:none!important'
    await waitFor(() => reader._iframeWindow.innerWidth <= 320 && Math.abs(size(result) - before.result * 2.4) < .3, 'selection 320px and 150% global text')
    await Zotero.Promise.delay(150)
    const menu = panel.querySelector('.jdx-window-appearance-menu')
    assert(menu.scrollWidth <= menu.clientWidth + 2 && panel.scrollWidth <= panel.clientWidth + 2, 'Selection size controls overflow at 320px and 150%')
    assert(Math.abs(size(source) - before.source * 1.5) < .2 && Math.abs(size(header) - before.header * 1.5) < .2, 'Selection local size leaked into original text or controls')
    range.parentElement.scrollIntoView()
    range.focus(); assert(doc.activeElement === range, 'Narrow selection size range lost keyboard focus')
    const rangeBounds = range.getBoundingClientRect(), menuBounds = menu.getBoundingClientRect()
    assert(rangeBounds.top >= menuBounds.top && rangeBounds.bottom <= menuBounds.bottom, 'Narrow selection size range cannot be scrolled into view')
    await screenshot('selection-text-size-160-dark-320-150')
  } finally {
    if (oldStyle === null) frame.removeAttribute('style'); else frame.setAttribute('style', oldStyle)
    if (previousGlobal === undefined) Zotero.Prefs.clear(globalKey, true); else Zotero.Prefs.set(globalKey, previousGlobal, true)
    if (previousTheme === undefined) Zotero.Prefs.clear(themeKey, true); else Zotero.Prefs.set(themeKey, previousTheme, true)
  }
  await waitFor(() => win.innerWidth === oldWidth, 'selection reader viewport restored')
  await Zotero.Promise.delay(150)
  appearance.open = false
  assert(Zotero.Prefs.get('extensions.jadenseInZotero.translationHistory') === history, 'Changing selection size changed translation history')
  report.checks.push('selection-native-text-size-range-reset-original-isolation-persistence', 'selection-native-text-size-light-dark-320-150-keyboard-focus')
}

/** 主 Reader 与独立简阅窗口使用相同 DOM 合约；校验文字和偏好，不调用翻译服务。 */
export async function verifySimpleReadingSize({ Zotero, reader, panel, detached, assert, waitFor, screenshot, report }) {
  const doc = panel.ownerDocument, win = doc.defaultView
  const key = 'extensions.jadenseInZotero.simpleReadingFontScale'
  const range = panel.querySelector('[data-simple-reading-font-scale]')
  const control = pattern => [...panel.querySelectorAll('button')].find(button => pattern.test(button.getAttribute('aria-label') || button.textContent))
  const toggle = detached ? control(/^(文字大小|Text size)$/u) : control(/^(简阅操作|Reading actions)$/u)
  const smaller = control(/^(减小文字|Decrease text size)$/u), larger = control(/^(增大文字|Increase text size)$/u), reset = control(/^(恢复默认文字大小|Reset text size)$/u)
  assert(range && toggle && smaller && larger && reset, 'Simple reading size controls are missing')
  const frame = panel.querySelector('iframe'), mirrorDoc = frame.contentDocument
  const scale = () => Number(mirrorDoc.documentElement.style.getPropertyValue('--scale'))
  const pdf = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer
  const pdfScale = pdf.currentScale, task = JSON.stringify(Zotero.__jadenseSimpleReading.list())
  const expectedInitial = detached ? '160' : '100'
  assert(range.value === expectedInitial, 'Simple reading size was not retained across window modes')
  const baseline = scale() / (Number(range.value) / 100)
  const set = value => { range.value = String(value); range.dispatchEvent(new win.Event('input', { bubbles: true })) }
  toggle.click()
  range.focus(); assert(doc.activeElement === range, 'Simple reading size range cannot receive keyboard focus')
  set(160)
  await waitFor(() => Math.abs(scale() - baseline * 1.6) < .003, 'simple reading text scale increases')
  assert(pdf.currentScale === pdfScale, 'Simple reading size changed the original PDF scale')
  assert(String(Zotero.Prefs.get(key, true)) === '160' && range.getAttribute('aria-valuetext') === '160%', 'Simple reading size was not saved or announced')
  if (detached) {
    larger.click()
    await waitFor(() => reader._iframeWindow.document.querySelector('[data-simple-reading-font-scale]')?.value === '170', 'simple reading main and detached size synchronization')
    smaller.click()
  } else {
    larger.click(); assert(range.value === '170', 'Simple reading increase action failed')
    smaller.click(); assert(range.value === '160', 'Simple reading decrease action failed')
  }
  const previousTheme = Zotero.Prefs.get('extensions.jadenseInZotero.theme', true)
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    await Zotero.Promise.delay(120)
    await screenshot('simple-reading-text-size-160-' + (detached ? 'detached-' : '') + theme, detached || reader._iframeWindow)
  }
  if (previousTheme === undefined) Zotero.Prefs.clear('extensions.jadenseInZotero.theme', true); else Zotero.Prefs.set('extensions.jadenseInZotero.theme', previousTheme, true)
  set(80); assert(smaller.disabled, 'Simple reading lower boundary remained enabled')
  set(200); assert(larger.disabled, 'Simple reading upper boundary remained enabled')
  reset.click()
  await waitFor(() => range.value === '100' && reset.disabled && Math.abs(scale() - baseline) < .003, 'simple reading size reset')
  set(160)
  toggle.click()
  assert(JSON.stringify(Zotero.__jadenseSimpleReading.list()) === task && pdf.currentScale === pdfScale, 'Changing simple reading size altered the task or original PDF')
  report.checks.push(detached ? 'simple-reading-native-text-size-detached-sync-reset' : 'simple-reading-native-text-size-range-step-reset-original-isolation')
}
