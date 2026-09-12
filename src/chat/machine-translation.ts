/** 网页翻译适配：只接收原文与语言；共享宿主队列串行发送，不携带攻玉/BYOK 凭据。 */
import MarkdownIt from 'markdown-it'
import type { TranslationLanguages } from './translation-languages'
import { uiText } from '@/zotero/ui-preferences'
import { queueTranslation, retryAt, TranslationRateLimitError } from './translation-queue'

export type TranslationService = 'bing' | 'google'
export const TRANSLATION_LIMITS = { bing: 1000, google: 5000 } as const
const entities = new MarkdownIt().utils
type QueueHost = { __jadenseTranslationQueue?: Promise<unknown> }

/** 优先在句界和空白处切分；按 UTF-16 长度保守限额，保证 Unicode 与源文均不丢失。 */
export function splitMachineTranslationText(text: string, limit: number): string[] {
  const chars = [...text], parts: string[] = []
  let start = 0
  while (start < chars.length) {
    let end = start, size = 0, boundary = start
    while (end < chars.length && size + chars[end].length <= limit) {
      size += chars[end].length; end++
      if (/[\s。！？.!?]/u.test(chars[end - 1])) boundary = end
    }
    const stop = end === chars.length ? end : boundary > start ? boundary : end
    if (stop === start) throw new Error('Translation chunk limit is too small')
    parts.push(chars.slice(start, stop).join('')); start = stop
  }
  return parts
}

function check(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError') }

/** 等待时响应取消；无法取消的旧宿主响应仍不得进入后续请求或存储。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(value => { if (!signal.aborted) resolve(value) }, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

function language(code: string, service: TranslationService) {
  if (service === 'google') return code
  return ({ auto: 'auto-detect', 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' } as Record<string, string>)[code] ?? code
}

/** 只解析响应拥有的译文字段，附加字段忽略；HTML 永不插入插件 DOM。 */
async function translateChunk(service: TranslationService, text: string, languages: TranslationLanguages, fetchImpl: typeof fetch, signal: AbortSignal) {
  const request = async (url: string, init?: RequestInit) => {
    check(signal)
    const response = await fetchImpl(url, { ...init, credentials: 'omit', signal })
    check(signal)
    if (response.status === 429) throw new TranslationRateLimitError(retryAt(response.headers.get('Retry-After')))
    if (!response.ok) throw new Error(uiText(`${service === 'bing' ? 'Bing' : 'Google'} 翻译请求失败（HTTP ${response.status}），请稍后重试。`, `${service === 'bing' ? 'Bing' : 'Google'} translation failed (HTTP ${response.status}). Please try again later.`))
    return response
  }
  const source = language(languages.sourceLanguage, service), target = language(languages.targetLanguage, service)
  let result: unknown
  if (service === 'google') {
    const query = new URLSearchParams({ sl: source, tl: target, q: text })
    const html = await (await request(`https://translate.google.com/m?${query}`)).text()
    const value = /class=["'](?:t0|result-container)["'][^>]*>([\s\S]*?)<\/div>/u.exec(html)?.[1]
    result = value?.replace(/<[^>]*>/gu, '').replace(/&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/giu, entity => entities.unescapeAll(entity))
  } else {
    const html = await (await request('https://www.bing.com/translator')).text()
    const ig = /["']IG["']\s*:\s*["']([^"']+)/iu.exec(html)?.[1]
    const iid = [...html.matchAll(/data-iid=["']([^"']+)["']/gu)].at(-1)?.[1]
    const session = /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"']+)"/u.exec(html)
    if (!ig || !iid || !session) throw new Error(uiText('Bing 翻译页面暂不可用，请稍后重试。', 'The Bing translation page is unavailable. Please try again later.'))
    const query = new URLSearchParams({ IG: ig, IID: iid })
    const body = new URLSearchParams({ fromLang: source, to: target, text, key: session[1], token: session[2] })
    const reply = await (await request(`https://www.bing.com/ttranslatev3?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })).json()
    result = reply?.[0]?.translations?.[0]?.text
  }
  check(signal)
  if (typeof result !== 'string' || !result.trim()) throw new Error(uiText('翻译服务没有返回可识别的译文，请稍后重试。', 'The translation service returned no readable translation. Please try again later.'))
  return result
}

/** 每片请求占用同一宿主队列；选文和全文跨窗口共享，无重试、无隐式服务回退。 */
export async function translateMachineText(input: TranslationLanguages & {
  host: object; service: TranslationService; text: string; fetchImpl: typeof fetch; signal?: AbortSignal
  onText?: (text: string) => void
}): Promise<string> {
  const host = input.host as QueueHost
  let result = ''
  for (const text of splitMachineTranslationText(input.text, TRANSLATION_LIMITS[input.service])) {
    check(input.signal)
    const operation = (host.__jadenseTranslationQueue ?? Promise.resolve()).catch(() => undefined).then(async () => {
      check(input.signal)
      if (!text.trim()) return text
      const controller = new AbortController()
      const cancel = () => controller.abort()
      input.signal?.addEventListener('abort', cancel, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const translated = await queueTranslation(host, input.service, input.signal, () => {
          timer = setTimeout(cancel, 30_000)
          return abortable(translateChunk(input.service, text, input, input.fetchImpl, controller.signal), controller.signal)
        })
        // 接口常会去除空白；恢复片段边界，避免连续片段直接粘连。
        return (text.match(/^\s*/u)?.[0] ?? '') + translated.trim() + (text.match(/\s*$/u)?.[0] ?? '')
      } catch (error) {
        check(input.signal)
        if (controller.signal.aborted) throw new Error(uiText('翻译请求超时，请稍后重试。', 'Translation timed out. Please try again later.'))
        throw error
      } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', cancel) }
    })
    host.__jadenseTranslationQueue = operation.catch(() => undefined)
    result += await (input.signal ? abortable(operation, input.signal) : operation)
    check(input.signal)
    input.onText?.(result)
  }
  return result
}
