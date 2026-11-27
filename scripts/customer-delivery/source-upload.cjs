const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto')
const {DatabaseSync}=require('node:sqlite')
const {parseGNPS}=require('./gnps-record.cjs')
const {hash}=require('./massbank-record.cjs')
const keyPattern=/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/
function candidate(h,peaks,original,upstream) {
 const name=h.NAME||h.COMPOUNDNAME||h.TITLE
 if(!name||!peaks.length)throw Error('缺少化合物名称或谱峰')
 if(peaks.some(p=>!Number.isFinite(p.mz)||p.mz<=0||!Number.isFinite(p.intensity)||p.intensity<0))throw Error('谱峰数值无效')
 if(h.NUMPEAKS && Number(h.NUMPEAKS)!==peaks.length)throw Error('Num Peaks 与实际谱峰数量不一致')
 const key=keyPattern.test(h.INCHIKEY||h.INCHIAUX||'')?(h.INCHIKEY||h.INCHIAUX):null
 const mode=(h.IONMODE||h.POLARITY||h.CHARGE||h.PRECURSORTYPE||'').toLowerCase()
 const polarity=/negative|-$/.test(mode)?0:/positive|\+$/.test(mode)?1:null
 const rawLevel=h.MSLEVEL||h.MSTYPE||(upstream?.assumeMs2?'MS2':''),level=/^\d+$/.test(rawLevel)?'MS'+rawLevel:/^MS[1-4]?$/.test(rawLevel.toUpperCase())?rawLevel.toUpperCase():null
 const precursor=Number((h.PRECURSORMZ||h.PEPMASS||'').split(/[\s,]/)[0])>0?Number((h.PRECURSORMZ||h.PEPMASS).split(/[\s,]/)[0]):null
 const adduct=h.PRECURSORTYPE||h.ADDUCT||h.ION||null,energy=h.COLLISIONENERGY||null,instrument=h.SOURCEINSTRUMENT||h.INSTRUMENT||h.INSTRUMENTTYPE||null
 const compound={main_name:name,name_en:name,inchikey:key,formula:h.FORMULA||null,cas:h.CAS||h.CASNO||null,smiles:h.SMILES||null}
 const sha256=hash(JSON.stringify({compound,level,polarity,precursor,adduct,energy,instrument,peaks:[...peaks].sort((a,b)=>a.mz-b.mz||a.intensity-b.intensity)}))
 const accession=upstream?upstream.accession(h,sha256):'UPLOAD-'+sha256
 const namespace=upstream?.adapter||'upload',sourceName=upstream?.name||'上传文件'
 const spectrumId=namespace+':'+accession,methodId=namespace+'-method:'+accession
 const record={compound,spectra:[{id:spectrumId,kind:'numeric',nature:'measured',spectrum_type:level,polarity,adduct,precursor_mz:precursor,collision_energy:energy?{raw:energy}:null,peaks,methodIds:[methodId],conditions:{instrument,...(h.SPECTYPE?{spectrum_processing:h.SPECTYPE}:{})},raw:{source_record_id:accession,sha256,original}}],ms:[{id:methodId,ms_mode:level,scan_mode:level,q1:precursor,polarity,adduct,conditions:{collision_energy_raw:energy},method_source:sourceName}],lc:[],sources:[{id:namespace+'-source:'+accession,name:sourceName,namespace,source_record_id:accession,version:upstream?.version||null,source_url:upstream?.url||null}]}
 return {accession,sha256,record,name,key,level,polarity,adduct,precursor,energy}
}
function parseBlocks(text,kind,onCandidate,onInvalid,upstream){
 let h={},peaks=[],original=[],lineStart=1,active=kind==='msp'
 function flush(){if(!original.some(s=>s.trim()))return;try{onCandidate(candidate(h,peaks,original.join('\n'),upstream),lineStart)}catch(e){onInvalid(lineStart,e.message)}h={};peaks=[];original=[]}
 const lines=text.split(/\r?\n/)
 for(let i=0;i<lines.length;i++){
  const line=lines[i].trim()
  if(kind==='mgf'&&/^BEGIN IONS$/i.test(line)){flush();active=true;lineStart=i+1;continue}
  if(kind==='mgf'&&/^END IONS$/i.test(line)){flush();active=false;continue}
  if(!active||!line||line.startsWith('#'))continue
  const header=line.match(/^([A-Za-z][A-Za-z0-9 _/-]*?)\s*[:=]\s*(.*)$/)
  if(header){const key=header[1].toUpperCase().replace(/[^A-Z0-9]/g,'');if(kind==='msp'&&key==='NAME'&&original.length){flush();lineStart=i+1}h[key]=header[2];original.push(line);continue}
  original.push(line)
  // MSP allows several semicolon-separated pairs and quoted peak annotations.
  const groups = line.match(/(?:[^";]|"(?:[^"\\]|\\.)*")+/g) || []
  for(const part of groups){const m=part.trim().match(/^(\S+)\s+(\S+)(?:\s+.*)?$/);if(m)peaks.push({mz:Number(m[1]),intensity:Number(m[2])});else if(part.trim())peaks.push({mz:NaN,intensity:NaN})}
 }
 if(kind==='mgf'&&active&&original.length)onInvalid(lineStart,'MGF 缺少 END IONS');else flush()
}
function parsePublishedSpectrum(text, config, metadata) {
 const verifiedFile = config.adapter === 'file'
 const dialect = verifiedFile ? metadata.format : config.adapter === 'msdial' ? 'msp' : 'mgf'
 const source = {
  adapter: verifiedFile ? 'source-file:' + config.sourceId : config.adapter,
  name: verifiedFile ? config.sourceName : (dialect === 'msp' ? 'MS-DIAL' : 'MSⁿLib') + ' / ' + config.scope,
  assumeMs2: !verifiedFile || metadata.assumeMs2 === true,
  version: metadata.version,
  url: metadata.url,
  accession(fields, contentHash) {
   if (verifiedFile) {
    if (metadata.gnps && /^CCMSLIB[0-9]+$/.test(fields.SPECTRUMID || '')) return fields.SPECTRUMID
    const commentId = fields.COMMENT?.match(/(?:^|;\s*)DB#=([^;]+);\s*origin=([^;]+)/i)
    const acquisition = config.sourceId === '69' && fields.DATASETID && fields.FILENAME && fields.EXTRACTSCAN
      ? [fields.DATASETID, fields.SPECTYPE, fields.SPECTRUMID, fields.FILENAME, fields.EXTRACTSCAN] : null
    const upstreamId = acquisition || fields.USI || fields.SPECTRUMID || commentId?.slice(1)
    return 'SOURCEFILE-' + hash(JSON.stringify([config.sourceId, upstreamId || contentHash]))
   }
   const publishedId = dialect === 'msp'
     ? fields.COMMENT?.match(/(?:^|;\s*)DB#=([^;]+);\s*origin=(.+)$/i)?.slice(1).map(s => s.trim()).reverse().join(':')
     : fields.USI?.startsWith('mzspec:') ? fields.USI : null
   if (dialect === 'mgf' && !publishedId) throw Error('MSⁿLib 谱图缺少发布编号 USI')
   const prefix = dialect === 'msp' ? 'MSDIAL' : 'MSNLIB'
   return prefix + '-' + (publishedId ? hash(config.scope + ':' + publishedId) : contentHash)
  }
 }
 let result
 parseBlocks(text, dialect, value => { result = value }, (_, error) => { throw Error(error) }, source)
 if (!result) throw Error('谱图记录为空或格式不完整')
 return result
}

function saveUpload(folder,input){
 if(typeof input.content!=='string'||!input.content.length||input.content.length>Math.ceil(64*1024*1024/3)*4)throw Error('上传文件为空或超过64 MB')
 const bytes=Buffer.from(input.content,'base64');if(bytes.length>64*1024*1024)throw Error('上传文件不能超过64 MB')
 const id=input.batchId||crypto.randomUUID(),dir=path.join(folder,'batches',id);fs.mkdirSync(dir,{recursive:true})
 const filename=path.basename(String(input.filename||'')),ext=path.extname(filename).toLowerCase();if(!['.json','.mgf','.msp'].includes(ext))throw Error('仅支持 JSON（GNPS）、MGF、MSP 文件')
 fs.writeFileSync(path.join(dir,'original'+ext),bytes,{mode:0o600})
 const progress=(value)=>{const f=path.join(dir,'progress.json');fs.writeFileSync(f+'.tmp',JSON.stringify({...value,at:new Date().toISOString()}));fs.renameSync(f+'.tmp',f)}
 progress({phase:'parse',label:'正在解析上传文件',completed:0,total:0,unit:'条'})
 const db=new DatabaseSync(path.join(dir,'candidates.sqlite'));db.exec('CREATE TABLE candidates(accession TEXT PRIMARY KEY,payload TEXT);CREATE TABLE invalid(line INTEGER,reason TEXT);BEGIN')
 const insert = db.prepare('INSERT INTO candidates VALUES(?,?)')
 const remove = db.prepare('DELETE FROM candidates WHERE accession=?')
 const bad = db.prepare('INSERT INTO invalid VALUES(?,?)')
 const seen = new Map()
 let count=0,invalid=0,duplicates=0,processed=0,conflicts=0
 const reject=(line,reason)=>{invalid++;bad.run(line,String(reason).slice(0,500))}
 const add=(candidate,line)=>{
  const prior = seen.get(candidate.accession)
  if (!prior) {
   seen.set(candidate.accession,{hash:candidate.sha256,line,conflict:false})
   insert.run(candidate.accession,JSON.stringify(candidate))
   count++
  } else if (prior.conflict) {
   reject(line,'来源编号存在内容冲突：'+candidate.accession)
  } else if (prior.hash === candidate.sha256) {
   duplicates++
  } else {
   prior.conflict = true
   conflicts++
   remove.run(candidate.accession)
   count--
   reject(prior.line,'来源编号存在内容冲突：'+candidate.accession)
   reject(line,'来源编号存在内容冲突：'+candidate.accession)
  }
  processed++
  if(processed%100===0)progress({phase:'parse',label:'正在解析上传文件',completed:processed,total:0,unit:'条',valid:count,invalid})
 }
 let compounds=0
 try{
  const text=bytes.toString('utf8').replace(/^\uFEFF/,'')
  if(ext==='.json'){const data=JSON.parse(text),rows=Array.isArray(data)?data:Array.isArray(data.records)?data.records:null;if(!rows)throw Error('JSON 应为 GNPS 谱图数组或 records 数组');rows.forEach((r,i)=>{try{add(parseGNPS(r,'uploaded','上传文件'),i+1)}catch(e){reject(i+1,e.message)}})}
  else parseBlocks(text,ext.slice(1),add,reject)
  compounds=db.prepare("SELECT COUNT(DISTINCT json_extract(payload,'$.key')) n FROM candidates").get().n
  db.exec('COMMIT')
 }catch(e){db.exec('ROLLBACK');throw e}finally{db.close()}
 if(!count && !conflicts)throw Error('没有可解析的谱图；'+invalid+' 条解析异常，请检查名称、格式和谱峰')
 const batch={taskId:input.taskId||'upload-'+id,batchId:id,libraryId:input.libraryId,adapter:'upload',scope:filename,version:'sha256:'+hash(bytes),count,compounds,invalid,duplicates,conflicts,checkedAt:new Date().toISOString(),uploaded:true,filename,actor:input.actor}
 fs.writeFileSync(path.join(dir,'batch.json'),JSON.stringify(batch));progress({phase:'compare',label:'解析完成，准备比对目标库',completed:0,total:count,unit:'张谱图'});return batch
}
if(require('node:worker_threads').parentPort){const {parentPort,workerData}=require('node:worker_threads');try{parentPort.postMessage({batch:saveUpload(workerData.folder,workerData.input)})}catch(e){parentPort.postMessage({error:e.message})}}
module.exports={saveUpload,parsePublishedSpectrum}
