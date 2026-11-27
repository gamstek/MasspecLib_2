const {majorGroup,MAJOR_GROUPS}=require('../../src/shared/majorGroups.mjs');
const {navigationAxisRoots,remainderMajor,remainderKey}=require('../../src/shared/categoryNavigation.mjs');
const {ionFlags,ionModePredicate}=require('../../src/shared/ionMode.mjs');
const {methodQualityIssue}=require('../../src/shared/acquisitionParameters.mjs');
const {peptideClassification,peptideSourceInfo,peptideCategoryCode}=require('../../src/shared/peptideClassification.mjs');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {fail}=require('./policy.cjs');
const {signature}=require('./unified-sqlite.cjs');
const {detailViews}=require('./lds-detail-index.cjs');
const {hasSourceTaxonomy,sourceCategories,sourceCategoryFilter}=require('./source-taxonomy.cjs');
const {FIXED_MAJORS,FIXED_CLASSIFICATION_CATALOG,subdivideMajorValue,MAJOR_NAMESPACE,majorKey,majorForLabels,fixedMajorValue,isPeptideCategory}=require('../../src/shared/fixedMajors.mjs');
const {classificationKey}=require('../../src/shared/deliveryClassification.mjs');
const addedStart=9000000000000;
const parse=v=>{if(v==null||v==='')return null;if(typeof v==='object')return v;try{return JSON.parse(v)}catch{return null}};
const number=v=>v===null||v===undefined||String(v).trim()===''?null:Number.isFinite(Number(v))?Number(v):null;
const unit=v=>v==null||!String(v).trim()?null:String(v).trim();
const required={
 化合物:['化合物ID','化合物名称','中文名称','CAS号','分子式','身份状态','对象类型','结构标识','来源名称与结构JSON','字段来源JSON'],
 来源记录:['来源记录ID','化合物ID','谱图ID','来源分区','字段值JSON','来源JSON','原始字段JSON','加和方式'],
 谱图:['谱图ID','MS级别','前体mz','离子模式','谱峰数'],谱峰:['谱图ID','峰序号','mz','强度'],
 MRM参数:['MRM记录ID','化合物ID','原始方法JSON','Q1母离子','Q3子离子','原始极性编码','离子模式'],
 分类字典:['分类ID','分类编码','分类名称','父类ID','分类维度'],化合物分类:['分类记录ID','化合物ID','分类ID','来源标签','分类名称','核查状态'],
 关联关系:['关联ID','化合物ID','谱图ID','关系类型'],来源资料:['原对象','内容JSON']
};
function inspectLDS(file){
 if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())fail('请选择普通 SQLite 数据库文件');
 if(fs.existsSync(file+'-journal')&&fs.statSync(file+'-journal').size)fail('数据库存在写入或待恢复日志，请停止写入并完成恢复后检查');
 const sig=signature(file),db=new DatabaseSync(file,{readOnly:true});try{
  db.exec('BEGIN');
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  const missing=[];for(const [t,columns]of Object.entries(required)){if(!tables.has(t)){missing.push('表 '+t);continue}const found=new Set(db.prepare('PRAGMA table_info("'+t+'")').all().map(c=>c.name));for(const c of columns)if(!found.has(c))missing.push(t+'.'+c)}
  if(missing.length)fail('谱库文件格式不兼容，缺少：'+missing.join('、'));
  for (const [table, column] of [['来源记录','来源记录ID'],['MRM参数','MRM记录ID'],['化合物分类','分类记录ID'],['关联关系','关联ID']]) {
    const definition = db.prepare(`PRAGMA table_info("${table}")`).all()
    if (definition.filter(field=>field.pk).length !== 1 ||
        !definition.some(field=>field.name===column && field.pk===1 && /^integer$/i.test(field.type)))
      fail('谱库文件格式不兼容：'+table+'.'+column+' 必须是整数主键')
  }
  const warnings=[],checks=[{label:'SQLite 基本读取',status:'passed',detail:'数据库可按只读方式打开并读取目录'},{label:'谱库表结构与必需字段',status:'passed',detail:Object.keys(required).length+' 张必需表及字段匹配'}];
  let meta={};
  if(tables.has('构建信息')){
   const columns=db.prepare('PRAGMA table_info("构建信息")').all().map(r=>r.name);
   if(columns.includes('键')&&columns.includes('值JSON'))meta=Object.fromEntries(db.prepare('SELECT * FROM 构建信息').all().map(r=>[r.键,parse(r.值JSON)]));
   else warnings.push('构建信息格式不同，未作为准入条件');
  }
  if(meta.complete!==true)warnings.push(meta.complete===false?'构建信息记录为未完成；当前格式检查通过不代表全部预期数据已导入，请确认来源文件已生成完毕':'未提供构建完成标记；以实际格式和读取检查结果为准');
  // Avoid sorting unindexed tables or counting every peak in a large source.
  const sampleColumns = {
    化合物:'化合物ID, 来源名称与结构JSON', 来源记录:'化合物ID, 谱图ID',
    谱图:'谱图ID', 谱峰:'谱图ID, mz, 强度', MRM参数:'化合物ID',
    分类字典:'CAST(父类ID AS TEXT) AS 父类ID', 化合物分类:'化合物ID',
    关联关系:'化合物ID, 谱图ID', 来源资料:'内容JSON'
  }
  const firstRows = table => db.prepare(`SELECT ${sampleColumns[table]} FROM "${table}" LIMIT 20`).all()
  const exists = (table, column) => db.prepare(`SELECT 1 FROM "${table}" WHERE "${column}"=? LIMIT 1`)
  const compound = exists('化合物', '化合物ID')
  const spectrum = exists('谱图', '谱图ID')
  const category = exists('分类字典', '分类ID')
  function checkReference(query, id, label) {
    if (id != null && !query.get(id)) fail(`关联抽检失败：${label}指向不存在的编号 ${id}`)
  }
  let sampled = 0
  for (const table of Object.keys(required)) {
    for (const row of firstRows(table)) {
      sampled++
      if (table === '化合物') {
        if (!Number.isSafeInteger(row.化合物ID) || row.化合物ID <= 0 || row.化合物ID >= addedStart)
          fail('读取抽检失败：化合物ID 无效')
        // The effective view uses json_extract directly and cannot read malformed JSON.
        const value = row.来源名称与结构JSON
        if (value !== null) {
          try { JSON.parse(value) } catch { fail('读取抽检失败：化合物.来源名称与结构JSON 不是有效 JSON') }
        }
      }
      if (['来源记录','MRM参数','化合物分类','关联关系'].includes(table))
        checkReference(compound, row.化合物ID, table+'.化合物ID')
      if (['来源记录','谱峰','关联关系'].includes(table))
        checkReference(spectrum, row.谱图ID, table+'.谱图ID')
      if (table === '分类字典') checkReference(category, row.父类ID, table+'.父类ID')
      if (table === '谱峰' && (!Number.isFinite(number(row.mz)) || number(row.mz) <= 0 ||
          !Number.isFinite(number(row.强度)) || number(row.强度) < 0))
        fail('读取抽检失败：谱峰 mz 或强度无效')
    }
  }
  checks.push({label:'基本读取与关联抽检',status:'passed',detail:'检查 '+sampled+' 条样本的查询字段、谱峰数值及基础引用'});
  const total=Number(db.prepare('SELECT count(*) n FROM 化合物').get().n);
  if(total >= 100000) warnings.push('大型库首次关联将建立只读查询所需索引，可能需要一定时间')
  if(!total)warnings.push('这是一个空库，关联后暂无化合物可查询');
  if(signature(file)!==sig)fail('检查期间源文件发生变化，请停止写入后重新检查',409);
  return{adapter:'lds-cn',adapterVersion:1,title:path.basename(file,path.extname(file)),sourceSignature:sig,total,trashed:0,readOnly:false,sourceReadOnly:true,displayFields:['main_name','name_zh','name_en','cas','formula','sources','mrm1','mrm2'],peakRows:meta.verified_peak_rows??meta.peaks_written??null,
   validation:{status:'passed',scope:'format-and-sample',checkedAt:new Date().toISOString(),checks,warnings,note:'格式及读取抽检通过，可关联；未执行全库完整性扫描，也不判断上游数据是否全部导入。'}};
 }finally{db.close()}
}

