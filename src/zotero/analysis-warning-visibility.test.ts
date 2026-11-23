/** 解析成果 DOM 回归：技术抽样说明不显示，实际错误只反馈一次，已有模型正文保持原样。 */
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaperAnalysisRecord } from '@/chat/paper-analysis-history'
import { mountAnalysisWorkspace } from './analysis-workspace'
import { initializeUiLocale } from './ui-preferences'
import type { ZoteroLike } from './runtime'

vi.mock('./document-jobs', () => ({ documentJobs: () => ({ list: () => [], get: () => undefined, subscribe: () => () => {}, ready: Promise.resolve() }) }))
vi.mock('./reference-workspace', () => ({ mountReferenceDetails: () => ({ update: () => {}, suspend: () => {}, pause: () => {}, remove: () => {} }) }))
const runtime = vi.hoisted(() => ({ start: vi.fn(), restart: vi.fn(), get: vi.fn() }))
vi.mock('./analysis-runtime', () => ({ analysisRuntime: () => runtime }))

const sampling = '为控制解析长度，均匀选取 1200/4931 个可定位原句；结论仅基于这些原句。'
const samplingEn = 'Analysis uses an evenly sampled 1200/4931 passages with usable coordinates; conclusions are limited to these passages.'
const pageFailure = '第 2 页的文字坐标读取失败，未纳入解析。'
const disposals: Array<() => void> = []

afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose())
  initializeUiLocale({ locale: 'zh-CN' })
  vi.clearAllMocks()
})

/** 用隔离 DOM 挂载真实解析界面，仅替换无关引用任务和运行调度。 */
function mount(record: PaperAnalysisRecord, unsaved = false, workbench = false, host: ZoteroLike = {}) {
  const dom = new JSDOM(`<!doctype html><article class="${workbench ? 'jdx-literature-detail' : ''}"><main></main></article>`), root = dom.window.document.querySelector('main')!
  const stop = vi.fn()
  const workspace = mountAnalysisWorkspace(root, host, { records: () => [record], unsaved: () => unsaved,
    openSource: async () => true, stop, onReferenceTask: () => {} })
  workspace.open(record.source)
  disposals.push(() => { workspace.remove(); dom.window.close() })
  return { root, workspace, stop }
}

