/** 工作台顶栏的唯一模式入口；临时反馈限时清理，连接完成前保持 off。 */
import { JADENSE_BRAND_PARTS } from './jadense-brand'
import type { ZoteroLike } from './runtime'
import { jadenseAiClient } from './jadense-ai'
import { localOCRReadiness } from './local-ocr'
import { modeEnabled, MODE_CONSENT_PREF, observeJadenseMode, saveJadenseMode } from './jadense-mode-state'
import { uiText } from './ui-preferences'
export function wireJadenseMode(host: ZoteroLike, root: HTMLElement, openConnection: () => void = () => {}, options: { compact?: boolean } = {}) {
  const doc = root.ownerDocument, ns = 'http://www.w3.org/1999/xhtml'
  const wrap = doc.createElementNS(ns, 'span') as HTMLSpanElement; wrap.className = options.compact ? 'jdx-mode-control jdx-mode-compact' : 'jdx-mode-control'
  const button = doc.createElementNS(ns, 'button') as HTMLButtonElement
  button.type = 'button'; button.className = 'jdx-mode-switch'; button.setAttribute('role', 'switch')
  button.setAttribute('aria-label', uiText('攻玉模式', 'Jadense mode'))
  const track = doc.createElementNS(ns, 'span'); track.className = 'jdx-mode-track'; track.setAttribute('aria-hidden', 'true')
  const thumb = doc.createElementNS(ns, 'span'); thumb.className = 'jdx-mode-thumb'
  const svgNS = 'http://www.w3.org/2000/svg', logo = doc.createElementNS(svgNS, 'svg')
  logo.setAttribute('class', 'jdx-mode-logo'); logo.setAttribute('viewBox', '0 0 575 552'); logo.setAttribute('focusable', 'false')
  for (const part of JADENSE_BRAND_PARTS) { const path = doc.createElementNS(svgNS, 'path'); path.setAttribute('d', part.path); logo.append(path) }
  thumb.append(logo); track.append(thumb)
  const label = doc.createElementNS(ns, 'span'); label.className = 'jdx-mode-label'; label.textContent = uiText('攻玉模式', 'Jadense mode'); button.append(track, label)
  const status = doc.createElementNS(ns, 'span') as HTMLSpanElement; status.setAttribute('role', 'status'); status.className = 'jdx-mode-status'
  const style = doc.createElementNS(ns, 'style'); style.textContent = `
.jdx-mode-control{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.jdx-mode-switch{display:inline-flex;align-items:center;gap:6px;background:transparent;color:inherit;border:0;padding:4px;font:inherit;cursor:pointer}
.jdx-mode-switch:focus-visible{outline:2px solid var(--jdx-green,#16cf8c);outline-offset:2px}
.jdx-mode-track{display:inline-block;width:46px;height:26px;border-radius:16px;background:color-mix(in srgb,GrayText 22%,transparent);border:1px solid color-mix(in srgb,GrayText 40%,transparent);padding:2px;box-sizing:border-box;flex:none;transition:background-color 180ms ease,border-color 180ms ease}
.jdx-mode-thumb{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--jdx-surface,Canvas);box-shadow:0 1px 2px #0002;transform:translateX(0);transition:transform 220ms cubic-bezier(.2,.8,.2,1)}
.jdx-mode-logo{display:block;width:12px;height:12px;fill:currentColor;color:#7c8580;transition:color 180ms ease}
.jdx-mode-switch[aria-checked=true] .jdx-mode-track{background:color-mix(in srgb,var(--jdx-green,#16cf8c) 20%,transparent);border-color:var(--jdx-green,#16cf8c)}
.jdx-mode-switch[aria-checked=true] .jdx-mode-thumb{transform:translateX(20px)}
.jdx-mode-switch[aria-checked=true] .jdx-mode-logo{color:var(--jdx-green,#16cf8c)}
@media (prefers-reduced-motion:reduce){.jdx-mode-track,.jdx-mode-thumb,.jdx-mode-logo{transition:none}}
.jdx-mode-status{font-size:12px;max-width:360px}.jdx-mode-status:empty{display:none}
.jdx-mode-compact{position:relative;flex-wrap:nowrap}
.jdx-mode-compact .jdx-mode-label,.jdx-mode-compact .jdx-mode-status[data-state=success]{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.jdx-mode-compact .jdx-mode-status:not(:empty):not([data-state=success]){position:absolute;top:100%;left:0;z-index:30;width:max-content;max-width:min(320px,70vw);padding:8px 10px;border:1px solid GrayText;border-radius:6px;background:var(--jdx-surface,Canvas);color:var(--jdx-text,CanvasText);box-shadow:0 2px 8px #0002}`
  wrap.append(style, button, status); root.append(wrap)
  if (typeof root.prepend === 'function') root.prepend(wrap)
  let pending = false, disposed = false, revision = 0, checking = false, retryAfterCheck = false
  let statusTimer: ReturnType<typeof setTimeout> | undefined
  const clearStatus = () => { clearTimeout(statusTimer); statusTimer = undefined; status.textContent = '' }
  // 错误留出阅读时间，其余反馈短暂出现；新操作和卸载不能留下旧提示或定时器。
  const showStatus = (state: 'notice' | 'success' | 'error', text: string) => {
    clearStatus(); status.dataset.state = state; status.textContent = text
    statusTimer = setTimeout(clearStatus, state === 'error' ? 5000 : 3000)
  }
  const dismissOutside = (event: Event) => { if (!wrap.contains(event.target as Node)) clearStatus() }
  const dismissEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') clearStatus() }
  doc.addEventListener('pointerdown', dismissOutside)
  doc.addEventListener('keydown', dismissEscape)
  const update = () => {
    button.setAttribute('aria-checked', String(modeEnabled(host)))
    button.title = pending ? uiText('攻玉模式：等待连接；点击取消开启', 'Jadense mode: waiting for connection; click to cancel') : uiText(`攻玉模式：${modeEnabled(host) ? '已开启' : '已关闭'}。接管 Jev；本机 OCR 未就绪时使用攻玉。当前任务保持原配置。`, `Jadense mode: ${modeEnabled(host) ? 'on' : 'off'}. Use Jadense for Jev and when local OCR is unprepared. Current tasks keep their configuration.`)
  }
  const stopMode = observeJadenseMode(host, update)
  const enable = async () => {
    if (!pending || checking || disposed) return
    checking = true; const current = revision
    try {
      const catalog = await jadenseAiClient(host).getZoteroAiCapabilities()
      if (!catalog.decision?.authorized || !catalog.ocr?.authorized) throw new Error(uiText('请生成包含 Jev/OCR 权限的新令牌并连接。', 'Connect a new token with Jev/OCR permissions.'))
      const ready = await localOCRReadiness(host)
      if (disposed || current !== revision || !pending) return
      saveJadenseMode(host, true, ready); pending = false
      showStatus(ready === null ? 'notice' : 'success', ready === null ? uiText('已开启；本机状态未确认，保留原 OCR 引擎。', 'Enabled; local readiness unknown, OCR selection retained.') : uiText('已开启', 'Enabled'))
    } catch (error) {
      if (!disposed && current === revision) { showStatus('error', error instanceof Error ? error.message : uiText('请先连接攻玉。', 'Connect Jadense first.')); openConnection() }
    } finally { checking = false; if (!disposed) { update(); if (retryAfterCheck) { retryAfterCheck = false; void enable() } } }
  }
  button.addEventListener('click', () => {
    clearStatus()
    if (modeEnabled(host)) { revision++; pending = false; saveJadenseMode(host, false); showStatus('success', uiText('已关闭，新任务使用原配置。', 'Disabled; new tasks use your original settings.')); update(); return }
    if (pending) { revision++; pending = false; showStatus('notice', uiText('已取消开启。', 'Activation canceled.')); update(); return }
    if (host.Prefs?.get(MODE_CONSENT_PREF, true) !== true) {
      const accepted = doc.defaultView?.confirm(uiText('开启攻玉模式，让攻玉为你提供 Jev 智能分类与 OCR 识别服务。\n\nJev 无需另配模型密钥；本机 OCR 未就绪时，攻玉可接力完成识别。你仍可自由选择 OCR 引擎。\n\n是否开启攻玉模式？', 'Let Jadense handle your Jev classification and OCR needs.\n\nJev works without a separate model API key. When local OCR is not ready, Jadense can take over recognition. You can still choose your preferred OCR engine.\n\nEnable Jadense mode?'))
      if (!accepted) return
      host.Prefs?.set(MODE_CONSENT_PREF, true, true)
    }
    status.textContent = ''; pending = true; revision++; update(); void enable()
  })
  // token 使用 Zotero 默认命名空间；不能误用 global=true。
  const tokenObserver = host.Prefs?.registerObserver?.('extensions.jadenseInZotero.token', () => { if (pending) { revision++; if (checking) retryAfterCheck = true; else void enable() } })
  return () => { disposed = true; revision++; pending = false; clearStatus(); doc.removeEventListener('pointerdown', dismissOutside); doc.removeEventListener('keydown', dismissEscape); stopMode(); if (tokenObserver !== undefined) host.Prefs?.unregisterObserver?.(tokenObserver); wrap.remove() }
}
