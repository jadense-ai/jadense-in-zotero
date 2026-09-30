/** 隔离 Zotero 中验证真实排版进程和阅读器；只替换合成翻译 Provider。 */
export async function verifyPDFTranslation({ Zotero, reader, assert, waitFor, screenshot, report, config, findManager }) {
  const main = Zotero.getMainWindow(), previous = main.fetch
  const doc = reader._iframeWindow.document, nativeWindow = reader._internalReader._primaryView._iframeWindow
  const control = (root, id) => root.querySelector(`[data-pdf-control="${id}"]`)
  const native = nativeWindow.PDFViewerApplication.pdfViewer
  const original = nativeWindow.frameElement, oldWidth = original.style.width, oldVisibility = original.style.visibility
  if (config.pdfEngineArchive || config.pdfEngineSettingsCheck) {
    Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown', true)
    main.openDialog('chrome://jadense-in-zotero/content/manager.xhtml?section=settings-ocr', 'jadense-engine-settings-smoke', 'chrome,dialog=no,titlebar,resizable,width=1100,height=900', { zotero: Zotero, section: 'settings-ocr', pluginID: config.pluginID })
    const manager = await waitFor(findManager, 'engine settings Manager')
    if (manager.document.querySelector('#jadense-quick-start-dialog')?.open) manager.document.getElementById('jadense-quick-start-close').click()
    // 设置已按依赖分组，必须先显示 PDF 页，避免对隐藏节点做零宽度断言和截图。
    const layoutTab = await waitFor(() => manager.document.querySelector('[data-settings-target="layout"]'), 'PDF engine settings tab')
    layoutTab.click()
    const row = await waitFor(() => manager.document.querySelector('[data-pdf-engine-settings]'), 'PDF engine settings')
    assert(row.getBoundingClientRect().width > 0, 'PDF engine settings must be visible')
    const check = row.querySelector('[data-pdf-engine-check]')
    assert(check && row.querySelector('[data-pdf-engine-import]'), 'Engine import/check controls missing')
    const guide = row.querySelector('a[href$="/docs/pdf-engine.md"]')
    assert(guide, 'PDF engine manual guide link missing')
    const launchURL = Zotero.launchURL, opened = []
    try {
      Zotero.launchURL = url => opened.push(url)
      guide.click()
      assert(opened.length === 1 && opened[0] === guide.href, 'PDF engine guide did not open in the system browser')
    } finally { Zotero.launchURL = launchURL }
    check.click()
    await waitFor(() => !check.disabled, 'empty profile engine check')
    const jobs = await waitFor(() => Zotero.__jadensePDFTranslationJobs, 'PDF engine jobs')
    if (config.pdfEngineArchive) {
      const progress = []
      await jobs.prepare(new main.AbortController().signal, stage => progress.push(stage), false, config.pdfEngineArchive)
      assert(progress.includes('extract') && progress.includes('check'), 'Offline package did not extract and check')
      report.checks.push('pdf-offline-package-real-host-import-and-health')
    }
    check.click()
    await waitFor(() => !check.disabled && /已就绪|engine ready/u.test(row.querySelector('[role="status"]').textContent), 'manual-install offline check', 180_000)
    row.scrollIntoView({ block: 'center' })
    await screenshot('pdf-engine-settings', manager)
    manager.resizeTo(760, 850)
    await new Promise(resolve => main.setTimeout(resolve, 400))
    assert(row.scrollWidth <= row.clientWidth + 2, 'Engine controls overflow narrow window')
    await screenshot('pdf-engine-settings-narrow', manager)
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
    await new Promise(resolve => main.setTimeout(resolve, 300))
    await screenshot('pdf-engine-settings-light', manager)
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'dark', true)
    report.checks.push('pdf-manual-check-button-and-narrow-settings')
    manager.close()
    await new Promise(resolve => main.setTimeout(resolve, 100))
    assert(Array.isArray(jobs.list()), 'PDF jobs must survive closing engine settings')
    if (config.pdfEngineSetupOnly) return
  }
  let fixtureStarts = 0
  let fixtureTask, notifyFixture = () => {}
  // UI 专项显式注入已生成的合成 PDF；不将其报告为真实引擎或冷启动缓存验收。
  if (config?.pdfViewerFixture) {
    const task = { id: 'viewer-fixture', status: 'running', pages: native.pagesCount, skipped: [], coverage: { total: 2, translated: 0, failed: 2, preserved: 0, failedPages: [0] } }
    fixtureTask = task
    Zotero.__jadensePDFTranslationJobs = {
      start: async () => { fixtureStarts++; return task }, openOrStart: async () => { fixtureStarts++; return task }, subscribe: callback => { notifyFixture = callback; return () => {} }, isActive: () => false,
      speed: () => ({ active: 1, concurrency: 2, httpMinute: 3, rpm: 20, queued: 0, waitMs: 0 }),
      hasOutput: () => true, bytes: () => globalThis.IOUtils.read(config.pdfViewerFixture), stop() {},
    }
  }
  const ai = Boolean(config?.pdfAI), starts = [], mixed = [], batchRows = []
  let active = 0, peak = 0, mixedStarted = false
  Zotero.Prefs.set('extensions.jadenseInZotero.fullTranslationInterface', JSON.stringify(ai ? { kind: 'ai', service: 'google' } : { kind: 'machine', service: 'google' }), true)
  let requests = 0, failedID = '', injectFailure = Boolean(config?.pdfPartial)
  main.fetch = async (url, options) => {
    if (ai && /\/api\/chat\/temporary$/u.test(String(url)) && options?.method === 'HEAD') {
      starts.push(Date.now()); return new main.Response(null, { headers: { 'x-jadense-temporary-protocol': '1' } })
    }
    if (ai && /\/api\/chat$/u.test(String(url)) && options?.method === 'POST') {
      const body = JSON.parse(options.body), text = body.messages.map(message => message.text ?? message.content ?? message.parts?.map(part => part.text ?? '').join('') ?? '').join('\n')
      requests++; starts.push(Date.now()); active++; peak = Math.max(peak, active)
      let translated
      const translate = source => source.split(/(<[^>]+>|\{[^}]+\}|⟦[^⟧]+⟧)/u).map(part => /^(<|\{|⟦)/u.test(part) ? part : part.replace(/[A-Za-z][A-Za-z ,.]+/gu, '科学研究保留证据。')).join('')
      if (text.startsWith('Translate the document passages')) {
        const current = Zotero.__jadensePDFTranslationJobs.list().find(task => task.status === 'running')
        assert(current && Zotero.__jadensePDFTranslationJobs.hasOutput(current), 'PDF must be published before any Provider request')
        if (!batchRows.length) report.checks.push('pdf-artifact-before-first-provider-request')
        const rows = JSON.parse(text.slice(text.indexOf('\n') + 1))
        batchRows.push(rows.length)
        if (injectFailure && !failedID) failedID = rows[0].id
        translated = JSON.stringify([...rows].filter(row => !injectFailure || row.id !== failedID).reverse().map(row => ({ id: row.id, output: translate(row.input), additional: true })))
        if (!mixedStarted) { mixedStarted = true; mixed.push(Zotero.__jadenseDocumentJobs.start('translation', reader.itemID).then(() => Zotero.__jadenseDocumentJobs.idle())) }
      } else translated = translate(/<passage>\n([\s\S]*?)\n<\/passage>/u.exec(text)?.[1] ?? text)
      await new Promise(resolve => main.setTimeout(resolve, 5000)); active--
      return new main.Response(`data: ${JSON.stringify({ type: 'text-delta', delta: translated })}\n\ndata: {"type":"finish"}\n\n`, { headers: { 'content-type': 'text/event-stream', 'x-jadense-temporary-protocol': '1' } })
    }
    if (!String(url).startsWith('https://translate.google.com/m?')) return previous.call(main, url, options)
    requests++
    return new main.Response('<div class="result-container">科学研究方法保留重要证据。</div>')
  }
  try {
    const compare = await waitFor(() => doc.querySelector('[data-jadense-pdf-mode="compare"]'), 'PDF comparison button')
    if (!compare.getBoundingClientRect().width) doc.querySelector('.jadense-reader-actions-toggle')?.click()
    await waitFor(() => compare.getBoundingClientRect().width > 0, 'visible PDF comparison menu action')
    assert(!doc.querySelector('[data-jadense-pdf-mode="inplace"]') && compare.getBoundingClientRect().width > 0, 'Top toolbar must only expose comparison')
    compare.click()
    let panel = await waitFor(() => doc.querySelector('.jdx-pdf-translation'), 'PDF translation panel')
    const homePanel = panel
    if (config.pdfViewerFixture) {
      await new Promise(resolve => main.setTimeout(resolve, 150))
      assert(panel.querySelector('iframe').hidden && !panel.querySelector('[data-pdf-control="view"] [role="option"][aria-selected="true"]')?.textContent.includes('仅显示译文'), 'Source-only PDF enabled translated views')
      report.checks.push('pdf-zero-translation-artifact-gated')
      fixtureTask.status = 'complete'; fixtureTask.coverage = { total: 2, translated: 2, failed: 0, preserved: 0, failedPages: [] }
      notifyFixture()
    }
    const toolbar = panel.querySelector('.jdx-pdf-translation-toolbar')
    assert(toolbar && toolbar.getBoundingClientRect().height <= 52, 'PDF primary toolbar must fit on one row')
    control(panel, 'more-toggle').click()
    assert(!panel.querySelector('.jdx-pdf-translation-popover').hidden && control(panel, 'scope')?.querySelector('.jdx-select-trigger'), 'Grouped actions or shared translation selector missing')
    const contextInput = panel.querySelector('[data-reading-budget="pdf"]')
    assert(contextInput?.value === '131072', 'PDF context budget must default to 128K')
    contextInput.value = '65536'; contextInput.dispatchEvent(new doc.defaultView.Event('change'))
    assert(JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.readingTranslationBudgets', true)).pdf === 65536, 'PDF budget edit not persisted')
    await screenshot('pdf-context-settings', reader._iframeWindow)
    contextInput.value = '131072'; contextInput.dispatchEvent(new doc.defaultView.Event('change'))
    report.checks.push('pdf-context-default-edit-no-restart')
    panel.querySelector('.jdx-pdf-translation-popover').dispatchEvent(new panel.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert(panel.querySelector('.jdx-pdf-translation-popover').hidden, 'PDF overflow panel failed to close')
    const label = () => panel.querySelector('.jdx-pdf-status-content')?.textContent ?? ''
    const deadline = Date.now() + 12 * 60_000
    let pdf, previousStatus = ''
    while (Date.now() < deadline) {
      if (label() !== previousStatus) {
        previousStatus = label(); report.engineStatus = previousStatus
        await globalThis.IOUtils.writeUTF8(config.reportPath, JSON.stringify(report))
      }
      const frameWindow = panel.querySelector('iframe')?.contentWindow
      pdf = (frameWindow?.wrappedJSObject ?? frameWindow)?.JadensePDFView
      if (pdf && !panel.querySelector('iframe').hidden) break
      const retry = control(panel, 'retry')
      if (retry && !retry.hidden && /失败|failed|Error|Cannot|unavailable|未完成|Permission denied|dead object/u.test(label())) {
        const errors = globalThis.Services.console.getMessageArray().map(row => row.message).filter(message => /pdf|viewer|SecurityError|SyntaxError|TypeError/iu.test(message)).slice(-15)
        throw new Error('PDF translation failed: ' + label() + '\n' + errors.join('\n'))
      }
      await new Promise(resolve => main.setTimeout(resolve, 300))
    }
    assert(pdf && !panel.querySelector('iframe').hidden, 'PDF viewer did not load: ' + label())
    await waitFor(() => panel.querySelector('iframe')?.contentDocument?.querySelector('.textLayer span'), 'translated PDF text layer')
    if (config.pdfViewerFixture) {
      control(panel, 'more-toggle').click()
      const scope = control(panel, 'scope'), trigger = scope.querySelector('.jdx-select-trigger')
      trigger.click()
      const other = scope.querySelector('.jdx-select-option[aria-selected="false"]')
      assert(other && scope.dataset.open === 'true', 'Translation scope options did not open')
      const selected = other.textContent.trim(); other.click()
      assert(trigger.textContent.includes(selected) && fixtureStarts === 1, 'Changing translation scope restarted the fixture task')
      await screenshot('pdf-translation-actions', reader._iframeWindow)
      control(panel, 'more-toggle').click()
      control(panel, 'search-toggle').click()
      assert(!panel.querySelector('.jdx-pdf-translation-search').hidden, 'Search popover did not open')
      panel.querySelector('.jdx-pdf-translation-search').dispatchEvent(new panel.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      assert(panel.querySelector('.jdx-pdf-translation-search').hidden, 'Search popover did not close with Escape')
      report.checks.push('pdf-scope-select-no-implicit-start-and-popover-keyboard')
    }
    if (fixtureTask && config.pdfStatusOnly) {
      const status = panel.querySelector('.jdx-pdf-status-content'), chip = () => control(panel, 'status-toggle')
      assert(!chip().hidden && /2/u.test(status.textContent), 'Completed translation coverage is missing')
      Object.assign(fixtureTask, { status: 'running', stage: 'translation', requestProgress: { stage: 'reasoning', stageStartedAt: Date.now(), receivedCharacters: 0 }, completed: 86, total: 120, error: 'Synthetic temporary warning', retrying: { batch: { attempt: 1, until: Date.now() + 20000 } } })
      notifyFixture()
      await waitFor(() => chip().classList.contains('is-working') && status.querySelector('progress')?.value === 86, 'active translation progress')
      assert(/自动继续|automatically/u.test(chip().textContent), 'Recovery countdown missing from status chip')
      assert(/自动继续|automatically/u.test(status.textContent), 'Recovery countdown missing')
      assert(/思考|Thinking/u.test(status.textContent), 'Actual request phase is missing')
      assert(status.firstChild.textContent !== fixtureTask.error, 'Warning replaced active work')
      assert(reader._iframeWindow.getComputedStyle(chip().querySelector('.jdx-pdf-status-dot')).animationName === 'jdx-pdf-working', 'Working animation missing')
      const details = status.querySelector('details'); details.open = true
      await new Promise(resolve => main.setTimeout(resolve, 1200))
      assert(status.querySelector('details').open, 'Details closed on refresh')
      status.querySelector('details').open = false
      await screenshot('pdf-translation-auto-retry', reader._iframeWindow)
      const managerWindow = main
      managerWindow.resizeTo(760, 850)
      panel.style.width = '640px'
      Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
      await new Promise(resolve => main.setTimeout(resolve, 500))
      assert(toolbar.getBoundingClientRect().height <= 52, '640px PDF toolbar wrapped')
      chip().click()
      const statusPanel = await waitFor(() => { const node = panel.querySelector('.jdx-pdf-translation-status-panel'); return node && !node.hidden ? node : null }, 'status popover')
      assert(statusPanel.getBoundingClientRect().width <= panel.getBoundingClientRect().width && statusPanel.scrollWidth <= statusPanel.clientWidth + 1, 'Status popover overflows the narrow reader')
      await screenshot('pdf-translation-auto-retry-narrow-light', reader._iframeWindow)
      statusPanel.dispatchEvent(new panel.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      assert(panel.querySelector('.jdx-pdf-translation-status-panel').hidden, 'Status popover failed to close with Escape')
      report.checks.push('pdf-status-chip-popover')
      panel.style.width = '320px'
      Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 150, true)
      await new Promise(resolve => main.setTimeout(resolve, 300))
      assert(toolbar.getBoundingClientRect().height <= 52 && toolbar.scrollWidth <= toolbar.clientWidth + 1, '320px / 150% PDF toolbar overflows')
      await screenshot('pdf-translation-auto-retry-320-light', reader._iframeWindow)
      Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 100, true)
      panel.style.width = '640px'
      Object.assign(fixtureTask, { stage: 'parse', total: undefined, retrying: {} }); notifyFixture()
      assert(!status.querySelector('progress').hasAttribute('value'), 'Unknown progress must be indeterminate')
      Object.assign(fixtureTask, { status: 'partial', error: undefined, diagnosticId: 'synthetic-diagnostic-123', failureCounts: { OUTPUT_FAILED: 34, PLACEHOLDER_MISMATCH: 6 } }); notifyFixture()
      assert(!chip().classList.contains('is-working') && /已保存|saved/u.test(status.textContent), 'Partial result must stop animation and explain saved work')
      assert(control(panel, 'retry')?.hidden && /补译|Resume/u.test(control(panel, 'task-action')?.textContent || ''), 'Partial translation shows duplicate resume actions')
      assert(status.textContent.includes('synthetic-diagnostic-123') && status.textContent.includes('OUTPUT_FAILED') && status.textContent.includes('PLACEHOLDER_MISMATCH'), 'Failure details lack identity or recovery categories')
      status.querySelector('details').open = true
      await screenshot('pdf-translation-failure-details', reader._iframeWindow)
      panel.style.width = '320px'
      Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 150, true)
      await new Promise(resolve => main.setTimeout(resolve, 200))
      assert(toolbar.scrollWidth <= toolbar.clientWidth + 1 && toolbar.getBoundingClientRect().height <= 52, 'Partial retry overflows compact PDF toolbar')
      Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', 100, true)
      panel.style.width = '640px'
      Object.assign(fixtureTask, { status: 'complete' }); notifyFixture()
      report.checks.push('pdf-working-animation-countdown-progress-details-partial-state')
      return
    }
    if (!config.pdfViewerFixture) {
      const jobs = Zotero.__jadensePDFTranslationJobs, task = jobs.get(panel.dataset.pdfTaskId)
      assert(jobs.hasOutput(task), 'Initial PDF must be readable')
      report.checks.push('pdf-readable-before-terminal-state')
      await waitFor(() => !jobs.isActive(task.id), 'PDF terminal state after initial readable artifact', 600000)
      assert(task.status === 'partial' || task.status === 'complete', 'Translation failed after initial artifact: ' + task.error)
      await waitFor(() => panel.dataset.pdfArtifactRevision === task.artifact.revision, 'latest PDF revision').catch(error => {
        throw new Error(`${error}; loaded=${panel.dataset.pdfArtifactRevision}; expected=${task.artifact.revision}; status=${label()}; errors=${globalThis.Services.console.getMessageArray().map(row => row.message).filter(message => /pdf|viewer|SecurityError|SyntaxError|TypeError/iu.test(message)).slice(-12).join('\n')}`)
      })
      pdf = (panel.querySelector('iframe').contentWindow.wrappedJSObject ?? panel.querySelector('iframe').contentWindow).JadensePDFView
    }
    if (ai) {
      assert(batchRows.some(count => count > 1), 'AI must send multiple independent paragraphs in one request')
      const task = Zotero.__jadensePDFTranslationJobs.get(panel.dataset.pdfTaskId)
      assert(task.strategy === 'batch-v4' && task.summary?.batchRows?.some(count => count > 1), 'Batch strategy or summary missing')
      report.batchPacking = { rows: batchRows.slice(), tokens: task.summary.batchTokens, endReasons: task.summary.batchEndReasons, coverage: task.coverage }
      report.checks.push('pdf-ai-multiple-paragraphs-per-request-and-batch-summary')
    }
    if (config.pdfEngineOnly) {
      assert(config.pdfViewerFixture || requests > 0, 'Real engine did not request translation')
      assert(panel.querySelector('iframe').contentDocument.body.textContent.includes('科学'), 'Translated PDF text is missing')
      await screenshot('pdf-engine-translated-reader')
      report.checks.push(config.pdfViewerFixture ? 'pdf-engine-settings-and-viewer-fixture' : 'pdf-engine-prepared-settings-closed-real-translation-and-reader')
      Zotero.Prefs.set('extensions.jadenseInZotero.pdfSmokeAttachment', reader.itemID, true)
      globalThis.Services.prefs.savePrefFile(null)
      return
    }
    // 长错误须保留尾部、可在状态浮层查看/选择；使用合成路径，不读取用户诊断或剪贴板。
    const statusContentNode = panel.querySelector('.jdx-pdf-status-content'), oldDetails = statusContentNode.textContent, oldChipHidden = control(panel, 'status-toggle').hidden
    const longError = 'Synthetic PDF error\n' + 'C:/synthetic/long-path/'.repeat(50) + '\nPermission denied (synthetic end)'
    statusContentNode.textContent = longError; control(panel, 'status-toggle').hidden = false
    control(panel, 'status-toggle').click()
    const expandedDetails = await waitFor(() => { const node = panel.querySelector('.jdx-pdf-translation-status-panel'); return node && !node.hidden ? node : null }, 'expanded PDF error')
    expandedDetails.scrollTop = expandedDetails.scrollHeight
    assert(statusContentNode.textContent.endsWith('Permission denied (synthetic end)') && expandedDetails.clientHeight > 0 && expandedDetails.scrollWidth <= expandedDetails.clientWidth + 1, 'PDF error tail lost or horizontally clipped')
    assert(control(panel, 'copy-status'), 'PDF error copy action missing')
    await screenshot('pdf-translation-expanded-error', reader._iframeWindow)
    expandedDetails.dispatchEvent(new panel.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    statusContentNode.textContent = oldDetails; control(panel, 'status-toggle').hidden = oldChipHidden
    await waitFor(() => Math.abs(original.getBoundingClientRect().top - panel.querySelector('iframe').getBoundingClientRect().top) < 2, 'PDF view alignment after collapsing details')
    report.checks.push('pdf-long-error-expand-wrap-and-copy-action')
    assert(config?.pdfViewerFixture ? requests === 0 : requests > 0, 'Unexpected translation provider requests')
    if (ai) {
      await Promise.all(mixed)
      assert(peak <= 2 && starts.every((time, index) => !index || time - starts[index - 1] >= 2950), 'Shared translation limits exceeded')
      assert(mixedStarted, 'Mixed Markdown translation did not run')
      report.translation = { modelRequests: requests, httpRequests: starts.length, peakConcurrency: peak }
      report.checks.push('pdf-ai-json-reordered-ids-and-shared-markdown-throttle')
    }
    if (config?.pdfPartial) {
      const jobs = Zotero.__jadensePDFTranslationJobs, task = jobs.get(panel.dataset.pdfTaskId)
      assert(task.status === 'partial' && task.coverage.failed === 1 && task.coverage.translated > 0, 'Partial task did not retain successful translations')
      assert(!control(panel, 'save-pdf').disabled && !control(panel, 'save-bilingual').disabled, 'Partial exports disabled')
      // 值拷贝到测试 compartment；旧 iframe 销毁后不能再读取其对象。
      const revision = task.artifact.revision, position = JSON.parse(pdf.stateJSON()), beforeRepair = requests
      injectFailure = false
      const repair = control(panel, 'task-action')
      assert(control(panel, 'retry')?.hidden && repair && !repair.disabled && /补译|Resume/u.test(repair.textContent), 'Partial retry must appear only in the toolbar')
      repair.click()
      assert(jobs.hasOutput(task), 'Retry hid the existing artifact')
      await waitFor(() => task.status === 'complete' && panel.dataset.pdfArtifactRevision === task.artifact.revision && task.artifact.revision !== revision, 'repaired PDF revision', 600000)
      assert(task.coverage.failed === 0 && requests === beforeRepair + 1, 'Retry translated already completed passages')
      pdf = (panel.querySelector('iframe').contentWindow.wrappedJSObject ?? panel.querySelector('iframe').contentWindow).JadensePDFView
      assert(pdf.state().page === position.page && Math.abs(pdf.state().fraction-position.fraction)<.05, 'Repair lost reading position')
      report.checks.push('pdf-partial-original-fallback-export-retry-only-missing-revision-position')
    }
    const translatedRequests = requests
    assert(original.style.width === '50%', 'Comparison did not split the native view')
    assert(panel.getBoundingClientRect().width > 100, 'Translated pane has no width')
    assert(Math.abs(original.getBoundingClientRect().top - panel.querySelector('iframe').getBoundingClientRect().top) < 2, 'Original and translation viewport tops do not align')
    const sidebar = main.ZoteroContextPane, previousCollapsed = sidebar?.collapsed
    if (sidebar) {
      const contextPane = main.document.getElementById('zotero-context-pane')
      const previousStyle = contextPane?.getAttribute('style')
      const pageBefore = native.currentPageNumber
      sidebar.collapsed = true
      const wide = original.getBoundingClientRect().width
      sidebar.collapsed = false
      await waitFor(() => original.getBoundingClientRect().width < wide - 20, 'PDF comparison sidebar expands')
      if (contextPane) {
        const narrow = original.getBoundingClientRect().width
        const width = contextPane.getBoundingClientRect().width
        contextPane.style.setProperty('min-width', `${width + 80}px`, 'important')
        await waitFor(() => original.getBoundingClientRect().width < narrow - 30, 'PDF comparison sidebar width adjusts')
        if (previousStyle === null) contextPane.removeAttribute('style'); else contextPane.setAttribute('style', previousStyle)
      }
      sidebar.collapsed = true
      await waitFor(() => original.getBoundingClientRect().width >= wide - 2, 'PDF comparison sidebar closes')
      assert(native.currentPageNumber === pageBefore, 'Sidebar resizing moved the original PDF page')
      if (/^(auto|page-width|page-fit|page-height)$/u.test(native.currentScaleValue)) {
        const page = native.getPageView(native.currentPageNumber - 1).div
        assert(page.getBoundingClientRect().width <= native.container.clientWidth + 4, 'PDF comparison did not refit after sidebar closed')
      }
      sidebar.collapsed = previousCollapsed
      report.checks.push('pdf-comparison-sidebar-open-close-refit')
    }
    report.checks.push(config?.pdfViewerFixture ? 'pdf-fixture-text-layer-no-engine-dispatch' : 'pdf-engine-stdio-provider-and-text-layer')
    if (!config.pdfViewerFixture) await waitFor(() => panel.querySelector('iframe').contentDocument.body.textContent.includes('科学'), 'completed translation text layer')
    await screenshot('pdf-translation-compare')
    await Zotero.Promise.delay(350)
    nativeWindow.dispatchEvent(new nativeWindow.Event('pointerdown'))
    native.currentPageNumber = 2
    await waitFor(() => pdf.state().page === 2, 'native-to-translation page sync').catch(error => { throw new Error(`${error}; native=${native.currentPageNumber}/${native.pagesCount}; translation=${JSON.stringify(pdf.state())}; scale=${native.currentScaleValue}; width=${original.getBoundingClientRect().width}`) })
    const scale = native.currentScale * 1.1
    native.currentScale = scale
    await waitFor(() => Math.abs(pdf.state().scale - scale) < .002, 'native-to-translation zoom sync')
    native.pagesRotation = 90
    await waitFor(() => pdf.state().rotation === 90, 'native-to-translation rotation sync')
    // 实际滚动译文窗口，验证反向页面同步，不调用被设计为静默的 set 接口。
    const translatedContainer = panel.querySelector('iframe').contentDocument.getElementById('viewerContainer')
    const translatedWindow = panel.querySelector('iframe').contentWindow
    translatedWindow.dispatchEvent(new translatedWindow.Event('wheel'))
    await new Promise(resolve => main.setTimeout(resolve, 300))
    translatedContainer.scrollTop = 0
    await waitFor(() => native.currentPageNumber === 1, 'translation-to-native page sync')
    nativeWindow.dispatchEvent(new nativeWindow.Event('wheel'))
    native.pagesRotation = 0
    await waitFor(() => pdf.state().rotation === 0 && native.pagesRotation === 0, 'reset rotation')
    report.checks.push('pdf-bidirectional-page-zoom-rotation-sync')
    const sync = control(panel, 'sync')
    assert(sync?.getAttribute('aria-pressed') === 'true', 'Linked scrolling control missing')
    const settle = () => new Promise(resolve => main.setTimeout(resolve, 250))
    const scroll = async (window, container, top) => {
      window.dispatchEvent(new window.Event('wheel'))
      container.scrollTop = top
      const expected = container.scrollTop
      await settle()
      assert(Math.abs(container.scrollTop - expected) < 2, `Scroll bounced: ${expected} -> ${container.scrollTop}`)
    }
    for (const top of [120, 240, 360, 180]) {
      await scroll(translatedWindow, translatedContainer, top)
      const sourcePage = native.getPageView(pdf.state().page - 1).div
      assert(Math.abs(native.container.scrollTop - sourcePage.offsetTop - sourcePage.offsetHeight * pdf.state().fraction) < 3, 'Right-to-left relative height mismatch: ' + JSON.stringify({ nativeTop: native.container.scrollTop, pageTop: sourcePage.offsetTop, pageHeight: sourcePage.offsetHeight, translation: JSON.parse(pdf.stateJSON()) }))
    }
    for (const top of [300, 450, 120]) await scroll(nativeWindow, native.container, top)
    sync.click()
    assert(sync.getAttribute('aria-pressed') === 'false', 'Cannot unlink scroll')
    const leftTop = native.container.scrollTop
    await scroll(translatedWindow, translatedContainer, 380)
    assert(native.container.scrollTop === leftTop, 'Unlinked right scroll moved left')
    const rightTop = translatedContainer.scrollTop
    await scroll(nativeWindow, native.container, 220)
    assert(translatedContainer.scrollTop === rightTop, 'Unlinked left scroll moved right')
    sync.click()
    await settle()
    report.checks.push('pdf-continuous-scroll-no-bounce-and-unlinked-both-panes')
    // 实际初始化系统 picker（不打开交互窗口）；回归 Reader 内容窗口的参数转换报错。
    const { FilePicker } = globalThis.ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs')
    const picker = new FilePicker()
    picker.init(main, 'PDF export regression', picker.modeSave)
    picker.defaultExtension = 'pdf'; picker.appendFilter('PDF', '*.pdf')
    report.checks.push('pdf-native-filepicker-init')
    const viewChoice = (root, label) => [...root.querySelectorAll('[data-pdf-control="view"] [role="option"]')].find(node => label.test(node.textContent))
    const inplace = viewChoice(panel, /仅显示译文|Translation only/u)
    assert(inplace, 'Translation-only control missing'); inplace.click()
    await waitFor(() => original.style.visibility === 'hidden', 'in-place translated PDF')
    const sourceView = viewChoice(panel, /原 PDF|Original PDF/u)
    assert(sourceView, 'Original view missing')
    for (const fraction of [.2, .3, .4]) {
      const translatedPage = panel.querySelector('iframe').contentDocument.querySelector('.page')
      await scroll(translatedWindow, translatedContainer, translatedPage.offsetTop + translatedPage.offsetHeight * fraction)
      sourceView.click()
      await settle()
      assert(original.style.visibility === oldVisibility, 'Original is not visible')
      const page = native.getPageView(0).div
      assert(Math.abs(native.container.scrollTop - page.offsetTop - page.offsetHeight * fraction) < 3, 'Showing original lost the translation anchor')
      await scroll(nativeWindow, native.container, page.offsetTop + page.offsetHeight * (fraction + .1))
      inplace.click()
      await settle()
      assert(original.style.visibility === 'hidden', 'Translation did not return')
      assert(pdf.state().page === 1 && Math.abs(pdf.state().fraction - fraction - .1) < .01, 'Returning to translation lost the original anchor')
    }
    await screenshot('pdf-translation-inplace')
    assert(requests === translatedRequests, 'Switching reading mode dispatched translation again')
    report.checks.push('pdf-inplace-original-toggle-no-extra-requests')
    report.checks.push('pdf-inplace-repeated-toggle-preserves-page-and-fraction')
    viewChoice(panel, /双视图|Split view/u).click()
    assert(original.style.width === '50%' && original.style.visibility === oldVisibility, 'Translation-only toggle did not restore comparison')
    const multiScreen = control(panel, 'multi-screen')
    assert(multiScreen, 'Multi-screen control missing')
    const windowStatus = new doc.defaultView.MutationObserver(() => {
      const message = homePanel.querySelector('.jdx-pdf-status-content')?.textContent
      if (message) (report.windowStatus ??= []).push(message)
    })
    windowStatus.observe(homePanel.querySelector('.jdx-pdf-status-content'), { childList: true })
    viewChoice(panel, /多屏模式|Multi-screen/u).click()
    const detachedPanelReady = () => {
      const browser = [...globalThis.Services.wm.getEnumerator(null)].map(window => window.document.getElementById('translation-host')).find(Boolean)
      if (browser) report.detachedHost = { uri: browser.contentDocument?.documentURI, ready: browser.contentDocument?.readyState, rootReady: browser.ownerDocument.readyState, load: typeof browser.fixupAndLoadURIString, width: browser.getBoundingClientRect().width, src: browser.getAttribute('src') }
      if (/独立阅读器未就绪|Separate reader is not ready/u.test(label())) throw new Error(label())
      const candidate = browser?.contentDocument?.querySelector('.jdx-pdf-translation')
      if (candidate?.querySelector('iframe')?.contentDocument?.querySelector('.textLayer span')) { panel = candidate; return panel }
      return null
    }
    await waitFor(detachedPanelReady, 'detached translated PDF').catch(error => {
      const windows = [...globalThis.Services.wm.getEnumerator(null)].map(window => window.document.getElementById('translation-host')?.contentDocument?.documentURI).filter(Boolean)
      throw new Error(`${error.message}; status=${label()}; windows=${JSON.stringify(windows)}; host=${JSON.stringify(report.detachedHost)}`)
    })
    const detachedWindow = [...globalThis.Services.wm.getEnumerator(null)].find(window => window.document.getElementById('translation-host')?.contentDocument === panel.ownerDocument)
    assert(detachedWindow, 'Detached native window missing')
    assert(control(panel, 'view').hidden && control(panel, 'multi-screen').getBoundingClientRect().width > 0, 'Detached return action missing')
    assert(control(panel, 'status-toggle') && panel.querySelector('.jdx-pdf-status-content'), 'Detached status chip or content missing')
    if (config.pdfViewerFixture) {
      control(panel, 'more-toggle').click()
      const detachedScope = control(panel, 'scope'), detachedTrigger = detachedScope.querySelector('.jdx-select-trigger')
      const budgetInput = panel.querySelector('[data-reading-budget="pdf"]')
      budgetInput.value = '196608'; budgetInput.dispatchEvent(new panel.ownerDocument.defaultView.Event('change'))
      assert(homePanel.querySelector('[data-reading-budget="pdf"]').value === '196608' && fixtureStarts === 1, 'Detached budget did not synchronize without restarting translation')
      budgetInput.value = '131072'; budgetInput.dispatchEvent(new panel.ownerDocument.defaultView.Event('change'))
      report.checks.push('pdf-detached-context-edit-sync-no-restart')
      detachedTrigger.click()
      const other = detachedScope.querySelector('.jdx-select-option[aria-selected="false"]')
      assert(other && detachedScope.dataset.open === 'true', 'Detached scope selector did not open')
      const selected = other.textContent.trim(); other.click()
      assert(control(homePanel, 'scope').querySelector('.jdx-select-trigger').textContent.includes(selected) && fixtureStarts === 1, 'Detached scope did not synchronize without starting a task')
      await screenshot('pdf-translation-multiscreen-actions', panel.ownerDocument.defaultView)
      control(panel, 'more-toggle').click()
    }
    assert(!panel.ownerDocument.nodePrincipal.isSystemPrincipal && !panel.querySelector('iframe').contentDocument.nodePrincipal.isSystemPrincipal, 'Detached PDF must remain unprivileged')
    assert(original.style.width === oldWidth && original.style.visibility === oldVisibility, 'Multi-screen mode did not restore full-width original')
    pdf = (panel.querySelector('iframe').contentWindow.wrappedJSObject ?? panel.querySelector('iframe').contentWindow).JadensePDFView
    nativeWindow.dispatchEvent(new nativeWindow.Event('wheel'))
    native.container.scrollTop = 0
    await waitFor(() => pdf.state().page === 1 && pdf.state().fraction < .05, 'detached original-to-translation sync')
    const detachedFrame = panel.querySelector('iframe').contentWindow
    detachedFrame.dispatchEvent(new detachedFrame.Event('wheel'))
    panel.querySelector('iframe').contentDocument.getElementById('viewerContainer').scrollTop = 300
    await waitFor(() => native.container.scrollTop > 200, 'detached translation-to-original sync')
    const detachedSync = control(panel, 'sync')
    detachedSync.click()
    await waitFor(() => detachedSync.getAttribute('aria-pressed') === 'false', 'detached sync control state')
    const detachedNativeTop = native.container.scrollTop
    await scroll(detachedFrame, panel.querySelector('iframe').contentDocument.getElementById('viewerContainer'), 450)
    assert(native.container.scrollTop === detachedNativeTop, 'Detached unlinked scroll moved original')
    detachedSync.click()
    nativeWindow.dispatchEvent(new nativeWindow.Event('wheel'))
    const detachedScale = pdf.state().scale
    native.currentScale = Math.min(10, detachedScale * 1.2)
    await waitFor(() => pdf.state().scale > detachedScale, 'detached native zoom sync')
    const detachedSearch = control(panel, 'find')
    control(panel, 'search-toggle').click()
    await waitFor(() => !panel.querySelector('.jdx-pdf-translation-search').hidden, 'detached search popover')
    detachedSearch.focus()
    detachedSearch.value = '科学'; detachedSearch.dispatchEvent(new panel.ownerDocument.defaultView.Event('input'))
    await waitFor(() => panel.querySelector('iframe').contentDocument.querySelector('.textLayer .highlight'), 'detached search control').catch(error => { throw new Error(`${error}; source=${control(homePanel, 'find').value}; copy=${detachedSearch.value}; text=${panel.querySelector('iframe').contentDocument.body.textContent.slice(0, 1500)}`) })
    detachedWindow.resizeTo(680, 600)
    // 部分宿主会忽略脚本 resizeTo；直接约束内容宿主并核对实际宽度，不能把宽屏截图当作窄屏验收。
    detachedWindow.document.getElementById('translation-host').style.maxWidth = '640px'
    await waitFor(() => panel.getBoundingClientRect().width <= 640, 'detached 640px content viewport')
    const detachedBounds = panel.getBoundingClientRect()
    assert([...panel.querySelector('.jdx-pdf-translation-toolbar').querySelectorAll('button')].filter(button => !button.hidden).every(button => { const rect = button.getBoundingClientRect(); return rect.left >= detachedBounds.left - 1 && rect.right <= detachedBounds.right + 1 }), 'Detached narrow controls overflow')
    await screenshot('pdf-translation-multiscreen', panel.ownerDocument.defaultView)
    const detachedState = JSON.parse(JSON.stringify(pdf.state()))
    detachedWindow.close()
    panel = homePanel
    await waitFor(() => panel.ownerDocument === doc && panel.querySelector('iframe')?.contentDocument?.querySelector('.textLayer span'), 'close detached window restores comparison')
    assert(original.style.width === '50%', 'Closing separate window did not restore comparison')
    pdf = (panel.querySelector('iframe').contentWindow.wrappedJSObject ?? panel.querySelector('iframe').contentWindow).JadensePDFView
    assert(pdf.state().page === detachedState.page && Math.abs(pdf.state().fraction - detachedState.fraction) < .05, 'Detached close lost reading position')
    viewChoice(panel, /多屏模式|Multi-screen/u).click()
    await waitFor(detachedPanelReady, 'reopen detached translated PDF')
    const returnButton = control(panel, 'multi-screen')
    assert(returnButton, 'Return control missing'); returnButton.click(); panel = homePanel
    await waitFor(() => panel.ownerDocument === doc && panel.querySelector('iframe')?.contentDocument?.querySelector('.textLayer span'), 'return-to-comparison button')
    assert(requests === translatedRequests, 'Multi-screen transitions dispatched translation again')
    if (config?.pdfViewerFixture) assert(fixtureStarts === 1, 'Reading mode changes restarted the translation task')
    report.checks.push('pdf-multiscreen-sync-position-narrow-close-return-no-extra-requests')
    windowStatus.disconnect()
    const save = [control(panel, 'save-pdf'), control(panel, 'save-bilingual')]
    assert(save.length === 2 && save.every(button => !button.disabled), 'PDF export controls unavailable')
    const close = control(panel, 'close-main'); close.click()
    assert(original.style.width === oldWidth && original.style.visibility === oldVisibility && !doc.querySelector('.jdx-pdf-translation'), 'Closing did not restore native PDF')
    compare.click()
    await waitFor(() => doc.querySelector('.jdx-pdf-translation iframe')?.contentDocument?.querySelector('.textLayer span'), 'reopen cached PDF')
    assert(requests === translatedRequests, 'Reopening did not reuse PDF result')
    report.checks.push(config?.pdfViewerFixture ? 'pdf-export-controls-close-restore-and-fixture-reopen' : 'pdf-export-controls-close-restore-and-cache')
    const cachedPanel = doc.querySelector('.jdx-pdf-translation')
    const search = control(cachedPanel, 'find')
    search.value = '科学'; search.dispatchEvent(new reader._iframeWindow.Event('input', { bubbles: true }))
    await waitFor(() => cachedPanel.querySelector('iframe').contentDocument.querySelector('.textLayer .highlight'), 'PDF translated text search')
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'dark', true)
    await waitFor(() => cachedPanel.dataset.theme === 'dark', 'dark PDF controls')
    assert(reader._iframeWindow.getComputedStyle(cachedPanel.querySelector('.jdx-pdf-translation-toolbar')).backgroundColor !== 'rgb(255, 255, 255)', 'Dark toolbar stayed white')
    await screenshot('pdf-translation-dark')
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
    report.checks.push('pdf-search-and-theme')
    const separate = await Zotero.Reader.open(reader.itemID, undefined, { openInWindow: true, allowDuplicate: true })
    await separate._initPromise
    await separate._internalReader._primaryView.initializedPromise
    const separateDoc = separate._iframeWindow.document
    const separateButton = await waitFor(() => separateDoc.querySelector('[data-jadense-pdf-mode="compare"]'), 'independent PDF toolbar')
    separateButton.click()
    await waitFor(() => separateDoc.querySelector('.jdx-pdf-translation iframe')?.contentDocument?.querySelector('.textLayer span'), 'independent translated reader')
    separate._window.resizeTo(680, 600)
    await new Promise(resolve => main.setTimeout(resolve, 300))
    const separatePanel = separateDoc.querySelector('.jdx-pdf-translation')
    separatePanel.style.maxWidth = '640px'
    await waitFor(() => separatePanel.getBoundingClientRect().width <= 640, 'independent constrained controls')
    const bounds = separatePanel.getBoundingClientRect()
    assert([...separatePanel.querySelector('.jdx-pdf-translation-toolbar').querySelectorAll('button')].filter(button => !button.hidden).every(button => { const rect = button.getBoundingClientRect(); return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 }), 'Narrow PDF controls overflow')
    await screenshot('pdf-translation-independent-narrow', separate._iframeWindow)
    const separateMultiScreen = control(separatePanel, 'multi-screen')
    separateMultiScreen.click()
    const companion = await waitFor(() => [...globalThis.Services.wm.getEnumerator(null)].find(window => window.document.getElementById('translation-host')?.contentDocument?.querySelector('.jdx-pdf-translation iframe')?.contentDocument?.querySelector('.textLayer span')), 'independent source multi-screen window')
    separate._window.close()
    await waitFor(() => companion.closed, 'source close cleans up translated window')
    assert(requests === translatedRequests, 'Independent window repeated translation')
    report.checks.push('pdf-independent-window-narrow-layout-and-source-close-cleanup')
    Zotero.Prefs.set('extensions.jadenseInZotero.pdfSmokeAttachment', reader.itemID, true)
    // 测试宿主随即强制结束进程，显式落盘，避免 Gecko 的延迟偏好写入丢失。
    globalThis.Services.prefs.savePrefFile(null)
  } finally { main.fetch = previous }
}

