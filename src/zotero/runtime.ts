import { JadenseApiClient, type JadenseFavoriteFolder, type JadenseZoteroImportResult } from "@/jadense/api"
import {
  jadenseFavoriteToZoteroDraft,
  zoteroItemToJadenseImportItem,
  type JadenseFavoriteExportItem,
  type JadenseZoteroImportItem,
} from "@/sync/metadata"
import type { ZoteroItemDraft, ZoteroItemSnapshot, ZoteroPdfAttachmentFile } from "./types"

const PREF_BASE_URL = "extensions.jadenseInZotero.baseUrl"
const PREF_TOKEN = "extensions.jadenseInZotero.token"
const PREF_DEFAULT_FOLDER_ID = "extensions.jadenseInZotero.defaultFolderId"
const PREF_SYNC_MAPPINGS = "extensions.jadenseInZotero.syncMappings"
const PREF_COLLECTION_UPLOAD_INCLUDE_PDF = "extensions.jadenseInZotero.collectionUploadIncludePdf"
const PREF_FAVORITE_FOLDERS_CACHE = "extensions.jadenseInZotero.favoriteFoldersCache"
const SYNC_MAPPING_VERSION = 2
export const DEFAULT_BASE_URL = "https://jadense.cn"
const ZOTERO_IMPORT_BATCH_SIZE = 100

export type JadenseConnection = {
  baseUrl: string
  token: string
  defaultFolderId: string
}

export type FavoriteFolderOption = {
  id: string
  name: string
  isDefault: boolean
  itemCount: number
}

export type FavoriteFoldersCache = {
  fetchedAt: string
  defaultFolderId: string | null
  folders: FavoriteFolderOption[]
}

export type FavoriteFoldersRefreshResult = {
  ok: boolean
  reason: "ok" | "no-token" | "request-failed"
  folders: FavoriteFolderOption[]
  selectedFolderId: string
  fetchedAt: string
  message: string
}

type ZoteroItemRef = {
  libraryKey: string
  itemKey: string
  itemID: string | number | null
  libraryID: string | number | null
}

type ZoteroCollectionRef = {
  name: string
  collectionID: string | number | null
  key: string | null
  libraryID: string | number | null
}

type SyncMappingRecord = {
  jadenseKey: string
  identityKeys: string[]
  zoteroItem: ZoteroItemRef
  updatedAt: string
}

type SyncFolderMappingRecord = {
  folderId: string
  folderName: string
  zoteroCollection: ZoteroCollectionRef
  updatedAt: string
}

type SyncPushMappingRecord = {
  zoteroKey: string
  clientItemId: string
  folderId: string
  collectionPaths: string[]
  metadataStatus: "imported" | "skipped" | "failed"
  pdfStatus: "uploaded" | "skipped" | "failed" | "not_requested"
  result?: unknown
  error?: string | null
  updatedAt: string
}

type SyncMappingState = {
  version: 2
  items: Record<string, SyncMappingRecord>
  folders: Record<string, SyncFolderMappingRecord>
  pushes: Record<string, SyncPushMappingRecord>
}

export type ZoteroLike = {
  locale?: string
  Prefs?: {
    // Zotero.Prefs.get/set 的第二个参数 global=true 表示键是完整 pref 路径；
    // 缺省时 Zotero 会把键解析到 extensions.zotero. 分支下。
    get(key: string, global?: boolean): unknown
    set(key: string, value: unknown, global?: boolean): void
    clear(key: string, global?: boolean): void
    registerObserver?(key: string, handler: () => void, global?: boolean): unknown
    unregisterObserver?(observerID: unknown): void
  }
  Items?: {
    get?(itemID: string | number): unknown | Promise<unknown>
    getByLibraryAndKey?(libraryID: string | number, key: string): unknown | Promise<unknown>
    getAll?(libraryID?: string | number, ...args: unknown[]): unknown[] | Promise<unknown[]>
  }
  Collections?: {
    get?(collectionID: string | number): unknown | Promise<unknown>
    getByLibrary?(libraryID?: string | number, ...args: unknown[]): unknown[] | Promise<unknown[]>
  }
  Libraries?: {
    userLibraryID?: string | number
  }
  getMainWindow?: () => (Window & typeof globalThis) | null
  getMainWindows?: () => Array<Window & typeof globalThis>
  getActiveZoteroPane?: () => {
    getSelectedItems?: () => unknown[]
    getSelectedCollection?: () => unknown
    getSelectedCollections?: () => unknown[]
  }
  Item?: new (itemType: string) => {
    libraryID?: string | number
    setField(field: string, value: string): void
    setCreators(creators: unknown[]): void
    setTags(tags: unknown[]): void
    saveTx(): Promise<unknown>
  }
  Collection?: new () => {
    id?: string | number
    key?: string
    libraryID?: string | number
    name?: string
    addItem?(itemID: string | number): unknown | Promise<unknown>
    addItems?(itemIDs: Array<string | number>): unknown | Promise<unknown>
    saveTx(): Promise<unknown>
  }
  PreferencePanes?: {
    register(options: {
      pluginID: string
      src: string
      id?: string
      label?: string
      image?: string
      scripts?: string[]
      stylesheets?: string[]
    }): string | Promise<string>
    unregister(id: string): void
  }
  ItemPaneManager?: {
    registerSection(options: {
      paneID: string
      pluginID: string
      header: { l10nID: string; icon: string }
      sidenav: { l10nID: string; icon: string }
      onItemChange?: (props: { setEnabled: (enabled: boolean) => void }) => void
      onRender: (props: { doc: Document; body: HTMLDivElement }) => void
    }): string | boolean | void
    unregisterSection(id: string): boolean
  }
  MenuManager?: {
    registerMenu(options: ZoteroMenuRegistration): string | boolean | void
    unregisterMenu(id: string): boolean
  }
  Utilities?: {
    Internal?: {
      openPreferences?: (...args: unknown[]) => unknown
    }
  }
}

export type ZoteroMenuItem = {
  menuType: "menuitem" | "separator" | "submenu"
  l10nID?: string
  onShowing?: (event: Event, context: ZoteroMenuContext) => void
  onCommand?: (event: Event, context: ZoteroMenuContext) => void
  menus?: ZoteroMenuItem[]
}

export type ZoteroMenuContext = {
  setEnabled?: (enabled: boolean) => void
  setVisible?: (visible: boolean) => void
}

export type ZoteroMenuRegistration = {
  menuID: string
  pluginID: string
  target: string
  menus: ZoteroMenuItem[]
}

