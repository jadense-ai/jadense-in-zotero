/** 账号模型禁选提示只报告服务端目录原因，不触发选择持久化。 */
import { expect, it, vi } from "vitest"
import type { JdxSelect, JdxSelectOption } from "./custom-select"

const show = vi.hoisted(() => vi.fn())
vi.mock("./ui/toast", () => ({ show }))
import { bindModelSelectToast, buildJadenseChatModelSelectOptions, shouldRefreshModelCatalog } from "./ai-model-select"

it("shows the locked reason through the owning document without selecting the option", () => {
  const doc = {} as Document
  const host = { ownerDocument: doc } as HTMLElement
  let denied: ((option: JdxSelectOption) => void) | undefined
  const onChange = vi.fn()
  const select = { element: host, onDisabledSelect: (listener: typeof denied) => { denied = listener }, onChange } as unknown as JdxSelect
  bindModelSelectToast(select)
  denied?.({ value: "model:paid", label: "Paid", disabled: true, disabledReason: "升级到 Pro 后可直接选择。" })
  expect(show).toHaveBeenCalledWith({ document: doc, themeRoot: host, type: "warning", message: "升级到 Pro 后可直接选择。" })
  expect(onChange).not.toHaveBeenCalled()
})

it("refreshes a successful catalog only after sixty seconds", () => {
  expect(shouldRefreshModelCatalog(100_000, 159_999)).toBe(false)
  expect(shouldRefreshModelCatalog(100_000, 160_000)).toBe(true)
  expect(shouldRefreshModelCatalog(0, 160_000)).toBe(true)
})

it("uses the server lock reason for both locales when no plan explains the denial", () => {
  const catalog = { options: [{ kind: "model" as const, modelId: "restricted", displayName: "Restricted", description: "", locked: true,
    lockReason: "仅向受邀用户开放。", capabilities: [] }] }
  expect(buildJadenseChatModelSelectOptions(catalog, undefined, false)[0].disabledReason).toBe("仅向受邀用户开放。")
  expect(buildJadenseChatModelSelectOptions(catalog, undefined, true)[0].disabledReason).toBe("仅向受邀用户开放。")
})
