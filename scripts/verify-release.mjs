/** 对照发布事实与源码许可文本核验实际 XPI、元数据及 SHA256SUMS，避免发布不完整制品。 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import JSZip from "jszip"

import {
  buildArtifactChecksum,
  buildDir,
  buildReleaseMetadata,
  buildReleasePaths,
  generatedManifestPath,
  loadReleaseContext,
  projectRoot,
  readJson,
  resolveBuildMode,
  sha256,
} from "./release-common.mjs"

const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

function checkDeep(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) {
    failures.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function readRequiredJson(filePath, label) {
  if (!existsSync(filePath)) {
    failures.push(`${label} is missing at ${filePath}.`)
    return null
  }
  try {
    return await readJson(filePath)
  } catch (error) {
    failures.push(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function isValidIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function failIfNeeded() {
  if (failures.length > 0) {
    throw new Error(`Release verification failed:\n- ${failures.join("\n- ")}`)
  }
}

const { facts, version, manifest: expectedManifest } = await loadReleaseContext()
const releasePaths = buildReleasePaths(facts, version)

if (!existsSync(releasePaths.artifactPath)) {
  failures.push(`XPI artifact is missing at ${releasePaths.artifactRelativePath}.`)
  failIfNeeded()
}

const artifactBuffer = await readFile(releasePaths.artifactPath)
const zip = await JSZip.loadAsync(artifactBuffer)
const bundledFiles = Object.values(zip.files)
  .filter((file) => !file.dir)
  .map((file) => file.name)
  .sort((a, b) => a.localeCompare(b))

check(bundledFiles.includes("manifest.json"), "XPI is missing root manifest.json.")
check(bundledFiles.includes("bootstrap.js"), "XPI is missing root bootstrap.js.")
check(bundledFiles.includes("content/preferences.xhtml"), "XPI is missing Preferences pane XHTML.")
check(bundledFiles.includes("content/preferences.css"), "XPI is missing Preferences pane CSS.")
check(bundledFiles.includes("content/preferences.js"), "XPI is missing Preferences pane script.")
check(bundledFiles.includes("content/manager.xhtml"), "XPI is missing Jadense Manager XHTML.")
check(bundledFiles.includes("content/manager.css"), "XPI is missing Jadense Manager CSS.")
check(bundledFiles.includes("content/ui.css"), "XPI is missing shared UI CSS.")
check(bundledFiles.includes("content/analysis.css"), "XPI is missing literature analysis CSS.")
check(bundledFiles.includes("content/manager.js"), "XPI is missing Jadense Manager script.")
check(bundledFiles.includes("locale/en-US/jadense-in-zotero.ftl"), "XPI is missing en-US Fluent strings.")
check(bundledFiles.includes("locale/zh-CN/jadense-in-zotero.ftl"), "XPI is missing zh-CN Fluent strings.")
check(bundledFiles.includes("_locales/en/messages.json"), "XPI is missing English manifest strings.")
check(bundledFiles.includes("_locales/zh/messages.json"), "XPI is missing Chinese manifest strings.")
check(bundledFiles.includes("icons/jadense-16.svg"), "XPI is missing item pane header icon.")
check(bundledFiles.includes("icons/jadense-20.svg"), "XPI is missing item pane sidenav icon.")
check(bundledFiles.includes("content/icons/logo-padded.png"), "XPI is missing Jadense brand logo.")
for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  const entry = zip.file(fileName)
  check(Boolean(entry), `XPI is missing ${fileName}.`)
  if (entry) {
    check((await entry.async("nodebuffer")).equals(await readFile(path.join(projectRoot, fileName))),
      `XPI ${fileName} does not match the source license text.`)
  }
}
if (existsSync(releasePaths.checksumPath)) {
  checkDeep(await readFile(releasePaths.checksumPath, "utf8"),
    buildArtifactChecksum(artifactBuffer, releasePaths.artifactName), "SHA256SUMS does not match the XPI")
} else {
  failures.push(`SHA256SUMS is missing at ${releasePaths.checksumRelativePath}.`)
}
for (const fileName of bundledFiles) {
  check(!fileName.startsWith("/"), `XPI entry must be relative: ${fileName}`)
  check(!fileName.split("/").includes(".."), `XPI entry must not traverse directories: ${fileName}`)
}

// 按 XPI 内的实际字节核对资源地址，防止热升级后的 Manager 继续命中旧版 CSS/JS。
const managerEntry = zip.file("content/manager.xhtml")
if (managerEntry) {
  const managerHtml = await managerEntry.async("string")
  for (const [attribute, fileName] of [["href", "manager.css"], ["href", "ui.css"], ["href", "analysis.css"], ["src", "manager.js"]]) {
    const resource = zip.file(`content/${fileName}`)
    if (!resource) continue
    const revision = sha256(await resource.async("nodebuffer")).slice(0, 12)
    check(managerHtml.includes(`${attribute}="${fileName}?v=${revision}"`),
      `Manager ${fileName} reference must include its bundled content hash (${revision}).`)
  }
}

const manifestEntry = zip.file("manifest.json")
let xpiManifest = null
if (manifestEntry) {
  try {
    xpiManifest = JSON.parse(await manifestEntry.async("string"))
  } catch (error) {
    failures.push(`XPI manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (xpiManifest) {
  checkDeep(xpiManifest, expectedManifest, "XPI manifest does not match release facts and package version")
}

const generatedManifest = await readRequiredJson(generatedManifestPath, "Generated manifest.json")
if (generatedManifest) {
  checkDeep(generatedManifest, expectedManifest, "Generated manifest.json does not match release facts and package version")
}

const buildManifest = await readRequiredJson(path.join(buildDir, "manifest.json"), "Build manifest.json")
if (buildManifest) {
  checkDeep(buildManifest, expectedManifest, "Build manifest.json does not match release facts and package version")
}

const metadata = await readRequiredJson(releasePaths.metadataPath, "release-metadata.json")
if (metadata) {
  const expectedMetadata = buildReleaseMetadata({
    manifest: expectedManifest,
    version,
    releasePaths,
    artifactBuffer,
    buildMode: resolveBuildMode(facts),
    builtAt: metadata.builtAt,
    bundledFiles,
  })
  checkDeep(metadata.version, expectedMetadata.version, "Metadata version drifted")
  checkDeep(metadata.addOnId, expectedMetadata.addOnId, "Metadata add-on id drifted")
  checkDeep(metadata.compatibility, expectedMetadata.compatibility, "Metadata compatibility drifted")
  checkDeep(metadata.artifactPath, expectedMetadata.artifactPath, "Metadata artifact path drifted")
  checkDeep(metadata.artifactName, expectedMetadata.artifactName, "Metadata artifact name drifted")
  checkDeep(metadata.artifactSizeBytes, artifactBuffer.byteLength, "Metadata artifact byte size drifted")
  checkDeep(metadata.artifactSha256, sha256(artifactBuffer), "Metadata artifact sha256 drifted")
  checkDeep(metadata.buildMode, expectedMetadata.buildMode, "Metadata build mode drifted")
  check(isValidIsoTimestamp(metadata.builtAt), "Metadata builtAt must be an ISO timestamp.")
  checkDeep(metadata.bundledFiles, bundledFiles, "Metadata bundled files drifted")
  checkDeep(metadata.manifest, expectedMetadata.manifest, "Metadata manifest summary drifted")
}

failIfNeeded()

console.log(`Verified ${releasePaths.artifactRelativePath}`)
console.log(`Bundled files: ${bundledFiles.join(", ")}`)
