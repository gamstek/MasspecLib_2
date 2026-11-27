import {FIXED_CLASSIFICATION_CATALOG,majorKey} from './fixedMajors.mjs'
export function peptideSourceInfo(value){
 const pending={subtype:'pending',status:'unparsed-source-identity'};if(typeof value!=='string'||value.length>2048)return pending
 const simple=value.match(/^([A-Z]+)\/([1-9]\d?)$/);if(simple)return{subtype:'unspecified',status:'source-sequence-only',sequence:simple[1],charge:Number(simple[2]),modifications:null}
 const inline=value.match(/^((?:[A-Z](?:\([^()]{1,80}\))?)+)\/([1-9]\d?)$/);if(inline){const tokens=[...inline[1].matchAll(/([A-Z])(?:\(([^()]{1,80})\))?/g)];if(tokens.map(t=>t[0]).join('')===inline[1]&&tokens.some(t=>t[2]))return{subtype:'modified',status:'source-notation-candidate',sequence:tokens.map(t=>t[1]).join(''),charge:Number(inline[2]),modifications:tokens.flatMap((t,index)=>t[2]?[{sequence_position:index+1,residue:t[1],source_marker:t[2]}]:[]),positionConvention:'inline-marker-location'}}
 const m=value.match(/^([A-Z]+)\/([1-9]\d?)_(\d{1,2})((?:\([^()]*\))*)_([0-9]+(?:\.[0-9]+)?)eV$/);if(!m)return pending
 const sequence=m[1],count=Number(m[3]),parts=[...m[4].matchAll(/\((\d+),([A-Z]),([^(),]{1,120})\)/g)]
 if(parts.length!==count||parts.map(p=>p[0]).join('')!==m[4])return pending
 const modifications=parts.map(p=>({raw_position:Number(p[1]),residue:p[2],name:p[3]}))
 if(modifications.some(p=>sequence[p.raw_position]!==p.residue&&sequence[p.raw_position-1]!==p.residue))return pending
 return{subtype:count?'modified':'unmodified',status:'source-notation-candidate',sequence,charge:Number(m[2]),modifications,collision_energy_from_name:{value:Number(m[5]),unit:'eV'},positionConvention:'source-original-unconverted'}
}
export const peptideCategoryCode=subtype=>FIXED_CLASSIFICATION_CATALOG.find(c=>c.parent_code==='peptides'&&c.category_name===({unmodified:'未修饰肽',modified:'修饰肽',unspecified:'修饰信息未注明',pending:'待细分肽'}[subtype]||'待细分肽')).category_code
export function peptideClassification(value,sourceName){
 const info=peptideSourceInfo(sourceName),items=(value.items||[]).filter(i=>i.key!==majorKey('other')&&i.key!==majorKey('peptides'))
 if(!items.some(i=>FIXED_CLASSIFICATION_CATALOG.some(c=>c.parent_code==='peptides'&&majorKey(c.category_code)===i.key)))items.push({key:majorKey(peptideCategoryCode(info.subtype)),review_status:info.status,classification_basis:'source-object-type-peptide',subdivision_basis:info.subtype==='pending'?'not-determined':'validated-source-notation'})
 return{...value,catalog:FIXED_CLASSIFICATION_CATALOG,items}
}
