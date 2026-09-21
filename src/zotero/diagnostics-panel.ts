/** 帮助菜单诊断工作台：仅显示收集器的安全投影，通过本机文件选择器导出。 */
import { diagnostics, type DiagnosticRecord } from './diagnostics'
import { copyTextToClipboard } from './connection-display'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

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

export function wireDiagnosticsPanel(doc: Document, host: ZoteroLike | null, navigate: () => void, leave: () => void) {
  if (!host) return
  const store = diagnostics(host)!, win = doc.defaultView!
  const menu = doc.getElementById('jadense-help-menu'), version = doc.getElementById('jadense-help-version')
  const parent = doc.getElementById('jadense-manager-section-guide')?.parentElement
  if (!menu || !version || !parent) return
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const node = doc.createElement(tag); if (text) node.textContent = text; return node }
  const button = (text: string, action: () => void) => { const node = el('button',text); node.type = 'button'; node.addEventListener('click',action); return node }
  const entry = button(uiText('错误诊断','Error diagnostics'), () => { menu.hidden = true; navigate(); render(); heading.focus() })
  entry.id = 'jadense-help-diagnostics'; entry.setAttribute('role','menuitem'); menu.append(entry)
  const panel = el('section'); panel.id = 'jadense-manager-section-diagnostics'; panel.className = 'jdx-manager-section jdx-diagnostics'; panel.hidden = true
  const heading = el('h2',uiText('错误诊断','Error diagnostics')); heading.tabIndex = -1
  const notice = el('p',uiText('仅保存在本机，最多保留 7 天 / 500 条 / 2 MiB。异常退出可能丢失尚未写盘的末尾事件。','Stored locally, up to 7 days / 500 records / 2 MiB. Abrupt shutdown may lose unflushed events.'))
  const controls = el('div'); controls.className = 'jdx-diagnostic-controls'
  const select = (label: string, options: [string,string][]) => { const node = el('select'); node.setAttribute('aria-label',label); for (const [value,text] of options) { const option = el('option',text); option.value = value; node.append(option) } controls.append(node); node.addEventListener('change', () => { selected = ''; render() }); return node }
  const range = select(uiText('时间范围','Time range'),[['7',uiText('近 7 天','Last 7 days')],['1',uiText('近 24 小时','Last 24 hours')],['0.041667',uiText('近 1 小时','Last hour')]])
  const feature = select(uiText('功能','Feature'),[['',uiText('所有功能','All features')]])
  const category = select(uiText('错误类别','Category'),[['error',uiText('异常','Errors')],['cancelled',uiText('取消','Cancelled')],['business',uiText('业务拒绝','Business rejection')],['',uiText('全部','All')]])
  const search = el('input'); search.type = 'search'; search.placeholder = uiText('搜索请求 ID','Search request ID'); search.setAttribute('aria-label',search.placeholder); controls.append(search); search.addEventListener('input',() => { selected = ''; render() })
  const summary = el('p'), status = el('p'); status.setAttribute('role','status')
  const list = el('div'); list.className = 'jdx-diagnostic-list'
  const facts = el('div'); facts.className = 'jdx-diagnostic-facts'
  const raw = el('details'); raw.append(el('summary',uiText('原始脱敏记录','Sanitized record')))
  const detail = el('pre'); detail.className = 'jdx-diagnostic-detail'; detail.tabIndex = 0
  let selected = '', filtered: DiagnosticRecord[] = []
  const filters = () => ({ days: range.value, feature: feature.value, category: category.value, requestId: search.value })
  const exportRows = async (all: boolean) => {
    try { const saved = await saveDiagnosticExport(win,store.export(all ? store.list() : filtered,all ? {} : filters())); status.textContent = saved ? uiText('已导出脱敏诊断文件。','Sanitized diagnostics exported.') : '' }
    catch { status.textContent = uiText('无法导出文件，可复制单条诊断。','Unable to export. You can copy an individual record.') }
  }
  const actions = el('div'); actions.className = 'jdx-diagnostic-controls'
  const copy = button(uiText('复制本条','Copy record'), () => { const record = filtered.find(r => r.id === selected); if (record) void copyTextToClipboard(host,store.export([record])).then(ok => { status.textContent = ok ? uiText('已复制。','Copied.') : uiText('复制失败。','Copy failed.') }) })
  actions.append(copy,button(uiText('导出筛选结果','Export filtered'),() => { void exportRows(false) }),button(uiText('导出全部','Export all'),() => { void exportRows(true) }),button(uiText('清空记录','Clear records'),() => { void store.clear().then(() => { selected = ''; render(); status.textContent = uiText('记录已清空。','Records cleared.') }) }),button(uiText('返回对话','Back to chat'),() => { panel.hidden = true; leave() }))
  raw.append(detail); panel.append(heading,notice,controls,summary,actions,status,list,facts,raw); parent.append(panel)
  const style = el('style'); style.textContent = '.jdx-diagnostics{padding:20px;overflow:auto;min-width:0}.jdx-diagnostic-controls{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.jdx-diagnostic-controls input,.jdx-diagnostic-controls select{max-width:100%;min-width:100px;padding:6px;border-radius:5px}.jdx-diagnostic-controls button{padding:6px 10px;border-radius:5px}.jdx-diagnostic-facts{margin:16px 0;overflow-wrap:anywhere}.jdx-diagnostic-facts ol{padding-inline-start:22px}.jdx-diagnostic-facts li{margin:5px 0;font-size:12px}.jdx-diagnostic-list{display:grid;gap:4px;max-height:240px;overflow:auto}.jdx-diagnostic-list button{text-align:start;overflow-wrap:anywhere}.jdx-diagnostic-detail{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font-size:12px}.jdx-diagnostic-list button[aria-pressed=true]{outline:1px solid #16cf8c}'; doc.head.append(style)
  function render() {
    if (panel.hidden) return
    const rows = store.list()
    for (const value of new Set(rows.map(r => r.context.feature).filter(Boolean))) if (!Array.from(feature.options).some(o => o.value === value)) { const option = el('option',value); option.value = value; feature.append(option) }
    filtered = rows.filter(r => Date.parse(r.startedAt) >= Date.now() - Number(range.value)*86400000 && (!category.value || r.category === category.value) && (!feature.value || r.context.feature === feature.value) && (!search.value || [r.id,r.context.clientRequestId,r.context.transportAttemptId,r.context.taskId,r.context.operationId,r.context.conversationId].some(v => v?.includes(search.value))))
    if (!filtered.some(r => r.id === selected)) selected = filtered[0]?.id ?? ''
    summary.textContent = uiText(`显示 ${filtered.length} 条；故障 ${filtered.filter(r => r.category === 'error').length} 条。${store.storageAvailable ? '' : ' 本地写盘不可用，目前仅保存在内存。'}`, `Showing ${filtered.length}; errors ${filtered.filter(r => r.category === 'error').length}.${store.storageAvailable ? '' : ' Storage unavailable; memory only.'}`)
    list.replaceChildren(...filtered.map(row => { const node = button(`${new Date(row.startedAt).toLocaleString()} · ${row.context.feature ?? 'unknown'} · ${row.firstError?.code ?? row.firstError?.stage ?? row.category}`,() => { selected = row.id; render() }); node.setAttribute('aria-pressed',String(selected === row.id)); return node }))
    const row = filtered.find(r => r.id === selected)
    facts.replaceChildren()
    if (row) {
      const categoryText = { running: uiText('进行中','Running'), success: uiText('完成','Completed'), error: uiText('异常','Error'), cancelled: uiText('取消','Cancelled'), business: uiText('业务拒绝','Business rejection') }[row.category]
      facts.append(el('h3',uiText('请求时间线','Request timeline')),el('p',`${uiText('结果','Result')}: ${categoryText} · ${uiText('接收字节','Bytes received')}: ${row.bytes} · ${uiText('文本字符','Text characters')}: ${row.characters}`))
      facts.append(el('p',`${uiText('请求 ID','Request ID')}: ${row.context.clientRequestId ?? row.id}`))
      if (row.firstError) facts.append(el('p',`${uiText('首次异常','First error')}: ${row.firstError.stage} · ${row.firstError.code ?? row.firstError.name ?? 'unknown'}`))
      const timeline = el('ol')
      for (const event of row.events) timeline.append(el('li',`${new Date(event.at).toLocaleTimeString()} (+${Math.max(0,Date.parse(event.at)-Date.parse(row.startedAt))} ms) · ${event.stage}${event.source ? ' · '+event.source : ''}${event.code ? ' · '+event.code : ''}${event.status ? ' · HTTP '+event.status : ''}`))
      facts.append(timeline)
    }
    detail.textContent = selected ? store.export(filtered.filter(r => r.id === selected)) : uiText('没有符合条件的记录。','No matching records.'); copy.disabled = !selected
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
