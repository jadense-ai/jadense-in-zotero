import { uiText } from "@/zotero/ui-preferences"
/**
 * Jadense 自研下拉组件。
 * Zotero chrome 窗口中原生 <select> 的弹出层是文档内 XUL menupopup，缺少主题样式，
 * 会以透明背景渲染、与页面文字重叠；该组件用 fixed 定位的自绘弹出层彻底绕开原生弹出层。
 * 同时兼容 manager 的 HTML 文档与 preferences 的 XUL 文档（统一以 XHTML 命名空间创建元素）。
 */

export type JdxSelectOption = {
  value: string
  label: string
  description?: string
  group?: string
  meta?: string
  disabled?: boolean
  /** 本地静态图标路径，仅用于紧凑展示，不加载外部资源。 */
  iconPath?: string
  /** 随插件打包的品牌 Logo。 */
  iconSrc?: string
  iconThemed?: boolean
}

export type JdxSelectChangeListener = (value: string) => void

export type JdxSelect = {
  /** 增强后的宿主元素（保留原 id）。 */
  readonly element: HTMLElement
  getValue(): string
  /** 仅在选项中存在该值时更新（对齐旧 syncFolderSelection 的语义），不触发 change。 */
  setValue(value: string): void
  setOptions(options: JdxSelectOption[], selectedValue: string): void
  setDisabled(disabled: boolean): void
  /** 仅在用户主动选择且值发生变化时触发，对齐原生 select 的 change。 */
  onChange(listener: JdxSelectChangeListener): void
  close(): void
  destroy(): void
}

type JdxSelectMoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End"

const POPUP_MAX_HEIGHT = 240
const POPUP_MIN_HEIGHT = 48
const POPUP_FLIP_THRESHOLD = 140
const POPUP_VIEWPORT_GAP = 8
const POPUP_TRIGGER_GAP = 4

/** 请求值存在于选项中则选中，否则回落到空值占位行（等价原生 select 的未匹配回落）。 */
export function resolveSelectedValue(options: JdxSelectOption[], requested: string) {
  return options.some((option) => option.value === requested) ? requested : ""
}

export function filterSelectOptions(options: JdxSelectOption[], query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return options
  return options.filter(option => [option.label, option.description, option.group, option.meta]
    .filter(Boolean)
    .some(value => value!.toLocaleLowerCase().includes(normalized)))
}

/** 打开状态下方向键循环移动高亮索引；没有选项时返回 -1。 */
export function moveActiveIndex(current: number, key: JdxSelectMoveKey, count: number) {
  if (count <= 0) return -1
  if (key === "Home") return 0
  if (key === "End") return count - 1
  const start = current < 0 ? (key === "ArrowDown" ? -1 : 0) : current
  return (start + (key === "ArrowDown" ? 1 : -1) + count) % count
}

/** 下方空间不足且上方更宽敞时向上展开。 */
export function shouldOpenUp(spaceBelow: number, spaceAbove: number) {
  return spaceBelow < POPUP_FLIP_THRESHOLD && spaceAbove > spaceBelow
}

/** 弹出层最大高度：默认 240px，受可用空间约束，保留最小可视高度。 */
export function resolvePopupMaxHeight(availableSpace: number, maximum = POPUP_MAX_HEIGHT) {
  return Math.max(POPUP_MIN_HEIGHT, Math.min(maximum, Math.floor(availableSpace)))
}

function htmlElement<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K): HTMLElementTagNameMap[K] {
  return doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]
}

/** 紧凑列表使用统一线性图标，静态路径来自调用方，兼容 XHTML / XUL 文档。 */
function createOptionIcon(doc: Document, pathData: string) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("class", "jdx-select-option-icon")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "1.7")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", pathData)
  svg.append(path)
  return svg
}

function createLogo(doc: Document, src: string, themed = false) {
  if (themed) {
    const mask = htmlElement(doc, "span")
    mask.className = "jdx-select-option-icon"
    mask.style.cssText = `background:currentColor;mask:url("${src}") center/contain no-repeat;display:inline-block;width:18px;height:18px`
    mask.setAttribute("aria-hidden", "true")
    return mask
  }
  const image = htmlElement(doc, "img")
  image.className = "jdx-select-option-icon"
  image.src = src
  image.alt = ""
  image.setAttribute("aria-hidden", "true")
  return image
}

function createChevron(doc: Document) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("class", "jdx-select-chevron")
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", "14")
  svg.setAttribute("height", "14")
  svg.setAttribute("aria-hidden", "true")
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", "M4 6.5 8 10.5 12 6.5")
  path.setAttribute("fill", "none")
  path.setAttribute("stroke", "currentColor")
  path.setAttribute("stroke-width", "1.6")
  path.setAttribute("stroke-linecap", "round")
  path.setAttribute("stroke-linejoin", "round")
  svg.append(path)
  return svg
}

