/** 文件存储真实序列化、安全路径和可选失败回归；解析 UI 由浏览器合成文件验收。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { appendLocalChatMessage, createLocalChatSession, readLocalChatState } from '@/chat/local-chat-store'
import { MAX_CHAT_FILE_TEXT, normalizeLocalChatFile } from '@/chat/file-input'
import { pruneChatFiles, readChatFile, readChatUpload, saveChatFile, wordXml } from './chat-files'

afterEach(() => vi.unstubAllGlobals())
function storage() {
  const files = new Map<string, string>()
  const io = { makeDirectory: vi.fn(async () => {}), writeUTF8: vi.fn(async (path: string, text: string) => { files.set(path, text) }), readUTF8: vi.fn(async (path: string) => { if (!files.has(path)) throw Error('missing'); return files.get(path)! }), getChildren: vi.fn(async () => [...files.keys()]), remove: vi.fn(async (path: string) => { files.delete(path) }) }
  vi.stubGlobal('IOUtils', io)
  vi.stubGlobal('PathUtils', { profileDir: '/fixture', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1) })
  return { files, io }
}
const file = { name: '研究.md', mimeType: 'text/markdown', size: 20, text: 'Synthetic evidence' }
describe('chat files', () => {
  it('extracts only Word body XML and rejects excessive decompressed contents', () => {
    const body = '<w:p>合成 Word</w:p>'
    const archive = zipSync({ 'word/document.xml': strToU8(body), 'word/media/ignored.bin': new Uint8Array(100) })
    expect(wordXml(archive.buffer as ArrayBuffer)).toBe(body)
    const large = zipSync({ 'word/document.xml': new Uint8Array(21 * 1024 * 1024) })
    expect(() => wordXml(large.buffer as ArrayBuffer)).toThrow()
    expect(() => wordXml(zipSync({ 'other.xml': strToU8('unrelated') }).buffer as ArrayBuffer)).toThrow()
  })
  it('round-trips extracted text without copying contents or arbitrary paths into Preferences', async () => {
    const { files } = storage()
    const saved = await saveChatFile({ ...file, futureField: true } as typeof file)
    const values = new Map<string, unknown>()
    const prefs = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) }, clear: (key: string) => { values.delete(key) } }
    const session = createLocalChatSession(prefs)
    appendLocalChatMessage(prefs, session.id, { id: 'm', role: 'user', text: 'Summarize', createdAt: new Date().toISOString(), file: { ...saved.attachment, text: file.text, path: '/private' } as typeof saved.attachment })
    const restored = readLocalChatState(prefs).sessions[0].messages[0].file!
    expect(restored).toEqual(saved.attachment)
    expect(JSON.stringify([...values])).not.toContain(file.text)
    expect(JSON.stringify([...values])).not.toContain('/private')
    expect(await readChatFile(restored)).toMatchObject(file)
    await pruneChatFiles([restored]); expect(files.size).toBe(1)
    await pruneChatFiles([]); expect(files.size).toBe(0)
    expect(await readChatFile(restored)).toBeNull()
  })
  it('contains storage failures, bounds contents, and never reads or deletes arbitrary paths', async () => {
    const { files, io } = storage()
    io.writeUTF8.mockRejectedValueOnce(Error('disk unavailable'))
    const saved = await saveChatFile({ ...file, text: 'x'.repeat(MAX_CHAT_FILE_TEXT + 1) })
    expect(saved.saved).toBe(false)
    expect((await readChatFile(saved.attachment))?.text).toHaveLength(MAX_CHAT_FILE_TEXT)
    expect(normalizeLocalChatFile({ id: '../../private' })).toBeUndefined()
    expect(await readChatFile({ ...saved.attachment, id: '../../private' })).toBeNull()
    expect(io.readUTF8).not.toHaveBeenCalled()
    files.set('/fixture/jadense-chat-files/unrelated.json', 'keep')
    await pruneChatFiles([])
    expect(files.size).toBe(1)
    expect(await readChatFile(saved.attachment)).toBeNull()
  })
  it('reads BOM text, bounds long text with a visible warning, and rejects oversize before reading', async () => {
    class Reader {
      result: ArrayBuffer | null = null
      onload?: () => void
      readAsArrayBuffer(file: File) { void file.arrayBuffer().then(value => { this.result = value; this.onload?.() }) }
    }
    const doc = { defaultView: { FileReader: Reader } } as unknown as Document
    const result = await readChatUpload(new File([new Uint8Array([255, 254, 65, 0, 66, 0])], 'notes.txt'), doc)
    expect(result).toMatchObject({ text: 'AB', name: 'notes.txt' })
    const long = await readChatUpload(new File(['x'.repeat(MAX_CHAT_FILE_TEXT + 10)], 'notes.md'), doc)
    expect(long).toMatchObject({ text: 'x'.repeat(MAX_CHAT_FILE_TEXT), warning: expect.stringContaining('60,000') })
    await expect(readChatUpload({ size: 21 * 1024 * 1024 } as File, doc)).rejects.toThrow('20 MB')
    await expect(readChatUpload(new File(['old'], 'notes.doc'), doc)).rejects.toThrow('.docx')
  })
})
