import { uiText } from "@/zotero/ui-preferences"
/**
 * 独立文献解析任务协调器。
 * 上游接收 Reader 附件 ID 与独立模型偏好，下游只写解析历史和 Zotero 原生批注；不接触 Chat 存储。
 */
import { ByokChatClient, type ByokConfig } from "@/chat/byok-chat"
import {
  appendPaperAnalysisRecord,
  MAX_ANALYSIS_NOTES_LENGTH,
  type PaperAnalysisHistoryPreferenceStore,
  type PaperAnalysisRecord,
} from "@/chat/paper-analysis-history"
import { buildPaperAnalysisPrompt, formatPaperAnalysis, parsePaperAnalysis } from "@/chat/paper-analysis"
import { TemporaryChatClient, type TemporaryChatSendInput } from "@/chat/temporary-chat"
import { featureModelState, type PaperAnalysisModelSelection } from "./ai-settings"
import { readPdfForAnalysis, saveAnalysisAnnotations, type PdfAnalysisSnapshot, type SavedAnalysisAnnotations, type ZoteroReaderHost } from "./reader-tools"
import { readConnection, type ZoteroLike } from "./runtime"

export const PAPER_ANALYSIS_MISSING_SUMMARY = "本次解析未返回总结。"

type PaperAnalysisZotero = ZoteroLike & ZoteroReaderHost

export type PaperAnalysisModelState = {
  selection: PaperAnalysisModelSelection
  label: string
  ready: boolean
  issue: string
  config?: ByokConfig
}

export type PaperAnalysisRunResult = {
  record: PaperAnalysisRecord
  coverage: string
  historySaved: boolean
  historyError?: string
  annotations: SavedAnalysisAnnotations
  annotationError?: string
}

type PaperAnalysisRunnerServices = {
  readPdf: typeof readPdfForAnalysis
  send(input: TemporaryChatSendInput, model: PaperAnalysisModelState): Promise<string>
  appendHistory(store: PaperAnalysisHistoryPreferenceStore, record: PaperAnalysisRecord): PaperAnalysisRecord
  saveAnnotations: typeof saveAnalysisAnnotations
}

function taskId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.()
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}

function notify(callback: ((message: string) => void) | undefined, message: string) {
  try { callback?.(message) } catch { /* 进度 UI 不得改变解析结果。 */ }
}

function coverageText(snapshot: PdfAnalysisSnapshot, forDisplay = true) {
  // 请求上下文使用原有中文范围说明；显示语言只改变界面摘要。
  const label = (zh: string, en: string) => forDisplay ? uiText(zh, en) : zh
  const text = [
    label(`PDF 共 ${snapshot.coverage.totalPages} 页，读取 ${snapshot.coverage.pagesRead} 页。`, `Read ${snapshot.coverage.pagesRead} of ${snapshot.coverage.totalPages} PDF pages.`),
    label(`提供 ${snapshot.passages.length} 段可定位原文。`, `${snapshot.passages.length} source passages can be located.`),
    snapshot.coverage.limited ? label("已按页或句子抽样，不代表完整全文。", "Pages or sentences were sampled; this is not the complete text.") : "",
    ...snapshot.coverage.warnings,
  ].filter(Boolean).join(" ")
  return text.length > 800 ? `${text.slice(0, 760)}${label("…（说明过长，已截短）", "… (notice truncated)")}` : text
}

function analysisCitation(snapshot: PdfAnalysisSnapshot) {
  const metadata = snapshot.metadata
  return [
    metadata.authors.join("; "),
    metadata.date || metadata.year,
    metadata.publicationTitle,
    metadata.doi ? `DOI: ${metadata.doi}` : "",
  ].filter(Boolean).join(". ")
}

/** 独立模型失效时不回退，避免把文献发送到用户未选择的隐私或计费目的地。 */
export function paperAnalysisModelState(zotero: ZoteroLike, invalidJadenseToken: string | null = null): PaperAnalysisModelState {
  return featureModelState(zotero, "analysis", invalidJadenseToken)
}