/** 冷启动只读取同一物理附件缓存；不安装、不请求 Provider。 */
export async function verifyPDFTranslationRestart({ Zotero, waitFor, assert, report }) {
  const main = Zotero.getMainWindow(), previous = main.fetch
  let requests = 0
  main.fetch = async (url, options) => {
    if (String(url).startsWith('https://translate.google.com/') || /\/api\/chat(?:\/|$)/u.test(String(url))) { requests++; throw new Error('Restart must use cached PDF') }
    return previous.call(main, url, options)
  }
  try {
    const reader = await Zotero.Reader.open(Zotero.Prefs.get('extensions.jadenseInZotero.pdfSmokeAttachment', true))
    await reader._initPromise; await reader._internalReader._primaryView.initializedPromise
    const doc = reader._iframeWindow.document
    const button = await waitFor(() => doc.querySelector('[data-jadense-pdf-mode="compare"]'), 'restored PDF toolbar')
    button.click()
    await waitFor(() => doc.querySelector('.jdx-pdf-translation iframe')?.contentDocument?.querySelector('.textLayer span'), 'restored translated PDF')
    assert(requests === 0, 'Cold restart dispatched translation')
    report.checks.push('pdf-cold-restart-artifact-reuse')
  } finally { main.fetch = previous }
}
