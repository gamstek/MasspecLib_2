import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { deliveryTabular } from '../src/shared/deliveryTabular.ts'
test('linked-field Excel and CSV exports retain source parameter units, defaults and method ownership', () => {
  const data = { manifest: { fieldLabels: { compound: { main_name: '名称' }, ms: { cur: '气帘气 CUR', transition_label: 'MRM编号' } } }, records: [{ id: 'compound1', sourceTitle: '=HYPERLINK("x")', compound: { main_name: '=1+1' }, ms: [{ id: 'm1', transition_label: 'MRM1', cur: { value: 30, unit: 'psi', unit_source: 'default' } }], lc: [{ id: 'l1', column_temperature_text: '室温' }] }] }
  const bytes = deliveryTabular(data, 'xlsx', true), book = XLSX.read(bytes, { type: 'buffer' })
  assert.deepEqual(book.SheetNames, ['化合物', '质谱方法', '液相方法'])
  const methods: any[] = XLSX.utils.sheet_to_json(book.Sheets['质谱方法'])
  assert.equal(methods[0]['气帘气 CUR'], '30 psi（默认单位）'); assert.equal(methods[0]['MRM编号'], 'MRM1')
  assert.equal(methods[0]['名称'], "'=1+1"); assert.equal(methods[0]['所属数据库'], "'=HYPERLINK(\"x\")")
  const csv = deliveryTabular(data, 'csv', true) as string; assert(csv.includes('气帘气 CUR')); assert(csv.includes('默认单位')); assert(csv.includes('室温'))
  const plain = XLSX.read(deliveryTabular(data, 'xlsx', false), { type: 'buffer' }); assert.deepEqual(plain.SheetNames, ['化合物'])
})
test('large Excel cells fail visibly rather than truncate scientific arrays or source text', () => {
  const data = { records: [{ id: 'c', compound: { main_name: 'test' }, ms: [{ ion_source_parameters_raw: 'a'.repeat(32768) }] }] }
  assert.throws(() => deliveryTabular(data, 'xlsx', true), /改用JSON/)
  assert((deliveryTabular(data, 'csv', true) as string).includes('a'.repeat(32768)))
})