function workspace(root,entry){return path.join(root,'libraries',entry.id,'lds-workspace.sqlite')}
function ensureWorkspace(root,entry){
 const file=workspace(root,entry);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const db=new DatabaseSync(file);
 try{db.exec(`PRAGMA journal_mode=DELETE;CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY,added INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'active',patch TEXT NOT NULL DEFAULT '{}',updated_at TEXT);CREATE TABLE IF NOT EXISTS membership(id INTEGER NOT NULL,major TEXT NOT NULL,PRIMARY KEY(id,major));CREATE INDEX IF NOT EXISTS membership_major ON membership(major,id);CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,at TEXT,actor TEXT,action TEXT,record_ids TEXT);CREATE TABLE IF NOT EXISTS imports(hash TEXT PRIMARY KEY,ids TEXT,at TEXT);`);
 if(!db.prepare('PRAGMA table_info(imports)').all().some(c=>c.name==='at'))db.exec('ALTER TABLE imports ADD COLUMN at TEXT');
 if(!db.prepare("SELECT 1 FROM metadata WHERE key='revision'").get())db.prepare('INSERT INTO metadata VALUES(?,?)').run('revision',crypto.randomUUID());
 }finally{db.close()}return file;
}
function revision(root,entry){const f=workspace(root,entry);if(!fs.existsSync(f))return entry.revision;const d=new DatabaseSync(f,{readOnly:true});try{return d.prepare("SELECT value FROM metadata WHERE key='revision'").get().value}finally{d.close()}}
function dictionary(db){const rows=db.prepare('SELECT CAST(分类ID AS TEXT) AS 分类ID, CAST(父类ID AS TEXT) AS 父类ID, 分类编码, 分类名称, 分类维度 FROM 分类字典').all(),by=new Map(rows.map(c=>[c.分类ID,c]));return{rows,by}}
function categoryPath(dict,c){const result=[],seen=new Set();while(c&&!seen.has(c.分类ID)){seen.add(c.分类ID);result.unshift(c.分类名称);c=dict.by.get(c.父类ID)}return result}
function codeFor(dict,c){const seen=new Set();while(c&&!seen.has(c.分类ID)){seen.add(c.分类ID);if(isPeptideCategory(c))return'peptides';let code=c.分类编码;if(code==='pending')return'other';if(FIXED_MAJORS.some(m=>m.category_code===code))return code;c=dict.by.get(c.父类ID)}return'other'}
function originalClassification(db,id,dict,defaultMajor,sourceRecord){
 const labels=[],paths=[],codes=new Set(),statuses=[],confirmedCodes=new Set();
 for(const row of db.prepare('SELECT CAST(分类ID AS TEXT) AS 分类ID, 来源标签, 分类名称, 核查状态 FROM category_by_compound WHERE lookup_compound_id=?').all(id)){
  const c=dict.by.get(row.分类ID),label=row.来源标签||row.分类名称;if(label)labels.push(String(label));if(row.核查状态)statuses.push(row.核查状态);if(row.核查状态==='confirmed')confirmedCodes.add(c?codeFor(dict,c):majorForLabels([String(label||'')]));
  if(c){paths.push(categoryPath(dict,c));codes.add(codeFor(dict,c))}else if(label){paths.push([String(label)]);codes.add(majorForLabels([String(label)]))}
 }
 if(!codes.size)codes.add(defaultMajor||'other');if(codes.size>1)codes.delete('other');if(codes.size===1&&codes.has('other')&&defaultMajor){codes.delete('other');codes.add(defaultMajor)}
 const value=subdivideMajorValue({version:1,scheme:'fixed-majors-v1',catalog:FIXED_CLASSIFICATION_CATALOG,items:[...codes].map(code=>({key:majorKey(code),review_status:confirmedCodes.has(code)?'confirmed':'pending'})),source_paths:paths,source_labels:[...new Set([...labels,...paths.map(p=>p.join(' / '))])]});
 const base=sourceRecord||db.prepare('SELECT 对象类型,化合物名称 FROM 化合物 WHERE 化合物ID=?').get(id);
 return base?.对象类型==='peptide'?peptideClassification(value,base.化合物名称):value.items.some(i=>i.key===majorKey('peptides'))?peptideClassification(value):value;
}
function prepare(root,entry){
 if(signature(entry.origin)!==entry.sourceSignature)fail('谱库文件已更新，请先重新关联',409);
 const file=ensureWorkspace(root,entry),db=new DatabaseSync(entry.origin,{readOnly:true});
 try{db.prepare('ATTACH DATABASE ? AS work').run(file);
 detailViews(db,root,entry);
 const expr=(key,base)=>`CASE WHEN json_type(w.patch,'$.compound.${key}') IS NOT NULL THEN json_extract(w.patch,'$.compound.${key}') ELSE ${base} END`;
 const base={main_name:'coalesce(c.中文名称,c.化合物名称,\'名称未提供\')',name_zh:'c.中文名称',name_en:"json_extract(c.来源名称与结构JSON,'$.name_en')",cas:'c.CAS号',formula:"coalesce(json_extract(c.来源名称与结构JSON,'$.source_formula'),c.分子式)",identity_status:'c.身份状态'};
 const fields=Object.entries(base).map(([k,v])=>expr(k,v)+' AS '+k).join(',');
 db.exec(`CREATE TEMP VIEW effective_base AS SELECT c.化合物ID id,coalesce(w.state,'active') state,w.patch,${fields} FROM 化合物 c LEFT JOIN work.changes w ON w.id=c.化合物ID AND w.added=0;CREATE TEMP VIEW effective_added AS SELECT w.id,w.state,w.patch,${Object.keys(base).map(k=>`json_extract(w.patch,'$.compound.${k}') AS ${k}`).join(',')} FROM work.changes w WHERE w.added=1;CREATE TEMP VIEW effective AS SELECT * FROM effective_base UNION ALL SELECT * FROM effective_added`);
 return{db,dict:dictionary(db)};
 }catch(e){db.close();throw e}
}
function addMembership(statement,id,code){const known=FIXED_CLASSIFICATION_CATALOG.find(c=>c.category_code===code);if(!known)return;statement.run(id,code);if(known.parent_code)statement.run(id,known.parent_code)}
function initializeMembership(root,entry){
 const f=ensureWorkspace(root,entry),w=new DatabaseSync(f),stamp=entry.sourceSignature+':'+(entry.defaultMajor||'other')+':two-level-v4-source-subcategories-ion-v1';
 try{if(w.prepare("SELECT value FROM metadata WHERE key='membershipSource'").get()?.value===stamp)return;
 const base=new DatabaseSync(entry.origin,{readOnly:true}),dict=dictionary(base);try{w.exec('BEGIN IMMEDIATE;DELETE FROM membership');const add=w.prepare('INSERT OR IGNORE INTO membership VALUES(?,?)');
 let id=null,paths=[],labels=[],codes=new Set();const flush=()=>{if(id==null)return;let value=subdivideMajorValue(fixedMajorValue({catalog:FIXED_CLASSIFICATION_CATALOG,items:[...codes].filter(c=>c!=='other').map(c=>({key:majorKey(c)})),source_paths:paths,source_labels:labels}));if(value.items.some(i=>i.key===majorKey('peptides')))value=peptideClassification(value);for(const item of value.items){const[,code]=JSON.parse(item.key);if(code!=='other')addMembership(add,id,code)}};
 for(const row of base.prepare('SELECT 化合物ID, CAST(分类ID AS TEXT) AS 分类ID, 来源标签, 分类名称 FROM 化合物分类 ORDER BY 化合物ID').iterate()){
  if(id!==row.化合物ID){flush();id=row.化合物ID;paths=[];labels=[];codes=new Set()}const c=dict.by.get(row.分类ID);if(c){paths.push(categoryPath(dict,c));codes.add(codeFor(dict,c))}if(row.来源标签||row.分类名称){const label=String(row.来源标签||row.分类名称);labels.push(label);if(!c){paths.push([label]);codes.add(majorForLabels([label]))}}
 }flush();
 // Trusted source object type supplies the major; only validated notation supplies candidate subtypes.
 const childCodes=new Map(['unmodified','modified','unspecified','pending'].map(t=>[t,peptideCategoryCode(t)])),priorChildren=new Map();for(const row of w.prepare("SELECT id,major FROM membership WHERE major LIKE 'sub:peptides:%'").iterate()){if(!priorChildren.has(row.id))priorChildren.set(row.id,new Set());priorChildren.get(row.id).add(row.major)}
 for(const row of base.prepare("SELECT 化合物ID,化合物名称 FROM 化合物 WHERE 对象类型='peptide'").iterate()){add.run(row.化合物ID,'peptides');const prior=priorChildren.get(row.化合物ID);if(prior&&[...prior].some(code=>code!==childCodes.get('pending')))continue;const code=childCodes.get(peptideSourceInfo(row.化合物名称).subtype);if(prior?.has(childCodes.get('pending'))&&code!==childCodes.get('pending'))w.prepare('DELETE FROM membership WHERE id=? AND major=?').run(row.化合物ID,childCodes.get('pending'));add.run(row.化合物ID,code)}
 for(const row of w.prepare('SELECT * FROM changes').all()){const p=parse(row.patch)||{};if(p.classification){w.prepare('DELETE FROM membership WHERE id=?').run(row.id);for(const item of subdivideMajorValue(fixedMajorValue(p.classification,entry.defaultMajor)).items||[]){let code;try{[,code]=JSON.parse(item.key)}catch{continue}addMembership(add,row.id,code)}}}
 w.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('membershipSource',stamp);w.exec('COMMIT');
 }catch(e){try{w.exec('ROLLBACK')}catch{}throw e}finally{base.close()}
 }finally{w.close()}
}
function counts(root,entry){
 ensureWorkspace(root,entry);const w=new DatabaseSync(workspace(root,entry),{readOnly:true});try{const row=w.prepare("SELECT sum(CASE WHEN added=1 AND state='active' THEN 1 ELSE 0 END) additions,sum(CASE WHEN added=0 AND state<>'active' THEN 1 ELSE 0 END) removals,sum(state='trash') trashed FROM changes").get();return{total:entry.total+(row.additions||0)-(row.removals||0),trashed:row.trashed||0,revision:w.prepare("SELECT value FROM metadata WHERE key='revision'").get().value}}finally{w.close()}}
