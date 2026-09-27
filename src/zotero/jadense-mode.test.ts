/** 模式状态机与真实派发边界回归；只使用合成连接与响应。 */
import { describe, expect, it, vi } from 'vitest'
import { modeEnabled, MODE_PREF, OCR_ENGINE_PREF, saveJadenseMode, saveOCREngine } from './jadense-mode-state'
import { ocrEngine } from './cloud-ocr-config'
import { JadenseApiClient } from '@/jadense/api'
import { recognizeJadenseImage, type JadenseOCRSnapshot } from './jadense-ocr'
import { recommendClassification } from './classification'
import { jadenseClassificationRequest } from './jadense-ai'

function host() {
  const values = new Map<string, unknown>(), callbacks = new Map<string, () => void>()
  return { values, Prefs: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value); callbacks.get(key)?.() }, registerObserver: (key: string, callback: () => void) => { callbacks.set(key, callback); return key }, unregisterObserver: (key: unknown) => { callbacks.delete(String(key)) } } }
}
describe('Jadense mode transitions', () => {
  it.each([true, false, null])('auto-selects only a confirmed unready local engine: %s', ready => {
    const h = host(); expect(modeEnabled(h)).toBe(false)
    saveJadenseMode(h, true, ready)
    expect(ocrEngine(h)).toBe(ready === false ? 'jadense' : 'local')
    saveJadenseMode(h, false); expect(ocrEngine(h)).toBe('local')
  })
  it('preserves cloud and later manual choices across toggles and reconstructed host', () => {
    const h = host(); saveOCREngine(h, 'glm'); saveJadenseMode(h, true, false)
    expect(ocrEngine(h)).toBe('glm'); saveOCREngine(h, 'jadense'); saveJadenseMode(h, false)
    expect(ocrEngine(h)).toBe('glm'); saveJadenseMode(h, true, false); saveOCREngine(h, 'local')
    saveJadenseMode(h, true, false); expect(ocrEngine(h)).toBe('local')
    expect(modeEnabled({ Prefs: h.Prefs })).toBe(true)
  })
  it('keeps automatically selected cloud after readiness changes and restores last local', () => {
    const h = host(); saveJadenseMode(h, true, false); saveJadenseMode(h, true, true)
    expect(ocrEngine(h)).toBe('jadense'); saveJadenseMode(h, false); expect(ocrEngine(h)).toBe('local')
    h.values.set(OCR_ENGINE_PREF, 'jadense'); h.values.set(MODE_PREF, false)
    expect(ocrEngine(h)).toBe('local')
  })
})
it('queries the original operation after a conflict without replaying the paid POST', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 'SPECIALIZED_OPERATION_ALREADY_SUBMITTED', message: 'Already submitted' }), { status: 409 }))
  const client = new JadenseApiClient({ baseUrl: 'https://example.invalid', token: 'synthetic', fetchImpl })
  await expect(client.zoteroAiRequest('decision', { operationId: 'one', state: 'fixture' })).rejects.toMatchObject({ status: 409 })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://example.invalid/api/extension/zotero/ai/decision')
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic')
  expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
  expect(init.method).toBe('POST')
  const [statusUrl, statusInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
  expect(statusUrl).toBe('https://example.invalid/api/extension/zotero/ai/operations?capability=decision&operationId=one')
  expect(statusInit).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' })
  expect(statusInit.body).toBeUndefined()
  expect(new Headers(statusInit.headers).get('authorization')).toBe('Bearer synthetic')
})
it('saves OCR operation identity before dispatch and preserves coordinates only when real', async () => {
  const events: string[] = []
  const request = vi.fn(async () => { events.push('dispatch'); return { text: 'text', blocks: [{ text: 'first' }, { text: 'second', box: { coordinates: [1, 2, 3, 4], system: 'normalized-1000' } }], warnings: [], billingStatus: 'settled' } })
  const config = { client: { zoteroAiRequest: request }, engine: 'jadense', config: { revision: 1 } } as unknown as JadenseOCRSnapshot
  const io = { fetch, signal: new AbortController().signal, progress: vi.fn(), saveBatch: async () => { events.push('saved') } }
  const page = await recognizeJadenseImage(config, 'data:image/png;base64,AA==', io)
  expect(events).toEqual(['saved', 'dispatch']); expect(page.blocks[0].bbox).toBeUndefined(); expect(page.blocks[1].bbox).toEqual([1, 2, 3, 4])
  await recognizeJadenseImage(config, 'data:image/png;base64,AA==', { ...io, batchID: 'stable' })
  expect(request.mock.calls[1]).toEqual(['ocr', { operationId: 'stable', image: 'data:image/png;base64,AA==', bindingRevision: 1 }, io.signal])
})
it('Jev gateway classification needs no BYOK key and still validates candidates locally', async () => {
  const item = { id: 1, key: 'one', libraryID: 1, title: 'paper', abstract: '', tags: [], collections: [] }
  const folders = [{ id: 2, key: 'two', libraryID: 1, path: ['Research'] }]
  const request = vi.fn(async () => ({ choice: 'collection_2', confidence: .8 }))
  const result = await recommendClassification(item, folders, '', undefined, undefined, request)
  expect(result.target).toEqual(folders[0]); expect(request).toHaveBeenCalledOnce()
})
it('cancels a hanging host request without replay and never dispatches a pre-canceled request', async () => {
  const fetchImpl = vi.fn(() => new Promise<Response>(() => {})), controller = new AbortController()
  const client = new JadenseApiClient({ baseUrl: 'https://example.invalid', token: 'synthetic', fetchImpl })
  const pending = client.zoteroAiRequest('ocr', { operationId: 'one' }, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow(/停止|Stopped/)
  await expect(client.zoteroAiRequest('ocr', { operationId: 'two' }, controller.signal)).rejects.toBeTruthy()
  expect(fetchImpl).toHaveBeenCalledOnce()
})
it('reuses completed Jev results and stable identities after loss of optional disk cache', async () => {
  const h = host(); h.values.set('extensions.jadenseInZotero.token', 'synthetic')
  let revision = 1
  const catalog = vi.spyOn(JadenseApiClient.prototype, 'getZoteroAiCapabilities').mockImplementation(async () => ({ userId: 'owner', decision: { authorized: true, available: true, enabled: true, modelId: 'jev', revision, displayName: 'Jev', reason: null }, ocr: {} as never }))
  const dispatch = vi.spyOn(JadenseApiClient.prototype, 'zoteroAiRequest').mockResolvedValue({ answers: { classification: { choice: 'one', confidence: .8 } } })
  try {
    const criteria = { one: 'Folder', none: 'None' }
    await (await jadenseClassificationRequest(h))('paper', criteria)
    await (await jadenseClassificationRequest(h))('paper', criteria)
    expect(dispatch).toHaveBeenCalledOnce()
    await (await jadenseClassificationRequest({ Prefs: h.Prefs }))('paper', criteria)
    expect(dispatch.mock.calls[1][1]).toEqual(dispatch.mock.calls[0][1])
    revision++
    await (await jadenseClassificationRequest(h))('paper', criteria)
    expect(dispatch.mock.calls[2][1]).not.toEqual(dispatch.mock.calls[0][1])
  } finally { catalog.mockRestore(); dispatch.mockRestore() }
})
