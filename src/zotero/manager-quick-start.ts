import type { ZoteroLike } from "./runtime"
import { copyTextToClipboard } from "./connection-display"
import { appendOnboardingEngineHelp } from "./onboarding-engine-help"
import { uiText } from "./ui-preferences"

/** 交互入门只保存教学进度；配置、真实对话和引擎检测由既有功能提供。 */
export const QUICK_START_SHOWN_PREF_KEY = "extensions.jadenseInZotero.quickStartShown"
export const ONBOARDING_PROGRESS_PREF_KEY = "extensions.jadenseInZotero.onboardingProgress"
type Route = "jadense" | "byok"
type Stage = "choose" | "configure" | "hello" | "engines-choice" | "engines" | "community-completed" | "community-skipped" | "completed" | "skipped"
type Progress = { stage: Stage; route?: Route; helloCompleted: boolean; helloAttempt?: string }
export type ManagerQuickStartActions = {
  openSettings(section: "connection" | "ai" | "features" | "ocr" | "layout"): void
  getChatReadiness(): { ready: boolean; route: Route; issue: string }
  /** 只有真实对话已完整结束且有非空回复，才返回 success。 */
  sendHello(): Promise<{ success: boolean; error?: string }>
  checkEngines(): Promise<{ ocr: boolean; pdf: boolean }>
  openChat(): void
}

/** 选择本模块拥有的字段，容忍未来新增字段，可选偏好故障不影响工作台。 */
function readProgress(zotero: ZoteroLike): Progress | null {
  try {
    const stored = zotero.Prefs?.get(ONBOARDING_PROGRESS_PREF_KEY, true)
    const value: unknown = typeof stored === "string" ? JSON.parse(stored) : stored
    if (!value || typeof value !== "object") return null
    const row = value as Record<string, unknown>
    const stages: Stage[] = ["choose", "configure", "hello", "engines-choice", "engines", "community-completed", "community-skipped", "completed", "skipped"]
    if (!stages.includes(row.stage as Stage)) return null
    const route = row.route === "jadense" || row.route === "byok" ? row.route : undefined
    const helloCompleted = row.helloCompleted === true
    let stage = row.stage as Stage
    if ((stage === "engines" || stage === "engines-choice") && !helloCompleted) stage = "hello"
    if ((stage === "configure" || stage === "hello") && !route) stage = "choose"
    const helloAttempt = stage === "hello" && typeof row.helloAttempt === "string" && row.helloAttempt.length <= 160 ? row.helloAttempt : undefined
    return { stage, route, helloCompleted, helloAttempt }
  } catch { return null }
}
function saveProgress(zotero: ZoteroLike, progress: Progress) {
  try { zotero.Prefs?.set(ONBOARDING_PROGRESS_PREF_KEY, JSON.stringify(progress), true) } catch { /* 仅当前窗口保持进度。 */ }
}
function isCommunity(stage: Stage) { return stage === "community-completed" || stage === "community-skipped" }

export function shouldShowManagerQuickStart(zotero: ZoteroLike) {
  const progress = readProgress(zotero)
  if (progress) return progress.stage !== "completed" && progress.stage !== "skipped"
  try {
    // 旧介绍偏好保持原分支，老用户可从帮助菜单主动重开。
    const value = zotero.Prefs?.get(QUICK_START_SHOWN_PREF_KEY)
    return !(value === true || value === "true")
  } catch { return true }
}
export function markManagerQuickStartShown(zotero: ZoteroLike) {
  try { zotero.Prefs?.set(QUICK_START_SHOWN_PREF_KEY, true) } catch { /* 展示偏好故障不阻断业务。 */ }
}

