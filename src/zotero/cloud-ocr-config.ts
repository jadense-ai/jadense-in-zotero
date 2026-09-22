/** 云 OCR 配置与凭证：偏好仅存公开参数，密钥由 Gecko 登录管理器或宿主会话保存。 */
import type { ZoteroLike } from './runtime'

export const OCR_ENGINE_PREF = 'extensions.jadenseInZotero.ocrEngine'
const PREFIX = 'extensions.jadenseInZotero.cloudOCR.'
export const CLOUD_OCR_SERVICES = {
  mineru: { name: 'MinerU', endpoint: 'https://mineru.net/api/v4', model: 'vlm', link: 'https://mineru.net/apiManage/token' },
  glm: { name: '智谱 GLM-OCR', endpoint: 'https://open.bigmodel.cn/api/paas/v4/layout_parsing', model: 'glm-ocr', link: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  siliconflow: { name: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-OCR', link: 'https://cloud.siliconflow.cn/account/ak' },
  aliyun: { name: '阿里百炼', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', model: 'qwen-vl-ocr', link: 'https://bailian.console.aliyun.com/' },
  custom: { name: 'OpenAI compatible', endpoint: '', model: '', link: '' },
} as const
export type CloudOCREngine = keyof typeof CLOUD_OCR_SERVICES
export type OCREngine = 'local' | CloudOCREngine
export type CloudOCRConfig = { engine: CloudOCREngine; endpoint: string; model: string; consent: boolean; key: string }
type Login = { hostname: string; httpRealm: string; username: string; password: string }
type LoginManager = { findLogins(origin: string, form: string | null, realm: string): Login[]; addLoginAsync(login: Login): Promise<unknown>; removeLogin(login: Login): void }
type Gecko = { Services?: { logins: LoginManager }; ChromeUtils?: { importESModule(uri: string): { Services?: { logins: LoginManager }; nsLoginInfo: new () => Login & { init(origin: string, form: null, realm: string, username: string, password: string, u: string, p: string): void } } } }
type Host = ZoteroLike & { __jadenseCloudOCRKeys?: Map<string, string> }
const origin = 'chrome://jadense-in-zotero'

/** 设置窗口和 bootstrap 的全局不同，统一从模块或 Zotero 主窗口获取凭证服务。 */
function loginPlatform(host: Host) {
  const platform = globalThis as Gecko, win = host.getMainWindow?.() as Gecko | null | undefined
  const ChromeUtils = platform.ChromeUtils ?? win?.ChromeUtils
  const Services = platform.Services ?? win?.Services ?? ChromeUtils?.importESModule('resource://gre/modules/Services.sys.mjs').Services
  return { manager: Services?.logins, ChromeUtils }
}

export function ocrEngine(host: ZoteroLike): OCREngine {
  const value = host.Prefs?.get(OCR_ENGINE_PREF, true)
  return typeof value === 'string' && Object.hasOwn(CLOUD_OCR_SERVICES, value) ? value as CloudOCREngine : 'local'
}
export function cloudOCRSettings(host: ZoteroLike, engine: CloudOCREngine) {
  let value: Partial<CloudOCRConfig> = {}
  try { value = JSON.parse(String(host.Prefs?.get(PREFIX + engine, true) || '{}')) ?? {} } catch { /* 损坏配置回到预设。 */ }
  const preset = CLOUD_OCR_SERVICES[engine]
  return { engine, endpoint: typeof value.endpoint === 'string' ? value.endpoint : preset.endpoint,
    model: typeof value.model === 'string' ? value.model : preset.model, consent: value.consent === true }
}
/** 仅 HTTPS 目的地址允许接收云密钥与文档；不允许 URL 内嵌秘密或查询参数。 */
export function cloudEndpoint(value: string) {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('OCR endpoint must be HTTPS, without credentials, query or fragment')
  return url.href.replace(/\/$/u, '')
}
function keys(host: Host) { return host.__jadenseCloudOCRKeys ??= new Map() }
function identity(engine: CloudOCREngine, endpoint: string) { return `${engine}:${endpoint}` }
export async function cloudOCRConfig(host: Host, engine: CloudOCREngine): Promise<CloudOCRConfig> {
  const value = cloudOCRSettings(host, engine), id = identity(engine, value.endpoint)
  let key = keys(host).get(id)
  if (key === undefined) {
    try { key = loginPlatform(host).manager?.findLogins(origin, null, id).find(row => row.username === engine)?.password } catch { /* 主密码未解锁仍可填会话密钥。 */ }
  }
  return { ...value, key: key ?? '' }
}
/** 更换 endpoint 必须重新确认；会话密钥优先于磁盘，避免旧凭证意外复用。 */
export async function saveCloudOCRConfig(host: Host, config: CloudOCRConfig): Promise<boolean> {
  const endpoint = cloudEndpoint(config.endpoint), id = identity(config.engine, endpoint), key = config.key.trim()
  keys(host).set(id, key)
  let persistent = false
  try {
    const { manager, ChromeUtils } = loginPlatform(host)
    if (manager && ChromeUtils) {
      for (const login of manager.findLogins(origin, null, id)) manager.removeLogin(login)
      if (key) {
        const { nsLoginInfo } = ChromeUtils.importESModule('resource://gre/modules/LoginInfo.sys.mjs')
        const login = new nsLoginInfo()
        login.init(origin, null, id, config.engine, key, '', '')
        await manager.addLoginAsync(login)
      }
      persistent = true
    }
  } catch { /* 不把凭证写入明文偏好；会话仍可用。 */ }
  host.Prefs?.set?.(PREFIX + config.engine, JSON.stringify({ endpoint, model: config.model.trim(), consent: config.consent }), true)
  return persistent
}
export function requireCloudOCR(config: CloudOCRConfig) {
  cloudEndpoint(config.endpoint)
  if (!config.consent) throw new Error('请在 OCR 配置确认云端上传及费用 / Confirm cloud upload and billing in OCR settings')
  if (!config.key || !config.model.trim()) throw new Error('请填写 OCR 密钥和模型 / OCR API key and model are required')
}
