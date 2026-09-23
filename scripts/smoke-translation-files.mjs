/** 隔离宿主的历史文件专项：合成 PDF 作为已有产物，不调用翻译服务。 */
export async function verifyTranslationFiles({ Zotero, reader, assert, waitFor, screenshot, report, findManager }) {
  const io = globalThis.IOUtils, paths = globalThis.PathUtils, main = Zotero.getMainWindow()
  const item = Zotero.Items.get(reader.itemID), original = await item.getFilePathAsync(), bytes = await io.read(original)
  const fingerprint = [...new Uint8Array(await main.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
  const id = 'a'.repeat(64), second = 'b'.repeat(64), incomplete = 'c'.repeat(64), partial = 'd'.repeat(64)
  for (const taskID of [id, second, incomplete, partial]) {
    const directory = paths.join(paths.profileDir, 'jadense-pdf-translation', 'tasks', taskID)
    await io.makeDirectory(directory, { ignoreExisting: true })
    await io.writeUTF8(paths.join(directory, 'task.json'), JSON.stringify({ id: taskID, version: 1, engine: 'historical-engine', source: { itemID: item.id, libraryID: item.libraryID, itemKey: item.key, title: 'Synthetic PDF' }, fingerprint, configuration: 'previous-configuration', languages: { sourceLanguage: 'en', targetLanguage: taskID === second ? 'ja' : 'zh-CN' }, status: taskID === incomplete ? 'running' : taskID === partial ? 'partial' : 'complete', stage: 'complete', percent: 100, pages: reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.pagesCount, skipped: [], future: true }))
    if (taskID === partial) {
      const revision = 'e'.repeat(32)
      for (const kind of ['mono', 'dual']) await io.copy(original, paths.join(directory, `${revision}-${kind}.pdf`))
      await io.writeUTF8(paths.join(directory, 'artifact.json'), JSON.stringify({ revision, fingerprint, configuration: 'previous-configuration', pages: reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.pagesCount, skipped: [], coverage: { total: 3, translated: 2, failed: 1, preserved: 4, failedPages: [0] } }))
    }
    if (taskID !== incomplete && taskID !== partial) for (const kind of ['mono', 'dual']) await io.copy(original, paths.join(directory, `${kind}.pdf`))
  }
  const doc = reader._iframeWindow.document
  doc.querySelector('.jadense-reader-brand').click()
  const manager = await waitFor(() => findManager()?.receiveJadenseContext && findManager(), 'history Manager')
  const md = manager.document
  await waitFor(() => md.getElementById('jadense-quick-start-close'), 'quick start dialog')
  md.getElementById('jadense-quick-start-close').click()
  md.getElementById('jadense-manager-nav-analysis').click()
  const paper = await waitFor(() => md.querySelector('#jadense-analysis-history .jdx-analysis-title'), 'PDF-only paper')
  paper.click()
  const tab = await waitFor(() => md.getElementById('jdx-literature-tab-files'), 'translated files tab'); tab.click()
  await waitFor(() => md.querySelectorAll('[data-pdf-task-id]').length === 4, 'all historical versions')
  const row = taskID => md.querySelector(`[data-pdf-task-id="${taskID}"]`)
  assert([...row(incomplete).querySelectorAll('button')].slice(0,3).every(button => button.disabled), 'Missing outputs can be opened or exported')
  assert([...row(partial).querySelectorAll('button')].every(button => !button.disabled), 'Partial outputs or retry unavailable')
  const jobs = Zotero.__jadensePDFTranslationJobs, originalStart = jobs.start, originalExport = jobs.export
  let starts = 0; const exports = []
  jobs.start = async () => { starts++; throw new Error('History must not start translation') }
  jobs.export = async (taskID, kind) => { exports.push({ taskID, kind }) }
  try {
    row(id).querySelectorAll('button')[1].click(); await waitFor(() => exports.length === 1 && !row(id).querySelectorAll('button')[2].disabled, 'mono export action')
    row(id).querySelectorAll('button')[2].click(); await waitFor(() => exports.length === 2 && !row(id).querySelector('button').disabled, 'dual export action')
    assert(exports[0].taskID === id && exports[0].kind === 'mono' && exports[1].kind === 'dual', 'Export selected wrong artifact')
    row(id).querySelector('button').click()
    await waitFor(() => doc.querySelector('.jdx-pdf-translation iframe')?.contentDocument?.querySelector('.textLayer span'), 'open saved bilingual PDF')
    assert(starts === 0, 'History generated a new translation')
    const panel = doc.querySelector('.jdx-pdf-translation')
    assert(panel.dataset.pdfTaskId === id, 'Reader opened the wrong version')
    row(second).querySelector('button').click()
    await waitFor(() => doc.querySelector('.jdx-pdf-translation')?.dataset.pdfTaskId === second && doc.querySelector('.jdx-pdf-translation iframe')?.contentDocument?.querySelector('.textLayer span'), 'switch saved version')
    assert(starts === 0, 'Version switch generated a translation')
    row(partial).querySelector('button').click()
    await waitFor(() => doc.querySelector('.jdx-pdf-translation')?.dataset.pdfTaskId === partial && doc.querySelector('.jdx-pdf-translation iframe')?.contentDocument?.querySelector('.textLayer span'), 'open partial history without generation')
    assert(starts === 0, 'Opening partial history generated requests')
    md.getElementById('jadense-quick-start-close').click()
    await screenshot('translation-files-history', manager)
    manager.resizeTo(760, 720)
    await new Promise(resolve => main.setTimeout(resolve, 300))
    await screenshot('translation-files-history-narrow', manager)
    await screenshot('translation-files-reader', reader._iframeWindow)
    report.checks.push('pdf-only-paper-history', 'historical-versions-incomplete-and-readable-partial-state', 'mono-dual-export-action-routing', 'saved-version-reader-without-generation')
  } finally { jobs.start = originalStart; jobs.export = originalExport }
}
