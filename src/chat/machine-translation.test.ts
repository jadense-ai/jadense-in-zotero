/** 网页响应夹具覆盖协议、无损切片和跨入口队列，不发送真实文献。 */
import { describe, expect, it, vi } from 'vitest'
import { splitMachineTranslationText, translateMachineText } from './machine-translation'

const languages = { sourceLanguage: 'en', targetLanguage: 'zh-CN' }
const google = (text = '译文') => new Response(`<div class="result-container">${text}</div>`)
const bing = '<script>var x={"ig":"test-ig"};var params_AbusePreventionHelper = [123,"test-session",3600];</script><div data-iid="translator.1"></div>'

describe('traditional translation adapters', () => {
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
  })

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
  })

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
