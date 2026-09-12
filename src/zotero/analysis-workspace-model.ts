/** 单篇解析读取投影：按可信附件身份聚合，旧数据不迁移，读取不启动任何任务。 */
import type { PaperAnalysisRecord, PaperAnalysisSource } from "@/chat/paper-analysis-history"
import type { DocumentIdentity } from "./pdf-document"
import type { DocumentTask } from "./document-store"
import type { TranslationRecord } from '@/chat/translation-history'
import { literatureIdentity } from './document-identity'
import type { ZoteroLike } from './runtime'

export type LiteratureResult = { id: string; date: string; mode: 'source' | 'translation' | 'selection' | 'analysis'; source: PaperAnalysisSource; task?: DocumentTask; analysis?: PaperAnalysisRecord; selection?: TranslationRecord }
export type LiteraturePaper = { key: string; title: string; source: PaperAnalysisSource; date: string; results: LiteratureResult[]; attachments: PaperAnalysisSource[] }

/** 各成果只投影索引，不复制正文；可信父条目聚合，缺身份旧记录独立保留。 */
export function literaturePapers(host: ZoteroLike, analyses: PaperAnalysisRecord[], tasks: DocumentTask[], selections: TranslationRecord[]): LiteraturePaper[] {
  const entries: LiteratureResult[] = [
    ...analyses.map(record => ({ id: record.id, date: record.createdAt, mode: 'analysis' as const, source: record.source, analysis: record })),
    ...tasks.map(task => ({ id: task.id, date: task.createdAt, mode: task.kind === 'extraction' ? 'source' as const : task.kind === 'translation' ? 'translation' as const : 'analysis' as const, source: { ...task.source, authors: [] }, task })),
    ...selections.map(record => ({ id: record.id, date: record.createdAt, mode: 'selection' as const, source: { ...record.source, libraryID: record.source.libraryID ?? -1, itemKey: record.source.itemKey ?? '', title: record.source.title || 'PDF', authors: [] }, selection: record })),
  ]
  const papers = new Map<string, LiteraturePaper>()
  for (const entry of entries.sort((a, b) => b.date.localeCompare(a.date))) {
    const owner = literatureIdentity(host, entry.source)
    const key = owner ? `literature:${paperKey(owner)}` : entry.source.itemKey ? `attachment:${paperKey(entry.source)}` : `legacy:${entry.mode}:${entry.id}`
    let paper = papers.get(key)
    if (!paper) { paper = { key, title: owner?.title || entry.source.title, source: entry.source, date: entry.date, results: [], attachments: [] }; papers.set(key, paper) }
    paper.results.push(entry)
    if (!paper.attachments.some(source => paperKey(source) === paperKey(entry.source))) paper.attachments.push(entry.source)
  }
  return [...papers.values()]
}

export type AnalysisPaper = { key: string; source: PaperAnalysisSource; record?: PaperAnalysisRecord; references?: DocumentTask; date: string }
export function paperKey(source: Pick<DocumentIdentity, "itemID" | "libraryID" | "itemKey">) {
  return JSON.stringify([source.libraryID, source.itemKey, source.itemID])
}

/** 可选任务链接只能连接同一附件；损坏链接不会给另一篇论文的内容或定位授权。 */
export function analysisPapers(records: PaperAnalysisRecord[], tasks: DocumentTask[]): AnalysisPaper[] {
  const papers = new Map<string, AnalysisPaper>()
  for (const record of [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = paperKey(record.source)
    if (!papers.has(key)) papers.set(key, { key, source: record.source, record, date: record.createdAt })
  }
  for (const task of [...tasks].filter(task => task.kind === "references").sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = paperKey(task.source)
    let paper = papers.get(key)
    if (!paper) { paper = { key, source: { ...task.source, authors: [] }, date: task.createdAt }; papers.set(key, paper) }
    if (!paper.references && (!paper.record?.referenceTaskID || paper.record.referenceTaskID === task.id)) paper.references = task
  }
  return [...papers.values()].sort((a, b) => b.date.localeCompare(a.date))
}
