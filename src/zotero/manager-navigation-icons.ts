/**
 * Manager 侧栏自制 SVG 资产：与 Webapp animated-icons 共用图形语义和动画节奏。
 * 上游是 manager.xhtml 的导航占位与私有雷达页，下游由 manager.css 驱动悬停、焦点和按下动效。
 */
export const MANAGER_NAVIGATION_ICON_IDS = [
  "message-square-plus",
  "history",
  "clipboard-list",
  "library",
  "radar",
  "settings",
  "theme",
] as const

export type ManagerNavigationIconId = (typeof MANAGER_NAVIGATION_ICON_IDS)[number]

type SvgNode = {
  tag: "circle" | "g" | "path" | "rect"
  attributes?: Record<string, string>
  children?: SvgNode[]
}

const iconShapes: Record<ManagerNavigationIconId, SvgNode[]> = {
  "message-square-plus": [
    {
      tag: "path",
      attributes: {
        class: "jdx-icon-draw",
        pathLength: "1",
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    },
    {
      tag: "g",
      attributes: { class: "jdx-icon-plus-late" },
      children: [
        { tag: "path", attributes: { d: "M12 8v6" } },
        { tag: "path", attributes: { d: "M9 11h6" } },
      ],
    },
  ],
  history: [
    {
      tag: "g",
      attributes: { class: "jdx-icon-rewind-arc" },
      children: [
        { tag: "path", attributes: { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" } },
        { tag: "path", attributes: { d: "M3 3v5h5" } },
      ],
    },
    { tag: "path", attributes: { class: "jdx-icon-rewind-hand", d: "M12 7v5l4 2" } },
  ],
  "clipboard-list": [
    { tag: "rect", attributes: { width: "8", height: "4", x: "8", y: "2", rx: "1", ry: "1" } },
    { tag: "path", attributes: { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" } },
    { tag: "path", attributes: { class: "jdx-icon-clip-line-1", d: "M12 11h4" } },
    { tag: "path", attributes: { class: "jdx-icon-clip-line-2", d: "M12 16h4" } },
    { tag: "path", attributes: { d: "M8 11h.01" } },
    { tag: "path", attributes: { d: "M8 16h.01" } },
  ],
  library: [
    { tag: "path", attributes: { d: "M4 4v16" } },
    { tag: "path", attributes: { d: "M8 8v12" } },
    { tag: "path", attributes: { d: "M12 6v14" } },
    { tag: "path", attributes: { class: "jdx-icon-lean-book", d: "m16 6 4 14" } },
  ],
  radar: [
    { tag: "circle", attributes: { class: "jdx-icon-radar-halo", cx: "12", cy: "12", r: "9", "stroke-width": "2" } },
    { tag: "circle", attributes: { class: "jdx-icon-radar-halo jdx-icon-radar-haze", cx: "12", cy: "12", r: "8", "stroke-width": "4" } },
    { tag: "path", attributes: { d: "M19.07 4.93A10 10 0 0 0 6.99 3.34" } },
    { tag: "path", attributes: { d: "M4 6h.01" } },
    { tag: "path", attributes: { d: "M2.29 9.62A10 10 0 1 0 21.31 8.35" } },
    { tag: "path", attributes: { d: "M16.24 7.76A6 6 0 1 0 8.23 16.67" } },
    { tag: "path", attributes: { d: "M12 18h.01" } },
    { tag: "path", attributes: { d: "M17.99 11.66A6 6 0 0 1 15.77 16.67" } },
    { tag: "circle", attributes: { cx: "12", cy: "12", r: "2" } },
    { tag: "path", attributes: { class: "jdx-icon-radar-sweep", d: "m13.41 10.59 5.66-5.66" } },
  ],
  settings: [
    {
      tag: "g",
      attributes: { class: "jdx-icon-gear" },
      children: [
        { tag: "path", attributes: { d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" } },
        { tag: "circle", attributes: { cx: "12", cy: "12", r: "3" } },
      ],
    },
  ],
  theme: [
    {
      tag: "g",
      attributes: { class: "jdx-icon-theme-sun-secondary", transform: "translate(-4.5 -4.5)" },
      children: [
        {
          tag: "g",
          attributes: { class: "jdx-icon-theme-secondary" },
          children: [
            { tag: "circle", attributes: { cx: "12", cy: "12", r: "4" } },
            { tag: "path", attributes: { d: "M12 2v2" } },
            { tag: "path", attributes: { d: "M12 20v2" } },
            { tag: "path", attributes: { d: "m4.93 4.93 1.41 1.41" } },
            { tag: "path", attributes: { d: "m17.66 17.66 1.41 1.41" } },
            { tag: "path", attributes: { d: "M2 12h2" } },
            { tag: "path", attributes: { d: "M20 12h2" } },
            { tag: "path", attributes: { d: "m6.34 17.66-1.41 1.41" } },
            { tag: "path", attributes: { d: "m19.07 4.93-1.41 1.41" } },
          ],
        },
      ],
    },
    {
      tag: "g",
      attributes: { class: "jdx-icon-theme-moon-secondary", transform: "translate(-4.5 -4.5)" },
      children: [
        { tag: "g", attributes: { class: "jdx-icon-theme-secondary" }, children: [{ tag: "path", attributes: { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" } }] },
      ],
    },
    {
      tag: "g",
      attributes: { class: "jdx-icon-theme-primary jdx-icon-theme-sun-primary" },
      children: [
        { tag: "circle", attributes: { cx: "12", cy: "12", r: "4" } },
        { tag: "path", attributes: { d: "M12 2v2" } },
        { tag: "path", attributes: { d: "M12 20v2" } },
        { tag: "path", attributes: { d: "m4.93 4.93 1.41 1.41" } },
        { tag: "path", attributes: { d: "m17.66 17.66 1.41 1.41" } },
        { tag: "path", attributes: { d: "M2 12h2" } },
        { tag: "path", attributes: { d: "M20 12h2" } },
        { tag: "path", attributes: { d: "m6.34 17.66-1.41 1.41" } },
        { tag: "path", attributes: { d: "m19.07 4.93-1.41 1.41" } },
      ],
    },
    {
      tag: "g",
      attributes: { class: "jdx-icon-theme-primary jdx-icon-theme-moon-primary" },
      children: [{ tag: "path", attributes: { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" } }],
    },
  ],
}

function appendSvgNode(document: Document, parent: SVGElement, node: SvgNode) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", node.tag)
  for (const [name, value] of Object.entries(node.attributes ?? {})) element.setAttribute(name, value)
  for (const child of node.children ?? []) appendSvgNode(document, element, child)
  parent.append(element)
}

/** 生成与 Webapp 24×24、2px currentColor 资产一致的 Manager 图标。 */
export function createManagerNavigationIcon(document: Document, id: ManagerNavigationIconId): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  icon.setAttribute("class", `jdx-manager-nav-icon${id === "theme" ? " jdx-manager-theme-icon" : ""}`)
  icon.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  icon.setAttribute("width", "16")
  icon.setAttribute("height", "16")
  icon.setAttribute("viewBox", "0 0 24 24")
  icon.setAttribute("fill", "none")
  icon.setAttribute("stroke", "currentColor")
  icon.setAttribute("stroke-width", "2")
  icon.setAttribute("stroke-linecap", "round")
  icon.setAttribute("stroke-linejoin", "round")
  icon.setAttribute("aria-hidden", "true")
  icon.setAttribute("focusable", "false")
  icon.dataset.jdxIconId = id
  for (const shape of iconShapes[id]) appendSvgNode(document, icon, shape)
  return icon
}

/** 为静态 Manager 导航占位挂载图标，并保留一次性点击动效的生命周期。 */
export function initializeManagerNavigationIcons(document: Document): () => void {
  for (const placeholder of Array.from(document.querySelectorAll<HTMLElement>("[data-jdx-icon-id]"))) {
    const id = placeholder.dataset.jdxIconId as ManagerNavigationIconId
    const button = placeholder.closest<HTMLButtonElement>("button")
    if (!button) continue
    button.dataset.jdxAnimatedNav = "true"
    placeholder.replaceWith(createManagerNavigationIcon(document, id))
  }

  const sidebar = document.getElementById("jadense-manager-sidebar")
  if (!sidebar) return () => {}
  const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()
  const triggerPress = (event: Event) => {
    const target = event.target as Element | null
    const button = target?.closest<HTMLButtonElement>('button[data-jdx-animated-nav="true"]')
    if (!button || !sidebar.contains(button)) return
    button.dataset.jdxIconPress = "true"
    const existing = timers.get(button)
    if (existing) clearTimeout(existing)
    timers.set(button, setTimeout(() => {
      button.removeAttribute("data-jdx-icon-press")
      timers.delete(button)
    }, 1200))
  }
  sidebar.addEventListener("click", triggerPress)
  return () => {
    sidebar.removeEventListener("click", triggerPress)
    for (const [button, timer] of timers) {
      clearTimeout(timer)
      button.removeAttribute("data-jdx-icon-press")
    }
    timers.clear()
  }
}
