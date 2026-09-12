/** 验证侧栏打开流程不触发翻译，保留恢复历史与新建对话的行为。 */
import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"

it("opens translation and restores history without starting a job", async () => {
  const source = readFileSync(new URL("./reader-sidebar.ts", import.meta.url), "utf8")
  const body = source.split("async show(shouldStart = false, onHistory, newConversation) {")[1].split("\n    },")[0]
  const activate = vi.fn(), setPage = vi.fn(), restore = vi.fn(), start = vi.fn()
  const run = new Function("options", "setPage", "restore", "start", "chatView", `let history; let taskID = ''; return async function(shouldStart, onHistory, newConversation) { ${body} }`)
  const show = run({ activate }, setPage, restore, start, {})
  await show(true)
  await show(true)
  expect(activate).toHaveBeenCalledTimes(2)
  expect(setPage).toHaveBeenCalledWith("translation")
  expect(restore).toHaveBeenCalledTimes(2)
  expect(start).not.toHaveBeenCalled()
})
