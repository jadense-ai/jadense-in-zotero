import { afterEach, describe, expect, it, vi } from "vitest"

import type { JadenseFavoriteExportItem } from "@/sync/metadata"
import {
  clearConnection,
  listFavoriteFoldersForConnection,
  previewSelectedCollectionUpload,
  pullFavoriteFolderToZotero,
  pushSelectedCollectionToJadense,
  pushSelectedItemsToJadense,
  readConnection,
  readFavoriteFoldersCache,
  refreshFavoriteFoldersCache,
  saveConnection,
  saveDefaultFolderId,
  type ZoteroLike,
} from "./runtime"

const SYNC_MAPPING_PREF_KEY = "extensions.jadenseInZotero.syncMappings"

type FakeFieldMap = Record<string, string>

class FakeZoteroItem {
  readonly id: number
  libraryID: string | number = 1
  readonly itemType: string
  readonly key: string
  private readonly fields: FakeFieldMap = {}
  private creators: unknown[] = []
  private tags: unknown[] = []
  private readonly attachmentIDs: Array<string | number> = []

  constructor(itemType: string, key: string) {
    this.itemType = itemType
    this.key = key
    this.id = Number(key.replace(/^I/, ""))
  }

  setField(field: string, value: string) {
    this.fields[field] = value
  }

  getField(field: string) {
    return this.fields[field] ?? ""
  }

  setCreators(creators: unknown[]) {
    this.creators = creators
  }

  getCreators() {
    return this.creators
  }

  setTags(tags: unknown[]) {
    this.tags = tags
  }

  getTags() {
    return this.tags
  }

  isRegularItem() {
    return true
  }

  isNote() {
    return false
  }

  isAttachment() {
    return false
  }

  getAttachments() {
    return this.attachmentIDs
  }

  addAttachment(attachmentID: string | number) {
    this.attachmentIDs.push(attachmentID)
  }

  async saveTx() {
    return this.key
  }
}

class FakeZoteroAttachment {
  readonly id: number
  readonly key: string
  libraryID: string | number = 1
  readonly itemType = "attachment"
  readonly file: Blob | null
  private readonly fields: FakeFieldMap = {}

  constructor(id: number, input: { title: string; contentType?: string; file?: Blob | null }) {
    this.id = id
    this.key = `A${id}`
    this.file = input.file === undefined ? new Blob(["pdf"], { type: "application/pdf" }) : input.file
    this.fields.title = input.title
    this.fields.contentType = input.contentType ?? "application/pdf"
  }

  getField(field: string) {
    return this.fields[field] ?? ""
  }

  isRegularItem() {
    return false
  }

  isNote() {
    return false
  }

  isAttachment() {
    return true
  }
}

class FakeZoteroCollection {
  readonly id: number
  readonly key: string
  libraryID: string | number = 1
  name = ""
  readonly itemIDs = new Set<string | number>()
  readonly childItems: Array<unknown> = []
  readonly childCollections: Array<unknown> = []

  constructor(id: number) {
    this.id = id
    this.key = `C${id}`
  }

  addItem(itemID: string | number) {
    this.itemIDs.add(itemID)
  }

  getChildItems() {
    return this.childItems
  }

  getChildCollections() {
    return this.childCollections
  }

  async saveTx() {
    return this.id
  }
}

