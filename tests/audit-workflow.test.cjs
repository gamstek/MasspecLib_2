const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm'),{build}=require('esbuild');
test('Scan isolates bad records and worker failures, preserves old results on partial passes, retries, and pauses honestly',async()=>{
 const entries=[{id:'db',name:'测试库',enabled:true}],scans=[],saved=[],checks=[],cleanups=[];
 let broken=true,pauseNext=false,handlers={},service;
 const qa={
  registry:{connections:()=>entries,getState:()=>({audit:{enabled:false,intervalSeconds:60}}),saveAuditSettings(){},connection:()=>entries[0]},
  adapters:{inspect:async()=>{},forgetColumns(){},count:async(_e,f)=>f.trashOnly?0:3,rows:async(_e,f,offset)=>f.trashOnly||offset?[]:[{id:'good'},{id:'bad'},{id:'workerbad'}],detail(){}},
  reader:{sourceChoice(){},readPage:async(_e,rows)=>{if(pauseNext){pauseNext=false;handlers['audit:pause']()}if(broken&&rows.some(r=>r.id==='bad'))throw Error('原始记录无法解析');return rows.map(row=>({row:{...row,ref:{connectionId:'db',key:row.id}},classes:[],assets:[{id:row.id}]}))}},
  repository:{ready:()=>true,openRepository:async()=>{},closeRepository:async()=>{},saveMember:async r=>saved.push(r.id),saveAssets:async(_r,a)=>a,saveCheck:async a=>checks.push(a.id),transaction:async fn=>fn({}),
   sql:async(sql,args=[])=>{if(sql.startsWith('SELECT * FROM qc_scans'))return [...scans].reverse();if(sql.startsWith('SELECT'))return [];if(sql.startsWith('INSERT INTO qc_scans'))scans.push({id:args[0],connection_id:args[1],state:args[2]});if(sql.startsWith('UPDATE qc_scans')){const scan=scans.find(s=>s.id===args.at(-1));if(sql.includes("state='partial'"))scan.state='partial';else if(sql.includes("state='completed'"))scan.state='completed';else if(sql.includes('state=?'))scan.state=args[0];scan.detail=args.at(-2)}if(sql.includes('SET present=0'))cleanups.push(sql);return []},mergeMembers(){},reviewCheck(){},undoMerge(){}},
  catalog:Object.fromEntries(['assetsFor','checkDetail','checkRows','memberRows','overview','rootFor'].map(k=>[k,()=>[]]))
 };
 const names={electron:['BrowserWindow'],registry:Object.keys(qa.registry),adapters:Object.keys(qa.adapters),reader:Object.keys(qa.reader),repository:Object.keys(qa.repository),catalog:Object.keys(qa.catalog)};
 const bundle=await build({entryPoints:[path.join(__dirname,'../src/main/audit/service.ts')],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'fake-boundaries',setup(b){b.onResolve({filter:/^(electron|node:worker_threads)$|\/(registry|adapters|reader|repository|catalog)$/},a=>{let key=a.path==='electron'?'electron':a.path==='node:worker_threads'?'worker':a.path.split('/').at(-1);return{path:key,namespace:'qa'}});b.onLoad({filter:/.*/,namespace:'qa'},a=>({contents:a.path==='worker'?`const {EventEmitter}=require('node:events');export class Worker extends EventEmitter{constructor(_p,options){super();queueMicrotask(()=>this.emit('message',{results:options.workerData.assets.map(a=>globalThis.__auditBroken()&&a.id==='workerbad'?{id:a.id,error:'单条计算错误'}:{id:a.id,result:{}})}))}terminate(){return Promise.resolve()}}`:a.path==='electron'?`export const BrowserWindow={getAllWindows:()=>[]}`:names[a.path].map(n=>`export const ${n}=(...args)=>globalThis.__auditQA.${a.path}.${n}(...args)`).join(';')}))}}]});
 const context={module:{exports:{}},exports:{},require,__dirname,__auditQA:qa,__auditBroken:()=>broken,setTimeout,clearTimeout,console,queueMicrotask};context.exports=context.module.exports;context.globalThis=context;
 vm.runInNewContext(bundle.outputFiles[0].text,context);service=context.module.exports;
 service.registerAuditIPC({handle:(name,fn)=>handlers[name]=()=>fn({})});
 let status=await service.runScan(true);
 assert.equal(status.phase,'partial');assert.equal(scans.at(-1).state,'partial');assert.deepEqual(checks,['good']);assert(saved.includes('workerbad'));assert(!saved.includes('bad'));assert.equal(cleanups.length,0);assert.equal(status.stale[0],'测试库');assert.equal(JSON.parse(scans.at(-1).detail).failures,2);
 broken=false;status=await service.runScan(true);assert.equal(status.phase,'completed');assert.equal(status.stale.length,0);assert(status.lastSuccessful);assert(checks.includes('bad'));assert(checks.includes('workerbad'));assert.equal(cleanups.length,2);
 pauseNext=true;status=await service.runScan(true);assert.equal(status.phase,'paused');assert.equal(scans.at(-1).state,'paused');assert.equal(cleanups.length,2);assert.equal(status.stale[0],'测试库');
 await service.stopAudit();
});