export function createJdxSelect(host: HTMLElement, input: {
  ariaLabel?: string
  popupWidth?: number
  searchPlaceholder?: string
  compact?: boolean
  iconPath?: string
  portal?: boolean
  showSelectedIcon?: boolean
} = {}): JdxSelect {
  const doc = host.ownerDocument
  const hostId = host.id || `jdx-select-${Math.random().toString(36).slice(2)}`
  const state = {
    options: [] as JdxSelectOption[],
    value: "",
    open: false,
    activeIndex: -1,
    disabled: false,
    query: "",
  }
  const listeners = new Set<JdxSelectChangeListener>()
  let anchorTop = 0, anchorLeft = 0

  host.classList.add("jdx-select")
  if (input.compact) host.classList.add("jdx-select-compact")
  host.dataset.open = "false"

  const trigger = htmlElement(doc, "button")
  trigger.type = "button"
  trigger.className = "jdx-select-trigger"
  trigger.setAttribute("aria-haspopup", "listbox")
  trigger.setAttribute("aria-expanded", "false")
  if (input.ariaLabel) trigger.setAttribute("aria-label", input.ariaLabel)

  const valueLabel = htmlElement(doc, "span")
  valueLabel.className = "jdx-select-value"
  const selectedIcon = input.showSelectedIcon ? htmlElement(doc, "span") : null
  if (selectedIcon) { selectedIcon.className = "jdx-select-leading-icon"; selectedIcon.setAttribute("aria-hidden", "true"); trigger.append(selectedIcon) }
  trigger.append(valueLabel, createChevron(doc))
  if (input.iconPath) {
    trigger.replaceChildren(createOptionIcon(doc, input.iconPath))
    host.classList.add("jdx-select-icon-only")
  }
  const portal = input.portal ? htmlElement(doc, "div") : null
  if (portal) { portal.className = `jdx-select jdx-select-portal${input.compact ? " jdx-select-compact" : ""}`; portal.dataset.open = "true" }

  const popup = htmlElement(doc, "div")
  popup.className = "jdx-select-popup"
  const search = input.searchPlaceholder ? htmlElement(doc, "input") : null
  if (search) {
    search.type = "search"
    search.className = "jdx-select-search"
    search.placeholder = input.searchPlaceholder!
    search.setAttribute("aria-label", input.searchPlaceholder!)
    search.setAttribute("role", "combobox")
    search.setAttribute("aria-autocomplete", "list")
  }
  const list = htmlElement(doc, "ul")
  list.className = "jdx-select-list"
  list.id = `${hostId}-listbox`
  list.setAttribute("role", "listbox")
  if (input.ariaLabel) list.setAttribute("aria-label", input.ariaLabel)
  trigger.setAttribute("aria-controls", list.id)
  search?.setAttribute("aria-controls", list.id)
  popup.append(...(search ? [search, list] : [list]))
  host.append(trigger, popup)

  function optionId(index: number) {
    return `${hostId}-option-${index}`
  }

  function renderTrigger() {
    const selected = state.options.find((option) => option.value === state.value) ?? null
    if (selectedIcon) {
      const path = selected?.iconPath ?? "M6 6h12v12H6zM9 9h6v6H9zM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"
      const key = selected?.iconSrc ?? path
      if (selectedIcon.dataset.path !== key) { selectedIcon.replaceChildren(selected?.iconSrc ? createLogo(doc, selected.iconSrc, selected.iconThemed) : createOptionIcon(doc, path)); selectedIcon.dataset.path = key }
    }
    valueLabel.textContent = selected?.label ?? "—"
    trigger.title = selected?.label ?? ""
    valueLabel.dataset.placeholder = String(state.value === "")
    if (input.ariaLabel) trigger.setAttribute("aria-label", `${input.ariaLabel}：${selected?.label ?? uiText("未选择", "Not selected")}`)
    trigger.disabled = state.disabled
    trigger.setAttribute("aria-expanded", String(state.open))
    search?.setAttribute("aria-expanded", String(state.open))
    host.dataset.open = String(state.open)
  }

  function renderOptions() {
    const options = filterSelectOptions(state.options, state.query)
    list.replaceChildren()
    if (options.length === 0) {
      const empty = htmlElement(doc, "li")
      empty.className = "jdx-select-empty"
      empty.textContent = state.query ? uiText("没有匹配的选项", "No matching options") : "—"
      list.append(empty)
      return
    }
    let currentGroup = ""
    options.forEach((option, index) => {
      if (option.group && option.group !== currentGroup) {
        currentGroup = option.group
        const heading = htmlElement(doc, "li")
        heading.className = "jdx-select-group"
        heading.setAttribute("role", "presentation")
        heading.textContent = option.group
        list.append(heading)
      }
      const row = htmlElement(doc, "li")
      row.className = "jdx-select-option"
      row.id = optionId(index)
      row.setAttribute("role", "option")
      row.setAttribute("aria-selected", String(option.value === state.value))
      row.setAttribute("aria-disabled", String(option.disabled === true))
      row.dataset.active = String(index === state.activeIndex)
      if (input.compact) row.title = [option.label, option.description, option.meta].filter(Boolean).join("\n")
      const main = htmlElement(doc, "span")
      main.className = "jdx-select-option-main"
      const label = htmlElement(doc, "span")
      label.className = "jdx-select-option-label"
      label.textContent = option.label
      if (input.compact && option.iconSrc) main.append(createLogo(doc, option.iconSrc, option.iconThemed))
      else if (input.compact && option.iconPath) main.append(createOptionIcon(doc, option.iconPath))
      main.append(label)
      if (option.meta) {
        const meta = htmlElement(doc, "span")
        meta.className = "jdx-select-option-meta"
        meta.textContent = option.meta
        main.append(meta)
      }
      if (input.compact) {
        const status = createOptionIcon(doc, option.disabled
          ? "M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3"
          : option.value === state.value ? "m5 12 4 4L19 6" : "")
        status.classList.add("jdx-select-option-status")
        main.append(status)
      }
      row.append(main)
      if (option.description) {
        const description = htmlElement(doc, "span")
        description.className = "jdx-select-option-description"
        description.textContent = option.description
        if (input.compact) {
          description.id = `${row.id}-description`
          row.setAttribute("aria-describedby", description.id)
        }
        row.append(description)
      }
      row.addEventListener("mouseenter", () => setActiveIndex(index, false))
      row.addEventListener("click", () => selectIndex(index, true))
      list.append(row)
    })
  }

  function setActiveIndex(index: number, scroll: boolean) {
    state.activeIndex = index
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".jdx-select-option"))
    rows.forEach((row, rowIndex) => {
      row.dataset.active = String(rowIndex === index)
    })
    if (index >= 0 && index < rows.length) {
      trigger.setAttribute("aria-activedescendant", optionId(index))
      search?.setAttribute("aria-activedescendant", optionId(index))
      if (scroll) {
        // 仅滚动选项弹层；scrollIntoView 会带动外层阅读区并触发其关闭监听。
        const rowBounds = rows[index].getBoundingClientRect(), popupBounds = popup.getBoundingClientRect()
        if (rowBounds.top < popupBounds.top) popup.scrollTop += rowBounds.top - popupBounds.top
        else if (rowBounds.bottom > popupBounds.bottom) popup.scrollTop += rowBounds.bottom - popupBounds.bottom
      }
    } else {
      trigger.removeAttribute("aria-activedescendant")
      search?.removeAttribute("aria-activedescendant")
    }
  }

  function positionPopup() {
    const rect = trigger.getBoundingClientRect()
    anchorTop = rect.top; anchorLeft = rect.left
    const viewportHeight = doc.defaultView?.innerHeight ?? 640
    const viewportWidth = doc.defaultView?.innerWidth ?? 960
    const spaceBelow = viewportHeight - rect.bottom - POPUP_VIEWPORT_GAP
    const spaceAbove = rect.top - POPUP_VIEWPORT_GAP
    const openUp = shouldOpenUp(spaceBelow, spaceAbove)
    const width = Math.min(Math.max(rect.width, input.popupWidth ?? 0), viewportWidth - (POPUP_VIEWPORT_GAP * 2))
    const left = Math.min(
      Math.max(POPUP_VIEWPORT_GAP, rect.left),
      viewportWidth - POPUP_VIEWPORT_GAP - width,
    )
    popup.style.left = `${Math.round(left)}px`
    popup.style.width = `${Math.round(width)}px`
    popup.style.maxHeight = `${resolvePopupMaxHeight(openUp ? spaceAbove : spaceBelow, input.compact ? 448 : POPUP_MAX_HEIGHT)}px`
    if (openUp) {
      popup.style.top = ""
      popup.style.bottom = `${Math.round(viewportHeight - rect.top + POPUP_TRIGGER_GAP)}px`
    } else {
      popup.style.bottom = ""
      popup.style.top = `${Math.round(rect.bottom + POPUP_TRIGGER_GAP)}px`
    }
  }

  function onDocumentPointerDown(event: Event) {
    if (!host.contains(event.target as Node) && !popup.contains(event.target as Node)) close()
  }

  function onDocumentScroll(event: Event) {
    if (popup.contains(event.target as Node)) return
    // Gecko 的焦点/滚动锚定可派发位置未变化的 scroll；固定底部工具条仍可安全保持弹层。
    const rect = trigger.getBoundingClientRect()
    if (Math.abs(rect.top - anchorTop) > 1 || Math.abs(rect.left - anchorLeft) > 1) close()
  }

  function open() {
    if (state.open || state.disabled) return
    state.open = true
    if (portal) {
      const computed = doc.defaultView?.getComputedStyle(host)
      for (const token of ["text", "muted", "line-strong", "surface", "green-deep", "active-bg", "active-text", "press-bg", "popup-shadow", "green"]) portal.style.setProperty(`--jdx-${token}`, computed?.getPropertyValue(`--jdx-${token}`) ?? "")
      portal.style.font = computed?.font || "13px system-ui"
      portal.style.color = "var(--jdx-text)"
      portal.append(popup); (doc.body || doc.documentElement).append(portal)
    }
    state.query = ""
    if (search) search.value = ""
    const options = filterSelectOptions(state.options, state.query)
    state.activeIndex = options.findIndex((option) => option.value === state.value)
    if (state.activeIndex < 0 && state.options.length > 0) state.activeIndex = 0
    renderOptions()
    renderTrigger()
    positionPopup()
    setActiveIndex(state.activeIndex, true)
    doc.addEventListener("pointerdown", onDocumentPointerDown, true)
    doc.addEventListener("scroll", onDocumentScroll, true)
    doc.defaultView?.addEventListener("resize", close)
    search?.focus({ preventScroll: true })
  }

  function close() {
    if (!state.open) return
    state.open = false
    if (portal) { host.append(popup); portal.remove() }
    state.activeIndex = -1
    renderTrigger()
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true)
    doc.removeEventListener("scroll", onDocumentScroll, true)
    doc.defaultView?.removeEventListener("resize", close)
  }

  function selectIndex(index: number, notify: boolean) {
    const option = filterSelectOptions(state.options, state.query)[index] ?? null
    if (!option || option.disabled) return
    close()
    const changed = option.value !== state.value
    state.value = option.value
    renderOptions()
    renderTrigger()
    if (notify) trigger.focus()
    if (notify && changed) {
      for (const listener of listeners) listener(option.value)
    }
  }

  trigger.addEventListener("click", () => {
    if (state.open) close()
    else open()
  })

  trigger.addEventListener("keydown", (event) => {
    if (state.disabled) return
    if (!state.open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        open()
      }
      return
    }
    handleOpenKeydown(event)
  })

  function handleOpenKeydown(event: KeyboardEvent) {
    const options = filterSelectOptions(state.options, state.query)
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End":
        event.preventDefault()
        setActiveIndex(moveActiveIndex(state.activeIndex, event.key, options.length), true)
        break
      case "Enter":
      case " ":
        if (event.key === " " && event.target === search) return
        // 阻止 button 默认 click，避免选中后又被触发一次开合。
        event.preventDefault()
        selectIndex(state.activeIndex, true)
        break
      case "Escape":
        event.preventDefault()
        close()
        trigger.focus()
        break
      case "Tab":
        close()
        break
    }
  }

  search?.addEventListener("input", () => {
    state.query = search.value
    const options = filterSelectOptions(state.options, state.query)
    state.activeIndex = options.length ? 0 : -1
    renderOptions()
    setActiveIndex(state.activeIndex, false)
  })
  search?.addEventListener("keydown", (event) => handleOpenKeydown(event))

  renderOptions()
  renderTrigger()

  return {
    element: host,
    close,
    destroy() { close(); listeners.clear(); trigger.remove(); popup.remove(); portal?.remove() },
    getValue: () => state.value,
    setValue(value: string) {
      if (!state.options.some((option) => option.value === value)) return
      state.value = value
      renderTrigger()
    },
    setOptions(options: JdxSelectOption[], selectedValue: string) {
      close()
      state.options = options.slice()
      state.value = resolveSelectedValue(state.options, selectedValue)
      state.activeIndex = -1
      renderOptions()
      renderTrigger()
    },
    setDisabled(disabled: boolean) {
      state.disabled = disabled
      if (disabled) close()
      renderTrigger()
    },
    onChange(listener: JdxSelectChangeListener) {
      listeners.add(listener)
    },
  }
}
