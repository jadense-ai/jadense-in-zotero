/** 工作台与 Reader 共享消息 UI；所有 DOM 均在调用方文档创建。 */
import type { LocalChatMessage } from '@/chat/local-chat-store'
import { updateChatMarkdown } from '@/chat/markdown'
import { ANALYSIS_CATEGORIES } from '@/chat/paper-analysis'
import { parseResearchPresentation, resolveResearchPage, type ResearchMessageContext } from '@/chat/research-presentation'
import { readChatImage } from './chat-images'
import { openChatSource } from './research-context'
import { copyTextToClipboard } from './connection-display'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
export type ChatMessageElements = { messageList: HTMLElement; chatStatus: HTMLElement; chatLatest: HTMLButtonElement }
const renderedMessageText = new WeakMap<HTMLElement, string>()
function setStatus(node: HTMLElement, text: string, kind: string) { node.textContent = text; node.dataset.state = kind }
export function nearLatest(elements: ChatMessageElements) { const log = elements.messageList; return log.scrollHeight - log.scrollTop - log.clientHeight < 64 }
export function updateLatestButton(elements: ChatMessageElements) { elements.chatLatest.hidden = nearLatest(elements) }
function openResearchPage(elements: ChatMessageElements, zotero: ZoteroLike, context: ResearchMessageContext, pageLabel?: string) {

  const page = pageLabel === undefined ? undefined : resolveResearchPage(context, pageLabel)
  if (pageLabel !== undefined && !page) return
  void openChatSource(zotero, {
    ...context.source, id: `zotero:${context.source.libraryID}/${context.source.itemKey}:file`,
    kind: "file", citation: context.source.title, text: "", contentType: "application/pdf", ...page,
  }).then((opened) => {
    setStatus(elements.chatStatus, opened ? uiText(`已在 Zotero 打开${page ? `第 ${page.pageLabel} 页` : "原 PDF"}。`, `Opened ${page ? `page ${page.pageLabel}` : "the original PDF"} in Zotero.`)
      : uiText("原附件已移动或不可用，请重新关联文件。", "The original attachment moved or is unavailable. Link the file again."), opened ? "success" : "error")
  }).catch(() => setStatus(elements.chatStatus, uiText("暂时无法打开原文，请在 Zotero 中检查该附件。", "Cannot open the original. Check the attachment in Zotero."), "error"))
}
/** 保留本地解析结构与页码能力，正文和 AI 说明走安全 Markdown，原文引句保持逐字一致。 */
function renderAnalysisBody(body: HTMLElement, message: LocalChatMessage, elements: ChatMessageElements, zotero: ZoteroLike) {
  const document = elements.messageList.ownerDocument
  const create = (tag: string, className = "") => { const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement; node.className = className; return node }

  const blocks = parseResearchPresentation(message.text)
  if (!blocks.some((block) => block.type === "heading" && block.level === 1)) return false
  const fragment = document.createDocumentFragment()
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block.type === "heading") {
      const heading = create(block.level === 1 ? "h3" : "h4", "jdx-analysis-heading")
      heading.textContent = block.text
      const category = ANALYSIS_CATEGORIES.find((item) => item.label === block.text)
      if (category) heading.style.setProperty("--annotation-color", category.color)
      fragment.append(heading)
    } else if (block.type === "annotation") {
      const entry = create("section", "jdx-analysis-annotation")
      const header = create("div", "jdx-analysis-annotation-header")
      const category = create("span", "jdx-analysis-category")
      category.textContent = block.category
      category.style.setProperty("--annotation-color", ANALYSIS_CATEGORIES.find((item) => item.label === block.category)?.color ?? "#aaaaaa")
      header.append(category)
      const page = resolveResearchPage(message.research, block.pageLabel)
      const pageControl = create(page ? "button" : "span", "jdx-analysis-page")
      pageControl.textContent = uiText(`第 ${block.pageLabel} 页`, `Page ${block.pageLabel}`)
      if (page && message.research) {
        (pageControl as HTMLButtonElement).type = "button"
        pageControl.setAttribute("aria-label", uiText(`在原 PDF 打开第 ${block.pageLabel} 页`, `Open page ${block.pageLabel} in the original PDF`))
        pageControl.addEventListener("click", () => openResearchPage(elements, zotero, message.research!, block.pageLabel))
      }
      header.append(pageControl)
      const quote = create("blockquote")
      quote.textContent = block.quote
      const comment = create("div", "jdx-markdown")
      updateChatMarkdown(comment, block.comment)
      entry.append(header, quote, comment)
      fragment.append(entry)
    } else {
      // 固定解析层次之间的连续正文一起解析，避免空行拆断 Markdown 代码块或列表。
      let text = block.text
      let next = blocks[index + 1]
      while (next?.type === "paragraph") {
        text += `\n\n${next.text}`
        index += 1
        next = blocks[index + 1]
      }
      const paragraph = create("div", `jdx-markdown${/^(解析完成：|已停止写入：|批注未全部写入：)/.test(text) ? " jdx-analysis-outcome" : ""}`)
      updateChatMarkdown(paragraph, text)
      fragment.append(paragraph)
    }
  }
  body.replaceChildren(fragment)
  return true
}