type CollectionItemEntry = {
  item: unknown
  snapshot: ZoteroItemSnapshot
  itemRef: ZoteroItemRef
  collectionPaths: string[]
}

type CollectionSkippedEntry = {
  clientItemId: string | null
  itemKey: string
  title: string
  collectionPaths: string[]
  reason: "missing_title" | "missing_item_key"
}

type ZoteroUploadPdfStatus =
  | { status: "uploaded"; result: unknown }
  | { status: "not_requested"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }

type ZoteroCollectionUploadItemResult = {
  clientItemId: string
  title: string
  itemKey: string
  collectionPaths: string[]
  metadataStatus: "imported" | "skipped" | "failed"
  metadataError?: string
  pdf: ZoteroUploadPdfStatus
}

export type ZoteroCollectionUploadPreview = {
  collectionName: string
  totalCount: number
  skippedCount: number
}

function prefString(zotero: ZoteroLike, key: string) {
  const value = zotero.Prefs?.get(key)
  return typeof value === "string" ? value.trim() : ""
}

function prefBoolean(zotero: ZoteroLike, key: string) {
  const value = zotero.Prefs?.get(key)
  return value === true || value === "true"
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/g, "")
}

function migrateBaseUrl(value: string) {
  const normalized = normalizeBaseUrl(value)
  // 正式连接使用内置主域；只保留显式的本机开发和国内预发覆盖，旧生产设置自然回到主域。
  if (!normalized || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(normalized)
    || normalized.toLowerCase() === "https://staging.jadense.cn") return normalized
  return DEFAULT_BASE_URL
}

function emptySyncMappings(): SyncMappingState {
  return { version: SYNC_MAPPING_VERSION, items: {}, folders: {}, pushes: {} }
}

function readSyncMappings(zotero: ZoteroLike): SyncMappingState {
  const rawValue = prefString(zotero, PREF_SYNC_MAPPINGS)
  if (!rawValue) return emptySyncMappings()

  try {
    const parsed = JSON.parse(rawValue) as Partial<SyncMappingState> & { version?: number }
    if (!parsed.items || typeof parsed.items !== "object") {
      return emptySyncMappings()
    }
    return {
      version: SYNC_MAPPING_VERSION,
      items: parsed.items,
      folders: parsed.folders && typeof parsed.folders === "object" ? parsed.folders : {},
      pushes: parsed.pushes && typeof parsed.pushes === "object" ? parsed.pushes : {},
    }
  } catch {
    return emptySyncMappings()
  }
}

function saveSyncMappings(zotero: ZoteroLike, state: SyncMappingState) {
  zotero.Prefs?.set(PREF_SYNC_MAPPINGS, JSON.stringify(state))
}

