/** 多渠道更新下载组件：统一维护百度网盘、夸克网盘与 GitHub 入口，供自动更新与手动检查共用。 */
import { getUiLocale, uiText, type UiLocale } from './ui-preferences'

export type UpdateChannelId = 'baidu' | 'quark' | 'github'

export type UpdateChannel = {
  id: UpdateChannelId
  name: string
  hint: string
  actionLabel: string
  url: string
  passcode?: string
  domesticRecommended: boolean
}

export const BAIDU_NETDISK_URL = 'https://pan.baidu.com/s/1YXrqXBao6uEA2BZKz1WlTw?pwd=4sci'
export const BAIDU_NETDISK_PASSCODE = '4sci'
export const QUARK_DRIVE_URL = 'https://pan.quark.cn/s/15513357f57d?pwd=H2RJ'
export const QUARK_DRIVE_PASSCODE = 'H2RJ'
export const DEFAULT_RELEASES_URL = 'https://github.com/jadense-ai/jadense-in-zotero/releases'

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** 校验并回退 GitHub 发布页链接，确保只打开固定仓库域名下的 HTTPS 地址。 */
function normalizeGithubUrl(url?: string): string {
  if (typeof url === 'string' && url.startsWith('https://github.com/jadense-ai/jadense-in-zotero/')) return url
  return DEFAULT_RELEASES_URL
}

/** 按当前界面语言排列三大下载渠道：中文环境优先呈现国内直连网盘，英文环境优先呈现 GitHub。 */
export function getUpdateDownloadChannels(githubUrl?: string, locale: UiLocale = getUiLocale()): UpdateChannel[] {
  const safeGithubUrl = normalizeGithubUrl(githubUrl)
  const baidu: UpdateChannel = {
    id: 'baidu',
    name: locale === 'zh-CN' ? '百度网盘' : 'Baidu Netdisk',
    hint: locale === 'zh-CN' ? '安装包与完整离线套装' : 'XPI & offline suite',
    actionLabel: locale === 'zh-CN' ? '前往下载' : 'Download',
    url: BAIDU_NETDISK_URL,
    passcode: BAIDU_NETDISK_PASSCODE,
    domesticRecommended: true,
  }
  const quark: UpdateChannel = {
    id: 'quark',
    name: locale === 'zh-CN' ? '夸克网盘' : 'Quark Drive',
    hint: locale === 'zh-CN' ? '安装包与完整离线套装' : 'XPI & offline suite',
    actionLabel: locale === 'zh-CN' ? '前往下载' : 'Download',
    url: QUARK_DRIVE_URL,
    passcode: QUARK_DRIVE_PASSCODE,
    domesticRecommended: true,
  }
  const github: UpdateChannel = {
    id: 'github',
    name: 'GitHub Releases',
    hint: locale === 'zh-CN' ? '官方发布页 · 更新日志与校验和' : 'Official release · Notes & checksums',
    actionLabel: locale === 'zh-CN' ? '打开发布页' : 'Open release',
    url: safeGithubUrl,
    domesticRecommended: false,
  }
  return locale === 'zh-CN' ? [baidu, quark, github] : [github, baidu, quark]
}

/** 生成渠道引导文案，明确提示中国大陆用户优先通过网盘下载并指引目标版本目录。 */
export function domesticChannelTip(version?: string, locale: UiLocale = getUiLocale()): string {
  const cleanVersion = typeof version === 'string' && version.trim() ? version.trim().replace(/^v/i, '') : ''
  if (locale === 'zh-CN') {
    return cleanVersion
      ? `中国大陆用户推荐优先使用百度或夸克网盘下载，连接更稳定；链接已带提取码，进入后选择 v${cleanVersion} 目录即可。`
      : '中国大陆用户推荐优先使用百度或夸克网盘下载，连接更稳定；链接已带提取码，进入后选择最新版本目录即可。'
  }
  return cleanVersion
    ? `In Mainland China? Use Baidu Netdisk or Quark Drive for faster downloads, then open folder v${cleanVersion}.`
    : 'In Mainland China? Use Baidu Netdisk or Quark Drive for faster, more reliable downloads.'
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text = ''): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K]
  if (text) node.textContent = text
  return node
}

