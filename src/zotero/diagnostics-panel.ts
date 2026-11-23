/** 帮助菜单诊断工作台：仅显示收集器的安全投影，通过本机文件选择器导出。 */
import { diagnostics, type DiagnosticRecord } from './diagnostics'
import { copyTextToClipboard } from './connection-display'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { action, element } from './ui/controls'

/** 五秒内五次激活；间隔超窗后从当前点击重新计数。 */
export function diagnosticGesture(open: () => void, now = Date.now) {
  let clicks: number[] = []
  return () => { const at = now(); clicks = clicks.filter(t => at - t <= 5000); clicks.push(at); if (clicks.length >= 5) { clicks = []; open() } }
}
type Picker = { init(win: Window, title: string, mode: number): void; modeSave: number; returnCancel: number; defaultString: string; defaultExtension: string; file: string; appendFilter(title: string, filter: string): void; show(): Promise<number> }
type ExportPlatform = { ChromeUtils: { importESModule(url: string): { FilePicker: new () => Picker } }; IOUtils: { writeUTF8(path: string, text: string, options: { tmpPath: string }): Promise<unknown> } }
export async function saveDiagnosticExport(win: Window, text: string, platform = win as unknown as ExportPlatform) {
  const { FilePicker } = platform.ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs')
  const picker = new FilePicker()
  picker.init(win, uiText('导出错误诊断', 'Export diagnostics'), picker.modeSave)
  picker.defaultString = `jadense-diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}.json`
  picker.defaultExtension = 'json'; picker.appendFilter('JSON', '*.json')
  if (await picker.show() === picker.returnCancel) return false
  await platform.IOUtils.writeUTF8(picker.file, text, { tmpPath: `${picker.file}.tmp` }); return true
}

const features: Record<string, [string, string]> = {
  chat: ['AI 对话', 'AI Chat'],
  analysis: ['文献解析', 'Literature analysis'],
  'paper-analysis-runner': ['文献解析', 'Literature analysis'],
  'paper-analysis-summary': ['解析总结', 'Analysis summary'],
  translation: ['翻译', 'Translation'],
  account: ['攻玉账号', 'Jadense account'],
  upload: ['文献上传', 'Literature upload'],
  ocr: ['文字识别', 'OCR'],
  figure: ['图片解读', 'Figure interpretation'],
  'reader-translation': ['阅读器翻译', 'Reader translation'],
  'pdf-translation': ['对照翻译', 'Bilingual PDF'],
  'document-jobs': ['文献任务', 'Document tasks'],
  'ocr-settings': ['OCR 配置', 'OCR settings'],
  manager: ['工作台', 'Workbench'],
  preferences: ['插件设置', 'Preferences'],
  initialization: ['插件启动', 'Plugin startup'],
  recovery: ['请求恢复', 'Request recovery'],
}

function featureLabel(value?: string) {
  const label = value && Object.hasOwn(features, value) ? features[value] : undefined
  return label ? uiText(...label) : value?.replace(/[-_]/g, ' ') || uiText('其他功能', 'Other feature')
}

function outcome(row: DiagnosticRecord) {
  const labels = {
    running: uiText('进行中', 'Running'), success: uiText('完成', 'Completed'),
    error: uiText('异常', 'Error'), cancelled: uiText('取消', 'Cancelled'),
    business: uiText('业务拒绝', 'Business rejection'),
  }
  if (row.category !== 'error' || !row.firstError) return labels[row.category]
  const stages: Record<string, string> = {
    history_save: uiText('历史记录保存失败', 'Could not save history'),
    annotation_save: uiText('批注写入失败', 'Could not save annotations'),
    fetch_error: uiText('网络请求失败', 'Network request failed'),
    provider_failed: uiText('服务商请求失败', 'Provider request failed'),
    resources: uiText('组件资源检查失败', 'Component resource check failed'),
    environment: uiText('运行环境检查失败', 'Environment check failed'),
  }
  const error = row.firstError
  if (Object.hasOwn(stages, error.stage)) return stages[error.stage]
  if (error.name === 'TimeoutError') return uiText('请求超时', 'Request timed out')
  return error.status ? uiText(`请求失败 · HTTP ${error.status}`, `Request failed · HTTP ${error.status}`) : uiText('执行异常', 'Execution error')
}

