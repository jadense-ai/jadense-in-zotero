/** 单篇参考文献视图：订阅指定任务，保留阅读/筛选/勾选；模型与原生写入只经过 DocumentJobs。 */
import type { ReferenceEntry } from "@/chat/reference-list"
import { referenceAIEnabled } from './reference-ai-settings'
import { documentJobs } from "./document-jobs"
import type { DocumentTask } from "./document-store"
import { navigateDocument, type DocumentHost, type DocumentIdentity } from "./pdf-document"
import type { ReferenceHost } from "./reference-verification"
import type { ZoteroLike } from "./runtime"
import { uiText } from "./ui-preferences"
import { actionIcon, element, action, notice, badge } from "./ui/controls"
import { createJdxSelect } from "./ui/select"

export type ReferencePreparation = { running: boolean; message?: string; error?: string }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export const canImportReference = (entry: ReferenceEntry) => entry.verification === "verified" && Boolean(entry.verified?.title) && !entry.imported && !entry.importUncertain
/** 只使用原文规则字段或本机查询结果构造链接；AI 不提供 URL 或交互权限。 */
export function referenceURL(entry: ReferenceEntry) {
  const fields = entry.verified || entry.fields
  const url = fields.url || (fields.doi ? `https://doi.org/${fields.doi}` : "")
  return /^https?:\/\//iu.test(url) ? url : ""
}
export function referenceSearchURL(entry: ReferenceEntry) { return `https://search.crossref.org/?q=${encodeURIComponent(entry.fields.title || entry.raw)}` }
export function filterReferences(entries: ReferenceEntry[], query: string, filter: string) {
  const text = query.trim().toLocaleLowerCase()
  return entries.filter(entry => (!text || [entry.raw, entry.fields.title, entry.fields.doi, ...entry.fields.authors, entry.verified?.title, entry.verified?.doi, ...(entry.verified?.authors || [])].join(" ").toLocaleLowerCase().includes(text))
    && (filter === "all" || (filter === "imported" ? Boolean(entry.imported) : !entry.imported && entry.verification === filter)))
}
function entryState(entry: ReferenceEntry) {
  return entry.imported ? uiText("已导入 / 已存在", "Imported / in library") : entry.importUncertain ? uiText("写入未确认", "Write unconfirmed")
    : entry.verification === "verified" ? uiText("已核验", "Verified") : entry.verification === "pending" ? uiText("待核验", "Pending") : uiText("未验证", "Unverified")
}

/** 原文定位和主动搜索独立于核验；只有原生写入需要匹配证据。 */
export function referenceRow(doc: Document, entry: ReferenceEntry, onImport: () => unknown, onLocate: () => unknown, onURL: (url: string) => unknown, onSelect: (checked: boolean) => void) {
  const row = element(doc, "article", "jdx-reference-row"); row.dataset.verification = entry.verification; row.dataset.referenceId = entry.id
  row.append(element(doc, "p", "jdx-reference-raw", entry.raw), element(doc, "p", "jdx-reference-state", [entryState(entry), entry.reason].filter(Boolean).join(" · ")))
  row.append(action(doc, uiText("定位原文", "Locate original"), () => { void onLocate() }), action(doc, uiText("搜索文献", "Search publication"), () => { void onURL(referenceSearchURL(entry)) }))
  if (referenceURL(entry)) row.append(action(doc, uiText("原文链接", "Publication link"), () => { void onURL(referenceURL(entry)) }))
  if (entry.verification !== "verified" || !entry.verified?.title) return row
  const checkbox = element(doc, "input"); checkbox.type = "checkbox"; checkbox.disabled = !canImportReference(entry)
  checkbox.setAttribute("aria-label", uiText(`选择引用 ${entry.label || entry.order + 1}`, `Select reference ${entry.label || entry.order + 1}`))
  checkbox.addEventListener("change", () => onSelect(checkbox.checked))
  const save = action(doc, uiText("导入 Zotero", "Import to Zotero"), () => { void onImport() }); save.disabled = !canImportReference(entry)
  row.append(checkbox, save)
  return row
}