/** 设置期间通过紧凑进度继续；只有明确操作才发起对话、安装检测或打开下载渠道。 */
export function wireManagerQuickStart(document: Document, zotero: ZoteroLike | null, actions: ManagerQuickStartActions) {
  const dialog = document.getElementById("jadense-quick-start-dialog") as HTMLDialogElement | null
  if (!zotero || !dialog) return { dispose() {}, restart() {} }
  const host = zotero, panel = dialog
  const initial: Progress = { stage: "choose", helloCompleted: false }
  let progress = readProgress(host) ?? { ...initial }
  const shouldOpen = shouldShowManagerQuickStart(host)
  let active = shouldOpen && !isCommunity(progress.stage)
  let view: "step" | "skip" | "community" = isCommunity(progress.stage) ? "community" : "step"
  let disposed = false
  let busy: "hello" | "engines" | null = null
  let generation = 0
  let message = ""
  let messageKind: "error" | "success" | "info" = "info"
  let engines: { ocr: boolean; pdf: boolean } | null = null
  let helpExpanded = false
  let help: { dispose(): void } | undefined
  let opener: HTMLElement | null = null
  const banner = element("section", "jdx-onboarding-progress")
  banner.id = "jadense-onboarding-progress"
  banner.setAttribute("aria-label", uiText("入门教学进度", "Getting started progress"))
  const content = document.querySelector<HTMLElement>(".jdx-manager-content")
  ;(content ?? document.body).prepend(banner)
  panel.classList.add("jdx-onboarding-dialog")
  panel.setAttribute("aria-labelledby", "jadense-quick-start-title")

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }
  function button(action: string, text: string, run: () => void, primary = false) {
    const node = element("button", primary ? "jdx-manager-primary" : "", text)
    node.type = "button"
    node.id = `jadense-onboarding-${action}`
    node.dataset.onboardingAction = action
    node.addEventListener("click", run)
    return node
  }
  function save() { saveProgress(host, progress) }
  function step(next: Stage) { progress.stage = next; message = ""; helpExpanded = false; save(); render(); if (panel.open) show() }
  function note(text: string, kind: typeof messageKind = "error") { message = text; messageKind = kind; render() }
  function hide() { if (panel.open) panel.close(); renderBanner() }
  function show() {
    if (disposed) return
    if (!panel.open) { opener = document.activeElement as HTMLElement | null; panel.showModal() }
    renderBanner()
    panel.querySelector<HTMLButtonElement>(view === "skip" ? '[data-onboarding-action="continue"]' : 'button:not(:disabled)')?.focus()
  }
  function openSettings(section: Parameters<ManagerQuickStartActions["openSettings"]>[0]) {
    hide()
    try { actions.openSettings(section) } catch { note(uiText("暂时无法打开设置，请从工作台设置进入后继续。", "Settings could not open. Open them from the workbench, then continue.")); show() }
  }
  function requestSkip() { view = "skip"; render(); show() }
  function finish(skipped: boolean) {
    generation += 1
    progress.stage = skipped ? "community-skipped" : "community-completed"
    delete progress.helloAttempt
    save()
    markManagerQuickStartShown(host)
    active = false
    view = "community"
    message = ""
    render()
    show()
  }
  function closeCommunity() {
    progress.stage = progress.stage === "community-completed" ? "completed" : "skipped"
    save()
    hide()
    opener?.focus()
  }
  function cancel(event: Event) {
    event.preventDefault()
    if (view === "community") closeCommunity()
    else if (view === "skip") { view = "step"; render(); show() }
    else requestSkip()
  }
  panel.addEventListener("cancel", cancel)

  function renderBanner() {
    banner.replaceChildren()
    banner.hidden = !active || panel.open
    if (content) content.dataset.onboardingActive = String(!banner.hidden)
    banner.dataset.onboardingStep = progress.stage
    if (!active) return
    const labels: Partial<Record<Stage, string>> = {
      choose: uiText("选择 AI 配置方式", "Choose an AI setup"),
      configure: uiText("完成配置后继续教学", "Continue after saving your setup"),
      hello: busy === "hello" ? uiText("正在等待「你好」的回复…", "Waiting for the hello reply…") : uiText("发送第一条「你好」", "Send your first hello"),
      "engines-choice": uiText("选择是否安装文档引擎", "Choose document engines"),
      engines: uiText("安装完成后检测引擎", "Check engines after installation"),
    }
    banner.append(element("span", "jdx-onboarding-progress-label", uiText("入门教学 · ", "Getting started · ") + (labels[progress.stage] ?? "")))
    banner.append(button("resume", uiText("继续引导", "Continue guide"), () => { view = "step"; render(); show() }))
    banner.append(button("banner-skip", uiText("跳过", "Skip"), requestSkip))
  }
  function heading(title: string, description: string) {
    const titleNode = element("h2", "", title)
    titleNode.id = "jadense-quick-start-title"
    titleNode.tabIndex = -1
    panel.append(titleNode, element("p", "jdx-onboarding-description", description))
  }
  function controls() {
    const row = element("div", "jdx-manager-actions jdx-onboarding-actions")
    panel.append(row)
    return row
  }
  function status() {
    if (!message) return
    const node = element("div", "jdx-manager-inline-status", message)
    node.setAttribute("role", "status")
    node.setAttribute("aria-atomic", "true")
    node.dataset.kind = messageKind
    panel.append(node)
  }
  function readChat() {
    try { return actions.getChatReadiness() } catch { return { ready: false, route: progress.route ?? "jadense", issue: uiText("暂时无法读取配置，请保存后重试。", "Setup could not be read. Save it and try again.") } }
  }
  function verifyConfig() {
    const ready = readChat()
    if (!ready.ready) { note(ready.issue || uiText("请先保存令牌或 BYOK 配置，并选择可用的对话模型。", "Save your token or BYOK setup and select an available Chat model.")); return }
    if (!matchesRoute(ready.route)) return
    step("hello")
  }
  function matchesRoute(route: Route) {
    if (!progress.route || progress.route === route) return true
    note(uiText("当前对话模型与教学所选的配置方式不同。请在「功能配置」选择对应的攻玉或 BYOK 模型后继续。", "Your Chat model uses a different setup method. Select the matching Jadense or BYOK model in Feature settings before continuing."))
    return false
  }
  async function sendHello() {
    if (busy) return
    const ready = readChat()
    if (!ready.ready) { note(ready.issue || uiText("对话配置尚未就绪，请先修复配置。", "Chat setup is not ready. Update it first.")); return }
    if (!matchesRoute(ready.route)) return
    const helloAttempt = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    progress.helloAttempt = helloAttempt
    save()
    busy = "hello"
    message = ""
    const attempt = ++generation
    hide()
    render()
    try {
      actions.openChat()
      const result = await actions.sendHello()
      // 窗口关闭不取消真实请求；完成后只推进仍处于 hello 的持久教学状态。
      if (disposed) {
        const latest = readProgress(host)
        if (result.success === true && attempt === generation && latest?.stage === "hello" && latest.helloAttempt === helloAttempt) {
          delete latest.helloAttempt
          saveProgress(host, { ...latest, stage: "engines-choice", helloCompleted: true })
        }
        return
      }
      if (attempt !== generation) return
      if (result.success === true) { progress.helloCompleted = true; delete progress.helloAttempt; step("engines-choice") }
      else note(result.error || uiText("尚未收到完整回复。请检查对话与配置，再由你决定是否重试。", "No complete reply was received. Check the conversation and setup before trying again."))
    } catch {
      if (!disposed && attempt === generation) note(uiText("对话没有成功完成。请检查配置和网络，再手动重试。", "The conversation did not complete. Check your setup and connection, then retry manually."))
    } finally {
      busy = null
      if (!disposed && attempt === generation) { render(); show() }
      else if (!disposed && active) render()
    }
  }
  async function checkEngines() {
    if (busy) return
    busy = "engines"
    engines = null
    message = uiText("正在检测本机 OCR 与 PDF 版面解析引擎…", "Checking local OCR and PDF layout engines…")
    messageKind = "info"
    const attempt = ++generation
    render()
    try {
      const result = await actions.checkEngines()
      if (disposed || attempt !== generation) return
      engines = { ocr: result.ocr === true, pdf: result.pdf === true }
      if (engines.ocr && engines.pdf) note(uiText("两项引擎均已就绪，可以完成教学。", "Both engines are ready. You can finish the guide."), "success")
      else { helpExpanded = true; note(uiText("还有引擎未就绪。可继续安装，或从下方渠道下载离线安装包。", "An engine is not ready. Continue setup or download an offline package below.")) }
    } catch {
      if (!disposed && attempt === generation) {
        engines = null
        helpExpanded = true
        note(uiText("暂时无法确认安装结果。请检查引擎设置，也可以改用离线安装包。", "Installation could not be verified. Check engine settings or use an offline package."))
      }
    } finally { busy = null; if (!disposed && attempt === generation) render() }
  }

  function render() {
    if (disposed) return
    help?.dispose()
    help = undefined
    const hadFocus = panel.contains(document.activeElement)
    const focusedAction = hadFocus ? (document.activeElement as HTMLElement).dataset.onboardingAction : undefined
    const restoreFocus = () => {
      if (!panel.open || !hadFocus) return
      const target = focusedAction ? panel.querySelector<HTMLButtonElement>(`[data-onboarding-action="${focusedAction}"]:not(:disabled)`) : null
      ;(target ?? panel.querySelector<HTMLElement>("h2"))?.focus()
    }
    panel.replaceChildren()
    panel.dataset.onboardingStep = view === "step" ? progress.stage : view
    renderBanner()
    if (view === "skip") {
      heading(uiText("确定跳过入门教学？", "Skip the getting started guide?"), uiText("未完成 AI 配置与测试时，对话可能无法使用；未安装所需引擎时，PDF 对照翻译和扫描文档识别可能不可用。你可以稍后从「帮助 → 入门教学」重新开始。", "Without AI setup and a successful test, Chat may not work. PDF parallel translation and scanned document recognition may be unavailable without the required engines. Reopen this guide from Help → Getting started tutorial at any time."))
      if (busy === "hello") panel.append(element("p", "jdx-onboarding-description", uiText("已发起的对话会继续运行，可在对话中查看或停止。", "The conversation already started will continue. View or stop it in Chat.")))
      controls().append(button("continue", uiText("继续引导", "Continue guide"), () => { view = "step"; render(); show() }, true), button("confirm-skip", uiText("确认跳过", "Skip guide"), () => finish(true)))
      restoreFocus()
      return
    }
    if (view === "community") {
      heading(progress.stage === "community-completed" ? uiText("入门教学已完成", "You are ready to get started") : uiText("已跳过入门教学", "Getting started guide skipped"), uiText("欢迎加入攻玉 QQ 社群，交流使用经验，遇到问题也可以在群内寻求帮助。", "Join the Jadense QQ community to share tips and ask for help."))
      const group = element("p", "jdx-onboarding-community", "QQ 455214858")
      group.id = "jadense-onboarding-qq"
      panel.append(group)
      controls().append(button("copy-qq", uiText("复制群号", "Copy group number"), () => {
        void copyTextToClipboard(host, "455214858").then(copied => {
          if (!disposed && view === "community") note(copied ? uiText("已复制群号。", "Group number copied.") : uiText("复制失败，请手动复制：455214858", "Copy failed. Copy this number manually: 455214858"), copied ? "success" : "error")
        })
      }), button("close-community", uiText("开始使用", "Start using Jadense"), closeCommunity, true))
      status()
      restoreFocus()
      return
    }
    const index = progress.stage === "choose" || progress.stage === "configure" ? 1 : progress.stage === "hello" ? 2 : 3
    panel.append(element("p", "jdx-onboarding-eyebrow", uiText(`入门教学 · 第 ${index} / 3 步`, `Getting started · Step ${index} of 3`)))
    if (progress.stage === "choose") {
      heading(uiText("先选择一种 AI 配置方式", "Choose how to connect to AI"), uiText("教学将带你完成配置、发送一条「你好」，并按需安装文档引擎。配置后随时可以切换。", "Set up AI, send a hello, and optionally install document engines. You can change your setup later."))
      const options = element("div", "jdx-onboarding-options")
      for (const route of ["jadense", "byok"] as const) {
        const option = button(`route-${route}`, "", () => { progress.route = route; step("configure"); openSettings(route === "jadense" ? "connection" : "ai") })
        option.append(element("strong", "", route === "jadense" ? uiText("使用攻玉令牌", "Use a Jadense token") : uiText("使用自己的 API 密钥（BYOK）", "Bring your own API key (BYOK)")))
        option.append(element("span", "", route === "jadense" ? uiText("连接攻玉账号，使用攻玉提供的模型。", "Connect your Jadense account to use its models.") : uiText("配置服务商、API 地址、密钥与模型。", "Configure your provider, API endpoint, key and model.")))
        options.append(option)
      }
      panel.append(options)
    } else if (progress.stage === "configure") {
      heading(uiText("保存配置并选择对话模型", "Save your setup and choose a Chat model"), progress.route === "jadense" ? uiText("在「连接攻玉」保存令牌，再到「功能配置」选择可用的对话模型。保存后返回此教学检查配置。", "Save your token in Connect to Jadense, then select an available Chat model in Feature settings. Return here after saving.") : uiText("在「BYOK」保存服务商与模型，再到「功能配置」将对话设为该模型。保存后返回此教学检查配置。", "Save a provider and model in BYOK, then select that model for Chat in Feature settings. Return here after saving."))
      controls().append(button("open-config", progress.route === "jadense" ? uiText("配置攻玉令牌", "Set up Jadense token") : uiText("配置 BYOK", "Set up BYOK"), () => openSettings(progress.route === "jadense" ? "connection" : "ai")), button("open-models", uiText("选择对话模型", "Choose Chat model"), () => openSettings("features")))
      controls().append(button("verify-config", uiText("已保存，检查并继续", "Saved — check and continue"), verifyConfig, true), button("change-route", uiText("更换配置方式", "Change setup method"), () => step("choose")))
    } else if (progress.stage === "hello") {
      heading(uiText("发起第一条「你好」对话", "Send your first hello"), uiText("点击后，会使用当前对话模型发送「你好」。这是真实模型请求，可能消耗攻玉积分或产生服务商费用；收到完整回复后才进入下一步。", "Click to send “你好” using your current Chat model. This is a real model request and may use Jadense credits or incur provider charges. A complete reply is required to continue."))
      const send = button("send-hello", busy === "hello" ? uiText("正在等待回复…", "Waiting for a reply…") : uiText("发送「你好」", "Send hello"), () => { void sendHello() }, true)
      send.disabled = busy !== null
      controls().append(send, button("open-chat", uiText("查看对话", "View conversation"), () => { hide(); actions.openChat() }))
      if (!busy) controls().append(button("open-config", uiText("修复配置", "Update setup"), () => openSettings(progress.route === "jadense" ? "connection" : "ai")), button("open-models", uiText("更换对话模型", "Change Chat model"), () => openSettings("features")))
    } else if (progress.stage === "engines-choice") {
      heading(uiText("需要 PDF 对照翻译等功能吗？", "Will you use PDF parallel translation?"), uiText("第一条对话已成功。PDF 对照翻译需要 PDF 版面解析引擎；扫描文档识别需要 OCR 引擎。如果需要这些功能，接下来将引导你安装两项引擎。", "Your first conversation succeeded. PDF parallel translation needs the PDF layout engine, and scanned documents need OCR. We can guide you through both installations."))
      controls().append(button("need-engines", uiText("需要，继续安装引擎", "Yes, set up engines"), () => step("engines"), true), button("no-engines", uiText("暂不需要，完成教学", "Not now, finish guide"), () => finish(false)))
    } else if (progress.stage === "engines") {
      heading(uiText("安装 OCR 与 PDF 版面解析引擎", "Install OCR and PDF layout engines"), uiText("依次打开两项引擎设置，按照页面提示安装。完成后返回检测；下载失败时可使用离线安装包。", "Open each engine’s settings and follow its installation steps. Return here to check the result. Offline packages are available if downloads fail."))
      const enginesList = element("div", "jdx-onboarding-engine-list")
      for (const engine of ["ocr", "pdf"] as const) {
        const row = element("div", "jdx-onboarding-engine-row")
        const label = engine === "ocr" ? uiText("OCR 引擎", "OCR engine") : uiText("PDF 版面解析引擎", "PDF layout engine")
        row.append(element("span", "", label), element("span", "jdx-onboarding-engine-state", engines ? (engines[engine] ? uiText("已就绪", "Ready") : uiText("尚未就绪", "Not ready")) : uiText("待检测", "Not checked")))
        row.append(button(engine === "ocr" ? "open-ocr" : "open-layout", uiText("打开安装设置", "Open installation settings"), () => openSettings(engine === "ocr" ? "ocr" : "layout")))
        enginesList.append(row)
      }
      panel.append(enginesList)
      const check = button("check-engines", busy === "engines" ? uiText("正在检测…", "Checking…") : uiText("检测安装结果", "Check installation"), () => { void checkEngines() }, !engines?.ocr || !engines?.pdf)
      check.disabled = busy !== null
      const row = controls()
      row.append(check)
      if (engines?.ocr && engines.pdf) row.append(button("finish", uiText("完成教学", "Finish guide"), () => finish(false), true))
      controls().append(button("offline-help", uiText("遇到问题？查看离线安装渠道", "Having trouble? View offline downloads"), () => { helpExpanded = !helpExpanded; render() }))
    }
    status()
    if (progress.stage === "engines" && helpExpanded) {
      const helpRoot = element("div", "jdx-onboarding-offline")
      panel.append(helpRoot)
      help = appendOnboardingEngineHelp(document, host, helpRoot)
    }
    const footer = element("div", "jdx-onboarding-footer")
    footer.append(button("skip", uiText("跳过教学", "Skip guide"), requestSkip))
    panel.append(footer)
    restoreFocus()
  }

  if (shouldOpen) { save(); render(); show() } else banner.hidden = true
  return {
    /** 老用户可主动重开；未完成时继续进度，进行中的请求不重复发送。 */
    restart() {
      if (disposed) return
      if (!active && !isCommunity(progress.stage)) { progress = { ...initial }; engines = null; active = true; save() }
      view = isCommunity(progress.stage) ? "community" : "step"
      message = ""
      render()
      show()
    },
    dispose() {
      if (disposed) return
      disposed = true
      help?.dispose()
      panel.removeEventListener("cancel", cancel)
      if (panel.open) panel.close()
      panel.replaceChildren()
      banner.remove()
      if (content) delete content.dataset.onboardingActive
    },
  }
}
