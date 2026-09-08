// Zotero 条目快照只保留 Jadense 元数据同步所需的最小字段。
export type ZoteroCreatorSnapshot = {
  firstName?: string | null
  lastName?: string | null
  name?: string | null
  creatorType?: string | null
}

export type ZoteroTagSnapshot = {
  tag: string
}

export type ZoteroItemSnapshot = {
  libraryKey: string
  itemKey: string
  itemType: string
  title: string
  creators: ZoteroCreatorSnapshot[]
  date?: string | null
  publicationTitle?: string | null
  doi?: string | null
  url?: string | null
  abstractNote?: string | null
  tags?: ZoteroTagSnapshot[]
  extra?: string | null
  collectionPaths?: string[]
}

export type ZoteroItemDraft = {
  itemType: string
  title: string
  creators: ZoteroCreatorSnapshot[]
  date: string | null
  publicationTitle: string | null
  doi: string | null
  url: string | null
  abstractNote: string | null
  tags: ZoteroTagSnapshot[]
  extra: string | null
}

export type ZoteroPdfAttachmentFile = {
  file: Blob
  filename: string
}
