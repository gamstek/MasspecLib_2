const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http')
const {randomUUID,createHash}=require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const {createService}=require('../scripts/customer-delivery/server.cjs')
const {FileLibraries}=require('../scripts/customer-delivery/file-libraries.cjs')
const {buildDetailIndex}=require('../scripts/customer-delivery/lds-detail-index.cjs')
const {publicationStore}=require('../scripts/customer-delivery/publication.cjs')
const {saveUpload}=require('../scripts/customer-delivery/source-upload.cjs')
const {sourceUpdates}=require('../scripts/customer-delivery/source-updates.cjs')
const {prepare}=require('../scripts/customer-delivery/lds-sqlite.cjs')
const {fixture}=require('./fixtures/lds-fixture.cjs')

function temporary(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'priority-workflow-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  return directory
}
async function api(t,directory,store) {
  const server=http.createServer(createService({directory,store,requirePublication:true}).handler)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  return async(route,body)=>{
    const response=await fetch('http://127.0.0.1:'+server.address().port+route,{
      method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body),
      headers:{Authorization:'Bearer audit','Content-Type':'application/json'}
    })
    return {status:response.status,data:await response.json()}
  }
}

test('publishing a file register adds it to the workspace, and removed files are excluded from update and delivery',async t=>{
  const directory=temporary(t),file=fixture(directory)
  fs.writeFileSync(path.join(directory,'admin-workspace.json'),JSON.stringify({
    schemaVersion:1,libraries:[],defaultLibrary:null,columns:['name_en'],pageSize:50,navigationWidth:240,expandedCategories:[]
  }))
  const call=await api(t,directory,{data:{},authenticate:()=>({id:'admin',role:'admin'}),mutate:async fn=>fn(),event(){}})
  assert.equal((await call('/admin/workspace')).data.libraries.length,0)
  const result=await call('/admin/publication/'+randomUUID(),{method:'POST',route:'/admin/file-sources/register',body:{directory:file}})
  assert.equal(result.status,201)
  const id=result.data.libraryId
  assert.deepEqual((await call('/admin/workspace')).data.libraries,[id])
  assert.equal((await call('/admin/workspace/library-visibility',{key:id,removed:true})).status,200)
  assert.equal((await call('/admin/file-sources')).data.libraries.length,0)
  assert.equal((await call('/admin/source-updates/list',{})).data.libraries.some(l=>l.libraryId===id),false)
  assert.equal((await call('/admin/libraries')).data.some(l=>l.id===id),false)
  assert.equal((await call('/admin/candidates',{libraryId:id})).status,409)
  assert.equal((await call('/admin/workspace/library-visibility',{key:id,removed:false})).status,200)
  assert.deepEqual((await call('/admin/workspace')).data.libraries,[id])
})

test('explicit rejection retries; a successful or uncertain publication is never executed twice',async t=>{
  const publications=publicationStore(temporary(t)),input={method:'POST',route:'/admin/file-sources/register',body:{directory:'/fixture'}}
  const id=randomUUID(),uncertainId=randomUUID()
  let attempts=0
  const run=async(_,res)=>{attempts++;res.writeHead(attempts===1?409:201);res.end(JSON.stringify({attempts}))}
  assert.equal((await publications.execute('a',id,input,'token',run)).state,'rejected')
  assert.equal((await publications.execute('a',id,input,'token',run)).status,201)
  assert.equal((await publications.execute('a',id,input,'token',run)).status,201)
  assert.equal(attempts,2)
  await assert.rejects(publications.execute('a',id,{...input,body:{directory:'/other'}},'token',run),/内容已变化/)
  const failed=async(_,res)=>{attempts++;res.writeHead(500);res.end('{}')}
  assert.equal((await publications.execute('a',uncertainId,input,'token',failed)).state,'uncertain')
  await assert.rejects(publications.execute('a',uncertainId,input,'token',run),/待核对/)
  assert.equal(attempts,3)
})

test('format rejects a missing query field, and the derived index gives lookup plans without touching the source',t=>{
  const directory=temporary(t),file=fixture(directory),files=new FileLibraries(path.join(directory,'managed'))
  const {libraryId}=files.register(file),entry=files.entry(libraryId),originalDigest=createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  buildDetailIndex(files.root,entry)
  const {db}=prepare(files.root,entry)
  try {
    for(const view of ['source_by_compound','links_by_compound','category_by_compound','mrm_by_compound']){
      const plan=db.prepare('EXPLAIN QUERY PLAN SELECT * FROM '+view+' WHERE lookup_compound_id=?').all(1).map(row=>row.detail)
      assert.match(plan.join(' '),/SEARCH i USING PRIMARY KEY/)
      assert.match(plan.join(' '),/SEARCH s USING INTEGER PRIMARY KEY/)
    }
  } finally { db.close() }
  assert.equal(files.rows({libraryId,details:true,onlySelected:true,compoundIds:[1]}).rows[0].record.spectra.length,1)
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),originalDigest)
  const writable=new DatabaseSync(file)
  try {writable.exec('ALTER TABLE 来源记录 RENAME COLUMN 加和方式 TO 旧加和方式')} finally{writable.close()}
  assert.match(files.checkFormat({directory:file}).issue,/来源记录.加和方式/)
})

