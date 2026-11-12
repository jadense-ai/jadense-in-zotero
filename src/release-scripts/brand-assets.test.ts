/** 用不同母版、过期文件和独立 checkout 验证完整派生链；不依赖具体玉钩几何。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BRAND_SNAPSHOT, syncBrandAssets } from '../../scripts/brand-assets.mjs'

const temporary: string[] = []
const first = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20" viewBox="0 0 30 20"><rect width="30" height="20" fill="#16cf8c"/></svg>'
const second = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-2, -2, 24, 24"><circle cx="10" cy="10" r="10" fill="#326de6"/></svg>'

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    const absolute = path.resolve(directory)
    expect(path.dirname(absolute)).toBe(path.resolve(tmpdir()))
    expect(path.basename(absolute).startsWith('jadense-brand-test-')).toBe(true)
    await rm(absolute, { recursive: true, force: true })
  }
})

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'jadense-brand-test-'))
  temporary.push(base)
  const root = path.join(base, 'extensions/jadense-in-zotero')
  const master = path.join(base, 'assets/brand/jadense-logo.svg')
  await mkdir(path.dirname(master), { recursive: true })
  await mkdir(root, { recursive: true })
  await writeFile(master, first)
  return { root, master, base }
}

describe('single-source brand generation', () => {
  it('updates every derived file when the sole master changes shape, color and bounds', async () => {
    const { root, master } = await fixture()
    const initial = await syncBrandAssets({ root })
    await writeFile(master, second)
    const updated = await syncBrandAssets({ root })
    expect(updated.sourceSha256).not.toBe(initial.sourceSha256)
    expect(updated.changed.sort()).toEqual([...initial.files.keys()].sort())
    for (const [file, contents] of updated.files) expect(await readFile(path.join(root, file))).toEqual(contents)
    for (const file of ['icons/jadense-16.svg', 'icons/jadense-20.svg', 'src/zotero/jadense-brand.generated.ts']) {
      const content = updated.files.get(file)!.toString('utf8')
      expect(content).toContain('circle')
      expect(content).toContain('-2, -2, 24, 24')
      expect(content).not.toContain('rect')
    }
    expect(updated.files.get('content/icons/logo-padded.png')).not.toEqual(initial.files.get('content/icons/logo-padded.png'))
    expect((await syncBrandAssets({ root, check: true })).changed).toEqual([])
  })

  it('reports manually changed native, raster and runtime files without rewriting in check mode', async () => {
    const { root } = await fixture()
    await syncBrandAssets({ root })
    const drift = ['icons/jadense-20.svg', 'content/icons/logo-padded.png', 'src/zotero/jadense-brand.generated.ts']
    for (const file of drift) await writeFile(path.join(root, file), 'synthetic stale artwork')
    expect((await syncBrandAssets({ root, check: true })).changed.sort()).toEqual(drift.sort())
    for (const file of drift) expect(await readFile(path.join(root, file), 'utf8')).toBe('synthetic stale artwork')
    await syncBrandAssets({ root })
    expect((await syncBrandAssets({ root, check: true })).changed).toEqual([])
  })

  it('builds the same resources from the published snapshot without monorepo files', async () => {
    const { root, base } = await fixture()
    const original = await syncBrandAssets({ root })
    const standalone = path.join(base, 'standalone')
    await mkdir(path.join(standalone, 'icons'), { recursive: true })
    await writeFile(path.join(standalone, BRAND_SNAPSHOT), original.files.get(BRAND_SNAPSHOT)!)
    const rebuilt = await syncBrandAssets({ root: standalone })
    expect(rebuilt.sourceSha256).toBe(original.sourceSha256)
    expect(rebuilt.files).toEqual(original.files)
  })

  it('keeps every checked-in brand artifact aligned with the official master', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    expect((await syncBrandAssets({ root, check: true })).changed).toEqual([])
  })
})
