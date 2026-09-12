/** 文献级工作区：按父条目列出成果，详情按附件阅读；旧解析组件保留为成果子视图。 */
import { readTranslationHistory, TRANSLATION_HISTORY_PREF_KEY } from '@/chat/translation-history'
import { PAPER_ANALYSIS_HISTORY_PREF_KEY, type PaperAnalysisSource } from '@/chat/paper-analysis-history'
import { literaturePapers, paperKey, type LiteraturePaper } from './analysis-workspace-model'
import { mountDocumentResults, resultLabels, resultStatus, sameAttachment, type AnalysisOptions, type DocumentResultMode } from './document-results'
import type { AnalysisDetailTab, AnalysisRunView } from './analysis-workspace'
import { documentJobs } from './document-jobs'
import { actionIcon, element, action, badge, bindTabs } from './ui/controls'
import { createJdxSelect } from './ui/select'
import { uiText } from './ui-preferences'
import type { ZoteroLike } from './runtime'

type LiteratureTab = Exclude<DocumentResultMode, 'analysis'> | AnalysisDetailTab | 'history'

export function mountLiteratureWorkspace(root: HTMLElement, host: ZoteroLike, options: AnalysisOptions) {
  const doc = root.ownerDocument, jobs = documentJobs(host), section = root.closest<HTMLElement>('.jdx-analysis-section') || root
  root.classList.add('jdx-literature-workspace')
  const toolbar = element(doc, 'div', 'jdx-result-tools'), search = element(doc, 'input', 'jdx-search'), list = element(doc, 'div', 'jdx-analysis-list'), detail = element(doc, 'article', 'jdx-literature-detail')
  search.type = 'search'; search.placeholder = uiText('搜索文献与成果', 'Search papers and results'); search.setAttribute('aria-label', search.placeholder)
  const searchField = element(doc, 'div', 'jdx-literature-search'); searchField.append(search); toolbar.append(searchField); root.replaceChildren(toolbar, list, detail); detail.hidden = true
  const title = element(doc, 'h2', 'jdx-literature-heading'), metadata = element(doc, 'p', 'jdx-literature-meta'), attachmentHost = element(doc, 'div', 'jdx-literature-attachment'), nav = element(doc, 'div', 'jdx-result-tools')
  const attachments = createJdxSelect(attachmentHost, { compact: true, portal: true, ariaLabel: uiText('PDF 附件', 'PDF attachment'), popupWidth: 320 })
  const backButton = action(doc, uiText('← 文献列表', '← Papers'), back)
  nav.append(backButton, attachmentHost, action(doc, uiText('打开原文', 'Open PDF'), () => { if (source) void options.openSource(source).catch(error => { metadata.textContent = String(error) }) }))
  actionIcon(backButton, 'back')
  actionIcon(nav.lastElementChild as HTMLButtonElement, 'open')
  const tabsHost = element(doc, 'div', 'jdx-tabs'), panels = element(doc, 'div', 'jdx-literature-panels')
  tabsHost.setAttribute('role', 'tablist'); tabsHost.setAttribute('aria-label', uiText('文献成果', 'Paper results'))
  const labels = { ...resultLabels(), summary: uiText('解析总结', 'Summary'), notes: uiText('解析笔记', 'Analysis notes'), references: uiText('参考文献', 'References'), history: uiText('历史', 'History') }, modes: LiteratureTab[] = ['source', 'translation', 'selection', 'summary', 'notes', 'references', 'history']
  const tabs = modes.map(mode => { const button = action(doc, labels[mode], () => {}); button.setAttribute('role', 'tab'); button.id = `jdx-literature-tab-${mode}`; button.setAttribute('aria-controls', `jdx-literature-panel-${mode}`); tabsHost.append(button); return button })
  const hero = element(doc, 'header', 'jdx-literature-hero'); hero.append(title, metadata)
  detail.append(nav, hero, tabsHost, panels)
  const mounted = new Map<string, { root: HTMLElement; view?: ReturnType<typeof mountDocumentResults>; scroll: number }>()
  const runs = new Map<string, AnalysisRunView>(), opened = new Map<string, PaperAnalysisSource>()
  let papers: LiteraturePaper[] = [], current: LiteraturePaper | undefined, source: PaperAnalysisSource | undefined, active: LiteratureTab = 'source', selectedKey = '', savedScroll = 0, disposed = false, sequence = 0
  const recordIDs = new Map<string, string>(), buttons = new Map<string, HTMLButtonElement>()
  const listRows = new Map<string, { root: HTMLElement; state: HTMLElement; date: HTMLElement; meta: HTMLElement }>()
  const empty = element(doc, 'p', 'jdx-result-empty', uiText('暂无文献成果。提取、翻译或解析文献后，结果将汇集于此。', 'No results yet. Extract, translate or analyze a paper to begin.'))
  list.append(empty)
  function clearViews() { for (const entry of mounted.values()) entry.view?.remove(); mounted.clear(); panels.replaceChildren() }
  function show(requested: DocumentResultMode | LiteratureTab, recordID?: string) {
    const mode: LiteratureTab = requested === 'analysis' ? (recordID && jobs.get(recordID)?.kind === 'references' ? 'references' : 'summary') : requested
    const analysisTab = mode === 'summary' || mode === 'notes' || mode === 'references' ? mode : undefined
    if (!source || !current) return
    const previous = mounted.get(`${paperKey(source)}:${active}`); if (previous) previous.scroll = section.scrollTop
    active = mode
    tabs.forEach((tab, index) => { tab.setAttribute('aria-selected', String(modes[index] === mode)); tab.tabIndex = modes[index] === mode ? 0 : -1 })
    const key = `${paperKey(source)}:${mode}`
    if (recordID && recordIDs.get(key) !== recordID) { mounted.get(key)?.view?.remove(); mounted.get(key)?.root.remove(); mounted.delete(key); recordIDs.set(key, recordID) }
    for (const [name, panel] of mounted) panel.root.hidden = name !== key
    let panel = mounted.get(key)
    if (!panel) {
      const container = element(doc, 'section', 'jdx-literature-panel'); container.setAttribute('role', 'tabpanel'); container.id = `jdx-literature-panel-${mode}-${++sequence}`; container.setAttribute('aria-labelledby', `jdx-literature-tab-${mode}`)
      panels.append(container); panel = { root: container, scroll: 0 }; mounted.set(key, panel)
      if (mode !== 'history') {
        panel.view = mountDocumentResults(container, host, source, analysisTab ? 'analysis' : mode as DocumentResultMode, { recordID: recordIDs.get(key), analysis: options, analysisTab, hideAnalysisTabs: true, onTranslate: id => show('translation', id) })
        const run = runs.get(paperKey(source)); if (run) panel.view.setRun(run)
      }
    }
    tabs[modes.indexOf(mode)].setAttribute('aria-controls', panel.root.id)
    if (mode === 'history') renderHistory(panel.root)
    section.scrollTop = panel.scroll
  }
  function renderHistory(container: HTMLElement) {
    const signature = JSON.stringify(current?.results.map(row => [row.id, row.date, row.task?.status, row.task?.error, row.task?.warnings, row.analysis?.summary, row.selection?.source.text]))
    if (container.dataset.signature === signature) return
    container.dataset.signature = signature; container.replaceChildren()
    for (const result of current?.results ?? []) {
      const row = element(doc, 'article', 'jdx-literature-event'), button = action(doc, labels[result.mode], () => {
        source = result.source; attachments.setValue(paperKey(source)); show(result.mode, result.id)
      })
      button.classList.add('jdx-literature-event-title')
      const heading = element(doc, 'div', 'jdx-literature-event-heading')
      heading.append(button, badge(doc, result.task ? resultStatus(result.task.status) : uiText('已保存', 'Saved'), result.task?.status || 'complete'), element(doc, 'time', '', new Date(result.date).toLocaleString()))
      row.append(heading, element(doc, 'p', 'jdx-literature-meta', `${result.source.title} · ${result.source.itemKey || result.source.itemID}`), element(doc, 'p', 'jdx-literature-event-preview', result.task ? [result.task.error, ...result.task.warnings].filter(Boolean).join(' · ') : (result.selection?.source.text || result.analysis?.summary || '').slice(0, 200)))
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
    papers = literaturePapers(host, options.records(), jobs.list(), host.Prefs ? readTranslationHistory(host.Prefs).records : [])
    for (const entry of opened.values()) if (!papers.some(paper => paper.attachments.some(item => sameAttachment(item, entry)))) papers.push({ key: `attachment:${paperKey(entry)}`, title: entry.title, source: entry, date: '', results: [], attachments: [entry] })
    if (selectedKey) {
      current = papers.find(paper => paper.key === selectedKey) || papers.find(paper => source && paper.attachments.some(item => sameAttachment(item, source!))) || current
      if (current) selectedKey = current.key
      updateDetail()
      for (const panel of mounted.values()) void panel.view?.refresh()
    }
    const scroll = section.scrollTop
    const visible = new Set<string>(); let cursor: Element | null = list.firstElementChild
    for (const paper of papers) {
      if (search.value && ![paper.title, ...paper.results.map(result => result.analysis?.summary || result.selection?.source.text || result.task?.source.title || '')].join(' ').toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) continue
      visible.add(paper.key)
      let row = listRows.get(paper.key)
      if (!row) {
        const container = element(doc, 'article', 'jdx-analysis-record'), button = action(doc, paper.title, () => { const current = papers.find(row => row.key === paper.key); if (current) open(current.source, undefined, current.results[0]?.id) })
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
    empty.hidden = visible.size > 0
    section.scrollTop = scroll
  }
  function open(next: PaperAnalysisSource, requested?: DocumentResultMode | AnalysisDetailTab, recordID?: string) {
    if (!selectedKey) savedScroll = section.scrollTop
    opened.set(paperKey(next), next); refresh()
    current = papers.find(paper => recordID && paper.results.some(result => result.id === recordID)) || papers.find(paper => paper.attachments.some(item => sameAttachment(item, next)))!
    selectedKey = current.key; source = next; list.hidden = true; toolbar.hidden = true; detail.hidden = false; section.dataset.detail = 'true'
    clearViews(); updateDetail()
    const mode = requested || current.results[0]?.mode || 'source'
    show(mode, recordID || (!requested ? current.results[0]?.id : undefined))
  }
  function back() {
    const previous = selectedKey; selectedKey = ''; detail.hidden = true; list.hidden = false; toolbar.hidden = false; delete section.dataset.detail
    clearViews(); refresh(); section.scrollTop = savedScroll; buttons.get(previous)?.focus({ preventScroll: true })
  }
  attachments.onChange(value => { const next = current?.attachments.find(item => paperKey(item) === value); if (next) { source = next; updateDetail(); show(active) } })
  search.addEventListener('input', refresh)
  const cleanups = [bindTabs(tabs, index => show(modes[index])), jobs.subscribe(refresh)]
  for (const key of [TRANSLATION_HISTORY_PREF_KEY, PAPER_ANALYSIS_HISTORY_PREF_KEY]) try { const id = host.Prefs?.registerObserver?.(key, refresh); if (id !== undefined) cleanups.push(() => host.Prefs?.unregisterObserver?.(id)) } catch { /* 显式刷新仍可读取。 */ }
  void jobs.ready.then(refresh)
  return { refresh, open, back, setRun(run: AnalysisRunView) { runs.set(paperKey(run.source), run); opened.set(paperKey(run.source), run.source); refresh(); for (const entry of mounted.values()) entry.view?.setRun(run) }, remove() { disposed = true; clearViews(); attachments.destroy(); cleanups.forEach(stop => stop()) } }
}