function createFakeZotero() {
  const prefs = new Map<string, unknown>()
  const items: FakeZoteroItem[] = []
  const attachments: FakeZoteroAttachment[] = []
  const collections: FakeZoteroCollection[] = []
  const selectedItems: unknown[] = []
  let selectedCollection: unknown = null
  let nextKey = 1
  let nextAttachmentId = 1000
  let nextCollectionId = 1

  class Item extends FakeZoteroItem {
    constructor(itemType: string) {
      super(itemType, `I${nextKey}`)
      nextKey += 1
    }

    override async saveTx() {
      if (!items.includes(this)) items.push(this)
      return super.saveTx()
    }
  }

  class Collection extends FakeZoteroCollection {
    constructor() {
      super(nextCollectionId)
      nextCollectionId += 1
    }

    override async saveTx() {
      if (!collections.includes(this)) collections.push(this)
      return super.saveTx()
    }
  }

  const zotero: ZoteroLike = {
    Prefs: {
      get: (key) => prefs.get(key),
      set: (key, value) => prefs.set(key, value),
      clear: (key) => prefs.delete(key),
    },
    Libraries: { userLibraryID: 1 },
    Items: {
      get: vi.fn((itemID: string | number) =>
        [...items, ...attachments].find((item) => String(item.id) === String(itemID)) ?? null,
      ),
      getByLibraryAndKey: vi.fn((libraryID: string | number, key: string) =>
        items.find((item) => String(item.libraryID) === String(libraryID) && item.key === key) ?? null,
      ),
      getAll: vi.fn(() => items),
    },
    Collections: {
      get: vi.fn((collectionID: string | number) =>
        collections.find((collection) => String(collection.id) === String(collectionID)) ?? null,
      ),
      getByLibrary: vi.fn((libraryID?: string | number) =>
        collections.filter((collection) => libraryID === undefined || String(collection.libraryID) === String(libraryID)),
      ),
    },
    getActiveZoteroPane: () => ({
      getSelectedItems: () => selectedItems,
      getSelectedCollection: () => selectedCollection,
    }),
    Item,
    Collection,
  }

  function seedItem(fields: FakeFieldMap) {
    const item = new FakeZoteroItem("journalArticle", `I${nextKey}`)
    nextKey += 1
    for (const [field, value] of Object.entries(fields)) item.setField(field, value)
    items.push(item)
    return item
  }

  function seedAttachment(input: { title: string; contentType?: string; file?: Blob | null }) {
    const attachment = new FakeZoteroAttachment(nextAttachmentId, input)
    nextAttachmentId += 1
    attachments.push(attachment)
    return attachment
  }

  function seedCollection(name: string) {
    const collection = new FakeZoteroCollection(nextCollectionId)
    nextCollectionId += 1
    collection.name = name
    collections.push(collection)
    return collection
  }

  saveConnection(zotero, {
    baseUrl: "http://localhost:3000",
    token: "jdx_ext_test",
    defaultFolderId: "folder-1",
  })

  return {
    zotero,
    prefs,
    items,
    attachments,
    collections,
    selectedItems,
    setSelectedCollection: (collection: unknown) => {
      selectedCollection = collection
    },
    seedItem,
    seedAttachment,
    seedCollection,
  }
}

function mockFavoriteItems(items: JadenseFavoriteExportItem[], folderName = "Synced Papers") {
  const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
    const value = String(url)
    const body = value.includes("/api/extension/favorite/folders")
      ? {
          defaultFolderId: "folder-1",
          folders: [{ id: "folder-1", name: folderName, isDefault: true, itemCount: items.length }],
        }
      : { items }
    return {
      ok: true,
      json: async () => body,
      text: async () => "",
    }
  })
  vi.stubGlobal("fetch", fetchImpl)
  return fetchImpl
}

function linkedPaperFavorite(overrides: Partial<JadenseFavoriteExportItem & { itemKind: "paper" }> = {}) {
  return {
    itemKind: "paper",
    articleId: "paper-1",
    paper: {
      title: "Linked paper",
      authors: [{ name: "Grace Hopper" }],
      journal: { name: "Computing" },
      publishedAt: "1952-01-01T00:00:00.000Z",
      abstract: "Compiler paper",
      external_source: "crossref",
      external_id: "10.1000/test",
      detailPageUrl: "https://example.com/paper",
      links: [{ type: "doi", url: "https://doi.org/10.1000/test" }],
    },
    ...overrides,
  } satisfies JadenseFavoriteExportItem
}

