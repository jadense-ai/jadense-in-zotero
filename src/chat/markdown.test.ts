/** 验证消息格式与特权窗口的展示安全边界；流式 DOM 复用由 installed-XPI smoke 覆盖。 */
import { describe, expect, it } from "vitest"
import { renderChatMarkdown } from "./markdown"

describe("chat Markdown", () => {
  it("renders reading structure, nested lists, quotes, code and tables for either message role", () => {
    const html = renderChatMarkdown([
      "# 文献阅读", "", "**论点**与*证据*，~~旧结论~~。", "", "> 引用原文", "",
      "1. 检查方法", "   - 核对样本", "2. 比较结果", "",
      "```ts", 'const value = "<script>"', "```", "",
      "| 方法 | 得分 |", "| --- | ---: |", "| 基线 | 72 |", "| 改进 | 86 |",
      "", "行内 `a < b`", "下一行",
    ].join("\n"))
    for (const tag of ["h1", "strong", "em", "s", "blockquote", "ol", "ul", "li", "pre", "table", "thead", "tbody"]) {
      expect(html).toContain(`<${tag}>`)
    }
    expect(html).toContain('<code class="language-ts">')
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("<code>a &lt; b</code><br />")
    expect(html).not.toContain("**论点**")
  })

  it("formats completed portions while Markdown arrives and tolerates unfinished fences", () => {
    const prefix = "## 回答\n\n**已完成的论点**\n\n"
    const partial = renderChatMarkdown(`${prefix}下一段 *尚未完成`)
    expect(partial).toContain("<h2>回答</h2>")
    expect(partial).toContain("<strong>已完成的论点</strong>")
    expect(renderChatMarkdown(`${prefix}下一段 *已完成*`)).toContain("<em>已完成</em>")
    expect(renderChatMarkdown(`${prefix}\u0060\u0060\u0060js\nconst value = 1`)).toContain('<pre><code class="language-js">const value = 1')
  })

  it("keeps literature formula notation while rendering the surrounding Markdown structure", () => {
    const html = renderChatMarkdown([
      "## 译文", "", "- **能量关系**：$E = mc^2$", "- 行内公式：$x_i = \\alpha + \\epsilon_i$", "- 括号公式：\\(a + b = c\\)",
      "", "$$", "\\int_0^1 x^2 \\, dx = \\frac{1}{3}", "$$",
      "", "\\[", "\\sum_{i=1}^{n} x_i", "\\]",
      "", "```latex", "\\operatorname{code_example}(x)", "```",
    ].join("\n"))
    expect(html).toContain("<h2>译文</h2>")
    expect(html).toContain("<strong>能量关系</strong>")
    expect(html).toContain('<span class="katex"><math')
    expect(html).toContain('<div class="katex-display"><span class="katex"><math')
    expect(html).toContain('<annotation encoding="application/x-tex">E = mc^2</annotation>')
    expect(html).toContain('<annotation encoding="application/x-tex">x_i = \\alpha + \\epsilon_i</annotation>')
    expect(html).toContain('<annotation encoding="application/x-tex">a + b = c</annotation>')
    expect(html).toContain('<annotation encoding="application/x-tex">\\int_0^1 x^2 \\, dx = \\frac{1}{3}</annotation>')
    expect(html).toContain('<annotation encoding="application/x-tex">\\sum_{i=1}^{n} x_i</annotation>')
    expect(html).toContain('<code class="language-latex">\\operatorname{code_example}(x)')
  })

  it("keeps unsafe or malformed formula commands inert without rejecting the translation", () => {
    const html = renderChatMarkdown('$\\href{javascript:alert(1)}{bad}$ and $\\frac{$')
    expect(html).not.toContain("<a ")
    expect(html).not.toContain("href=")
    expect(html).toContain('class="jdx-math-error"')
  })

  it("escapes raw HTML instead of giving user/model text privileges in the chrome document", () => {
    const html = renderChatMarkdown('<script>alert(1)</script>\n<img src="file:///private" onerror="alert(1)"/>\n<svg onload="alert(1)"></svg>\n<iframe src="chrome://global/content/"></iframe>')
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toMatch(/<(script|img|svg|iframe)\b/)
  })

  it.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "javascript&#58;alert(1)", "javascript&colon;alert(1)",
    "data:text/html,hello", "file:///C:/private.txt", "chrome://global/content/", "resource://gre/modules/",
    "zotero://select/library/items/ABC", "//example.com/path", "../preferences.xhtml", "#local-window",
  ])("keeps unsafe or local URL %s inert without rejecting the message", (url) => {
    const html = renderChatMarkdown(`**正常正文** [查看](${url})`)
    expect(html).toContain("<strong>正常正文</strong>")
    expect(html).not.toContain("<a ")
  })

  it("keeps explicit web and email links and requires a click before opening an image", () => {
    const html = renderChatMarkdown('[论文](https://example.org/paper?q=a&b=c "标题")\nhttps://example.org\n[联系](mailto:author@example.org)\n![结果图](https://example.org/figure.png)')
    expect(html).toContain('href="https://example.org/paper?q=a&amp;b=c"')
    expect(html).toContain('href="mailto:author@example.org"')
    expect(html).toContain('target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"')
    expect(html).toContain('href="https://example.org/figure.png"')
    expect(html).toContain("图片：结果图")
    expect(html).not.toContain("<img")
  })

  it("does not nest links when an image is the label of a web link", () => {
    const html = renderChatMarkdown('[说明 ![结果图](https://example.org/figure.png)](https://example.org/paper)')
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).toContain("图片：结果图")
  })

  it("keeps an empty message empty", () => {
    expect(renderChatMarkdown("")).toBe("")
  })
})
