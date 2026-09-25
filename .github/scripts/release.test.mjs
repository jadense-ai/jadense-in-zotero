/** 发布回归在临时 Git 仓库和假 gh 上执行，不创建远程标签、Release 或上传文件。 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import process from "node:process"
import path from "node:path"
import { test } from "node:test"
import { createDraftRelease, resolveRelease } from "./release.mjs"
import { summaryVersions } from "./check-docs.mjs"

test("source sync accepts unreleased versions while release branches retain naming checks", () => {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  const check = (branch) => execFileSync(process.execPath, ['.github/scripts/check-docs.mjs'], {
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_HEAD_REF: branch },
    stdio: 'pipe', windowsHide: true,
  })
  assert.doesNotThrow(() => check('sync-upstream'))
  assert.doesNotThrow(() => check(`v${version}`))
  assert.throws(() => check('release-upstream'))
  assert.throws(() => check('v999.999.999'))
})

test("README release summaries reject excess, duplicates and mismatched links", () => {
  const summary = (tags) => `<!-- release-summary:start -->\n${tags.map(tag => `- [${tag}](https://github.com/jadense-ai/jadense-in-zotero/releases/tag/${tag}) — Update`).join('\n')}\n<!-- release-summary:end -->`
  assert.deepEqual(summaryVersions(summary(['v1.0.0', 'v0.9.0'])), ['v1.0.0', 'v0.9.0'])
  for (const tags of [[], ['v1.0.0', 'v1.0.0'], ['v0.9.0', 'v1.0.0'], ['v1.0.0', 'v0.9.0', 'v0.8.0', 'v0.7.0', 'v0.6.0', 'v0.5.0']]) assert.throws(() => summaryVersions(summary(tags)))
  assert.throws(() => summaryVersions(summary(['v1.0.0']).replace('/tag/v1.0.0', '/tag/v2.0.0')))
})

/** 只清理本测试创建的临时目录。 */
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zotero-release-test-"))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith("zotero-release-test-"))
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

test("tag source and version guards use actual Git history", (t) => {
  const cwd = fixture(t)
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true })
  git("init", "--initial-branch=main")
  git("config", "user.name", "Release fixture")
  git("config", "user.email", "release@example.invalid")
  git("config", "commit.gpgsign", "false")
  writeFileSync(path.join(cwd, "package.json"), '{"version":"0.3.1"}\n')
  git("add", "package.json")
  git("commit", "-m", "fixture")
  git("update-ref", "refs/remotes/origin/main", "HEAD")
  const env = { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.3.1" }
  assert.equal(resolveRelease({ cwd, env }), "release/zotero/v0.3.1")
  for (const tag of ["v0.3.2", "v0.3.1-beta.1", "0.3.1", "v0.3.1\n"]) {
    assert.throws(() => resolveRelease({ cwd, env: { ...env, GITHUB_REF_NAME: tag } }), /Tag must match/)
  }
  git("checkout", "-b", "unmerged")
  git("commit", "--allow-empty", "-m", "unmerged")
  assert.throws(() => resolveRelease({ cwd, env }), /must belong to origin\/main/)
  assert.equal(resolveRelease({ cwd, env: { GITHUB_REF_TYPE: "branch" } }), "release/zotero/v0.3.1")
  writeFileSync(path.join(cwd, "package.json"), '{"version":"0.3.1-beta.1"}')
  assert.throws(() => resolveRelease({ cwd, env }), /Only stable/)
})