function filter(db,entry,input){const group=majorGroup(input.categoryKey);if(group){const base=filter(db,entry,{...input,categoryKey:undefined}),slots=group.members.map(()=>'?').join(',');let clause=group.code==='biology'?`EXISTS(SELECT 1 FROM work.membership k WHERE k.id=c.id AND k.major IN (${slots}))`:`c.id IN (SELECT k.id FROM work.membership k WHERE k.major IN (${slots}))`;if(group.members.includes(entry.defaultMajor||'other'))clause='('+clause+' OR NOT EXISTS(SELECT 1 FROM work.membership k WHERE k.id=c.id))';return{where:base.where+' AND ('+clause+')',params:[...base.params,...group.members]}}
 let where="c.state=?",params=[input.trash===true?'trash':'active'];const keyword=String(input.keyword||'').trim().toLowerCase();if(keyword.length>200)fail('查询文字过长');
 if(/^\d{2,7}-\d{2}-\d$/.test(keyword)){where+=" AND c.id IN (SELECT 化合物ID FROM 化合物 WHERE CAS号=? UNION SELECT id FROM work.changes WHERE json_extract(patch,'$.compound.cas')=?) AND c.cas=?";params.push(keyword,keyword,keyword)}else if(keyword){where+=" AND (instr(lower(coalesce(c.main_name,'')),?)>0 OR instr(lower(coalesce(c.name_zh,'')),?)>0 OR instr(lower(coalesce(c.name_en,'')),?)>0 OR c.cas=? OR instr(lower(coalesce(c.formula,'')),?)>0)";params.push(...Array(5).fill(keyword))}
 if(input.onlySelected){if(!Array.isArray(input.compoundIds)||!input.compoundIds.length||input.compoundIds.length>20000||input.compoundIds.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<1))fail('请选择有效记录');where+=` AND c.id IN (${input.compoundIds.map(()=>'?').join(',')})`;params.push(...input.compoundIds.map(Number))}
 if(input.identityStatus){where+=' AND c.identity_status=?';params.push(String(input.identityStatus))}
 const rawCategory=sourceCategoryFilter(db,entry,input.categoryKey);
 const axis=navigationAxisRoots(FIXED_MAJORS,input.categoryKey);
 if(rawCategory){where+=' AND '+rawCategory.where;params.push(...rawCategory.params)}
 else if(axis){const codes=axis.map(c=>c.category_code);const fallback=codes.includes(entry.defaultMajor||'other');
  where+=codes.length?' AND (c.id IN (SELECT id FROM work.membership WHERE major IN ('+codes.map(()=>'?').join(',')+'))'+(fallback?' OR NOT EXISTS (SELECT 1 FROM work.membership WHERE id=c.id)':'')+')':' AND 0';params.push(...codes)
 }else if(input.categoryKey){const remainder=remainderMajor(input.categoryKey);let ns,code;try{[ns,code]=JSON.parse(remainder?majorKey(remainder):input.categoryKey)}catch{if(input.categoryKey==='@pending')code='other';else fail('分类筛选无效')};if(ns&&ns!==MAJOR_NAMESPACE)fail('此分类不在工作台分类目录中');if(!FIXED_CLASSIFICATION_CATALOG.some(m=>m.category_code===code))fail('分类不可用');
  if(code===(entry.defaultMajor||'other')){where+=' AND (EXISTS(SELECT 1 FROM work.membership k WHERE k.id=c.id AND k.major=?) OR NOT EXISTS(SELECT 1 FROM work.membership k WHERE k.id=c.id))';params.push(code)}else{where+=' AND c.id IN (SELECT k.id FROM work.membership k WHERE k.major=?)';params.push(code)}
 }
 if(remainderMajor(input.categoryKey)){const children=FIXED_CLASSIFICATION_CATALOG.filter(c=>c.parent_code===remainderMajor(input.categoryKey)).map(c=>c.category_code);if(children.length){where+=` AND NOT EXISTS(SELECT 1 FROM work.membership k WHERE k.id=c.id AND k.major IN (${children.map(()=>'?').join(',')}))`;params.push(...children)}}
 if(input.sourceIds?.length)fail('此库请按来源名称查询');if(input.auditState)fail('此谱库没有样品自动检查结果，请选择有检测结果的数据源');
 const ms="coalesce(json_extract(c.patch,'$.ms'),(SELECT json_group_array(json_object('polarity',CASE WHEN m.离子模式='positive' THEN 1 WHEN m.离子模式='negative' THEN 0 ELSE m.原始极性编码 END,'q1',m.Q1母离子,'q3',m.Q3子离子)) FROM mrm_by_compound m WHERE m.lookup_compound_id=c.id))";
 const hasBaseSpectrum="EXISTS(SELECT 1 FROM links_by_compound r WHERE r.lookup_compound_id=c.id AND r.关系类型='spectrum_compound')",hasSpectrum="(CASE WHEN json_type(c.patch,'$.spectra') IS NOT NULL THEN coalesce(json_array_length(c.patch,'$.spectra'),0)>0 ELSE "+hasBaseSpectrum+" END)";
 const hasIon=p=>"(EXISTS(SELECT 1 FROM json_each("+ms+") m WHERE json_extract(m.value,'$.polarity')="+p+") OR CASE WHEN json_type(c.patch,'$.spectra') IS NOT NULL THEN EXISTS(SELECT 1 FROM json_each(c.patch,'$.spectra') s WHERE json_extract(s.value,'$.polarity')="+p+") ELSE EXISTS(SELECT 1 FROM links_by_compound r JOIN 谱图 s ON s.谱图ID=r.谱图ID WHERE r.lookup_compound_id=c.id AND r.关系类型='spectrum_compound' AND s.离子模式='"+(p===1?'positive':'negative')+"') END)";
 if(input.polarity!==undefined&&input.polarity!==null&&input.polarity!=='')where+=' AND '+ionModePredicate(input.polarity,hasIon(1),hasIon(0));
 if(input.spectrumKind){if(!['numeric','image'].includes(input.spectrumKind))fail('谱图形式无效');where+=input.spectrumKind==='numeric'?" AND (CASE WHEN json_type(c.patch,'$.spectra') IS NOT NULL THEN EXISTS(SELECT 1 FROM json_each(c.patch,'$.spectra') s WHERE json_extract(s.value,'$.kind')='numeric' OR json_extract(s.value,'$.spectrum_type')='numeric') ELSE "+hasBaseSpectrum+" END)":" AND EXISTS(SELECT 1 FROM json_each(c.patch,'$.spectra') s WHERE length(coalesce(json_extract(s.value,'$.image_base64'),''))>0)"}
 if(input.adduct){const q=String(input.adduct).trim().toLowerCase();if(q.length>200)fail('加合离子查询过长');where+=" AND (EXISTS(SELECT 1 FROM json_each(c.patch,'$.ms') m WHERE instr(lower(coalesce(json_extract(m.value,'$.adduct'),'')),?)>0) OR EXISTS(SELECT 1 FROM json_each(c.patch,'$.spectra') s WHERE instr(lower(coalesce(json_extract(s.value,'$.adduct'),'')),?)>0) OR (json_type(c.patch,'$.ms') IS NULL AND json_type(c.patch,'$.spectra') IS NULL AND EXISTS(SELECT 1 FROM source_by_compound s WHERE s.lookup_compound_id=c.id AND instr(lower(coalesce(s.加和方式,'')),?)>0)))";params.push(q,q,q)}
 if(input.sourceQuery){const q=String(input.sourceQuery).trim().toLowerCase();if(q.length>200)fail('来源查询过长');const matches=[...sourceNames(db,dictionary(db))].filter(([,name])=>name.toLowerCase().includes(q));const parts=[];for(const[key]of matches){const i=key.indexOf(':');parts.push("(s.来源分区=? AND (CAST(json_extract(s.来源JSON,'$.file_id') AS TEXT)=? OR CAST(json_extract(s.来源JSON,'$.file_key') AS TEXT)=?))");const id=key.slice(i+1);params.push(key.slice(0,i),id,id)}
 const original="EXISTS(SELECT 1 FROM source_by_compound s WHERE s.lookup_compound_id=c.id AND ("+(parts.length?parts.join(' OR ')+' OR ':'')+"instr(lower(coalesce(s.来源JSON,'')),?)>0))";params.push(q,q);where+=" AND (CASE WHEN json_type(c.patch,'$.sources') IS NOT NULL THEN EXISTS(SELECT 1 FROM json_each(c.patch,'$.sources') s WHERE instr(lower(coalesce(json_extract(s.value,'$.name'),'')),?)>0) ELSE "+original+" END)";
 // SQL placeholder order starts with the override predicate, then original source predicates.
 const count=matches.length*3+2,tail=params.splice(params.length-count,count);params.push(tail[tail.length-1],...tail.slice(0,-1));
 }

 const types=input.dataTypes||[];if(!Array.isArray(types)||types.some(t=>!['spectrum','numeric','image','measurement','response'].includes(t)))fail('数据类型筛选无效');for(const t of types){if(t==='spectrum')where+=" AND ((CASE WHEN json_type(c.patch,'$.ms') IS NOT NULL THEN json_array_length(c.patch,'$.ms')>0 ELSE EXISTS(SELECT 1 FROM mrm_by_compound m WHERE m.lookup_compound_id=c.id) END) OR "+hasSpectrum+")";else where+=` AND EXISTS(SELECT 1 FROM json_each(c.patch,'$.${t==='measurement'||t==='response'?'experiments':'chromatograms'}') x WHERE json_extract(x.value,'$.${t==='measurement'?'measurement':t==='response'?'ratio':t==='image'?'image_base64':'points'}') IS NOT NULL)`}
 return{where,params};
}
function sourceNames(db,dict){if(dict.sourceNames)return dict.sourceNames;const names=new Map();for(const row of db.prepare("SELECT 内容JSON FROM 来源资料 WHERE 原对象='source_files'").iterate()){const outer=parse(row.内容JSON)||{},detail=parse(outer.details_json)||outer;const name=detail.library_key||detail.name||detail.filename||detail.file_name||(detail.path?path.basename(detail.path):null);if(name)names.set(String(outer.part||'')+':'+String(outer.original_file_id||detail.file_id||detail.file_key),String(name))}dict.sourceNames=names;return names}
function sourceName(db,dict,s,info){const names=sourceNames(db,dict);for(const id of [info.file_id,info.file_key,info.original_file_id,info.library_key]){const name=names.get(String(s.来源分区)+':'+String(id));if(name)return name}return String(info.name||info.library_name||info.dataset||info.source_record_id||s.来源分区||'服务器文件库')}
function previewTransitions(db,id){
 const methods=[]
 const rows=db.prepare(`SELECT m.Q1母离子,m.Q3子离子,m.碰撞参数,m.原始方法JSON,s.字段值JSON
  FROM mrm_by_compound m LEFT JOIN 来源记录 s ON s.来源记录ID=m.来源记录ID
  WHERE m.lookup_compound_id=? ORDER BY m.MRM记录ID`)
 for(const row of rows.iterate(id)){
  const q1=number(row.Q1母离子),q3=number(row.Q3子离子)
  if(!(q1>0&&q3>0))continue
  const dp=number(parse(row.原始方法JSON)?.dp??parse(row.字段值JSON)?.dp)
  methods.push({q1,q3,dp,ce:number(row.碰撞参数)})
  if(methods.length===2)break
 }
 return methods
}
function record(db,row,dict,entry,input={}){
 const p=row.patch?parse(row.patch)||{}:{classification:parse(row.classificationPatch)},base=row.id<addedStart?db.prepare('SELECT * FROM 化合物 WHERE 化合物ID=?').get(row.id):null,extra=base?parse(base.来源名称与结构JSON)||{}:{};
 const classification=p.classification?subdivideMajorValue(fixedMajorValue(p.classification,entry.defaultMajor)):originalClassification(db,row.id,dict,entry.defaultMajor,base);
 const r={id:String(row.id),compound:{main_name:row.main_name,name_zh:row.name_zh,name_en:row.name_en,cas:row.cas,formula:row.formula,smiles:base?.SMILES,calculated_formula:base?.分子式,identity_status:row.identity_status,formula_source:extra.source_formula?'source':'calculated',...(p.compound||{})},classification,ms:[],lc:[],spectra:[],sources:[],chromatograms:[],experiments:[],checks:[],raw:p.raw||null,provenance:p.provenance||[]};
 if(!input.details){
  const methods=parse(row.msPatch)
  if(input.includeMrmSummary)r.mrmPreview=methods??(base?previewTransitions(db,row.id):[])
  const modes=[]
  if(methods)modes.push(...methods.map(m=>m.polarity))
  else if(base)modes.push(...db.prepare('SELECT 离子模式,原始极性编码 FROM mrm_by_compound WHERE lookup_compound_id=?').all(row.id).map(m=>m.离子模式||m.原始极性编码))
  if(Object.hasOwn(p,'spectra'))modes.push(...p.spectra.map(m=>m.polarity))
  else if(base)modes.push(...db.prepare("SELECT DISTINCT s.离子模式 FROM links_by_compound r JOIN 谱图 s ON s.谱图ID=r.谱图ID WHERE r.lookup_compound_id=? AND r.关系类型='spectrum_compound'").all(row.id).map(s=>s.离子模式))
  r.ionModes=ionFlags(modes)
  return r
 }
 if(input.policy&&!input.policy.features.spectra&&!input.policy.features.lc&&!input.policy.fields.source?.length)return r;
 const sources=base?db.prepare('SELECT * FROM source_by_compound WHERE lookup_compound_id=? ORDER BY 来源记录ID').all(row.id):[],bySource=new Map(sources.map(s=>[s.来源记录ID,s]));
 for(const m of base?db.prepare('SELECT * FROM mrm_by_compound WHERE lookup_compound_id=? ORDER BY MRM记录ID').all(row.id):[]){const raw=parse(m.原始方法JSON)||{},source=bySource.get(m.来源记录ID),values=parse(source?.字段值JSON)||{},u=unit(m.碰撞参数单位)||unit(source?.碰撞参数单位_逐条)||unit(source?.碰撞参数单位_文档声明),id='mrm:'+m.MRM记录ID;
  r.ms.push({...raw,id,ms_mode:raw.ms_mode||'MRM',q1:number(m.Q1母离子),q3:number(m.Q3子离子),ce:number(m.碰撞参数),ce_unit:u||'eV',ce_unit_source:u?'explicit':'default',dp:number(raw.dp??values.dp),cxp:number(raw.cxp??values.cxp),polarity:m.离子模式==='positive'?1:m.离子模式==='negative'?0:[0,1].includes(m.原始极性编码)?m.原始极性编码:null,ion_source:m.离子源||source?.离子源类型||null,ion_source_parameters_raw:source?.离子源参数||null,method_source:'来源记录 '+m.来源记录ID,source_record_id:m.来源记录ID,original_method_id:m.原始方法ID,transition_label:'原方法 '+m.原始方法ID,transition_role:'unspecified',quality_issue:m.Q1Q3有效?'':'原始离子对不完整或无效'});
 }
 for(const s of sources){const info=parse(s.来源JSON)||{},name=sourceName(db,dict,s,info);r.sources.push({name:String(name),version:null,source_record_id:s.来源记录ID,ce_unit:unit(s.碰撞参数单位_逐条)||unit(s.碰撞参数单位_文档声明)||(r.ms.some(m=>m.source_record_id===s.来源记录ID)?'eV':null),ce_unit_source:unit(s.碰撞参数单位_逐条)||unit(s.碰撞参数单位_文档声明)?'explicit':r.ms.some(m=>m.source_record_id===s.来源记录ID)?'default':null});
 const rt=number(s.保留时间),hasLC=rt!==null||s.色谱柱信息||s.液相梯度||s.流动相条件;if(hasLC){const obs=String(s.保留时间??'').split(/[/;；、,，]/).map(number).filter(v=>v!==null&&v>=0),u=unit(s.保留时间单位)||'min';r.lc.push({id:'source-lc:'+s.来源记录ID,method_source:'来源记录 '+s.来源记录ID,retention_time:rt??obs[0]??null,retention_time_unit:u,retention_times:obs.map((value,i)=>({id:'rt:'+s.来源记录ID+':'+i,value,unit:u,methodIds:r.ms.filter(m=>m.source_record_id===s.来源记录ID).map(m=>m.id)})),column_type:s.色谱柱信息,program_text:s.液相梯度,phase_A:s.流动相条件,gradient:[]})}
 }
 const spectra=base?db.prepare("SELECT DISTINCT s.* FROM links_by_compound r JOIN 谱图 s ON s.谱图ID=r.谱图ID WHERE r.lookup_compound_id=? AND r.关系类型='spectrum_compound' ORDER BY s.谱图ID").all(row.id):[];
 for(const s of spectra){r.spectra.push({id:'spectrum:'+s.谱图ID,kind:'numeric',spectrum_type:Number(s.MS级别)===1?'MS1':Number(s.MS级别)===2?'MS2':'未注明',precursor_mz:number(s.前体mz),polarity:s.离子模式==='positive'?1:s.离子模式==='negative'?0:null,collision_energy:{value:number(s.建库碰撞参数),unit:unit(s.建库碰撞参数单位)},peak_count:s.谱峰数,peaks:input.includePeaks?db.prepare('SELECT mz,强度 intensity FROM 谱峰 WHERE 谱图ID=? ORDER BY 峰序号').all(s.谱图ID):[],peaksDeferred:!input.includePeaks,methodIds:[]})}
 for(const group of ['ms','lc','spectra','sources','chromatograms','experiments'])if(Object.hasOwn(p,group))r[group]=p[group];
 r.ms=r.ms.map(m=>({...m,quality_issue:methodQualityIssue(m)}));
 if(input.includePeaks)for(const s of r.spectra)if(s.peaksDeferred&&/^spectrum:[0-9]+$/.test(s.id)){s.peaks=db.prepare('SELECT mz,强度 intensity FROM 谱峰 WHERE 谱图ID=? ORDER BY 峰序号').all(Number(s.id.split(':')[1]));s.peaksDeferred=false}
 return r;
}
const queryTotalCache=new Map();const categoryCountCache=new Map();
function filteredTotal(db,entry,input,f){const current=db.prepare("SELECT value FROM work.metadata WHERE key='revision'").get().value,stats=categoryCountCache.get(JSON.stringify([entry.id,entry.sourceSignature,entry.defaultMajor,current]));if(input.categoryKey&&stats&&!input.categoryKey.startsWith('axis:')&&!input.categoryKey.startsWith('["sqlite-native:')){const plain=filter(db,entry,{categoryKey:input.categoryKey});if(plain.where===f.where&&JSON.stringify(plain.params)===JSON.stringify(f.params)){const group=majorGroup(input.categoryKey),remainder=remainderMajor(input.categoryKey);return group?(stats.value.groupCounts[group.code]||0):remainder?(stats.value.remainders[remainder]||0):(stats.value.counts[input.categoryKey==='@pending'?majorKey('other'):input.categoryKey]||0)}}const key=JSON.stringify([entry.id,entry.sourceSignature,entry.defaultMajor,db.prepare("SELECT value FROM work.metadata WHERE key='revision'").get().value,f.where,f.params]);const prior=queryTotalCache.get(key);if(prior)return prior.total;const total=Number(db.prepare('SELECT count(*) n FROM effective c WHERE '+f.where).get(...f.params).n);queryTotalCache.set(key,{total,at:Date.now()});while(queryTotalCache.size>128)queryTotalCache.delete(queryTotalCache.keys().next().value);return total}
function rows(root,entry,input={},all=false){
 initializeMembership(root,entry);const current=revision(root,entry);if(input.revision&&input.revision!==current)fail('管理工作区已更新，请刷新后重试',409);
 const{db,dict}=prepare(root,entry);try{const f=filter(db,entry,input),page=Math.max(1,Math.trunc(Number(input.page)||1));const total=!input.keyword&&!input.categoryKey&&!input.onlySelected&&!input.identityStatus&&(input.polarity===undefined||input.polarity===null||input.polarity==='')&&!input.adduct&&!input.spectrumKind&&!input.dataTypes?.length&&!input.sourceQuery?counts(root,entry)[input.trash?'trashed':'total']:filteredTotal(db,entry,input,f);
 if(input.countOnly)return{total,page,entry:{...entry,revision:current,readOnly:!!entry.readOnly},revision:current,categories:FIXED_CLASSIFICATION_CATALOG,classes:[],rows:[]};
 const select=input.details?'c.*':"c.id,c.state,c.main_name,c.name_zh,c.name_en,c.cas,c.formula,c.identity_status,json_extract(c.patch,'$.classification') classificationPatch"+
  (input.includeMrmSummary?",json_extract(c.patch,'$.ms') msPatch":"");const addedCount=Number(db.prepare('SELECT count(*) n FROM effective_added c WHERE '+f.where).get(...f.params).n),baseCount=total-addedCount,offset=all?0:(page-1)*50,limit=all?total:50,selected=[];
 if(offset<baseCount){const take=Math.min(limit,baseCount-offset),fromEnd=baseCount-offset-take,reverse=fromEnd<offset;const rows=db.prepare('SELECT '+select+' FROM effective_base c WHERE '+f.where+' ORDER BY c.id '+(reverse?'DESC':'ASC')+' LIMIT ? OFFSET ?').all(...f.params,take,reverse?fromEnd:offset);selected.push(...(reverse?rows.reverse():rows))}
 if(selected.length<limit&&addedCount)selected.push(...db.prepare('SELECT '+select+' FROM effective_added c WHERE '+f.where+' ORDER BY c.id LIMIT ? OFFSET ?').all(...f.params,limit-selected.length,Math.max(0,offset-baseCount)));return{total,page,entry:{...entry,revision:current,readOnly:!!entry.readOnly},revision:current,categories:FIXED_CLASSIFICATION_CATALOG,classes:[],rows:selected.map(row=>({id:row.id,key:String(row.id),record:record(db,row,dict,entry,input)}))};
 }finally{db.close()}
}
function uncachedCategories(root,entry){initializeMembership(root,entry);const{db}=prepare(root,entry);try{const values={};for(const row of db.prepare("SELECT k.major,count(*) n FROM work.membership k LEFT JOIN work.changes w ON w.id=k.id WHERE coalesce(w.state,'active')='active' GROUP BY k.major").all())values[majorKey(row.major)]=row.n;
 const fallback=entry.defaultMajor||'other',without=counts(root,entry).total-Number(db.prepare("SELECT count(distinct k.id) n FROM work.membership k LEFT JOIN work.changes w ON w.id=k.id WHERE coalesce(w.state,'active')='active'").get().n);values[majorKey(fallback)]=(values[majorKey(fallback)]||0)+without;
 const remainders={};for(const major of FIXED_MAJORS){const children=FIXED_CLASSIFICATION_CATALOG.filter(c=>c.parent_code===major.category_code).map(c=>c.category_code);const detailed=children.length?Number(db.prepare("SELECT count(distinct k.id) n FROM work.membership k LEFT JOIN work.changes w ON w.id=k.id WHERE coalesce(w.state,'active')='active' AND k.major IN ("+children.map(()=>'?').join(',')+")").get(...children).n):0;remainders[major.category_code]=(values[majorKey(major.category_code)]||0)-detailed}const groupCounts={};for(const g of MAJOR_GROUPS){groupCounts[g.code]=Number(db.prepare("SELECT count(distinct k.id) n FROM work.membership k LEFT JOIN work.changes w ON w.id=k.id WHERE coalesce(w.state,'active')='active' AND k.major IN ("+g.members.map(()=>'?').join(',')+")").get(...g.members).n)+(g.members.includes(entry.defaultMajor||'other')?without:0)}return{catalog:FIXED_CLASSIFICATION_CATALOG,counts:values,remainders,groupCounts,total:counts(root,entry).total,pending:0};}finally{db.close()}}