function standaloneFavorite(overrides: Partial<JadenseFavoriteExportItem & { itemKind: "standalone" }> = {}) {
  return {
    itemKind: "standalone",
    favoriteItemId: "fav-1",
    standalone: {
      title: "Standalone thesis",
      authors: ["Ada Lovelace"],
      journal: "University Archive",
      publicationDate: "1843",
      abstract: "No DOI",
      sourceUrl: "https://example.com/thesis",
      metadata: { doi: null },
    },
    ...overrides,
  } satisfies JadenseFavoriteExportItem
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("pullFavoriteFolderToZotero", () => {
  it("persists a linked paper mapping and skips repeat imports", async () => {
    const { zotero, prefs, items, collections } = createFakeZotero()
    mockFavoriteItems([linkedPaperFavorite()])

    await expect(pullFavoriteFolderToZotero(zotero)).resolves.toEqual({
      importedCount: 1,
      skippedCount: 0,
      unchangedCount: 0,
      totalCount: 1,
      collectionName: "Jadense - Synced Papers",
    })
    expect(items).toHaveLength(1)
    expect(collections).toHaveLength(1)
    expect(collections[0]?.itemIDs.has(items[0]!.id)).toBe(true)

    const mappings = JSON.parse(String(prefs.get(SYNC_MAPPING_PREF_KEY))) as {
      items: Record<string, { zoteroItem: { itemKey: string } }>
      folders: Record<string, { zoteroCollection: { name: string } }>
    }
    expect(mappings.items["jadense:article:paper-1"]?.zoteroItem.itemKey).toBe(items[0]?.key)
    expect(mappings.folders["folder-1"]?.zoteroCollection.name).toBe("Jadense - Synced Papers")

    await expect(pullFavoriteFolderToZotero(zotero)).resolves.toEqual({
      importedCount: 0,
      skippedCount: 1,
      unchangedCount: 1,
      totalCount: 1,
      collectionName: "Jadense - Synced Papers",
    })
    expect(items).toHaveLength(1)
    expect(collections).toHaveLength(1)
  })

  it("skips an existing DOI match without overwriting local Zotero metadata", async () => {
    const { zotero, items, collections, seedItem } = createFakeZotero()
    const existing = seedItem({
      title: "Local edited title",
      DOI: "10.1000/test",
      extra: "Curated locally",
    })
    mockFavoriteItems([linkedPaperFavorite()])

    await expect(pullFavoriteFolderToZotero(zotero)).resolves.toEqual({
      importedCount: 0,
      skippedCount: 1,
      unchangedCount: 1,
      totalCount: 1,
      collectionName: "Jadense - Synced Papers",
    })

    expect(items).toEqual([existing])
    expect(existing.getField("title")).toBe("Local edited title")
    expect(existing.getField("extra")).toBe("Curated locally")
    expect(collections[0]?.itemIDs.has(existing.id)).toBe(true)
  })

  it("skips standalone favorites that already have a Jadense marker", async () => {
    const { zotero, items, collections, seedItem } = createFakeZotero()
    const existing = seedItem({
      title: "Local standalone title",
      extra: "Jadense favorite item: fav-1",
    })
    mockFavoriteItems([standaloneFavorite()])

    await expect(pullFavoriteFolderToZotero(zotero)).resolves.toEqual({
      importedCount: 0,
      skippedCount: 1,
      unchangedCount: 1,
      totalCount: 1,
      collectionName: "Jadense - Synced Papers",
    })

    expect(items).toEqual([existing])
    expect(existing.getField("title")).toBe("Local standalone title")
    expect(collections[0]?.itemIDs.has(existing.id)).toBe(true)
  })
})

describe("Zotero -> Jadense upload", () => {
  it("pushes selected method-style Zotero items and persists v2 push mappings", async () => {
    const { zotero, prefs, selectedItems, seedItem } = createFakeZotero()
    const item = seedItem({
      title: "Method style paper",
      DOI: "10.1000/method",
    })
    selectedItems.push(item)
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        importedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        results: [{ clientItemId: "zotero:1/I1", status: "imported", result: { insertedFolderIds: ["folder-1"] } }],
      }),
      text: async () => "",
    })))

    await expect(pushSelectedItemsToJadense(zotero)).resolves.toMatchObject({
      importedCount: 1,
      failedCount: 0,
    })

    const mappings = JSON.parse(String(prefs.get(SYNC_MAPPING_PREF_KEY))) as {
      version: number
      pushes: Record<string, { metadataStatus: string; pdfStatus: string }>
    }
    expect(mappings.version).toBe(2)
    expect(mappings.pushes["1:I1"]).toMatchObject({
      metadataStatus: "imported",
      pdfStatus: "not_requested",
    })
  })

  it("optionally uploads PDFs for selected Zotero items", async () => {
    const { zotero, selectedItems, seedAttachment, seedItem } = createFakeZotero()
    const item = seedItem({ title: "Selected PDF paper" })
    const attachment = seedAttachment({ title: "selected-paper.pdf" })
    item.addAttachment(attachment.id)
    selectedItems.push(item)
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body instanceof FormData) {
        return {
          ok: true,
          json: async () => ({
            itemKind: "literature",
            articleId: null,
            insertedFolderIds: ["folder-1"],
            skippedFolderIds: [],
          }),
          text: async () => "",
        }
      }
      return {
        ok: true,
        json: async () => ({
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          results: [{ clientItemId: "zotero:1/I1", status: "imported" }],
        }),
        text: async () => "",
      }
    })
    vi.stubGlobal("fetch", fetchImpl)

    await expect(pushSelectedItemsToJadense(zotero, { includePdf: true })).resolves.toMatchObject({
      importedCount: 1,
      pdfUploadedCount: 1,
      pdfFailedCount: 0,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("uploads selected collection recursively with dedupe, chunking, and optional PDFs", async () => {
    const {
      zotero,
      prefs,
      seedAttachment,
      seedCollection,
      seedItem,
      setSelectedCollection,
    } = createFakeZotero()
    const root = seedCollection("Root")
    const child = seedCollection("Child")
    root.childCollections.push(child)

    const first = seedItem({ title: "Paper 1", DOI: "10.1000/1" })
    const unreadableAttachment = seedAttachment({ title: "unreadable.pdf", file: null })
    const attachment = seedAttachment({ title: "paper-1.pdf" })
    first.addAttachment(unreadableAttachment.id)
    first.addAttachment(attachment.id)
    root.childItems.push(first)
    child.childItems.push(first)

    for (let index = 2; index <= 101; index += 1) {
      root.childItems.push(seedItem({
        title: `Paper ${index}`,
        DOI: `10.1000/${index}`,
      }))
    }
    root.childItems.push(seedItem({ DOI: "10.1000/missing-title" }))
    setSelectedCollection(root)

    const metadataBatchSizes: number[] = []
    let pdfUploadCount = 0
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const value = String(url)
      if (value.includes("/api/extension/favorite/import-zotero-items")) {
        const body = JSON.parse(String(init?.body)) as {
          items: Array<{ clientItemId: string }>
        }
        metadataBatchSizes.push(body.items.length)
        return {
          ok: true,
          json: async () => ({
            importedCount: body.items.length,
            skippedCount: 0,
            failedCount: 0,
            results: body.items.map((item) => ({
              clientItemId: item.clientItemId,
              status: "imported",
              result: { insertedFolderIds: ["folder-1"] },
            })),
          }),
          text: async () => "",
        }
      }
      if (value.includes("/api/extension/favorite/import-page-pdf")) {
        pdfUploadCount += 1
        return {
          ok: true,
          json: async () => ({
            itemKind: "paper",
            articleId: "paper-1",
            insertedFolderIds: [],
            skippedFolderIds: [],
            backfilledFolderIds: ["folder-1"],
          }),
          text: async () => "",
        }
      }
      return {
        ok: true,
        json: async () => ({ defaultFolderId: "folder-1", folders: [] }),
        text: async () => "",
      }
    }))

    await expect(previewSelectedCollectionUpload(zotero)).resolves.toEqual({
      collectionName: "Root",
      totalCount: 101,
      skippedCount: 1,
    })
    const uploadResult = await pushSelectedCollectionToJadense(zotero, { includePdf: true })
    expect(uploadResult).toMatchObject({
      collectionName: "Root",
      totalCount: 101,
      importedCount: 101,
      skippedCount: 1,
      failedCount: 0,
      pdfUploadedCount: 1,
      pdfSkippedCount: 101,
      pdfFailedCount: 0,
    })
    expect(uploadResult.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadataStatus: "skipped",
        metadataError: "missing_title",
      }),
    ]))

    expect(metadataBatchSizes).toEqual([100, 1])
    expect(pdfUploadCount).toBe(1)
    const mappings = JSON.parse(String(prefs.get(SYNC_MAPPING_PREF_KEY))) as {
      pushes: Record<string, { collectionPaths: string[]; pdfStatus: string }>
    }
    expect(Object.keys(mappings.pushes)).toHaveLength(101)
    expect(mappings.pushes["1:I1"]).toMatchObject({
      collectionPaths: ["Root", "Root / Child"],
      pdfStatus: "uploaded",
    })
  })

  it("marks the PDF as skipped when the server reports the item already has a file", async () => {
    const { zotero, prefs, selectedItems, seedAttachment, seedItem } = createFakeZotero()
    const item = seedItem({ title: "Already has PDF" })
    const attachment = seedAttachment({ title: "already-has-pdf.pdf" })
    item.addAttachment(attachment.id)
    selectedItems.push(item)
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes("/api/extension/favorite/import-page-pdf")) {
        return {
          ok: true,
          json: async () => ({
            itemKind: "literature",
            articleId: null,
            assetFileId: null,
            insertedFolderIds: [],
            skippedFolderIds: ["folder-1"],
            backfilledFolderIds: [],
          }),
          text: async () => "",
        }
      }
      return {
        ok: true,
        json: async () => ({
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          results: [{ clientItemId: "zotero:1/I1", status: "imported" }],
        }),
        text: async () => "",
      }
    }))

    await expect(pushSelectedItemsToJadense(zotero, { includePdf: true })).resolves.toMatchObject({
      importedCount: 1,
      pdfUploadedCount: 0,
      pdfSkippedCount: 1,
      pdfFailedCount: 0,
    })
    const mappings = JSON.parse(String(prefs.get(SYNC_MAPPING_PREF_KEY))) as {
      pushes: Record<string, { pdfStatus: string; error?: string | null }>
    }
    expect(mappings.pushes["1:I1"]?.pdfStatus).toBe("skipped")
  })
})

