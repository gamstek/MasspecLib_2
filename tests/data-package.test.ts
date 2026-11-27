import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate'
import {
  encodePackage,
  decodePackage,
  validatePackage,
  contentHash,
  hasEntityProvenance,
  type DataPackage
} from '../src/shared/dataPackage.ts'
function example(): DataPackage {
  return JSON.parse(readFileSync('examples/synthetic-source.json', 'utf8'))
}

test('v2 round-trip preserves duplicate m/z, decimal text, high intensity, negative energy, zero and unknown units', () => {
  const data = example()
  assert.deepEqual(decodePackage(encodePackage(data)).groups, data.groups)
  assert.equal(data.groups[0].spectra?.[0].peaks[0].mz, '100.0000000001')
  assert.equal(data.groups[0].methods?.[0].ce, -15)
})
test('canonical hashes ignore JSON property order and preserve missing/null/zero distinctions', () => {
  assert.equal(contentHash({ a: 1, b: null }), contentHash({ b: null, a: 1 }))
  assert.notEqual(contentHash({ a: null }), contentHash({}))
  assert.notEqual(contentHash({ a: 0 }), contentHash({ a: null }))
})
test('duplicate source keys, missing method references and guessed invalid numeric fields are rejected', () => {
  const duplicate = example()
  duplicate.groups.push(structuredClone(duplicate.groups[0]))
  assert.throws(() => validatePackage(duplicate))
  const reference = example()
  reference.groups[0].spectra![0].methodLocalIds = ['absent']
  assert.throws(() => validatePackage(reference))
  const invalid = example()
  invalid.groups[0].methods![0].ce = ''
  assert.throws(() => validatePackage(invalid))
})
test('tampered content, unknown file paths and malformed packages are rejected', () => {
  const files = unzipSync(encodePackage(example()))
  const group = JSON.parse(strFromU8(files['groups.ndjson']))
  group.compound.main_name = 'tampered'
  files['groups.ndjson'] = strToU8(JSON.stringify(group))
  assert.throws(() => decodePackage(zipSync(files)))
  assert.throws(() => decodePackage(zipSync({ '../outside': strToU8('unexpected') })))
  assert.throws(() => decodePackage(strToU8('{bad-json')))
})
test('legacy v1 keeps missing fields and the full original record without CAS/name overwrite matching', () => {
  const original = {
    id: 7,
    main_name: '旧包测试',
    name: [],
    cas: null,
    ms_methods: [{ id: 8, q1: null, q3: null, ce: -10 }],
    lc_methods: []
  }
  const data = decodePackage(
    strToU8(JSON.stringify({ exportVersion: '1.0', compounds: [original] }))
  )
  assert.deepEqual(data.groups[0].raw, original)
  assert.equal(data.groups[0].methods?.[0].q3, null)
  assert.equal(data.groups[0].methods?.[0].ce, -10)
})
test('images are separate from peaks and MIME must agree with bytes', () => {
  const data = example()
  data.groups[0].spectra = [
    {
      kind: 'image',
      image_base64: Buffer.from('not png').toString('base64'),
      image_mime: 'image/png'
    }
  ]
  assert.throws(() => validatePackage(data))
})

test('legacy empty strings and a string alias remain traceable without filling scientific values', () => {
  const original = {
    id: 9,
    main_name: '旧记录',
    name: '',
    cas: '',
    formula: '',
    ms_methods: [],
    lc_methods: []
  }
  const data = decodePackage(
    strToU8(JSON.stringify({ exportVersion: '1.0', compounds: [original] }))
  )
  assert.equal(data.groups[0].compound.cas, '')
  assert.deepEqual(data.groups[0].raw, original)
})

test('entity-specific scientific origins supersede package origin only for a valid exact entity reference', () => {
  const group = example().groups[0]
  group.provenance = [{ appliesTo: 'spectrum', entityId: 'sp:one', source_record: {
    library: { namespace: 'official:lab', name: 'Official laboratory' }
  } }]
  assert.equal(hasEntityProvenance(group, 'spectrum', 'sp:one'), true)
  assert.equal(hasEntityProvenance(group, 'spectrum', 'sp:other'), false)
  assert.equal(hasEntityProvenance(group, 'ms_method', 'sp:one'), false)
  assert.equal(hasEntityProvenance(group, 'spectrum', undefined), false)
  group.provenance[0].source_record.library.namespace = 'database-record:internal'
  assert.equal(hasEntityProvenance(group, 'spectrum', 'sp:one'), false)
  group.provenance[0].source_record.library = { namespace: 'official:lab' }
  assert.equal(hasEntityProvenance(group, 'spectrum', 'sp:one'), false)
})