function nonEmptyText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeDoi(value: unknown) {
  return nonEmptyText(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() || null
}

function normalizeIdentitySegment(value: unknown) {
  return nonEmptyText(value).toLowerCase()
}

function doiIdentityKey(value: unknown) {
  const doi = normalizeDoi(value)
  return doi ? `doi:${doi}` : null
}

function sourceIdentityKey(source: unknown, id: unknown) {
  const normalizedSource = normalizeIdentitySegment(source)
  const normalizedId = normalizeIdentitySegment(id)
  return normalizedSource && normalizedId ? `source:${normalizedSource}/${normalizedId}` : null
}

function assertClient(zotero: ZoteroLike) {
  const { baseUrl, token } = readConnection(zotero)
  if (!token) throw new Error("未配置攻玉令牌，请先在「连接攻玉」中完成连接。")
  const win = zotero.getMainWindow?.()
  const fetchImpl = win?.fetch ? win.fetch.bind(win) : undefined
  const formDataFactory = win?.FormData ? () => new win.FormData() : undefined
  return new JadenseApiClient({ baseUrl, token, fetchImpl, formDataFactory })
}

function readField(item: Record<string, unknown>, name: string) {
  const getField = item.getField
  if (typeof getField !== "function") return null
  const value = getField.call(item, name)
  return typeof value === "string" ? value : null
}

function readCreators(item: Record<string, unknown>) {
  const getCreators = item.getCreators
  if (typeof getCreators !== "function") return []
  const value = getCreators.call(item)
  return Array.isArray(value) ? value : []
}

function readTags(item: Record<string, unknown>) {
  const getTags = item.getTags
  if (typeof getTags !== "function") return []
  const value = getTags.call(item)
  return Array.isArray(value) ? value : []
}

function readBooleanPredicate(record: Record<string, unknown>, name: string) {
  const value = record[name]
  if (typeof value === "function") return Boolean(value.call(record))
  return typeof value === "boolean" ? value : null
}

function snapshotItem(item: unknown, collectionPaths: string[] = []): ZoteroItemSnapshot | null {
  if (!item || typeof item !== "object") return null
  const record = item as Record<string, unknown>
  if (
    readBooleanPredicate(record, "isRegularItem") === false ||
    readBooleanPredicate(record, "isNote") === true ||
    readBooleanPredicate(record, "isAttachment") === true ||
    record.deleted === true
  ) return null

  const libraryKey = typeof record.libraryKey === "string" ? record.libraryKey : String(record.libraryID ?? "local")
  const itemKey = typeof record.key === "string" ? record.key : ""
  const title = readField(record, "title")?.trim() ?? ""
  if (!itemKey || !title) return null

  return {
    libraryKey,
    itemKey,
    itemType: typeof record.itemType === "string" ? record.itemType : "journalArticle",
    title,
    creators: readCreators(record),
    date: readField(record, "date"),
    publicationTitle: readField(record, "publicationTitle"),
    doi: readField(record, "DOI"),
    url: readField(record, "url"),
    abstractNote: readField(record, "abstractNote"),
    tags: readTags(record),
    extra: readField(record, "extra"),
    collectionPaths,
  }
}

function itemRefFromRawItem(item: unknown): ZoteroItemRef | null {
  if (!item || typeof item !== "object") return null
  const record = item as Record<string, unknown>
  const libraryKey = typeof record.libraryKey === "string" ? record.libraryKey : String(record.libraryID ?? "local")
  const itemKey = typeof record.key === "string" ? record.key : ""
  if (!itemKey) return null
  const libraryID = typeof record.libraryID === "string" || typeof record.libraryID === "number" ? record.libraryID : null
  const itemID = typeof record.id === "string" || typeof record.id === "number" ? record.id : null
  return { libraryKey, itemKey, itemID, libraryID }
}

function collectionSkippedEntry(item: unknown, collectionPaths: string[]): CollectionSkippedEntry | null {
  if (!item || typeof item !== "object") return null
  const record = item as Record<string, unknown>
  if (
    readBooleanPredicate(record, "isRegularItem") === false ||
    readBooleanPredicate(record, "isNote") === true ||
    readBooleanPredicate(record, "isAttachment") === true ||
    record.deleted === true
  ) return null

  const ref = itemRefFromRawItem(item)
  const title = readField(record, "title")?.trim() ?? ""
  if (!ref?.itemKey) {
    return {
      clientItemId: null,
      itemKey: "",
      title: "Untitled Zotero item",
      collectionPaths,
      reason: "missing_item_key",
    }
  }
  if (!title) {
    return {
      clientItemId: `zotero:${ref.libraryKey}/${ref.itemKey}`,
      itemKey: ref.itemKey,
      title: "Untitled Zotero item",
      collectionPaths,
      reason: "missing_title",
    }
  }
  return null
}

function collectionRefFromRawCollection(collection: unknown): ZoteroCollectionRef | null {
  if (!collection || typeof collection !== "object") return null
  const record = collection as Record<string, unknown>
  const name = nonEmptyText(record.name)
  if (!name) return null
  const collectionID =
    typeof record.id === "string" || typeof record.id === "number"
      ? record.id
      : typeof record.collectionID === "string" || typeof record.collectionID === "number"
        ? record.collectionID
        : null
  const key = typeof record.key === "string" && record.key.trim() ? record.key.trim() : null
  const libraryID = typeof record.libraryID === "string" || typeof record.libraryID === "number" ? record.libraryID : null
  return { name, collectionID, key, libraryID }
}

function selectedEntries(zotero: ZoteroLike): CollectionItemEntry[] {
  const pane = zotero.getActiveZoteroPane?.()
  const selected = pane?.getSelectedItems?.() ?? []
  return selected.flatMap((item) => {
    const snapshot = snapshotItem(item)
    const itemRef = itemRefFromRawItem(item)
    return snapshot && itemRef ? [{ item, snapshot, itemRef, collectionPaths: [] }] : []
  })
}

function callMaybeArray<T = unknown>(target: unknown, thisArg: unknown, ...args: unknown[]): T[] {
  if (typeof target !== "function") return []
  const value = target.call(thisArg, ...args)
  return Array.isArray(value) ? value as T[] : []
}

async function awaitMaybeArray<T = unknown>(target: unknown, thisArg: unknown, ...args: unknown[]): Promise<T[]> {
  if (typeof target !== "function") return []
  const value = await target.call(thisArg, ...args)
  return Array.isArray(value) ? value as T[] : []
}

function collectionName(collection: unknown) {
  if (!collection || typeof collection !== "object") return "Selected Collection"
  const record = collection as Record<string, unknown>
  return nonEmptyText(record.name) || nonEmptyText(record.getName) || "Selected Collection"
}

/** Zotero 10 使用多选 getter；旧版回退单选 getter，且隔离已废弃 API 可能抛出的异常。 */
export function selectedZoteroCollections(zotero: ZoteroLike) {
  const pane = zotero.getActiveZoteroPane?.()
  try {
    const selected = pane?.getSelectedCollections?.()
    if (Array.isArray(selected)) return selected
  } catch {
    // 继续尝试 Zotero 8/9 单选 API。
  }
  try {
    const selected = pane?.getSelectedCollection?.()
    return selected ? [selected] : []
  } catch {
    return []
  }
}

async function resolveCollectionById(zotero: ZoteroLike, value: unknown) {
  if (value && typeof value === "object") return value
  if ((typeof value !== "string" && typeof value !== "number") || !zotero.Collections?.get) return null
  try {
    return await zotero.Collections.get.call(zotero.Collections, value)
  } catch {
    return null
  }
}

async function resolveItemById(zotero: ZoteroLike, value: unknown) {
  if (value && typeof value === "object") return value
  if ((typeof value !== "string" && typeof value !== "number") || !zotero.Items?.get) return null
  try {
    return await zotero.Items.get.call(zotero.Items, value)
  } catch {
    return null
  }
}

async function collectionChildItems(zotero: ZoteroLike, collection: unknown) {
  if (!collection || typeof collection !== "object") return []
  const record = collection as Record<string, unknown>
  const rawItems = await awaitMaybeArray(record.getChildItems, collection)
  const rawItemIDs = rawItems.length > 0 ? rawItems : callMaybeArray(record.items, collection)
  const resolved = await Promise.all(rawItemIDs.map((item) => resolveItemById(zotero, item)))
  return resolved.filter(Boolean)
}

async function collectionChildCollections(zotero: ZoteroLike, collection: unknown) {
  if (!collection || typeof collection !== "object") return []
  const record = collection as Record<string, unknown>
  const rawCollections = await awaitMaybeArray(record.getChildCollections, collection)
  const rawCollectionIDs = rawCollections.length > 0 ? rawCollections : callMaybeArray(record.collections, collection)
  const resolved = await Promise.all(rawCollectionIDs.map((item) => resolveCollectionById(zotero, item)))
  return resolved.filter(Boolean)
}

function collectionEntryKey(ref: ZoteroItemRef) {
  return `${String(ref.libraryID ?? ref.libraryKey)}:${ref.itemKey}`
}

async function collectSelectedCollectionItems(zotero: ZoteroLike): Promise<{
  collectionName: string
  entries: CollectionItemEntry[]
  skipped: CollectionSkippedEntry[]
}> {
  const collections = selectedZoteroCollections(zotero)
  if (collections.length === 0) throw new Error("请先在 Zotero 中选中分类再上传。")

  const entriesByKey = new Map<string, CollectionItemEntry>()
  const skippedByKey = new Map<string, CollectionSkippedEntry>()
  const walk = async (current: unknown, path: string[]) => {
    const name = collectionName(current)
    const nextPath = [...path, name]
    const items = await collectionChildItems(zotero, current)
    for (const item of items) {
      const collectionPath = nextPath.join(" / ")
      const snapshot = snapshotItem(item, [collectionPath])
      const itemRef = itemRefFromRawItem(item)
      if (!snapshot || !itemRef) {
        const skipped = collectionSkippedEntry(item, [collectionPath])
        if (!skipped) continue
        const key = skipped.clientItemId ?? `${skipped.reason}:${skippedByKey.size}`
        const existing = skippedByKey.get(key)
        if (existing) {
          existing.collectionPaths = Array.from(new Set([...existing.collectionPaths, ...skipped.collectionPaths]))
        } else {
          skippedByKey.set(key, skipped)
        }
        continue
      }

      const key = collectionEntryKey(itemRef)
      const existing = entriesByKey.get(key)
      if (existing) {
        existing.collectionPaths = Array.from(new Set([...existing.collectionPaths, ...(snapshot.collectionPaths ?? [])]))
        existing.snapshot.collectionPaths = existing.collectionPaths
      } else {
        entriesByKey.set(key, {
          item,
          snapshot,
          itemRef,
          collectionPaths: snapshot.collectionPaths ?? [],
        })
      }
    }

    const childCollections = await collectionChildCollections(zotero, current)
    for (const child of childCollections) {
      await walk(child, nextPath)
    }
  }

  for (const collection of collections) await walk(collection, [])
  return {
    collectionName: collections.length === 1 ? collectionName(collections[0]) : `${collections.length} 个分类`,
    entries: Array.from(entriesByKey.values()),
    skipped: Array.from(skippedByKey.values()),
  }
}

function filenameFromPath(value: string) {
  return value.split(/[\\/]/g).filter(Boolean).pop() || "zotero-attachment.pdf"
}

function attachmentFilename(attachment: Record<string, unknown>, filePath?: string | null) {
  const title = readField(attachment, "title") ?? nonEmptyText(attachment.title)
  if (title.toLowerCase().endsWith(".pdf")) return title
  if (filePath) return filenameFromPath(filePath)
  return title ? `${title}.pdf` : "zotero-attachment.pdf"
}

function attachmentContentType(attachment: Record<string, unknown>) {
  return (
    readField(attachment, "contentType") ??
    nonEmptyText(attachment.contentType) ??
    nonEmptyText(attachment.attachmentContentType)
  ).toLowerCase()
}

async function attachmentFilePath(attachment: Record<string, unknown>) {
  if (typeof attachment.getFilePathAsync === "function") {
    const value = await attachment.getFilePathAsync.call(attachment)
    return typeof value === "string" && value.trim() ? value.trim() : null
  }
  if (typeof attachment.getFilePath === "function") {
    const value = attachment.getFilePath.call(attachment)
    return typeof value === "string" && value.trim() ? value.trim() : null
  }
  return nonEmptyText(attachment.filePath) || nonEmptyText(attachment.path) || null
}

async function readFilePathAsBlob(filePath: string): Promise<Blob | null> {
  const ioUtils = (globalThis as typeof globalThis & {
    IOUtils?: { read?: (path: string) => Promise<Uint8Array> }
  }).IOUtils
  if (!ioUtils?.read) return null
  const bytes = await ioUtils.read(filePath)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([buffer], { type: "application/pdf" })
}

function blobFromAttachmentRecord(attachment: Record<string, unknown>) {
  const file = attachment.file
  if (typeof Blob !== "undefined" && file instanceof Blob) return file
  if (file && typeof file === "object" && typeof (file as Blob).arrayBuffer === "function") {
    return file as Blob
  }
  return null
}

async function buildPdfAttachmentFile(attachment: unknown): Promise<ZoteroPdfAttachmentFile | null> {
  if (!attachment || typeof attachment !== "object") return null
  const record = attachment as Record<string, unknown>
  if (readBooleanPredicate(record, "isAttachment") === false) return null

  const filePath = await attachmentFilePath(record)
  const filename = attachmentFilename(record, filePath)
  const contentType = attachmentContentType(record)
  if (contentType && !contentType.includes("pdf") && !filename.toLowerCase().endsWith(".pdf")) return null

  try {
    const blob = blobFromAttachmentRecord(record) ?? (filePath ? await readFilePathAsBlob(filePath) : null)
    return blob ? { file: blob, filename } : null
  } catch {
    return null
  }
}

async function findFirstPdfAttachment(zotero: ZoteroLike, item: unknown): Promise<ZoteroPdfAttachmentFile | null> {
  if (!item || typeof item !== "object") return null
  const record = item as Record<string, unknown>
  const attachmentRefs = await awaitMaybeArray(record.getAttachments, item)
  for (const ref of attachmentRefs) {
    const attachment = await resolveItemById(zotero, ref)
    const file = await buildPdfAttachmentFile(attachment)
    if (file) return file
  }
  return null
}

async function createZoteroItem(zotero: ZoteroLike, draft: ZoteroItemDraft): Promise<ZoteroItemRef> {
  if (!zotero.Item) throw new Error("Zotero.Item API is unavailable.")
  const item = new zotero.Item(draft.itemType)
  if (zotero.Libraries?.userLibraryID !== undefined) {
    item.libraryID = zotero.Libraries.userLibraryID
  }
  item.setField("title", draft.title)
  if (draft.date) item.setField("date", draft.date)
  if (draft.publicationTitle) item.setField("publicationTitle", draft.publicationTitle)
  if (draft.doi) item.setField("DOI", draft.doi)
  if (draft.url) item.setField("url", draft.url)
  if (draft.abstractNote) item.setField("abstractNote", draft.abstractNote)
  if (draft.extra) item.setField("extra", draft.extra)
  item.setCreators(draft.creators)
  item.setTags(draft.tags)
  await item.saveTx()
  const itemRef = itemRefFromRawItem(item)
  if (!itemRef) throw new Error("Created Zotero item could not be resolved.")
  return itemRef
}

async function resolveMappedItem(zotero: ZoteroLike, ref: ZoteroItemRef) {
  const getByLibraryAndKey = zotero.Items?.getByLibraryAndKey
  if (!getByLibraryAndKey) return null

  const libraryCandidates = [ref.libraryID, ref.libraryKey].filter(
    (value): value is string | number => typeof value === "string" || typeof value === "number",
  )
  for (const libraryID of libraryCandidates) {
    try {
      const item = await getByLibraryAndKey.call(zotero.Items, libraryID, ref.itemKey)
      if (snapshotItem(item)) return item
    } catch {
      // Try the next library identifier shape; Zotero versions differ here.
    }
  }
  return null
}

async function listKnownZoteroItems(zotero: ZoteroLike) {
  const getAll = zotero.Items?.getAll
  if (!getAll) return []

  const attempts: Array<[string | number] | []> =
    zotero.Libraries?.userLibraryID !== undefined ? [[zotero.Libraries.userLibraryID], []] : [[]]

  for (const args of attempts) {
    try {
      const items = await getAll.call(zotero.Items, ...args)
      if (Array.isArray(items)) return items
    } catch {
      // Fall through to the next supported Zotero item listing shape.
    }
  }
  return []
}

async function listKnownZoteroCollections(zotero: ZoteroLike) {
  const getByLibrary = zotero.Collections?.getByLibrary
  if (!getByLibrary) return []

  const attempts: Array<[string | number] | []> =
    zotero.Libraries?.userLibraryID !== undefined ? [[zotero.Libraries.userLibraryID], []] : [[]]

  for (const args of attempts) {
    try {
      const collections = await getByLibrary.call(zotero.Collections, ...args)
      if (Array.isArray(collections)) return collections
    } catch {
      // Fall through to the next supported Zotero collection listing shape.
    }
  }
  return []
}

async function resolveCollection(zotero: ZoteroLike, ref: ZoteroCollectionRef) {
  if (ref.collectionID !== null && zotero.Collections?.get) {
    try {
      const collection = await zotero.Collections.get.call(zotero.Collections, ref.collectionID)
      if (collectionRefFromRawCollection(collection)) return collection
    } catch {
      // Fall back to name-based lookup below.
    }
  }

  const collections = await listKnownZoteroCollections(zotero)
  return collections.find((collection) => collectionRefFromRawCollection(collection)?.name === ref.name) ?? null
}

async function createZoteroCollection(zotero: ZoteroLike, name: string): Promise<ZoteroCollectionRef | null> {
  if (!zotero.Collection) return null
  const collection = new zotero.Collection()
  if (zotero.Libraries?.userLibraryID !== undefined) {
    collection.libraryID = zotero.Libraries.userLibraryID
  }
  collection.name = name
  await collection.saveTx()
  return collectionRefFromRawCollection(collection)
}

function favoriteCollectionName(folderName: string) {
  return `Jadense - ${folderName}`
}

async function ensureFavoriteFolderCollection(
  zotero: ZoteroLike,
  state: SyncMappingState,
  input: { folderId: string; folderName: string },
) {
  const mapped = state.folders[input.folderId]
  if (mapped) {
    const existing = await resolveCollection(zotero, mapped.zoteroCollection)
    if (existing) return mapped.zoteroCollection
  }

  const collectionName = favoriteCollectionName(input.folderName)
  const collections = await listKnownZoteroCollections(zotero)
  const existingRef = collections
    .map((collection) => collectionRefFromRawCollection(collection))
    .find((collection): collection is ZoteroCollectionRef => Boolean(collection && collection.name === collectionName))
  const zoteroCollection = existingRef ?? await createZoteroCollection(zotero, collectionName)
  if (!zoteroCollection) return null

  state.folders[input.folderId] = {
    folderId: input.folderId,
    folderName: input.folderName,
    zoteroCollection,
    updatedAt: new Date().toISOString(),
  }
  return zoteroCollection
}

async function addItemToCollection(
  zotero: ZoteroLike,
  collectionRef: ZoteroCollectionRef | null,
  itemRef: ZoteroItemRef | null,
) {
  if (!collectionRef || !itemRef) return false
  const collection = await resolveCollection(zotero, collectionRef)
  if (!collection || typeof collection !== "object") return false

  const record = collection as {
    addItem?: (itemID: string | number) => unknown | Promise<unknown>
    addItems?: (itemIDs: Array<string | number>) => unknown | Promise<unknown>
  }
  const itemID = itemRef.itemID ?? itemRef.itemKey
  if (typeof record.addItem === "function") {
    await record.addItem.call(collection, itemID)
    return true
  }
  if (typeof record.addItems === "function") {
    await record.addItems.call(collection, [itemID])
    return true
  }
  return false
}

function jadenseStableKey(item: JadenseFavoriteExportItem) {
  return item.itemKind === "paper"
    ? `jadense:article:${item.articleId}`
    : `jadense:favorite-item:${item.favoriteItemId}`
}

function favoriteIdentityKeys(item: JadenseFavoriteExportItem, draft: ZoteroItemDraft) {
  const keys = new Set<string>([jadenseStableKey(item)])
  const doiKey = doiIdentityKey(draft.doi)
  if (doiKey) keys.add(doiKey)
  if (item.itemKind === "paper") {
    const sourceKey = sourceIdentityKey(item.paper.external_source, item.paper.external_id)
    if (sourceKey) keys.add(sourceKey)
  }
  return Array.from(keys)
}

function identityKeysFromSnapshot(snapshot: ZoteroItemSnapshot) {
  const keys = new Set<string>()
  const doiKey = doiIdentityKey(snapshot.doi)
  if (doiKey) keys.add(doiKey)

  for (const line of (snapshot.extra ?? "").split(/\r?\n/g)) {
    const articleMatch = /^Jadense article:\s*(.+)$/i.exec(line)
    if (articleMatch?.[1]) keys.add(`jadense:article:${articleMatch[1].trim()}`)

    const favoriteMatch = /^Jadense favorite item:\s*(.+)$/i.exec(line)
    if (favoriteMatch?.[1]) keys.add(`jadense:favorite-item:${favoriteMatch[1].trim()}`)

    const sourceMatch = /^Jadense source:\s*([^/]+)\/(.+)$/i.exec(line)
    const sourceKey = sourceMatch ? sourceIdentityKey(sourceMatch[1], sourceMatch[2]) : null
    if (sourceKey) keys.add(sourceKey)
  }

  return keys
}

async function findStrongIdentityMatch(zotero: ZoteroLike, wantedKeys: string[]) {
  const wanted = new Set(wantedKeys)
  const items = await listKnownZoteroItems(zotero)
  for (const item of items) {
    const snapshot = snapshotItem(item)
    const itemRef = itemRefFromRawItem(item)
    if (!snapshot || !itemRef) continue

    const existingKeys = identityKeysFromSnapshot(snapshot)
    for (const key of existingKeys) {
      if (wanted.has(key)) return itemRef
    }
  }
  return null
}

function saveMapping(
  state: SyncMappingState,
  jadenseKey: string,
  identityKeys: string[],
  zoteroItem: ZoteroItemRef,
) {
  state.items[jadenseKey] = {
    jadenseKey,
    identityKeys,
    zoteroItem,
    updatedAt: new Date().toISOString(),
  }
}

async function resolveFavoriteFolderName(client: JadenseApiClient, folderId: string) {
  try {
    const folders = await client.listFavoriteFolders()
    return folders.folders.find((folder) => folder.id === folderId)?.name?.trim() || folderId
  } catch {
    return folderId
  }
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected Jadense sync error"
}

async function importMetadataBatches(
  client: JadenseApiClient,
  folderId: string,
  items: JadenseZoteroImportItem[],
): Promise<JadenseZoteroImportResult> {
  const results: JadenseZoteroImportResult["results"] = []
  for (const chunk of chunkItems(items, ZOTERO_IMPORT_BATCH_SIZE)) {
    try {
      const result = await client.importZoteroItems([folderId], chunk)
      results.push(...result.results)
    } catch (error) {
      const message = errorMessage(error)
      results.push(...chunk.map((item) => ({
        clientItemId: item.clientItemId,
        status: "failed" as const,
        error: message,
      })))
    }
  }

  return {
    results,
    importedCount: results.filter((item) => item.status === "imported").length,
    skippedCount: results.filter((item) => item.status === "skipped").length,
    failedCount: results.filter((item) => item.status === "failed").length,
  }
}

function resultByClientItemId(results: JadenseZoteroImportResult["results"]) {
  return new Map(results.map((item) => [item.clientItemId, item]))
}

async function uploadPdfForEntry(input: {
  client: JadenseApiClient
  folderId: string
  zotero: ZoteroLike
  entry: CollectionItemEntry
  importItem: JadenseZoteroImportItem
  includePdf: boolean
}): Promise<ZoteroUploadPdfStatus> {
  if (!input.includePdf) return { status: "not_requested" as const, reason: "未请求上传 PDF。" }

  const attachment = await findFirstPdfAttachment(input.zotero, input.entry.item)
  if (!attachment) return { status: "skipped", reason: "未找到可读取的 PDF 附件。" }

  try {
    const result = await input.client.importFavoritePdf({
      folderIds: [input.folderId],
      item: input.importItem,
      file: attachment.file,
      filename: attachment.filename,
    })
    // 全部收藏夹都 skipped 说明条目已存在且已有文件;否则无论新建还是回填,PDF 都已落到条目上。
    const deliveredCount =
      (result.insertedFolderIds?.length ?? 0) + (result.backfilledFolderIds?.length ?? 0)
    if (deliveredCount === 0) {
      return { status: "skipped", reason: "攻玉中已存在该条目及其 PDF,本次未重复上传。" }
    }
    return { status: "uploaded", result }
  } catch (error) {
    const message = errorMessage(error)
    return {
      status: "failed",
      error: /insufficient_scope/i.test(message)
        ? "PDF 上传需要重新生成带 favorites:write 权限的攻玉插件令牌。"
        : message,
    }
  }
}

function savePushMapping(
  state: SyncMappingState,
  input: {
    folderId: string
    entry: CollectionItemEntry
    importItem: JadenseZoteroImportItem
    metadataResult: JadenseZoteroImportResult["results"][number]
    pdfStatus: ZoteroUploadPdfStatus
  },
) {
  const zoteroKey = collectionEntryKey(input.entry.itemRef)
  state.pushes[zoteroKey] = {
    zoteroKey,
    clientItemId: input.importItem.clientItemId,
    folderId: input.folderId,
    collectionPaths: input.entry.collectionPaths,
    metadataStatus: input.metadataResult.status,
    pdfStatus: input.pdfStatus.status,
    result: input.metadataResult.result,
    error: input.metadataResult.error ?? ("error" in input.pdfStatus ? input.pdfStatus.error : null),
    updatedAt: new Date().toISOString(),
  }
}

function summarizeCollectionUpload(items: ZoteroCollectionUploadItemResult[]) {
  return {
    importedCount: items.filter((item) => item.metadataStatus === "imported").length,
    skippedCount: items.filter((item) => item.metadataStatus === "skipped").length,
    failedCount: items.filter((item) => item.metadataStatus === "failed").length,
    pdfUploadedCount: items.filter((item) => item.pdf.status === "uploaded").length,
    pdfSkippedCount: items.filter((item) => item.pdf.status === "skipped" || item.pdf.status === "not_requested").length,
    pdfFailedCount: items.filter((item) => item.pdf.status === "failed").length,
  }
}

export function readConnection(zotero: ZoteroLike): JadenseConnection {
  const storedBaseUrl = prefString(zotero, PREF_BASE_URL)
  const baseUrl = storedBaseUrl ? migrateBaseUrl(storedBaseUrl) : DEFAULT_BASE_URL
  if (storedBaseUrl && baseUrl !== storedBaseUrl) {
    zotero.Prefs?.set(PREF_BASE_URL, baseUrl)
  }
  return {
    baseUrl,
    token: prefString(zotero, PREF_TOKEN),
    defaultFolderId: prefString(zotero, PREF_DEFAULT_FOLDER_ID),
  }
}

// 攻玉地址由插件固定(DEFAULT_BASE_URL),UI 不再提供编辑入口;
// 存量的 baseUrl pref 仍由 readConnection() 读取并迁移。baseUrl 入参仅保留给
// 测试/开发环境手动覆盖,UI 一律不传。
export function saveConnection(zotero: ZoteroLike, input: { token: string; defaultFolderId?: string | null; baseUrl?: string }) {
  if (!input.token.trim()) throw new Error("请填写攻玉插件令牌。")

  if (input.baseUrl !== undefined) {
    const baseUrl = migrateBaseUrl(input.baseUrl)
    if (!baseUrl) throw new Error("请填写攻玉 Webapp 地址。")
    zotero.Prefs?.set(PREF_BASE_URL, baseUrl)
  }
  zotero.Prefs?.set(PREF_TOKEN, input.token.trim())
  // defaultFolderId 缺省(undefined)表示不改动已有选择;显式传空(含 null)则清除。
  if (input.defaultFolderId === undefined) return
  const folderId = input.defaultFolderId?.trim() ?? ""
  if (folderId) {
    zotero.Prefs?.set(PREF_DEFAULT_FOLDER_ID, folderId)
  } else {
    zotero.Prefs?.clear(PREF_DEFAULT_FOLDER_ID)
  }
}

export function saveDefaultFolderId(zotero: ZoteroLike, folderId: string) {
  if (folderId.trim()) {
    zotero.Prefs?.set(PREF_DEFAULT_FOLDER_ID, folderId.trim())
  } else {
    zotero.Prefs?.clear(PREF_DEFAULT_FOLDER_ID)
  }
}

export function clearConnection(zotero: ZoteroLike) {
  zotero.Prefs?.clear(PREF_BASE_URL)
  zotero.Prefs?.clear(PREF_TOKEN)
  zotero.Prefs?.clear(PREF_DEFAULT_FOLDER_ID)
  zotero.Prefs?.clear(PREF_SYNC_MAPPINGS)
  zotero.Prefs?.clear(PREF_COLLECTION_UPLOAD_INCLUDE_PDF)
  zotero.Prefs?.clear(PREF_FAVORITE_FOLDERS_CACHE)
}

export function readCollectionUploadIncludePdfDefault(zotero: ZoteroLike) {
  return prefBoolean(zotero, PREF_COLLECTION_UPLOAD_INCLUDE_PDF)
}

export function saveCollectionUploadIncludePdfDefault(zotero: ZoteroLike, includePdf: boolean) {
  zotero.Prefs?.set(PREF_COLLECTION_UPLOAD_INCLUDE_PDF, includePdf)
}

export async function listFavoriteFoldersForConnection(
  input: Pick<JadenseConnection, "baseUrl" | "token">,
  fetchImpl?: typeof fetch,
) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const token = input.token.trim()
  if (!baseUrl) throw new Error("请填写攻玉 Webapp 地址。")
  if (!token) throw new Error("请先配置攻玉插件令牌再加载收藏夹。")
  return new JadenseApiClient({ baseUrl, token, fetchImpl }).listFavoriteFolders()
}

