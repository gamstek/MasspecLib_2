const {test} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto')
const {ClassificationService} = require('../scripts/customer-delivery/classification.cjs')
const {createService} = require('../scripts/customer-delivery/server.cjs')
const {categoryKey,classificationPlan,classificationWhere} = require('../src/shared/classification.mjs')
const {DatabaseSync} = require('node:sqlite')
const localDB='mspec_lib2_shared_00000000000000000001', projectDB='mspec_lib2_shared_00000000000000000002'
const category=(id,code,axis,ns)=>({id,namespace:ns,category_code:code,category_name:code,parent_code:null,axis})
const local={...category(1,'pesticides','application','unified-consolidated-v2'),category_name:'农药及农残'}, project=category(8,'杀虫剂','source_taxonomy','tender')
function fixture() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'classification-')), queries=[], libraries=[{database_name:localDB,title:'本地',categories:[local]},{database_name:projectDB,title:'项目',categories:[project]}]
 const connect=async()=>({query:async(sql,params=[])=>{ queries.push({sql,params}); if (sql.includes('FROM mspec_lib2_catalog.libraries')) return [libraries.map(({categories,...l})=>l)]; if(sql.includes('taxonomy_categories')) return [libraries.find(l=>sql.includes(l.database_name)).categories]; if(sql.startsWith('USE ')) return [[]]; if(sql.startsWith('SELECT id FROM')) return [[{id:'17'}]]; return [[]] },end:async()=>{}})
 return {dir,connect,libraries,queries,service:new ClassificationService(dir,connect),cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})}
}
test('SQL filtering excludes manual override from inherited membership and preserves pending',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE compounds(id INTEGER PRIMARY KEY);CREATE TABLE compound_taxonomy(compound_id INTEGER,category_id INTEGER);INSERT INTO compounds VALUES(1),(2),(3),(4);INSERT INTO compound_taxonomy VALUES(1,8),(2,8),(3,8)')
 try {
  const plan={pending:false,nativeCategoryIds:[],ruleCategoryIds:[8],overrideIds:['2','4'],includeIds:['4']}
  const selected=classificationWhere(plan);assert.deepEqual(db.prepare('SELECT c.id FROM compounds c WHERE '+selected.where+' ORDER BY c.id').all(...selected.params).map(r=>r.id),[1,3,4])
  const pending=classificationWhere({...plan,pending:true});assert.deepEqual(db.prepare('SELECT c.id FROM compounds c WHERE '+pending.where).all(...pending.params).map(r=>r.id),[2])
 } finally{db.close()}
})
test('bootstrap retains local catalogue, future libraries default project, manual state persists independently',async()=>{
 const f=fixture()
 try{
  let s=await f.service.state('admin');assert.equal(s.roles[localDB],'local');assert.equal(s.roles[projectDB],'project');assert(s.catalog.some(c=>categoryKey(c)===categoryKey(local)));assert.equal(s.catalog.filter(c=>c.fixed).length,require('../src/shared/fixedMajors.mjs').FIXED_CLASSIFICATION_CATALOG.length)
  const third='mspec_lib2_shared_00000000000000000003';f.libraries.push({database_name:third,title:'未来导入',categories:[category(9,'不同目录','application','future')]})
  s=await f.service.state('admin');assert(!s.catalog.some(c=>c.namespace==='future'));assert.deepEqual(classificationPlan(s,s.libraries[2],s.catalog,categoryKey(local)).nativeCategoryIds,[])
  await f.service.saveMapping({database:projectDB,sourceKey:categoryKey(project),targets:[categoryKey(local)]},'admin')
  await f.service.assign({records:[{database:projectDB,id:'17'}],categories:[],mode:'replace'},'admin')
  const reloaded=new ClassificationService(f.dir,f.connect);s=await reloaded.state('admin');assert.equal(Object.values(s.assignments)[0].locked,true);assert.equal(s.mappings.length,1)
  assert(f.queries.every(q=>!/^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)/i.test(q.sql)))
  const before=fs.readFileSync(reloaded.file,'utf8');await assert.rejects(()=>reloaded.saveMapping({database:projectDB,sourceKey:'nonexistent',targets:[categoryKey(local)]},'admin'));assert.equal(fs.readFileSync(reloaded.file,'utf8'),before)
 }finally{f.cleanup()}
})
test('first startup does not interpret a tender application catalogue as the local scheme',async()=>{
 const f=fixture()
 try{
  const db='mspec_lib2_shared_00000000000000000003';f.libraries.push({database_name:db,title:'招标专用分类',categories:[category(9,'同名但不同口径','application','tender-application')]})
  const s=await f.service.state('admin');assert.equal(s.roles[db],'project');assert(!s.catalog.some(c=>c.namespace==='tender-application'))
 }finally{f.cleanup()}
})
test('editing mapping replaces same source rule; manual taxonomy children and role reference protection work',async()=>{
 const f=fixture()
 try{
  await f.service.state('admin');await f.service.saveCategory({name:'新增细类',parentKey:categoryKey(local)},'admin')
  let s=await f.service.state('admin');assert.equal(s.catalog.length,require('../src/shared/fixedMajors.mjs').FIXED_CLASSIFICATION_CATALOG.length+1);const child=s.catalog.find(c=>c.category_name==='新增细类');assert.equal(child.parent_code,local.category_code)
  await f.service.saveMapping({database:projectDB,sourceKey:categoryKey(project),targets:[categoryKey(local)]},'admin')
  await f.service.saveMapping({database:projectDB,sourceKey:categoryKey(project),targets:[categoryKey(child)],enabled:false},'admin')
  s=await f.service.state('admin');assert.equal(s.mappings.length,1);assert.equal(s.mappings[0].enabled,false)
  await assert.rejects(()=>f.service.saveRole({database:localDB,role:'project'},'admin'))
  const old=s.revision;await assert.rejects(()=>f.service.mutate('revoked','test',()=>{},()=>{throw Error('revoked')}));assert.equal(f.service.data.revision,old)
 }finally{f.cleanup()}
})
test('HTTP classification routes require authenticated administrator, never customer or anonymous',async()=>{
 const f=fixture(),pair=crypto.generateKeyPairSync('ed25519')
 const store={authenticate(token){if(!['admin','customer'].includes(token))throw Object.assign(Error('not logged in'),{status:401});return{id:token,role:token}},data:{}}
 const service=createService({directory:f.dir,connect:f.connect,engine:null,privateKey:pair.privateKey,publicKey:'test',store}),server=http.createServer(service.handler)
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port
 const request=(token,route='/admin/classification/state',method='GET',body)=>fetch(url+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
 try{
  assert.equal((await request('customer')).status,403);assert.equal((await request('')).status,401);assert(!fs.existsSync(path.join(f.dir,'classification.json')))
  const allowed=await request('admin');assert.equal(allowed.status,200);assert.equal((await allowed.json()).capabilities.ai,false)
  assert.equal((await request('customer','/admin/classification/category','POST',{name:'bad'})).status,403)
  assert.equal((await request('admin','/admin/classification/mapping','POST',{database:projectDB,sourceKey:categoryKey(project),targets:[]})).status,400)
 }finally{await new Promise(r=>server.close(r));f.cleanup()}
})
