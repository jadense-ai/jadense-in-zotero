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
