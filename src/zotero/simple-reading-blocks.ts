/** 原生 SDT DOM → 引用路径翻译单元；不解析 PDF，也不复制宿主渲染器。 */
export const SIMPLE_READING_STRATEGY = 'native-sdt-v1'
export type ReadingBlock = { id: string; text: string; pairs?: Array<[number, number]> }
type Marker = { node: Node; kind: 'open' | 'close' | 'keep'; pair?: number }
export type BoundReadingBlock = ReadingBlock & { element: HTMLElement; markers: Marker[] }
const markerPattern = /⟦J(\d+)⟧/gu
const token = (n: number) => `⟦J${n}⟧`
const blockSelector = 'p,h1,h2,h3,h4,h5,h6,li,td,th,figcaption,aside'
const protectedSelector = '.sdt-reference,.sdt-source-crop,.sdt-math,math,img,svg,pre,code,[hidden]'

/** 仅用于确认本地生成的回填串可安全重建 DOM；模型原始文本先经过恢复。 */
export function validBlockOutput(block: ReadingBlock, output: unknown): boolean {
  if (typeof output !== 'string' || !output.trim()) return false
  const expected = [...block.text.matchAll(markerPattern)].map(m => m[0]).sort()
  const actual = [...output.matchAll(markerPattern)].map(m => m[0]).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual) || /⟦J[^⟧]*$/u.test(output)) return false
  const starts = new Map(block.pairs ?? []), ends = new Map((block.pairs ?? []).map(([a, b]) => [b, a])), stack: number[] = []
  for (const match of output.matchAll(markerPattern)) {
    const id = Number(match[1])
    if (starts.has(id)) stack.push(id)
    else if (ends.has(id) && stack.pop() !== ends.get(id)) return false
  }
  return stack.length === 0
}

/** 模型漏掉格式标记时保留译文正文，按原文中的相对位置恢复原生节点。 */
export function recoverReadingOutput(block: ReadingBlock, output: unknown): string | undefined {
  if (typeof output !== 'string' || !output.trim()) return undefined
  const expected = new Set([...block.text.matchAll(markerPattern)].map(match => match[1]))
  const normalized = output.replace(/(?:⟦|［|\[)\s*J\s*(\d+)\s*(?:⟧|］|\])/gu, (value, id: string) => expected.has(id) ? token(Number(id)) : value)
  if (validBlockOutput(block, normalized)) return normalized
  const markers = [...block.text.matchAll(markerPattern)]
  if (!markers.length) return normalized
  const prose = Array.from(normalized.replace(/⟦\s*J\s*\d+\s*⟧/gu, ''))
  if (!prose.join('').trim()) return undefined
  const sourceLength = Array.from(block.text.replace(markerPattern, '')).length
  let sourceOffset = 0, previous = 0, outputOffset = 0, restored = ''
  for (const match of markers) {
    sourceOffset += Array.from(block.text.slice(previous, match.index)).length
    const approximate = sourceLength ? Math.round(sourceOffset / sourceLength * prose.length) : 0
    const position = nearestReadingBoundary(prose, approximate, outputOffset)
    restored += prose.slice(outputOffset, position).join('') + match[0]
    outputOffset = position; previous = match.index! + match[0].length
  }
  restored += prose.slice(outputOffset).join('')
  return validBlockOutput(block, restored) ? restored : undefined
}

function nearestReadingBoundary(text: string[], approximate: number, minimum: number) {
  let best = approximate, distance = 7
  for (let index = Math.max(minimum, approximate - 6); index <= Math.min(text.length, approximate + 6); index++) {
    if (index !== 0 && index !== text.length && !/[\s.,;:!?，。；：！？、]/u.test(text[index - 1]) && !/\s/u.test(text[index])) continue
    const gap = Math.abs(index - approximate)
    if (gap < distance) { best = index; distance = gap }
  }
  return Math.max(minimum, best)
}

