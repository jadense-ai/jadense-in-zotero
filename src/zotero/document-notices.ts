/** 文档执行错误的安全用户投影；单一任务入口通知，窗口只展示持久错误。 */
import type { ZoteroLike } from './runtime'
import { openManagerWindow, type ZoteroManagerWindow } from './manager-window'
import { copyTextToClipboard } from './connection-display'
import { uiText } from './ui-preferences'
import { TranslationRateLimitError } from '@/chat/translation-queue'

export type DocumentIssue = { id: string; code: string; message: string; stage: string; action?: 'ocr' | 'connection'; retryAt?: number }
export function documentIssue(error: unknown, stage: string, kind = 'translation'): DocumentIssue {
  const value = error as { code?: string; status?: number }
  const code = (typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value.code) ? value.code : undefined) || (error instanceof TranslationRateLimitError ? 'RATE_LIMITED' : 'DOCUMENT_FAILED')
  const issue: DocumentIssue = { id: crypto.randomUUID(), code, stage, message: '' }
  const retained = uiText('已完成内容已保留。', 'Completed content is retained.')
  if (code.startsWith('OCR_')) { issue.action = 'ocr'; issue.message = uiText('OCR 依赖或模型尚未就绪。请前往 OCR 配置点击“启用本机 OCR”或“继续准备”。', 'OCR dependencies or models are not ready. Open OCR configuration and choose Enable local OCR or Continue setup.') }
  if (code === 'OCR_PREPARING') issue.message = uiText('OCR 正在准备，请完成后重新启动任务。', 'OCR preparation is in progress. Start again when it completes.')
  else if (code === 'OCR_DEPENDENCIES_MISSING') issue.message = uiText('OCR 依赖尚未安装完成，请前往 OCR 配置点击“启用本机 OCR”。', 'OCR dependencies are incomplete. Choose Enable local OCR in OCR configuration.')
  else if (code === 'OCR_MODELS_MISSING') issue.message = uiText('OCR 模型尚未就绪，请前往 OCR 配置点击“继续准备”，已下载内容会复用。', 'OCR models are not ready. Choose Continue setup in OCR configuration; existing downloads will be reused.')
  else if (code === 'POINTS_INSUFFICIENT' || value?.status === 402) { issue.action = 'connection'; issue.message = uiText(`积分不足，${kind === 'translation' ? '全文翻译' : '任务'}已停止。请领取或补充积分后重试。`, 'Not enough points. The task stopped. Add points or check in, then retry.') + retained }
  else if ([401, 403].includes(value?.status ?? 0) || code === 'AI_NOT_CONFIGURED') { issue.action = 'connection'; issue.message = uiText('AI 连接未配置、已过期或权限不足，请检查连接和模型设置。', 'AI configuration is missing, expired or lacks permission. Check the connection and model settings.') + retained }
  else if (error instanceof TranslationRateLimitError || value?.status === 429) { issue.retryAt = error instanceof TranslationRateLimitError ? error.retryAt : undefined; issue.message = uiText('服务请求过于频繁，请稍后重试。', 'The service is rate limited. Retry later.') + (issue.retryAt ? new Date(issue.retryAt).toLocaleTimeString() : '') + retained }
  else if (code === 'OUTPUT_RESOURCES_CHANGED') issue.message = uiText('此片译文缺少或改变了图片/公式引用，请重试此片。', 'This chunk has missing or changed image/formula references. Retry the chunk.') + retained
  else if (code === 'OUTPUT_EMPTY') issue.message = uiText('此片未返回译文，请重试。', 'This chunk returned no translation. Retry it.') + retained
  else if (code === 'STREAM_EARLY_EOF') issue.message = uiText('译文连接中断，尚未收到完整结果，请继续重试。', 'The translation connection was interrupted before a complete result. Resume to retry.') + retained
  else if (code === 'STREAM_INCOMPLETE') issue.message = uiText('此片输出未完整结束，可能已达到输出长度限制，请重试此片。', 'This chunk ended incomplete, possibly at the output limit. Retry the chunk.') + retained
  else if (code === 'CONFIG_CHANGED') issue.message = uiText('当前任务使用的 AI 配置已改变，任务已暂停，请确认设置后继续。', 'The active AI configuration changed. The task paused; check settings and resume.') + retained
  else if (code === 'STORAGE_UNAVAILABLE') issue.message = uiText('尚未完整保存，请及时复制。', 'Not fully saved. Copy the content now.')
  else if (!issue.message) issue.message = uiText('任务未能完成，请重试或复制诊断编号反馈。', 'The task could not finish. Retry or copy the diagnostic ID to report it.') + retained
  return issue
}

