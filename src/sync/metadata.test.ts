import { describe, expect, it } from "vitest"

import {
  jadenseFavoriteToZoteroDraft,
  zoteroItemToJadenseImportItem,
} from "./metadata"

describe("Zotero/Jadense metadata mapping", () => {
  it("maps Zotero DOI items into Jadense metadata imports", () => {
    const mapped = zoteroItemToJadenseImportItem({
      libraryKey: "L1",
      itemKey: "I1",
      itemType: "journalArticle",
      title: " Attention Is All You Need ",
      creators: [
        { firstName: "Ashish", lastName: "Vaswani", creatorType: "author" },
        { name: "Noam Shazeer", creatorType: "author" },
      ],
      date: "2017",
      publicationTitle: "NeurIPS",
      doi: "https://doi.org/10.48550/arXiv.1706.03762",
      url: "https://arxiv.org/abs/1706.03762",
      abstractNote: "Transformer paper",
      tags: [{ tag: "LLM" }],
      extra: "arXiv:1706.03762",
    })

    expect(mapped).toEqual({
      clientItemId: "zotero:L1/I1",
      metadata: expect.objectContaining({
        doi: "10.48550/arxiv.1706.03762",
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        venueName: "NeurIPS",
        publicationDate: "2017",
        abstract: "Transformer paper",
        canonicalUrl: "https://arxiv.org/abs/1706.03762",
        externalSource: "arxiv",
        externalId: "1706.03762",
        sourceMetadata: {
          zotero: {
            libraryKey: "L1",
            itemKey: "I1",
            itemType: "journalArticle",
            tags: ["LLM"],
            extra: "arXiv:1706.03762",
            collectionPaths: [],
          },
        },
      }),
    })
  })

  it("maps CNKI source identity before treating DOI as the only identifier", () => {
    const mapped = zoteroItemToJadenseImportItem({
      libraryKey: "L1",
      itemKey: "CNKI1",
      itemType: "journalArticle",
      title: "CNKI paper",
      creators: [],
      doi: "10.1000/cnki-paper",
      url: "https://kns.cnki.net/kcms2/article/abstract?v=1&dbcode=CJFD&filename=LKXB202501001",
      extra: "",
    })

    expect(mapped.metadata).toMatchObject({
      doi: "10.1000/cnki-paper",
      externalSource: "cnki",
      externalId: "CJFD/LKXB202501001",
    })
  })

  it("keeps unknown Zotero-only items as source metadata instead of public source identity", () => {
    const mapped = zoteroItemToJadenseImportItem({
      libraryKey: "Library-A",
      itemKey: "Item-42",
      itemType: "journalArticle",
      title: "Local working paper",
      creators: [],
      url: "https://example.com/local-paper",
      extra: "Imported from a private bibliography",
      collectionPaths: ["Root / Child"],
    })

    expect(mapped.metadata).toMatchObject({
      doi: null,
      externalSource: null,
      externalId: null,
      sourceMetadata: {
        zotero: {
          libraryKey: "Library-A",
          itemKey: "Item-42",
          collectionPaths: ["Root / Child"],
        },
      },
    })
  })

  it("maps standalone Jadense favorites into Zotero item drafts", () => {
    const draft = jadenseFavoriteToZoteroDraft({
      itemKind: "standalone",
      favoriteItemId: "fav-1",
      standalone: {
        title: "Standalone thesis",
        authors: ["Ada Lovelace"],
        venueName: "University Archive",
        publicationDate: "1843",
        abstract: "No DOI",
        sourceUrl: "https://example.com/thesis",
        metadata: { doi: null },
      },
    })

    expect(draft).toEqual({
      itemType: "journalArticle",
      title: "Standalone thesis",
      creators: [{ creatorType: "author", name: "Ada Lovelace" }],
      date: "1843",
      publicationTitle: "University Archive",
      doi: null,
      url: "https://example.com/thesis",
      abstractNote: "No DOI",
      tags: [],
      extra: "Jadense favorite item: fav-1",
    })
  })

  it("maps linked Jadense papers into Zotero item drafts without PDF assumptions", () => {
    const draft = jadenseFavoriteToZoteroDraft({
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
    })

    expect(draft).toMatchObject({
      itemType: "journalArticle",
      title: "Linked paper",
      creators: [{ creatorType: "author", name: "Grace Hopper" }],
      doi: "10.1000/test",
      url: "https://example.com/paper",
      extra: "Jadense article: paper-1\nJadense source: crossref/10.1000/test",
    })
  })
})