/** 管理筛选、当前记录和全部记录三个操作范围；渲染只读取收集器的脱敏投影。 */
export function wireDiagnosticsPanel(doc: Document, host: ZoteroLike | null, navigate: () => void, leave: () => void) {
  if (!host) return
  const store = diagnostics(host)!, win = doc.defaultView!
  const menu = doc.getElementById('jadense-help-menu'), version = doc.getElementById('jadense-help-version')
  const parent = doc.getElementById('jadense-manager-section-guide')?.parentElement
  if (!menu || !version || !parent) return
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className = '') => element(doc, tag, className, text)
  const button = (label: string, run: () => void) => action(doc, label, run)
  const entry = button(uiText('错误诊断','Error diagnostics'), () => { menu.hidden = true; navigate(); render(); heading.focus() })
  entry.id = 'jadense-help-diagnostics'; entry.setAttribute('role','menuitem'); menu.append(entry)
  const panel = el('section', undefined, 'jdx-manager-section jdx-diagnostics')
  panel.id = 'jadense-manager-section-diagnostics'; panel.hidden = true
  const heading = el('h2', uiText('错误诊断', 'Error diagnostics')); heading.tabIndex = -1
  panel.setAttribute('aria-label', heading.textContent!)
  const header = el('header', undefined, 'jdx-diagnostic-heading')
  header.append(heading, button(uiText('返回对话', 'Back to chat'), () => { panel.hidden = true; leave() }))
  const notice = el('p', uiText('记录仅保存在本机，最多保留 7 天、500 条、2 MiB。异常退出时，最近的事件可能尚未保存。', 'Records stay on this device for up to 7 days, 500 records or 2 MiB. Recent events may be lost after an abrupt exit.'), 'jdx-diagnostic-note')

  let selected = '', filtered: DiagnosticRecord[] = []
  const controls = el('div', undefined, 'jdx-diagnostic-filters')
  const select = (label: string, options: [string,string][]) => {
    const field = el('label', label), node = el('select')
    for (const [value, text] of options) { const option = el('option', text); option.value = value; node.append(option) }
    field.append(node); controls.append(field); node.addEventListener('change', render)
    return node
  }
  const range = select(uiText('时间范围','Time range'), [['7',uiText('近 7 天','Last 7 days')],['1',uiText('近 24 小时','Last 24 hours')],['0.041667',uiText('近 1 小时','Last hour')]])
  const feature = select(uiText('功能','Feature'), [['',uiText('所有功能','All features')]])
  const category = select(uiText('类别','Category'), [['error',uiText('异常','Errors')],['cancelled',uiText('取消','Cancelled')],['business',uiText('业务拒绝','Business rejection')],['',uiText('全部','All')]])
  const searchField = el('label', uiText('请求 ID', 'Request ID')), search = el('input')
  search.type = 'search'; searchField.append(search); controls.append(searchField); search.addEventListener('input', render)
  const filters = () => ({ days: range.value, feature: feature.value, category: category.value, requestId: search.value })

  function feedback() {
    const node = el('p', undefined, 'jdx-diagnostic-feedback')
    node.setAttribute('role', 'status')
    return node
  }
  const exportFeedback = feedback(), recordFeedback = feedback(), managementFeedback = feedback()
  const diskNotice = el('p', uiText('本地写盘不可用，当前记录仅保存在内存中。','Local storage is unavailable. These records are held in memory only.'), 'jdx-diagnostic-note')
  const exportRows = async (all: boolean) => {
    const status = all ? managementFeedback : exportFeedback
    try {
      const saved = await saveDiagnosticExport(win, store.export(all ? store.list() : filtered, all ? {} : filters()))
      status.textContent = saved ? uiText('已导出脱敏诊断文件。', 'Sanitized diagnostics exported.') : ''
    } catch { status.textContent = uiText('无法导出文件，可复制单条诊断。','Unable to export. You can copy an individual record.') }
  }
  const resultBar = el('div', undefined, 'jdx-diagnostic-heading'), count = el('h3')
  const exportFiltered = button('', () => { void exportRows(false) })
  resultBar.append(count, exportFiltered)
  const list = el('div', undefined, 'jdx-diagnostic-list')
  const empty = el('div', undefined, 'jdx-diagnostic-empty'), emptyText = el('p')
  const reset = button(uiText('清除筛选', 'Clear filters'), () => {
    range.value = '7'; feature.value = ''; category.value = ''; search.value = ''
    render(); search.focus()
  })
  empty.append(emptyText, reset)

  const facts = el('section', undefined, 'jdx-diagnostic-facts'), factHeading = el('div', undefined, 'jdx-diagnostic-heading')
  const title = el('h3'), identity = el('p'), cause = el('p'), metrics = el('p', undefined, 'jdx-diagnostic-note')
  const copy = button(uiText('复制本条', 'Copy record'), () => {
    const row = filtered.find(record => record.id === selected)
    if (row) void copyTextToClipboard(host, store.export([row])).then(ok => {
      if (selected === row.id) recordFeedback.textContent = ok ? uiText('已复制本条诊断。','Record copied.') : uiText('复制失败。','Copy failed.')
    })
  })
  factHeading.append(title, copy)
  const timeline = el('ol'), raw = el('details'), detail = el('pre', undefined, 'jdx-diagnostic-detail')
  detail.tabIndex = 0; raw.append(el('summary', uiText('原始脱敏记录', 'Sanitized record')), detail)
  facts.append(factHeading, recordFeedback, cause, identity, metrics, el('h4', uiText('请求时间线', 'Request timeline')), timeline, raw)

  const manage = el('section', undefined, 'jdx-diagnostic-manage'), allActions = el('div', undefined, 'jdx-diagnostic-heading')
  const danger = el('div', undefined, 'jdx-diagnostic-clear')
  const exportAll = button(uiText('导出全部', 'Export all'), () => { void exportRows(true) })
  const clearAll = button('', () => {
    void store.clear().then(() => { render(); managementFeedback.textContent = uiText('已清空全部本机诊断记录。', 'All local diagnostic records cleared.') })
  })
  clearAll.classList.add('jdx-manager-danger')
  allActions.append(el('h3', uiText('本机记录管理', 'Manage local records')), exportAll)
  danger.append(clearAll)
  manage.append(allActions, danger, managementFeedback)
  panel.append(header, notice, controls, diskNotice, resultBar, exportFeedback, list, empty, facts, manage)
  parent.append(panel)

  const rowButtons = new Map<string, HTMLButtonElement>()
  function render() {
    if (panel.hidden) return
    const rows = store.list()
    const knownFeatures = new Set(Array.from(feature.options, option => option.value))
    for (const value of new Set(rows.map(row => row.context.feature).filter(Boolean))) {
      if (!knownFeatures.has(value)) { const option = el('option', featureLabel(value)); option.value = value; feature.append(option) }
    }
    const since = Date.now() - Number(range.value) * 86400000, query = search.value.trim()
    filtered = rows.filter(row => Date.parse(row.startedAt) >= since &&
      (!category.value || row.category === category.value) && (!feature.value || row.context.feature === feature.value) &&
      (!query || [row.id, ...['clientRequestId','transportAttemptId','taskId','operationId','conversationId','requestId','executionId','diagnosticId'].map(key => row.context[key])].some(value => value?.includes(query))))
    const row = filtered.find(item => item.id === selected) ?? filtered[0]
    const nextId = row?.id ?? ''
    if (selected !== nextId) recordFeedback.textContent = ''
    selected = nextId
    const n = filtered.length
    count.textContent = uiText(`筛选结果（${n}）`, `Results (${n})`)
    exportFiltered.textContent = uiText(`导出当前筛选的 ${n} 条`, `Export ${n} filtered records`)
    clearAll.textContent = uiText(`清空全部 ${rows.length} 条本机记录`, `Clear all ${rows.length} local records`)
    exportFiltered.disabled = !n; exportAll.disabled = clearAll.disabled = !rows.length
    diskNotice.hidden = store.storageAvailable; list.hidden = !n; empty.hidden = !!n; reset.hidden = !rows.length
    emptyText.textContent = rows.length ? uiText('当前筛选无匹配记录。','No records match these filters.') : uiText('本机暂无诊断记录。','No diagnostic records on this device.')

    // 原地更新和插入，后台新增记录时保持现有按钮及其键盘焦点。
    let next = list.firstElementChild
    const visible = new Set(filtered.map(item => item.id))
    const focused = doc.activeElement
    for (const item of filtered) {
      let node = rowButtons.get(item.id)
      if (!node) {
        const id = item.id
        node = button('', () => {
          if (selected !== id) recordFeedback.textContent = ''
          selected = id; render()
        })
        node.append(el('strong'), el('time')); rowButtons.set(id, node)
      }
      const summary = featureLabel(item.context.feature) + ' · ' + outcome(item)
      if (node.firstElementChild!.textContent !== summary) node.firstElementChild!.textContent = summary
      const date = node.lastElementChild as HTMLTimeElement
      if (date.dateTime !== item.startedAt) { date.dateTime = item.startedAt; date.textContent = new Date(item.startedAt).toLocaleString() }
      node.setAttribute('aria-pressed', String(item.id === selected))
      if (node !== next) list.insertBefore(node, next)
      next = node.nextElementSibling
    }
    for (const [id, node] of rowButtons) if (!visible.has(id)) { node.remove(); rowButtons.delete(id) }
    if (focused && focused !== doc.activeElement && list.contains(focused)) (focused as HTMLElement).focus({ preventScroll: true })
    facts.hidden = !row
    if (!row) { detail.textContent = ''; timeline.replaceChildren(); return }
    title.textContent = featureLabel(row.context.feature) + ' · ' + outcome(row)
    identity.textContent = uiText('请求 ID', 'Request ID') + ' · ' + (row.context.clientRequestId ?? row.id)
    cause.hidden = !row.firstError
    cause.textContent = row.firstError ? [uiText('首次异常','First error'), row.firstError.stage, row.firstError.code ?? row.firstError.name].filter(Boolean).join(' · ') : ''
    metrics.textContent = uiText(`接收 ${row.bytes} 字节 · ${row.characters} 个文本字符`, `${row.bytes} bytes received · ${row.characters} text characters`)
    timeline.replaceChildren(...row.events.map(event => el('li', [new Date(event.at).toLocaleTimeString() + ` (+${Math.max(0, Date.parse(event.at) - Date.parse(row.startedAt))} ms)`, event.stage, event.source, event.code, event.status && 'HTTP ' + event.status].filter(Boolean).join(' · '))))
    detail.textContent = store.export([row])
  }
  const activate = diagnosticGesture(() => { store.setEnabled(true); (doc.getElementById('jadense-help-dialog') as HTMLDialogElement)?.close(); navigate(); render(); heading.focus() })
  version.tabIndex = 0; version.setAttribute('role','button'); version.addEventListener('click',() => { if (!doc.getElementById('jadense-help-description')?.hidden) activate() })
  version.addEventListener('keydown',event => { if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) { event.preventDefault(); if (!doc.getElementById('jadense-help-description')?.hidden) activate() } })
  const unsubscribe = store.subscribe(render)
  const onError = (event: ErrorEvent) => store.record('manager','unhandled_error',event.error)
  const onRejection = (event: PromiseRejectionEvent) => store.record('manager','unhandled_rejection',event.reason)
  win.addEventListener('error',onError); win.addEventListener('unhandledrejection',onRejection)
  win.addEventListener('unload',() => { unsubscribe(); win.removeEventListener('error',onError); win.removeEventListener('unhandledrejection',onRejection) },{ once: true })
}
