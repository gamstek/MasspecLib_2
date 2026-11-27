const {groupMemberships}=require('../../src/shared/majorGroups.mjs')
const {remainderMajor,remainderMajors,matchesNavigation}=require('../../src/shared/categoryNavigation.mjs')
const {recordIonFlags}=require('../../src/shared/ionMode.mjs')
const lds=require('./lds-sqlite.cjs')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { fail, text, hash, normalizePolicy, fields, pick } = require('./policy.cjs')
const { clean, SnapshotBuilder, measurement, limit, ratio } = require('./snapshot.cjs')
const { projectClassification, classificationCatalog, classificationDescendants, classificationKey } = require('../../src/shared/deliveryClassification.mjs')
const { inspectUnified, unifiedRows, unifiedRecords, unifiedCategories, signature } = require('./unified-sqlite.cjs')
const {nativeFileFilters}=require('./file-filters.cjs')
const {fixedMajorValue,subdivideMajorValue,FIXED_MAJORS,FIXED_CLASSIFICATION_CATALOG,majorKey}=require('../../src/shared/fixedMajors.mjs')
const classify=(record,entry)=>({...record,classification:subdivideMajorValue(fixedMajorValue(record.classification,entry.defaultMajor))})
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const digestCache = new Map()
function digest(file) {
  if (fs.lstatSync(file).isSymbolicLink()) fail('数据库必须为普通 SQLite 文件')
  const key = () => {
    if (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size) fail('源库存在未合并日志，请先合并后关联')
    const stat = fs.statSync(file)
    return [stat.size,stat.mtimeMs,stat.ctimeMs].join(':')
  }
  const before = key(), prior = digestCache.get(file)
  if (prior?.key === before) return prior.value
  const checksum = crypto.createHash('sha256'), buffer = Buffer.alloc(4 * 1024 * 1024)
  const fd = fs.openSync(file, 'r')
  try {
    let length
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      checksum.update(buffer.subarray(0, length))
  } finally { fs.closeSync(fd) }
  if (key() !== before) fail('校验期间源文件变化，请重试', 409)
  const value = checksum.digest('hex')
  digestCache.set(file, { key:before, value })
  while (digestCache.size > 32) digestCache.delete(digestCache.keys().next().value)
  return value
}
function sqlite(file, readOnly = true) { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file, { readOnly, enableForeignKeyConstraints: true }) }
const inspectionCache=new Map();
function inspectFile(file) {if(fs.lstatSync(file).isSymbolicLink())fail('数据库必须为普通 SQLite 文件');const stat=fs.statSync(file),signature=stat.size+':'+stat.mtimeMs+':'+stat.ctimeMs;const prior=inspectionCache.get(file);if(prior&&prior.signature===signature&&!fs.existsSync(file+'-wal'))return structuredClone(prior.value);const value=inspectFileUncached(file);inspectionCache.set(file,{signature,value});while(inspectionCache.size>32)inspectionCache.delete(inspectionCache.keys().next().value);return structuredClone(value)}
function inspectFileUncached(file) {
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) fail('数据库必须为普通 SQLite 文件')
  if (fs.existsSync(file + '-wal') && fs.statSync(file + '-wal').size > 0) fail('数据库仍有未合并日志，请先完成检查点并停止写入后注册')
  const db = sqlite(file)
  try {
    const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(r => [r.key, r.value]))
    if (metadata.product !== 'MasspecLib2' || metadata.schemaVersion !== '1' || !uuid(metadata.libraryId) || !uuid(metadata.revision)) fail('不支持的文件库格式；请先转换为 MasspecLib2 SQLite 文件库')
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('SQLite 完整性检查失败')
    text(metadata.title, '数据库名称')
    let active = 0, trashed = 0;const displayFields=new Set()
    for (const row of db.prepare('SELECT ordinal,id,payload,class_ids,trashed FROM records').iterate()) {
      const record = JSON.parse(row.payload), classes = JSON.parse(row.class_ids)
      if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || typeof row.id !== 'string' || !row.id || record.id !== row.id || typeof record.compound?.main_name !== 'string' || !record.compound.main_name.trim() || !Array.isArray(classes) || classes.some(c => !Number.isSafeInteger(c) || c < 1) || ![0,1].includes(row.trashed)) fail('文件库记录结构无效')
      for (const key of ['ms','lc','spectra','sources','chromatograms','experiments']) if (record[key] != null && !Array.isArray(record[key])) fail('文件库关联记录结构无效')
      row.trashed ? trashed++ : active++
      if(!row.trashed)for(const [key,value]of Object.entries(record.compound)){if(value!==null&&value!==undefined&&String(value).trim()&&(!['name_en','name_zh'].includes(key)||String(value).trim()!==String(record.compound.main_name||'').trim()))displayFields.add(key)}
    }
    const classes = db.prepare('SELECT id,class_name FROM classes ORDER BY class_name').all()
    return { ...metadata, total: active, trashed, classes,displayFields:[...displayFields] }
  } finally { db.close() }
}
function createLibrary(file, { libraryId = crypto.randomUUID(), revision = crypto.randomUUID(), title, records, classes = [] }) {
  if (!uuid(libraryId) || !uuid(revision)) fail('文件库标识无效')
  if (fs.existsSync(file)) fail('目标文件已存在')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = sqlite(file, false)
  try {
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE records(ordinal INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,class_ids TEXT NOT NULL DEFAULT \'[]\',trashed INTEGER NOT NULL DEFAULT 0 CHECK(trashed IN(0,1))); CREATE TABLE classes(id INTEGER PRIMARY KEY,class_name TEXT NOT NULL); BEGIN IMMEDIATE')
    for (const [key,value] of Object.entries({ product:'MasspecLib2',schemaVersion:'1',libraryId,revision,title:text(title,'数据库名称') })) db.prepare('INSERT INTO metadata VALUES(?,?)').run(key,value)
    const categoryMap=new Map();for(const record of records)for(const c of record.classification?.catalog||[])categoryMap.set(classificationKey(c),c)
    const categories=classificationCatalog([...categoryMap.values()]);db.prepare('INSERT INTO metadata VALUES(?,?)').run('classificationCatalog',JSON.stringify(categories))
    let ordinal = 0
    for (const record of records) db.prepare('INSERT INTO records(ordinal,id,payload,class_ids) VALUES(?,?,?,?)').run(++ordinal, String(record.id), JSON.stringify({ ...record, id: String(record.id) }), JSON.stringify(record.classIds || []))
    for (const c of classes) db.prepare('INSERT INTO classes VALUES(?,?)').run(c.id,c.class_name)
    db.exec('COMMIT')
  } catch(e) { try { db.exec('ROLLBACK') } catch {} throw e } finally { db.close() }
  fs.chmodSync(file, 0o600); return inspectFile(file)
}
function inspectSource(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('请输入服务器绝对目录或文件路径')
  const real = fs.realpathSync(directory)
  const source = fs.statSync(real).isFile() ? real : path.join(real,'library.sqlite')
  if (!fs.statSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) fail('请选择普通 SQLite 数据库文件')
  signature(source)
  const db = sqlite(source)
  let tables
  try {
    tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map(row => row.name))
  } finally { db.close() }
  if (tables.has('化合物') || tables.has('构建信息') || tables.has('谱图')) return {source,metadata:lds.inspectLDS(source)}
  if (tables.has('metadata') && tables.has('records')) return {source,metadata:inspectFile(source)}
  if (tables.has('compounds')) return {source,metadata:inspectUnified(source)}
  fail('未识别到受支持的表结构，请选择谱库 SQLite 文件、MasspecLib2 文件库或统一交付库')
}
class FileLibraries {
  constructor(root) { this.root = path.resolve(root); this.registry = path.join(this.root,'registry.json') }
  state() { if (!fs.existsSync(this.registry)) return { version:1,libraries:[] }; const d=JSON.parse(fs.readFileSync(this.registry,'utf8')); if(d.version!==1||!Array.isArray(d.libraries))fail('文件库目录损坏',500); return d }
  save(data) {
    fs.mkdirSync(this.root,{recursive:true,mode:0o700}); const tmp=this.registry+'.'+crypto.randomUUID()+'.tmp'
    try { fs.writeFileSync(tmp,JSON.stringify(data,null,2),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.registry) } finally { if(fs.existsSync(tmp))fs.unlinkSync(tmp) }
  }
  setAccess(input) {
    const data = this.state()
    const entry = data.libraries.find(e => 'file:' + e.id === input.libraryId)
    if (!entry) fail('文件库不存在', 404)
    if (typeof input.readOnly !== 'boolean') fail('读写权限无效')
    if (entry.managedSourceArchive && !input.readOnly) fail('自动更新谱库由服务器维护',403)
    if (entry.adapter === 'unified-sqlite' && !input.readOnly) fail('直接关联的 SQLite 源文件只读，请使用管理副本', 403)
    entry.readOnly = input.readOnly
    this.save(data)
    return { readOnly: entry.readOnly }
  }
  writableEntry(id) {
    const entry = this.entry(id)
    if (entry.readOnly || entry.adapter === 'unified-sqlite') fail('此数据源只读，不能修改记录', 403)
    return entry
  }
  setDefault(input){const data=this.state(),entry=data.libraries.find(e=>'file:'+e.id===input.libraryId);if(!entry||!FIXED_MAJORS.some(c=>c.category_code===input.major))fail('数据库或大类无效');entry.defaultMajor=input.major;this.save(data);return{ok:true}}
  file(entry) { if(!uuid(entry.id)||!uuid(entry.revision))fail('文件库标识无效');return path.join(this.root,'libraries',entry.id,'revisions',entry.revision+'.sqlite') }
  entry(id) { const entry=this.state().libraries.find(x=>'file:'+x.id===id);if(!entry)fail('文件库不存在',404);return entry }
  list() { return this.state().libraries.map(e=>{try { if(e.adapter==='lds-cn'){if(signature(e.origin)!==e.sourceSignature)fail('谱库文件已更新，请重新关联');return{...e,...lds.counts(this.root,e),detailIndex:require('./lds-detail-index.cjs').detailIndexInfo(this.root,e),libraryId:'file:'+e.id,status:'ready',readOnly:!!e.readOnly}}if(e.adapter==='unified-sqlite'){if(signature(e.origin)!==e.sourceSignature)fail('源库已更新，请重新关联以登记新修订');return{...e,libraryId:'file:'+e.id,status:'ready',readOnly:true}}const file=this.file(e);if(digest(file)!==e.sha256)fail('工作修订校验失败');const meta=inspectFile(file);return{...e,libraryId:'file:'+e.id,adapter:'sqlite',status:'ready',total:meta.total,trashed:meta.trashed,displayFields:meta.displayFields} }catch(error){return{...e,libraryId:'file:'+e.id,adapter:'sqlite',status:'error',issue:error.message}}}) }
  open(id, revision) { const e=this.entry(id);if(e.adapter==='lds-cn'){const current=lds.revision(this.root,e);if(revision&&revision!==current)fail('工作区已更新，请刷新',409);return{...e,revision:current,readOnly:!!e.readOnly}}if(revision&&revision!==e.revision)fail('数据库修订已变化，请重新检查交付范围',409);if(e.adapter==='unified-sqlite'){if(signature(e.origin)!==e.sourceSignature)fail('源库已更新，请重新关联以登记新修订');return{...e,libraryId:'file:'+e.id,status:'ready',readOnly:true}}const file=this.file(e);if(digest(file)!==e.sha256)fail('文件库校验失败，保留原配置，请重新检查',409);return{entry:e,db:sqlite(file)} }
  checkFormat(input) {
    const directory=input.directory;
    try{
      const {source,metadata}=inspectSource(directory)
      return {directory:source,...metadata,status:'ready',validation:metadata.validation||{status:'passed',scope:'adapter',checkedAt:new Date().toISOString(),checks:[{label:'数据库格式及适配器读取',status:'passed',detail:'通过现有文件库适配器检查'}],warnings:[],note:'格式检查通过，可关联'}};
    }catch(error){return{directory,title:typeof directory==='string'?path.basename(directory,path.extname(directory)):'',status:'error',issue:error.message,validation:{status:'failed',checkedAt:new Date().toISOString(),checks:[{label:'数据库格式检查',status:'failed',detail:error.message}],warnings:[],note:'检查未通过，请根据具体问题处理后重试'}}}
  }
  scan(directory) {
    if(typeof directory!=='string'||!path.isAbsolute(directory))fail('请输入服务器绝对目录')
    const real=fs.realpathSync(directory), entries=fs.statSync(real).isDirectory()?fs.readdirSync(real,{withFileTypes:true}):[], found=[]
    const candidates=[...(fs.statSync(real).isFile()?[real]:entries.filter(e=>e.isFile()&&/\.sqlite$/i.test(e.name)).map(e=>path.join(real,e.name))),path.join(real,'library.sqlite'),...entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()).slice(0,1000).map(e=>path.join(real,e.name,'library.sqlite'))]
    for (const entry of entries.filter(e => e.isDirectory() && uuid(e.name)).slice(0,1000)) {
      const folder = path.join(real,entry.name)
      for (const file of fs.readdirSync(folder,{withFileTypes:true})) {
        if (file.isFile() && /\.sqlite$/i.test(file.name)) candidates.push(path.join(folder,file.name))
      }
    }
    for(const file of [...new Set(candidates)])if(fs.existsSync(file)&&fs.statSync(file).isFile())found.push(this.checkFormat({directory:file}))
    return found
  }
  createImportedLibrary(input) {
    const { id, hash, title, records, uploadRoot } = input
    if (!uuid(id) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) ||
        typeof title !== 'string' || !title.trim() || title.length > 120) fail('新库名称或导入批次无效')
    if (!Array.isArray(records) || !records.length || records.length > 20000) fail('每批导入1–20000条')
    const name = title.trim()
    const data = this.state()
    const previous = data.libraries.find(entry => entry.id === id)
    if (previous) {
      if (previous.title !== name || previous.importHash !== hash) fail('此导入编号已用于其他新库',409)
      return {libraryId:'file:'+id,title:name,origin:previous.origin,total:lds.counts(this.root,previous).total}
    }
    if (data.libraries.some(entry => entry.title === name)) fail('同名数据库已存在，请使用其他名称',409)
    const folder = path.join(uploadRoot, id), origin = path.join(folder, 'library.sqlite')
    fs.mkdirSync(folder, { recursive:true, mode:0o700 })
    if (!fs.existsSync(origin)) {
      const temp = origin + '.' + crypto.randomUUID() + '.tmp'
      try {
        const db = sqlite(temp, false)
        try { db.exec(fs.readFileSync(path.join(__dirname,'lds-empty.sql'),'utf8')) } finally { db.close() }
        fs.renameSync(temp,origin)
      } finally { if(fs.existsSync(temp))fs.unlinkSync(temp) }
    }
    const { validation: _validation, ...metadata } = lds.inspectLDS(origin)
    const entry = { ...metadata, id, title:name, origin, importHash:hash, registeredAt:new Date().toISOString() }
    lds.initializeMembership(this.root,entry)
    const result = lds.mutate(this.root,entry,{action:'import',hash,records,revision:lds.revision(this.root,entry),actor:input.actor})
    entry.revision = result.revision
    data.libraries.push(entry)
    this.save(data)
    return {libraryId:'file:'+id,title:name,origin,total:result.total,imported:result.changed}
  }
  registerInput(input){return this.register(input.directory,input.libraryId)}
  register(directory, expectedId) {
    const {source,metadata}=inspectSource(directory)
    const data=this.state()
    if(['unified-sqlite','lds-cn'].includes(metadata.adapter)){
      const old=expectedId?data.libraries.find(e=>'file:'+e.id===expectedId):data.libraries.find(e=>e.origin===source)
      if(expectedId&&!old)fail('重新关联目标不存在',404)
      if(old?.managedSourceArchive)fail('自动更新谱库由服务器维护',403)
      if(old&&!expectedId)fail('此库已关联，请使用重新关联',409)
      const {validation, ...sourceMetadata}=metadata
      const id=old?.id||crypto.randomUUID(),entry={...sourceMetadata,readOnly:metadata.readOnly || !!old?.readOnly,defaultMajor:old?.defaultMajor,id,revision:crypto.randomUUID(),origin:source,registeredAt:new Date().toISOString()}
      if (old?.displayTitle) {
        entry.displayTitle = old.displayTitle
        entry.title = old.displayTitle
      }
      if(old?.adapter==='lds-cn')lds.checkRelink(this.root,old,entry)
      if(old)data.libraries[data.libraries.indexOf(old)]=entry;else data.libraries.push(entry)
      if(entry.adapter==='lds-cn'){
        if (entry.total >= 100000) require('./lds-detail-index.cjs').buildDetailIndex(this.root, entry)
        lds.initializeMembership(this.root,entry);entry.revision=lds.revision(this.root,entry)}
      this.save(data)
      if(entry.adapter==='lds-cn')require('./lds-detail-index.cjs').pruneDetailIndexes(this.root,entry,old)
      return{...entry,libraryId:'file:'+id}
    }
    const before=digest(source),meta=metadata
    if(expectedId&&expectedId!=='file:'+meta.libraryId)fail('重新关联的文件属于另一个数据库',409)
    const old=data.libraries.find(e=>e.id===meta.libraryId)
    if(old&&!expectedId)fail('此库已注册，请使用重新关联；旧修订保持可用',409)
    const entry={readOnly:!!old?.readOnly,defaultMajor:old?.defaultMajor,id:meta.libraryId,title:meta.title,revision:crypto.randomUUID(),origin:path.dirname(source),registeredAt:new Date().toISOString()}
    const target=this.file(entry);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL)
    if(digest(source)!==before||digest(target)!==before){fs.unlinkSync(target);fail('注册期间源文件变化，请重试',409)}
    entry.sha256=before
    if(old)data.libraries[data.libraries.indexOf(old)]=entry;else data.libraries.push(entry)
    this.save(data);return{...entry,libraryId:'file:'+entry.id}
  }
  *records(input) {
    const entry=this.entry(input.libraryId)
    if(entry.adapter==='lds-cn'){yield* lds.records(this.root,entry,input);return}
    if(entry.adapter==='unified-sqlite'){
      if(input.revision&&input.revision!==entry.revision||signature(entry.origin)!==entry.sourceSignature)fail('源库修订已变化，请重新关联',409)
      yield* unifiedRecords(entry.origin,{...input,defaultMajor:entry.defaultMajor})
      if(signature(entry.origin)!==entry.sourceSignature)fail('生成期间源文件变化，本次交付已取消',409)
    }else for(const row of this.rows(input,true).rows)yield row.record
  }
  categories(input) {
    const entry=this.entry(input.libraryId)
    if(entry.adapter==='lds-cn')return lds.categories(this.root,entry,input)
    if(entry.adapter==='unified-sqlite'){if(signature(entry.origin)!==entry.sourceSignature)fail('源库已变化，请重新关联',409);return unifiedCategories(entry.origin,{defaultMajor:entry.defaultMajor})}
    const {db}=this.open(input.libraryId)
    try{
      const {classificationTree}=require('../../src/shared/deliveryClassification.mjs'),records=db.prepare('SELECT payload FROM records WHERE trashed=0').all().map(r=>classify(JSON.parse(r.payload),entry)),tree=classificationTree(records),counts={},remainders={},groupCounts={},catalog=new Map()
      const visit=nodes=>{for(const node of nodes){if(!node.key.startsWith('axis:'))counts[node.key]=node.count;visit(node.children)}};visit(tree);for(const k of Object.keys(counts))delete counts[k];for(const record of records){const by=new Map(record.classification.catalog.map(c=>[classificationKey(c),c])),unique=new Set();for(const item of record.classification.items){let c=by.get(item.key);while(c){unique.add(classificationKey(c));c=c.parent_code?by.get(JSON.stringify([c.namespace,c.parent_code])):null}}for(const k of unique)counts[k]=(counts[k]||0)+1}
      for(const record of records){for(const code of groupMemberships(record.classification.catalog,record.classification.items.map(i=>i.key)))groupCounts[code]=(groupCounts[code]||0)+1;for(const code of remainderMajors(record.classification.catalog,record.classification.items.map(i=>i.key)))remainders[code]=(remainders[code]||0)+1;for(const c of record.classification?.catalog||[])catalog.set(classificationKey(c),c)}
      return{catalog:[...catalog.values()],counts,remainders,groupCounts,total:records.length,pending:records.filter(r=>!r.classification?.items?.length).length}
    }finally{db.close()}
  }
  rows(input, all=false) {
    const entryInfo=this.entry(input.libraryId)
    if(entryInfo.adapter==='lds-cn')return lds.rows(this.root,entryInfo,input,all)
    if(entryInfo.adapter==='unified-sqlite'){
      if(input.revision&&input.revision!==entryInfo.revision||signature(entryInfo.origin)!==entryInfo.sourceSignature)fail('源库修订已变化，请重新关联',409)
      return{...unifiedRows(entryInfo.origin,{...input,defaultMajor:entryInfo.defaultMajor},all),entry:entryInfo}
    }
    const {entry,db}=this.open(input.libraryId,input.revision)
    try {
      let where='trashed=?',params=[input.trash===true?1:0]
      const advanced=nativeFileFilters(input);for(const clause of advanced.clauses)where+=' AND ('+clause+')';params.push(...advanced.params)
      const keyword=String(input.keyword||'').trim().toLowerCase();if(keyword.length>200)fail('查询文字过长')
      if(keyword){where+=" AND (instr(lower(coalesce(json_extract(payload,'$.compound.main_name'),'')),?)>0 OR instr(lower(coalesce(json_extract(payload,'$.compound.name_zh'),'')),?)>0 OR instr(lower(coalesce(json_extract(payload,'$.compound.name_en'),'')),?)>0 OR instr(lower(coalesce(json_extract(payload,'$.compound.cas'),'')),?)>0 OR instr(lower(coalesce(json_extract(payload,'$.compound.formula'),'')),?)>0)";params.push(...Array(5).fill(keyword))}
      const ids=input.compoundIds||[],classes=input.classIds||[]
      if(!Array.isArray(ids)||ids.length>20000||ids.some(x=>!Number.isSafeInteger(Number(x))||Number(x)<1)||!Array.isArray(classes)||classes.length>1000||classes.some(x=>!Number.isSafeInteger(Number(x))||Number(x)<1))fail('筛选编号无效')
      if(input.onlySelected){if(!ids.length)fail('请先勾选记录');where+=` AND ordinal IN (${ids.map(()=>'?').join(',')})`;params.push(...ids.map(Number))}
      if(classes.length){where+=` AND EXISTS(SELECT 1 FROM json_each(records.class_ids) j WHERE j.value IN (${classes.map(()=>'?').join(',')}))`;params.push(...classes.map(Number))}
      const page=Math.max(1,Math.trunc(Number(input.page)||1));let total,selected
      if(input.categoryKey){const matching=[];for(const r of db.prepare('SELECT * FROM records WHERE '+where+' ORDER BY ordinal').iterate(...params)){const record=classify(JSON.parse(r.payload),entry);if(matchesNavigation(record.classification,input.categoryKey))matching.push({id:r.ordinal,key:r.id,record})}total=matching.length;selected=input.countOnly?[]:all?matching:matching.slice((page-1)*50,page*50)}
      else{total=Number(db.prepare('SELECT COUNT(*) n FROM records WHERE '+where).get(...params).n);selected=input.countOnly?[]:db.prepare('SELECT * FROM records WHERE '+where+' ORDER BY ordinal'+(all?'':' LIMIT 50 OFFSET ?')).all(...params,...(all?[]:[(page-1)*50])).map(r=>({id:r.ordinal,key:r.id,record:classify(JSON.parse(r.payload),entry)}))}
      return{entry,total,page,categories:FIXED_CLASSIFICATION_CATALOG,classes:db.prepare('SELECT * FROM classes ORDER BY class_name').all(),rows:selected}

    }finally{db.close()}
  }
  updateCompound(input) {
    const entry=this.writableEntry(input.libraryId)
    if(entry.adapter==='lds-cn')return lds.mutate(this.root,entry,{...input,action:'update',record:{compound:input.compound}})
    if(entry.readOnly||entry.adapter==='unified-sqlite')fail('此数据源只读，不修改源文件',403)
    if(!input.revision||input.revision!==entry.revision)fail('文件库已变化，请重新打开详情后编辑',409)
    if(!Number.isSafeInteger(input.id)||input.id<1||!input.compound||typeof input.compound!=='object'||Array.isArray(input.compound))fail('记录信息无效')
    const allowed=['main_name','name_zh','name_en','cas','formula','molecular_mass','monoisotopic_mass'],patch={}
    if(Object.keys(input.compound).some(k=>!allowed.includes(k)))fail('仅支持编辑基本信息，不接受谱图或方法覆盖')
    for(const [key,value] of Object.entries(input.compound)){
      if(['molecular_mass','monoisotopic_mass'].includes(key)){if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0))fail('质量必须为非负有限数值');patch[key]=value}
      else{if(value!==null&&typeof value!=='string')fail('文本字段无效');const text=String(value??'').trim();if(text.length>(key==='formula'?1000:255)||key==='main_name'&&!text)fail('名称不能为空且文本不能超过字段长度');patch[key]=text||null}
    }
    const opened=this.open(input.libraryId,input.revision);opened.db.close()
    const data=this.state(),next={...entry,revision:crypto.randomUUID(),updatedAt:new Date().toISOString()},target=this.file(next)
    fs.copyFileSync(this.file(entry),target,fs.constants.COPYFILE_EXCL)
    let working
    try{
      working=sqlite(target,false);working.exec('BEGIN IMMEDIATE')
      const row=working.prepare('SELECT payload,trashed FROM records WHERE ordinal=?').get(input.id)
      if(!row||row.trashed)fail('记录不存在或已删除，请刷新',409)
      const record=JSON.parse(row.payload);record.compound={...record.compound,...patch}
      working.prepare('UPDATE records SET payload=? WHERE ordinal=?').run(JSON.stringify(record),input.id)
      working.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(next.revision);working.exec('COMMIT');working.close();working=null
      inspectFile(target);next.sha256=digest(target);data.libraries[data.libraries.findIndex(e=>e.id===entry.id)]=next;this.save(data)
      return{revision:next.revision,changed:1}
    }catch(e){if(working){try{working.exec('ROLLBACK')}catch{}working.close()}if(fs.existsSync(target))fs.unlinkSync(target);throw e}
  }
  backup(input){const entry=this.entry(input.libraryId);if(entry.adapter!=='lds-cn')fail('此库不支持备份管理工作区');return lds.backup(this.root,entry)}
  restore(input){const entry=this.writableEntry(input.libraryId);if(entry.adapter!=='lds-cn')fail('此库不支持恢复管理工作区');return lds.restore(this.root,entry,input)}
  mutate(input){if(input.action==='massbank-add'||String(input.hash).startsWith('massbank:'))fail('请使用 MassBank 待发布变更');const entry=this.writableEntry(input.libraryId);if(entry.adapter!=='lds-cn')fail('此库不支持编辑管理工作区');return lds.mutate(this.root,entry,input)}
  sourceCompare(input) { return require('./source-batch.cjs').compareBatch(this,input) }
  ensureSourceArchive(input) { return require('./source-archive.cjs').ensure(this,input) }
  archiveSourceBatch(input) { return require('./source-archive.cjs').archive(this,input) }
  sourceInspect(input) { return require('./source-batch.cjs').inspectBatch(this,input) }
  sourcePublish(input) { return require('./source-batch.cjs').publishBatch(this,input) }
  massbankCompare(input) {
    const entry = this.writableEntry(input.libraryId)
    if (entry.adapter !== 'lds-cn') fail('请选择支持谱图更新且可编辑的服务器文件库')
    if (!input.candidates.length) { this.open(input.libraryId); if (signature(entry.origin) !== entry.sourceSignature) fail('目标库已变化，请重新关联', 409); return { rows: [] } }
    const { rows, revision } = require('./massbank-match.cjs').compare(this.root, entry, input.candidates)
    return { rows, revision }
  }
  massbankPublish(input, validateSelection) {
    const entry = this.writableEntry(input.libraryId)
    if (entry.adapter !== 'lds-cn') fail('请选择支持谱图更新且可编辑的服务器文件库')
    const db = new (require('node:sqlite').DatabaseSync)(lds.workspace(this.root, entry), { readOnly: true })
    try {
      const receipt = db.prepare('SELECT ids FROM imports WHERE hash=?').get('massbank:' + input.hash)
      if (receipt) return { changed: 0, addedSpectra: 0, ids: JSON.parse(receipt.ids), duplicate: true, revision: lds.revision(this.root, entry) }
    } finally { db.close() }
    validateSelection?.()
    const { revision, operations } = require('./massbank-match.cjs').compare(this.root, entry, input.candidates, input.selected, undefined, undefined, input.confirmed)
    if (revision !== input.revision) fail('数据库已变化，请重新核对差异', 409)
    const result = lds.mutate(this.root, entry, { ...input, candidates: undefined, operations, action: 'massbank-add' })
    return { ...result, addedSpectra: operations.filter(o=>!o.sourceOnly).length, linkedSources:operations.filter(o=>o.sourceOnly).length }
  }
  peaks(input){
    const entry=this.entry(input.libraryId)
    if(entry.adapter!=='lds-cn')fail('此库没有按需谱峰接口')
    if(entry.managedSourceArchive){
      const result=this.rows({libraryId:input.libraryId,compoundIds:[Number(input.id)],onlySelected:true,details:true,includePeaks:true})
      const record=result.rows.find(row=>String(row.id)===String(input.id))?.record
      const spectrum=record?.spectra.find(item=>item.id===input.spectrumId)
      if(!spectrum)fail('谱图不属于此化合物',404)
      return spectrum.peaks
    }
    return lds.peaks(this.root,entry,input)
  }
  change(input) {
    if(this.entry(input.libraryId).adapter==='lds-cn')return this.mutate(input)
    if(this.entry(input.libraryId).readOnly)fail('此数据源只读，请导入为管理库后修改',403)
    const {entry,db}=this.open(input.libraryId,input.revision);db.close()
    if(!['delete','restore','purge'].includes(input.action)||!Array.isArray(input.ids)||!input.ids.length||input.ids.length>20000||new Set(input.ids).size!==input.ids.length||input.ids.some(x=>!Number.isSafeInteger(x)||x<1))fail('记录操作无效')
    const data=this.state(),next={...entry,revision:crypto.randomUUID(),updatedAt:new Date().toISOString()},target=this.file(next);fs.copyFileSync(this.file(entry),target,fs.constants.COPYFILE_EXCL)
    const working=sqlite(target,false)
    try{
      working.exec('BEGIN IMMEDIATE')
      for(const id of input.ids){const row=working.prepare('SELECT trashed FROM records WHERE ordinal=?').get(id);if(!row||(input.action==='delete'?row.trashed!==0:row.trashed!==1))fail('记录状态已变化，请刷新',409)}
      for(const id of input.ids)if(input.action==='purge')working.prepare('DELETE FROM records WHERE ordinal=?').run(id);else working.prepare('UPDATE records SET trashed=? WHERE ordinal=?').run(input.action==='delete'?1:0,id)
      working.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(next.revision);working.exec('COMMIT')
    }catch(e){try{working.exec('ROLLBACK')}catch{}throw e}finally{working.close()}
    inspectFile(target);next.sha256=digest(target);data.libraries[data.libraries.findIndex(e=>e.id===entry.id)]=next;this.save(data)
    return{revision:next.revision,changed:input.ids.length}
  }
}
function projectRecord(raw, policy, id, sourceKey, displayName, stableId, options = {}) {
  if (options.normalizeLiquid !== false) raw = { ...raw, lc: (raw.lc || []).map(require('./liquid-normalization.cjs').normalizeLiquid) }
  const record={id,stableId,sourceKey,sourceTitle:displayName,compound:clean(raw.compound,policy.fields.compound),ms:[],lc:[],spectra:[],chromatograms:[],experiments:[],sources:[],checks:[]}
  const classification=projectClassification(raw.classification,policy.fields.classification, {subdivide:policy.features.classificationSubdivide,sourceLabelDepth:policy.classification?.sourceLabelDepth,navigationDepth:policy.classification?.navigationDepth,tagDepth:policy.classification?.tagDepth});if(classification)record.classification=classification
  const methodMap=new Map((raw.ms||[]).map(m=>[m.id,hash(id+':ms:'+m.id).slice(0,24)]))
  if(policy.features.spectra){record.ms=(raw.ms||[]).map(m=>({id:methodMap.get(m.id),...clean(m,policy.fields.ms)}));record.spectra=(raw.spectra||[]).map(s=>({id:hash(id+':sp:'+s.id).slice(0,24),...clean(s,policy.fields.spectrum),methodIds:(s.methodIds||[]).filter(x=>methodMap.has(x)).map(x=>methodMap.get(x))}))}
  if(policy.features.lc)record.lc=(raw.lc||[]).map(m=>{const out={id:hash(id+':lc:'+m.id).slice(0,24),...clean(m,policy.fields.lc)};if(policy.fields.lc.includes('gradient'))out.gradient=(m.gradient||[]).map(r=>clean(r,['step_order','time','time_unit','percentage_A','percentage_B','flow_rate','flow_rate_unit']));if(policy.fields.lc.includes('flow_rate')&&m.flow_rate&&typeof m.flow_rate==='object')out.flow_rate=Array.isArray(m.flow_rate.program)?{program:m.flow_rate.program.map(r=>pick(r,['value','unit','unit_source','time','time_unit']))}:pick(m.flow_rate,['value','unit','unit_source']);if(policy.fields.lc.includes('retention_times'))out.retention_times=(m.retention_times||[]).map(r=>({...pick(r,['id','value','unit','unit_source','peak_label']),methodIds:r.methodIds||[]}));if(out.retention_times)out.retention_times=out.retention_times.map(r=>({...r,methodIds:policy.features.spectra?(r.methodIds||[]).filter(x=>methodMap.has(x)).map(x=>methodMap.get(x)):[]}));return out})
  if(policy.features.chromatograms)record.chromatograms=(raw.chromatograms||[]).map(m=>({id:hash(id+':ch:'+m.id).slice(0,24),...clean(m,policy.fields.chromatogram)}))
  if(policy.features.experiments)record.experiments=(raw.experiments||[]).map(m=>{const out={id:hash(id+':ex:'+m.id).slice(0,24),...clean(m,policy.fields.experiment)};for(const key of ['measurement','limit','ratio'])if(policy.fields.experiment.includes(key)&&m[key]!=null)out[key]=({measurement,limit,ratio})[key](m[key]);return out})
  record.sources=(raw.sources||[]).map(s=>clean(s,policy.fields.source))
  return record
}
class LibrarySnapshotBuilder extends SnapshotBuilder {
  constructor(connect,directory,engine,catalog){super(connect,directory,engine);this.catalog=catalog}
  async libraries(){const files=this.catalog.list().filter(e=>e.status==='ready').map(e=>({id:e.libraryId,title:e.title,schema_version:1,compound_count:e.total,adapter:'sqlite',revision:e.revision}));try{return[...await super.libraries(),...files]}catch(e){if(files.length)return files;throw e}}
  async candidates(input){if(!String(input.libraryId).startsWith('file:'))return super.candidates(input);const result=this.catalog.rows(input);return{...result,entry:undefined,rows:result.rows.map(r=>({id:r.id,...r.record.compound})),revision:result.entry.revision}}
  analyse(record,policy){
    if(!policy.features.checks)return record
    for(const [type,rows] of [['chromatogram',record.chromatograms],['experiment',record.experiments]])for(const row of rows){
      if(row.status!=='completed'){record.checks.push({id:row.id,type,incomplete:true,issue:'记录尚未完成，不参与正式检查'});continue}
      try{
        if(!this.engine)throw Error('检查引擎不可用')
        const result=type==='chromatogram'?{id:row.id,sample:'交付记录',compound:record.compound.main_name,trace:{timeUnit:row.time_unit,points:row.points||[]}}:{id:row.id,sample:'交付记录',compound:record.compound.main_name,measurement:row.measurement,limit:row.limit,ratio:row.ratio}
        if(type==='experiment'&&row.record_type==='reference')throw Error('参考记录不作为样品检查')
        const normalized=this.engine.normalizeDetectionPackage({formatVersion:1,batchName:'文件库交付检查',methodName:'文件库检查',ruleVersion:'默认规则',results:[result]}),checked=this.engine.analyseRow(normalized.results[0])
        record.checks.push({id:row.id,type,engineVersion:this.engine.ENGINE_VERSION,...pick(checked,['abnormal','incomplete']),peak:checked.peak,ratio:checked.ratio,limit:checked.limit,labels:checked.labels})
      }catch{record.checks.push({id:row.id,type,incomplete:true,issue:'数据或检查条件不完整，不能参与正式判断'})}
    }
    return record
  }
  async build(input,progress=()=>{}){
    if(!input.selections?.some(s=>String(s.libraryId).startsWith('file:')))return super.build(input,progress)
    const policy=normalizePolicy(input.policy);if(!input.selections.length||input.selections.length>100||new Set(input.selections.map(s=>s.libraryId)).size!==input.selections.length)fail('请选择不重复的1–100个数据库')
    let serializedBytes=0,maxMethods=0;const id=crypto.randomUUID(),tmp=path.join(this.directory,'.building-'+id),target=path.join(this.directory,id),index=[],origins=[],contents={compounds:0,ms:0,lc:0,spectra:0,chromatograms:0,experiments:0};fs.mkdirSync(tmp,{mode:0o700});const children=[]
    try{
      for(const s of input.selections){
        let rows,sourceRevision,defaultTitle
        if(String(s.libraryId).startsWith('file:')){const entry=this.catalog.entry(s.libraryId);rows=this.catalog.records({...s,policy});sourceRevision=entry.adapter==='lds-cn'?lds.revision(this.catalog.root,entry):entry.revision;defaultTitle=entry.title}
        else{const child=await super.build({...input,selections:[s]});children.push(child);rows=this.index(child).map(r=>this.record(child,r.id,r));defaultTitle=child.title}
        const displayName=text(s.displayName||defaultTitle,'数据库显示名称');if(origins.some(o=>o.displayName===displayName))fail('数据库显示名称重复')
        const sourceKey=hash(id+':library:'+s.libraryId).slice(0,24)
        let sourceCount=0
        for(const raw of rows){maxMethods=Math.max(maxMethods,raw.ms?.length||0);sourceCount++;const stableId=String(s.libraryId).startsWith('file:')?hash(s.libraryId+':'+raw.id):(raw.stableId||hash(s.libraryId+':'+raw.id)),recordId=hash(id+':'+stableId).slice(0,32),record=projectRecord(raw,policy,recordId,sourceKey,displayName,stableId),file=JSON.stringify(this.analyse(record,policy));if((serializedBytes+=Buffer.byteLength(file))>200*1024*1024)fail('已选内容超过当前单包安全体积，请减少范围或取消谱峰字段');fs.writeFileSync(path.join(tmp,recordId+'.json'),file,{mode:0o600});index.push({id:recordId,stableId,sourceKey,sourceTitle:displayName,...(record.classification?{classification:record.classification}:{}),compound:Object.fromEntries(Object.entries(record.compound).filter(([k])=>!k.endsWith('base64'))),sha256:hash(file),abnormal:record.checks.some(c=>c.abnormal),incomplete:record.checks.some(c=>c.incomplete)});for(const k of ['ms','lc','spectra','chromatograms','experiments'])contents[k]+=record[k].length;contents.compounds++;progress(contents.compounds);if(contents.compounds%25===0)await new Promise(resolve=>setImmediate(resolve))}
        origins.push({sourceKey,libraryId:s.libraryId,revision:sourceRevision,displayName,count:sourceCount,selection:{...s}})
      }
      if(!index.length)fail('所选条件没有可交付的化合物')
      const manifest={layout:{maxMethods},id,title:text(input.title,'交付名称'),version:text(input.version,'修订',64),createdAt:new Date().toISOString(),policy,fieldLabels:Object.fromEntries(Object.entries(policy.fields).map(([g,keys])=>[g,Object.fromEntries(keys.map(k=>[k,fields[g][k]]))])),sources:origins.map(({sourceKey,displayName,count})=>({sourceKey,displayName,count})),contents,total:index.length,indexHash:hash(JSON.stringify(index))}
      fs.writeFileSync(path.join(tmp,'index.json'),JSON.stringify(index),{mode:0o600});fs.writeFileSync(path.join(tmp,'manifest.json'),JSON.stringify(manifest),{mode:0o600});fs.renameSync(tmp,target);return{...manifest,origins}
    }catch(e){fs.rmSync(tmp,{recursive:true,force:true});throw e}finally{for(const c of children)fs.rmSync(path.join(this.directory,c.id),{recursive:true})}
  }
}
module.exports={FileLibraries,LibrarySnapshotBuilder,createLibrary,inspectFile,projectRecord}
