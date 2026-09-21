/* global ChromeUtils, Components */
/** 隔离 XPI 的侧栏恢复验收；只在合成 profile 注入宿主/运行时故障，不派发生成。 */
export async function verifySidebarRecovery({ Zotero, reader, assert, waitFor, screenshot, report, pluginID, stage }) {
  const main = Zotero.getMainWindow(), doc = main.document
  const sessions = () => JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState') || '{}').sessions ?? []
  const before = sessions().length, tasks = Zotero.__jadenseDocumentJobs.list().length
  const rootFor = current => current._window.document.querySelector(`.jdx-reader-workspace[data-reader-item="${current.itemID}"]`)
  const buttonFor = current => { try { return current._iframeWindow?.document.querySelector('[data-jadense-action="attach"]') } catch { return null } }
  const visible = node => node && node.getBoundingClientRect().width > 100 && node.getBoundingClientRect().height > 100
  await stage('sidebar-native-entry')
  await waitFor(() => buttonFor(reader), 'Reader toolbar')
  const currentDetail = await waitFor(() => [...doc.querySelectorAll('item-details')].find(node => node.tabID === reader.tabID), 'Reader item details')
  report.nativeEntry = { sections: [...currentDetail.querySelectorAll('[data-pane]')].map(node => node.dataset.pane), buttons: [...(currentDetail.sidenav?.querySelectorAll('[data-pane]') ?? [])].map(node => node.dataset.pane), html: currentDetail.sidenav?.outerHTML?.slice(0, 1500) }
  await stage('sidebar-native-icon')
  const native = await waitFor(() => currentDetail.sidenav?.querySelector('.btn[data-pane$="jadense-in-zotero-sync-panel"]') || doc.querySelector('.btn[data-pane$="jadense-in-zotero-sync-panel"]'), 'native sidebar icon')
  native.click()
  let root = await waitFor(() => visible(rootFor(reader)) && rootFor(reader), 'visible native sidebar')
  assert(root.querySelector('textarea'), 'Sidebar has no composer')
  // 在真实 XUL 宿主里检查普通正文与内联子元素，避免仅测独立 HTML 页漏掉宿主选择限制。
  const selectionProbe = doc.createElementNS('http://www.w3.org/1999/xhtml', 'p')
  selectionProbe.style.cssText = 'position:fixed;top:100px;left:100px;z-index:100000;background:white;color:black;font:16px monospace;padding:8px'
  selectionProbe.innerHTML = '<span>Sidebar selectable body text</span>'
  root.append(selectionProbe)
  await Zotero.Promise.delay(100)
  const textNode = selectionProbe.firstElementChild
  report.sidebarSelection = { body: main.getComputedStyle(selectionProbe).userSelect, inline: main.getComputedStyle(textNode).userSelect }
  const rect = textNode.getBoundingClientRect(), mouse = main.windowUtils
  mouse.sendMouseEvent('mousedown', rect.left + 1, rect.top + rect.height / 2, 0, 1, 0)
  mouse.sendMouseEvent('mousemove', rect.right - 1, rect.top + rect.height / 2, 0, 0, 0)
  mouse.sendMouseEvent('mouseup', rect.right - 1, rect.top + rect.height / 2, 0, 1, 0)
  report.sidebarSelection.selected = main.getSelection().toString()
  selectionProbe.remove()
  assert(report.sidebarSelection.selected.includes('selectable body'), `Sidebar drag selection failed: ${JSON.stringify(report.sidebarSelection)}`)
  main.getSelection().removeAllRanges()
  report.checks.push('sidebar-body-native-drag-selection')
  assert(sessions().length === before, 'Native open created a session')
  buttonFor(reader).click(); buttonFor(reader).click(); buttonFor(reader).click()
  await Zotero.Promise.delay(200)
  assert(doc.querySelectorAll(`.jdx-reader-workspace[data-reader-item="${reader.itemID}"]`).length === 1, 'Repeated open duplicated surfaces')
  assert(sessions().length === before, 'Toolbar open created a session')
  report.checks.push('native-icon-visible-composer', 'toolbar-open-no-session', 'overlapping-opens-one-surface')
  // 快捷键保持已有捕获行为；Escape 退出，不进入 AI/OCR。
  const pdfWindow = reader._internalReader._primaryView._iframeWindow
  await waitFor(() => pdfWindow.document.querySelector('[data-jadense-figure-overlay]'), 'capture shortcut listeners')
  const captureKey = new pdfWindow.KeyboardEvent('keydown', Components.utils.cloneInto({ key: 's', code: 'KeyS', ctrlKey: !Zotero.isMac, metaKey: Boolean(Zotero.isMac), altKey: true, bubbles: true, cancelable: true }, pdfWindow))
  pdfWindow.document.body.dispatchEvent(captureKey)
  report.shortcut = { prevented: captureKey.defaultPrevented, ctrl: captureKey.ctrlKey, alt: captureKey.altKey }
  await stage('sidebar-shortcut')
  await waitFor(() => pdfWindow.document.querySelector('[data-jadense-capture]'), 'capture shortcut')
  pdfWindow.document.body.dispatchEvent(new pdfWindow.KeyboardEvent('keydown', Components.utils.cloneInto({ key: 'Escape', bubbles: true, cancelable: true }, pdfWindow)))
  assert(!pdfWindow.document.querySelector('[data-jadense-capture]'), 'Capture remained after Escape')
  report.checks.push('shortcut-and-escape-no-request')


  for (const [theme, width, height] of [['light', 1360, 860], ['dark', 1360, 860], ['light', 900, 700]]) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    main.resizeTo(width, height); await Zotero.Promise.delay(400)
    root = rootFor(reader)
    assert(visible(root), `Sidebar disappeared at ${theme}/${width}`)
    const bounds = root.getBoundingClientRect(), input = root.querySelector('textarea').getBoundingClientRect()
    assert(input.width > 30 && input.right <= bounds.right + 2 && input.bottom <= bounds.bottom + 2, 'Composer is clipped')
    await screenshot(`sidebar-recovery-${theme}-${width}`, main)
  }
  report.checks.push('light-dark-narrow-layout')
  main.resizeTo(1360, 860); await Zotero.Promise.delay(400)

  await stage('sidebar-native-failure')
  const detail = [...doc.querySelectorAll('item-details')].find(node => node.tabID === reader.tabID)
  const original = detail.scrollToPane, originalPin = detail.pinnedPane
  detail.scrollToPane = async () => { throw new Error('SYNTHETIC_NATIVE_ACTIVATION_FAILURE') }
  try {
    buttonFor(reader).click()
    root = await waitFor(() => { const value = rootFor(reader); return value?.classList.contains('jdx-reader-dock') && value }, 'fallback dock')
    assert(visible(root), 'Fallback dock is invisible')
    assert(!detail.hasAttribute('data-jdx-reading-active'), 'Native active state survived fallback')
    const trace = await waitFor(() => Zotero.__jadenseDiagnostics.list().find(row => row.events.some(event => event.stage === 'dock_ready') && row.firstError?.stage === 'native_failed'), 'successful fallback diagnostic')
    assert(trace?.category === 'success', 'Fallback has no successful diagnostic timeline')
    report.nativeRollback = { originalPin, restoredPin: detail.pinnedPane }
  } finally { detail.scrollToPane = original }
  report.checks.push('native-failure-fallback-visible', 'native-state-rollback', 'fallback-diagnostic-timeline')

  await stage('sidebar-content-failure')
  const runtime = Zotero.__jadenseChatRuntime, feature = runtime.feature
  runtime.feature = () => { throw new Error('SYNTHETIC_CONTENT_FAILURE') }
  let errorPanel
  try {
    buttonFor(reader).click()
    errorPanel = await waitFor(() => reader._iframeWindow.document.querySelector('.jdx-sidebar-recovery') || doc.querySelector('.jdx-sidebar-recovery'), 'inline recoverable error')
    assert(errorPanel.querySelectorAll('button').length === 2, 'Missing recovery actions')
    assert(!errorPanel.textContent.includes('SYNTHETIC_CONTENT_FAILURE'), 'Raw exception leaked')
    assert(errorPanel.textContent.includes('diag-') || /[a-f0-9]{8}-/.test(errorPanel.textContent), 'Missing diagnostic ID')
    await screenshot('sidebar-recovery-error', errorPanel.ownerDocument.defaultView)
  } finally { runtime.feature = feature }
  errorPanel.querySelector('button').focus(); errorPanel.querySelector('button').click()
  root = await waitFor(() => visible(rootFor(reader)) && rootFor(reader), 'retry sidebar')
  assert(!reader._iframeWindow.document.querySelector('.jdx-sidebar-recovery'), 'Error panel survived retry')
  assert(sessions().length === before, 'Retry created a session')
  report.checks.push('content-failure-inline-retry', 'retry-no-business-replay')

  await stage('sidebar-independent-window')
  const standalone = await Zotero.Reader.open(reader.itemID, undefined, { openInWindow: true, allowDuplicate: true })
  try {
    await waitFor(() => buttonFor(standalone), 'independent toolbar'); buttonFor(standalone).click()
    const other = await waitFor(() => visible(rootFor(standalone)) && rootFor(standalone), 'independent sidebar')
    assert(other.ownerDocument !== root.ownerDocument, 'Independent Reader reused another window surface')
    await screenshot('sidebar-recovery-independent', standalone._window)
  } finally { standalone._window.close() }
  assert(visible(rootFor(reader)), 'Closing independent Reader removed the original sidebar')
  report.checks.push('same-pdf-two-windows', 'independent-close-isolated')
  await stage('sidebar-second-pdf')
  const attachment = Zotero.Items.get(reader.itemID)
  const secondPDF = await Zotero.Attachments.importFromFile({ file: await attachment.getFilePathAsync(), parentItemID: attachment.parentItemID, contentType: 'application/pdf' })
  const secondReader = await Zotero.Reader.open(secondPDF.id)
  await waitFor(() => buttonFor(secondReader), 'second PDF toolbar'); buttonFor(secondReader).click()
  const secondRoot = await waitFor(() => visible(rootFor(secondReader)) && rootFor(secondReader), 'second PDF sidebar')
  assert(secondRoot.dataset.readerItem === String(secondPDF.id), 'Second PDF inherited original identity')
  main.Zotero_Tabs.select(reader.tabID); await Zotero.Promise.delay(150)
  assert(visible(rootFor(reader)), 'Original PDF sidebar did not restore')
  main.Zotero_Tabs.close(secondReader.tabID)
  report.checks.push('multiple-pdf-identity-and-switch')

  await stage('sidebar-invisible-native-recovery')
  root = rootFor(reader)
  const nativeBody = root.closest('[data-type="body"]')
  report.visibilityProbe = { tabID: reader.tabID, selectedID: main.Zotero_Tabs.selectedID, visibility: doc.visibilityState, detailClass: root.closest('item-details')?.className, active: root.closest('item-details')?.hasAttribute('data-jdx-reading-active') }
  if (nativeBody) {
    const beforeRoot = root
    nativeBody.style.display = 'none'
    try {
      main.dispatchEvent(new main.Event('resize'))
      await waitFor(() => visible(rootFor(reader)) && rootFor(reader).classList.contains('jdx-reader-dock'), 'invisible native recovery')
      assert(rootFor(reader) === beforeRoot, 'Visibility recovery recreated business content')
      assert(sessions().length === before, 'Visibility recovery created a session')
      await screenshot('sidebar-invisible-native-recovered', main)
    } finally { nativeBody.style.display = '' }
    report.checks.push('invisible-native-same-content-dock')
  }
  Zotero.Prefs.set('extensions.jadenseInZotero.fontSize', '20', true)
  main.resizeTo(900, 700); await Zotero.Promise.delay(400)
  root = rootFor(reader)
  assert(visible(root) && root.querySelector('textarea').getBoundingClientRect().width > 30, 'Scaled narrow composer unavailable')
  await screenshot('sidebar-scaled-narrow', main)
  main.resizeTo(1360, 860)
  Zotero.Prefs.set('extensions.jadenseInZotero.fontSize', '13', true)
  report.checks.push('scaled-narrow-composer')


  await stage('sidebar-disable-enable')
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs')
  const addon = await AddonManager.getAddonByID(pluginID)
  await addon.disable()
  await waitFor(() => !doc.querySelector('.jdx-reader-workspace'), 'disabled sidebar cleanup')
  assert(!doc.querySelector('.jdx-sidebar-recovery'), 'Disabled plugin retained error UI')
  await addon.enable()
  await waitFor(() => Zotero.__jadenseChatRuntime && Zotero.Reader._registeredListeners.some(row => row.pluginID === pluginID && row.type === 'renderToolbar'), 'reenabled runtime')
  const itemID = reader.itemID
  const closedTab = reader.tabID
  main.Zotero_Tabs.close(closedTab)
  await Zotero.Promise.delay(300)
  await stage('sidebar-reopen-after-enable')
  reader = await Zotero.Reader.open(itemID, undefined, { allowDuplicate: true })
  await waitFor(() => buttonFor(reader), 'reenabled toolbar'); buttonFor(reader).click()
  await waitFor(() => visible(rootFor(reader)), 'reenabled sidebar')
  assert(sessions().length === before, 'Enable created a conversation')
  assert(Zotero.__jadenseDocumentJobs.list().length === tasks, 'Opening started document work')
  const toolsPopup = doc.getElementById('menu_ToolsPopup')
  toolsPopup.dispatchEvent(new main.Event('popupshowing', { bubbles: true }))
  const submenu = await waitFor(() => toolsPopup.querySelector('[data-l10n-id="jadense-in-zotero-menu-main"] menupopup'), 'Jadense tools submenu')
  submenu.dispatchEvent(new main.Event('popupshowing', { bubbles: true }))
  await waitFor(() => submenu.querySelector('[data-l10n-id="jadense-in-zotero-menu-export-diagnostics"]'), 'Tools diagnostic export')
  report.checks.push('disable-full-cleanup', 'enable-new-reader-opens', 'no-document-or-chat-side-effects', 'diagnostics-tools-entry')

  await stage('sidebar-results-read-timeout')
  const jobs = Zotero.__jadenseDocumentJobs
  const extracted = await jobs.start('extraction', itemID, true)
  const readExtraction = jobs.store.extraction
  root = rootFor(reader)
  jobs.store.extraction = () => new Promise(() => {})
  try {
    root.querySelector('.jdx-reader-header-left button').click()
    const source = await waitFor(() => [...doc.querySelectorAll('[role="option"]')].find(row => /全文 Markdown|Full Markdown/u.test(row.textContent)), 'source page')
    source.click()
    await waitFor(() => /正在读取原文|Loading source/u.test(root.textContent), 'immediate result loading')
    await waitFor(() => /成果暂时无法读取|Results are temporarily unavailable/u.test(root.textContent), 'bounded result read')
    await screenshot('sidebar-results-read-timeout', main)
  } finally { jobs.store.extraction = readExtraction }
  const retryRead = [...root.querySelectorAll('button')].find(button => /重试读取|Retry reading/u.test(button.textContent))
  assert(retryRead, 'Missing local read retry'); retryRead.click()
  await waitFor(() => root.querySelector('.jdx-result-content .jdx-markdown'), 'result read recovery')
  assert(jobs.list().length === tasks + 1, 'Read retry replayed extraction')
  await jobs.delete(extracted.id)
  report.checks.push('result-loading-visible', 'result-read-10s-timeout', 'result-retry-no-extraction')
}
