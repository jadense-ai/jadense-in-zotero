import { migrateTranslationConfiguration } from './zotero/translation-config-migration'
import { lifecycleTrace } from './zotero/lifecycle-diagnostics'
import { selectedClassificationIDs } from './zotero/classification'
import { openClassificationWindow, closeClassificationWindow } from './zotero/classification-window'
declare const __JADENSE_BUILD_ID__: string
import { saveDiagnosticExport } from './zotero/diagnostics-panel'
import { stopAnalysisRuntime } from './zotero/analysis-runtime'
import { diagnostics, stopDiagnostics } from "@/zotero/diagnostics"
import { installedPluginVersion } from "@/zotero/manager-help"
import { chatRuntime, stopChatRuntime } from "@/zotero/chat-runtime"
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
import { pdfTranslationJobs, stopPDFTranslationJobs } from "@/zotero/pdf-translation-jobs"
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
let lifecycleGeneration = 0
let stopped = false
let cancelStartupWait: (() => void) | undefined

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
  try { Zotero?.debug?.(`[Jadense in Zotero] ${message}`) } catch { /* 可选日志不可阻断生命周期。 */ }
}

function recordInitializationError(stage: string, error: unknown) {
  const trace = lifecycleTrace(Zotero, 'initialization', stage); trace.fail(error, stage); trace.end('error')
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
    recordInitializationError('localization_failed', error)
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
async function waitForMainWindowUi(active: () => boolean) {
  let cancel!: () => void
  const cancelled = new Promise<void>(resolve => { cancel = resolve })
  cancelStartupWait = cancel
  let slow = false
  const timer = setTimeout(() => { if (active()) { slow = true; log('host_wait_slow') } }, 10000)
  let removeLoad = () => {}
  try {
    await Promise.race([Promise.resolve(Zotero.uiReadyPromise).catch(() => undefined), cancelled])
    if (!active()) return
    const win = mainWindow()
    if (win?.document.readyState === 'loading') await Promise.race([new Promise<void>(resolve => {
      const loaded = () => resolve(); win.addEventListener('load', loaded, { once: true }); removeLoad = () => win.removeEventListener('load', loaded)
    }), cancelled])
  } finally { clearTimeout(timer); removeLoad(); if (cancelStartupWait === cancel) cancelStartupWait = undefined }
  return slow
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
      if (!stopped) recordInitializationError('favorite_cache_failed', error)
    })
  } catch (error) {
    recordInitializationError('favorite_cache_failed', error)
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
  if (openManager("settings-connection")) return
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
      classifySelectedItems: () => {
        openClassificationWindow(Zotero, mainWindow() as ZoteroManagerWindow | null, selectedClassificationIDs(Zotero), () => { openManager('settings-features') })
      },
      canClassifySelectedItems: () => selectedClassificationIDs(Zotero).length > 0,
      exportDiagnostics: () => { void exportDiagnostics() },
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
    recordInitializationError('menu_registration_failed', error)
  }
}

function unregisterMenus() {
  unregisterNativeMenus(Zotero, registeredMenuIDs, pluginContext.pluginID)
  registeredMenuIDs = []
}

/** 工具菜单直接导出安全投影，不依赖工作台页面成功加载。 */
async function exportDiagnostics() {
  const win = mainWindow()
  if (!win) return
  try {
    const store = diagnostics(Zotero)!
    await store.ready
    await saveDiagnosticExport(win, store.export())
  } catch {
    win.alert(uiText('无法导出诊断，请使用 Zotero 帮助菜单中的调试输出日志。', 'Could not export diagnostics. Use Debug Output Logging in Zotero Help.'))
  }
}

