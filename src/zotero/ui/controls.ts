/** Manager 公共控件：只负责 XHTML、交互语义与主题样式，不读取任务或持久化数据。 */
export function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function action(doc: Document, label: string, onClick: () => void, kind: "ghost" | "primary" = "ghost") {
  const node = element(doc, "button", `jdx-button jdx-button-${kind}`, label)
  node.type = "button"
  node.addEventListener("click", onClick)
  return node
}

export function notice(doc: Document) {
  const node = element(doc, "div", "jdx-notice")
  node.setAttribute("role", "status")
  return node
}

/** 点击及键盘共用选择路径；只保留一个可 Tab 聚焦项，返回清理函数供页面释放。 */
export function bindTabs(buttons: HTMLButtonElement[], select: (index: number) => void) {
  const cleanups: Array<() => void> = []
  buttons.forEach((button, index) => {
    const click = () => select(index)
    const key = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
      event.preventDefault()
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length
      select(next); buttons[next].focus({ preventScroll: true })
    }
    button.addEventListener("click", click); button.addEventListener("keydown", key)
    cleanups.push(() => { button.removeEventListener("click", click); button.removeEventListener("keydown", key) })
  })
  return () => cleanups.forEach(cleanup => cleanup())
}

/** 状态点配合文字表达；颜色不承担唯一信息。 */
export function badge(doc: Document, label: string, state = "neutral") {
  const node = element(doc, "span", "jdx-badge", label)
  node.dataset.state = state
  return node
}

/** 成果操作栏的线性图标；保留按钮原文，状态切换后重新同步 tooltip 与可访问名称。 */
const actionPaths = {
  back: 'M19 12H5m6-6-6 6 6 6', open: 'M14 3h7v7m0-7L10 14M10 3H4v17h17v-6',
  workbench: 'M3 4h18v16H3zM9 4v16M3 9h6', copy: 'M9 8h12v13H9zM5 16H3V3h12v2',
  extract: 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5', refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',
  stop: 'M6 6h12v12H6z', pause: 'M8 5v14M16 5v14', play: 'm8 5 11 7-11 7z',
  read: 'M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15', locate: 'M12 3v4m0 10v4M3 12h4m10 0h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1', type: 'M4 5h16M12 5v15M8 20h8', more: 'M4 12h2m5 0h2m5 0h2',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6', import: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', edit: 'm4 16-1 5 5-1L20 8l-4-4L4 16m9-9 4 4', delete: 'M5 7h14m-9 4v6m4-6v6M9 7V4h6v3m-9 0 1 13h10l1-13',
  verify: 'm4 12 5 5L20 6', skip: 'm5 5 9 7-9 7zM19 5v14',
} as const
export function actionIcon(button: HTMLButtonElement, icon: keyof typeof actionPaths, label = button.textContent || '') {
  button.classList.add('jdx-icon-action'); button.title = label; button.setAttribute('aria-label', label)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${actionPaths[icon]}"/></svg>`
  button.style.setProperty('--jdx-action-icon', `url("data:image/svg+xml,${encodeURIComponent(svg)}")`)
  return button
}
