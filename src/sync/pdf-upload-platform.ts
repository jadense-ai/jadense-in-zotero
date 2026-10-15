/** 收藏上传的宿主适配：绑定 WebCrypto，回退 Gecko 哈希/UUID；纯 SHA 只计算身份，不授予权限。 */
type NativeHash = { SHA256: number; init(kind: number): void; update(bytes: Uint8Array, count: number): void; finish(ascii: boolean): string }
type Platform = typeof globalThis & {
  Components?: { classes: Record<string, { createInstance(type: unknown): NativeHash }>; interfaces: { nsICryptoHash: unknown } }
  Services?: { uuid: { generateUUID(): { toString(): string } } }
}
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
const rotate = (n: number, bits: number) => (n >>> bits) | (n << (32 - bits))

/** 固定内存的标准 SHA-256；供缺少 WebCrypto 的宿主及本地输入指纹使用。 */
export function portableSha256(bytes: Uint8Array): string {
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const total = Math.ceil((bytes.length + 9) / 64) * 64, w = new Int32Array(64)
  const tail = new DataView(new ArrayBuffer(8)); tail.setUint32(0, Math.floor(bytes.length / 0x20000000)); tail.setUint32(4, bytes.length * 8)
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) {
      let word = 0
      for (let j = 0; j < 4; j++) { const p = offset + i * 4 + j; word = (word << 8) | (p < bytes.length ? bytes[p]! : p === bytes.length ? 128 : p >= total - 8 ? tail.getUint8(p - total + 8) : 0) }
      w[i] = word
    }
    for (let i = 16; i < 64; i++) { const x = w[i - 15]!, y = w[i - 2]!; w[i] = w[i - 16]! + (rotate(x,7) ^ rotate(x,18) ^ (x >>> 3)) + w[i - 7]! + (rotate(y,17) ^ rotate(y,19) ^ (y >>> 10)) }
    let [a,b,c,d,e,f,g,q] = h as [number,number,number,number,number,number,number,number]
    for (let i = 0; i < 64; i++) { const t = (q + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0
      const u = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      q=g; g=f; f=e; e=(d+t)|0; d=c; c=b; b=a; a=(t+u)|0 }
    const values = [a,b,c,d,e,f,g,q]; for (let i=0;i<8;i++) h[i]=(h[i]!+values[i]!)|0
  }
  return h.map(n => (n >>> 0).toString(16).padStart(8,'0')).join('')
}

export function uploadFingerprint(text: string) { return portableSha256(new TextEncoder().encode(text)) }

/** 源文件摘要不依赖 bootstrap 全局的 Crypto 对象，所有方法保留原接收者。 */
export async function uploadFileSha256(file: Blob, platform: Partial<Platform> = globalThis): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  try { if (platform.crypto?.subtle) return Array.from(new Uint8Array(await platform.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('') } catch { /* 使用宿主/纯计算回退。 */ }
  try { const native = platform.Components
    if (native) { const hash = native.classes['@mozilla.org/security/hash;1']!.createInstance(native.interfaces.nsICryptoHash); hash.init(hash.SHA256); hash.update(bytes,bytes.length)
      return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2,'0')).join('') }
  } catch { /* 纯计算回退不依赖特权模块。 */ }
  return portableSha256(bytes)
}

export function uploadRequestId(platform: Partial<Platform> = globalThis): string {
  try { if (platform.crypto?.randomUUID) return platform.crypto.randomUUID() } catch { /* 原生 UUID 回退。 */ }
  try { if (platform.Services?.uuid) return platform.Services.uuid.generateUUID().toString().replace(/[{}]/g,'') } catch { /* 本机请求身份不作为授权凭据。 */ }
  return `zotero-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}
