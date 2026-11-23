/** 文献级工作区：按父条目列出成果，详情按附件阅读；旧解析组件保留为成果子视图。 */
import { readTranslationHistory, TRANSLATION_HISTORY_PREF_KEY } from '@/chat/translation-history'
import { PAPER_ANALYSIS_HISTORY_PREF_KEY, type PaperAnalysisSource } from '@/chat/paper-analysis-history'
import { literaturePapers, paperKey, type LiteraturePaper } from './analysis-workspace-model'
import { mountDocumentResults, resultLabels, resultStatus, sameAttachment, type AnalysisOptions, type DocumentResultMode } from './document-results'
import type { AnalysisDetailTab, AnalysisRunView } from './analysis-workspace'
import { pdfTranslationJobs } from './pdf-translation-jobs'
import { simpleReadingJobs } from './simple-reading-jobs'
import { openSavedSimpleReading } from './simple-reading'
import { mountSimpleReadingHistory } from './simple-reading-history'
import { mountPDFTranslationFiles, pdfFileStatus } from './pdf-translation-files'
import { documentJobs } from './document-jobs'
import { actionIcon, element, action, badge, bindTabs } from './ui/controls'
import { createJdxSelect } from './ui/select'
import { uiText } from './ui-preferences'
import { translationLanguageDisplayLabel } from '@/chat/translation-languages'
import type { ZoteroLike } from './runtime'

type LiteratureTab = Exclude<DocumentResultMode, 'analysis'> | AnalysisDetailTab | 'history' | 'files' | 'simple'

