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
export function resolvePopupMaxHeight(availableSpace: number) {
  return Math.max(POPUP_MIN_HEIGHT, Math.min(POPUP_MAX_HEIGHT, Math.floor(availableSpace)))
}

function htmlElement<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K): HTMLElementTagNameMap[K] {
  return doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]
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
} = {}): JdxSelect {
  const doc = host.ownerDocument
  const hostId = host.id || "jdx-select"
  const state = {
    options: [] as JdxSelectOption[],
    value: "",
    open: false,
    activeIndex: -1,
    disabled: false,
    query: "",
  }
  const listeners = new Set<JdxSelectChangeListener>()

  host.classList.add("jdx-select")
  host.dataset.open = "false"

  const trigger = htmlElement(doc, "button")
  trigger.type = "button"
  trigger.className = "jdx-select-trigger"
  trigger.setAttribute("aria-haspopup", "listbox")
  trigger.setAttribute("aria-expanded", "false")
  if (input.ariaLabel) trigger.setAttribute("aria-label", input.ariaLabel)

  const valueLabel = htmlElement(doc, "span")
  valueLabel.className = "jdx-select-value"
  trigger.append(valueLabel, createChevron(doc))

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
    valueLabel.textContent = selected?.label ?? "—"
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
      const main = htmlElement(doc, "span")
      main.className = "jdx-select-option-main"
      const label = htmlElement(doc, "span")
      label.className = "jdx-select-option-label"
      label.textContent = option.label
      main.append(label)
      if (option.meta) {
        const meta = htmlElement(doc, "span")
        meta.className = "jdx-select-option-meta"
        meta.textContent = option.meta
        main.append(meta)
      }
      row.append(main)
      if (option.description) {
        const description = htmlElement(doc, "span")
        description.className = "jdx-select-option-description"
        description.textContent = option.description
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
      if (scroll) rows[index].scrollIntoView({ block: "nearest" })
    } else {
      trigger.removeAttribute("aria-activedescendant")
      search?.removeAttribute("aria-activedescendant")
    }
  }

  function positionPopup() {
    const rect = trigger.getBoundingClientRect()
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
    popup.style.maxHeight = `${resolvePopupMaxHeight(openUp ? spaceAbove : spaceBelow)}px`
    if (openUp) {
      popup.style.top = ""
      popup.style.bottom = `${Math.round(viewportHeight - rect.top + POPUP_TRIGGER_GAP)}px`
    } else {
      popup.style.bottom = ""
      popup.style.top = `${Math.round(rect.bottom + POPUP_TRIGGER_GAP)}px`
    }
  }

  function onDocumentPointerDown(event: Event) {
    if (!host.contains(event.target as Node)) close()
  }

  function onDocumentScroll(event: Event) {
    if (!popup.contains(event.target as Node)) close()
  }

  function open() {
    if (state.open || state.disabled) return
    state.open = true
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
    search?.focus()
  }

  function close() {
    if (!state.open) return
    state.open = false
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
