import {majorGroup} from './majorGroups.mjs'
import {navigationAxisRoots,remainderMajor} from './categoryNavigation.mjs'
import {fixedMajorValue,majorKey,subdivideMajorValue} from './fixedMajors.mjs'
export const categoryKey = c => JSON.stringify([c.namespace, c.category_code])
export const recordKey = (database, id) => JSON.stringify([database, String(id)])
export const isProjectAxis = axis => ['source_taxonomy', 'source_scope'].includes(axis)
export function descendants(catalog, key) {
  const found = new Set([key]); let size = -1
  while (size !== found.size) { size = found.size; for (const c of catalog) if (c.parent_code && found.has(JSON.stringify([c.namespace, c.parent_code]))) found.add(categoryKey(c)) }
  return found
}
export function localCatalog(catalog) {
  const index = new Map(catalog.map(c => [categoryKey(c), c]))
  return catalog.filter(c => {
    let root = c; const seen = new Set()
    while (root?.parent_code) { const key = categoryKey(root); if (seen.has(key)) throw Error('分类目录存在循环'); seen.add(key); root = index.get(JSON.stringify([root.namespace, root.parent_code])) }
    return root && !isProjectAxis(root.axis) && root.axis !== 'unresolved'
  })
}
export function displayLibrary(library, peers) {
  if (peers.filter(p => p.title === library.title).length < 2) return library.title
  const format = library.file_name?.split('.').pop()?.toUpperCase()
  const same = peers.filter(p => p.title === library.title && p.file_name?.split('.').pop()?.toUpperCase() === format)
  return `${library.title}（${format && same.length === 1 ? format : [format, library.database_name.slice(-8)].filter(Boolean).join(' · ')}）`
}
export function classificationPlan(state, library, allCategories, selectedKey) {
  const roots=navigationAxisRoots(allCategories,selectedKey)
  if(roots)return {unionPlans:roots.map(c=>classificationPlan(state,library,allCategories,categoryKey(c)))}
  const group=majorGroup(selectedKey);if(group)return{unionPlans:group.members.map(code=>classificationPlan(state,library,allCategories,majorKey(code)))}
  const remainder=remainderMajor(selectedKey);if(remainder){const root=majorKey(remainder),children=allCategories.filter(c=>c.parent_code===remainder&&c.namespace===JSON.parse(root)[0]);return{intersection:[classificationPlan(state,library,allCategories,root)],excludePlans:children.map(c=>classificationPlan(state,library,allCategories,categoryKey(c)))}}
  if(state.fixedMajors){
    const wanted=descendants(allCategories,selectedKey),other=selectedKey===majorKey('other'),pending=selectedKey==='@pending',ids=[],nonOther=[],resolved=[];
    for(const c of library.categories){const memberships=classificationMembership({...state,assignments:{},defaults:{}},library,[categoryKey(c)],'').filter(m=>!m.evidence?.some(e=>e.kind==='library-default'));if(memberships.length)resolved.push(Number(c.id));if(memberships.some(m=>categoryKey(m)!==majorKey('other')))nonOther.push(Number(c.id));if(memberships.some(m=>wanted.has(categoryKey(m))))ids.push(Number(c.id))}
    const empty=classificationMembership({...state,assignments:{}},library,[],'').some(m=>wanted.has(categoryKey(m))),overrides=Object.values(state.assignments).filter(a=>a.database===library.database_name)
    return {pending:false,alwaysEmpty:pending,inheritedComplement:other&&empty,inheritedOrUnlinked:!other&&empty,allCategoryIds:resolved,nativeCategoryIds:other&&empty?nonOther:ids,ruleCategoryIds:[],overrideIds:overrides.map(a=>String(a.id)),includeIds:overrides.filter(a=>classificationMembership(state,library,[],String(a.id)).some(c=>wanted.has(categoryKey(c)))).map(a=>String(a.id))}
  }

  const pending = selectedKey === '@pending' 
  const wanted = pending ? new Set(allCategories.map(categoryKey)) : descendants(allCategories, selectedKey)
  const ownKeys = new Map(allCategories.map(c => [categoryKey(c), c]))
  if (!pending && !ownKeys.has(selectedKey)) throw Error('本地分类不存在或已停用')
  const nativeCategoryIds = state.roles[library.database_name] === 'local' ? localCatalog(library.categories).filter(c => wanted.has(categoryKey(c))).map(c => Number(c.id)) : []
  const ruleCategoryIds = []
  for (const rule of state.mappings) if (rule.enabled && rule.database === library.database_name && rule.targets.some(k => wanted.has(k))) {
    const keys = descendants(library.categories, rule.sourceKey)
    ruleCategoryIds.push(...library.categories.filter(c => keys.has(categoryKey(c))).map(c => Number(c.id)))
  }
  const overrides = Object.values(state.assignments).filter(a => a.database === library.database_name)
  return { pending, nativeCategoryIds: [...new Set(nativeCategoryIds)], ruleCategoryIds: [...new Set(ruleCategoryIds)], overrideIds: overrides.map(a => String(a.id)), includeIds: overrides.filter(a => a.categories.some(k => wanted.has(k))).map(a => String(a.id)) }
}
/** All names are fixed SQL, and all selected IDs are bound parameters. */
export function classificationWhere(plan) {
  if(plan.unionPlans){const parts=plan.unionPlans.map(classificationWhere);return{where:parts.map(p=>'('+p.where+')').join(' OR ')||'FALSE',params:parts.flatMap(p=>p.params)}}
  if(plan.intersection){const parts=plan.intersection.map(classificationWhere),exclude=(plan.excludePlans||[]).map(classificationWhere);return{where:parts.map(p=>'('+p.where+')').concat(exclude.map(p=>'NOT ('+p.where+')')).join(' AND '),params:[...parts,...exclude].flatMap(p=>p.params)}}
  if(plan.alwaysEmpty)return {where:'FALSE',params:[]}
  const params = []
  const ids = (values, expression) => {
    if (!values.length) return 'FALSE'
    if (values.length > 20000 || values.some(v => !/^\d+$/.test(String(v)))) throw Error('分类记录范围无效或超过单次限制')
    params.push(...values); return `${expression} IN (${values.map(() => '?').join(',')})`
  }
  const include = ids(plan.includeIds || [], 'c.id'), override = ids(plan.overrideIds || [], 'c.id')
  const native = ids(plan.nativeCategoryIds || [], 'ct.category_id'), rules = ids(plan.ruleCategoryIds || [], 'ct.category_id')
  const inherited = (plan.nativeCategoryIds?.length || plan.ruleCategoryIds?.length) ? `EXISTS(SELECT 1 FROM compound_taxonomy ct WHERE ct.compound_id=c.id AND (${native} OR ${rules}))` : 'FALSE'
  const any=plan.inheritedOrUnlinked?ids(plan.allCategoryIds||[], 'ct.category_id'):'FALSE'
  const effective=plan.inheritedComplement?`NOT (${inherited})`:plan.inheritedOrUnlinked&&!plan.allCategoryIds?.length?'TRUE':plan.inheritedOrUnlinked?`(${inherited} OR NOT EXISTS(SELECT 1 FROM compound_taxonomy ct WHERE ct.compound_id=c.id AND ${any}))`:inherited
  const classified = `(${include} OR (NOT (${override}) AND ${effective}))`
  return { where: plan.pending ? `NOT ${classified}` : classified, params }
}
export function categoryViewNode(key) { return JSON.stringify(['local-classification-v1', key]) }
/** Resolve explicit stored metadata for display, without inferring identity or category semantics. */
export function classificationMembership(state, library, sourceKeys, id) {
  const catalog = new Map(state.catalog.map(c => [categoryKey(c), c]))
  const assigned = state.assignments[recordKey(library.database_name, id)]
  if(state.fixedMajors){
    const normalize=k=>{let c=catalog.get(k);if(!c)return null;const path=[c],seen=new Set();while(c.parent_code){if(seen.has(categoryKey(c)))return null;seen.add(categoryKey(c));c=catalog.get(JSON.stringify([c.namespace,c.parent_code]));if(!c)return null;path.unshift(c)}return path[Math.min(1,path.length-1)]}
    if(assigned){const categories=assigned.categories.map(normalize).filter(Boolean);return(categories.length?categories:[catalog.get(majorKey('other'))]).map(c=>({...c,evidence:[{kind:'manual-assignment',actor:assigned.actor,at:assigned.at,locked:true}]}))}
    const own=new Map(library.categories.map(c=>[categoryKey(c),c])),found=new Map(),add=(target,evidence)=>{const c=normalize(target);if(c)found.set(categoryKey(c),{...c,evidence:[evidence]})}
    for(const source of sourceKeys){let c=own.get(source),mapped=false;const seen=new Set();while(c&&!seen.has(categoryKey(c))){seen.add(categoryKey(c));const rule=state.mappings.find(r=>r.enabled&&r.database===library.database_name&&r.sourceKey===categoryKey(c));if(rule){for(const target of rule.targets)add(target,{kind:'explicit-administrator-mapping',mappingId:rule.id,actor:rule.actor});mapped=true;break}c=c.parent_code?own.get(JSON.stringify([c.namespace,c.parent_code])):null}
      if(!mapped){const value=subdivideMajorValue(fixedMajorValue({catalog:library.categories,items:[{key:source}]}));for(const item of value.items)if(item.key!==majorKey('other'))add(item.key,{kind:'fixed-label-rule'});if(state.roles[library.database_name]==='local'&&catalog.has(source)&&!value.items.some(i=>i.key!==majorKey('other')))add(source,{kind:'existing-local-classification'})}
    }
    if(!found.size){const key=majorKey(state.defaults?.[library.database_name]||'other');found.set(key,{...catalog.get(key),evidence:[{kind:'library-default'}]})}
    if(found.size>1)found.delete(majorKey('other'));return [...found.values()]
  }
  if (assigned) return assigned.categories.filter(k => catalog.has(k)).map(k => ({ ...catalog.get(k), evidence: [{ kind: 'manual-assignment', actor: assigned.actor, at: assigned.at, locked: true }] }))
  const found = new Map()
  const add = (key, evidence) => {
    if (!catalog.has(key)) return
    if (!found.has(key)) found.set(key, { ...catalog.get(key), evidence: [] })
    found.get(key).evidence.push(evidence)
  }
  if (state.roles[library.database_name] === 'local') for (const key of sourceKeys) add(key, { kind: 'existing-local-classification' })
  for (const rule of state.mappings) if (rule.enabled && rule.database === library.database_name) {
    const eligible = descendants(library.categories, rule.sourceKey)
    if (sourceKeys.some(k => eligible.has(k))) for (const key of rule.targets) add(key, { kind: 'explicit-administrator-mapping', mappingId: rule.id, actor: rule.actor, at: rule.at })
  }
  return [...found.values()]
}
