/** 解析历史里的简阅版本：纯本地读取，打开与浏览不发起翻译。 */
import type { DocumentIdentity } from './pdf-document'
import type { ZoteroLike } from './runtime'
import { simpleReadingJobs } from './simple-reading-jobs'
import { openSavedSimpleReading } from './simple-reading'
import { action, element } from './ui/controls'
import { uiText } from './ui-preferences'
import { translationLanguageDisplayLabel } from '@/chat/translation-languages'

export function mountSimpleReadingHistory(root: HTMLElement, host: ZoteroLike, source: DocumentIdentity) {
  const jobs = simpleReadingJobs(host), doc = root.ownerDocument, status = element(doc, 'p'), list = element(doc, 'div')
  status.setAttribute('role', 'status')
  const open = (id: string) => { void openSavedSimpleReading(host, source, id).catch(error => { status.textContent = error instanceof Error ? error.message : uiText('无法打开简阅。', 'Could not open reading mode.') }) }
  root.append(status, list)
  let disposed = false
  const refresh = () => {
    if (disposed) return
    list.replaceChildren()
    const tasks = jobs.list().filter(task => task.source.itemID === source.itemID && task.source.libraryID === source.libraryID && task.source.itemKey === source.itemKey)
    if (!tasks.length) list.append(element(doc, 'p', 'jdx-result-empty', uiText('尚无简阅译文。打开上方的「简阅模式」，点击翻译即可保存版本。', 'No reading translations yet. Open Reading mode above and click Translate to save a version.')))
    for (const task of tasks) {
      const row = element(doc, 'article', 'jdx-literature-event')
      const heading = element(doc, 'div', 'jdx-literature-event-heading'), count = Object.keys(task.outputs).length
      const version = action(doc, translationLanguageDisplayLabel(task.languages.targetLanguage), () => open(task.id))
      version.classList.add('jdx-literature-event-title')
      const date = new Date(task.createdAt).toLocaleString()
      version.setAttribute('aria-label', uiText(`打开${version.textContent}简阅译文，${date}`, `Open ${version.textContent} reading translation, ${date}`))
      heading.append(version, element(doc, 'time', '', date))
      row.append(heading, element(doc, 'p', 'jdx-literature-meta', uiText(`已译 ${count}/${task.total} 个内容块`, `${count}/${task.total} blocks translated`)))
      list.append(row)
    }
  }
  const unsubscribe = jobs.subscribe(refresh)
  async function load() {
    status.replaceChildren()
    try { await jobs.load() } catch {
      if (disposed) return
      if (!list.querySelector('article')) list.replaceChildren()
      status.append(doc.createTextNode(uiText('暂时无法读取简阅译文。', 'Reading translations could not be loaded.')), action(doc, uiText('重试读取', 'Retry loading'), () => { void load() }))
    }
  }
  refresh(); void load()
  return { refresh, remove() { disposed = true; unsubscribe() } }
}
