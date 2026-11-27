import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fixedMajorValue,majorKey} from '../src/shared/fixedMajors.mjs'
import {projectClassification,classificationTree} from '../src/shared/deliveryClassification.mjs'
import {createWindowIcon,windowIconDataURL} from '../src/shared/windowIcon.mjs'
test('original antibiotic hierarchy becomes a major and optional portable subcategories without source wrapper',()=>{
 const catalog=[{namespace:'source',category_code:'r',category_name:'毒物（原表分类）',axis:'source_taxonomy'},{namespace:'source',category_code:'a',category_name:'抗生素类',parent_code:'r',axis:'source_taxonomy'},{namespace:'source',category_code:'b',category_name:'其他抗菌药',parent_code:'a',axis:'source_taxonomy'}];const original={catalog,items:[{key:'["source","b"]'}]},before=JSON.stringify(original),value=fixedMajorValue(original)
 assert.equal(value.items[0].key,majorKey('drugs'));assert(value.source_labels.includes('抗生素类 / 其他抗菌药'));assert.equal(JSON.stringify(original),before)
 const base=projectClassification(value,['categories','source_labels']);assert.equal(classificationTree([{classification:base}])[0].key,majorKey('drugs'))
 const expanded=projectClassification(value,['categories','source_labels'],{subdivide:true}),tree=classificationTree([{classification:expanded}]);assert.equal(tree[0].children[0].label,'抗生素类 (1)');assert.equal(tree[0].children[0].children.length,0);assert(expanded.source_labels.includes('抗生素类 / 其他抗菌药'));assert(!JSON.stringify(tree).includes('原表分类'));assert.equal(fixedMajorValue({}).items[0].key,majorKey('other'));assert.equal(fixedMajorValue({},'cosmetics').items[0].key,majorKey('cosmetics'))
})
test('embedded window icon is PNG data and invalid decoded resources fail before window hiding',()=>{
 const bytes=Buffer.from(windowIconDataURL.split(',')[1],'base64');assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert(bytes.readUInt32BE(16)>0);let supplied;const image={isEmpty:()=>false};assert.equal(createWindowIcon({createFromDataURL:v=>{supplied=v;return image}}),image);assert.equal(supplied,windowIconDataURL);assert.throws(()=>createWindowIcon({createFromDataURL:()=>({isEmpty:()=>true})}),/资源无效/)
})
