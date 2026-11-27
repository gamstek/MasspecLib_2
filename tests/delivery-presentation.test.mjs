import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compoundColumns, detailFields } from '../src/shared/deliveryPresentation.mjs'
const allowed = ['main_name','name_zh','name_en','cas','formula','molecular_mass','monoisotopic_mass']
test('Hides an entirely empty column but retains zero and a field populated after the first page', () => {
  const rows = Array.from({length:75},(_,i)=>({compound:{main_name:'A'+i,name_zh:'A'+i,name_en:'English '+i,cas:i===74?'50-00-0':null,molecular_mass:0}}))
  assert.deepEqual(compoundColumns(rows,allowed),['main_name','name_en','cas','molecular_mass'])
})
test('Keeps a distinct Chinese alias and does not reveal unauthorized fields', () => {
  assert.deepEqual(compoundColumns([{compound:{main_name:'A',name_zh:'甲',cas:'secret'}}],['main_name','name_zh']),['main_name','name_zh'])
})
test('Whitespace-only aliases are empty; trimming equal aliases avoids duplicate names', () => {
  assert.deepEqual(compoundColumns([{compound:{main_name:'甲',name_zh:' 甲 ',name_en:'  '}}],allowed),['main_name'])
})
test('Detail suppresses repeated name, carrier-unit rows and unknown channel roles, while preserving zero polarity', () => {
  assert.deepEqual(detailFields('compound',{main_name:'甲',name_zh:'甲',name_en:'Alpha'},allowed),['main_name','name_en'])
  assert.deepEqual(detailFields('ms',{ce:0,ce_unit:'V',polarity:0,transition_role:'unspecified'},['ce','ce_unit','polarity','transition_role']),['ce','polarity'])
})
test('Details retain independent units when the paired value is not authorized', () => {
  assert.deepEqual(detailFields('ms',{ce_unit:'V'},['ce_unit']),['ce_unit'])
})
test('Details avoid duplicating collision pressure and column type stored in legacy aliases', () => {
  assert.deepEqual(detailFields('ms',{cad_value:9,cad_type:'psi',collision_gas_pressure:{value:9,unit:'psi'}},['cad_value','cad_type','collision_gas_pressure']),['collision_gas_pressure'])
  assert.deepEqual(detailFields('lc',{column_type:'C18',chromatographic_column_mode:'C18'},['column_type','chromatographic_column_mode']),['column_type'])
})
test('Both complete real datasets get useful stable columns, independently of search or pagination', () => {
  const records=JSON.parse(readFileSync(new URL('../../package-envelope.json',import.meta.url),'utf8')).payload.offline.payload.records
  assert.deepEqual(compoundColumns(records.filter(r=>r.sourceTitle==='中药农残检测方法'),allowed),['main_name','name_en'])
  assert.deepEqual(compoundColumns(records.filter(r=>r.sourceTitle==='化妆品液质检测方法'),allowed),['main_name','name_en','cas','formula'])
})
