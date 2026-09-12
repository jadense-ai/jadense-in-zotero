/** 帮助更新边界测试：真实版本委托 Gecko，网络失败不进入业务流程。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { checkLatestRelease, compareGeckoVersions, installedPluginVersion, JADENSE_WORKBENCH_URL, LATEST_RELEASE_API, openHelpLink, releaseSummary, REPOSITORY_URL } from "./manager-help"
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
  it("preserves native chrome on unverified platforms and versions", () => {
    expect(supportsIntegratedTitlebar("WINNT", "10.0.2", "26200")).toBe(true)
    for (const [os, version, build] of [["Darwin", "10.0.2", "26200"], ["Linux", "10.0.2", "26200"], ["WINNT", "9.0", "26200"], ["WINNT", "10.0.3", "26200"], ["WINNT", "10.0.2", "22631"]]) expect(supportsIntegratedTitlebar(os!, version!, build!)).toBe(false)
  })
})
