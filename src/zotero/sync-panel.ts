/** 原生条目面板使用启动语言；主题只覆盖插件自有正文，不覆盖 Zotero 标题与侧栏。 */
import { getUiLocale, observeTheme, uiText } from "./ui-preferences"
import { element } from "./ui/controls"
import {
  pushSelectedCollectionToJadense,
  pushSelectedItemsToJadense,
  readCollectionUploadIncludePdfDefault,
  readConnection,
  readFavoriteFoldersCache,
  selectedZoteroCollections,
  SYNC_PANEL_PREF_KEYS,
  type ZoteroLike,
} from "./runtime"
import type { BootstrapPluginContext } from "./native-preferences"
import { formatJadenseSyncResult } from "./sync-result"
import { renderNativeReaderSidebar, removeNativeReaderSidebar, removeReaderSidebars } from "./reader-sidebar"

export const JADENSE_SYNC_PANEL_ID = "jadense-in-zotero-sync-panel"

export type ZoteroSelectionSummary = {
  selectedItemCount: number
  hasSelectedCollection: boolean
  collectionName: string | null
}

export type SyncPanelState = {
  stage: "connect" | "folder" | "ready" | "no-selection"
  managerActionLabel: string
  connected: boolean
  baseUrl: string
  defaultFolderId: string
  includePdfDefault: boolean
  selection: ZoteroSelectionSummary
  hintLabel: string
  connectionLabel: string
  folderLabel: string
  selectionLabels: string[]
  canExportItems: boolean
  canExportCollection: boolean
}

export type SyncPanelCallbacks = {
  openManager?: () => void
  openConnection?: () => void
  openUploadDestination?: () => void
  openTranslationHistory?: () => void
}

