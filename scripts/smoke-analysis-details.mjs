/** 注入隔离 Zotero companion 的详情验收；只操作合成文献及实际打包 UI。 */
export async function verifyAnalysisDetails({ manager, Zotero, task, jobs, assert, waitFor, screenshot, report, language, sibling }) {
  const doc = manager.document, detail = doc.querySelector('.jdx-analysis-detail:not([hidden])')
  const section = detail.closest('.jdx-analysis-section'), tabs = [...detail.querySelectorAll('[role="tab"]')]
  const references = detail.querySelector('.jdx-reference-details'), search = references.querySelector('input[type="search"]')
  const originalRow = references.querySelector('.jdx-reference-row'), checkbox = originalRow.querySelector('input')
  const tasksBefore = jobs.list('references').length
  const historyKey = 'extensions.jadenseInZotero.paperAnalysisHistory', savedHistory = JSON.parse(Zotero.Prefs.get(historyKey))
  const firstRecord = savedHistory.records.find(record => record.referenceTaskID === task.id)
  savedHistory.records.push({ ...firstRecord, id: 'analysis-independent-sibling', source: { ...firstRecord.source, ...sibling }, referenceTaskID: undefined, summary: '**Independent attachment** with the same title. This saved result belongs to a different PDF and has no reference extraction task.', notes: undefined })
  Zotero.Prefs.set(historyKey, JSON.stringify(savedHistory))
  assert(tabs.length === 3 && !doc.getElementById('jadense-analysis-tab-references'), 'Detail tab hierarchy is wrong')
  assert(detail.querySelector('.jdx-analysis-summary strong'), 'Summary lost safe Markdown formatting')
  assert(detail.querySelector('.jdx-note-entry blockquote') && !detail.querySelector('.jdx-note-entry button'), 'Notes lost structure or gained page navigation')
  checkbox.click(); search.value = 'Smith'; search.dispatchEvent(new manager.Event('input', { bubbles: true }))
  search.focus()
  jobs.emit()
  await Zotero.Promise.delay(150)
  assert(doc.activeElement === search && originalRow === references.querySelector('.jdx-reference-row'), 'Background task notification rebuilt reference DOM/focus')
  assert(references.querySelectorAll('.jdx-reference-row:not([hidden])').length === 2, 'Reference search did not filter')
  tabs[0].click(); tabs[1].click(); tabs[2].click()
  assert(search.value === 'Smith' && checkbox.checked, 'Tab switch lost search/selection')
  const filter = references.querySelector('[id$="-filter"]')
  filter.querySelector('.jdx-select-trigger').click()
  filter.querySelectorAll('[role="option"]')[2].click()
  assert(references.querySelectorAll('.jdx-reference-row:not([hidden])').length === 0, 'Status filter did not combine with search')
  tabs[0].click(); tabs[2].click()
  assert(references.querySelectorAll('.jdx-reference-row:not([hidden])').length === 0 && checkbox.checked, 'Status filter or hidden selection was lost')
  filter.querySelector('.jdx-select-trigger').click(); filter.querySelector('[role="option"]').click()
  search.value = ''; search.dispatchEvent(new manager.Event('input', { bubbles: true }))
  const key = value => doc.activeElement.dispatchEvent(new manager.KeyboardEvent('keydown', { key: value, bubbles: true }))
  tabs[0].focus(); key('End'); assert(doc.activeElement === tabs[2] && tabs[2].getAttribute('aria-selected') === 'true', 'End tab navigation failed')
  key('Home'); key('ArrowRight'); assert(doc.activeElement === tabs[1], 'Home/Arrow tab navigation failed')
  const chromeWidth = manager.outerWidth - manager.innerWidth, chromeHeight = manager.outerHeight - manager.innerHeight
  for (const theme of ['light', 'dark']) {
    Zotero.Prefs.set('extensions.jadenseInZotero.theme', theme, true)
    for (const [width, height, size] of [[1360, 860, 13], [760, 620, 24]]) {
      Zotero.Prefs.set('extensions.jadenseInZotero.fontSize', String(size), true)
      manager.resizeTo(width + chromeWidth, height + chromeHeight)
      await waitFor(() => manager.innerWidth === width && manager.innerHeight === height, 'analysis detail viewport')
      await Zotero.Promise.delay(150)
      for (let index = 0; index < tabs.length; index++) {
        tabs[index].click(); tabs[index].focus({ preventScroll: true }); section.scrollTop = 0
        assert(section.scrollWidth <= section.clientWidth + 2, `Analysis detail overflow at ${width}/${size}/${index}`)
        if (size === 24) section.scrollTop += tabs[index].getBoundingClientRect().top - section.getBoundingClientRect().top - 8
        await Zotero.Promise.delay(150)
        if (size === 24) assert(tabs[index].getBoundingClientRect().bottom < 160, 'Sticky tabs are not reachable in the compact reading viewport')
        await screenshot(`analysis-detail-${language}-${theme}-${width}-${size}-${['summary', 'notes', 'references'][index]}`, manager)
      }
      section.scrollTop = section.scrollHeight
      await Zotero.Promise.delay(150)
      const trigger = references.querySelector('[id$="-collection"] .jdx-select-trigger')
      const scrollEvents = [], beforeScroll = section.scrollTop
      const captureScroll = event => scrollEvents.push({ id: event.target?.id, className: event.target?.className })
      doc.addEventListener('scroll', captureScroll, true)
      trigger.click()
      await Zotero.Promise.delay(150)
      doc.removeEventListener('scroll', captureScroll, true)
      const popup = references.querySelector('[id$="-collection"] .jdx-select-popup')
      const bounds = popup.getBoundingClientRect()
      assert(bounds.width > 0 && bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1, `Reference collection popup escaped the window: ${JSON.stringify({ left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, open: trigger.getAttribute('aria-expanded'), beforeScroll, afterScroll: section.scrollTop, scrollEvents })}`)
      await screenshot(`analysis-detail-${language}-${theme}-${width}-${size}-select`, manager)
      trigger.click()
      const saved = section.scrollTop
      tabs[0].click(); tabs[2].click()
      assert(Math.abs(section.scrollTop - saved) < 2 && checkbox.checked, 'Reference reading position/selection was lost')
    }
  }
  detail.querySelector('.jdx-detail-navigation button').click()
  const title = doc.activeElement
  assert(title?.classList.contains('jdx-analysis-title'), 'Back did not restore history focus')
  const siblingTitle = [...doc.querySelectorAll('.jdx-analysis-title')].find(button => button !== title && button.textContent === title.textContent)
  assert(siblingTitle, 'Same-title PDF attachments were merged in history')
  section.scrollTop = 40
  const listScroll = section.scrollTop
  assert(listScroll > 0, 'History fixture did not exercise a real scroll position')
  await screenshot(`analysis-history-${language}-dark-760-24`, manager)
  title.click(); detail.querySelector('.jdx-detail-navigation button').click()
  assert(doc.activeElement === title && section.scrollTop === listScroll, 'History scroll/focus was not restored')
  title.click(); tabs[2].click()
  // 挂起第一篇的真实读取返回，再切换同名的另一附件，迟到数据不得污染当前详情。
  const readReferences = jobs.store.references.bind(jobs.store)
  let releaseRead
  const delayed = new Promise(resolve => { releaseRead = resolve })
  jobs.store.references = async id => { if (id === task.id) await delayed; return readReferences(id) }
  try {
    jobs.emit(); detail.querySelector('.jdx-detail-navigation button').click(); siblingTitle.click()
    const otherDetail = doc.querySelector('.jdx-analysis-detail:not([hidden])'), otherTabs = [...otherDetail.querySelectorAll('[role="tab"]')]
    assert(otherDetail.querySelector('.jdx-analysis-summary').textContent.includes('Independent attachment'), 'Same-title paper opened another summary')
    otherTabs[2].click(); releaseRead(); await Zotero.Promise.delay(150)
    assert(!otherDetail.querySelector('.jdx-reference-row'), 'Late reference read contaminated another PDF')
    const visibleActions = [...otherDetail.querySelectorAll('.jdx-reference-tools button')].filter(button => !button.hidden && !button.disabled)
    assert(visibleActions.length === 1 && /提取参考文献|Extract references/.test(visibleActions[0].textContent), 'Empty reference task exposes pause or verification')
    otherDetail.querySelector('.jdx-detail-navigation button').click(); title.click(); tabs[2].click()
  } finally { releaseRead(); jobs.store.references = readReferences }
  assert(checkbox.checked && tasksBefore === jobs.list('references').length, 'Read-only navigation created tasks or lost state')
  report.checks.push('analysis-same-title-pdf-isolation', 'analysis-late-reference-read-isolation', 'analysis-empty-reference-actions')
  Zotero.Prefs.set('extensions.jadenseInZotero.fontSize', '13', true)
  manager.resizeTo(1360 + chromeWidth, 860 + chromeHeight)
  const all = references.querySelector('.jdx-reference-import input'), save = references.querySelector('.jdx-reference-import>button')
  all.click(); assert(save.textContent.includes('2') && !save.disabled, 'Select importable did not select verified references')
  save.click(); save.click()
  assert(save.disabled && references.querySelector('[id$="-library"] .jdx-select-trigger').disabled, 'Import did not lock submit and destination snapshot')
  await waitFor(() => references.querySelector('.jdx-notice[data-kind="success"]')?.textContent.includes('2'), 'reference import feedback')
  const entries = await jobs.store.references(task.id)
  assert(entries.filter(entry => entry.imported).length === 2 && save.disabled, 'Import result/selection cleanup failed')
  report.checks.push('analysis-detail-three-tabs', 'analysis-detail-safe-summary-and-structured-notes', 'analysis-reference-stable-dom-focus', 'analysis-reference-search-filter-selection', 'analysis-detail-keyboard-tabs', 'analysis-detail-light-dark-compact-max-font', 'analysis-reference-popup-bounds', 'analysis-detail-tab-reading-position', 'analysis-history-return-scroll-focus', 'analysis-browse-zero-new-tasks', 'analysis-reference-ui-import-snapshot-double-submit')
}
