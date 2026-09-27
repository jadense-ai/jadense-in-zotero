/** 翻译失败反馈必须可定位，恢复过程计数不能冒充最终未译段数。 */
import { expect, it } from 'vitest'
import { pdfFailureDetails } from './pdf-translation-policy'

it('includes task identity and failure categories even without diagnostics storage', () => {
  const details = pdfFailureDetails({ id: 'task-123', status: 'partial', failureCounts: { OUTPUT_FAILED: 34, PLACEHOLDER_MISMATCH: 6 } })
  expect(details).toContain('task-123')
  expect(details).toContain('OUTPUT_FAILED')
  expect(details).toContain('34')
  expect(details).toContain('PLACEHOLDER_MISMATCH')
})

it('includes the diagnostic id and contains malformed optional feedback', () => {
  const details = pdfFailureDetails({ id: 'task-123', status: 'error', diagnosticId: 'diagnostic-456', failureCounts: { OUTPUT_FAILED: 2, FUTURE: 1, INVALID_OUTPUT: NaN } })
  expect(details).toContain('diagnostic-456')
  expect(details).not.toContain('NaN')
  expect(pdfFailureDetails({ id: 'task-123', status: 'complete', failureCounts: { OUTPUT_FAILED: 34 } })).toBe('')
})
