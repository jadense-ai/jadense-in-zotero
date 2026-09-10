import {
  clearConnection,
  favoriteFolderOptionLabel,
  readCollectionUploadIncludePdfDefault,
  readConnection,
  refreshFavoriteFoldersCache,
  saveConnection,
  saveCollectionUploadIncludePdfDefault,
  saveDefaultFolderId,
  type ZoteroLike,
} from "./runtime"

type DialogWindow = Window & typeof globalThis

const HTML_NS = "http://www.w3.org/1999/xhtml"
const DIALOG_NAME = "jadense-in-zotero-settings"

function html<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
  options: { className?: string; text?: string; type?: string } = {},
) {
  const node = doc.createElementNS(HTML_NS, tagName) as HTMLElementTagNameMap[K]
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  if (options.type && "type" in node) {
    node.setAttribute("type", options.type)
  }
  return node
}

function labeledField(doc: Document, label: string, input: HTMLElement) {
  const wrapper = html(doc, "label", { className: "jdx-field" })
  const caption = html(doc, "span", { text: label })
  wrapper.append(caption, input)
  return wrapper
}

function createInput(doc: Document, value: string, options: { type?: string; placeholder?: string } = {}) {
  const input = html(doc, "input", { type: options.type ?? "text" })
  input.value = value
  if (options.placeholder) input.placeholder = options.placeholder
  return input
}

function setStatus(target: HTMLElement, message: string, kind: "idle" | "error" | "success" = "idle") {
  target.textContent = message
  target.dataset.kind = kind
}

function ensureBody(doc: Document) {
  if (doc.body) return doc.body
  const body = html(doc, "body")
  doc.documentElement.appendChild(body)
  return body
}

function resetDocument(doc: Document) {
  doc.title = "Jadense in Zotero"
  const style = html(doc, "style")
  style.textContent = `
    :root {
      color-scheme: light;
      font: calc(13px * var(--jdx-font-scale,1)) system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #17211b;
      background: #f7f9f8;
    }
    body {
      margin: 0;
      background: #f7f9f8;
    }
    .jdx-root {
      box-sizing: border-box;
      width: 100%;
      min-height: 100vh;
      padding: 24px;
    }
    .jdx-panel {
      display: grid;
      gap: 16px;
      max-width: 560px;
      margin: 0 auto;
    }
    h1 {
      margin: 0;
      font-size: calc(20px * var(--jdx-font-scale,1));
      font-weight: 650;
      letter-spacing: 0;
    }
    .jdx-field {
      display: grid;
      gap: 6px;
      font-weight: 600;
    }
    input,
    select {
      box-sizing: border-box;
      width: 100%;
      min-height: 34px;
      border: 1px solid #cfd9d4;
      border-radius: 6px;
      padding: 6px 9px;
      color: #17211b;
      background: #fff;
      font: inherit;
      font-weight: 400;
    }
    .jdx-folder-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: end;
    }
    .jdx-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      padding-top: 4px;
    }
    button {
      min-height: 34px;
      border: 1px solid #cfd9d4;
      border-radius: 6px;
      padding: 6px 12px;
      color: #17211b;
      background: #fff;
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      border-color: #96aaa0;
      background: #f1f6f3;
    }
    button:disabled {
      cursor: default;
      opacity: 0.65;
    }
    .jdx-primary {
      border-color: #16d78f;
      background: #16d78f;
      color: #07351f;
      font-weight: 650;
    }
    .jdx-danger {
      color: #8f1f1f;
    }
    .jdx-status {
      min-height: 18px;
      color: #53625a;
    }
    .jdx-status[data-kind="error"] {
      color: #b42318;
    }
    .jdx-status[data-kind="success"] {
      color: #117a52;
    }
    .jdx-note {
      margin: 0;
      color: #53625a;
      line-height: 1.45;
    }
    .jdx-checkbox {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      font-weight: 600;
    }
    .jdx-checkbox input {
      width: auto;
      min-height: 0;
      margin-top: 3px;
    }
  `

  if (doc.head) {
    doc.head.replaceChildren(style)
  } else {
    doc.documentElement.prepend(style)
  }

  const body = ensureBody(doc)
  body.replaceChildren()
  return body
}

function folderOptionLabel(folder: { name: string; isDefault: boolean; itemCount: number }) {
  return favoriteFolderOptionLabel(folder)
}

function renderFolderOptions(
  doc: Document,
  select: HTMLSelectElement,
  folders: Array<{ id: string; name: string; isDefault: boolean; itemCount: number }>,
  selectedFolderId: string,
) {
  select.replaceChildren()
  select.append(html(doc, "option", { text: "Select a Jadense folder" }))
  select.options[0]!.value = ""

  for (const folder of folders) {
    const option = html(doc, "option", { text: folderOptionLabel(folder) })
    option.value = folder.id
    select.append(option)
  }
  select.value = folders.some((folder) => folder.id === selectedFolderId) ? selectedFolderId : ""
}

function openDialogWindow(win: DialogWindow) {
  const opened = win.open("", DIALOG_NAME, "popup,width=600,height=620,resizable,centerscreen")
  if (!opened?.document) return null
  opened.focus()
  return opened as DialogWindow
}

