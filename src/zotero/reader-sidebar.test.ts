/** 侧栏壳只导航；所有成果执行由显式按钮负责。 */
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
it('exposes seven independent pages and never starts document work when shown', () => {
  const source = readFileSync(new URL('./reader-sidebar.ts', import.meta.url), 'utf8')
  const shown = source.slice(source.indexOf('async show(shouldStart'), source.indexOf('    remove() {', source.indexOf('async show(shouldStart')))
  expect(shown).toContain("setPage('translation')")
  expect(shown).not.toContain('jobs.start')
  expect(source).toContain('mountReaderChat(chat, sessionHost, host, itemID)')
  expect(source).toContain('resultLabels()')
  expect(source).toContain('mountDocumentResults(panel, host, source, mode')
  expect(source).toContain("action: { kind: 'fullTranslate', itemID, taskID, resultMode: analysisTab || resultMode }")
})
