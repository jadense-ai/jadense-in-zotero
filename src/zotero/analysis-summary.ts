/** 完整分段成果的本地整理与批注交付；摘要增强和展示容量不拥有整次解析的失败状态。 */
import { parsePaperAnalysis, type AnalysisPassage, type PaperAnalysisResult } from '@/chat/paper-analysis'
import { retainCompletedAnalysis, restoreSummarySources, type AnalysisInputPlan } from './analysis-input'
import { uiText } from './ui-preferences'

/** 完整响应已有正文时，从现有 section 或批注说明补出展示概览，缺少顶层 summary 不触发重生成。 */
export function fillAnalysisSummary(response: string, passages: readonly AnalysisPassage[]) {
  const parsed = parsePaperAnalysis(response, passages)
  if (parsed.summary || parsed.rawText) return response
  const summary = (parsed.sections.map(section => section.summary).join('\n\n')
    || [...parsed.annotations, ...(parsed.notes ?? [])].map(annotation => annotation.comment).join('\n\n')).slice(0, 1600)
  return summary ? JSON.stringify({ summary, sections: parsed.sections,
    annotations: [...parsed.annotations, ...(parsed.notes ?? [])].map(({ passageId, category, comment }) => ({ passageId, category, comment })) }) : response
}

/** 批注逐组重新校验，避免把原句重复序列化后撞上单次模型响应的字符边界。 */
export function attachAnalysisCandidates(analysis: PaperAnalysisResult, plan: AnalysisInputPlan | undefined, passages: readonly AnalysisPassage[]) {
  if (!plan?.annotationCandidates?.length) return analysis
  const annotations = new Map(analysis.annotations.map(row => [JSON.stringify([row.passageId, row.category]), row]))
  for (let offset = 0; offset < plan.annotationCandidates.length; offset += 64) {
    const candidates = plan.annotationCandidates.slice(offset, offset + 64).map(({ passageId, category, comment }) => ({ passageId, category, comment }))
    const parsed = parsePaperAnalysis(JSON.stringify({ annotations: candidates }), passages)
    for (const row of parsed.annotations) annotations.set(JSON.stringify([row.passageId, row.category]), row)
  }
  return { ...analysis, annotations: [...annotations.values()] }
}

/** 本地只编排已有文字，不编造新结论；短概览覆盖每段，完整分段总结与证据留在笔记。 */
export function localAnalysisSummary(plan: AnalysisInputPlan, passages: readonly AnalysisPassage[]): PaperAnalysisResult | undefined {
  restoreSummarySources(plan, passages)
  if (!plan.sourceNotes?.length) retainCompletedAnalysis(plan, passages)
  const notes = plan.sourceNotes?.filter(note => note.summary.trim() || note.sections.some(section => section.summary.trim()))
  if (!notes?.length) return undefined
  const part = (index: number) => uiText(`第 ${index + 1} 部分`, `Part ${index + 1}`)
  const summaryLimit = Math.max(1, Math.floor(1600 / notes.length) - 24)
  const sections: PaperAnalysisResult['sections'] = notes.flatMap((note, index) => [
    ...(note.summary ? [{ category: 'additional' as const, summary: `${part(index)}\n${note.summary}` }] : []),
    ...note.sections.map(section => ({ ...section, summary: `${part(index)}\n${section.summary}` })),
  ])
  const summary = notes.map((note, index) => {
    const text = note.summary || note.sections.map(section => section.summary).join(' ')
    return `${part(index)}：${text.length > summaryLimit ? `${text.slice(0, summaryLimit)}…` : text}`
  }).join('\n\n').slice(0, 1600)
  if (!sections.length && !summary.trim()) return undefined
  return { summary, sections, annotations: [], skipped: 0, warnings: [] }
}
