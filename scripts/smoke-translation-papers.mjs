/** 隔离 profile 内核对公开论文的真实文字层；只读取本地指定 PDF，不调用外部模型。 */
/* global PathUtils */
export async function verifyTranslationPapers({ Zotero, jobs, directory, report, assert }) {
  report.publicPapers = []
  for (const name of ['attention', 'resnet']) {
    const attachment = await Zotero.Attachments.importFromFile({ file: PathUtils.join(directory, `${name}.pdf`), contentType: 'application/pdf' })
    const reader = await Zotero.Reader.open(attachment.id)
    await reader._initPromise
    const task = await jobs.start('translation', attachment.id)
    jobs.pause(task.id); await jobs.idle()
    const pages = await Promise.all(Array.from({ length: task.totalPages }, (_, i) => jobs.store.page(task.id, i)))
    const paragraphs = pages.flatMap(page => page.paragraphs)
    const rawIDs = pages.flatMap(page => page.lines.map(line => line.id))
    const keptIDs = paragraphs.flatMap(paragraph => paragraph.lineIDs)
    const excludedIDs = pages.flatMap(page => page.excludedLines.map(line => line.id))
    assert(new Set(keptIDs).size === keptIDs.length, `${name}: duplicate source lines`)
    assert(rawIDs.length === keptIDs.length + excludedIDs.length && rawIDs.every(id => keptIDs.includes(id) || excludedIDs.includes(id)), `${name}: dropped source lines`)
    const summary = {
      name, totalPages: pages.length, rawLines: rawIDs.length, paragraphs: paragraphs.length,
      excludedLines: excludedIDs.length, headings: paragraphs.filter(p => p.heading).map(p => p.text),
      crossPageParagraphs: paragraphs.filter(p => p.locations.length > 1).map(p => ({ text: p.text, pages: p.locations.map(location => location.pageIndex + 1) })),
      // 仅保存在隔离测试报告中用于人工核对，不将全文写入仓库。
      firstPages: pages.slice(0, 4).map(page => ({ page: page.pageIndex + 1, paragraphs: page.paragraphs.map(p => ({ text: p.text, heading: p.heading, rects: p.rects })) })),
    }
    report.publicPapers.push(summary)
    const prefix = name === 'attention' ? 'Recurrent neural networks' : 'Deeper neural networks'
    const paragraph = paragraphs.find(p => p.text.startsWith(prefix))
    assert(paragraph?.text.length > 300, `${name}: opening argument was fragmented`)
    if (name === 'attention') {
      const definition = paragraphs.find(p => p.text.startsWith('An attention function can'))
      assert(definition?.text.includes('weighted sum of the values') && !definition.text.includes('Scaled Dot-Product Attention'), 'A floating figure interrupted the cross-page definition')
      const multihead = paragraphs.find(p => p.text.startsWith('Instead of performing'))
      assert(multihead?.text.includes('output values.') && !multihead.text.includes('4To illustrate'), 'A footnote interrupted the cross-page argument')
      assert(paragraphs.find(p => p.text.startsWith('4To illustrate'))?.locations.length === 1, 'A bottom footnote was merged into the next page')
      assert(!paragraphs.filter(p => p.locations.length > 1).some(p => p.text.includes('train PPL BLEU params')), 'A table header was merged into body text')
    }
  }
  report.checks.push('public-single-and-two-column-pdf-source-coverage')
}
