/** 已知抽样说明仅作内部诊断；真实读取错误与未知消息仍须展示。 */
import { describe, expect, it } from 'vitest'
import { analysisWarningsForDisplay, splitAnalysisWarnings } from './paper-analysis-warnings'

const notices = [
  '为控制解析长度，均匀选取 1200/4931 个可定位原句；结论仅基于这些原句。',
  'Analysis uses an evenly sampled 1200/4931 passages with usable coordinates; conclusions are limited to these passages.',
  '长文献均匀抽取 80/120 页（包括末页），未读取全部正文。',
  'This long document was sampled evenly across 80/120 pages, including the last page. Not all text was read.',
]

describe('analysis warning presentation', () => {
  it.each(notices)('keeps known coverage notice internal: %s', notice => {
    expect(splitAnalysisWarnings([notice, notice])).toEqual({ warnings: [], coverageWarnings: [notice] })
    expect(analysisWarningsForDisplay({ warnings: [notice] })).toEqual([])
  })

  it('retains real extraction, model, and persistence errors even when mentioning sampling', () => {
    const warnings = [
      '第 2 页的文字坐标读取失败，未纳入解析。',
      'Pages 4, 5 contain no passages with usable coordinates and were omitted. They may be images, blank, or lack a text layer.',
      'AI 响应未完整结束；已保留收到的部分内容供核对，未写入 PDF 批注。',
      '解析历史保存失败；笔记暂留当前窗口，请及时复制。',
      `${notices[0]} 但写入失败。`,
      `读取失败：${notices[1]}`,
      '新的可恢复错误',
    ]
    expect(analysisWarningsForDisplay({ warnings: [...notices, ...warnings] })).toEqual(warnings)
    expect(analysisWarningsForDisplay()).toEqual([])
  })

  it('contains malformed optional legacy warning metadata at the display boundary', () => {
    expect(analysisWarningsForDisplay({ warnings: 'malformed' as unknown as string[] })).toEqual([])
    expect(analysisWarningsForDisplay({ warnings: [null, {}, ' Real failure '] as unknown as string[] })).toEqual(['Real failure'])
  })
})
