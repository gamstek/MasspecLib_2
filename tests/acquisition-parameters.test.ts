import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquisitionView, normalizeAcquisition, lcFlowRate, quantityText } from '../src/shared/acquisitionParameters.mjs'
import { retentionObservations } from '../src/shared/lcRetention.ts'
import { lcTemperature } from '../src/shared/lcTemperature.ts'
test('source parser separates positive/negative IS, gas pressures and source temperature from original text', () => {
  const row = acquisitionView({ conditions: { transition_label: 'MRM5', method_source: '方法甲', ion_source_parameters_raw: '电喷雾电压（IS）：5500V/−4500V 碰撞气12psi\n气帘气（CUR）：35psi\n雾化气（GS1）：45psi\n辅助气压力（GS2）：55psi\n离子源温度（TEM）：500℃' } })
  assert.deepEqual(row.is_positive, { value: 5500, unit: 'V', unit_source: 'explicit' })
  assert.deepEqual(row.is_negative, { value: -4500, unit: 'V', unit_source: 'explicit' })
  assert.equal(row.collision_gas_pressure.value, 12); assert.equal(row.cur.value, 35); assert.equal(row.gs1.value, 45); assert.equal(row.gs2.value, 55)
  assert.equal(row.source_temperature.value, 500); assert.equal(row.method_source, '方法甲'); assert.equal(row.transition_label, 'MRM5')
})
test('missing pressure units default to psi with explicit provenance, while Medium stays qualitative and adduct note stays a note', () => {
  const raw = '气帘气CUR 30，碰撞气Medium，喷雾电压IS 4500 V；源温TEM 450 ℃；雾化气GS1 50，辅助气GS2 50；母离子多为[M+NH4]+铵加合'
  const row = acquisitionView({ conditions: { ion_source_parameters_raw: raw } })
  assert.equal(row.collision_gas_level, 'Medium'); assert.equal(row.collision_gas_pressure, undefined)
  assert.equal(row.cur.value, 30); assert.equal(row.cur.unit, 'psi'); assert.equal(row.cur.unit_source, 'default')
  assert.equal(row.gs1.unit_source, 'default'); assert(quantityText(row.gs2).includes('默认单位'))
  assert(row.adduct_note.includes('[M+NH4]+')); assert.equal(row.adduct, undefined); assert.equal(row.ion_source_parameters_raw, raw)
})
test('explicit structured values override parsing and export only fixed quantity members', () => {
  const row = acquisitionView({ conditions: { private: 'secret', cur: { value: 20, unit: 'kPa', private: 'hidden' }, ion_source_parameters_raw: 'CUR 30 psi' } })
  assert.deepEqual(row.cur, { value: 20, unit: 'kPa', unit_source: 'explicit' }); assert.equal(row.private, undefined)
  assert.throws(() => normalizeAcquisition({ conditions: { cur: { value: 'Medium' } } }), /有效数值/)
  assert.equal(acquisitionView({ conditions: { cur: null, ion_source_parameters_raw: 'CUR 30psi' } }).cur, undefined)
})
test('existing converted packages expose raw room temperature, multiple retention candidates and flow rates without destructive migration', () => {
  const conditions = { column_temperature_raw: '室温', retention_time_candidates_min: [3.2, 4.1], flow_rate_mL_min: .3 }
  assert.equal(lcTemperature({ column_temperature_c: null, conditions }).column_temperature_text, '室温')
  const times = retentionObservations({ conditions }); assert.equal(times.length, 2); assert(times.every(r => r.methodLocalIds.length === 0))
  assert.deepEqual(lcFlowRate({ conditions }), { value: .3, unit: 'mL/min', unit_source: 'explicit' })
  assert.equal(lcFlowRate({ items: [{ flow_rate: .4 }] }).unit_source, 'default')
  assert.equal(lcFlowRate({ items: [{ flow_rate: .4 }, { flow_rate: .6 }] }).program.length, 2)
})
