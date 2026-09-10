/** 阅读投影回归：页码不是章节、片段不是段落，未完成段落不会泄漏原文或半段译文。 */
import { describe, it, expect } from "vitest"
import { buildTranslationReadingIndex, joinTranslationPieces, translationReadingRows } from "./translation-reading"
import { translationReadingAppearance } from "./translation-reader"
import type { TranslationPage } from "./document-store"

function page(index: number, parts: string[], translations: string[] = []): TranslationPage {
  return { pageIndex: index, pageLabel: String(index + 1), lines: [], paragraphs: [{ id: `p${index}`, text: parts.join(" "), pageIndex: index, pageLabel: String(index + 1), rects: [], lineIDs: [] }],
    pieces: parts.map((text, i) => ({ id: `p${index}-${i}`, paragraphID: `p${index}`, text })), translations: Object.fromEntries(translations.map((text, i) => [`p${index}-${i}`, text])) }
}

describe("continuous translation reading", () => {
  it("keeps paragraphs across physical pages in one section and groups legacy pieces", () => {
    const first = page(0, ["Methods"], ["方法"]); first.paragraphs[0].heading = true
    const second = page(1, ["First part", "continued"], ["完整的", "自然段。"])
    const index = buildTranslationReadingIndex([first, second])
    expect(index.blocks.map(block => block.section)).toEqual(["Methods", "Methods"])
    expect(translationReadingRows([first, second], index).map(row => row.text)).toEqual(["方法", "完整的自然段。"])
    expect(index.blocks[1].pieceIDs).toEqual(["p1-0", "p1-1"])
  })
  it("publishes only complete paragraphs and keeps explicit missing page gaps", () => {
    const partial = page(0, ["source one", "source two"], ["只有半段"])
    const rows = translationReadingRows([partial, null, page(2, ["final"], ["末段"])])
    expect(rows[0].text).toBeUndefined(); expect(rows[1].missing).toBe(true); expect(rows[2].text).toBe("末段")
  })
  it("ignores a stale optional index instead of hiding a saved paragraph", () => {
    const saved = page(0, ["body"], ["正文"]), index = buildTranslationReadingIndex([saved])
    index.blocks[0].paragraphID = "foreign"
    expect(translationReadingRows([saved], index)[0].text).toBe("正文")
    expect(translationReadingRows([saved], { ...index, blocks: [] })[0].text).toBe("正文")
  })
  it("joins prose without invented paragraph breaks but preserves Markdown structure", () => {
    expect(joinTranslationPieces(["A sentence.", "Another sentence."])).toBe("A sentence. Another sentence.")
    expect(joinTranslationPieces(["结论。", "下一句。"])).toBe("结论。下一句。")
    expect(joinTranslationPieces(["说明", "- 第一项\n- 第二项"])).toBe("说明\n\n- 第一项\n- 第二项")
  })
  it("defaults to 14px regardless of the general plugin font and contains invalid preferences", () => {
    const values = new Map<string, unknown>([["extensions.jadenseInZotero.fontSize", 24]])
    const host = { Prefs: { get: (key: string) => values.get(key) } }
    expect(translationReadingAppearance(host)).toEqual({ fontSize: 14, lineHeight: 1.8 })
    values.set("extensions.jadenseInZotero.translationReadingFontSize", 18)
    values.set("extensions.jadenseInZotero.translationReadingLineHeight", "garbage")
    expect(translationReadingAppearance(host)).toEqual({ fontSize: 18, lineHeight: 1.8 })
  })
})
