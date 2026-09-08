import { describe, expect, it } from "vitest"

import {
  PAPER_ANALYSIS_HISTORY_PREF_KEY,
  appendPaperAnalysisRecord,
  readPaperAnalysisHistory,
  type PaperAnalysisHistoryPreferenceStore,
  type PaperAnalysisRecord,
} from "./paper-analysis-history"

function preferences(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  const reads: string[] = []
  const store: PaperAnalysisHistoryPreferenceStore = {
    get: (key) => {
      reads.push(key)
      return values.get(key)
    },
    set: (key, value) => values.set(key, value),
  }
  return { store, values, reads }
}

function record(index: number, overrides: Partial<PaperAnalysisRecord> = {}): PaperAnalysisRecord {
  return {
    id: `analysis-${index}`,
    createdAt: new Date(Date.UTC(2026, 8, 4, 0, index)).toISOString(),
    source: {
      itemID: index + 1,
      libraryID: 1,
      itemKey: `PDF${String(index).padStart(5, "0")}`,
      title: `Paper ${index}`,
      authors: ["Ada Lovelace", "Grace Hopper"],
      date: "2026-09-04",
      year: "2026",
      publicationTitle: "Journal of Tests",
      doi: `10.1000/${index}`,
    },
    summary: `Summary ${index}`,
    ...overrides,
  }
}

describe("paper analysis history", () => {
  it("keeps legacy summary-only records readable under the same independent v1 preference", () => {
    const fixture = preferences({
      "extensions.jadenseInZotero.localChatState": JSON.stringify({ messages: [{ kind: "analysis" }] }),
    })
    appendPaperAnalysisRecord(fixture.store, record(1))

    expect(readPaperAnalysisHistory(fixture.store)).toEqual({ version: 1, records: [record(1)] })
    expect(JSON.parse(String(fixture.values.get(PAPER_ANALYSIS_HISTORY_PREF_KEY)))).toEqual({
      version: 1,
      records: [record(1)],
    })
    expect(fixture.reads.every((key) => key === PAPER_ANALYSIS_HISTORY_PREF_KEY)).toBe(true)
  })

  it("persists bounded readable notes and warnings while containing malformed optional fields", () => {
    const fixture = preferences()
    appendPaperAnalysisRecord(fixture.store, record(1, {
      notes: "关键原句与解释\n" + "n".repeat(100_000),
      warnings: ["部分批注未写入", "部分批注未写入", null as unknown as string],
    }))
    appendPaperAnalysisRecord(fixture.store, record(2, {
      notes: { malformed: true } as unknown as string,
      warnings: "bad" as unknown as string[],
    }))
    const history = readPaperAnalysisHistory(fixture.store)
    expect(history.records[0]).toEqual(record(2))
    expect(history.records[1].notes).toContain("关键原句与解释")
    expect(history.records[1].notes).toContain("后续已截断")
    expect(history.records[1].notes!.length).toBeLessThanOrEqual(96_000)
    expect(history.records[1].warnings).toEqual(["部分批注未写入"])
  })

  it("orders valid records newest-first while dropping corrupt siblings and additive fields", () => {
    const older = { ...record(1), future: true, source: { ...record(1).source, future: true } }
    const newer = {
      ...record(2),
      source: { ...record(2).source, authors: [" Ada ", null, "", "Grace"] },
      ignored: { harmless: true },
    }
    const fixture = preferences({
      [PAPER_ANALYSIS_HISTORY_PREF_KEY]: JSON.stringify({
        version: 1,
        future: true,
        records: [older, { ...record(3), summary: "" }, newer, { ...record(4), source: { ...record(4).source, itemKey: "" } }],
      }),
    })

    expect(readPaperAnalysisHistory(fixture.store)).toEqual({
      version: 1,
      records: [
        { ...record(2), source: { ...record(2).source, authors: ["Ada", "Grace"] } },
        record(1),
      ],
    })
  })

  it("does not interpret records from another schema version", () => {
    const fixture = preferences({
      [PAPER_ANALYSIS_HISTORY_PREF_KEY]: JSON.stringify({ version: 0, records: [record(1)] }),
    })
    expect(readPaperAnalysisHistory(fixture.store)).toEqual({ version: 1, records: [] })
  })

  it("caps storage at 200 records and one million serialized characters by removing the oldest", () => {
    const largeAuthors = Array.from({ length: 32 }, (_, index) => `${index}-${"a".repeat(198)}`)
    const existing = Array.from({ length: 220 }, (_, index) => record(index, {
      source: { ...record(index).source, authors: largeAuthors },
      summary: "s".repeat(1_600),
    }))
    const fixture = preferences({
      [PAPER_ANALYSIS_HISTORY_PREF_KEY]: JSON.stringify({ version: 1, records: existing }),
    })
    appendPaperAnalysisRecord(fixture.store, record(999))

    const serialized = String(fixture.values.get(PAPER_ANALYSIS_HISTORY_PREF_KEY))
    const history = readPaperAnalysisHistory(fixture.store)
    expect(serialized.length).toBeLessThanOrEqual(1_000_000)
    expect(history.records.length).toBeLessThanOrEqual(200)
    expect(history.records[0].id).toBe("analysis-999")
    expect(history.records.some(({ id }) => id === "analysis-0")).toBe(false)
  })

  it("does not persist a record whose attachment identity is unsafe", () => {
    const fixture = preferences()
    expect(() => appendPaperAnalysisRecord(fixture.store, record(1, {
      source: { ...record(1).source, itemKey: "x".repeat(81) },
    }))).toThrow("附件身份")
    expect(fixture.values.has(PAPER_ANALYSIS_HISTORY_PREF_KEY)).toBe(false)
  })
})
