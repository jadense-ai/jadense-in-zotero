/** 独立文献分类界面与工作台密钥配置：密钥配置、目录选择和可核对预览；只用本地 DOM，不解析模型 HTML。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { applyClassification, loadClassificationFolders, loadClassificationItems, readTypesafeKey, recommendClassification, testTypesafeKey, TYPESAFE_KEY_PREF, TYPESAFE_KEYS_URL, type ClassificationFolder, type ClassificationItem, type ClassificationRow } from './classification'

export function mountClassification(doc: Document, host: ZoteroLike, openSettings: () => void) {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text; node.className = className; return node
  }
  const button = (text: string, action: () => void) => {
    const node = make('button', text); node.type = 'button'; node.addEventListener('click', action); return node
  }
  const checkbox = (label: string, checked = false) => {
    const input = make('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label); return input
  }
  const paths = (values: string[][]) => {
    const list = make('div', '', 'jdx-classification-paths')
    if (!values.length) list.textContent = uiText('无', 'None')
    for (const parts of values) {
      const line = make('span', '', 'jdx-classification-path')
      line.setAttribute('aria-label', parts.join(uiText('，子文件夹：', ', subfolder: ')))
      const icon = make('span', '📁'); icon.setAttribute('aria-hidden', 'true'); line.append(icon)
      parts.forEach((part, index) => {
        if (index) { const separator = make('span', '›', 'jdx-classification-separator'); separator.setAttribute('aria-hidden', 'true'); line.append(separator) }
        line.append(make('span', part, index === parts.length - 1 ? 'jdx-classification-leaf' : ''))
      })
      list.append(line)
    }
    return list
  }
  const dialog = make('main', '', 'jdx-classification-dialog'); dialog.id = 'jadense-classification-dialog'
  const heading = make('h2', uiText('文献分类', 'Literature classification')); heading.id = 'jadense-classification-title'; dialog.setAttribute('aria-labelledby', heading.id)
  const subtitle = make('p'), status = make('p', '', 'jdx-manager-inline-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
  const library = make('select'); library.setAttribute('aria-label', uiText('资料库', 'Library'))
  const choose = make('div', '', 'jdx-classification-choose')
  const search = make('input'); search.type = 'search'; search.placeholder = uiText('搜索收藏夹', 'Search collections'); search.setAttribute('aria-label', search.placeholder)
  const collectionList = make('div', '', 'jdx-classification-folders')
  const replace = checkbox(uiText('移除候选范围内的原分类', 'Remove existing memberships within the candidate scope'))
  const replaceLabel = make('label', '', 'jdx-classification-replace'); replaceLabel.append(replace, doc.createTextNode(replace.getAttribute('aria-label')!))
  const collectionActions = make('div', '', 'jdx-classification-actions')
  collectionActions.append(search, button(uiText('全选', 'Select all'), () => { folders.forEach(folder => candidateIDs.add(folder.id)); renderFolders() }), button(uiText('清空选择', 'Clear selection'), () => { candidateIDs.clear(); renderFolders() }))
  choose.append(make('h3', uiText('选择候选收藏夹', 'Choose candidate collections')), make('p', uiText('分类即 Zotero 收藏夹。📁 父文件夹 › 子文件夹；可只选部分目录，模型不会创建新目录。', 'Categories are Zotero collections. 📁 Parent › Child. Choose any folders; the model will not create new ones.')), collectionActions, collectionList, replaceLabel)
  const preview = make('div', '', 'jdx-classification-preview'); preview.hidden = true
  const tableScroll = make('div', '', 'jdx-classification-table-scroll'), table = make('table'), thead = make('thead'), tbody = make('tbody'), header = make('tr')
  for (const label of [uiText('应用', 'Apply'), uiText('文献', 'Paper'), uiText('原分类', 'Current'), uiText('推荐分类', 'Recommended'), uiText('将移除的分类', 'To remove'), uiText('置信度', 'Confidence')]) { const cell = make('th', label); cell.scope = 'col'; header.append(cell) }
  thead.append(header); table.append(thead, tbody); tableScroll.append(table)
  preview.append(make('h3', uiText('核对分类预览', 'Review recommendations')), tableScroll)
  let ids: number[] = [], items: ClassificationItem[] = [], folders: ClassificationFolder[] = [], rows: ClassificationRow[] = []
  const candidateIDs = new Set<number>()
  let controller: AbortController | undefined, busy = false, saving = false, generation = 0, step = 0
  const currentLibrary = () => Number(library.value)
  const updateActions = () => {
    generate.disabled = busy || !candidateIDs.size || !items.some(item => item.libraryID === currentLibrary())
    apply.disabled = busy || !rows.some(row => row.selected && row.target && !row.applied)
    choose.hidden = step !== 0; preview.hidden = step !== 1; complete.hidden = step !== 2
    generate.hidden = step !== 0 || busy; apply.hidden = step !== 1 || busy
    back.hidden = step !== 1; status.hidden = !status.textContent
    library.hidden = step !== 0 || library.options.length <= 1
    steps.forEach((node, index) => { node.setAttribute('aria-current', index === step ? 'step' : 'false'); node.classList.toggle('is-complete', index < step) })
    back.disabled = busy; library.disabled = busy
    stop.hidden = !busy || saving
  }
  const renderFolders = () => {
    collectionList.replaceChildren()
    const term = search.value.toLocaleLowerCase()
    for (const folder of folders.filter(folder => folder.path.join(' ').toLocaleLowerCase().includes(term))) {
      const label = make('label'), input = checkbox(folder.path.join(' › '), candidateIDs.has(folder.id))
      input.addEventListener('change', () => { if (input.checked) candidateIDs.add(folder.id); else candidateIDs.delete(folder.id); updateActions() })
      label.append(input, paths([folder.path])); collectionList.append(label)
    }
    if (!folders.length) collectionList.append(make('p', uiText('此资料库暂无收藏夹，请先在 Zotero 中创建。', 'No collections in this library. Create some in Zotero first.')))
    else if (!collectionList.children.length) collectionList.append(make('p', uiText('没有符合搜索的收藏夹。', 'No matching collections.')))
    updateActions()
  }
  const folderPaths = (values: number[]) => values.map(id => folders.find(folder => folder.id === id)?.path ?? [uiText('已不可用的收藏夹', 'Unavailable collection')])
  const renderRows = () => {
    tbody.replaceChildren()
    for (const row of rows) {
      const tr = make('tr'), selectCell = make('td'), input = checkbox(row.item.title, row.selected)
      input.disabled = busy || !row.target || Boolean(row.applied)
      input.addEventListener('change', () => { row.selected = input.checked; updateActions() })
      selectCell.append(input)
      const paper = make('td', row.item.title); if (row.error) paper.append(make('p', row.error, 'jdx-classification-error'))
      if (row.applied) paper.append(make('p', uiText('已应用', 'Applied'), 'jdx-classification-applied'))
      const original = make('td'); original.append(paths(folderPaths(row.item.collections)))
      const target = make('td'); target.append(row.target ? paths([row.target.path]) : make('span', row.error ? uiText('推荐失败，保持不变', 'Failed, unchanged') : uiText('未匹配，保持不变', 'No match, unchanged')))
      const removal = make('td'); removal.append(paths(folderPaths(row.remove)))
      tr.append(selectCell, paper, original, target, removal, make('td', row.confidence === null ? '—' : `${Math.round(row.confidence * 100)}%`)); tbody.append(tr)
    }
    updateActions()
  }
  const loadLibrary = async () => {
    const token = ++generation; busy = true; rows = []; candidateIDs.clear(); step = 0; updateActions()
    try {
      const loaded = await loadClassificationFolders(host, currentLibrary())
      if (token !== generation) return
      folders = loaded; folders.forEach(folder => candidateIDs.add(folder.id)); search.value = ''; renderFolders()
      status.textContent = ''
    } catch { status.textContent = uiText('无法读取收藏夹，请关闭后重试。', 'Could not read collections. Close and retry.') }
    finally { if (token === generation) { busy = false; updateActions(); if (!dialog.hidden) search.focus() } }
  }
  const generate = button(uiText('生成推荐预览', 'Generate recommendations'), () => { void (async () => {
    if (busy) return
    if (!readTypesafeKey(host)) { keyGuide.showModal(); return }
    busy = true; controller = new AbortController(); rows = []; step = 1; renderRows()
    const candidates = folders.filter(folder => candidateIDs.has(folder.id))
    const selected = items.filter(item => item.libraryID === currentLibrary())
    try {
      // 重新读取条目，重复生成时不会继续使用已经应用前的集合快照。
      const fresh = await loadClassificationItems(host, selected.map(item => item.id))
      for (const item of fresh) {
        if (controller.signal.aborted) break
        status.textContent = uiText(`正在推荐 ${rows.length + 1} / ${fresh.length}…`, `Recommending ${rows.length + 1} / ${fresh.length}…`)
        try {
          const result = await recommendClassification(item, candidates, readTypesafeKey(host), controller.signal)
          if (controller.signal.aborted) break
          const remove = result.target && replace.checked ? item.collections.filter(id => candidateIDs.has(id) && id !== result.target!.id) : []
          rows.push({ item, ...result, remove, selected: Boolean(result.target && (!item.collections.includes(result.target.id) || remove.length)) })
        } catch (error) {
          if (controller.signal.aborted) break
          rows.push({ item, target: null, confidence: null, remove: [], selected: false, error: (error as Error).message })
          // 明确服务失败后停止后续派发；已完成预览仍可核对应用。
          break
        }
        renderRows()
      }
      status.textContent = uiText(`已生成 ${rows.length} / ${fresh.length} 篇预览，尚未修改条目。${controller.signal.aborted ? '已停止。' : rows.some(row => row.error) ? '请求失败，已停止后续请求；可重新生成。' : ''}`, `Previewed ${rows.length} / ${fresh.length} papers; no changes saved.${controller.signal.aborted ? ' Stopped.' : rows.some(row => row.error) ? ' Request failed; remaining requests stopped. You can retry.' : ''}`)
    } catch { status.textContent = uiText('无法读取文献，请重新打开分类。', 'Could not read papers. Reopen classification.') }
    finally { busy = false; renderRows() }
  })() })
  const apply = button(uiText('确认归类', 'Apply classification'), () => { void (async () => {
    if (busy) return
    busy = saving = true; renderRows()
    try {
      const result = await applyClassification(host, rows, folders.filter(folder => candidateIDs.has(folder.id)))
      status.textContent = uiText(`已归类 ${result.applied} 篇，失败 ${result.failed} 篇。`, `Applied ${result.applied}; failed ${result.failed}.`)
      if (!result.failed) { step = 2; completeCount.textContent = uiText(`已归类 ${rows.filter(row => row.applied).length} 篇文献`, `Classified ${rows.filter(row => row.applied).length} papers`); status.textContent = '' }
    } catch (error) { status.textContent = (error as Error).message }
    finally { busy = saving = false; renderRows() }
  })() }); apply.className = 'jdx-manager-primary'
  const back = button(uiText('返回上一步', 'Back'), () => { rows = []; step = 0; status.textContent = ''; updateActions(); search.focus() })
  const stop = button(uiText('停止', 'Stop'), () => controller?.abort()); stop.hidden = true
  const top = make('div', '', 'jdx-classification-heading'); top.append(heading)
  const stepper = make('ol', '', 'jdx-classification-steps')
  const steps = [uiText('选择分类', 'Choose collections'), uiText('核对预览', 'Review'), uiText('完成', 'Done')].map((label, index) => {
    const node = make('li'); node.append(make('span', String(index + 1)), doc.createTextNode(label)); stepper.append(node); return node
  })
  const complete = make('section', '', 'jdx-classification-complete')
  const completeCount = make('h3'); complete.append(make('span', '✓', 'jdx-classification-success'), completeCount)
  const keyGuide = make('dialog', '', 'jdx-classification-key-guide')
  const guideTitle = make('h3', uiText('先配置 API 密钥', 'Configure an API key')); guideTitle.id = 'classification-key-guide-title'; keyGuide.setAttribute('aria-labelledby', guideTitle.id)
  const guideActions = make('div', '', 'jdx-classification-actions')
  guideActions.append(button(uiText('取消', 'Cancel'), () => keyGuide.close()), button(uiText('前往配置', 'Open settings'), () => { keyGuide.close(); openSettings() }))
  keyGuide.append(guideTitle, make('p', uiText('在功能配置中保存 TypeSafe 密钥后，返回继续。', 'Save a TypeSafe key in feature settings, then return to continue.')), guideActions)
  const actions = make('div', '', 'jdx-classification-actions jdx-classification-footer'); actions.append(back, stop, generate, apply)
  generate.className = 'jdx-manager-primary'
  const content = make('div', '', 'jdx-classification-content')
  content.append(library, choose, preview, complete)
  dialog.append(top, subtitle, stepper, content, status, actions, keyGuide)
  doc.body.append(dialog)
  doc.addEventListener('keydown', event => { if (event.key === 'Escape' && !saving && !keyGuide.open) { controller?.abort(); doc.defaultView?.close() } })
  search.addEventListener('input', renderFolders)
  library.addEventListener('change', () => { void loadLibrary() })
  updateActions()
  return {
    async open(selectedIDs: number[]) {
      if (busy) { if (dialog.hidden) dialog.hidden = false; return }
      ids = [...selectedIDs]; controller?.abort(); rows = []; candidateIDs.clear(); collectionList.replaceChildren(); step = 0
      if (dialog.hidden) dialog.hidden = false
      busy = true; updateActions(); status.textContent = uiText('正在读取所选文献…', 'Reading selected papers…')
      try {
        items = await loadClassificationItems(host, ids)
        subtitle.textContent = uiText(`已选 ${items.length} 篇文献`, `${items.length} papers selected`)
        library.replaceChildren()
        for (const id of new Set(items.map(item => item.libraryID))) {
          const name = (host.Libraries as { get?: (id: number) => { name: string } } | undefined)?.get?.(id)?.name
          const option = make('option', name || uiText(`资料库 ${id}`, `Library ${id}`)); option.value = String(id); library.append(option)
        }
        library.hidden = library.options.length <= 1
        if (!items.length) { status.textContent = uiText('请先在 Zotero 中选择一个或多个文献条目；附件和笔记不参与分类。', 'Select one or more papers in Zotero. Attachments and notes are excluded.'); return }
        await loadLibrary()
      } catch { status.textContent = uiText('无法读取所选文献，请重试。', 'Could not read selected papers. Retry.') }
      finally { busy = false; updateActions() }
    },
    dispose() { generation++; controller?.abort(); dialog.remove() },
  }
}

/** 密钥配置只挂载到功能配置页，不创建分类界面。 */
export function mountClassificationSettings(doc: Document, host: ZoteroLike, root = doc.querySelector<HTMLElement>('[data-classification-settings-host]')) {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text; node.className = className; return node
  }
  const button = (text: string, action: () => void) => {
    const node = make('button', text); node.type = 'button'; node.addEventListener('click', action); return node
  }
  const settings = make('section', '', 'jdx-feature-model-row jdx-classification-settings')
  settings.dataset.featureGroup = 'classification'
  const title = make('h3', uiText('文献分类', 'Literature classification'))
  const note = make('p', uiText('独立使用 Jev，不跟随对话模型。选中文献后右键打开文献分类。仅将标题、摘要、标签及候选目录发送到 TypeSafe，不发送 PDF。', 'Uses Jev independently of the Chat model. Right-click selected papers to classify them. Only titles, abstracts, tags and candidate folders are sent to TypeSafe, never PDFs.'))
  const keyLabel = make('label', 'TypeSafe API Key'); keyLabel.htmlFor = 'jadense-typesafe-key'
  const key = make('input'); key.id = keyLabel.htmlFor; key.type = 'password'; key.autocomplete = 'off'; key.value = readTypesafeKey(host)
  const settingStatus = make('p', '', 'jdx-manager-inline-status'); settingStatus.setAttribute('role', 'status')
  let testAbort: AbortController | undefined
  const save = button(uiText('保存密钥', 'Save key'), () => {
    try {
      if (!host.Prefs) throw new Error()
      host.Prefs.set(TYPESAFE_KEY_PREF, key.value.trim(), true)
      settingStatus.textContent = key.value.trim() ? uiText('已保存到当前 Zotero 配置。', 'Saved in this Zotero profile.') : uiText('已清除密钥。', 'Key removed.')
    } catch { settingStatus.textContent = uiText('密钥保存失败，请重试。', 'Could not save the key. Retry.') }
  })
  const test = button(uiText('测试密钥', 'Test key'), () => { void (async () => {
    testAbort?.abort(); testAbort = new AbortController(); test.disabled = true
    settingStatus.textContent = uiText('正在使用固定示例测试密钥…', 'Testing the key with a fixed example…')
    try { await testTypesafeKey(key.value, testAbort.signal); settingStatus.textContent = uiText('密钥测试通过，可使用 Jev。请保存密钥。', 'Key test passed. Jev is available. Save your key.') }
    catch (error) { settingStatus.textContent = (error as Error).message }
    finally { test.disabled = false }
  })() })
  const getKey = button(uiText('获取 API 密钥 ↗', 'Get API key ↗'), () => {
    const launcher = host as ZoteroLike & { launchURL?: (url: string) => void }
    if (launcher.launchURL) launcher.launchURL(TYPESAFE_KEYS_URL)
    else doc.defaultView?.open(TYPESAFE_KEYS_URL, '_blank', 'noopener,noreferrer')
  })
  const settingActions = make('div', '', 'jdx-manager-actions jdx-classification-actions'); settingActions.append(save, test, getKey)
  const description = make('div'); description.append(title, note)
  const controls = make('div', '', 'jdx-manager-field jdx-pref-field')
  controls.append(keyLabel, key, settingActions, make('p', uiText('密钥仅保存在本机 Zotero 配置。测试会向 TypeSafe 发送一次固定示例请求，可能消耗额度。', 'The key stays in your local Zotero profile. Testing sends one fixed example to TypeSafe and may use credits.')), settingStatus)
  settings.append(description, controls)
  root?.append(settings)

  const observer = host.Prefs?.registerObserver?.(TYPESAFE_KEY_PREF, () => { key.value = readTypesafeKey(host) }, true)
  return () => { if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); testAbort?.abort(); key.value = ''; settings.remove() }
}
