import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {fixedMajorValue} from '../src/shared/fixedMajors.mjs'
import {projectClassification,classificationTree} from '../src/shared/deliveryClassification.mjs'
const {normalizePolicy}=createRequire(import.meta.url)('../scripts/customer-delivery/policy.cjs')
test('screenshot dye hierarchy obeys total depth 1/2/3 including fixed major, including repeated projections',()=>{
 const raw=fixedMajorValue({source_paths:[['染料及非食用添加物','三苯甲烷类染料']]});const depth=nodes=>nodes.length?Math.max(...nodes.map(n=>1+depth(n.children))):0
 for(const limit of [1,2,3]){const options={subdivide:true,sourceLabelDepth:limit},first=projectClassification(raw,['categories','source_labels'],options),again=projectClassification(first,['categories','source_labels'],options),tree=classificationTree(Array.from({length:10},()=>({classification:again})));assert.equal(depth(tree),Math.min(2,limit));assert.equal(tree[0].count,10);if(limit<3)assert(!JSON.stringify(again).includes('三苯甲烷类染料'));if(limit===2){assert.equal(tree[0].children[0].label,'染料及非食用添加物 (10)');assert.deepEqual(again.source_labels,['染料及非食用添加物'])}if(limit===1)assert.deepEqual(again.source_labels,[])}
})
test('delivery depth two removes third-level tags and navigation nodes from payload, preserving major and source',()=>{
 const value=fixedMajorValue({source_paths:[['抗生素类','抗菌药','第三层敏感标签']],source_labels:['第三层敏感标签']});const before=JSON.stringify(value)
 const projected=projectClassification(value,['categories','source_labels'],{subdivide:true,sourceLabelDepth:2}),tree=classificationTree([{classification:projected}]);assert.deepEqual(projected.source_labels,['抗生素类']);assert.equal(tree[0].children[0].label,'抗生素类 (1)');assert.equal(tree[0].children[0].children.length,0);assert(!JSON.stringify(projected).includes('抗菌药'));assert(!JSON.stringify(projected).includes('第三层敏感标签'));assert.equal(JSON.stringify(value),before)
 const full=projectClassification(value,['categories','source_labels'],{subdivide:true,sourceLabelDepth:0});assert(JSON.stringify(full).includes('第三层敏感标签'))
 const policy={fields:{compound:['main_name']},classification:{sourceLabelDepth:2}};assert.equal(normalizePolicy(policy).classification.sourceLabelDepth,2);for(const bad of [-1,1.5,11,'2'])assert.throws(()=>normalizePolicy({...policy,classification:{sourceLabelDepth:bad}}),/层级/)
})
test('actual client label handler toggles once, retains expansion across query and triangle events, and queries once',()=>{
 const text=fs.readFileSync(new URL('../src/renderer/src/components/DeliveryCustomer.vue',import.meta.url),'utf8');const code=text.slice(text.indexOf('function rememberCategory'),text.indexOf('const props =')).replaceAll(':any','').replaceAll(':boolean','').replaceAll(':void','');let queries=0
 const context={expandedCategoryKeys:{value:[]},chooseCategory:()=>{queries++},Set};vm.createContext(context);vm.runInContext(code,context);const data={key:'major'},node={childNodes:[{}],expanded:false,expand(){this.expanded=true},collapse(){this.expanded=false}}
 context.clickCategory(data,node);assert.equal(node.expanded,true);assert.equal(queries,1);assert(context.expandedCategoryKeys.value.includes('major'))
 // Query replaces record-state/tree data. Stored expansion keys are independent of that data.
 assert(text.includes(':default-expanded-keys="expandedCategoryKeys"'));assert(text.includes(':expand-on-click-node="false"'));context.clickCategory(data,node);assert.equal(node.expanded,false);assert.equal(queries,2);assert.equal(context.expandedCategoryKeys.value.length,0)
 context.rememberCategory(data,true);assert(context.expandedCategoryKeys.value.includes('major'));context.rememberCategory(data,false);assert.equal(context.expandedCategoryKeys.value.length,0)
})
