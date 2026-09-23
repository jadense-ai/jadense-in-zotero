/** 帮助更新边界测试：真实版本委托 Gecko，网络失败不进入业务流程。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { checkLatestRelease, compareGeckoVersions, installedPluginVersion, JADENSE_WORKBENCH_URL, LATEST_RELEASE_API, openHelpLink, releaseNotes, releaseSummary, REPOSITORY_URL, visibleReleaseNotes } from "./manager-help"
import { supportsIntegratedTitlebar } from "./manager-titlebar"

afterEach(() => vi.useRealTimers())
const stable = { tag_name: "v0.4.10", draft: false, prerelease: false }

describe("manual release checks", () => {
  it("reads the installed addon and delegates comparison without lexical sorting", async () => {
    const getAddonByID = vi.fn().mockResolvedValue({ version: "0.4.9" })
    expect(await installedPluginVersion("installed-id", { ChromeUtils: { importESModule: () => ({ AddonManager: { getAddonByID } }) } })).toBe("0.4.9")
    expect(getAddonByID).toHaveBeenCalledWith("installed-id")
    const compare = vi.fn().mockReturnValue(-1)
    const platform = { Services: { vc: { compare } } }
    const result = releaseSummary({ ...stable, arbitrary: { ignored: true }, html_url: "javascript:evil()" }, "0.4.9", (a, b) => compareGeckoVersions(a, b, platform))
    expect(compare).toHaveBeenCalledWith("0.4.9", "0.4.10")
    expect(result.state).toBe("available")
    expect(result.url).toBe(`${REPOSITORY_URL}/releases/tag/v0.4.10`)
  })
  it.each([[0, "latest"], [1, "ahead"], [-1, "available"]] as const)("handles comparison %s", (order, state) => {
    expect(releaseSummary(stable, "0.4.10", () => order).state).toBe(state)
  })
  it.each([null, {}, { ...stable, prerelease: true }, { ...stable, draft: true }, { ...stable, tag_name: "release/unknown" }])("contains unreadable stable metadata", payload => {
    expect(() => releaseSummary(payload, "0.4.4", () => 0)).toThrow()
  })
  it("uses a credential-free explicit GET and ignores additive data", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...stable, assets: [], future: true }) })
    expect((await checkLatestRelease("0.4.4", () => -1, request)).state).toBe("available")
    expect(request).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.objectContaining({ credentials: "omit", signal: expect.any(AbortSignal) }))
  })
  it("reads the latest release's bilingual summary from the same response", () => {
    const body = `## 本次更新\n\n- **新增** [对照翻译](https://example.invalid) 与导出。\n- 修复更新弹窗。\n\n## What's new\n\n- Add parallel translation and export.\n\n## 操作与配置\n- 不应进入摘要。`
    const result = releaseSummary({ ...stable, body }, "0.4.9", () => -1)
    expect(result.notes).toEqual({ zhCN: ["新增 对照翻译 与导出。", "修复更新弹窗。"], enUS: ["Add parallel translation and export."] })
    expect(visibleReleaseNotes(result.notes, "en-US")).toEqual({ items: ["Add parallel translation and export."], language: "en-US" })
  })
  it("supports existing release prose and keeps missing or unsafe notes optional", () => {
    const body = `## 本次更新\n\n本版修复 **设置**。\n\n## 操作与配置\n不会显示。\n\nEnglish: This patch fixes settings.`
    expect(releaseNotes(body)).toEqual({ zhCN: ["本版修复 设置。"], enUS: ["This patch fixes settings."] })
    expect(releaseSummary({ ...stable, body: { unexpected: true } }, "0.4.9", () => -1).state).toBe("available")
    expect(releaseNotes("## 本次更新\n- <img src=x onerror=alert(1)>文本").zhCN).toEqual(["文本"])
    expect(visibleReleaseNotes({ zhCN: ["中文摘要"], enUS: [] }, "en-US")).toEqual({ items: ["中文摘要"], language: "zh-CN" })
    expect(releaseNotes(`## 本次更新\n摘要前言。\n- 第一项更新。\n- 第二项更新。`).zhCN).toEqual(["第一项更新。", "第二项更新。"])
  })
  it.each([403, 404, 429, 500])("contains HTTP %s", async status => {
    await expect(checkLatestRelease("0.4.4", () => 0, vi.fn().mockResolvedValue({ ok: false, status }))).rejects.toThrow(`GitHub ${status}`)
  })
  it("times out and aborts its request", async () => {
    vi.useFakeTimers()
    const request = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))))
    const result = expect(checkLatestRelease("0.4.4", () => 0, request)).rejects.toThrow("aborted")
    await vi.advanceTimersByTimeAsync(10_000)
    await result
  })
  it("contains JSON/network/version failures and can retry", async () => {
    await expect(checkLatestRelease("0.4.4", () => 0, vi.fn().mockRejectedValue(new Error("offline")))).rejects.toThrow("offline")
    await expect(checkLatestRelease("0.4.4", () => 0, vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error("JSON") } }))).rejects.toThrow("JSON")
    await expect(installedPluginVersion("missing", {})).rejects.toThrow()
    expect(() => compareGeckoVersions("1", "2", {})).toThrow()
  })
  it("opens the fixed repository through the system browser", () => {
    const launchURL = vi.fn()
    openHelpLink({ launchURL }, REPOSITORY_URL)
    expect(launchURL).toHaveBeenCalledWith("https://github.com/jadense-ai/jadense-in-zotero")
    expect(() => openHelpLink(null, REPOSITORY_URL)).toThrow()
  })
  it("uses the workbench for the titlebar check-in action", () => {
    expect(JADENSE_WORKBENCH_URL).toBe("https://jadense.cn/app")
  })
  it("keeps Windows integrated chrome across host and OS updates", () => {
    for (const [version, build] of [["10.0.2", "26200"], ["10.0.3", "26200"], ["10.0.4", "22631"], ["9.0", "26100"]]) expect(supportsIntegratedTitlebar("WINNT", version, build)).toBe(true)
    expect(supportsIntegratedTitlebar("WINNT")).toBe(true)
    for (const os of ["Darwin", "Linux"]) expect(supportsIntegratedTitlebar(os)).toBe(false)
  })
})