export function favoriteFolderOptionLabel(folder: Pick<FavoriteFolderOption, "name" | "isDefault" | "itemCount">) {
  const suffix = folder.isDefault ? "default" : `${folder.itemCount} items`
  return `${folder.name} (${suffix})`
}

export function resolveSelectedFavoriteFolderId(input: {
  folders: FavoriteFolderOption[]
  requestedFolderId: string
  defaultFolderId: string | null
}) {
  const requestedFolderId = input.requestedFolderId.trim()
  if (input.folders.some((folder) => folder.id === requestedFolderId)) {
    return requestedFolderId
  }
  if (input.defaultFolderId && input.folders.some((folder) => folder.id === input.defaultFolderId)) {
    return input.defaultFolderId
  }
  return input.folders[0]?.id ?? ""
}

export function readFavoriteFoldersCache(zotero: ZoteroLike): FavoriteFoldersCache | null {
  const rawValue = prefString(zotero, PREF_FAVORITE_FOLDERS_CACHE)
  if (!rawValue) return null

  try {
    const parsed = JSON.parse(rawValue) as Partial<FavoriteFoldersCache>
    if (!Array.isArray(parsed.folders)) return null
    const folders = parsed.folders.filter((folder): folder is FavoriteFolderOption =>
      Boolean(folder) && typeof folder.id === "string" && typeof folder.name === "string",
    )
    return {
      fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : "",
      defaultFolderId: typeof parsed.defaultFolderId === "string" ? parsed.defaultFolderId : null,
      folders,
    }
  } catch {
    return null
  }
}

