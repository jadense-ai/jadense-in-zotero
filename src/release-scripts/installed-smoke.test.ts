/**
 * Installed-XPI smoke 日志判定测试。
 * 上游模拟 Zotero 冷启动输出，下游确保插件注册标记必需且运行时拒绝错误会使 smoke 失败。
 */
import { describe, expect, it } from "vitest"

import {
  INSTALLED_SMOKE_LOCALIZATION_MARKER,
  INSTALLED_SMOKE_MANAGER_MARKER,
  INSTALLED_SMOKE_OPEN_MANAGER_PREF,
  INSTALLED_SMOKE_START_MARKER,
  validateInstalledSmokeLog,
} from "../../scripts/smoke-installed-xpi.mjs"

const pluginId = "jadense-in-zotero@jadense.cn"

function passingLogLines() {
  return [
    `Plugin ${pluginId} registered preference pane jadense-in-zotero-preferences`,
    INSTALLED_SMOKE_LOCALIZATION_MARKER,
    "[Jadense in Zotero] smoke l10n probe label: Jadense",
    INSTALLED_SMOKE_MANAGER_MARKER,
    INSTALLED_SMOKE_START_MARKER,
  ]
}

describe("installed-XPI smoke log validation", () => {
  it("accepts a registered, localized, and rendered installed plugin", () => {
    expect(validateInstalledSmokeLog({
      stdout: passingLogLines().join("\n"),
      stderr: "",
      pluginId,
    })).toEqual([])
  })

  it("requires the manager boot marker proving the workspace rendered", () => {
    const failures = validateInstalledSmokeLog({
      stdout: [
        `Plugin ${pluginId} registered preference pane jadense-in-zotero-preferences`,
        INSTALLED_SMOKE_LOCALIZATION_MARKER,
        "[Jadense in Zotero] smoke l10n probe label: Jadense",
        INSTALLED_SMOKE_START_MARKER,
      ].join("\n"),
      stderr: "",
      pluginId,
    })
    expect(failures).toContain(`Missing manager boot marker: ${INSTALLED_SMOKE_MANAGER_MARKER}`)
  })

  it.each([
    ["smoke l10n probe label: (empty)"],
    ["smoke l10n probe unavailable"],
  ])("rejects unresolved Fluent probe: %s", (probeLine) => {
    const failures = validateInstalledSmokeLog({
      stdout: [
        `Plugin ${pluginId} registered preference pane jadense-in-zotero-preferences`,
        INSTALLED_SMOKE_LOCALIZATION_MARKER,
        probeLine,
        INSTALLED_SMOKE_MANAGER_MARKER,
        INSTALLED_SMOKE_START_MARKER,
      ].join("\n"),
      stderr: "",
      pluginId,
    })
    expect(failures).toContain("Missing resolved Fluent label for jadense-in-zotero-menu-main.")
  })

  it.each([
    'ItemPaneSectionAPI: Error: Option must have .header["l10nID"]',
    "MenuAPI: Error: menu localization failed",
    "[Jadense in Zotero] Manager failed to initialize",
    "TypeError: fetch called on an object that does not implement interface Window",
    "[Jadense in Zotero] Chrome content registration was unavailable; manager and preferences chrome URLs may not load.",
  ])("rejects installed runtime error: %s", (runtimeError) => {
    expect(validateInstalledSmokeLog({
      stdout: passingLogLines().join("\n"),
      stderr: runtimeError,
      pluginId,
    })).toContain(`Rejected Zotero log line: ${runtimeError}`)
  })

  it("exposes the smoke pref used to auto-open the manager window", () => {
    expect(INSTALLED_SMOKE_OPEN_MANAGER_PREF).toBe("extensions.jadenseInZotero.smokeOpenManager")
  })
})
