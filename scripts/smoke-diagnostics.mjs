/* global ChromeUtils, Cc, Ci */
/** 隔离 profile 的诊断验收：只使用合成错误，不访问真实请求与用户内容。 */
export async function verifyDiagnostics({ Zotero, manager, readerDoc, findManager, assert, waitFor, screenshot, report }) {
  let win = manager
  const get = id => win.document.getElementById('jadense-' + id)
  const closeQuickStart = () => { if (get('quick-start-dialog')?.open) get('quick-start-dialog').close() }
  await waitFor(() => get('quick-start-dialog')?.open || Zotero.Prefs.get('extensions.jadenseInZotero.quickStartShown') === true, 'quick-start before diagnostics')
  closeQuickStart()
  await waitFor(() => !get('quick-start-dialog')?.open, 'quick-start closed')
  const collector = Zotero.__jadenseDiagnostics
  assert(collector && !collector.enabled, 'Diagnostics not owned by lifecycle or enabled by default')
  assert(!get('help-diagnostics').hidden, 'Diagnostic entry must be available without unlocking')
  get('help-diagnostics').click()
  assert(!get('manager-section-diagnostics').hidden, 'Help menu did not directly open diagnostics')
  const trace = collector.start({ feature: 'analysis', clientRequestId: 'smoke-request-to-copy' })
  trace.fail(new Error('PRIVATE-PROMPT sk-PRIVATE-KEY'), 'synthetic_failure')
  trace.end()
  await collector.flush()
  const panel = get('manager-section-diagnostics')
  const search = panel.querySelector('input[type=search]')
  const input = Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor)
  win.focus(); search.focus()
  assert(input.beginInputTransactionForTests(win), 'Could not start native keyboard input')
  const press = (key, keyCode) => {
    input.keydown(new win.KeyboardEvent('keydown', { key, code: key, keyCode }))
    input.keyup(new win.KeyboardEvent('keyup', { key, code: key, keyCode }))
  }
  input.commitCompositionWith('smoke-request-to-copy')
  assert(search.value === 'smoke-request-to-copy', 'Keyboard input did not populate the request filter')
  const record = panel.querySelector('.jdx-diagnostic-list button')
  press('Tab', 9); press('Tab', 9)
  assert(win.document.activeElement === record, 'Tab from the filter did not reach its result')
  press('Enter', 13)
  collector.record('manager', 'synthetic_later_error', new Error('Synthetic background update'))
  assert(win.document.activeElement === record && record.getAttribute('aria-pressed') === 'true', 'Background refresh lost focus or record selection')
  assert(panel.querySelector('pre').textContent.includes('synthetic_failure'), 'Diagnostic detail did not update')
  assert(!panel.textContent.includes('PRIVATE'), 'Private error text leaked')
  assert(collector.storageAvailable, 'Native diagnostic persistence failed')
  let copied
  // 仅替换隔离窗口的剪贴板，验收单条复制且不改动用户的系统剪贴板。
  const prior = Object.getOwnPropertyDescriptor(win.navigator, 'clipboard')
  try {
    Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = JSON.parse(text) } } })
    press('Tab', 9)
    assert(win.document.activeElement === panel.querySelector('.jdx-diagnostic-facts button'), 'Tab from the record did not reach Copy')
    press('Enter', 13)
    await waitFor(() => copied, 'copy selected diagnostic')
    assert(copied.records.length === 1 && copied.records[0].id === trace.row.id, 'Copy included a different diagnostic')
  } finally {
    if (prior) Object.defineProperty(win.navigator, 'clipboard', prior)
    else delete win.navigator.clipboard
  }
  const size = [win.outerWidth-win.innerWidth,win.outerHeight-win.innerHeight]
  Zotero.Prefs.set('extensions.jadenseInZotero.fontScale','150',true)
  for (const theme of ['light','dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme',theme,true)
    for (const width of [1100,720]) {
      win.resizeTo(width+size[0],800+size[1]); await Zotero.Promise.delay(250)
      assert(Math.abs(win.innerWidth-width) <= 2, 'Requested diagnostic width '+width+', actual '+win.innerWidth)
      assert(panel.scrollWidth <= panel.clientWidth+2, 'Diagnostic panel overflows at '+width)
      await screenshot('diagnostics-'+theme+'-'+width,win)
    }
  }
  Zotero.Prefs.set('extensions.jadenseInZotero.fontScale','100',true)
  win.close(); await waitFor(() => !findManager(),'diagnostics closed')
  readerDoc.querySelector('.jadense-reader-brand').click()
  win = await waitFor(() => findManager()?.receiveJadenseContext && findManager(),'diagnostics reopened')
  assert(!get('help-diagnostics').hidden && Zotero.__jadenseDiagnostics === collector,'Reopening lost diagnostic entry or collector')
  get('help-diagnostics').click()
  const buttons = [...get('manager-section-diagnostics').querySelectorAll('button')]
  buttons.find(b => /返回对话|Back to chat/.test(b.textContent)).click()
  assert(get('manager-section-diagnostics').hidden && !get('help-diagnostics').hidden,'Returning to chat hid the diagnostic entry')
  get('help-diagnostics').click()
  assert(!get('manager-section-diagnostics').hidden,'Could not reopen diagnostics after returning to chat')
  assert(collector.list().length > 0,'Exit cleared diagnostic history')
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs')
  const addon = await AddonManager.getAddonByID('jadense-in-zotero@jadense.cn')
  await addon.disable(); await addon.enable()
  await waitFor(() => Zotero.__jadenseDiagnostics && Zotero.__jadenseDiagnostics !== collector,'reloaded collector')
  await Zotero.__jadenseDiagnostics.ready
  assert(!Zotero.__jadenseDiagnostics.enabled,'Reload retained developer mode')
  assert(Zotero.__jadenseDiagnostics.list().some(r => r.firstError?.stage === 'synthetic_failure'),'Reload lost persisted diagnostic history')
  await Zotero.__jadenseDiagnostics.clear()
  assert(Zotero.__jadenseDiagnostics.list().length === 0,'Clear retained diagnostic records')
  report.checks.push('diagnostics-direct-menu-access','diagnostics-return-and-reopen','diagnostics-sanitized-detail','diagnostics-native-persistence','diagnostics-record-focus-and-copy','diagnostics-themes-compact','diagnostics-window-reopen','diagnostics-reload-history-restored','diagnostics-clear')
}
