/** 最新结果投影与引用筛选回归：不依赖 DOM，覆盖同名、旧数据、可选关联和导入资格。 */
import { describe, expect, it } from "vitest"
import { analysisPapers, paperKey } from "./analysis-workspace-model"
import { canImportReference, filterReferences } from "./reference-workspace"
import type { PaperAnalysisRecord } from "@/chat/paper-analysis-history"
import type { DocumentTask } from "./document-store"
import type { ReferenceEntry } from "@/chat/reference-list"

const source = { itemID: 1, libraryID: 1, itemKey: "PDF00001", title: "Same title", authors: [] }
const record = (id: string, date: string): PaperAnalysisRecord => ({ id, createdAt: date, source, summary: id })
const task = (id: string, other = source): DocumentTask => ({ version: 1, id, source: other, kind: "references", status: "complete", createdAt: "2026-09-01", total: 2, completed: 2, totalPages: 1, models: [], warnings: [] })
describe("single-paper analysis projection", () => {
  it("shows only the newest result while leaving all historical inputs intact", () => {
    const records = [record("old", "2026-09-01"), record("new", "2026-09-02")]
    expect(analysisPapers(records, [task("refs")])).toMatchObject([{ record: { id: "new" }, references: { id: "refs" } }])
    expect(records.map(row => row.id)).toEqual(["old", "new"])
  })
  it("never merges same-title attachments, reused item IDs or different libraries", () => {
    const other = { ...source, itemKey: "PDF00002" }, group = { ...source, libraryID: 2 }
    expect(analysisPapers([record("a", "2026-09-02")], [task("b", other), task("c", group)])).toHaveLength(3)
    expect(paperKey(other)).not.toBe(paperKey(source))
  })
  it("uses an explicit same-attachment task and rejects a cross-paper display link locally", () => {
    expect(analysisPapers([{ ...record("new", "2026-09-02"), referenceTaskID: "chosen" }], [task("latest"), task("chosen")])[0].references?.id).toBe("chosen")
    const result = analysisPapers([{ ...record("new", "2026-09-02"), referenceTaskID: "wrong" }], [task("wrong", { ...source, itemID: 2 })])
    expect(result.find(row => row.record)?.references).toBeUndefined()
  })
  it("keeps reference-only history and summary-only history readable", () => {
    expect(analysisPapers([], [task("refs")])[0]).toMatchObject({ references: { id: "refs" } })
    expect(analysisPapers([record("legacy", "2026-09-02")], [])[0].record?.summary).toBe("legacy")
  })
})

describe("reference filtering and selection eligibility", () => {
  const metadata = { title: "Evidence", authors: ["Smith"], year: "2020", doi: "10.1234/one" }
  const entry: ReferenceEntry = { id: "one", order: 0, raw: "Original citation", fields: metadata, verified: metadata, uncertain: false, verification: "verified", lines: [] }
  it("searches source/title/author/DOI while keeping original order", () => {
    expect(filterReferences([entry], "smith", "verified")).toEqual([entry])
    expect(filterReferences([entry], "10.1234", "all")).toEqual([entry])
    expect(filterReferences([entry], "missing", "all")).toEqual([])
  })
  it("never selects unresolved, imported or uncertain-write rows for a new import", () => {
    expect(canImportReference(entry)).toBe(true)
    for (const change of [{ verification: "unverified" }, { verified: undefined }, { importUncertain: true }, { imported: { itemID: 2, libraryID: 1, itemKey: "BOOK0001" } }]) expect(canImportReference({ ...entry, ...change } as ReferenceEntry)).toBe(false)
    expect(filterReferences([{ ...entry, imported: { itemID: 2, libraryID: 1, itemKey: "BOOK0001" } }], "", "verified")).toEqual([])
  })
})
