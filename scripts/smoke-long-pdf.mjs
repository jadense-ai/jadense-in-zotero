/** 长 PDF 的真实 XPI 验收：生成合成 PDF，使用生产 ChatRuntime 和本机模型 stub。 */
/* global IOUtils, PathUtils */
export function longPdfFixture(count = 81) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${count} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (let i = 0; i < count; i++) {
    const lines = i === count - 1 ? ['TAIL_UNIQUE_FACT = 7391', 'Appendix conclusion on the last page.'] : Array.from({ length: 35 }, (_, line) => `Page ${i + 1} line ${line + 1}: ordinary experimental evidence and limitations.`)
    const stream = 'BT /F1 10 Tf 45 740 Td\n' + lines.map((line, index) => `${index ? '0 -18 Td ' : ''}(${line}) Tj`).join('\n') + '\nET'
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'ascii')
}

export async function verifyLongPdf({ Zotero, manager, config, assert, waitFor, screenshot, report }) {
  const doc = manager.document
  doc.getElementById('jadense-quick-start-close')?.click()
  doc.getElementById('jadense-manager-nav-chat').click()
  Zotero.Prefs.set('extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, activeProviderId: 'long-provider', activeModelId: 'long-model',
    providers: [{ id: 'long-provider', name: 'Local stub', protocol: 'openai-chat-completions', baseUrl: config.origin + '/v1', apiKey: config.token }],
    models: [{ id: 'long-model', providerId: 'long-provider', name: 'Long PDF stub', model: 'synthetic-long-pdf', contextWindow: 16384, maxOutputTokens: 4096 }] }))
  Zotero.Prefs.set('extensions.jadenseInZotero.chatModel', JSON.stringify({ route: 'byok', modelId: 'long-model' }))
  const attachment = await Zotero.Attachments.importFromFile({ file: config.longPdfPath, libraryID: Zotero.Libraries.userLibraryID, contentType: 'application/pdf' })
  const reader = await Zotero.Reader.open(attachment.id); await reader._initPromise
  const runtime = await waitFor(() => Zotero.__jadenseChatRuntime, 'shared chat runtime')
  // 真实宿主比较旧后台纯文字接口与当前全页关联；模型尚未调用。
  const workerStart = Date.now()
  const workerText = await Zotero.PDFWorker.getFullText(attachment.id, 80)
  const workerMs = Date.now() - workerStart
  const nativeStart = Date.now()
  for (let page = 0; page < 81; page++) await reader._internalReader._primaryView._ensureBasicPageData(page)
  const nativePageDataMs = Date.now() - nativeStart
  const extractionStart = Date.now()
  const sessionID = await runtime.create(attachment.id)
  report.textExtractionPerformance = { pages: 81, workerPages: workerText.extractedPages, workerMs, nativePageDataMs, associationWithNativePagesReadyMs: Date.now() - extractionStart }
  const state = () => JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState'))
  const session = () => state().sessions.find(row => row.id === sessionID)
  assert(session().sources[0].document?.totalPages === 81 && !session().sources[0].text, 'Native association did not cache all 81 pages separately')
  const snapshot = state(); snapshot.activeSessionId = sessionID
  Zotero.Prefs.set('extensions.jadenseInZotero.localChatState', JSON.stringify(snapshot))
  const sessionButton = await waitFor(() => [...doc.querySelectorAll('.jdx-chat-session-button')].find(row => row.dataset.sessionId === sessionID), 'long PDF session button')
  sessionButton.click()
  const root = PathUtils.join(Zotero.Profile.dir, 'jadense-chat-documents', session().sources[0].document.id)
  const tail = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, 'page-80.json')))
  assert(tail.paragraphs.some(row => row.text.includes('7391')), 'Native page 81 cache lost the unique fact')
  // 保留真实提取、历史和原生写入，仅替换模型响应，验证标签及无坐标 OCR 回退。
  const analysis = await waitFor(() => Zotero.__jadenseAnalysisRuntime, 'analysis runtime')
  const analyze = () => analysis.run({ zotero: Zotero, itemID: attachment.id, signal: new manager.AbortController().signal, fetchImpl: manager.fetch.bind(manager), services: {
    send: async request => {
      const data = JSON.parse(request.messages[0].text.split('\n').at(-1))
      return JSON.stringify({ summary: 'Synthetic analysis', annotations: [{ passageId: data.passages[0].id, category: 'claim', comment: 'Synthetic evidence note' }] })
    },
  } })
  const traditional = await analyze()
  assert(traditional.annotations.created === 1, 'Traditional extraction did not create a native annotation')
  const annotation = attachment.getAnnotations().find(row => row.annotationComment?.includes('Synthetic evidence note'))
  assert(annotation && !annotation.getTags().some(row => row.tag === 'Jadense AI') && annotation.getTags().some(row => row.tag === 'Jadense AI/claim'), 'Native category tags or standalone tag removal failed')
  Zotero.Prefs.set('extensions.jadenseInZotero.documentOCR', true, true)
  Zotero.Prefs.set('extensions.jadenseInZotero.ocrEngine', 'siliconflow', true)
  try {
    const fallback = await analyze()
    assert(fallback.annotations.skipped === 1 && fallback.annotations.created === 0, 'Fallback lost annotation deduplication')
    assert(fallback.record.warnings.some(row => /有效位置|usable positions/u.test(row)), 'OCR fallback warning was not retained')
  } finally {
    Zotero.Prefs.set('extensions.jadenseInZotero.documentOCR', false, true)
    Zotero.Prefs.clear('extensions.jadenseInZotero.ocrEngine', true)
  }
  report.checks.push('native-analysis-category-tags', 'native-analysis-ocr-fallback-warning', 'native-analysis-category-deduplication')
  const send = async () => {
    await runtime.send({ sessionID, prompt: '第 81 页的 TAIL_UNIQUE_FACT 是多少？' })
    assert(session().messages.at(-1)?.text.includes('7391'), `Tail-page answer failed: ${runtime.status}`)
    assert(session().messages.at(-1)?.reading?.sources[0]?.pages.some(row => row.pageIndex === 80), 'Tail page was not in request reading coverage')
  }
  await send()
  const defaultState = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, 'chat.json')))
  assert(!Object.values(defaultState.summaries).some(row => row.text), 'Default long-PDF chat unexpectedly summarized the document')
  Zotero.Prefs.set('extensions.jadenseInZotero.chatLongDocumentMode', 'summarize')
  await send()
  const summaryState = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, 'chat.json')))
  assert(Object.values(summaryState.summaries).some(row => row.text), 'Explicit long-document summary was not saved')
  await waitFor(() => doc.querySelector('[data-document-reading]'), 'reading coverage UI')
  const details = [...doc.querySelectorAll('[data-document-reading]')].at(-1); details.open = true
  const button = [...details.querySelectorAll('button')].find(row => row.textContent.includes('81'))
  assert(button, 'Tail-page navigation button missing'); button.click()
  await waitFor(() => reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentPageNumber === 81, 'native navigation to page 81')
  doc.getElementById('jadense-quick-start-close')?.click()
  assert(!doc.getElementById('jadense-chat-source-summary')?.textContent.includes('无可读正文'), 'Cached PDF incorrectly displayed as unreadable')
  await screenshot('long-pdf-reading-coverage', manager)
  Zotero.Prefs.set('extensions.jadenseInZotero.theme', 'light', true)
  await Zotero.Promise.delay(200)
  await screenshot('long-pdf-reading-coverage-light', manager)
  report.checks.push('native-81-page-extraction', 'native-tail-page-cache', 'native-long-pdf-budgeted-request', 'native-default-long-pdf-no-summary', 'native-opt-in-summary-cache', 'native-followup-tail-evidence', 'native-page-81-navigation')
}

