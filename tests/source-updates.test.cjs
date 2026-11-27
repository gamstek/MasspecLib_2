const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http')
const {randomUUID}=require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const {fixture}=require('./fixtures/lds-fixture.cjs')
const {FileLibraries}=require('../scripts/customer-delivery/file-libraries.cjs')
const {parseGNPS}=require('../scripts/customer-delivery/gnps-record.cjs')
const {hash}=require('../scripts/customer-delivery/massbank-record.cjs')
const {createService}=require('../scripts/customer-delivery/server.cjs')
const {sourceUpdates}=require('../scripts/customer-delivery/source-updates.cjs')
const {EventEmitter}=require('node:events')
const sample=(id=1,extra={})=>({spectrum_id:'CCMSLIB'+String(id).padStart(10,'0'),Compound_Name:'Fixture chemical',
  peaks_json:JSON.stringify([[101,55+id]]),ms_level:'2',Ion_Mode:'Positive',Adduct:'[M+H]+',Precursor_MZ:'179.07',
  InChIKey_smiles:'AAAAAAAAAAAAAA-BBBBBBBBBB-C',Instrument:'Orbitrap',Collision_Energy:'10 eV',...extra})

function massbankSource(accession, name, inchikey, intensity = 55) {
 const text = [
  'ACCESSION: ' + accession, 'CH$NAME: ' + name, 'CH$LINK: INCHIKEY ' + inchikey,
  'AC$MASS_SPECTROMETRY: MS_TYPE MS2', 'AC$MASS_SPECTROMETRY: ION_MODE POSITIVE',
  'AC$MASS_SPECTROMETRY: COLLISION_ENERGY 10(NCE)', 'MS$FOCUSED_ION: PRECURSOR_M/Z 179.07',
  'MS$FOCUSED_ION: PRECURSOR_TYPE [M+H]+', 'PK$NUM_PEAK: 1', 'PK$PEAK: m/z int. rel.int.',
  '  101.0 ' + intensity + ' 999', '//', ''
 ].join('\n')
 return { accession, sha256: hash(text), text }
}

test('source update tasks can be removed without touching published libraries',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-remove-'))
 try{
  const updates=sourceUpdates({directory,fileOp:async(method)=>method==='list'?[]:{}})
  const task=await updates.configure({sourceId:'59',scope:'官方当前版本',libraryId:'file:test'})
  assert.equal((await updates.list()).tasks.length,1)
  assert.deepEqual(await updates.remove({id:task.id}),{removed:true,id:task.id})
  assert.equal((await updates.list()).tasks.length,0)
  updates.close()
 }finally{fs.rmSync(directory,{recursive:true,force:true})}
})

test('a scheduled task resumes its failed batch and cannot delete its last successful result', async t => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-scheduled-'))
 const root=path.join(directory,'source-updates')
 const jobs=[]
 const updates=sourceUpdates({directory,fileOp:async method=>method==='list'?[]:{},
   spawnJob(_node,args) {
     const child = new EventEmitter()
     child.stderr = new EventEmitter()
     child.kill = () => child.emit('close',1)
     jobs.push({child,folder:args[1]})
     return child
   }})
 t.after(()=>{updates.close();fs.rmSync(directory,{recursive:true,force:true})})
 const task=await updates.configure({sourceId:'59',scope:'官方当前版本',libraryId:'file:test',intervalHours:24})
 await updates.tick()
 assert.equal(jobs.length,1)
 const good=jobs[0]
 fs.writeFileSync(path.join(good.folder,'batch.json'),JSON.stringify({version:'v1',count:1,compounds:1}))
 good.child.emit('close',0)
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(task.batchId,path.basename(good.folder))
 assert.ok(Date.parse(task.nextRunAt)>Date.now())
 await updates.check({taskId:task.id})
 const bad=jobs[1]
 fs.writeFileSync(path.join(bad.folder,'existing.part'),'partial bytes')
 bad.child.emit('close',1)
 assert.equal(task.failedBatchId,path.basename(bad.folder))
 assert.equal(task.batchId,path.basename(good.folder))
 await assert.rejects(updates.deleteBatch({taskId:task.id,batchId:task.batchId}),/只能删除/)
 await updates.check({taskId:task.id})
 assert.equal(jobs[2].folder,bad.folder)
 assert.equal(fs.readFileSync(path.join(bad.folder,'existing.part'),'utf8'),'partial bytes')
 jobs[2].child.emit('close',1)
 await updates.deleteBatch({taskId:task.id,batchId:task.failedBatchId})
 assert.ok(fs.existsSync(good.folder))
 assert.ok(!fs.existsSync(bad.folder))
 assert.equal(task.failedBatchId,undefined)
})

