const {navigationAxisRoots,remainderMajor,remainderMajors}=require('../../src/shared/categoryNavigation.mjs')
const {ionModePredicate,ionFlags}=require('../../src/shared/ionMode.mjs')
const {majorGroup,groupMemberships}=require('../../src/shared/majorGroups.mjs')
const fs = require('node:fs'), path = require('node:path')
const { classificationCatalog, classificationKey, classificationDescendants } = require('../../src/shared/deliveryClassification.mjs')
const { fail } = require('./policy.cjs')
const {fixedMajorValue,subdivideMajorValue,FIXED_MAJORS,FIXED_CLASSIFICATION_CATALOG,majorKey}=require('../../src/shared/fixedMajors.mjs')
const open = file => new (require('node:sqlite').DatabaseSync)(file, { readOnly: true })
const parse = value => { try { return JSON.parse(value || 'null') } catch { fail('数据库 JSON 字段损坏') } }
function signature(file) { if(fs.existsSync(file+'-wal')&&fs.statSync(file+'-wal').size)fail('源库存在未合并日志，请停止写入、完成检查点后重新关联',409);const s=fs.statSync(file);return `${s.size}:${s.mtimeMs}` }
function inspectUnified(file) {
  if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail('请选择普通 SQLite 数据库文件')
  if (fs.existsSync(file+'-wal') && fs.statSync(file+'-wal').size) fail('源数据库仍有未合并日志，请先完成检查点')
  const db=open(file)
  try {
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r=>r.name))
    if (!tables.has('compound_classifications') || !tables.has('categories') || !db.prepare('PRAGMA table_info(compounds)').all().some(c=>c.name==='compound_id')) fail('不支持的统一交付库结构或缺少分类字典')
    const dictionary=db.prepare('SELECT * FROM categories').all(),categories=classificationCatalog(dictionary)
    const displayFields=['main_name'];for(const field of ['name_en','cas','formula'])if(db.prepare(`SELECT 1 FROM compounds WHERE ${field} IS NOT NULL AND trim(${field})<>'' LIMIT 1`).get())displayFields.push(field)
    return { displayFields, adapter:'unified-sqlite',title:path.basename(file,path.extname(file)),categories,sourceSignature:signature(file),readOnly:true,total:Number(db.prepare('SELECT COUNT(*) n FROM compounds').get().n),trashed:0 }
  } finally {db.close()}
}
function filter(db,input) {const group=majorGroup(input.categoryKey);if(group){const parts=group.members.map(code=>filter(db,{...input,categoryKey:majorKey(code)}));return{...parts[0],where:parts.map(p=>'('+p.where+')').join(' OR '),params:parts.flatMap(p=>p.params)}}
  const roots=navigationAxisRoots(FIXED_MAJORS,input.categoryKey)
  if(roots){
    if(!roots.length)return {...filter(db,{...input,categoryKey:undefined}),where:'0',params:[]}
    const parts=roots.map(category=>filter(db,{...input,categoryKey:majorKey(category.category_code)}))
    return {...parts[0],where:parts.map(part=>'('+part.where+')').join(' OR '),params:parts.flatMap(part=>part.params)}
  }
  const remainder=remainderMajor(input.categoryKey);if(remainder){const root=filter(db,{...input,categoryKey:majorKey(remainder)}),children=FIXED_CLASSIFICATION_CATALOG.filter(c=>c.parent_code===remainder).map(c=>filter(db,{...input,categoryKey:majorKey(c.category_code)}));return{...root,where:'('+root.where+')'+children.map(c=>' AND NOT ('+c.where+')').join(''),params:[root,...children].flatMap(c=>c.params)}}
  const clauses=['1=1'],params=[],keyword=String(input.keyword||'').trim().toLowerCase()
  if(input.auditState||input.adduct||input.sourceQuery||input.sourceIds?.length)fail('此只读关联库支持极性、质谱与谱图形式筛选；其他条件请清空或单独选择支持的数据库')
  if(input.dataTypes!==undefined&&(!Array.isArray(input.dataTypes)||input.dataTypes.some(t=>t!=='spectrum')))fail('此只读关联库仅支持“有质谱”数据类型筛选')
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(r=>r.name))
  const mrm=tables.has('mrm_transitions'),spectra=tables.has('spectra')&&tables.has('spectrum_compounds')
  if(input.dataTypes?.length)clauses.push('('+(mrm?'EXISTS(SELECT 1 FROM mrm_transitions m WHERE m.compound_id=c.compound_id)':'0')+' OR '+(spectra?'EXISTS(SELECT 1 FROM spectrum_compounds sc WHERE sc.compound_id=c.compound_id)':'0')+')')
  if(input.spectrumKind){if(!['numeric','image'].includes(input.spectrumKind))fail('谱图形式无效');clauses.push(input.spectrumKind==='numeric'&&spectra?'EXISTS(SELECT 1 FROM spectrum_compounds sc WHERE sc.compound_id=c.compound_id)':'0=1')}
  if(input.polarity!==undefined&&input.polarity!==null&&input.polarity!==''){
    const has=p=>{const terms=[];if(mrm)terms.push("EXISTS(SELECT 1 FROM mrm_transitions m WHERE m.compound_id=c.compound_id AND "+(p===1?"(lower(m.polarity) IN ('positive','pos','+') OR (coalesce(lower(m.polarity),'') NOT IN ('negative','neg','-') AND m.polarity_code=1))":"(lower(m.polarity) IN ('negative','neg','-') OR (coalesce(lower(m.polarity),'') NOT IN ('positive','pos','+') AND m.polarity_code=0))")+")");if(spectra)terms.push("EXISTS(SELECT 1 FROM spectrum_compounds sc JOIN spectra s ON s.spectrum_id=sc.spectrum_id WHERE sc.compound_id=c.compound_id AND lower(s.polarity) IN ("+(p===1?"'positive','pos','+'":"'negative','neg','-'")+"))");return '('+(terms.join(' OR ')||'0')+')'};clauses.push(ionModePredicate(input.polarity,has(1),has(0)));
  }
  if (input.trash) clauses.push('0=1')
  if(input.identityStatus){if(!['structure_consistent','identity_conflict','unresolved'].includes(input.identityStatus))fail('身份状态无效');clauses.push('c.identity_status=?');params.push(input.identityStatus)}
  if(keyword.length>200)fail('查询文字过长')
  if(keyword){clauses.push("(instr(lower(coalesce(c.compound_name,'')),?)>0 OR instr(lower(coalesce(c.name_zh,'')),?)>0 OR instr(lower(coalesce(c.name_en,'')),?)>0 OR instr(lower(coalesce(c.cas,'')),?)>0 OR instr(lower(coalesce(c.formula,c.derived_formula,'')),?)>0)");params.push(...Array(5).fill(keyword))}
  if(input.onlySelected){const ids=input.compoundIds;if(!Array.isArray(ids)||!ids.length||ids.length>20000||ids.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<1))fail('记录范围无效');clauses.push(`c.compound_id IN (${ids.map(()=>'?').join(',')})`);params.push(...ids.map(Number))}
  const dictionary=db.prepare('SELECT * FROM categories').all(),categories=classificationCatalog(dictionary),byId=new Map(dictionary.map(c=>[String(c.category_id),c]))
  if(input.categoryKey){
    const mapping=dictionary.map(c=>({id:c.category_id,value:subdivideMajorValue(fixedMajorValue({catalog:categories,items:[{key:classificationKey({...c,namespace:'unified-consolidated-v2'})}]},input.defaultMajor))}))
    const other=input.categoryKey===majorKey('other'),ids=mapping.filter(c=>c.value.items.some(i=>other?i.key!==majorKey('other'):i.key===input.categoryKey||FIXED_CLASSIFICATION_CATALOG.some(c=>c.parent_code&&majorKey(c.category_code)===i.key&&majorKey(c.parent_code)===input.categoryKey))).map(c=>c.id)
    if(input.categoryKey==='@pending')clauses.push('0=1');else{clauses.push((other?'NOT ':'')+`EXISTS(SELECT 1 FROM compound_classifications k WHERE k.compound_id=c.compound_id AND json_extract(k.details_json,'$.part') IS NOT 'mrm' AND json_extract(k.details_json,'$.category_id') IN (${ids.map(()=>'?').join(',')||'NULL'}))`);params.push(...ids)}
  }

  return {where:clauses.join(' AND '),params,categories,byId}
}
function record(db,row,categories,byId,details,defaultMajor) {
  const id=String(row.compound_id),items=new Map(),sourceLabels=new Set()
  for(const k of db.prepare('SELECT details_json FROM compound_classifications WHERE compound_id=?').all(row.compound_id)){
    const evidence=parse(k.details_json);if(typeof evidence?.original_label==='string'&&evidence.original_label.trim())sourceLabels.add(evidence.original_label.trim());if(evidence?.part==='mrm')continue
    const c=byId.get(String(evidence?.category_id));if(!c||!categories.some(v=>v.category_code===c.category_code))continue
    const key=JSON.stringify(['unified-consolidated-v2',c.category_code]);items.set(key,{key,review_status:evidence.review_status||'unreviewed'})
  }
  const result={id,compound:{main_name:row.name_zh||row.compound_name||row.name_en||'名称未提供',name_zh:row.name_zh,name_en:row.name_en,cas:row.cas,formula:row.formula||row.derived_formula},classification:{catalog:categories,items:[...items.values()],source_labels:[...sourceLabels]},ms:[],lc:[],spectra:[],sources:[],chromatograms:[],experiments:[],checks:[]}
  result.classification=subdivideMajorValue(fixedMajorValue(result.classification,defaultMajor))
  if(!details){const ts=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(t=>t.name)),modes=[],convert=(p,code)=>['positive','pos','+'].includes(String(p).toLowerCase())?1:['negative','neg','-'].includes(String(p).toLowerCase())?0:[0,1].includes(code)?code:null;if(ts.has('mrm_transitions'))modes.push(...db.prepare('SELECT polarity,polarity_code FROM mrm_transitions WHERE compound_id=?').all(row.compound_id).map(m=>convert(m.polarity,m.polarity_code)));if(ts.has('spectra')&&ts.has('spectrum_compounds'))modes.push(...db.prepare('SELECT DISTINCT s.polarity FROM spectra s JOIN spectrum_compounds sc ON sc.spectrum_id=s.spectrum_id WHERE sc.compound_id=?').all(row.compound_id).map(s=>convert(s.polarity)));result.ionModes=ionFlags(modes);return result}
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(t=>t.name))
  if(tables.has('mrm_transitions'))for(const m of db.prepare('SELECT * FROM mrm_transitions WHERE compound_id=? ORDER BY mrm_id').all(row.compound_id)){
    const original=tables.has('source_records')?db.prepare('SELECT normalized_fields_json FROM source_records WHERE source_record_id=?').get(m.source_record_id):null
    const fields=original?parse(original.normalized_fields_json)||{}:{}
    const numeric=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null
    result.ms.push({...fields,id:'mrm:'+m.mrm_id,q1:numeric(m.q1),q3:numeric(m.q3),ce:numeric(m.collision_parameter),ce_unit:m.collision_parameter_unit||null,polarity:['positive','pos','+'].includes(String(m.polarity).toLowerCase())?1:['negative','neg','-'].includes(String(m.polarity).toLowerCase())?0:[0,1].includes(m.polarity_code)?m.polarity_code:null,ion_source:m.ion_source,ms_mode:'MRM'})
  }
  if(tables.has('spectra')&&tables.has('spectrum_compounds'))for(const s of db.prepare('SELECT DISTINCT s.* FROM spectra s JOIN spectrum_compounds sc ON sc.spectrum_id=s.spectrum_id WHERE sc.compound_id=? ORDER BY s.spectrum_id').all(row.compound_id)){
    const peaks=db.prepare('SELECT mz,intensity FROM spectrum_peaks WHERE spectrum_id=? ORDER BY peak_no').all(s.spectrum_id)
    result.spectra.push({id:'spectrum:'+s.spectrum_id,kind:Number(s.ms_level)===1?'MS1':'MS2',spectrum_type:'numeric',precursor_mz:s.precursor_mz,polarity:['positive','+'].includes(s.polarity)?1:['negative','-'].includes(s.polarity)?0:null,collision_energy:{value:s.collision_energy,unit:s.collision_energy_unit},peaks:peaks.map(p=>({mz:p.mz,intensity:p.intensity})),methodIds:[]})
  }
  return result
}
function unifiedRows(file,input,all=false) {
  const db=open(file)
  try{
    const f=filter(db,input),total=Number(db.prepare('SELECT COUNT(*) n FROM compounds c WHERE '+f.where).get(...f.params).n),page=Math.max(1,Math.trunc(Number(input.page)||1))
    const selected=input.countOnly?[]:db.prepare('SELECT c.* FROM compounds c WHERE '+f.where+' ORDER BY c.compound_id'+(all?'':' LIMIT 50 OFFSET ?')).all(...f.params,...(all?[]:[(page-1)*50]))
    return{total,page,categories:f.categories,classes:[],rows:selected.map(r=>({id:Number(r.compound_id),key:String(r.compound_id),record:record(db,r,f.categories,f.byId,all||input.details===true,input.defaultMajor)}))}
  }finally{db.close()}
}
module.exports={inspectUnified,unifiedRows,signature}
function* unifiedRecords(file,input) {
  const db=open(file)
  try { db.exec('BEGIN');const f=filter(db,input);for(const row of db.prepare('SELECT c.* FROM compounds c WHERE '+f.where+' ORDER BY c.compound_id').iterate(...f.params))yield record(db,row,f.categories,f.byId,true,input.defaultMajor) }
  finally {db.close()}
}
module.exports.unifiedRecords=unifiedRecords
const countCache=new Map()
function unifiedCategories(file,input={}) {
  const key=file+':'+signature(file)+':'+(input.defaultMajor||'');if(countCache.has(key))return countCache.get(key)
  const db=open(file)
  try{
    const dictionary=db.prepare('SELECT * FROM categories').all(),catalog=classificationCatalog(dictionary),mapped=new Map(dictionary.map(c=>[String(c.category_id),subdivideMajorValue(fixedMajorValue({catalog,items:[{key:classificationKey({...c,namespace:'unified-consolidated-v2'})}]},input.defaultMajor)).items.flatMap(i=>{const c=FIXED_CLASSIFICATION_CATALOG.find(c=>majorKey(c.category_code)===i.key);return c?.parent_code?[i.key,majorKey(c.parent_code)]:[i.key]})])),counts={},remainders={},groupCounts={};let last=null,keys=new Set(),classified=0
    const flush=()=>{if(last===null)return;if(keys.size>1)keys.delete(majorKey('other'));if(!keys.size)keys.add(majorKey(input.defaultMajor||'other'));for(const code of groupMemberships(FIXED_CLASSIFICATION_CATALOG,[...keys]))groupCounts[code]=(groupCounts[code]||0)+1;for(const k of keys)counts[k]=(counts[k]||0)+1;for(const code of remainderMajors(FIXED_CLASSIFICATION_CATALOG,[...keys]))remainders[code]=(remainders[code]||0)+1;classified++}
    for(const row of db.prepare('SELECT compound_id,details_json FROM compound_classifications ORDER BY compound_id').iterate()){if(last!==row.compound_id){flush();last=row.compound_id;keys=new Set()}const item=parse(row.details_json);if(item?.part!=='mrm')for(const key of mapped.get(String(item?.category_id))||[])keys.add(key)}flush()
    const total=Number(db.prepare('SELECT COUNT(*) n FROM compounds').get().n),fallback=majorKey(input.defaultMajor||'other');counts[fallback]=(counts[fallback]||0)+total-classified
    remainders[input.defaultMajor||'other']=(remainders[input.defaultMajor||'other']||0)+total-classified;for(const code of groupMemberships(FIXED_CLASSIFICATION_CATALOG,[fallback]))groupCounts[code]=(groupCounts[code]||0)+total-classified;const result={catalog:FIXED_CLASSIFICATION_CATALOG,counts,remainders,groupCounts,total,pending:0};if(countCache.size>10)countCache.clear();countCache.set(key,result);return result
  }finally{db.close()}
}

module.exports.unifiedCategories=unifiedCategories
