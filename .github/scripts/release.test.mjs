/** 发布回归在临时 Git 仓库和假 gh 上执行，不创建远程标签、Release 或上传文件。 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createDraftRelease, resolveRelease } from "./release.mjs"

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
  const env = { GITHUB_EVENT_NAME: "push", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.3.1", GH_REPO: "fixture/plugin" }
  return { directory, env }
}

test("verified artifacts create one draft with generated notes and no publishing/overwrite command", (t) => {
  const input = releaseFixture(t)
  const calls = []
  createDraftRelease({ ...input, gh: (args, stdin) => { calls.push({ args, stdin }); return "v0.3.0\n" } })
  assert.equal(calls.length, 2)
  assert.ok(calls[0].args.includes("--paginate"))
  const { args, stdin } = calls[1]
  assert.deepEqual(args.slice(0, 3), ["release", "create", "v0.3.1"])
  assert.deepEqual(args.slice(3, 6).map((file) => path.basename(file)), ["jadense-in-zotero-v0.3.1.xpi", "release-metadata.json", "SHA256SUMS"])
  for (const flag of ["--verify-tag", "--draft", "--generate-notes"]) assert.ok(args.includes(flag))
  assert.deepEqual(args.slice(-2), ["--notes-file", "-"])
  assert.match(stdin, /smoke:installed/)
  assert.match(stdin, /smoke:research/)
  assert.ok(!args.includes("--clobber"))
})

test("bad hashes, metadata, unsupported tags and non-tag events cannot reach GitHub", (t) => {
  for (const scenario of ["checksum", "metadata", "beta", "manual", "pull-request"]) {
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
