/** 纯文本容量估算与可选材料选择；完整正文独立保存，仅当前请求使用检索片段。 */
export function textTokenCost(text: string) { return [...text].reduce((sum, c) => sum + (c.charCodeAt(0) < 128 ? 1 / 3 : 1.5), 0) }

/** 完整正文保持在上游存储；超容量时优先问题相关片段并显式报告不完整覆盖。 */
export function fitTextContext(text: string, budget: number, question = ''): { text: string; limited: boolean } {
  const cost = (value: string) => textTokenCost(JSON.stringify(value))
  if (cost(text) <= budget) return { text, limited: false }
  if (budget < 64) return { text: '', limited: true }
  const words = question.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
  const terms = [...new Set(words.flatMap(word => /^\p{Script=Han}+$/u.test(word) ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)) : [word]))]
  const chunks: string[] = [], size = Math.max(64, Math.min(4000, Math.floor(budget / 4)))
  let chunk = '', used = 0
  for (const char of text) {
    const n = cost(char)
    if (chunk && used + n > size) { chunks.push(chunk); chunk = ''; used = 0 }
    chunk += char; used += n
  }
  if (chunk) chunks.push(chunk)
  const ranked = chunks.map((value, index) => ({ value, index, score: terms.reduce((n, term) => n + Number(value.toLowerCase().includes(term)), 0) }))
    .sort((a, b) => b.score - a.score || Number(b.index === chunks.length - 1) - Number(a.index === chunks.length - 1) || a.index - b.index)
  const selected: typeof ranked = []
  const build = () => selected.sort((a, b) => a.index - b.index).map(row => row.value).join('\n[…]\n')
  let selectedCost = 0
  for (const row of ranked) {
    const added = cost(row.value) + 8
    if (selectedCost + added <= budget - 32) { selected.push(row); selectedCost += added }
  }
  return { text: build(), limited: true }
}
