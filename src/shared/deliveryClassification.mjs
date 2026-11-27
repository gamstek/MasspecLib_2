import {MAJOR_GROUPS,majorGroup,majorGroupKey,groupMemberships} from './majorGroups.mjs'
import {subdivideMajorValue} from './fixedMajors.mjs'
// Portable, allow-listed classification data. No source paths, credentials or raw evidence.
export const classificationAxes = { application: '用途分类', chemical_structure: '结构分类', origin: '生物来源', biological_role: '生物作用' }
export const classificationKey = c => JSON.stringify([c.namespace, c.category_code])
export function classificationNavigationEnabled(policy) { return policy?.features?.classification === true || policy?.features?.classification === undefined && !!policy?.fields?.classification?.includes('categories') }
export function classificationCatalog(rows = [], namespace = 'unified-consolidated-v2') {
  if (!Array.isArray(rows)) throw Error('分类字典必须为数组')
  const byId = new Map(rows.map(c => [String(c.category_id ?? c.id), c]))
  const catalog = rows.filter(c => classificationAxes[c.axis] && !['disabled', 'retired', 'inactive'].includes(c.status)).map(c => ({
    namespace: String(c.namespace || namespace), category_code: String(c.category_code || ''), category_name: String(c.category_name || ''),
    parent_code: c.parent_code || (c.parent_id != null ? byId.get(String(c.parent_id))?.category_code : null) || null, axis: c.axis
  }))
  const keys = new Map(catalog.map(c => [classificationKey(c), c]))
  if (keys.size !== catalog.length || catalog.some(c => !c.category_code || !c.category_name)) throw Error('分类字典编码重复或名称缺失')
  for (const c of catalog) {
    const seen = new Set(); let current = c
    while (current?.parent_code) {
      const key = classificationKey(current)
      if (seen.has(key)) throw Error('分类字典存在父子循环')
      seen.add(key); current = keys.get(JSON.stringify([current.namespace, current.parent_code]))
      if (!current) throw Error('分类字典缺少父类别')
    }
  }
  return catalog
}
export function classificationDescendants(catalog, key) {
  const group=majorGroup(key);if(group)return [...new Set(group.members.flatMap(code=>classificationDescendants(catalog,JSON.stringify(['unified-consolidated-v2',code]))))]
  const result = new Set([key]); let old = -1
  while (old !== result.size) { old = result.size; for (const c of catalog) if (c.parent_code && result.has(JSON.stringify([c.namespace, c.parent_code]))) result.add(classificationKey(c)) }
  return [...result]
}
export function limitSourceClassification(value,depth=0){
 if(!depth)return value
 if(!Number.isInteger(depth)||depth<1||depth>10)throw Error('分类标签保留层级无效')
 const sourceDepth=value.scheme==='fixed-majors-v1'?depth-1:depth
 const paths=(value.source_paths?.length?value.source_paths:(value.source_labels||[]).map(label=>label.split(' / '))).map(path=>path.slice(0,sourceDepth)).filter(path=>path.length)
 return {...value,source_paths:paths,source_labels:[...new Set(paths.map(p=>p.join(' / ')).filter(Boolean))]}
}
export function projectClassification(value, allowed = [],options={}) {
  if ((!allowed.includes('categories') && !allowed.includes('source_labels')) || !value) return undefined
  value=limitSourceClassification(value,options.tagDepth===undefined?options.sourceLabelDepth:options.tagDepth===0?0:options.tagDepth+(value.scheme==='fixed-majors-v1'?1:0))
  if(options.subdivide&&value.scheme==='fixed-majors-v1'&&allowed.includes('categories')&&allowed.includes('source_labels')&&!(value.catalog||[]).some(c=>c.category_code.startsWith('detail:')))value=subdivideMajorValue(value)
  const catalog = allowed.includes('categories') ? classificationCatalog(value.catalog || []) : [], known = new Map(catalog.map(c => [classificationKey(c), c])), items = new Map()
  for (const item of allowed.includes('categories') ? value.items || [] : []) {
    let key = item.key || classificationKey(item)
    if((options.navigationDepth||options.sourceLabelDepth||value.scheme==='fixed-majors-v1'&&options.subdivide!==true)&&known.has(key)){const path=[];let node=known.get(key);while(node){path.unshift(node);node=node.parent_code?known.get(JSON.stringify([node.namespace,node.parent_code])):null}key=classificationKey(path[Math.min(path.length,value.scheme==='fixed-majors-v1'&&options.subdivide!==true?1:options.navigationDepth||Math.min(2,options.sourceLabelDepth))-1])}
    if (!known.has(key)) throw Error('分类引用缺少对应字典，不能生成交付')
    const normalized = { key }
    if (allowed.includes('status')) normalized.review_status = String(item.review_status || 'unreviewed')
    const existing = items.get(key)
    if (!existing || existing.review_status !== 'confirmed') items.set(key, normalized)
  }
  const used = new Set(items.keys())
  for (const key of [...used]) { let c = known.get(key); while (c?.parent_code) { const parent = JSON.stringify([c.namespace, c.parent_code]); used.add(parent); c = known.get(parent) } }
  return { version: 1, ...(value.scheme?{scheme:value.scheme}:{}),catalog: catalog.filter(c => used.has(classificationKey(c))), items: [...items.values()], ...(allowed.includes('source_labels') ? {source_labels:[...new Set((value.source_labels||[]).filter(s=>typeof s==='string'&&s.trim()).map(s=>s.trim().slice(0,500)))]} : {}) }
}
export function classificationTree(records = [],options={}) {
  const catalog = new Map(), counts = new Map()
  for (const r of records) {
    for (const c of r.classification?.catalog || []) {
      const key = classificationKey(c), prior = catalog.get(key)
      if (prior && prior !== c && JSON.stringify(prior) !== JSON.stringify(c)) throw Error('交付分类字典冲突')
      catalog.set(key, c)
    }
  }
  for (const r of records) {
    const memberships = new Set()
    for (const item of r.classification?.items || []) {
      let c = catalog.get(item.key)
      while (c) { memberships.add(classificationKey(c)); c = c.parent_code ? catalog.get(JSON.stringify([c.namespace, c.parent_code])) : undefined }
    }
    for (const key of memberships) counts.set(key, (counts.get(key) || 0) + 1)
  }
  const nodes = new Map([...catalog].map(([key, c]) => [key, { key, label: `${c.category_name} (${counts.get(key) || 0})`, count: counts.get(key) || 0, children: [] }]))
  const roots = Object.entries(classificationAxes).map(([axis, label]) => ({ key: 'axis:' + axis, label, children: [] }))
  for (const [key, c] of catalog) {
    const parent = c.parent_code ? nodes.get(JSON.stringify([c.namespace, c.parent_code])) : roots.find(r => r.key === 'axis:' + c.axis)
    parent?.children.push(nodes.get(key))
  }
  const nonempty=nodes=>nodes.filter(n=>n.count>0).map(n=>({...n,children:nonempty(n.children)}))
  if(!records.some(r=>r.classification?.scheme==='fixed-majors-v1'))return roots.filter(r=>r.children.length)
  const result=nonempty(roots.flatMap(r=>r.children));for(const group of MAJOR_GROUPS){const members=result.filter(n=>group.members.some(code=>n.key===JSON.stringify(['unified-consolidated-v2',code])));if(!members.length)continue;const count=records.filter(r=>groupMemberships(r.classification?.catalog||[],(r.classification?.items||[]).map(i=>i.key)).includes(group.code)).length;const at=Math.min(...members.map(m=>result.indexOf(m)));for(const m of members)result.splice(result.indexOf(m),1);result.splice(at,0,{key:majorGroupKey(group.code),label:group.name+' ('+count+')',count,children:options.navigationDepth===1?[]:members.map(m=>({...m,children:[]}))})}return result
}
export function classificationLabel(record) {
  const catalog = new Map((record.classification?.catalog || []).map(c => [classificationKey(c), c]))
  return (record.classification?.items || []).map(item => catalog.get(item.key)?.category_name).filter(Boolean).join('；')
}
