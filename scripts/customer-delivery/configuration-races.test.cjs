const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {Store}=require('./store.cjs'),{createService}=require('./server.cjs');
test('asynchronous configuration failures preserve old snapshots and remove only newly generated uncommitted outputs',async t=>{
 for(const failure of ['disabled-account','deleted-original'])await t.test(failure,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'msl-configuration-race-')),store=new Store(directory),keys=crypto.generateKeyPairSync('ed25519');
  await store.createUser({username:'race_admin',password:'test-password',role:'admin'});const customer=await store.createUser({username:'race_customer',password:'test-password',customerName:'测试客户'}),token=(await store.login('race_admin','test-password')).token;
  const oldId=crypto.randomUUID(),newId=crypto.randomUUID(),oldDir=path.join(directory,'datasets',oldId),newDir=path.join(directory,'datasets',newId),policy={fields:{compound:['main_name']},features:{}};
  fs.mkdirSync(oldDir,{recursive:true});fs.writeFileSync(path.join(oldDir,'manifest.json'),JSON.stringify({id:oldId}));fs.writeFileSync(path.join(oldDir,'keep.txt'),'original snapshot');
  store.data.releases.push({id:oldId,tenantId:customer.tenantId,version:'initial',state:'published',title:'旧交付',policy});
  const service=createService({directory,store,connect:null,engine:null,privateKey:keys.privateKey,publicKey:keys.publicKey.export({type:'spki',format:'pem'})});let finish;
  service.builder.build=async()=>{fs.mkdirSync(newDir);fs.writeFileSync(path.join(newDir,'manifest.json'),JSON.stringify({id:newId}));return new Promise(resolve=>finish=()=>resolve({id:newId,title:'新交付',total:1,policy}))};
  const server=http.createServer(service.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}/admin/releases`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({customerName:'测试客户',tenantId:customer.tenantId,deliveryAt:'2026-10-28T00:00:00Z',access:{mode:'online',userId:customer.id},policy,selections:[{libraryId:'test'}],replacesId:oldId,expectedRevision:'initial'})});assert.equal(response.status,202);const job=await response.json();assert(finish);
   if(failure==='disabled-account')store.data.users.find(u=>u.id===customer.id).disabled=true;else store.data.releases[0].state='deleted';finish();
   for(let i=0;i<100&&service.jobs.get(job.id).state==='building';i++)await new Promise(r=>setTimeout(r,5));
   assert.equal(service.jobs.get(job.id).state,'failed');assert.equal(store.data.releases.length,1);assert.equal(store.data.releases[0].id,oldId);assert.equal(fs.readFileSync(path.join(oldDir,'keep.txt'),'utf8'),'original snapshot');assert(!fs.existsSync(newDir));
  }finally{await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true})}
 });
});