function createSvg(doc: Document, viewBox: string, size: number, paths: Array<{ tag: 'path' | 'circle' | 'polyline' | 'line' | 'rect'; attrs: Record<string, string> }>, strokeWidth = '1.65'): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', strokeWidth)
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const item of paths) {
    const node = doc.createElementNS(SVG_NS, item.tag)
    for (const [key, value] of Object.entries(item.attrs)) node.setAttribute(key, value)
    svg.append(node)
  }
  return svg
}

/** 渠道语义图标：保持统一线条粗细与视觉体量，避免使用 Emoji 或字符替代。 */
function createChannelIcon(doc: Document, id: UpdateChannelId): SVGSVGElement {
  if (id === 'baidu') {
    return createSvg(doc, '0 0 20 20', 18, [
      { tag: 'path', attrs: { d: 'M6.2 15.2h8.2a3.3 3.3 0 0 0 .5-6.56A4.75 4.75 0 0 0 5.7 7.8a3.6 3.6 0 0 0 .5 7.4Z' } },
      { tag: 'path', attrs: { d: 'M10 9.6v3.7' } },
      { tag: 'path', attrs: { d: 'M8.4 11.9 10 13.5l1.6-1.6' } },
    ])
  }
  if (id === 'quark') {
    return createSvg(doc, '0 0 20 20', 18, [
      { tag: 'path', attrs: { d: 'M11.3 2.8 5.2 10.6h4.5l-1 6.6 6.1-7.8h-4.5l1-6.6Z' } },
    ])
  }
  return createSvg(doc, '0 0 20 20', 18, [
    { tag: 'path', attrs: { d: 'M7.5 15.8c-3.3 1-3.3-1.6-4.7-2m9.4 4v-3.2c0-.9-.2-1.5-.8-2 2.7-.3 5.5-1.3 5.5-5.7a4.4 4.4 0 0 0-1.2-3.1 4.1 4.1 0 0 0-.1-3s-1-.3-3.2 1.2a11.1 11.1 0 0 0-5.8 0C4.4.5 3.4.8 3.4.8a4.1 4.1 0 0 0-.1 3 4.4 4.4 0 0 0-1.2 3.1c0 4.4 2.8 5.4 5.5 5.7-.5.4-.8 1.1-.8 2v3.2' } },
  ], '1.5')
}

export function createExternalArrowIcon(doc: Document, size = 13): SVGSVGElement {
  return createSvg(doc, '0 0 16 16', size, [
    { tag: 'path', attrs: { d: 'M6 3.5h6.5V10' } },
    { tag: 'path', attrs: { d: 'M12.5 3.5 4.2 11.8' } },
  ], '1.7')
}

function createCopyIcon(doc: Document, size = 12): SVGSVGElement {
  return createSvg(doc, '0 0 16 16', size, [
    { tag: 'rect', attrs: { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.6' } },
    { tag: 'path', attrs: { d: 'M3.5 10.5H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5' } },
  ], '1.5')
}

function createCheckIcon(doc: Document, size = 12): SVGSVGElement {
  return createSvg(doc, '0 0 16 16', size, [
    { tag: 'path', attrs: { d: 'M3.2 8.4 6.4 11.6 12.8 4.8' } },
  ], '1.85')
}

function createTipIcon(doc: Document, size = 15): SVGSVGElement {
  return createSvg(doc, '0 0 16 16', size, [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '6.2' } },
    { tag: 'path', attrs: { d: 'M2.3 8h11.4' } },
    { tag: 'path', attrs: { d: 'M8 1.8c1.7 1.7 2.5 3.9 2.5 6.2S9.7 12.5 8 14.2c-1.7-1.7-2.5-3.9-2.5-6.2S6.3 3.5 8 1.8Z' } },
  ], '1.4')
}

