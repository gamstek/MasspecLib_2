import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  transitionText,
  productIonText,
  methodTransitionText,
  methodLabel,
  energyMethodText,
  energyTypeText,
  acquisitionRows,
  type SpectrumDisplay
} from '../src/shared/scientificDisplay.ts'

test('a scan mode alone never asserts the existence of fragment peaks', () => {
  for (const mode of ['MS2', 'MS/MS', 'LC-MS/MS', 'MS1', 'MRM', undefined]) {
    assert.equal(transitionText('329.065', null, mode), '329.065 → 固定Q3未指定')
    assert.equal(transitionText(null, null, mode), '未提供 → 固定Q3未指定')
  }
  assert.equal(transitionText(329.065, 311.055, 'MRM'), '329.065 → 311.055')
  assert.equal(transitionText(329.065, 0, 'SRM'), '329.065 → 0')
})

test('fragment counts require real linked numeric MS2 spectra and preserve duplicate peak records', () => {
  const method = { id: 1, ms_mode: 'Q-Exactive', scan_mode: 'MS2', q1: '329.065000', q3: null }
  const spectra: SpectrumDisplay[] = [
    {
      kind: 'numeric',
      spectrum_type: 'MS2',
      methodIds: ['1'],
      peaks: [
        { mz: '100.100', intensity: '20' },
        { mz: '100.100', intensity: '0' }
      ]
    },
    {
      kind: 'numeric',
      spectrum_type: 'MS2',
      methodIds: [2],
      peaks: [{ mz: '200', intensity: '5' }]
    }
  ]
  const before = JSON.stringify(spectra)
  assert.equal(methodTransitionText(method, spectra), '329.065 → MS2碎片谱峰 2 条；固定Q3未指定')
  assert.equal(
    methodLabel(method, spectra),
    'Q-Exactive · MS2 · 329.065 → MS2碎片谱峰 2 条；固定Q3未指定'
  )
  assert.equal(methodTransitionText({ ...method, id: 3 }, spectra), '329.065 → 固定Q3未指定')
  assert.equal(
    methodTransitionText({ ...method, id: undefined }, spectra),
    '329.065 → 固定Q3未指定'
  )
  assert.equal(methodTransitionText({ ...method, q3: '311.055000' }, spectra), '329.065 → 311.055')
  assert.equal(JSON.stringify(spectra), before)
})

test('empty, image, MS1, unknown type and invalid peaks are not counted as MS2 fragments', () => {
  const peak = { mz: '100', intensity: '1' }
  const spectra: SpectrumDisplay[] = [
    { kind: 'image', spectrum_type: 'MS2', peaks: [peak] },
    { kind: 'numeric', spectrum_type: 'MS1', peaks: [peak] },
    { kind: 'numeric', spectrum_type: null, peaks: [peak] },
    { kind: 'numeric', spectrum_type: 'MS2', peaks: [] },
    {
      kind: 'numeric',
      spectrum_type: 'MS2',
      peaks: [
        { mz: '', intensity: 1 },
        { mz: null, intensity: 1 },
        { mz: '100', intensity: '' },
        { mz: '100', intensity: 'NaN' },
        { mz: '100', intensity: -1 },
        { mz: 0, intensity: 1 }
      ]
    }
  ]
  assert.equal(transitionText('329.065', null, 'MS2', spectra), '329.065 → 固定Q3未指定')
  assert.equal(
    transitionText('329.065', null, 'MS2', [
      { kind: 'numeric', spectrum_type: 'MS/MS', peaks: [peak] }
    ]),
    '329.065 → MS2碎片谱峰 1 条；固定Q3未指定'
  )
})

test('method energy and its type have readable labels without changing stored values', () => {
  assert.equal(energyMethodText('20', 'NCE', 'normalized'), '20 NCE（归一化）')
  assert.equal(energyMethodText(0, 'eV', 'fixed'), '0 eV')
  assert.equal(energyMethodText(null, 'NCE', 'normalized'), '未提供')
  assert.equal(energyTypeText('normalized'), '归一化')
  assert.equal(energyTypeText('fixed'), '固定能量')
  assert.equal(energyTypeText('vendor-specific'), 'vendor-specific')
  assert.equal(energyTypeText(null), '未提供')
})

test('recognized confidence declarations are separate from ordinary source notes', () => {
  const conditions = {
    source_accession: 'MSBNK-AAFC-AC000032',
    source_comments: ['仪器维护后采集', 'CONFIDENCE Reference Standard (Level 1)', '另一条备注']
  }
  const before = JSON.stringify(conditions)
  assert.deepEqual(acquisitionRows(conditions), [
    { label: '原始记录编号', value: 'MSBNK-AAFC-AC000032' },
    { label: '数据置信度（来源声明）', value: 'CONFIDENCE Reference Standard (Level 1)' },
    { label: '来源备注', value: '仪器维护后采集；另一条备注' }
  ])
  assert.equal(JSON.stringify(conditions), before)
  assert.deepEqual(acquisitionRows({ source_comments: ['仪器维护后采集'] }), [
    { label: '来源备注', value: '仪器维护后采集' }
  ])
  assert.deepEqual(
    acquisitionRows({ source_comments: '未做验证', confidence: '来源自报Level 2' }),
    [
      { label: '数据置信度（来源声明）', value: '来源自报Level 2' },
      { label: '来源备注', value: '未做验证' }
    ]
  )
})

test('one acquisition mode is shown with method value taking precedence and raw fallback retained', () => {
  const conditions = { scan_mode: 'MS1', original_mass_spectrometry: { MS_TYPE: ['MS2'] } }
  assert.deepEqual(acquisitionRows(conditions, 'MRM'), [{ label: '采集模式', value: 'MRM' }])
  assert.deepEqual(acquisitionRows({ original_mass_spectrometry: { MS_TYPE: ['MS2'] } }), [
    { label: '采集模式', value: 'MS2' }
  ])
  assert.deepEqual(acquisitionRows(null, 'SRM'), [{ label: '采集模式', value: 'SRM' }])
  assert.deepEqual(acquisitionRows('旧仪器原文', 'MS1'), [
    { label: '采集模式', value: 'MS1' },
    { label: '条件说明', value: '旧仪器原文' }
  ])
})

test('the concise product column distinguishes fixed ions from actual MS2 peak counts', () => {
  const spectra = [
    { kind: 'numeric', spectrum_type: 'MS2', peaks: [{ mz: '100', intensity: '0' }] }
  ]
  assert.equal(productIonText('311.055000', spectra), '311.055')
  assert.equal(productIonText(0, spectra), '0')
  assert.equal(productIonText(null, spectra), '1 条MS2谱峰')
  assert.equal(productIonText(null, []), '未提供')
  assert.equal(productIonText(null, [{ ...spectra[0], kind: 'image' }]), '未提供')
})
