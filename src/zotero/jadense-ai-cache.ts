/** Jev 完成结果的 profile 缓存；操作身份由内容摘要派生，不依赖可选缓存写盘成功。 */
import type { ZoteroLike } from './runtime'
type Answer = { choice: string; confidence: number | null; warning?: string }
type CacheHost = ZoteroLike & { __jadenseDecisionCache?: Map<string, Answer> }
type Platform = { IOUtils?: { readUTF8(path: string): Promise<string>; writeUTF8(path: string, text: string, options: { tmpPath: string }): Promise<unknown>; makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown> }; PathUtils?: { profileDir: string; join(...parts: string[]): string } }
export async function decisionOperationId(content: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(content))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}
/** 文件名仅使用摘要，缓存不会保存令牌或原始分类输入。 */
export async function cachedDecision(host: CacheHost, key: string): Promise<Answer | undefined> {
  if (host.__jadenseDecisionCache?.has(key)) return host.__jadenseDecisionCache.get(key)
  try {
    const { IOUtils, PathUtils } = globalThis as Platform
    const value = JSON.parse(await IOUtils!.readUTF8(PathUtils!.join(PathUtils!.profileDir, 'jadense-decision', `${key}.json`)))
    if (typeof value?.choice === 'string' && (value.confidence === null || (typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1))) return value as Answer
  } catch { /* 可选展示缓存不阻断分类，服务端操作围栏仍有效。 */ }
}
export async function saveDecision(host: CacheHost, key: string, answer: Answer) {
  (host.__jadenseDecisionCache ??= new Map()).set(key, answer)
  try {
    const { IOUtils, PathUtils } = globalThis as Platform
    const dir = PathUtils!.join(PathUtils!.profileDir, 'jadense-decision'), path = PathUtils!.join(dir, `${key}.json`)
    await IOUtils!.makeDirectory(dir, { ignoreExisting: true })
    await IOUtils!.writeUTF8(path, JSON.stringify(answer), { tmpPath: `${path}.tmp` })
  } catch { /* 缓存写盘失败仍保留会话结果，稳定身份避免重复收费。 */ }
}
