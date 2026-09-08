import type {
  ZoteroCreatorSnapshot,
  ZoteroItemDraft,
  ZoteroItemSnapshot,
  ZoteroTagSnapshot,
} from "@/zotero/types"

export type JadenseFavoriteMetadata = {
  doi: string | null
  externalSource: string | null
  externalId: string | null
  title: string | null
  authors: string[]
  venueName: string | null
  publicationDate: string | null
  abstract: string | null
  canonicalUrl: string | null
  pageUrl: string | null
  sourceMetadata: Record<string, unknown>
}

export type JadenseZoteroImportItem = {
  clientItemId: string
  metadata: JadenseFavoriteMetadata
}

export type JadenseFavoriteExportItem =
  | {
      itemKind: "paper"
      articleId: string
      paper: {
        title: string
        authors?: { name?: string | null }[]
        journal?: { name?: string | null } | null
        venue?: { name?: string | null } | null
        publishedAt?: string | null
        abstract?: string | null
        external_source?: string | null
        external_id?: string | null
        detailPageUrl?: string | null
        links?: { type: string; url: string }[]
      }
    }
  | {
      itemKind: "standalone"
      favoriteItemId: string
      standalone: {
        title: string
        authors: string[]
        venueName: string | null
        journal?: string | null
        publicationDate: string | null
        abstract: string | null
        sourceUrl: string | null
        metadata: Record<string, unknown>
      }
    }

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function nullableText(value: unknown) {
  const normalized = text(value)
  return normalized || null
}

function normalizeDoi(value: unknown) {
  return text(value).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() || null
}

function withoutArxivVersion(value: string) {
  return value.replace(/v\d+$/i, "")
}