export function openConnectionSettings(zotero: ZoteroLike, win: DialogWindow) {
  const dialog = openDialogWindow(win)
  if (!dialog) return false

  const doc = dialog.document
  const current = readConnection(zotero)
  const includePdfDefault = readCollectionUploadIncludePdfDefault(zotero)
  const body = resetDocument(doc)
  const root = html(doc, "main", { className: "jdx-root" })
  const panel = html(doc, "section", { className: "jdx-panel" })
  const title = html(doc, "h1", { text: "Jadense in Zotero" })
  const rangeNote = html(doc, "p", {
    className: "jdx-note",
    text: "Collection upload uses the selected Zotero collection and child collections by default.",
  })
  const scopeNote = html(doc, "p", {
    className: "jdx-note",
    text: "PDF upload requires a Zotero token with favorites:write. Older tokens continue to work for metadata-only uploads.",
  })
  const helpNote = html(doc, "p", {
    className: "jdx-note",
    text: "To find your token: open the Jadense app, go to Settings → Integrations → Connect Jadense in Zotero, generate a token, and copy it right away — it is shown only once.",
  })
  const tokenInput = createInput(doc, "", {
    type: "password",
    placeholder: current.token ? "Stored token will be kept unless replaced" : "Paste Zotero plugin token",
  })
  const includePdfInput = createInput(doc, "", { type: "checkbox" }) as HTMLInputElement
  includePdfInput.checked = includePdfDefault
  const folderSelect = html(doc, "select")
  const loadFoldersButton = html(doc, "button", { text: "Reload folders", type: "button" })
  const saveButton = html(doc, "button", { className: "jdx-primary", text: "Save", type: "button" })
  const disconnectButton = html(doc, "button", { className: "jdx-danger", text: "Disconnect", type: "button" })
  const closeButton = html(doc, "button", { text: "Close", type: "button" })
  const status = html(doc, "div", { className: "jdx-status" })
  status.setAttribute("role", "status")

  renderFolderOptions(doc, folderSelect, [], current.defaultFolderId)
  folderSelect.addEventListener("change", () => {
    // 选中即保存;刷新缓存时也会自动落盘解析后的选中项。
    if (folderSelect.value) saveDefaultFolderId(zotero, folderSelect.value)
  })

  async function loadFolders() {
    loadFoldersButton.disabled = true
    setStatus(status, "Loading favorite folders...")
    const result = await refreshFavoriteFoldersCache(zotero, dialog!.fetch.bind(dialog))
    if (result.ok) {
      renderFolderOptions(doc, folderSelect, result.folders, result.selectedFolderId)
      setStatus(status, `Loaded ${result.folders.length} favorite folders.`, "success")
    } else if (result.reason === "no-token") {
      setStatus(status, "Paste a token and save it before loading favorite folders.", "error")
    } else {
      setStatus(status, result.message, "error")
    }
    loadFoldersButton.disabled = false
  }

  // 打开弹窗即自动加载,不再要求用户手动触发。
  if (current.token) void loadFolders()

  loadFoldersButton.addEventListener("click", () => {
    void loadFolders()
  })

  saveButton.addEventListener("click", () => {
    try {
      const token = tokenInput.value.trim()
      const latest = readConnection(zotero)
      if (token) {
        saveConnection(zotero, { token })
        tokenInput.value = ""
        tokenInput.placeholder = "Stored token will be kept unless replaced"
      } else if (!latest.token) {
        throw new Error("Jadense plugin token is required.")
      }
      saveCollectionUploadIncludePdfDefault(zotero, includePdfInput.checked)
      setStatus(status, "Connection saved.", "success")
      // 新令牌保存后立即拉取收藏夹,顺带完成连接验证。
      if (token) void loadFolders()
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : "Could not save connection.", "error")
    }
  })

  disconnectButton.addEventListener("click", () => {
    clearConnection(zotero)
    tokenInput.value = ""
    includePdfInput.checked = false
    tokenInput.placeholder = "Paste Zotero plugin token"
    renderFolderOptions(doc, folderSelect, [], "")
    setStatus(status, "Token removed from this Zotero profile.", "success")
  })

  closeButton.addEventListener("click", () => dialog.close())

  const folderRow = html(doc, "div", { className: "jdx-folder-row" })
  folderRow.append(labeledField(doc, "Default Jadense favorite folder", folderSelect), loadFoldersButton)
  const pdfCheckbox = html(doc, "label", { className: "jdx-checkbox" })
  pdfCheckbox.append(
    includePdfInput,
    html(doc, "span", { text: "Upload readable PDF attachments by default for collection uploads" }),
  )

  const actions = html(doc, "div", { className: "jdx-actions" })
  actions.append(disconnectButton, closeButton, saveButton)

  panel.append(
    title,
    rangeNote,
    scopeNote,
    helpNote,
    labeledField(doc, "Plugin token", tokenInput),
    folderRow,
    pdfCheckbox,
    status,
    actions,
  )
  root.append(panel)
  body.append(root)
  return true
}
