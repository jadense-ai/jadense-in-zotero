/* global ChromeUtils */
/** 隔离 profile 的诊断验收：只使用合成错误，不访问真实请求与用户内容。 */
export async function verifyDiagnostics({ Zotero, manager, readerDoc, findManager, assert, waitFor, screenshot, report }) {
  let win = manager
  const get = id => win.document.getElementById('jadense-' + id)
  const closeQuickStart = () => { if (get('quick-start-dialog')?.open) get('quick-start-close').click() }
  await waitFor(() => get('quick-start-dialog')?.open || Zotero.Prefs.get('extensions.jadenseInZotero.quickStartShown') === true, 'quick-start before diagnostics')
  closeQuickStart()
  await waitFor(() => !get('quick-start-dialog')?.open, 'quick-start closed')
  const collector = Zotero.__jadenseDiagnostics
  assert(collector && !collector.enabled, 'Diagnostics not owned by lifecycle or enabled by default')
  assert(!get('help-diagnostics').hidden, 'Diagnostic entry must be available without unlocking')
  get('help-diagnostics').click()
  assert(!get('manager-section-diagnostics').hidden, 'Help menu did not directly open diagnostics')
  collector.record('analysis','synthetic_failure',new Error('PRIVATE-PROMPT sk-PRIVATE-KEY'))
  await collector.flush()
  const panel = get('manager-section-diagnostics')
  assert(panel.querySelector('pre').textContent.includes('synthetic_failure'), 'Diagnostic detail did not update')
  assert(!panel.textContent.includes('PRIVATE'), 'Private error text leaked')
  assert(collector.storageAvailable, 'Native diagnostic persistence failed')
  const size = [win.outerWidth-win.innerWidth,win.outerHeight-win.innerHeight]
  for (const theme of ['light','dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme',theme,true)
    win.resizeTo(760+size[0],620+size[1]); await Zotero.Promise.delay(150)
    assert(panel.scrollWidth <= panel.clientWidth+2, 'Diagnostic panel overflows')
    await screenshot('diagnostics-'+theme,win)
  }
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
  report.checks.push('diagnostics-direct-menu-access','diagnostics-return-and-reopen','diagnostics-sanitized-detail','diagnostics-native-persistence','diagnostics-themes-compact','diagnostics-window-reopen','diagnostics-reload-history-restored','diagnostics-clear')
}