export function openDocumentSettings(host: ZoteroLike, action: 'ocr' | 'connection') {
  return openManagerWindow({ zotero: host, win: host.getMainWindow?.() as ZoteroManagerWindow | null,
    context: { pluginID: 'jadense-in-zotero@jadense.cn', rootURI: '' }, section: action === 'ocr' ? 'settings-ocr' : 'settings-connection' })
}

/** 单个任务管理器调用一次；失败的展示不得干扰任务落盘。 */
export function notifyDocumentIssue(host: ZoteroLike, issue: DocumentIssue, retry?: () => void, copy?: () => Promise<string>) {
  try {
    const recent = (globalThis as unknown as { Services?: { wm?: { getMostRecentWindow(type: null): Window | null } } }).Services?.wm?.getMostRecentWindow(null)
    const win = recent && !recent.closed && String(recent.location?.href).includes('jadense-in-zotero') ? recent : host.getMainWindow?.(); if (!win || win.closed) return
    const doc = win.document
    const make = (tag: string, text = '') => { const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement; node.textContent = text; return node }
    let stack = doc.getElementById('jadense-document-notices')
    if (!stack) { stack = make('div'); stack.id = 'jadense-document-notices'; stack.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;display:grid;gap:8px;max-width:min(440px,90vw)'; doc.documentElement.append(stack) }
    const toast = make('div'); toast.setAttribute('role', 'alert'); toast.dataset.diagnosticId = issue.id
    toast.style.cssText = 'padding:14px;background:light-dark(#fff,#202421);color:light-dark(#111510,#f1f5ef);border:1px solid #8886;border-radius:8px;box-shadow:0 4px 20px #0003;font:14px/1.5 system-ui;white-space:normal;overflow-wrap:anywhere'
    toast.append(make('div', issue.message))
    const button = (label: string, run: () => void) => { const node = make('button', label); node.style.cssText = 'margin:8px 8px 0 0;padding:4px 8px;cursor:pointer'; node.addEventListener('click', run); toast.append(node) }
    if (issue.action) button(issue.action === 'ocr' ? uiText('前往 OCR 配置', 'Open OCR configuration') : uiText('账户 / 签到', 'Account / check in'), () => { openDocumentSettings(host, issue.action!); toast.remove() })
    if (retry) button(uiText('重试', 'Retry'), () => { toast.remove(); retry() })
    if (copy) button(uiText('复制内容', 'Copy content'), () => { void copy().then(text => copyTextToClipboard(host, text)).catch(() => {}) })
    button(uiText('复制诊断编号', 'Copy diagnostic ID'), () => { void copyTextToClipboard(host, issue.id) })
    button(uiText('关闭', 'Dismiss'), () => toast.remove())
    stack.append(toast)
    while (stack.children.length > 3) stack.firstElementChild?.remove()
  } catch { /* 展示不阻止执行或错误保存。 */ }
}


/** 历史页操作入口不触发 toast；同一错误在多个视图可读、可处理。 */
export function renderDocumentIssueActions(root: HTMLElement, host: ZoteroLike, issue?: DocumentIssue) {
  root.hidden = !issue
  if (root.dataset.issue === issue?.id) return
  root.dataset.issue = issue?.id ?? ''; root.replaceChildren()
  if (!issue) return
  const button = (text: string, run: () => void) => { const node = root.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'button'); node.textContent = text; node.className = 'jdx-button'; node.addEventListener('click', run); root.append(node) }
  if (issue.action) button(issue.action === 'ocr' ? uiText('前往 OCR 配置', 'Open OCR configuration') : uiText('账户 / 连接', 'Account / connection'), () => { openDocumentSettings(host, issue.action!) })
  button(uiText('复制诊断编号', 'Copy diagnostic ID'), () => { void copyTextToClipboard(host, issue.id) })
}
