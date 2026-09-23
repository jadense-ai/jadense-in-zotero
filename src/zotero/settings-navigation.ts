/** 设置目录共用布局：只切换现有 DOM，不重建控件、不保存业务偏好。 */
import { uiText } from './ui-preferences'

/** 依赖跳转先选择目录，再由调用方滚动并聚焦对应控件。 */
export function selectSettingsGroup(root: HTMLElement, key: string) {
  root.querySelector<HTMLButtonElement>(`[data-settings-target="${key}"]`)?.click()
}

/** 两个设置宿主保留原始节点与事件；目录使用普通按钮，并支持方向键。 */
export function wireSettingsNavigation(root: HTMLElement, selector: string, initial: string) {
  const doc = root.ownerDocument
  const panels = Array.from(root.querySelectorAll<HTMLElement>(selector))
  const make = (tag: string) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement
  const shell = make('div'), nav = make('nav'), detail = make('div')
  shell.className = 'jdx-settings-layout'; nav.className = 'jdx-settings-directory'; detail.className = 'jdx-settings-detail'
  nav.setAttribute('aria-label', uiText('配置分类', 'Settings categories'))
  root.insertBefore(shell, panels[0] || null); shell.append(nav, detail)
  const buttons = panels.map((panel, index) => {
    const key = panel.dataset.settingsTask || panel.dataset.externalDependency || String(index)
    const title = panel.querySelector<HTMLElement>(':scope > h3')!
    panel.id ||= `${root.id || 'jdx-settings'}-group-${key}`
    title.id ||= `${panel.id}-title`
    panel.setAttribute('aria-labelledby', title.id)
    const button = make('button') as HTMLButtonElement
    button.type = 'button'; button.dataset.settingsTarget = key; button.textContent = title.textContent
    button.setAttribute('aria-controls', panel.id)
    button.addEventListener('click', () => {
      panels.forEach((node, i) => { node.hidden = i !== index })
      buttons.forEach((node, i) => { if (i === index) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current') })
    })
    nav.append(button); detail.append(panel)
    return button
  })
  const onKey = (event: KeyboardEvent) => {
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    let next = index
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % buttons.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + buttons.length - 1) % buttons.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1
    else return
    event.preventDefault(); buttons[next].focus(); buttons[next].click()
  }
  nav.addEventListener('keydown', onKey)
  ;(buttons.find(button => button.dataset.settingsTarget === initial) || buttons[0])?.click()
  return () => { nav.removeEventListener('keydown', onKey); panels.forEach(panel => { panel.hidden = false; shell.before(panel) }); shell.remove() }
}
