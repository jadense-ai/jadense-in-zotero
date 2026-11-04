/** 教学交互的真实推进、警告取消、跨窗口恢复与可选偏好降级回归。 */
import { JSDOM } from "jsdom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { markManagerQuickStartShown, ONBOARDING_PROGRESS_PREF_KEY, QUICK_START_SHOWN_PREF_KEY, shouldShowManagerQuickStart, wireManagerQuickStart, type ManagerQuickStartActions } from "./manager-quick-start"
import { initializeUiLocale } from "./ui-preferences"
import type { ZoteroLike } from "./runtime"

function fakeZotero(value?: unknown) {
  const values = new Map<string, unknown>(value === undefined ? [] : [[QUICK_START_SHOWN_PREF_KEY, value]])
  return {
    values,
    locale: "zh-CN",
    Prefs: { get: (key: string) => values.get(key), set: (key: string, next: unknown) => values.set(key, next) },
  } as unknown as ZoteroLike & { values: Map<string, unknown> }
}
const cleanups: (() => void)[] = []
beforeEach(() => initializeUiLocale({ locale: "zh-CN" }))
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks() })

function fixture(host = fakeZotero(), overrides: Partial<ManagerQuickStartActions> = {}) {
  const window = new JSDOM('<section class="jdx-manager-content"><main>Workbench</main></section><dialog id="jadense-quick-start-dialog"></dialog>').window
  const document = window.document
  const dialog = document.querySelector("dialog")!
  dialog.showModal = function () { this.open = true }
  dialog.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")) }
  const actions: ManagerQuickStartActions = {
    openSettings: vi.fn(),
    getChatReadiness: vi.fn(() => ({ ready: true, route: "byok", issue: "" })),
    sendHello: vi.fn(async () => ({ success: true })),
    checkEngines: vi.fn(async () => ({ ocr: true, pdf: true })),
    openChat: vi.fn(),
    ...overrides,
  }
  const controller = wireManagerQuickStart(document, host, actions)
  cleanups.push(() => { controller.dispose(); window.close() })
  const click = (action: string) => {
    const target = document.querySelector<HTMLButtonElement>(`[data-onboarding-action="${action}"]`)
    expect(target, action).not.toBeNull()
    target!.click()
  }
  const stage = () => dialog.dataset.onboardingStep
  const progress = () => JSON.parse(String(host.values.get(ONBOARDING_PROGRESS_PREF_KEY))) as Record<string, unknown>
  const configure = (route = "byok") => { click(`route-${route}`); click("resume"); click("verify-config") }
  return { window, document, dialog, actions, controller, host, click, stage, progress, configure }
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe("manager quick start", () => {
  it("preserves the old profile dismissal and lets existing users restart explicitly", () => {
    const zotero = fakeZotero()
    expect(shouldShowManagerQuickStart(zotero)).toBe(true)
    markManagerQuickStartShown(zotero)
    expect(zotero.values.get(QUICK_START_SHOWN_PREF_KEY)).toBe(true)
    expect(shouldShowManagerQuickStart(zotero)).toBe(false)
    expect(shouldShowManagerQuickStart(fakeZotero("true"))).toBe(false)
    const f = fixture(zotero)
    expect(f.dialog.open).toBe(false)
    f.controller.restart()
    expect(f.dialog.open).toBe(true)
    expect(f.stage()).toBe("choose")
  })

  it("opens the chosen settings, keeps a compact continuation, and sends nothing automatically", () => {
    const f = fixture()
    expect(f.dialog.open).toBe(true)
    f.click("route-jadense")
    expect(f.actions.openSettings).toHaveBeenCalledWith("connection")
    expect(f.dialog.open).toBe(false)
    expect(f.document.getElementById("jadense-onboarding-progress")!.hidden).toBe(false)
    expect(f.document.querySelector<HTMLElement>(".jdx-manager-content")!.dataset.onboardingActive).toBe("true")
    expect(f.actions.sendHello).not.toHaveBeenCalled()
    expect(f.actions.checkEngines).not.toHaveBeenCalled()
    f.click("resume")
    expect(f.stage()).toBe("configure")
    expect(f.progress()).toMatchObject({ stage: "configure", route: "jadense", helloCompleted: false })
  })

  it("keeps incomplete setup in place and checks the selected billing route", () => {
    const readiness = vi.fn(() => ({ ready: false, route: "byok" as "byok" | "jadense", issue: "请保存 API 密钥" }))
    const f = fixture(fakeZotero(), { getChatReadiness: readiness })
    f.configure()
    expect(f.stage()).toBe("configure")
    expect(f.dialog.textContent).toContain("请保存 API 密钥")
    readiness.mockReturnValue({ ready: true, route: "jadense", issue: "" })
    f.click("verify-config")
    expect(f.stage()).toBe("configure")
    expect(f.dialog.textContent).toContain("配置方式不同")
    expect(f.actions.sendHello).not.toHaveBeenCalled()
  })

  it("requires an explicit hello and a successful result before offering document engines", async () => {
    const request = pending<{ success: boolean }>()
    const f = fixture(fakeZotero(), { sendHello: vi.fn(() => request.promise) })
    f.configure()
    expect(f.stage()).toBe("hello")
    expect(f.document.activeElement?.id).toBe("jadense-onboarding-send-hello")
    expect(f.actions.sendHello).not.toHaveBeenCalled()
    f.click("send-hello")
    expect(f.actions.sendHello).toHaveBeenCalledOnce()
    expect(f.dialog.open).toBe(false)
    expect(f.progress().helloCompleted).toBe(false)
    f.click("resume")
    expect(f.document.querySelector<HTMLButtonElement>('[data-onboarding-action="send-hello"]')!.disabled).toBe(true)
    request.resolve({ success: true })
    await settle()
    expect(f.stage()).toBe("engines-choice")
    expect(f.progress()).toMatchObject({ stage: "engines-choice", helloCompleted: true })
    expect(f.progress().helloAttempt).toBeUndefined()
    expect(f.actions.checkEngines).not.toHaveBeenCalled()
    f.click("no-engines")
    expect(f.stage()).toBe("community")
    expect(f.dialog.textContent).toContain("455214858")
    f.click("close-community")
    expect(f.progress().stage).toBe("completed")
    expect(shouldShowManagerQuickStart(f.host)).toBe(false)
  })

  it.each(["failure", "throw"])("keeps hello incomplete on %s and never retries automatically", async kind => {
    const sendHello = vi.fn(async () => { if (kind === "throw") throw new Error("network"); return { success: false, error: "未收到完整回复" } })
    const f = fixture(fakeZotero(), { sendHello })
    f.configure(); f.click("send-hello"); await settle()
    expect(f.stage()).toBe("hello")
    expect(f.progress().helloCompleted).toBe(false)
    expect(f.document.querySelector('[data-onboarding-action="open-config"]')).not.toBeNull()
    expect(sendHello).toHaveBeenCalledOnce()
  })

  it("rechecks configuration before hello and does not silently change providers", () => {
    const readiness = vi.fn(() => ({ ready: true, route: "byok" as "byok" | "jadense", issue: "" }))
    const f = fixture(fakeZotero(), { getChatReadiness: readiness })
    f.configure()
    readiness.mockReturnValue({ ready: true, route: "jadense", issue: "" })
    f.click("send-hello")
    expect(f.actions.sendHello).not.toHaveBeenCalled()
    expect(f.dialog.textContent).toContain("配置方式不同")
  })

  it("does not replace an in-flight attempt when readiness says another request is running", () => {
    const readiness = vi.fn(() => ({ ready: true, route: "byok" as const, issue: "" }))
    const f = fixture(fakeZotero(), { getChatReadiness: readiness })
    f.configure()
    const stored = { ...f.progress(), helloAttempt: "other-window-request" }
    f.host.values.set(ONBOARDING_PROGRESS_PREF_KEY, JSON.stringify(stored))
    readiness.mockReturnValue({ ready: false, route: "byok", issue: "请等待当前对话完成" })
    f.click("send-hello")
    expect(f.actions.sendHello).not.toHaveBeenCalled()
    expect(f.progress().helloAttempt).toBe("other-window-request")
  })

  it("offers both installations and offline help, and finishes only after both engines pass", async () => {
    const checkEngines = vi.fn().mockResolvedValueOnce({ ocr: true, pdf: false }).mockResolvedValueOnce({ ocr: true, pdf: true })
    const f = fixture(fakeZotero(), { checkEngines })
    f.configure(); f.click("send-hello"); await settle(); f.click("need-engines")
    expect(checkEngines).not.toHaveBeenCalled()
    f.click("open-ocr"); expect(f.actions.openSettings).toHaveBeenLastCalledWith("ocr"); f.click("resume")
    f.click("open-layout"); expect(f.actions.openSettings).toHaveBeenLastCalledWith("layout"); f.click("resume")
    f.click("check-engines"); await settle()
    expect(f.stage()).toBe("engines")
    expect(f.document.querySelector('[data-onboarding-action="finish"]')).toBeNull()
    expect(f.document.querySelectorAll("[data-engine-download-channel]")).toHaveLength(3)
    f.click("check-engines"); await settle(); f.click("finish")
    expect(f.stage()).toBe("community")
    expect(f.progress().stage).toBe("community-completed")
  })

  it("contains an engine check failure and keeps offline repair visible", async () => {
    const f = fixture(fakeZotero(), { checkEngines: vi.fn(async () => { throw new Error("unavailable") }) })
    f.configure(); f.click("send-hello"); await settle(); f.click("need-engines"); f.click("check-engines"); await settle()
    expect(f.stage()).toBe("engines")
    expect(f.dialog.textContent).toContain("暂时无法确认安装结果")
    expect(f.document.querySelector("[data-onboarding-engine-help]")).not.toBeNull()
    expect(f.document.querySelector('[data-onboarding-action="finish"]')).toBeNull()
  })

  it("warns on Escape, defaults to continuing, and requires confirmation to skip", () => {
    const f = fixture()
    const escape = new f.window.Event("cancel", { cancelable: true })
    f.dialog.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(f.stage()).toBe("skip")
    expect(f.document.activeElement?.id).toBe("jadense-onboarding-continue")
    f.dialog.dispatchEvent(new f.window.Event("cancel", { cancelable: true }))
    expect(f.stage()).toBe("choose")
    expect(f.progress().stage).toBe("choose")
    f.click("skip"); f.click("confirm-skip")
    expect(f.stage()).toBe("community")
    expect(f.progress().stage).toBe("community-skipped")
    f.click("close-community")
    expect(f.progress().stage).toBe("skipped")
  })

  it("resumes setup and a pending community invitation after closing the window", () => {
    const host = fakeZotero()
    const first = fixture(host)
    first.click("route-byok"); first.controller.dispose()
    const next = fixture(host)
    expect(next.stage()).toBe("configure")
    next.click("skip"); next.click("confirm-skip"); next.controller.dispose()
    const third = fixture(host)
    expect(third.stage()).toBe("community")
    third.click("close-community")
    const last = fixture(host)
    expect(last.dialog.open).toBe(false)
  })

  it("records a completed hello after disposal without rendering into the closed window", async () => {
    const request = pending<{ success: boolean }>()
    const host = fakeZotero()
    const f = fixture(host, { sendHello: () => request.promise })
    f.configure(); f.click("send-hello"); f.controller.dispose()
    request.resolve({ success: true }); await settle()
    expect(f.dialog.open).toBe(false)
    expect(f.progress()).toMatchObject({ stage: "engines-choice", helloCompleted: true })
    expect(fixture(host).stage()).toBe("engines-choice")
  })

  it("does not let an old window's reply complete another attempt", async () => {
    const request = pending<{ success: boolean }>()
    const f = fixture(fakeZotero(), { sendHello: () => request.promise })
    f.configure(); f.click("send-hello"); f.controller.dispose()
    f.host.values.set(ONBOARDING_PROGRESS_PREF_KEY, JSON.stringify({ stage: "hello", route: "byok", helloCompleted: false, helloAttempt: "new-window" }))
    request.resolve({ success: true }); await settle()
    expect(f.progress()).toMatchObject({ stage: "hello", helloCompleted: false, helloAttempt: "new-window" })
  })

  it("allows restarting after skipping an in-flight hello without dispatching a duplicate", async () => {
    const request = pending<{ success: boolean }>()
    const f = fixture(fakeZotero(), { sendHello: vi.fn(() => request.promise) })
    f.configure(); f.click("send-hello"); f.click("banner-skip"); f.click("confirm-skip"); f.click("close-community")
    f.controller.restart()
    expect(f.stage()).toBe("choose")
    f.configure()
    f.click("send-hello")
    expect(f.actions.sendHello).toHaveBeenCalledOnce()
    request.resolve({ success: true }); await settle()
    expect(f.stage()).toBe("hello")
    expect(f.progress().helloCompleted).toBe(false)
    expect(f.document.querySelector<HTMLButtonElement>('[data-onboarding-action="send-hello"]')!.disabled).toBe(false)
  })

  it("accepts additive progress, discards unrelated fields, and survives preference failures", () => {
    const host = fakeZotero(true)
    host.values.set(ONBOARDING_PROGRESS_PREF_KEY, JSON.stringify({ stage: "configure", route: "byok", helloCompleted: false, future: { anything: true } }))
    const f = fixture(host)
    expect(f.stage()).toBe("configure")
    expect(f.progress().future).toBeUndefined()
    host.Prefs!.get = () => { throw new Error("unavailable") }
    host.Prefs!.set = () => { throw new Error("unavailable") }
    f.controller.restart()
    f.click("skip"); f.click("confirm-skip")
    expect(f.stage()).toBe("community")
    expect(shouldShowManagerQuickStart(host)).toBe(true)
  })

  it("uses English copy and XHTML nodes while preserving the exact QQ number", () => {
    initializeUiLocale({ locale: "en-US" })
    const f = fixture()
    expect(f.dialog.textContent).toContain("Choose how to connect to AI")
    expect(f.document.getElementById("jadense-onboarding-route-byok")!.namespaceURI).toBe("http://www.w3.org/1999/xhtml")
    f.click("skip"); f.click("confirm-skip")
    expect(f.dialog.textContent).toContain("QQ 455214858")
  })

  it("copies the QQ group number only after an explicit click", async () => {
    const host = fakeZotero(), writeText = vi.fn(async () => {})
    Object.assign(host, { getMainWindow: () => ({ navigator: { clipboard: { writeText } } }) })
    const f = fixture(host)
    f.click("skip"); f.click("confirm-skip")
    expect(writeText).not.toHaveBeenCalled()
    f.document.getElementById("jadense-onboarding-copy-qq")!.focus()
    f.click("copy-qq"); await settle()
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith("455214858")
    expect(f.document.activeElement?.id).toBe("jadense-onboarding-copy-qq")
    expect(f.dialog.textContent).toContain("已复制群号")
  })
})
