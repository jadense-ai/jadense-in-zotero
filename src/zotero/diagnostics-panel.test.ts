/** 从帮助菜单进入真实诊断面板，验证不同筛选范围、后台更新和键盘复制。 */
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { diagnostics, stopDiagnostics } from './diagnostics'
import { wireDiagnosticsPanel } from './diagnostics-panel'
import { initializeUiLocale } from './ui-preferences'
import type { ZoteroLike } from './runtime'

it('keeps the focused record when new events arrive and copies only that record', async () => {
  initializeUiLocale({ locale: 'en-US' })
  const dom = new JSDOM('<main><div id="jadense-help-menu"></div><button id="jadense-help-version"></button><div id="jadense-manager-section-guide"></div></main>')
  const doc = dom.window.document
  const writeText = vi.fn(async (_text: string) => {})
  const host = { getMainWindow: () => ({ navigator: { clipboard: { writeText } } }) } as unknown as ZoteroLike
  const store = diagnostics(host)!
  try {
    wireDiagnosticsPanel(doc, host, () => { doc.getElementById('jadense-manager-section-diagnostics')!.hidden = false }, () => {})
    doc.getElementById('jadense-help-diagnostics')!.click()
    const visibleEmpty = () => doc.querySelector<HTMLElement>('.jdx-diagnostic-empty:not([hidden])')
    expect(visibleEmpty()?.textContent).toContain('No diagnostic records on this device')
    store.start({ feature: 'chat' }).end()
    expect(visibleEmpty()?.textContent).toContain('No records match')
    const id = store.start({ feature: 'analysis', clientRequestId: 'old-request' })
    id.fail(new Error('private body'), 'annotation_save'); id.end()
    const node = doc.querySelector<HTMLButtonElement>('.jdx-diagnostic-list button')!
    node.focus(); node.click()
    store.record('ocr-settings', 'environment', new Error('synthetic'))
    expect(doc.activeElement).toBe(node)
    expect(node.getAttribute('aria-pressed')).toBe('true')
    expect(doc.querySelector('.jdx-diagnostic-facts h3')?.textContent).toContain('Could not save annotations')
    doc.querySelector<HTMLButtonElement>('.jdx-diagnostic-facts button')!.click()
    const payload = JSON.parse(writeText.mock.calls[0][0])
    expect(payload.records.map((r: { id: string }) => r.id)).toEqual([id.row.id])
    expect(JSON.stringify(payload)).not.toContain('private body')
    const search = doc.querySelector<HTMLInputElement>('input[type=search]')!
    search.value = 'no-match'; search.dispatchEvent(new dom.window.Event('input'))
    expect(visibleEmpty()?.textContent).toContain('No records match')
    expect(doc.querySelector('.jdx-diagnostic-manage')?.textContent).toContain('Clear all 3 local records')
    doc.querySelector<HTMLButtonElement>('.jdx-diagnostic-empty button')!.click()
    expect(doc.querySelectorAll('.jdx-diagnostic-list button')).toHaveLength(3)
    expect(doc.activeElement).toBe(search)
  } finally { stopDiagnostics(host); dom.window.close() }
})
