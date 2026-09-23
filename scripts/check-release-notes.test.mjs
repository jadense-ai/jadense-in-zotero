/** 发布说明格式回归：只检查文本，不创建或修改 GitHub Release。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkReleaseNotes } from './check-release-notes.mjs'

const body = `## 本次更新

- 新增 PDF 对照阅读。
- 修复更新弹窗。

## What's new

- Add side-by-side PDF reading.
- Fix the update dialog.

## 操作与配置

安装步骤和详细说明。

## 升级与兼容

从上一正式版直接升级，无需迁移。

## 验证与下载

已验证冷启动和升级；安装包见本页附件。
`

test('accepts five ordered Markdown sections with short bilingual update lists', () => {
  assert.deepEqual(checkReleaseNotes(body).zhCN, ['- 新增 PDF 对照阅读。', '- 修复更新弹窗。'])
  assert.equal(checkReleaseNotes(body.replace(/\n/gu, '\r\n')).enUS.length, 2)
})

test('rejects missing, repeated, malformed and placeholder update sections', () => {
  for (const invalid of [
    body.replace("## What's new", '## Release'),
    `${body}\n## 本次更新\n- 重复。`,
    body.replace('- 新增 PDF 对照阅读。', '新增 PDF 对照阅读。'),
    body.replace('- 新增 PDF 对照阅读。', '- 待填写'),
    body.replace('## 操作与配置', '### 详细内容'),
    body.replace('## 升级与兼容', '## 兼容性'),
    body.replace('## 升级与兼容', '## 额外内容\n\n说明。\n\n## 升级与兼容'),
    body.replace('安装步骤和详细说明。', '待填写'),
    body.replace('已验证冷启动和升级；安装包见本页附件。', '- [ ] 待验证'),
    body.replace('## 操作与配置\n\n安装步骤和详细说明。', '## 操作与配置'),
  ]) assert.throws(() => checkReleaseNotes(invalid))
})
