/** Reader 对话视图：共享工作台消息/输入组件，视图选择和草稿不写入全局 activeSessionId。 */
import { readLocalChatState } from '@/chat/local-chat-store'
import type { ChatImageInput } from '@/chat/image-input'
import { JadenseApiClient, type JadenseChatModelCatalog } from '@/jadense/api'
import { chatRuntime } from './chat-runtime'
import { mountChatComposer } from './chat-composer-ui'
import { renderMessage, nearLatest, followMessageUpdate, updateLatestButton } from './chat-message-ui'
import { createJdxSelect } from './ui/select'
import { element } from './ui/controls'
import { uiText } from './ui-preferences'
import { collectSourceForItem } from './research-context'
import { normalizeFigureImage } from './reader-figure-tools'
import { effectiveFeatureModelSelection, featureModelSelectionFromKey, featureModelSelectionKey, featureModelState, readAutoFollowChatModel, saveFeatureModelSelection } from './ai-settings'
import { buildFeatureModelSelectOptions, jadenseChatModelSelectionIssue } from './ai-model-select'
import { readConnection, type ZoteroLike } from './runtime'

/** 每个 Reader 生命周期保留一份会话选择；功能页隐藏不销毁此视图。 */
export function mountReaderChat(root: HTMLElement, selector: HTMLElement, host: ZoteroLike, itemID: number) {
  const doc = root.ownerDocument, win = doc.defaultView!, runtime = chatRuntime(host)
  const prefix = `reader-${Math.random().toString(36).slice(2)}`
  root.classList.add('jdx-reader-chat')
  const messageList = element(doc, 'div', 'jdx-chat-message-list')
  messageList.setAttribute('role', 'log'); messageList.setAttribute('aria-live', 'polite'); messageList.tabIndex = 0
  const chatLatest = element(doc, 'button', 'jdx-chat-latest', uiText('↓ 回到最新', '↓ Back to latest')); chatLatest.type = 'button'
  const dock = element(doc, 'div', 'jdx-chat-dock'); mountChatComposer(dock, prefix)
  const get = <T extends HTMLElement>(suffix: string) => dock.querySelector<T>(`#${prefix}-chat-${suffix}`)!
  const chatStatus = get<HTMLElement>('status'), input = get<HTMLTextAreaElement>('input'), form = get<HTMLFormElement>('form')
  const send = get<HTMLButtonElement>('send'), stop = get<HTMLButtonElement>('stop'), attach = get<HTMLButtonElement>('attach-image')
  const file = get<HTMLInputElement>('image-input'), preview = get<HTMLElement>('image-preview'), hint = get<HTMLElement>('compose-hint')
  const association = element(doc, 'small', 'jdx-chat-association')
  dock.querySelector('.jdx-chat-status-panel')!.prepend(association); root.append(messageList, chatLatest, dock)
  const elements = { messageList, chatLatest, chatStatus }
  const sessions = createJdxSelect(selector, { compact: true, portal: true, ariaLabel: uiText('切换对话', 'Switch conversation'), popupWidth: 280 })
  const models = createJdxSelect(get('model-select'), { compact: true, portal: true, showSelectedIcon: true, popupWidth: 320, ariaLabel: uiText('对话模型', 'Chat model'), searchPlaceholder: uiText('搜索模型', 'Search models') })
  const drafts = new Map<string, { text: string; image?: ChatImageInput; scroll: number }>()
  let sessionID = '', image: ChatImageInput | undefined, disposed = false, creating = false, readingImage = false, newConversationDraft = false
  let source: Awaited<ReturnType<typeof collectSourceForItem>> = null
  let catalog: JadenseChatModelCatalog = { options: [], defaultSelection: null }, catalogReady = false
  let sessionOptionsKey = '', modelOptionsKey = '', imageGeneration = 0
  const saveDraft = () => drafts.set(sessionID, { text: input.value, image, scroll: messageList.scrollTop })
  const error = (value: unknown) => { chatStatus.textContent = value instanceof Error ? value.message : String(value); chatStatus.dataset.state = 'error' }
  const renderImage = () => {
    preview.replaceChildren(); preview.hidden = !image
    if (!image) return
    const img = element(doc, 'img'); img.src = image.dataUrl; img.alt = image.name ?? uiText("图片", "Image")
    const name = element(doc, 'span', '', image.name)
    const remove = element(doc, 'button', '', uiText('移除图片', 'Remove image')); remove.type = 'button'
    remove.onclick = () => { image = undefined; saveDraft(); renderImage(); update() }
    preview.append(img, name, remove)
  }
  function update() {
    if (disposed) return
    root.dataset.chatSession = sessionID
    const state = readLocalChatState(runtime.preferences)
    if (sessionID && !state.sessions.some(session => session.id === sessionID)) { sessionID = ''; input.value = ''; image = undefined; renderImage(); messageList.replaceChildren() }
    const session = state.sessions.find(session => session.id === sessionID)
    const ordered = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const key = JSON.stringify(ordered.map(session => [session.id, session.title]))
    if (key !== sessionOptionsKey) {
      sessions.setOptions(ordered.map(session => ({ value: session.id, label: session.title })), sessionID); sessionOptionsKey = key
    } else sessions.setValue(sessionID)
    const follow = nearLatest(elements), top = messageList.scrollTop
    if (!session?.messages.length) {
      if (!messageList.querySelector('.jdx-chat-empty')) {
        const empty = element(doc, 'div', 'jdx-chat-empty')
        empty.append(element(doc, 'h3', '', uiText('与当前文献对话', 'Discuss this paper')), element(doc, 'p', '', uiText('发送问题时关联当前 PDF，也可从顶部切换已有对话。', 'Ask about this PDF, or switch conversations above.')))
        messageList.replaceChildren(empty)
      }
    } else {
      messageList.querySelector('.jdx-chat-empty')?.remove()
      const existing = new Map(Array.from(messageList.children).map(child => [(child as HTMLElement).dataset.messageId, child as HTMLElement]))
      session.messages.forEach((message, index) => {
        const node = renderMessage(elements, host, message, existing.get(message.id)); existing.delete(message.id)
        if (messageList.children[index] !== node) messageList.insertBefore(node, messageList.children[index] ?? null)
      })
      existing.forEach(node => node.remove())
    }
    if (follow && !root.hidden) followMessageUpdate(elements, true, top)
    const linked = source && session?.sources.some(item => item.kind === 'file' && item.libraryID === source!.libraryID && item.itemKey === source!.itemKey)
    association.textContent = linked ? uiText(`已关联：${source!.title}`, `Linked: ${source!.title}`)
      : uiText(`发送时将关联当前 PDF：${source?.title ?? '…'}`, `Sending will link this PDF: ${source?.title ?? '…'}`)
    association.title = association.textContent
    const feature = image ? 'chat' : runtime.feature(sessionID), ai = featureModelState(host, feature), selection = effectiveFeatureModelSelection(host, feature)
    const options = buildFeatureModelSelectOptions(host, catalog, selection)
    const nextModelKey = JSON.stringify(options)
    if (nextModelKey !== modelOptionsKey) { modelOptionsKey = nextModelKey; models.setOptions(options, featureModelSelectionKey(selection)) }
    else models.setValue(featureModelSelectionKey(selection))
    const issue = ai.route === 'jadense' && catalogReady ? jadenseChatModelSelectionIssue(catalog, ai.selection.route === 'jadense' ? ai.selection.selection ?? { kind: 'default' } : { kind: 'default' }) : ''
    send.disabled = !ai.ready || !!issue || runtime.busy || creating || readingImage || (!input.value.trim() && !image)
    stop.hidden = !runtime.busy
    const generating = state.sessions.find(session => session.id === runtime.activeSessionID)?.title ?? ''
    stop.title = uiText(`停止生成：${generating}`, `Stop generating: ${generating}`); stop.setAttribute('aria-label', stop.title)
    attach.disabled = readingImage
    hint.textContent = !ai.ready ? ai.issue : issue || uiText('Ctrl / ⌘ + Enter 发送 · Enter 换行', 'Ctrl / ⌘ + Enter to send · Enter for a new line')
    input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, Math.max(48, Math.min(160, root.clientHeight * .28)))}px`
    updateLatestButton(elements)
  }
  const select = (id: string) => {
    saveDraft(); sessionID = id
    newConversationDraft = false
    const draft = drafts.get(id); input.value = draft?.text ?? ''; image = draft?.image
    messageList.replaceChildren(); renderImage(); update()
    win.requestAnimationFrame(() => { messageList.scrollTop = draft?.scroll ?? messageList.scrollHeight; updateLatestButton(elements) })
  }
  sessions.onChange(select)
  models.onChange(value => { const selected = featureModelSelectionFromKey(value); if (selected) saveFeatureModelSelection(host, readAutoFollowChatModel(host) ? 'chat' : image ? 'chat' : runtime.feature(sessionID), selected); update() })
  function newSession() {
    if (creating) return
    if (sessionID) saveDraft(); else drafts.delete('')
    sessionID = ''; newConversationDraft = true; input.value = ''; image = undefined
    messageList.replaceChildren(); renderImage(); update()
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (send.disabled) return
    const target = sessionID, prompt = input.value, sentImage = image
    if (!target) {
      creating = true; update()
      try {
        const id = await runtime.create(itemID)
        if (disposed) return
        select(id); input.value = prompt; image = sentImage; renderImage(); saveDraft()
      } catch (value) {
        if (!disposed) error(value)
        return
      } finally {
        creating = false
        if (!disposed) update()
      }
    }
    const capturedID = target || sessionID
    void runtime.send({ sessionID: capturedID, prompt, image: sentImage, itemID,
      onAccepted() {
        const saved = drafts.get(capturedID)
        if (saved?.text === prompt && saved.image === sentImage) drafts.delete(capturedID)
        if (disposed || sessionID !== capturedID) return
        if (input.value === prompt) input.value = ''
        if (image === sentImage) image = undefined
        renderImage(); saveDraft(); update()
      },
    })
  })
  input.addEventListener('input', () => { saveDraft(); update() })
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit() } })
  async function attachImage(value: File) {
    const target = sessionID, generation = ++imageGeneration
    readingImage = true; update()
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new (win as Window & typeof globalThis).FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(value) })
      const result = await normalizeFigureImage(data, doc, value.name)
      if (disposed || generation !== imageGeneration) return
      if (sessionID === target) { image = result; renderImage(); saveDraft() }
      else { const draft = drafts.get(target) ?? { text: '', scroll: 0 }; drafts.set(target, { ...draft, image: result }) }
    } catch (value) { if (!disposed) error(value) }
    finally { readingImage = false; update() }
  }
  attach.onclick = () => file.click()
  file.onchange = () => { const value = file.files?.[0]; file.value = ''; if (value) void attachImage(value) }
  input.addEventListener('paste', event => { const value = Array.from(event.clipboardData?.files ?? []).find(file => /^image\/(png|jpeg)$/.test(file.type)); if (value) { event.preventDefault(); void attachImage(value) } })
  root.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() })
  root.addEventListener('drop', event => { const value = Array.from(event.dataTransfer?.files ?? []).find(file => /^image\/(png|jpeg)$/.test(file.type)); if (value) { event.preventDefault(); void attachImage(value) } })
  stop.onclick = () => runtime.stop()
  chatLatest.onclick = () => { messageList.scrollTop = messageList.scrollHeight; updateLatestButton(elements) }
  messageList.addEventListener('scroll', () => updateLatestButton(elements), { passive: true })
  const unsubscribe = runtime.subscribe(() => { if (disposed) return; chatStatus.textContent = runtime.activeSessionID === sessionID ? runtime.status : ''; chatStatus.dataset.state = runtime.statusKind; void refreshCatalog(); update() })
  const resize = new (win as Window & typeof globalThis).ResizeObserver(update); resize.observe(root)
  // 悬浮卡片的真实高度同时决定消息留白和回到最新按钮的位置。
  const dockResize = new (win as Window & typeof globalThis).ResizeObserver(() => {
    const follow = nearLatest(elements)
    root.style.setProperty('--jdx-chat-dock-height', `${Math.ceil(dock.getBoundingClientRect().height)}px`)
    if (follow) messageList.scrollTop = messageList.scrollHeight
    updateLatestButton(elements)
  }); dockResize.observe(dock)
  void collectSourceForItem(host, itemID, { includeText: false }).then(value => {
    if (disposed) return
    source = value
    const related = readLocalChatState(runtime.preferences).sessions.find(session => session.sources.some(item => item.kind === 'file' && item.libraryID === value?.libraryID && item.itemKey === value?.itemKey))
    if (related && !newConversationDraft && !sessionID && !input.value) select(related.id)
    update()
  }).catch(error)
  let catalogController = new AbortController(), catalogIdentity = ''
  async function refreshCatalog() {
    const connection = readConnection(host), identity = `${connection.baseUrl}\n${connection.token}`
    if (identity === catalogIdentity || disposed) return
    catalogIdentity = identity; catalogController.abort(); catalogController = new AbortController()
    const controller = catalogController
    catalogReady = false; catalog = { options: [], defaultSelection: null }
    if (!connection.token) return
    try {
      const value = await new JadenseApiClient({ ...connection, fetchImpl: win.fetch.bind(win) }).getChatModels(controller.signal)
      if (!disposed && !controller.signal.aborted) { catalog = value; catalogReady = true; update() }
    } catch { /* 目录是可选展示，不阻断已有模型发送。 */ }
  }
  void refreshCatalog()
  update()
  return { newSession, refresh: update, closeMenus() { sessions.close(); models.close() }, remove() { disposed = true; ++imageGeneration; unsubscribe(); resize.disconnect(); dockResize.disconnect(); catalogController.abort(); sessions.destroy(); models.destroy(); root.replaceChildren() } }
}
