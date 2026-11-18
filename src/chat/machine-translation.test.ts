/** 网页响应夹具覆盖协议、无损切片和跨入口队列，不发送真实文献。 */
import { describe, expect, it, vi } from 'vitest'
import { splitMachineTranslationText, translateMachineText } from './machine-translation'

const languages = { sourceLanguage: 'en', targetLanguage: 'zh-CN' }
const google = (text = '译文') => new Response(`<div class="result-container">${text}</div>`)
const bing = '<script>var x={"ig":"test-ig"};var params_AbusePreventionHelper = [123,"test-session",3600];</script><div data-iid="translator.1"></div>'

describe('traditional translation adapters', () => {
  it.each([
    ['edge', 'https://edge.microsoft.com/translate/translatetext', [{ translations: [{ text: '甲乙' }], ignored: 1 }]],
    ['google-gtx', 'https://translate.googleapis.com/translate_a/single', [[['甲', 'A'], ['乙', 'B']], null, 'en']],
    ['libretranslate', 'http://127.0.0.1:5000/translate', { translatedText: '甲乙', extra: true }],
  ] as const)('routes %s directly and preserves auto detection and traditional Chinese', async (service, endpoint, reply) => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(reply))
    const result = await translateMachineText({ host: {}, service, text: 'A B', sourceLanguage: 'auto', targetLanguage: 'zh-TW', fetchImpl })
    expect(result).toBe('甲乙')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [address, init] = fetchImpl.mock.calls[0], url = new URL(String(address))
    expect(url.origin + url.pathname).toBe(endpoint)
    expect(init?.credentials).toBe('omit')
    if (service === 'edge') {
      expect(Object.fromEntries(url.searchParams)).toEqual({ to: 'zh-Hant', isEnterpriseClient: 'false' })
      expect(JSON.parse(String(init?.body))).toEqual(['A B'])
    } else if (service === 'google-gtx') {
      expect(Object.fromEntries(url.searchParams)).toEqual({ client: 'gtx', dt: 't', sl: 'auto', tl: 'zh-TW', q: 'A B' })
    } else {
      expect(init?.redirect).toBe('error')
      expect(JSON.parse(String(init?.body))).toEqual({ q: 'A B', source: 'auto', target: 'zt', format: 'text' })
    }
  })

  it('sends MyMemory at most 500 UTF-8 bytes per lookup and preserves the entire selection', async () => {
    const requests: string[] = [], text = ('中文 😀. ').repeat(75)
    const host = { Prefs: { get: () => '{"https://api.mymemory.translated.net":{"rpm":60000}}' } }
    const fetchImpl = vi.fn(async (address: RequestInfo | URL) => {
      const url = new URL(String(address)), q = url.searchParams.get('q')!
      expect(url.origin + url.pathname).toBe('https://api.mymemory.translated.net/get')
      expect(url.searchParams.get('langpair')).toBe('autodetect|en')
      requests.push(q)
      return Response.json({ responseStatus: '200', responseData: { translatedText: q.trim() } })
    })
    expect(await translateMachineText({ host, service: 'mymemory', text, sourceLanguage: 'auto', targetLanguage: 'en', fetchImpl })).toBe(text)
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.join('')).toBe(text)
    expect(requests.every(q => new TextEncoder().encode(q).length <= 500)).toBe(true)
  })

  it.each([
    ['mymemory', { responseStatus: 429, quotaFinished: true, responseData: { translatedText: 'quota warning' } }],
    ['mymemory', { responseStatus: 403, responseData: { translatedText: 'invalid language' } }],
    ['google-gtx', [[['first sentence'], [null, 'second missing']]]],
  ] as const)('does not store service errors or partial %s replies as translations', async (service, reply) => {
    const fetchImpl = vi.fn(async () => Response.json(reply)), onText = vi.fn()
    await expect(translateMachineText({ host: {}, service, text: 'test', ...languages, fetchImpl, onText })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(onText).not.toHaveBeenCalled()
  })
  it('maps Bing languages and reads only the translation field without credentials', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify([{ translations: [{ text: '繁體譯文', extra: true }], extra: 1 }])) : new Response(bing))
    expect(await translateMachineText({ host: {}, service: 'bing', text: 'hello', sourceLanguage: 'auto', targetLanguage: 'zh-TW', fetchImpl })).toBe('繁體譯文')
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('IG')).toBe('test-ig')
    expect(Object.fromEntries(new URLSearchParams(String(fetchImpl.mock.calls[1][1]?.body)))).toEqual({ fromLang: 'auto-detect', to: 'zh-Hant', text: 'hello', key: '123', token: 'test-session' })
    expect(fetchImpl.mock.calls.every(([, init]) => init?.credentials === 'omit')).toBe(true)
    expect(fetchImpl.mock.calls[1][1]?.headers).not.toHaveProperty('Authorization')
  })

  it('decodes Google HTML entities without changing literal backslashes or returning markup', async () => {
    const fetchImpl = vi.fn(async () => google('A &amp; B &#x1F600; &lt;script&gt; \\*'))
    expect(await translateMachineText({ host: {}, service: 'google', text: 'hello', ...languages, fetchImpl })).toBe('A & B 😀 <script> \\*')
  })

  it.each([1000, 5000])('splits at %i without losing whitespace or surrogate pairs', limit => {
    const text = ('Alpha 😀 sentence. 中文段落！\n' + '😀'.repeat(2600)).repeat(2)
    const parts = splitMachineTranslationText(text, limit)
    expect(parts.join('')).toBe(text)
    expect(parts.every(part => part.length <= limit && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part))).toBe(true)
  })

  it('sends every source character and restores chunk boundary whitespace', async () => {
    const source = 'A sentence. '.repeat(900), received: string[] = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const text = new URL(String(url)).searchParams.get('q')!; received.push(text)
      return google(text.trim())
    })
    expect(await translateMachineText({ host: {}, service: 'google', text: source, ...languages, fetchImpl })).toBe(source)
    expect(received.join('')).toBe(source)
  }, 15_000)

  it.each([() => new Response('limited', { status: 429 }), () => google(''), () => new Response('<html>captcha</html>')])('fails locally without retries or fallback', async response => {
    const fetchImpl = vi.fn(async () => response())
    await expect(translateMachineText({ host: {}, service: 'google', text: 'hello', ...languages, fetchImpl })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('shares a serial queue and releases it after an error', async () => {
    const host = {}, calls: string[] = []
    let release!: (response: Response) => void
    const fetchImpl = vi.fn((url: RequestInfo | URL) => {
      calls.push(new URL(String(url)).searchParams.get('q')!)
      return calls.length === 1 ? new Promise<Response>(resolve => { release = resolve }) : Promise.resolve(google())
    })
    const first = translateMachineText({ host, service: 'google', text: 'first', ...languages, fetchImpl })
    const failure = expect(first).rejects.toThrow()
    const second = translateMachineText({ host, service: 'google', text: 'second', ...languages, fetchImpl })
    await vi.waitFor(() => expect(calls).toEqual(['first']))
    release(new Response('', { status: 429, headers: { 'Retry-After': '1' } })); await failure
    expect(await second).toBe('译文'); expect(calls).toEqual(['first', 'second'])
  }, 15_000)

  it('cancels queued requests and drops a late active response', async () => {
    const host = {}, controller = new AbortController(), queued = new AbortController(), onText = vi.fn()
    let release!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    const active = translateMachineText({ host, service: 'google', text: 'active', ...languages, fetchImpl, signal: controller.signal, onText })
    const waiting = translateMachineText({ host, service: 'google', text: 'queued', ...languages, fetchImpl, signal: queued.signal })
    const rejectedActive = expect(active).rejects.toMatchObject({ name: 'AbortError' })
    const rejectedWaiting = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    queued.abort(); controller.abort(); release(google('late'))
    await Promise.all([rejectedActive, rejectedWaiting])
    expect(onText).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
