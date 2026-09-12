/** 从插件源码构建 XPI，附完整许可文本，并输出同一制品的元数据与 SHA-256 清单。 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { build } from "esbuild"
import JSZip from "jszip"

import {
  buildArtifactChecksum,
  buildDir,
  buildReleaseMetadata,
  buildReleasePaths,
  generatedManifestPath,
  listFiles,
  loadReleaseContext,
  projectRoot,
  resolveBuildMode,
  resolveBuiltAt,
  sha256,
  stringifyJson,
  zipEntryDate,
} from "./release-common.mjs"

const { facts, version, manifest } = await loadReleaseContext()
const releasePaths = buildReleasePaths(facts, version)
await rm(buildDir, { recursive: true, force: true })
await rm(releasePaths.versionDir, { recursive: true, force: true })
await mkdir(buildDir, { recursive: true })
await mkdir(releasePaths.versionDir, { recursive: true })

for (const directory of ["content", "locale", "_locales", "icons"]) {
  await cp(path.join(projectRoot, directory), path.join(buildDir, directory), { recursive: true })
}

// 使用插件仓库内的品牌素材，开源仓库可独立安装依赖并构建发行包。
const logos = JSON.parse(await readFile(path.join(projectRoot, "model-logos/catalog.json"), "utf8"))
await mkdir(path.join(buildDir, "content/model-logos"), { recursive: true })
for (const logo of logos) await cp(path.join(projectRoot, logo.src), path.join(buildDir, "content/model-logos", path.basename(logo.src)))

// Bundle 不保留零散许可证注释；完整原文随每份 XPI 分发。
for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(path.join(projectRoot, fileName), path.join(buildDir, fileName))
}

await build({
  entryPoints: [path.join(projectRoot, "src/bootstrap.ts")],
  outfile: path.join(buildDir, "bootstrap.js"),
  bundle: true,
  format: "iife",
  target: "firefox140",
  sourcemap: false,
  legalComments: "none",
})

await build({
  entryPoints: [path.join(projectRoot, "src/zotero/preferences-page.ts")],
  outfile: path.join(buildDir, "content/preferences.js"),
  bundle: true,
  format: "iife",
  target: "firefox140",
  sourcemap: false,
  legalComments: "none",
})

await build({
  entryPoints: [path.join(projectRoot, "src/zotero/manager-page.ts")],
  outfile: path.join(buildDir, "content/manager.js"),
  bundle: true,
  format: "iife",
  target: "firefox140",
  sourcemap: false,
  legalComments: "none",
})

// Chrome 样式缓存按资源地址复用；内容摘要让热升级和同版本重建都加载匹配的 CSS/JS。
const managerHtmlPath = path.join(buildDir, "content/manager.xhtml")
let managerHtml = await readFile(managerHtmlPath, "utf8")
for (const fileName of ["manager.css", "ui.css", "chat.css", "analysis.css", "manager.js"]) {
  const revision = sha256(await readFile(path.join(buildDir, "content", fileName))).slice(0, 12)
  managerHtml = managerHtml.replace(`"${fileName}"`, `"${fileName}?v=${revision}"`)
}
await writeFile(managerHtmlPath, managerHtml)

const manifestJson = stringifyJson(manifest)
await writeFile(generatedManifestPath, manifestJson)
await writeFile(path.join(buildDir, "manifest.json"), manifestJson)

const zip = new JSZip()
const zipDate = zipEntryDate(facts)
const bundled = await listFiles(buildDir)
for (const file of bundled) {
  zip.file(file.archivePath, await readFile(file.fullPath), { date: zipDate })
}

const xpi = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
  platform: "UNIX",
})
await writeFile(releasePaths.artifactPath, xpi)
await writeFile(releasePaths.checksumPath, buildArtifactChecksum(xpi, releasePaths.artifactName))

const metadata = buildReleaseMetadata({
  manifest,
  version,
  releasePaths,
  artifactBuffer: xpi,
  buildMode: resolveBuildMode(facts),
  builtAt: resolveBuiltAt(),
  bundledFiles: bundled.map((file) => file.archivePath),
})
await writeFile(releasePaths.metadataPath, stringifyJson(metadata))

console.log(`Built ${releasePaths.artifactRelativePath}`)
console.log(`Metadata ${releasePaths.metadataRelativePath}`)
console.log(`Checksums ${releasePaths.checksumRelativePath}`)