function defaultPaneHandle(pluginID: string, paneID: string) {
  return `${pluginID}-${paneID}`
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function selectedCollectionName(collection: unknown) {
  if (!collection || typeof collection !== "object") return null
  const record = collection as Record<string, unknown>
  const direct = text(record.name)
  if (direct) return direct
  const getName = record.getName
  if (typeof getName === "function") return text(getName.call(collection)) || null
  return null
}

/** 工作台展示及上传共享一次读取的选择，避免跨窗口切换后扩大操作范围。 */
export function readUploadSelection(zotero: ZoteroLike) {
  return {
    items: [...(zotero.getActiveZoteroPane?.()?.getSelectedItems?.() ?? [])],
    collections: [...selectedZoteroCollections(zotero)],
  }
}

export function summarizeZoteroSelection(zotero: ZoteroLike, selection = readUploadSelection(zotero)): ZoteroSelectionSummary {
  const { items: selectedItems, collections } = selection
  const collection = collections[0] ?? null
  return {
    selectedItemCount: selectedItems.length,
    hasSelectedCollection: Boolean(collection),
    collectionName: collections.length > 1 ? uiText(`${collections.length} 个分类`, `${collections.length} collections`) : selectedCollectionName(collection),
  }
}

export function buildSyncPanelState(zotero: ZoteroLike): SyncPanelState {
  const connection = readConnection(zotero)
  const connected = Boolean(connection.token)
  const hasDefaultFolder = Boolean(connection.defaultFolderId)
  const selection = summarizeZoteroSelection(zotero)
  // 收藏夹名称属于可选展示。旧缓存缺少名称时仍可按已保存的 ID 上传。
  const folder = hasDefaultFolder && readFavoriteFoldersCache(zotero)?.folders.find(entry => entry.id === connection.defaultFolderId)
  const stage = !connected ? "connect" : !hasDefaultFolder ? "folder"
    : selection.hasSelectedCollection || selection.selectedItemCount > 0 ? "ready" : "no-selection"

  return {
    stage,
    managerActionLabel: uiText("打开攻玉工作台", "Open Jadense Workspace"),
    connected,
    baseUrl: connection.baseUrl,
    defaultFolderId: connection.defaultFolderId,
    includePdfDefault: readCollectionUploadIncludePdfDefault(zotero),
    selection,
    hintLabel: stage === "connect" ? uiText("连接账号后即可上传选中的文献。", "Connect your account to upload papers.")
      : stage === "folder" ? uiText("选择一个攻玉收藏夹来接收文献。", "Choose the Jadense folder that will receive your papers.")
      : stage === "no-selection" ? uiText("在 Zotero 文库中选择条目或分类。", "Select items or a collection in your Zotero library.") : "",
    connectionLabel: connected ? uiText(`已连接 ${connection.baseUrl}`, `Connected to ${connection.baseUrl}`) : uiText("未连接攻玉", "Jadense is disconnected"),
    folderLabel: (folder && folder.name.trim()) || connection.defaultFolderId || uiText("尚未选择", "Not selected"),
    selectionLabels: [
      selection.hasSelectedCollection
        ? selection.collectionName || uiText("未命名分类", "Untitled collection")
        : uiText("未选中", "None selected"),
      selection.selectedItemCount > 0
        ? uiText(`${selection.selectedItemCount} 个条目`, `${selection.selectedItemCount} ${selection.selectedItemCount === 1 ? "item" : "items"}`)
        : uiText("未选中", "None selected"),
    ],
    canExportItems: connected && hasDefaultFolder && selection.selectedItemCount > 0,
    canExportCollection: connected && hasDefaultFolder && selection.hasSelectedCollection,
  }
}

function setStatus(target: HTMLElement, message: string, kind: "idle" | "error" | "success" = "idle") {
  target.textContent = message
  target.dataset.kind = kind
}

const PANEL_STYLES = `
  .jdx-sync-panel {
    --jdx-sync-bg: #fff; --jdx-sync-text: #111510; --jdx-sync-muted: #53625a;
    --jdx-sync-line: #d9e2dd; --jdx-sync-hover: #f1f4ef; --jdx-sync-focus: #117a52;
    --jdx-sync-success: #117a52; --jdx-sync-error: #b42318;
    color-scheme: light; color: var(--jdx-sync-text); background: var(--jdx-sync-bg);
    font: calc(12px * var(--jdx-font-scale,1))/1.45 system-ui, sans-serif;
    display: grid; gap: 10px; min-width: 0; padding: 10px 12px; box-sizing: border-box;
    overflow-wrap: anywhere;
  }
  .jdx-sync-panel[data-theme="dark"] {
    --jdx-sync-bg: #1a201c; --jdx-sync-text: #e4eae6; --jdx-sync-muted: #a3b0a9;
    --jdx-sync-line: #42504a; --jdx-sync-hover: #2b342f; --jdx-sync-focus: #7fe0b2;
    --jdx-sync-success: #7fe0b2; --jdx-sync-error: #f5a097; color-scheme: dark;
  }
  .jdx-sync-panel [hidden] { display: none !important; }
  .jdx-sync-panel h2, .jdx-sync-panel p, .jdx-sync-panel dl, .jdx-sync-panel dd { margin: 0; }
  .jdx-sync-panel h2 { color: inherit; font: 650 1.16em/1.35 system-ui, sans-serif; }
  .jdx-sync-hint { color: var(--jdx-sync-muted); margin-top: 3px !important; }
  .jdx-sync-facts { display: grid; gap: 4px; }
  .jdx-sync-row { display: grid; grid-template-columns: minmax(0, 7em) minmax(0, 1fr); gap: 6px; }
  .jdx-sync-row dt { color: var(--jdx-sync-muted); }
  .jdx-sync-row dd { min-width: 0; }
  .jdx-sync-row[data-row="destination"] { grid-template-columns: auto minmax(0, 1fr); align-items: baseline; }
  .jdx-sync-destination { font-weight: 600; }
  .jdx-sync-action-scope { display: block; color: var(--jdx-sync-muted); font-size: .94em; font-weight: 400; }
  .jdx-sync-actions { display: grid; gap: 5px; }
  .jdx-sync-panel button {
    appearance: none; box-sizing: border-box; min-width: 0; margin: 0; cursor: pointer;
    background: var(--jdx-sync-bg); color: inherit; border: 1px solid var(--jdx-sync-line);
    border-radius: 6px; padding: 6px 10px; min-height: 32px; font: inherit;
    font-weight: 600; text-align: center; overflow-wrap: anywhere; white-space: normal;
  }
  .jdx-sync-panel button:hover:enabled { background: var(--jdx-sync-hover); }
  .jdx-sync-panel button[data-primary="true"] { border-color: #16cf8c; background: #16cf8c; color: #07351f; }
  .jdx-sync-panel button[data-primary="true"]:hover:enabled { background: #22d997; }
  .jdx-sync-panel button:focus-visible { outline: 2px solid var(--jdx-sync-focus); outline-offset: 2px; }
  .jdx-sync-panel button:disabled { color: var(--jdx-sync-muted); opacity: .65; cursor: default; }
  .jdx-sync-panel .jdx-sync-link {
    min-height: 24px; padding: 1px 3px; border: 0; background: transparent;
    color: var(--jdx-sync-muted); font-weight: 500; text-align: start;
    text-decoration: underline; text-underline-offset: 3px;
  }
  .jdx-sync-footer { border-top: 1px solid var(--jdx-sync-line); padding-top: 5px; }
  .jdx-sync-status { white-space: pre-wrap; color: var(--jdx-sync-muted); }
  .jdx-sync-status:empty { display: none; }
  .jdx-sync-status[data-kind="error"] { color: var(--jdx-sync-error); }
  .jdx-sync-status[data-kind="success"] { color: var(--jdx-sync-success); }
`

const panelCleanups = new WeakMap<HTMLElement, () => void>()

export function renderSyncPanel(input: {
  doc: Document
  body: HTMLDivElement
  zotero: ZoteroLike
  callbacks?: SyncPanelCallbacks
}) {
  const { doc, body, zotero, callbacks } = input
  panelCleanups.get(body)?.()
  const root = element(doc, "section", "jdx-sync-panel")
  const style = element(doc, "style", "", PANEL_STYLES)
  const header = element(doc, "header")
  const title = element(doc, "h2", "", uiText("上传到攻玉", "Upload to Jadense"))
  const hint = element(doc, "p", "jdx-sync-hint")
  header.append(title, hint)
  const facts = element(doc, "dl", "jdx-sync-facts")
  const actions = element(doc, "div", "jdx-sync-actions")
  const status = element(doc, "div", "jdx-sync-status")
  status.setAttribute("role", "status")
  const footer = element(doc, "footer", "jdx-sync-footer")
  const field = (key: string, label: string) => {
    const row = element(doc, "div", "jdx-sync-row")
    row.dataset.row = key
    const value = element(doc, "span")
    value.dataset.syncField = key
    const cell = element(doc, "dd"); cell.append(value)
    row.append(element(doc, "dt", "", label), cell); facts.append(row)
    return value
  }
  const button = (key: string, label: string, onClick?: () => void) => {
    const control = element(doc, "button", "", label)
    control.type = "button"; control.dataset.syncAction = key
    if (onClick) control.addEventListener("click", onClick)
    else control.disabled = true
    return control
  }
  const destination = field("destination", uiText("上传至", "Upload to"))
  destination.className = "jdx-sync-destination"
  const itemsValue = field("items", uiText("选中条目", "Selected items"))
  const collectionValue = field("collection", uiText("Zotero 分类", "Zotero collection"))
  const pdf = field("pdf", uiText("上传内容", "Include"))
  const connect = button("connect", uiText("连接攻玉", "Connect Jadense"), callbacks?.openConnection)
  const chooseFolder = button("folder", uiText("选择目标收藏夹", "Choose destination folder"), callbacks?.openUploadDestination)
  connect.dataset.primary = chooseFolder.dataset.primary = "true"
  const changeFolder = button("change-folder", uiText("更改", "Change"), callbacks?.openUploadDestination)
  changeFolder.className = "jdx-sync-link"
  changeFolder.setAttribute("aria-label", uiText("更改上传收藏夹和 PDF 设置", "Change upload folder and PDF settings"))
  destination.after(doc.createTextNode(" "), changeFolder)
  const manager = button("workspace", uiText("打开攻玉工作台", "Open Jadense Workspace"), callbacks?.openManager)
  manager.className = "jdx-sync-link"
  footer.append(manager)

  // 渲染和点击沿用同一份本地设置；跨窗口选择收藏夹/附件后立即更新原有控件与键盘焦点。
  const upload = async (scope: "items" | "collection") => {
    const state = buildSyncPanelState(zotero)
    const run = scope === "items" ? pushSelectedItemsToJadense : pushSelectedCollectionToJadense
    setStatus(status, uiText(`正在上传至「${state.folderLabel}」…`, `Uploading to ${state.folderLabel}…`))
    try {
      const result = await run(zotero, { includePdf: state.includePdfDefault })
      setStatus(status, uiText(`已完成向「${state.folderLabel}」的上传。\n`, `Upload to ${state.folderLabel} finished.\n`) + formatJadenseSyncResult(result), "success")
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : uiText("上传失败。", "Upload failed."), "error")
    }
  }
  const items = button("items", "", () => { void upload("items") })
  const collection = button("collection", "", () => { void upload("collection") })
  const collectionLabel = element(doc, "span")
  const collectionScope = element(doc, "span", "jdx-sync-action-scope")
  collection.append(collectionLabel, collectionScope)
  actions.append(items, collection)
  root.append(style, header, connect, chooseFolder, facts, actions, status, footer)
  body.replaceChildren(root)

  const refresh = () => {
    const state = buildSyncPanelState(zotero)
    root.dataset.state = state.stage
    const ready = state.stage === "ready"
    const count = state.selection.selectedItemCount
    title.textContent = ready && count ? uiText(`已选 ${count} 个条目`, `${count} ${count === 1 ? "item" : "items"} selected`)
      : ready ? uiText(`已选分类「${state.selectionLabels[0]}」`, `Selected collection · ${state.selectionLabels[0]}`)
      : uiText("上传到攻玉", "Upload to Jadense")
    hint.textContent = state.hintLabel; hint.hidden = !state.hintLabel
    connect.hidden = state.stage !== "connect"; chooseFolder.hidden = state.stage !== "folder"
    itemsValue.textContent = state.selectionLabels[1]; collectionValue.textContent = state.selectionLabels[0]
    destination.textContent = state.folderLabel
    pdf.textContent = state.includePdfDefault ? uiText("题录和可读取的 PDF", "Metadata and readable PDFs") : uiText("仅题录", "Metadata only")
    for (const value of [itemsValue, collectionValue, pdf]) value.closest("div")!.hidden = ready
    changeFolder.hidden = !state.connected || !state.defaultFolderId
    actions.hidden = state.stage === "connect" || state.stage === "folder"
    const attachmentScope = state.includePdfDefault ? uiText("（含 PDF）", " with PDFs") : uiText("（仅题录）", " (metadata only)")
    const uploadItems = count ? uiText(`上传 ${count} 个条目`, `Upload ${count} ${count === 1 ? "item" : "items"}`) : uiText("上传选中条目", "Upload selected items")
    items.textContent = uploadItems + attachmentScope
    collectionLabel.textContent = uiText("上传分类及子分类", "Upload collection and subcollections") + attachmentScope
    collectionScope.textContent = state.selectionLabels[0]
    collectionScope.hidden = !state.canExportCollection || !state.canExportItems
    items.disabled = !state.canExportItems
    collection.disabled = !state.canExportCollection
    items.dataset.primary = String(state.canExportItems)
    collection.dataset.primary = String(!state.canExportItems && state.canExportCollection)
    const firstAction = state.canExportCollection && !state.canExportItems ? collection : items
    if (actions.firstElementChild !== firstAction) actions.prepend(firstAction)
  }
  refresh()
  const stopTheme = observeTheme(zotero, root)
  const prefs = zotero.Prefs
  const observerIDs: unknown[] = []
  if (prefs?.registerObserver && prefs.unregisterObserver) {
    for (const key of SYNC_PANEL_PREF_KEYS) {
      try { observerIDs.push(prefs.registerObserver(key, refresh)) } catch { /* 旧宿主回到文库时更新。 */ }
    }
  }
  const win = doc.defaultView
  win?.addEventListener("focus", refresh)
  const cleanup = () => {
    stopTheme()
    for (const id of observerIDs) {
      try { prefs?.unregisterObserver?.(id) } catch { /* 窗口可能已关闭。 */ }
    }
    win?.removeEventListener("focus", refresh)
    win?.removeEventListener("unload", cleanup)
    panelCleanups.delete(body)
  }
  panelCleanups.set(body, cleanup)
  win?.addEventListener("unload", cleanup, { once: true })
}

