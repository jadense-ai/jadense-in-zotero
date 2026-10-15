/** 收藏 PDF 的本机未完成意图；共享 Zotero host 上互斥，Prefs 只保存非凭据的最小恢复身份。 */
import { uploadFingerprint, uploadRequestId } from './pdf-upload-platform'
export const PDF_UPLOAD_ATTEMPTS_PREF = 'extensions.jadenseInZotero.pdfUploadAttempts'
export type PdfUploadAttempt = { scopeKey: string; inputFingerprint: string; requestId: string; filename: string;
  sha256?: string; size?: number; attachmentIdentity?: string; assetFileId?: string; retryAssociationOnly?: boolean;
  stage: 'prepared' | 'preflight' | 'uploading' | 'association'; updatedAt: string }
type Prefs = { get(key:string,global?:boolean):unknown; set(key:string,value:unknown,global?:boolean):void; clear(key:string,global?:boolean):void }
type Shared = { records: Record<string,PdfUploadAttempt>; locks: Set<string>; persistent: boolean }
type Host = object & { Prefs?: Prefs; __jadensePdfUploadAttempts?: Shared }

export class PdfUploadAttempts {
  private readonly shared: Shared
  constructor(private readonly host: Host) {
    if (!host.__jadensePdfUploadAttempts) {
      let records: Record<string,PdfUploadAttempt> = {}
      try { const value = JSON.parse(String(host.Prefs?.get(PDF_UPLOAD_ATTEMPTS_PREF,true) ?? '{}')) as Record<string,unknown>
        for (const [key,raw] of Object.entries(value)) {
          const r = raw as Partial<PdfUploadAttempt> | null
          if (r && typeof r.requestId==='string' && typeof r.inputFingerprint==='string' && typeof r.filename==='string') {
            records[key] = { scopeKey:key, requestId:r.requestId, inputFingerprint:r.inputFingerprint, filename:r.filename,
              sha256:typeof r.sha256==='string'?r.sha256:undefined, attachmentIdentity:typeof r.attachmentIdentity==='string'?r.attachmentIdentity:undefined,
              size:typeof r.size==='number'?r.size:undefined,
              assetFileId:typeof r.assetFileId==='string'?r.assetFileId:undefined,retryAssociationOnly:r.retryAssociationOnly===true,
              stage:r.stage==='association'?'association':r.stage==='uploading'?'uploading':'prepared', updatedAt:typeof r.updatedAt==='string'?r.updatedAt:'' }
          }
        }
      } catch { records={} }
      host.__jadensePdfUploadAttempts={records,locks:new Set(),persistent:true}
    }
    this.shared=host.__jadensePdfUploadAttempts
  }
  get(scopeKey:string) { return this.shared.records[scopeKey] }
  lock(scopeKey:string) { if(this.shared.locks.has(scopeKey))return false; this.shared.locks.add(scopeKey); return true }
  unlock(scopeKey:string) { this.shared.locks.delete(scopeKey) }
  begin(input: Omit<PdfUploadAttempt,'requestId'|'stage'|'updatedAt'>, createId=uploadRequestId): PdfUploadAttempt {
    const existing=this.get(input.scopeKey)
    if(existing?.inputFingerprint===input.inputFingerprint)return existing
    const attempt={...input,requestId:createId(),stage:'prepared' as const,updatedAt:new Date().toISOString()}
    this.shared.records[input.scopeKey]=attempt; this.persist(); return attempt
  }
  update(scopeKey:string, patch:Partial<Pick<PdfUploadAttempt,'assetFileId'|'retryAssociationOnly'|'stage'>>) {
    const row=this.get(scopeKey); if(row){Object.assign(row,patch,{updatedAt:new Date().toISOString()});this.persist()}
  }
  finish(scopeKey:string) { delete this.shared.records[scopeKey]; this.persist() }
  clear() { this.shared.records={}; this.persist() }
  get persistent() { return this.shared.persistent }
  private persist() {
    try { if(!this.host.Prefs) { this.shared.persistent=false; return }
      this.host.Prefs.set(PDF_UPLOAD_ATTEMPTS_PREF,JSON.stringify(this.shared.records),true);this.shared.persistent=true
    } catch { this.shared.persistent=false }
  }
}

/** scope 包含连接和目标；凭据只参与单向摘要，不进入磁盘和诊断。 */
export function pdfUploadScope(connection:{baseUrl:string;token:string}, itemKey:string,folderId:string) {
  return uploadFingerprint(JSON.stringify([connection.baseUrl.replace(/\/+$/g,''),connection.token,itemKey,folderId]))
}
export function pdfUploadInputFingerprint(input: unknown) { return uploadFingerprint(JSON.stringify(input)) }
