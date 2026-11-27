import {test} from 'node:test'
import assert from 'node:assert/strict'
import {categoryKey, recordKey, classificationPlan, classificationWhere, classificationMembership, localCatalog, displayLibrary} from '../src/shared/classification.mjs'
const cat=(id,code,parent=null,axis='application',ns='local')=>({id,namespace:ns,category_code:code,parent_code:parent,category_name:code,axis})
const catalog=[cat(1,'pesticide'),cat(2,'insecticide','pesticide')]
const project={database_name:'project',categories:[cat(8,'insecticide',null,'source_taxonomy','tender'),cat(9,'child','insecticide','source_taxonomy','tender')]}
const local={database_name:'local',categories:catalog}
const state=()=>({roles:{local:'local',project:'project'},mappings:[],assignments:{}})
test('project category trees never promote source labels into local kinds',()=>{
 assert.deepEqual(localCatalog(project.categories),[])
 assert.deepEqual(classificationPlan(state(),project,catalog,categoryKey(catalog[0])).nativeCategoryIds,[])
 assert.deepEqual(classificationPlan(state(),local,catalog,categoryKey(catalog[0])).nativeCategoryIds,[1,2])
 assert.equal(localCatalog([cat(4,'unknown',null,'unresolved')]).length,0)
})
test('unmapped project records are pending; SQL does not require a taxonomy table when empty',()=>{
 const p=classificationPlan(state(),project,catalog,'@pending'), f=classificationWhere(p)
 assert.equal(p.pending,true);assert(!f.where.includes('compound_taxonomy'));assert.deepEqual(f.params,[])
})
test('explicit mapping includes descendants, never rewrites original category data',()=>{
 const s=state(),before=JSON.stringify(project)
 s.mappings.push({database:'project',sourceKey:categoryKey(project.categories[0]),targets:[categoryKey(catalog[1])],enabled:true})
 assert.deepEqual(classificationPlan(s,project,catalog,categoryKey(catalog[0])).ruleCategoryIds,[8,9])
 assert.deepEqual(classificationPlan(s,local,catalog,categoryKey(catalog[0])).ruleCategoryIds,[])
 assert.equal(JSON.stringify(project),before)
 s.mappings[0].enabled=false;assert.deepEqual(classificationPlan(s,project,catalog,categoryKey(catalog[0])).ruleCategoryIds,[])
})
test('manual overrides win even if category mapping later changes; clear remains pending',()=>{
 const s=state();s.mappings.push({database:'project',sourceKey:categoryKey(project.categories[0]),targets:[categoryKey(catalog[1])],enabled:true})
 s.assignments.a={database:'project',id:'17',categories:[],locked:true}
 s.assignments.b={database:'project',id:'18',categories:[categoryKey(catalog[1])],locked:true}
 const p=classificationPlan(s,project,catalog,categoryKey(catalog[0]))
 assert.deepEqual(p.overrideIds,['17','18']);assert.deepEqual(p.includeIds,['18'])
 assert.deepEqual(classificationWhere(p).params,['18','17','18',8,9])
 s.mappings=[];assert.deepEqual(classificationPlan(s,project,catalog,categoryKey(catalog[0])).includeIds,['18'])
})
test('untrusted SQL identifiers and IDs are never interpolated',()=>{
 assert.throws(()=>classificationWhere({includeIds:['1) OR 1=1'],overrideIds:[],nativeCategoryIds:[],ruleCategoryIds:[]}))
 const f=classificationWhere({includeIds:['1'],overrideIds:[],nativeCategoryIds:[3],ruleCategoryIds:[]})
 assert(f.where.includes('?'));assert(!f.where.includes('IN (1)'));assert.deepEqual(f.params,['1',3])
})
test('same-named libraries are explicitly distinguished without discarding records',()=>{
 const libs=[{title:'毒物',database_name:'a',file_name:'a.msldata'},{title:'毒物',database_name:'b',file_name:'b.sql'}]
 assert.equal(displayLibrary(libs[0],libs),'毒物（MSLDATA）');assert.equal(displayLibrary(libs[1],libs),'毒物（SQL）')
})
test('detail display resolves the same explicit mappings and manual locks as query membership',()=>{
 const s={...state(),catalog};s.mappings.push({id:'rule',database:'project',sourceKey:categoryKey(project.categories[0]),targets:[categoryKey(catalog[1])],enabled:true})
 assert.equal(classificationMembership(s,project,[categoryKey(project.categories[1])],'17')[0].category_code,'insecticide')
 assert.equal(classificationMembership(s,project,[],'17').length,0)
 s.assignments[recordKey('project','17')]={database:'project',id:'17',categories:[],locked:true}
 assert.equal(classificationMembership(s,project,[categoryKey(project.categories[1])],'17').length,0)
 assert.equal(classificationMembership(s,local,[categoryKey(catalog[1])],'17')[0].evidence[0].kind,'existing-local-classification')
})
