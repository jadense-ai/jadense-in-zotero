/** 用真实文字层形态的行标记/坐标验证清理；原始行仍留给引用与人工核对。 */
import { describe, expect, it } from "vitest"
import { textPage, type PdfTextDocument } from "./pdf-document"
import { prepareTranslationDocument } from "./translation-document"

function page(index: number, rows: Array<[string, number, number, number, number?]>) {
  const result = textPage(rows.flatMap(([text, x, y, width, height = 10]) => [...text].map((c, i) => ({
    c, rect: [x + i * width / text.length, y, x + (i + 1) * width / text.length, y + height],
    lineBreakAfter: i === text.length - 1, paragraphBreakAfter: i === text.length - 1,
  }))), index, String(index + 1))
  return { ...result, viewBox: [0, 0, 600, 800] }
}
function fixture(pages: PdfTextDocument["pages"]): PdfTextDocument {
  return { source: { itemID: 1, libraryID: 1, itemKey: "PDF", title: "Scientific study" }, pages }
}
describe("translation reading order and semantic paragraphs", () => {
  it("recovers geometry-only wraps without fragmenting vertical marginal identifiers", () => {
    const chars = [
      ...[..."A complete scientific argument continues"].map((c, i) => ({ c, rect: [30 + i * 5, 680, 35 + i * 5, 690] })),
      { c: "-", rect: [225, 680, 230, 690], ignorable: true, lineBreakAfter: true },
      ...[..."with evidence and a complete conclusion."].map((c, i) => ({ c, rect: [30 + i * 5, 666, 35 + i * 5, 676], lineBreakAfter: i === "with evidence and a complete conclusion.".length - 1 })),
      ...[..."arXiv:1234.56789"].map((c, i) => ({ c, rect: [12, 200 + i * 12, 25, 210 + i * 12], lineBreakAfter: i === 15 })),
    ]
    const raw = { ...textPage(chars, 0, "1"), viewBox: [0, 0, 600, 800] }
    expect(raw.lines.map(line => line.text).at(-1)).toBe("arXiv:1234.56789")
    expect(new Set(raw.lines.map(line => line.id)).size).toBe(raw.lines.length)
    const result = prepareTranslationDocument(fixture([raw]))
    expect(result.pages[0].excludedLines?.at(-1)?.text).toBe("arXiv:1234.56789")
    expect(result.pages[0].paragraphs[0].text).toContain("conclusion.")
  })
  it("recognizes numbered subsections without turning larger body text into headings", () => {
    const result = prepareTranslationDocument(fixture([page(0, [["3.3 Position-wise Feed-Forward Networks", 30, 700, 240], ["We have three major observations from the experiment", 30, 660, 240, 13], ["and report all supporting measurements.", 30, 642, 210, 13], ["2014 English-French dataset consisting of many sentences", 30, 600, 240], ["R. R. Salakhutdinov. Improving neural networks", 30, 570, 240]])]))
    expect(result.pages[0].paragraphs.filter(p => p.heading).map(p => p.text)).toEqual(["3.3 Position-wise Feed-Forward Networks"])
  })
  it("keeps a multi-sentence paragraph across a full-width page ending, but respects an indented new paragraph", () => {
    const previous = page(0, [["This scientific argument spans several lines and gives evidence", 30, 90, 240], ["before reaching the end of this page with a complete sentence.", 30, 76, 240]])
    const continuation = page(1, [["The same argument continues in a new sentence.", 30, 700, 240], ["It finally reaches its conclusion.", 30, 686, 180]])
    const joined = prepareTranslationDocument(fixture([previous, continuation]))
    expect(joined.pages[0].paragraphs[0].text).toContain("sentence. The same argument")
    expect(joined.pages[0].paragraphs[0].locations?.map(location => location.pageIndex)).toEqual([0, 1])
    const independent = page(1, [["A new paragraph starts with indentation.", 45, 700, 220], ["It has its own supporting argument.", 30, 686, 240]])
    expect(prepareTranslationDocument(fixture([previous, independent])).pages[1].paragraphs.length).toBeGreaterThan(0)
  })
  it("removes margin furniture but keeps short headings, body Article and every raw line", () => {
    const original = fixture([0, 1].map(i => page(i, [
      ["Article", 30, 773, 35], ["Research Journal 2026", 350, 773, 180],
      ["Results", 30, 700, 50, 14],
      ["This Article reports an intact scientific argument", 30, 670, 240],
      ["with supporting evidence and precise notation $x^2$.", 30, 656, 240],
      ["Article", 30, 610, 40], [String(i + 1), 280, 20, 10],
    ])))
    const result = prepareTranslationDocument(original)
    expect(result.pages[0].paragraphs.map(p => p.text)).toEqual([
      "Results", "This Article reports an intact scientific argument with supporting evidence and precise notation $x^2$.", "Article",
    ])
    expect(result.pages[0].excludedLines?.map(l => l.text)).toEqual(["Article", "Research Journal 2026", "1"])
    expect(result.pages[0].lines).toEqual(original.pages[0].lines)
    expect(original.pages[0].paragraphs).toHaveLength(7)
  })
  it("joins a sentence across columns and pages with separate page coordinates", () => {
    const original = fixture([
      page(0, [["A sufficiently detailed scientific argument continues", 30, 680, 240], ["through the entire left column and", 30, 666, 240],
        ["then into the right column without losing its", 330, 680, 240], ["meaning across the page boundary and", 330, 666, 240]]),
      page(1, [["ends with its complete conclusion.", 30, 680, 240], ["Methods", 30, 630, 70, 14], ["An independent paragraph.", 30, 600, 240]]),
    ])
    const result = prepareTranslationDocument(original)
    const paragraph = result.pages[0].paragraphs[0]
    expect(result.pages[0].paragraphs).toHaveLength(1)
    expect(paragraph.text).toBe("A sufficiently detailed scientific argument continues through the entire left column and then into the right column without losing its meaning across the page boundary and ends with its complete conclusion.")
    expect(paragraph.locations?.map(l => l.pageIndex)).toEqual([0, 1])
    expect(paragraph.rects).toHaveLength(4)
    expect(result.pages[1].continuationFrom).toEqual([0])
    expect(result.pages[1].paragraphs.map(p => p.text)).toEqual(["Methods", "An independent paragraph."])
  })
  it("does not merge across unreadable pages or discard coordinate-free short text", () => {
    const original = fixture([page(0, [["A sentence that remains unfinished", 30, 680, 240]]), textPage([], 1, "2"), textPage([{ c: "x" }], 2, "3")])
    const result = prepareTranslationDocument(original)
    expect(result.pages[0].paragraphs[0].text).toBe("A sentence that remains unfinished")
    expect(result.pages[2].paragraphs[0].text).toBe("x")
    expect(result.pages[1].warning).toBeTruthy()
  })
  it("continues body text past a floating figure and keeps bottom footnotes separate", () => {
    const result = prepareTranslationDocument(fixture([
      page(0, [["The experiment establishes a sufficiently detailed argument and", 30, 90, 240], ["the observed effect is a weighted sum", 30, 76, 240]]),
      page(1, [["Diagram labels", 60, 700, 120], ["Figure 2: The measured process.", 30, 500, 220],
        ["of the measurements with a complete conclusion.", 30, 470, 240],
        ["A second scientific paragraph continues through the page and", 30, 104, 240], ["demonstrates the same result across independent", 30, 90, 240],
        ["4A separate methodological footnote.", 42, 62, 228, 9]]),
      page(2, [["observations. This completes the argument.", 30, 700, 240]]),
    ]))
    expect(result.pages[0].paragraphs[0].text).toContain("weighted sum of the measurements")
    expect(result.pages[0].paragraphs[0].text).not.toContain("Diagram")
    expect(result.pages[1].paragraphs.find(p => p.text.startsWith("A second"))?.text).toContain("independent observations.")
    expect(result.pages[1].paragraphs.find(p => p.text.startsWith("4A"))?.text).toBe("4A separate methodological footnote.")
    const allIDs = result.pages.flatMap(p => p.paragraphs.flatMap(paragraph => paragraph.lineIDs))
    expect(new Set(allIDs).size).toBe(allIDs.length)
  })
  it("does not treat a short table header as an unfinished sentence continuation", () => {
    const result = prepareTranslationDocument(fixture([
      page(0, [["The experiment compares different configurations on the", 30, 76, 240]]),
      page(1, [["train PPL BLEU params", 30, 700, 240], ["Table 3: Model comparison.", 30, 500, 220]]),
    ]))
    expect(result.pages[0].paragraphs[0].locations).toHaveLength(1)
    expect(result.pages[1].paragraphs[0].text).toBe("train PPL BLEU params")
  })
})
