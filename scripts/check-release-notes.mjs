/** 发布前检查 GitHub Release 正文的固定 Markdown 更新栏目；只读本地文件或标准输入。 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HEADINGS = ['## 本次更新', "## What's new", '## 操作与配置', '## 升级与兼容', '## 验证与下载']

/** 从 v0.6.2 起，固定栏目既供用户阅读，也供插件稳定提取更新摘要。 */
export function checkReleaseNotes(body) {
  if (typeof body !== 'string') throw new Error('Release body must be text.')
  const lines = body.replace(/\r\n?/gu, '\n').split('\n')
  const headings = lines.filter(line => /^##\s/u.test(line))
  if (headings.length !== HEADINGS.length || headings.some((heading, index) => heading !== HEADINGS[index])) {
    throw new Error(`Release body must contain these headings once, in order: ${HEADINGS.join(' / ')}.`)
  }
  const sections = HEADINGS.map((heading, index) => {
    const start = lines.indexOf(heading)
    const end = index + 1 < HEADINGS.length ? lines.indexOf(HEADINGS[index + 1]) : lines.length
    return lines.slice(start + 1, end).map(line => line.trim()).filter(Boolean)
  })
  const items = (heading, language) => {
    const section = sections[HEADINGS.indexOf(heading)]
    if (section.length < 1 || section.length > 4 || section.some(line => !/^[-*+]\s+\S/u.test(line))) throw new Error(`${heading} must contain 1–4 Markdown bullet items only.`)
    for (const line of section) {
      const text = line.replace(/^[-*+]\s+/u, '').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/[*_`]/gu, '').trim()
      if (!text || text.length > 220 || /待填写|TODO/iu.test(text)) throw new Error(`${language} update items must be short and must not contain placeholders.`)
    }
    return section
  }
  for (let index = 2; index < HEADINGS.length; index++) {
    if (!sections[index].length || sections[index].some(line => /待填写|TODO|\[ \]/iu.test(line))) {
      throw new Error(`${HEADINGS[index]} must contain actual release information, not placeholders.`)
    }
  }
  return { zhCN: items('## 本次更新', 'Chinese'), enUS: items("## What's new", 'English') }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = process.argv[2]
    if (!source) throw new Error('Usage: node scripts/check-release-notes.mjs <body.md|->')
    checkReleaseNotes(readFileSync(source === '-' ? 0 : source, 'utf8'))
    process.stdout.write('Release notes format is valid.\n')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
