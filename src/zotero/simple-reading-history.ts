/** 解析历史里的简阅版本：纯本地读取，打开与浏览不发起翻译。 */
import type { DocumentIdentity } from './pdf-document'
import type { ZoteroLike } from './runtime'
import { simpleReadingJobs } from './simple-reading-jobs'
import { openSavedSimpleReading } from './simple-reading'
import { action, element } from './ui/controls'
import { uiText } from './ui-preferences'

export function mountSimpleReadingHistory(root: HTMLElement, host: ZoteroLike, source: DocumentIdentity) {
  const jobs = simpleReadingJobs(host), doc = root.ownerDocument, status = element(doc, 'p'), list = element(doc, 'div')
  status.setAttribute('role', 'status')
  const open = (id?: string) => { void openSavedSimpleReading(host, source, id).catch(error => { status.textContent = error instanceof Error ? error.message : uiText('无法打开简阅。', 'Could not open reading mode.') }) }
  root.append(action(doc, uiText('打开简阅模式', 'Open reading mode'), () => open()), status, list)
  const refresh = () => {
    list.replaceChildren()
    const tasks = jobs.list().filter(task => task.source.itemID === source.itemID && task.source.libraryID === source.libraryID && task.source.itemKey === source.itemKey)
    if (!tasks.length) list.append(element(doc, 'p', '', uiText('尚无简阅译文。打开后点击翻译即可保存版本。', 'No reading translations yet. Open reading mode and click Translate to save a version.')))
    for (const task of tasks) {
      const row = element(doc, 'article', 'jdx-literature-event')
      row.append(action(doc, `${new Date(task.createdAt).toLocaleString()} · ${task.languages.targetLanguage} · ${Object.keys(task.outputs).length}/${task.total}`, () => open(task.id)))
      list.append(row)
    }
  }
  const unsubscribe = jobs.subscribe(refresh)
  refresh(); void jobs.load().catch(() => { status.textContent = uiText('简阅历史读取失败。', 'Could not read reading history.') })
  return { refresh, remove: unsubscribe }
}