/** 第二次原生启动直接恢复会话与磁盘缓存；启动/浏览不能发起整理调用。 */
export async function verifyLongPdfRestart({ Zotero, config, assert, report }) {
  const state = JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState'))
  const session = state.sessions.find(row => row.sources.some(source => source.document?.totalPages === 81))
  assert(session, 'Restart lost the linked document reference')
  const win = Zotero.getMainWindow().openDialog('chrome://jadense-in-zotero/content/manager.xhtml?section=chat', 'long-pdf-restart', 'chrome,dialog=no,resizable,width=1000,height=750', { zotero: Zotero, section: 'chat', pluginID: config.pluginID })
  try {
    for (let attempt = 0; attempt < 100 && !Zotero.__jadenseChatRuntime; attempt++) await Zotero.Promise.delay(100)
    const runtime = Zotero.__jadenseChatRuntime
    assert(runtime, 'Restart did not create ChatRuntime')
    await runtime.send({ sessionID: session.id, prompt: '第 81 页的 TAIL_UNIQUE_FACT 是多少？' })
    const restored = JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState')).sessions.find(row => row.id === session.id)
    assert(restored.messages.at(-1)?.text.includes('7391'), `Restart answer failed: ${runtime.status}`)
    report.checks.push('native-cold-restart-tail-evidence')
  } finally { win.close() }
}
