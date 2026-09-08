import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const xhtml = readFileSync(new URL("../../content/preferences.xhtml", import.meta.url), "utf8")

describe("preferences pane markup", () => {
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

  it("presents one route selector and exactly two semantic settings sections", () => {
    expect(xhtml).toContain('id="jadense-in-zotero-route-jadense"')
    expect(xhtml).toContain('id="jadense-in-zotero-route-byok"')
    expect(xhtml.match(/data-settings-section=/g)).toHaveLength(2)
    expect(xhtml).toContain('data-settings-section="jadense"')
    expect(xhtml).toContain('data-settings-section="byok"')
    expect(xhtml).toContain('id="jadense-in-zotero-byok-key-mask"')
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
