/** 发布事实回归：验证宿主身份不漂移，以及对外 SHA 清单使用实际制品字节和文件名。 */
import { describe, expect, it } from "vitest"

import { buildArtifactChecksum, buildManifest, buildReleasePaths } from "../../scripts/release-common.mjs"

function releaseFacts(overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      manifest_version: 2,
      name: "Jadense in Zotero",
      description: "Sync literature metadata between Zotero and Jadense favorites.",
      homepage_url: "https://jadense.cn",
      applications: {
        zotero: {
          id: "jadense-in-zotero@jadense.cn",
          update_url: "https://jadense.cn/plugins/zotero/jadense-in-zotero/updates.json",
          strict_min_version: "8.0",
          strict_max_version: "*",
          ...overrides,
        },
      },
    },
  }
}

describe("buildManifest", () => {
  it("keeps Zotero install metadata under applications.zotero", () => {
    expect(buildManifest(releaseFacts(), "0.1.1")).toMatchObject({
      version: "0.1.1",
      applications: {
        zotero: {
          id: "jadense-in-zotero@jadense.cn",
          update_url: "https://jadense.cn/plugins/zotero/jadense-in-zotero/updates.json",
          strict_min_version: "8.0",
          strict_max_version: "*",
        },
      },
    })
  })

  it("rejects missing Zotero update_url values", () => {
    expect(() => buildManifest(releaseFacts({ update_url: undefined }), "0.1.0")).toThrow(
      "release-facts.json manifest.applications.zotero.update_url must be a non-empty string.",
    )
  })

  it("rejects non-HTTPS Zotero update_url values", () => {
    expect(() => buildManifest(releaseFacts({ update_url: "http://jadense.cn/updates.json" }), "0.1.0")).toThrow(
      "release-facts.json manifest.applications.zotero.update_url must be an HTTPS URL.",
    )
  })

  it("rejects malformed Zotero update_url values", () => {
    expect(() => buildManifest(releaseFacts({ update_url: "https://" }), "0.1.0")).toThrow(
      "release-facts.json manifest.applications.zotero.update_url must be an HTTPS URL.",
    )
  })

  it("passes through manifest icons for the add-on manager", () => {
    const facts = releaseFacts()
    facts.manifest = {
      ...facts.manifest,
      icons: { 48: "content/icons/logo-padded.png" },
    } as typeof facts.manifest

    expect(buildManifest(facts, "0.1.1")).toMatchObject({
      icons: { 48: "content/icons/logo-padded.png" },
    })
    expect(buildManifest(releaseFacts(), "0.1.1")).not.toHaveProperty("icons")
  })
})

describe("release checksum", () => {
  it("emits the standard SHA-256 checksum and puts the manifest beside the versioned XPI", () => {
    const paths = buildReleasePaths({ release: {
      output_dir: "release/zotero",
      artifact_slug: "jadense-in-zotero",
    } }, "0.3.1")
    expect(paths.checksumRelativePath).toBe("release/zotero/v0.3.1/SHA256SUMS")
    expect(buildArtifactChecksum(Buffer.from("abc"), paths.artifactName)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  jadense-in-zotero-v0.3.1.xpi\n",
    )
    expect(buildArtifactChecksum(Buffer.from("abd"), paths.artifactName)).not.toBe(
      buildArtifactChecksum(Buffer.from("abc"), paths.artifactName),
    )
  })
})
