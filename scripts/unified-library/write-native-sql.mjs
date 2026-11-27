import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { decodePackage, contentHash, hasEntityProvenance } from '../../src/shared/dataPackage.ts'
const [input,output]=process.argv.slice(2)
if(!input||!output)throw new Error('用法：node --experimental-strip-types scripts/unified-library/write-native-sql.mjs <已完成转换目录> <SQL输出目录>')
const report=JSON.parse(fs.readFileSync(path.join(input,'conversion-report.json'),'utf8'))
if(report.errors.length)throw new Error('转换有错误，拒绝生成可用SQL')
fs.mkdirSync(output,{recursive:true})
const filename=path.join(output,'01_导入转换数据.sql')
if(fs.existsSync(filename))throw new Error('SQL已存在，请使用新输出目录')
const initialization=fs.readFileSync('prisma/masspeclib2-initialize.sql','utf8')
const guardedInitialization=`-- Run only in the selected NEW EMPTY database. Existing tables are never dropped.\nSET NAMES utf8mb4;\nDELIMITER $$\nDROP PROCEDURE IF EXISTS __ml2_initialize_empty$$\nCREATE PROCEDURE __ml2_initialize_empty() SQL SECURITY INVOKER\nBEGIN\nIF DATABASE() IS NULL OR DATABASE() IN ('mysql','information_schema','performance_schema','sys') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REFUSED: select a new application database'; END IF;\nIF EXISTS(SELECT 1 FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY DATABASE()) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REFUSED: target database is not empty'; END IF;\n${initialization}\nEND$$\nCALL __ml2_initialize_empty()$$\nDROP PROCEDURE __ml2_initialize_empty$$\nDELIMITER ;\n`
fs.writeFileSync(path.join(output,'00_初始化空库.sql'),guardedInitialization)
const initializationManifest=JSON.parse(fs.readFileSync('prisma/masspeclib2-initialize.sql.manifest.json','utf8'))
fs.writeFileSync(path.join(output,'00_初始化空库.sql.manifest.json'),JSON.stringify({...initializationManifest,sha256:createHash('sha256').update(guardedInitialization).digest('hex'),guarded:true},null,2))
const stream=fs.createWriteStream(filename),sha=createHash('sha256'),counts={},libraries=new Map(),categoryIds=new Map(),sourceRecords=new Map()
const now=new Date().toISOString().slice(0,19).replace('T',' ')
let buffer='',prefix=0,chunk=0
const quote=value=>value===null||value===undefined?'NULL':typeof value==='number'?(Number.isFinite(value)?String(value):(()=>{throw new Error('非有限数值')})()):typeof value==='boolean'?(value?'1':'0'):'CONVERT(0x'+Buffer.from(typeof value==='string'?value:JSON.stringify(value),'utf8').toString('hex')+' USING utf8mb4)'
const next=table=>(counts[table]=(counts[table]??0)+1)
function insert(table,data){buffer+='INSERT INTO `'+table+'` ('+Object.keys(data).map(k=>'`'+k+'`').join(',')+') VALUES ('+Object.values(data).map(quote).join(',')+');\n'}
const pick=(record,keys)=>Object.fromEntries(keys.filter(k=>record[k]!==undefined).map(k=>[k,record[k]]))
const compoundFields=['main_name','name_zh','name_en','name','cas','formula','molecular_mass','monoisotopic_mass','identifiers','properties']
const msFields=['ms_mode','transition_role','q1','q3','ce','dp','cxp','polarity','ion_source','scan_mode','cad_value','cad_type','adduct','ce_unit','energy_type','conditions']
const lcFields=['lc_mode','chromatographic_column_mode','column_type','column_length_mm','column_inner_diameter_mm','column_particle_size_um','column_temperature_c','elution_mode','program_text','retention_time','retention_time_unit','phase_A','phase_B','conditions']
const spFields=['kind','peaks','image_base64','image_mime','spectrum_type','polarity','adduct','precursor_mz','collision_energy','conditions','nature','raw']
const itemFields=['time','percentage_A','percentage_B','flow_rate','time_unit','flow_rate_unit','components','step_order']
async function write(text){sha.update(text);if(!stream.write(text))await once(stream,'drain')}
function library(origin){
 const old=libraries.get(origin.namespace);if(old)return old
 const id=next('spectral_libraries');libraries.set(origin.namespace,id)
 insert('spectral_libraries',{id,namespace:origin.namespace,name:origin.name??origin.namespace,source_type:origin.source_type??origin.sourceType??'unknown',...pick(origin,['version','provider','license','location'])});return id
}
function source(libraryId,key,hash,raw,decision,batchId){
 const sig=JSON.stringify([libraryId,key,hash]);if(sourceRecords.has(sig))return sourceRecords.get(sig)
 const id=next('source_records');sourceRecords.set(sig,id)
 insert('source_records',{id,library_id:libraryId,source_key:key,content_hash:hash,raw,decision,batch_id:batchId,created_at:now});return id
}
function link(sourceId,type,id){insert('entity_sources',{id:next('entity_sources'),source_record_id:sourceId,entity_type:type,entity_id:id,revision_at_import:1})}
async function flush(){
 if(!buffer)return
 const name='__ml2_convert_'+String(++chunk),expected=prefix,after=counts.compounds??0
 await write(`DROP PROCEDURE IF EXISTS \`${name}\`$$\nCREATE PROCEDURE \`${name}\`() SQL SECURITY INVOKER\nBEGIN\nDECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;\nIF NOT EXISTS(SELECT 1 FROM app_metadata WHERE id=1 AND product='MasspecLib2' AND schema_version=4 AND state='pending') OR NOT ((SELECT COUNT(*) FROM compounds)<=>${expected}) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REFUSED: needs new pending schema 4 and correct previous chunks'; END IF;\nSTART TRANSACTION;\n${buffer}COMMIT;\nEND$$\nCALL \`${name}\`()$$\nDROP PROCEDURE \`${name}\`$$\n`)
 buffer='';prefix=after
}
await write('-- MasspecLib2 / schema 4; use only after 00 in a NEW EMPTY database.\n-- Data remains pending until final counts and peak-count check succeed.\nSET NAMES utf8mb4;\nDELIMITER $$\n')
let first=true
for(const part of report.parts){
 const bytes=fs.readFileSync(path.join(input,part.file))
 if(createHash('sha256').update(bytes).digest('hex')!==part.sha256)throw new Error('包哈希改变 '+part.file)
 const data=decodePackage(bytes)
 if(first){for(const cat of data.taxonomyCatalog??[]){const id=next('taxonomy_categories');categoryIds.set(JSON.stringify([cat.namespace,cat.category_code]),id);insert('taxonomy_categories',{id,...cat})}first=false}
 const batch=next('import_batches');insert('import_batches',{id:batch,package_id:data.packageId,content_hash:part.sha256,mapping_version:data.mappingVersion,status:'completed',cursor:data.groups.length,report:{imported:data.groups.length,generated_from_package:true},created_at:now,updated_at:now})
 for(const group of data.groups){
  const compoundId=next('compounds'),entityIds=new Map([['compound:',compoundId]]),methods=new Map()
  const hasOrigin=(type,id)=>hasEntityProvenance(group,type,id)
  insert('compounds',{id:compoundId,...pick(group.compound,compoundFields),is_favorite:false,is_in_trash:false,is_delete:false,create_time:now,update_time:now,revision:1})
  const primary=source(library(group.source),group.source.key,contentHash(group),group,'created',batch);link(primary,'compound',compoundId)
  for(const assignment of group.classifications??[]){insert('compound_taxonomy',{compound_id:compoundId,category_id:categoryIds.get(JSON.stringify([assignment.namespace,assignment.category_code])),evidence:assignment.evidence??[]});next('compound_taxonomy')}
  for(const m of group.methods??[]){const id=next('ms_methods');methods.set(m.localId,id);entityIds.set('ms_method:'+m.localId,id);insert('ms_methods',{id,compounds_id:compoundId,...pick(m,msFields),create_time:now,update_time:now,revision:1});if(!hasOrigin('ms_method',m.localId))link(primary,'ms_method',id)}
  for(const m of group.lcMethods??[]){const id=next('lc_methods');entityIds.set('lc_method:'+m.localId,id);insert('lc_methods',{id,compounds_id:compoundId,...pick(m,lcFields),create_time:now,update_time:now,revision:1});if(!hasOrigin('lc_method',m.localId))link(primary,'lc_method',id)
   for(const [i,step]of(m.items??[]).entries())insert('lc_methods_items',{id:next('lc_methods_items'),lc_methods_id:id,...pick(step,itemFields),step_order:step.step_order??i,create_time:now,update_time:now})}
  for(const sp of group.spectra??[]){const id=next('spectra');entityIds.set('spectrum:'+sp.localId,id);insert('spectra',{id,compound_id:compoundId,...pick(sp,spFields),revision:1,created_at:now,updated_at:now});if(!hasOrigin('spectrum',sp.localId))link(primary,'spectrum',id)
   for(const localId of sp.methodLocalIds??[]){insert('spectrum_method_links',{spectrum_id:id,method_id:methods.get(localId)});next('spectrum_method_links')}}
  for(const evidence of group.provenance??[]){const record=evidence.source_record,origin=record?.library;if(!origin)continue
   const id=entityIds.get(evidence.appliesTo+':'+(evidence.entityId??''));if(!id)throw new Error('来源关联悬空')
   const raw={original:record.raw??evidence,importedWithSourceRecord:primary}
   const sr=source(library(origin),String(record.source_key??group.source.key),contentHash(raw),raw,'evidence',batch)
   link(sr,evidence.appliesTo,id)
  }
  if(buffer.length>4*1024*1024)await flush()
 }
}
await flush()
const checks=Object.entries(counts).map(([table,total])=>`(SELECT COUNT(*) FROM \`${table}\`)<>${total}`).join(' OR ')
await write(`DROP PROCEDURE IF EXISTS __ml2_convert_finish$$\nCREATE PROCEDURE __ml2_convert_finish() SQL SECURITY INVOKER\nBEGIN\nIF ${checks} OR (SELECT COALESCE(SUM(JSON_LENGTH(peaks)),0) FROM spectra)<>${report.peaks} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INCOMPLETE: counts mismatch; database remains pending'; END IF;\nUPDATE app_metadata SET state='ready',instance_id=UUID() WHERE id=1 AND product='MasspecLib2' AND schema_version=4 AND state='pending';\nSELECT 'CONVERSION_IMPORTED' result,${report.convertedGroups} identity_groups,${report.spectra} spectra,${report.peaks} peaks;\nEND$$\nCALL __ml2_convert_finish()$$\nDROP PROCEDURE __ml2_convert_finish$$\nDELIMITER ;\n`)
stream.end();await once(stream,'finish')
fs.writeFileSync(path.join(output,'sql-manifest.json'),JSON.stringify({sourceReport:path.resolve(input,'conversion-report.json'),targetSchemaVersion:4,dataFile:path.basename(filename),sha256:sha.digest('hex'),counts,chunks:chunk,peaks:report.peaks},null,2))
console.log(JSON.stringify({sql:filename,counts,chunks:chunk},null,2))
