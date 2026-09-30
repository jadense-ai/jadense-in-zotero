/** 引擎目录迁移回归：只在目标完整可用后切换偏好，失败时保留源数据。 */
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'
import { changeEngineStorage, engineStorageRoot, ensureEngineStorageAvailable, retryEngineStorageCleanup, storageRecovery } from './engine-storage'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function fixture() {
  const dirs = new Set(['/','/profile']), files = new Map<string, Uint8Array>(), prefs = new Map<string, unknown>()
  const normalized = (value: string) => path.posix.normalize(value)
  const put = (name: string, value: string) => { const file = normalized(name); let parent = path.posix.dirname(file); while (!dirs.has(parent)) { dirs.add(parent); parent = path.posix.dirname(parent) } files.set(file, new TextEncoder().encode(value)) }
  const io = {
    exists: async (name: string) => dirs.has(normalized(name)) || files.has(normalized(name)),
    makeDirectory: async (name: string, options: { ignoreExisting: boolean }) => { const folder = normalized(name); if (dirs.has(folder) && !options.ignoreExisting) throw new Error('exists'); let parent = folder; while (!dirs.has(parent)) { dirs.add(parent); parent = path.posix.dirname(parent) } },
    getChildren: async (name: string) => { const folder = normalized(name); if (!dirs.has(folder)) throw new Error('missing'); return [...new Set([...dirs, ...files.keys()].filter(value => value !== folder && path.posix.dirname(value) === folder))] },
    stat: async (name: string) => { const value = normalized(name); if (dirs.has(value)) return { type: 'directory', size: 0 }; const bytes = files.get(value); if (!bytes) throw new Error('missing'); return { type: 'regular', size: bytes.length } },
    copy: vi.fn(async (from: string, to: string) => { const value = files.get(normalized(from)); if (!value) throw new Error('missing source'); files.set(normalized(to), value.slice()) }),
    move: async (from: string, to: string) => { const a = normalized(from), b = normalized(to); for (const entry of [...dirs]) if (entry === a || entry.startsWith(a + '/')) { dirs.delete(entry); dirs.add(b + entry.slice(a.length)) } for (const [entry, value] of [...files]) if (entry.startsWith(a + '/')) { files.delete(entry); files.set(b + entry.slice(a.length), value) } },
    remove: vi.fn(async (name: string) => { const root = normalized(name); for (const entry of [...dirs]) if (entry === root || entry.startsWith(root + '/')) dirs.delete(entry); for (const entry of [...files.keys()]) if (entry === root || entry.startsWith(root + '/')) files.delete(entry) }),
    read: async (name: string, options?: { offset: number; maxBytes: number }) => { const value = files.get(normalized(name)); if (!value) throw new Error('missing'); return options ? value.slice(options.offset, options.offset + options.maxBytes) : value.slice() },
    readUTF8: async (name: string) => { const value = files.get(normalized(name)); if (!value) throw new Error('missing'); return new TextDecoder().decode(value) },
    writeUTF8: async (name: string, value: string) => { put(name, value) },
  }
  vi.stubGlobal('IOUtils', io)
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: path.posix.join, normalize: normalized, parent: path.posix.dirname, filename: path.posix.basename })
  const host = { Prefs: { get: (name: string) => prefs.get(name), set: (name: string, value: unknown) => { prefs.set(name, value) }, clear: (name: string) => { prefs.delete(name) } } } as ZoteroLike
  return { dirs, files, prefs, io, host, put }
}

it('stores an uninstalled engine in a new parent without starting installation', async () => {
  const { host, dirs, files } = fixture()
  const result = await changeEngineStorage(host, 'ocr', '/other/new')
  expect(result).toMatchObject({ moved: true, root: '/other/new/jadense-ocr/v1' })
  expect(dirs.has(result.root)).toBe(true)
  expect(files.has('/other/new/jadense-ocr/v1/.jadense-storage-id')).toBe(true)
  await expect(ensureEngineStorageAvailable(host, 'ocr')).resolves.toBe(result.root)
})

