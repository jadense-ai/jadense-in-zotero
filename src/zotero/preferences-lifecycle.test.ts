/** 模拟 PreferencePanes 先载入脚本、再插入片段，并在销毁沙箱之前派发根节点 unload。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

const xhtml = readFileSync(new URL('../../content/preferences.xhtml', import.meta.url), 'utf8')
const script = buildSync({
  entryPoints: [fileURLToPath(new URL('./preferences-page.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', target: 'firefox140',
}).outputFiles[0].text

it('keeps tab drafts through repeated showing and releases observers before Zotero destroys its pane sandbox', async () => {
  const dom = new JSDOM('<!doctype html><main></main>', { runScripts: 'outside-only', url: 'https://settings-test.invalid' })
  const win = dom.window
  const observers = new Map<number, () => void>()
  const observerKeys = new Map<number, string>()
  let nextObserver = 0
  Object.assign(win, {
    PathUtils: { profileDir: '/synthetic-profile', join: (...parts: string[]) => parts.join('/'), normalize: (value: string) => value },
    IOUtils: { exists: async () => false },
    Zotero: {
      locale: 'zh-CN', getMainWindow: () => win,
      // 真实宿主由插件启动层持有任务运行时；面板只读取繁忙状态。
      __jadensePDFTranslationJobs: { storageBusyReason: () => undefined },
      Prefs: {
        get: () => undefined, set: () => {},
        registerObserver: (key: string, callback: () => void) => { const id = ++nextObserver; observers.set(id, callback); observerKeys.set(id, key); return id },
        unregisterObserver: (id: number) => { observers.delete(id); observerKeys.delete(id) },
      },
    },
  })
  try {
    win.eval(script)
    win.document.querySelector('main')!.innerHTML = xhtml.replaceAll('html:', '').replaceAll(/\b(vbox|groupbox)\b/g, 'div')
    const root = win.document.getElementById('jadense-in-zotero-preferences-pane')!
    root.dispatchEvent(new win.Event('load'))
    expect(root.getAttribute('data-jadense-initialized')).toBe('true')
    expect(root.querySelector('[data-classification-settings-host] input')).toBeTruthy()
    const count = observers.size
    expect(count).toBeGreaterThan(10)
    root.dispatchEvent(new win.Event('showing'))
    expect(observers.size).toBe(count)
    const tab = (key: string) => win.document.getElementById(`jadense-in-zotero-settings-tab-${key}`)!
    const panels = Array.from(root.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
    expect(panels.filter(panel => !panel.hidden)).toHaveLength(1)
    const draft = win.document.getElementById('jadense-in-zotero-byok-provider-name') as HTMLInputElement
    tab('byok').click()
    draft.value = 'Unsaved provider name'
    tab('general').click(); tab('byok').click()
    expect(draft.value).toBe('Unsaved provider name')
    tab('byok').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(tab('general').getAttribute('aria-selected')).toBe('true')
    expect(win.document.activeElement).toBe(tab('general'))
    tab('general').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(tab('byok').getAttribute('aria-selected')).toBe('true')
    expect(panels.filter(panel => !panel.hidden)).toHaveLength(1)
    root.dispatchEvent(new win.Event('unload'))
    expect([...observerKeys.values()], 'pane unload must run before the host nukes the sandbox').toEqual([])
    root.remove()
    await Promise.resolve()
    expect(observers.size).toBe(0)
  } finally { win.close() }
})
