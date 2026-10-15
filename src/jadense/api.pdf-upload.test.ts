/** PDF 边界回归：协议、保存身份、取消/超时和未知响应，不访问真实服务。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JadenseApiClient } from './api'
import type { JadenseZoteroImportItem } from '@/sync/metadata'
const item: JadenseZoteroImportItem={clientItemId:'zotero:1/one',metadata:{doi:null,externalSource:null,externalId:null,title:'Paper',authors:[],venueName:null,publicationDate:null,abstract:null,canonicalUrl:null,pageUrl:null,sourceMetadata:{}}}
const input=()=>({folderIds:['folder'],item,file:new Blob(['abc'],{type:'application/pdf'}),filename:'中文 100%.pdf',requestId:'same-intent'})
const result={itemKind:'literature',articleId:null,assetFileId:'saved',insertedFolderIds:['folder'],skippedFolderIds:[]}
const client=(fetchImpl:typeof fetch,extra={})=>new JadenseApiClient({baseUrl:'https://synthetic.invalid',token:'synthetic',fetchImpl,...extra})
afterEach(()=>vi.useRealTimers())
describe('favorite PDF protocol',()=>{
  it('reuses content with real digest and size, no multipart or FormData creation',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({reused:true,result:{...result,future:true}})),form=vi.fn()
    expect(await client(fetcher,{formDataFactory:form}).importFavoritePdf(input())).toMatchObject(result)
    expect(form).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',size:3,filename:'中文 100%.pdf',requestId:'same-intent'})
  })
  it('preserves the same receipt and filename across preflight and multipart',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({reused:false,future:true})).mockResolvedValueOnce(Response.json(result))
    await client(fetcher).importFavoritePdf(input())
    const form=fetcher.mock.calls[1][1].body as FormData
    expect(form.get('requestId')).toBe('same-intent');expect((form.get('file') as File).name).toBe('中文 100%.pdf')
    expect(fetcher.mock.calls[1][1].headers.has('content-type')).toBe(false)
  })
  it.each([401,403,413,429,503])('does not fall through to byte upload after HTTP %i',async status=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({error:'rejected'},{status}))
    await expect(client(fetcher).importFavoritePdf(input())).rejects.toMatchObject({status})
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('exposes the saved identity before reporting failure and retries association with no local file',async()=>{
    const saved=vi.fn(),fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'saved',code:'FILE_ASSOCIATION_FAILED',assetFileId:'saved',retryAssociationOnly:true,future:true},{status:503}))
      .mockResolvedValueOnce(Response.json({reused:true,result}))
    const api=client(fetcher)
    await expect(api.importFavoritePdf({...input(),onSavedFile:saved})).rejects.toMatchObject({assetFileId:'saved',retryAssociationOnly:true})
    expect(saved).toHaveBeenCalledWith('saved',true)
    await api.importFavoritePdf({...input(),file:undefined,assetFileId:'saved'})
    const body=JSON.parse(fetcher.mock.calls[1][1].body)
    expect(body).toMatchObject({assetFileId:'saved',requestId:'same-intent'});expect(body).not.toHaveProperty('sha256');expect(body).not.toHaveProperty('size')
  })
  it('uses the multipart compatibility path when local hashing is unavailable',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json(result))
    await client(fetcher,{computeSha256:async()=>undefined}).importFavoritePdf(input())
    expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1].body).toBeInstanceOf(FormData)
  })
  it('drops malformed optional response decorations while preserving successful folder receipts',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({reused:true,result:{...result,conflicts:'not-an-array',backfilledFolderIds:null,future:true}}))
    expect(await client(fetcher).importFavoritePdf(input())).toMatchObject({insertedFolderIds:['folder'],conflicts:undefined,backfilledFolderIds:undefined})
  })
  it.each([{future:true},{reused:true},{reused:true,result:{future:true}}])('contains uncertain preflight responses without further writes: %j',async payload=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json(payload))
    await expect(client(fetcher).importFavoritePdf(input())).rejects.toThrow('响应格式无效')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('bounds preflight waits even if transport ignores abort',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn(()=>new Promise<Response>(()=>{}))
    const waiting=client(fetcher).importFavoritePdf({...input(),sha256:'a'.repeat(64)})
    const assertion=expect(waiting).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(60000);await assertion;expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('bounds multipart waits at thirty minutes without replaying the upload',async()=>{
    vi.useFakeTimers();const fetcher=vi.fn(()=>new Promise<Response>(()=>{}))
    const waiting=client(fetcher,{computeSha256:async()=>undefined}).importFavoritePdf(input())
    const assertion=expect(waiting).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(1800000);await assertion;expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('cancels a dispatched wait without starting another request',async()=>{
    const controller=new AbortController(),fetcher=vi.fn(()=>new Promise<Response>(()=>{}))
    const waiting=client(fetcher).importFavoritePdf({...input(),sha256:'a'.repeat(64),signal:controller.signal})
    const assertion=expect(waiting).rejects.toBeDefined();controller.abort();await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
