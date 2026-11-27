const {remainderMajor,remainderMajors}=require('../../src/shared/categoryNavigation.mjs')
const {majorGroup,groupMemberships}=require('../../src/shared/majorGroups.mjs')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { categoryKey, recordKey, localCatalog, classificationPlan, classificationWhere, classificationMembership } = require('../../src/shared/classification.mjs')
const { validateCatalog } = require('./classification-validation.cjs')
const {FIXED_MAJORS,FIXED_CLASSIFICATION_CATALOG,isMajor,majorKey,sourceCategoryPath}=require('../../src/shared/fixedMajors.mjs')
const fail = message => { throw Object.assign(new Error(message), { status: 400 }) }
class ClassificationService {
  constructor(directory, connect) {
    this.file = path.join(directory, 'classification.json'); this.connect = connect; this.tail = Promise.resolve()
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, revision: 0, initialized: false, roles: {}, categories: [], assignments: {}, mappings: [], events: [] }
  }
  async mutate(actor, action, apply, authenticate = () => {}) {
    const run = this.tail.then(async () => {
      authenticate(); const next = structuredClone(this.data); await apply(next); authenticate()
      next.revision++; next.events.push({ id: crypto.randomUUID(), actor, action, at: new Date().toISOString() }); next.events = next.events.slice(-1000)
      const temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temp, this.file); this.data = next
      return { ok: true, revision: next.revision }
    }); this.tail = run.catch(() => {}); return run
  }
  async guarded(state, actor, action, apply, authenticate) {
    return this.mutate(actor, action, d => { if (d.revision !== state.revision) fail('分类配置已更新，请刷新后重试'); return apply(d) }, authenticate)
  }
  async libraries() {
    const c = await this.connect()
    try {
      const [rows] = await c.query('SELECT id,database_name,title,file_name,compound_count FROM mspec_lib2_catalog.libraries ORDER BY published_at,id')
      const result = []
      for (const library of rows) {
        if (!/^mspec_lib2_shared_[a-f0-9]{20}$/.test(library.database_name)) fail('库标识无效')
        let categories = []
        try { [categories] = await c.query('SELECT id,namespace,category_code,category_name,parent_code,axis FROM `' + library.database_name + '`.taxonomy_categories ORDER BY id') }
        catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e }
        result.push({ ...library, categories })
      }
      return result
    } finally { await c.end() }
  }
  catalog(libraries, includeDisabled=false) {
    const catalog = new Map()
    for (const library of libraries) if (this.data.roles[library.database_name] === 'local') for (const c of localCatalog(library.categories)) {
      const { id, ...definition } = c, key = categoryKey(c), prior = catalog.get(key)
      if (prior && (prior.category_name !== c.category_name || (prior.parent_code || null) !== (c.parent_code || null))) fail('本地分类目录冲突，请先核对目录命名空间')
      catalog.set(key, definition)
    }
    for (const c of this.data.categories) catalog.set(categoryKey(c), c)
    for(const c of FIXED_CLASSIFICATION_CATALOG)catalog.set(categoryKey(c),{...c})
    const values=[...catalog.values()].sort((a,b) => (a.sort_order || 0) - (b.sort_order || 0))
    if(includeDisabled)return values
    return values.filter(c=>{let node=c;const seen=new Set();while(node){const key=categoryKey(node);if(seen.has(key))fail('分类目录存在循环');seen.add(key);if(node.status==='disabled')return false;node=node.parent_code?catalog.get(JSON.stringify([node.namespace,node.parent_code])):null}return true})
  }
  async state(actor = 'system', authenticate) {
    const libraries = await this.libraries()
    if (!this.data.initialized) await this.mutate(actor, 'initialize-classification', d => {
      if (d.initialized) return
      // Only the previously established local catalogue is migrated automatically.
      // Arbitrary application-axis project categories are not proof of a local scheme.
      for (const l of libraries) d.roles[l.database_name] = l.categories.some(c => c.namespace === 'unified-consolidated-v2') ? 'local' : 'project'
      d.initialized = true
    }, authenticate)
    return { ...structuredClone(this.data), fixedMajors:true, libraries, catalog: this.catalog(libraries),allCatalog:this.catalog(libraries,true), capabilities: { ai: false, manualAssignment: true, explicitMapping: true, crossRecordIdentityMerge: false } }
  }
  async plans(key, databases, actor, authenticate) {
    const state = await this.state(actor, authenticate)
    if (!Array.isArray(databases) || databases.length > 1000) fail('库范围无效')
    if(key!=='@pending'&&!remainderMajor(key)&&!majorGroup(key)&&!state.catalog.some(c=>categoryKey(c)===key))return {revision:state.revision,plans:state.libraries.filter(l=>databases.includes(l.database_name)).map(l=>({database:l.database_name,pending:false,nativeCategoryIds:[],ruleCategoryIds:[],overrideIds:[],includeIds:[]}))}
    return { revision: state.revision, plans: state.libraries.filter(l => databases.includes(l.database_name)).map(l => ({ database: l.database_name, ...classificationPlan(state, l, state.catalog, key) })) }
  }
  async counts(databases, actor, authenticate) {
    if(!Array.isArray(databases)||databases.length>1000)fail('库范围无效')
    const state=await this.state(actor,authenticate),catalog=new Map(state.catalog.map(c=>[categoryKey(c),c])),result=[],c=await this.connect()
    try{
      for(const library of state.libraries.filter(l=>databases.includes(l.database_name))){
        const prefix='`'+library.database_name+'`.',active='COALESCE(c.is_delete,0)=0 AND COALESCE(c.is_in_trash,0)=0'
        const [[summary]]=await c.query('SELECT COUNT(*) total FROM '+prefix+'compounds c WHERE '+active)
        const byRecord=new Map(),byCategory=new Map(library.categories.map(c=>[String(c.id),categoryKey(c)]))
        if(library.categories.length){const [links]=await c.query('SELECT ct.compound_id,ct.category_id FROM '+prefix+'compound_taxonomy ct JOIN '+prefix+'compounds c ON c.id=ct.compound_id WHERE '+active);for(const link of links){const id=String(link.compound_id);if(!byRecord.has(id))byRecord.set(id,[]);const key=byCategory.get(String(link.category_id));if(key)byRecord.get(id).push(key)}}
        const overrides=Object.values(state.assignments).filter(a=>a.database===library.database_name).map(a=>a.id)
        for(let start=0;start<overrides.length;start+=500){const batch=overrides.slice(start,start+500),[rows]=await c.query('SELECT c.id FROM '+prefix+`compounds c WHERE ${active} AND c.id IN (${batch.map(()=>'?').join(',')})`,batch);for(const row of rows)if(!byRecord.has(String(row.id)))byRecord.set(String(row.id),[])}
        const counts={},remainders={},groupCounts={};let classified=0
        for(const [id,keys]of byRecord){const memberships=classificationMembership(state,library,keys,id),unique=new Set();for(const item of memberships){let node=catalog.get(categoryKey(item));while(node){unique.add(categoryKey(node));node=node.parent_code?catalog.get(JSON.stringify([node.namespace,node.parent_code])):null}}for(const code of remainderMajors(state.catalog,memberships.map(categoryKey)))remainders[code]=(remainders[code]||0)+1;for(const code of groupMemberships(state.catalog,[...unique]))groupCounts[code]=(groupCounts[code]||0)+1;if(unique.size)classified++;for(const key of unique)counts[key]=(counts[key]||0)+1}
        if(state.fixedMajors){const missing=Number(summary.total)-byRecord.size;const fallback=classificationMembership(state,library,[],'');for(const code of groupMemberships(state.catalog,fallback.map(categoryKey)))groupCounts[code]=(groupCounts[code]||0)+missing;for(const item of fallback)counts[categoryKey(item)]=(counts[categoryKey(item)]||0)+missing;for(const code of remainderMajors(state.catalog,fallback.map(categoryKey)))remainders[code]=(remainders[code]||0)+missing}
        result.push({database:library.database_name,total:Number(summary.total),pending:state.fixedMajors?0:Number(summary.total)-classified,counts,remainders,groupCounts})
      }
    }finally{await c.end()}
    return{revision:state.revision,catalog:state.catalog,libraries:result}
  }
  async saveDefault(input,actor,authenticate){const state=await this.state(actor,authenticate);if(!state.libraries.some(l=>l.database_name===input.database)||!FIXED_MAJORS.some(c=>c.category_code===input.major))fail('数据库或默认大类无效');return this.guarded(state,actor,'set-default-major',d=>{d.defaults||={};d.defaults[input.database]=input.major},authenticate)}
  async saveRole(input, actor, authenticate) {
    const state = await this.state(actor, authenticate)
    if (!state.libraries.some(l => l.database_name === input.database) || !['local', 'project'].includes(input.role)) fail('库用途设置无效')
    if (input.role === 'project') {
      const library = state.libraries.find(l => l.database_name === input.database)
      const removed = new Set(localCatalog(library.categories).map(categoryKey))
      const available = new Set([...state.categories, ...state.libraries.filter(l => l.database_name !== input.database && state.roles[l.database_name] === 'local').flatMap(l => localCatalog(l.categories))].map(categoryKey))
      if (state.categories.some(c => c.parent_code && removed.has(JSON.stringify([c.namespace,c.parent_code])) && !available.has(JSON.stringify([c.namespace,c.parent_code]))) || state.mappings.some(m => m.targets.some(k => removed.has(k) && !available.has(k))) || Object.values(state.assignments).some(a => a.categories.some(k => removed.has(k) && !available.has(k)))) fail('该库目录仍被本地分类关联使用，请先迁移关联再改为项目库')
    }
    return this.guarded(state, actor, 'set-library-role', d => { d.roles[input.database] = input.role }, authenticate)
  }
  async saveCategory(input, actor, authenticate) {
    const state = await this.state(actor, authenticate)
    const name = String(input.name || '').trim(); if (!name || name.length > 255) fail('请填写有效类别名称')
    const parent = input.parentKey ? state.catalog.find(c => categoryKey(c) === input.parentKey) : null
    if (input.parentKey && !parent) fail('父类别不存在')
    const existing = input.key ? state.catalog.find(c => categoryKey(c) === input.key) : null
    if (input.key && !existing) fail('类别不存在，请刷新')
    if(existing&&isMajor(existing))fail('预设大类固定，不支持重命名或调整层级')
    if(parent&&!isMajor(parent))fail('导航最多两级，请选择固定大类；更细内容保留为标签')
    if(!existing&&!parent)fail('请选择预设大类或其细类作为父类别')
    const axis = parent?.axis || existing?.axis || input.axis || 'application'
    if (!['application','origin','chemical_structure','biological_role'].includes(axis)) fail('请选择有效分类维度')
    const category = { namespace: existing?.namespace || parent?.namespace || 'manual-local-v1', category_code: existing?.category_code || crypto.randomUUID(), category_name: name, parent_code: parent?.category_code || null, axis, sort_order: Number.isSafeInteger(input.sort_order) ? input.sort_order : existing?.sort_order || 0 }
    if (state.catalog.some(c => categoryKey(c) !== categoryKey(category) && c.category_name === name && c.namespace === category.namespace && (c.parent_code || null) === category.parent_code)) fail('同级已有同名类别')
    const next = [...state.catalog.filter(c => categoryKey(c) !== categoryKey(category)), category]
    validateCatalog(next)
    return this.guarded(state, actor, existing ? 'update-local-category' : 'add-local-category', d => { d.categories = [...d.categories.filter(c => categoryKey(c) !== categoryKey(category)), category] }, authenticate)
  }
  async setCategoryStatus(input,actor,authenticate){
    const state=await this.state(actor,authenticate),existing=state.allCatalog.find(c=>categoryKey(c)===input.key)
    if(existing&&isMajor(existing))fail('预设大类不能停用')
    if(!existing||!['active','disabled'].includes(input.status))fail('类别状态无效')
    if(input.status==='active'&&existing.parent_code&&!state.catalog.some(c=>c.namespace===existing.namespace&&c.category_code===existing.parent_code))fail('请先启用父类别')
    return this.guarded(state,actor,input.status==='disabled'?'disable-local-category':'enable-local-category',d=>{d.categories=[...d.categories.filter(c=>categoryKey(c)!==input.key),{...existing,status:input.status}]},authenticate)
  }
  async unlock(input, actor, authenticate) {
    const state = await this.state(actor, authenticate)
    if (!Array.isArray(input.records) || !input.records.length || input.records.length > 500) fail('每次请选择1–500条记录')
    if (input.records.some(r => !state.libraries.some(l => l.database_name === r.database) || !/^\d{1,20}$/.test(String(r.id)))) fail('所选记录范围无效')
    return this.guarded(state, actor, 'unlock-local-classification', d => { for (const r of input.records) delete d.assignments[recordKey(r.database, String(BigInt(String(r.id))))] }, authenticate)
  }
  async snapshotRows(c, source, ids, state) {
    const library = state.libraries.find(l => l.database_name === source.database_name)
    if (!library) fail('数据源尚未登记到分类管理')
    const result = new Map()
    if (!ids.length) return result
    let links = []
    if (library.categories.length) [links] = await c.query(`SELECT compound_id,category_id,evidence FROM compound_taxonomy WHERE compound_id IN (${ids.map(() => '?').join(',')})`, ids)
    const labels = new Map(library.categories.map(cat => [String(cat.id), cat]))
    for (const id of ids) {
      const own = links.filter(l => String(l.compound_id) === String(id)), sourceKeys = own.map(l => labels.get(String(l.category_id))).filter(Boolean).map(categoryKey)
      const items = classificationMembership(state, library, sourceKeys, String(id)).map(cat => {
        const evidence = cat.evidence || []
        let status = evidence.some(e => e.kind === 'manual-assignment') ? 'confirmed' : 'unreviewed'
        const native = own.filter(l => { const c = labels.get(String(l.category_id)); return c && categoryKey(c) === categoryKey(cat) })
        for (const link of native) { let value = link.evidence; if (typeof value === 'string') { try { value = JSON.parse(value) } catch { value = [] } }; const values = Array.isArray(value) ? value : [value]; const observed = values.find(v => v?.review_status)?.review_status; if (observed && status !== 'confirmed') status = observed }
        return { key: categoryKey(cat), review_status: status }
      })
      const original=library.categories.filter(c=>sourceKeys.includes(categoryKey(c)))
      result.set(String(id), { scheme:'fixed-majors-v1',catalog: state.catalog, items,source_labels:original.map(c=>c.category_name),source_paths:original.map(c=>sourceCategoryPath(library.categories,c)) })
    }
    return result
  }
  async saveMapping(input, actor, authenticate) {
    const state = await this.state(actor, authenticate), library = state.libraries.find(l => l.database_name === input.database)
    if (!library || !library.categories.some(c => categoryKey(c) === input.sourceKey)) fail('项目来源类别不存在')
    if (!Array.isArray(input.targets) || !input.targets.length || input.targets.some(k => !state.catalog.some(c => categoryKey(c) === k))) fail('请选择明确的本地目标类别')
    const prior = state.mappings.find(m => m.database === input.database && m.sourceKey === input.sourceKey)
    const rule = { id: prior?.id || crypto.randomUUID(), database: input.database, sourceKey: input.sourceKey, targets: [...new Set(input.targets)], enabled: input.enabled !== false, actor, at: new Date().toISOString(), evidence: 'administrator-configured-mapping' }
    return this.guarded(state, actor, 'save-explicit-mapping', d => { const old = d.mappings.findIndex(m => m.id === rule.id); if (old >= 0) d.mappings[old] = rule; else d.mappings.push(rule) }, authenticate)
  }
  async assign(input, actor, authenticate) {
    const state = await this.state(actor, authenticate)
    if (!Array.isArray(input.records) || !input.records.length || input.records.length > 500) fail('每次请选择1–500条记录')
    if (!Array.isArray(input.categories) || input.categories.some(k => !state.catalog.some(c => categoryKey(c) === k))) fail('本地类别无效')
    if (!['add', 'replace'].includes(input.mode)) fail('请选择追加或替换本地分类')
    const changes = [], c = await this.connect()
    try {
      for (let ref of input.records) {
        const library = state.libraries.find(l => l.database_name === ref.database)
        if (!library || !/^\d{1,20}$/.test(String(ref.id))) fail('所选记录范围无效')
        ref = { ...ref, id: String(BigInt(String(ref.id))) }
        await c.query('USE `' + library.database_name + '`')
        const [found] = await c.query('SELECT id FROM `' + library.database_name + '`.compounds WHERE id=? AND COALESCE(is_delete,0)=0 AND COALESCE(is_in_trash,0)=0', [String(ref.id)])
        if (found.length !== 1) fail('所选化合物不存在或已删除，请刷新后重选')
        const inherited = []
        if (input.mode === 'add') for (const cat of state.catalog) {
          const f = classificationWhere(classificationPlan(state, library, state.catalog, categoryKey(cat)))
          const [matches] = await c.query('SELECT c.id FROM `' + library.database_name + '`.compounds c WHERE c.id=? AND (' + f.where + ')', [String(ref.id), ...f.params])
          if (matches.length) inherited.push(categoryKey(cat))
        }
        changes.push({ database: ref.database, id: String(ref.id), categories: [...new Set([...inherited, ...input.categories])], locked: true, evidence: 'manual-assignment', actor, at: new Date().toISOString() })
      }
    } finally { await c.end() }
    return this.mutate(actor, 'batch-local-classification', d => {
      if (d.revision !== state.revision) fail('分类配置已更新，请刷新后重试')
      for (const a of changes) d.assignments[recordKey(a.database, a.id)] = a
      const counts = {}; for (const a of Object.values(d.assignments)) counts[a.database] = (counts[a.database] || 0) + 1
      if (Object.values(counts).some(n => n > 20000)) fail('当前版本每库最多保存20000条人工锁定记录，请使用项目类别映射进行批量归类')
    }, authenticate)
  }
}
module.exports = { ClassificationService }
