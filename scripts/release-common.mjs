/** 发布共用事实：由包版本与 release-facts 生成 XPI 路径、manifest、摘要及校验清单。 */
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_STRICT_MAX_VERSION = "*"
const DEFAULT_BUILD_MODE = "production"
const DEFAULT_ZIP_ENTRY_TIMESTAMP = "1980-01-01T00:00:00.000Z"

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const buildDir = join(projectRoot, "build")
export const generatedManifestPath = join(projectRoot, "manifest.json")
export const releaseFactsPath = join(projectRoot, "release-facts.json")
export const packageJsonPath = join(projectRoot, "package.json")

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

export function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value.trim()
}

function requireHttpsUrl(value, label) {
  const url = requireString(value, label)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label} must be an HTTPS URL.`)
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must be an HTTPS URL.`)
  }
  return url
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function requireManifestVersion(value) {
  if (value !== 2) {
    throw new Error("release-facts.json manifest.manifest_version must be 2 for Zotero.")
  }
  return value
}

function optionalManifestIcons(value) {
  if (value === undefined || value === null) return null
  const icons = requireObject(value, "release-facts.json manifest.icons")
  const normalized = {}
  for (const [size, iconPath] of Object.entries(icons)) {
    normalized[requireString(size, "release-facts.json manifest.icons size")] = requireString(
      iconPath,
      `release-facts.json manifest.icons["${size}"]`,
    )
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

function releaseConfig(facts) {
  return requireObject(facts.release, "release-facts.json release")
}

function zoteroManifestFacts(facts) {
  const manifest = requireObject(facts.manifest, "release-facts.json manifest")
  const applications = requireObject(manifest.applications, "release-facts.json manifest.applications")
  return requireObject(applications.zotero, "release-facts.json manifest.applications.zotero")
}

export async function loadReleaseContext() {
  const [facts, packageJson] = await Promise.all([
    readJson(releaseFactsPath),
    readJson(packageJsonPath),
  ])
  const version = requireString(packageJson.version, "package.json version")
  const manifest = buildManifest(facts, version)
  return { facts, packageJson, version, manifest }
}

export function buildManifest(facts, version) {
  const sourceManifest = requireObject(facts.manifest, "release-facts.json manifest")
  const zotero = zoteroManifestFacts(facts)
  const icons = optionalManifestIcons(sourceManifest.icons)
  return {
    manifest_version: requireManifestVersion(sourceManifest.manifest_version),
    name: requireString(sourceManifest.name, "release-facts.json manifest.name"),
    version: requireString(version, "package.json version"),
    description: requireString(sourceManifest.description, "release-facts.json manifest.description"),
    homepage_url: requireString(sourceManifest.homepage_url, "release-facts.json manifest.homepage_url"),
    ...(icons ? { icons } : {}),
    applications: {
      zotero: {
        id: requireString(zotero.id, "release-facts.json manifest.applications.zotero.id"),
        update_url: requireHttpsUrl(
          zotero.update_url,
          "release-facts.json manifest.applications.zotero.update_url",
        ),
        strict_min_version: requireString(
          zotero.strict_min_version,
          "release-facts.json manifest.applications.zotero.strict_min_version",
        ),
        strict_max_version: optionalString(zotero.strict_max_version) ?? DEFAULT_STRICT_MAX_VERSION,
      },
    },
  }
}

function resolveProjectRelativePath(projectRelativePath, label) {
  const normalizedParts = requireString(projectRelativePath, label)
    .split(/[\\/]+/g)
    .filter(Boolean)
  if (isAbsolute(projectRelativePath) || normalizedParts.includes("..")) {
    throw new Error(`${label} must stay inside the extension package.`)
  }
  return join(projectRoot, ...normalizedParts)
}

export function toPosixPath(value) {
  return value.split(sep).join("/")
}

export function buildReleasePaths(facts, version) {
  const release = releaseConfig(facts)
  const outputRoot = resolveProjectRelativePath(release.output_dir, "release-facts.json release.output_dir")
  const artifactSlug = requireString(release.artifact_slug, "release-facts.json release.artifact_slug")
  const versionDir = join(outputRoot, `v${version}`)
  const artifactName = `${artifactSlug}-v${version}.xpi`
  const artifactPath = join(versionDir, artifactName)
  const metadataPath = join(versionDir, "release-metadata.json")
  const checksumPath = join(versionDir, "SHA256SUMS")
  return {
    versionDir,
    artifactName,
    artifactPath,
    artifactRelativePath: toPosixPath(relative(projectRoot, artifactPath)),
    metadataPath,
    metadataRelativePath: toPosixPath(relative(projectRoot, metadataPath)),
    checksumPath,
    checksumRelativePath: toPosixPath(relative(projectRoot, checksumPath)),
  }
}

export function resolveBuildMode(facts, env = process.env) {
  const release = releaseConfig(facts)
  return optionalString(env.JADENSE_ZOTERO_BUILD_MODE)
    ?? optionalString(env.npm_config_build_mode)
    ?? optionalString(release.default_build_mode)
    ?? DEFAULT_BUILD_MODE
}

export function resolveBuiltAt(env = process.env) {
  const explicit = optionalString(env.JADENSE_ZOTERO_RELEASE_BUILT_AT)
  if (explicit) return normalizeIsoTimestamp(explicit, "JADENSE_ZOTERO_RELEASE_BUILT_AT")

  const sourceDateEpoch = optionalString(env.SOURCE_DATE_EPOCH)
  if (sourceDateEpoch) {
    const epochSeconds = Number(sourceDateEpoch)
    if (!Number.isFinite(epochSeconds)) {
      throw new Error("SOURCE_DATE_EPOCH must be a finite Unix timestamp in seconds.")
    }
    return new Date(epochSeconds * 1000).toISOString()
  }

  return new Date().toISOString()
}

export function zipEntryDate(facts) {
  const release = releaseConfig(facts)
  return new Date(normalizeIsoTimestamp(
    optionalString(release.zip_entry_timestamp) ?? DEFAULT_ZIP_ENTRY_TIMESTAMP,
    "release-facts.json release.zip_entry_timestamp",
  ))
}

function normalizeIsoTimestamp(value, label) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date timestamp.`)
  }
  return date.toISOString()
}

export async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(rootDir, fullPath))
    } else if (entry.isFile()) {
      files.push({
        fullPath,
        archivePath: toPosixPath(relative(rootDir, fullPath)),
      })
    }
  }
  return files.sort((a, b) => a.archivePath.localeCompare(b.archivePath))
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

/** 将实际 XPI 字节与发布文件名写成 sha256sum --check 可读取的一行。 */
export function buildArtifactChecksum(artifactBuffer, artifactName) {
  return `${sha256(artifactBuffer)}  ${artifactName}\n`
}

export function manifestSummary(manifest) {
  const zotero = manifest.applications.zotero
  return {
    manifestVersion: manifest.manifest_version,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    homepageUrl: manifest.homepage_url,
    zotero: {
      id: zotero.id,
      updateUrl: zotero.update_url,
      strictMinVersion: zotero.strict_min_version,
      strictMaxVersion: zotero.strict_max_version,
    },
  }
}

export function compatibilitySummary(manifest) {
  const zotero = manifest.applications.zotero
  return {
    zotero: {
      strictMinVersion: zotero.strict_min_version,
      strictMaxVersion: zotero.strict_max_version,
    },
  }
}

export function buildReleaseMetadata(input) {
  const {
    manifest,
    version,
    releasePaths,
    artifactBuffer,
    buildMode,
    builtAt,
    bundledFiles,
  } = input
  const zotero = manifest.applications.zotero
  return {
    version,
    addOnId: zotero.id,
    compatibility: compatibilitySummary(manifest),
    artifactPath: releasePaths.artifactRelativePath,
    artifactName: releasePaths.artifactName,
    artifactSizeBytes: artifactBuffer.byteLength,
    artifactSha256: sha256(artifactBuffer),
    buildMode,
    builtAt,
    bundledFiles,
    manifest: manifestSummary(manifest),
  }
}
