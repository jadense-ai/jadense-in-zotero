/**
 * Zotero 消息的 Markdown 展示边界：上游保留本地消息原文，下游只生成安全阅读节点。
 * 用户、AI 和解析说明共用格式；不执行 HTML，也不自动请求图片或本地特权资源。
 */
import MarkdownIt from "markdown-it"
import katex from "katex"

const markdown = new MarkdownIt({ html: false, xhtmlOut: true, breaks: true, linkify: true })

function mathHtml(source: string, displayMode: boolean) {
  try {
    const rendered = katex.renderToString(source.trim(), {
      displayMode,
      output: "mathml",
      strict: "ignore",
      throwOnError: true,
      trust: false,
    })
    return displayMode ? `<div class="katex-display">${rendered}</div>` : rendered
  } catch {
    return `<code class="jdx-math-error">${markdown.utils.escapeHtml(source)}</code>`
  }
}

function escapedAt(source: string, index: number) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

// 文献 AI 常返回 $…$ / \(…\)；在 Markdown escape 规则前截取，交给本地 KaTeX 输出 MathML。
markdown.inline.ruler.before("escape", "math_inline", (state, silent) => {
  const start = state.pos
  const dollar = state.src[start] === "$" && state.src[start + 1] !== "$"
  const paren = state.src.slice(start, start + 2) === "\\("
  if (!dollar && !paren) return false
  const openingLength = paren ? 2 : 1
  const close = paren ? "\\)" : "$"
  if (/\s/.test(state.src[start + openingLength] ?? "")) return false
  let cursor = start + openingLength
  while ((cursor = state.src.indexOf(close, cursor)) >= 0) {
    if (escapedAt(state.src, cursor)) { cursor += close.length; continue }
    if (cursor === start + openingLength || /\s/.test(state.src[cursor - 1])) { cursor += close.length; continue }
    if (dollar && /\d/.test(state.src[cursor + 1] ?? "")) { cursor += 1; continue }
    if (!silent) {
      const token = state.push("math_inline", "math", 0)
      token.content = state.src.slice(start + openingLength, cursor)
    }
    state.pos = cursor + close.length
    return true
  }
  return false
})

markdown.block.ruler.before("fence", "math_block", (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const end = state.eMarks[startLine]
  const opening = state.src.slice(start, start + 2)
  if (opening !== "$$" && opening !== "\\[") return false
  const close = opening === "$$" ? "$$" : "\\]"
  let nextLine = startLine
  let content = state.src.slice(start + 2, end)
  const sameLineEnd = content.lastIndexOf(close)
  if (sameLineEnd >= 0 && !content.slice(sameLineEnd + 2).trim()) {
    content = content.slice(0, sameLineEnd)
  } else {
    const lines: string[] = [content]
    let found = false
    while (++nextLine < endLine) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
      const line = state.src.slice(lineStart, state.eMarks[nextLine])
      const closeAt = line.lastIndexOf(close)
      if (closeAt >= 0 && !line.slice(closeAt + 2).trim()) {
        lines.push(line.slice(0, closeAt))
        found = true
        break
      }
      lines.push(line)
    }
    if (!found) return false
    content = lines.join("\n")
  }
  if (!content.trim()) return false
  if (!silent) {
    const token = state.push("math_block", "math", 0)
    token.block = true
    token.content = content
    token.map = [startLine, nextLine + 1]
  }
  state.line = nextLine + 1
  return true
})

markdown.renderer.rules.math_inline = (tokens, index) => mathHtml(tokens[index].content, false)
markdown.renderer.rules.math_block = (tokens, index) => `${mathHtml(tokens[index].content, true)}\n`
const validateLink = markdown.validateLink.bind(markdown)
markdown.validateLink = (url) => /^(https?:\/\/|mailto:)/i.test(url) && validateLink(url)

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet("target", "_blank")
  tokens[index].attrSet("rel", "noopener noreferrer")
  tokens[index].attrSet("referrerpolicy", "no-referrer")
  return renderer.renderToken(tokens, index, options)
}

// 自动加载模型提供的图片会泄露阅读行为；保留可显式打开的图片说明和地址。
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]
  const label = markdown.utils.escapeHtml(`图片：${token.content || "查看图片"}`)
  const url = String(token.attrGet("src") ?? "")
  const insideLink = tokens.slice(0, index).reduce((depth, item) =>
    depth + (item.type === "link_open" ? 1 : item.type === "link_close" ? -1 : 0), 0) > 0
  if (insideLink || !markdown.validateLink(url)) return label
  return `<a href="${markdown.utils.escapeHtml(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${label}</a>`
}

/** 格式异常只降级这一段展示，不改变消息原文、存储或对话执行结果。 */
export function renderChatMarkdown(text: string): string {
  try {
    return markdown.render(text)
  } catch {
    const escaped = markdown.utils.escapeHtml(text).replace(/\r?\n/g, "<br />")
    return `<p>${escaped}</p>`
  }
}

/** 复用未变化的段落与文本节点，流式补全只更新变化处，保留已有选区和代码滚动。 */
function syncMarkdownChildren(target: Node, source: Node) {
  const children = Array.from(source.childNodes)
  for (const [index, next] of children.entries()) {
    const current = target.childNodes[index]
    if (!current) target.appendChild(next)
    else if (current.isEqualNode(next)) continue
    else if (current.nodeType === 3 && next.nodeType === 3) {
      const text = next.nodeValue ?? ""
      const previous = current.nodeValue ?? ""
      if (text.startsWith(previous)) (current as Text).appendData(text.slice(previous.length))
      else {
        let prefix = 0
        while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix += 1
        ;(current as Text).replaceData(prefix, previous.length - prefix, text.slice(prefix))
      }
    } else if (current.nodeType === 1 && current.cloneNode(false).isEqualNode(next.cloneNode(false))) {
      syncMarkdownChildren(current, next)
    } else target.replaceChild(next, current)
  }
  while (target.childNodes.length > children.length) target.lastChild?.remove()
}

/** 使用惰性 HTML 模板承接已禁用 HTML/危险资源的解析结果，兼容 Manager 的 XHTML 文档。 */
export function updateChatMarkdown(target: HTMLElement, text: string) {
  const template = target.ownerDocument.createElement("template")
  try {
    template.innerHTML = renderChatMarkdown(text)
  } catch {
    // XHTML 中不可解析的控制字符只影响格式；仍保留这条消息，不中断对话。
    const paragraph = target.ownerDocument.createElement("p")
    paragraph.textContent = text
    template.content.append(paragraph)
  }
  syncMarkdownChildren(target, template.content)
}
