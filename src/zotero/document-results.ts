import { analysisRuntime } from './analysis-runtime'
import { lifecycleTrace } from './lifecycle-diagnostics'
import { renderDocumentIssueActions } from './document-notices'
/** 当前附件的只读成果界面：Reader 与文献详情共用，任务仅由明确按钮启动。 */
import { updateChatMarkdown } from '@/chat/markdown'
import { readTranslationHistory, TRANSLATION_HISTORY_PREF_KEY } from '@/chat/translation-history'
import { PAPER_ANALYSIS_HISTORY_PREF_KEY, type PaperAnalysisSource } from '@/chat/paper-analysis-history'
import { documentJobs } from './document-jobs'
import { paperKey } from './analysis-workspace-model'
import { mountAnalysisWorkspace, type AnalysisRunView, type AnalysisDetailTab } from './analysis-workspace'
import { mountTranslationReader, installTranslationReadingStyles } from './translation-reader'
import { copyTextToClipboard } from './connection-display'
import { navigateDocument, type DocumentHost } from './pdf-document'
import { actionIcon, element, action, notice } from './ui/controls'
import { createChevron } from './ui/chevron'
import { createJdxSelect } from './ui/select'
import { show, type ToastHandle, type ToastType } from './ui/toast'
import { uiText } from './ui-preferences'
import type { ZoteroLike } from './runtime'
import { translationLanguageDisplayLabel } from '@/chat/translation-languages'
import type { DocumentTask } from './document-store'

export type DocumentResultMode = 'source' | 'translation' | 'selection' | 'analysis'
export type AnalysisOptions = Parameters<typeof mountAnalysisWorkspace>[2]
export const resultLabels = (): Record<DocumentResultMode, string> => ({ source: uiText('全文 Markdown', 'Full Markdown'), translation: uiText('全文翻译', 'Full translation'), selection: uiText('选中翻译历史', 'Selection translations'), analysis: uiText('解析结果', 'Analysis results') })
export const resultStatus = (status: DocumentTask['status']) => ({ running: uiText('进行中', 'Running'), paused: uiText('已暂停', 'Paused'), complete: uiText('已完成', 'Complete'), partial: uiText('部分完成', 'Partial'), error: uiText('失败', 'Failed') })[status]

/** 安全附件匹配从完整身份出发；旧缺失身份记录仅作单独历史展示。 */
export function sameAttachment(a: { itemID: number; libraryID?: number; itemKey?: string }, b: { itemID: number; libraryID?: number; itemKey?: string }) {
  return a.itemID === b.itemID && (a.libraryID ?? -1) === (b.libraryID ?? -1) && (a.itemKey ?? '') === (b.itemKey ?? '')
}

