/** 隔离 Zotero profile 中以真实 Manager/Preferences 表单验证空引擎跨盘位置切换。 */
/* global IOUtils, PathUtils */
export async function verifyEngineStorage({ Zotero, assert, waitFor, screenshot, report, findManager, findWindowContaining, config }) {
  const main = Zotero.getMainWindow(), io = IOUtils, paths = PathUtils
  const parent = paths.join(config.engineStorageParent || paths.join(config.screenshotDir, 'external-engine-storage'), paths.filename(config.screenshotDir))
  const rows = (doc, kind) => doc.querySelector(`[data-engine-storage="${kind}"]`)
  const controls = row => ({ input: row.querySelector('input'), save: row.querySelector('.jdx-button-primary'), reset: [...row.querySelectorAll('button')].find(button => /默认|default/iu.test(button.textContent)), browse: [...row.querySelectorAll('button')].find(button => /浏览|Browse/iu.test(button.textContent)) })
  const setDraft = (win, row, value) => {
    const control = controls(row)
    control.input.value = value
    control.input.dispatchEvent(new win.Event('input', { bubbles: true }))
    assert(!control.save.disabled && row.textContent.includes(value), 'Typed parent was not previewed before save')
    return control
  }
  const save = async (win, row, value, root) => {
    const control = setDraft(win, row, value)
    control.save.click()
    await waitFor(() => /已迁移|Storage moved|没有变化|unchanged/iu.test(row.querySelector('[role="status"]')?.textContent || '') || (!control.save.disabled && row.querySelector('[role="status"]')?.dataset.kind === 'error'), 'engine storage save', 120000)
    assert(await io.exists(paths.join(root, '.jadense-storage-id')), 'Storage marker was not saved at selected location: ' + row.querySelector('[role="status"]')?.textContent)
    assert(row.textContent.includes(root), 'Settings did not show the active location')
  }
  Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown', true)
  main.openDialog('chrome://jadense-in-zotero/content/manager.xhtml?section=settings-ocr', 'jadense-storage-smoke', 'chrome,dialog=no,titlebar,resizable,width=1000,height=850', { zotero: Zotero, section: 'settings-ocr', pluginID: config.pluginID })
  const manager = await waitFor(findManager, 'engine storage Manager')
  const doc = manager.document
  if (doc.querySelector('#jadense-quick-start-dialog')?.open) doc.getElementById('jadense-quick-start-close').click()
  await waitFor(() => rows(doc, 'ocr') && rows(doc, 'pdf'), 'both engine storage rows')
  const ocr = rows(doc, 'ocr'), pdf = rows(doc, 'pdf')
  assert(ocr.querySelector('label')?.htmlFor === controls(ocr).input.id && pdf.querySelector('label')?.htmlFor === controls(pdf).input.id, 'Storage text fields need accessible labels')
  assert(controls(ocr).browse && controls(pdf).browse, 'Native folder pickers are missing')
  doc.querySelector('[data-settings-target="layout"]')?.click()
  const pdfParent = paths.join(parent, 'PDF'), pdfRoot = paths.join(pdfParent, 'jadense-pdf-translation')
  const ocrParent = paths.join(parent, 'OCR'), ocrRoot = paths.join(ocrParent, 'jadense-ocr', 'v1')
  await waitFor(() => !Zotero.__jadensePDFTranslationJobs?.storageBusyReason(), 'idle PDF history scan')
  const taskID = 'a'.repeat(64), taskRelative = ['tasks', taskID, 'artifact.json'], cacheRelative = ['cache', 'recognition.json']
  const profilePDF = paths.join(config.profileDir, 'jadense-pdf-translation'), profileOCR = paths.join(config.profileDir, 'jadense-ocr', 'v1')
  await io.makeDirectory(paths.join(profilePDF, 'tasks', taskID), { ignoreExisting: true })
  await io.writeUTF8(paths.join(profilePDF, ...taskRelative), '{"revision":"synthetic-pdf-result"}')
  await io.makeDirectory(paths.join(profileOCR, 'cache'), { ignoreExisting: true })
  await io.writeUTF8(paths.join(profileOCR, ...cacheRelative), '{"revision":"synthetic-ocr-cache"}')
  setDraft(manager, pdf, pdfParent)
  assert(!Zotero.Prefs.get('extensions.jadenseInZotero.pdfEngineStorage', true), 'Editing a draft changed the PDF preference')
  await save(manager, pdf, pdfParent, pdfRoot)
  assert(await io.readUTF8(paths.join(pdfRoot, ...taskRelative)) === '{"revision":"synthetic-pdf-result"}', 'PDF result did not move intact')
  assert(Zotero.Prefs.get('extensions.jadenseInZotero.pdfEngineStorage', true), 'Manager PDF save did not persist its location')
  doc.querySelector('[data-settings-target="ocr"]')?.click()
  await waitFor(() => doc.querySelector('[data-ocr-action="stop"]')?.hidden, 'idle OCR settings')
  await save(manager, ocr, ocrParent, ocrRoot)
  assert(await io.readUTF8(paths.join(ocrRoot, ...cacheRelative)) === '{"revision":"synthetic-ocr-cache"}', 'OCR cache did not move intact')
  assert(Zotero.Prefs.get('extensions.jadenseInZotero.ocrEngineStorage', true), 'Manager OCR save did not persist its location')
  assert(paths.normalize(pdfRoot) !== paths.normalize(ocrRoot), 'Engine locations were not independent')
  await screenshot('engine-storage-manager', manager)
  manager.resizeTo(760, 850)
  await new Promise(resolve => main.setTimeout(resolve, 350))
  assert(pdf.scrollWidth <= pdf.clientWidth + 2 && ocr.scrollWidth <= ocr.clientWidth + 2, 'Storage fields overflow narrow Manager')
  await screenshot('engine-storage-manager-narrow', manager)
  Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
  await new Promise(resolve => main.setTimeout(resolve, 300))
  await screenshot('engine-storage-manager-light', manager)
  Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'dark', true)
  manager.close()
  await Promise.resolve(Zotero.Utilities.Internal.openPreferences('jadense-in-zotero-preferences'))
  const preferences = await waitFor(() => findWindowContaining('jadense-in-zotero-preferences-pane'), 'native engine preferences')
  const nativeDoc = preferences.document
  await waitFor(() => rows(nativeDoc, 'ocr') && rows(nativeDoc, 'pdf'), 'native engine storage rows')
  for (const [kind, root] of [['pdf', paths.join(config.profileDir, 'jadense-pdf-translation')], ['ocr', paths.join(config.profileDir, 'jadense-ocr', 'v1')]]) {
    if (kind === 'ocr') await waitFor(() => nativeDoc.querySelector('[data-ocr-action="stop"]')?.hidden, 'idle native OCR settings', 120000)
    const row = rows(nativeDoc, kind), control = controls(row)
    control.reset.click()
    assert(!control.save.disabled && row.textContent.includes(root), 'Restore default did not preview the profile location')
    control.save.click()
    await waitFor(() => ['success', 'error'].includes(row.querySelector('[role="status"]')?.dataset.kind), 'default engine migration status', 120000)
    assert(row.querySelector('[role="status"]').dataset.kind === 'success', `Default ${kind} migration failed: ${row.querySelector('[role="status"]')?.textContent}`)
    assert(!Zotero.Prefs.get(`extensions.jadenseInZotero.${kind === 'pdf' ? 'pdfEngineStorage' : 'ocrEngineStorage'}`, true), `Default ${kind} preference remained custom`)
    assert(await io.exists(root), `Default ${kind} profile engine folder was not restored: ${row.querySelector('[role="status"]')?.textContent}; pref=${Zotero.Prefs.get(`extensions.jadenseInZotero.${kind === 'pdf' ? 'pdfEngineStorage' : 'ocrEngineStorage'}`, true)}`)
  }
  assert(!await io.exists(pdfRoot) && !await io.exists(ocrRoot), 'Old managed engine folders were not cleaned')
  assert(await io.readUTF8(paths.join(profilePDF, ...taskRelative)) === '{"revision":"synthetic-pdf-result"}'
    && await io.readUTF8(paths.join(profileOCR, ...cacheRelative)) === '{"revision":"synthetic-ocr-cache"}', 'Engine data changed after returning to defaults')
  rows(nativeDoc, 'ocr').scrollIntoView({ block: 'center' })
  await new Promise(resolve => main.setTimeout(resolve, 250))
  await screenshot('engine-storage-native', preferences)
  preferences.close()
  report.checks.push('engine-storage-manager-and-native-text-save-reset', 'engine-storage-new-parent-and-cleanup', 'engine-storage-independent-engines')
}