/** 使用宿主已合并的跨页元素；列表条目、表格单元格作为独立单元。 */
export function readingBlocks(root: HTMLElement, authors: string[] = []): BoundReadingBlock[] {
  const normalizedAuthors = new Set(authors.map(name => name.trim().toLocaleLowerCase()).filter(Boolean))
  const result: BoundReadingBlock[] = []
  const references = new Set<Element>(); let inReferences = false
  for (const child of Array.from(root.children)) {
    if (/^h[1-6]$/u.test(child.localName)) { inReferences = /^(?:\d+[.\s]*)?(?:references|bibliography|参考文献)\s*$/iu.test(child.textContent?.trim() ?? ''); continue }
    if (inReferences) references.add(child)
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(blockSelector))) {
    if (!/^\d+(?:\.\d+)*$/u.test(el.dataset.refPath ?? '') || el.closest(protectedSelector)) continue
    if (Array.from(references).some(section => section === el || section.contains(el))) continue
    const owner = el.parentElement?.closest('li,td,th')
    if (owner && !el.matches('li,td,th')) continue
    const plain = el.textContent?.trim() ?? ''
    if (!/\p{L}/u.test(plain) || normalizedAuthors.has(plain.toLocaleLowerCase())) continue
    const markers: Marker[] = []
    const keep = (node: Node) => { const n = markers.length; markers.push({ node, kind: 'keep' }); return token(n) }
    const encode = (node: Node): string => {
      if (node.nodeType === 3) {
        // DOI、URL 与原文自带的标记都是只读原子，不能混进译文协议。
        return (node.textContent ?? '').replace(/https?:\/\/[^\s<>]+|\b10\.\d{4,9}\/[^\s<>]+|⟦J\d+⟧/gu, value => keep(el.ownerDocument.createTextNode(value)))
      }
      if (node.nodeType !== 1) return ''
      const child = node as HTMLElement
      if (child.matches(protectedSelector) || child.matches('ul,ol,table') || child.localName === 'br') return keep(child)
      // SDT 的文字定位 span 不是语义格式；不把每个排版碎片变成模型必须复制的一对标记。
      if (child.localName === 'span' && Array.from(child.attributes).every(attr => attr.name === 'data-text-index')) return Array.from(child.childNodes, encode).join('')
      const start = markers.length
      markers.push({ node: child, kind: 'open' })
      const content = Array.from(child.childNodes, encode).join('')
      const end = markers.length
      markers.push({ node: child, kind: 'close', pair: start }); markers[start].pair = end
      return token(start) + content + token(end)
    }
    const text = Array.from(el.childNodes, encode).join('')
    if (/\p{L}/u.test(text.replace(markerPattern, ''))) result.push({ id: el.dataset.refPath!, text, element: el, markers, pairs: markers.flatMap((m, i) => m.kind === 'open' ? [[i, m.pair!] as [number, number]] : []) })
  }
  return result
}

/** 仅创建文本节点和原模板节点副本；Provider 的 HTML 永远只是可选择的文字。 */
export function applyReadingOutput(block: BoundReadingBlock, output: string): boolean {
  if (!validBlockOutput(block, output)) return false
  const doc = block.element.ownerDocument, fragment = doc.createDocumentFragment()
  const stack: Array<{ node: Node; index: number }> = [{ node: fragment, index: -1 }]
  let offset = 0
  for (const match of output.matchAll(markerPattern)) {
    stack.at(-1)!.node.appendChild(doc.createTextNode(output.slice(offset, match.index)))
    const index = Number(match[1]), marker = block.markers[index]
    if (!marker) return false
    if (marker.kind === 'close') { if (stack.at(-1)?.index !== marker.pair) return false; stack.pop() }
    else {
      const node = marker.node.cloneNode(marker.kind === 'keep')
      stack.at(-1)!.node.appendChild(node)
      if (marker.kind === 'open') stack.push({ node, index })
    }
    offset = match.index! + match[0].length
  }
  if (stack.length !== 1) return false
  fragment.append(doc.createTextNode(output.slice(offset)))
  block.element.replaceChildren(fragment)
  return true
}

/** 宽容读取常见数组、包装、ID 映射、JSONL 与顺序列表，逐段恢复可用正文。 */
export function readingReply(blocks: ReadingBlock[], reply: string): Record<string, string> {
  const clean = reply.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let parsed: unknown
  try { parsed = JSON.parse(clean) } catch { /* 独立回收完整对象。 */ }
  const repaired = parsed === undefined ? repairReadingJSON(clean) : clean
  if (parsed === undefined) try { parsed = JSON.parse(repaired) } catch { /* 外层仍损坏时逐对象回收。 */ }
  const allowed = new Map(blocks.map(block => [block.id, block])), values = new Map<string, string>()
  const rows = parsed === undefined ? completeReplyRows(repaired, blocks) : readingRows(parsed, blocks)
  if (!rows.length && parsed === undefined && !clean.startsWith('[') && !clean.startsWith('{')) {
    const passages = clean.split(/\n\s*\n/gu).map(part => part.trim()).filter(Boolean)
    const lines = passages.length === blocks.length ? passages : clean.split(/\n+/gu).map(part => part.trim()).filter(Boolean)
    if (lines.length === blocks.length) lines.forEach((part, index) => rows.push({ id: blocks[index].id, output: part }))
  }
  for (const row of rows) {
    const block = allowed.get(row.id), recovered = block && recoverReadingOutput(block, row.output)
    if (!block || !recovered) continue
    if (!values.has(row.id) || recovered.length > values.get(row.id)!.length) values.set(row.id, recovered)
  }
  return Object.fromEntries(values)
}

