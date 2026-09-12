/** 阅读界面回归：解析成果正文保持可选择，全文翻译工具栏不被解析样式拉开。 */
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("reading UI controls", () => {
  it("does not add bulk-copy controls to analysis summary or notes", () => {
    const view = read("./analysis-workspace.ts")

    expect(view).not.toContain("copyTextToClipboard")
    expect(view).not.toContain("jdx-reading-toolbar")
    expect(view).not.toContain("Copy the notes before closing")
    expect(view).toContain("jdx-analysis-summary")
    expect(view).toContain("jdx-analysis-notes-text")
  })

  it("keeps full-translation controls grouped and analysis text selectable", () => {
    const analysis = read("../../content/analysis.css")
    const shared = read("../../content/ui.css")

    expect(analysis).not.toMatch(/\.jdx-reading-toolbar\s*\{[^}]*justify-content:\s*space-between/)
    expect(shared).toMatch(/\.jdx-document-results \.jdx-analysis-detail \.jdx-reading-body\{[^}]*user-select:text/)
    expect(shared).toMatch(/\.jdx-literature-workspace \.jdx-reference-import input\[type=checkbox\][^{}]*\{[^{}]*appearance:auto/)
    expect(shared).toMatch(/\.jdx-document-results \.jdx-reference-import input\[type=checkbox\][^{}]*\{[^{}]*appearance:auto/)
  })

  it("keeps reference controls in the heading instead of a standalone row", () => {
    const view = read("./reference-workspace.ts")

    expect(view).toContain("head.append(title, count, tools)")
    expect(view).not.toContain("root.append(head, tools,")
  })

  it("exposes persisted reference edit and delete controls", () => {
    const view = read("./reference-workspace.ts")

    expect(view).toContain("编辑参考文献")
    expect(view).toContain("删除参考文献")
    expect(view).toContain("prompt(uiText(\"编辑参考文献内容\"")
    expect(view).toContain("jobs.updateReference")
    expect(view).toContain("jobs.deleteReference")
  })
})