it('copies PDF tasks and engine files, verifies and removes the old root', async () => {
  const { host, put, files, dirs } = fixture()
  put('/profile/jadense-pdf-translation/runtime/python.exe', 'engine')
  put('/profile/jadense-pdf-translation/tasks/abc/artifact.json', 'result')
  const phases: string[] = []
  const result = await changeEngineStorage(host, 'pdf', '/other', { progress: phase => phases.push(phase), validate: async root => { expect(root).toBe('/other/jadense-pdf-translation') } })
  expect(result.moved).toBe(true)
  expect(files.has('/other/jadense-pdf-translation/tasks/abc/artifact.json')).toBe(true)
  expect(dirs.has('/profile/jadense-pdf-translation')).toBe(false)
  expect(phases).toContain('verify')
  expect(engineStorageRoot(host, 'pdf')).toBe(result.root)
})

it('keeps staging paths short enough for a deep Windows profile and task folder', async () => {
  const { host, put, io, files } = fixture()
  const taskID = 'a'.repeat(64), parent = '/external/' + 'x'.repeat(140)
  put(`/profile/jadense-pdf-translation/tasks/${taskID}/artifact.json`, 'result')
  const makeDirectory = io.makeDirectory
  io.makeDirectory = async (name, options) => {
    if (name.length > 255) throw new Error('Windows path too long')
    return makeDirectory(name, options)
  }
  io.copy.mockImplementation(async (from, to) => {
    if (to.length > 255) throw new Error('Windows path too long')
    files.set(to, files.get(from)!.slice())
  })
  await expect(changeEngineStorage(host, 'pdf', parent)).resolves.toMatchObject({ moved: true })
  expect(files.has(`${parent}/jadense-pdf-translation/tasks/${taskID}/artifact.json`)).toBe(true)
})

it('leaves rebuildable Unix environment links for target repair while preserving results', async () => {
  const { host, put, files, io } = fixture()
  const link = '/profile/jadense-pdf-translation/.venv/bin/python'
  put('/profile/jadense-pdf-translation/.venv/bin/python3', 'interpreter')
  put('/profile/jadense-pdf-translation/tasks/abc/artifact.json', 'result')
  const children = io.getChildren
  io.getChildren = async name => name === path.posix.dirname(link) ? [...await children(name), link] : children(name)
  vi.stubGlobal('Ci', { nsIFile: {} })
  vi.stubGlobal('Cc', { '@mozilla.org/file/local;1': { createInstance: () => {
    let file = ''
    return { initWithPath: (name: string) => { file = name }, isSymlink: () => file === link }
  } } })
  const result = await changeEngineStorage(host, 'pdf', '/other', { validate: async root => {
    expect(files.has(`${root}/.venv/bin/python3`)).toBe(true)
    expect(files.has(`${root}/.venv/bin/python`)).toBe(false)
  } })
  expect(result.moved).toBe(true)
  expect(files.has('/other/jadense-pdf-translation/tasks/abc/artifact.json')).toBe(true)
})

it('keeps source and preference on validation failure', async () => {
  const { host, put, files } = fixture()
  put('/profile/jadense-ocr/v1/runtime/python.exe', 'python')
  await expect(changeEngineStorage(host, 'ocr', '/other', { validate: async () => { throw new Error('broken') } })).rejects.toThrow('broken')
  expect(engineStorageRoot(host, 'ocr')).toBe('/profile/jadense-ocr/v1')
  expect(files.has('/profile/jadense-ocr/v1/runtime/python.exe')).toBe(true)
  expect(files.has('/other/jadense-ocr/v1/runtime/python.exe')).toBe(false)
})

it('refuses occupied or overlapping storage without changing files', async () => {
  const { host, put, files } = fixture()
  put('/profile/jadense-pdf-translation/worker.py', 'source')
  await expect(changeEngineStorage(host, 'pdf', '/other', { busy: () => 'busy' })).rejects.toThrow('busy')
  await expect(changeEngineStorage(host, 'pdf', '/profile/jadense-pdf-translation/nested')).rejects.toThrow('重叠')
  put('/other/jadense-pdf-translation/user.txt', 'existing')
  await expect(changeEngineStorage(host, 'pdf', '/other')).rejects.toThrow('已有文件')
  expect(files.has('/profile/jadense-pdf-translation/worker.py')).toBe(true)
})

