/** 可选材料按问题选择当前请求片段，完整正文仍由上游存储保留。 */
import { describe, expect, it } from 'vitest'
import { fitTextContext, textTokenCost } from './token-budget'

describe('optional text context', () => {
  it('keeps complete material when it fits', () => {
    expect(fitTextContext('Complete source 原文。', 900)).toEqual({ text: 'Complete source 原文。', limited: false })
  })

  it.each([
    { question: 'MITOCHONDRIA observations', target: 'Mitochondria observations: a specific decline in respiration. '.repeat(4), marker: 'specific decline' },
    { question: '线粒体呼吸链发生了哪些异常变化', target: '线粒体呼吸链异常下降，观察到特异性变化。'.repeat(4), marker: '呼吸链异常下降' },
  ])('retrieves relevant middle evidence within the serialized budget: $question', ({ question, target, marker }) => {
    const text = 'Background material. '.repeat(1500) + target + 'Other background material. '.repeat(1500)
    const fitted = fitTextContext(text, 900, question)
    expect(fitted.limited).toBe(true)
    expect(fitted.text).toContain(marker)
    expect(textTokenCost(JSON.stringify(fitted.text))).toBeLessThanOrEqual(900)
    expect(text).toContain(target)
  })
})
