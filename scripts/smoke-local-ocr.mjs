/** CPU 真 OCR 验收：合成双栏 PDF，经鉴权服务上传，核对页数、来源与缓存。 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createResearchFixturePdf } from './smoke-research.mjs'
import { createOCRLayoutFixture } from './ocr-layout-fixture.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'jadense-ocr-smoke-'))
const python = process.argv[2] || path.resolve('content/ocr/.venv/Scripts/python.exe')
const child = spawn(python, ['-u', path.resolve('content/ocr/server.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const token = randomUUID()
child.stdin.write(JSON.stringify({ root: process.argv[3] || root, token }) + '\n')
const url = await new Promise((resolve, reject) => {
  let buffer = ''
  child.stdout.on('data', data => {
    buffer += data.toString()
    const line = buffer.split('\n').find(line => line.startsWith('{"port":'))
    if (line) resolve(`http://127.0.0.1:${JSON.parse(line).port}`)
  })
  child.once('exit', code => reject(new Error(`OCR exited ${code}`)))
})
child.stderr.on('data', data => process.stderr.write(data))
const headers = { Authorization: `Bearer ${token}` }
try {
  assert.equal((await fetch(`${url}/health`)).status, 403)
  assert.equal((await fetch(`${url}/health`, { headers: { ...headers, Origin: 'https://untrusted.invalid' } })).status, 403)
  const complex = process.argv.includes('--complex')
  let pdf = complex ? createOCRLayoutFixture() : createResearchFixturePdf(false, true)
  await writeFile(path.join(root, 'fixture.pdf'), pdf)
  if (process.argv.includes('--scan')) {
    execFileSync(python, ['-c', 'import pypdfium2 as p,sys; d=p.PdfDocument(sys.argv[1]); images=[page.render(scale=2).to_pil().convert("RGB") for page in d]; images[0].save(sys.argv[2],save_all=True,append_images=images[1:],resolution=144); s=p.PdfDocument(sys.argv[2]); assert all(not page.get_textpage().get_text_range() for page in s)', path.join(root, 'fixture.pdf'), path.join(root, 'scan.pdf')], { windowsHide: true })
    pdf = await readFile(path.join(root, 'scan.pdf'))
  }
  const response = await fetch(`${url}/jobs`, { method: 'POST', headers, body: pdf })
  assert.equal(response.status, 200)
  const { id } = await response.json()
  let previous = ''
  for (;;) {
    const result = await (await fetch(`${url}/jobs/${id}`, { headers })).json()
    if (result.state === 'error') throw new Error(result.error)
    const progress = `${result.state} ${result.page || 0}/${result.total || 0}`
    if (progress !== previous) { console.log(progress); previous = progress }
    if (result.state === 'complete') {
      assert.equal(result.result.pages.length, 2)
      const text = result.result.pages.flatMap(page => page.blocks.map(block => block.text)).join(' ')
      await writeFile(path.join(root, 'result.json'), JSON.stringify(result.result, null, 2))
      if (complex) {
        const first = text.indexOf('First column'), second = text.indexOf('Second column'), third = text.indexOf('Third column')
        assert(first >= 0 && second > first && third > second, 'Three-column reading order is incorrect')
        assert(!text.includes('Downloaded from'), 'Vertical download furniture entered the body')
        assert.equal(result.result.pages[1].blocks.filter(block => block.image?.startsWith('data:image/png;base64,')).length, 10, 'All ten equations must be preserved as local images')
      } else {
        assert.match(text, /complete scientific argument/i)
        assert.match(text, /independent experiment/i)
      }
      assert(!result.result.pages.some(page => page.blocks.some(block => !block.locations.length)))
      const cached = await (await fetch(`${url}/jobs`, { method: 'POST', headers, body: pdf })).json()
      assert.equal((await (await fetch(`${url}/jobs/${cached.id}`, { headers })).json()).state, 'complete')
      const cancellable = await (await fetch(`${url}/jobs`, { method: 'POST', headers, body: Buffer.concat([pdf, Buffer.from('\n% cancel fixture')]) })).json()
      assert.equal((await fetch(`${url}/jobs/${cancellable.id}`, { method: 'DELETE', headers })).status, 200)
      assert.equal((await (await fetch(`${url}/jobs/${cancellable.id}`, { headers })).json()).state, 'cancelled')
      console.log(`OCR smoke passed: ${root}`); break
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
} finally { child.stdin.end() }