/** 优先使用现代剪贴板 API，在 Zotero 特权文档中回退 Gecko 原生剪贴板服务。 */
async function copyText(doc: Document, value: string): Promise<boolean> {
  const win = doc.defaultView as (Window & {
    Components?: {
      classes?: Record<string, { getService(iface: unknown): { copyString(str: string): void } }>
      interfaces?: { nsIClipboardHelper?: unknown }
    }
  }) | null
  try {
    const clipboard = win?.navigator?.clipboard
    if (clipboard?.writeText) {
      await clipboard.writeText(value)
      return true
    }
  } catch { /* 回退原生剪贴板服务。 */ }
  try {
    const helper = win?.Components?.classes?.['@mozilla.org/widget/clipboardhelper;1']
      ?.getService(win.Components.interfaces?.nsIClipboardHelper)
    if (helper?.copyString) {
      helper.copyString(value)
      return true
    }
  } catch { /* 剪贴板不可用时保留可读提取码。 */ }
  return false
}

/** 共享渠道选择器样式：使用 light-dark 与低饱和度绿灰语义色，在 Manager 与 Reader 保持一致观感。 */
export const UPDATE_CHANNELS_STYLES = `
  .jdx-update-channels {
    container-type: inline-size;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .jdx-update-channels-heading {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    color: var(--jdx-text, light-dark(#111510, #edf2ee));
  }
  .jdx-update-channels-tip {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid light-dark(#bce8d3, #234937);
    border-radius: 9px;
    background: light-dark(#effaf4, #142a20);
    color: light-dark(#0c5b3d, #9be9c7);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .jdx-update-channels-tip-icon {
    flex: none;
    margin-top: 2px;
    color: light-dark(#0f7c56, #4fe3ab);
    display: inline-flex;
  }
  .jdx-update-channels-list {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--jdx-line, light-dark(#d9e2dd, #323f38));
    border-radius: 10px;
    background: var(--jdx-surface, light-dark(#ffffff, #1d2420));
    overflow: hidden;
  }
  .jdx-update-channel-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 13px;
    transition: background-color 140ms ease;
  }
  .jdx-update-channel-row + .jdx-update-channel-row {
    border-top: 1px solid var(--jdx-line, light-dark(#e3eae6, #2d3832));
  }
  .jdx-update-channel-row:hover {
    background: light-dark(#f6f9f7, #242e28);
  }
  .jdx-update-channel-icon {
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
  }
  .jdx-update-channel-icon[data-channel="baidu"] {
    background: light-dark(#edf3fc, #1a293d);
    border-color: light-dark(#d5e3f7, #273e5c);
    color: light-dark(#245bbd, #82b4ff);
  }
  .jdx-update-channel-icon[data-channel="quark"] {
    background: light-dark(#eef7f6, #172e2d);
    border-color: light-dark(#cfe7e5, #254846);
    color: light-dark(#156b6e, #6cd8dc);
  }
  .jdx-update-channel-icon[data-channel="github"] {
    background: light-dark(#f1f4f2, #26302b);
    border-color: light-dark(#dce3df, #38453e);
    color: light-dark(#242c27, #dbe4de);
  }
  .jdx-update-channel-body {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .jdx-update-channel-title-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  .jdx-update-channel-name {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--jdx-text, light-dark(#111510, #edf2ee));
  }
  .jdx-update-channel-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.5;
    background: light-dark(#e2f8ee, #153627);
    color: light-dark(#086241, #76efc0);
    white-space: nowrap;
  }
  .jdx-update-channel-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--jdx-muted, light-dark(#4e5e56, #9ab0a4));
  }
  .jdx-update-channel-hint {
    overflow-wrap: anywhere;
  }
  .jdx-update-channels button.jdx-update-channel-code {
    appearance: none;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: auto;
    min-height: 22px;
    margin: 0;
    padding: 1px 7px;
    border: 1px solid var(--jdx-line, light-dark(#d1ddd6, #394840));
    border-radius: 5px;
    background: light-dark(#f3f7f5, #222c26);
    color: var(--jdx-text, light-dark(#1d2a23, #dce8e1));
    font: 11.5px/1.35 system-ui, -apple-system, sans-serif;
    cursor: pointer;
    transition: border-color 140ms ease, background-color 140ms ease, color 140ms ease;
  }
  .jdx-update-channels button.jdx-update-channel-code code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
  .jdx-update-channels button.jdx-update-channel-code:hover {
    border-color: light-dark(#97b8a8, #4f6b5e);
    background: light-dark(#e9f3ee, #28362f);
  }
  .jdx-update-channels button.jdx-update-channel-code[data-copied="true"] {
    border-color: light-dark(#8fd8b8, #2c6b4f);
    background: light-dark(#e3f8ee, #153627);
    color: light-dark(#086241, #76efc0);
  }
  .jdx-update-channels button.jdx-update-channel-code:focus-visible {
    outline: 2px solid #16cf8c;
    outline-offset: 2px;
  }
  .jdx-update-channels button.jdx-update-channel-open {
    appearance: none;
    box-sizing: border-box;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: auto;
    min-height: 32px;
    margin: 0;
    padding: 6px 12px;
    border-radius: 7px;
    border: 1px solid var(--jdx-line-strong, light-dark(#c2d0c8, #3f4f47));
    background: var(--jdx-surface, light-dark(#ffffff, transparent));
    color: var(--jdx-text, light-dark(#111510, #e7eee9));
    font: 500 12.5px/1.35 system-ui, -apple-system, sans-serif;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }
  .jdx-update-channels button.jdx-update-channel-open:hover {
    background: light-dark(#edf2ef, #2b3630);
    border-color: light-dark(#95aaa0, #5b6f65);
  }
  .jdx-update-channels button.jdx-update-channel-open.recommended {
    background: light-dark(#e5f9f0, #16392a);
    border-color: light-dark(#9ee0c2, #275e46);
    color: light-dark(#075a3c, #7cf0c2);
    font-weight: 600;
  }
  .jdx-update-channels button.jdx-update-channel-open.recommended:hover {
    background: #16cf8c;
    border-color: #16cf8c;
    color: #0b1611;
  }
  .jdx-update-channels button.jdx-update-channel-open:focus-visible {
    outline: 2px solid #16cf8c;
    outline-offset: 2px;
  }
  @container (max-width: 390px) {
    .jdx-update-channel-row {
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px 10px;
      padding: 10px 11px;
    }
    .jdx-update-channels button.jdx-update-channel-open {
      width: 100%;
    }
  }
  @media (max-width: 440px) {
    .jdx-update-channel-row {
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 8px 10px;
      padding: 10px 11px;
    }
    .jdx-update-channels button.jdx-update-channel-open {
      width: 100%;
    }
  }
`

