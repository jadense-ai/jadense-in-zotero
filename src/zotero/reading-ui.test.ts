/** 阅读界面回归：解析成果正文保持可选择，全文翻译工具栏不被解析样式拉开。 */
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("reading UI controls", () => {
  it("renders selection source Markdown on initial display, OCR replacement and history", () => {
    const reader = read('./reader-tools.ts')
    expect(reader).toContain('renderTranslationMarkdown(selection.text ?? "", sourceText)')
    expect(reader).toContain("renderTranslationMarkdown(selection.text ?? '', sourceText)")
    expect(reader).not.toContain('sourceText.textContent = selection.text')
    expect(reader).toContain('sourceText.className = "jadense-translation-text jadense-translation-markdown"')
    expect(read('./document-ui.ts')).toContain('updateChatMarkdown(original, record.source.text)')
  })

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

  it("groups reference actions, search and filter in one toolbar", () => {
    const view = read("./reference-workspace.ts")

    expect(view).toContain("searchBar.append(tools, search, filters)")
    expect(view).not.toContain("root.append(head, tools,")
  })
  it("places reference selection before the number outside the action toolbar", () => {
    const view = read("./reference-workspace.ts")
    expect(view).toContain('element(doc, "label", "jdx-reference-select")')
    expect(view).toContain("insertBefore(checkbox, view.number)")
    expect(view).not.toContain("view.controls.append(checkbox")
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
