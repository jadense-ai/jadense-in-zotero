import { createModelSelect } from './ui/model-select'
/** Reader 对话视图：共享工作台消息/输入组件，视图选择和草稿不写入全局 activeSessionId。 */
import { readLocalChatState } from '@/chat/local-chat-store'
import type { ChatUploadInput } from '@/chat/file-input'
import { readChatUpload } from './chat-files'
import { renderUploadDraft } from './chat-attachment-ui'
import { JadenseApiClient, type JadenseChatModelCatalog } from '@/jadense/api'
import { chatRuntime, type SelectionQuote } from './chat-runtime'
import { mountChatComposer } from './chat-composer-ui'
import { bindChatEvidenceToggle } from './chat-evidence-settings'
import { renderMessage, nearLatest, followMessageUpdate, updateLatestButton } from './chat-message-ui'
import { createJdxSelect } from './ui/select'
import { element } from './ui/controls'
import { uiText } from './ui-preferences'
import { collectSourceForItem } from './research-context'
import { effectiveFeatureModelSelection, featureModelSelectionFromKey, featureModelSelectionKey, featureModelState, featureFollowsChat, saveFeatureModelSelection } from './ai-settings'
import { bindModelSelectToast, buildFeatureModelSelectOptions, configureFeatureModelThinking, jadenseChatModelSelectionIssue, shouldRefreshModelCatalog } from './ai-model-select'
import { rememberModelCatalog } from './model-catalog'
import { openManagerWindow } from './manager-window'
import { readConnection, type ZoteroLike } from './runtime'