export function registerSyncPanel(
  zotero: ZoteroLike,
  context: BootstrapPluginContext,
  callbacks: SyncPanelCallbacks = {},
) {
  if (!zotero.ItemPaneManager?.registerSection) return null
  const registeredID = zotero.ItemPaneManager.registerSection({
    paneID: JADENSE_SYNC_PANEL_ID,
    pluginID: context.pluginID,
    header: {
      l10nArgs: JSON.stringify({ language: getUiLocale() }),
      l10nID: "jadense-in-zotero-panel-header",
      icon: `${context.rootURI}icons/jadense-16.svg`,
    },
    sidenav: {
      l10nArgs: JSON.stringify({ language: getUiLocale() }),
      l10nID: "jadense-in-zotero-panel-sidenav",
      icon: `${context.rootURI}icons/jadense-20.svg`,
    },
    onItemChange: ({ setEnabled }) => {
      setEnabled(true)
    },
    onDestroy: ({ body }) => { panelCleanups.get(body)?.(); removeNativeReaderSidebar(body) },
    onRender: ({ doc, body, tabType }) => {
      if (tabType !== "library" && (tabType || (body.closest("item-details") as HTMLElement & { tabID?: string } | null)?.tabID)) {
        renderNativeReaderSidebar(body, zotero, callbacks.openTranslationHistory)
        panelCleanups.get(body)?.(); return
      }
      removeNativeReaderSidebar(body)
      renderSyncPanel({ doc, body, zotero, callbacks })
    },
  })
  if (registeredID === false) return null
  return typeof registeredID === "string" && registeredID.length > 0
    ? registeredID
    : defaultPaneHandle(context.pluginID, JADENSE_SYNC_PANEL_ID)
}

export function unregisterSyncPanel(zotero: ZoteroLike, paneID: string | null, _pluginID = "") {
  removeReaderSidebars(zotero)
  if (!paneID) return
  try {
    zotero.ItemPaneManager?.unregisterSection?.(paneID)
  } catch {
    // Continue unregistering fallback handles.
  }
}
