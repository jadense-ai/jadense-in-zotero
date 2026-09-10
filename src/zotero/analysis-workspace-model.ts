/** 单篇解析读取投影：按可信附件身份聚合，旧数据不迁移，读取不启动任何任务。 */
import type { PaperAnalysisRecord, PaperAnalysisSource } from "@/chat/paper-analysis-history"
import type { DocumentIdentity } from "./pdf-document"
import type { DocumentTask } from "./document-store"

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
