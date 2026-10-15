/** Python 和 TypeScript 使用相同的模型输出夹具。 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readingReply } from './simple-reading-blocks'
import { readingPrompt } from './simple-reading-jobs'
const cases = JSON.parse(readFileSync(new URL('../../content/pdf-translation/translation-wire-cases.json', import.meta.url), 'utf8')) as Array<{ name: string; raw: string; expected: Record<string, string> }>
it.each(cases)('$name', ({ raw, expected }) => {
  expect(readingReply([{ id: '1', text: 'First' }, { id: '2', text: 'Second' }], raw)).toEqual(expected)
})
it('keeps native identities and pairing metadata out of new model prompts', () => {
  const prompt = readingPrompt({ languages: { sourceLanguage: 'en', targetLanguage: 'zh-CN' } }, {
    id: 'request', operation: 'operation', state: 'pending', promptVersion: 3,
    blocks: [{ id: 'page/12/left/top', text: 'First' }, { id: 'page/13/right', text: 'Second' }],
  })
  expect(prompt).not.toContain('page/12'); expect(prompt).not.toContain('exactly once')
  expect(JSON.parse(prompt.split('\n').at(-1)!)).toEqual([{ id: '1', text: 'First' }, { id: '2', text: 'Second' }])
})
