/** Manager 的本地待恢复执行入口；仅取回最终结果，不触发批注或原生导入。 */
import { ReliableTemporaryChatClient } from '@/chat/reliable-temporary-chat'
import { readConnection, type ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
export function wireTemporaryRecovery(host: ZoteroLike, root: HTMLElement | null, fetchImpl: typeof fetch) {
  if (!root) return () => {}
  const doc = root.ownerDocument
  const section = doc.createElement('section'), refresh = doc.createElement('button'), list = doc.createElement('div'), status = doc.createElement('p')
  section.className = 'jdx-temporary-recovery'; refresh.className = 'jdx-manager-button'
  refresh.type = 'button'; refresh.textContent = uiText('查看待恢复 AI 请求', 'Show pending AI requests'); status.setAttribute('role', 'status')
  let disposed = false
  refresh.addEventListener('click', () => { void (async () => {
    refresh.disabled = true
    try {
      const connection = readConnection(host), client = new ReliableTemporaryChatClient({ ...connection, fetchImpl })
      const pending = await client.pending(); if (disposed) return
      list.replaceChildren(); status.textContent = pending.length ? '' : uiText('没有待恢复请求。', 'No pending requests.')
      for (const row of pending) {
        const item = doc.createElement('div'), button = doc.createElement('button'), output = doc.createElement('textarea')
        button.className = 'jdx-manager-button'
        button.type = 'button'; button.textContent = uiText(`恢复结果 · ${row.createdAt}`, `Recover result · ${row.createdAt}`)
        output.readOnly = true; output.hidden = true; output.setAttribute('aria-label', uiText('恢复的 AI 结果', 'Recovered AI result'))
        button.addEventListener('click', () => { button.disabled = true; void client.recover(row, { onTextDelta: (_delta, text) => { if (!disposed) { output.hidden = false; output.value = text } } })
          .then(text => { if (!disposed) { output.hidden = false; output.value = text; status.textContent = uiText('结果已恢复，可选择并复制。', 'Result recovered. Select and copy the text.') } })
          .catch(error => { if (!disposed) status.textContent = error instanceof Error ? error.message : String(error) })
          .finally(() => { if (!disposed) button.disabled = false }) })
        item.append(button, output); list.append(item)
      }
    } catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : String(error) }
    finally { if (!disposed) refresh.disabled = false }
  })() })
  section.append(refresh, status, list); root.append(section)
  return () => { disposed = true; section.remove() }
}