function categories(root,entry,options={}){const useSource=options.sourceTaxonomy===true&&hasSourceTaxonomy(entry);const key=JSON.stringify([entry.id,entry.sourceSignature,entry.defaultMajor,revision(root,entry),...(useSource?['source']:[])]),prior=categoryCountCache.get(key);if(prior)return prior.value;
 let value;if(useSource){const {db}=prepare(root,entry);try{value={...sourceCategories(db,entry),total:counts(root,entry).total}}finally{db.close()}}else value=uncachedCategories(root,entry);categoryCountCache.set(key,{value,at:Date.now()});while(categoryCountCache.size>16)categoryCountCache.delete(categoryCountCache.keys().next().value);return value}
function peaks(root,entry,input){const{db}=prepare(root,entry);try{const current=db.prepare('SELECT * FROM effective WHERE id=?').get(Number(input.id));if(!current||current.state!=='active')fail('记录不可用',404);const patch=parse(current.patch)||{};if(patch.spectra&&!patch.spectra.some(s=>s.id===input.spectrumId&&s.peaksDeferred))fail('谱图已修改，请刷新详情',409);const id=Number(String(input.spectrumId).replace(/^spectrum:/,''));if(!Number.isSafeInteger(id)||!db.prepare("SELECT 1 FROM links_by_compound WHERE lookup_compound_id=? AND 谱图ID=? AND 关系类型='spectrum_compound'").get(Number(input.id),id))fail('谱图不属于此化合物',404);return db.prepare('SELECT mz,强度 intensity FROM 谱峰 WHERE 谱图ID=? ORDER BY 峰序号').all(id)}finally{db.close()}}
module.exports={inspectLDS,ensureWorkspace,initializeMembership,workspace,revision,counts,rows,categories,peaks,addedStart,parse,record,prepare};