function parseUrl(value: unknown) {
  const raw = text(value)
  if (!raw) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function normalizeSourceId(value: unknown) {
  return text(value).replace(/\s+/g, "")
}

function detectArxivId(input: ZoteroItemSnapshot) {
  const candidates = [input.url, input.extra, input.doi].map(text)
  for (const candidate of candidates) {
    const match =
      /arxiv(?:\.org\/(?:abs|pdf)\/|:)\s*([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(candidate) ??
      /\b(arXiv\s+ID|arxivId)\s*[:=]\s*([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(candidate)
    const id = match?.[2] ?? match?.[1]
    if (id) return withoutArxivVersion(id)
  }
  return null
}

function detectPubmedId(input: ZoteroItemSnapshot) {
  const url = parseUrl(input.url)
  const fromUrl = url?.hostname.includes("pubmed.ncbi.nlm.nih.gov")
    ? url.pathname.split("/").filter(Boolean)[0]
    : null
  if (fromUrl) return normalizeSourceId(fromUrl)

  const extra = text(input.extra)
  const match = /\b(?:PMID|PubMed ID)\s*[:=]\s*(\d+)/i.exec(extra)
  return match?.[1] ?? null
}

function detectCnkiId(input: ZoteroItemSnapshot) {
  const url = parseUrl(input.url)
  if (url?.hostname.includes("cnki.net")) {
    const dbcode = url.searchParams.get("dbcode") ?? url.searchParams.get("DbCode")
    const filename = url.searchParams.get("filename") ?? url.searchParams.get("FileName")
    if (dbcode && filename) return `${dbcode.toUpperCase()}/${filename.toUpperCase()}`
  }

  const extra = text(input.extra)
  const dbcode = /\bDBCODE\s*[:=]\s*([A-Za-z0-9_]+)/i.exec(extra)?.[1]
  const filename = /\bFILENAME\s*[:=]\s*([A-Za-z0-9_]+)/i.exec(extra)?.[1]
  if (dbcode && filename) return `${dbcode.toUpperCase()}/${filename.toUpperCase()}`

  const compact = /\bCNKI\s*[:=]\s*([A-Za-z0-9_]+\/[A-Za-z0-9_]+)/i.exec(extra)?.[1]
  return compact ? compact.toUpperCase() : null
}

function detectWanfangId(input: ZoteroItemSnapshot) {
  const url = parseUrl(input.url)
  if (!url?.hostname.includes("wanfangdata.com")) return null
  return normalizeSourceId(url.searchParams.get("id")) || null
}

function detectSourceIdentity(input: ZoteroItemSnapshot) {
  const cnki = detectCnkiId(input)
  if (cnki) return { externalSource: "cnki", externalId: cnki }

  const arxiv = detectArxivId(input)
  if (arxiv) return { externalSource: "arxiv", externalId: arxiv }

  const pubmed = detectPubmedId(input)
  if (pubmed) return { externalSource: "pubmed", externalId: pubmed }

  const wanfang = detectWanfangId(input)
  if (wanfang) return { externalSource: "wanfang", externalId: wanfang }

  return { externalSource: null, externalId: null }
}

function creatorName(creator: ZoteroCreatorSnapshot) {
  const direct = text(creator.name)
  if (direct) return direct
  return [creator.firstName, creator.lastName].map(text).filter(Boolean).join(" ").trim()
}

function creatorFromName(name: string): ZoteroCreatorSnapshot {
  return { creatorType: "author", name }
}

function tagsFromZotero(tags: ZoteroTagSnapshot[] | undefined) {
  return (tags ?? []).map((tag) => text(tag.tag)).filter(Boolean)
}

function paperDoiUrl(value: string | null) {
  return value ? `https://doi.org/${value}` : null
}

export function zoteroClientItemId(input: Pick<ZoteroItemSnapshot, "libraryKey" | "itemKey">) {
  return `zotero:${input.libraryKey}/${input.itemKey}`
}

export function zoteroItemToJadenseImportItem(item: ZoteroItemSnapshot): JadenseZoteroImportItem {
  const doi = normalizeDoi(item.doi)
  const canonicalUrl = nullableText(item.url) ?? paperDoiUrl(doi)
  const authors = item.creators.map(creatorName).filter(Boolean)
  const sourceIdentity = detectSourceIdentity(item)

  return {
    clientItemId: zoteroClientItemId(item),
    metadata: {
      doi,
      externalSource: sourceIdentity.externalSource,
      externalId: sourceIdentity.externalId,
      title: nullableText(item.title),
      authors,
      venueName: nullableText(item.publicationTitle),
      publicationDate: nullableText(item.date),
      abstract: nullableText(item.abstractNote),
      canonicalUrl,
      pageUrl: canonicalUrl,
      sourceMetadata: {
        zotero: {
          libraryKey: item.libraryKey,
          itemKey: item.itemKey,
          itemType: item.itemType,
          tags: tagsFromZotero(item.tags),
          extra: nullableText(item.extra),
          collectionPaths: item.collectionPaths ?? [],
        },
      },
    },
  }
}

export function jadenseFavoriteToZoteroDraft(item: JadenseFavoriteExportItem): ZoteroItemDraft {
  if (item.itemKind === "standalone") {
    return {
      itemType: "journalArticle",
      title: item.standalone.title,
      creators: item.standalone.authors.map(creatorFromName),
      date: item.standalone.publicationDate,
      publicationTitle: nullableText(item.standalone.venueName) ?? nullableText(item.standalone.journal),
      doi: nullableText(item.standalone.metadata.doi),
      url: item.standalone.sourceUrl,
      abstractNote: item.standalone.abstract,
      tags: [],
      extra: `Jadense favorite item: ${item.favoriteItemId}`,
    }
  }

  const doi = normalizeDoi(item.paper.links?.find((link) => link.type === "doi")?.url)
  const url = nullableText(item.paper.detailPageUrl) ?? item.paper.links?.find((link) => link.type === "doi")?.url ?? null
  return {
    itemType: "journalArticle",
    title: item.paper.title,
    creators: (item.paper.authors ?? []).flatMap((author) => {
      const name = text(author.name)
      return name ? [creatorFromName(name)] : []
    }),
    date: nullableText(item.paper.publishedAt),
    publicationTitle: nullableText(item.paper.journal?.name) ?? nullableText(item.paper.venue?.name),
    doi,
    url,
    abstractNote: nullableText(item.paper.abstract),
    tags: [],
    extra: [
      `Jadense article: ${item.articleId}`,
      item.paper.external_source && item.paper.external_id
        ? `Jadense source: ${item.paper.external_source}/${item.paper.external_id}`
        : null,
    ].filter(Boolean).join("\n"),
  }
}