function writeFavoriteFoldersCache(zotero: ZoteroLike, cache: FavoriteFoldersCache) {
  zotero.Prefs?.set(PREF_FAVORITE_FOLDERS_CACHE, JSON.stringify(cache))
}

function toFavoriteFolderOption(folder: JadenseFavoriteFolder): FavoriteFolderOption {
  return {
    id: folder.id,
    name: folder.name,
    isDefault: folder.isDefault === true,
    itemCount: typeof folder.itemCount === "number" ? folder.itemCount : 0,
  }
}

// 同一时刻只放行一个收藏夹请求:面板/Manager/启动预热共享结果,避免并发重复打 API。
let favoriteFoldersRefreshInFlight: Promise<FavoriteFoldersRefreshResult> | null = null

export function refreshFavoriteFoldersCache(
  zotero: ZoteroLike,
  fetchImpl?: typeof fetch,
): Promise<FavoriteFoldersRefreshResult> {
  if (favoriteFoldersRefreshInFlight) return favoriteFoldersRefreshInFlight

  const connection = readConnection(zotero)
  if (!connection.token) {
    return Promise.resolve({
      ok: false,
      reason: "no-token",
      folders: [],
      selectedFolderId: connection.defaultFolderId,
      fetchedAt: readFavoriteFoldersCache(zotero)?.fetchedAt ?? "",
      message: "请先配置攻玉插件令牌再加载收藏夹。",
    })
  }

  const request = (async (): Promise<FavoriteFoldersRefreshResult> => {
    try {
      const result = await listFavoriteFoldersForConnection({
        baseUrl: connection.baseUrl,
        token: connection.token,
      }, fetchImpl)
      const folders = result.folders.map(toFavoriteFolderOption)
      const selectedFolderId = resolveSelectedFavoriteFolderId({
        folders,
        requestedFolderId: connection.defaultFolderId,
        defaultFolderId: result.defaultFolderId,
      })
      const fetchedAt = new Date().toISOString()
      writeFavoriteFoldersCache(zotero, { fetchedAt, defaultFolderId: result.defaultFolderId, folders })
      // 服务端默认收藏夹/列表第一个会在用户从未选择时自动落盘,保证上传流程始终有可用 folderId。
      if (selectedFolderId && selectedFolderId !== connection.defaultFolderId) {
        zotero.Prefs?.set(PREF_DEFAULT_FOLDER_ID, selectedFolderId)
      }
      return {
        ok: true,
        reason: "ok",
        folders,
        selectedFolderId,
        fetchedAt,
        message: `已加载 ${folders.length} 个收藏夹。`,
      }
    } catch (error) {
      const cached = readFavoriteFoldersCache(zotero)
      return {
        ok: false,
        reason: "request-failed",
        folders: cached?.folders ?? [],
        selectedFolderId: connection.defaultFolderId,
        fetchedAt: cached?.fetchedAt ?? "",
        message: error instanceof Error ? error.message : "收藏夹加载失败。",
      }
    } finally {
      favoriteFoldersRefreshInFlight = null
    }
  })()
  favoriteFoldersRefreshInFlight = request
  return request
}

