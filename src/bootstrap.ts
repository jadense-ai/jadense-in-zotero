/** 插件生命周期与原生入口；就绪后固定会话语言，停止时清理窗口和宿主注册。 */
import { initializeUiLocale, uiText } from "@/zotero/ui-preferences"
import {
  clearConnection,
  previewSelectedCollectionUpload,
  pushSelectedCollectionToJadense,
  pushSelectedItemsToJadense,
  readCollectionUploadIncludePdfDefault,
  readConnection,
  refreshFavoriteFoldersCache,
  saveCollectionUploadIncludePdfDefault,
  saveConnection,
  type ZoteroLike,
} from "@/zotero/runtime"
import {
  openPreferencesPane,
  registerPreferencesPane,
  unregisterPreferencesPane,
  type BootstrapPluginContext,
} from "@/zotero/native-preferences"
import {
  registerNativeMenus,
  unregisterNativeMenus,
} from "@/zotero/native-menus"
import {
  registerSyncPanel,
  unregisterSyncPanel,
} from "@/zotero/sync-panel"
import {
  openManagerWindow,
  closeManagerWindow,
  type ManagerSection,
  type ZoteroManagerWindow,
} from "@/zotero/manager-window"
import { registerReaderTools, type ReaderAction } from "@/zotero/reader-tools"
import { registerReaderFigureTools } from "@/zotero/reader-figure-tools"
import { documentJobs, stopDocumentJobs } from "@/zotero/document-jobs"
import { translateReaderSelection } from "@/zotero/reader-translation"
import { formatJadenseSyncResult } from "@/zotero/sync-result"
import {
  registerChromeContent,
  ensureJadenseLocalization,
  unregisterChromeContent,
  type JadenseMainWindow,
} from "@/zotero/chrome-registration"

declare const Zotero: ZoteroLike & {
  debug?: (message: string) => void
  getMainWindow?: () => Window & typeof globalThis
  uiReadyPromise?: Promise<unknown>
}

type BootstrapData = {
  id?: string
  rootURI?: string
  resourceURI?: { spec?: string }
}

const DEFAULT_PLUGIN_ID = "jadense-in-zotero@jadense.cn"
const SMOKE_OPEN_MANAGER_PREF = "extensions.jadenseInZotero.smokeOpenManager"

let pluginContext: BootstrapPluginContext = {
  pluginID: DEFAULT_PLUGIN_ID,
  rootURI: "",
}
let registeredMenuIDs: string[] = []
let registeredPreferencesPaneID: string | null = null
let registeredSyncPanelID: string | null = null
let registeredChromeContent: ReturnType<typeof registerChromeContent> = null
let smokeManagerOpened = false
let smokeLocalizationProbed = false
let unregisterReaderTools: (() => void) | null = null
let unregisterReaderFigureTools: (() => void) | null = null

function smokeRequested() {
  try {
    return Zotero?.Prefs?.get(SMOKE_OPEN_MANAGER_PREF, true) === true
  } catch {
    return false
  }
}

