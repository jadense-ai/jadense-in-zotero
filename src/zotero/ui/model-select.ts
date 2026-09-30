/** 模型选择统一沿用对话输入框的外观；目录、思考能力和保存行为由宿主接入。 */
import { createJdxSelect } from './select'
import { uiText } from '../ui-preferences'

/** Reader 可将弹层挂至宿主文档，避免侧栏裁切；其他入口保持原有生命周期。 */
export function createModelSelect(host: HTMLElement, input: { ariaLabel: string; portal?: boolean }) {
  host.classList.add('jdx-model-select')
  return createJdxSelect(host, {
    ...input,
    showSelectedIcon: true,
    compact: true,
    popupWidth: 304,
    searchPlaceholder: uiText('搜索路由、模型或能力', 'Search routes, models, or capabilities'),
  })
}
