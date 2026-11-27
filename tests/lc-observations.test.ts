import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lcTemperature } from '../src/shared/lcTemperature.ts'
import { retentionObservations, retentionConditions } from '../src/shared/lcRetention.ts'
import { encodePackage } from '../src/shared/dataPackage.ts'
import { readPersonalPackage, personalView, tablePackage } from '../src/shared/personalLibrary.ts'

test('missing scalar and multiple retention units default to minutes across personal import, export and persistence', () => {
  const data = tablePackage([{ main_name: '默认分钟' }], 'default-minute')
  data.groups[0].lcMethods = [{ retention_time: 2.95, retention_times: [{ value: 3.2 }, { value: 120, unit: 's' }] }]
  const decoded = readPersonalPackage(encodePackage(data))
  const lc = personalView({ id: 'batch', filename: '默认分钟', data: decoded }).records[0].lc[0]
  assert.equal(lc.retention_time_unit, 'min')
  assert.equal(lc.retention_time_unit_source, 'default')
  assert.equal(lc.retention_times[0].unit, 'min')
  assert.equal(lc.retention_times[0].unit_source, 'default')
  assert.equal(lc.retention_times[1].value, 120)
  assert.equal(lc.retention_times[1].unit, 's')
  const conditions = retentionConditions(decoded.groups[0].lcMethods![0], null)!
  assert.equal(conditions.retention_times[0].unit, 'min')
  assert.equal(conditions.retention_times[0].unit_source, 'default')
})
test('qualitative column temperature is preserved and never assigned an assumed Celsius value', () => {
  const room = lcTemperature({ column_temperature_c: '室温', conditions: { phase: 'A' } })
  assert.equal(room.column_temperature_c, null); assert.equal(room.column_temperature_text, '室温')
  assert.deepEqual(room.conditions, { phase: 'A', column_temperature_text: '室温' })
  assert.equal(lcTemperature({ column_temperature_c: '25 ℃' }).column_temperature_c, 25)
  assert.equal(lcTemperature({ column_temperature_c: 0 }).column_temperature_c, 0)
  assert.throws(() => lcTemperature({ column_temperature_c: 25, column_temperature_text: '室温' }), /同时填写/)
  assert.throws(() => lcTemperature({ column_temperature_c: Infinity }), /无效/)
})
test('one LC method round-trips two peaks with distinct times, units and multiple MRM channel associations', () => {
  const data = tablePackage([{ main_name: '多峰多通道演示' }], 'peaks')
  data.groups[0].methods = [ { localId: 'quant', q1: 301.1, q3: 123, ce: 20, transition_role: 'quantifier' }, { localId: 'qual', q1: 301.1, q3: 151, ce: 30, transition_role: 'qualifier' } ]
  data.groups[0].lcMethods = [{ column_temperature_text: '室温', retention_times: [ { id: 'p1', value: 3.2, unit: 'min', peak_label: '待确认峰1', methodLocalIds: ['quant', 'qual'] }, { id: 'p2', value: 245, unit: 's', peak_label: '待确认峰2', methodLocalIds: ['quant'] } ] }]
  const decoded = readPersonalPackage(encodePackage(data)), view = personalView({ id: 'batch', filename: '峰.msldata', data: decoded })
  assert.equal(view.records[0].lc.length, 1)
  assert.equal(view.records[0].lc[0].column_temperature_text, '室温')
  assert.equal(view.records[0].lc[0].column_temperature_c, null)
  assert.equal(view.records[0].lc[0].retention_times.length, 2)
  assert.deepEqual(view.records[0].lc[0].retention_times[0].methodIds, ['m0', 'm1'])
  const input = decoded.groups[0].lcMethods![0], t = lcTemperature(input)
  const stored = retentionConditions(input, t.conditions, new Set(['quant', 'qual']), new Map([['quant', 12], ['qual', 18]]))!
  assert.deepEqual(stored.retention_times[0].methodLocalIds, ['12', '18'])
  assert.equal(retentionObservations({ conditions: stored }, new Set(['12', '18']))[1].unit, 's')
})
test('ambiguous retention values, unknown units, duplicate peak IDs and broken MRM references are rejected', () => {
  const row = { id: 'p1', value: 3.2, unit: 'min', methodLocalIds: ['m1'] }
  assert.throws(() => retentionObservations({ retention_times: [{ ...row, value: '3.2/4.1' }] }), /非负数值/)
  assert.equal(retentionObservations({ retention_times: [{ ...row, unit: '' }] })[0].unit_source, 'default')
  assert.throws(() => retentionObservations({ retention_times: [{ ...row, unit: 'unknown' }] }), /单位/)
  assert.throws(() => retentionObservations({ retention_times: [row, row] }), /标识重复/)
  assert.throws(() => retentionObservations({ retention_times: [row] }, new Set(['m2'])), /不存在或已删除/)
  assert.deepEqual(retentionObservations({ retention_time: 3.2, retention_time_unit: 'min' }), [])
})
