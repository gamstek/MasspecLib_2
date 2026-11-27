import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupLiquidMethods } from '../src/shared/liquidMethodGroups.mjs'
test('same LC conditions share a card while retaining source channel identities and editable records', () => {
  const a = { id:'a', method_source:'source-a', column_type:'HILIC', retention_time:6.001533,
    retention_times:[{id:'rt-a',value:6.001533,unit:'min',methodLocalIds:['ms-a']}], methodsLinks:[] }
  const b = { ...structuredClone(a), id:'b', method_source:'source-b',
    retention_times:[{id:'rt-b',value:6.001533,unit:'min',methodLocalIds:['ms-b']}] }
  const before = JSON.stringify([a,b])
  const groups = groupLiquidMethods([a,b])
  assert.equal(groups.length,1)
  assert.deepEqual(groups[0].members.map(m => m.retention_times[0].methodLocalIds),[['ms-a'],['ms-b']])
  assert.equal(groupLiquidMethods([a,b],true).length,2)
  assert.equal(groupLiquidMethods([a,{...b,retention_time:7}]).length,2)
  assert.equal(groupLiquidMethods([a,{...b,phase_A:'different'}]).length,2)
  assert.equal(JSON.stringify([a,b]),before)
})
