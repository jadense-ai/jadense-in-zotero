/** 更新弹窗布局回归：真实组件 + Reader margin 重置，断言视口居中、窄窗及关闭操作。 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
/* global window, document */

// 浏览器驱动由调用方提供，避免为单个布局检查新增项目依赖。
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/zotero/update-notification.ts', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'UpdateNotification' })
const readerCSS = process.env.READER_CSS ? await readFile(process.env.READER_CSS, 'utf8') : '* { padding: 0; margin: 0; }'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  for (const host of ['manager', 'reader']) {
    for (const theme of ['light', 'dark']) {
      for (const viewport of [{ width: 1000, height: 700 }, { width: 360, height: 420 }]) {
        await page.setViewportSize(viewport)
        await page.setContent(`<html data-color-scheme="${theme}"><head><style>${host === 'reader' ? readerCSS : ''}</style></head><body></body></html>`)
        await page.addScriptTag({ content: bundle.outputFiles[0].text })
        await page.evaluate(theme => {
          window.UpdateNotification.showUpdateDialog(document, { Prefs: { get: key => key.endsWith('.theme') ? theme : undefined }, launchURL: () => {} }, { current: '0.4.10', latest: '0.5.0', state: 'available', url: 'https://example.invalid' })
        }, theme)
        const bounds = await page.locator('#jadense-update-dialog').boundingBox()
        const delta = { x: bounds.x + bounds.width / 2 - viewport.width / 2, y: bounds.y + bounds.height / 2 - viewport.height / 2 }
        console.log(JSON.stringify({ host, theme, viewport, bounds, delta }))
        assert(Math.abs(delta.x) <= 1 && Math.abs(delta.y) <= 1, `${host} dialog is not centered`)
        assert(bounds.x >= 15 && bounds.y >= 15 && bounds.width <= viewport.width - 30 && bounds.height <= viewport.height - 30, 'Dialog exceeds viewport')
        if (process.env.UPDATE_SCREENSHOT && host === 'reader' && theme === 'light' && viewport.width === 1000) await page.screenshot({ path: process.env.UPDATE_SCREENSHOT })
        await page.keyboard.press('Escape')
        await page.locator('#jadense-update-dialog').waitFor({ state: 'detached' })
      }
    }
  }
} finally { await browser.close() }
