import mysql from 'mysql2/promise'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { encodePackage, decodePackage, validateGroup, canonicalStringify, contentHash } from '../../src/shared/dataPackage.ts'
import { validateCatalog } from '../../src/shared/taxonomy.ts'
import { catalogFromRows, convertCompound, MAPPING_VERSION, json } from './mapping.mjs'
const options = Object.fromEntries(process.argv.slice(2).map(x => { const i=x.indexOf('=');return i<0?[x,true]:[x.slice(0,i),x.slice(i+1)] }))
if(!options['--database'] || !options['--output'] || (!options['--sample']&&!options['--all']))throw new Error('用法：npm run unified:convert -- --database=暂存库 --output=输出目录 --sample（或 --all）')
const out=path.resolve(String(options['--output']));fs.mkdirSync(out,{recursive:true})
if(fs.existsSync(path.join(out,'conversion-report.json')))throw new Error('输出目录已有转换结果，请使用新目录，避免覆盖')
const db=await mysql.createConnection({host:process.env.UNIFIED_MYSQL_HOST??'127.0.0.1',port:Number(process.env.UNIFIED_MYSQL_PORT??44715),user:process.env.UNIFIED_MYSQL_USER??'root',password:process.env.UNIFIED_MYSQL_PASSWORD??'',database:String(options['--database']),jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true,charset:'utf8mb4'})
const query=async(sql,params=[]) => (await db.query(sql,params))[0]
const warnings=[], errors=[], parts=[]
const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,clean(v)])) : value
let part=[],partBytes=0, converted=0,spectra=0,peaks=0,methods=0,lc=0,assignments=0,last=0
const started=Date.now()
try {
 await db.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
 const categories=await query('SELECT * FROM categories ORDER BY category_id'),catalog=catalogFromRows(categories);validateCatalog(catalog)
 fs.writeFileSync(path.join(out,'taxonomy-catalog.json'),JSON.stringify(catalog,null,2))
 const files=new Map((await query('SELECT * FROM files')).map(x=>[String(x.file_id),x]))
 const publicSources=new Map((await query('SELECT * FROM library_public_sources')).map(x=>[String(x.import_source_id),x]))
 const counts={}
 for(const table of ['compounds','spectra','spectrum_exact_peaks','compound_category_evidence','categories','source_categories','source_label_mapping','library_reference_compounds','mrm_source_compounds','mrm_parameters'])counts[table]=Number((await query('SELECT COUNT(*) n FROM `'+table+'`'))[0].n)
 const identity=await query('SELECT identity_status,COUNT(*) n FROM compounds GROUP BY identity_status')
 const sampleIds=new Set()
 if(options['--sample']){
  for(const status of ['structure_consistent','identity_conflict','unresolved'])for(const row of await query('SELECT compound_id FROM compounds WHERE identity_status=? AND spectrum_count BETWEEN 1 AND 50 ORDER BY compound_id LIMIT 3',[status]))sampleIds.add(String(row.compound_id))
  for(const row of await query('SELECT ce.category_id,MIN(ce.compound_id) compound_id FROM compound_category_evidence ce JOIN compounds c ON c.compound_id=ce.compound_id WHERE c.spectrum_count BETWEEN 1 AND 50 GROUP BY ce.category_id'))sampleIds.add(String(row.compound_id))
  for(const fileId of [27,137,138])for(const row of await query('SELECT c.compound_id FROM compounds c JOIN spectra s ON s.record_id=c.representative_record_id WHERE s.file_id=? AND c.spectrum_count BETWEEN 1 AND 50 ORDER BY c.compound_id LIMIT 2',[fileId]))sampleIds.add(String(row.compound_id))
  fs.writeFileSync(path.join(out,'selected-source-ids.json'),JSON.stringify([...sampleIds],null,2))
 }
 const flush=()=>{
  if(!part.length)return
  const packageId='unified-20261015:'+MAPPING_VERSION+':'+String(parts.length+1).padStart(5,'0')+':'+contentHash(part.map(x=>x.source)).slice(0,16)
  const data={formatVersion:2,schemaVersion:2,packageId,mappingVersion:MAPPING_VERSION,taxonomyCatalog:catalog,groups:part}
  const bytes=encodePackage(data);const decoded=decodePackage(bytes)
  if(contentHash(decoded.groups)!==contentHash(part))throw new Error('正式编码解码往返不一致')
  const name=String(parts.length+1).padStart(5,'0')+'.msldata'
  fs.writeFileSync(path.join(out,name),bytes)
  parts.push({file:name,packageId,groups:part.length,spectra:part.reduce((n,g)=>n+g.spectra.length,0),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
  // Retain normalized JSON only for reviewable small-sample deliveries.
  if(options['--sample'])fs.writeFileSync(path.join(out,name+'.json'),JSON.stringify(data,null,2))
  part=[];partBytes=0
 }
 while(true){
  const batch=options['--sample'] ? (last?[]:await query('SELECT * FROM compounds WHERE compound_id IN ('+[...sampleIds].map(()=>'?').join(',')+') ORDER BY compound_id',[...sampleIds])) : await query('SELECT * FROM compounds WHERE compound_id>? ORDER BY compound_id LIMIT 100',[last])
  if(!batch.length)break
  last=Number(batch.at(-1).compound_id)
  const ids=batch.map(x=>x.compound_id),slots=ids.map(()=>'?').join(',')
  const records=await query(`SELECT cs.compound_id,cs.identity_status,cs.identity_flags_json,s.*,sd.name_zh,sd.name_en,sd.cas,sd.payload_json,sd.payload_sha256,ep.peaks_json,ep.peak_count AS exact_peak_count,ep.peaks_sha256 FROM compound_spectra cs JOIN spectra s ON s.record_id=cs.record_id JOIN spectrum_details sd ON sd.record_id=s.record_id LEFT JOIN spectrum_exact_peaks ep ON ep.record_id=s.record_id WHERE cs.compound_id IN (${slots}) ORDER BY cs.compound_id,s.record_id`,ids)
  const identifiers=await query(`SELECT * FROM compound_identifiers WHERE compound_id IN (${slots}) ORDER BY identifier_id`,ids)
  const evidence=await query(`SELECT * FROM compound_category_evidence WHERE compound_id IN (${slots}) ORDER BY evidence_id`,ids)
  const publicRecords=new Map((await query(`SELECT * FROM library_public_records WHERE compound_id IN (${slots}) AND record_id IS NOT NULL ORDER BY import_record_id`,ids)).map(x=>[String(x.record_id),x]))
  const fieldEvidence=await query(`SELECT * FROM library_compound_field_evidence WHERE compound_id IN (${slots}) ORDER BY field_evidence_id`,ids)
  const groupRows=(rows)=>{const m=new Map();for(const row of rows){const k=String(row.compound_id);if(!m.has(k))m.set(k,[]);m.get(k).push(row)}return m}
  const rec=groupRows(records),ident=groupRows(identifiers),ev=groupRows(evidence),fe=groupRows(fieldEvidence)
  for(const compound of batch){
   try{
    const key=String(compound.compound_id),rows=rec.get(key)??[]
    if(rows.length!==Number(compound.spectrum_count))throw new Error('身份分组谱图数量与来源统计不一致')
    const group=convertCompound(compound,rows,ident.get(key)??[],ev.get(key)??[],categories,files,publicRecords,publicSources,fe.get(key)??[])
    validateGroup(clean(group))
    Object.assign(group, clean(group))
    const size=Buffer.byteLength(canonicalStringify(group))
    if(partBytes+size>24*1024*1024 || part.length>=100)flush()
    part.push(group);partBytes+=size;converted++;spectra+=group.spectra.length;peaks+=group.spectra.reduce((n,s)=>n+s.peaks.length,0);methods+=group.methods.length;lc+=group.lcMethods.length;assignments+=group.classifications.length
    warnings.push(...group.compound.properties.conversion_warnings.map(x=>({...x,compound_id:key})))
   }catch(error){errors.push({compound_id:compound.compound_id,error:String(error)})}
  }
  if(converted%1000<100)console.log(JSON.stringify({converted,last,spectra,parts:parts.length,seconds:Math.round((Date.now()-started)/1000)}))
 }
 flush()
 await db.query('COMMIT')
 const report={mappingVersion:MAPPING_VERSION,targetSchemaVersion:4,mode:options['--sample']?'sample':'all',sourceDatabase:String(options['--database']),sourceCounts:counts,identityCounts:identity,
  convertedGroups:converted,spectra,peaks,methods,lcMethods:lc,classificationLinks:assignments,catalogNodes:catalog.length,parts,warnings,errors,
  scope:'有谱图身份分组；MRM候选与无谱图目录未自动合并，另行转换；原始暂存库完整保留',seconds:(Date.now()-started)/1000,status:errors.length?'incomplete':'completed'}
 fs.writeFileSync(path.join(out,'conversion-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,warnings:warnings.length,errors:errors.length,parts:parts.length},null,2))
 if(errors.length)process.exitCode=1
}finally{await db.end()}
