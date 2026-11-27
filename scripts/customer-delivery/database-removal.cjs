const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fail}=require('./policy.cjs');
// Called only after server-side admin password reauthentication. No caller paths.
async function removeServerDatabase({libraryId,fileLibraries,connect,maintenanceConnect,directory,removeWorkspaceReference}){
 if(typeof libraryId!=='string')fail('数据库标识无效');
 if(libraryId.startsWith('file:')){
  const entry=fileLibraries.entry(libraryId),state=fileLibraries.state(),files=[];
  if(entry.adapter==='unified-sqlite'||entry.adapter==='lds-cn'){if(require('./unified-sqlite.cjs').signature(entry.origin)!==entry.sourceSignature)fail('源文件修订已变化，请重新关联后再执行',409);files.push(entry.origin)}
  else{
   const dir=fs.realpathSync(entry.origin);
   const matches=fs.readdirSync(dir).filter(n=>n.endsWith('.sqlite')).map(n=>path.join(dir,n)).filter(p=>{try{return require('./file-libraries.cjs').inspectFile(p).libraryId===entry.id}catch{return false}});
   if(matches.length!==1)fail('源文件无法唯一确认，已阻止删除；可先解除关联',409);files.push(matches[0]);
  }
  const archive=path.join(directory,'database-trash',crypto.randomUUID());fs.mkdirSync(archive,{recursive:true,mode:0o700});const moved=[];
  try{
   for(const file of files){if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())fail('源文件不安全');if(fs.existsSync(file+'-wal')&&fs.statSync(file+'-wal').size)fail('源库仍在写入，已阻止删除',409);const target=path.join(archive,path.basename(file));fs.renameSync(file,target);moved.push([file,target])}
   const managed=path.resolve(fileLibraries.root,'libraries',entry.id);if(!/^[a-f0-9-]{36}$/.test(entry.id)||path.dirname(managed)!==path.resolve(fileLibraries.root,'libraries'))fail('管理目录无效');
   if(fs.existsSync(managed)){const target=path.join(archive,'managed-revisions');fs.renameSync(managed,target);moved.push([managed,target])}
   fs.writeFileSync(path.join(archive,'restore.json'),JSON.stringify({entry,moved}),{mode:0o600});state.libraries=state.libraries.filter(e=>e.id!==entry.id);fileLibraries.save(state);
  }catch(e){for(const [file,target]of moved.reverse())if(fs.existsSync(target))fs.renameSync(target,file);throw e}
  return{removed:true,serverDataRemoved:true,recovery:'server-trash'};
 }
 if(!/^[a-f0-9]{64}$/.test(libraryId))fail('仅支持服务器登记的数据库');
 if(!maintenanceConnect)fail('服务器未配置数据库删除权限；仍可解除软件关联',409);
 const reader=await connect();let row;
 try{const [rows]=await reader.query('SELECT id,database_name FROM mspec_lib2_catalog.libraries WHERE id=?',[libraryId]);row=rows[0]}finally{await reader.end()}
 if(!row||!/^mspec_lib2_shared_[a-f0-9]{20}$/.test(row.database_name))fail('不允许删除此数据库',403);
 const admin=await maintenanceConnect()
 try {
  const restoreReference=removeWorkspaceReference?.(row.database_name)
  try {
   await admin.query('DROP DATABASE `'+row.database_name+'`')
  } catch (error) {
   if (restoreReference) {
    const result=await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[row.database_name]).catch(()=>null)
    if (result?.[0].length) restoreReference()
   }
   throw error
  }
  await admin.query('DELETE FROM mspec_lib2_catalog.libraries WHERE id=?',[libraryId])
 } finally {await admin.end()}
 return{removed:true,serverDataRemoved:true,recovery:'none'};
}
module.exports={removeServerDatabase};
