/** 隔离 Zotero profile 验证真实收藏夹读写；仅 TypeSafe 返回值合成，不访问真实密钥。 */
export async function verifyClassification({ Zotero, manager, assert, waitFor, screenshot, report, openClassification, assertNoManager }) {
  const libraryID = Zotero.Libraries.userLibraryID
  const makeFolder = async (name, parentID) => {
    const folder = new Zotero.Collection(); folder.libraryID = libraryID; folder.name = name
    if (parentID) folder.parentID = parentID
    await folder.saveTx(); return folder
  }
  const root = await makeFolder('Aerosol'), child = await makeFolder('反演', root.id), target = await makeFolder('AERONET', child.id), outside = await makeFolder('待读 / 待核对')
  const papers = []
  for (const title of ['Accuracy assessment of aerosol optical properties retrieved from Aerosol Robotic Network (AERONET) Sun and sky radiance measurements', 'On the general theory of control systems']) {
    const item = new Zotero.Item('journalArticle'); item.libraryID = libraryID; item.setField('title', title); item.setField('abstractNote', 'Synthetic classification smoke abstract')
    item.setCollections([outside.id]); await item.saveTx(); papers.push(item)
  }
  let doc = manager.document
  const key = doc.getElementById('jadense-typesafe-key')
  assert(key?.type === 'password', 'Classification key is missing or unmasked')
  let originalFetch = manager.fetch
  let calls = 0, mode = 'success'
  const fetcher = async (url, init) => {
    if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return originalFetch.call(manager, url, init)
    calls++
    const body = JSON.parse(init.body)
    assert(body.model === 'jev-latest' && body.questions.classification.type === 'choice', 'Wrong TypeSafe protocol')
    assert(!('key' in body.state) && !('collections' in body.state), 'Internal item identity leaked into model state')
    if (mode === 'error') return new manager.Response('synthetic private body', { status: 401 })
    const choice = body.questions.classification.criteria.research ? 'research' : body.state.title.startsWith('Accuracy') ? `collection_${target.id}` : 'none'
    return new manager.Response(JSON.stringify({ answers: { classification: { choice, confidence: .7 } }, additive: true }))
  }
  manager.fetch = fetcher
  const settings = doc.querySelector('[data-feature-group="classification"]')
  const press = (root, label) => {
    const control = [...root.querySelectorAll('button')].find(button => button.textContent.trim() === label)
    assert(control && !control.disabled, 'Missing or disabled button: ' + label); control.click()
  }
  const open = async () => {
    manager = await openClassification(papers.map(paper => paper.id))
    if (manager.fetch !== fetcher) originalFetch = manager.fetch
    manager.fetch = fetcher; doc = manager.document
  }
  try {
    key.value = 'synthetic-classification-smoke-key'; press(settings, '测试密钥')
    await waitFor(() => settings.textContent.includes('密钥测试通过'), 'key test')
    press(settings, '保存密钥')
    assert(Zotero.Prefs.get('extensions.jadenseInZotero.typesafeApiKey', true) === key.value, 'Classification key not saved')
    manager.fetch = originalFetch; manager.close()
    await waitFor(() => manager.closed, 'settings workbench closed')
    await open(); assertNoManager()
    const dialog = await waitFor(() => doc.querySelector('#jadense-classification-dialog'), 'classification window')
    assert(doc.title === '文献分类' && !doc.querySelector('#jadense-manager-shell'), 'Classification is not independent or incorrectly named')
    await waitFor(() => [...dialog.querySelectorAll('.jdx-classification-folders label')].some(label => label.textContent.includes('AERONET')), 'nested collections')
    assert(dialog.textContent.includes('Aerosol') && dialog.textContent.includes('›'), 'Missing folder breadcrumb')
    const assertFooter = () => {
      const footer = dialog.querySelector('.jdx-classification-footer').getBoundingClientRect()
      const padding = parseFloat(manager.getComputedStyle(dialog).paddingBottom)
      assert(Math.abs(manager.innerHeight - footer.bottom - padding) < 2, 'Actions are not anchored to the window bottom')
      assert(footer.top >= 0 && footer.right <= manager.innerWidth, 'Actions overflow the window')
    }
    assertFooter()
    await screenshot('classification-choose', manager)
    const generate = () => press(dialog, '生成推荐预览')
    generate()
    await waitFor(() => dialog.querySelectorAll('tbody tr').length === 2 && [...dialog.querySelectorAll('button')].some(button => button.textContent === '确认归类' && !button.disabled), 'classification preview')
    assert(papers[0].getCollections().join() === String(outside.id), 'Preview wrote memberships')
    assert(dialog.querySelectorAll('tbody input:checked').length === 1, 'No-match selected by default')
    await screenshot('classification-preview', manager)
    const previousTheme = Zotero.Prefs.get('extensions.jadenseInZotero.theme', true)
    const previousSize = [manager.outerWidth, manager.outerHeight]
    manager.resizeTo(800, 660)
    await Zotero.Promise.delay(120)
    const bounds = dialog.getBoundingClientRect()
    assert(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= manager.innerWidth + 1 && bounds.bottom <= manager.innerHeight + 1, 'Narrow classification dialog overflows viewport')
    await screenshot('classification-narrow', manager)
    assertFooter()
    manager.resizeTo(720, 500)
    await Zotero.Promise.delay(120)
    assertFooter()
    await screenshot('classification-small', manager)
    manager.resizeTo(...previousSize)
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
    await waitFor(() => doc.documentElement.dataset.theme === 'light', 'classification light theme')
    await screenshot('classification-light', manager)
    assertFooter()
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', previousTheme || 'system', true)
    press(dialog, '确认归类')
    await waitFor(() => dialog.textContent.includes('已归类 1 篇'), 'classification apply')
    assert(papers[0].getCollections().includes(target.id) && papers[0].getCollections().includes(outside.id), 'Add classification lost existing membership')
    assert(!papers[1].getCollections().includes(target.id), 'Unmatched paper changed')
    assert(!dialog.querySelector('.jdx-classification-complete').hidden, 'Completion step missing')
    await screenshot('classification-complete', manager)
    await open(); assertNoManager()
    mode = 'error'; const beforeError = calls; generate()
    await waitFor(() => dialog.textContent.includes('HTTP 401'), 'provider error')
    assert(calls === beforeError + 1, 'Error continued dispatch')
    await screenshot('classification-error', manager)
    press(dialog, '返回上一步')
    assert(!dialog.querySelector('.jdx-classification-choose').hidden, 'Back did not restore selection')
    Zotero.Prefs.set('extensions.jadenseInZotero.typesafeApiKey', '', true)
    const beforeGuide = calls; generate()
    assert(dialog.querySelector('dialog').open && calls === beforeGuide, 'Missing key should guide without a request')
    await screenshot('classification-key-guide', manager)
    press(dialog.querySelector('dialog'), '取消')
    assert(!dialog.querySelector('dialog').open, 'Guide cancel failed')
    assert(![...dialog.querySelectorAll('button')].some(button => ['配置密钥', '撤销上次归类', '重新选择分类', '关闭'].includes(button.textContent)), 'Removed action still present')
    assert(!dialog.querySelector('.jdx-classification-close'), 'Redundant close button remains')
    report.checks.push('classification-key-mask-test-save', 'classification-native-nested-folders', 'classification-preview-no-write', 'classification-native-add-preserves-existing', 'classification-unmatched-unchanged', 'classification-steps-back-complete', 'classification-missing-key-guide', 'classification-provider-error-contained', 'classification-narrow-viewport', 'classification-native-menu-independent-window')
  } finally { manager.fetch = originalFetch }
}
