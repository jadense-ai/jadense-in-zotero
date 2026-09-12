/** 隔离真实 Zotero/XPI 验收：合成已提取成果，操作真实侧栏、文献聚合及翻译接口。 */
export async function verifyLiteratureWorkspace({ Zotero, reader, jobs, assert, waitFor, screenshot, report, findManager }) {
  const main = Zotero.getMainWindow(), doc = main.document, attachment = Zotero.Items.get(reader.itemID), parent = attachment.parentItem
  const source = { itemID: attachment.id, itemKey: attachment.key, libraryID: attachment.libraryID, title: parent.getField('title'), literature: { itemID: parent.id, itemKey: parent.key, libraryID: parent.libraryID, title: parent.getField('title') } }
  Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown', true)
  const extractionID = '20000000-0000-4000-8000-000000000001'
  const png = 'data:image/png;base64,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'
  const markdown = '# SOURCE_MARKDOWN\n\nScientific evidence from the original PDF.\n\n![Figure](jdx-asset:image-0)\n\n| Method | Result |\n| --- | --- |\n| Test | 42 |'
  const pages = [{ pageIndex: 0, pageLabel: '1', lines: [], paragraphs: [{ id: 'block-1', text: markdown, pageIndex: 0, pageLabel: '1', rects: [[40, 40, 400, 100]], lineIDs: [] }] }]
  await jobs.store.save({ version: 1, id: extractionID, kind: 'extraction', source, createdAt: new Date().toISOString(), status: 'complete', totalPages: 1, completed: 1, total: 1, models: [], warnings: [] })
  await jobs.store.saveExtraction(extractionID, { version: 1, markdown, pages, assets: ['image-0'] })
  await jobs.store.saveAsset(extractionID, 'image-0', png)
  const sibling = await Zotero.Attachments.importFromFile({ file: await attachment.getFilePathAsync(), parentItemID: parent.id, contentType: 'application/pdf' }); sibling.setField('title', 'Supplementary PDF'); await sibling.saveTx()
  Zotero.Prefs.set('extensions.jadenseInZotero.translationHistory', JSON.stringify({ version: 1, records: [
    { id: 'selection-main', createdAt: new Date().toISOString(), source: { ...source, text: 'CURRENT_PDF_SELECTION', pageIndex: 0 }, result: { text: '当前附件译文', sourceLanguage: 'en', targetLanguage: 'zh-CN' } },
    { id: 'selection-sibling', createdAt: new Date().toISOString(), source: { ...source, itemID: sibling.id, itemKey: sibling.key, text: 'SIBLING_PDF_ONLY' }, result: { text: '其他附件译文', sourceLanguage: 'en', targetLanguage: 'zh-CN' } },
  ] }))
  Zotero.Prefs.set('extensions.jadenseInZotero.paperAnalysisHistory', JSON.stringify({ version: 1, records: [{ id: 'analysis-main', createdAt: new Date().toISOString(), source: { ...source, authors: ['Synthetic Author'] }, summary: 'ANALYSIS_RESULT_VISIBLE', notes: '总体概述\n保留可读解析笔记。' }] }))
  // 用真实存储构造新的生命周期实例，验证重新加载而非仅依赖任务缓存。
  jobs.dispose(); jobs = new jobs.constructor(Zotero, main.fetch.bind(main), jobs.store); Zotero.__jadenseDocumentJobs = jobs; await jobs.ready
  main.Zotero_Tabs.select(reader.tabID)
  reader._iframeWindow.document.querySelector('[data-jadense-action="fullTranslate"]').click()
  const root = await waitFor(() => doc.querySelector(`.jdx-reader-workspace[data-reader-item="${reader.itemID}"]`), 'literature sidebar')
  const choose = async label => {
    root.querySelector('.jdx-reader-header-left button').click()
    const option = await waitFor(() => [...doc.querySelectorAll('[role="option"]')].find(row => row.getBoundingClientRect().height > 0 && row.textContent.includes(label)), `sidebar option ${label}`)
    option.click(); await Zotero.Promise.delay(120)
  }
  const isEnglish = root.textContent.includes('Full translation'), labels = isEnglish ? ['Chat', 'Full Markdown', 'Full translation', 'Selection translations', 'Summary', 'Analysis notes', 'References'] : ['对话', '全文 Markdown', '全文翻译', '选中翻译历史', '解析总结', '解析笔记', '参考文献']
  root.querySelector('.jdx-reader-header-left button').click()
  assert(labels.every(label => [...doc.querySelectorAll('[role="option"]')].some(row => row.textContent.includes(label))), 'Seven sidebar pages missing')
  root.querySelector('.jdx-reader-header-left button').click()
  await choose(labels[1])
  await waitFor(() => root.querySelector('.jdx-reader-workspace-content:not([hidden]) .jdx-reading-block')?.textContent.includes('SOURCE_MARKDOWN'), 'rendered source Markdown')
  await waitFor(() => root.querySelector('.jdx-reader-workspace-content:not([hidden]) img')?.naturalWidth > 0, 'loaded local figure')
  assert(jobs.list('translation').length === 0, 'Browsing source started translation')
  const sourceTools = root.querySelector('.jdx-reader-workspace-content:not([hidden]) .jdx-result-tools')
  assert(sourceTools.querySelector('.jdx-result-workbench').getBoundingClientRect().left - sourceTools.getBoundingClientRect().left <= 14, 'Markdown actions not left aligned')
  await Zotero.Promise.delay(150)
  const sourceActionBounds = sourceTools.querySelector('.jdx-result-workbench').getBoundingClientRect(), sourceToolsBounds = sourceTools.getBoundingClientRect()
  assert(sourceActionBounds.width >= 30 && sourceActionBounds.left >= sourceToolsBounds.left && sourceActionBounds.right <= sourceToolsBounds.right, `Source actions outside toolbar: ${JSON.stringify({ action: sourceActionBounds.toJSON(), tools: sourceToolsBounds.toJSON() })}`)
  await screenshot('literature-sidebar-source', main)
  await choose(labels[3])
  const currentPanel = () => root.querySelector('.jdx-reader-workspace-content:not([hidden])')
  await waitFor(() => currentPanel()?.textContent.includes('CURRENT_PDF_SELECTION'), 'current PDF history')
  assert(!currentPanel().textContent.includes('SIBLING_PDF_ONLY'), 'Sibling history leaked into current PDF')
  const disclosure = currentPanel().querySelector('.jdx-selection-toggle'); assert(disclosure, 'Custom selection disclosure missing'); disclosure.click(); assert(disclosure.getAttribute('aria-expanded') === 'true', 'Selection disclosure did not expand'); await screenshot('literature-sidebar-selection', main)
  await choose(labels[4]); await waitFor(() => currentPanel()?.textContent.includes('ANALYSIS_RESULT_VISIBLE'), 'sidebar analysis')
  for (const [index, tab] of [[4, 'summary'], [5, 'notes'], [6, 'references']]) {
    await choose(labels[index])
    await waitFor(() => currentPanel()?.querySelector('.jdx-detail-tabs')?.hidden, `flat reader ${tab}`)
    const panel = currentPanel(), tools = panel.querySelector('.jdx-result-tools'), first = tools.querySelector('.jdx-result-workbench')
    assert(first.getBoundingClientRect().left - tools.getBoundingClientRect().left <= 14, 'Reader action is not left aligned')
    assert(!panel.querySelector(`.jdx-detail-panel[id$="-${tab}"]`).hidden, `Reader content mismatch: ${tab}`)
  }
  await choose(labels[4])
  await screenshot('literature-sidebar-analysis', main)
  await choose(labels[0]); assert(root.querySelector('.jadense-reader-chat') || !root.querySelector('.jdx-reader-workspace-content').hidden, 'Chat unreachable')
  await choose(labels[1])
  const translate = [...currentPanel().querySelectorAll('button')].find(button => /^(全文翻译|Translate full text)$/u.test(button.textContent.trim()))
  assert(translate && !translate.disabled, 'Explicit translation action unavailable'); translate.click()
  const translation = await waitFor(() => jobs.list('translation')[0], 'explicit Markdown translation')
  await waitFor(() => { if (translation.status === 'error') throw new Error(translation.error); return translation.status === 'complete' }, 'Markdown translation completion')
  assert(translation.extractionID === extractionID, 'Translation lost source version')
  await waitFor(() => currentPanel()?.textContent.includes('OCR_STREAM'), 'sidebar translation')
  await screenshot('literature-sidebar-translation', main)
  // 仅改变隔离夹具投影，覆盖运行提示外观，不发起新的翻译请求。
  const readerView = currentPanel().querySelector('.jdx-translation-reader')
  assert(!readerView.querySelector('details,summary,select,progress'), 'Native result controls remain')
  const typography = [...readerView.querySelectorAll('button')].find(button => button.textContent === 'Aa')
  typography.click(); assert(typography.getAttribute('aria-expanded') === 'true', 'Custom menu did not open')
  typography.dispatchEvent(new main.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert(typography.getAttribute('aria-expanded') === 'false', 'Custom menu Escape did not close')
  assert(!readerView.querySelector('.jdx-reading-state').textContent, 'Translation completion banner persists')
  const originalState = { status: translation.status, error: translation.error, storageWarning: translation.storageWarning, completed: translation.completed }
  for (const state of ['running', 'paused', 'partial', 'error', 'unsaved']) {
    Object.assign(translation, originalState, { status: state === 'unsaved' ? 'complete' : state, error: state === 'error' ? (isEnglish ? 'Translation service unavailable. Completed text is preserved.' : '翻译服务暂不可用，已完成的正文已保留。') : undefined, storageWarning: state === 'unsaved', completed: state === 'unsaved' ? originalState.completed : 0 })
    jobs.emit(); await Zotero.Promise.delay(180)
    const footer = readerView.querySelector('.jdx-reading-footer')
    assert(footer.dataset.state === (state === 'unsaved' ? 'error' : state), `Incorrect runtime state: ${state}`)
    if (state === 'unsaved') assert([...footer.querySelectorAll('button')].some(button => /复制全文|Copy all/u.test(button.textContent)), 'Unsaved result needs direct copy action')
    assert(footer.getBoundingClientRect().bottom <= main.innerHeight + 2, 'Runtime actions outside viewport')
    await screenshot(`literature-status-${state}`, main)
  }
  Object.assign(translation, originalState); jobs.emit(); await Zotero.Promise.delay(120)
  report.checks.push('custom-disclosure-and-menu', 'runtime-running-paused-partial-error-unsaved')

  const workbench = [...currentPanel().querySelectorAll('button')].find(button => /^(在工作台查看|Open in workbench)$/u.test(button.textContent.trim()))
  assert(workbench, 'Workbench deep link unavailable'); workbench.click()
  const manager = await waitFor(() => findManager()?.document.querySelector('.jdx-literature-detail:not([hidden])') && findManager(), 'unified paper detail')
  const md = manager.document
  const dismiss = md.getElementById('jadense-quick-start-close'); dismiss?.click()
  await Zotero.Promise.delay(150)
  assert(md.getElementById('jadense-manager-nav-translations').getBoundingClientRect().width === 0, 'Standalone translation navigation remains')
  await waitFor(() => md.querySelector('.jdx-literature-panel:not([hidden])')?.textContent.includes('OCR_STREAM'), 'deep-linked translation')
  // 在真实宿主测量 panel 边距、空操作栏和展开后的解析入口。
  const detail = md.querySelector('.jdx-literature-detail'), section = detail.closest('.jdx-analysis-section')
  const bounds = detail.getBoundingClientRect(), outer = section.getBoundingClientRect()
  assert(bounds.left - outer.left <= 14 && outer.right - bounds.right <= 14, 'Paper detail retains wide gutters')
  md.getElementById('jdx-literature-tab-source').click()
  await waitFor(() => md.querySelector('.jdx-literature-panel:not([hidden]) .jdx-reading-block'), 'workbench source')
  const sourcePanel = md.querySelector('.jdx-literature-panel:not([hidden])')
  assert(![...sourcePanel.querySelectorAll(':scope > .jdx-notice')].some(node => node.textContent.includes(isEnglish ? 'Complete' : '已完成')), 'Saved completion status persists')
  assert(manager.getComputedStyle(sourcePanel.querySelector('.jdx-result-tools')).backgroundColor === 'rgba(0, 0, 0, 0)', 'Source toolbar has a separate fill')
  const capsule = sourcePanel.querySelector('.jdx-translation-capsule')
  assert(capsule && capsule.firstElementChild.classList.contains('jdx-result-language') && capsule.lastElementChild.textContent === (isEnglish ? 'Translate full text' : '全文翻译'), 'Translation capsule order')
  const iconActions = sourcePanel.querySelectorAll('.jdx-result-tools > button')
  assert(iconActions.length >= 2 && [...iconActions].every(button => button.classList.contains('jdx-icon-action') && button.title && button.getAttribute('aria-label') === button.title), 'Source actions lack icons/tooltips')
  assert(manager.getComputedStyle(capsule).borderRadius === '999px', 'Translation capsule is not rounded')
  const languageBounds = capsule.firstElementChild.getBoundingClientRect(), translateBounds = capsule.lastElementChild.getBoundingClientRect()
  assert(Math.abs(languageBounds.right - translateBounds.left) < 2, 'Translation capsule has a gap')
  await screenshot('literature-workbench-source', manager)
  md.getElementById('jdx-literature-tab-selection').click()
  await waitFor(() => md.querySelector('.jdx-literature-panel:not([hidden]) .jdx-result-tools')?.hidden, 'empty toolbar hidden')
  for (const tab of ['summary', 'notes', 'references']) {
    md.getElementById(`jdx-literature-tab-${tab}`).click()
    await waitFor(() => md.querySelector('.jdx-literature-panel:not([hidden]) .jdx-analysis-detail:not([hidden])'), `flat ${tab}`)
    const panel = md.querySelector('.jdx-literature-panel:not([hidden])')
    assert(panel.querySelector('.jdx-detail-tabs').hidden, 'Nested analysis tabs remain')
    assert(!panel.querySelector(`.jdx-detail-panel[id$="-${tab}"]`).hidden, `Incorrect analysis content: ${tab}`)
    await screenshot(`literature-workbench-${tab}`, manager)
  }
  report.checks.push('panel-gutters', 'transparent-source-toolbar', 'empty-toolbar-hidden', 'flat-analysis-tabs', 'no-saved-completion-banner')
  // 详情状态会保留；切换主页面后同时核对 hidden 与实际布局，防止 CSS 将旧页重新显示。
  for (const name of ['settings', 'chat', 'migrate']) {
    md.getElementById(`jadense-manager-nav-${name}`).click()
    const analysis = md.getElementById('jadense-manager-section-analysis')
    assert(analysis.hidden && manager.getComputedStyle(analysis).display === 'none' && analysis.getBoundingClientRect().height === 0, `Analysis detail leaks into ${name}`)
    assert([...md.querySelectorAll('.jdx-manager-section')].filter(section => manager.getComputedStyle(section).display !== 'none').length === 1, `Multiple manager pages visible in ${name}`)
  }
  md.getElementById('jadense-manager-nav-analysis').click()
  assert(!md.getElementById('jadense-manager-section-analysis').hidden, 'Analysis detail cannot reopen')
  report.checks.push('manager-detail-navigation-isolation')
  const historyTab = md.getElementById('jdx-literature-tab-history'); historyTab.click()
  await waitFor(() => md.querySelector('.jdx-literature-panel:not([hidden])')?.textContent.includes('SIBLING_PDF_ONLY'), 'all attachments in paper history')
  for (const width of [1360, 760]) {
    manager.resizeTo(width, 860); await Zotero.Promise.delay(150)
    for (const theme of ['light', 'dark']) {
      Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true); await Zotero.Promise.delay(120)
      const activeTab = md.querySelector('.jdx-literature-detail [role=tab][aria-selected=true]'), tabBounds = activeTab.getBoundingClientRect(), trackBounds = activeTab.parentElement.getBoundingClientRect()
      assert(tabBounds.left >= trackBounds.left - 2 && tabBounds.right <= trackBounds.right + 2, `Active result tab outside viewport: ${JSON.stringify({tab: [tabBounds.left, tabBounds.right], track:[trackBounds.left, trackBounds.right], scroll:activeTab.parentElement.scrollLeft, width:activeTab.parentElement.scrollWidth, overflow:manager.getComputedStyle(activeTab.parentElement).overflowX})}`)
      assert(md.documentElement.scrollWidth <= manager.innerWidth + 2, 'Paper workbench overflows viewport')
      await screenshot(`literature-workbench-${width}-${theme}`, manager)
    }
  }
  const back = [...md.querySelectorAll('.jdx-literature-detail button')].find(button => /← (文献列表|Papers)/u.test(button.textContent)); back.click()
  assert(md.querySelectorAll('#jadense-analysis-history .jdx-analysis-list>.jdx-analysis-record').length === 1, 'Same parent was not grouped into one paper')
  await screenshot('literature-paper-list', manager)
  const siblingReader = await Zotero.Reader.open(sibling.id); await siblingReader._initPromise; await siblingReader._internalReader._primaryView.initializedPromise
  const siblingTrigger = await waitFor(() => siblingReader._iframeWindow.document.querySelector('[data-jadense-action="fullTranslate"]'), 'sibling Reader toolbar')
  siblingTrigger.click()
  const siblingRoot = await waitFor(() => doc.querySelector(`.jdx-reader-workspace[data-reader-item="${sibling.id}"]`), 'sibling sidebar binding')
  const switchSibling = async label => {
    siblingRoot.querySelector('.jdx-reader-header-left button').click()
    const option = await waitFor(() => [...doc.querySelectorAll('[role="option"]')].find(row => row.getBoundingClientRect().height > 0 && row.textContent.includes(label)), 'sibling option')
    option.click()
  }
  await switchSibling(labels[3])
  const siblingPanel = () => siblingRoot.querySelector('.jdx-reader-workspace-content:not([hidden])')
  await waitFor(() => siblingPanel()?.textContent.includes('SIBLING_PDF_ONLY'), 'sibling selection history')
  assert(!siblingPanel().textContent.includes('CURRENT_PDF_SELECTION'), 'Primary PDF leaked after switching PDF')
  await switchSibling(labels[2])
  const translateWithoutSource = await waitFor(() => siblingPanel()?.querySelector('.jdx-translation-capsule .jdx-button-primary'), 'translation without source')
  assert(!translateWithoutSource.disabled, 'Missing Markdown disabled full translation')
  assert(!siblingPanel().textContent.includes(isEnglish ? 'Extract the source in Full Markdown' : '请先在'), 'Translation still requires a manual extraction step')
  assert(!jobs.list('extraction').some(task => task.source.itemID === sibling.id), 'Browsing translation started OCR')
  await screenshot('literature-translation-without-source', main)
  report.checks.push('translation-enabled-without-source', 'translation-browse-no-ocr')
  await switchSibling(labels[1])
  await waitFor(() => siblingPanel()?.textContent.includes(isEnglish ? 'Extract the source' : '先提取原文'), 'empty source page')
  assert(!jobs.list('extraction').some(task => task.source.itemID === sibling.id), 'Empty source view started OCR')
  await screenshot('literature-sibling-empty', main)
  report.checks.push('switch-pdf-history-isolation', 'empty-source-no-dispatch')
  report.checks.push('seven-sidebar-pages', 'source-markdown-local-images', 'no-translation-on-browse', 'current-pdf-isolation', 'analysis-sidebar', 'all-chat-reachable', 'explicit-markdown-translation', 'fixed-extraction-version', 'workbench-deep-link', 'paper-history-all-attachments', 'parent-paper-grouping', 'compact-light-dark-workbench')
}
