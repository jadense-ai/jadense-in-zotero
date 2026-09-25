/** 在缺少 Web API 的后台 realm 执行真实初始化与 OCR 检查，避免 Node 全局掩盖宿主缺失。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { build, transform } from 'esbuild'
import { expect, it, vi } from 'vitest'

it('prepares OCR resources after bootstrap supplies missing Web APIs', async () => {
  const bootstrap = readFileSync(new URL('../bootstrap.ts', import.meta.url), 'utf8')
  const initialization = bootstrap.slice(bootstrap.indexOf('  const windowRuntime ='), bootstrap.indexOf('  const collector ='))
  expect(initialization).toContain('backgroundRuntime')
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, text: async () => 'bundled resource' }))
  const writeUTF8 = vi.fn(async () => {})
  const host = { getMainWindow: () => ({ fetch }), Prefs: { get: () => undefined, set: () => {} } }
  const context = createContext({
    host, mainWindow: () => ({ AbortController, AbortSignal, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval }),
    IOUtils: { makeDirectory: async () => {}, exists: async () => false, writeUTF8, readUTF8: async () => JSON.stringify({ revision: 5, versions: { docling: '2.126.0', rapidocr: '3.9.2' } }) },
    PathUtils: { profileDir: '/profile', join: (...parts: string[]) => parts.join('/') },
  })
  expect(runInContext('typeof AbortSignal', context)).toBe('undefined')
  runInContext((await transform(initialization, { loader: 'ts' })).code, context)
  expect(runInContext('typeof setInterval + "/" + typeof clearInterval', context)).toBe('function/function')
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./local-ocr.ts', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'ocr', platform: 'browser' })
  runInContext(bundle.outputFiles[0].text, context)
  await expect(runInContext('ocr.checkLocalOCR(host)', context)).resolves.toMatchObject({ ready: true, modelsReady: true })
  expect(fetch).toHaveBeenCalledTimes(8)
  expect(writeUTF8).toHaveBeenCalledTimes(8)
  expect(fetch.mock.calls.every(call => call[1].signal instanceof AbortSignal)).toBe(true)
})