it('keeps the new location active and records failed source cleanup', async () => {
  const { host, put, io } = fixture()
  put('/profile/jadense-pdf-translation/worker.py', 'engine')
  const original = io.remove.getMockImplementation()!
  io.remove.mockImplementation(async (name: string) => { if (name === '/profile/jadense-pdf-translation') throw new Error('locked'); return original(name) })
  const result = await changeEngineStorage(host, 'pdf', '/other')
  expect(result.cleanupError).toBe('locked')
  expect(engineStorageRoot(host, 'pdf')).toBe('/other/jadense-pdf-translation')
  expect((await storageRecovery('pdf'))?.phase).toBe('commit')
  io.remove.mockImplementation(original)
  await expect(retryEngineStorageCleanup(host, 'pdf')).resolves.toBe(true)
  expect(await storageRecovery('pdf')).toBeUndefined()
})

it('moves partial downloads and can return to the default profile independently', async () => {
  const { host, put, files } = fixture()
  put('/profile/jadense-ocr/v1/uv-cache/partial.whl', 'downloaded bytes')
  put('/profile/jadense-pdf-translation/tasks/abc/output.pdf', 'old result')
  await changeEngineStorage(host, 'ocr', '/external/OCR')
  await changeEngineStorage(host, 'pdf', '/external/PDF')
  expect(files.has('/external/OCR/jadense-ocr/v1/uv-cache/partial.whl')).toBe(true)
  expect(files.has('/external/PDF/jadense-pdf-translation/tasks/abc/output.pdf')).toBe(true)
  await changeEngineStorage(host, 'ocr', '')
  expect(engineStorageRoot(host, 'ocr')).toBe('/profile/jadense-ocr/v1')
  expect(files.has('/profile/jadense-ocr/v1/uv-cache/partial.whl')).toBe(true)
  expect(engineStorageRoot(host, 'pdf')).toBe('/external/PDF/jadense-pdf-translation')
})

it('treats differently cased Unix directories as distinct locations', async () => {
  const { host, put } = fixture()
  put('/profile/jadense-pdf-translation/tasks/one.json', 'result')
  await changeEngineStorage(host, 'pdf', '/Storage')
  const result = await changeEngineStorage(host, 'pdf', '/storage')
  expect(result.moved).toBe(true)
  expect(result.root).toBe('/storage/jadense-pdf-translation')
})

it('reports a disconnected configured drive without creating a profile fallback', async () => {
  const { host, files, dirs } = fixture()
  await changeEngineStorage(host, 'ocr', '/external')
  files.delete('/external/jadense-ocr/v1/.jadense-storage-id')
  await expect(ensureEngineStorageAvailable(host, 'ocr')).rejects.toThrow('不可用')
  expect(engineStorageRoot(host, 'ocr')).toBe('/external/jadense-ocr/v1')
  expect(dirs.has('/profile/jadense-ocr/v1')).toBe(false)
})

it('retains source and lets a restarted settings view clean an interrupted copy', async () => {
  const { host, put, files } = fixture()
  put('/profile/jadense-pdf-translation/tasks/one.pdf', 'result')
  const controller = new AbortController()
  await expect(changeEngineStorage(host, 'pdf', '/external', {
    signal: controller.signal, progress: phase => { if (phase === 'copy') controller.abort() },
  })).rejects.toMatchObject({ name: 'AbortError' })
  expect(engineStorageRoot(host, 'pdf')).toBe('/profile/jadense-pdf-translation')
  expect(files.has('/profile/jadense-pdf-translation/tasks/one.pdf')).toBe(true)
  expect((await storageRecovery('pdf'))?.phase).toBe('copy')
  await expect(retryEngineStorageCleanup(host, 'pdf')).resolves.toBe(true)
  expect(await storageRecovery('pdf')).toBeUndefined()
  expect(files.has('/external/jadense-pdf-translation/tasks/one.pdf')).toBe(false)
})

