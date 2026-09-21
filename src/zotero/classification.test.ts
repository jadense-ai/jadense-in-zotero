/** 合成宿主覆盖协议最小投影、目录身份与分类写入/撤销，不读取真实密钥或文献。 */
import { describe, expect, it, vi } from 'vitest'
import { applyClassification, canUndoClassification, loadClassificationFolders, loadClassificationItems, readTypesafeKey, recommendClassification, selectedClassificationIDs, testTypesafeKey, TYPESAFE_ENDPOINT, undoClassification, type ClassificationRow } from './classification'
import { initializeUiLocale } from './ui-preferences'

function fixture() {
  initializeUiLocale({ locale: 'zh-CN' })
  let memberships = [1, 9], persisted = [...memberships]
  const item = {
    id: 5, key: 'PAPER', libraryID: 1, deleted: false,
    isRegularItem: () => true, isEditable: vi.fn(() => true),
    getField: (field: string) => field === 'title' ? 'Aerosol observations' : 'Abstract',
    getTags: () => [{ tag: 'AERONET' }], getCollections: () => [...memberships],
    setCollections: vi.fn((ids: number[]) => { memberships = [...ids] }),
    saveTx: vi.fn(async () => { persisted = [...memberships] }),
    reload: vi.fn(async () => { memberships = [...persisted] }),
  }
  const nativeFolders = [
    { id: 1, key: 'ROOT', libraryID: 1, name: 'Aerosol' },
    { id: 2, key: 'CHILD', libraryID: 1, parentID: 1, name: '反演 / AERONET' },
    { id: 9, key: 'OUTSIDE', libraryID: 1, name: 'Reading list' },
    { id: 10, key: 'OTHER', libraryID: 2, name: 'Other library' },
  ]
  const host = {
    Items: { get: vi.fn(() => item) },
    Collections: { getByLibrary: vi.fn(() => nativeFolders) },
    getActiveZoteroPane: () => ({ getSelectedItems: () => [item, { id: 99, isRegularItem: () => false }] }),
  }
  const prepare = async () => {
    const [snapshot] = await loadClassificationItems(host, [5])
    const folders = (await loadClassificationFolders(host, 1)).filter(folder => folder.id !== 9)
    const row: ClassificationRow = { item: snapshot, target: folders.find(folder => folder.id === 2)!, confidence: .7, remove: [1], selected: true }
    return { row, folders }
  }
  return { host, item, nativeFolders, prepare }
}
const response = (choice = 'collection_2', confidence: unknown = .7) => new Response(JSON.stringify({ answers: { classification: { type: 'choice', choice, confidence, future: true } }, extra: true }))

