const {test}=require('node:test'),assert=require('node:assert/strict'),{normalizePolicy}=require('../scripts/customer-delivery/policy.cjs'),{classificationNavigationEnabled}=require('../src/shared/deliveryClassification.mjs');
test('new deliveries choose classification navigation separately from detail fields; legacy policies remain readable',()=>{
 const base={fields:{compound:['main_name'],classification:['categories','status','source_labels']},features:{}};
 const hidden=normalizePolicy(base);assert.equal(hidden.features.classification,false);assert(!classificationNavigationEnabled(hidden));assert.deepEqual(hidden.fields.classification,base.fields.classification);
 const enabled=normalizePolicy({fields:{compound:['main_name']},features:{classification:true}});assert(classificationNavigationEnabled(enabled));assert(enabled.fields.classification.includes('categories'));
 assert(classificationNavigationEnabled(base));assert(!classificationNavigationEnabled({...base,features:{classification:false}}));assert(!classificationNavigationEnabled({fields:{compound:['main_name']},features:{}}));
});
