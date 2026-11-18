/** 免密钥翻译目录：选择器、三种阅读入口及宿主调度共用稳定 ID。 */
export const machineServices = {
  bing: { name: 'Bing', origin: 'https://www.bing.com', limit: 1000 },
  google: { name: 'Google', origin: 'https://translate.google.com', limit: 5000 },
  edge: { name: 'Microsoft Edge', origin: 'https://edge.microsoft.com', limit: 5000 },
  'google-gtx': { name: 'Google GTX', origin: 'https://translate.googleapis.com', limit: 1500 },
  mymemory: { name: 'MyMemory', origin: 'https://api.mymemory.translated.net', limit: 500 },
  libretranslate: { name: 'LibreTranslate', origin: 'http://127.0.0.1:5000', limit: 5000 },
} as const
export type TranslationService = keyof typeof machineServices
export function isMachineService(value: unknown): value is TranslationService {
  return typeof value === 'string' && Object.hasOwn(machineServices, value)
}
export function isMachineAddress(address: string) {
  return Object.values(machineServices).some(service => service.origin === address)
}

/** MyMemory 按 UTF-8 字节限额；其他适配器按 UTF-16 单元保守切片。 */
export function machineTextCost(service: TranslationService, text: string) {
  if (service !== 'mymemory') return text.length
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}
