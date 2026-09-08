/** 本地页码身份和纯文本展示测试；未提供导航上下文的旧消息不获得跳页能力。 */
import { describe, expect, it } from "vitest"
import { formatPaperAnalysis } from "./paper-analysis"
import {
  normalizeResearchMessageContext,
  parseResearchPresentation,
  resolveResearchPage,
  type ResearchMessageContext,
} from "./research-presentation"

function context(): ResearchMessageContext {
  return {
    source: { itemID: 2, libraryID: 1, itemKey: "PDF00002", title: "研究文献" },
    pages: [{ pageIndex: 0, pageLabel: "i" }, { pageIndex: 3, pageLabel: "1" }],
  }
}

describe("research message navigation", () => {
  it("projects only local identity and usable pages while stripping additive capabilities", () => {
    const original = context()
    const result = normalizeResearchMessageContext({
      ...original,
      action: "open-url",
      source: { ...original.source, url: "javascript:unexpected()", path: "C:\\private\\paper.pdf", text: "do-not-copy", token: "secret-fixture" },
      pages: [...original.pages, { pageIndex: 3, pageLabel: "1", href: "https://unexpected.invalid" }, { pageIndex: -1, pageLabel: "bad" }],
    })
    expect(result).toEqual(original)
    expect(JSON.stringify(result)).not.toMatch(/javascript|private|unexpected|do-not-copy|secret-fixture/)
    expect(normalizeResearchMessageContext({ ...original, source: { ...original.source, itemID: -1 } })).toBeUndefined()
    expect(normalizeResearchMessageContext({ ...original, pages: "not-pages" })).toBeUndefined()
  })

  it("never guesses a physical page from a displayed number, leading zero, or roman numeral", () => {
    const metadata = { ...context(), pages: [{ pageIndex: 0, pageLabel: "i" }, { pageIndex: 5, pageLabel: "01" }, { pageIndex: 9, pageLabel: "1" }] }
    expect(resolveResearchPage(metadata, "i")).toEqual({ pageIndex: 0, pageLabel: "i" })
    expect(resolveResearchPage(metadata, "01")).toEqual({ pageIndex: 5, pageLabel: "01" })
    expect(resolveResearchPage(metadata, "1")).toEqual({ pageIndex: 9, pageLabel: "1" })
    expect(resolveResearchPage(metadata, "I")).toBeUndefined()
    expect(resolveResearchPage(metadata, "6")).toBeUndefined()
    expect(resolveResearchPage(undefined, "1")).toBeUndefined()
  })

  it("removes ambiguous labels before the 32-page cap so persistence cannot turn them into valid links", () => {
    const metadata = {
      ...context(),
      pages: [{ pageIndex: 0, pageLabel: "shared" },
        ...Array.from({ length: 35 }, (_, index) => ({ pageIndex: index + 1, pageLabel: `S${index + 1}` })),
        { pageIndex: 99, pageLabel: "shared" }],
    }
    const normalized = normalizeResearchMessageContext(metadata)
    expect(normalized?.pages).toHaveLength(32)
    expect(resolveResearchPage(metadata, "shared")).toBeUndefined()
    expect(resolveResearchPage(normalizeResearchMessageContext(JSON.parse(JSON.stringify(normalized))), "shared")).toBeUndefined()
    expect(resolveResearchPage(normalized, "S1")).toEqual({ pageIndex: 1, pageLabel: "S1" })
    expect(resolveResearchPage(normalized, "S35")).toBeUndefined()
  })

  it("retains the PDF identity when no unambiguous page labels remain", () => {
    for (const pages of [[], [{ pageIndex: 0, pageLabel: "1" }, { pageIndex: 6, pageLabel: "1" }]]) {
      const metadata = { ...context(), pages }
      const normalized = normalizeResearchMessageContext(metadata)
      expect(normalized).toEqual({ source: metadata.source, pages: [] })
      expect(resolveResearchPage(metadata, "1")).toBeUndefined()
      const reloaded = normalizeResearchMessageContext(JSON.parse(JSON.stringify(normalized)))
      expect(reloaded).toEqual(normalized)
      expect(resolveResearchPage(reloaded, "1")).toBeUndefined()
    }
  })
})