function defaultServices(zotero: PaperAnalysisZotero, fetchImpl: typeof fetch): PaperAnalysisRunnerServices {
  return {
    readPdf: readPdfForAnalysis,
    appendHistory: appendPaperAnalysisRecord,
    saveAnnotations: saveAnalysisAnnotations,
    async send(input, model) {
      if (model.selection.route === "byok") {
        return new ByokChatClient({ config: model.config!, fetchImpl }).send(input)
      }
      const connection = readConnection(zotero)
      return new TemporaryChatClient({ baseUrl: connection.baseUrl, token: connection.token, selection: model.selection.selection, fetchImpl }).send({ ...input, clientFeature: "analysis" })
    },
  }
}

/** 先备份可读结果，再独立写原生批注；未完成流只保留文字，不触发写入或额外 AI 请求。 */
export async function runIndependentPaperAnalysis(input: {
  zotero: PaperAnalysisZotero
  itemID: number
  fetchImpl: typeof fetch
  signal: AbortSignal
  invalidJadenseToken?: string | null
  onProgress?: (message: string) => void
  recordID?: string
  createdAt?: string
  services?: Partial<PaperAnalysisRunnerServices>
}): Promise<PaperAnalysisRunResult> {
  const model = paperAnalysisModelState(input.zotero, input.invalidJadenseToken)
  if (!model.ready) throw new Error(model.issue)
  const defaults = defaultServices(input.zotero, input.fetchImpl)
  const services = { ...defaults, ...input.services }

  notify(input.onProgress, uiText("正在读取 PDF 原文与句子位置…", "Reading PDF text and sentence positions…"))
  const snapshot = await services.readPdf(input.zotero, input.itemID, {
    signal: input.signal,
    onProgress: ({ pagesRead, totalPages }) => notify(input.onProgress, uiText(`正在读取 PDF：${pagesRead} / ${totalPages} 页…`, `Reading PDF: ${pagesRead} / ${totalPages} pages…`)),
  })
  input.signal.throwIfAborted()
  const coverage = coverageText(snapshot)
  const requestID = input.recordID ?? taskId("analysis")
  const prompt = buildPaperAnalysisPrompt({
    title: snapshot.metadata.title,
    citation: analysisCitation(snapshot),
    passages: snapshot.passages,
    coverage: coverageText(snapshot, false),
  })

  notify(input.onProgress, uiText(`正在使用${model.label}按结构解析文献…`, `Analyzing the paper with ${model.label}…`))
  let response = ""
  let partialText = ""
  let generationWarning: string | undefined
  try {
    response = await services.send({
      clientRequestId: taskId("analysis-request"),
      conversationId: requestID,
      messages: [{ id: taskId("analysis-prompt"), role: "user", text: prompt }],
      sources: [],
      signal: input.signal,
      requireComplete: true,
      onTextDelta: (_delta, accumulatedText) => {
        partialText = accumulatedText.slice(0, 256_000)
      },
    }, model)
    input.signal.throwIfAborted()
  } catch (error) {
    response ||= partialText
    if (!response.trim()) throw error
    generationWarning = input.signal.aborted
      ? uiText("生成已停止；已保留收到的部分内容供核对，未写入 PDF 批注。", "Generation stopped. Received content was retained for review; no PDF annotations were written.")
      : uiText("AI 响应未完整结束；已保留收到的部分内容供核对，未写入 PDF 批注。", "The AI response was incomplete. Received content was retained for review; no PDF annotations were written.")
  }
  const analysis = parsePaperAnalysis(response, snapshot.passages)
  const warnings = [...(generationWarning ? [generationWarning] : []), ...analysis.warnings]
  if (analysis.skipped) warnings.push(uiText(`有 ${analysis.skipped} 条内容未作为 PDF 批注采用；可恢复的笔记已保留供阅读。`, `${analysis.skipped} entries were not used as PDF annotations. Recoverable notes were retained for review.`))

  const record: PaperAnalysisRecord = {
    id: requestID,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: {
      itemID: snapshot.itemID,
      libraryID: snapshot.libraryID,
      itemKey: snapshot.itemKey,
      title: snapshot.metadata.title,
      authors: snapshot.metadata.authors,
      ...(snapshot.metadata.date ? { date: snapshot.metadata.date } : {}),
      ...(snapshot.metadata.year ? { year: snapshot.metadata.year } : {}),
      ...(snapshot.metadata.publicationTitle ? { publicationTitle: snapshot.metadata.publicationTitle } : {}),
      ...(snapshot.metadata.doi ? { doi: snapshot.metadata.doi } : {}),
    },
    summary: analysis.summary || uiText(PAPER_ANALYSIS_MISSING_SUMMARY, "No summary was returned for this analysis."),
    notes: formatPaperAnalysis(analysis, MAX_ANALYSIS_NOTES_LENGTH - 1_600),
    warnings,
  }

  let historySaved = true
  let historyError: string | undefined
  notify(input.onProgress, uiText("正在保存解析总结与笔记备份…", "Saving the analysis summary and notes…"))
  const writePending = !generationWarning && analysis.annotations.length > 0
  if (writePending) record.warnings = [...warnings, uiText("PDF 批注写入尚未确认；解析笔记已保留。", "PDF annotation writes have not been confirmed. Analysis notes were retained.")]
  try {
    if (!input.zotero.Prefs) throw new Error("missing preferences")
    services.appendHistory(input.zotero.Prefs, record)
  } catch {
    historySaved = false
    historyError = uiText("解析历史保存失败；笔记暂留当前窗口，请及时复制。", "Could not save analysis history. Notes remain in this window; copy them before closing.")
      + (writePending ? uiText("已验证的原生批注仍会继续写入。", "Validated native annotations will still be written.") : "")
  }

  const emptyAnnotations: SavedAnalysisAnnotations = { created: 0, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }
  if (!writePending) return { record, coverage, historySaved, ...(historyError ? { historyError } : {}), annotations: emptyAnnotations }

  notify(input.onProgress, uiText("正在写入 Zotero 原生批注…", "Writing Zotero annotations…"))
  let annotations = emptyAnnotations
  let annotationError: string | undefined
  try {
    annotations = await services.saveAnnotations(input.zotero, snapshot, analysis.annotations, { signal: input.signal })
  } catch {
    annotations = { ...emptyAnnotations, unprocessed: analysis.annotations.length }
    annotationError = input.signal.aborted
      ? uiText("已停止写入；此前成功保存的批注予以保留，可展开笔记查看解析内容。", "Writing stopped. Previously saved annotations were retained; expand the notes to review the analysis.")
      : uiText("原生批注未能全部写入；解析笔记已保留，可展开查看和复制。", "Some native annotations could not be written. Expand the retained analysis notes to review or copy them.")
  }
  const writeSummary = annotationError
    ?? uiText(`PDF 批注：新增 ${annotations.created} 条，跳过 ${annotations.skipped} 条，失败 ${annotations.failed} 条，未执行 ${annotations.unprocessed} 条。`, `PDF annotations: ${annotations.created} created, ${annotations.skipped} skipped, ${annotations.failed} failed, ${annotations.unprocessed} unprocessed.`)
  record.notes += `\n\n${uiText("写入结果", "Write result")}\n${writeSummary}`
  record.warnings = [...warnings, ...(annotationError || annotations.failed || annotations.unprocessed ? [writeSummary] : []), ...annotations.warnings]
  // 替换同一记录的写入状态；失败时保留首次备份，不重发 AI 或原生写入。
  try {
    if (!input.zotero.Prefs) throw new Error("missing preferences")
    services.appendHistory(input.zotero.Prefs, record)
    historySaved = true
    historyError = undefined
  } catch {
    historyError = historySaved
      ? uiText("笔记备份已保存，但批注写入状态未能更新；当前结果暂留窗口，请及时复制。", "The notes were saved, but the annotation status could not be updated. Copy the current result before closing this window.")
      : historyError
  }
  return { record, coverage, historySaved, ...(historyError ? { historyError } : {}), annotations, ...(annotationError ? { annotationError } : {}) }
}
