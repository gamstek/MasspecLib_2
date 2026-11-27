import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  numericText,
  columnParticleSize,
  mobilePhaseDisplay,
  liquidProgramDisplay,
  retentionTimeText,
  retentionTimeInMinutes,
  energyText,
  acquisitionRows,
  liquidConditionRows
} from '../src/shared/scientificDisplay.ts'
test('display decimal padding is removed without changing source text or rounding digits', () => {
  assert.equal(numericText('335.0520000000'), '335.052')
  assert.equal(numericText('1.800'), '1.8')
  assert.equal(numericText('335.0520000001'), '335.0520000001')
  assert.equal(numericText(0), '0')
  assert.equal(numericText(null), '未提供')
})
test('energy objects show readable values and preserve zero and unknown scale', () => {
  assert.equal(
    energyText({ raw: '20(NCE)', value: '20', scale: 'NCE', energy_type: 'normalized' }),
    '20 NCE（归一化）'
  )
  assert.equal(energyText({ value: 0, unit: 'eV' }), '0 eV')
  assert.equal(energyText({ value: -15 }), '-15')
  assert.equal(energyText('20(NCE)'), '20(NCE)')
  assert.equal(energyText(JSON.stringify({ value: '20', scale: 'NCE' })), '20 NCE')
  assert.equal(energyText({ raw: 'not recorded' }), 'not recorded')
})
test('conditions show scientific fields while original and administrative fields stay out of summary', () => {
  const conditions = {
    instrument_type: 'LC-ESI-ITFT',
    ionization_voltage: { value: '3.9', unit: 'kV' },
    fragmentation_mode: 'HCD',
    resolution: '17500',
    source_accession: 'MSBNK-AAFC-AC000022',
    lc_method_local_id: 'lc:abc',
    original_mass_spectrometry: { MS_TYPE: ['MS2'], IONIZATION: ['ESI'] }
  }
  const before = JSON.stringify(conditions)
  assert.deepEqual(acquisitionRows(conditions), [
    { label: '采集模式', value: 'MS2' },
    { label: '仪器类型', value: 'LC-ESI-ITFT' },
    { label: '离子源', value: 'ESI' },
    { label: '离子源电压', value: '3.9 kV' },
    { label: '碎裂方式', value: 'HCD' },
    { label: '分辨率', value: '17500' },
    { label: '原始记录编号', value: 'MSBNK-AAFC-AC000022' }
  ])
  assert.equal(JSON.stringify(conditions), before)
  assert.deepEqual(acquisitionRows({ source_accession: 'a' }), [
    { label: '原始记录编号', value: 'a' }
  ])
  assert.deepEqual(acquisitionRows(null), [])
})

test('liquid conditions expose a concise summary and keep raw chromatography collapsible', () => {
  const rows = liquidConditionRows({
    record_accessions: ['MSBNK-AAFC-AC000044'],
    particle_size_original: '1.8 uM',
    particle_size_mapping: '用户确认：按μm解释，标准粒径1.8 μm',
    original_chromatography: {
      SOLVENT: ['A H2O 0.1% FA', 'B ACN 0.1% FA'],
      RETENTION_TIME: ['2.8'],
      NAPS_RTI: ['750'],
      FLOW_RATE: ['0.3 mL min-1'],
      COLUMN_NAME: ['Agilent RRHD Eclipse 50 x 2 mm, 1.8 uM'],
      FLOW_GRADIENT: ['100:0 at 0 min']
    }
  })
  assert.deepEqual(rows.slice(0, 7), [
    { label: '来源记录数', value: '1' },
    { label: '流速', value: '0.3 mL min-1' },
    { label: '原始保留时间', value: '2.8' },
    { label: 'NAPS_RTI（来源原字段）', value: '750' },
    { label: '原始色谱柱', value: 'Agilent RRHD Eclipse 50 x 2 mm, 1.8 uM' },
    { label: '原始流动相', value: 'A H2O 0.1% FA；B ACN 0.1% FA' },
    { label: '原始梯度', value: '100:0 at 0 min' }
  ])
  assert.equal(
    rows.find((row) => row.label === '粒径说明')?.value,
    '用户确认：按μm解释，标准粒径1.8 μm'
  )
})

test('NAPS_RTI alone never becomes retention time and missing time units are not inferred', () => {
  const original = { original_chromatography: { NAPS_RTI: ['750'] } }
  assert.deepEqual(liquidConditionRows(original), [
    { label: 'NAPS_RTI（来源原字段）', value: '750' }
  ])
  assert.deepEqual(liquidConditionRows({ original_chromatography: { RETENTION_TIME: ['0'] } }), [
    { label: '原始保留时间', value: '0' }
  ])
  assert.deepEqual(original, { original_chromatography: { NAPS_RTI: ['750'] } })
})