describe('Jev classification', () => {
  it('contains optional preference read failures without breaking the workbench', () => {
    expect(readTypesafeKey({ Prefs: { get: () => { throw new Error('unavailable') }, set: () => {}, clear: () => {} } })).toBe('')
  })
  it('projects only selected papers and preserves actual folder segments including slashes', async () => {
    const { host } = fixture()
    expect(selectedClassificationIDs(host)).toEqual([5])
    const folders = await loadClassificationFolders(host, 1)
    expect(folders.find(folder => folder.id === 2)?.path).toEqual(['Aerosol', '反演 / AERONET'])
    expect(folders.some(folder => folder.libraryID === 2)).toBe(false)
    expect(host.Collections.getByLibrary).toHaveBeenCalledWith(1, true)
  })
  it('sends official Choice protocol with minimal metadata, accepts additive fields and unknown confidence', async () => {
    const { prepare } = fixture(), { row, folders } = await prepare()
    const fetcher = vi.fn(async () => response('collection_2', 'future-confidence'))
    const result = await recommendClassification(row.item, folders, ' synthetic ', undefined, fetcher)
    expect(result).toMatchObject({ target: { id: 2 }, confidence: null })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(TYPESAFE_ENDPOINT)
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer synthetic' } })
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('jev-latest')
    expect(body.state).toEqual({ title: 'Aerosol observations', abstract: 'Abstract', tags: ['AERONET'] })
    expect(body.questions.classification.criteria.collection_2).toEqual({ folderHierarchy: ['Aerosol', '反演 / AERONET'] })
    expect(body.questions.classification.criteria.none).toBeTruthy()
  })
  it('handles none, rejects invented candidate IDs, redacts HTTP and transport errors, and tests only fixed sample', async () => {
    const { prepare } = fixture(), { row, folders } = await prepare()
    await expect(recommendClassification(row.item, folders, 'synthetic', undefined, async () => response('none'))).resolves.toMatchObject({ target: null })
    await expect(recommendClassification(row.item, folders, 'synthetic', undefined, async () => response('collection_999'))).rejects.toThrow('有效')
    await expect(testTypesafeKey('synthetic', undefined, async () => new Response('SECRET RESPONSE', { status: 401 }))).rejects.toThrow('HTTP 401')
    await expect(testTypesafeKey('synthetic', undefined, async () => { throw new Error('SECRET KEY') })).rejects.not.toThrow('SECRET')
    const fetcher = vi.fn(async () => response('research'))
    await testTypesafeKey('synthetic', undefined, fetcher)
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)).state).toEqual({ title: 'Research on machine learning' })
    await expect(testTypesafeKey('', undefined, fetcher)).rejects.toThrow('密钥')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('propagates cancellation and bounds a stalled request', async () => {
    fixture(); vi.useFakeTimers()
    try {
      const fetcher: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      const pending = testTypesafeKey('synthetic', undefined, fetcher)
      const check = expect(pending).rejects.toThrow('超时')
      await vi.advanceTimersByTimeAsync(30_000); await check
      const abort = new AbortController(), canceled = testTypesafeKey('synthetic', abort.signal, fetcher)
      const canceledCheck = expect(canceled).rejects.toThrow('已停止')
      abort.abort(); await canceledCheck
    } finally { vi.useRealTimers() }
  })
  it('reduces candidate sets above the provider option limit without dropping folders', async () => {
    const { prepare } = fixture(), { row } = await prepare()
    const folders = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, key: `C${i}`, libraryID: 1, path: [`Folder ${i}`] }))
    const counts: number[] = []
    const result = await recommendClassification(row.item, folders, 'synthetic', undefined, async (_url, init) => {
      const options = Object.keys(JSON.parse(String(init?.body)).questions.classification.criteria)
      counts.push(options.length)
      return response(options[0])
    })
    expect(counts).toEqual([255, 47, 3]); expect(result.target?.id).toBe(1)
  })
  it('writes only checked matches, preserves outside memberships, and supports undo', async () => {
    const { host, item, prepare } = fixture(), { row, folders } = await prepare()
    expect(await applyClassification(host, [{ ...row, selected: false }, { ...row, target: null }, row], folders)).toEqual({ applied: 1, failed: 0 })
    expect(item.getCollections()).toEqual([9, 2]); expect(canUndoClassification(host, 1)).toBe(true)
    expect(await applyClassification(host, [row], folders)).toEqual({ applied: 0, failed: 0 })
    expect(await undoClassification(host, 1)).toEqual({ restored: 1, failed: 0 })
    expect(item.getCollections()).toEqual([1, 9]); expect(canUndoClassification(host, 1)).toBe(false)
  })
  it.each(['permission', 'membership', 'identity', 'deleted', 'folder', 'cross-library', 'outside-removal'])('contains stale/invalid %s writes', async reason => {
    const { host, item, nativeFolders, prepare } = fixture(), { row, folders } = await prepare()
    if (reason === 'permission') item.isEditable.mockReturnValue(false)
    if (reason === 'membership') item.setCollections([9])
    if (reason === 'identity') item.key = 'REPLACED'
    if (reason === 'deleted') item.deleted = true
    if (reason === 'folder') nativeFolders[1].name = 'Renamed'
    if (reason === 'cross-library') row.target!.libraryID = 2
    if (reason === 'outside-removal') row.remove = [9]
    expect(await applyClassification(host, [row], folders)).toEqual({ applied: 0, failed: 1 })
    expect(item.saveTx).not.toHaveBeenCalled(); expect(canUndoClassification(host, 1)).toBe(false)
  })
  it('reloads failed native saves and never records an undo for an unsaved write', async () => {
    const { host, item, prepare } = fixture(), { row, folders } = await prepare()
    item.saveTx.mockRejectedValueOnce(new Error('native failure'))
    expect(await applyClassification(host, [row], folders)).toEqual({ applied: 0, failed: 1 })
    expect(item.reload).toHaveBeenCalled(); expect(item.getCollections()).toEqual([1, 9]); expect(canUndoClassification(host, 1)).toBe(false)
  })
  it('does not overwrite changes made after applying when undoing', async () => {
    const { host, item, prepare } = fixture(), { row, folders } = await prepare()
    await applyClassification(host, [row], folders)
    item.setCollections([9, 2, 77])
    expect(await undoClassification(host, 1)).toEqual({ restored: 0, failed: 1 })
    expect(item.getCollections()).toEqual([9, 2, 77])
  })
})
