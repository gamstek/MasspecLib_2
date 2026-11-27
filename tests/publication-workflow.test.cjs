const {test}=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),vm=require('node:vm')
const {Store}=require('../scripts/customer-delivery/store.cjs')
const {createLibrary, projectRecord}=require('../scripts/customer-delivery/file-libraries.cjs')
const {createService}=require('../scripts/customer-delivery/server.cjs')
const {normalizePolicy}=require('../scripts/customer-delivery/policy.cjs')
test('publishing a new import creates one searchable server library and restores the same receipt',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'new-import-test-'))
 const uploadRoot=path.join(root,'uploads')
 const store=new Store(root)
 await store.createUser({username:'admin',password:'publication-test-password',role:'admin'})
 const token=(await store.login('admin','publication-test-password')).token
 fs.writeFileSync(path.join(root,'admin-workspace.json'),JSON.stringify({schemaVersion:1,libraries:[],defaultLibrary:null,columns:['cas'],pageSize:50,navigationWidth:235,expandedCategories:[]}))
 const server=http.createServer(createService({directory:root,store,requirePublication:true,databaseUploadRoot:uploadRoot}).handler)
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const call=async(route,body)=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body&&JSON.stringify(body)})
  return {status:response.status,data:await response.json()}
 }
 try {
  const id=crypto.randomUUID(), libraryId='file:'+id
  const body={id,title:'新建测试库',hash:'a'.repeat(64),records:[{compound:{main_name:'Imported sample',cas:'123-45-6'}}]}
  const route='/admin/file-sources/create-import',publication='/admin/publication/'+id
  assert.equal((await call(route,body)).status,409)
  assert.deepEqual((await call('/admin/workspace')).data.libraries,[])
  const request={method:'POST',route,body}
  const created=await call(publication,request)
  assert.equal(created.status,201,JSON.stringify(created.data))
  assert.equal(created.data.total,1)
  assert.equal(created.data.origin,path.join(uploadRoot,id,'library.sqlite'))
  assert.deepEqual(await call(publication,request),created)
  assert.deepEqual((await call('/admin/workspace')).data.libraries,[libraryId])
  const rows=await call('/admin/file-sources/records',{libraryId,keyword:'Imported sample'})
  assert.equal(rows.data.total,1)
  assert.equal(rows.data.rows[0].main_name,'Imported sample')
  const invalidId=crypto.randomUUID()
  assert.equal((await call('/admin/publication/'+invalidId,{...request,body:{...body,id:invalidId,title:'无效测试库',records:[{compound:{main_name:''}}]}})).status,400)
  assert.deepEqual((await call('/admin/workspace')).data.libraries,[libraryId])
 } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
})
test('durable publication receipts prevent repeating file mutations and reject old direct writes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'publication-test-'))
 const store=new Store(root)
 await store.createUser({username:'admin',password:'publication-test-password',role:'admin'})
 const token=(await store.login('admin','publication-test-password')).token
 const source=path.join(root,'input/library.sqlite')
 createLibrary(source,{title:'Test',records:[{id:'one',compound:{main_name:'Before'}}]})
 let server
 const start=async()=>{
  server=http.createServer(createService({directory:root,store,requirePublication:true}).handler)
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
 }
 await start()
 const call=async(route,body,auth=token)=>{
  const r=await fetch('http://127.0.0.1:'+server.address().port+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
  return{status:r.status,data:await r.json()}
 }
 try{
  assert.equal((await call('/admin/file-sources/register',{directory:path.dirname(source)})).status,409)
  const registration=crypto.randomUUID(),url='/admin/publication/'+registration
  const first=await call(url,{method:'POST',route:'/admin/file-sources/register',body:{directory:path.dirname(source)}})
  assert.equal(first.status,201)
  const libraryId=first.data.libraryId
  assert.deepEqual(await call(url,{method:'POST',route:'/admin/file-sources/register',body:{directory:path.dirname(source)}}),first)
  const updateId=crypto.randomUUID(),updateUrl='/admin/publication/'+updateId
  const input={method:'POST',route:'/admin/file-sources/update-compound',body:{libraryId,id:1,revision:first.data.revision,compound:{main_name:'Published'}}}
  assert.equal((await call(updateUrl,input,'invalid')).status,401)
  const updated=await call(updateUrl,input);assert.equal(updated.status,200)
  await new Promise(r=>server.close(r));await start()
  const receipt=await call(updateUrl)
  assert.equal(receipt.data.state,'completed')
  assert.deepEqual(await call(updateUrl,input),updated)
  assert.equal((await call('/admin/file-sources/record',{libraryId,id:1})).data.record.compound.main_name,'Published')
  assert.equal((await call('/admin/publication/'+crypto.randomUUID(),{method:'POST',route:'/admin/users',body:{}})).status,400)
 }finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
})
test('client projections contain parsed LC values only when authorized',()=>{
 const raw={compound:{main_name:'Test'},lc:[{id:'one',column_type:'BEH C18 1.7um, 2.1x100mm, Waters',phase_A:JSON.stringify([{field:'SolventA',value:'Water'},{field:'SolventB',value:'ACN'}]),program_text:'95/5 at 0 min, 5/95 at 10 min',gradient:[]}]}
 const before=JSON.stringify(raw)
 const policy=normalizePolicy({fields:{compound:['main_name'],lc:['phase_A','phase_B','column_length_mm','gradient']},features:{lc:true}})
 const record=projectRecord(raw,policy,'id','library','Test','stable')
 assert.equal(record.lc[0].phase_A,'Water');assert.equal(record.lc[0].phase_B,'ACN')
 assert.equal(record.lc[0].column_length_mm,100);assert.equal(record.lc[0].gradient.length,2)
 assert.equal(record.lc[0].column_particle_size_um,undefined);assert.equal(record.lc[0].program_text,undefined)
 assert.equal(JSON.stringify(raw),before)
})
test('pending changes are private, persist input, replay once, and keep partial failure results',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pending-test-'))
 let actor='admin-a',writes=0
 const ts=require('typescript')
 const src=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/main/services/pendingChanges.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const module={exports:{}}
 const deps={electron:{app:{getPath:()=>root},dialog:{}},'node:async_hooks':require('node:async_hooks'),'node:crypto':crypto,'node:fs':fs,'node:path':path,'../../shared/editDrafts.mjs':require('../src/shared/editDrafts.mjs'),'../delivery':{adminEditIdentity:()=>({owner:actor,session:1})}}
 vm.runInNewContext(src,{exports:module.exports,module,require:name=>{if(!deps[name])throw Error(name);return deps[name]},Buffer,structuredClone})
 const api=module.exports
 try{
  const payload={connectionId:'file:one',compound:{main_name:'Private'}}
  const staged=await api.stageChange('federation:create',[payload])
  payload.compound.main_name='later'
  assert.equal(writes,0)
  actor='admin-b';assert.equal(api.listPendingChanges().length,0)
  actor='admin-a'
  api.registerPublishHandler('federation:create',async(_event,input)=>{
   assert.equal(input.compound.main_name,'Private')
   assert.equal(await api.stageChange('federation:create',[input]),undefined)
   assert(api.publishedOperationId().startsWith(staged.operationId))
   writes++;return{success:true,ref:{connectionId:input.connectionId,key:'10'}}
  })
  await api.publishPendingChange(staged.operationId)
  await api.publishPendingChange(staged.operationId)
  assert.equal(writes,1)
  assert.equal(api.listPendingChanges()[0].status,'completed')
  api.discardPendingChange(staged.operationId)
  assert.equal(api.listPendingChanges().length,0)
  const failed=await api.stageChange('import:undo',[22])
  api.registerPublishHandler('import:undo',async()=>{throw Error('network-result-unknown')})
  await assert.rejects(api.publishPendingChange(failed.operationId),/network/)
  assert.equal(api.listPendingChanges()[0].status,'uncertain')
  await assert.rejects(api.publishPendingChange(failed.operationId),/尚未确认/)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})

