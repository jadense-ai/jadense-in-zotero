/** 注入隔离 Zotero 的全文侧栏验收；操作实际 XPI、合成 PDF 与本地模型夹具。 */
export async function verifyTranslationSidebar({ Zotero, reader, jobs, assert, waitFor, screenshot, report, findManager }) {
  const main = Zotero.getMainWindow(), doc = main.document
  main.focus()
  main.Zotero_Tabs.select(reader.tabID)
  const trigger = reader._iframeWindow.document.querySelector('[data-jadense-action="fullTranslate"]')
  assert(trigger, 'Full translation entry is missing')
  trigger.click()
  const root = await waitFor(() => doc.querySelector(`.jdx-reader-workspace[data-reader-item="${reader.itemID}"]`), 'native translation sidebar')
  assert(root.closest('item-pane-custom-section'), 'Translation did not reuse the registered native section')
  const startButton = root.querySelector('.jdx-reader-translation-confirmation button')
  assert(startButton, 'Full translation confirmation is missing')
  await waitFor(() => !jobs.list('translation').some(task => task.source.itemID === reader.itemID), 'translation confirmation before dispatch')
  startButton.click()
  const task = await waitFor(() => jobs.list('translation').find(task => task.source.itemID === reader.itemID), 'sidebar translation task')
  if (task.status === 'running') {
    const waiting = await waitFor(() => root.querySelector('.jdx-reading-gap:not([hidden])'), 'single pending passage notice')
    assert(root.querySelectorAll('.jdx-reading-gap:not([hidden])').length === 1 && !root.querySelector('.jdx-reading-block:not([hidden])'), 'Pending translation leaked source text or a list of tasks')
    root.querySelector('[data-translation-pause]').click(); await jobs.idle()
    assert(task.status === 'paused' && waiting.isConnected, 'Pause discarded the reading surface')
    root.querySelector('[data-translation-pause]').click()
  }
  await waitFor(() => { if (task.status === 'error') throw new Error(task.error); return task.status === 'complete' }, 'sidebar translation complete')
  const body = await waitFor(() => root.querySelector('.jdx-reading-body'), 'continuous translation body')
  const block = await waitFor(() => body.querySelector('.jdx-reading-block:not([hidden])'), 'translated paragraph')
  assert(!root.querySelector('.jdx-document-original,.jdx-document-page,article details'), 'Source previews or physical pages leaked into the prose')
  assert(!body.querySelector('button,summary'), 'Paragraphs contain repeated action controls')
  assert(!reader._iframeWindow.document.querySelector('.jdx-full-translation-window'), 'Legacy floating translation remains')
  const view = reader._internalReader._primaryView
  await reader.navigate({ pageIndex: 1 })
  await waitFor(() => view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 2, 'PDF before reading selection')
  const range = doc.createRange(); range.selectNodeContents(block); main.getSelection().addRange(range)
  block.click()
  assert(view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 2, 'Read mode navigated the PDF')
  root.querySelector('[data-reading-mode="locate"]').click()
  block.click()
  assert(view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 2, 'Selecting text in Locate mode navigated')
  main.getSelection().removeAllRanges()
  block.click()
  await waitFor(() => view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 1, 'paragraph source navigation')
  const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'a'), launch = Zotero.launchURL
  let launched = ''
  try {
    link.href = 'https://example.invalid/source'; link.textContent = 'reference'; block.append(link)
    Zotero.launchURL = url => { launched = url }; link.click()
    assert(launched === link.href && view._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 1, 'A prose link triggered location')
  } finally { link.remove(); Zotero.launchURL = launch }
  const viewer = view._iframeWindow.PDFViewerApplication.pdfViewer, rotation = viewer.pagesRotation, scale = viewer.currentScaleValue
  viewer.pagesRotation = 90; viewer.currentScaleValue = '1.25'
  body.dispatchEvent(new main.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  doc.activeElement.dispatchEvent(new main.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(() => viewer.currentPageNumber === 2, 'keyboard location under rotation and zoom')
  assert(view._highlightedPosition?.pageIndex === 1 && view._highlightedPosition.rects.length, 'Keyboard location lost PDF coordinates')
  const selecting = new main.KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true })
  body.dispatchEvent(selecting); assert(!selecting.defaultPrevented, 'Locate mode captured a text-selection shortcut')
  viewer.pagesRotation = rotation; viewer.currentScaleValue = scale
  const before = block
  root.querySelector('[data-reading-mode="read"]').click(); jobs.emit()
  await Zotero.Promise.delay(100)
  assert(before === body.querySelector('.jdx-reading-block:not([hidden])'), 'Mode switch rebuilt paragraph DOM')
  const oldCount = jobs.list('translation').length
  trigger.click(); await Zotero.Promise.delay(100)
  assert(jobs.list('translation').length === oldCount, 'Reopening dispatched another task')
  const chromeWidth = main.outerWidth - main.innerWidth, chromeHeight = main.outerHeight - main.innerHeight
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    for (const [width, height] of [[1920, 1080], [1360, 860], [760, 620]]) {
      main.resizeTo(width + chromeWidth, height + chromeHeight)
      await Zotero.Promise.delay(650)
      // Zotero 临时切换 stacked 后才重新计算窗口最小宽度。
      main.resizeTo(width + chromeWidth, height + chromeHeight)
      await Zotero.Promise.delay(450)
      await screenshot(`translation-sidebar-settle-${theme}-${width}`, main)
      await Zotero.Promise.delay(100)
      for (const size of [12, 14, 24]) {
        Zotero.Prefs.set('extensions.jadenseInZotero.translationReadingFontSize', String(size), true)
        await Zotero.Promise.delay(100)
        assert(Number.parseFloat(main.getComputedStyle(body).fontSize) === size, `Reading font was multiplied by plugin scale: ${JSON.stringify({ expected: size, actual: main.getComputedStyle(body).fontSize, variable: root.querySelector('.jdx-translation-reader').style.getPropertyValue('--jdx-reading-font') })}`)
        assert(body.scrollWidth <= body.clientWidth + 2, 'Prose widened the sidebar')
        const bounds = root.getBoundingClientRect(), bodyBounds = body.getBoundingClientRect()
        if (!(bounds.right <= main.innerWidth + 2 && bounds.bottom <= main.innerHeight + 2 && bounds.top >= 0)) await screenshot('translation-sidebar-viewport-issue', main)
        assert(bounds.right <= main.innerWidth + 2 && bounds.bottom <= main.innerHeight + 2 && bounds.top >= 0, `Sidebar escaped the actual viewport: ${JSON.stringify({ theme, size, viewport: [main.innerWidth, main.innerHeight], bounds: bounds.toJSON() })}`)
        if (bodyBounds.height <= 180) {
          report.sidebarAncestors = []; let ancestor = root
          while (ancestor && report.sidebarAncestors.length < 12) { report.sidebarAncestors.push({ name: ancestor.localName, id: ancestor.id, className: ancestor.className, height: ancestor.clientHeight, rect: ancestor.getBoundingClientRect().toJSON(), display: main.getComputedStyle(ancestor).display }); ancestor = ancestor.parentElement }
          await screenshot('translation-sidebar-layout-issue', main)
        }
        assert(bounds.width > 250 && bodyBounds.height > 180, `Reader body has insufficient space: ${JSON.stringify({ width: bounds.width, height: bounds.height, body: bodyBounds.height })}`)
        if (bounds.height >= 600 && size === 14) assert(bodyBounds.height / bounds.height >= .8, 'Chrome occupies over 20% of the reading height')
        ;(report.translationSidebarLayouts ??= []).push({ theme, size, viewport: [main.innerWidth, main.innerHeight], sidebar: [bounds.width, bounds.height], body: [bodyBounds.width, bodyBounds.height] })
        await screenshot(`translation-sidebar-${theme}-${width}-${size}`, main)
      }
    }
  }
  Zotero.Prefs.set('extensions.jadenseInZotero.translationReadingFontSize', '14', true)
  main.resizeTo(1360 + chromeWidth, 860 + chromeHeight)
  const details = await waitFor(() => root.closest('item-details'), 'return from dock to native sidebar'), native = details.sidenav
  const info = native?.querySelector('.btn[data-pane="info"]')
  if (info) {
    info.dispatchEvent(new main.MouseEvent('click', { bubbles: true, detail: 1, button: 0 }))
    await Zotero.Promise.delay(100)
    trigger.click(); await Zotero.Promise.delay(150)
    assert(before === body.querySelector('.jdx-reading-block:not([hidden])'), 'Native sidebar switch recreated the translation')
  }
  root.querySelector('header button').click(); await Zotero.Promise.delay(100)
  assert(jobs.get(task.id).status === 'complete', 'Hiding sidebar changed the task')
  trigger.click(); await Zotero.Promise.delay(100)
  // 长文/局部失败是自有排版夹具，验证 UI 稳定性，不作为模型译质样本。
  const originals = await Promise.all(Array.from({ length: task.totalPages }, (_, i) => jobs.store.page(task.id, i)))
  const prose = [
    '研究首先关注一个经常被忽略的问题：当实验结果跨越多页呈现时，读者仍然需要沿着同一条论证理解证据。研究者先说明观察对象与比较条件，再解释测量方式及其适用范围。每个结论都与相应的实验条件相联系，避免把局部改善误解为适用于所有情境的结果。',
    '为了区分测量波动与稳定变化，实验在相同条件下进行重复观测。分析保留了全部观测值，并结合估计区间讨论结果的不确定性。读者可以继续阅读方法部分，了解样本如何被选择、数据如何被处理，以及哪些因素可能影响结论。',
    '这一比较说明，理解研究结果需要同时考虑效应大小与证据范围。后续工作应在独立样本中重复实验，并检验不同测量条件下的表现。只有这些证据相互支持，结论才有理由被推广到新的研究场景。',
  ].join('')
  for (const original of originals.filter(Boolean)) {
    const page = JSON.parse(JSON.stringify(original))
    for (const piece of page.pieces) page.translations[piece.id] = prose
    await jobs.store.savePage(task.id, page)
  }
  jobs.emit(); await waitFor(() => body.textContent.includes(prose), 'long-form typography fixture')
  Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
  body.scrollTop = 350; body.dispatchEvent(new main.Event('scroll'))
  await Zotero.Promise.delay(450)
  const anchor = await jobs.store.readingPosition(task.id)
  assert(anchor?.blockID, 'Reading anchor was not saved')
  const anchorNode = body.querySelector(`[data-reading-block="${anchor.blockID}"]`), stableText = anchorNode.firstChild
  Zotero.Prefs.set('extensions.jadenseInZotero.translationReadingFontSize', '20', true)
  await Zotero.Promise.delay(150)
  assert(anchorNode.firstChild === stableText, 'Typography rebuilt prose')
  assert(Math.abs(body.scrollTop - anchorNode.offsetTop - anchor.offset * anchorNode.offsetHeight) < 3, 'Font change lost the block anchor')
  Zotero.Prefs.set('extensions.jadenseInZotero.translationReadingFontSize', '14', true)
  body.scrollTop = 0; await screenshot('translation-sidebar-long-chapter', main)
  const incomplete = await jobs.store.page(task.id, 0)
  delete incomplete.translations[incomplete.pieces[0].id]
  if (incomplete.pieces[1]) delete incomplete.translations[incomplete.pieces[1].id]
  await jobs.store.savePage(task.id, incomplete); task.status = 'error'; task.error = '合成断网夹具：已有译文继续可读'; jobs.emit()
  await waitFor(() => body.querySelectorAll('.jdx-reading-gap:not([hidden])').length === 1, 'merged incomplete region')
  assert((await jobs.copy(task.id)).includes('[此处译文尚未完成]') || (await jobs.copy(task.id)).includes('[Translation unavailable here]'), 'Copy silently concealed a gap')
  await screenshot('translation-sidebar-interrupted', main)
  for (const page of originals.filter(Boolean)) await jobs.store.savePage(task.id, page)
  task.status = 'complete'; delete task.error; jobs.emit()
  await waitFor(() => !body.querySelector('.jdx-reading-gap:not([hidden])'), 'completed passage replaced its gap')
  const standalone = await Zotero.Reader.open(reader.itemID, undefined, { openInWindow: true, allowDuplicate: true })
  await standalone._initPromise
  await standalone._internalReader._primaryView.initializedPromise
  const standaloneButton = await waitFor(() => standalone._iframeWindow.document.querySelector('[data-jadense-action="fullTranslate"]'), 'standalone translation entry')
  standaloneButton.click()
  await Zotero.Promise.delay(500)
  report.standalone = { windowURL: standalone._window.document.URL, iframeURL: standalone._iframeWindow.document.URL,
    roots: standalone._window.document.querySelectorAll('.jdx-reader-workspace').length,
    innerRoots: standalone._iframeWindow.document.querySelectorAll('.jdx-reader-workspace').length,
    html: standalone._window.document.querySelector('.jdx-reader-workspace')?.outerHTML.slice(0, 2200) }
  const standaloneRoot = await waitFor(() => standalone._window.document.querySelector('.jdx-reader-dock .jdx-reading-body'), 'standalone docked prose')
  assert(standaloneRoot.closest('.jdx-reader-workspace').dataset.translationTask === task.id, 'Standalone reader did not restore the existing record')
  await standalone.navigate({ pageIndex: 1 })
  standaloneRoot.closest('.jdx-translation-reader').querySelector('[data-reading-mode="locate"]').click()
  standaloneRoot.querySelector('.jdx-reading-block:not([hidden])').click()
  await waitFor(() => standalone._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 1, 'standalone source navigation')
  standalone._window.focus()
  await waitFor(() => standalone._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(0)?.renderingState === 3, 'standalone PDF paint')
  await screenshot('translation-sidebar-independent-window', standalone._window)
  standalone._window.close()
  assert(jobs.list('translation').length === oldCount, 'Window changes created translation requests')
  if (findManager) {
    const historyButton = [...root.querySelectorAll('.jdx-reading-menu button')].find(button => /翻译历史|Translation history/u.test(button.textContent))
    historyButton.click()
    const manager = await waitFor(() => { const value = findManager(); return value?.document.querySelector('.jdx-history-detail .jdx-reading-body') && value }, 'shared full translation history renderer')
    const historyBody = manager.document.querySelector('.jdx-history-detail .jdx-reading-body')
    await waitFor(() => historyBody.querySelector('.jdx-reading-block:not([hidden])')?.textContent, 'history translated prose loaded')
    assert(historyBody.clientHeight > 180 && historyBody.scrollWidth <= historyBody.clientWidth + 2, 'History reader lost its independent viewport')
    manager.focus()
    await screenshot('translation-sidebar-history', manager)
    main.focus()
  }
  report.checks.push('native-translation-sidebar', 'translation-continuous-prose', 'read-locate-selection', 'paragraph-dom-preservation', 'reading-font-independent', 'native-sidebar-reopen', 'sidebar-responsive-layout')
  report.checks.push('translation-pending-pause', 'translation-long-prose-anchor', 'translation-gap-copy-and-recovery', 'translation-independent-window')
  report.checks.push('translation-keyboard-zoom-rotation', 'translation-links-and-selection-shortcuts', 'translation-shared-history')
  return { task, root }
}
