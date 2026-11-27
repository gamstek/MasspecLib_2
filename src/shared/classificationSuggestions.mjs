import {categoryKey} from './classification.mjs'
const axes=new Set(['application','chemical_structure','origin','biological_role'])
const normalize=s=>String(s||'').normalize('NFC').trim().replace(/\s+/g,' ').toLocaleLowerCase()
function path(catalog,category){const names=[],seen=new Set(),byKey=new Map(catalog.map(c=>[categoryKey(c),c]));let c=category;while(c){const key=categoryKey(c);if(seen.has(key))return [];seen.add(key);names.unshift(c.category_name);if(!c.parent_code)break;c=byKey.get(JSON.stringify([c.namespace,c.parent_code]));if(!c)return []}return names}
// Suggestions are descriptive only. No rule is persisted or enabled here.
export function mappingSuggestions(sourceCatalog,targetCatalog){
 return sourceCatalog.map(source=>{
  const sourcePath=path(sourceCatalog,source),eligible=targetCatalog.filter(t=>t.status!=='disabled'&&(!axes.has(source.axis)||t.axis===source.axis)),full=JSON.stringify(sourcePath.map(normalize))
  let candidates=sourcePath.length>1&&axes.has(source.axis)?eligible.filter(t=>JSON.stringify(path(targetCatalog,t).map(normalize))===full):[]
  let reason='完整类别路径一致；仍需核对分类含义'
  if(!candidates.length){candidates=eligible.filter(t=>normalize(t.category_name)===normalize(source.category_name));reason='仅类别名称一致，必须核对父类别和含义'}
  return{sourceKey:categoryKey(source),sourcePath:sourcePath.join(' / '),candidates:candidates.map(t=>({key:categoryKey(t),path:path(targetCatalog,t).join(' / '),reason})),status:candidates.length===1?'suggested':candidates.length?'ambiguous':'unmatched',needsConfirmation:true}
 })
}
