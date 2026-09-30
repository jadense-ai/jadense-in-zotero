import { createChevron } from "./chevron"
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
  /** 禁选行仍可点按；调用方可将此原因交给 Toast。 */
  disabledReason?: string
  /** 本地静态图标路径，仅用于紧凑展示，不加载外部资源。 */
  iconPath?: string
  /** 随插件打包的品牌 Logo。 */
  iconSrc?: string
  iconThemed?: boolean
}

export type JdxSelectChangeListener = (value: string) => void

/** 仅模型宿主启用：目录决定档位，宿主负责持久化；普通下拉保持原行为。 */
export type JdxModelControl = {
  selectionKey?: string
  levels: { value: string; label: string }[]
  value: string
  label: string
  onCommit?: (value: string) => void
}

export type JdxSelect = {
  /** 增强后的宿主元素（保留原 id）。 */
  readonly element: HTMLElement
  getValue(): string
  /** 仅在选项中存在该值时更新（对齐旧 syncFolderSelection 的语义），不触发 change。 */
  setValue(value: string): void
  setOptions(options: JdxSelectOption[], selectedValue: string): void
  setDisabled(disabled: boolean): void
  setModelControl(control: JdxModelControl): void
  /** 仅在用户主动选择且值发生变化时触发，对齐原生 select 的 change。 */
  onChange(listener: JdxSelectChangeListener): void
  onOpen(listener: () => void): void
  onDisabledSelect(listener: (option: JdxSelectOption) => void): void
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
  const openListeners = new Set<() => void>()
  const disabledListeners = new Set<(option: JdxSelectOption) => void>()
  let anchorTop = 0, anchorLeft = 0
  let modelControl: JdxModelControl | undefined
  let modelView: "model" | "route" | "list" = "model"

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
  trigger.append(valueLabel, createChevron(doc, "jdx-select-chevron", "down", 14))
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
  const modelPanel = htmlElement(doc, "div")
  modelPanel.className = "jdx-model-panel"
  modelPanel.hidden = true
  popup.prepend(modelPanel)
  const effortBadge = htmlElement(doc, "span")
  effortBadge.className = "jdx-model-effort"
  effortBadge.hidden = true
  valueLabel.after(effortBadge)

  function visibleOptions() {
    const options = modelControl ? state.options.filter(option => modelView === "route" ? option.value.startsWith("route:") : !option.value.startsWith("route:")) : state.options
    return filterSelectOptions(options, state.query)
  }

  /** 浏览路由/模型不保存；只有选中模型和完成调档手势才写入宿主偏好。 */
  function renderModelPanel() {
    if (!modelControl) return
    modelPanel.hidden = false
    modelPanel.replaceChildren()
    popup.classList.add("jdx-model-popup")
    popup.dataset.modelView = modelView
    list.hidden = modelView === "model"
    if (search) search.hidden = modelView !== "list"
    const header = htmlElement(doc, "div")
    header.className = "jdx-model-header"
    const button = (label: string, action: () => void) => {
      const node = htmlElement(doc, "button")
      node.type = "button"; node.textContent = label; node.title = label
      node.setAttribute("aria-label", label); node.addEventListener("click", action)
      return node
    }
    const switchView = (view: typeof modelView) => {
      modelView = view; state.query = ""; if (search) search.value = ""
      state.activeIndex = -1; renderOptions(); renderModelPanel(); positionPopup()
      if (view === "list") search?.focus({ preventScroll: true })
      else modelPanel.querySelector<HTMLButtonElement>(".jdx-model-heading")?.focus({ preventScroll: true })
    }
    if (modelView === "list") {
      const back = button(uiText("返回思考设置", "Back to thinking settings"), () => switchView("model"))
      back.replaceChildren(createChevron(doc, "", "left", 16)); header.append(back)
      const title = htmlElement(doc, "span"); title.textContent = uiText("模型列表", "Models"); header.append(title)
      modelPanel.append(header); return
    }
    const mode = button(modelView === "route" ? uiText("切换到指定模型", "Use a specific model") : uiText("切换到智能路由", "Use smart routing"), () => switchView(modelView === "route" ? "model" : "route"))
    mode.replaceChildren(createOptionIcon(doc, modelView === "route" ? "M3 12h6l6-6h6M9 12l6 6h6" : "M6 6h12v12H6zM9 9h6v6H9zM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"))
    mode.disabled = !state.options.some(option => option.value.startsWith("route:"))
    const selected = state.options.find(option => option.value === state.value)
    const selectedIsRoute = state.value.startsWith("route:")
    const heading = button(modelView === "route" ? uiText("智能路由", "Smart routing") : modelControl.label, () => { if (modelView === "model") switchView("list") })
    heading.className = "jdx-model-heading"
    if (modelView === "model") {
      const title = htmlElement(doc, "span"); title.className = "jdx-model-heading-effort"
      title.append(doc.createTextNode(modelControl.label), createChevron(doc, "", "right", 14))
      const name = htmlElement(doc, "span"); name.className = "jdx-model-heading-name"
      name.textContent = selectedIsRoute ? uiText("选择模型", "Choose a model") : selected?.label ?? uiText("选择模型", "Choose a model")
      heading.replaceChildren(title, name)
    }
    const auto = button(modelView === "route" ? uiText("恢复默认路由", "Reset route") : uiText("自动", "Auto"), () => {
      if (modelView === "route") {
        const index = visibleOptions().findIndex(option => option.value === "route:standard")
        selectIndex(index, true)
      } else modelControl?.onCommit?.("auto")
    })
    auto.disabled = modelView === "route" ? !visibleOptions().some(option => option.value === "route:standard" && !option.disabled) : selectedIsRoute || !modelControl.onCommit || state.disabled
    if (modelView === "model") auto.setAttribute("aria-pressed", String(modelControl.value === "auto"))
    else auto.replaceChildren(createOptionIcon(doc, "M3 10a9 9 0 1 1 2 8M3 3v7h7"))
    header.append(mode, heading, auto); modelPanel.append(header)
    if (modelView !== "model") return
    const rangeWrap = htmlElement(doc, "div"); rangeWrap.className = "jdx-thinking-range"
    const track = htmlElement(doc, "div"); track.className = "jdx-thinking-track"; track.setAttribute("aria-hidden", "true")
    const fill = htmlElement(doc, "span"); fill.className = "jdx-thinking-fill"
    const dots = htmlElement(doc, "span"); dots.className = "jdx-thinking-dots"
    modelControl.levels.forEach(() => dots.append(htmlElement(doc, "span")))
    track.append(fill, dots); rangeWrap.append(track)
    const range = htmlElement(doc, "input")
    range.type = "range"; range.className = "jdx-model-thinking-range"
    range.min = "0"; range.max = String(Math.max(1, modelControl.levels.length - 1)); range.step = "1"
    const index = modelControl.levels.findIndex(level => level.value === modelControl!.value)
    range.value = String(Math.max(0, index)); range.dataset.automatic = String(index < 0)
    const paintRange = (index: number) => {
      const percent = Math.max(0, index) / Math.max(1, modelControl!.levels.length - 1) * 100
      fill.style.width = index < 0 ? "100%" : `calc(${percent}% + ${14 - percent * .28}px)`
      fill.style.setProperty("--thinking-particle-duration", index < 0 ? "6s" : `${12 / (1 + percent / 20)}s`)
    }
    paintRange(index)
    range.setAttribute("aria-label", uiText("思考档位", "Thinking effort")); range.setAttribute("aria-valuetext", modelControl.label)
    range.disabled = selectedIsRoute || !modelControl.onCommit || modelControl.levels.length < 2 || state.disabled
    const signature = modelControl
    let gesture: "pointer" | "keyboard" | null = null
    const commitRange = () => {
      const level = signature.levels[Number(range.value)]
      gesture = null
      if (signature === modelControl && level && !range.disabled && !state.disabled && state.open) modelControl.onCommit?.(level.value)
    }
    range.addEventListener("pointerdown", event => { if (!range.disabled) { gesture = "pointer"; range.setPointerCapture?.(event.pointerId) } })
    range.addEventListener("pointerup", () => { if (gesture === "pointer") commitRange() })
    range.addEventListener("pointercancel", () => { gesture = null; range.value = String(Math.max(0, index)); paintRange(index) })
    range.addEventListener("keydown", event => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) gesture = "keyboard"
      else if (event.key === "Escape") gesture = null
    })
    range.addEventListener("keyup", event => {
      if (gesture === "keyboard" && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) commitRange()
    })
    range.addEventListener("blur", () => { if (gesture === "keyboard") commitRange() })
    range.addEventListener("input", () => {
      const level = signature.levels[Number(range.value)]
      if (!level) return
      range.dataset.automatic = "false"; range.setAttribute("aria-valuetext", level.label)
      paintRange(Number(range.value))
      const label = heading.querySelector(".jdx-model-heading-effort")
      if (label) label.firstChild!.textContent = level.label
    })
    range.addEventListener("change", () => {
      if (!gesture) commitRange()
    })
    rangeWrap.append(range); modelPanel.append(rangeWrap)
  }

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
    effortBadge.hidden = !modelControl || !selected || state.value.startsWith("route:")
    effortBadge.textContent = modelControl?.label ?? ""
    trigger.title = selected?.label ?? ""
    if (!effortBadge.hidden) trigger.title += ` · ${uiText("思考", "Thinking")}: ${modelControl!.label}`
    valueLabel.dataset.placeholder = String(state.value === "")
    if (input.ariaLabel) trigger.setAttribute("aria-label", `${input.ariaLabel}：${trigger.title || uiText("未选择", "Not selected")}`)
    trigger.disabled = state.disabled
    trigger.setAttribute("aria-expanded", String(state.open))
    search?.setAttribute("aria-expanded", String(state.open))
    host.dataset.open = String(state.open)
  }

  function renderOptions() {
    const options = visibleOptions()
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
      if (option.disabled || modelControl) row.tabIndex = 0
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
      if (input.compact || option.disabled) {
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
      row.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectIndex(index, true) }
        else if (event.key === "Escape" && !modelControl) { event.preventDefault(); close(); trigger.focus() }
      })
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
    const fontScale = Number(doc.defaultView?.getComputedStyle(host).getPropertyValue("--jdx-font-scale")) || 1
    const width = Math.min(modelControl ? (modelView === "list" ? 304 : 256) * fontScale : Math.max(rect.width, input.popupWidth ?? 0), viewportWidth - (POPUP_VIEWPORT_GAP * 2))
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
    if (modelControl) { modelView = state.value.startsWith("route:") ? "route" : "model"; renderModelPanel() }
    if (portal) {
      const computed = doc.defaultView?.getComputedStyle(host)
      for (const token of ["text", "muted", "line-strong", "surface", "subtle", "font-scale", "green-deep", "active-bg", "active-text", "press-bg", "popup-shadow", "green"]) portal.style.setProperty(`--jdx-${token}`, computed?.getPropertyValue(`--jdx-${token}`) ?? "")
      portal.style.font = computed?.font || "13px system-ui"
      portal.style.color = "var(--jdx-text)"
      portal.append(popup); (doc.body || doc.documentElement).append(portal)
    }
    state.query = ""
    if (search) search.value = ""
    const options = visibleOptions()
    state.activeIndex = options.findIndex((option) => option.value === state.value)
    if (state.activeIndex < 0 && state.options.length > 0) state.activeIndex = 0
    renderOptions()
    renderTrigger()
    positionPopup()
    setActiveIndex(state.activeIndex, true)
    doc.addEventListener("pointerdown", onDocumentPointerDown, true)
    doc.addEventListener("scroll", onDocumentScroll, true)
    // Gecko 视图/字体变化也可能触发 resize；保持键盘上下文，只重算弹层位置。
    doc.defaultView?.addEventListener("resize", positionPopup)
    if (modelControl) modelPanel.querySelector<HTMLButtonElement>(".jdx-model-heading")?.focus({ preventScroll: true })
    else search?.focus({ preventScroll: true })
    for (const listener of openListeners) listener()
  }

  function close() {
    if (!state.open) return
    state.open = false
    if (portal) { host.append(popup); portal.remove() }
    state.activeIndex = -1
    renderTrigger()
    doc.removeEventListener("pointerdown", onDocumentPointerDown, true)
    doc.removeEventListener("scroll", onDocumentScroll, true)
    doc.defaultView?.removeEventListener("resize", positionPopup)
  }

  function selectIndex(index: number, notify: boolean) {
    const option = visibleOptions()[index] ?? null
    if (!option) return
    if (option.disabled) {
      if (notify) for (const listener of disabledListeners) listener(option)
      return
    }
    if (!modelControl || modelView === "route") close()
    const changed = option.value !== state.value
    state.value = option.value
    renderOptions()
    renderTrigger()
    if (notify) trigger.focus()
    if (notify && changed) {
      for (const listener of listeners) listener(option.value)
    }
    if (modelControl && state.open) { modelView = "model"; renderModelPanel(); renderOptions(); positionPopup(); modelPanel.querySelector<HTMLButtonElement>(".jdx-model-heading")?.focus({ preventScroll: true }) }
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
    const options = visibleOptions()
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End":
        event.preventDefault()
        setActiveIndex(moveActiveIndex(state.activeIndex, event.key, options.length), true)
        if (modelControl && event.target !== search) list.querySelectorAll<HTMLElement>('[role="option"]')[state.activeIndex]?.focus()
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
        if (modelControl && modelView === "list") { modelView = "model"; renderOptions(); renderModelPanel(); positionPopup(); modelPanel.querySelector<HTMLButtonElement>(".jdx-model-heading")?.focus({ preventScroll: true }); break }
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
    const options = visibleOptions()
    state.activeIndex = options.length ? 0 : -1
    renderOptions()
    setActiveIndex(state.activeIndex, false)
  })
  search?.addEventListener("keydown", (event) => handleOpenKeydown(event))
  popup.addEventListener("keydown", event => {
    if (!modelControl || event.target === search) return
    if (event.key === "Escape") { event.stopPropagation(); handleOpenKeydown(event) }
    else if (modelView !== "model" && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) handleOpenKeydown(event)
  })

  renderOptions()
  renderTrigger()

  return {
    element: host,
    close,
    destroy() { close(); listeners.clear(); openListeners.clear(); disabledListeners.clear(); trigger.remove(); popup.remove(); portal?.remove() },
    getValue: () => state.value,
    setModelControl(control) {
      if (modelControl && JSON.stringify([modelControl.selectionKey, modelControl.levels, modelControl.value, modelControl.label, Boolean(modelControl.onCommit)]) === JSON.stringify([control.selectionKey, control.levels, control.value, control.label, Boolean(control.onCommit)])) {
        modelControl.onCommit = control.onCommit
        return
      }
      modelControl = control
      const restoreRangeFocus = popup.contains(doc.activeElement) && doc.activeElement?.classList.contains("jdx-model-thinking-range")
      trigger.setAttribute("aria-haspopup", "dialog")
      popup.id = `${hostId}-model-dialog`
      trigger.setAttribute("aria-controls", popup.id)
      popup.setAttribute("role", "dialog")
      popup.setAttribute("aria-label", uiText("模型与思考设置", "Model and thinking settings"))
      renderTrigger(); renderModelPanel()
      if (restoreRangeFocus) modelPanel.querySelector<HTMLInputElement>("input[type=range]")?.focus()
      if (state.open) { renderOptions(); positionPopup() }
    },
    setValue(value: string) {
      if (!state.options.some((option) => option.value === value)) return
      state.value = value
      renderTrigger()
    },
    setOptions(options: JdxSelectOption[], selectedValue: string) {
      state.options = options.slice()
      state.value = resolveSelectedValue(state.options, selectedValue)
      state.activeIndex = state.open ? visibleOptions().findIndex(option => option.value === state.value) : -1
      renderOptions()
      renderTrigger()
      if (state.open) { positionPopup(); setActiveIndex(state.activeIndex, false) }
    },
    setDisabled(disabled: boolean) {
      if (state.disabled === disabled) return
      state.disabled = disabled
      if (disabled) close()
      renderTrigger()
      if (modelControl) renderModelPanel()
    },
    onChange(listener: JdxSelectChangeListener) {
      listeners.add(listener)
    },
    onOpen(listener: () => void) { openListeners.add(listener) },
    onDisabledSelect(listener: (option: JdxSelectOption) => void) { disabledListeners.add(listener) },
  }
}
