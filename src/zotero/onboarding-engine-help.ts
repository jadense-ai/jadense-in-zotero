/** 入门引导与引擎设置共用离线安装帮助；仅呈现已确认的公开渠道，不启动下载或安装。 */
import type { ZoteroLike } from './runtime'
import { RELEASES_URL, REPOSITORY_URL } from './manager-help'
import { uiText } from './ui-preferences'

/** GitHub 沿用工作台常量；网盘值来自公开分发配置及 2026-10-21 用户提供的百度新目录分享。 */
export const ONBOARDING_ENGINE_DOWNLOADS = [
  { id: 'github', url: RELEASES_URL, code: '' },
  { id: 'quark', url: 'https://pan.quark.cn/s/15513357f57d?pwd=H2RJ', code: 'H2RJ' },
  { id: 'baidu', url: 'https://pan.baidu.com/s/1YXrqXBao6uEA2BZKz1WlTw?pwd=4sci', code: '4sci' },
] as const

/** 可嵌入引导或设置页；调用方控制显示时机和销毁，外部链接始终交给系统浏览器。 */
export function appendOnboardingEngineHelp(doc: Document, host: ZoteroLike, root: HTMLElement) {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text
    return node
  }
  const element = make('section'); element.dataset.onboardingEngineHelp = ''
  element.className = 'jdx-settings-controls jdx-manager-settings-note jdx-pref-card-note'
  const title = make('h4', uiText('下载并导入离线引擎', 'Download and import offline engines'))
  const introduction = make('p', uiText(
    '在线准备遇到网络或下载问题时，可从以下渠道下载完整离线套装，或匹配当前插件版本的 OCR、PDF 版面解析引擎 ZIP。',
    'If online setup has network or download problems, use a channel below to get the complete offline kit, or OCR and PDF layout engine ZIP files matching your installed plugin.',
  ))
  const channels = make('ul')
  const status = make('p'); status.setAttribute('role', 'status'); status.style.overflowWrap = 'anywhere'
  let disposed = false
  const link = (label: string, url: string) => {
    const anchor = make('a', label); anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'
    anchor.addEventListener('click', event => {
      event.preventDefault()
      if (disposed) return
      try {
        const open = (host as ZoteroLike & { launchURL?: (url: string) => void }).launchURL
        if (!open) throw new Error('System browser unavailable')
        open.call(host, url)
        status.textContent = ''
      } catch {
        status.textContent = uiText('无法打开浏览器，请复制链接访问：', 'Could not open the browser. Copy this link: ') + url
      }
    })
    return anchor
  }
  for (const channel of ONBOARDING_ENGINE_DOWNLOADS) {
    const item = make('li'); item.dataset.engineDownloadChannel = channel.id
    const label = channel.id === 'github' ? 'GitHub Releases' : channel.id === 'quark' ? uiText('夸克网盘', 'Quark Drive') : uiText('百度网盘', 'Baidu Netdisk')
    if (channel.url) {
      item.append(link(label, channel.url))
      if (channel.code) item.append(make('span', uiText(` · 提取码：${channel.code}`, ` · Access code: ${channel.code}`)))
      const address = make('span', channel.url); address.style.display = 'block'; address.style.overflowWrap = 'anywhere'; address.style.userSelect = 'text'
      item.append(address)
    } else {
      item.textContent = label + uiText('：下载入口更新中，请先使用 GitHub 或夸克。', ': the download link is being updated. Use GitHub or Quark for now.')
    }
    channels.append(item)
  }
  const steps = make('ol')
  for (const text of [
    uiText('下载匹配的完整引擎包。若下载了完整离线套装，先解压套装，找到里面的两个引擎 ZIP；不要解压引擎 ZIP 本身。', 'Download matching complete engine packages. If you downloaded the offline kit, extract the kit to find its two engine ZIP files; leave the engine ZIP files compressed.'),
    uiText('进入「设置」的「外置依赖配置」，选择「OCR配置」或「版面解析引擎」，点击「导入离线包」并选择对应的引擎 ZIP。两个引擎需要分别导入。', 'Open External dependencies in Settings, choose OCR configuration or Layout parsing engine, then Import offline package and select the corresponding engine ZIP. Import each engine separately.'),
    uiText('等待导入及自动检测完成。需要再次确认时，OCR 点击「重新检查」，版面解析引擎点击「检测已安装引擎」；两项均显示已就绪后，回到入门引导继续。', 'Wait for import and automatic checks to finish. To verify again, choose Check again for OCR and Check installed engine for the layout engine. Return to onboarding after both report ready.'),
  ]) steps.append(make('li', text))
  const platform = make('p', uiText(
    '当前完整离线包适用于 Windows x64。其他系统请按安装指南准备兼容环境；不要使用不匹配的包。无需预装 Python。',
    'Complete offline packages currently support Windows x64. On other systems, follow the installation guides for a compatible environment. Do not use a mismatched package. The complete packages need no preinstalled Python.',
  ))
  const guides = make('div'); guides.className = 'jdx-manager-actions'
  guides.append(
    link(uiText('OCR 安装指南', 'OCR installation guide'), `${REPOSITORY_URL}/blob/main/docs/local-ocr.md`),
    link(uiText('PDF 版面解析引擎安装指南', 'PDF layout engine installation guide'), `${REPOSITORY_URL}/blob/main/docs/pdf-engine.md`),
  )
  element.append(title, introduction, channels, steps, platform, guides, status)
  root.append(element)
  return { element, dispose: () => { disposed = true; element.remove() } }
}