export async function pushSelectedItemsToJadense(
  zotero: ZoteroLike,
  options: { includePdf?: boolean } = {},
) {
  const client = assertClient(zotero)
  const folderId = prefString(zotero, PREF_DEFAULT_FOLDER_ID)
  if (!folderId) throw new Error("未设置默认攻玉收藏夹。")

  const entries = selectedEntries(zotero)
  const items = entries.map((entry) => zoteroItemToJadenseImportItem(entry.snapshot))
  if (items.length === 0) throw new Error("未选中可上传的 Zotero 条目。")

  const result = await importMetadataBatches(client, folderId, items)
  const resultsById = resultByClientItemId(result.results)
  const mappingState = readSyncMappings(zotero)
  const itemResults: ZoteroCollectionUploadItemResult[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const importItem = items[index]!
    const metadataResult = resultsById.get(importItem.clientItemId) ?? {
      clientItemId: importItem.clientItemId,
      status: "failed" as const,
      error: "攻玉未返回该条目的导入结果。",
    }
    const pdf = metadataResult.status === "failed"
      ? { status: "skipped" as const, reason: "元数据导入失败，未继续上传 PDF。" }
      : await uploadPdfForEntry({
          client,
          folderId,
          zotero,
          entry,
          importItem,
          includePdf: Boolean(options.includePdf),
        })
    savePushMapping(mappingState, {
      folderId,
      entry,
      importItem,
      metadataResult,
      pdfStatus: pdf,
    })
    itemResults.push({
      clientItemId: importItem.clientItemId,
      title: entry.snapshot.title,
      itemKey: entry.snapshot.itemKey,
      collectionPaths: [],
      metadataStatus: metadataResult.status,
      metadataError: metadataResult.error,
      pdf,
    })
  }
  saveSyncMappings(zotero, mappingState)
  return {
    ...result,
    ...summarizeCollectionUpload(itemResults),
    items: itemResults,
  }
}

