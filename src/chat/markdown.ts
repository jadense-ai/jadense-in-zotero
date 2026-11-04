/**
 * Zotero 消息的 Markdown 展示边界：上游保留本地消息原文，下游只生成安全阅读节点。
 * 用户、AI 和解析说明共用格式；不执行 HTML，也不自动请求图片或本地特权资源。
 */
import MarkdownIt from "markdown-it"
import katex from "katex"
import type { ChatEvidence } from './evidence'
import { uiText } from '@/zotero/ui-preferences'

const markdown = new MarkdownIt({ html: false, xhtmlOut: true, breaks: true, linkify: true })

// 只有消息拥有本地索引时才赋予定位能力；代码块和普通外链不会进入此规则。
markdown.inline.ruler.before('link', 'evidence', (state, silent) => {
  if (silent || !state.env?.chatEvidence || state.linkLevel > 0 || !state.src.startsWith('[[evidence:', state.pos)) return false
  const match = /^\[\[evidence:([^\]\r\n]*)\]\]/u.exec(state.src.slice(state.pos))
  if (!match) {
    // 流式标记尚未闭合，不在用户面前闪烁内部 ID。
    if (!state.src.slice(state.pos).includes(']]') && state.src.length - state.pos < 80) { state.pos = state.src.length; return true }
    return false
  }
  if (!silent) { const token = state.push('evidence', '', 0); token.content = match[1] }
  state.pos += match[0].length
  return true
})
markdown.renderer.rules.evidence = (tokens, index, _options, env) => {
  const entry = (env?.chatEvidence as ChatEvidence | undefined)?.entries.find(row => row.id === tokens[index].content)
  const escape = markdown.utils.escapeHtml
  if (!entry) return `<span class="jdx-evidence-unavailable" title="${escape(uiText('没有可核验的本地原文位置', 'No verifiable local passage is available'))}">${escape(uiText('来源不可用', 'Source unavailable'))}</span>`
  const numbers = env!.evidenceNumbers as Map<string, number>
  if (!numbers.has(entry.id)) numbers.set(entry.id, numbers.size + 1)
  const number = numbers.get(entry.id)!
  const label = uiText(`引用 ${number}：${entry.source.title}，第 ${entry.pageLabel} 页，${entry.rects.length ? '定位原文段落' : '仅定位到页'}`, `Citation ${number}: ${entry.source.title}, page ${entry.pageLabel}, ${entry.rects.length ? 'open original passage' : 'page location only'}`)
  return `<span class="jdx-evidence-link" data-evidence-id="${escape(entry.id)}" data-evidence-number="${number}" aria-label="${escape(label)}">${number}</span>`
}

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
  let cursor = start + openingLength
  while ((cursor = state.src.indexOf(close, cursor)) >= 0) {
    if (escapedAt(state.src, cursor)) { cursor += close.length; continue }
    const content = state.src.slice(start + openingLength, cursor).trim()
    if (!content) return false
    // OCR 会在公式分隔符内添加空格；货币的下一笔金额不是公式闭合符。
    if (dollar && (/^\d/.test(state.src.slice(cursor + 1))
      || /^\d[\d.,]*\s+[a-z]/iu.test(content) && /^\s+\d/.test(state.src.slice(cursor + 1)))) return false
    if (!silent) {
      const token = state.push("math_inline", "math", 0)
      token.content = content
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
markdown.validateLink = (url) => /^jdx-asset:image-\d+$/u.test(url) || /^(https?:\/\/|mailto:)/i.test(url) && validateLink(url)

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index].attrSet("target", "_blank")
  tokens[index].attrSet("rel", "noopener noreferrer")
  tokens[index].attrSet("referrerpolicy", "no-referrer")
  return renderer.renderToken(tokens, index, options)
}

// 自动加载模型提供的图片会泄露阅读行为；保留可显式打开的图片说明和地址。
markdown.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index]
  const label = markdown.utils.escapeHtml(`图片：${token.content || "查看图片"}`)
  const url = String(token.attrGet("src") ?? "")
  const assets = env?.documentAssets as Record<string, unknown> | undefined
  const asset = /^jdx-asset:image-\d+$/u.test(url) ? assets?.[url] : undefined
  if (typeof asset === 'string' && /^data:image\/png;base64,[a-z\d+/]+=*$/iu.test(asset)) {
    return `<img src="${asset}" alt="${markdown.utils.escapeHtml(token.content)}" style="max-width:100%;height:auto" />`
  }
  if (url.startsWith('jdx-asset:')) return `<span>${label} (unavailable)</span>`
  const insideLink = tokens.slice(0, index).reduce((depth, item) =>
    depth + (item.type === "link_open" ? 1 : item.type === "link_close" ? -1 : 0), 0) > 0
  if (insideLink || !markdown.validateLink(url)) return label
  return `<a href="${markdown.utils.escapeHtml(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${label}</a>`
}

/** 格式异常只降级这一段展示，不改变消息原文、存储或对话执行结果。 */
export function renderChatMarkdown(text: string, documentAssets?: Record<string, string>, chatEvidence?: ChatEvidence): string {
  try {
    return markdown.render(text, { documentAssets, chatEvidence, evidenceNumbers: new Map<string, number>() })
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
export function updateChatMarkdown(target: HTMLElement, text: string, documentAssets?: Record<string, string>, chatEvidence?: ChatEvidence) {
  const template = target.ownerDocument.createElement("template")
  try {
    template.innerHTML = renderChatMarkdown(text, documentAssets, chatEvidence)
  } catch {
    // XHTML 中不可解析的控制字符只影响格式；仍保留这条消息，不中断对话。
    const paragraph = target.ownerDocument.createElement("p")
    paragraph.textContent = text
    template.content.append(paragraph)
  }
  // Gecko 的特权 HTML 解析器会移除 form/button；先解析无行为占位，再用本地索引创建按钮。
  if (chatEvidence) for (const span of Array.from(template.content.querySelectorAll<HTMLElement>('span[data-evidence-id]'))) {
    if (!chatEvidence.entries.some(entry => entry.id === span.dataset.evidenceId)) continue
    const button = target.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'button')
    for (const attribute of Array.from(span.attributes)) button.setAttribute(attribute.name, attribute.value)
    button.setAttribute('type', 'button'); button.textContent = span.textContent
    span.replaceWith(button)
  }
  syncMarkdownChildren(target, template.content)
}
