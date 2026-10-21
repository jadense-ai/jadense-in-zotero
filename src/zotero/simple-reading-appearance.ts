/** 简阅正文的独立显示比例：主栏菜单与多屏窗口共用，偏好不参与翻译任务身份。 */
import type { ZoteroLike } from './runtime'
import { action, element } from './ui/controls'
import { uiText } from './ui-preferences'

export const SIMPLE_READING_FONT_SCALE_PREF = 'extensions.jadenseInZotero.simpleReadingFontScale'

/** 可选展示值只归一化或回退，不因旧值或存储异常阻断阅读。 */
function normalizeScale(value: unknown) {
  const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? Math.min(200, Math.max(80, Math.round(number))) : 100
}

export function readSimpleReadingFontScale(host: ZoteroLike) {
  try { return normalizeScale(host.Prefs?.get(SIMPLE_READING_FONT_SCALE_PREF, true)) } catch { return 100 }
}

export const SIMPLE_READING_APPEARANCE_CSS = `
.jdx-simple-font{display:flex;flex-direction:column;gap:6px;min-width:0;padding:6px 8px}
.jdx-simple-font-label{display:flex;align-items:center;justify-content:space-between;gap:12px;white-space:normal}
.jdx-simple-font-value{flex:none;font-variant-numeric:tabular-nums}
.jdx-simple-reading .jdx-simple-font input{width:100%;min-width:0;padding:0;border:0;accent-color:var(--jdx-green,#16cf8c)}
.jdx-simple-font-actions{display:flex;flex-wrap:wrap;gap:6px}
.jdx-simple-reading .jdx-simple-font-actions button{min-width:32px;flex:1}
.jdx-simple-font-help{margin:0;color:var(--jdx-reader-muted);font-size:calc(11px * var(--jdx-font-scale,1));line-height:1.5;white-space:normal}
.jdx-simple-reading .jdx-simple-detached-tools{flex-wrap:wrap;white-space:normal;overflow:visible}
.jdx-simple-detached-tools input{flex:1;min-width:80px}
`

/** 一次简阅挂载只保留一份比例；保存失败时仍更新当前窗口，卸载时移除可选监听。 */
export function createSimpleReadingAppearance(host: ZoteroLike, changed: () => void) {
  let value = readSimpleReadingFontScale(host)
  const views = new Set<() => void>()
  const update = (next: unknown) => {
    value = normalizeScale(next)
    for (const view of views) view()
    changed()
  }
  const save = (next: number) => {
    update(next)
    try { host.Prefs?.set?.(SIMPLE_READING_FONT_SCALE_PREF, String(value), true) } catch { /* 当前窗口的排版调整仍然生效。 */ }
  }
  let observer: unknown
  if (host.Prefs?.registerObserver && host.Prefs.unregisterObserver) {
    try { observer = host.Prefs.registerObserver(SIMPLE_READING_FONT_SCALE_PREF, () => update(readSimpleReadingFontScale(host)), true) } catch { /* 无监听的宿主仍支持当前阅读窗口。 */ }
  }
  return {
    scale: () => value / 100,
    mount(container: HTMLElement) {
      const doc = container.ownerDocument, root = element(doc, 'div', 'jdx-simple-font')
      const label = element(doc, 'label', 'jdx-simple-font-label', uiText('文字大小', 'Text size'))
      const output = element(doc, 'output', 'jdx-simple-font-value'), range = element(doc, 'input')
      range.type = 'range'; range.min = '80'; range.max = '200'; range.step = '10'
      range.dataset.simpleReadingFontScale = ''; range.setAttribute('aria-label', uiText('简阅文字大小', 'Reading text size'))
      const controls = element(doc, 'div', 'jdx-simple-font-actions')
      const smaller = action(doc, '−', () => save(value - 10)), larger = action(doc, '+', () => save(value + 10))
      const reset = action(doc, '100%', () => save(100))
      for (const [button, title] of [[smaller, uiText('减小文字', 'Decrease text size')], [larger, uiText('增大文字', 'Increase text size')], [reset, uiText('恢复默认文字大小', 'Reset text size')]] as const) {
        button.title = title; button.setAttribute('aria-label', title)
      }
      const render = () => { range.value = String(value); range.setAttribute('aria-valuetext', `${value}%`); output.textContent = `${value}%`; smaller.disabled = value <= 80; larger.disabled = value >= 200; reset.disabled = value === 100 }
      range.addEventListener('input', () => save(Number(range.value)))
      label.append(output); controls.append(smaller, reset, larger)
      root.append(label, range, controls, element(doc, 'p', 'jdx-simple-font-help', uiText('仅调整简阅内容，原 PDF 保持不变。', 'Adjusts reading content; the original PDF stays unchanged.')))
      container.append(root); views.add(render); render()
      return () => { views.delete(render); root.remove() }
    },
    remove() {
      views.clear()
      if (observer !== undefined) try { host.Prefs?.unregisterObserver?.(observer) } catch { /* 关闭阅读器不依赖偏好服务。 */ }
    },
  }
}