describe("plain-text research presentation", () => {
  it("segments the actual formatter's title, sections, multiline quotes and comments", () => {
    const text = formatPaperAnalysis({
      summary: "根据已提供的材料进行分析。\n完整性仍需核对。",
      sections: [{ category: "novelty", summary: "相比已有方法，引入新的证据连接。" }],
      annotations: [{ passageId: "p4-c0", category: "claim", text: "A claim spans\ntwo original lines.", pageIndex: 3, pageLabel: "iv", comment: "解释此句的论证作用。\n保留证据边界。" }],
      warnings: ["仅分析已提供页面。"],
      skipped: 0,
    })
    const blocks = parseResearchPresentation(text)
    expect(blocks).toContainEqual({ type: "heading", level: 1, text: "文献解析（AI 辅助，请核对原文）" })
    expect(blocks).toContainEqual({ type: "heading", level: 2, text: "创新点" })
    expect(blocks).toContainEqual({ type: "heading", level: 2, text: "关键句与批注（1 条）" })
    expect(blocks).toContainEqual({ type: "annotation", category: "核心论点", pageLabel: "iv", quote: "A claim spans\ntwo original lines.", comment: "解释此句的论证作用。\n保留证据边界。" })
    expect(blocks).toContainEqual({ type: "paragraph", text: "提示：仅分析已提供页面。" })
    expect(resolveResearchPage(undefined, "iv")).toBeUndefined()
  })

  it("keeps ordinary text and model links literal, with no markdown or HTML capability", () => {
    const text = "创新点\n普通讨论中的词语，不是解析节。\n\n# Heading\n<script>unexpected()</script>\n[打开](javascript:unexpected())"
    const blocks = parseResearchPresentation(text)
    expect(blocks).toEqual([
      { type: "paragraph", text: "创新点\n普通讨论中的词语，不是解析节。" },
      { type: "paragraph", text: "# Heading\n<script>unexpected()</script>\n[打开](javascript:unexpected())" },
    ])
    expect(blocks.every((block) => !Object.hasOwn(block, "href") && !Object.hasOwn(block, "html"))).toBe(true)
  })

  it("preserves Manager success or partial-write warnings before the fixed analysis title", () => {
    const analysis = formatPaperAnalysis({
      summary: "分析正文仍可阅读。", sections: [], warnings: [], skipped: 0,
      annotations: [{ passageId: "p1-c0", category: "evidence", text: "The measured result supports this claim.", pageIndex: 0, pageLabel: "S1", comment: "该结果提供量化证据。" }],
    })
    for (const prefix of [
      "解析完成：新增 1 条 PDF 批注，跳过 0 条重复或不可写入的批注。",
      "批注未全部写入：当前文库不可编辑。\n\n已保留解析内容，请核对附件。",
    ]) {
      const blocks = parseResearchPresentation(`${prefix}\n\n${analysis}`)
      expect(blocks[0]).toEqual({ type: "paragraph", text: prefix })
      expect(blocks[1]).toEqual({ type: "heading", level: 1, text: "文献解析（AI 辅助，请核对原文）" })
      expect(blocks).toContainEqual({ type: "annotation", category: "关键证据", pageLabel: "S1", quote: "The measured result supports this claim.", comment: "该结果提供量化证据。" })
    }
  })

  it("preserves unsupported or incomplete annotation sections and text following valid cards", () => {
    const unknown = "【模型自造分类】第 7 页\n原句：Keep all unknown text.\nAI 批注：Still plain text."
    const incomplete = "【核心论点】第 8 页\n原句：The comment has not arrived."
    const blocks = parseResearchPresentation(`文献解析（AI 辅助，请核对原文）\r\n\r\n${unknown}\n\n${incomplete}\n\n阅读范围：2 / 9 页。`)
    expect(blocks).toContainEqual({ type: "paragraph", text: unknown })
    expect(blocks).toContainEqual({ type: "paragraph", text: incomplete })
    expect(blocks).toContainEqual({ type: "paragraph", text: "阅读范围：2 / 9 页。" })
    expect(parseResearchPresentation(" \r\n ")).toEqual([])
  })
})
