/** 官方 SVG 母版生成全部插件品牌资源；仓库构建跟随共享母版，独立源码使用随包快照。 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import sharp from 'sharp'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BRAND_SNAPSHOT = 'icons/jadense-logo.svg'

/** 仅在共享母版不存在的独立 checkout 中读取已生成快照，不从其他 PNG 或组件回推图形。 */
export async function loadBrandMaster(root = projectRoot) {
  try {
    return await readFile(path.resolve(root, '../../assets/brand/jadense-logo.svg'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return readFile(path.join(root, BRAND_SNAPSHOT), 'utf8')
  }
}

/** 保留 SVG 的图形结构，不绑定玉钩数量、路径、旋转或渐变；装饰图标的名称由控件承担。 */
function drawingNode(element) {
  return {
    tag: element.localName,
    attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
    children: [...element.childNodes].flatMap(child => {
      if (child.nodeType === 1) return ['title', 'desc', 'metadata'].includes(child.localName) ? [] : [drawingNode(child)]
      return child.nodeType === 3 && child.textContent.trim() ? [child.textContent] : []
    }),
  }
}

/** 纯生成：所有尺寸、PNG 与内嵌 SVG 数据都由同一份母版得到，调用方决定写入还是核对。 */
export async function renderBrandAssets(master) {
  const source = master.replace(/\r\n/g, '\n').trimEnd() + '\n'
  const dom = new JSDOM(source, { contentType: 'image/svg+xml' })
  try {
    const svg = dom.window.document.documentElement
    const files = new Map([[BRAND_SNAPSHOT, Buffer.from(source)]])
    for (const size of [16, 20]) {
      const icon = svg.cloneNode(true)
      icon.setAttribute('width', String(size)); icon.setAttribute('height', String(size))
      icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', 'Jadense logo')
      files.set(`icons/jadense-${size}.svg`, Buffer.from(icon.outerHTML + '\n'))
    }

    const [, , sourceWidth, sourceHeight] = svg.getAttribute('viewBox').trim().split(/[\s,]+/).map(Number)
    const width = 829, height = 794, scale = Math.min(width / sourceWidth, height / sourceHeight) * 0.7
    const w = sourceWidth * scale, h = sourceHeight * scale
    const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><svg x="${(width - w) / 2}" y="${(height - h) / 2}" width="${w}" height="${h}" viewBox="${svg.getAttribute('viewBox')}">${svg.innerHTML}</svg></svg>`
    files.set('content/icons/logo-padded.png', await sharp(Buffer.from(canvas)).png().toBuffer())

    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    const generated = '/** 自动生成：仅修改 assets/brand/jadense-logo.svg，再运行 pnpm brand:sync；勿手工编辑。 */\n'
      + `export const JADENSE_BRAND_SOURCE_SHA256 = ${JSON.stringify(sourceSha256)}\n`
      + `export default ${JSON.stringify(drawingNode(svg), null, 2)} as const\n`
    files.set('src/zotero/jadense-brand.generated.ts', Buffer.from(generated))
    return { files, sourceSha256 }
  } finally {
    dom.window.close()
  }
}

/** 同步明确归属的派生文件；check 不写入，返回所有漂移项而不是静默复用旧文件。 */
export async function syncBrandAssets({ root = projectRoot, check = false } = {}) {
  const result = await renderBrandAssets(await loadBrandMaster(root))
  const changed = []
  for (const [relative, expected] of result.files) {
    const target = path.join(root, relative)
    const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    const matches = relative.endsWith('.png') ? current?.equals(expected)
      : current?.toString('utf8').replace(/\r\n/g, '\n') === expected.toString('utf8')
    if (matches) continue
    changed.push(relative)
    if (!check) {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, expected)
    }
  }
  return { ...result, changed }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const result = await syncBrandAssets({ check })
  if (check && result.changed.length) {
    console.error(`品牌资源需要同步，请运行 pnpm brand:sync：\n${result.changed.join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`${check ? 'Verified' : 'Synced'} ${result.files.size} brand assets from one SVG master.`)
  }
}