test('automatic downloads enter a readable read-only library without publication', async t => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-archive-'))
 const files=new FileLibraries(path.join(directory,'registry'))
 const {libraryId,title}=files.ensureSourceArchive({uploadRoot:directory})
 const jobs=[]
 const updates=sourceUpdates({directory,fileOp:async (method,input)=>files[method](input),
  archive:{libraryId,title,ensure:async()=>files.ensureSourceArchive({uploadRoot:directory}),
    write:async input=>files.archiveSourceBatch(input)},
  spawnJob(_node,args){
   const child=new EventEmitter()
   child.stderr=new EventEmitter()
   child.kill=()=>child.emit('close',1)
   jobs.push({child,folder:args[1]})
   return child
  }})
 t.after(()=>{updates.close();fs.rmSync(directory,{recursive:true,force:true})})
 const task=await updates.configure({sourceId:'59',scope:'官方当前版本',intervalHours:24})
 await updates.tick()
 const batch=jobs[0]
 const candidate=parseGNPS(sample(),'v1','LEAFBOT')
 const candidateWithMissingKey=parseGNPS(sample(2,{InChIKey_smiles:'',Compound_Name:'Other source record'}),'v1','LEAFBOT')
 fs.writeFileSync(path.join(batch.folder,'batch.json'),JSON.stringify({taskId:task.id,batchId:path.basename(batch.folder),
   libraryId:'',adapter:'file',sourceId:task.sourceId,scope:task.scope,version:'v1',count:2,archiveMode:true}))
 const db=new DatabaseSync(path.join(batch.folder,'candidates.sqlite'))
 db.exec('CREATE TABLE candidates(accession TEXT PRIMARY KEY,payload TEXT)')
 for(const record of [candidate,candidateWithMissingKey]) db.prepare('INSERT INTO candidates VALUES(?,?)').run(record.accession,JSON.stringify(record))
 db.close()
 batch.child.emit('close',0)
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(task.archived.addedSpectra,2)
 assert.equal(files.rows({libraryId}).total,2)
 const [row]=files.rows({libraryId,keyword:'Fixture chemical',details:true}).rows
 assert.equal(row.record.sources[0].source_record_id,candidate.accession)
 assert.equal(row.record.spectra[0].methodIds[0],row.record.ms[0].id)
 assert.deepEqual(files.peaks({libraryId,id:row.id,spectrumId:row.record.spectra[0].id}),candidate.record.spectra[0].peaks)
 assert.equal(files.archiveSourceBatch({batchFolder:batch.folder,sourceId:task.sourceId}).addedSpectra,0)
 assert.throws(()=>files.setAccess({libraryId,readOnly:false}),/服务器维护/)
 await assert.rejects(updates.publish({taskId:task.id,batchId:task.batchId}),/自动汇入/)
})

test('GNPS comparison ignores export membership/order but detects scientific revisions',()=>{
 const a=parseGNPS(sample(),'v1','LEAFBOT'),b=parseGNPS(sample(),'v2','MIADB')
 assert.equal(a.sha256,b.sha256)
 assert.notEqual(a.sha256,parseGNPS(sample(1,{Precursor_MZ:'180'}),'v1','LEAFBOT').sha256)
 assert.equal(parseGNPS(sample(1,{InChIKey_inchi:'CCCCCCCCCCCCCC-DDDDDDDDDD-E'}),'v1','LEAFBOT').key,null)
 assert.throws(()=>parseGNPS(sample(1,{peaks_json:'[[0,1]]'}),'v1','LEAFBOT'))
})

