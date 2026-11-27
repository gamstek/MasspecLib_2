const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {SnapshotBuilder}=require('./snapshot.cjs'),{createLibrary}=require('./file-libraries.cjs'),{fields,hash,fail}=require('./policy.cjs')
// SELECT-only conversion. The original MySQL library and published deliveries are untouched.
async function convertFileLibrary({connect,engine,root,libraryId,classificationProvider}){
 if(typeof libraryId!=='string'||libraryId.startsWith('file:'))fail('请选择现有 MySQL 数据库')
 const stage=path.join(root,'staging',crypto.randomUUID());fs.mkdirSync(stage,{recursive:true,mode:0o700})
 const builder=new SnapshotBuilder(connect,path.join(stage,'snapshots'),engine);builder.classificationProvider=classificationProvider
 try{
  const libraries=await builder.libraries(),source=libraries.find(x=>x.id===libraryId);if(!source)fail('数据库不存在')
  const result=await builder.build({title:source.title,version:'file-conversion',selections:[{libraryId}],policy:{fields:Object.fromEntries(Object.entries(fields).map(([g,f])=>[g,Object.keys(f)])),features:{spectra:true,lc:true,chromatograms:true,experiments:true}}})
  const classes=[],classMap=new Map(),c=await connect()
  try{
   const selected=await builder.source(c,libraryId);await c.query('USE `'+selected.database_name+'`')
   const [available]=await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',[selected.database_name]),tables=new Set(available.map(t=>t.TABLE_NAME))
   if(tables.has('classes')&&tables.has('compound_class')){
    const [labels]=await c.query('SELECT id,class_name FROM classes ORDER BY id');classes.push(...labels.map(r=>({id:Number(r.id),class_name:r.class_name})))
    const [links]=await c.query('SELECT compound_id,class_id FROM compound_class ORDER BY compound_id,class_id')
    for(const link of links){const stable=hash('mysql:'+libraryId+':'+link.compound_id);if(!classMap.has(stable))classMap.set(stable,[]);classMap.get(stable).push(Number(link.class_id))}
   }
  }finally{await c.end()}
  const records=builder.index(result).map(r=>{const record=builder.record(result,r.id,r);return{...record,id:record.stableId,classIds:classMap.get(record.stableId)||[]}})
  const directory=path.join(root,'imports',crypto.randomUUID()),metadata=createLibrary(path.join(directory,'library.sqlite'),{title:source.title,records,classes})
  return{directory,stage,metadata}
 }catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e}
}
module.exports={convertFileLibrary}