function normalizeGroups(value){
 for(const group of ['ms','lc','spectra','sources','chromatograms','experiments']){
  const seen=new Set();for(const row of value[group]||[]){row.id=row.id==null||row.id===''?group+':'+crypto.randomUUID():String(row.id);if(seen.has(row.id))fail(group+'记录编号重复');seen.add(row.id);
   if(row.methodIds)row.methodIds=row.methodIds.map(String);
   for(const rt of row.retention_times||[])if(rt.methodIds)rt.methodIds=rt.methodIds.map(String);
  }
 }
 return value;
}
function validateDeferred(base,id,value){
 for(const s of value.spectra||[])if(s.peaksDeferred){const key=Number(String(s.id).replace(/^spectrum:/,''));if(!base||!/^spectrum:[0-9]+$/.test(s.id)||!base.prepare("SELECT 1 FROM links_by_compound WHERE lookup_compound_id=? AND 谱图ID=? AND 关系类型='spectrum_compound'").get(id,key))fail('延迟加载谱图不属于此化合物');}
}
function validatePatch(value,partial=false){
 if(!value||typeof value!=='object'||Array.isArray(value))fail('工作区数据无效');const allowed=new Set(['compound','ms','lc','spectra','sources','chromatograms','experiments','classification','raw','provenance']);for(const k of Object.keys(value))if(!allowed.has(k))fail('不支持的记录字段：'+k);
 if(value.compound){if(typeof value.compound!=='object'||Array.isArray(value.compound))fail('基本信息无效');for(const [k,v]of Object.entries(value.compound)){if(k==='main_name'&&(typeof v!=='string'||!v.trim()))fail('名称不能为空');if(['molecular_mass','monoisotopic_mass'].includes(k)&&v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0))fail('质量须为非负数值');if(typeof v==='string'&&v.length>100000)fail('单字段内容过长')}}
 if(!partial&&(!value.compound?.main_name||!String(value.compound.main_name).trim()))fail('名称不能为空');
 for(const k of ['ms','lc','spectra','sources','chromatograms','experiments'])if(Object.hasOwn(value,k)&&(!Array.isArray(value[k])||value[k].length>5000||value[k].some(v=>!v||typeof v!=='object'||Array.isArray(v))))fail(k+'须为有效记录数组');
 for(const m of value.ms||[]){for(const k of ['q1','q3','ce','dp','cxp'])if(m[k]!=null&&(typeof m[k]!=='number'||!Number.isFinite(m[k])||['q1','q3'].includes(k)&&m[k]<=0))fail(k+'数值无效');if(m.polarity!=null&&![0,1].includes(m.polarity))fail('极性仅支持0/1或空值');if(!unit(m.ce_unit)){m.ce_unit='eV';m.ce_unit_source='default'}else if(m.ce_unit_source==='default'&&m.ce_unit!=='eV')m.ce_unit_source='administrator';m.quality_issue=methodQualityIssue(m,true)}
 for(const m of value.lc||[]){if(m.retention_time!=null&&(typeof m.retention_time!=='number'||!Number.isFinite(m.retention_time)||m.retention_time<0))fail('保留时间须为非负数');if(!m.retention_time_unit)m.retention_time_unit='min'}
 for(const spec of value.spectra||[]){if(spec.peaks!=null&&(!Array.isArray(spec.peaks)||spec.peaks.length>2000000||spec.peaks.some(p=>!p||typeof p.mz!=='number'||!Number.isFinite(p.mz)||p.mz<=0||typeof p.intensity!=='number'||!Number.isFinite(p.intensity)||p.intensity<0)))fail('谱峰必须具有有效正mz和非负强度');if(spec.methodIds!=null&&!Array.isArray(spec.methodIds))fail('谱图方法关联无效')}
 if(value.classification){if(!Array.isArray(value.classification.items))fail('分类结构无效');for(const item of value.classification.items){if(!FIXED_CLASSIFICATION_CATALOG.some(c=>majorKey(c.category_code)===item.key))fail('请选择固定大类');}value.classification={...value.classification,version:1,scheme:'fixed-majors-v1',catalog:FIXED_CLASSIFICATION_CATALOG}}
 return normalizeGroups(JSON.parse(JSON.stringify(value)));
}
function mutate(root,entry,input){
 initializeMembership(root,entry);if(!input.revision)fail('工作区修订缺失，请刷新',409);const db=new DatabaseSync(workspace(root,entry));let base;
 try{db.exec('BEGIN IMMEDIATE');if(db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value!==input.revision)fail('工作区已更新，请重新打开后保存',409);if(signature(entry.origin)!==entry.sourceSignature)fail('谱库文件已更新，请重新关联',409);
 const action=input.action,ids=input.ids||[input.id],changed=[],batchAt=new Date().toISOString();let duplicate=false;
 if(action==='massbank-add'||action==='source-archive'){
  const archive=action==='source-archive';
  if(archive&&!entry.managedSourceArchive)fail('此操作仅限自动更新谱库',403);
  const records = new Map();
  const { db: reader, dict } = prepare(root, entry);
  try {
   for (const operation of input.operations) {
    const key = operation.target ?? (archive ? operation.identityKey : operation.record.compound.inchikey);
    if (!records.has(key)) {
     if (operation.target) {
      const existing = reader.prepare('SELECT * FROM effective WHERE id=? AND state=?').get(operation.target, 'active');
      if (!existing) fail('目标化合物已变化', 409);
      const current = record(reader, existing, dict, entry, { details: true });
      records.set(key, { spectra: current.spectra, sources: current.sources, ms: current.ms, lc: current.lc });
     } else {
      records.set(key, { compound: operation.record.compound, raw: archive ? {sourceArchiveKey:key} : {massbankPilot:true}, spectra: [], sources: [], ms: [], lc: [] });
     }
    }
    const destination = records.get(key);
    for (const group of ['spectra','sources','ms','lc']) destination[group].push(...operation.record[group]);
   }
  } finally { reader.close(); }
  base = new DatabaseSync(entry.origin,{readOnly:true});detailViews(base,root,entry);
  let next = Math.max(addedStart, db.prepare('SELECT coalesce(max(id),0) n FROM changes WHERE added=1').get().n) + 1;
  for (const [key, value] of records) {
   const attach = typeof key === 'number', id = attach ? key : next++;
   const old = db.prepare('SELECT * FROM changes WHERE id=?').get(id);
   const addition = validatePatch(value, attach);
   validateDeferred(attach ? base : null, id, addition);
   db.prepare('INSERT OR REPLACE INTO changes VALUES(?,?,?,?,?)').run(id, old?.added ?? Number(!attach), 'active',
    JSON.stringify({ ...(parse(old?.patch) || {}), ...addition }), batchAt);
   changed.push(id);
  }
  db.prepare('INSERT INTO imports(hash,ids,at) VALUES(?,?,?)').run((archive?'source-archive:':'massbank:')+input.hash,JSON.stringify(changed),batchAt);
 }else if(['create','import'].includes(action)){
  const records=action==='create'?[input.record]:input.records;if(!Array.isArray(records)||!records.length||records.length>20000)fail('每批导入1–20000条');
  if(input.hash&&db.prepare('SELECT 1 FROM imports WHERE hash=?').get(input.hash)){duplicate=true}else{
   let next=Math.max(addedStart,db.prepare('SELECT coalesce(max(id),0) n FROM changes WHERE added=1').get().n)+1;
   const insert=db.prepare("INSERT INTO changes(id,added,state,patch,updated_at)VALUES(?,1,'active',?,?)");for(const value of records){const r=validatePatch(value);validateDeferred(null,null,r);for(const group of ['ms','lc','spectra','sources','chromatograms','experiments'])for(const [i,m]of(r[group]||[]).entries())m.id=m.id||group+':'+next+':'+i;insert.run(next,JSON.stringify(r),batchAt);changed.push(next++)}
   if(input.hash)db.prepare('INSERT INTO imports(hash,ids,at)VALUES(?,?,?)').run(input.hash,JSON.stringify(changed),batchAt);
  }
 }else if(action==='undo-import'){const batch=db.prepare('SELECT * FROM imports WHERE hash=?').get(input.hash);if(!batch)fail('导入批次不存在');const batchIds=JSON.parse(batch.ids);for(const id of batchIds){const row=db.prepare('SELECT * FROM changes WHERE id=?').get(id);if(!row||row.state!=='active'||row.updated_at!==batch.at)fail('本批次已有记录被修改或删除，不能整体撤销',409)}for(const id of batchIds){db.prepare("UPDATE changes SET state='trash',updated_at=? WHERE id=?").run(batchAt,id);changed.push(id)}db.prepare('DELETE FROM imports WHERE hash=?').run(input.hash)
 }else{
  if(!Array.isArray(ids)||!ids.length||ids.length>20000||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1))fail('记录范围无效');base=new DatabaseSync(entry.origin,{readOnly:true});detailViews(base,root,entry);
  for(const id of ids){const old=db.prepare('SELECT * FROM changes WHERE id=?').get(id),exists=old?.added||base.prepare('SELECT 1 FROM 化合物 WHERE 化合物ID=?').get(id);if(!exists||old?.state==='purged')fail('记录不存在或已彻底删除',409);let patch=parse(old?.patch)||{},state=old?.state||'active';
   if(action==='update'){if(state!=='active')fail('请先恢复记录',409);const update=validatePatch(input.record,true);validateDeferred(base,id,update);patch={...patch,...update,compound:{...(patch.compound||{}),...(update.compound||{})}}}
   else if(action==='assign'){if(state!=='active')fail('请选择可用记录',409);const current=patch.classification||originalClassification(base,id,dictionary(base),entry.defaultMajor),keys=input.categories||[];if(keys.some(key=>!FIXED_CLASSIFICATION_CATALOG.some(m=>majorKey(m.category_code)===key)))fail('请选择固定大类或二级类别');if(input.mode==='unlock')delete patch.classification;else patch.classification={...current,catalog:FIXED_CLASSIFICATION_CATALOG,items:[...new Set(input.mode==='add'?[...current.items.map(i=>i.key),...keys]:(keys.length?keys:[majorKey('other')]))].map(key=>({key,review_status:'confirmed'}))};}
   else if(action==='delete'){if(state!=='active')fail('记录状态已变化',409);state='trash'}else if(action==='restore'){if(state!=='trash')fail('记录不在回收站',409);state='active'}else if(action==='purge'){if(state!=='trash')fail('请先移入回收站',409);state='purged'}else fail('工作区操作无效');
   db.prepare('INSERT OR REPLACE INTO changes VALUES(?,?,?,?,?)').run(id,old?.added||0,state,JSON.stringify(patch),new Date().toISOString());changed.push(id);
  }
 }
 const dict=base?dictionary(base):null;for(const id of changed){const row=db.prepare('SELECT * FROM changes WHERE id=?').get(id),patch=parse(row.patch)||{};if(!patch.classification&&!row.added&&action!=='assign')continue;db.prepare('DELETE FROM membership WHERE id=?').run(id);const classification=patch.classification||(base?originalClassification(base,id,dict,entry.defaultMajor):null);for(const item of classification?.items||[]){const[,code]=JSON.parse(item.key);addMembership(db.prepare('INSERT OR IGNORE INTO membership VALUES(?,?)'),id,code)}}
 const nextRevision=changed.length?crypto.randomUUID():input.revision;db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(nextRevision);db.prepare('INSERT INTO events(at,actor,action,record_ids)VALUES(?,?,?,?)').run(new Date().toISOString(),String(input.actor||'admin'),action,JSON.stringify(changed));if(signature(entry.origin)!==entry.sourceSignature)fail('源文件变化，保存已取消',409);db.exec('COMMIT');return{revision:nextRevision,changed:changed.length,ids:changed,duplicate,...counts(root,entry)};
 }catch(e){try{db.exec('ROLLBACK')}catch{}throw e}finally{base?.close();db.close()}
}
function* records(root,entry,input){
 const version=revision(root,entry);initializeMembership(root,entry);const{db,dict}=prepare(root,entry);
 try{db.exec('BEGIN');const f=filter(db,entry,input),n=Number(db.prepare('SELECT count(*) n FROM effective c WHERE '+f.where).get(...f.params).n);if(n>20000)fail('本次选择超过 20,000 个化合物，请缩小范围后生成交付；全库大范围交付尚需分块格式');
  for(const row of db.prepare('SELECT c.* FROM effective c WHERE '+f.where+' ORDER BY c.id').iterate(...f.params)){
   const includePeaks=!!input.policy?.features?.spectra&&input.policy.fields.spectrum?.includes('peaks');if(includePeaks){const peaks=db.prepare("SELECT coalesce(sum(s.谱峰数),0)n FROM links_by_compound r JOIN 谱图 s ON s.谱图ID=r.谱图ID WHERE r.lookup_compound_id=? AND r.关系类型='spectrum_compound'").get(row.id).n;if(peaks>2000000)fail('单化合物谱峰体积过大，请取消谱峰字段或缩小交付内容')}
   yield record(db,row,dict,entry,{details:true,includePeaks,policy:input.policy});
  }
  if(version!==revision(root,entry)||signature(entry.origin)!==entry.sourceSignature)fail('交付期间数据修订已变化，本次已取消',409);
 }finally{db.close()}
}
module.exports.mutate=mutate;module.exports.records=records;