export type DownloadChannelsPanelOptions = {
  version?: string
  githubUrl?: string
  locale?: UiLocale
  onOpen: (channel: UpdateChannel) => void
  onCopyPasscode?: (channel: UpdateChannel, copied: boolean) => void
}

/** 构造三渠道下载面板（含国内网盘推荐提示、一键复制提取码及外部打开动作），返回根节点与定时器清理函数。 */
export function createDownloadChannelsPanel(doc: Document, options: DownloadChannelsPanelOptions): { element: HTMLElement; cleanup: () => void } {
  const locale = options.locale ?? getUiLocale()
  const channels = getUpdateDownloadChannels(options.githubUrl, locale)
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const section = el(doc, 'section')
  section.className = 'jdx-update-channels'
  section.setAttribute('aria-label', locale === 'zh-CN' ? '下载渠道' : 'Download channels')

  const heading = el(doc, 'h3', locale === 'zh-CN' ? '选择下载渠道' : 'Choose a download channel')
  heading.className = 'jdx-update-channels-heading'

  const tip = el(doc, 'p')
  tip.className = 'jdx-update-channels-tip'
  const tipIcon = el(doc, 'span')
  tipIcon.className = 'jdx-update-channels-tip-icon'
  tipIcon.append(createTipIcon(doc))
  const tipCopy = el(doc, 'span', domesticChannelTip(options.version, locale))
  tip.append(tipIcon, tipCopy)

  const list = el(doc, 'div')
  list.className = 'jdx-update-channels-list'

  for (const channel of channels) {
    const row = el(doc, 'div')
    row.className = 'jdx-update-channel-row'
    row.dataset.channel = channel.id

    const iconWrap = el(doc, 'span')
    iconWrap.className = 'jdx-update-channel-icon'
    iconWrap.dataset.channel = channel.id
    iconWrap.append(createChannelIcon(doc, channel.id))

    const body = el(doc, 'div')
    body.className = 'jdx-update-channel-body'

    const titleLine = el(doc, 'div')
    titleLine.className = 'jdx-update-channel-title-line'
    const name = el(doc, 'span', channel.name)
    name.className = 'jdx-update-channel-name'
    titleLine.append(name)

    if (channel.domesticRecommended) {
      const badge = el(doc, 'span', locale === 'zh-CN' ? '国内推荐' : 'CN mirror')
      badge.className = 'jdx-update-channel-badge'
      titleLine.append(badge)
    }

    const meta = el(doc, 'div')
    meta.className = 'jdx-update-channel-meta'
    const hint = el(doc, 'span', channel.hint)
    hint.className = 'jdx-update-channel-hint'
    meta.append(hint)

    if (channel.passcode) {
      const codeButton = el(doc, 'button')
      codeButton.type = 'button'
      codeButton.className = 'jdx-update-channel-code'
      codeButton.dataset.passcode = channel.passcode
      const copyTooltip = locale === 'zh-CN' ? `点击复制提取码 ${channel.passcode}` : `Copy extraction code ${channel.passcode}`
      codeButton.title = copyTooltip
      codeButton.setAttribute('aria-label', copyTooltip)

      const labelPrefix = el(doc, 'span', locale === 'zh-CN' ? '提取码' : 'Code')
      const codeValue = el(doc, 'code', channel.passcode)
      const iconHolder = el(doc, 'span')
      iconHolder.style.display = 'inline-flex'
      iconHolder.append(createCopyIcon(doc))
      codeButton.append(labelPrefix, codeValue, iconHolder)

      let resetTimer: ReturnType<typeof setTimeout> | undefined
      codeButton.addEventListener('click', () => {
        void copyText(doc, channel.passcode!).then(copied => {
          if (copied) {
            codeButton.dataset.copied = 'true'
            labelPrefix.textContent = locale === 'zh-CN' ? '已复制' : 'Copied'
            iconHolder.replaceChildren(createCheckIcon(doc))
            if (resetTimer) { clearTimeout(resetTimer); timers.delete(resetTimer) }
            resetTimer = setTimeout(() => {
              delete codeButton.dataset.copied
              labelPrefix.textContent = locale === 'zh-CN' ? '提取码' : 'Code'
              iconHolder.replaceChildren(createCopyIcon(doc))
              if (resetTimer) timers.delete(resetTimer)
            }, 2000)
            timers.add(resetTimer)
          }
          options.onCopyPasscode?.(channel, copied)
        })
      })
      meta.append(codeButton)
    }

    body.append(titleLine, meta)

    const openButton = el(doc, 'button')
    openButton.type = 'button'
    const emphasize = locale === 'zh-CN' ? channel.domesticRecommended : channel.id === 'github'
    openButton.className = emphasize ? 'jdx-update-channel-open recommended' : 'jdx-update-channel-open'
    openButton.dataset.channelOpen = channel.id
    openButton.setAttribute(
      'aria-label',
      locale === 'zh-CN' ? `通过${channel.name}下载更新` : `Download update via ${channel.name}`,
    )
    openButton.append(el(doc, 'span', channel.actionLabel), createExternalArrowIcon(doc))
    openButton.addEventListener('click', () => options.onOpen(channel))

    row.append(iconWrap, body, openButton)
    list.append(row)
  }

  section.append(heading, tip, list)
  return {
    element: section,
    cleanup: () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}

/** 渠道打开后的用户可读提示，包含网盘提取码提醒。 */
export function channelOpenedMessage(channel: UpdateChannel): string {
  if (channel.passcode) {
    return uiText(
      `已在浏览器打开${channel.name}（提取码 ${channel.passcode}），下载 .xpi 后在 Zotero「工具 → 插件」覆盖安装。`,
      `Opened ${channel.name} in your browser (code: ${channel.passcode}). Install the .xpi via Zotero Tools → Add-ons.`,
    )
  }
  return uiText(
    `已在浏览器打开 ${channel.name}，下载 .xpi 后在 Zotero「工具 → 插件」覆盖安装。`,
    `Opened ${channel.name} in your browser. Install the .xpi via Zotero Tools → Add-ons.`,
  )
}
