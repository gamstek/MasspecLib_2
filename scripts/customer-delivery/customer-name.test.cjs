const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {customerFor}=require('./customer-name.cjs'),{Store}=require('./store.cjs'),{createService}=require('./server.cjs');
test('Name resolution reuses stable identities, handles duplicates explicitly and accepts legacy IDs',()=>{
 const tenants=[{id:'a',name:'海南药检所'},{id:'b',name:'重复客户'},{id:'c',name:'重复客户'}];
 assert.equal(customerFor(tenants,{customerName:' 海南药检所 '}).tenant.id,'a');
 assert.equal(customerFor(tenants,{tenantId:'a'}).tenant.id,'a');
 assert.equal(customerFor(tenants,{tenantId:'a',customerName:''}).tenant.id,'a');
 assert.equal(customerFor(tenants,{customerName:'新客户'}).created,true);
 assert.throws(()=>customerFor(tenants,{customerName:'重复客户'}),/同名/);
 assert.equal(customerFor(tenants,{tenantId:'c',customerName:'重复客户'}).tenant.id,'c');
 for(const input of [{customerName:''},{customerName:'x'.repeat(121)},{tenantId:'missing'},{tenantId:'a',customerName:'其他客户'}])assert.throws(()=>customerFor(tenants,input));
 assert.equal(tenants.length,3);
});
test('Name-only configuration reuses account tenant and failed builds preserve old deliveries',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'msl-customer-name-')),store=new Store(directory),pair=crypto.generateKeyPairSync('ed25519');
 await store.createUser({username:'test_admin',password:'test-password',role:'admin'});const token=(await store.login('test_admin','test-password')).token;
 const account=await store.createUser({username:'new_customer',password:'test-password',customerName:'新客户'});
 const service=createService({directory,store,connect:null,engine:null,privateKey:pair.privateKey,publicKey:pair.publicKey.export({type:'spki',format:'pem'})});
 let failBuild=false;service.builder.build=async input=>{if(failBuild)throw Object.assign(new Error('测试构建失败'),{status:400});return{id:crypto.randomUUID(),title:input.title,version:input.version,total:1,origins:[],sources:[],policy:input.policy}};
 const server=http.createServer(service.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=async input=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/admin/releases`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({customerName:'新客户',deliveryAt:'2026-10-28T00:00:00Z',access:{mode:'online',userId:account.id},policy:{fields:{compound:['main_name']}},selections:[{libraryId:'library'}],...input})});return{status:res.status,body:await res.json()}};
 const done=async id=>{for(let i=0;i<100;i++){const job=service.jobs.get(id);if(job.state!=='building')return job;await new Promise(r=>setTimeout(r,5))}throw Error('job timeout')};
 try {
  assert.equal((await post({customerName:' '})).status,400);
  assert.equal((await post({access:null})).status,400);assert.equal(store.data.releases.length,0);
  const first=await post({});assert.equal(first.status,202);assert.equal((await done(first.body.id)).state,'ready');const tenant=store.data.tenants[0];assert.equal(tenant.name,'新客户');assert.equal(store.data.releases[0].tenantId,tenant.id);
  const second=await post({customerName:' 新客户 '});assert.equal((await done(second.body.id)).state,'ready');assert.equal(store.data.tenants.length,1);assert.equal(store.data.releases[1].tenantId,tenant.id);
  failBuild=true;const failed=await post({replacesId:store.data.releases[0].id,expectedRevision:store.data.releases[0].version});assert.equal((await done(failed.body.id)).state,'failed');assert.equal(store.data.releases.length,2);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true})}
});