test('column particle size reads only column metadata and accepts authorized uM/um spellings', () => {
  for (const unit of ['uM', 'um', 'μm', 'µm']) {
    const method = {
      column_particle_size_um: null,
      chromatographic_column_mode: `Agilent RRHD Eclipse 50 x 2 mm, 1.8 ${unit}`
    }
    const before = JSON.stringify(method)
    assert.equal(columnParticleSize(method), 1.8)
    assert.equal(JSON.stringify(method), before)
  }
  assert.equal(
    columnParticleSize({ conditions: JSON.stringify({ particle_size_original: '1.8 uM' }) }),
    1.8
  )
  assert.equal(
    columnParticleSize({
      conditions: { original_chromatography: { COLUMN_NAME: ['C18 50 x 2 mm, 1.8 uM'] } }
    }),
    1.8
  )
  assert.equal(
    columnParticleSize({
      column_particle_size_um: '2.300',
      chromatographic_column_mode: 'C18 1.8 uM'
    }),
    2.3
  )
  assert.equal(columnParticleSize({ phase_A: '1.8 uM', conditions: { solvent: '1.8 uM' } }), null)
  assert.equal(columnParticleSize({ chromatographic_column_mode: '50 x 2 mm' }), null)
  assert.equal(
    columnParticleSize({
      chromatographic_column_mode: '1.8 uM',
      conditions: { particle_size_original: '2.6 um' }
    }),
    null
  )
})

test('retention time defaults missing units to minutes and converts explicitly supplied units', () => {
  assert.equal(retentionTimeText('2.950', null), '2.95 min（默认单位）')
  assert.equal(retentionTimeText(0, ''), '0 min（默认单位）')
  assert.equal(retentionTimeInMinutes(120, null), 120)
  assert.equal(retentionTimeInMinutes('120', 's'), 2)
  assert.equal(retentionTimeText(177, 'sec'), '2.95 min')
  assert.equal(retentionTimeText('0.5', 'h'), '30 min')
  assert.equal(retentionTimeText(60000, 'ms'), '1 min')
  assert.equal(retentionTimeText(null, 'min'), '未提供')
  assert.equal(retentionTimeInMinutes(2.8, 'unknown'), null)
  assert.equal(retentionTimeText(2.8, 'unknown'), '2.8 unknown（原始单位）')
  assert.equal(retentionTimeInMinutes('not numeric', 'min'), null)
})

test('LDS solvent labels separate the A and B values without rewriting the source', () => {
  const method = { phase_A: JSON.stringify(['SOLVENT A Water with 0.1% formic acid', 'SOLVENT B ACN with 0.1% formic acid']) }
  const raw = method.phase_A
  const phases = mobilePhaseDisplay(method)
  assert.equal(phases.phase_A, 'Water with 0.1% formic acid')
  assert.equal(phases.phase_B, 'ACN with 0.1% formic acid')
  assert.equal(method.phase_A, raw)
  assert.equal(mobilePhaseDisplay({ ...method, phase_B: 'Reviewed B' }).phase_B, 'Reviewed B')
  assert.equal(mobilePhaseDisplay({ phase_A: 'A mixture of water and methanol' }).phase_A, 'A mixture of water and methanol')
  assert.equal(mobilePhaseDisplay({ phase_A: '["Water","ACN"]' }).phase_B, '')
})

test('LDS liquid program exposes the four screenshot steps and handles explicit ranges', () => {
  const result = liquidProgramDisplay('95/5 at 0 min, 95/5 at 1.12 min, 0.5/99.5 at 6.41 min, 0.5/99.5 at 10.01 min')
  assert.equal(result.elution, 'gradient')
  assert.deepEqual(result.steps.map(r => [r.time, r.percentage_A, r.percentage_B, r.time_unit]),
    [['0', 95, 5, 'min'], ['1.12', 95, 5, 'min'], ['6.41', 0.5, 99.5, 'min'], ['10.01', 0.5, 99.5, 'min']])
  assert.equal(liquidProgramDisplay('95/5 at 0-15 min, 5/95 at 15.1-24 min').steps[0].time, '0–15')
  assert.equal(liquidProgramDisplay('50:50 isocratic').elution, 'isocratic')
  const partial = liquidProgramDisplay('0 min min 98% A, 2 min 80% A')
  assert.equal(partial.steps[0].percentage_B, null)
  assert.equal(partial.elution, 'gradient')
  for (const ambiguous of ['95/5 at 0 min, see attachment', '95/10 at 0 min', '50/50 at 5 min, 95/5 at 3 min'])
    assert.deepEqual(liquidProgramDisplay(ambiguous).steps, [])
})

test('object-form LDS mobile phases preserve solvent values', () => {
  const value = mobilePhaseDisplay({phase_A:JSON.stringify([
    {field:'SolventA',value:'water with 0.1% formic acid (pH2.7)'},
    {field:'SolventB',value:'acetonitrile with 0.1% formic acid'}])})
  assert.equal(value.phase_A,'water with 0.1% formic acid (pH2.7)')
  assert.equal(value.phase_B,'acetonitrile with 0.1% formic acid')
})