describe("Jadense connection preferences", () => {
  it("uses the cn production default and migrates legacy production URLs", () => {
    const { zotero, prefs } = createFakeZotero()
    prefs.delete("extensions.jadenseInZotero.baseUrl")

    expect(readConnection(zotero).baseUrl).toBe("https://jadense.cn")

    prefs.set("extensions.jadenseInZotero.baseUrl", "https://app.jadense.com/")
    expect(readConnection(zotero).baseUrl).toBe("https://jadense.cn")
    expect(prefs.get("extensions.jadenseInZotero.baseUrl")).toBe("https://jadense.cn")

    prefs.set("extensions.jadenseInZotero.baseUrl", "https://staging.jadense.com/")
    expect(readConnection(zotero).baseUrl).toBe("https://staging.jadense.com")
  })

  it("normalizes connection values and clears an empty default folder", () => {
    const { zotero, prefs } = createFakeZotero()

    saveConnection(zotero, {
      baseUrl: " https://jadense.cn/ ",
      token: " jdx_ext_updated ",
      defaultFolderId: " folder-2 ",
    })
    expect(readConnection(zotero)).toEqual({
      baseUrl: "https://jadense.cn",
      token: "jdx_ext_updated",
      defaultFolderId: "folder-2",
    })

    // 令牌编辑场景:不传 baseUrl/defaultFolderId 时两者都保持原值。
    saveConnection(zotero, { token: "jdx_ext_updated" })
    expect(readConnection(zotero)).toEqual({
      baseUrl: "https://jadense.cn",
      token: "jdx_ext_updated",
      defaultFolderId: "folder-2",
    })

    saveConnection(zotero, {
      token: "jdx_ext_updated",
      defaultFolderId: "",
    })
    expect(readConnection(zotero).defaultFolderId).toBe("")
    expect(prefs.has("extensions.jadenseInZotero.defaultFolderId")).toBe(false)
  })

  it("loads favorite folders with the configured bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        defaultFolderId: "folder-1",
        folders: [{ id: "folder-1", name: "Default", isDefault: true, itemCount: 2 }],
      }),
      text: async () => "",
    })

    await expect(
      listFavoriteFoldersForConnection(
        {
          baseUrl: "https://jadense.cn/",
          token: "jdx_ext_secret",
        },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({
      defaultFolderId: "folder-1",
      folders: [{ id: "folder-1", name: "Default", isDefault: true, itemCount: 2 }],
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://jadense.cn/api/extension/favorite/folders",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get("authorization")).toBe("Bearer jdx_ext_secret")
  })
})

