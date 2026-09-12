/** 原生条目面板使用启动语言；主题只覆盖插件自有正文，不覆盖 Zotero 标题与侧栏。 */
import { getUiLocale, observeTheme, uiText } from "./ui-preferences"
import {
  pushSelectedCollectionToJadense,
  pushSelectedItemsToJadense,
  readCollectionUploadIncludePdfDefault,
  readConnection,
  selectedZoteroCollections,
  type ZoteroLike,
} from "./runtime"
import type { BootstrapPluginContext } from "./native-preferences"
import { formatJadenseSyncResult } from "./sync-result"
import { mountNativeReaderSidebar, removeNativeReaderSidebar, removeReaderSidebars } from "./reader-sidebar"

export const JADENSE_SYNC_PANEL_ID = "jadense-in-zotero-sync-panel"

export type ZoteroSelectionSummary = {
  selectedItemCount: number
  hasSelectedCollection: boolean
  collectionName: string | null
}

export type SyncPanelState = {
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

export function summarizeZoteroSelection(zotero: ZoteroLike): ZoteroSelectionSummary {
  const pane = zotero.getActiveZoteroPane?.()
  const selectedItems = pane?.getSelectedItems?.() ?? []
  const collections = selectedZoteroCollections(zotero)
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

  return {
    managerActionLabel: uiText("打开攻玉工作台", "Open Jadense Workspace"),
    connected,
    baseUrl: connection.baseUrl,
    defaultFolderId: connection.defaultFolderId,
    includePdfDefault: readCollectionUploadIncludePdfDefault(zotero),
    selection,
    hintLabel: uiText("在攻玉工作台中对话，或将 Zotero 文献单向上传到攻玉。", "Chat in Jadense Workspace or upload Zotero literature to Jadense."),
    connectionLabel: connected ? uiText(`已连接 ${connection.baseUrl}`, `Connected to ${connection.baseUrl}`) : uiText("未配置攻玉令牌，请打开「连接攻玉」", "No Jadense token. Open Connect Jadense."),
    folderLabel: hasDefaultFolder ? uiText(`默认收藏夹：${connection.defaultFolderId}`, `Default folder: ${connection.defaultFolderId}`) : uiText("未设置默认收藏夹", "No default folder selected"),
    selectionLabels: [
      selection.hasSelectedCollection
        ? uiText(`当前分类：${selection.collectionName ?? "未命名分类"}`, `Current collection: ${selection.collectionName ?? "Untitled collection"}`)
        : uiText("未选中分类", "No collection selected"),
      selection.selectedItemCount > 0
        ? uiText(`已选中 ${selection.selectedItemCount} 个条目`, `${selection.selectedItemCount} items selected`)
        : uiText("未选中条目", "No items selected"),
    ],
    canExportItems: connected && hasDefaultFolder && selection.selectedItemCount > 0,
    canExportCollection: connected && hasDefaultFolder && selection.hasSelectedCollection,
  }
}

function create(doc: Document, tagName: keyof HTMLElementTagNameMap, className?: string, textContent?: string) {
  const node = doc.createElement(tagName)
  if (className) node.className = className
  if (textContent !== undefined) node.textContent = textContent
  return node
}

function setStatus(target: HTMLElement, message: string, kind: "idle" | "error" | "success" = "idle") {
  target.textContent = message
  target.dataset.kind = kind
}

function formatCommandResult(result: unknown) {
  return formatJadenseSyncResult(result)
}

async function runPanelCommand(
  status: HTMLElement,
  operation: () => Promise<unknown>,
) {
  setStatus(status, uiText("正在上传到攻玉…", "Uploading to Jadense…"))
  try {
    const result = await operation()
    setStatus(status, uiText(`上传完成。\n${formatCommandResult(result)}`, `Upload completed.\n${formatCommandResult(result)}`), "success")
  } catch (error) {
    setStatus(status, error instanceof Error ? error.message : uiText("上传失败。", "Upload failed."), "error")
  }
}

function appendButton(input: {
  doc: Document
  parent: HTMLElement
  label: string
  disabled: boolean
  primary?: boolean
  onClick: () => void
}) {
  const button = create(
    input.doc,
    "button",
    input.primary ? "jdx-sync-button jdx-sync-button-primary" : "jdx-sync-button",
  ) as HTMLButtonElement
  button.type = "button"
  button.textContent = input.label
  button.disabled = input.disabled
  button.addEventListener("click", input.onClick)
  input.parent.append(button)
}

const PANEL_STYLES = `
  .jdx-sync-panel {
    --jdx-sidebar: #f7f8f5;
    --jdx-text: #111510;
    --jdx-muted: #53625a;
    --jdx-line: #d9e2dd;
    --jdx-line-strong: #b9c7c0;
    --jdx-surface: #ffffff;
    --jdx-subtle: #f1f4ef;
    --jdx-press-bg: #e6ece8;
    --jdx-green: #16cf8c;
    --jdx-green-hover: #22d997;
    --jdx-active-bg: #d4fae8;
    --jdx-active-text: #07351f;
    --jdx-error-text: #b42318;
    --jdx-error-bg: #fef3f2;
    --jdx-success-text: #117a52;
    --jdx-success-bg: #ecfdf3;
    color-scheme: light;
    display: flex;
    flex-direction: column;
    min-height: 100%;
    overflow: hidden;
    color: var(--jdx-text);
    background: var(--jdx-sidebar);
    font: calc(12px * var(--jdx-font-scale,1))/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .jdx-sync-panel[data-theme="dark"] {
    color-scheme: dark;
    --jdx-sidebar: #1a201c;
    --jdx-text: #e4eae6;
    --jdx-muted: #9aa8a1;
    --jdx-line: #303a34;
    --jdx-line-strong: #42504a;
    --jdx-surface: #27312a;
    --jdx-subtle: #232b26;
    --jdx-press-bg: #2b342f;
    --jdx-green: #16cf8c;
    --jdx-green-hover: #4fe3ab;
    --jdx-active-bg: #0f2e21;
    --jdx-active-text: #8ff0c8;
    --jdx-error-text: #f5a097;
    --jdx-error-bg: #3a2320;
    --jdx-success-text: #7fe0b2;
    --jdx-success-bg: #14291f;
  }
  .jdx-sync-content {
    display: grid;
    flex: 1 1 auto;
    align-content: start;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    padding: 12px;
  }
  .jdx-sync-intro {
    display: grid;
    gap: 3px;
  }
  .jdx-sync-intro strong {
    font-size: calc(14px * var(--jdx-font-scale,1));
    line-height: 1.35;
  }
  .jdx-sync-hint {
    margin: 0;
    color: var(--jdx-muted);
    font-size: calc(11.5px * var(--jdx-font-scale,1));
    line-height: 1.6;
  }
  .jdx-sync-card {
    display: grid;
    gap: 6px;
    border: 1px solid var(--jdx-line);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--jdx-surface);
  }
  .jdx-sync-card-heading,
  .jdx-sync-actions-heading {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 2px;
    color: var(--jdx-muted);
    font-size: calc(10.5px * var(--jdx-font-scale,1));
    font-weight: 650;
    letter-spacing: .02em;
  }
  .jdx-sync-card-heading::before,
  .jdx-sync-actions-heading::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--jdx-green);
  }
  .jdx-sync-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-weight: 600;
    color: var(--jdx-text);
  }
  .jdx-sync-pill::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #b7c4bd;
  }
  .jdx-sync-pill[data-connected="true"]::before {
    background: var(--jdx-green);
  }
  .jdx-sync-line {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    min-width: 0;
    border-top: 1px solid var(--jdx-line);
    padding-top: 6px;
    color: var(--jdx-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .jdx-sync-line::before {
    content: "";
    flex: 0 0 4px;
    width: 4px;
    height: 4px;
    margin-top: 7px;
    border-radius: 50%;
    background: var(--jdx-line-strong);
  }
  .jdx-sync-actions {
    display: grid;
    gap: 8px;
  }
  .jdx-sync-actions-heading { margin: 0 0 1px; }
  .jdx-sync-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    min-height: 32px;
    border: 1px solid var(--jdx-line);
    border-radius: 6px;
    padding: 6px 10px;
    color: var(--jdx-text);
    background: var(--jdx-surface);
    font: inherit;
    font-weight: 600;
    text-align: start;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
  }
  .jdx-sync-button:hover:not(:disabled) {
    border-color: var(--jdx-line-strong);
    background: var(--jdx-press-bg);
  }
  .jdx-sync-button-primary {
    border-color: var(--jdx-green);
    background: var(--jdx-green);
    color: #07351f;
  }
  .jdx-sync-button-primary:hover:not(:disabled) {
    border-color: var(--jdx-green-hover);
    background: var(--jdx-green-hover);
  }
  .jdx-sync-button:active:not(:disabled) { transform: translateY(1px); }
  .jdx-sync-button:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .jdx-sync-status {
    min-height: 0;
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--jdx-subtle);
    color: var(--jdx-muted);
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .jdx-sync-status:focus-visible,
  .jdx-sync-button:focus-visible {
    outline: 2px solid var(--jdx-green);
    outline-offset: 2px;
  }
  .jdx-sync-status:empty {
    display: none;
  }
  .jdx-sync-status[data-kind="error"] {
    background: var(--jdx-error-bg);
    color: var(--jdx-error-text);
  }
  .jdx-sync-status[data-kind="success"] {
    background: var(--jdx-success-bg);
    color: var(--jdx-success-text);
  }
`

const panelThemes = new WeakMap<HTMLElement, () => void>()

export function renderSyncPanel(input: {
  doc: Document
  body: HTMLDivElement
  zotero: ZoteroLike
  callbacks?: SyncPanelCallbacks
}) {
  const { doc, body, zotero, callbacks } = input
  const state = buildSyncPanelState(zotero)
  panelThemes.get(body)?.()
  body.replaceChildren()

  const root = create(doc, "div", "jdx-sync-panel")
  const style = create(doc, "style")
  style.textContent = PANEL_STYLES

  const content = create(doc, "div", "jdx-sync-content")
  const intro = create(doc, "section", "jdx-sync-intro")
  const introTitle = create(doc, "strong", "", uiText("在 Zotero 中继续研究", "Continue your research in Zotero"))
  const hint = create(doc, "p", "jdx-sync-hint")
  hint.textContent = state.hintLabel
  intro.append(introTitle, hint)

  const card = create(doc, "section", "jdx-sync-card")
  const cardHeading = create(doc, "h2", "jdx-sync-card-heading", uiText("当前状态", "Current status"))
  const pill = create(doc, "span", "jdx-sync-pill")
  pill.dataset.connected = String(state.connected)
  pill.textContent = state.connectionLabel
  card.append(cardHeading, pill)
  for (const label of [state.folderLabel, ...state.selectionLabels]) {
    const line = create(doc, "div", "jdx-sync-line")
    line.textContent = label
    line.title = label
    card.append(line)
  }

  const actionSection = create(doc, "section", "jdx-sync-action-section")
  const actionsHeading = create(doc, "h2", "jdx-sync-actions-heading", uiText("快捷操作", "Quick actions"))
  const actions = create(doc, "div", "jdx-sync-actions")
  const commandStatus = create(doc, "div", "jdx-sync-status")
  commandStatus.setAttribute("role", "status")

  appendButton({
    doc,
    parent: actions,
    label: state.managerActionLabel,
    disabled: !callbacks?.openManager,
    onClick: () => {
      callbacks?.openManager?.()
    },
  })
  appendButton({
    doc,
    parent: actions,
    label: uiText("上传选中条目", "Upload selected items"),
    disabled: !state.canExportItems,
    primary: true,
    onClick: () => {
      void runPanelCommand(commandStatus, () => pushSelectedItemsToJadense(zotero, {
        includePdf: readCollectionUploadIncludePdfDefault(zotero),
      }))
    },
  })
  appendButton({
    doc,
    parent: actions,
    label: state.includePdfDefault ? uiText("上传收藏夹（含 PDF）", "Upload collection with PDFs") : uiText("上传收藏夹", "Upload collection"),
    disabled: !state.canExportCollection,
    primary: true,
    onClick: () => {
      void runPanelCommand(commandStatus, () =>
        pushSelectedCollectionToJadense(zotero, { includePdf: readCollectionUploadIncludePdfDefault(zotero) }))
    },
  })
  actionSection.append(actionsHeading, actions)
  content.append(intro, card, actionSection, commandStatus)
  root.append(style, content)
  body.append(root)
  const stopObservingTheme = observeTheme(zotero, root)
  const stopTheme = () => {
    stopObservingTheme()
    doc.defaultView?.removeEventListener("unload", stopTheme)
  }
  panelThemes.set(body, stopTheme)
  doc.defaultView?.addEventListener("unload", stopTheme, { once: true })
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
    onDestroy: ({ body }) => { panelThemes.get(body)?.(); panelThemes.delete(body); removeNativeReaderSidebar(body) },
    onRender: ({ doc, body, tabType }) => {
      if (tabType && tabType !== "library" && mountNativeReaderSidebar(body, zotero, callbacks.openTranslationHistory)) {
        panelThemes.get(body)?.(); panelThemes.delete(body); return
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