/** 三个制品文件与最小 GitHub 事件；附加元数据不影响完整性字段的校验。 */
function releaseFixture(t) {
  const directory = fixture(t)
  const artifactName = "jadense-in-zotero-v0.3.1.xpi"
  const bytes = "synthetic XPI bytes; ZIP structure is checked by release:verify"
  const digest = createHash("sha256").update(bytes).digest("hex")
  writeFileSync(path.join(directory, artifactName), bytes)
  writeFileSync(path.join(directory, "SHA256SUMS"), `${digest}  ${artifactName}\n`)
  writeFileSync(path.join(directory, "release-metadata.json"), JSON.stringify({
    version: "0.3.1", artifactName, artifactSha256: digest, artifactSizeBytes: bytes.length, additiveField: true,
  }))
  const assets = {xpi: {file: artifactName, size: bytes.length, sha256: digest}}
  for (const [kind, file] of Object.entries({offline: 'jadense-in-zotero-v0.3.1-windows-x64-offline.zip', 'pdf-translation': 'jadense-pdf-engine-1-windows-x64.zip', ocr: 'jadense-ocr-engine-1-windows-x64.zip'})) {
    writeFileSync(path.join(directory, file), bytes)
    assets[kind] = {file, size: bytes.length, sha256: digest, additive: true}
  }
  writeFileSync(path.join(directory, 'distribution-metadata.json'), JSON.stringify({version: '0.3.1', assets, additive: true}))
  writeFileSync(path.join(directory, 'DISTRIBUTION-SHA256SUMS'), Object.values(assets).map(entry => `${entry.sha256}  ${entry.file}\n`).join(''))
  const env = { GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.3.1", GH_REPO: "fixture/plugin" }
  return { directory, env }
}

test("verified artifacts create one draft with user-facing notes and no publishing/overwrite command", (t) => {
  const input = releaseFixture(t)
  const calls = []
  createDraftRelease({ ...input, gh: (args, stdin) => { calls.push({ args, stdin }); return "v0.3.0\n" } })
  assert.equal(calls.length, 2)
  assert.ok(calls[0].args.includes("--paginate"))
  const { args, stdin } = calls[1]
  assert.deepEqual(args.slice(0, 3), ["release", "create", "v0.3.1"])
  assert.deepEqual(args.slice(3, 6).map((file) => path.basename(file)), ["jadense-in-zotero-v0.3.1.xpi", "release-metadata.json", "SHA256SUMS"])
  for (const name of ['jadense-in-zotero-v0.3.1-windows-x64-offline.zip', 'jadense-pdf-engine-1-windows-x64.zip', 'jadense-ocr-engine-1-windows-x64.zip', 'distribution-metadata.json', 'DISTRIBUTION-SHA256SUMS']) assert.ok(args.some(arg => path.basename(arg) === name))
  for (const flag of ["--verify-tag", "--draft"]) assert.ok(args.includes(flag))
  assert.equal(args[args.indexOf("--title") + 1], "v0.3.1");
  assert.ok(!args.includes("--generate-notes"));
  assert.deepEqual(args.slice(-2), ["--notes-file", "-"])
  assert.deepEqual([...stdin.matchAll(/^## .+$/gm)].map((match) => match[0]), ["## 本次更新", "## What's new", "## 操作与配置", "## 升级与兼容", "## 验证与下载"])
  assert.match(stdin, /smoke:installed/)
  assert.match(stdin, /smoke:research/)
  assert.ok(!args.includes("--clobber"))
})

test("bad hashes, metadata, unsupported tags and non-tag events cannot reach GitHub", (t) => {
  for (const scenario of ["checksum", "metadata", "beta", "manual", "pull-request", "missing-zip", "corrupt-zip", "wrong-version", "path-traversal", "distribution-checksum"]) {
    const input = releaseFixture(t)
    if (scenario === "checksum") writeFileSync(path.join(input.directory, "SHA256SUMS"), "wrong")
    if (scenario === "metadata") {
      const file = path.join(input.directory, "release-metadata.json")
      const metadata = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(file, JSON.stringify({ ...metadata, artifactSha256: "wrong" }))
    }
    if (scenario === "beta") input.env.GITHUB_REF_NAME = "v0.3.1-rc.1"
    if (scenario === "manual") input.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    if (scenario === "pull-request") input.env.GITHUB_EVENT_NAME = "pull_request"
    if (scenario === 'missing-zip') rmSync(path.join(input.directory, 'jadense-in-zotero-v0.3.1-windows-x64-offline.zip'))
    if (scenario === 'corrupt-zip') writeFileSync(path.join(input.directory, 'jadense-ocr-engine-1-windows-x64.zip'), 'corrupt')
    if (scenario === 'distribution-checksum') writeFileSync(path.join(input.directory, 'DISTRIBUTION-SHA256SUMS'), 'wrong')
    if (['wrong-version', 'path-traversal'].includes(scenario)) {
      const file = path.join(input.directory, 'distribution-metadata.json')
      const metadata = JSON.parse(readFileSync(file, 'utf8'))
      if (scenario === 'wrong-version') metadata.version = '0.3.0'
      else metadata.assets.ocr.file = '../escape.zip'
      writeFileSync(file, JSON.stringify(metadata))
    }
    let calls = 0
    assert.throws(() => createDraftRelease({ ...input, gh: () => { calls++; return "" } }))
    assert.equal(calls, 0, scenario)
  }
})

test("existing release or failed lookup prevents creation; failed creation is never retried", (t) => {
  for (const scenario of ["exists", "lookup-failure", "create-failure"]) {
    const input = releaseFixture(t)
    const calls = []
    const gh = (args) => {
      calls.push(args)
      if (scenario === "exists") return "v0.3.0\nv0.3.1\n"
      if (scenario === "lookup-failure" || args[0] === "release") throw new Error("simulated gh failure")
      return ""
    }
    assert.throws(() => createDraftRelease({ ...input, gh }), scenario === "exists" ? /already exists/ : /simulated gh failure/)
    assert.equal(calls.length, scenario === "create-failure" ? 2 : 1)
  }
})
