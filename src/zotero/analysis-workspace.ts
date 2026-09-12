/** 文献解析列表与单篇详情：只管理阅读状态，执行/持久化由 Manager 和独立任务层负责。 */
import { updateChatMarkdown } from "@/chat/markdown"
import { parseResearchPresentation } from "@/chat/research-presentation"
import type { PaperAnalysisRecord, PaperAnalysisSource } from "@/chat/paper-analysis-history"
import { analysisPapers, paperKey, type AnalysisPaper } from "./analysis-workspace-model"
import { documentJobs } from "./document-jobs"
import type { DocumentTask } from "./document-store"
import { mountReferenceDetails, type ReferencePreparation } from "./reference-workspace"
import type { ZoteroLike } from "./runtime"
import { getUiLocale, uiText } from "./ui-preferences"
import { actionIcon, action, badge, bindTabs, element, notice } from "./ui/controls"

export type AnalysisDetailTab = "summary" | "notes" | "references"
export type AnalysisRunView = { source: PaperAnalysisSource; message: string; busy: boolean; error?: boolean; references?: ReferencePreparation; referenceTaskID?: string; createdAt: string }
const timeText = (value: string) => new Date(value).toLocaleString(getUiLocale(), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
const metadataText = (source: PaperAnalysisSource) => [source.authors.join("、"), source.date || source.year, source.publicationTitle].filter(Boolean).join(" · ")
/** 翻译固定展示标题，不改写已保存的模型正文或笔记备份。 */
function noteLabel(text: string) {
  const labels: Record<string, string> = { 总体概述: "Overview", 研究问题: "Research question", 核心论点: "Central claim", 创新点: "Novelty", 研究方法: "Methods", 关键证据: "Key evidence", 研究结论: "Conclusions", 局限性: "Limitations", 未来工作: "Future work", 补充要点: "Additional findings" }
  const count = /^关键句与批注（(\d+) 条）$/.exec(text)
  return uiText(text, count ? `Source passages and notes (${count[1]})` : labels[text] || text)
}

let workspaceSequence = 0

export function mountAnalysisWorkspace(root: HTMLElement, host: ZoteroLike, options: {
  embedded?: boolean
  hideTabs?: boolean
  referenceTaskID?: string
  records(): PaperAnalysisRecord[]
  unsaved(id: string): boolean
  openSource(source: PaperAnalysisSource): Promise<boolean>
  stop(source: PaperAnalysisSource): void
  onReferenceTask(source: PaperAnalysisSource, task: DocumentTask): void
}) {
  const workspaceID = ++workspaceSequence
  const doc = root.ownerDocument, jobs = documentJobs(host), section = options.embedded ? root : root.closest<HTMLElement>(".jdx-analysis-section") || root
  const list = element(doc, "div", "jdx-analysis-list"), empty = element(doc, "div", "jdx-result-empty")
  empty.append(element(doc, "span", "jdx-empty-mark", "≡"), element(doc, "h3", "", uiText("从一篇文献开始", "Start with a paper")), element(doc, "p", "", uiText("在 PDF 阅读器中点击「解析」，总结、笔记与参考文献会汇集在这里。", "Click Analyze in the PDF reader to collect the summary, notes and references here.")))
  root.replaceChildren(list, empty)
  const runs = new Map<string, AnalysisRunView>(), papers = new Map<string, AnalysisPaper>()
  const openedSources = new Map<string, PaperAnalysisSource>()
  const rows = new Map<string, { root: HTMLElement; title: HTMLButtonElement; meta: HTMLElement; preview: HTMLElement; state: HTMLElement; date: HTMLElement }>()
  type Detail = { root: HTMLElement; title: HTMLElement; meta: HTMLElement; date: HTMLElement; warning: HTMLElement; status: HTMLElement; stop: HTMLButtonElement; summary: HTMLElement; notes: HTMLElement; tabs: HTMLButtonElement[]; panels: HTMLElement[]; active: AnalysisDetailTab; scrolls: number[]; signature: string; reference: ReturnType<typeof mountReferenceDetails>; cleanup(): void }
  const details = new Map<string, Detail>()
  let selected: string | undefined, savedScroll = 0, disposed = false, detailSequence = 0
  const labels: Record<AnalysisDetailTab, string> = { summary: uiText("解析总结", "Summary"), notes: uiText("解析笔记", "Analysis notes"), references: uiText("参考文献", "References") }
  const tabNames = Object.keys(labels) as AnalysisDetailTab[]
  const message = notice(doc)
  root.append(message)
  async function openSource(source: PaperAnalysisSource, target = message) {
    try { target.textContent = await options.openSource(source) ? "" : uiText("原 PDF 不可用；已保存的解析仍可阅读。", "The original PDF is unavailable. Saved analysis remains readable.") }
    catch { target.textContent = uiText("无法打开原 PDF，请确认附件仍在文库中。", "Cannot open the original PDF. Check the attachment in your library.") }
    target.dataset.kind = "error"
  }
  function back() {
    if (!selected) return
    const key = selected, detail = details.get(key)!
    detail.scrolls[tabNames.indexOf(detail.active)] = section.scrollTop; detail.reference.suspend(); detail.root.hidden = true
    selected = undefined; delete section.dataset.detail; list.hidden = false; refresh(); section.scrollTop = savedScroll
    rows.get(key)?.title.focus({ preventScroll: true })
  }
  function selectTab(detail: Detail, tab: AnalysisDetailTab, restore = true) {
    if (restore) detail.scrolls[tabNames.indexOf(detail.active)] = section.scrollTop
    detail.reference.suspend(); detail.active = tab
    detail.tabs.forEach((button, index) => { const active = tabNames[index] === tab; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1; detail.panels[index].hidden = !active })
    section.scrollTop = detail.scrolls[tabNames.indexOf(tab)]
  }
  function renderNotes(target: HTMLElement, record?: PaperAnalysisRecord) {
    target.replaceChildren()
    if (!record?.notes) { target.append(element(doc, "p", "jdx-result-empty", uiText("这条记录没有解析笔记。", "This record has no analysis notes."))); return }
    for (const block of parseResearchPresentation(record.notes)) {
      if (block.type === "heading") { if (block.level !== 1) target.append(element(doc, "h3", "jdx-note-heading", noteLabel(block.text))); continue }
      if (block.type === "annotation") {
        const note = element(doc, "article", "jdx-note-entry"), meta = element(doc, "div", "jdx-note-meta")
        meta.append(badge(doc, noteLabel(block.category)), element(doc, "span", "", uiText(`第 ${block.pageLabel} 页`, `Page ${block.pageLabel}`)))
        const comment = element(doc, "div", "jdx-markdown"); updateChatMarkdown(comment, block.comment)
        note.append(meta, element(doc, "blockquote", "", block.quote), comment); target.append(note)
      } else { const text = element(doc, "div", "jdx-markdown jdx-note-paragraph"); updateChatMarkdown(text, block.text); target.append(text) }
    }
  }
  function createDetail(paper: AnalysisPaper): Detail {
    const key = paper.key, prefix = `jdx-analysis-detail-${workspaceID}-${++detailSequence}`
    const container = element(doc, "article", "jdx-analysis-detail"), nav = element(doc, "div", "jdx-detail-navigation")
    const feedback = notice(doc), backButton = action(doc, uiText("← 解析历史", "← Analysis history"), back)
    nav.append(backButton, action(doc, uiText("打开原文 ↗", "Open PDF ↗"), () => { void openSource(papers.get(key)!.source, feedback) }))
    const hero = element(doc, "header", "jdx-analysis-hero"), eyebrow = element(doc, "div", "jdx-analysis-eyebrow", uiText("文献解析", "LITERATURE ANALYSIS"))
    const title = element(doc, "h2"), meta = element(doc, "p", "jdx-detail-metadata"), date = element(doc, "p", "jdx-detail-date")
    hero.append(eyebrow, title, meta, date)
    const run = element(doc, "div", "jdx-detail-run"), status = notice(doc), stop = action(doc, uiText("停止本次解析", "Stop analysis"), () => { reference.pause(); options.stop(papers.get(key)!.source) })
    actionIcon(backButton, "back"); actionIcon(nav.lastElementChild as HTMLButtonElement, "open"); actionIcon(stop, "stop")
    run.append(status, stop)
    const warning = notice(doc), tablist = element(doc, "div", "jdx-tabs jdx-detail-tabs")
    tablist.setAttribute("role", "tablist"); tablist.setAttribute("aria-label", uiText("解析结果", "Analysis results"))
    const panels = tabNames.map(name => { const panel = element(doc, "section", "jdx-detail-panel"); panel.id = `${prefix}-${name}`; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", `${prefix}-tab-${name}`); return panel })
    const tabs = tabNames.map((name, i) => { const button = action(doc, labels[name], () => {}); button.id = `${prefix}-tab-${name}`; button.setAttribute("role", "tab"); button.setAttribute("aria-controls", panels[i].id); tablist.append(button); return button })
    const summary = element(doc, "div", "jdx-markdown jdx-analysis-summary jdx-reading-body"), notes = element(doc, "div", "jdx-analysis-notes-text jdx-reading-body")
    panels[0].append(summary); panels[1].append(notes)
    container.append(nav, hero, run, warning, feedback, tablist, ...panels)
    if (options.embedded) { nav.hidden = true; hero.hidden = true }
    if (options.hideTabs) { tablist.hidden = true; panels.forEach(panel => { panel.removeAttribute("role"); panel.removeAttribute("aria-labelledby") }) }
    const reference = mountReferenceDetails(panels[2], host, paper.source, task => { options.onReferenceTask(paper.source, task); refresh() })
    const detail: Detail = { root: container, title, meta, date, warning, status, stop, summary, notes, tabs, panels, active: "summary", scrolls: [0, 0, 0], signature: "", reference, cleanup: () => {} }
    const cleanup = bindTabs(tabs, i => selectTab(detail, tabNames[i]))
    detail.cleanup = () => { cleanup(); reference.remove() }
    details.set(key, detail); root.append(container); container.hidden = true; selectTab(detail, "summary", false)
    return detail
  }
  function updateDetail(paper: AnalysisPaper, detail: Detail) {
    const run = runs.get(paper.key), record = paper.record
    detail.title.textContent = paper.source.title; detail.meta.textContent = [metadataText(paper.source), paper.source.doi ? `DOI ${paper.source.doi}` : ""].filter(Boolean).join(" · ")
    detail.meta.hidden = !detail.meta.textContent
    detail.date.textContent = [record ? uiText(`解析于 ${timeText(record.createdAt)}`, `Analyzed ${timeText(record.createdAt)}`) : uiText("尚未生成解析总结", "No analysis summary yet"), uiText("本地保存", "Stored locally")].join(" · ")
    detail.status.textContent = run?.message || ""; detail.status.dataset.kind = run?.error ? "error" : run?.busy || run?.references?.running ? "running" : "neutral"
    detail.stop.hidden = !(run?.busy || run?.references?.running || paper.references?.status === "running")
    detail.status.parentElement!.hidden = !detail.status.textContent && detail.stop.hidden
    detail.warning.textContent = [record && options.unsaved(record.id) ? uiText("最新结果尚未完整保存，关闭窗口前请选中需要保留的内容并复制。", "The latest result is not fully saved. Select and copy anything you need before closing.") : "", ...(record?.warnings || [])].filter(Boolean).join("\n")
    detail.warning.dataset.kind = record && options.unsaved(record.id) ? "error" : "neutral"
    const signature = JSON.stringify(record || null)
    if (signature !== detail.signature) {
      detail.signature = signature
      updateChatMarkdown(detail.summary, record?.summary || uiText("尚无解析总结。请在 PDF 阅读器中点击「解析」。", "No analysis summary yet. Click Analyze in the PDF reader."))
      renderNotes(detail.notes, record)
    }
    const reference = options.referenceTaskID ? jobs.get(options.referenceTaskID) : paper.references
    detail.reference.update(reference && paperKey(reference.source) === paperKey(paper.source) ? reference : paper.references, run?.references)
  }
  function refresh() {
    if (disposed) return
    const projection = analysisPapers(options.records(), jobs.list("references"))
    papers.clear(); projection.forEach(paper => papers.set(paper.key, paper))
    for (const [key, source] of openedSources) if (!papers.has(key)) papers.set(key, { key, source, date: new Date().toISOString() })
    for (const [key, run] of runs) {
      if (!papers.has(key)) papers.set(key, { key, source: run.source, date: run.createdAt })
      const paper = papers.get(key)!
      if (run.referenceTaskID) { const task = jobs.get(run.referenceTaskID); if (task && paperKey(task.source) === key) paper.references = task }
    }
    const ordered = [...papers.values()].sort((a, b) => b.date.localeCompare(a.date))
    for (const paper of ordered) {
      let row = rows.get(paper.key)
      if (!row) {
        const container = element(doc, "article", "jdx-analysis-record"), body = element(doc, "div", "jdx-analysis-row-body"), top = element(doc, "div", "jdx-analysis-row-top")
        const title = action(doc, paper.source.title, () => open(paper.source)); title.className = "jdx-analysis-title"
        const meta = element(doc, "p", "jdx-analysis-meta"), preview = element(doc, "div", "jdx-markdown jdx-analysis-preview")
        const state = badge(doc, ""), date = element(doc, "time", "jdx-analysis-date")
        top.append(state, date); body.append(top, title, meta, preview)
        const go = action(doc, "↗", () => { void openSource(papers.get(paper.key)!.source) }); go.title = uiText("打开原文", "Open original"); go.setAttribute("aria-label", go.title)
        container.append(body, go); container.dataset.paperKey = paper.key
        row = { root: container, title, meta, preview, state, date }; rows.set(paper.key, row)
      }
      const run = runs.get(paper.key), running = run?.busy || run?.references?.running || paper.references?.status === "running"
      row.title.textContent = paper.source.title; row.meta.textContent = metadataText(paper.source); row.meta.hidden = !row.meta.textContent
      row.date.textContent = timeText(paper.date)
      updateChatMarkdown(row.preview, paper.record?.summary || (running ? uiText("正在整理解析结果…", "Preparing analysis results…") : paper.references ? uiText("可进入详情查看参考文献。", "Open the details to view references.") : uiText("尚未生成解析结果。", "No analysis results yet.")))
      row.state.textContent = running ? uiText("解析中", "In progress") : run?.error ? uiText("解析未完成", "Incomplete") : paper.record?.warnings?.length || (paper.record && options.unsaved(paper.record.id)) ? uiText("结果待核对", "Review needed") : paper.record ? uiText("已解析", "Analyzed") : uiText("参考文献", "References")
      row.state.dataset.state = running ? "busy" : paper.record && !paper.record.warnings?.length ? "success" : "neutral"
      if (details.has(paper.key)) updateDetail(paper, details.get(paper.key)!)
    }
    let cursor = list.firstElementChild
    for (const paper of ordered) { const node = rows.get(paper.key)!.root; if (node !== cursor) list.insertBefore(node, cursor); cursor = node.nextElementSibling }
    for (const [key, row] of rows) if (!papers.has(key)) { row.root.remove(); rows.delete(key); if (key !== selected) { details.get(key)?.cleanup(); details.get(key)?.root.remove(); details.delete(key) } }
    empty.hidden = Boolean(ordered.length) || Boolean(selected)
  }
  function open(source: PaperAnalysisSource, tab?: AnalysisDetailTab) {
    const key = paperKey(source)
    openedSources.set(key, source)
    refresh()
    let paper = papers.get(key)
    if (!paper) { paper = { key, source, date: new Date().toISOString() }; papers.set(key, paper) }
    if (selected) { const current = details.get(selected)!; current.scrolls[tabNames.indexOf(current.active)] = section.scrollTop; current.reference.suspend(); current.root.hidden = true }
    else savedScroll = section.scrollTop
    selected = key; section.dataset.detail = "true"; list.hidden = true; empty.hidden = true; message.textContent = ""
    const detail = details.get(key) || createDetail(paper)
    updateDetail(paper, detail); detail.root.hidden = false
    selectTab(detail, tab || detail.active, false)
    if (!options.hideTabs) detail.tabs[tabNames.indexOf(detail.active)].focus({ preventScroll: true })
  }
  const stop = jobs.subscribe(refresh)
  void jobs.ready.then(refresh)
  return {
    refresh, open, back,
    setRun(run: AnalysisRunView) { runs.set(paperKey(run.source), run); refresh() },
    remove() { disposed = true; stop(); for (const detail of details.values()) detail.cleanup() },
  }
}
