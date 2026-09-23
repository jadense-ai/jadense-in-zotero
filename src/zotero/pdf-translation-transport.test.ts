/** 真实 stdio 调度函数回归：两条在途消息乱序完成、背压与无进展计时。 */
import { afterEach, expect, it, vi } from 'vitest'
import { runPDFWorker } from './pdf-translation-runtime'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function processFixture() {
  const chunks: string[] = [], replies: string[] = []
  let read: ((value: string | null) => void) | undefined
  const push = (value: string) => { if (read) { const resolve = read; read = undefined; resolve(value) } else chunks.push(value) }
  const child = {
    stdin: { write: vi.fn(async (line: string) => { const value = JSON.parse(line); if (value.id) { replies.push(value.id); if (replies.length === 2) { push('{"type":"complete"}\n'); push('') } } }), close: async () => {} },
    stdout: { readString: async () => chunks.length ? chunks.shift()! : new Promise<string | null>(resolve => { read = resolve }) },
    stderr: { readString: async () => null }, wait: async () => ({ exitCode: 0 }), kill: vi.fn(() => push('')),
  }
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: (...parts: string[]) => parts.join('/') })
  vi.stubGlobal('IOUtils', { exists: async () => false })
  vi.stubGlobal('ChromeUtils', { importESModule: () => ({ Subprocess: { getEnvironment: () => ({}), call: async () => child } }) })
  return { child, replies, push }
}

it('consumes concurrent requests and writes their replies by identity rather than input order', async () => {
  const f = processFixture(), gates = new Map<string, () => void>(), signal = new AbortController().signal
  f.push('{"type":"translate","id":"first","text":"a"}\n{"type":"translate","id":"second","text":"b"}\n')
  const result = runPDFWorker({}, {}, signal, async message => {
    if (message.type !== 'translate') return
    await new Promise<void>(resolve => gates.set(String(message.id), resolve))
    return { id: message.id, text: 'translated' }
  })
  await vi.waitFor(() => expect(gates.size).toBe(2))
  gates.get('second')!(); await vi.waitFor(() => expect(f.replies).toEqual(['second']))
  gates.get('first')!(); await result
  expect(f.replies).toEqual(['second', 'first']); expect(f.child.kill).not.toHaveBeenCalled()
})

it('excludes pending translation quota from the layout timeout and drops late replies on cancellation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = processFixture(), controller = new AbortController()
  let finish!: () => void
  f.push('{"type":"translate","id":"first","text":"a"}\n')
  const result = runPDFWorker({}, {}, controller.signal, async message => {
    await new Promise<void>(resolve => { finish = resolve }); return { id: message.id, text: 'late' }
  })
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(31 * 60_000); expect(f.child.kill).not.toHaveBeenCalled()
  controller.abort(); finish(); await vi.advanceTimersByTimeAsync(1); await assertion
  expect(f.replies).toEqual([]); expect(f.child.kill).toHaveBeenCalledOnce()
})

it('sends soft cancellation and continues consuming the final artifact without killing the engine', async () => {
  const f = processFixture(), finish = new AbortController(), messages: string[] = []
  const result = runPDFWorker({}, {}, new AbortController().signal, async message => { messages.push(String(message.type)) }, finish.signal)
  await vi.waitFor(() => expect(f.child.stdin.write).toHaveBeenCalledOnce())
  finish.abort()
  await vi.waitFor(() => expect(f.child.stdin.write).toHaveBeenCalledWith('{"type":"cancel"}\n'))
  f.push('{"type":"artifact"}\n{"type":"complete"}\n'); f.push('')
  await result
  expect(messages).toEqual(['artifact', 'complete'])
  expect(f.child.kill).not.toHaveBeenCalled()
})

it('bounds cancellation finalization to 120 seconds', async () => {
  vi.useFakeTimers()
  const f = processFixture(), finish = new AbortController()
  const result = runPDFWorker({}, {}, new AbortController().signal, async () => {}, finish.signal)
  const assertion = expect(result).rejects.toThrow(/保存已完成译文超时|Saving translations timed out/u)
  await vi.advanceTimersByTimeAsync(1)
  finish.abort()
  await vi.advanceTimersByTimeAsync(119_999)
  expect(f.child.kill).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await assertion
  expect(f.child.kill).toHaveBeenCalledOnce()
})

it('still bounds finalization when eight providers ignore request cancellation', async () => {
  vi.useFakeTimers()
  const f = processFixture(), finish = new AbortController()
  f.push(Array.from({ length: 8 }, (_, id) => JSON.stringify({ type: 'translate', id: String(id) })).join('\n') + '\n')
  const result = runPDFWorker({}, {}, new AbortController().signal, async () => new Promise(() => {}), finish.signal)
  const assertion = expect(result).rejects.toThrow(/保存已完成译文超时|Saving translations timed out/u)
  await vi.advanceTimersByTimeAsync(1)
  finish.abort()
  await vi.advanceTimersByTimeAsync(120_000)
  await assertion
  expect(f.child.kill).toHaveBeenCalledOnce()
})
