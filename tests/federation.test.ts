import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  pageWindow,
  refKey,
  sourceKey,
  sourceMatches,
  validateConnection,
  sqlIdentifier
} from '../src/shared/federation.ts'
import { encodePackage, decodePackage } from '../src/shared/dataPackage.ts'
test('connection-scoped keys distinguish repeated numeric IDs and arbitrary stable keys', () => {
  assert.notEqual(refKey({ connectionId: 'A', key: '1' }), refKey({ connectionId: 'B', key: '1' }))
  assert.notEqual(refKey({ connectionId: 'A', key: '01' }), refKey({ connectionId: 'A', key: '1' }))
  assert.equal(refKey({ connectionId: 'A', key: 'uuid-xyz' }), '["A","uuid-xyz"]')
})
test('fuzzy text applies without picks; exact OR choices take precedence over further typing', () => {
  const a = { id: sourceKey('one', '中药药典'), name: '中药药典', sourceType: 'public' },
    b = { id: sourceKey('two', '中药规范'), name: '中药规范', sourceType: 'local' }
  assert.equal(sourceMatches(a, '中药', []), true)
  assert.equal(sourceMatches(b, '中药', []), true)
  assert.equal(sourceMatches(a, '无匹配', []), false)
  assert.equal(sourceMatches(a, '', []), true)
  assert.equal(sourceMatches(a, '其他输入', [a.id]), true)
  assert.equal(sourceMatches(b, '中药', [a.id]), false)
  assert.notEqual(sourceKey('one', '同名', '甲'), sourceKey('two', '同名', '甲'))
  assert.notEqual(sourceKey('one', '同名', '甲'), sourceKey('one', '同名', '乙'))
})
test('federated pagination crosses connection boundaries without repeats', () => {
  assert.deepEqual(pageWindow([2, 4, 1], 1, 3), [
    { index: 0, offset: 0, limit: 2 },
    { index: 1, offset: 0, limit: 1 }
  ])
  assert.deepEqual(pageWindow([2, 4, 1], 2, 3), [{ index: 1, offset: 1, limit: 3 }])
  assert.deepEqual(pageWindow([2, 4, 1], 3, 3), [{ index: 2, offset: 0, limit: 1 }])
  assert.deepEqual(pageWindow([0, 0], 1, 50), [])
  assert.throws(() => pageWindow([1], 0, 50))
})
test('external mapping remains read-only and rejects executable identifiers', () => {
  const entry = {
    id: 'A',
    name: '外部库',
    host: '127.0.0.1',
    port: 3306,
    user: 'reader',
    database: 'external',
    adapter: 'mapped' as const,
    enabled: true,
    writable: false,
    mapping: { table: 'records', key: 'uuid', fields: { name_zh: 'title' } }
  }
  validateConnection(entry)
  assert.throws(() => validateConnection({ ...entry, writable: true }))
  assert.throws(() =>
    validateConnection({ ...entry, mapping: { ...entry.mapping, table: 'records;DROP TABLE x' } })
  )
  assert.throws(() => sqlIdentifier('x` WHERE 1=1'))
})
test('new bilingual and LC fields round-trip without filling missing scientific data', () => {
  const data = {
    formatVersion: 2 as const,
    schemaVersion: 2 as const,
    packageId: 'unit-v3-fields',
    mappingVersion: '2.1',
    groups: [
      {
        source: {
          namespace: 'unit',
          key: '1',
          sourceType: 'public' as const,
          location: '本地测试文件'
        },
        compound: { name_zh: '中文', name_en: 'English' },
        methods: [{ transition_role: 'qualifier', ce: -15, dp: 0 }],
        lcMethods: [
          {
            column_type: '测试柱',
            column_length_mm: '100.000',
            column_inner_diameter_mm: '2.100',
            column_particle_size_um: '1.700',
            column_temperature_c: 0,
            phase_A: '水；测试条件',
            phase_B: '乙腈；测试条件',
            elution_mode: 'gradient',
            program_text: '仅供软件测试',
            items: []
          }
        ]
      }
    ]
  }
  assert.deepEqual(decodePackage(encodePackage(data)).groups, data.groups)
  assert.throws(() =>
    encodePackage({
      ...data,
      groups: [{ ...data.groups[0], lcMethods: [{ column_length_mm: -1 }] }]
    })
  )
})
