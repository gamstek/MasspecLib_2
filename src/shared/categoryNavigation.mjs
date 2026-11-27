import {majorGroup,groupMemberships} from './majorGroups.mjs'
import {FIXED_MAJORS,majorKey} from './fixedMajors.mjs'
export const remainderKey=code=>'@remainder:'+majorKey(code)
export function remainderMajor(key){if(typeof key!=='string'||!key.startsWith('@remainder:'))return null;return FIXED_MAJORS.find(c=>majorKey(c.category_code)===key.slice(11))?.category_code||null}
export function remainderMajors(catalog,keys){const by=new Map(catalog.map(c=>[JSON.stringify([c.namespace,c.category_code]),c])),roots=new Set(),detailed=new Set();for(const key of keys){let c=by.get(key);if(!c)continue;let child=false;const seen=new Set();while(c.parent_code&&!seen.has(c.category_code)){seen.add(c.category_code);child=true;c=by.get(JSON.stringify([c.namespace,c.parent_code]));if(!c)break}if(c&&FIXED_MAJORS.some(m=>m.category_code===c.category_code&&m.namespace===c.namespace)){roots.add(c.category_code);if(child)detailed.add(c.category_code)}}return [...roots].filter(c=>!detailed.has(c))}
export function navigationAxisRoots(catalog,key){
 if(typeof key!=='string'||!key.startsWith('axis:'))return null
 return catalog.filter(c=>!c.parent_code&&c.axis===key.slice(5))
}
export function matchesNavigation(value,key){const roots=navigationAxisRoots(value.catalog||[],key);if(roots)return roots.some(c=>matchesNavigation(value,JSON.stringify([c.namespace,c.category_code])));const group=majorGroup(key);if(group)return groupMemberships(value.catalog||[],(value.items||[]).map(i=>i.key)).includes(group.code);const code=remainderMajor(key);if(code)return remainderMajors(value.catalog||[],(value.items||[]).map(i=>i.key)).includes(code);const found=new Set([key]);let size=-1;while(size!==found.size){size=found.size;for(const c of value.catalog||[])if(c.parent_code&&found.has(JSON.stringify([c.namespace,c.parent_code])))found.add(JSON.stringify([c.namespace,c.category_code]))}return(value.items||[]).some(i=>found.has(i.key))}
export function remainderLabel(code){const name=FIXED_MAJORS.find(c=>c.category_code===code)?.category_name||'';return name.startsWith('其他')?name+'（其余记录）':'其他'+name}
