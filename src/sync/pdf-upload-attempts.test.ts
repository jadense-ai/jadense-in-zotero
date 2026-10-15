import { describe, expect, it } from 'vitest'
import { PdfUploadAttempts, PDF_UPLOAD_ATTEMPTS_PREF, pdfUploadScope } from './pdf-upload-attempts'
describe('PDF intent persistence',()=>{
  const input={scopeKey:'scope',inputFingerprint:'bytes-and-target',filename:'中文 100%.pdf',sha256:'digest'}
  it('shares locks across bundles, restores saved files after restart, and finishes completed intents',()=>{
    const values=new Map<string,unknown>(), Prefs={get:(k:string)=>values.get(k),set:(k:string,v:unknown)=>{values.set(k,v)},clear:(k:string)=>{values.delete(k)}}
    const host={Prefs}, first=new PdfUploadAttempts(host),second=new PdfUploadAttempts(host)
    expect(first.lock('scope')).toBe(true);expect(second.lock('scope')).toBe(false);first.unlock('scope')
    expect(second.lock('scope')).toBe(true);second.unlock('scope')
    first.begin(input,()=> 'original');first.update('scope',{assetFileId:'saved',retryAssociationOnly:true,stage:'association'})
    const restored=new PdfUploadAttempts({Prefs})
    expect(restored.begin(input,()=> 'new')).toMatchObject({requestId:'original',assetFileId:'saved'})
    expect(restored.begin({...input,inputFingerprint:'changed'},()=> 'new').requestId).toBe('new')
    restored.finish('scope');expect(JSON.parse(String(values.get(PDF_UPLOAD_ATTEMPTS_PREF)))).toEqual({})
  })
  it('isolates credentials and degrades local writes without losing in-session intent',()=>{
    expect(pdfUploadScope({baseUrl:'https://host/',token:'one'},'item','folder')).not.toBe(pdfUploadScope({baseUrl:'https://host',token:'two'},'item','folder'))
    const store=new PdfUploadAttempts({Prefs:{get:()=>null,set:()=>{throw new Error('disk')},clear:()=>{}}})
    store.begin(input,()=> 'retained');store.update('scope',{assetFileId:'saved'})
    expect(store.persistent).toBe(false);expect(store.get('scope')?.assetFileId).toBe('saved')
  })
})