let sequence = 0
/** 兼容旧的显式附件入口；Manager 使用单篇详情，不再挂载跨论文工具栏。 */
export function mountReferenceWorkspace(root: HTMLElement, host: ZoteroLike, itemID?: number) {
  if (!itemID) return
  void documentJobs(host).start("references", itemID).then(task => {
    root.replaceChildren()
    const view = mountReferenceDetails(root, host, task.source, value => view.update(value))
    view.update(task)
    root.ownerDocument.defaultView?.addEventListener("unload", () => view.remove(), { once: true })
  }).catch(error => { root.textContent = errorText(error) })
}
export function mountReferenceDetails(root: HTMLElement, host: ZoteroLike, source: DocumentIdentity, onTask: (task: DocumentTask) => void) {
  const doc = root.ownerDocument, jobs = documentJobs(host), native = host as unknown as ReferenceHost, prefix = `jdx-references-${++sequence}`
  root.classList.add("jdx-reference-details")
  const head = element(doc, "div", "jdx-reference-heading"), title = element(doc, "h3", "", uiText("参考文献", "References"))
  const count = element(doc, "span", "jdx-reference-count"), tools = element(doc, "div", "jdx-reference-tools")
  const status = notice(doc), feedback = notice(doc)
  const search = element(doc, "input", "jdx-search"); search.type = "search"; search.placeholder = uiText("搜索标题、作者或 DOI", "Search title, author or DOI"); search.setAttribute("aria-label", search.placeholder)
  const filters = element(doc, "div"); filters.id = `${prefix}-filter`
  const filter = createJdxSelect(filters, { ariaLabel: uiText("核验状态", "Verification status") })
  filter.setOptions([['all', uiText("全部参考文献", "All references")], ['verified', uiText("已核验", "Verified")], ['unverified', uiText("未验证", "Unverified")], ['pending', uiText("待核验", "Pending")], ['imported', uiText("已导入 / 已存在", "Imported / in library")]].map(([value, label]) => ({ value, label })), "all")
  const list = element(doc, "div", "jdx-reference-list"), empty = element(doc, "div", "jdx-result-empty")
  const importBar = element(doc, "div", "jdx-reference-import")
  const allLabel = element(doc, "label", "jdx-check"), all = element(doc, "input"), selectionText = element(doc, "span")
  all.type = "checkbox"; all.setAttribute("aria-label", uiText("全选当前可导入条目", "Select all importable results")); allLabel.append(all, selectionText)
  const libraryRoot = element(doc, "div"), collectionRoot = element(doc, "div"); libraryRoot.id = `${prefix}-library`; collectionRoot.id = `${prefix}-collection`
  const library = createJdxSelect(libraryRoot, { ariaLabel: uiText("目标文库", "Destination library") })
  const collection = createJdxSelect(collectionRoot, { ariaLabel: uiText("目标分类", "Destination collection"), searchPlaceholder: uiText("搜索分类", "Search collections") })
  const libraries = (native.Libraries?.getAll?.() || []).filter(item => item.editable)
  const libraryOptions = libraries.map(item => ({ value: String(item.libraryID), label: item.name }))
  library.setOptions(libraryOptions, String(libraries.find(item => item.libraryID === source.libraryID)?.libraryID ?? libraries[0]?.libraryID ?? ""))
  const collections = () => collection.setOptions([{ value: "", label: uiText("不指定分类", "No collection") }, ...(native.Collections?.getByLibrary?.(Number(library.getValue()), true) || []).map(item => ({ value: String(item.id), label: item.name }))], "")
  library.onChange(collections); collections()
  let task: DocumentTask | undefined, preparation: ReferencePreparation | undefined, entries: ReferenceEntry[] = [], importing = false, disposed = false, generation = 0
  let extracting: AbortController | undefined
  const selected = new Set<string>()
  type Row = { root: HTMLElement; raw: HTMLElement; metadata: HTMLElement; state: HTMLElement; reason: HTMLElement; number: HTMLElement; controls: HTMLElement; publication?: HTMLButtonElement; checkbox?: HTMLInputElement; save?: HTMLButtonElement; entry: ReferenceEntry }
  const rows = new Map<string, Row>()
  const operate = (callback: (id: string) => void) => { if (task && !importing) { feedback.textContent = ""; callback(task.id) } }
  const extract = action(doc, uiText("提取参考文献", "Extract references"), () => {
    if (extracting || preparation?.running) return
    extracting = new AbortController(); preparation = { running: true, message: uiText("正在读取 PDF…", "Reading PDF…") }; render()
    void jobs.start("references", source.itemID, Boolean(task), { signal: extracting.signal, onProgress: message => { preparation = { running: true, message }; render() } }).then(value => {
      if (disposed) return
      task = value; onTask(value)
    }).catch(error => { if (!disposed && !extracting?.signal.aborted) feedback.textContent = errorText(error) }).finally(() => { extracting = undefined; preparation = undefined; if (!disposed) void refresh() })
  }, "primary")
  const pause = action(doc, uiText("暂停", "Pause"), () => {
    if (extracting) extracting.abort()
    else operate(id => jobs.pause(id))
  })
  const resume = action(doc, uiText("继续核验", "Continue verification"), () => operate(id => jobs.resume(id)))
  const identify = action(doc, uiText("识别待定片段", "Identify uncertain fragments"), () => operate(id => jobs.resume(id, true)))
  const skip = action(doc, uiText("跳过 AI，继续核验", "Skip AI and verify"), () => operate(id => jobs.skipReferenceAI(id)))
  const verify = action(doc, uiText("重新核验", "Verify again"), () => operate(id => jobs.resume(id)))
  const importSelected = async (ids: string[]) => {
    if (!task || importing || !library.getValue() || !ids.length) return
    const taskID = task.id, destination = Number(library.getValue()), folder = collection.getValue()
    const restoreFocus = root.contains(doc.activeElement)
    importing = true; feedback.textContent = uiText("正在导入 Zotero…", "Importing to Zotero…"); render()
    try {
      const report = await jobs.import(taskID, ids, destination, folder ? Number(folder) : undefined)
      if (disposed || task?.id !== taskID) return
      feedback.textContent = report ? uiText(`已导入或已存在 ${report.imported} 条 · 失败 ${report.failed} 条 · 写入未确认 ${report.uncertain} 条`, `${report.imported} imported or existing · ${report.failed} failed · ${report.uncertain} unconfirmed`) : uiText("参考文献任务不可用", "Reference task unavailable")
      feedback.dataset.kind = report && !report.failed && !report.uncertain ? "success" : "error"
    } catch (error) { if (!disposed) { feedback.textContent = errorText(error); feedback.dataset.kind = "error" } }
    finally { importing = false; if (!disposed) { await refresh(); if (restoreFocus && !root.closest("[hidden]")) { feedback.tabIndex = -1; feedback.focus({ preventScroll: true }) } } }
  }
  const importButton = action(doc, uiText("导入 Zotero", "Import to Zotero"), () => { void importSelected([...selected]) }, "primary")
  const showSource = async (entry: ReferenceEntry) => {
    if (!task || !entry.lines[0]) return
    try { await navigateDocument(host as unknown as DocumentHost, task.source, { pageIndex: entry.lines[0].pageIndex, rects: entry.lines[0].rects }) }
    catch (error) { feedback.textContent = errorText(error); feedback.dataset.kind = "error" }
  }
  function render() {
    if (disposed) return
    const phase = task ? jobs.referencePhase(task.id) : undefined, running = task?.status === "running", preparing = Boolean(preparation?.running || extracting)
    const busy = importing || phase === "importing"
    const blocksImport = running && phase !== "identifying"
    const label = phase === "stopping" ? uiText("正在停止…", "Stopping…") : phase === "queued" ? uiText("等待处理", "Queued") : phase === "identifying" ? uiText("识别待定片段", "Identifying fragments") : phase === "verifying" ? uiText("正在核验", "Verifying") : phase === "importing" ? uiText("正在导入", "Importing")
      : task?.status === "paused" ? uiText("已暂停", "Paused") : task?.status === "error" ? uiText("核验失败", "Verification failed") : task ? uiText("提取完成", "Extraction finished") : ""
    status.textContent = [preparing ? preparation?.message : label && `${label} · ${task?.completed ?? 0} / ${task?.total ?? 0}`, preparation?.error, task?.error, ...(task?.warnings || []), task?.storageWarning ? uiText("结果尚未完整保存，关闭前请保留所需内容。", "Results are not fully saved. Keep needed content before closing.") : ""].filter(Boolean).join("\n")
    status.dataset.kind = task?.error || preparation?.error || task?.storageWarning ? "error" : "neutral"
    extract.hidden = preparing || running; extract.disabled = busy
    extract.textContent = task ? uiText("重新提取参考文献", "Extract references again") : uiText("提取参考文献", "Extract references")
    pause.hidden = !running && !extracting; pause.disabled = busy
    resume.hidden = !task || running || !["paused", "error"].includes(task.status); resume.disabled = busy || phase === "stopping"
    verify.hidden = !task || running || task.status === "paused"; verify.disabled = busy
    identify.hidden = !referenceAIEnabled(host) || !task || running || !entries.some(entry => entry.uncertain); identify.disabled = busy
    if (task?.referenceAI?.pausedReason) status.textContent += ` · ${task.referenceAI.pausedReason}`
    skip.hidden = phase !== "identifying"; skip.disabled = busy
    actionIcon(extract, task ? "refresh" : "extract"); actionIcon(pause, "pause"); actionIcon(resume, "play"); actionIcon(identify, "search"); actionIcon(skip, "skip"); actionIcon(verify, "verify")
    library.setDisabled(busy || !libraryOptions.length); collection.setDisabled(busy || !libraryOptions.length)
    const visible = filterReferences(entries, search.value, filter.getValue())
    const visibleIDs = new Set(visible.map(entry => entry.id)), importable = visible.filter(canImportReference)
    const validIDs = new Set(entries.filter(canImportReference).map(entry => entry.id))
    for (const id of selected) if (!validIDs.has(id)) selected.delete(id)
    count.textContent = uiText(`${entries.length} 条 · ${entries.filter(entry => entry.verification === "verified").length} 已核验`, `${entries.length} references · ${entries.filter(entry => entry.verification === "verified").length} verified`)
    selectionText.textContent = selected.size ? uiText(`已选择 ${selected.size} 条`, `${selected.size} selected`) : uiText("全选可导入", "Select importable")
    all.checked = importable.length > 0 && importable.every(entry => selected.has(entry.id)); all.indeterminate = !all.checked && importable.some(entry => selected.has(entry.id)); all.disabled = !importable.length || busy || blocksImport
    importButton.disabled = !selected.size || !library.getValue() || busy || blocksImport
    importButton.textContent = busy ? uiText("正在导入…", "Importing…") : selected.size ? uiText(`导入 ${selected.size} 条`, `Import ${selected.size}`) : uiText("导入 Zotero", "Import to Zotero")
    actionIcon(importButton, "import")
    importBar.hidden = !entries.length
    for (const entry of entries) {
      let row = rows.get(entry.id)
      if (!row) {
        const container = element(doc, "article", "jdx-reference-row"), number = element(doc, "span", "jdx-reference-number")
        const body = element(doc, "div", "jdx-reference-body"), raw = element(doc, "p", "jdx-reference-raw"), meta = element(doc, "div", "jdx-reference-meta")
        const metadata = element(doc, "p", "jdx-reference-raw")
        const state = badge(doc, ""), reason = element(doc, "span", "jdx-reference-reason"), controls = element(doc, "div", "jdx-reference-actions")
        meta.append(state, reason); body.append(raw, metadata, meta, controls); container.append(number, body); container.dataset.referenceId = entry.id
        row = { root: container, raw, metadata, state, reason, number, controls, entry }; rows.set(entry.id, row)
      }
      row.entry = entry; row.root.hidden = !visibleIDs.has(entry.id); row.root.dataset.verification = entry.verification
      if (row.raw.textContent !== entry.raw) row.raw.textContent = entry.raw
      row.metadata.textContent = entry.verified ? [entry.verified.title, entry.verified.authors.join("; "), entry.verified.year, entry.verified.publicationTitle, entry.verified.doi].filter(Boolean).join(" · ") : ""
      row.metadata.hidden = !entry.verified
      row.number.textContent = entry.label || String(entry.order + 1); row.state.textContent = entryState(entry); row.state.dataset.state = entry.verification === "verified" ? "success" : "neutral"
      row.reason.textContent = [entry.uncertain ? uiText("识别待定，原文保留", "Uncertain extraction; original retained") : "", entry.reason].filter(Boolean).join(" · ")
      if (!row.checkbox) {
        const view = row, checkbox = element(doc, "input"); checkbox.type = "checkbox"
        checkbox.setAttribute("aria-label", uiText(`选择引用 ${entry.label || entry.order + 1}`, `Select reference ${entry.label || entry.order + 1}`))
        checkbox.addEventListener("change", () => { if (checkbox.checked) selected.add(view.entry.id); else selected.delete(view.entry.id); render() })
        const locate = action(doc, uiText("定位原文", "Locate original"), () => { void showSource(view.entry) })
        const publication = action(doc, uiText("原文链接 ↗", "Publication ↗"), () => {
          const url = referenceURL(view.entry)
          if (/^https?:\/\//iu.test(url)) { try { (host as ZoteroLike & { launchURL?(url: string): void }).launchURL?.(url) } catch (error) { feedback.textContent = errorText(error) } }
        })
        const search = action(doc, uiText("搜索文献", "Search publication"), () => {
          try { (host as ZoteroLike & { launchURL?(url: string): void }).launchURL?.(referenceSearchURL(view.entry)) } catch (error) { feedback.textContent = errorText(error) }
        })
        const save = action(doc, uiText("导入", "Import"), () => { void importSelected([view.entry.id]) })
        actionIcon(locate, "locate"); actionIcon(search, "search"); actionIcon(publication, "open")
        view.controls.append(checkbox, locate, search, publication, save); view.checkbox = checkbox; view.save = save; view.publication = publication
      }
      if (row.checkbox) {
        row.checkbox.hidden = entry.verification !== "verified"; row.save!.hidden = entry.verification !== "verified"
        row.publication!.hidden = !referenceURL(entry)
        row.checkbox.checked = selected.has(entry.id); row.checkbox.disabled = busy || blocksImport || !canImportReference(entry)
        // 未确认写入仅允许显式核对文库；执行层先查 DOI，找不到时仍禁止再次写入。
        row.save!.textContent = entry.importUncertain ? uiText("核对文库", "Check library") : uiText("导入", "Import")
        actionIcon(row.save!, entry.importUncertain ? "search" : "import")
        row.save!.disabled = busy || blocksImport || Boolean(entry.imported) || entry.verification !== "verified"
      }
    }
    // 只插入新增/位置变化的节点；普通核验进度不移动已有节点、选择或焦点。
    let cursor = list.firstElementChild
    for (const entry of entries) { const node = rows.get(entry.id)!.root; if (node !== cursor) list.insertBefore(node, cursor); cursor = node.nextElementSibling }
    for (const [id, row] of rows) if (!entries.some(entry => entry.id === id)) { row.root.remove(); rows.delete(id) }
    empty.hidden = Boolean(visible.length)
    empty.textContent = preparing || running ? uiText("正在整理参考文献，已提取的内容会在这里出现。", "Preparing references. Extracted entries will appear here.") : entries.length ? uiText("没有符合筛选条件的参考文献", "No references match these filters") : task ? uiText("未识别到参考文献区域；不代表原文没有参考文献。", "No reference region was identified; the paper may still contain references.") : uiText("这篇文献尚未提取参考文献。", "References have not been extracted for this paper.")
  }
  async function refresh() {
    const current = ++generation, id = task?.id
    const result = id ? await jobs.store.references(id) : []
    if (disposed || current !== generation || id !== task?.id) return
    entries = result; render()
  }
  all.addEventListener("change", () => { for (const entry of filterReferences(entries, search.value, filter.getValue()).filter(canImportReference)) { if (all.checked) selected.add(entry.id); else selected.delete(entry.id) } render() })
  search.addEventListener("input", render); filter.onChange(render)
  head.append(title, count); tools.append(extract, pause, resume, verify, identify, skip)
  const searchBar = element(doc, "div", "jdx-reference-search"); searchBar.append(search, filters)
  const destination = element(doc, "div", "jdx-reference-destination"); destination.append(libraryRoot, collectionRoot)
  importBar.append(allLabel, destination, importButton)
  root.append(head, tools, status, searchBar, feedback, list, empty, importBar)
  const stop = jobs.subscribe(() => { void refresh() }); render()
  return {
    update(value?: DocumentTask, preparing?: ReferencePreparation) { const changed = value?.id !== task?.id; task = value; preparation = preparing; if (changed) { selected.clear(); entries = [] } void refresh() },
    pause() { extracting?.abort(); if (task) jobs.pause(task.id) },
    suspend() { filter.close(); library.close(); collection.close() },
    remove() { disposed = true; ++generation; stop(); extracting?.abort(); filter.close(); library.close(); collection.close() },
  }
}
