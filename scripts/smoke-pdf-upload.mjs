/** 最终 XPI 的原生收藏 PDF 回归。只使用隔离 profile、合成 PDF 和本机 HTTP 服务。 */
/* global Zotero, Services, IOUtils, Components */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import JSZip from 'jszip'
import { createResearchFixturePdf } from './smoke-research.mjs'

async function nativeHarness(config) {
  const checks=[],assert=(value,message)=>{if(!value)throw new Error(message)},delay=ms=>Zotero.Promise.delay(ms)
  const wait=async(fn,label)=>{const end=Date.now()+60000;while(Date.now()<end){const value=fn();if(value)return value;await delay(100)}throw new Error('Timeout: '+label)}
  const persist=report=>IOUtils.writeUTF8(config.report,JSON.stringify(report,null,2))
  try {
    await Zotero.uiReadyPromise
    const main=await wait(()=>Zotero.getMainWindow(),'main window')
    await wait(()=>main.document.readyState==='complete','main document')
    // uiReadyPromise 早于冷启动条目缓存；与综合夹具一样等待后再读取既有合成条目。
    await Zotero.Libraries.get(Zotero.Libraries.userLibraryID).waitForDataLoad('item')
    Zotero.Prefs.set('extensions.jadenseInZotero.quickStartShown',true)
    Zotero.Prefs.set('extensions.jadenseInZotero.displayLanguage',config.appearanceLanguage,true)
    Zotero.Prefs.set('extensions.jadenseInZotero.baseUrl',config.origin)
    Zotero.Prefs.set('extensions.jadenseInZotero.token','jdx_ext_synthetic_upload_smoke')
    Zotero.Prefs.set('extensions.jadenseInZotero.defaultFolderId','folder-test')
    if(config.phase===3){
      assert(Object.keys(JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.pdfUploadAttempts',true)||'{}')).length===0,'Completed intent survived cold start')
      await delay(500);checks.push('cold-start-no-pending-intent');await persist({state:'passed',checks});Services.startup.quit(Services.startup.eForceQuit);return
    }
    await wait(()=>main.document.querySelector('[data-l10n-id="jadense-in-zotero-menu-main"]') || Zotero.__jadenseDiagnostics,'plugin startup')
    let collection, first
    if(config.phase===1){
      collection=new Zotero.Collection();collection.name='PDF upload fixture';await collection.saveTx()
      const add=async(title,pdf)=>{const paper=new Zotero.Item('journalArticle');paper.setField('title',title);paper.setCollections([collection.id]);await paper.saveTx()
        if(pdf)await Zotero.Attachments.importFromFile({file:pdf,parentItemID:paper.id,title:'中文 100%.pdf',contentType:'application/pdf'});return paper}
      first=await add('Saved pending association',config.pdf);await add('Successful PDF',config.secondPdf);await add('Metadata only',false)
      Zotero.Prefs.set('extensions.jadenseInZotero.pdfSmokeCollection',collection.id,true)
      Zotero.Prefs.set('extensions.jadenseInZotero.pdfSmokeFirst',first.id,true)
    } else {
      collection=Zotero.Collections.get(Zotero.Prefs.get('extensions.jadenseInZotero.pdfSmokeCollection',true))
      first=Zotero.Items.get(Zotero.Prefs.get('extensions.jadenseInZotero.pdfSmokeFirst',true))
      const attachment=Zotero.Items.get(first.getAttachments()[0]),file=await attachment.getFilePathAsync()
      assert(file.replaceAll('\\','/').toLowerCase().startsWith(config.dataDir.replaceAll('\\','/').toLowerCase()+'/'),'Fixture file escaped isolated data directory')
      await IOUtils.remove(file);checks.push('saved-pdf-local-source-removed')
    }
    const pane=main.ZoteroPane
    await pane.collectionsView.selectByID('C'+collection.id)
    await wait(()=>pane.getSelectedCollection()?.id===collection.id,'selected collection')
    await delay(1000)
    main.openDialog('chrome://jadense-in-zotero/content/manager.xhtml?section=settings-connection','','chrome,dialog=no,titlebar,resizable,width=1100,height=800',{zotero:Zotero,section:'settings-connection',pluginID:'jadense-in-zotero@jadense.cn'})
    const manager=await wait(()=>{const windows=Services.wm.getEnumerator(null);while(windows.hasMoreElements()){const win=windows.getNext();if(win.document?.getElementById('jadense-manager-export-collection'))return win}return null},'manager')
    await delay(1000)
    const doc=manager.document
    doc.querySelector('.jdx-quick-start-dialog[open]')?.close()
    doc.getElementById('jadense-settings-tab-connection').click()
    doc.getElementById('jadense-connection-tab-sync').click()
    const refresh=doc.getElementById('jadense-manager-migrate-load-folders');refresh.click()
    const button=doc.getElementById('jadense-manager-export-collection'),status=doc.getElementById('jadense-manager-migration-status'),include=doc.getElementById('jadense-manager-include-pdf')
    await wait(()=>!refresh.disabled&&!button.disabled,'upload ready')
    include.checked=true;include.dispatchEvent(new manager.Event('change',Components.utils.cloneInto({bubbles:true},manager)))
    status.textContent='';button.click()
    await wait(()=>!button.disabled&&status.textContent,'upload result')
    const statusText=status.textContent
    const attempts=JSON.parse(Zotero.Prefs.get('extensions.jadenseInZotero.pdfUploadAttempts',true)||'{}')
    if(config.phase===1){
      assert(Object.keys(attempts).length===1,'Expected one pending PDF')
      const attempt=Object.values(attempts)[0]
      assert(attempt.assetFileId&&attempt.retryAssociationOnly&&attempt.requestId,'Saved association receipt is incomplete')
      assert(status.textContent.includes(config.appearanceLanguage==='en-US'?'PDFs saved, awaiting association':'PDF 已保存，待关联'),'Saved PDF status is not visible')
      checks.push('native-collection-multipart','partial-failure-preserves-other-items','saved-association-receipt','visible-saved-pdf-status')
      const downloaded=await main.fetch(config.origin+'/files/'+attempt.assetFileId)
      const bytes=new Uint8Array(await downloaded.arrayBuffer()),local=await IOUtils.read(config.pdf)
      assert(bytes.length===local.length&&bytes.every((b,i)=>b===local[i]),'Saved PDF download bytes differ')
      checks.push('saved-pdf-download-identical')
      if(config.previewCheck){
      await IOUtils.write(config.preview,bytes)
      const previewPaper=new Zotero.Item('journalArticle');previewPaper.setField('title','Saved PDF preview');await previewPaper.saveTx()
      const preview=await Zotero.Attachments.importFromFile({file:config.preview,parentItemID:previewPaper.id,title:'Saved PDF preview',contentType:'application/pdf'})
      manager.close();await wait(()=>manager.closed,'manager closed before Reader');main.focus();await pane.selectItem(previewPaper.id)
      const reader=await Zotero.Reader.open(preview.id);await reader._initPromise
      const view=reader._internalReader._primaryView;await view.initializedPromise;await view._ensureBasicPageData(0)
      assert(view._pdfPages[0]?.chars?.length>0,'Saved PDF could not be read by the native viewer')
      checks.push('saved-pdf-native-preview')
      }
    } else {
      assert(Object.keys(attempts).length===0,'Recovered association did not finish its intent')
      assert(!status.textContent.includes(config.appearanceLanguage==='en-US'?'awaiting association':'待关联'),'Recovered item still awaiting association')
      checks.push('cold-restart-association-only','missing-local-pdf-recovery','completed-intent-cleared')
    }
    await persist({state:'passed',checks,status:statusText})
    await delay(250);Services.startup.quit(Services.startup.eForceQuit)
  } catch(error){await persist({state:'failed',checks,error:String(error),stack:error?.stack});Services.startup.quit(Services.startup.eForceQuit)}
}

const [executable,xpi,output,appearanceLanguage='zh-CN']=process.argv.slice(2)
if(!executable||!xpi||!output)throw new Error('Usage: node scripts/smoke-pdf-upload.mjs <Zotero.exe> <xpi> <output>')
const root=path.resolve(output),profile=path.join(root,'profile'),dataDir=path.join(root,'data'),extensions=path.join(profile,'extensions')
await mkdir(extensions,{recursive:true});await mkdir(dataDir,{recursive:true})
const pdf=path.join(root,'中文 100%.pdf');await writeFile(pdf,createResearchFixturePdf())
const secondPdf=path.join(root,'second.pdf');await writeFile(secondPdf,createResearchFixturePdf(true))
await copyFile(path.resolve(xpi),path.join(extensions,'jadense-in-zotero@jadense.cn.xpi'))
const assets=new Map(),receipts=new Map(),associated=new Set(),requests=[]
let failAssociation=true
const server=createServer(async(req,res)=>{
  try {
    const chunks=[];for await(const part of req)chunks.push(part);const body=Buffer.concat(chunks)
    const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
    const url=new URL(req.url,'http://localhost')
    if(url.pathname.startsWith('/files/')){const bytes=assets.get(url.pathname.slice(7));res.writeHead(bytes?200:404,{'content-type':'application/pdf'});res.end(bytes);return}
    if(url.pathname.endsWith('/favorite/folders'))return json({defaultFolderId:'folder-test',folders:[{id:'folder-test',name:'Fixture',isDefault:true,itemCount:0}]})
    if(url.pathname.endsWith('/profile/me'))return json({userId:'synthetic-user',displayName:'Fixture',subscription:{code:'pro',label:'PRO'}})
    if(url.pathname.endsWith('/points/status'))return json({billing:{sourceKind:'personal',balancePoints:0},checkIn:{signedToday:false,currentStreakDays:0,todayReward:{grantedPoints:0}}})
    if(url.pathname.endsWith('/chat/models'))return json({options:[],defaultSelection:null})
    if(url.pathname.endsWith('/favorite/import-zotero-items')){const input=JSON.parse(body);requests.push({kind:'metadata',count:input.items.length});return json({results:input.items.map(item=>({clientItemId:item.clientItemId,status:'imported'})),importedCount:input.items.length,skippedCount:0,failedCount:0})}
    if(url.pathname.endsWith('/favorite/import-page-pdf')){
      let input,assetFileId
      if(req.headers['content-type']?.includes('application/json')){input=JSON.parse(body);assetFileId=input.assetFileId||[...assets].find(([,bytes])=>createHash('sha256').update(bytes).digest('hex')===input.sha256)?.[0];requests.push({kind:input.assetFileId?'association':'preflight',requestId:input.requestId,size:input.size,sha256:input.sha256})
        if(!assetFileId)return json({reused:false})
      } else {const form=await new Request('http://localhost'+req.url,{method:'POST',headers:req.headers,body}).formData(),file=form.get('file')
        const bytes=Buffer.from(await file.arrayBuffer());assetFileId='asset-'+createHash('sha256').update(bytes).digest('hex');assets.set(assetFileId,bytes)
        input={requestId:form.get('requestId'),metadata:JSON.parse(form.get('metadata')),filename:file.name};requests.push({kind:'multipart',requestId:input.requestId,bytes:bytes.length,filename:file.name})
      }
      const title=input.metadata.title,result={itemKind:'literature',articleId:null,assetFileId,insertedFolderIds:['folder-test'],skippedFolderIds:[]}
      if(title==='Saved pending association'&&failAssociation){failAssociation=false;return json({code:'FILE_ASSOCIATION_FAILED',error:'文件已保存，关联失败，请重试关联。',assetFileId,retryAssociationOnly:true},503)}
      if(receipts.has(input.requestId))return json({reused:true,result:receipts.get(input.requestId)})
      if(associated.has(title)){result.insertedFolderIds=[];result.skippedFolderIds=['folder-test'];result.conflicts=[{message:'当前收藏夹已有同名或相同文献，已拒绝导入。'}]}
      else associated.add(title)
      receipts.set(input.requestId,result)
      return json(req.headers['content-type']?.includes('application/json')?{reused:true,result}:result)
    }
    return json({})
  }catch(error){res.writeHead(500);res.end(String(error))}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port
try {
  await writeFile(path.join(profile,'user.js'),['user_pref("extensions.autoDisableScopes",0);','user_pref("extensions.enabledScopes",15);','user_pref("extensions.update.enabled",false);','user_pref("intl.locale.requested","zh-CN");','user_pref("extensions.jadenseInZotero.smokeOpenManager",true);',`user_pref("extensions.jadenseInZotero.displayLanguage",${JSON.stringify(appearanceLanguage)});`].join('\n'))
  for(const phase of [1,2,3]){
    const report=path.join(root,`native-${phase}.json`),config={phase,report,origin,pdf,secondPdf,dataDir,appearanceLanguage,previewCheck:process.argv.includes('--preview'),preview:path.join(dataDir,'saved-preview.pdf')}
    const zip=new JSZip().file('manifest.json',JSON.stringify({manifest_version:2,name:'PDF isolated smoke',version:'1.0.0',applications:{zotero:{id:'pdf-upload-smoke@synthetic.invalid',update_url:'https://example.invalid/updates.json',strict_min_version:'9.0',strict_max_version:'10.0.*'}}}))
    zip.file('bootstrap.js',nativeHarness.toString()+`\nfunction startup(){void nativeHarness(${JSON.stringify(config)});}function shutdown(){}function install(){}function uninstall(){}`)
    await writeFile(path.join(extensions,'pdf-upload-smoke@synthetic.invalid.xpi'),await zip.generateAsync({type:'nodebuffer'}))
    const stdout=await open(path.join(root,`native-${phase}.stdout.log`),'w'),stderr=await open(path.join(root,`native-${phase}.stderr.log`),'w')
    const before=requests.length,child=spawn(executable,['-no-remote','-profile',profile,'-datadir',dataDir,'-ZoteroDebugText'],{windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]})
    // Windows 启动器会提早退出；实际 Gecko 是否完成以报告为准。
    const waitReport=async()=>{const end=Date.now()+150000;while(Date.now()<end){const raw=await readFile(report,'utf8').catch(()=>null);if(raw)return JSON.parse(raw);await new Promise(resolve=>setTimeout(resolve,250))}throw new Error('Native phase '+phase+' timed out; artifacts: '+root)}
    let state
    try { state=await Promise.race([waitReport(),new Promise((_,reject)=>child.once('error',reject))]) }
    finally {
      // 报告先于原生退出写入；让宿主正常关闭并刷盘，不能提前强杀模拟成冷启动。
      await new Promise(resolve=>setTimeout(resolve,1000))
      await new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process -Filter \"Name='zotero.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:JADENSE_PDF_SMOKE_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],{windowsHide:true,env:{...process.env,JADENSE_PDF_SMOKE_PROFILE:profile}},resolve))
      await stdout.close();await stderr.close()
    }
    if(state.state!=='passed')throw new Error(JSON.stringify(state))
    if(phase===2&&requests.slice(before).some(r=>r.kind==='multipart'))throw new Error('Restart repeated PDF byte upload')
    if(phase===3&&requests.slice(before).some(r=>['multipart','association','preflight','metadata'].includes(r.kind)))throw new Error('Cold start performed an upload')
    console.log(`Native PDF phase ${phase}: ${state.checks.join(', ')}`)
  }
  await writeFile(path.join(root,'requests.json'),JSON.stringify(requests,null,2))
}finally{server.close()}