function record(warnings: string[]): PaperAnalysisRecord {
  return { id: 'analysis-fixture', createdAt: '2026-10-21T01:50:29Z', source: { itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Synthetic paper', authors: [] },
    summary: '已有研究总结', notes: '已有解析笔记', warnings }
}

describe('analysis warning visibility', () => {
  it('keeps the completed action compact, opens the retained group and keeps storage failures visible', () => {
    const fixture = record(['有 1 条内容未作为 PDF 批注采用；可恢复的笔记已保留供阅读。', pageFailure])
    fixture.notes = '文献解析（AI 辅助，请核对原文）\n\n总体概述\n已有研究总结\n\n保留笔记（1 条，未写入 PDF 批注）\n\n【研究问题】原句位置无法确认\n已恢复的笔记'
    const { root, workspace } = mount(fixture, true, true)
    const tools = root.querySelector<HTMLElement>('.jdx-analysis-reading-tools')!
    expect(tools.textContent).toContain('1 条笔记已保留，未写入 PDF 批注')
    expect(tools.querySelector('.jdx-icon-action')?.textContent).toBe('重新解析')
    const run = root.querySelector<HTMLElement>('.jdx-detail-run')!
    expect(run.hidden).toBe(true)
    expect(root.querySelector('.jdx-analysis-warning')?.textContent).toContain(pageFailure)
    expect(root.querySelector('.jdx-analysis-warning')?.textContent).toContain('最新结果尚未完整保存')
    tools.querySelector('button')!.click()
    expect(root.ownerDocument.activeElement?.getAttribute('data-jdx-retained-notes')).toBe('1')
    workspace.setRun({ source:fixture.source, busy:false, resumable:true, message:'已暂停', createdAt:fixture.createdAt })
    expect(run.hidden).toBe(false)
    expect(run.querySelector('.jdx-icon-action[aria-label="重新解析"]')).toBeTruthy()
    expect(tools.querySelector('.jdx-icon-action')).toBeNull()
  })

  it('only links an unambiguous native quote and rechecks the PDF anchor when the reader clicks', async () => {
    const fixture = record([])
    fixture.notes = '文献解析（AI 辅助，请核对原文）\n\n【研究问题】第 iv 页\n原句：Unique passage\nAI 批注：已核对\n\n【研究问题】第 7 页\n原句：Unknown passage\nAI 批注：仅有历史页码'
    const annotation = { key:'NATIVE42', parentItemID:42, annotationText:'Unique passage', annotationPageLabel:'iv', annotationPosition:JSON.stringify({ pageIndex:3, rects:[[1,2,3,4]] }), getTags:() => [{tag:'Jadense AI/question'}] }
    const annotations = [annotation], navigate = vi.fn()
    const host = { Items:{ get:() => ({ id:42, libraryID:1, key:'PDF42', isPDFAttachment:() => true, getAnnotations:() => annotations }) }, Reader:{ open:vi.fn(async () => ({ navigate })) } }
    const { root, workspace } = mount(fixture, false, true, host)
    workspace.open(fixture.source, 'notes')
    await vi.waitFor(() => expect(root.querySelectorAll('.jdx-note-meta button')).toHaveLength(1))
    const link = root.querySelector<HTMLButtonElement>('.jdx-note-meta button')!
    expect(link.textContent).toBe('查看原文')
    expect(root.querySelectorAll('.jdx-note-meta')[1].textContent).toContain('第 7 页')
    link.click()
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ position:{ pageIndex:3, rects:[[1,2,3,4]] } }))
    annotations.push({...annotation, key:'ANOTHER', annotationPosition:JSON.stringify({ pageIndex:3, rects:[[3,4,5,6]] })})
    link.click()
    await vi.waitFor(() => expect(link.isConnected).toBe(false))
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('opens the notes body for a legacy notice without claiming all skipped entries were saved', () => {
    const fixture = record(['4 entries were not used as PDF annotations. Recoverable notes were retained for review.'])
    fixture.notes = '旧版本留下的原始文字，未记录具体笔记分组。'
    const { root } = mount(fixture, false, true)
    expect(root.querySelector('.jdx-analysis-retained')?.textContent).toContain('4 条内容未写入 PDF 批注')
    expect(root.querySelector('.jdx-analysis-retained')?.textContent).not.toContain('4 条笔记已保留')
    root.querySelector<HTMLButtonElement>('.jdx-analysis-retained button')!.click()
    expect(root.ownerDocument.activeElement).toBe(root.querySelector('.jdx-analysis-notes-text'))
    expect(root.ownerDocument.activeElement?.textContent?.trim()).toBe(fixture.notes)
  })

  it.each(['zh-CN', 'en-US'])('hides both legacy technical templates and marks saved analysis complete in %s', locale => {
    initializeUiLocale({ locale })
    const { root } = mount(record([sampling, samplingEn]))
    expect(root.textContent).not.toContain('1200/4931')
    expect(root.querySelector('.jdx-badge')?.textContent).toBe(locale === 'zh-CN' ? '已解析' : 'Analyzed')
    expect(root.querySelector('.jdx-badge')?.getAttribute('data-state')).toBe('success')
    expect(root.querySelector('.jdx-analysis-summary')?.textContent).toContain('已有研究总结')
  })

  it('retains a real page-read warning and avoids duplicating the same run feedback', () => {
    const fixture = record([sampling, pageFailure]), { root, workspace } = mount(fixture)
    expect(root.textContent).not.toContain(sampling)
    expect(root.querySelector('.jdx-badge')?.textContent).toBe('结果待核对')
    expect(root.textContent?.split(pageFailure)).toHaveLength(2)
    workspace.setRun({ source: fixture.source, message: pageFailure, busy: false, error: true, createdAt: fixture.createdAt })
    expect(root.textContent?.split(pageFailure)).toHaveLength(2)
    expect(root.querySelector('.jdx-detail-run')?.textContent).toContain(pageFailure)
  })

  it('preserves saved model prose and unsaved-result feedback while hiding separate technical warnings', () => {
    const fixture = record([sampling])
    fixture.summary = `保留模型原文：${sampling}`
    const { root } = mount(fixture, true)
    expect(root.querySelector('.jdx-analysis-summary')?.textContent).toContain(fixture.summary)
    expect(root.querySelector('.jdx-analysis-detail')?.textContent).toContain('最新结果尚未完整保存')
    expect([...root.querySelectorAll('.jdx-notice')].every(notice => !notice.textContent?.includes(sampling))).toBe(true)
  })

  it.each(['zh-CN', 'en-US'])('explains reference-only work and keeps its labelled stop action in %s', locale => {
    initializeUiLocale({ locale })
    const fixture = record([]), { root, workspace, stop } = mount(fixture)
    const banner = root.querySelector<HTMLElement>('.jdx-detail-run')!
    expect(banner.querySelector<HTMLElement>('[role=status]')?.hidden).toBe(true)
    workspace.setRun({ source: fixture.source, message: '', busy: false, references: { running: true }, createdAt: fixture.createdAt })
    expect(banner.hidden).toBe(false)
    expect(banner.querySelector('.jdx-analysis-status-title')?.textContent).toBe(locale === 'zh-CN' ? '正在整理参考文献' : 'Preparing references')
    expect(banner.querySelector('.jdx-analysis-status-description')?.textContent).not.toBe('')
    const actions = banner.querySelector<HTMLElement>('[role=group]')!
    const visible = [...actions.querySelectorAll('button')].filter(button => !button.hidden)
    expect(visible.map(button => button.textContent)).toEqual(locale === 'zh-CN' ? ['重新解析', '停止本次解析'] : ['Reanalyze', 'Stop analysis'])
    visible[1].click()
    expect(stop).toHaveBeenCalledWith(fixture.source)
    workspace.setRun({ source: fixture.source, message: 'Completed', busy: false, createdAt: fixture.createdAt })
    expect(banner.querySelector<HTMLElement>('[role=status]')?.hidden).toBe(true)
    expect(root.querySelector('.jdx-analysis-summary')?.textContent?.trim()).toBe(fixture.summary)
  })

  it('offers separate continue and reanalyze actions when paused', () => {
    const fixture = record([]), { root, workspace } = mount(fixture)
    workspace.setRun({ source: fixture.source, message: 'Reading page 2', busy: true, createdAt: fixture.createdAt })
    workspace.setRun({ source: fixture.source, message: 'Paused by reader', busy: false, resumable: true, createdAt: fixture.createdAt })
    const banner = root.querySelector<HTMLElement>('.jdx-detail-run')!
    expect(banner.dataset.kind).toBe('neutral')
    expect(banner.querySelector('.jdx-analysis-status-title')?.textContent).toBe('解析已暂停')
    expect(banner.querySelector('.jdx-analysis-status-description')?.textContent).toBe('Paused by reader')
    const visible = [...banner.querySelectorAll('button')].filter(button => !button.hidden)
    expect(visible.map(button => button.textContent)).toEqual(['继续解析', '重新解析'])
    expect(visible[0].classList.contains('jdx-button-primary')).toBe(true)
  })

  it('retains error feedback without reserving space for unavailable actions', () => {
    const fixture = record([]), { root, workspace } = mount(fixture)
    workspace.setRun({ source: fixture.source, message: pageFailure, busy: false, error: true, createdAt: fixture.createdAt })
    const banner = root.querySelector<HTMLElement>('.jdx-detail-run')!
    expect(banner.hidden).toBe(false)
    expect(banner.dataset.kind).toBe('error')
    expect(banner.querySelector('.jdx-analysis-status-title')?.textContent).toBe('解析未完成')
    expect(banner.querySelector<HTMLElement>('.jdx-analysis-run-actions')?.hidden).toBe(false)
  })

  it.each(['zh-CN', 'en-US'])('only starts a new analysis after explicit confirmation in %s', locale => {
    initializeUiLocale({ locale })
    const fixture = record([]), { root, workspace } = mount(fixture)
    workspace.setRun({ source: fixture.source, message: 'Uncertain', busy: false, resumable: true, error: true, createdAt: fixture.createdAt })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.jdx-analysis-run-actions button')]
    const restart = buttons.find(button => button.textContent === (locale === 'zh-CN' ? '重新解析' : 'Reanalyze'))!
    const confirm = vi.spyOn(root.ownerDocument.defaultView!, 'confirm').mockReturnValue(false)
    restart.click()
    expect(runtime.restart).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    restart.click()
    expect(runtime.restart).toHaveBeenCalledOnce()
    expect(runtime.restart).toHaveBeenCalledWith(42)
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/积分|charges/))
    buttons[0].click()
    expect(runtime.start).toHaveBeenCalledOnce()
    expect(runtime.start).toHaveBeenCalledWith(42)
    workspace.setRun({ source: fixture.source, message: 'Running', busy: true, createdAt: fixture.createdAt })
    expect(restart.hidden).toBe(true)
  })
})
