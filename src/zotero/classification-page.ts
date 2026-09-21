/** 独立 chrome 页面只初始化文献分类与主题，不加载工作台、账号或对话功能。 */
import { mountClassification } from './classification-ui'
import type { ClassificationWindow } from './classification-window'
import { initializeUiLocale, observeTheme, uiText } from './ui-preferences'

const page = window as ClassificationWindow
function initialize() {
  const context = page.JadenseClassification ?? page.arguments?.[0]
  if (context) {
    initializeUiLocale(context.zotero)
    document.title = uiText('文献分类', 'Literature classification')
    const stopTheme = observeTheme(context.zotero, document.documentElement)
    const classification = mountClassification(document, context.zotero, context.openSettings)
    page.receiveClassificationItems = ids => { void classification.open(ids) }
    void classification.open(context.itemIDs)
    window.addEventListener('unload', () => { classification.dispose(); stopTheme(); page.receiveClassificationItems = undefined }, { once: true })
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true })
else initialize()
