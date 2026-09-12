/** 隔离 profile 的真实 Reader 对话验收；仅点击发行 UI，合成模型请求不访问真实账号。 */
export async function verifyReaderChat({ Zotero, reader, manager, assert, waitFor, screenshot, report }) {
  const main = Zotero.getMainWindow(), doc = main.document, runtime = Zotero.__jadenseChatRuntime
  const state = () => JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState'))
  const previous = state().activeSessionId
  reader._iframeWindow.document.querySelector('[data-jadense-action="attach"]').click()
  const root = await waitFor(() => doc.querySelector(`.jdx-reader-workspace[data-reader-item="${reader.itemID}"]`), 'Reader Chat shell')
  const chat = root.querySelector('.jdx-reader-chat')
  await waitFor(() => chat.dataset.chatSession && state().sessions.find(s => s.id === chat.dataset.chatSession)?.sources.length, 'new sidebar conversation with PDF')
  const createdID = chat.dataset.chatSession
  assert(state().activeSessionId === previous, 'Sidebar changed Manager selection')
  const pick = async (host, value) => {
    host.querySelector('.jdx-select-trigger').click()
    const owner = host.ownerDocument
    const option = await waitFor(() => [...owner.querySelectorAll('.jdx-select-portal [role="option"]')].find(row => row.textContent.trim() === value), `option ${value}`)
    option.click()
  }
  const input = chat.querySelector('textarea'), sessions = root.querySelector('.jdx-reader-header-center .jdx-select')
  input.value = 'Sidebar draft'; input.dispatchEvent(new main.Event('input', { bubbles: true }))
  await pick(sessions, state().sessions.find(s => s.id === previous).title)
  assert(chat.dataset.chatSession === previous && state().sessions.find(s => s.id === previous).sources.length === 0, 'Switching associated the PDF')
  assert(chat.querySelector('.jdx-chat-association').textContent.includes('发送时将关联'), 'Missing send-time association notice')
  input.value = 'SYNTHETIC_SIDEBAR_QUESTION'; input.dispatchEvent(new main.Event('input', { bubbles: true }))
  chat.querySelector('form').requestSubmit()
  await waitFor(() => runtime.busy, 'shared Chat started')
  await pick(sessions, state().sessions.find(s => s.id === createdID).title)
  assert(input.value === 'Sidebar draft', 'Switching lost the first draft')
  await waitFor(() => !runtime.busy && state().sessions.find(s => s.id === previous)?.messages.some(m => m.role === 'assistant' && m.status === 'complete'), 'original conversation completion')
  assert(state().sessions.find(s => s.id === previous).sources.some(s => s.itemID === reader.itemID), 'Send did not associate current PDF')
  assert(state().sessions.find(s => s.id === createdID).messages.length === 0, 'Reply followed visible selection')
  await waitFor(() => manager.document.querySelector('.jdx-chat-message[data-role="assistant"]'), 'shared Manager history render')
  const taskCount = Zotero.__jadenseDocumentJobs.list('translation').length
  await pick(root.querySelector('.jdx-reader-header-left .jdx-select'), '全文翻译')
  assert(root.dataset.page === 'translation' && !root.querySelector('.jdx-reader-workspace-empty').hidden, 'Translation page missing')
  assert(Zotero.__jadenseDocumentJobs.list('translation').length === taskCount, 'Page switch started a translation')
  await pick(root.querySelector('.jdx-reader-header-left .jdx-select'), '对话')
  assert(input.value === 'Sidebar draft', 'Page switch lost draft')
  await pick(sessions, state().sessions.find(s => s.id === previous).title)
  await waitFor(() => chat.querySelector('.jdx-chat-message-body h2'), 'shared Markdown rendering')
  // 回放带真实本地页码身份的旧解析回答，覆盖共享消息样式而不调用模型或写批注。
  const analysisState = state(), attachment = Zotero.Items.get(reader.itemID)
  analysisState.sessions.find(s => s.id === previous).messages.push({
    id: 'synthetic-analysis-style', role: 'assistant', status: 'complete', createdAt: new Date().toISOString(),
    text: '文献解析（AI 辅助，请核对原文）\n\n【关键证据】第 1 页\n原句：The gas cell has a length of 5 cm.\nAI 批注：该句给出测量对象的关键参数。\n\n【关键证据】第 unknown 页\n原句：Unmapped evidence.\nAI 批注：保留无法定位的备注。',
    research: { source: { itemID: attachment.id, libraryID: attachment.libraryID, itemKey: attachment.key, title: 'Synthetic PDF' }, pages: [{ pageIndex: 0, pageLabel: '1' }] },
  })
  Zotero.Prefs.set('extensions.jadenseInZotero.localChatState', JSON.stringify(analysisState))
  await pick(sessions, state().sessions.find(s => s.id === createdID).title)
  await pick(sessions, state().sessions.find(s => s.id === previous).title)
  const analysisPage = await waitFor(() => chat.querySelector('button.jdx-analysis-page'), 'analysis page button')
  const chromeWidth = main.outerWidth - main.innerWidth, chromeHeight = main.outerHeight - main.innerHeight
  for (const theme of ['dark', 'light']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    await Zotero.Promise.delay(100)
    const pageStyle = main.getComputedStyle(analysisPage)
    assert(analysisPage.textContent.includes('1') && pageStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && pageStyle.appearance === 'none', `Analysis page native rectangle: ${pageStyle.backgroundColor}, ${pageStyle.appearance}`)
    assert(main.getComputedStyle(analysisPage.parentElement).display === 'flex', 'Analysis header shared layout missing')
    assert(chat.querySelector('span.jdx-analysis-page')?.textContent.includes('unknown'), 'Unmapped analysis page missing')
    for (const [width, height] of [[480, 600], [320, 360], [260, 280]]) {
      // 调整真实宿主，绝不缩小插件根节点后留下未覆盖的侧栏区域。
      main.resizeTo(1360 + chromeWidth, height + root.getBoundingClientRect().top + chromeHeight)
      await Zotero.Promise.delay(500)
      const native = root.closest('context-pane'), outer = native?.closest('#zotero-context-pane') ?? native
      if (outer) { outer.style.width = `${width}px`; outer.setAttribute('width', String(width)) }
      await Zotero.Promise.delay(700)
      if (width === 480) {
        analysisPage.closest('.jdx-analysis-annotation').scrollIntoView({ block: 'start' })
        await screenshot(`reader-chat-analysis-${theme}`, main)
      }
      const bounds = root.getBoundingClientRect(), send = chat.querySelector('[id$="-chat-send"]')
      const editorStyle = main.getComputedStyle(input), dock = chat.querySelector('.jdx-chat-dock')
      input.focus()
      assert(editorStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && editorStyle.color === main.getComputedStyle(root).getPropertyValue('--jdx-text').trim().replace(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i, (_, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`), 'Editor did not inherit plugin theme')
      assert(editorStyle.borderBottomWidth === '0px' && editorStyle.outlineStyle === 'none', 'Native textarea focus decoration leaked')
      assert(main.getComputedStyle(dock).backgroundColor === 'rgba(0, 0, 0, 0)' && main.getComputedStyle(dock).position === 'absolute', 'Composer dock masks the message area')
      const panel = chat.querySelector('.jdx-chat-status-panel'), field = chat.querySelector('.jdx-chat-compose-field')
      assert(panel.getBoundingClientRect().bottom > field.getBoundingClientRect().top && panel.getBoundingClientRect().height <= 36, 'Idle status is not a compact tucked panel')
      assert(root.querySelectorAll('.jdx-reader-header-right button').length === 1, 'Redundant sidebar collapse control remains')
      assert(root.scrollWidth <= root.clientWidth + 2, `Sidebar overflow at ${width} x ${height}`)
      const ancestors = []; let ancestor = root
      while (ancestor && ancestors.length < 20) { ancestors.push({ name: ancestor.localName, id: ancestor.id, className: ancestor.className, bounds: ancestor.getBoundingClientRect().toJSON(), minWidth: main.getComputedStyle(ancestor).minWidth, overflow: main.getComputedStyle(ancestor).overflow }); ancestor = ancestor.parentElement }
      report.readerChatAncestors = ancestors
      const clipping = ancestors.filter(item => item.bounds.width > 0)
      const nativeRight = Math.min(main.innerWidth, ...clipping.map(item => item.bounds.right))
      assert(bounds.right <= nativeRight + 2, `Sidebar escapes native content pane: ${JSON.stringify(ancestors)}`)
      const parentBounds = root.parentElement.getBoundingClientRect()
      const viewport = root.closest('item-details')?.querySelector('.zotero-view-item')?.getBoundingClientRect() ?? parentBounds
      const expectedBottom = Math.min(viewport.bottom, main.innerHeight)
      assert(Math.abs(bounds.width - parentBounds.width) <= 2, `Sidebar does not fill parent width: ${JSON.stringify({ bounds: bounds.toJSON(), parent: parentBounds.toJSON() })}`)
      assert(Math.abs(bounds.bottom - expectedBottom) <= 4, `Sidebar does not fill available height: ${JSON.stringify({ bounds: bounds.toJSON(), viewport: viewport.toJSON(), expectedBottom })}`)
      assert(Math.abs(chat.getBoundingClientRect().bottom - bounds.bottom) <= 2, 'Chat page does not fill shell')
      ;(report.readerChatLayouts ??= []).push({ theme, requested: [width, height], actual: [bounds.width, bounds.height], parent: [parentBounds.width, expectedBottom - bounds.top] })
      const model = chat.querySelector('.jdx-chat-model-select .jdx-select-trigger')
      assert(model?.querySelector('.jdx-select-leading-icon img'), 'Selected model icon missing')
      assert(model.querySelector('img').src.endsWith('/deepseek.svg') && model.querySelector('img').naturalWidth > 0, 'Model brand logo failed to load')
      const label = model.querySelector('.jdx-select-value')
      assert((main.getComputedStyle(label).display === 'none') === (chat.clientWidth <= 380), 'Model label did not follow container width')
      const sendBounds = send.getBoundingClientRect()
      assert(sendBounds.right <= bounds.right + 2 && sendBounds.bottom <= bounds.bottom + 2 && sendBounds.width > 0, 'Send control escaped its container')
      sessions.querySelector('.jdx-select-trigger').click()
      await Zotero.Promise.delay(100)
      if (!doc.querySelector('.jdx-select-portal .jdx-select-popup')) sessions.querySelector('.jdx-select-trigger').click()
      const popup = await waitFor(() => doc.querySelector('.jdx-select-portal .jdx-select-popup'), 'conversation popup')
      const popupBounds = popup.getBoundingClientRect()
      assert(popupBounds.right <= main.innerWidth && popupBounds.bottom <= main.innerHeight, 'Popup escaped viewport')
      await screenshot(`reader-chat-${theme}-${width}-${height}`, main)
      sessions.querySelector('.jdx-select-trigger').dispatchEvent(new main.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await screenshot(`reader-chat-messages-${theme}-${width}-${height}`, main)
    }
  }
  // 共享输入模板在工作台也验收空闲、运行和长错误；只修改隔离 fixture 的展示文字。
  const managerStatus = manager.document.getElementById('jadense-chat-status')
  const savedStatus = { text: managerStatus.textContent, kind: managerStatus.dataset.kind, busy: managerStatus.dataset.busy }
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    for (const [kind, text] of [['idle', ''], ['running', '正在分析当前文献…'], ['error', '模型请求未完成，请检查连接后重试。已生成内容与输入草稿仍然保留。'.repeat(3)]]) {
      managerStatus.textContent = text; managerStatus.dataset.kind = kind; managerStatus.dataset.busy = String(kind === 'running')
      await Zotero.Promise.delay(150)
      const panel = managerStatus.closest('.jdx-chat-status-panel'), field = manager.document.querySelector('.jdx-chat-compose-field')
      assert((manager.getComputedStyle(panel).display === 'none') === !text, 'Manager empty status takes space')
      if (text) {
        assert(panel.getBoundingClientRect().bottom > field.getBoundingClientRect().top, 'Manager status is detached from input')
        assert(panel.scrollWidth <= panel.clientWidth + 1, 'Manager status overflows horizontally')
        if (kind === 'running') assert(panel.getBoundingClientRect().height <= 36, 'Manager running status is too tall')
      }
      await screenshot(`manager-composer-${theme}-${kind}`, manager)
    }
  }
  managerStatus.textContent = savedStatus.text; managerStatus.dataset.kind = savedStatus.kind ?? ''; managerStatus.dataset.busy = savedStatus.busy ?? ''
  report.checks.push('reader-chat-analysis-page-theme-and-layout', 'manager-composer-shared-status-light-dark-idle-running-error')
  main.resizeTo(1360 + chromeWidth, 860 + chromeHeight)
  const standalone = await Zotero.Reader.open(reader.itemID, undefined, { openInWindow: true, allowDuplicate: true })
  await waitFor(() => standalone._iframeWindow?.document.querySelector('[data-jadense-action="attach"]'), 'standalone Reader tools')
  standalone._iframeWindow.document.querySelector('[data-jadense-action="attach"]').click()
  const second = await waitFor(() => standalone._window.document.querySelector('.jdx-reader-chat[data-chat-session]:not([data-chat-session=""])'), 'standalone conversation')
  const secondID = second.dataset.chatSession
  assert(secondID !== chat.dataset.chatSession, 'Readers shared a view selection')
  const secondInput = second.querySelector('textarea')
  secondInput.value = 'SYNTHETIC_SIDEBAR_QUESTION standalone'
  secondInput.dispatchEvent(new standalone._window.Event('input', { bubbles: true }))
  second.querySelector('form').requestSubmit()
  await waitFor(() => runtime.busy, 'standalone generation')
  await screenshot('reader-chat-standalone-stream', standalone._window)
  standalone._window.close()
  await waitFor(() => !runtime.busy, 'generation survives Reader close')
  assert(state().sessions.find(s => s.id === secondID)?.messages.at(-1)?.status === 'complete', 'Closing Reader stopped generation')
  assert(chat.dataset.chatSession === previous && state().activeSessionId === previous, 'Standalone changed other view selections')
  report.checks.push('reader-chat-standalone-dock', 'reader-chat-generation-survives-close', 'reader-chat-new-pdf-association', 'reader-chat-all-local-sessions', 'reader-chat-send-time-association', 'reader-chat-switch-during-stream', 'reader-chat-shared-manager-history', 'reader-chat-page-draft-retention', 'reader-chat-light-dark-small-layout')
}
