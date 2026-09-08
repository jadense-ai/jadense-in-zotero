/** 验证本地图片附件回读、文件边界、失败隔离和删除后的回收。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { pruneChatImages, readChatImage, saveChatImage } from "./chat-images"
import { appendLocalChatMessage, createLocalChatSession, readLocalChatState } from "@/chat/local-chat-store"

afterEach(() => vi.unstubAllGlobals())

function host() {
  const files = new Map<string, string>()
  const io = {
    makeDirectory: vi.fn(async () => undefined),
    writeUTF8: vi.fn(async (path: string, value: string) => { files.set(path, value) }),
    readUTF8: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error("missing"); return files.get(path)! }),
    getChildren: vi.fn(async () => [...files.keys()]),
    remove: vi.fn(async (path: string) => { files.delete(path) }),
  }
  vi.stubGlobal("IOUtils", io)
  vi.stubGlobal("PathUtils", { profileDir: "/fixture", join: (...parts: string[]) => parts.join("/"), filename: (path: string) => path.split("/").at(-1) })
  return { files, io }
}

const image = { dataUrl: "data:image/png;base64,aW1hZ2U=", mimeType: "image/png", name: "fixture.png" } as const

describe("local chat images", () => {
  it.each(["upload", "figure"] as const)("round-trips %s attachments through real message serialization without embedding bytes", async origin => {
    const { files } = host()
    const stored = await saveChatImage(image, origin)
    expect(stored.saved).toBe(true)
    const values = new Map<string, unknown>()
    const prefs = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) }, clear: (key: string) => { values.delete(key) } }
    const session = createLocalChatSession(prefs)
    const extraImage = { ...stored.attachment, dataUrl: image.dataUrl, path: "/unrelated", futureField: true }
    appendLocalChatMessage(prefs, session.id, { id: "message", role: "user", text: "看图", createdAt: new Date().toISOString(), image: extraImage })
    const restored = readLocalChatState(prefs).sessions[0].messages[0].image!
    expect(restored).toEqual(stored.attachment)
    expect(JSON.stringify([...values.values()])).not.toContain("data:image")
    expect(await readChatImage(restored)).toEqual(image)
    expect(extraImage.futureField).toBe(true)
    await pruneChatImages([restored])
    expect(files.size).toBe(1)
    await pruneChatImages([])
    expect(files.size).toBe(0)
    expect(await readChatImage(restored)).toBeNull()
  })

  it("contains storage failure and refuses path capabilities without blocking readable text", async () => {
    const { io, files } = host()
    io.writeUTF8.mockRejectedValueOnce(new Error("disk unavailable"))
    const stored = await saveChatImage(image, "upload")
    expect(stored.saved).toBe(false)
    expect(await readChatImage(stored.attachment)).toEqual(image)
    expect(await readChatImage({ id: "../../other", name: "bad", origin: "upload" })).toBeNull()
    expect(io.readUTF8).not.toHaveBeenCalled()
    files.set("/fixture/jadense-chat-images/unrelated.txt", "leave alone")
    await pruneChatImages([])
    expect(files.size).toBe(1)
    expect(await readChatImage(stored.attachment)).toBeNull()
  })
})