test('rebuilding a library index removes stale revisions after the new index is active',t=>{
  const directory=temporary(t),file=fixture(directory),files=new FileLibraries(path.join(directory,'managed'))
  const {libraryId}=files.register(file),first=files.entry(libraryId)
  const firstIndex=buildDetailIndex(files.root,first)
  const source=new DatabaseSync(file)
  try { source.prepare('UPDATE 化合物 SET 化合物名称=? WHERE 化合物ID=1').run('Compound 1 revised') } finally { source.close() }
  const second={...first,sourceSignature:require('../scripts/customer-delivery/unified-sqlite.cjs').signature(file)}
  const secondIndex=buildDetailIndex(files.root,second)
  assert.notEqual(secondIndex,firstIndex)
  assert.equal(fs.existsSync(secondIndex),true)
  assert.equal(fs.existsSync(firstIndex),false)
  assert.deepEqual(fs.readdirSync(path.dirname(secondIndex)).filter(name=>/^detail-index-[a-f0-9]{20}\.sqlite$/.test(name)),[path.basename(secondIndex)])
})

test('same upstream accession and changed peaks become visible upload conflicts',t=>{
  const directory=temporary(t)
  const make=(id,intensity)=>({spectrum_id:'CCMSLIB'+id,Compound_Name:'Audit',peaks_json:JSON.stringify([[20,intensity]]),ms_level:2,
    Ion_Mode:'Positive',Adduct:'[M+H]+',Precursor_MZ:123.4,InChIKey_smiles:'AAAAAAAAAAAAAA-BBBBBBBBBB-C'})
  const upload=saveUpload(directory,{filename:'conflict.json',libraryId:'fixture',
    content:Buffer.from(JSON.stringify([make('1',10),make('1',99),make('2',10),make('2',10)])).toString('base64')})
  assert.deepEqual([upload.count,upload.duplicates,upload.conflicts,upload.invalid],[1,1,1,2])
  const db=new DatabaseSync(path.join(directory,'batches',upload.batchId,'candidates.sqlite'),{readOnly:true})
  try {
    assert.equal(db.prepare('SELECT accession FROM candidates').get().accession,'CCMSLIB2')
    assert.match(db.prepare('SELECT reason FROM invalid LIMIT 1').get().reason,/CCMSLIB1/)
  } finally {db.close()}
})

test('website probe rejects a non-success response and never presents HTML size as a database version',async t=>{
  const directory=temporary(t),updates=sourceUpdates({directory,fileOp:async()=>[]})
  const source=(await updates.list()).catalog.find(item=>item.adapter==='snapshot')
  const task=await updates.configure({sourceId:source.id,scope:'官方当前版本',libraryId:''})
  const original=global.fetch
  try {
    global.fetch=async()=>new Response(null,{status:404,headers:{'content-length':'1234'}})
    await assert.rejects(updates.check({taskId:task.id}),/404/)
    assert.equal((await updates.list()).tasks[0].batchId,undefined)
    global.fetch=async()=>new Response(null,{status:200,headers:{'content-length':'1234'}})
    await updates.check({taskId:task.id})
    assert.match((await updates.list()).tasks[0].version,/未检查谱库版本/)
  } finally {global.fetch=original}
})

test('online category navigation, classified query and unclassified export use the same data scope',async t=>{
  const directory=temporary(t),id=randomUUID(),snapshot=path.join(directory,'datasets',id)
  fs.mkdirSync(snapshot,{recursive:true})
  const hash=value=>createHash('sha256').update(value).digest('hex')
  const category={namespace:'audit',category_code:'a',category_name:'Audit',axis:'application'}
  const key=JSON.stringify([category.namespace,category.category_code])
  const rows=[true,false].map(classified=>{
    const rid=randomUUID().replaceAll('-',''),compound={main_name:classified?'Classified':'Unclassified'}
    const classification=classified?{catalog:[category],items:[{key}]}:undefined
    const record={id:rid,sourceKey:'one',compound,classification},bytes=JSON.stringify(record)
    fs.writeFileSync(path.join(snapshot,rid+'.json'),bytes)
    return {...record,sha256:hash(bytes)}
  })
  const payload=JSON.stringify(rows);fs.writeFileSync(path.join(snapshot,'index.json'),payload)
  const release={id,tenantId:'customer',indexHash:hash(payload),state:'published',
    policy:{fields:{compound:['main_name'],ms:[]},features:{classification:true,export:true}}}
  const call=await api(t,directory,{data:{},authenticate:()=>({id:'customer',role:'customer',tenantId:'customer'}),authorize:()=>release,mutate:async fn=>fn(),event(){}})
  const query=await call('/releases/'+id+'/query',{categoryKeys:[key],source:'one'})
  assert.equal(query.status,200)
  assert.equal(query.data.classification.unclassified,1)
  assert.deepEqual(query.data.rows.map(row=>row.id),[rows[0].id])
  const exported=await call('/releases/'+id+'/export',{unclassified:true,fields:['main_name']})
  assert.equal(exported.status,200)
  assert.deepEqual(exported.data.records.map(row=>row.id),[rows[1].id])
})
