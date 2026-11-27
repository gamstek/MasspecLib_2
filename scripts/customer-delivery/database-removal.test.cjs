const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {FileLibraries,createLibrary}=require('./file-libraries.cjs'),{Store}=require('./store.cjs'),{createService}=require('./server.cjs'),{removeServerDatabase}=require('./database-removal.cjs');
test('server removal rejects missing/wrong passwords and removes only the chosen synthetic file after admin reauthentication',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'database-removal-')),source=path.join(dir,'source/library.sqlite');createLibrary(source,{title:'Synthetic database',records:[{id:'x',compound:{main_name:'Synthetic'},ms:[],lc:[],spectra:[]}]});const files=new FileLibraries(path.join(dir,'source-libraries')),entry=files.register(source),store=new Store(dir);await store.createUser({username:'admin',password:'test-password',role:'admin'});const token=(await store.login('admin','test-password')).token,pair=crypto.generateKeyPairSync('ed25519');const service=createService({directory:dir,store,connect:async()=>{throw Error('must not access SQL')},engine:null,privateKey:pair.privateKey,publicKey:pair.publicKey});const server=http.createServer(service.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const call=async(password,auth=true)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/admin/file-sources/delete-database',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({libraryId:entry.libraryId,password})});return{status:r.status,data:await r.json()}};
 const workspaceFile=path.join(dir,'admin-workspace.json')
 const peer='file:'+crypto.randomUUID()
 const config={schemaVersion:1,libraries:[entry.libraryId,peer],defaultLibrary:entry.libraryId,
  columns:['name_en'],pageSize:50,navigationWidth:235,expandedCategories:[],openMenus:['databases']}
 fs.writeFileSync(workspaceFile,JSON.stringify(config))
 const workspace=()=>JSON.parse(fs.readFileSync(workspaceFile,'utf8'))
 try {
  assert.equal((await call('test-password',false)).status,401)
  assert.equal((await call('wrong-password')).status,403)
  assert.equal((await call()).status,403)
  assert.deepEqual(workspace(),config)
  assert.equal(files.list().length,1)
  fs.renameSync(source,source+'.hidden')
  assert.equal((await call('test-password')).status,409)
  assert.deepEqual(workspace(),config)
  fs.renameSync(source+'.hidden',source)
  const result=await call('test-password')
  assert.equal(result.status,200)
  assert.equal(result.data.recovery,'server-trash')
  assert.deepEqual(workspace(),{...config,libraries:[peer],defaultLibrary:peer})
  assert(!fs.existsSync(source))
  assert.equal(files.list().length,0)
  assert.equal(fs.readdirSync(path.join(dir,'database-trash')).length,1)
  assert(store.data.events.some(e=>e.action==='delete-server-database'))
 } finally {
  await new Promise(r=>server.close(r))
  fs.rmSync(dir,{recursive:true,force:true})
 }
});
test('SQL deletion is catalog scoped, never interpolates caller schema names and requires configured maintenance credentials',async()=>{
 const id='a'.repeat(64),queries=[],connect=async()=>({query:async()=>[[{database_name:'mspec_lib2_shared_'+'1'.repeat(20)}]],end:async()=>{}}),maintenanceConnect=async()=>({query:async(...args)=>queries.push(args),end:async()=>{}});
 await assert.rejects(()=>removeServerDatabase({libraryId:'mysql; DROP DATABASE system',connect,maintenanceConnect}),/仅支持/);await assert.rejects(()=>removeServerDatabase({libraryId:id,connect}),/未配置/);assert.equal(queries.length,0);
 await removeServerDatabase({libraryId:id,connect,maintenanceConnect});assert.equal(queries[0][0],'DROP DATABASE `mspec_lib2_shared_'+'1'.repeat(20)+'`');assert.deepEqual(queries[1][1],[id]);
 await assert.rejects(()=>removeServerDatabase({libraryId:id,maintenanceConnect,connect:async()=>({query:async()=>[[{database_name:'mysql'}]],end:async()=>{}})}),/不允许/);
});
test('a failed SQL drop restores the workspace reference only if the original database is still present',async()=>{
 const databaseName='mspec_lib2_shared_'+'1'.repeat(20)
 const connect=async()=>({query:async()=>[[{database_name:databaseName}]],end:async()=>{}})
 for (const stillExists of [true,false]) {
  let restored=false
  const removeWorkspaceReference=key=>{
   assert.equal(key,databaseName)
   return ()=>{restored=true}
  }
  const maintenanceConnect=async()=>({
   query:async sql=>{
    if (sql.startsWith('DROP ')) throw Error('Simulated SQL failure')
    return [stillExists?[{SCHEMA_NAME:databaseName}]:[]]
   },
   end:async()=>{}
  })
  await assert.rejects(()=>removeServerDatabase({
   libraryId:'a'.repeat(64),connect,maintenanceConnect,removeWorkspaceReference
  }),/Simulated SQL failure/)
  assert.equal(restored,stillExists)
 }
});
