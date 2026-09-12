import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"
import { selectPreferencesStrings } from "./connection-display"

const xhtml = readFileSync(new URL("../../content/preferences.xhtml", import.meta.url), "utf8")

describe("preferences pane markup", () => {
  it("provides General controls with labels, restart guidance, and complete bilingual static copy", () => {
    expect(xhtml).toContain('data-settings-section="general"')
    expect(xhtml).toContain('id="jadense-in-zotero-display-language" aria-labelledby="jadense-in-zotero-display-language-label"')
    expect(xhtml).toContain('id="jadense-in-zotero-theme" aria-labelledby="jadense-in-zotero-theme-label"')
    expect(xhtml).toContain('data-i18n-key="languageRestartNote"')
    for (const locale of ["zh-CN", "en-US"]) {
      const strings = selectPreferencesStrings(locale)
      for (const match of xhtml.matchAll(/data-i18n-(?:key|aria-label)="([^"]+)"/g)) {
        expect(strings[match[1] as keyof typeof strings], `${locale}: ${match[1]}`).toBeTypeOf("string")
      }
    }
  })
  it("keeps token display and editing as separate rows", () => {
    expect(xhtml).toContain('id="jadense-in-zotero-token-mask"')
    expect(xhtml).toContain('id="jadense-in-zotero-token-copy"')
    expect(xhtml).toContain('id="jadense-in-zotero-token-edit"')
    expect(xhtml).toContain('id="jadense-in-zotero-token-edit-row"')
    expect(xhtml).toContain('id="jadense-in-zotero-token-input"')
    expect(xhtml).toContain('id="jadense-in-zotero-connection-status"')
  })

  it("no longer exposes the server address, the raw folder id, or manual load/save buttons", () => {
    expect(xhtml).not.toContain('id="jadense-in-zotero-base-url"')
    expect(xhtml).not.toContain('id="jadense-in-zotero-folder-id"')
    expect(xhtml).not.toContain('id="jadense-in-zotero-load-folders"')
    expect(xhtml).not.toContain('id="jadense-in-zotero-save"')
  })

  it("presents the automatic-follow toggle with feature models, connection, and BYOK sections", () => {
    expect(xhtml).not.toContain('id="jadense-in-zotero-route-jadense"')
    expect(xhtml).toContain('id="jadense-in-zotero-auto-follow-chat-model"')
    for (const feature of ["chat", "translation", "analysis", "figure"]) expect(xhtml).toContain(`id="jadense-in-zotero-feature-${feature}-model"`)
    expect(xhtml.indexOf('id="jadense-in-zotero-feature-chat-model"')).toBeLessThan(xhtml.indexOf('id="jadense-in-zotero-auto-follow-chat-model"'))
    expect(xhtml.indexOf('id="jadense-in-zotero-auto-follow-chat-model"')).toBeLessThan(xhtml.indexOf('id="jadense-in-zotero-feature-translation-model"'))
    expect(xhtml.match(/data-settings-section=/g)).toHaveLength(5)
    expect(xhtml).toContain('data-settings-section="ocr"')
    expect(xhtml).toContain('data-settings-section="jadense"')
    expect(xhtml).toContain('data-settings-section="byok"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-key-mask"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-key-toggle"')
    expect(xhtml).toContain('class="jdx-pref-byok-layout"')
    expect(xhtml).toContain('class="jdx-pref-provider-list"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-model-editor" class="jdx-pref-model-editor" hidden="hidden"')
    expect(xhtml).not.toContain('<html:details class="jdx-pref-model-editor" open="open">')
    expect(xhtml.indexOf('id="jadense-in-zotero-byok-model-editor"')).toBeLessThan(xhtml.indexOf('id="jadense-in-zotero-byok-model-select"'))
    expect(xhtml.indexOf('<html:div class="jdx-pref-byok-panel">')).toBeGreaterThan(xhtml.indexOf('<html:div class="jdx-pref-byok-editor">'))
    expect(xhtml.indexOf('<html:div class="jdx-pref-byok-panel">')).toBeLessThan(xhtml.indexOf('<html:p class="jdx-pref-warning"'))
    expect(xhtml).not.toContain('value="https://api.openai.com/v1"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-base-url"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-provider-select"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-provider-save"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-model-select"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-model-name"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-context-window"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-save"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-test"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-clear"')
  })

  it("ships the bottom help card that explains where to find the token", () => {
    expect(xhtml).toContain('id="jadense-in-zotero-help-steps"')
    expect(xhtml).toContain('data-i18n-key="helpTitle"')
    expect(xhtml).toContain('data-i18n-key="helpNote"')
  })

  it("uses data-i18n-key placeholders filled by JS for all static copy", () => {
    expect(xhtml).toContain('data-i18n-key="note"')
    expect(xhtml).toContain('data-i18n-key="jadenseSectionTitle"')
    expect(xhtml).toContain('data-i18n-key="folderTitle"')
    expect(xhtml).toContain('data-i18n-key="includePdfLabel"')
  })
})
