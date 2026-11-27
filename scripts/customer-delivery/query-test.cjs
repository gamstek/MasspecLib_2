const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const {Store}=require('./store.cjs'),{createService}=require('./server.cjs');
test('advanced online queries, negative polarity, cross-page favorites, exports and authorization agree',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'msl-query-')),store=new Store(dir),pair=crypto.generateKeyPairSync('ed25519'),id=crypto.randomUUID();
 const user=await store.createUser({username:'query_customer',customerName:'Query',password:'test-password'}),login=await store.login('query_customer','test-password');
 fs.mkdirSync(path.join(dir,'datasets',id),{recursive:true});const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
 const rows=Array.from({length:75},(_,i)=>{const rid=hash(String(i)).slice(0,32),record={id:rid,sourceKey:'one',compound:{main_name:'记录'+i,name_en:'Sample '+i},ms:[{q1:i===74?184:200,q3:143,polarity:0}],checks:[]};const bytes=JSON.stringify(record);fs.writeFileSync(path.join(dir,'datasets',id,rid+'.json'),bytes);return{id:rid,sourceKey:'one',compound:record.compound,sha256:hash(bytes)}});
 const index=JSON.stringify(rows);fs.writeFileSync(path.join(dir,'datasets',id,'index.json'),index);
 store.data.releases.push({id,tenantId:user.tenantId,indexHash:hash(index),state:'published',policy:{fields:{compound:['main_name','name_en'],ms:['q1','q3','polarity']},features:{export:true}}});
 const service=createService({directory:dir,store,connect:null,engine:null,privateKey:pair.privateKey,publicKey:pair.publicKey.export({type:'spki',format:'pem'})}),server=http.createServer(service.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const post=async(route,data)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/releases/${id}/${route}`,{method:'POST',headers:{Authorization:'Bearer '+login.token,'Content-Type':'application/json'},body:JSON.stringify(data)});return{status:res.status,data:await res.json()}};
 try{
 const advanced=await post('query',{q1:184,polarity:0});assert.equal(advanced.status,200);assert.equal(advanced.data.total,1);assert.equal(advanced.data.rows[0].id,rows[74].id);
 const favorites=await post('query',{recordIds:[rows[74].id]});assert.equal(favorites.data.total,1);assert.deepEqual(favorites.data.matchedIds,[rows[74].id]);
 const exported=await post('export',{q1:184,polarity:0,fields:['main_name']});assert.equal(exported.status,200);assert.deepEqual(exported.data.records.map(r=>r.id),[rows[74].id]);
 const tolerant=await post('query',{q1:184.1,massTolerance:0.1,polarity:0});assert.equal(tolerant.data.total,1);
 const tolerantExport=await post('export',{q1:184.1,massTolerance:0.1,polarity:0,fields:['main_name']});assert.deepEqual(tolerantExport.data.records.map(r=>r.id),[rows[74].id]);
 assert.equal((await post('query',{q1:184,massTolerance:11})).status,400);
 assert.equal((await post('query',{q1:'invalid'})).status,400);store.data.releases[0].policy.fields.ms=[];assert.equal((await post('query',{polarity:0})).status,403);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
});
