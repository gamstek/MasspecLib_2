import{majorKey}from './fixedMajors.mjs';
export const MAJOR_GROUPS=[{code:'food',name:'食品类',members:['food_additives','food_components']},{code:'biology',name:'生物类',members:['metabolism','lipids','peptides']}];
export const majorGroupKey=code=>'@major-group:'+code;
export const majorGroup=key=>MAJOR_GROUPS.find(g=>majorGroupKey(g.code)===key);
export function groupMemberships(catalog,keys){const by=new Map(catalog.map(c=>[majorKey(c.category_code),c])),roots=new Set();for(const key of keys){let c=by.get(key),seen=new Set();while(c&&!seen.has(c.category_code)){seen.add(c.category_code);roots.add(c.category_code);c=c.parent_code?by.get(majorKey(c.parent_code)):null}}return MAJOR_GROUPS.filter(g=>g.members.some(c=>roots.has(c))).map(g=>g.code)}
