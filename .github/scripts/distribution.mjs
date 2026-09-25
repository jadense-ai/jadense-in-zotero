/** 发布附件统一边界：流式摘要避免将 GB 级离线 ZIP 一次载入内存。 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, readFileSync, statSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export function digest(file) {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  const fd = openSync(file, 'r')
  try {
    let count
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count))
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

/** 必需角色独立校验；忽略附加字段，但不允许清单控制越界文件或缺少正式制品。 */
export function verifyDistribution(directory, version) {
  const metadata = JSON.parse(readFileSync(path.join(directory, 'distribution-metadata.json'), 'utf8'))
  if (metadata.version !== version) throw new Error('Distribution version mismatch')
  const patterns = {
    xpi: name => name === `jadense-in-zotero-v${version}.xpi`,
    offline: name => name === `jadense-in-zotero-v${version}-windows-x64-offline.zip`,
    'pdf-translation': name => /^jadense-pdf-engine-[\w.-]+-windows-x64\.zip$/.test(name),
    ocr: name => /^jadense-ocr-engine-[\w.-]+-windows-x64\.zip$/.test(name),
  }
  const checksums = readFileSync(path.join(directory, 'DISTRIBUTION-SHA256SUMS'), 'utf8').trim().split(/\r?\n/)
  return Object.entries(patterns).map(([kind, matches]) => {
    const entry = metadata.assets?.[kind]
    if (!entry || typeof entry.file !== 'string' || !matches(entry.file)) throw new Error(`Missing or invalid ${kind} asset`)
    const file = path.resolve(directory, entry.file)
    const size = statSync(file).size
    if (!size || size >= 2 ** 31) throw new Error('Release assets must be smaller than 2 GiB')
    const hash = digest(file)
    if (entry.size !== size || entry.sha256 !== hash || !checksums.includes(`${hash}  ${entry.file}`)) throw new Error(`${kind} distribution checksum mismatch`)
    return file
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyDistribution(process.argv[2], process.argv[3])
}