type ReplyRow = { id: string; output: unknown }
function readingRows(value: unknown, blocks: ReadingBlock[], depth = 0): ReplyRow[] {
  if (depth > 4) return []
  if (typeof value === 'string' && blocks.length === 1) return [{ id: blocks[0].id, output: value }]
  if (Array.isArray(value)) {
    const hasExplicitID = value.some(row => row && typeof row === 'object' && !Array.isArray(row) && 'id' in row)
    if (!hasExplicitID && value.length === blocks.length && value.every(row => typeof row === 'string' || row && typeof row === 'object' && !Array.isArray(row) && ['output', 'translation', 'translated_text', 'text'].some(key => key in row))) {
      return value.map((row, index) => ({ id: blocks[index].id, output: typeof row === 'string' ? row : readingText(row as Record<string, unknown>) }))
    }
    return value.flatMap(row => readingRows(row, blocks, depth + 1))
  }
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (typeof record.id === 'string' || typeof record.id === 'number') return [{ id: String(record.id).trim(), output: readingText(record) }]
  for (const key of ['translations', 'results', 'data', 'output']) if (key in record && typeof record[key] === 'object') return readingRows(record[key], blocks, depth + 1)
  if (blocks.length === 1 && typeof readingText(record) === 'string') return [{ id: blocks[0].id, output: readingText(record) }]
  const allowed = new Set(blocks.map(block => block.id))
  return Object.entries(record).flatMap(([key, output]) => {
    const index = /^p([1-9]\d*)$/iu.exec(key)?.[1]
    const id = allowed.has(key) ? key : index ? blocks[Number(index) - 1]?.id : undefined
    return id ? [{ id, output: typeof output === 'object' && output !== null ? readingText(output as Record<string, unknown>) : output }] : []
  })
}
function readingText(row: Record<string, unknown>) { return row.output ?? row.translation ?? row.translated_text ?? row.text }

/** 只修复 JSON 容器和字符串转义，不补造被截断的译文内容。 */
function repairReadingJSON(raw: string) {
  let result = '', quoted = false
  const closing: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (quoted) {
      if (char === '\\') {
        const next = raw[i + 1]
        if (next && !'"\\/bfnrtu'.includes(next)) result += '\\'
        result += char
        continue
      }
      if (char === '"') quoted = false
      result += char === '\n' ? '\\n' : char
      continue
    }
    if (char === '"') quoted = true
    else if (char === '[') closing.push(']')
    else if (char === '{') closing.push('}')
    else if (char === closing.at(-1)) closing.pop()
    if (char === ',' && /^[\s]*[}\]]/u.test(raw.slice(i + 1))) continue
    result += char
  }
  return quoted ? result : result.trimEnd().replace(/,$/u, '') + closing.reverse().join('')
}

/** 外层 JSON 损坏时仅恢复完整对象；字符串内的括号/转义不能成为块边界。 */
function completeReplyRows(reply: string, blocks: ReadingBlock[]): ReplyRow[] {
  const rows: ReplyRow[] = [], starts: number[] = []
  let quoted = false, escaped = false
  for (let i = 0; i < reply.length; i++) {
    const char = reply[i]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') quoted = true
    else if (char === '{') starts.push(i)
    else if (char === '}' && starts.length) {
      const start = starts.pop()!
      try { rows.push(...readingRows(JSON.parse(reply.slice(start, i + 1)), blocks)) } catch { /* 仅丢弃损坏对象。 */ }
    }
  }
  return rows
}

/** 可见块每次派发前重新排前；超容量单元留给局部拆分，不使全文失败。 */
export function readingBatch(blocks: ReadingBlock[], visible: Set<string>, limit: number, cost: (text: string) => number): ReadingBlock[] {
  const ordered = blocks.map((block, index) => ({ block, index })).sort((a, b) => Number(visible.has(b.block.id)) - Number(visible.has(a.block.id)) || a.index - b.index)
  const batch: ReadingBlock[] = []; let used = 0
  for (const { block } of ordered) {
    const size = cost(JSON.stringify(block)) + 32
    if (batch.length && used + size > limit) break
    batch.push(block); used += size
    if (used >= limit) break
  }
  // 优先级决定选哪批，进入模型的段落仍按原文顺序排列，保留上下文。
  const selected = new Set(batch.map(block => block.id))
  return blocks.filter(block => selected.has(block.id))
}

export function machineReadingText(blocks: ReadingBlock[]) {
  return blocks.map((block, i) => `⟦B${i}⟧${block.text}⟦E${i}⟧`).join('\n')
}
export function machineReadingReply(blocks: ReadingBlock[], reply: string): Record<string, string> {
  const result: Record<string, string> = {}
  blocks.forEach((block, index) => {
    const start = `⟦B${index}⟧`, end = `⟦E${index}⟧`
    if (reply.split(start).length !== 2 || reply.split(end).length !== 2) return
    const a = reply.indexOf(start) + start.length, b = reply.indexOf(end)
    const value = reply.slice(a, b)
    if (b >= a && !/⟦[BE]\d+⟧/u.test(value) && validBlockOutput(block, value)) result[block.id] = value
  })
  return result
}
