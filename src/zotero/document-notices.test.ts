/** 用户提示只投影安全原因，不回显 Provider 正文或凭据。 */
import { expect, it } from 'vitest'
import { documentIssue, notifyDocumentIssue } from './document-notices'
import { TranslationRateLimitError } from '@/chat/translation-queue'

it.each([
  [{ code: 'POINTS_INSUFFICIENT', status: 402 }, '积分不足', 'connection'],
  [{ status: 401 }, '权限不足', 'connection'],
  [{ status: 403 }, '权限不足', 'connection'],
  [{ code: 'OCR_NOT_READY' }, 'OCR', 'ocr'],
  [{ code: 'STREAM_EARLY_EOF' }, '连接中断', undefined],
  [{ code: 'STREAM_INCOMPLETE' }, '输出未完整', undefined],
  [{ code: 'OUTPUT_RESOURCES_CHANGED' }, '图片/公式', undefined],
  [{ code: 'STORAGE_UNAVAILABLE' }, '请及时复制', undefined],
] as const)('projects a user-actionable issue for %j', (value, message, action) => {
  const issue = documentIssue({ ...value, message: 'Bearer secret', body: 'private paper' }, 'generation')
  expect(issue.message).toContain(message); expect(issue.action).toBe(action)
  expect(JSON.stringify(issue)).not.toMatch(/Bearer|secret|private paper/u)
})
it('keeps rate limit timing and contains broken notification surfaces', () => {
  const issue = documentIssue(new TranslationRateLimitError(Date.now() + 60_000), 'generation')
  expect(issue.retryAt).toBeGreaterThan(Date.now())
  expect(() => notifyDocumentIssue({ getMainWindow: () => { throw new Error('closed') } }, issue)).not.toThrow()
})