export function mountLiteratureWorkspace(root: HTMLElement, host: ZoteroLike, options: AnalysisOptions) {
  const doc = root.ownerDocument, jobs = documentJobs(host), pdfs = pdfTranslationJobs(host), section = root.closest<HTMLElement>('.jdx-analysis-section') || root
  const readings = simpleReadingJobs(host)
  root.classList.add('jdx-literature-workspace')
  const toolbar = element(doc, 'div', 'jdx-result-tools'), search = element(doc, 'input', 'jdx-search'), list = element(doc, 'div', 'jdx-analysis-list'), detail = element(doc, 'article', 'jdx-literature-detail')
  search.type = 'search'; search.placeholder = uiText('搜索文献与成果', 'Search papers and results'); search.setAttribute('aria-label', search.placeholder)
  const searchField = element(doc, 'div', 'jdx-literature-search'); searchField.append(search); toolbar.append(searchField); root.replaceChildren(toolbar, list, detail); detail.hidden = true
  const title = element(doc, 'h2', 'jdx-literature-heading'), metadata = element(doc, 'p', 'jdx-literature-meta'), attachmentHost = element(doc, 'div', 'jdx-literature-attachment'), nav = element(doc, 'div', 'jdx-result-tools')
  const feedback = element(doc, 'div', 'jdx-literature-feedback')
  feedback.setAttribute('role', 'status')
  const attachments = createJdxSelect(attachmentHost, { compact: true, portal: true, ariaLabel: uiText('PDF 附件', 'PDF attachment'), popupWidth: 320 })
  const backButton = action(doc, uiText('← 文献列表', '← Papers'), back)
  nav.append(backButton, attachmentHost, action(doc, uiText('打开原文', 'Open PDF'), () => {
    if (!source) return
    feedback.textContent = ''
    void options.openSource(source).then(ok => { if (!ok) feedback.textContent = uiText('原 PDF 不可用，已保存的成果仍可阅读。', 'The original PDF is unavailable. Saved results remain readable.') }).catch(error => { feedback.textContent = String(error) })
  }))
  actionIcon(backButton, 'back')
  actionIcon(nav.lastElementChild as HTMLButtonElement, 'open')
  nav.append(action(doc, uiText('简阅模式', 'Reading mode'), () => {
    if (!source) return
    feedback.textContent = ''
    void openSavedSimpleReading(host, source).catch(error => { feedback.textContent = String(error) })
  }))
  const tabsHost = element(doc, 'div', 'jdx-tabs'), panels = element(doc, 'div', 'jdx-literature-panels')
  tabsHost.setAttribute('role', 'tablist'); tabsHost.setAttribute('aria-label', uiText('文献成果', 'Paper results'))
  const labels = { ...resultLabels(), simple: uiText('简阅译文', 'Reading translations'), files: uiText('对照翻译', 'Bilingual PDF'), summary: uiText('解析总结', 'Summary'), notes: uiText('解析笔记', 'Analysis notes'), references: uiText('参考文献', 'References'), history: uiText('历史', 'History') }, modes: LiteratureTab[] = [ 'files', 'simple', 'translation', 'selection', 'summary', 'notes', 'references', 'history']
  const tabs = modes.map(mode => { const button = action(doc, labels[mode], () => {}); button.setAttribute('role', 'tab'); button.id = `jdx-literature-tab-${mode}`; button.setAttribute('aria-controls', `jdx-literature-panel-${mode}`); tabsHost.append(button); return button })
  const hero = element(doc, 'header', 'jdx-literature-hero'); hero.append(title, metadata)
  detail.append(nav, hero, tabsHost, feedback, panels)
  const mounted = new Map<string, { root: HTMLElement; view?: ReturnType<typeof mountDocumentResults>; files?: ReturnType<typeof mountPDFTranslationFiles>; simple?: ReturnType<typeof mountSimpleReadingHistory>; scroll: number }>()
  const runs = new Map<string, AnalysisRunView>(), opened = new Map<string, PaperAnalysisSource>()
  let papers: LiteraturePaper[] = [], current: LiteraturePaper | undefined, source: PaperAnalysisSource | undefined, active: LiteratureTab = 'summary', selectedKey = '', savedScroll = 0, disposed = false, sequence = 0
  const recordIDs = new Map<string, string>(), buttons = new Map<string, HTMLButtonElement>()
  const listRows = new Map<string, { root: HTMLElement; state: HTMLElement; date: HTMLElement; meta: HTMLElement }>()
  const empty = element(doc, 'div', 'jdx-result-empty'), emptyText = element(doc, 'p')
  const clearSearch = action(doc, uiText('清除搜索', 'Clear search'), () => { search.value = ''; refresh(); search.focus() })
  empty.append(emptyText, clearSearch); list.append(empty)
  const loadNotices = element(doc, 'div', 'jdx-literature-load-notices')
  toolbar.after(loadNotices)
  const analyses = historyIndex(options.records, uiText('暂时无法读取解析记录。', 'Analysis records could not be loaded.'))
  const selections = historyIndex(() => host.Prefs ? readTranslationHistory(host.Prefs).records : [], uiText('暂时无法读取选中翻译。', 'Selection translations could not be loaded.'))
  /** 各来源保留上一次索引快照；暂不可读时只重试对应来源，不影响其余历史。 */
  function historyIndex<T>(read: () => T[], failure: string) {
    let last: T[] = []
    const warning = element(doc, 'div', 'jdx-literature-load-warning', failure)
    warning.setAttribute('role', 'status')
    warning.append(action(doc, uiText('重试读取', 'Retry loading'), () => { warning.remove(); refresh() }))
    return () => {
      if (!warning.parentElement) {
        try { last = read() } catch { loadNotices.append(warning) }
      }
      return last
    }
  }
  function clearViews() { for (const entry of mounted.values()) { entry.view?.remove(); entry.files?.remove(); entry.simple?.remove() }; mounted.clear(); panels.replaceChildren() }
  function show(requested: DocumentResultMode | LiteratureTab, recordID?: string) {
    const mode: LiteratureTab = requested === 'analysis' ? (recordID && jobs.get(recordID)?.kind === 'references' ? 'references' : 'summary') : requested
    const analysisTab = mode === 'summary' || mode === 'notes' || mode === 'references' ? mode : undefined
    if (!source || !current) return
    const previous = [...mounted.values()].find(entry => !entry.root.hidden)
    if (previous) previous.scroll = previous.root.scrollTop
    // 总结和笔记来自同一解析记录；保留实际选中的版本，包括子视图里的版本切换。
    const previousRecordID = previous?.view?.selectedRecordID()
    if ((active === 'summary' || active === 'notes') && previousRecordID && previous === mounted.get(`${paperKey(source)}:${active}`)) {
      for (const tab of ['summary', 'notes']) recordIDs.set(`${paperKey(source)}:${tab}`, previousRecordID)
    }
    active = mode
    const tabMode = mode === 'source' ? 'history' : mode
    tabs.forEach((tab, index) => { tab.setAttribute('aria-selected', String(modes[index] === tabMode)); tab.tabIndex = modes[index] === tabMode ? 0 : -1 })
    const key = `${paperKey(source)}:${mode}`
    const sharedAnalysis = mode === 'summary' || mode === 'notes'
    if (sharedAnalysis) {
      recordID ??= recordIDs.get(key)
      if (recordID) for (const tab of ['summary', 'notes']) recordIDs.set(`${paperKey(source)}:${tab}`, recordID)
    }
    if (recordID && (sharedAnalysis ? mounted.get(key)?.view?.selectedRecordID() : recordIDs.get(key)) !== recordID) { mounted.get(key)?.view?.remove(); mounted.get(key)?.files?.remove(); mounted.get(key)?.simple?.remove(); mounted.get(key)?.root.remove(); mounted.delete(key); recordIDs.set(key, recordID) }
    for (const [name, panel] of mounted) panel.root.hidden = name !== key
    let panel = mounted.get(key)
    if (!panel) {
      const container = element(doc, 'section', 'jdx-literature-panel'); container.setAttribute('role', 'tabpanel'); container.id = `jdx-literature-panel-${mode}-${++sequence}`; container.setAttribute('aria-labelledby', `jdx-literature-tab-${tabMode}`)
      panels.append(container); panel = { root: container, scroll: 0 }; mounted.set(key, panel)
      if (mode === 'files') panel.files = mountPDFTranslationFiles(container, host, source, recordIDs.get(key))
      else if (mode === 'simple') panel.simple = mountSimpleReadingHistory(container, host, source)
      else if (mode !== 'history') {
        panel.view = mountDocumentResults(container, host, source, analysisTab ? 'analysis' : mode as DocumentResultMode, {
          recordID: recordIDs.get(key), analysis: options, analysisTab, hideAnalysisTabs: true,
          onTranslate: id => show('translation', id), onOpenAnalysisNotes: id => {
            show('notes', id)
            mounted.get(`${paperKey(source!)}:notes`)?.view?.focusNotes()
          },
        })
        if (mode === 'source') {
          const returnToHistory = action(doc, uiText('返回历史', 'Back to history'), () => {
            show('history')
            const history = mounted.get(`${paperKey(source!)}:history`)
            const origin = Array.from(history?.root.querySelectorAll<HTMLButtonElement>('[data-history-record]') || []).find(button => button.dataset.historyRecord === recordID)
            ;(origin || tabs[modes.indexOf('history')]).focus()
          })
          returnToHistory.classList.add('jdx-history-return')
          container.prepend(returnToHistory)
        }
        const run = runs.get(paperKey(source)); if (run) panel.view.setRun(run)
      }
    }
    tabs[modes.indexOf(tabMode)].setAttribute('aria-controls', panel.root.id)
    if (mode === 'history') renderHistory(panel.root)
    panel.root.scrollTop = panel.scroll
  }
  function renderHistory(container: HTMLElement) {
    const signature = JSON.stringify(current?.results.map(row => [row.id, row.date, row.task?.status, row.pdf?.status, row.simple && Object.keys(row.simple.outputs).length, row.task?.error, row.task?.warnings, row.analysis?.summary, row.selection?.source.text]))
    if (container.dataset.signature === signature) return
    container.dataset.signature = signature; container.replaceChildren()
    for (const result of current?.results ?? []) {
      const language = result.simple?.languages.targetLanguage || result.pdf?.languages.targetLanguage || result.task?.languages?.targetLanguage || result.selection?.result.targetLanguage
      const label = result.task?.kind === 'references' ? labels.references : labels[result.mode]
      const row = element(doc, 'article', 'jdx-literature-event'), button = action(doc, [label, language && translationLanguageDisplayLabel(language)].filter(Boolean).join(' · '), () => {
        feedback.textContent = ''
        if (result.simple) {
          void openSavedSimpleReading(host, result.source, result.id).catch(error => { feedback.textContent = String(error) })
          return
        }
        source = result.source; updateDetail()
        show(result.mode, result.id)
        const destination = [...mounted.values()].find(entry => !entry.root.hidden)
        if (result.mode === 'source') destination?.root.querySelector<HTMLButtonElement>('button')?.focus()
        else tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.focus()
      })
      button.classList.add('jdx-literature-event-title')
      button.dataset.historyRecord = result.id
      const heading = element(doc, 'div', 'jdx-literature-event-heading')
      const status = result.simple ? uiText(`已译 ${Object.keys(result.simple.outputs).length}/${result.simple.total} 个内容块`, `${Object.keys(result.simple.outputs).length}/${result.simple.total} blocks translated`)
        : result.pdf ? pdfFileStatus(result.pdf) : result.task ? resultStatus(result.task.status) : uiText('已保存', 'Saved')
      const state = result.simple?.status || result.pdf?.status || result.task?.status || 'complete'
      heading.append(button, badge(doc, status, state), element(doc, 'time', '', result.date ? new Date(result.date).toLocaleString() : uiText('时间未知', 'Date unknown')))
      row.append(heading)
      if ((current?.attachments.length ?? 0) > 1) row.append(element(doc, 'p', 'jdx-literature-meta', `${result.source.title} · ${result.source.itemKey || result.source.itemID}`))
      row.append(element(doc, 'p', 'jdx-literature-event-preview', result.task ? [result.task.error, ...result.task.warnings].filter(Boolean).join(' · ') : (result.selection?.source.text || result.analysis?.summary || '').slice(0, 200)))
      container.append(row)
    }
    if (!container.childNodes.length) container.append(element(doc, 'p', '', uiText('尚无历史', 'No history yet')))
  }
  function updateDetail() {
    if (!current || !source) return
    title.textContent = current.title
    metadata.textContent = [source.authors.join('、'), source.year, source.publicationTitle].filter(Boolean).join(' · ')
    attachments.setOptions(current.attachments.map(item => ({ value: paperKey(item), label: `${item.title} · ${item.itemKey || item.itemID}` })), paperKey(source))
    attachmentHost.hidden = current.attachments.length < 2
    const history = mounted.get(`${paperKey(source)}:history`); if (history && active === 'history') renderHistory(history.root)
  }
  function refresh() {
    if (disposed) return
    papers = literaturePapers(host, analyses(), jobs.list(), selections(), pdfs.list(), readings.list())
    for (const entry of opened.values()) if (!papers.some(paper => paper.attachments.some(item => sameAttachment(item, entry)))) papers.push({ key: `attachment:${paperKey(entry)}`, title: entry.title, source: entry, date: '', results: [], attachments: [entry] })
    if (selectedKey) {
      current = papers.find(paper => paper.key === selectedKey) || papers.find(paper => source && paper.attachments.some(item => sameAttachment(item, source!))) || current
      if (current) selectedKey = current.key
      updateDetail()
      for (const panel of mounted.values()) { void panel.view?.refresh(); panel.files?.refresh() }
    }
    const scroll = section.scrollTop
    const query = search.value.trim().toLocaleLowerCase()
    const visible = new Set<string>(); let cursor: Element | null = list.firstElementChild
    for (const paper of papers) {
      if (query && ![paper.title, ...paper.results.map(result => result.analysis?.summary || result.selection?.source.text || result.task?.source.title || '')].join(' ').toLocaleLowerCase().includes(query)) continue
      visible.add(paper.key)
      let row = listRows.get(paper.key)
      if (!row) {
        const container = element(doc, 'article', 'jdx-analysis-record'), button = action(doc, paper.title, () => {
          const selected = papers.find(row => row.key === paper.key)
          if (selected) {
            const result = selected.results.find(entry => entry.mode !== 'source')
            open(result?.source || selected.source, result?.mode || 'history', result?.id)
            tabs.find(tab => tab.tabIndex === 0)?.focus({ preventScroll: true })
          }
        })
        button.className = 'jdx-button jdx-analysis-title'; buttons.set(paper.key, button)
        row = { root: container, state: element(doc, 'div', 'jdx-literature-types'), date: element(doc, 'time', 'jdx-analysis-date'), meta: element(doc, 'p', 'jdx-literature-meta') }; container.append(button, row.meta, row.state, row.date); container.dataset.paperKey = paper.key; listRows.set(paper.key, row)
      }
      buttons.get(paper.key)!.textContent = paper.title
      const states = [...new Set(paper.results.map(result => labels[result.mode]))]
      const run = paper.attachments.some(item => runs.get(paperKey(item))?.busy) || paper.results.some(result => result.task?.status === 'running')
      row.meta.textContent = [paper.source.authors.join('、'), paper.source.year, paper.source.publicationTitle].filter(Boolean).join(' · ')
      row.state.replaceChildren(...states.map(label => badge(doc, label)), ...(run ? [badge(doc, uiText('进行中', 'Running'), 'running')] : []))
      row.date.textContent = paper.date ? new Date(paper.date).toLocaleString() : ''
      if (row.root !== cursor) list.insertBefore(row.root, cursor)
      cursor = row.root.nextElementSibling
    }
    for (const [key, row] of listRows) if (!visible.has(key)) { row.root.remove(); listRows.delete(key); buttons.delete(key) }
    empty.hidden = visible.size > 0 || (!query && loadNotices.childElementCount > 0)
    emptyText.textContent = query ? uiText(`没有找到与「${search.value.trim()}」匹配的文献。`, `No papers match “${search.value.trim()}”.`)
      : uiText('暂无文献成果。翻译或解析文献后，结果将汇集于此。', 'No results yet. Translate or analyze a paper to begin.')
    clearSearch.hidden = !query
    section.scrollTop = scroll
  }
  function open(next: PaperAnalysisSource, requested?: DocumentResultMode | LiteratureTab, recordID?: string) {
    if (!selectedKey) savedScroll = section.scrollTop
    opened.set(paperKey(next), next); refresh()
    current = papers.find(paper => recordID && paper.results.some(result => result.id === recordID)) || papers.find(paper => paper.attachments.some(item => sameAttachment(item, next)))!
    selectedKey = current.key; source = next; list.hidden = true; toolbar.hidden = true; loadNotices.hidden = true; feedback.textContent = ''; detail.hidden = false; section.dataset.detail = 'true'
    clearViews(); updateDetail()
    const mode = requested || current.results.find(result => result.mode !== 'source')?.mode || 'history'
    show(mode, recordID || (!requested ? current.results.find(result => result.mode === mode)?.id : undefined))
  }
  function back() {
    const previous = selectedKey; selectedKey = ''; detail.hidden = true; list.hidden = false; toolbar.hidden = false; loadNotices.hidden = false; delete section.dataset.detail
    clearViews(); refresh(); section.scrollTop = savedScroll; buttons.get(previous)?.focus({ preventScroll: true })
  }
  attachments.onChange(value => { const next = current?.attachments.find(item => paperKey(item) === value); if (next) { source = next; feedback.textContent = ''; updateDetail(); show(active === 'source' ? 'history' : active) } })
  search.addEventListener('input', refresh)
  const cleanups = [bindTabs(tabs, index => show(modes[index])), jobs.subscribe(refresh), pdfs.subscribe(refresh), readings.subscribe(refresh)]
  for (const key of [TRANSLATION_HISTORY_PREF_KEY, PAPER_ANALYSIS_HISTORY_PREF_KEY]) try { const id = host.Prefs?.registerObserver?.(key, refresh); if (id !== undefined) cleanups.push(() => host.Prefs?.unregisterObserver?.(id)) } catch { /* 显式刷新仍可读取。 */ }
  void jobs.ready.then(refresh)
  // 简阅和对照文件独立加载；单个来源失败时其余已取得的文献继续可读。
  function loadHistory(read: () => Promise<void>, failure: string) {
    const warning = element(doc, 'div', 'jdx-literature-load-warning', failure)
    warning.setAttribute('role', 'status')
    const retry = action(doc, uiText('重试读取', 'Retry loading'), () => { void run() })
    warning.append(retry)
    async function run() {
      retry.disabled = true
      try { await read(); warning.remove() }
      catch { if (!disposed && !warning.parentElement) loadNotices.append(warning) }
      finally { retry.disabled = false; if (!disposed) refresh() }
    }
    void run()
  }
  loadHistory(() => readings.load(), uiText('暂时无法读取简阅译文。', 'Reading translations could not be loaded.'))
  loadHistory(() => pdfs.loadHistory(), uiText('暂时无法读取对照翻译文件。', 'Bilingual PDF files could not be loaded.'))
  return { refresh, open, back, setRun(run: AnalysisRunView) { runs.set(paperKey(run.source), run); opened.set(paperKey(run.source), run.source); refresh(); for (const entry of mounted.values()) entry.view?.setRun(run) }, remove() { disposed = true; clearViews(); attachments.destroy(); cleanups.forEach(stop => stop()) } }
}
