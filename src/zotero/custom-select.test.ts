import { describe, expect, it } from "vitest"

import {
  filterSelectOptions,
  moveActiveIndex,
  resolvePopupMaxHeight,
  resolveSelectedValue,
  shouldOpenUp,
} from "./custom-select"

const OPTIONS = [
  { value: "", label: "选择收藏夹" },
  { value: "folder-1", label: "Reading List" },
  { value: "folder-2", label: "To Read" },
]

describe("resolveSelectedValue", () => {
  it("keeps a value that exists in the options", () => {
    expect(resolveSelectedValue(OPTIONS, "folder-2")).toBe("folder-2")
  })

  it("falls back to the empty placeholder when the value is unknown", () => {
    expect(resolveSelectedValue(OPTIONS, "missing")).toBe("")
  })

  it("falls back to empty when no options exist", () => {
    expect(resolveSelectedValue([], "folder-1")).toBe("")
  })

  it("accepts the empty placeholder value itself", () => {
    expect(resolveSelectedValue(OPTIONS, "")).toBe("")
  })
})

describe("filterSelectOptions", () => {
  const richOptions = [
    { value: "route:standard", label: "标准", group: "智能路由", description: "自动选择研究模型" },
    { value: "model:glm", label: "GLM-5", group: "平台模型", description: "适合长文", meta: "1.25x" },
  ]

  it("matches labels, descriptions, groups, and metadata", () => {
    expect(filterSelectOptions(richOptions, "GLM")).toEqual([richOptions[1]])
    expect(filterSelectOptions(richOptions, "自动选择")).toEqual([richOptions[0]])
    expect(filterSelectOptions(richOptions, "平台模型")).toEqual([richOptions[1]])
    expect(filterSelectOptions(richOptions, "1.25x")).toEqual([richOptions[1]])
  })

  it("returns all options for a blank query", () => {
    expect(filterSelectOptions(richOptions, "  ")).toBe(richOptions)
  })
})

describe("moveActiveIndex", () => {
  it("moves down and wraps past the last option", () => {
    expect(moveActiveIndex(0, "ArrowDown", 3)).toBe(1)
    expect(moveActiveIndex(2, "ArrowDown", 3)).toBe(0)
  })

  it("moves up and wraps before the first option", () => {
    expect(moveActiveIndex(1, "ArrowUp", 3)).toBe(0)
    expect(moveActiveIndex(0, "ArrowUp", 3)).toBe(2)
  })

  it("starts from the first/last option when nothing is highlighted", () => {
    expect(moveActiveIndex(-1, "ArrowDown", 3)).toBe(0)
    expect(moveActiveIndex(-1, "ArrowUp", 3)).toBe(2)
  })

  it("jumps to the ends with Home and End", () => {
    expect(moveActiveIndex(1, "Home", 3)).toBe(0)
    expect(moveActiveIndex(1, "End", 3)).toBe(2)
  })

  it("returns -1 when there are no options", () => {
    expect(moveActiveIndex(0, "ArrowDown", 0)).toBe(-1)
  })
})

describe("shouldOpenUp", () => {
  it("opens down when there is enough space below", () => {
    expect(shouldOpenUp(300, 400)).toBe(false)
  })

  it("flips up only when space below is scarce and space above is larger", () => {
    expect(shouldOpenUp(120, 300)).toBe(true)
    expect(shouldOpenUp(120, 100)).toBe(false)
  })
})

describe("resolvePopupMaxHeight", () => {
  it("caps the popup at 240px", () => {
    expect(resolvePopupMaxHeight(600)).toBe(240)
  })

  it("shrinks to the available space but keeps a minimum visible height", () => {
    expect(resolvePopupMaxHeight(180)).toBe(180)
    expect(resolvePopupMaxHeight(10)).toBe(48)
  })
})

// 模型目录允许更高的列表，但仍受窗口可用空间约束；普通下拉沿用原上限。
describe("compact catalog height", () => {
  it("uses the requested cap without overflowing the available space", () => {
    expect(resolvePopupMaxHeight(600, 448)).toBe(448)
    expect(resolvePopupMaxHeight(180, 448)).toBe(180)
    expect(resolvePopupMaxHeight(600)).toBe(240)
  })
})