test('MultiMS2 source numbers are scoped to the actual acquisition', () => {
 const {parsePublishedSpectrum}=require('../scripts/customer-delivery/source-upload.cjs')
 const config={adapter:'file',sourceId:'69',sourceName:'MultiMS²'}
 const metadata={format:'mgf',version:'test'}
 const record=(scan, intensity) => parsePublishedSpectrum([
   'BEGIN IONS','COMPOUND_NAME=Fixture','SPECTRUM_ID=534','DATASET_ID=MSV000099369',
   'SPECTYPE=SINGLE_SCAN','FILENAME=experiment.mzML','EXTRACTSCAN='+scan,
   'MSLEVEL=2','IONMODE=positive','PEPMASS=112.05','ADDUCT=[M+H]+',
   '51 '+intensity,'END IONS'
 ].join('\n'),config,metadata)
 const first=record(81,20), second=record(82,20), revised=record(81,25)
 assert.notEqual(first.accession,second.accession)
 assert.equal(first.accession,revised.accession)
 assert.notEqual(first.sha256,revised.sha256)
})

test('MSP preserves peak annotations containing semicolons between peak columns', () => {
 const {parsePublishedSpectrum}=require('../scripts/customer-delivery/source-upload.cjs')
 const text='Name: Fixture\nNum Peaks: 2\n100.1 70 "reference; second note"; 101.2 30 "isotope; another note"'
 const record=parsePublishedSpectrum(text,{adapter:'file',sourceId:'45',sourceName:'KI-GIAR'},{format:'msp'})
 assert.deepEqual(record.record.spectra[0].peaks,[{mz:100.1,intensity:70},{mz:101.2,intensity:30}])
})

