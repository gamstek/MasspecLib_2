import test from 'node:test'
import assert from 'node:assert/strict'
import {queryOptions,matchesQuery,methodColumns} from '../src/shared/deliveryQuery.mjs'
const r={id:'one',sourceKey:'library',compound:{main_name:'乙酰甲胺磷',name_en:'Acephate',image_base64:'secret'},ms:[{q1:184,q3:143,polarity:0},{q1:200,q3:100,polarity:1}]}

test('Mass tolerance includes boundaries on one channel and never relaxes polarity',()=>{
 assert(matchesQuery(r,queryOptions({q1:184.1,q3:142.9,massTolerance:0.1,polarity:0})))
 assert(!matchesQuery(r,queryOptions({q1:184.1001,massTolerance:0.1})))
 assert(!matchesQuery(r,queryOptions({q1:184,massTolerance:10,polarity:1})))
 assert(!matchesQuery(r,queryOptions({q1:184,q3:100,massTolerance:0.1})))
 assert(!matchesQuery(r,queryOptions({q1:184.1})))
 for(const massTolerance of [-0.1,11,'bad',Infinity]) assert.throws(()=>queryOptions({q1:184,massTolerance}))
})
test('Combines method filters on one channel and preserves negative polarity zero',()=>{
 assert(matchesQuery(r,queryOptions({q1:184,q3:143,polarity:0})))
 assert(!matchesQuery(r,queryOptions({q1:184,q3:100})))
 assert(!matchesQuery({...r,ms:[{q1:null}]},queryOptions({q1:0})))
})
test('Search trims text, excludes images and combines source with cross-page record IDs',()=>{
 assert(matchesQuery(r,queryOptions({keyword:' ACE ',source:'library',recordIds:['two','one']})))
 assert(!matchesQuery(r,queryOptions({keyword:'secret'})))
 assert(!matchesQuery(r,queryOptions({recordIds:[]})))
})
test('Invalid advanced criteria fail explicitly, while empty inputs mean all',()=>{
 for(const q of [{q1:'NaN'},{q3:-1},{polarity:2},{recordIds:'x'}])assert.throws(()=>queryOptions(q))
 assert(matchesQuery(r,queryOptions({q1:'',q3:null,polarity:''})))
 assert.deepEqual(methodColumns([r],['q1','polarity']),['q1','polarity'])
})