function backup(root,entry){const db=new DatabaseSync(ensureWorkspace(root,entry),{readOnly:true});try{db.exec('BEGIN');return{format:'MasspecLib2-LDS-workspace',version:1,libraryId:entry.id,sourceSignature:entry.sourceSignature,sourcePath:entry.origin,createdAt:new Date().toISOString(),revision:revision(root,entry),changes:db.prepare('SELECT * FROM changes').all(),imports:db.prepare('SELECT * FROM imports').all(),events:db.prepare('SELECT * FROM events ORDER BY id').all()}}finally{db.close()}}
function restore(root,entry,input){const data=input.backup;if(input.confirmation!==true||data?.format!=='MasspecLib2-LDS-workspace'||data.version!==1||data.libraryId!==entry.id||data.sourceSignature!==entry.sourceSignature||!Array.isArray(data.changes))fail('备份身份或源修订不匹配，未恢复');const db=new DatabaseSync(ensureWorkspace(root,entry));try{db.exec('BEGIN IMMEDIATE');if(input.revision!==db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value)fail('工作区已变化，请重新打开恢复',409);const source=new DatabaseSync(entry.origin,{readOnly:true});const seen=new Set();try{for(const row of data.changes){if(!Number.isSafeInteger(row.id)||row.id<1||seen.has(row.id)||![0,1].includes(row.added)||!['active','trash','purged'].includes(row.state)||row.added!==Number(row.id>=addedStart))fail('备份记录无效');seen.add(row.id);if(!row.added&&!source.prepare('SELECT 1 FROM 化合物 WHERE 化合物ID=?').get(row.id))fail('备份引用的原始化合物不存在');validatePatch(JSON.parse(row.patch),!row.added)}}finally{source.close()}db.exec('DELETE FROM changes;DELETE FROM imports;DELETE FROM membership');for(const row of data.changes)db.prepare('INSERT INTO changes VALUES(?,?,?,?,?)').run(row.id,row.added,row.state,row.patch,row.updated_at);for(const row of data.imports||[])db.prepare('INSERT INTO imports VALUES(?,?,?)').run(row.hash,row.ids,row.at);const next=crypto.randomUUID();db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(next);db.prepare("DELETE FROM metadata WHERE key='membershipSource'").run();db.prepare('INSERT INTO events(at,actor,action,record_ids)VALUES(?,?,?,?)').run(new Date().toISOString(),String(input.actor||'admin'),'restore-workspace',JSON.stringify([...seen]));if(signature(entry.origin)!==entry.sourceSignature)fail('源库修订已变化，恢复已取消',409);db.exec('COMMIT');return{restored:true,revision:next}}catch(e){try{db.exec('ROLLBACK')}catch{}throw e}finally{db.close()}}
module.exports.backup=backup;module.exports.restore=restore;

function checkRelink(root,old,next){if(!old||old.sourceSignature===next.sourceSignature&&old.origin===next.origin)return;const file=workspace(root,old);if(!fs.existsSync(file))return;const db=new DatabaseSync(file,{readOnly:true});try{if(db.prepare('SELECT count(*) n FROM changes').get().n)fail('此库工作区已有变更，源文件修订或位置不同。请先备份工作区，作为新数据源关联并核对记录身份；未套用旧修改',409)}finally{db.close()}}
module.exports.checkRelink=checkRelink;
