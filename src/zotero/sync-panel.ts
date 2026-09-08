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
    collectionName: collections.length > 1 ? `${collections.length} 个分类` : selectedCollectionName(collection),
  }
}

export function buildSyncPanelState(zotero: ZoteroLike): SyncPanelState {
  const connection = readConnection(zotero)
  const connected = Boolean(connection.token)
  const hasDefaultFolder = Boolean(connection.defaultFolderId)
  const selection = summarizeZoteroSelection(zotero)

  return {
    managerActionLabel: "打开攻玉工作台",
    connected,
    baseUrl: connection.baseUrl,
    defaultFolderId: connection.defaultFolderId,
    includePdfDefault: readCollectionUploadIncludePdfDefault(zotero),
    selection,
    hintLabel: "在攻玉工作台中对话，或将 Zotero 文献单向上传到攻玉。",
    connectionLabel: connected ? `已连接 ${connection.baseUrl}` : "未配置攻玉令牌，请打开「连接攻玉」",
    folderLabel: hasDefaultFolder ? `默认收藏夹：${connection.defaultFolderId}` : "未设置默认收藏夹",
    selectionLabels: [
      selection.hasSelectedCollection
        ? `当前分类：${selection.collectionName ?? "未命名分类"}`
        : "未选中分类",
      selection.selectedItemCount > 0
        ? `已选中 ${selection.selectedItemCount} 个条目`
        : "未选中条目",
    ],
    canExportItems: connected && hasDefaultFolder && selection.selectedItemCount > 0,
    canExportCollection: connected && hasDefaultFolder && selection.hasSelectedCollection,
  }
}

function create(doc: Document, tagName: keyof HTMLElementTagNameMap, className?: string) {
  const node = doc.createElement(tagName)
  if (className) node.className = className
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
  setStatus(status, "正在上传到攻玉…")
  try {
    const result = await operation()
    setStatus(status, `上传完成。\n${formatCommandResult(result)}`, "success")
  } catch (error) {
    setStatus(status, error instanceof Error ? error.message : "上传失败。", "error")
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
    --jdx-text: #17211b;
    --jdx-muted: #53625a;
    --jdx-line: #d9e2dd;
    --jdx-line-strong: #b9c7c0;
    --jdx-surface: #ffffff;
    --jdx-subtle: #f1f4ef;
    --jdx-green-deep: #0f7c56;
    --jdx-green-deep-hover: #0b6848;
    --jdx-green-text: #ffffff;
    --jdx-error-text: #b42318;
    --jdx-error-bg: #fef3f2;
    --jdx-success-text: #117a52;
    --jdx-success-bg: #ecfdf3;
    display: grid;
    gap: 10px;
    color: var(--jdx-text);
    font: 12px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    .jdx-sync-panel {
      --jdx-text: #e4eae6;
      --jdx-muted: #9aa8a1;
      --jdx-line: #303a34;
      --jdx-line-strong: #42504a;
      --jdx-surface: #202723;
      --jdx-subtle: #1b211e;
      --jdx-green-deep: #2f9d71;
      --jdx-green-deep-hover: #3bb184;
      --jdx-green-text: #eef7f2;
      --jdx-error-text: #f5a097;
      --jdx-error-bg: #3a2320;
      --jdx-success-text: #7fe0b2;
      --jdx-success-bg: #14291f;
    }
  }
  .jdx-sync-hint {
    margin: 0;
    color: var(--jdx-muted);
    font-size: 11.5px;
  }
  .jdx-sync-card {
    display: grid;
    gap: 6px;
    border: 1px solid var(--jdx-line);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--jdx-surface);
  }
  .jdx-sync-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
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
    background: #16cf8c;
  }
  .jdx-sync-line {
    color: var(--jdx-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .jdx-sync-actions {
    display: grid;
    gap: 8px;
  }
  .jdx-sync-button {
    min-height: 32px;
    border: 1px solid var(--jdx-line);
    border-radius: 6px;
    padding: 6px 10px;
    color: var(--jdx-text);
    background: var(--jdx-surface);
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .jdx-sync-button:hover:not(:disabled) {
    border-color: var(--jdx-line-strong);
    background: var(--jdx-subtle);
  }
  .jdx-sync-button-primary {
    border-color: var(--jdx-green-deep);
    background: var(--jdx-green-deep);
    color: var(--jdx-green-text);
  }
  .jdx-sync-button-primary:hover:not(:disabled) {
    border-color: var(--jdx-green-deep-hover);
    background: var(--jdx-green-deep-hover);
  }
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

export function renderSyncPanel(input: {
  doc: Document
  body: HTMLDivElement
  zotero: ZoteroLike
  callbacks?: SyncPanelCallbacks
}) {
  const { doc, body, zotero, callbacks } = input
  const state = buildSyncPanelState(zotero)
  body.replaceChildren()

  const root = create(doc, "div", "jdx-sync-panel")
  const style = create(doc, "style")
  style.textContent = PANEL_STYLES

  const hint = create(doc, "p", "jdx-sync-hint")
  hint.textContent = state.hintLabel

  const card = create(doc, "div", "jdx-sync-card")
  const pill = create(doc, "span", "jdx-sync-pill")
  pill.dataset.connected = String(state.connected)
  pill.textContent = state.connectionLabel
  card.append(pill)
  for (const label of [state.folderLabel, ...state.selectionLabels]) {
    const line = create(doc, "div", "jdx-sync-line")
    line.textContent = label
    line.title = label
    card.append(line)
  }

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
    label: "上传选中条目",
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
    label: state.includePdfDefault ? "上传收藏夹（含 PDF）" : "上传收藏夹",
    disabled: !state.canExportCollection,
    primary: true,
    onClick: () => {
      void runPanelCommand(commandStatus, () =>
        pushSelectedCollectionToJadense(zotero, { includePdf: readCollectionUploadIncludePdfDefault(zotero) }))
    },
  })
  root.append(style, hint, card, actions, commandStatus)
  body.append(root)
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
      l10nID: "jadense-in-zotero-panel-header",
      icon: `${context.rootURI}icons/jadense-16.svg`,
    },
    sidenav: {
      l10nID: "jadense-in-zotero-panel-sidenav",
      icon: `${context.rootURI}icons/jadense-20.svg`,
    },
    onItemChange: ({ setEnabled }) => {
      setEnabled(true)
    },
    onRender: ({ doc, body }) => {
      renderSyncPanel({ doc, body, zotero, callbacks })
    },
  })
  if (registeredID === false) return null
  return typeof registeredID === "string" && registeredID.length > 0
    ? registeredID
    : defaultPaneHandle(context.pluginID, JADENSE_SYNC_PANEL_ID)
}

export function unregisterSyncPanel(zotero: ZoteroLike, paneID: string | null, _pluginID = "") {
  if (!paneID) return
  try {
    zotero.ItemPaneManager?.unregisterSection?.(paneID)
  } catch {
    // Continue unregistering fallback handles.
  }
}
