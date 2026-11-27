import {randomUUID} from 'node:crypto'
import {classificationCatalog,classificationKey} from './deliveryClassification.mjs'
/** SQLite file-library SQL. Inputs must already be authorized and projected. */
export function deliverySql(data:any,includeDetails:boolean):string {
 if(!Array.isArray(data?.records)||!data.records.length)throw Error('没有可导出的记录')
 const quote=(v:unknown):string=>"CAST(X'"+Buffer.from(String(v),'utf8').toString('hex')+"' AS TEXT)"
 const records=data.records.map((r:any)=>{
  if(!r.id||!r.compound?.main_name)throw Error('SQL文件库必须包含化合物名称和记录ID')
  return includeDetails?{...r,classIds:[]}:{id:r.id,sourceTitle:r.sourceTitle,compound:r.compound,ms:[],lc:[],spectra:[],sources:[],chromatograms:[],experiments:[]}
 })
 const categories=new Map<string,any>();for(const r of records)for(const c of r.classification?.catalog||[])categories.set(classificationKey(c),c)
 const metadata={product:'MasspecLib2',schemaVersion:'1',libraryId:randomUUID(),revision:randomUUID(),title:String(data.manifest?.title||'客户导出数据库').slice(0,120),classificationCatalog:JSON.stringify(classificationCatalog([...categories.values()]))}
 const lines=['-- MasspecLib2 SQLite 文件库 SQL；请在空的 SQLite 数据库中执行。','-- 仅包含当前授权范围、所选记录及字段；不含账号密码。','PRAGMA foreign_keys=ON;','BEGIN TRANSACTION;',"CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);","CREATE TABLE records(ordinal INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,class_ids TEXT NOT NULL DEFAULT '[]',trashed INTEGER NOT NULL DEFAULT 0 CHECK(trashed IN(0,1)));",'CREATE TABLE classes(id INTEGER PRIMARY KEY,class_name TEXT NOT NULL);']
 for(const [key,value]of Object.entries(metadata))lines.push(`INSERT INTO metadata(key,value) VALUES(${quote(key)},${quote(value)});`)
 records.forEach((r:any,i:number)=>lines.push(`INSERT INTO records(ordinal,id,payload,class_ids,trashed) VALUES(${i+1},${quote(r.id)},${quote(JSON.stringify(r))},'[]',0);`))
 lines.push('COMMIT;');return lines.join('\n')+'\n'
}