function delayForSmoke(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * 冒烟探针：在主窗口上解析一个已注册的 Fluent ID 的 .label 属性，
 * 证明 insertFTLIfNeeded 挂载的资源真的可被 L10nRegistry 解析，而不只是插入了 link。
 */
async function probeLocalizationForSmoke() {
  if (!smokeRequested() || smokeLocalizationProbed) return
  smokeLocalizationProbed = true
  type FluentAttribute = { name?: string; value?: string }
  const win = mainWindow() as (Window & typeof globalThis & {
    document?: { l10n?: { formatMessages?: (ids: string[]) => Promise<Array<{ attributes?: FluentAttribute[] }> | null> } }
  }) | null
  const l10n = win?.document?.l10n
  if (!l10n || typeof l10n.formatMessages !== "function") {
    log("smoke l10n probe unavailable")
    return
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const messages = await l10n.formatMessages(["jadense-in-zotero-menu-main"])
      const label = messages?.[0]?.attributes?.find((attribute) => attribute.name === "label")?.value
      if (label) {
        log(`smoke l10n probe label: ${label}`)
        return
      }
    } catch (error) {
      log(`smoke l10n probe failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    await delayForSmoke(300)
  }
  log("smoke l10n probe label: (empty)")
}

function log(message: string) {
  Zotero?.debug?.(`[Jadense in Zotero] ${message}`)
}

function mainWindow() {
  return Zotero?.getMainWindow?.() ?? null
}

function loadLocalizationIntoWindow(win: JadenseMainWindow | null | undefined) {
  try {
    if (!ensureJadenseLocalization(win)) {
      log("Zotero main window Fluent loader was unavailable.")
      return
    }
    log("localization loaded")
  } catch (error) {
    log(error instanceof Error ? error.message : "Jadense Fluent resource loading failed.")
  }
}

function loadLocalizationIntoOpenWindows() {
  const windows = Zotero?.getMainWindows?.() ?? []
  const current = mainWindow()
  const seen = new Set<Window & typeof globalThis>()
  for (const win of windows) seen.add(win)
  if (current) seen.add(current)
  for (const win of seen) loadLocalizationIntoWindow(win)
}

function rootUriFromData(data: BootstrapData) {
  return data.rootURI ?? data.resourceURI?.spec ?? ""
}

/** Zotero 10 会在 collection tree 完成前调用插件 startup；窗口 UI 必须等到宿主明确就绪。 */
async function waitForMainWindowUi() {
  try {
    await Zotero.uiReadyPromise
  } catch {
    // 较旧 Zotero 没有或拒绝该 Promise 时，继续使用文档 load 作为兼容边界。
  }
  const win = mainWindow()
  if (!win || win.document.readyState !== "loading") return
  await new Promise<void>((resolve) => win.addEventListener("load", () => resolve(), { once: true }))
}

function alertUser(message: string) {
  mainWindow()?.alert(message)
}

async function runCommand(operation: () => Promise<unknown>) {
  try {
    const result = await operation()
    alertUser(uiText(`上传完成。\n${formatJadenseSyncResult(result)}`, `Upload completed.\n${formatJadenseSyncResult(result)}`))
  } catch (error) {
    alertUser(error instanceof Error ? error.message : uiText("上传失败。", "Upload failed."))
  }
}

async function runCollectionUploadFlow(win: Window & typeof globalThis) {
  try {
    const preview = await previewSelectedCollectionUpload(Zotero)
    if (preview.totalCount === 0) {
      const skippedText = preview.skippedCount > 0
        ? uiText(` 其中 ${preview.skippedCount} 个条目因缺少标题等必要元数据，上传前已被跳过。`, ` ${preview.skippedCount} items were skipped because required metadata was missing.`)
        : ""
      alertUser(uiText(`“${preview.collectionName}”及其子分类中没有可上传的 Zotero 条目。${skippedText}`, `“${preview.collectionName}” and its subcollections contain no uploadable Zotero items.${skippedText}`))
      return
    }
    const shouldContinue = win.confirm(
      [
        uiText(`将“${preview.collectionName}”及其子分类中的 ${preview.totalCount} 个 Zotero 条目元数据上传到攻玉？`, `Upload metadata for ${preview.totalCount} Zotero items in “${preview.collectionName}” and its subcollections to Jadense?`),
        preview.skippedCount > 0 ? uiText(`${preview.skippedCount} 个条目因缺少必要元数据将被跳过。`, `${preview.skippedCount} items with missing required metadata will be skipped.`) : null,
      ].filter(Boolean).join("\n"),
    )
    if (!shouldContinue) return
    const pdfDefault = readCollectionUploadIncludePdfDefault(Zotero)
    const includePdf = win.confirm(
      uiText(`同时上传可读取的本地 PDF 附件？\n当前默认：${pdfDefault ? "元数据 + PDF" : "仅元数据"}\n确定：元数据 + PDF\n取消：仅元数据`, `Also upload readable local PDF attachments?\nCurrent default: ${pdfDefault ? "Metadata + PDF" : "Metadata only"}\nOK: Metadata + PDF\nCancel: Metadata only`),
    )
    saveCollectionUploadIncludePdfDefault(Zotero, includePdf)
    await runCommand(() => pushSelectedCollectionToJadense(Zotero, { includePdf }))
  } catch (error) {
    alertUser(error instanceof Error ? error.message : uiText("收藏夹上传失败。", "Collection upload failed."))
  }
}

function runPromptConnectionFlow(win: Window & typeof globalThis) {
  // 兜底链路同样不暴露攻玉地址与收藏夹 ID:地址由插件固定,收藏夹由首次自动加载解析落盘。
  const token = win.prompt(uiText("请输入攻玉插件令牌", "Enter your Jadense plugin token"))?.trim()
  if (!token) return
  try {
    saveConnection(Zotero, { token })
    alertUser(uiText("攻玉账号已保存。", "Jadense account saved."))
    warmFavoriteFoldersCache()
  } catch (error) {
    alertUser(error instanceof Error ? error.message : uiText("攻玉账号保存失败。", "Could not save the Jadense account."))
  }
}

// 启动/配置完成后静默预热收藏夹缓存:面板打开即有数据,失败只进日志不打断用户。
function warmFavoriteFoldersCache() {
  try {
    if (!readConnection(Zotero).token) return
    void Promise.resolve(refreshFavoriteFoldersCache(Zotero)).catch((error: unknown) => {
      log(error instanceof Error ? error.message : "Favorite folders warm-up failed.")
    })
  } catch (error) {
    log(error instanceof Error ? error.message : "Favorite folders warm-up failed.")
  }
}

function openManager(section: ManagerSection = "chat", action?: ReaderAction) {
  const win = mainWindow()
  if (!win) {
    log("Main window was unavailable for opening the manager.")
    return false
  }
  return openManagerWindow({
    zotero: Zotero,
    win: win as ZoteroManagerWindow,
    context: pluginContext,
    section,
    action,
  })
}

function configureConnection() {
  const win = mainWindow()
  if (!win) {
    log("Main window was unavailable for configuration.")
    return
  }
  if (openManager("migrate")) return
  if (openPreferencesPane(Zotero, win)) return
  alertUser(uiText("请打开 Zotero 设置并选择 Jadense in Zotero；将改用输入框完成配置。", "Open Zotero Settings and select Jadense in Zotero. A token prompt will open as a fallback."))
  runPromptConnectionFlow(win)
}

function registerMenus() {
  unregisterMenus()
  try {
    registeredMenuIDs = registerNativeMenus(Zotero, pluginContext.pluginID, {
      openManager: () => {
        openManager()
      },
      configureConnection,
      exportSelectedItems: () => {
        void runCommand(() => pushSelectedItemsToJadense(Zotero, {
          includePdf: readCollectionUploadIncludePdfDefault(Zotero),
        }))
      },
      exportSelectedCollection: () => {
        const win = mainWindow()
        if (win) void runCollectionUploadFlow(win)
      },
      disconnect: () => {
        clearConnection(Zotero)
        alertUser(uiText("已从当前 Zotero 配置中移除攻玉账号。", "Jadense account removed from this Zotero profile."))
      },
    })
    if (registeredMenuIDs.length === 0) {
      log("Zotero MenuManager was unavailable.")
    }
  } catch (error) {
    log(error instanceof Error ? error.message : "Menu registration failed.")
  }
}

function unregisterMenus() {
  unregisterNativeMenus(Zotero, registeredMenuIDs, pluginContext.pluginID)
  registeredMenuIDs = []
}

async function startup(data: BootstrapData = {}) {
  pluginContext = {
    pluginID: data.id?.trim() || DEFAULT_PLUGIN_ID,
    rootURI: rootUriFromData(data),
  }
  try {
    registeredChromeContent = registerChromeContent(pluginContext.rootURI)
    if (!registeredChromeContent) {
      log("Chrome content registration was unavailable; manager and preferences chrome URLs may not load.")
    }
  } catch (error) {
    log(error instanceof Error ? error.message : "Chrome content registration failed.")
  }

  await waitForMainWindowUi()
  initializeUiLocale(Zotero)
  // 后台任务不依附 Manager；bootstrap sandbox 缺少的 Web API 从常驻 Zotero 主窗口取得。
  const windowRuntime = mainWindow() as unknown as Record<string, unknown> | null
  const backgroundRuntime = globalThis as unknown as Record<string, unknown>
  if (windowRuntime) for (const name of ["AbortController", "DOMException", "TextDecoder", "TextEncoder", "URL", "URLSearchParams", "crypto", "structuredClone", "setTimeout", "clearTimeout"]) {
    if (backgroundRuntime[name] !== undefined) continue
    const value = windowRuntime[name]
    backgroundRuntime[name] = typeof value === "function" && ["structuredClone", "setTimeout", "clearTimeout"].includes(name) ? value.bind(windowRuntime) : value
  }

  loadLocalizationIntoOpenWindows()

  try {
    registeredPreferencesPaneID = await registerPreferencesPane(Zotero, pluginContext)
  } catch (error) {
    log(error instanceof Error ? error.message : "Preferences pane registration failed.")
  }

  try {
    registeredSyncPanelID = registerSyncPanel(Zotero, pluginContext, {
      openManager: () => {
        openManager()
      },
    })
  } catch (error) {
    log(error instanceof Error ? error.message : "Sync panel registration failed.")
  }

  registerMenus()
  documentJobs(Zotero)
  try {
    unregisterReaderTools = registerReaderTools(Zotero, pluginContext.pluginID, (action, hooks) => {
      if (action.kind === "translate") {
        const win = mainWindow()
        if (!win) throw new Error(uiText("当前 Zotero 窗口不可用，无法翻译。", "The Zotero window is unavailable for translation."))
        return translateReaderSelection({
          zotero: Zotero,
          action,
          fetchImpl: win.fetch.bind(win),
          onTextDelta: hooks?.onTranslationText,
        }).then((record) => ({ translation: record.result.text }))
      }
      openManager(action.kind === "analyze" || action.kind === "references" ? "analysis" : action.kind === "fullTranslate" ? "translations" : "chat", action)
    }, () => {
      if (!openManager()) throw new Error(uiText("无法打开攻玉工作台。", "Could not open Jadense Workspace."))
    })
  } catch (error) {
    // 阅读器增强是可选入口，不能影响普通对话和原有上传。
    log(error instanceof Error ? error.message : "Reader tools were unavailable.")
  }
  try {
    unregisterReaderFigureTools = registerReaderFigureTools(Zotero, pluginContext.pluginID, (action) => {
      if (!openManager("chat", action)) throw new Error(uiText("当前 Zotero 窗口不可用，无法解读图片。", "The Zotero window is unavailable for image interpretation."))
    })
  } catch (error) {
    // 图片识别依赖 Zotero 10 Reader 私有能力；失败只关闭这一入口。
    log(error instanceof Error ? error.message : "Reader figure tools were unavailable.")
  }
  await probeLocalizationForSmoke()
  openManagerForSmoke()
  warmFavoriteFoldersCache()
  log("started")
}

function shutdown() {
  stopDocumentJobs(Zotero)
  unregisterReaderFigureTools?.()
  unregisterReaderFigureTools = null
  unregisterReaderTools?.()
  unregisterReaderTools = null
  closeManagerWindow(Zotero)
  unregisterMenus()
  unregisterPreferencesPane(Zotero, registeredPreferencesPaneID)
  registeredPreferencesPaneID = null
  unregisterSyncPanel(Zotero, registeredSyncPanelID, pluginContext.pluginID)
  registeredSyncPanelID = null
  unregisterChromeContent(registeredChromeContent)
  registeredChromeContent = null
  log("stopped")
}

function onMainWindowLoad(data: { window?: Window & typeof globalThis } = {}) {
  loadLocalizationIntoWindow(data.window ?? mainWindow())
  registerMenus()
  openManagerForSmoke()
}

/**
 * 冒烟辅助：隔离临时 profile 通过 pref 请求自动打开工作台，
 * 让安装版 XPI 冒烟能依赖 manager booted 标记证明窗口真实渲染而不是空白。
 */
function openManagerForSmoke() {
  if (smokeManagerOpened || !smokeRequested()) return
  smokeManagerOpened = true
  const opened = openManager("chat")
  log(`smoke manager open result: ${String(opened)}`)
}

function onMainWindowUnload() {
  unregisterMenus()
}

function install() {
  log("installed")
}

function uninstall() {
  log("uninstalled")
}

Object.assign(globalThis, {
  startup,
  shutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  install,
  uninstall,
})
