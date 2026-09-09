/** 工作台静态文案适配：仅处理 XHTML 中明确标记的界面文本，启动后不接触文献或历史。 */
import { getUiLocale } from "./ui-preferences"

/** 语言为本次 Zotero 启动快照；配置变更不会在重开工作台时提前替换文案。 */
export function localizeManagerStaticContent(document: Document) {
  const locale = getUiLocale()
  document.documentElement.lang = locale
  if (locale !== "en-US") return
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-ui-en]"))) {
    node.textContent = node.dataset.uiEn ?? node.textContent
  }
  for (const attribute of ["aria-label", "title", "placeholder", "alt"] as const) {
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(`[data-ui-en-${attribute}]`))) {
      const value = node.getAttribute(`data-ui-en-${attribute}`)
      if (value !== null) node.setAttribute(attribute, value)
    }
  }
}
