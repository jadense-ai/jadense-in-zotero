/**
 * 文献解析结果的本地展示契约。
 * Manager 从本地 PDF 快照生成页码上下文，本地 Chat 只保存最小定位字段；
 * 旧解析正文可分段显示，但纯文本和模型输出本身不能赋予页码导航能力。
 */
import { ANALYSIS_CATEGORIES } from "./paper-analysis"

const MAX_RESEARCH_PAGES = 32
const MAX_PAGE_LABEL_LENGTH = 80
const ANALYSIS_TITLE = "文献解析（AI 辅助，请核对原文）"
const CATEGORY_LABELS = new Set<string>(ANALYSIS_CATEGORIES.map((category) => category.label))

export type ResearchMessageContext = {
  source: { itemID: number; libraryID: number; itemKey: string; title: string }
  pages: { pageIndex: number; pageLabel: string }[]
}

export type ResearchPresentationBlock =
  | { type: "heading"; level: 1 | 2; text: string }
  | { type: "paragraph"; text: string }
  | { type: "annotation"; category: string; pageLabel: string; quote: string; comment: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** 仅丢弃坏的可选导航数据；不保存 URL、路径、正文、模型能力或未知增量字段。 */
export function normalizeResearchMessageContext(value: unknown): ResearchMessageContext | undefined {
  const row = record(value)
  const source = record(row?.source)
  const itemKey = typeof source?.itemKey === "string" ? source.itemKey.trim() : ""
  if (!source || !nonNegativeInteger(source.itemID) || source.itemID === 0
    || !nonNegativeInteger(source.libraryID) || !itemKey || itemKey.length > 80 || !Array.isArray(row?.pages)) return undefined

  const byLabel = new Map<string, number | null>()
  for (const value of row.pages) {
    const page = record(value)
    const label = typeof page?.pageLabel === "string" ? page.pageLabel.trim() : ""
    if (!page || !nonNegativeInteger(page.pageIndex) || !label || label.length > MAX_PAGE_LABEL_LENGTH) continue
    // 必须在限量前检查全部候选；否则截掉冲突页后，重载会把歧义标签误当作唯一页码。
    if (!byLabel.has(label)) byLabel.set(label, page.pageIndex)
    else if (byLabel.get(label) !== page.pageIndex) byLabel.set(label, null)
  }
  const pages = [...byLabel].flatMap(([pageLabel, pageIndex]) => pageIndex === null ? [] : [{ pageIndex, pageLabel }])
    .slice(0, MAX_RESEARCH_PAGES)
  // 没有可安全匹配的页标时仍保留附件身份，Manager 可以打开原 PDF，但不能猜测跳页。
  return {
    source: {
      itemID: source.itemID,
      libraryID: source.libraryID,
      itemKey,
      title: typeof source.title === "string" ? source.title.trim().slice(0, 500) || "PDF 文献" : "PDF 文献",
    },
    pages,
  }
}

/** 显示标签只与本地提供的标签精确匹配；罗马数字、前导零与附件页号均不可猜测。 */
export function resolveResearchPage(
  context: ResearchMessageContext | undefined,
  label: string,
): ResearchMessageContext["pages"][number] | undefined {
  const normalized = normalizeResearchMessageContext(context)
  return normalized?.pages.find((page) => page.pageLabel === label.trim())
}

/** 只识别本项目固定解析文案，不解析 Markdown、HTML、模型链接或执行指令。 */
export function parseResearchPresentation(text: string): ResearchPresentationBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim()
  if (!normalized) return []
  const textLines = normalized.split("\n")
  const titleIndex = textLines.findIndex((line) => line.trim() === ANALYSIS_TITLE)
  const isAnalysis = titleIndex >= 0
  // Manager 将写入状态/失败警告放在解析标题之前；这些前缀完整保留为普通文本。
  const prefix = titleIndex > 0 ? textLines.slice(0, titleIndex).join("\n").trim() : ""
  const body = isAnalysis ? textLines.slice(titleIndex).join("\n") : normalized
  const blocks = body.split(/\n[\t ]*\n+/).flatMap((part): ResearchPresentationBlock[] => {
    const lines = part.trim().split("\n")
    const first = lines[0].trim()
    if (isAnalysis && (first === ANALYSIS_TITLE || first === "总体概述" || CATEGORY_LABELS.has(first)
      || /^关键句与批注（\d+ 条）$/.test(first))) {
      const blocks: ResearchPresentationBlock[] = [{ type: "heading", level: first === ANALYSIS_TITLE ? 1 : 2, text: first }]
      const rest = lines.slice(1).join("\n").trim()
      if (rest) blocks.push({ type: "paragraph", text: rest })
      return blocks
    }
    const annotation = isAnalysis ? /^【([^】]+)】第\s+(.+?)\s+页$/.exec(first) : null
    const commentIndex = lines.findIndex((line, index) => index > 1 && line.startsWith("AI 批注："))
    if (annotation && CATEGORY_LABELS.has(annotation[1]) && lines[1]?.startsWith("原句：") && commentIndex > 1) {
      const quote = lines.slice(1, commentIndex).join("\n").slice("原句：".length).trim()
      const comment = lines.slice(commentIndex).join("\n").slice("AI 批注：".length).trim()
      if (quote && comment) return [{ type: "annotation", category: annotation[1], pageLabel: annotation[2], quote, comment }]
    }
    return [{ type: "paragraph", text: part.trim() }]
  })
  return prefix ? [{ type: "paragraph", text: prefix }, ...blocks] : blocks
}
