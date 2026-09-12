/** 当前附件的只读成果界面：Reader 与文献详情共用，任务仅由明确按钮启动。 */
import { updateChatMarkdown } from '@/chat/markdown'
import { readTranslationHistory, TRANSLATION_HISTORY_PREF_KEY } from '@/chat/translation-history'
import { readPaperAnalysisHistory, PAPER_ANALYSIS_HISTORY_PREF_KEY, type PaperAnalysisSource } from '@/chat/paper-analysis-history'
import { documentJobs } from './document-jobs'
import { paperKey } from './analysis-workspace-model'
import { mountAnalysisWorkspace, type AnalysisRunView, type AnalysisDetailTab } from './analysis-workspace'
import { mountTranslationReader, installTranslationReadingStyles } from './translation-reader'
import { copyTextToClipboard } from './connection-display'
import { navigateDocument, type DocumentHost } from './pdf-document'
import { actionIcon, element, action, notice } from './ui/controls'
import { createJdxSelect } from './ui/select'
import { uiText } from './ui-preferences'
import type { ZoteroLike } from './runtime'
import { readArticleTranslationLanguages, writeArticleTranslationLanguages } from './translation-settings'
import { TRANSLATION_LANGUAGES, translationLanguageDisplayLabel, type TranslationLanguages } from '@/chat/translation-languages'
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
  recordID?: string; readerDocument?: Document; analysis?: AnalysisOptions; analysisTab?: AnalysisDetailTab; hideAnalysisTabs?: boolean; onTranslate?(id: string): void; onWorkbench?(mode: DocumentResultMode, id?: string): void
} = {}) {
  const doc = root.ownerDocument, jobs = documentJobs(host)
  installTranslationReadingStyles(doc)
  if (!doc.getElementById('jdx-document-results-css')) {
    const link = element(doc, 'link'); link.id = 'jdx-document-results-css'; link.rel = 'stylesheet'; link.href = 'chrome://jadense-in-zotero/content/ui.css'
    ;(doc.head || doc.documentElement).append(link)
  }
  root.classList.add('jdx-document-results'); root.replaceChildren()
  const toolbar = element(doc, 'div', 'jdx-result-tools'), versionHost = element(doc, 'div', 'jdx-result-version'), message = notice(doc)
  const versions = createJdxSelect(versionHost, { compact: true, portal: true, ariaLabel: uiText('成果版本', 'Result version'), popupWidth: 300 })
  const body = element(doc, 'div', 'jdx-result-content'), status = notice(doc)
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', resultLabels()[mode]); root.dataset.resultMode = mode
  toolbar.append(versionHost); root.append(toolbar, message, body, status)
  if (options.onWorkbench) { const open = action(doc, uiText('在工作台查看', 'Open in workbench'), () => options.onWorkbench?.(mode, selected)); actionIcon(open, 'workbench'); open.classList.add('jdx-result-workbench'); toolbar.append(open) }
  const cleanups: Array<() => void> = []
  let selected = options.recordID, disposed = false, refreshing = false, dirty = false, signature = '', stopContent = () => {}, active: AbortController | undefined
  let analysis: ReturnType<typeof mountAnalysisWorkspace> | undefined
  let analysisRun: AnalysisRunView | undefined
  let selectedLanguages: TranslationLanguages | undefined
  let startingTranslation = false
  const rows = () => jobs.list(mode === 'source' ? 'extraction' : 'translation').filter(task => sameAttachment(task.source, source))
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined
  status.classList.add('jdx-result-toast')
  // 普通操作反馈自动消失；风险与进行中提示保留在任务区域。
  const feedback = (text: string) => {
    if (disposed) return
    clearTimeout(feedbackTimer); status.textContent = text; status.dataset.kind = 'complete'
    feedbackTimer = setTimeout(() => { status.textContent = '' }, 3500)
  }
  cleanups.push(() => clearTimeout(feedbackTimer))
  const report = (error: unknown) => { if (!disposed) { message.textContent = String(error); message.dataset.kind = 'error' } }
  const startExtraction = async (fresh: boolean) => {
    if (active) return
    active = new AbortController(); extract.disabled = true; cancel.hidden = false; status.textContent = ''; message.dataset.kind = 'running'
    try {
      const task = await jobs.start('extraction', source.itemID, fresh, { signal: active.signal, onProgress: text => { if (!disposed) message.textContent = text } })
      selected = task.id; signature = ''; await refresh(); if (task.status === 'complete') feedback(uiText('原文提取完成', 'Source extracted'))
    } catch (error) { report(error) }
    finally { active = undefined; if (!disposed) { extract.disabled = false; cancel.hidden = true } }
  }
  const extract = action(doc, uiText('提取原文', 'Extract source'), () => { void startExtraction(Boolean(rows().length)) })
  const cancel = action(doc, uiText('停止提取', 'Stop extraction'), () => { active?.abort(); const running = rows().find(task => task.status === 'running'); if (running) jobs.pause(running.id) }); cancel.hidden = true
  extract.classList.add('jdx-result-extract')
  const translate = action(doc, uiText('全文翻译', 'Translate full text'), () => {
    if (startingTranslation) return
    const extractionID = mode === 'source' ? selected : jobs.list('extraction').find(task => sameAttachment(task.source, source) && ['complete', 'partial'].includes(task.status))?.id
    startingTranslation = true; translate.disabled = true; message.textContent = ''; message.dataset.kind = 'neutral'
    void jobs.start('translation', source.itemID, true, { extractionID, languages: selectedLanguages, onProgress: text => { if (!disposed) { message.textContent = text; message.dataset.kind = 'running' } } }).then(task => {
      if (disposed) return
      message.textContent = ''
      if (mode === 'translation') { selected = task.id; signature = ''; void refresh() }
      else options.onTranslate?.(task.id)
    }).catch(report).finally(() => { startingTranslation = false; if (!disposed) void refresh() })
  })
  translate.classList.add('jdx-button-primary')
  if (mode === 'source') {
    toolbar.append(extract, cancel, action(doc, uiText('复制 Markdown', 'Copy Markdown'), () => {
      if (selected) void jobs.store.extraction(selected).then(value => copyTextToClipboard(host, value?.markdown || '')).then(ok => { feedback(ok ? uiText('已复制', 'Copied') : uiText('复制失败', 'Copy failed')) }).catch(report)
    }), translate)
  }
  if (mode === 'translation' || mode === 'source') {
    if (mode === 'translation') toolbar.append(translate)
    const languageHost = element(doc, 'div', 'jdx-result-language')
    const language = createJdxSelect(languageHost, { compact: true, portal: true, ariaLabel: uiText('目标语言', 'Target language'), popupWidth: 220 })
    const capsule = element(doc, 'div', 'jdx-translation-capsule')
    capsule.setAttribute('role', 'group'); capsule.setAttribute('aria-label', uiText('全文翻译', 'Full translation'))
    capsule.append(languageHost, translate); toolbar.append(capsule)
    // 语言选择沿用附件级偏好；更换语言仅影响下一次明确发起的翻译。
    void readArticleTranslationLanguages(host, source.itemID).then(value => { if (!disposed) { selectedLanguages ??= value; language.setOptions(TRANSLATION_LANGUAGES.map(row => ({ value: row.value, label: translationLanguageDisplayLabel(row.value) })), selectedLanguages.targetLanguage) } }).catch(() => {})
    language.onChange(value => { selectedLanguages = { sourceLanguage: selectedLanguages?.sourceLanguage || 'en', targetLanguage: value }; void writeArticleTranslationLanguages(host, source.itemID, selectedLanguages).catch(report) })
    cleanups.push(() => language.destroy())
  }
  actionIcon(extract, 'extract'); actionIcon(cancel, 'stop')
  const copy = Array.from(toolbar.children).find(child => child.textContent === uiText('复制 Markdown', 'Copy Markdown')) as HTMLButtonElement | undefined
  if (mode === 'source' && copy) actionIcon(copy, 'copy')
  const analysisOptions: AnalysisOptions = options.analysis ?? {
    records: () => host.Prefs ? readPaperAnalysisHistory(host.Prefs).records : [], unsaved: () => false,
    openSource: async record => { await navigateDocument(host as unknown as DocumentHost, record, { pageIndex: 0 }, options.readerDocument); return true },
    stop: record => { for (const task of jobs.list('references').filter(task => sameAttachment(task.source, record))) jobs.pause(task.id) }, onReferenceTask: () => {},
  }
  async function refresh() {
    if (disposed) return
    if (refreshing) { dirty = true; return }
    refreshing = true
    try { do {
      dirty = false
      const records = mode === 'analysis' ? analysisOptions.records().filter(record => sameAttachment(record.source, source))
        : mode === 'selection' ? (host.Prefs ? readTranslationHistory(host.Prefs).records : []).filter(record => sameAttachment(record.source, source)) : rows()
      const ordered = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      if (!selected || !ordered.some(record => record.id === selected)) selected = ordered[0]?.id
      versions.setOptions(ordered.map(record => ({ value: record.id, label: `${new Date(record.createdAt).toLocaleString()}${'languages' in record && record.languages ? ` · ${translationLanguageDisplayLabel(record.languages.targetLanguage)}` : ''}${'status' in record ? ` · ${resultStatus(record.status)}` : ''}` })), selected || '')
      versionHost.hidden = ordered.length < 2 || mode === 'selection'
      toolbar.hidden = !Array.from(toolbar.children).some(child => !(child as HTMLElement).hidden)
      const task = selected ? jobs.get(selected) : undefined
      const nextSignature = mode === 'selection' ? JSON.stringify(records) : `${mode}:${selected || ''}:${mode === 'source' ? task?.status : ''}`
      if (mode === 'source') {
        const running = rows().find(row => row.status === 'running')
        extract.textContent = rows().length ? uiText('重新提取', 'Extract again') : uiText('提取原文', 'Extract source')
        actionIcon(extract, rows().length ? 'refresh' : 'extract')
        extract.disabled = Boolean(active || running); cancel.hidden = !active && !running
        translate.disabled = startingTranslation || !task || !['complete', 'partial'].includes(task.status)
        message.textContent = task?.error || (running ? jobs.translationPhase(running.id) || uiText('正在提取原文…', 'Extracting source…') : task && task.status !== 'complete' ? resultStatus(task.status) : '')
        message.dataset.kind = task?.error ? 'error' : running ? 'running' : task?.status || 'neutral'
      }
      if (mode === 'translation') translate.disabled = startingTranslation
      if (mode === 'source' && task?.storageWarning) { message.textContent = uiText('成果未完整保存，关闭窗口前请复制。', 'Not fully saved. Copy before closing.'); message.dataset.kind = 'error' }
      if (nextSignature === signature) { analysis?.refresh(); continue }
      signature = nextSignature; stopContent(); stopContent = () => {}; analysis = undefined; body.replaceChildren()
      if (mode === 'source') {
        const value = selected ? await jobs.store.extraction(selected) : null, assets = selected ? await jobs.store.assets(selected) : {}
        if (disposed) return
        const text = element(doc, 'div', 'jdx-markdown jdx-reading-block')
        updateChatMarkdown(text, value?.markdown || uiText('先提取原文。完成后可阅读图文 Markdown，再手动翻译。', 'Extract the source, read its Markdown, then translate when ready.'), assets)
        if (value) body.append(text)
        else body.append(emptyResult(doc, uiText('先准备原文', 'Prepare the source'), text.textContent || ''))
        if (value?.assets.some(asset => !assets[`jdx-asset:${asset}`])) message.textContent = uiText('部分图片不可用，正文仍可阅读和翻译。', 'Some images are unavailable. Text remains readable and translatable.')
      } else if (mode === 'translation') {
        if (selected) stopContent = mountTranslationReader(body, host, selected, { readerDocument: options.readerDocument, onReplace: id => { selected = id; signature = ''; void refresh() } })
        else body.append(emptyResult(doc, uiText('开始全文翻译', 'Start a full translation'), uiText('选择目标语言，点击“全文翻译”。', 'Choose a target language and click Translate full text.')))
      } else if (mode === 'analysis') {
        const referenceTask = options.recordID ? jobs.get(options.recordID) : undefined
        analysis = mountAnalysisWorkspace(body, host, { ...analysisOptions, embedded: true, hideTabs: options.hideAnalysisTabs, referenceTaskID: referenceTask?.kind === 'references' ? referenceTask.id : undefined, records: () => analysisOptions.records().filter(record => sameAttachment(record.source, source) && (!selected || record.id === selected)) })
        analysis.open(source, referenceTask?.kind === 'references' ? 'references' : options.analysisTab)
        if (analysisRun) analysis.setRun(analysisRun)
        stopContent = () => analysis?.remove()
      } else {
        for (const record of host.Prefs ? readTranslationHistory(host.Prefs).records.filter(record => sameAttachment(record.source, source)) : []) {
          const entry = element(doc, 'article', 'jdx-selection-result')
          const content = element(doc, 'div', 'jdx-selection-content'); content.id = `jdx-selection-${Math.random().toString(36).slice(2)}`; content.hidden = record.id !== options.recordID
          const title = action(doc, '', () => { content.hidden = !content.hidden; title.setAttribute('aria-expanded', String(!content.hidden)) }); title.classList.add('jdx-selection-toggle')
          title.setAttribute('aria-expanded', String(!content.hidden)); title.setAttribute('aria-controls', content.id)
          title.append(element(doc, 'time', '', new Date(record.createdAt).toLocaleString()), element(doc, 'span', 'jdx-selection-preview', record.source.text.slice(0, 90)))
          const original = element(doc, 'div', 'jdx-markdown'), translated = element(doc, 'div', 'jdx-markdown')
          updateChatMarkdown(original, record.source.text); updateChatMarkdown(translated, record.result.text)
          content.append(element(doc, 'h4', '', uiText('原文', 'Source')), original, element(doc, 'h4', '', record.result.targetLanguage), translated,
            action(doc, uiText('打开原文位置', 'Go to source'), () => { void navigateDocument(host as unknown as DocumentHost, source, { pageIndex: record.source.pageIndex ?? 0 }, options.readerDocument).catch(report) }))
          entry.append(title, content)
          body.append(entry)
        }
        if (!body.childNodes.length) body.append(emptyResult(doc, uiText('暂无选中翻译', 'No selection translations'), uiText('在当前 PDF 中选中文字并翻译，记录会显示在这里。', 'Select and translate text in this PDF to keep a record here.')))
      }
    } while (dirty && !disposed) } catch (error) { report(error) } finally { refreshing = false }
  }
  versions.onChange(value => { selected = value; void refresh() })
  cleanups.push(jobs.subscribe(() => { void refresh() }))
  for (const key of [TRANSLATION_HISTORY_PREF_KEY, PAPER_ANALYSIS_HISTORY_PREF_KEY]) {
    try { const id = host.Prefs?.registerObserver?.(key, () => { void refresh() }); if (id !== undefined) cleanups.push(() => host.Prefs?.unregisterObserver?.(id)) } catch { /* 切换视图仍会读取。 */ }
  }
  void jobs.ready.then(refresh)
  return { refresh, setRun(run: AnalysisRunView) { if (paperKey(run.source) === paperKey(source)) { analysisRun = run; analysis?.setRun(run) } }, remove() { disposed = true; stopContent(); versions.destroy(); cleanups.forEach(stop => stop()) } }
}

/** 空状态沿用文档式层级，不依赖系统表单外观。 */
function emptyResult(doc: Document, title: string, description: string) {
  const node = element(doc, 'div', 'jdx-result-empty')
  node.append(element(doc, 'h3', '', title), element(doc, 'p', '', description))
  return node
}