async function startup(data: BootstrapData = {}) {
  const generation = ++lifecycleGeneration; stopped = false
  const active = () => !stopped && generation === lifecycleGeneration
  pluginContext = { pluginID: data.id?.trim() || DEFAULT_PLUGIN_ID, rootURI: rootUriFromData(data) }
  // 先补齐当前可用主窗口的 Web API，诊断在就绪之后初始化；等待过程保留原生日志。
  const startedAt = new Date().toISOString()
  log('initialization:wait_host')
  const slowHost = await waitForMainWindowUi(active)
  if (!active()) return
  const windowRuntime = mainWindow() as unknown as Record<string, unknown> | null
  const backgroundRuntime = globalThis as unknown as Record<string, unknown>
  if (windowRuntime) for (const name of ["AbortController", "AbortSignal", "DOMException", "TextDecoder", "TextEncoder", "URL", "URLSearchParams", "crypto", "structuredClone", "setTimeout", "clearTimeout", "setInterval", "clearInterval"]) {
    if (backgroundRuntime[name] !== undefined) continue
    const value = windowRuntime[name]
    backgroundRuntime[name] = typeof value === "function" && ["structuredClone", "setTimeout", "clearTimeout", "setInterval", "clearInterval"].includes(name) ? value.bind(windowRuntime) : value
  }

  const collector = (() => { try { return diagnostics(Zotero) } catch { return undefined } })()
  if (collector) {
    collector.environment = { zotero: String((Zotero as unknown as { version?: string }).version ?? 'unknown'), os: String((windowRuntime?.navigator as Navigator | undefined)?.platform ?? 'unknown'), plugin: 'unknown' }
    collector.environment.build = typeof __JADENSE_BUILD_ID__ === 'string' ? __JADENSE_BUILD_ID__ : 'development'
    void installedPluginVersion(pluginContext.pluginID).then(version => { if (active()) collector.environment.plugin = version }).catch(() => undefined)
  }
  const trace = lifecycleTrace(Zotero, 'initialization', 'startup', 'background', startedAt)
  if (slowHost) trace.event('host_wait_slow')
  trace.event('host_ready')
  let degraded = false
  const step = async (stage: string, run: () => unknown) => {
    if (!active()) return
    trace.event(stage)
    try { await run() } catch (error) { degraded = true; trace.fail(error, stage, 'STARTUP_COMPONENT_FAILED') }
  }
  await step('chrome_registration', () => {
    registeredChromeContent = registerChromeContent(pluginContext.rootURI)
    if (!registeredChromeContent) throw Object.assign(new Error('Chrome content unavailable'), { code: 'CHROME_UNAVAILABLE' })
  })
  migrateTranslationConfiguration(Zotero)
  await step('locale', () => { initializeUiLocale(Zotero); loadLocalizationIntoOpenWindows() })
  await step('menus', () => { registerMenus(); if (!registeredMenuIDs.length) throw new Error('Menus unavailable') })
  await step('preferences', async () => {
    const id = await registerPreferencesPane(Zotero, pluginContext)
    if (!active()) { unregisterPreferencesPane(Zotero, id); return }
    registeredPreferencesPaneID = id
    if (!id) throw new Error('Preferences unavailable')
  })
  await step('native_panel', () => {
    registeredSyncPanelID = registerSyncPanel(Zotero, pluginContext, {
      openTranslationHistory: () => { openManager('translations') }, openManager: () => { openManager() },
    })
    if (!registeredSyncPanelID) throw new Error('Native panel unavailable')
  })
  await step('document_runtime', () => {
    const jobs = documentJobs(Zotero)
    // 异步存储加载不能延迟 Reader 入口注册；失败仍有诊断。
    void jobs.ready.catch(error => { if (active()) { const failure = lifecycleTrace(Zotero, 'initialization', 'document_restore'); failure.fail(error, 'document_restore_failed'); failure.end('error') } })
  })
  await step('chat_runtime', () => { chatRuntime(Zotero) })
  // 服务在插件后台 realm 创建；先在设置安装后关闭窗口，任务仍须可执行。
  // 此处只创建队列，不下载、扫描用户文件或加载模型。
  await step('pdf_runtime', () => { pdfTranslationJobs(Zotero) })
  await step('reader_tools', () => {
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
  })
  await step('reader_figures', () => {
    unregisterReaderFigureTools = registerReaderFigureTools(Zotero, pluginContext.pluginID, action => {
      if (!openManager('chat', action)) throw new Error(uiText('当前 Zotero 窗口不可用，无法解读图片。', 'The Zotero window is unavailable for image interpretation.'))
    })
  })
  if (!active()) { trace.event('startup_cancelled'); trace.end('cancelled'); return }
  await step('smoke', async () => { await probeLocalizationForSmoke(); if (active()) openManagerForSmoke() })
  if (!active()) { trace.end('cancelled'); return }
  warmFavoriteFoldersCache()
  trace.event(degraded ? 'startup_degraded' : 'startup_complete'); trace.end(degraded ? 'error' : 'success')
  log(degraded ? 'startup_degraded' : 'startup_complete'); log('started')
}

function shutdown() {
  stopped = true; lifecycleGeneration++; cancelStartupWait?.(); cancelStartupWait = undefined
  const trace = lifecycleTrace(Zotero, 'initialization', 'shutdown')
  const cleanups: Array<[string, () => void]> = [
    ['analysis', () => stopAnalysisRuntime(Zotero)], ['chat', () => stopChatRuntime(Zotero)], ['documents', () => stopDocumentJobs(Zotero)],
    ['pdf', () => stopPDFTranslationJobs(Zotero)],
    ['figures', () => { const remove = unregisterReaderFigureTools; unregisterReaderFigureTools = null; remove?.() }],
    ['reader', () => { const remove = unregisterReaderTools; unregisterReaderTools = null; remove?.() }],
    ['classification', () => closeClassificationWindow(Zotero)],
    ['manager', () => closeManagerWindow(Zotero)], ['menus', unregisterMenus],
    ['preferences', () => { const id = registeredPreferencesPaneID; registeredPreferencesPaneID = null; unregisterPreferencesPane(Zotero, id) }],
    ['panel', () => { const id = registeredSyncPanelID; registeredSyncPanelID = null; unregisterSyncPanel(Zotero, id, pluginContext.pluginID) }],
    ['chrome', () => { const handle = registeredChromeContent; registeredChromeContent = null; unregisterChromeContent(handle) }],
  ]
  let failed = false
  for (const [stage, cleanup] of cleanups) { trace.event(stage); try { cleanup() } catch (error) { failed = true; trace.fail(error, stage, 'SHUTDOWN_COMPONENT_FAILED') } }
  trace.end(failed ? 'error' : 'success'); log('stopped')
  try { stopDiagnostics(Zotero) } catch { /* 诊断不能阻止卸载。 */ }
  smokeManagerOpened = false; smokeLocalizationProbed = false
}

function onMainWindowLoad(data: { window?: Window & typeof globalThis } = {}) {
  if (stopped) return
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