export async function previewSelectedCollectionUpload(zotero: ZoteroLike): Promise<ZoteroCollectionUploadPreview> {
  const collected = await collectSelectedCollectionItems(zotero)
  return {
    collectionName: collected.collectionName,
    totalCount: collected.entries.length,
    skippedCount: collected.skipped.length,
  }
}

export async function pushSelectedCollectionToJadense(
  zotero: ZoteroLike,
  options: { includePdf?: boolean } = {},
) {
  const client = assertClient(zotero)
  const folderId = prefString(zotero, PREF_DEFAULT_FOLDER_ID)
  if (!folderId) throw new Error("未设置默认攻玉收藏夹。")

  const collected = await collectSelectedCollectionItems(zotero)
  const localSkippedItems: ZoteroCollectionUploadItemResult[] = collected.skipped.map((item) => ({
    clientItemId: item.clientItemId ?? `zotero:missing-key/${item.collectionPaths.join("/")}`,
    title: item.title,
    itemKey: item.itemKey,
    collectionPaths: item.collectionPaths,
    metadataStatus: "skipped",
    metadataError: item.reason,
    pdf: { status: "skipped", reason: item.reason },
  }))

  if (collected.entries.length === 0) {
    return {
      collectionName: collected.collectionName,
      totalCount: 0,
      importedCount: 0,
      skippedCount: localSkippedItems.length,
      failedCount: 0,
      pdfUploadedCount: 0,
      pdfSkippedCount: localSkippedItems.length,
      pdfFailedCount: 0,
      items: localSkippedItems,
    }
  }

  const importItems = collected.entries.map((entry) => zoteroItemToJadenseImportItem(entry.snapshot))
  const metadataResult = await importMetadataBatches(client, folderId, importItems)
  const resultsById = resultByClientItemId(metadataResult.results)
  const mappingState = readSyncMappings(zotero)
  const items: ZoteroCollectionUploadItemResult[] = []

  for (let index = 0; index < collected.entries.length; index += 1) {
    const entry = collected.entries[index]!
    const importItem = importItems[index]!
    const result = resultsById.get(importItem.clientItemId) ?? {
      clientItemId: importItem.clientItemId,
      status: "failed" as const,
      error: "攻玉未返回该条目的导入结果。",
    }
    const pdf = result.status === "failed"
      ? { status: "skipped" as const, reason: "元数据导入失败，未继续上传 PDF。" }
      : await uploadPdfForEntry({
          client,
          folderId,
          zotero,
          entry,
          importItem,
          includePdf: Boolean(options.includePdf),
        })

    savePushMapping(mappingState, {
      folderId,
      entry,
      importItem,
      metadataResult: result,
      pdfStatus: pdf,
    })
    items.push({
      clientItemId: importItem.clientItemId,
      title: entry.snapshot.title,
      itemKey: entry.snapshot.itemKey,
      collectionPaths: entry.collectionPaths,
      metadataStatus: result.status,
      metadataError: result.error,
      pdf,
    })
  }

  saveSyncMappings(zotero, mappingState)
  const allItems = [...localSkippedItems, ...items]
  return {
    collectionName: collected.collectionName,
    totalCount: collected.entries.length,
    ...summarizeCollectionUpload(allItems),
    items: allItems,
  }
}

