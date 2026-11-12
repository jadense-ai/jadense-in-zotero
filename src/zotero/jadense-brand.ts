/** 所有内嵌品牌图标的唯一渲染入口；几何由官方 SVG 自动生成，组件只决定尺寸与单色状态。 */
import drawing, { JADENSE_BRAND_SOURCE_SHA256 } from './jadense-brand.generated'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
type DrawingNode = {
  tag: string
  attributes: Readonly<Record<string, string>>
  children: readonly (DrawingNode | string)[]
}

let brandSequence = 0
export const JADENSE_BRAND_VIEW_BOX = drawing.attributes.viewBox

/** 创建独立 SVG；所有本地引用按实例隔离，Reader 渐变与模式开关单色版共用同一图形树。 */
export function createJadenseBrandIcon(doc: Document, { size = 20, monochrome = false }: { size?: number; monochrome?: boolean } = {}): SVGSVGElement {
  const prefix = `jadense-brand-${++brandSequence}-`
  const references = (value: string) => value.replace(/url\((['"]?)#([^)'"\s]+)\1\)/g, (_match, _quote, id) => `url(#${prefix}${id})`)
  const create = (node: DrawingNode): SVGElement => {
    const element = doc.createElementNS(SVG_NS, node.tag)
    for (const [name, raw] of Object.entries(node.attributes)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) continue
      let value = name === 'id' ? prefix + raw : references(raw)
      if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) value = '#' + prefix + value.slice(1)
      if (monochrome && (name === 'fill' || name === 'stroke') && !['none', 'transparent'].includes(value)) value = 'currentColor'
      if (name.startsWith('xlink:')) element.setAttributeNS(XLINK_NS, name, value)
      else element.setAttribute(name, value)
    }
    for (const child of node.children) element.append(typeof child === 'string' ? doc.createTextNode(child) : create(child))
    return element
  }
  const svg = create(drawing) as SVGSVGElement
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false')
  svg.setAttribute('data-jadense-brand', JADENSE_BRAND_SOURCE_SHA256)
  if (monochrome) svg.setAttribute('fill', 'currentColor')
  return svg
}
