/** 在 smoke-research 的隔离 profile 中操作真实条目面板、Reader 和工作台。所有记录与连接均由本地夹具提供。 */
export async function verifySidebarUI({ Zotero, reader, parent, attachment, assert, waitFor, screenshot, report, stage, findManager, config }) {
  const main = Zotero.getMainWindow(), doc = main.document
  const pref = name => 'extensions.jadenseInZotero.' + name
  const visible = node => node?.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0
  const pick = async (trigger, match) => {
    trigger.click()
    const option = await waitFor(() => [...doc.querySelectorAll('.jdx-select-portal [role=option]')].find(node => visible(node) && match(node)), 'visible sidebar option', 5000)
    option.click()
  }
  Zotero.Prefs.set(pref('quickStartShown'), true)
  await stage('sidebar-draft-and-type')
  main.restore?.()
  main.resizeTo(1360, 830)
  const ask = await waitFor(() => reader._iframeWindow.document.querySelector('[data-jadense-action="attach"]'), 'reader ask action')
  ask.click()
  const root = await waitFor(() => {
    const node = doc.querySelector(`.jdx-reader-workspace[data-reader-item="${reader.itemID}"]`)
    return visible(node) && node
  }, 'mounted reader sidebar')
  const input = root.querySelector('textarea'), add = root.querySelector('.jdx-reader-header-right button')
  assert(root.querySelector('.jdx-reader-header-center').textContent.includes('新对话'), 'Draft title missing')
  input.value = '保留我的未发问题'
  input.dispatchEvent(new main.Event('input', { bubbles: true }))
  add.click()
  await waitFor(() => doc.activeElement === input, 'focus returns to unsent question', 5000)
  assert(input.value === '保留我的未发问题', 'New conversation discarded the draft')
  const outer = root.closest('#zotero-context-pane')
  assert(outer, 'Native reader context pane missing')
  report.sidebarLayouts = []
  for (const [width, height, scale, theme] of [[480, 600, 100, 'light'], [320, 360, 150, 'light'], [320, 360, 150, 'dark']]) {
    Zotero.Prefs.set(pref('theme'), theme, true)
    Zotero.Prefs.set(pref('fontScale'), String(scale), true)
    // 原生图标栏占独立列。宿主完成 resize 后以正文实际宽高校正测试视口。
    for (let attempt = 0; attempt < 4; attempt++) {
      await Zotero.Promise.delay(300)
      const rect = root.getBoundingClientRect()
      if (Math.abs(rect.width - width) <= 3 && Math.abs(rect.height - height) <= 4) break
      const paneWidth = outer.getBoundingClientRect().width + width - rect.width
      outer.style.width = Math.round(paneWidth) + 'px'
      outer.style.minWidth = Math.round(paneWidth) + 'px'
      outer.style.maxWidth = Math.round(paneWidth) + 'px'
      outer.setAttribute('width', String(Math.round(paneWidth)))
      main.resizeTo(main.outerWidth, main.outerHeight + height - rect.height)
    }
    await Zotero.Promise.delay(200)
    const bounds = root.getBoundingClientRect()
    const sizes = [input, root.querySelector('.jdx-chat-empty p'), root.querySelector('[id$="-chat-compose-hint"]')].map(node => parseFloat(main.getComputedStyle(node).fontSize))
    report.sidebarLayouts.push({ requested: [width, height], actual: [bounds.width, bounds.height], scale, theme, sizes })
    const ancestry = []
    for (let el = root; el; el = el.parentElement) ancestry.push([el.localName, el.id, Math.round(el.getBoundingClientRect().width)])
    assert(Math.abs(bounds.width - width) <= 3 && Math.abs(bounds.height - height) <= 4, 'Requested sidebar size not reached: ' + JSON.stringify({ layouts: report.sidebarLayouts, ancestry, outer: outer.style.cssText }))
    assert(sizes[0] >= 13 * scale / 100 - .1 && sizes[1] >= 13 * scale / 100 - .1 && sizes[2] >= 11 * scale / 100 - .1, 'Sidebar type did not scale: ' + sizes)
    const send = root.querySelector('[type=submit]').getBoundingClientRect()
    await screenshot(`sidebar-chat-${width}-${scale}-${theme}`, main)
    assert(send.right <= bounds.right + 1 && send.bottom <= bounds.bottom + 1 && send.width > 0, 'Send control clipped: ' + JSON.stringify({ send: send.toJSON(), bounds: bounds.toJSON() }))
  }
  report.checks.push('reader-draft-focus-and-type-scale')

  await stage('sidebar-analysis-versions')
  const source = { itemID: attachment.id, libraryID: attachment.libraryID, itemKey: attachment.key, title: 'Sidebar paper', authors: [] }
  const go = name => pick(root.querySelector('.jdx-reader-header-left button'), node => node.textContent.trim() === name)
  const result = () => [...root.querySelectorAll('.jdx-document-results')].find(visible)
  const version = () => result()?.querySelector('.jdx-result-version .jdx-select-trigger')
  const records = [11, 22].map(day => ({ id: 'sidebar-version-' + day, createdAt: `2026-11-${day}T10:00:00Z`, source,
    summary: 'Summary ' + day, notes: 'Notes ' + day, referenceTaskID: '21000000-0000-4000-8000-0000000000' + day }))
  const citations = ['Lin A. Material recovery in a synthetic cohort (2024).', 'Park B. Independent calibration of synthetic samples (2025).']
  if (!Zotero.__jadenseDocumentJobs) {
    await go('选中翻译历史')
    await waitFor(() => result()?.dataset.resultMode === 'selection', 'initialize the document store')
  }
  const previousJobs = Zotero.__jadenseDocumentJobs
  await previousJobs.ready
  for (const [index, record] of records.entries()) {
    const id = record.referenceTaskID, raw = citations[index]
    assert(await previousJobs.store.save({ version: 1, id, kind: 'references', source, createdAt: record.createdAt, status: 'complete', totalPages: 1, completed: 1, total: 1, models: [], warnings: [] }), 'Could not save the reference task fixture')
    assert(await previousJobs.store.saveReferences(id, [{ id: 'reference-' + index, order: 0, raw, lines: [], fields: { title: raw, authors: [], year: '' }, uncertain: false, verification: 'unverified' }]), 'Could not save the synthetic citation')
  }
  // 复用隔离原生验收的真实索引加载路径，确保两端读取磁盘保存的版本关联。
  previousJobs.dispose()
  const jobs = new previousJobs.constructor(Zotero, main.fetch.bind(main), previousJobs.store)
  Zotero.__jadenseDocumentJobs = jobs; await jobs.ready
  Zotero.Prefs.set(pref('paperAnalysisHistory'), JSON.stringify({ version: 1, records }))
  const hasOlderBibliography = panel => {
    const citationsShown = [...(panel?.querySelectorAll('.jdx-reference-raw') ?? [])].filter(visible).map(node => node.textContent)
    return citationsShown.length === 1 && citationsShown[0] === citations[0]
  }
  await go('解析总结')
  await waitFor(() => visible(version()), 'two analysis versions')
  await pick(version(), option => option.id.endsWith('option-1'))
  await waitFor(() => result()?.innerText.includes('Summary 11'), 'older summary')
  const versionTitle = version().textContent
  await go('解析笔记')
  await waitFor(() => result()?.innerText.includes('Notes 11'), 'matching older notes', 5000)
  await go('参考文献')
  await waitFor(() => root.dataset.page === 'references' && version()?.textContent === versionTitle && hasOlderBibliography(result()), 'older bibliography text in Reader', 5000)
  // 留足竖向空间，让交付截图同时包含版本日期和对应的引文正文。
  const compactHeight = main.outerHeight
  main.resizeTo(main.outerWidth, 950)
  await waitFor(() => root.getBoundingClientRect().height > 600, 'expanded bibliography viewport')
  result().querySelector('.jdx-reference-raw').scrollIntoView({ block: 'center', behavior: 'instant' })
  await Zotero.Promise.delay(200)
  await screenshot('sidebar-analysis-older-references', main)
  main.resizeTo(main.outerWidth, compactHeight)
  await waitFor(() => Math.abs(root.getBoundingClientRect().height - 360) < 5, 'restore compact sidebar')
  root.querySelector('.jdx-reader-header-right button:not([hidden])').click()
  const manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), 'analysis workbench')
  await waitFor(() => {
    const panel = [...manager.document.querySelectorAll('.jdx-document-results')].find(visible)
    return panel?.querySelector('.jdx-result-version .jdx-select-trigger')?.textContent === versionTitle && hasOlderBibliography(panel)
  }, 'older bibliography text in workbench', 6000)
  await go('历史全文译文')
  await waitFor(() => result()?.innerText.includes('打开对照翻译'), 'bilingual PDF action')
  result().querySelector('.jdx-result-empty button').click()
  await waitFor(() => reader._iframeWindow.document.querySelector('.jdx-pdf-translation'), 'bilingual view in the current PDF', 8000)
  await go('对话')
  assert(input.value === '保留我的未发问题', 'Returning from results lost the draft')
  report.checks.push('reader-shared-analysis-version-and-workbench', 'reader-legacy-translation-navigation')

  await stage('sidebar-generating-conversation')
  const chat = root.querySelector('.jdx-reader-chat'), send = chat.querySelector('[type=submit]'), stop = chat.querySelector('[id$="-chat-stop"]')
  input.value += '\nSYNTHETIC_SIDEBAR_QUESTION'
  input.dispatchEvent(new main.Event('input', { bubbles: true }))
  await waitFor(() => !send.disabled, 'configured chat model ready', 5000)
  send.click()
  const ownerID = await waitFor(() => visible(stop) && chat.dataset.chatSession, 'active reply in its conversation', 10000)
  const ownerTitle = root.querySelector('.jdx-reader-header-center .jdx-select-trigger').title
  add.click()
  input.value = '另一个草稿'
  input.dispatchEvent(new main.Event('input', { bubbles: true }))
  const notice = chat.querySelector('.jdx-reader-other-generation')
  assert(chat.dataset.chatSession === '' && ownerTitle && visible(notice) && notice.textContent.includes(ownerTitle)
    && !visible(stop) && send.disabled, 'Another draft does not identify the generating conversation or exposes its controls')
  notice.querySelector('button').click()
  assert(chat.dataset.chatSession === ownerID && visible(stop) && !visible(notice), 'Return did not expose Stop in the owning conversation')
  await waitFor(() => !visible(stop) && chat.querySelector('.jdx-chat-message[data-role="assistant"][data-status="complete"]'), 'synthetic reply completed in its original conversation', 15000)
  add.click()
  assert(input.value === '另一个草稿' && !send.disabled, 'Background reply lost or blocked the other draft')
  report.checks.push('reader-generating-owner-return-and-scoped-stop')

  await stage('sidebar-library-configuration')
  Zotero.Prefs.clear(pref('token'))
  Zotero.Prefs.clear(pref('defaultFolderId'))
  Zotero.Prefs.set(pref('collectionUploadIncludePdf'), true)
  main.Zotero_Tabs.select('zotero-pane')
  await main.ZoteroPane.selectItem(parent.id)
  const details = doc.getElementById('zotero-item-details')
  const section = await waitFor(() => details.querySelector('item-pane-custom-section[data-pane$="jadense-in-zotero-sync-panel"]'), 'library Jadense section', 8000)
  await details.scrollToPane(section.dataset.pane, 'instant')
  const panel = () => section.querySelector('.jdx-sync-panel')
  const action = key => panel()?.querySelector('[data-sync-action="' + key + '"]')
  await waitFor(() => visible(action('connect')), 'connect action')
  assert(action('connect').getBoundingClientRect().bottom <= main.innerHeight, 'Connection action below the first viewport')
  await screenshot('sidebar-library-connect', main)
  action('connect').click()
  const settings = manager.document
  await waitFor(() => visible(settings.getElementById('jadense-settings-panel-connection')), 'connect destination')
  const token = settings.getElementById('jadense-manager-token-input')
  if (!visible(token)) settings.getElementById('jadense-manager-token-edit').click()
  token.value = config.token
  token.dispatchEvent(new manager.Event('input', { bubbles: true }))
  settings.getElementById('jadense-manager-token-save').click()
  await waitFor(() => Zotero.Prefs.get(pref('token')) === config.token && !settings.getElementById('jadense-manager-token-save').disabled, 'synthetic connection saved')
  // 连接成功后，某些配置会自动选择服务器默认收藏夹；独立核验缺失目标的入口。
  Zotero.Prefs.clear(pref('defaultFolderId'))
  await waitFor(() => visible(action('folder')), 'choose-folder action', 7000)
  action('folder').click()
  await waitFor(() => visible(settings.getElementById('jadense-connection-panel-sync')), 'folder selector destination')
  settings.getElementById('jadense-manager-migrate-load-folders').click()
  await waitFor(() => panel()?.dataset.state === 'ready' && !settings.getElementById('jadense-manager-migrate-load-folders').disabled, 'ready state after choosing folder', 10000)
  main.focus()
  await details.scrollToPane(section.dataset.pane, 'instant')
  await screenshot('sidebar-library-ready', main)
  const destination = panel().querySelector('[data-sync-field="destination"]').textContent
  const upload = action('items')
  assert(destination === 'Synthetic upload folder' && upload.textContent === '上传 1 个条目（含 PDF）', 'Upload scope, destination or attachment setting missing: ' + JSON.stringify([destination, upload.textContent, panel().innerText]))
  action('change-folder').click()
  const includePdf = settings.getElementById('jadense-manager-include-pdf')
  await waitFor(() => visible(includePdf) && includePdf.checked, 'current attachment setting')
  includePdf.click()
  await waitFor(() => action('items').textContent === '上传 1 个条目（仅题录）' && action('collection').textContent.includes('仅题录'), 'both upload scopes reflect the new PDF setting', 5000)
  report.checks.push('library-connect-and-choose-destination', 'library-readable-upload-scope')
}