export function mountDocumentResults(root: HTMLElement, host: ZoteroLike, source: PaperAnalysisSource, mode: DocumentResultMode, options: {
  recordID?: string; readerDocument?: Document; analysis?: AnalysisOptions; analysisTab?: AnalysisDetailTab; hideAnalysisTabs?: boolean; onTranslate?(id: string): void; onWorkbench?(mode: DocumentResultMode, id?: string): void; onOpenBilingual?(): Promise<void>
  onOpenAnalysisNotes?(id?: string): void
} = {}) {
  const doc = root.ownerDocument, jobs = documentJobs(host)
  installTranslationReadingStyles(doc)
  if (!doc.getElementById('jdx-document-results-css')) {
    const link = element(doc, 'link'); link.id = 'jdx-document-results-css'; link.rel = 'stylesheet'; link.href = 'chrome://jadense-in-zotero/content/ui.css'
    ;(doc.head || doc.documentElement).append(link)
  }
  root.classList.add('jdx-document-results'); root.replaceChildren()
  const toolbar = element(doc, 'div', 'jdx-result-tools'), versionHost = element(doc, 'div', 'jdx-result-version'), message = notice(doc)
  const savedKind = mode === 'translation' && options.analysis ? element(doc, 'span', 'jdx-result-kind', uiText('历史全文译文', 'Saved full translation')) : undefined
  const versions = createJdxSelect(versionHost, { compact: true, portal: true, ariaLabel: uiText('成果版本', 'Result version'), popupWidth: 300 })
  const body = element(doc, 'div', 'jdx-result-content')
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', resultLabels()[mode]); root.dataset.resultMode = mode
  const issueActions = element(doc, 'div', 'jdx-actions'); issueActions.hidden = true
  if (savedKind) { savedKind.hidden = true; toolbar.append(savedKind) }
  toolbar.append(versionHost); root.append(toolbar, message, issueActions, body)
  if (mode === 'source') message.textContent = uiText('全文提取已停用，已有 Markdown 仍可查看和复制。', 'Document extraction has been retired. Saved Markdown remains available to read and copy.')
  if (options.onWorkbench) { const open = action(doc, uiText('在工作台查看', 'Open in workbench'), () => options.onWorkbench?.(mode, selected)); actionIcon(open, 'workbench'); open.classList.add('jdx-result-workbench'); toolbar.append(open) }
  const cleanups: Array<() => void> = []
  let selected = options.recordID, disposed = false, refreshing = false, dirty = false, signature = '', stopContent = () => {}
  let analysis: ReturnType<typeof mountAnalysisWorkspace> | undefined
  let analysisRun: AnalysisRunView | undefined
  let activeAnalysisTab = options.analysisTab, requestedRecordID = options.recordID, showAnalysisRun = true
  let attachmentReferences = false
  let notesFocusPending = false
  function focusNotesWhenReady() {
    if (!notesFocusPending || root.closest('[hidden]')) return
    const target = body.querySelector<HTMLElement>('[data-jdx-retained-notes]') || body.querySelector<HTMLElement>('.jdx-analysis-notes-text')
    if (!target || target.closest('[hidden]')) return
    notesFocusPending = false
    target.focus({ preventScroll: true })
    target.scrollIntoView?.({ block: 'nearest' })
  }
  const updateReferenceNotice = () => {
    message.textContent = attachmentReferences && activeAnalysisTab === 'references'
      ? uiText('此版本未保存参考文献关联。下方展示当前 PDF 附件的参考文献记录。', 'This version has no linked bibliography. The references below are saved for this attachment.') : ''
  }
  const rows = () => jobs.list(mode === 'source' ? 'extraction' : 'translation').filter(task => sameAttachment(task.source, source))
  let feedbackToast: ToastHandle | undefined
  // 普通操作反馈自动消失；风险与进行中提示保留在任务区域。
  const feedback = (text: string, type: ToastType = 'success') => {
    if (disposed) return
    feedbackToast?.close()
    feedbackToast = show({ document: doc, themeRoot: root, type, message: text })
  }
  cleanups.push(() => feedbackToast?.close())
  const report = (error: unknown) => { if (!disposed) { message.textContent = error instanceof Error ? error.message : String(error); message.dataset.kind = 'error' } }
  /** 读取失败局部恢复，不重放提取/翻译；迟到的磁盘读取不再进入渲染分支。 */
  const readResult = async <T,>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Result read timed out'), { code: 'SIDEBAR_RESULTS_TIMEOUT' })), 10000) })]) }
    finally { clearTimeout(timer) }
  }
  const readFailed = (error: unknown) => {
    if (disposed) return
    signature = ''
    const trace = lifecycleTrace(host, 'document-results', 'read')
    trace.fail(error, 'content_read'); trace.end('error')
    const empty = emptyResult(doc, uiText('成果暂时无法读取', 'Results are temporarily unavailable'), uiText('请重试读取，或在工作台查看。此操作不会重新提取或生成。', 'Retry reading, or view in the workspace. This does not extract or generate again.'))
    if (trace.id) empty.append(element(doc, 'small', '', uiText(`诊断编号：${trace.id}`, `Diagnostic ID: ${trace.id}`)))
    empty.append(action(doc, uiText('重试读取', 'Retry reading'), () => { void readResult(jobs.ready).then(refresh).catch(readFailed) }))
    body.replaceChildren(empty)
  }
  body.append(emptyResult(doc, uiText('正在读取成果…', 'Loading results…'), ''))
  if (mode === 'source') {
    toolbar.append(action(doc, uiText('复制 Markdown', 'Copy Markdown'), () => {
      if (selected) void jobs.store.extraction(selected).then(value => copyTextToClipboard(host, value?.markdown || '')).then(ok => { feedback(ok ? uiText('已复制', 'Copied') : uiText('复制失败', 'Copy failed'), ok ? 'success' : 'error') }).catch(report)
    }))
  }
  const copy = Array.from(toolbar.children).find(child => child.textContent === uiText('复制 Markdown', 'Copy Markdown')) as HTMLButtonElement | undefined
  if (mode === 'source' && copy) actionIcon(copy, 'copy')
  const analysisOptions: AnalysisOptions = options.analysis ?? {
    records: () => analysisRuntime(host).records(), unsaved: id => analysisRuntime(host).unsaved(id),
    openSource: async record => { await navigateDocument(host as unknown as DocumentHost, record, { pageIndex: 0 }, options.readerDocument); return true },
    stop: record => { analysisRuntime(host).stop(record.itemID); for (const task of jobs.list('references').filter(task => sameAttachment(task.source, record))) jobs.pause(task.id) }, onReferenceTask: () => {},
  }
  async function refresh() {
    if (disposed) return
    if (refreshing) { dirty = true; return }
    refreshing = true
    try { do {
      dirty = false
      if (mode === 'analysis' && !options.analysis) analysisRun = analysisRuntime(host).get(source.itemID)
      const selections = mode === 'selection' && host.Prefs
        ? readTranslationHistory(host.Prefs).records.filter(record => sameAttachment(record.source, source)) : []
      const records = mode === 'analysis' ? analysisOptions.records().filter(record => sameAttachment(record.source, source))
        : mode === 'selection' ? selections : rows()
      const ordered = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      if (!selected || !ordered.some(record => record.id === selected)) selected = ordered[0]?.id
      // 历史解析引用自己的参考文献任务；当前运行的进度只属于当前版本。
      const analysisRecord = mode === 'analysis' ? ordered.find(record => record.id === selected) : undefined
      const requestedTask = mode === 'analysis' && requestedRecordID ? jobs.get(requestedRecordID) : undefined
      const referenceTaskID = requestedTask?.kind === 'references' ? requestedTask.id
        : analysisRecord && 'referenceTaskID' in analysisRecord ? analysisRecord.referenceTaskID : undefined
      showAnalysisRun = selected === ordered[0]?.id
      if (mode === 'analysis') {
        attachmentReferences = ordered.length > 1 && !referenceTaskID && jobs.list('references').some(task => sameAttachment(task.source, source))
        updateReferenceNotice()
      }
      versions.setOptions(ordered.map(record => ({ value: record.id, label: `${new Date(record.createdAt).toLocaleString()}${'languages' in record && record.languages ? ` · ${translationLanguageDisplayLabel(record.languages.targetLanguage)}` : ''}${'status' in record ? ` · ${resultStatus(record.status)}` : ''}` })), selected || '')
      versionHost.hidden = ordered.length < 2 || mode === 'selection'
      if (savedKind) savedKind.hidden = !selected
      toolbar.hidden = !Array.from(toolbar.children).some(child => !(child as HTMLElement).hidden)
      const task = selected ? jobs.get(selected) : undefined
      const nextSignature = mode === 'selection' ? JSON.stringify(records)
        : mode === 'analysis' ? JSON.stringify([mode, selected, referenceTaskID, showAnalysisRun])
        : `${mode}:${selected || ''}:${mode === 'source' ? task?.status : ''}`
      if (mode === 'source') {
        const running = rows().find(row => row.status === 'running')
        message.textContent = task?.error || (running ? jobs.translationPhase(running.id) || uiText('正在提取原文…', 'Extracting source…') : task?.warnings.length ? task.warnings.join('\n') : task && task.status !== 'complete' ? resultStatus(task.status) : uiText('全文提取已停用，已有 Markdown 仍可查看和复制。', 'Document extraction has been retired. Saved Markdown remains available to read and copy.'))
        message.dataset.kind = task?.error ? 'error' : running ? 'running' : task?.status || 'neutral'
      }
      if (mode === 'source') renderDocumentIssueActions(issueActions, host, task?.issue)
      if (mode === 'source' && task?.storageWarning) { message.textContent = uiText('成果未完整保存，关闭窗口前请复制。', 'Not fully saved. Copy before closing.'); message.dataset.kind = 'error' }
      if (nextSignature === signature) { if (analysisRun && showAnalysisRun) analysis?.setRun(analysisRun); analysis?.refresh(); continue }
      signature = nextSignature; stopContent(); stopContent = () => {}; analysis = undefined; body.replaceChildren()
      if (mode === 'source') {
        body.append(emptyResult(doc, uiText('正在读取原文…', 'Loading source…'), ''))
        const [value, assets] = selected ? await Promise.all([readResult(jobs.store.extraction(selected)), readResult(jobs.store.assets(selected)).catch((): Record<string, string> => ({}))]) : [null, {} as Record<string, string>]
        if (disposed) return
        body.replaceChildren()
        const text = element(doc, 'div', 'jdx-markdown jdx-reading-block')
        updateChatMarkdown(text, value?.markdown || uiText('暂无已保存的原文 Markdown。', 'No saved source Markdown.'), assets)
        if (value) body.append(text)
        else body.append(emptyResult(doc, uiText('先准备原文', 'Prepare the source'), text.textContent || ''))
        if (value?.assets.some(asset => !assets[`jdx-asset:${asset}`])) message.textContent = uiText('部分图片不可用，正文仍可阅读和翻译。', 'Some images are unavailable. Text remains readable and translatable.')
      } else if (mode === 'translation') {
        if (selected) stopContent = mountTranslationReader(body, host, selected, { readerDocument: options.readerDocument, onReplace: id => { selected = id; signature = ''; void refresh() } })
        else {
          const openBilingual = options.onOpenBilingual
          const empty = emptyResult(doc, uiText('暂无历史全文译文', 'No saved full translations'), openBilingual
            ? uiText('在对照翻译中并排阅读原文和译文。', 'Read the original and translated PDF side by side.')
            : uiText('请在 PDF 阅读器工具条中打开「对照翻译」。', 'Open Bilingual PDF from the PDF reader toolbar.'))
          const openPDF = options.analysis?.openSource
          if (openBilingual || openPDF) {
            const label = openBilingual ? uiText('打开对照翻译', 'Open bilingual PDF') : uiText('打开 PDF 阅读器', 'Open PDF reader')
            const open = action(doc, label, async () => {
              open.disabled = true; message.textContent = ''
              try {
                if (openBilingual) await openBilingual()
                else if (!await openPDF!(source)) report(uiText('原 PDF 不可用。', 'The original PDF is unavailable.'))
              } catch (error) { report(error) }
              finally { if (!disposed) open.disabled = false }
            })
            empty.append(open)
          }
          body.append(empty)
        }
      } else if (mode === 'analysis') {
        analysis = mountAnalysisWorkspace(body, host, { ...analysisOptions, embedded: true, hideTabs: options.hideAnalysisTabs, referenceTaskID,
          onOpenNotes: options.onOpenAnalysisNotes ? () => options.onOpenAnalysisNotes?.(selected) : analysisOptions.onOpenNotes,
          records: () => analysisOptions.records().filter(record => sameAttachment(record.source, source) && (!selected || record.id === selected)) })
        analysis.open(source, activeAnalysisTab ?? (requestedTask?.kind === 'references' ? 'references' : undefined))
        if (analysisRun && showAnalysisRun) analysis.setRun(analysisRun)
        focusNotesWhenReady()
        stopContent = () => analysis?.remove()
      } else {
        for (const record of selections) {
          const entry = element(doc, 'article', 'jdx-selection-result')
          const content = element(doc, 'div', 'jdx-selection-content'); content.id = `jdx-selection-${Math.random().toString(36).slice(2)}`; content.hidden = record.id !== options.recordID
          const title = action(doc, '', () => { content.hidden = !content.hidden; title.setAttribute('aria-expanded', String(!content.hidden)) }); title.classList.add('jdx-selection-toggle')
          title.setAttribute('aria-expanded', String(!content.hidden)); title.setAttribute('aria-controls', content.id)
          const meta = element(doc, 'span', 'jdx-selection-meta')
          const page = record.source.pageLabel || (record.source.pageIndex !== undefined ? String(record.source.pageIndex + 1) : '')
          if (page) meta.append(element(doc, 'span', '', uiText(`第 ${page} 页`, `Page ${page}`)))
          meta.append(element(doc, 'span', '', translationLanguageDisplayLabel(record.result.targetLanguage)), element(doc, 'time', '', new Date(record.createdAt).toLocaleString()))
          title.append(element(doc, 'span', 'jdx-selection-preview', record.source.text.slice(0, 90)), meta, createChevron(doc, 'jdx-selection-chevron', 'down', 16))
          const original = element(doc, 'div', 'jdx-markdown'), translated = element(doc, 'div', 'jdx-markdown')
          updateChatMarkdown(original, record.source.text); updateChatMarkdown(translated, record.result.text)
          content.append(element(doc, 'h4', '', uiText('原文', 'Source')), original, element(doc, 'h4', '', record.result.targetLanguage), translated,
            action(doc, uiText('打开原文位置', 'Go to source'), () => { void navigateDocument(host as unknown as DocumentHost, source, { pageIndex: record.source.pageIndex ?? 0 }, options.readerDocument).catch(report) }))
          entry.append(title, content)
          body.append(entry)
        }
        if (!body.childNodes.length) body.append(emptyResult(doc, uiText('暂无选中翻译', 'No selection translations'), uiText('在当前 PDF 中选中文字并翻译，记录会显示在这里。', 'Select and translate text in this PDF to keep a record here.')))
      }
    } while (dirty && !disposed) } catch (error) { readFailed(error) } finally { refreshing = false }
  }
  versions.onChange(value => { selected = value; requestedRecordID = value; void refresh() })
  if (mode === 'analysis') cleanups.push(analysisRuntime(host).subscribe(() => { void refresh() }))
  cleanups.push(jobs.subscribe(() => { void refresh() }))
  for (const key of [TRANSLATION_HISTORY_PREF_KEY, PAPER_ANALYSIS_HISTORY_PREF_KEY]) {
    try { const id = host.Prefs?.registerObserver?.(key, () => { void refresh() }); if (id !== undefined) cleanups.push(() => host.Prefs?.unregisterObserver?.(id)) } catch { /* 切换视图仍会读取。 */ }
  }
  void readResult(jobs.ready).then(refresh).catch(readFailed)
  return {
    refresh, selectedRecordID: () => selected,
    focusNotes() { notesFocusPending = true; focusNotesWhenReady() },
    setAnalysisTab(tab: AnalysisDetailTab) {
      if (activeAnalysisTab === tab) return
      activeAnalysisTab = tab; updateReferenceNotice(); analysis?.open(source, tab)
    },
    setRun(run: AnalysisRunView) { if (paperKey(run.source) === paperKey(source)) { analysisRun = run; if (showAnalysisRun) analysis?.setRun(run) } },
    remove() { disposed = true; stopContent(); versions.destroy(); cleanups.forEach(stop => stop()) },
  }
}

/** 空状态沿用文档式层级，不依赖系统表单外观。 */
function emptyResult(doc: Document, title: string, description: string) {
  const node = element(doc, 'div', 'jdx-result-empty')
  node.append(element(doc, 'h3', '', title), element(doc, 'p', '', description))
  return node
}