it('rejects changed copy bytes before committing', async () => {
  const { host, put, files, io } = fixture()
  put('/profile/jadense-pdf-translation/tasks/one.pdf', 'result')
  io.copy.mockImplementation(async (_from: string, to: string) => { files.set(to, new TextEncoder().encode('broken')) })
  await expect(changeEngineStorage(host, 'pdf', '/external')).rejects.toThrow('校验失败')
  expect(engineStorageRoot(host, 'pdf')).toBe('/profile/jadense-pdf-translation')
  expect(files.has('/profile/jadense-pdf-translation/tasks/one.pdf')).toBe(true)
})

it('returns promptly on a stuck copy and fences new work until the disk call settles', async () => {
  const { host, put, io, files } = fixture()
  put('/profile/jadense-pdf-translation/tasks/one.pdf', 'result')
  let finish!: () => void
  io.copy.mockImplementation(async (from: string, to: string) => {
    await new Promise<void>(resolve => { finish = resolve })
    files.set(to, files.get(from)!.slice())
  })
  const controller = new AbortController()
  const moving = changeEngineStorage(host, 'pdf', '/external', { signal: controller.signal })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  controller.abort()
  await expect(moving).rejects.toMatchObject({ name: 'AbortError' })
  await expect(changeEngineStorage(host, 'pdf', '/another')).rejects.toThrow('磁盘操作仍未结束')
  expect(engineStorageRoot(host, 'pdf')).toBe('/profile/jadense-pdf-translation')
  finish()
  await vi.waitFor(() => expect((host as ZoteroLike & { __jadenseStorageUnsettled?: Set<string> }).__jadenseStorageUnsettled?.size).toBe(0))
  await expect(retryEngineStorageCleanup(host, 'pdf')).resolves.toBe(true)
})

it('retains the original location when the destination is not writable', async () => {
  const { host, put, io, files } = fixture()
  put('/profile/jadense-pdf-translation/tasks/one.pdf', 'result')
  const original = io.makeDirectory
  io.makeDirectory = async (name, options) => { if (name === '/external') throw new Error('access denied'); return original(name, options) }
  await expect(changeEngineStorage(host, 'pdf', '/external')).rejects.toThrow('access denied')
  expect(engineStorageRoot(host, 'pdf')).toBe('/profile/jadense-pdf-translation')
  expect(files.has('/profile/jadense-pdf-translation/tasks/one.pdf')).toBe(true)
})

it('refuses cleanup while that engine is occupied', async () => {
  const { host, put } = fixture()
  put('/profile/jadense-pdf-translation/tasks/one.pdf', 'result')
  const controller = new AbortController()
  await expect(changeEngineStorage(host, 'pdf', '/external', { signal: controller.signal, progress: phase => { if (phase === 'copy') controller.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
  await expect(retryEngineStorageCleanup(host, 'pdf', () => 'still reading')).rejects.toThrow('still reading')
  expect(await storageRecovery('pdf')).toBeDefined()
})

it('bounds a stuck cleanup call and keeps the engine fenced', async () => {
  const { host, put, io } = fixture()
  put('/profile/jadense-pdf-translation/tasks/one.pdf', 'result')
  const controller = new AbortController()
  await expect(changeEngineStorage(host, 'pdf', '/external', { signal: controller.signal, progress: phase => { if (phase === 'copy') controller.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
  let finish!: () => void
  const stage = (await storageRecovery('pdf'))!.stage
  const original = io.remove.getMockImplementation()!
  io.remove.mockImplementation(async (name: string) => {
    if (name === stage) await new Promise<void>(resolve => { finish = resolve })
    return original(name)
  })
  vi.useFakeTimers()
  const cleanup = retryEngineStorageCleanup(host, 'pdf')
  const assertion = expect(cleanup).rejects.toThrow('清理磁盘操作超时')
  await vi.advanceTimersByTimeAsync(120001)
  await assertion
  expect(typeof finish).toBe('function')
  await expect(changeEngineStorage(host, 'pdf', '/another')).rejects.toThrow('磁盘操作仍未结束')
  finish()
  await vi.advanceTimersByTimeAsync(1)
})
