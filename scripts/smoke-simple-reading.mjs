/* global Services, PathUtils, IOUtils */
/** 隔离宿主简阅检查；缺私有 API 时只证明降级，不冒充完整 SDT 验收。 */
export async function verifySimpleReading({ Zotero, reader, assert, waitFor, screenshot, report, config }) {
  const doc = reader._iframeWindow.document, internal = reader._internalReader
  const button = await waitFor(() => doc.querySelector('[data-jadense-simple-reading]'), 'simple reading entry')
  report.simpleReading = { version: Zotero.version, setReadingMode: typeof internal._setReadingMode, loadSDT: typeof internal._loadSDT, getSDTReader: typeof internal.getSDTReader }
  const before = internal._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.container.scrollTop
  button.click()
  if (typeof internal._setReadingMode !== 'function') {
    await waitFor(() => /简阅模式不可用|Reading mode is unavailable/u.test(doc.body.textContent), 'unavailable reading feedback')
    assert(!doc.querySelector('.jdx-simple-reading'), 'Unsupported reading mode modified the PDF layout')
    assert(internal._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.container.scrollTop === before, 'Unsupported reading mode moved the PDF')
    assert(doc.querySelector('[data-jadense-pdf-mode="compare"]'), 'Existing bilingual PDF entry disappeared')
    report.checks.push('simple-reading-capability-fallback-no-layout-change')
    await screenshot('simple-reading-unavailable')
    return
  }
  const panel = await waitFor(() => doc.querySelector('.jdx-simple-reading'), 'native simple reading panel', 120000)
  try { await waitFor(() => panel.querySelector('iframe')?.contentDocument?.querySelector('#sdt-content') || !panel.isConnected, 'native mirrored structure', 15000) }
  catch (error) { throw new Error(String(error) + ' panel=' + panel.outerHTML.slice(0, 500) + ' controls=' + panel.textContent.slice(-800) + ' frame=' + panel.querySelector('iframe')?.contentDocument?.documentElement?.outerHTML.slice(0, 500) + ' feedback=' + doc.body.textContent.slice(-800)) }
  assert(panel.isConnected, 'Reading panel closed during initialization: ' + doc.body.textContent.slice(-2000))
  const pdf = internal._primaryView._iframeWindow.PDFViewerApplication.pdfViewer
  const pdfFrame = internal._primaryView._iframeWindow.frameElement
  let mirror = panel.querySelector('iframe').contentDocument.querySelector('#sdt-content')
  assert(mirror.querySelectorAll('[data-ref-path]').length > 0 && pdfFrame.getBoundingClientRect().width > 0, 'PDF and extracted HTML are not both available')
  assert(!internal._state?.primaryReadingModeEnabled, 'Simple reading left the native SDT view in place of the PDF')
  assert(!Zotero.__jadenseSimpleReading.list().length, 'Opening reading mode created a translation task')
  const main = Zotero.getMainWindow(), previousFetch = main.fetch
  let requests = 0
  const contextToggle = [...panel.querySelectorAll('button')].find(node => /^(简阅操作|Reading actions)$/u.test(node.textContent))
  contextToggle.click()
  const contextInput = panel.querySelector('[data-reading-budget="simple"]')
  assert(contextInput?.value === '131072' && !panel.querySelector('.jdx-simple-menu').hidden, 'Reading context default or settings opening failed')
  contextInput.value = '65536'; contextInput.dispatchEvent(new doc.defaultView.Event('change'))
  assert(JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.readingTranslationBudgets', true)).simple === 65536, 'Reading context edit not persisted')
  await screenshot('simple-reading-context-settings')
  contextInput.value = '131072'; contextInput.dispatchEvent(new doc.defaultView.Event('change'))
  panel.querySelector('.jdx-simple-menu').dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert(panel.querySelector('.jdx-simple-menu').hidden && !Zotero.__jadenseSimpleReading.list().length, 'Settings failed to close or started translation')
  report.checks.push('simple-reading-context-default-edit-no-request')
  Zotero.Prefs.set('extensions.jadenseInZotero.fullTranslationInterface', JSON.stringify({ kind: 'machine', service: 'google' }), true)
  main.fetch = async (url, options) => {
    if (!String(url).startsWith('https://translate.google.com/')) return previousFetch.call(main, url, options)
    requests++
    await Zotero.Promise.delay(80)
    const input = new URL(String(url)).searchParams.get('q')
    const output = input.split(/(⟦[^⟧]+⟧)/u).map(part => part.startsWith('⟦') ? part : part.replace(/[A-Za-z][A-Za-z ,.-]+/gu, '模拟译文')).join('')
    return new main.Response(`<div class="result-container">${output.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`, { headers: { 'Content-Type': 'text/html' } })
  }
  const control = (root, label) => [...root.querySelectorAll('button')].find(node => label.test(node.textContent))
  const view = (root, label) => [...root.querySelectorAll('.jdx-simple-view [role="option"]')].find(node => label.test(node.textContent))
  const language = (root, label) => [...root.querySelectorAll('.jdx-simple-language button')].find(node => label.test(node.textContent))
  try {
    await waitFor(() => /右侧显示|Extracted original HTML/u.test(panel.querySelector('.jdx-simple-status').textContent), 'ready PDF and HTML reading state')
    assert(view(panel, /双视图|Split view/u)?.getAttribute('aria-disabled') === 'false', 'Untranslated HTML comparison is unavailable')
    assert(view(panel, /简阅内容|Reading content/u)?.getAttribute('aria-disabled') === 'false', 'Untranslated HTML single view is unavailable')
    assert(view(panel, /多屏阅读|Separate window/u)?.getAttribute('aria-disabled') === 'false', 'Untranslated HTML separate view is unavailable')
    assert(language(panel, /译文|Translation/u)?.disabled, 'Translation language became selectable without translated text')
    assert(!panel.querySelector('iframe').hidden && mirror.textContent, 'Untranslated HTML is hidden')
    const viewTrigger = panel.querySelector('.jdx-simple-view .jdx-select-trigger')
    viewTrigger.click()
    assert(panel.querySelector('.jdx-simple-view').dataset.open === 'true', 'Reading view selector did not open')
    await screenshot('simple-reading-view-options')
    viewTrigger.click()
    await screenshot('simple-reading-empty')
    report.checks.push('simple-reading-empty-translation-gated')
    control(panel, /^翻译$|^Translate$/u).click()
    await waitFor(() => Zotero.__jadenseSimpleReading.list()[0]?.status === 'complete', 'simulated reading translation', 180000)
    await waitFor(() => mirror.textContent.includes('模拟译文'), 'incremental translated text')
    assert(!language(panel, /译文|Translation/u).disabled, 'Translation language remained disabled after output')
    const requestsBeforeLanguage = requests
    language(panel, /原文|Original/u).click()
    await waitFor(() => panel.querySelector('iframe').contentDocument.querySelector('#sdt-content')?.textContent.includes('Our method'), 'original HTML language')
    assert(!panel.querySelector('iframe').contentDocument.querySelector('#sdt-content').textContent.includes('模拟译文'), 'Original HTML language retained translated text')
    await screenshot('simple-reading-original-html')
    language(panel, /译文|Translation/u).click()
    await waitFor(() => panel.querySelector('iframe').contentDocument.querySelector('#sdt-content')?.textContent.includes('模拟译文'), 'translated HTML language')
    assert(requests === requestsBeforeLanguage, 'Switching HTML language sent a translation request')
    viewTrigger.click(); await screenshot('simple-reading-translated-language-option'); viewTrigger.click()
    mirror = panel.querySelector('iframe').contentDocument.querySelector('#sdt-content')
    assert(!pdfFrame.contentDocument?.body.textContent.includes('模拟译文'), 'Translation mutated native PDF')
    assert(view(panel, /双视图|Split view/u)?.getAttribute('aria-disabled') === 'false', 'Translated comparison must be enabled')
    assert(!mirror.querySelector('[data-jdx-reading-status]'), 'Completed translation retained missing labels')
    assert(requests > 0 && requests < Zotero.__jadenseSimpleReading.list()[0].total, 'Small blocks were not batched')
    report.simpleReading.simulated = { requests, ...Zotero.__jadenseSimpleReading.list()[0].metrics }
    const search = panel.querySelector('input[type=search]'); search.value = '模拟译文'; control(panel, /查找下一个|Find next/u).click()
    assert(panel.querySelector('iframe').contentWindow.getSelection().toString().includes('模拟译文'), 'Translated text is not searchable/selectable')
    view(panel, /简阅内容|Reading content/u).click(); assert(pdfFrame.style.visibility === 'hidden', 'Single HTML view did not hide PDF')
    view(panel, /双视图|Split view/u).click()
    const layoutFacts = () => { const a = pdfFrame, b = panel.querySelector('iframe'); return { original: { width: a.getBoundingClientRect().width, x: a.getBoundingClientRect().x, style: a.getAttribute('style') }, mirror: { width: b.getBoundingClientRect().width, x: b.getBoundingClientRect().x, hidden: b.hidden, display: reader._iframeWindow.getComputedStyle(b).display, style: b.getAttribute('style') }, width: panel.getBoundingClientRect().width } }
    report.simpleReading.compareLayout = layoutFacts()
    assert(report.simpleReading.compareLayout.mirror.width > 0, 'Comparison translation has no layout width')
    const sidebar = main.ZoteroContextPane, previousCollapsed = sidebar?.collapsed
    if (sidebar) {
      const contextPane = main.document.getElementById('zotero-context-pane')
      const previousStyle = contextPane?.getAttribute('style')
      const pageBefore = pdf.currentPageNumber
      sidebar.collapsed = true
      const wide = pdfFrame.getBoundingClientRect().width
      sidebar.collapsed = false
      await waitFor(() => pdfFrame.getBoundingClientRect().width < wide - 20, 'simple reading sidebar expands')
      if (contextPane) {
        const narrow = pdfFrame.getBoundingClientRect().width
        const width = contextPane.getBoundingClientRect().width
        contextPane.style.setProperty('min-width', `${width + 80}px`, 'important')
        await waitFor(() => pdfFrame.getBoundingClientRect().width < narrow - 30, 'simple reading sidebar width adjusts')
        if (previousStyle === null) contextPane.removeAttribute('style'); else contextPane.setAttribute('style', previousStyle)
      }
      sidebar.collapsed = true
      await waitFor(() => pdfFrame.getBoundingClientRect().width >= wide - 2, 'simple reading sidebar closes')
      assert(pdf.currentPageNumber === pageBefore, 'Sidebar resizing moved the original PDF page')
      if (/^(auto|page-width|page-fit|page-height)$/u.test(pdf.currentScaleValue)) {
        const page = pdf.getPageView(pdf.currentPageNumber - 1).div
        assert(page.getBoundingClientRect().width <= pdf.container.clientWidth + 4, 'Original PDF did not refit after sidebar closed')
      }
      sidebar.collapsed = previousCollapsed
      report.checks.push('simple-reading-sidebar-open-close-refit')
    }
    mirror.querySelector('.sdt-source-crop')?.scrollIntoView()
    try { await waitFor(() => [...mirror.querySelectorAll('.sdt-source-crop img')].some(img => img.naturalWidth > 0), 'translated native crop', 15000) }
    catch (error) { throw new Error(String(error) + ' ' + JSON.stringify([...mirror.querySelectorAll('.sdt-source-crop')].map(figure => ({ state: figure.dataset.sourceCropState, error: figure.dataset.jdxCropError, html: figure.outerHTML.slice(0, 600) })))) }
    view(panel, /多屏阅读|Separate window/u).click()
    const detached = await waitFor(() => { const windows = Services.wm.getEnumerator(null); while (windows.hasMoreElements()) { const candidate = windows.getNext(); if (!candidate.closed && /简阅译文|Reading translation/u.test(candidate.document.title)) return candidate }; return null }, 'separate reading window').catch(error => { throw new Error(`${error}; status=${panel.querySelector('.jdx-simple-status')?.textContent}; toggle=${panel.querySelector('.jdx-simple-status-toggle')?.textContent}; option=${view(panel, /多屏阅读|Separate window/u)?.outerHTML}`) })
    const detachedFrame = await waitFor(() => detached.document.getElementById('translation-host')?.contentDocument?.querySelector('iframe'), 'separate reading iframe')
    await waitFor(() => detachedFrame.contentDocument?.body.textContent.includes('模拟译文'), 'separate translated text')
    await screenshot('simple-reading-detached', detached)
    detached.close()
    await waitFor(() => panel.querySelector('iframe')?.contentDocument?.body.textContent.includes('模拟译文'), 'return to compare')
    await Zotero.Promise.delay(200)
    panel.querySelector('iframe').contentDocument.querySelector('.sdt-source-crop')?.scrollIntoView()
    await waitFor(() => [...panel.querySelector('iframe').contentDocument.querySelectorAll('.sdt-source-crop img')].some(img => img.naturalWidth > 0), 'returned native crop', 20000)
    report.simpleReading.returnLayout = layoutFacts()
    assert(report.simpleReading.returnLayout.mirror.width > 0, 'Returning from separate window hid the translation')
    await screenshot('simple-reading-translated')
    const translatedWindow = panel.querySelector('iframe').contentWindow
    translatedWindow.dispatchEvent(new translatedWindow.Event('wheel'))
    translatedWindow.scrollTo(0, translatedWindow.document.body.scrollHeight)
    await Zotero.Promise.delay(250)
    assert(pdf.container.scrollTop > 0, 'Page-linked scrolling did not move the PDF')
    control(panel, /同步滚动|Sync scroll/u).click()
    const sourceY = pdf.container.scrollTop
    translatedWindow.scrollTo(0, 0); await Zotero.Promise.delay(250)
    assert(Math.abs(pdf.container.scrollTop - sourceY) < 2, 'Independent scrolling moved the PDF')
    // Windows 主窗最小宽度可能拦截 resizeTo；直接限制 Reader frame，并断言实际视口。
    const readerFrame = reader._iframe
    assert(readerFrame, 'Reader frame is unavailable for narrow viewport verification')
    const frameStyle = readerFrame.getAttribute('style')
    try {
      readerFrame.style.cssText += ';width:520px!important;min-width:0!important;max-width:520px!important;flex:none!important'
      await waitFor(() => reader._iframeWindow.innerWidth <= 520, 'actual narrow reader viewport')
      await Zotero.Promise.delay(250)
      assert(panel.scrollWidth <= panel.clientWidth + 2, 'Reading controls overflow the narrow window')
      await screenshot('simple-reading-narrow')
      panel.style.setProperty('--jdx-font-scale', '1.5')
      readerFrame.style.cssText += ';width:320px!important;max-width:320px!important'
      await waitFor(() => reader._iframeWindow.innerWidth <= 320, 'actual 320px reader viewport')
      await Zotero.Promise.delay(250)
      assert(panel.scrollWidth <= panel.clientWidth + 2, 'Reading controls overflow at 320px and 150% font size')
      const focus = panel.querySelector('.jdx-simple-view .jdx-select-trigger'); focus.focus()
      assert(doc.activeElement === focus, 'Reading view button cannot receive keyboard focus')
      await screenshot('simple-reading-320-scaled')
      contextToggle.click()
      const settings = panel.querySelector('.jdx-simple-menu')
      assert(!settings.hidden && settings.scrollWidth <= settings.clientWidth + 2, 'Reading context settings overflow narrow scaled window')
      await screenshot('simple-reading-context-320-scaled')
      settings.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      panel.style.removeProperty('--jdx-font-scale')
    } finally { if (frameStyle === null) readerFrame.removeAttribute('style'); else readerFrame.setAttribute('style', frameStyle) }
    const count = requests
    control(panel, /退出简阅|Close reading mode/u).click(); await waitFor(() => !doc.querySelector('.jdx-simple-reading'), 'close translated reading')
    button.click()
    const reopened = await waitFor(() => { const p = doc.querySelector('.jdx-simple-reading'); return p?.querySelector('iframe')?.contentDocument?.body.textContent.includes('模拟译文') ? p : null }, 'cached reading')
    assert(requests === count, 'Cache reopen contacted translation service')
    control(reopened, /退出简阅|Close reading mode/u).click(); await waitFor(() => !doc.querySelector('.jdx-simple-reading'), 'close cached reading')
    button.click(); await waitFor(() => doc.querySelector('.jdx-simple-reading'), 'reopen reading theme checks')
    report.checks.push('simple-reading-simulated-batching-search-selection-single-multiscreen-cache')
  } finally { main.fetch = previousFetch }
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    await Zotero.Promise.delay(250)
    const mirrorDocument = doc.querySelector('.jdx-simple-reading iframe').contentDocument
    const mirrorWindow = mirrorDocument.defaultView
    const background = mirrorWindow.getComputedStyle(mirrorDocument.documentElement).backgroundColor
    assert(background === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(46, 52, 64)') && mirrorDocument.documentElement.dataset.colorScheme === theme, `Reading HTML did not follow ${theme} theme`)
    await screenshot(`simple-reading-${theme}`)
  }
  const close = control(doc.querySelector('.jdx-simple-reading'), /退出简阅|Close reading mode/u)
  close.click(); await waitFor(() => !doc.querySelector('.jdx-simple-reading'), 'close simple reading')
  await waitFor(() => internal._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.container.scrollTop === before, 'Reading mode did not restore PDF location')
  // 缺 SDT 只影响该入口；用宿主能力接缝制造缺失，不安装 OCR 或版面引擎。
  const loadSDT = internal._loadSDT
  internal._loadSDT = async () => null
  try {
    button.click()
    await waitFor(() => /简阅模式不可用|Reading mode is unavailable/u.test(doc.body.textContent), 'missing SDT feedback').catch(error => { throw new Error(`${error}; panel=${Boolean(doc.querySelector('.jdx-simple-reading'))}; feedback=${doc.body.textContent.slice(-1800)}`) })
    assert(!doc.querySelector('.jdx-simple-reading'), 'Missing SDT left a reading panel')
  } finally { internal._loadSDT = loadSDT }
  // 对照 PDF 任务接缝不执行服务，只验两个真实阅读视图的布局互斥和恢复。
  const originalPDFJobs = Zotero.__jadensePDFTranslationJobs
  Zotero.__jadensePDFTranslationJobs = { subscribe: () => () => {}, get: () => undefined, openOrStart: async () => { throw new Error('Synthetic PDF start failure') }, isActive: () => false, stop() {} }
  try {
    button.click(); await waitFor(() => doc.querySelector('.jdx-simple-reading iframe')?.contentDocument?.querySelector('#sdt-content'), 'reading before PDF compare')
    doc.querySelector('[data-jadense-pdf-mode="compare"]').click()
    await waitFor(() => doc.querySelector('.jdx-pdf-translation') && !doc.querySelector('.jdx-simple-reading'), 'PDF comparison replaces simple reading')
    assert(pdfFrame.getBoundingClientRect().width > 0 && doc.defaultView.getComputedStyle(pdfFrame).display !== 'none' && doc.defaultView.getComputedStyle(pdfFrame).visibility !== 'hidden', 'Switching to PDF comparison hid the original PDF')
    assert(pdfFrame.contentDocument?.body.textContent.includes('Our method'), 'Switching to PDF comparison lost the original PDF contents')
    button.click()
    await waitFor(() => doc.querySelector('.jdx-simple-reading iframe')?.contentDocument?.querySelector('#sdt-content') && !doc.querySelector('.jdx-pdf-translation'), 'simple reading replaces PDF comparison')
    control(doc.querySelector('.jdx-simple-reading'), /退出简阅|Close reading mode/u).click()
  } finally { Zotero.__jadensePDFTranslationJobs = originalPDFJobs }
  report.checks.push('simple-reading-linked-independent-narrow-missing-sdt-and-pdf-exclusion')
  report.checks.push('simple-reading-native-structure-zero-requests-and-restore')
  // 在第一个 Reader 顶栏仍显示“正在读取”时关闭标签，第二个 PDF 必须独立完成初始化。
  await waitFor(() => !doc.querySelector('.jdx-simple-reading'), 'reading view closed before interrupted open')
  const jobs = Zotero.__jadenseSimpleReading, originalLoad = jobs.load
  jobs.load = () => new Promise(() => {})
  try {
    button.click()
    await waitFor(() => /正在读取|Loading/u.test(doc.querySelector('.jdx-simple-status-toggle')?.textContent || ''), 'interrupted reading loading toolbar')
    reader.close()
  } finally { jobs.load = originalLoad }
  const second = await Zotero.Attachments.importFromFile({ file: config.pdfPath, parentItemID: Zotero.Items.get(reader.itemID).parentItemID, contentType: 'application/pdf' })
  const nextReader = await Zotero.Reader.open(second.id)
  await nextReader._initPromise
  await nextReader._internalReader._primaryView.initializedPromise
  const nextDoc = nextReader._iframeWindow.document
  const nextButton = await waitFor(() => nextDoc.querySelector('[data-jadense-simple-reading]'), 'second PDF reading entry')
  nextButton.click()
  await waitFor(() => /待翻译|Not translated/u.test(nextDoc.querySelector('.jdx-simple-status-toggle')?.textContent || ''), 'second PDF reading ready')
  assert(!nextDoc.querySelector('.jdx-simple-status-toggle')?.textContent.includes('正在读取'), 'Second PDF retained first PDF loading state')
  report.checks.push('simple-reading-close-during-loading-next-pdf-ready')
}

/** 两篇真实 PDF 的关闭/切换时序；只验初始化，不发送翻译请求。 */
export async function verifySimpleReadingInterruption({ Zotero, reader, assert, waitFor, report, config }) {
  const firstDoc = reader._iframeWindow.document
  const firstButton = await waitFor(() => firstDoc.querySelector('[data-jadense-simple-reading]'), 'first reading entry')
  const started = Date.now()
  firstButton.click()
  if (config.closeDelayMs) await Zotero.Promise.delay(config.closeDelayMs)
  const firstPanel = config.closeBeforePanel || config.closeDelayMs ? null : await waitFor(() => firstDoc.querySelector('.jdx-simple-reading'), 'first reading panel', 120000)
  const firstStatus = firstPanel?.querySelector('.jdx-simple-status-toggle')?.textContent || (config.closeDelayMs ? `after-${config.closeDelayMs}ms` : 'before-panel')
  if (firstPanel) assert(/正在读取|Loading/u.test(firstStatus), 'First PDF completed before interruption could be reproduced')
  reader.close()
  const firstClosedMs = Date.now() - started
  const firstAttachment = Zotero.Items.get(reader.itemID)
  const secondAttachment = await Zotero.Attachments.importFromFile({ file: config.secondPdfPath, parentItemID: firstAttachment.parentItemID, contentType: 'application/pdf' })
  const secondReader = await Zotero.Reader.open(secondAttachment.id)
  await secondReader._initPromise
  await secondReader._internalReader._primaryView.initializedPromise
  const secondDoc = secondReader._iframeWindow.document
  const secondButton = await waitFor(() => secondDoc.querySelector('[data-jadense-simple-reading]'), 'second reading entry')
  const secondStarted = Date.now()
  secondButton.click()
  const secondPanel = await waitFor(() => secondDoc.querySelector('.jdx-simple-reading'), 'second reading panel', 120000)
  await waitFor(() => /待翻译|Not translated|\d+\s*\/\s*\d+/u.test(secondPanel.querySelector('.jdx-simple-status-toggle')?.textContent || ''), 'second reading ready', 60000)
  assert(secondPanel.isConnected, 'Second reading panel was removed before readiness')
  report.simpleReadingInterruption = { firstClosedMs, secondReadyMs: Date.now() - secondStarted, firstStatus, secondStatus: secondPanel.querySelector('.jdx-simple-status-toggle')?.textContent }
  report.checks.push('simple-reading-real-pdf-close-during-load-next-pdf-ready')
}

/** 同一隔离 profile 冷启动只恢复本地成果，不允许翻译 HTTP。 */
export async function verifySimpleReadingRestart({ Zotero, assert, waitFor, report }) {
  const root = PathUtils.join(Zotero.Profile.dir, 'jadense-simple-reading')
  const files = await IOUtils.getChildren(root), file = files.find(path => /[a-f0-9]{64}\.json$/u.test(path))
  assert(file, 'Missing saved reading task')
  const task = JSON.parse(await IOUtils.readUTF8(file)), main = Zotero.getMainWindow(), originalFetch = main.fetch
  let requests = 0
  main.fetch = async (url, options) => { if (/translate\.google\.com|bing\.com/u.test(String(url))) { requests++; throw new Error('Cache must not call translation provider') }; return originalFetch.call(main, url, options) }
  try {
    const reader = await Zotero.Reader.open(task.source.itemID); await reader._initPromise; await reader._internalReader._primaryView.initializedPromise
    const doc = reader._iframeWindow.document, button = await waitFor(() => doc.querySelector('[data-jadense-simple-reading]'), 'restart reading entry')
    button.click()
    await waitFor(() => doc.querySelector('.jdx-simple-reading iframe')?.contentDocument?.body.textContent.includes('模拟译文'), 'cold cached reading')
    assert(requests === 0, 'Cold cache contacted translation service')
    report.checks.push('simple-reading-cold-restart-zero-provider-requests')
  } finally { main.fetch = originalFetch }
}
