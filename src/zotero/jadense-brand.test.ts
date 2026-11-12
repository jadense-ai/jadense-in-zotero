/** 用真实 DOM 检查品牌多实例引用与单色派生，避免渐变互串或单独维护第二份几何。 */
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { createJadenseBrandIcon } from './jadense-brand'

describe('shared brand renderer', () => {
  it('isolates every local definition and reference across icons in the same document', () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    try {
      const doc = dom.window.document
      const icons = [createJadenseBrandIcon(doc), createJadenseBrandIcon(doc), createJadenseBrandIcon(doc, { size: 12, monochrome: true })]
      doc.body.append(...icons)
      const ids = [...doc.querySelectorAll('[id]')].map(node => node.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const icon of icons) {
        const ownIds = new Set([...icon.querySelectorAll('[id]')].map(node => node.id))
        for (const element of icon.querySelectorAll('*')) for (const attribute of element.attributes) {
          for (const match of attribute.value.matchAll(/url\(#([^)]+)\)|^#(.+)$/g)) {
            if (attribute.name === 'href' || attribute.value.startsWith('url(')) expect(ownIds.has(match[1] || match[2])).toBe(true)
          }
        }
        expect(icon.getAttribute('aria-hidden')).toBe('true')
        expect(icon.getAttribute('focusable')).toBe('false')
      }
      const monochrome = icons[2]
      expect(monochrome.getAttribute('width')).toBe('12')
      expect([...monochrome.querySelectorAll('[fill]')].every(node => ['currentColor', 'none', 'transparent'].includes(node.getAttribute('fill')!))).toBe(true)
    } finally { dom.window.close() }
  })

  it('renders the same pixels as the distributed master at actual toolbar sizes', async () => {
    const master = await readFile(new URL('../../icons/jadense-logo.svg', import.meta.url), 'utf8')
    const dom = new JSDOM('<!doctype html><body></body>')
    try {
      for (const size of [12, 16, 20, 40]) for (const monochrome of [false, true]) {
        const expected = new JSDOM(master, { contentType: 'image/svg+xml' })
        try {
          const source = expected.window.document.documentElement
          source.setAttribute('width', String(size)); source.setAttribute('height', String(size))
          if (monochrome) {
            source.setAttribute('fill', 'currentColor')
            for (const element of source.querySelectorAll('[fill]')) if (element.getAttribute('fill') !== 'none') element.setAttribute('fill', 'currentColor')
          }
          const actual = createJadenseBrandIcon(dom.window.document, { size, monochrome })
          const serialize = (element: Element) => new dom.window.XMLSerializer().serializeToString(element)
          const pixels = (svg: string) => sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
          expect(await pixels(serialize(actual))).toEqual(await pixels(serialize(source)))
        } finally { expected.window.close() }
      }
    } finally { dom.window.close() }
  })
})
