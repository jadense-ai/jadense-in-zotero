/** 工作台和侧栏的同一输入区模板；只解析静态自有 XHTML，不插入用户内容。 */
import { getUiLocale } from './ui-preferences'
export const CHAT_COMPOSER_MARKUP = `<div class="jdx-chat-status-panel"><div id="jadense-chat-status" class="jdx-manager-inline-status" role="status"></div></div>
                  <form id="jadense-chat-form" class="jdx-chat-composer">
                    <div class="jdx-chat-compose-field">
                      <div id="jadense-chat-image-preview" class="jdx-chat-image-preview" aria-label="待发送图片" data-ui-en-aria-label="Image ready to send" hidden="hidden"></div>
                      <input id="jadense-chat-image-input" type="file" accept="image/png,image/jpeg" hidden="hidden" aria-label="选择图片" data-ui-en-aria-label="Choose an image"/>
                      <textarea id="jadense-chat-input" rows="2" maxlength="20000" aria-label="对话消息" data-ui-en-aria-label="Chat message" aria-describedby="jadense-chat-compose-hint" placeholder="向攻玉提问…" data-ui-en-placeholder="Ask Jadense…"></textarea>
                      <div class="jdx-chat-composer-footer">
                        <div class="jdx-chat-composer-meta">
                          <button id="jadense-chat-attach-image" class="jdx-chat-icon-button" type="button" title="上传 PNG 或 JPEG 图片，也可粘贴或拖入图片" data-ui-en-title="Upload a PNG or JPEG image, or paste or drop an image" aria-label="上传图片" data-ui-en-aria-label="Upload image"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9"/></svg></button>
                          <div id="jadense-chat-model-select" class="jdx-chat-model-select"></div>
                        </div>
                        <div class="jdx-chat-composer-actions">
                          <button id="jadense-chat-stop" class="jdx-chat-icon-button" type="button" hidden="hidden" title="停止" data-ui-en-title="Stop" aria-label="停止" data-ui-en-aria-label="Stop"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg></button>
                          <button id="jadense-chat-send" class="jdx-manager-primary jdx-chat-icon-button" type="submit" title="发送" data-ui-en-title="Send" aria-label="发送" data-ui-en-aria-label="Send"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
                        </div>
                      </div>
                    </div>
                  </form>
                  <small id="jadense-chat-compose-hint" data-ui-en="Ctrl / ⌘ + Enter to send · Enter for a new line">Ctrl / ⌘ + Enter 发送 · Enter 换行</small>`
export function mountChatComposer(root: HTMLElement, prefix = 'jadense') {
  const doc = root.ownerDocument
  const parser = new (doc.defaultView as Window & typeof globalThis).DOMParser()
  const parsed = parser.parseFromString(`<div xmlns="http://www.w3.org/1999/xhtml">${CHAT_COMPOSER_MARKUP.replaceAll('jadense-chat-', `${prefix}-chat-`)}</div>`, 'application/xhtml+xml')
  root.replaceChildren(...Array.from(parsed.documentElement.childNodes).map(node => doc.importNode(node, true)))
  if (getUiLocale() === 'en-US') {
    root.querySelectorAll<HTMLElement>('[data-ui-en]').forEach(node => { node.textContent = node.dataset.uiEn ?? '' })
    for (const attr of ['aria-label', 'title', 'placeholder']) root.querySelectorAll(`[data-ui-en-${attr}]`).forEach(node => node.setAttribute(attr, node.getAttribute(`data-ui-en-${attr}`)!))
  }
}
