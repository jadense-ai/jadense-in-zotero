/** 共用 chevron：沿用下拉组件的 SVG 路径，供导航、目录与折叠控件复用。 */
export function createChevron(doc: Document, className = "jdx-select-chevron", direction: "down" | "right" = "down", size = 16) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("class", className)
  svg.setAttribute("viewBox", "0 0 16 16")
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("focusable", "false")
  const path = doc.createElementNS(svg.namespaceURI, "path")
  path.setAttribute("d", "M4 6.5 8 10.5 12 6.5")
  path.setAttribute("fill", "none")
  path.setAttribute("stroke", "currentColor")
  path.setAttribute("stroke-width", "1.6")
  path.setAttribute("stroke-linecap", "round")
  path.setAttribute("stroke-linejoin", "round")
  if (direction === "right") path.setAttribute("transform", "rotate(-90 8 8)")
  svg.append(path)
  return svg
}