test('multisource API keeps immutable paged batches, publish-only visibility, receipt retries and stale guards',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-updates-')),origin=fixture(directory),initialHash=hash(fs.readFileSync(origin))
 const files=new FileLibraries(path.join(directory,'libraries')),libraryId=files.register(origin).libraryId
 const store={data:{},authenticate(token){return{id:token,role:token==='customer'?'customer':'admin'}},mutate:async fn=>fn(),event(){}}
 const server=http.createServer(createService({directory,fileLibraryRoot:files.root,store,requirePublication:true}).handler)
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const call=async(route,body={},token='a')=>{const r=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',body:JSON.stringify(body),headers:{authorization:'Bearer '+token}});return{status:r.status,data:await r.json()}}
 const api=(action,body,token)=>call('/admin/source-updates/'+action,body,token)
 try{
  assert.equal((await api('list',{},'customer')).status,403)
  const list=await api('list');assert.equal(list.data.catalog.length,52)
  assert.equal(list.data.catalog.filter(s=>s.adapter==='file').length,37)
  assert.equal((await api('configure',{sourceId:'2',scope:'any',libraryId})).status,400)
  const t=await api('configure',{sourceId:'59',scope:'官方当前版本',libraryId});assert.equal(t.status,200)
  const other=await api('configure',{sourceId:'1',scope:'AAFC',libraryId});assert.equal(other.status,200)
  assert.equal((await api('configure',{sourceId:'59',scope:'官方当前版本',libraryId})).status,400)
  const taskId=t.data.id,batchId=randomUUID(),folder=path.join(directory,'source-updates','batches',batchId)
  fs.mkdirSync(folder,{recursive:true})
  fs.writeFileSync(path.join(folder,'batch.json'),JSON.stringify({taskId,batchId,libraryId,version:'fixture',count:106,compounds:1,invalid:0}))
  const db=new DatabaseSync(path.join(folder,'candidates.sqlite'));db.exec('CREATE TABLE candidates(accession TEXT PRIMARY KEY,payload TEXT);CREATE TABLE invalid(line INTEGER,reason TEXT)')
  for(let i=1;i<=106;i++){const c=parseGNPS(i===106?sample(i,{peaks_json:sample(1).peaks_json}):sample(i),'fixture',i===106?'MIADB':'LEAFBOT');db.prepare('INSERT INTO candidates VALUES(?,?)').run(c.accession,JSON.stringify(c))}db.close()
  let first=(await api('compare',{taskId,batchId})).data
  assert.equal(first.rows.length,100);assert.equal(first.total,106);assert.equal(first.counts.new,105);assert.equal(first.counts.duplicate,1)
  assert.equal((await api('compare',{taskId:other.data.id,batchId})).status,409)
  assert.equal(files.rows({libraryId}).total,3)
  const selected=first.rows.slice(0,2).map(r=>r.accession),input={taskId,batchId,revision:first.revision,selected}
  assert.equal((await api('publish',input)).status,409)
  const publish=body=>call('/admin/publication/'+randomUUID(),{method:'POST',route:'/admin/source-updates/publish',body})
  assert.equal((await publish({...input,selected:[sample(106).spectrum_id]})).status,409)
  const published=await publish(input);assert.equal(published.status,200,JSON.stringify(published));assert.equal(published.data.addedSpectra,2)
  assert.equal(files.rows({libraryId}).total,4)
  const retry=await publish(input);assert.equal(retry.data.duplicate,true)
  const stale=await publish({...input,selected:[first.rows[2].accession]});assert.equal(stale.status,409)
  first=(await api('compare',{taskId,batchId,filter:'all'})).data;assert.equal(first.counts.existing,2);assert.equal(first.counts.attach,103);assert.equal(first.counts.merge,1)
  const page2=(await api('compare',{taskId,batchId,page:2,filter:'all'})).data;assert.equal(page2.rows.length,6)
  const merge=first.rows.find(r=>r.status==='merge')||page2.rows.find(r=>r.status==='merge')
  assert.ok(merge)
  const linked=await publish({...input,revision:first.revision,selected:[merge.accession]});assert.equal(linked.status,200);assert.equal(linked.data.addedSpectra,0);assert.equal(linked.data.linkedSources,1)
  const fresh=(await api('compare',{taskId,batchId,filter:'all'})).data;assert.equal(fresh.counts.existing,3)
  first.revision=fresh.revision
  const next=await publish({...input,revision:first.revision,selected:[page2.rows[0].accession]});assert.equal(next.status,200)
  const result=files.rows({libraryId});assert.equal(result.total,4)
  const inspect=(await api('inspect',{taskId,batchId,accession:selected[0]})).data
  assert.ok(inspect.upstream);assert.ok(inspect.previous);assert.ok(inspect.current)
  const nextBatch=randomUUID(),nextFolder=path.join(directory,'source-updates','batches',nextBatch);fs.mkdirSync(nextFolder)
  fs.writeFileSync(path.join(nextFolder,'batch.json'),JSON.stringify({adapter:'gnps',scope:'LEAFBOT',taskId,batchId:nextBatch,libraryId,version:'next',count:1,compounds:1,invalid:0}))
  const later=new DatabaseSync(path.join(nextFolder,'candidates.sqlite'));later.exec('CREATE TABLE candidates(accession TEXT PRIMARY KEY,payload TEXT);CREATE TABLE invalid(line INTEGER,reason TEXT)')
  const kept=parseGNPS(sample(2),'next','LEAFBOT');later.prepare('INSERT INTO candidates VALUES(?,?)').run(kept.accession,JSON.stringify(kept));later.close()
  const disappearance=await api('compare',{taskId,batchId:nextBatch});assert.equal(disappearance.data.counts.missing,2)
  const missing=disappearance.data.rows.find(r=>r.status==='missing')
  assert.equal((await api('inspect',{taskId,batchId:nextBatch,accession:missing.accession})).data.upstream,null)
  assert.equal(files.rows({libraryId}).total,4)
  const all=(await api('compare',{taskId,batchId,selectAll:true})).data
  assert.equal(all.eligibleIds.length,102)
  assert.ok(!all.eligibleIds.includes(merge.accession))
  const bulkInput={taskId,batchId,revision:all.revision,selected:all.eligibleIds}
  const bulk=await publish(bulkInput);assert.equal(bulk.status,200,JSON.stringify(bulk));assert.equal(bulk.data.addedSpectra,102)
  assert.equal((await publish(bulkInput)).data.duplicate,true)
  assert.equal((await api('compare',{taskId,batchId,selectAll:true})).data.eligibleIds.length,0)
  assert.equal(hash(fs.readFileSync(origin)),initialHash)
 }finally{await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true})}
})