/** 消息操作使用静态线性图标；原生 tooltip 与无障碍名称共用本地化文案。 */
export function messageAction(document: Document, label: string, pathData: string): HTMLButtonElement {
  const create = (tag: string) => document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement

  const button = create("button") as HTMLButtonElement
  button.type = "button"
  button.title = label
  button.setAttribute("aria-label", label)
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  icon.setAttribute("viewBox", "0 0 24 24")
  icon.setAttribute("aria-hidden", "true")
  icon.setAttribute("fill", "none")
  icon.setAttribute("stroke", "currentColor")
  icon.setAttribute("stroke-width", "1.7")
  icon.setAttribute("stroke-linecap", "round")
  icon.setAttribute("stroke-linejoin", "round")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", pathData)
  icon.append(path)
  button.append(icon)
  return button
}

/** 消息节点按 ID 复用；流式正文更新 Markdown 的变化节点，不重建来源或会话按钮。 */
export function renderMessage(elements: ChatMessageElements, zotero: ZoteroLike, message: LocalChatMessage, existing?: HTMLElement) {
  const document = elements.messageList.ownerDocument
  const create = (tag: string, className = "") => { const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement; node.className = className; return node }

  const wrapper = existing ?? create("article", "jdx-chat-message")
  if (!existing) {
    wrapper.dataset.messageId = message.id
    wrapper.dataset.role = message.role
    const actions = create("div", "jdx-chat-message-actions")
    const copy = messageAction(document, uiText("复制 Markdown", "Copy Markdown"), "M9 9h11v11H9zM15 5V3H3v12h2")
    copy.dataset.copyMessage = "true"
    copy.addEventListener("click", () => {
      const text = renderedMessageText.get(wrapper) ?? ""
      if (text) void copyTextToClipboard(zotero, text).then((copied) => {
        setStatus(elements.chatStatus, copied ? uiText("已复制消息。", "Message copied.") : uiText("复制失败，可直接选择消息文字复制。", "Copy failed. Select the message text to copy it."), copied ? "success" : "error")
      })
    })
    actions.append(copy)
    const plain = messageAction(document, uiText("复制纯文本", "Copy plain text"), "M4 5h16M12 5v14M8 19h8")
    plain.dataset.copyPlain = "true"
    plain.addEventListener("click", () => {
      const text = wrapper.querySelector<HTMLElement>(".jdx-chat-message-body")?.innerText ?? ""
      if (text) void copyTextToClipboard(zotero, text).then((copied) => {
        setStatus(elements.chatStatus, copied ? uiText("已复制纯文本。", "Plain text copied.") : uiText("复制失败，可直接选择消息文字复制。", "Copy failed. Select the message text to copy it."), copied ? "success" : "error")
      })
    })
    actions.append(plain)
    actions.setAttribute("role", "group")
    actions.setAttribute("aria-label", uiText("消息操作", "Message actions"))
    wrapper.append(create("div", "jdx-chat-message-body"))
    if (message.image) {
      const attachment = create("div", "jdx-chat-message-image")
      const caption = create("span")
      caption.textContent = uiText(`正在加载图片：${message.image.name}`, `Loading image: ${message.image.name}`)
      attachment.append(caption)
      wrapper.append(attachment)
      void readChatImage(message.image).then(image => {
        if (!image) {
          caption.textContent = uiText(`图片不可用：${message.image!.name}（本地附件丢失或未保存）`, `Image unavailable: ${message.image!.name} (local attachment missing or not saved)`)
          return
        }
        const preview = create("button") as HTMLButtonElement
        preview.type = "button"
        preview.setAttribute("aria-label", uiText(`放大图片：${message.image!.name}`, `Enlarge image: ${message.image!.name}`))
        preview.setAttribute("aria-expanded", "false")
        const img = create("img") as HTMLImageElement
        img.alt = message.image!.name || uiText("消息图片", "Message image")
        const follow = nearLatest(elements)
        const previousTop = elements.messageList.scrollTop
        img.onload = () => { if (follow && wrapper.isConnected) followMessageUpdate(elements, true, previousTop) }
        img.onerror = () => { preview.remove(); caption.textContent = uiText(`图片无法显示：${message.image!.name}`, `Cannot display image: ${message.image!.name}`) }
        img.src = image.dataUrl
        preview.append(img)
        preview.addEventListener("click", () => {
          const expanded = preview.getAttribute("aria-expanded") !== "true"
          preview.setAttribute("aria-expanded", String(expanded))
          preview.setAttribute("aria-label", uiText(`${expanded ? "缩小" : "放大"}图片：${message.image!.name}`, `${expanded ? "Shrink" : "Enlarge"} image: ${message.image!.name}`))
        })
        caption.textContent = message.image!.name
        attachment.prepend(preview)
      })
    }
    wrapper.append(actions)
  }
  if (renderedMessageText.get(wrapper) === message.text && wrapper.dataset.status === message.status) return wrapper
  const body = wrapper.querySelector<HTMLElement>(".jdx-chat-message-body")!
  const isAnalysis = message.role === "assistant" && message.status === "complete"
    && renderAnalysisBody(body, message, elements, zotero)
  wrapper.dataset.research = String(isAnalysis)
  wrapper.dataset.status = message.status
  wrapper.dataset.stopped = String(message.status === "failed" && /^(已停止|对话已中止|Generation stopped\.|Chat was stopped\.)/.test(message.text))
  body.classList.toggle("jdx-markdown", !isAnalysis)
  if (!isAnalysis) {
    updateChatMarkdown(body, message.text || (message.status === "streaming" ? uiText("正在处理…", "Working…") : ""))
  }
  const actions = wrapper.querySelector<HTMLElement>(".jdx-chat-message-actions")!
  const copy = actions.querySelector<HTMLButtonElement>('[data-copy-message]')!
  copy.disabled = !message.text
  actions.querySelector<HTMLButtonElement>("[data-copy-plain]")!.disabled = !message.text
  if (message.research && !actions.querySelector("[data-open-research]")) {
    const open = messageAction(document, uiText("打开原 PDF", "Open original PDF"), "M14 3h7v7m0-7L11 13M10 3H3v18h18v-7")
    open.dataset.openResearch = "true"
    open.addEventListener("click", () => openResearchPage(elements, zotero, message.research!))
    actions.prepend(open)
  }
  renderedMessageText.set(wrapper, message.text)
  return wrapper
}

export function followMessageUpdate(elements: ChatMessageElements, follow: boolean, previousTop: number, start?: HTMLElement) {
  elements.messageList.ownerDocument.defaultView?.requestAnimationFrame(() => {
    if (follow && Math.abs(elements.messageList.scrollTop - previousTop) < 2) {
      if (start) elements.messageList.scrollTop += start.getBoundingClientRect().top - elements.messageList.getBoundingClientRect().top - 12
      else elements.messageList.scrollTop = elements.messageList.scrollHeight
    }
    updateLatestButton(elements)
  })
}
