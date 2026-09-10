/** Reader 操作区的折叠菜单：只搬移插件按钮，给宿主页码与批注控件保留空间。 */
import { uiText } from "./ui-preferences"

export function bindReaderActionMenu(group: HTMLElement, actions: HTMLElement, toggle: HTMLButtonElement) {
  const doc = group.ownerDocument, win = doc.defaultView
  let open = false
  const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"))
  const position = () => {
    const rect = toggle.getBoundingClientRect()
    actions.style.left = `${Math.max(8, Math.min(rect.left, (win?.innerWidth || 800) - actions.getBoundingClientRect().width - 8))}px`
    actions.style.top = `${Math.max(8, Math.min(rect.bottom + 6, (win?.innerHeight || 600) - actions.getBoundingClientRect().height - 8))}px`
  }
  const close = () => {
    if (!open) return false
    const focused = actions.contains(doc.activeElement)
    open = false
    toggle.setAttribute("aria-expanded", "false")
    actions.removeAttribute("data-jadense-action-menu")
    actions.setAttribute("role", "group")
    for (const button of buttons) { button.removeAttribute("role"); button.removeAttribute("tabindex") }
    actions.style.left = ""; actions.style.top = ""
    group.append(actions)
    if (focused) toggle.focus()
    return true
  }
  const show = (last = false, focus = true) => {
    open = true
    toggle.setAttribute("aria-expanded", "true")
    actions.setAttribute("data-jadense-action-menu", "")
    actions.setAttribute("role", "menu")
    for (const button of buttons) { button.setAttribute("role", "menuitem"); button.tabIndex = -1 }
    ;(doc.body || doc.documentElement).append(actions)
    position()
    if (focus) buttons[last ? buttons.length - 1 : 0]?.focus()
  }
  const resize = () => {
    const focusedAction = buttons.find(button => button === doc.activeElement)
    close()
    // 始终测量展开布局，否则已隐藏的按钮会让宽屏误判空间充足并反复挤压宿主。
    group.setAttribute("data-compact", "false")
    const toolbar = group.closest<HTMLElement>(".toolbar")
    const compact = (win?.innerWidth || 800) <= 1400
      || Boolean(toolbar && toolbar.scrollWidth > toolbar.clientWidth + 1)
    group.setAttribute("data-compact", String(compact))
    if (compact && focusedAction) toggle.focus()
    else if (!compact && doc.activeElement === toggle) (focusedAction ?? buttons[0])?.focus()
  }
  // 鼠标展开保留 PDF 选区焦点；键盘激活才把焦点交给菜单项。
  const preserveSelection = (event: MouseEvent) => event.preventDefault()
  const click = (event?: MouseEvent) => { if (open) close(); else show(false, !event?.detail) }
  const toggleKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault(); show(event.key === "ArrowUp")
  }
  const menuKey = (event: KeyboardEvent) => {
    if (!open) return
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation() }
      close(); return
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    event.preventDefault()
    const current = buttons.indexOf(doc.activeElement as HTMLButtonElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  const outside = (event: Event) => {
    if (open && !actions.contains(event.target as Node) && !toggle.contains(event.target as Node)) close()
  }
  toggle.title = uiText("阅读操作", "Reading actions")
  toggle.setAttribute("aria-label", toggle.title)
  toggle.setAttribute("aria-haspopup", "menu")
  toggle.setAttribute("aria-expanded", "false")
  toggle.addEventListener("mousedown", preserveSelection)
  toggle.addEventListener("click", click)
  toggle.addEventListener("keydown", toggleKey)
  actions.addEventListener("keydown", menuKey)
  doc.addEventListener("pointerdown", outside, true)
  win?.addEventListener("resize", resize)
  resize()
  return {
    close,
    remove() {
      close()
      toggle.removeEventListener("mousedown", preserveSelection)
      toggle.removeEventListener("click", click)
      toggle.removeEventListener("keydown", toggleKey)
      actions.removeEventListener("keydown", menuKey)
      doc.removeEventListener("pointerdown", outside, true)
      win?.removeEventListener("resize", resize)
    },
  }
}
