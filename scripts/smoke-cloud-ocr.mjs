/** 安装包云 OCR 原生验收：隔离 profile，真实 PDF.js/设置/缓存，合成 HTTPS Provider 响应。 */
export async function verifyCloudOCR({ Zotero, reader, assert, waitFor, screenshot, report, findManager }) {
  const { IOUtils, PathUtils } = globalThis
  const main = Zotero.getMainWindow(), jobs = Zotero.__jadenseDocumentJobs
  Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown', true)
  Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
  await jobs.ready
  assert(!await IOUtils.exists(PathUtils.join(PathUtils.profileDir, 'jadense-ocr', 'v1', 'ready-2.126.0-3.9.2')), 'Expected clean OCR profile')
  let count = 0, fail = false
  const imageSizes = []
  const original = main.fetch
  main.fetch = async (url, init) => {
    if (!String(url).startsWith('https://cloud-ocr.invalid/')) return original.call(main, url, init)
    count++
    assert(init.credentials === 'omit' && init.redirect === 'error', 'Cloud credentials transport unsafe')
    const payload = JSON.parse(init.body)
    assert(payload.messages[0].content[0].image_url.url.startsWith('data:image/'), 'Cloud OCR did not render a page image')
    imageSizes.push(payload.messages[0].content[0].image_url.url.length)
    return new main.Response(JSON.stringify(fail ? { error: 'synthetic failure' } : { choices: [{ message: { content: '# Cloud OCR\n\nScientific paper 测试正文\n\n$$E=mc^2$$' }, finish_reason: 'stop' }] }), { status: fail ? 401 : 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    main.openDialog('chrome://jadense-in-zotero/content/manager.xhtml?section=settings-ocr', 'jadense-cloud-ocr-smoke', 'chrome,dialog=no,titlebar,resizable,width=1100,height=800', { zotero: Zotero, section: 'settings-ocr', pluginID: 'jadense-in-zotero@jadense.cn' })
    const manager = await waitFor(() => findManager(), 'cloud OCR settings')
    await waitFor(() => manager.document.querySelector('[data-ocr-setting="endpoint"]'), 'cloud controls')
    if (manager.document.querySelector('#jadense-quick-start-dialog')?.open) manager.document.querySelector('#jadense-quick-start-close').click()
    const root = manager.document.querySelector('.jdx-ocr-settings')
    const button = [...root.querySelectorAll('button')].find(node => /本机 OCR|Local OCR/u.test(node.textContent))
    assert(button, 'OCR engine selector missing'); button.click()
    const option = await waitFor(() => [...manager.document.querySelectorAll('[role="option"]')].find(node => node.textContent.includes('OpenAI compatible')), 'custom engine option'); option.click()
    const endpoint = root.querySelector('[data-ocr-setting="endpoint"]'), key = root.querySelector('[data-ocr-setting="key"]'), model = root.querySelector('[data-ocr-setting="model"]')
    await waitFor(() => ![...root.querySelectorAll('button')].find(node => /保存并使用|Save and use/u.test(node.textContent))?.disabled, 'configuration ready')
    endpoint.value = 'https://cloud-ocr.invalid/v1'; model.value = 'synthetic-ocr'; key.value = 'synthetic-cloud-key'
    const consent = [...root.querySelectorAll('input[type="checkbox"]')].find(node => /我同意|I agree/u.test(node.parentElement.textContent)); consent.checked = true
    const save = [...root.querySelectorAll('button')].find(node => /保存并使用|Save and use/u.test(node.textContent)); save.click()
    await waitFor(() => Zotero.Prefs.get('extensions.jadenseInZotero.ocrEngine', true) === 'custom', 'saved cloud config')
    assert(!String(Zotero.Prefs.get('extensions.jadenseInZotero.cloudOCR.custom', true)).includes('synthetic-cloud-key'), 'Secret leaked into preferences')
    const test = [...root.querySelectorAll('button')].find(node => /测试识别|Test OCR/u.test(node.textContent)); test.click()
    await waitFor(() => root.textContent.includes('连接成功') || root.textContent.includes('Connected:'), 'built-in image test')
    manager.document.getElementById('jadense-settings-tab-features').click()
    const enabled = manager.document.querySelector('[data-ocr-setting="document"]'); if (!enabled.checked) enabled.click()
    await waitFor(() => Zotero.Prefs.get('extensions.jadenseInZotero.documentOCR', true) === true, 'cloud enhancement enabled without Python')
    await screenshot('cloud-ocr-settings', manager)
    report.checks.push('cloud-settings-save', 'cloud-key-not-in-prefs', 'cloud-test-built-in-image', 'cloud-enable-without-python')
    const before = count
    const task = await jobs.start('extraction', reader.itemID, true, { useOCR: true })
    assert(task.status === 'complete', 'Cloud extraction incomplete: ' + task.warnings.join(' / ') + ' ' + (task.error || ''))
    const result = await jobs.store.extraction(task.id)
    assert(result?.ocr?.engine === 'custom' && result.markdown.includes('测试正文'), 'Cloud result or provenance missing')
    assert(count > before, 'No actual page requests')
    const after = count
    const again = await jobs.start('extraction', reader.itemID, true, { useOCR: true })
    assert(again.status === 'complete' && count === after, 'Completed cloud pages were billed again')
    report.checks.push('native-cloud-pdf-render', 'cloud-full-extraction', 'cloud-provenance', 'cloud-cache-reuse')
    // 从真实 Reader 选区入口触发增强，仅传入一个合成文字矩形。
    const { Components } = globalThis
    const view = reader._internalReader._primaryView, frame = view._iframeWindow
    await view._ensureBasicPageData(0)
    const chars = view._pdfPages[0].chars.slice(0, 20), rects = chars.map(c => c.rect).filter(Boolean)
    const rect = [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))]
    Zotero.Prefs.set('extensions.jadenseInZotero.ocrSelection', true, true)
    const selectionCount = count
    const selectionText = chars.filter(c => !c.ignorable).map(c => c.c + (c.spaceAfter || c.lineBreakAfter ? ' ' : '')).join('').trim()
    view._setSelectionRanges(Components.utils.cloneInto([{ pageIndex: 0, position: { pageIndex: 0, rects: [rect] }, sortIndex: '00000|000000|00000', text: selectionText, collapsed: false, anchor: true, head: true, anchorOffset: 0, headOffset: 20 }], reader._iframeWindow))
    const popup = await waitFor(() => reader._iframeWindow.document.querySelector('[data-jadense-reader-tools="renderTextSelectionPopup"]'), 'cloud selection popup')
    popup.querySelector('[data-jadense-action="quote"]').click()
    await Zotero.Promise.delay(1500)
    await screenshot('cloud-ocr-selection', main)
    assert(count > selectionCount, 'No selection image request')
    await waitFor(() => count > selectionCount, 'cloud selected image request')
    await Zotero.Promise.delay(300)
    assert(imageSizes.at(-1) < imageSizes[1], 'Selection uploaded a full page')
    assert(!frame.document.body.textContent.includes('选文 OCR 未完成'), 'Selection cloud OCR fell back')
    report.checks.push('native-cloud-selection', 'selection-cropped-upload')
    model.value = 'synthetic-failure'; save.click()
    await waitFor(() => String(Zotero.Prefs.get('extensions.jadenseInZotero.cloudOCR.custom', true)).includes('synthetic-failure'), 'changed cloud model')
    fail = true
    const fallback = await jobs.start('extraction', reader.itemID, true, { useOCR: true })
    assert(fallback.status === 'partial' && fallback.warnings.length, 'Cloud failure masked as success')
    assert((await jobs.store.extraction(fallback.id))?.markdown.trim(), 'Cloud failure lost the text layer')
    assert(!await IOUtils.exists(PathUtils.join(PathUtils.profileDir, 'jadense-ocr', 'v1', 'ready-2.126.0-3.9.2')), 'Cloud path installed Python')
    endpoint.value = 'https://another-cloud.invalid/v1'; endpoint.dispatchEvent(new manager.Event('input', { bubbles: true }))
    assert(!consent.checked, 'Changed endpoint retained consent')
    report.checks.push('cloud-auth-fallback', 'no-local-runtime-installed', 'endpoint-consent-invalidated')
    await screenshot('cloud-ocr-endpoint-consent', manager)
  } finally { main.fetch = original }
}