/** 每个 Reader 生命周期保留一份会话选择；功能页隐藏不销毁此视图。 */
export function mountReaderChat(root: HTMLElement, selector: HTMLElement, host: ZoteroLike, itemID: number) {
  const cleanups: Array<() => void> = []
  let disposed = false
  try {
  const doc = root.ownerDocument, win = doc.defaultView!, runtime = chatRuntime(host)
  const prefix = `reader-${Math.random().toString(36).slice(2)}`
  root.classList.add('jdx-reader-chat')
  const messageList = element(doc, 'div', 'jdx-chat-message-list')
  messageList.setAttribute('role', 'log'); messageList.setAttribute('aria-live', 'polite'); messageList.tabIndex = 0
  const chatLatest = element(doc, 'button', 'jdx-chat-latest', uiText('↓ 回到最新', '↓ Back to latest')); chatLatest.type = 'button'
  const dock = element(doc, 'div', 'jdx-chat-dock'); mountChatComposer(dock, prefix)
  cleanups.push(bindChatEvidenceToggle(dock, host))
  const get = <T extends HTMLElement>(suffix: string) => dock.querySelector<T>(`#${prefix}-chat-${suffix}`)!
  const chatStatus = get<HTMLElement>('status'), input = get<HTMLTextAreaElement>('input'), form = get<HTMLFormElement>('form')
  const send = get<HTMLButtonElement>('send'), stop = get<HTMLButtonElement>('stop'), attach = get<HTMLButtonElement>('attach-image')
  const file = get<HTMLInputElement>('image-input'), preview = get<HTMLElement>('image-preview'), hint = get<HTMLElement>('compose-hint')
  const association = element(doc, 'small', 'jdx-chat-association')
  const otherGeneration = element(doc, 'div', 'jdx-reader-other-generation'), owner = element(doc, 'span')
  owner.setAttribute('role', 'status')
  const returnChat = element(doc, 'button', 'jdx-reader-return-chat', uiText('返回该对话', 'Go to conversation'))
  returnChat.type = 'button'; otherGeneration.append(owner, returnChat)
  const modelIssue = element(doc, 'div', 'jdx-reader-model-issue'), issueText = element(doc, 'span')
  issueText.id = `${prefix}-model-issue`; issueText.setAttribute('role', 'status')
  const configure = element(doc, 'button', 'jdx-reader-configure-model')
  configure.type = 'button'; modelIssue.append(issueText, configure)
  dock.querySelector('.jdx-chat-status-panel')!.prepend(association, otherGeneration, modelIssue); root.append(messageList, chatLatest, dock)
  const elements = { messageList, chatLatest, chatStatus }
  const newTitle = uiText('新对话', 'New conversation')
  const draftTitle = element(doc, 'strong', 'jdx-reader-draft-title', newTitle), history = element(doc, 'div')
  selector.append(draftTitle, history)
  const sessions = createJdxSelect(history, { compact: true, portal: true, ariaLabel: uiText('切换对话', 'Switch conversation'), popupWidth: 280 })
  cleanups.push(() => sessions.destroy())
  const models = createModelSelect(get('model-select'), { portal: true, modelNoticeInPopup: true, ariaLabel: uiText('对话模型', 'Chat model') })
  bindModelSelectToast(models)
  models.onOpen(() => { void refreshCatalog() })
  cleanups.push(() => models.destroy())
  const drafts = new Map<string, { text: string; image?: ChatUploadInput; scroll: number }>()
  let sessionID = '', image: ChatUploadInput | undefined, creating = false, readingImage = false, newConversationDraft = false
  let source: Awaited<ReturnType<typeof collectSourceForItem>> = null
  let catalog: JadenseChatModelCatalog = { options: [], defaultSelection: null }, catalogReady = false
  let sessionOptionsKey = '', modelOptionsKey = '', imageGeneration = 0
  let newSessionGeneration = 0
  let firstSendPending = false
  let needsConnection = false
  const saveDraft = () => drafts.set(sessionID, { text: input.value, image, scroll: messageList.scrollTop })
  const error = (value: unknown) => { if (disposed) return; chatStatus.textContent = value instanceof Error ? value.message : String(value); chatStatus.dataset.state = 'error' }
  const renderImage = () => {
    renderUploadDraft(preview, image, () => { image = undefined; saveDraft(); renderImage(); update(); attach.focus() })
  }
  function update() {
    if (disposed) return
    root.dataset.chatSession = sessionID
    const state = readLocalChatState(runtime.preferences)
    if (sessionID && !state.sessions.some(session => session.id === sessionID)) { select(''); return }
    const session = state.sessions.find(session => session.id === sessionID)
    const ordered = [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const key = JSON.stringify(ordered.map(session => [session.id, session.title]))
    if (key !== sessionOptionsKey) {
      history.hidden = ordered.length === 0; draftTitle.hidden = !history.hidden
      if (history.hidden) sessions.close()
      sessions.setOptions([{ value: '', label: newTitle }, ...ordered.map(session => ({ value: session.id, label: session.title }))], sessionID); sessionOptionsKey = key
    } else sessions.setValue(sessionID)
    const follow = nearLatest(elements), top = messageList.scrollTop
    if (!session?.messages.length) {
      if (!messageList.querySelector('.jdx-chat-empty')) {
        const empty = element(doc, 'div', 'jdx-chat-empty')
        empty.append(element(doc, 'h3', '', uiText('与当前文献对话', 'Discuss this paper')), element(doc, 'p', '', uiText('发送问题时会关联当前 PDF。', 'Your question will include this PDF.')))
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
    configureFeatureModelThinking(models, host, feature, catalog)
    const issue = ai.route === 'jadense' && catalogReady ? jadenseChatModelSelectionIssue(catalog, ai.selection.route === 'jadense' ? ai.selection.selection ?? { kind: 'default' } : { kind: 'default' }) : ''
    send.disabled = !ai.ready || !!issue || runtime.busy || creating || (!sessionID && firstSendPending) || readingImage || (!input.value.trim() && !image)
    const generating = state.sessions.find(session => session.id === runtime.activeSessionID)?.title
    stop.hidden = !runtime.busy || runtime.activeSessionID !== sessionID
    stop.title = generating ? uiText(`停止生成：${generating}`, `Stop generating: ${generating}`) : uiText('停止生成', 'Stop generating')
    stop.setAttribute('aria-label', stop.title)
    otherGeneration.hidden = !runtime.busy || runtime.activeSessionID === sessionID
    const ownerText = otherGeneration.hidden ? '' : generating
      ? uiText(`「${generating}」正在生成回复。`, `“${generating}” is generating a reply.`)
      : uiText('其他对话正在生成回复。', 'Another conversation is generating a reply.')
    if (owner.textContent !== ownerText) owner.textContent = ownerText
    returnChat.hidden = !generating
    attach.disabled = readingImage
    modelIssue.hidden = ai.ready && !issue
    needsConnection = !ai.ready && ai.route === 'jadense' && Boolean(ai.selection.selection)
    const reason = modelIssue.hidden ? '' : ai.ready ? issue : needsConnection ? uiText('尚未连接攻玉。', 'Jadense is not connected.')
      : ai.route === 'byok' ? uiText('当前 BYOK 对话模型不可用。', 'The selected BYOK chat model is unavailable.')
      : uiText('尚未配置对话模型。', 'Choose a chat model to send a message.')
    if (issueText.textContent !== reason) issueText.textContent = reason
    configure.textContent = needsConnection ? uiText('连接攻玉', 'Connect Jadense') : uiText('配置对话模型', 'Configure chat model')
    hint.hidden = !modelIssue.hidden
    input.setAttribute('aria-describedby', modelIssue.hidden ? hint.id : issueText.id)
    input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, Math.max(48, Math.min(160, root.clientHeight * .28)))}px`
    updateLatestButton(elements)
  }
  const syncStatus = () => {
    chatStatus.textContent = runtime.activeSessionID === sessionID ? runtime.status : ''
    chatStatus.dataset.state = runtime.statusKind
  }
  const select = (id: string) => {
    ++newSessionGeneration; creating = false
    saveDraft(); sessionID = id
    newConversationDraft = id === ''
    const draft = drafts.get(id); input.value = draft?.text ?? ''; image = draft?.image
    messageList.replaceChildren(); syncStatus(); renderImage(); update()
    win.requestAnimationFrame(() => { messageList.scrollTop = draft?.scroll ?? messageList.scrollHeight; updateLatestButton(elements) })
  }
  sessions.onChange(select)
  returnChat.onclick = () => {
    const id = runtime.activeSessionID
    if (runtime.busy && id && readLocalChatState(runtime.preferences).sessions.some(session => session.id === id)) { select(id); input.focus() }
  }
  configure.onclick = () => {
    const opened = openManagerWindow({ zotero: host, win: host.getMainWindow?.() ?? win as Window & typeof globalThis,
      context: { pluginID: 'jadense-in-zotero@jadense.cn', rootURI: '' }, section: needsConnection ? 'settings-connection' : 'settings-features', focusChatModel: !needsConnection })
    if (!opened) error(uiText('暂时无法打开设置，请从工作台进入设置。', 'Settings could not open. Open Settings from the workbench.'))
  }
  models.onChange(value => { const selected = featureModelSelectionFromKey(value); if (selected) saveFeatureModelSelection(host, featureFollowsChat(host, runtime.feature(sessionID)) ? 'chat' : image ? 'chat' : runtime.feature(sessionID), selected, catalog); update() })
  async function newSession(quote?: SelectionQuote) {
    if (sessionID) select('')
    newConversationDraft = true
    input.focus()
    if (!quote) return
    const generation = ++newSessionGeneration
    creating = true
    input.value = quote.text.split('\n').map(line => `> ${line}`).join('\n') + '\n\n' + input.value
    saveDraft(); update()
    try {
      const id = await runtime.create(itemID, quote)
      if (disposed || generation !== newSessionGeneration) return
      promoteDraft(id); input.focus()
    } finally { if (!disposed && generation === newSessionGeneration) { creating = false; update() } }
  }
  /** 首次发送取得真实会话后，迁移当前输入和附件，之后新建的草稿从空白开始。 */
  function promoteDraft(id: string) {
    sessionID = id; newConversationDraft = false; drafts.delete('')
    saveDraft(); syncStatus(); update()
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (send.disabled) return
    let capturedID = sessionID
    const prompt = input.value, sentImage = image
    if (!capturedID) {
      firstSendPending = true; update()
      try {
        capturedID = await runtime.create(itemID)
        if (disposed) return
        if (!sessionID && !creating) promoteDraft(capturedID)
        else {
          const draft = drafts.get('')
          if (draft?.text === prompt && draft.image === sentImage) drafts.delete('')
          drafts.set(capturedID, { text: prompt, image: sentImage, scroll: 0 })
        }
      } catch (value) {
        if (!disposed) error(value)
        return
      } finally {
        firstSendPending = false
        if (!disposed) update()
      }
    }
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
      const result = await readChatUpload(value, doc)
      if (disposed || generation !== imageGeneration) return
      if (sessionID === target) { image = result; renderImage(); saveDraft() }
      else { const draft = drafts.get(target) ?? { text: '', scroll: 0 }; drafts.set(target, { ...draft, image: result }) }
    } catch (value) { if (!disposed && generation === imageGeneration) error(value) }
    finally { if (generation === imageGeneration) { readingImage = false; update() } }
  }
  attach.onclick = () => file.click()
  file.onchange = () => { const value = file.files?.[0]; file.value = ''; if (value) void attachImage(value) }
  input.addEventListener('paste', event => { const value = event.clipboardData?.files?.[0]; if (value) { event.preventDefault(); void attachImage(value) } })
  root.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() })
  root.addEventListener('drop', event => { const value = event.dataTransfer?.files?.[0]; if (value) { event.preventDefault(); void attachImage(value) } })
  stop.onclick = () => { if (runtime.busy && runtime.activeSessionID === sessionID) runtime.stop() }
  chatLatest.onclick = () => { messageList.scrollTop = messageList.scrollHeight; updateLatestButton(elements) }
  messageList.addEventListener('scroll', () => updateLatestButton(elements), { passive: true })
  const unsubscribe = runtime.subscribe(() => { if (disposed) return; syncStatus(); void refreshCatalog(); update() })
  cleanups.push(unsubscribe)
  const onResize = () => { if (!disposed) { update(); fitDock() } }
  win.addEventListener('resize', onResize); cleanups.push(() => win.removeEventListener('resize', onResize))
  const watch = (target: HTMLElement, update: () => void) => {
    try { const observer = new (win as Window & typeof globalThis).ResizeObserver(update); cleanups.push(() => observer.disconnect()); observer.observe(target) } catch { /* 窗口 resize 保留布局能力。 */ }
  }
  watch(root, update)
  // 悬浮卡片的真实高度同时决定消息留白和回到最新按钮的位置。
  const fitDock = () => {
    const follow = nearLatest(elements)
    root.style.setProperty('--jdx-chat-dock-height', `${Math.ceil(dock.getBoundingClientRect().height)}px`)
    if (follow) messageList.scrollTop = messageList.scrollHeight
    updateLatestButton(elements)
  }; watch(dock, fitDock)
  void collectSourceForItem(host, itemID, { includeText: false }).then(value => {
    if (disposed) return
    source = value
    const related = readLocalChatState(runtime.preferences).sessions.find(session => session.sources.some(item => item.kind === 'file' && item.libraryID === value?.libraryID && item.itemKey === value?.itemKey))
    if (related && !newConversationDraft && !sessionID && !input.value && !image && !readingImage) select(related.id)
    update()
  }).catch(error)
  let catalogController = new AbortController(), catalogIdentity = '', catalogUpdatedAt = 0, catalogLoading = false
  cleanups.push(() => catalogController.abort())
  async function refreshCatalog() {
    let controller: AbortController | undefined
    try {
    const connection = readConnection(host), identity = `${connection.baseUrl}\n${connection.token}`
    if (disposed || (catalogLoading && identity === catalogIdentity) || (identity === catalogIdentity && !shouldRefreshModelCatalog(catalogUpdatedAt))) return
    catalogLoading = true
    if (identity !== catalogIdentity) { catalogReady = false; catalog = { options: [], defaultSelection: null }; catalogUpdatedAt = 0 }
    catalogIdentity = identity; catalogController.abort(); catalogController = new AbortController()
    controller = catalogController
    if (!connection.token) { catalogLoading = false; update(); return }
      const value = await new JadenseApiClient({ ...connection, fetchImpl: win.fetch.bind(win) }).getChatModels(controller.signal)
      if (!disposed && !controller.signal.aborted) { catalog = value; rememberModelCatalog(host, value); catalogReady = true; catalogUpdatedAt = Date.now(); update() }
    } catch { /* 目录是可选展示，不阻断已有模型发送。 */ }
    finally { if (controller === catalogController) catalogLoading = false }
  }
  update()
  void refreshCatalog()
  return { newSession, refresh: update, closeMenus() { sessions.close(); models.close() }, remove() { disposed = true; ++imageGeneration; for (const cleanup of cleanups.reverse()) { try { cleanup() } catch { /* 回收其他资源。 */ } } root.replaceChildren(); selector.replaceChildren() } }
  } catch (error) {
    disposed = true
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch { /* 初始化失败也释放已订阅资源。 */ } }
    root.replaceChildren(); selector.replaceChildren(); throw error
  }
}
