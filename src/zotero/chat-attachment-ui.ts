/** 工作台和 Reader 共用附件卡片：文件名、类型、体积和文字预览使用安全 DOM。 */
import { fileSizeLabel, isChatFile, type ChatFileInput, type ChatUploadInput, type LocalChatFile } from '@/chat/file-input'
import { element } from './ui/controls'
import { uiText } from './ui-preferences'
import { readChatFile } from './chat-files'

export function fileCard(doc: Document, file: Pick<ChatFileInput, 'name' | 'size' | 'warning'>, state: string) {
  const card = element(doc, 'div', 'jdx-chat-file-card')
  const type = file.name.split('.').pop()?.toUpperCase().slice(0, 8) || 'FILE'
  const icon = element(doc, 'span', 'jdx-chat-file-icon', type); icon.setAttribute('aria-hidden', 'true')
  const info = element(doc, 'div', 'jdx-chat-file-info')
  const name = element(doc, 'strong', 'jdx-chat-file-name', file.name); name.title = file.name
  info.append(name, element(doc, 'small', 'jdx-chat-file-meta', `${type} · ${fileSizeLabel(file.size)} · ${state}`))
  card.append(icon, info)
  if (file.warning) { card.dataset.warning = 'true'; info.append(element(doc, 'small', 'jdx-chat-file-warning', file.warning)) }
  return card
}

export function renderUploadDraft(container: HTMLElement, upload: ChatUploadInput | undefined, remove: () => void) {
  const doc = container.ownerDocument
  container.replaceChildren(); container.hidden = !upload
  if (!upload) return
  let card: HTMLElement
  if (isChatFile(upload)) card = fileCard(doc, upload, uiText('待发送', 'Ready'))
  else {
    card = element(doc, 'div', 'jdx-chat-file-card')
    const img = element(doc, 'img'); img.src = upload.dataUrl; img.alt = upload.name || uiText('图片', 'Image')
    card.append(img, element(doc, 'strong', 'jdx-chat-file-name', upload.name || uiText('图片', 'Image')))
  }
  const button = element(doc, 'button', 'jdx-chat-file-remove', '×'); button.type = 'button'
  button.title = uiText('移除附件', 'Remove attachment'); button.setAttribute('aria-label', `${button.title}: ${upload.name || ''}`)
  button.onclick = remove
  card.append(button); container.append(card)
}

export function renderFileMessage(container: HTMLElement, attachment: LocalChatFile) {
  const doc = container.ownerDocument
  const details = element(doc, 'details', 'jdx-chat-file-message')
  const summary = element(doc, 'summary'); summary.append(fileCard(doc, attachment, uiText('查看文字', 'View text')))
  const preview = element(doc, 'pre', 'jdx-chat-file-text', uiText('正在读取附件…', 'Loading attachment…'))
  details.append(summary, preview); container.append(details)
  let loaded = false
  details.addEventListener('toggle', () => {
    if (!details.open || loaded) return
    loaded = true
    void readChatFile(attachment).then(file => {
      preview.textContent = file ? file.text || uiText('无可提取文字。', 'No extractable text.') : uiText('本地附件不可用，请重新上传。', 'Local attachment unavailable. Upload it again.')
    })
  })
}
