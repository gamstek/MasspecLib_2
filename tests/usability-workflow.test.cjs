const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto')
const {LocalReviews}=require('../src/shared/localReviews.mjs'),{projectClassification,classificationCatalog}=require('../src/shared/deliveryClassification.mjs')
const {Store}=require('../scripts/customer-delivery/store.cjs'),{createService}=require('../scripts/customer-delivery/server.cjs'),{ClassificationService}=require('../scripts/customer-delivery/classification.cjs')
test('local review validates check and reason, survives restart and remains isolated by customer and release',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'local-review-'))
 try{const record={id:'record',checks:[{id:'check'}]},value=new LocalReviews(root,'customer-a');const result=value.add('release-a',record,{checkId:'check',action:'reviewed',reason:'符合规则'},'operator');assert(result.id);assert.equal(new LocalReviews(root,'customer-a').list('release-a','record').length,1);assert.equal(value.list('release-b','record').length,0);assert.equal(new LocalReviews(root,'customer-b').list('release-a','record').length,0);assert.throws(()=>value.add('release-a',record,{checkId:'other',action:'reviewed',reason:'x'},'operator'));assert.throws(()=>value.add('release-a',record,{checkId:'check',action:'reviewed',reason:' '},'operator'));assert.equal(value.read().length,1)}finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('original classification labels can be delivered as detail data independently of normalized categories',()=>{
 const value={catalog:[{namespace:'u',category_code:'one',category_name:'类别',axis:'application',parent_code:null}],items:[{key:'["u","one"]',review_status:'candidate_pending_review'}],source_labels:[' 原表标签 ','123','123'],source_path:'/private'}
 const raw=projectClassification(value,['source_labels']);assert.deepEqual(raw.catalog,[]);assert.deepEqual(raw.items,[]);assert.deepEqual(raw.source_labels,['原表标签','123']);assert(!JSON.stringify(raw).includes('/private'))
 const normalized=projectClassification(value,['categories']);assert.equal(normalized.items.length,1);assert.equal(normalized.items[0].review_status,undefined);assert.equal(normalized.source_labels,undefined)
})
test('HTTP drafts reject stale edits and deletion, preserve other drafts, and strip plaintext passwords',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'draft-contract-')),store=new Store(root),pair=crypto.generateKeyPairSync('ed25519');await store.createUser({username:'admin',password:'admin-password',role:'admin'});const token=(await store.login('admin','admin-password')).token
 const service=createService({directory:root,connect:null,engine:null,privateKey:pair.privateKey,publicKey:'test',store}),server=http.createServer(service.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const request=async(data,auth=token,suffix='')=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/admin/drafts${suffix}`,{method:'POST',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:JSON.stringify(data)});return{status:response.status,value:await response.json()}}
 try {
   assert.equal((await request({customerName:'a'},'invalid')).status,401)
   const first=await request({customerName:'a',password:'sensitive',loginAccount:{password:'sensitive'}})
   assert.equal(first.status,200)
   assert.equal(first.value.password,undefined)
   assert.equal(first.value.loginAccount,undefined)
   const next=await request({...first.value,notes:'new'})
   assert.equal(next.value.revision,2)
   assert.equal((await request({...first.value,notes:'stale'})).status,409)
   assert.equal((await request(first.value,'invalid','/delete')).status,401)
   assert.equal((await request(first.value,token,'/delete')).status,409)
   const second=await request({customerName:'b'})
   assert.equal(new Store(root).data.drafts[0].notes,'new')
   assert.equal((await request(next.value,token,'/delete')).status,200)
   assert.equal((await request({...next.value,notes:'stale after deletion'})).status,409)
   assert.equal((await request(next.value,token,'/delete')).status,200)
   const reloaded=new Store(root)
   assert.deepEqual(reloaded.data.drafts.map(draft=>draft.id),[second.value.id])
   assert(reloaded.data.events.some(event=>event.action==='delete-delivery-draft'))
   assert(!fs.readFileSync(reloaded.file,'utf8').includes('sensitive'))
 } finally { await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true}) }

})
test('manual classification locks can be undone without modifying source databases',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'unlock-contract-')),database='mspec_lib2_shared_00000000000000000001'
 const connect=async()=>({query:async sql=>sql.includes('FROM mspec_lib2_catalog.libraries')?[[{database_name:database,title:'test'}]]:sql.includes('taxonomy_categories')?[[{id:1,namespace:'unified-consolidated-v2',category_code:'one',category_name:'one',axis:'application',parent_code:null}]]:[[]],end:async()=>{}})
 try{const service=new ClassificationService(root,connect);await service.state('admin');await service.mutate('admin','fixture',d=>{d.assignments[JSON.stringify([database,'1'])]={database,id:'1',categories:[],locked:true}});await service.unlock({records:[{database,id:'1'}]},'admin');assert.equal(Object.keys((await service.state('admin')).assignments).length,0);await assert.rejects(()=>service.unlock({records:[{database:'bad',id:'1'}]},'admin'))}finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('batched navigation counts deduplicate ancestors, obey active rows and manual overrides across source libraries',async()=>{
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(':memory:'),root=fs.mkdtempSync(path.join(os.tmpdir(),'counts-contract-')),local='mspec_lib2_shared_00000000000000000001',project='mspec_lib2_shared_00000000000000000002',libraries=[{database_name:local,title:'local'},{database_name:project,title:'project'}]
 for(const name of [local,project]){db.exec(`ATTACH ':memory:' AS ${name};CREATE TABLE ${name}.compounds(id INTEGER PRIMARY KEY,is_delete INTEGER,is_in_trash INTEGER);CREATE TABLE ${name}.taxonomy_categories(id INTEGER,namespace TEXT,category_code TEXT,category_name TEXT,parent_code TEXT,axis TEXT);CREATE TABLE ${name}.compound_taxonomy(compound_id INTEGER,category_id INTEGER)`)}
 db.exec(`INSERT INTO ${local}.compounds VALUES(1,0,0),(2,0,0),(3,0,1);INSERT INTO ${local}.taxonomy_categories VALUES(1,'unified-consolidated-v2','parent','Parent',NULL,'application'),(2,'unified-consolidated-v2','child','Child','parent','application');INSERT INTO ${local}.compound_taxonomy VALUES(1,1),(1,2),(2,2),(3,2);INSERT INTO ${project}.compounds VALUES(10,0,0),(11,0,0);INSERT INTO ${project}.taxonomy_categories VALUES(8,'source','raw','Raw',NULL,'source_taxonomy');INSERT INTO ${project}.compound_taxonomy VALUES(10,8),(11,8)`)
 const connect=async()=>({query:async(sql,params=[])=>sql.includes('FROM mspec_lib2_catalog.libraries')?[libraries]:[db.prepare(sql).all(...params)],end:async()=>{}})
 try{const service=new ClassificationService(root,connect);await service.state('admin');await service.saveMapping({database:project,sourceKey:'["source","raw"]',targets:['["unified-consolidated-v2","child"]']},'admin');await service.mutate('admin','fixture',d=>{d.assignments[JSON.stringify([project,'11'])]={database:project,id:'11',categories:[],locked:true}});const result=await service.counts([local,project],'admin'),a=result.libraries.find(l=>l.database===local),b=result.libraries.find(l=>l.database===project);assert.equal(a.total,2);assert.equal(a.pending,0);assert.equal(a.counts['["unified-consolidated-v2","parent"]'],2);assert.equal(b.total,2);assert.equal(b.pending,0);assert.equal(b.counts['["unified-consolidated-v2","other"]'],1);assert.equal(b.counts['["unified-consolidated-v2","parent"]'],1)}finally{db.close();fs.rmSync(root,{recursive:true,force:true})}
})
