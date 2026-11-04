/** 真实 Zotero 中的溯源专项；仅用隔离 profile、合成 PDF 与本地模型服务。 */
export async function verifyEvidence({ Zotero, reader, manager, assert, waitFor, screenshot, report }) {
  const main = Zotero.getMainWindow(), state = () => JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState') || '{"sessions":[]}')
  const openSources = (message, win) => {
    const trigger = message.querySelector('.jdx-chat-message-actions [data-evidence-sources-toggle]')
    assert(trigger && !message.querySelector('.jdx-evidence-source-list'), 'Sources must only have an action-bar trigger')
    trigger.scrollIntoView({ block: 'center' }); trigger.click()
    const panel = win.document.querySelector('.jdx-evidence-sources')
    assert(panel && !message.contains(panel) && panel.getAttribute('role') === 'dialog', 'Sources are not in an independent portal')
    const bounds = panel.getBoundingClientRect()
    assert(bounds.left >= 0 && bounds.right <= win.innerWidth && bounds.top >= 0 && bounds.bottom <= win.innerHeight, 'Source panel escaped viewport')
    return panel
  }
  // 复现实际鼠标事件顺序：离开引用/卡片后，普通正文的 mouseover 不能取消延迟关闭。
  const verifyPreviewLifecycle = async (citation, win) => {
    const doc = win.document, prose = citation.closest('.jdx-chat-message-body'), preview = () => doc.querySelector('.jdx-evidence-preview')
    const hover = () => { citation.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); assert(preview(), 'Citation preview did not reopen') }
    hover()
    citation.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: prose }))
    prose.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: citation }))
    await Zotero.Promise.delay(250)
    assert(!preview(), 'Hover preview remained after moving to message text')
    hover()
    const card = preview()
    citation.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: card }))
    card.dispatchEvent(new win.MouseEvent('mouseenter'))
    await Zotero.Promise.delay(250)
    assert(preview() === card, 'Preview closed while reading the excerpt')
    card.dispatchEvent(new win.MouseEvent('mouseleave', { relatedTarget: prose }))
    prose.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: card }))
    await Zotero.Promise.delay(250)
    assert(!preview(), 'Preview remained after leaving the excerpt')
    hover()
    prose.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }))
    assert(!preview() && !citation.hasAttribute('aria-describedby'), 'Outside pointer input did not clean up hover preview')
  }
  const toggle = manager.document.querySelector('[data-chat-evidence-toggle]')
  assert(toggle?.getAttribute('aria-pressed') === 'false', 'Evidence should default off')
  toggle.click()
  reader._iframeWindow.document.querySelector('[data-jadense-action="attach"]').click()
  const chat = await waitFor(() => main.document.querySelector('.jdx-reader-chat'), 'Reader Chat')
  const readerToggle = chat.querySelector('[data-chat-evidence-toggle]')
  assert(readerToggle.getAttribute('aria-pressed') === 'true', 'Reader did not restore the preference')
  const input = chat.querySelector('textarea')
  input.value = 'SYNTHETIC_EVIDENCE_QUESTION 请概括这篇论文的主要发现，并提供原文证据。'
  input.dispatchEvent(new main.Event('input', { bubbles: true }))
  await waitFor(() => !chat.querySelector('[id$="-chat-send"]').disabled, 'Evidence send ready')
  chat.querySelector('form').requestSubmit()
  const session = await waitFor(() => state().sessions.find(row => row.messages.some(message => message.role === 'assistant' && message.status === 'complete')), 'Cited answer')
  const answer = session.messages.at(-1), entry = answer.evidence?.entries[0]
  assert(entry && entry.source.itemID === reader.itemID && entry.rects.length, 'Evidence lost native identity or rectangles')
  const button = await waitFor(() => chat.querySelector('[data-evidence-id]'), 'Inline citation')
  assert(button.textContent === '1', 'Inline citation contains page metadata')
  assert(!main.document.querySelector('.jdx-evidence-sources'), 'Source list rendered before opening')
  const initialPanel = openSources(button.closest('.jdx-chat-message'), main), source = initialPanel.querySelector('.jdx-evidence-source')
  assert(source?.textContent.includes(entry.source.title) && source.dataset.evidenceNumber === '1', 'Dedicated source title missing')
  initialPanel.querySelector('.jdx-evidence-sources-close').click()
  main.focus(); button.scrollIntoView({ block: 'center' })
  await Zotero.Promise.delay(100)
  button.focus()
  button.dispatchEvent(new main.MouseEvent('mouseover', { bubbles: true }))
  await Zotero.Promise.delay(300)
  const liveButton = chat.querySelector('[data-evidence-id]')
  liveButton.dispatchEvent(new main.MouseEvent('mouseover', { bubbles: true }))
  report.evidencePreviewProbe = { button: liveButton.outerHTML, connected: liveButton.isConnected, same: liveButton === button,
    quote: entry.quote, preview: main.document.querySelector('.jdx-evidence-preview')?.outerHTML, active: main.document.activeElement?.outerHTML?.slice(0, 500) }
  assert(main.document.querySelector('.jdx-evidence-preview')?.textContent.includes(entry.quote), 'Original quote preview unavailable')
  await verifyPreviewLifecycle(button, main)
  // 真实焦点转入嵌套 PDF frame，不能依赖主文档接收到 frame 内的 pointerdown。
  main.focus(); button.focus()
  button.dispatchEvent(new main.MouseEvent('mouseover', { bubbles: true }))
  reader._internalReader._primaryView._iframeWindow.focus()
  await waitFor(() => !main.document.querySelector('.jdx-evidence-preview'), 'Reader preview closed on PDF frame focus')
  main.focus()
  openSources(button.closest('.jdx-chat-message'), main)
  reader._internalReader._primaryView._iframeWindow.focus()
  await waitFor(() => !main.document.querySelector('.jdx-evidence-sources'), 'Reader source list closed on PDF frame focus')
  main.focus()
  await reader.navigate({ pageIndex: 1 })
  button.click()
  await waitFor(() => !button.hasAttribute('aria-busy'), 'Citation navigation')
  assert(chat.querySelector('[id$="-chat-status"]').dataset.state === 'success', 'Citation navigation failed')
  const pdfView = reader._internalReader._primaryView
  // 查看真实 Reader 当前页和临时高亮，绝不拦截或模拟 navigate。
  assert(pdfView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === entry.pageIndex + 1, 'Citation opened the wrong physical page')
  report.evidenceNavigation = { pageIndex: entry.pageIndex, rectCount: entry.rects.length, nativeHighlight: JSON.stringify(pdfView._highlightedPosition ?? null) }
  assert(pdfView._highlightedPosition?.rects?.length === entry.rects.length, 'Native passage highlight missing')
  await screenshot('evidence-pdf-target', reader._iframeWindow)
  manager.document.querySelector(`[data-session-id="${session.id}"]`).click()
  await waitFor(() => manager.document.querySelector('[data-evidence-id]'), 'Manager citation')
  const previous = manager.document; manager.location.reload()
  await waitFor(() => manager.document !== previous && manager.document.querySelector('[data-evidence-id]'), 'Citations after reload')
  assert(manager.document.querySelector('[data-chat-evidence-toggle]').getAttribute('aria-pressed') === 'true', 'Reload lost preference')
  await verifyPreviewLifecycle(manager.document.querySelector('[data-evidence-id]'), manager)
  // 为原生阅读器和侧栏同时留出可用宽度；只调整宿主侧栏，不伪造插件内部尺寸。
  main.resizeTo(1360 + main.outerWidth - main.innerWidth, 760 + main.outerHeight - main.innerHeight)
  await Zotero.Promise.delay(300)
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    manager.resizeTo(1080, 760); manager.focus()
    const details = manager.document.getElementById('jadense-chat-details-toggle')
    if (details?.getAttribute('aria-expanded') === 'true') details.click()
    await Zotero.Promise.delay(200)
    const citation = manager.document.querySelector('[data-evidence-id]')
    citation.scrollIntoView({ block: 'center' }); citation.focus()
    citation.dispatchEvent(new manager.MouseEvent('mouseover', { bubbles: true }))
    await Zotero.Promise.delay(100)
    const preview = manager.document.querySelector('[role="tooltip"]')
    assert(preview && preview.getBoundingClientRect().right <= manager.innerWidth && preview.getBoundingClientRect().left >= 0, 'Preview escaped Manager viewport')
    await screenshot(`evidence-manager-${theme}`, manager)
    citation.dispatchEvent(new manager.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert(!manager.document.querySelector('.jdx-evidence-preview'), 'Escape did not dismiss preview')
    const sourcePanel = openSources(citation.closest('.jdx-chat-message'), manager)
    await screenshot(`evidence-manager-sources-${theme}`, manager)
    sourcePanel.querySelector('.jdx-evidence-sources-close').click()
    const root = chat.closest('.jdx-reader-workspace'), native = root.closest('context-pane'), outer = native?.closest('#zotero-context-pane') ?? native
    for (const width of [440, 320, 260]) {
      if (outer) { outer.style.width = `${width}px`; outer.setAttribute('width', String(width)) }
      await Zotero.Promise.delay(200)
      const send = chat.querySelector('[id$="-chat-send"]'), bounds = root.getBoundingClientRect()
      assert(send.getBoundingClientRect().right <= bounds.right + 2 && root.scrollWidth <= root.clientWidth + 2, `Evidence composer overflow at ${width}`)
      const ancestors = []; let ancestor = root
      while (ancestor && ancestors.length < 20) { ancestors.push({ name: ancestor.localName, id: ancestor.id, bounds: ancestor.getBoundingClientRect().toJSON() }); ancestor = ancestor.parentElement }
      const visibleRight = Math.min(main.innerWidth, ...ancestors.filter(row => row.bounds.width > 0).map(row => row.bounds.right))
      assert(bounds.right <= visibleRight + 2, `Evidence sidebar escaped its native viewport: ${JSON.stringify(ancestors)}`)
      ;(report.evidenceLayouts ??= []).push({ theme, requestedWidth: width, actualWidth: bounds.width })
      const citation = chat.querySelector('[data-evidence-id]'); citation.scrollIntoView({ block: 'center' }); citation.focus()
      citation.dispatchEvent(new main.MouseEvent('mouseover', { bubbles: true }))
      const previewBounds = main.document.querySelector('.jdx-evidence-preview').getBoundingClientRect()
      assert(previewBounds.right <= main.innerWidth && previewBounds.left >= 0 && previewBounds.bottom <= main.innerHeight, 'Reader preview escaped the viewport')
      await screenshot(`evidence-reader-${theme}-${width}`, main)
      citation.dispatchEvent(new main.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
  }
  Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', '150', true)
  manager.resizeTo(760, 650)
  await Zotero.Promise.delay(200)
  for (const [win, root, name] of [[manager, manager.document.getElementById('jadense-chat-dock'), 'manager'], [main, chat, 'reader']]) {
    const bounds = root.getBoundingClientRect(), send = root.querySelector('[id$="-chat-send"]')
    assert(root.scrollWidth <= root.clientWidth + 2 && send.getBoundingClientRect().right <= bounds.right + 2, 'Scaled composer overflow')
    await screenshot(`evidence-${name}-150`, win)
  }
  // 修改的是隔离 fixture 的可选历史版本信息；复用真实点击路径确认不会误跳。
  const saved = state(), message = saved.sessions.find(row => row.id === session.id).messages.at(-1)
  message.evidence.entries[0].source.modificationTime = -1
  Zotero.Prefs.set('extensions.jadenseInZotero.localChatState', JSON.stringify(saved))
  Zotero.__jadenseChatRuntime.changed()
  await Zotero.Promise.delay(200)
  manager.document.querySelector('[data-evidence-id]').click()
  await waitFor(() => manager.document.getElementById('jadense-chat-status').dataset.state === 'error', 'Changed PDF feedback')
  assert(manager.document.querySelector('.jdx-chat-message-body').textContent, 'Invalid source erased the message')
  // 两个真实附件都引用第一页，验证编号、标题和导航不依赖页码或当前选中文献。
  const paper = new Zotero.Item('journalArticle')
  paper.libraryID = Zotero.Libraries.userLibraryID
  const longTitle = 'A second independent paper with the same page labels: reproducible measurements and comparative evidence across multiple experimental conditions'
  paper.setField('title', longTitle); await paper.saveTx()
  const second = await Zotero.Attachments.importFromFile({ file: await Zotero.Items.get(reader.itemID).getFilePathAsync(), parentItemID: paper.id, contentType: 'application/pdf' })
  await Zotero.__jadenseChatRuntime.associate(session.id, second.id)
  Zotero.Prefs.set('extensions.jadenseInZotero.fontScale', '100', true)
  Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
  main.Zotero_Tabs.select(reader.tabID)
  input.value = 'SYNTHETIC_EVIDENCE_QUESTION 请比较这两篇文献，并分别引用原文。'
  input.dispatchEvent(new main.Event('input', { bubbles: true })); chat.querySelector('form').requestSubmit()
  const comparison = await waitFor(() => {
    const last = state().sessions.find(row => row.id === session.id).messages.at(-1)
    return last.id !== answer.id && last.role === 'assistant' && last.status === 'complete' && last
  }, 'Two-PDF answer')
  const compareBody = chat.querySelector(`[data-message-id="${comparison.id}"]`)
  const inline = [...compareBody.querySelectorAll('.jdx-chat-message-body [data-evidence-id]')]
  assert(inline.map(node => node.textContent).join(',') === '1,2,1', 'Citation numbers do not follow first appearance')
  let sourcePanel = openSources(compareBody, main)
  const sourceRows = [...sourcePanel.querySelectorAll('.jdx-evidence-source')]
  assert(sourceRows.length === 2 && sourceRows.some(row => row.title === longTitle), 'Two-PDF source titles missing')
  sourcePanel.querySelector('.jdx-evidence-sources-close').click()
  for (const savedRow of sourceRows) {
    main.Zotero_Tabs.select(reader.tabID)
    await Zotero.Promise.delay(200)
    sourcePanel = openSources(compareBody, main)
    const row = sourcePanel.querySelector(`[data-evidence-id="${savedRow.dataset.evidenceId}"]`)
    const target = comparison.evidence.entries.find(entry => entry.id === row.dataset.evidenceId)
    row.click(); await waitFor(() => !row.hasAttribute('aria-busy'), 'Source row navigation')
    const native = Zotero.Reader._readers.find(value => value.itemID === target.source.itemID)
    assert(native?._internalReader._primaryView._highlightedPosition?.pageIndex === target.pageIndex, 'Source row opened the wrong PDF')
  }
  main.Zotero_Tabs.select(reader.tabID)
  manager.resizeTo(1080, 760)
  manager.document.querySelector(`[data-session-id="${session.id}"]`).click()
  await Zotero.Promise.delay(200)
  const managerAnswer = manager.document.querySelector(`[data-message-id="${comparison.id}"]`)
  managerAnswer.scrollIntoView({ block: 'center' })
  assert(!manager.document.querySelector('.jdx-evidence-sources'), 'Sources should be collapsed on another host')
  await screenshot('evidence-multiple-pdfs', manager)
  sourcePanel = openSources(managerAnswer, manager)
  const title = sourcePanel.querySelector('.jdx-evidence-source-title')
  assert(manager.getComputedStyle(title).textOverflow === 'ellipsis' && title.scrollWidth > title.clientWidth, 'Source title does not truncate')
  await screenshot('evidence-multiple-pdfs-sources', manager)
  sourcePanel.querySelector('.jdx-evidence-sources-close').click()
  main.focus()
  await Zotero.Promise.delay(300)
  assert(chat.scrollWidth <= chat.clientWidth + 2, 'Multi-PDF sources overflow narrow sidebar')
  const parentRights = []; let finalNode = chat.parentElement
  while (finalNode) { const bounds = finalNode.getBoundingClientRect(); if (bounds.width > 0) parentRights.push(bounds.right); finalNode = finalNode.parentElement }
  const nativeRight = Math.min(main.innerWidth, ...parentRights)
  assert(chat.getBoundingClientRect().right <= nativeRight + 2, 'Chat clipped by native pane')
  const finalSend = chat.querySelector('[id$="-chat-send"]'), sendBounds = finalSend.getBoundingClientRect()
  assert(sendBounds.right <= nativeRight + 2, 'Send button clipped after cross-PDF navigation')
  let sendParent = finalSend.parentElement
  while (sendParent && sendParent !== chat) {
    assert(sendBounds.right <= sendParent.getBoundingClientRect().right + 2, `Send button clipped by ${sendParent.className}`)
    sendParent = sendParent.parentElement
  }
  await screenshot('evidence-multiple-pdfs-narrow', main)
  sourcePanel = openSources(compareBody, main)
  const narrowTitle = sourcePanel.querySelector('.jdx-evidence-source-title')
  assert(narrowTitle.scrollWidth > narrowTitle.clientWidth, 'Long source title does not truncate')
  await screenshot('evidence-multiple-pdfs-sources-narrow', main)
  main.dispatchEvent(new main.KeyboardEvent('keydown', { key: 'Escape' }))
  assert(!main.document.querySelector('.jdx-evidence-sources'), 'Escape left the source list open')
  // 合成历史只测试展示容量：24 个定位项不得增加消息正文高度，滚动归列表自身。
  const manyState = state(), manySession = manyState.sessions.find(row => row.id === session.id)
  const entries = Array.from({ length: 24 }, (_, index) => ({ ...comparison.evidence.entries[index % 2], id: `s1b${index + 1}` }))
  const many = { ...comparison, id: comparison.id + '-many', text: entries.map((entry, index) => `论断 ${index + 1} [[evidence:${entry.id}]]`).join('。'), evidence: { entries } }
  manySession.messages.push(many)
  Zotero.Prefs.set('extensions.jadenseInZotero.localChatState', JSON.stringify(manyState)); Zotero.__jadenseChatRuntime.changed()
  const manyBody = await waitFor(() => chat.querySelector(`[data-message-id="${many.id}"]`), 'Many source fixture')
  const closedHeight = manyBody.getBoundingClientRect().height
  sourcePanel = openSources(manyBody, main)
  const list = sourcePanel.querySelector('.jdx-evidence-source-list')
  assert(list.scrollHeight > list.clientHeight && main.getComputedStyle(list).overflowY === 'auto', 'Many sources did not scroll independently')
  const manyRows = [...list.querySelectorAll('.jdx-evidence-source')]
  for (let index = 0; index < manyRows.length; index++) {
    const row = manyRows[index], bounds = row.getBoundingClientRect()
    assert(row.querySelector('.jdx-evidence-source-quote').getBoundingClientRect().bottom <= bounds.bottom, 'Source text escaped its row')
    if (index) assert(manyRows[index - 1].getBoundingClientRect().bottom <= bounds.top, 'Source rows overlap')
  }
  assert(manyBody.getBoundingClientRect().height === closedHeight, 'Opening sources changed the message height')
  list.scrollTop = list.scrollHeight; await Zotero.Promise.delay(100)
  assert(main.document.querySelector('.jdx-evidence-sources') === sourcePanel, 'Scrolling sources dismissed the panel')
  await screenshot('evidence-many-sources', main)
  main.document.documentElement.dispatchEvent(new main.MouseEvent('pointerdown', { bubbles: true }))
  assert(!main.document.querySelector('.jdx-evidence-sources'), 'Outside click left the panel open')
  // 原生标签切走会保留部分 Reader DOM；浮层不能跟到文献库页面。
  manyBody.querySelector('[data-evidence-id]').dispatchEvent(new main.MouseEvent('mouseover', { bubbles: true }))
  assert(main.document.querySelector('.jdx-evidence-preview'), 'Reader preview missing before native tab switch')
  main.Zotero_Tabs.select('zotero-pane')
  await waitFor(() => !main.document.querySelector('.jdx-evidence-preview'), 'Preview removed after leaving Reader tab')
  main.Zotero_Tabs.select(reader.tabID)
  manager.document.querySelector('[data-chat-evidence-toggle]').click()
  await waitFor(() => readerToggle.getAttribute('aria-pressed') === 'false', 'Cross-view toggle sync')
  report.checks.push('evidence-live-model-projection', 'evidence-native-pdf-navigation', 'evidence-safe-preview', 'evidence-history-reload', 'evidence-stale-source-contained', 'evidence-cross-view-toggle', 'evidence-light-dark-narrow-layout', 'evidence-150-percent-layout', 'evidence-two-pdf-numbered-sources', 'evidence-on-demand-source-portal', 'evidence-many-sources-independent-scroll', 'evidence-preview-pointer-lifecycle', 'evidence-pdf-frame-dismissal', 'evidence-native-tab-dismissal')
}
