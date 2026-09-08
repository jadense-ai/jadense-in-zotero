/** GitHub 发布边界：验证标签来源及已构建制品，只创建草稿；不接触插件运行或官网发布。 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const NOTES = `## 发布验收（公开前由维护者填写）

- 实测 Zotero 版本：待填写；操作系统及版本：待填写。
- 兼容范围、功能限制与升级注意事项：待填写。
- [ ] 已下载本草稿的 XPI，并核对 SHA256SUMS。
- [ ] smoke:installed 三次冷启动通过。
- [ ] smoke:research 通过，使用临时 profile、合成数据及模拟接口。
- [ ] 已从同插件身份的上一正式版验证升级；无适用版本时填写原因。
- [ ] 已补齐以上说明，确认所有附件齐全后人工公开。

正式发布后标签和附件不可修改；更换制品必须增加版本号。
`

/** 稳定版本用于制品路径和标签，禁止预发布及路径/输出注入取得发布身份。 */
function stableVersion(version) {
  if (typeof version !== "string" || !STABLE_VERSION.test(version)) {
    throw new Error("Only stable X.Y.Z versions are supported.")
  }
  return version
}

/** 从工作区版本解析制品目录；标签必须精确匹配且已包含在远端 main 历史中。 */
export function resolveRelease({ cwd = process.cwd(), env = process.env } = {}) {
  const version = stableVersion(JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).version)
  if (env.GITHUB_REF_TYPE === "tag") {
    if (env.GITHUB_REF_NAME !== `v${version}`) throw new Error("Tag must match package.json version (vX.Y.Z).")
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], {
        cwd, stdio: "pipe", windowsHide: true,
      })
    } catch {
      throw new Error("Release commit must belong to origin/main; fetch complete history before checking.")
    }
  }
  return `release/zotero/v${version}`
}

/** gh 使用参数数组及标准输入，不将标签、仓库或发布说明拼成 shell 代码。 */
function runGh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, windowsHide: true })
}

/** 校验同一次 CI 的实际 XPI 与元数据；只读查询成功且不存在同名 Release 才创建草稿。 */
export function createDraftRelease({ directory, env = process.env, gh = runGh }) {
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF_TYPE !== "tag") {
    throw new Error("Draft releases require a tag push; manual runs only verify.")
  }
  const tag = env.GITHUB_REF_NAME
  if (typeof tag !== "string" || !tag.startsWith("v")) throw new Error("A vX.Y.Z tag is required.")
  const version = stableVersion(tag.slice(1))
  const repository = env.GH_REPO
  if (!repository) throw new Error("GH_REPO is required.")
  const artifactName = `jadense-in-zotero-${tag}.xpi`
  const artifact = path.resolve(directory, artifactName)
  const metadataPath = path.resolve(directory, "release-metadata.json")
  const checksumsPath = path.resolve(directory, "SHA256SUMS")
  const bytes = readFileSync(artifact)
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (readFileSync(checksumsPath, "utf8").trim() !== `${digest}  ${artifactName}`) {
    throw new Error("SHA256SUMS does not match the release XPI.")
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
  if (metadata.version !== version || metadata.artifactName !== artifactName ||
      metadata.artifactSha256 !== digest || metadata.artifactSizeBytes !== bytes.length) {
    throw new Error("Release metadata does not match the release XPI.")
  }

  // 分页包含所有草稿及正式版本；查询失败直接停止，不能误判为不存在。
  const tags = gh(["api", `repos/${repository}/releases`, "--paginate", "--jq", ".[].tag_name"])
  if (tags.split(/\r?\n/).includes(tag)) {
    throw new Error(`Release ${tag} already exists. Keep its assets; repair drafts from the original run or use a new version.`)
  }
  gh([
    "release", "create", tag, artifact, metadataPath, checksumsPath,
    "--repo", repository, "--verify-tag", "--draft", "--generate-notes",
    "--title", `Jadense in Zotero ${tag}`, "--notes-file", "-",
  ], NOTES)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "resolve") {
      const directory = resolveRelease()
      appendFileSync(process.env.GITHUB_OUTPUT, `directory=${directory}\n`)
    } else if (process.argv[2] === "draft") {
      createDraftRelease({ directory: process.argv[3] })
    } else {
      throw new Error("Usage: node .github/scripts/release.mjs resolve | draft <artifact-directory>")
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