export async function pullFavoriteFolderToZotero(zotero: ZoteroLike) {
  const client = assertClient(zotero)
  const folderId = prefString(zotero, PREF_DEFAULT_FOLDER_ID)
  if (!folderId) throw new Error("未设置默认攻玉收藏夹。")

  const payload = await client.listFavoriteItems(folderId)
  const mappingState = readSyncMappings(zotero)
  const folderName = await resolveFavoriteFolderName(client, folderId)
  const previousFolderMapping = JSON.stringify(mappingState.folders[folderId] ?? null)
  const collectionRef = await ensureFavoriteFolderCollection(zotero, mappingState, {
    folderId,
    folderName,
  })
  let importedCount = 0
  let skippedCount = 0
  let mappingChanged = previousFolderMapping !== JSON.stringify(mappingState.folders[folderId] ?? null)

  for (const item of payload.items) {
    const favoriteItem = item as JadenseFavoriteExportItem
    const draft = jadenseFavoriteToZoteroDraft(favoriteItem)
    const jadenseKey = jadenseStableKey(favoriteItem)
    const identityKeys = favoriteIdentityKeys(favoriteItem, draft)
    const mappedItem = mappingState.items[jadenseKey]
      ? await resolveMappedItem(zotero, mappingState.items[jadenseKey]!.zoteroItem)
      : null

    if (mappedItem) {
      await addItemToCollection(
        zotero,
        collectionRef,
        itemRefFromRawItem(mappedItem) ?? mappingState.items[jadenseKey]!.zoteroItem,
      )
      skippedCount += 1
      continue
    }

    const existingMatch = await findStrongIdentityMatch(zotero, identityKeys)
    if (existingMatch) {
      await addItemToCollection(zotero, collectionRef, existingMatch)
      saveMapping(mappingState, jadenseKey, identityKeys, existingMatch)
      mappingChanged = true
      skippedCount += 1
      continue
    }

    const createdItem = await createZoteroItem(zotero, draft)
    await addItemToCollection(zotero, collectionRef, createdItem)
    saveMapping(mappingState, jadenseKey, identityKeys, createdItem)
    mappingChanged = true
    importedCount += 1
  }

  if (mappingChanged) saveSyncMappings(zotero, mappingState)
  return {
    importedCount,
    skippedCount,
    unchangedCount: skippedCount,
    totalCount: payload.items.length,
    collectionName: collectionRef?.name ?? null,
  }
}
