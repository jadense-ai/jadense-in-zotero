import { beforeEach, describe, expect, it } from "vitest"
import { initializeUiLocale } from "./ui-preferences"
import { pdfTranslationStatusView, type PDFStatusInput } from "./pdf-translation-status"
import type { PDFTranslationTask } from "./pdf-translation-jobs"
import type { TranslationSnapshot } from "@/chat/translation-queue"

const makeTask = (over: Partial<PDFTranslationTask>): PDFTranslationTask =>
  ({ id: "task-1", status: "running", stage: "translation", percent: 40, pages: 8, skipped: [], ...over }) as PDFTranslationTask
const makeSpeed = (over: Partial<TranslationSnapshot> = {}): TranslationSnapshot =>
  ({ active: 1, concurrency: 2, httpMinute: 3, rpm: 20, queued: 0, waitMs: 0, ...over }) as TranslationSnapshot
const view = (input: PDFStatusInput) => pdfTranslationStatusView(input)

describe("pdfTranslationStatusView", () => {
  beforeEach(() => { initializeUiLocale({ locale: "zh-CN" }) })

  it("瞬时提示一次性覆盖任务状态:info 为准备中,error 为错误", () => {
    const info = view({ task: makeTask({ status: "running" }), notice: { text: "准备 PDF 翻译…", tone: "info" } })
    expect(info).toMatchObject({ kind: "preparing", led: "busy", visible: true, label: "准备 PDF 翻译…", working: true })
    expect(info.progress).toBeUndefined()
    const failed = view({ task: makeTask({ status: "running" }), notice: { text: "磁盘已满", tone: "error" } })
    expect(failed).toMatchObject({ kind: "error", led: "error", visible: true, label: "磁盘已满", working: false })
  })

  it("无任务时仅窗口错误可见,否则完全隐藏", () => {
    expect(view({})).toMatchObject({ kind: "idle", visible: false, working: false })
    const failed = view({ windowError: "独立窗口不可用" })
    expect(failed).toMatchObject({ kind: "error", led: "error", visible: true, label: "独立窗口不可用" })
  })

  it("排队与翻译阶段显示工作动画、阶段文案与确定进度", () => {
    const queued = view({ task: makeTask({ status: "queued", stage: "queued" }) })
    expect(queued).toMatchObject({ kind: "working", led: "busy", visible: true, working: true })
    expect(queued.label).toContain("等待其他 PDF 任务")
    expect(queued.progress).toBe("indeterminate")
    const running = view({ task: makeTask({ status: "running", stage: "translation", completed: 86, total: 120 }) })
    expect(running.label).toBe("翻译正文… · 已完成 86 / 120 段")
    expect(running.progress).toEqual({ value: 86, max: 120 })
    expect(running.working).toBe(true)
  })

  it("批次退避进入等待级别:倒计时行为徽章摘要,动画继续", () => {
    const now = 1_000_000
    const waiting = view({ now, task: makeTask({ status: "running", completed: 86, total: 120, retrying: { batch: { attempt: 1, until: now + 20_000 } as never } }) })
    expect(waiting).toMatchObject({ kind: "waiting", led: "warning", working: true })
    expect(waiting.label).toBe("服务暂时繁忙，20 秒后自动继续，无需重复点击。")
    expect(waiting.lines[0]).toContain("翻译正文…")
    const recovered = view({ now, task: makeTask({ status: "running", retrying: { batch: { attempt: 2, until: now - 1 } as never } }) })
    expect(recovered.label).toBe("正在自动恢复未完成内容，无需重复点击。")
  })

  it("服务排队等待给出预计继续时间", () => {
    const waiting = view({ task: makeTask({ status: "running", completed: 1, total: 9 }), speed: makeSpeed({ queued: 3, waitMs: 12_000 }) })
    expect(waiting.kind).toBe("waiting")
    expect(waiting.lines.some(line => line.includes("正在等待翻译服务，约 12 秒后继续"))).toBe(true)
    expect(waiting.details).toContain("等待 12 秒")
  })

  it("运行中的临时错误不覆盖工作状态,错误与速度进入详情", () => {
    const running = view({ task: makeTask({ status: "running", completed: 3, total: 9, error: "Synthetic temporary warning" }), speed: makeSpeed() })
    expect(running.kind).toBe("working")
    expect(running.lines.join("\n")).not.toContain("Synthetic temporary warning")
    expect(running.details).toContain("Synthetic temporary warning")
    expect(running.details).toContain("在途 1/2")
  })

  it("中断与旧版中断给出重试恢复提示", () => {
    const interrupted = view({ task: makeTask({ status: "interrupted" }) })
    expect(interrupted).toMatchObject({ kind: "interrupted", led: "warning", working: false, label: "上次任务已中断，点击重试将复用已完成片段。" })
    const legacy = view({ task: makeTask({ status: "interrupted", legacy: true }) })
    expect(legacy.label).toContain("旧版未完成任务")
  })

  it("取消保留错误前缀且级别为静音", () => {
    const cancelled = view({ task: makeTask({ status: "cancelled", error: "Provider 拒绝" }) })
    expect(cancelled).toMatchObject({ kind: "cancelled", led: "muted", working: false })
    expect(cancelled.lines).toEqual(["Provider 拒绝", "已取消，点击重试可复用已完成片段。"])
  })

  it("部分完成保留原因、错误行、覆盖率与诊断详情", () => {
    const partial = view({
      task: makeTask({ status: "partial", error: "两批未恢复", diagnosticId: "diag-9", failureCounts: { OUTPUT_FAILED: 34, PLACEHOLDER_MISMATCH: 6 },
        coverage: { total: 120, translated: 86, failed: 34, preserved: 0, failedPages: [2, 5] } }),
      hasOutput: true,
    })
    expect(partial).toMatchObject({ kind: "partial", led: "warning", working: false })
    expect(partial.lines[0]).toContain("部分段落暂未完成")
    expect(partial.lines).toContain("两批未恢复")
    expect(partial.lines.join("\n")).toContain("已译 86 段 · 未译 34 段（保留原文）")
    expect(partial.lines.join("\n")).toContain("未完成页：3、6")
    expect(partial.details).toContain("任务编号：task-1")
    expect(partial.details).toContain("诊断编号：diag-9")
    expect(partial.details).toContain("模型批次失败 [OUTPUT_FAILED] 34")
    expect(partial.details).toContain("公式或格式标记不匹配 [PLACEHOLDER_MISMATCH] 6")
  })

  it("完成且无消息时隐藏;有覆盖率或保留页时以成功级别显示", () => {
    expect(view({ task: makeTask({ status: "complete" }), hasOutput: true })).toMatchObject({ kind: "idle", visible: false })
    const done = view({ task: makeTask({ status: "complete", coverage: { total: 9, translated: 9, failed: 0, preserved: 0, failedPages: [] } }), hasOutput: true })
    expect(done).toMatchObject({ kind: "complete", led: "success", visible: true, working: false })
    expect(done.label).toContain("已译 9 段")
    const skipped = view({ task: makeTask({ status: "complete", skipped: [0, 3] }), hasOutput: true })
    expect(skipped).toMatchObject({ kind: "complete", led: "success" })
    expect(skipped.label).toBe("以下页无可翻译文字，已保留原页：1、4")
  })

  it("收尾阶段只显示保存提示", () => {
    const finishing = view({ task: makeTask({ status: "running", stage: "finishing", completed: 9, total: 9 }) })
    expect(finishing).toMatchObject({ kind: "working", led: "busy", label: "正在保存已完成译文" })
  })

  it("错误状态与窗口错误为错误级别;运行中时窗口错误只进详情", () => {
    const failed = view({ task: makeTask({ status: "error", error: "引擎崩溃" }) })
    expect(failed).toMatchObject({ kind: "error", led: "error", working: false, label: "引擎崩溃" })
    const busyWindow = view({ task: makeTask({ status: "running", completed: 1, total: 2 }), windowError: "独立窗口创建失败" })
    expect(busyWindow.kind).toBe("working")
    expect(busyWindow.label).toContain("翻译正文…")
    expect(busyWindow.details).toContain("独立窗口创建失败")
    const idleWindow = view({ task: makeTask({ status: "complete" }), windowError: "独立窗口创建失败", hasOutput: true })
    expect(idleWindow).toMatchObject({ kind: "error", led: "error", label: "独立窗口创建失败" })
  })
})