describe("favorite folders cache", () => {
  const foldersResponse = {
    defaultFolderId: "folder-9",
    folders: [
      { id: "folder-1", name: "Papers", isDefault: false, itemCount: 3 },
      { id: "folder-9", name: "Default", isDefault: true, itemCount: 1 },
    ],
  }

  function foldersFetch(payload: unknown = foldersResponse) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
      text: async () => "",
    })
  }

  it("persists fetched folders and auto-selects the server default folder", async () => {
    const { zotero, prefs } = createFakeZotero()
    saveDefaultFolderId(zotero, "")
    const fetchImpl = foldersFetch()

    const result = await refreshFavoriteFoldersCache(zotero, fetchImpl as unknown as typeof fetch)

    expect(result.ok).toBe(true)
    expect(result.selectedFolderId).toBe("folder-9")
    // 服务端默认收藏夹在用户从未选择时自动落盘,保证上传流程始终有可用 folderId。
    expect(prefs.get("extensions.jadenseInZotero.defaultFolderId")).toBe("folder-9")
    const cached = readFavoriteFoldersCache(zotero)
    expect(cached?.folders).toHaveLength(2)
    expect(cached?.defaultFolderId).toBe("folder-9")
    expect(cached?.fetchedAt).toBeTruthy()
  })

  it("keeps the stored folder selection when it still exists on the server", async () => {
    const { zotero, prefs } = createFakeZotero()
    expect(prefs.get("extensions.jadenseInZotero.defaultFolderId")).toBe("folder-1")

    const result = await refreshFavoriteFoldersCache(zotero, foldersFetch() as unknown as typeof fetch)

    expect(result.ok).toBe(true)
    expect(result.selectedFolderId).toBe("folder-1")
    expect(prefs.get("extensions.jadenseInZotero.defaultFolderId")).toBe("folder-1")
  })

  it("returns no-token without issuing a request", async () => {
    const { zotero } = createFakeZotero()
    clearConnection(zotero)
    const fetchImpl = foldersFetch()

    const result = await refreshFavoriteFoldersCache(zotero, fetchImpl as unknown as typeof fetch)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("no-token")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("falls back to the cached folder list without exposing a non-JSON server body", async () => {
    const { zotero } = createFakeZotero()
    await refreshFavoriteFoldersCache(zotero, foldersFetch() as unknown as typeof fetch)

    const failingFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "server down",
    })
    const result = await refreshFavoriteFoldersCache(zotero, failingFetch as unknown as typeof fetch)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("request-failed")
    expect(result.message).toBe("攻玉请求失败（500）")
    expect(result.folders).toHaveLength(2)
  })

  it("shares one in-flight request between concurrent callers", async () => {
    const { zotero } = createFakeZotero()
    const fetchImpl = foldersFetch()

    const [first, second] = await Promise.all([
      refreshFavoriteFoldersCache(zotero, fetchImpl as unknown as typeof fetch),
      refreshFavoriteFoldersCache(zotero, fetchImpl as unknown as typeof fetch),
    ])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })

  it("clears the cache together with the connection", async () => {
    const { zotero, prefs } = createFakeZotero()
    await refreshFavoriteFoldersCache(zotero, foldersFetch() as unknown as typeof fetch)
    expect(readFavoriteFoldersCache(zotero)).not.toBeNull()

    clearConnection(zotero)

    expect(readFavoriteFoldersCache(zotero)).toBeNull()
    expect(prefs.has("extensions.jadenseInZotero.token")).toBe(false)
  })
})
