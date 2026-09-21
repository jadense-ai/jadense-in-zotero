/** 全文翻译的首次成本与稳定性提示；Reader 和 Manager 共用 profile 确认记录。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export const TRANSLATION_WARNING_PREF = 'extensions.jadenseInZotero.fullTranslationWarningAcknowledged'

/** 全文翻译入口共用首次告知，取消发生在原文提取和翻译请求之前。 */
export function confirmFirstFullTranslation(host: ZoteroLike, win = host.getMainWindow?.()) {
  if (host.Prefs?.get(TRANSLATION_WARNING_PREF, true) !== true) {
    const accepted = win?.confirm(uiText('不推荐使用全文翻译\n\n全文翻译可能消耗较多积分，结果与稳定性也会受到文献长度和模型影响。建议阅读文献后自行判断需要精读的内容，使用选中翻译，这样更经济、更稳定。\n\n仍要继续全文翻译吗？', 'Full translation is not recommended\n\nIt can use more credits, and results and stability depend on document length and the model. Read the paper, decide which passages need close reading, and use selection translation for a more economical and stable workflow.\n\nContinue with full translation?'))
    if (!accepted) return false
    host.Prefs?.set?.(TRANSLATION_WARNING_PREF, true, true)
  }
  return true
}
