/** 隔离 Zotero profile 验证发行 XPI 文件读取、持久化和 Reader 共用入口。 */
/* global Components, IOUtils, PathUtils */
export async function verifyChatFiles({ Zotero, manager, reader, config, waitFor, assert, screenshot, report }) {
  const doc = manager.document
  doc.getElementById('jadense-quick-start-close')?.click()
  doc.getElementById('jadense-manager-nav-chat').click()
  const upload = (win, input, bytes, name, type) => {
    const file = new win.File(win.Array.of(Components.utils.cloneInto(bytes, win)), name, Components.utils.cloneInto({ type }, win))
    const transfer = new win.DataTransfer(); transfer.items.add(file); input.files = transfer.files
    input.dispatchEvent(new win.Event('change', Components.utils.cloneInto({ bubbles: true }, win)))
  }
  const state = () => JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.localChatState') || '{}')
  const ready = async () => {
    await waitFor(() => doc.getElementById('jadense-chat-stop').hidden, 'file read finished')
  assert(!doc.getElementById('jadense-chat-image-preview').hidden, `File read failed: ${doc.getElementById('jadense-chat-status').textContent}`)
  }
  upload(manager, doc.getElementById('jadense-chat-image-input'), new TextEncoder().encode('Synthetic text evidence'), 'research.md', 'text/markdown')
  await ready()
  assert(doc.querySelector('.jdx-chat-file-name')?.textContent === 'research.md', 'Text file card missing')
  doc.querySelector('.jdx-chat-file-remove').click()
  assert(doc.getElementById('jadense-chat-image-preview').hidden, 'Removal did not clear the draft')
  upload(manager, doc.getElementById('jadense-chat-image-input'), new Uint8Array(config.wordBytes), 'research.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  await ready()
  assert(doc.querySelector('.jdx-chat-file-name')?.textContent === 'research.docx', 'Word file card missing')
  upload(manager, doc.getElementById('jadense-chat-image-input'), await IOUtils.read(config.pdfPath), 'research.pdf', 'application/pdf')
  await ready()
  doc.getElementById('jadense-chat-send').click()
  await waitFor(() => state().sessions?.some(session => session.messages.some(message => message.file)), 'file reference persisted')
  await waitFor(() => !Zotero.__jadenseChatRuntime.busy, 'file response')
  const message = state().sessions.flatMap(session => session.messages).find(message => message.file)
  const stored = JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, 'jadense-chat-files', `${message.file.id}.json`)))
  assert(stored.text.includes(config.sentences[0][0]), `Native PDF extraction lost text: ${stored.text}`)
  assert(!JSON.stringify(state()).includes(config.sentences[0][0]), 'Extracted text leaked into Preferences')
  const old = manager.document; manager.location.reload()
  await waitFor(() => manager.document !== old && manager.document.querySelector('.jdx-chat-file-message summary'), 'file history reload')
  manager.document.querySelector('.jdx-chat-file-message summary').click()
  await waitFor(() => manager.document.querySelector('.jdx-chat-file-text')?.textContent.includes(config.sentences[0][0]), 'file text restored')
  await screenshot('chat-file-history', manager)
  reader._iframeWindow.document.querySelector('[data-jadense-action="attach"]').click()
  const main = Zotero.getMainWindow()
  const chat = await waitFor(() => main.document.querySelector('.jdx-reader-chat'), 'Reader chat')
  upload(main, chat.querySelector('input[type="file"]'), await IOUtils.read(config.pdfPath), 'reader.pdf', 'application/pdf')
  await waitFor(() => {
    const status = chat.querySelector('[id$="-chat-status"]')
    if (status?.dataset.state === 'error') throw new Error(`Reader upload failed: ${status.textContent}`)
    return chat.querySelector('.jdx-chat-image-preview .jdx-chat-file-name')?.textContent === 'reader.pdf'
  }, 'Reader PDF draft')
  assert(!chat.querySelector('[id$="-send"]').disabled, 'Reader file send disabled')
  upload(main, chat.querySelector('input[type="file"]'), new Uint8Array(config.wordBytes), 'reader.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  await waitFor(() => {
    const status = chat.querySelector('[id$="-chat-status"]')
    if (status?.dataset.state === 'error') throw new Error(`Reader Word failed: ${status.textContent}`)
    return chat.querySelector('.jdx-chat-image-preview .jdx-chat-file-name')?.textContent === 'reader.docx'
  }, 'Reader Word draft')
  for (const theme of ['light', 'dark']) {
    if (manager.document.documentElement.dataset.theme !== theme) manager.document.getElementById('jadense-manager-theme-toggle').click()
    manager.resizeTo(760, 650)
    await Zotero.Promise.delay(300)
    for (const id of ['jadense-chat-details-toggle', 'jadense-manager-sidebar-toggle']) {
      const toggle = manager.document.getElementById(id)
      if (toggle?.getAttribute('aria-expanded') === 'true') toggle.click()
    }
    assert(manager.document.documentElement.scrollWidth <= manager.innerWidth + 2, 'File cards overflow the compact window')
    await screenshot(`chat-file-${theme}`, manager)
  }
  report.checks.push('chat-file-text-read-remove', 'chat-file-native-word', 'chat-file-native-pdf', 'chat-file-persisted-reference', 'chat-file-reload-preview', 'chat-file-reader-pdf', 'chat-file-reader-word')
}
