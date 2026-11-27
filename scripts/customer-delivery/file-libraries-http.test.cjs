const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http')
const {createLibrary}=require('./file-libraries.cjs'),{createService}=require('./server.cjs'),{Store}=require('./store.cjs'),{decryptOffline}=require('../../src/shared/offlineAccess.mjs')
test('admin file source APIs protect writes, feed real snapshots and packages, and preserve existing deliveries after source deletion',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'msl-file-api-')),store=new Store(dir),pair=crypto.generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),incoming=path.join(dir,'incoming'),templateFile=path.join(dir,'template.zip')
 fs.writeFileSync(templateFile,'template');createLibrary(path.join(incoming,'library.sqlite'),{title:'文件库',records:[{id:'stable-a',compound:{main_name:'甲',name_en:'A',cas:'50-00-0'},ms:[{id:'m1',q1:100.123,q3:30}]},{id:'stable-b',compound:{main_name:'乙'},ms:[]}]})
 await store.createUser({username:'admin',password:'admin-password',role:'admin'});const token=(await store.login('admin','admin-password')).token,service=createService({directory:dir,store,connect:null,engine:null,privateKey:pair.privateKey,publicKey,templateFile}),server=http.createServer(service.handler)
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const api=async(route,method='GET',body,auth=token)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()}}
 try{
  const configured=await api('/admin/access-credentials','POST',{customerName:'客户',mode:'offline',username:'customer',password:'client-password',passwordConfirm:'client-password'});assert.equal(configured.status,201)
  const registered=await api('/admin/file-sources/register','POST',{directory:incoming});assert.equal(registered.status,201);const libraryId=registered.body.libraryId,revision=registered.body.revision
  const query=await api('/admin/file-sources/records','POST',{libraryId});assert.equal(query.body.total,2)
  const detail=await api('/admin/file-sources/record','POST',{libraryId,id:1});assert.equal(detail.body.record.ms[0].q1,100.123)
  assert.equal((await api('/admin/file-sources/access','POST',{libraryId,readOnly:true})).status,200)
  assert.equal((await api('/admin/file-sources/record','POST',{libraryId,id:1})).body.readOnly,true)
  for (const [action, payload] of [
    ['change',{action:'delete',ids:[1]}],
    ['update-compound',{id:1,compound:{main_name:'禁止的编辑'}}],
    ['mutate',{action:'import',records:[]}],
    ['restore',{}]
  ]) {
    assert.equal((await api('/admin/file-sources/'+action,'POST',{libraryId,revision,...payload})).status,403)
  }
  assert.equal((await api('/admin/file-sources/access','POST',{libraryId,readOnly:false})).status,200)
  assert.equal((await api('/admin/file-sources/record','POST',{libraryId,id:1})).body.readOnly,false)
  const selection={libraryId,revision,onlySelected:true,compoundIds:[1]},built=await api('/admin/releases','POST',{tenantId:configured.body.tenantId,customerName:'客户',deliveryAt:new Date().toISOString(),access:configured.body.access,selections:[selection],policy:{fields:{compound:['main_name'],ms:['q1']},features:{spectra:true,deleteRecords:true,restoreRecords:true}}});assert.equal(built.status,202)
  for(let i=0;i<100&&service.jobs.get(built.body.id).state==='building';i++)await new Promise(r=>setTimeout(r,5));const job=service.jobs.get(built.body.id);assert.equal(job.state,'ready');const id=job.releaseId
  assert.equal((await api(`/admin/releases/${id}/publish`,'POST',{})).status,200)
  const changed=await api('/admin/file-sources/change','POST',{libraryId,revision,action:'delete',ids:[1]});assert.equal(changed.status,200);assert.equal((await api('/admin/file-sources/records','POST',{libraryId})).body.total,1)
  assert.equal((await api('/admin/file-sources/change','POST',{libraryId,revision,action:'delete',ids:[2]})).status,409)
  const packaged=await api(`/admin/releases/${id}/package`,'POST',{});assert.equal(packaged.status,200);const data=await decryptOffline(packaged.body.payload.offline,'customer','client-password',publicKey,configured.body.tenantId);assert.equal(data.records.length,1);assert.equal(data.records[0].compound.main_name,'甲');assert.equal(data.records[0].compound.cas,undefined);assert.equal(data.records[0].ms[0].q3,undefined);assert(data.manifest.policy.features.deleteRecords)
  const other=await store.createUser({username:'outside',password:'other-password',customerName:'另一个客户'}),customerToken=(await store.login(other.username,'other-password')).token
  assert.equal((await api('/admin/file-sources/change','POST',{libraryId,action:'purge',ids:[1]},customerToken)).status,403);assert.equal((await api('/admin/file-sources','GET',undefined,'bad-token')).status,401)
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
})
