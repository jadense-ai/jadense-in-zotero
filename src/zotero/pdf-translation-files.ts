import { pdfCoverageText, pdfModeLabel } from './pdf-translation-policy'
/** 翻译文件历史：只展示已有本地产物，打开指定版本或调用现有 PDF 导出，不启动翻译。 */
import type { DocumentIdentity } from './pdf-document'
import type { ZoteroLike } from './runtime'
import { pdfTranslationJobs, type PDFTranslationTask } from './pdf-translation-jobs'
import { openSavedPDFTranslation } from './pdf-translation-reader'
import { sameAttachment } from './document-results'
import { translationLanguageDisplayLabel } from '@/chat/translation-languages'
import { action, badge, element, notice } from './ui/controls'
import { uiText } from './ui-preferences'

export function pdfFileStatus(task: PDFTranslationTask) {
  return task.status === 'partial' ? uiText('部分完成', 'Partially translated') : task.status === 'complete' ? uiText('已保存', 'Saved')
    : task.status === 'queued' || task.status === 'running' ? uiText('进行中', 'Running') : uiText('未完成', 'Incomplete')
}

/** 以完整附件身份过滤；异步动作失败仅在本页显示。 */
export function mountPDFTranslationFiles(root: HTMLElement, host: ZoteroLike, source: DocumentIdentity, selectedID?: string) {
  const doc = root.ownerDocument, jobs = pdfTranslationJobs(host), status = notice(doc), list = element(doc, 'div')
  root.append(status, list)
  let disposed = false, signature = '', busy = false
  const perform = async (button: HTMLButtonElement, work: () => Promise<unknown>) => {
    if (busy) return
    const enabled = Array.from(list.querySelectorAll<HTMLButtonElement>('button')).filter(control => !control.disabled)
    busy = true; button.disabled = true; enabled.forEach(control => { control.disabled = true }); status.textContent = ''
    try { await work() } catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : String(error) }
    finally { busy = false; if (!disposed) { enabled.forEach(control => { control.disabled = false }); refresh() } }
  }
  function refresh() {
    if (disposed || busy) return
    const tasks = jobs.list().filter(task => sameAttachment(task.source, source))
    const next = JSON.stringify(tasks.map(task => [task.id, task.status, task.error, task.pages, task.createdAt, task.artifact?.revision]))
    if (next === signature) return
    signature = next; list.replaceChildren()
    for (const task of tasks) {
      const row = element(doc, 'article', 'jdx-literature-event'), heading = element(doc, 'div', 'jdx-literature-event-heading')
      row.dataset.pdfTaskId = task.id
      if (task.id === selectedID) row.setAttribute('aria-current', 'true')
      heading.append(element(doc, 'strong', '', `${translationLanguageDisplayLabel(task.languages.sourceLanguage)} → ${translationLanguageDisplayLabel(task.languages.targetLanguage)}`), badge(doc, pdfFileStatus(task), task.status === 'complete' ? 'complete' : 'neutral'))
      const date = task.createdAt && Number.isFinite(Date.parse(task.createdAt)) ? new Date(task.createdAt).toLocaleString() : uiText('历史记录（时间未知）', 'Historical record (date unknown)')
      row.append(heading, element(doc, 'p', 'jdx-literature-meta', `${date} · ${task.pages} ${uiText('页', 'pages')}`))
      row.append(element(doc, 'p', 'jdx-literature-meta', `${pdfModeLabel(task.mode ?? 'full')} · ${pdfCoverageText(task.artifact?.coverage ?? task.coverage)}`))
      if (task.error) row.append(element(doc, 'p', 'jdx-notice', task.error))
      const controls = element(doc, 'div', 'jdx-actions')
      const open = action(doc, uiText('打开对照翻译', 'Open bilingual PDF'), () => { void perform(open, () => openSavedPDFTranslation(host, task.id)) })
      controls.append(open)
      for (const [kind, label] of [['mono', uiText('导出译文 PDF', 'Export translated PDF')], ['dual', uiText('导出双语 PDF', 'Export bilingual PDF')]] as const) {
        const save = action(doc, label, () => { void perform(save, () => jobs.export(task.id, kind, doc.defaultView!)) })
        save.disabled = !jobs.hasOutput(task); controls.append(save)
      }
      if (task.status !== 'complete') { const retry = action(doc, uiText('补译未完成部分', 'Translate remaining passages'), () => jobs.retry(task.id)); retry.disabled = jobs.isActive(task.id); controls.append(retry) }
      open.disabled = !jobs.hasOutput(task); row.append(controls); list.append(row)
    }
    if (!tasks.length) list.append(element(doc, 'p', 'jdx-result-empty', uiText('暂无翻译文件。请在 PDF 阅读器工具条中使用“对照翻译”，完成后会自动显示在这里。', 'No translated files yet. Use Bilingual PDF in the PDF reader toolbar. Completed files appear here automatically.')))
  }
  refresh()
  return { refresh, remove() { disposed = true } }
}