test('confirmed review candidates can be staged and published',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-review-confirmed-')),origin=fixture(root),key='KWILGNNWGSNMPA-UHFFFAOYSA-N'
 try{
  const base=new DatabaseSync(origin),source=massbankSource('MSBNK-AAFC-REVIEW01','Removed source',key)
  base.prepare('UPDATE 化合物 SET 结构标识=? WHERE 化合物ID=2').run(key)
  base.prepare('UPDATE 来源记录 SET 来源JSON=? WHERE 来源记录ID=1').run(JSON.stringify({source_record_id:source.accession}))
  base.close()
  const files=new FileLibraries(path.join(root,'libraries')),entry=files.register(origin),libraryId=entry.libraryId
  files.mutate({libraryId,action:'delete',id:1,revision:entry.revision})
  const batchId=randomUUID(),folder=path.join(root,'source-updates','batches',batchId);fs.mkdirSync(folder,{recursive:true})
  const candidate=require('../scripts/customer-delivery/massbank-record.cjs').parseRecord(source,'fixture')
  fs.writeFileSync(path.join(folder,'batch.json'),JSON.stringify({adapter:'massbank',scope:'AAFC',batchId,libraryId,version:'fixture',count:1,compounds:1,invalid:0}))
  const db=new DatabaseSync(path.join(folder,'candidates.sqlite'));db.exec('CREATE TABLE candidates(accession TEXT PRIMARY KEY,payload TEXT);CREATE TABLE invalid(line INTEGER,reason TEXT)');db.prepare('INSERT INTO candidates VALUES(?,?)').run(candidate.accession,JSON.stringify(candidate));db.close()
  const compared=files.sourceCompare({libraryId,batchFolder:folder});assert.equal(compared.rows[0].status,'review')
  const published=files.sourcePublish({libraryId,batchFolder:folder,selected:[candidate.accession],confirmed:[candidate.accession],revision:compared.revision,hash:'review-confirmed',actor:'test'})
  assert.equal(published.changed,1);assert.equal(published.addedSpectra,1)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('new source publish commands stage privately and replay through explicit publication',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-pending-')),crypto=require('node:crypto'),ts=require('typescript'),vm=require('node:vm')
 const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/main/services/pendingChanges.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 let actor='a',writes=0
 const module={exports:{}},deps={electron:{app:{getPath:()=>root},dialog:{}},'node:async_hooks':require('node:async_hooks'),'node:crypto':crypto,'node:fs':fs,'node:path':path,'../../shared/editDrafts.mjs':require('../src/shared/editDrafts.mjs'),'../delivery':{adminEditIdentity:()=>({owner:actor,session:1})}}
 vm.runInNewContext(source,{exports:module.exports,module,require:name=>deps[name],Buffer,structuredClone})
 const api=module.exports,input={taskId:'one',batchId:randomUUID(),revision:'revision',selected:['CCMSLIB0001']}
 try{
  const staged=await api.stageChange('delivery:call',['POST','/admin/source-updates/publish',input]);assert.ok(staged.staged);assert.equal(writes,0)
  actor='b';assert.equal(api.listPendingChanges().length,0);actor='a'
  api.registerPublishHandler('delivery:call',async(_event,method,route,body)=>{assert.equal(method,'POST');assert.equal(route,'/admin/source-updates/publish');assert.equal(body.batchId,input.batchId);assert.ok(api.publishedOperationId());writes++;return{addedSpectra:1}})
  await api.publishPendingChange(staged.operationId);await api.publishPendingChange(staged.operationId);assert.equal(writes,1)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('uploaded MSP batches are parsed and compared before publication',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-upload-')),origin=fixture(root),files=new FileLibraries(path.join(root,'libraries')),libraryId=files.register(origin).libraryId
 const store={data:{},authenticate:t=>({id:t,role:'admin'}),mutate:async fn=>fn(),event(){}}
 const server=http.createServer(createService({directory:root,fileLibraryRoot:files.root,store}).handler);await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const body={libraryId,filename:'upload.msp',content:Buffer.from('Name: Mellein\nInChIKey: KWILGNNWGSNMPA-UHFFFAOYSA-N\nPrecursorMZ: 179.07\nIonMode: Positive\nPrecursorType: [M+H]+\nMS Level: 2\nNum Peaks: 2\n101 55\n102 12\n').toString('base64')}
 try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/admin/source-updates/upload',{method:'POST',body:JSON.stringify(body),headers:{authorization:'Bearer admin'}});assert.equal(r.status,200);const uploaded=await r.json();assert.equal(uploaded.spectra,1);const cmp=await fetch('http://127.0.0.1:'+server.address().port+'/admin/source-updates/compare',{method:'POST',body:JSON.stringify({taskId:uploaded.taskId,batchId:uploaded.batchId}),headers:{authorization:'Bearer admin'}});assert.equal((await cmp.json()).rows.length,1)}finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
})



test('upload parsers retain original, reject malformed peaks, preserve unknown metadata and stable repeat identity',()=>{
 const {saveUpload}=require('../scripts/customer-delivery/source-upload.cjs')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upload-parser-'))
 const content='Name: Good\nInChIKey: AAAAAAAAAAAAAA-BBBBBBBBBB-C\nNum Peaks: 2\n101 20\n102 30\n\nName: Bad\nNum Peaks: 1\n-1 20\n'
 try{
  const input={filename:'real.msp',libraryId:'test',content:Buffer.from(content).toString('base64')},a=saveUpload(root,input),b=saveUpload(root,input)
  assert.equal(a.count,1);assert.equal(a.invalid,1)
  const read=batch=>{const db=new DatabaseSync(path.join(root,'batches',batch.batchId,'candidates.sqlite'));try{return JSON.parse(db.prepare('SELECT payload FROM candidates').get().payload)}finally{db.close()}}
  const c=read(a);assert.equal(c.accession,read(b).accession);assert.equal(c.polarity,null);assert.equal(c.level,null)
  assert.equal(fs.readFileSync(path.join(root,'batches',a.batchId,'original.msp'),'utf8'),content)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'batches',a.batchId,'progress.json'),'utf8')).phase,'compare')
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
const {saveUpload}=require('../scripts/customer-delivery/source-upload.cjs')
test('re-uploading a published file finds existing spectra instead of adding duplicates',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upload-repeat-')),origin=fixture(root),files=new FileLibraries(path.join(root,'libraries')),libraryId=files.register(origin).libraryId
 try{
  const input={filename:'repeat.mgf',libraryId,content:Buffer.from('BEGIN IONS\nTITLE=Unique uploaded chemical\nINCHIKEY=AAAAAAAAAAAAAA-BBBBBBBBBB-C\nMSLEVEL=2\nIONMODE=Positive\nPEPMASS=179.07 500\nADDUCT=[M+H]+\n101 55\n102 12\nEND IONS\n').toString('base64')}
  const a=saveUpload(root,input),folder=path.join(root,'batches',a.batchId),first=files.sourceCompare({libraryId,batchFolder:folder,selectAll:true})
  assert.equal(first.eligibleIds.length,1)
  const published=files.sourcePublish({libraryId,batchFolder:folder,selected:first.eligibleIds,revision:first.revision,hash:'upload-repeat-test',actor:'test'})
  assert.equal(published.addedSpectra,1)
  const b=saveUpload(root,input),again=files.sourceCompare({libraryId,batchFolder:path.join(root,'batches',b.batchId),selectAll:true})
  assert.equal(again.counts.existing,1);assert.equal(again.eligibleIds.length,0)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})

test('legacy MassBank traceback becomes a short status and preserves the last completed batch',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-legacy-error-'))
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
 const data=path.join(directory,'source-updates'),batchId=randomUUID()
 fs.mkdirSync(data)
 const task={id:randomUUID(),sourceId:'1',scope:'AAFC',libraryId:'file:fixture',enabled:true,batchId,
   spectra:950,error:'检查未完成：ExperimentalWarning\nTraceback\nhttp.client.IncompleteRead: truncated'}
 fs.writeFileSync(path.join(data,'tasks.json'),JSON.stringify([task]))
 const {sourceUpdates}=require('../scripts/customer-delivery/source-updates.cjs')
 const list=await sourceUpdates({directory,fileOp:async()=>[]}).list()
 assert.equal(list.tasks[0].batchId,batchId)
 assert.equal(list.tasks[0].spectra,950)
 assert.match(list.tasks[0].error,/上游响应中断.*上次成功结果仍可查看/)
 assert.doesNotMatch(list.tasks[0].error,/Traceback|ExperimentalWarning|IncompleteRead/)
})
