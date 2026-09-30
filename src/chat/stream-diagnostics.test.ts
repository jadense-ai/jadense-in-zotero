/** 经真实 SSE 解析与磁盘投影验证诊断，不保存响应原文。 */
import { expect, it } from 'vitest'
import { Diagnostics } from '@/zotero/diagnostics'
import { consumeTemporaryChatStream } from './temporary-chat'

it('persists reasoning and protocol counters without remote content', async () => {
  let saved = ''
  const platform = {
    PathUtils: { profileDir: 'test', join: (...parts: string[]) => parts.join('/') },
    IOUtils: { makeDirectory: async () => {}, readUTF8: async () => saved, writeUTF8: async (_: string, text: string) => { saved = text } },
  }
  const store = new Diagnostics(platform); await store.ready
  const trace = store.start({ feature: 'translation' })
  const payload = [
    ': heartbeat',
    'data: broken-PRIVATE',
    'data: {"type":"reasoning-delta","delta":"PRIVATE"}',
    'data: {"type":"PRIVATE","secret":"PRIVATE"}',
    'data: {"choices":[{"delta":{"content":"PRIVATE"}}]}',
    'data: {"type":"text-delta","textDelta":"PRIVATE"}',
    'data: {"type":"text-delta","delta":"译文"}',
    'data: [DONE]',
  ].join('\n\n') + '\n\n'
  const result = await consumeTemporaryChatStream(new Response(payload), undefined, true, trace)
  trace.end(); await store.flush()
  const restored = new Diagnostics(platform); await restored.ready
  const summary = restored.list()[0].events.filter(e => e.stage === 'stream_summary').at(-1)!.translation!
  expect(result).toBe('译文')
  expect(summary).toMatchObject({ streamEvents: 8, emptyEvents: 1, invalidEvents: 1, reasoningEvents: 1, reasoningChars: 7, unknownEvents: 1, openaiEvents: 1, textEvents: 2, textChars: 2, invalidDeltaEvents: 1, doneEvents: 1, pendingChars: 0 })
  expect(summary.firstReasoningMs).toBeGreaterThanOrEqual(0)
  expect(saved).not.toContain('PRIVATE')
  expect(saved).not.toContain('译文')
  store.dispose(); restored.dispose()
})
