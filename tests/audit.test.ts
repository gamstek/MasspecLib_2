import test from 'node:test'
import assert from 'node:assert/strict'
import {
  identityKey,
  applicableChecks,
  normalizeAuditRow,
  analyseAsset,
  safeImage,
  type AuditAsset
} from '../src/shared/audit.ts'
import { validateExportSelection, csvCell } from '../src/shared/exportFields.ts'
import { analyseRow } from '../src/shared/analysis/engine.ts'
import { normalizeDetectionPackage } from '../src/shared/analysis/input.ts'
const asset = (extra: Partial<AuditAsset>): AuditAsset => ({
  id: 'asset',
  ref: { connectionId: 'db', key: '1' },
  recordKey: 'record',
  kind: 'measurement',
  sources: [],
  methodName: 'm',
  batchName: 'b',
  ruleVersion: 'r',
  checks: [],
  fingerprint: 'f',
  ...extra
})
test('chemical identity requires full InChIKey and rejects conflict flags; CAS/name do not auto-merge', () => {
  const compound = {
    main_name: 'same',
    cas: '1',
    identifiers: { InChIKey: 'AAAAAAAAAAAAAA-BBBBBBBBBB-C' }
  }
  assert.equal(identityKey(compound), 'AAAAAAAAAAAAAA-BBBBBBBBBB-C')
  assert.equal(
    identityKey({ ...compound, properties: { identity_status: 'identity_conflict' } }),
    undefined
  )
  assert.equal(identityKey({ ...compound, identifiers: { inchikey: 'AAAAAAAAAAAAAA' } }), undefined)
  assert.equal(identityKey({ main_name: 'same', cas: '1' }), undefined)
})
test('reference spectra, images and incomplete measured results have different eligibility', () => {
  assert.equal(analyseAsset(asset({ kind: 'spectrum' })), null)
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const imageResult = analyseAsset(asset({ kind: 'chromatogram', image, checks: ['peak'] }))!
  assert.equal(imageResult.peak.state, 'unknown')
  assert.equal(imageResult.limit.state, 'na')
  assert.equal(imageResult.abnormal, false)
  assert.equal(imageResult.incomplete, true)
  const row = normalizeAuditRow({ measurement: { value: 2, unit: 'mg/kg' } }, '化合物')
  assert.deepEqual(applicableChecks(row), ['limit'])
  const result = analyseAsset(asset({ row, checks: ['limit'] }))!
  assert.equal(result.limit.state, 'unknown')
  assert.equal(result.peak.state, 'na')
  assert.equal(result.ratio.state, 'na')
  assert.deepEqual(applicableChecks(undefined, undefined, []), [])
  assert.throws(() => applicableChecks(undefined, undefined, ['guess']))
  assert.equal(safeImage('data:image/svg+xml;base64,AAA='), undefined)
})
test('multiple qualifier channels use their own rules; failure on any channel is retained', () => {
  const input = normalizeDetectionPackage({
    formatVersion: 1,
    batchName: 'b',
    methodName: 'm',
    ruleVersion: 'r',
    results: [
      {
        sample: 's',
        compound: 'c',
        ratio: { quantifierArea: 100 },
        qualifiers: [
          {
            channel: 'q1',
            ratio: { qualifierArea: 50, reference: 0.5, tolerancePct: 20, referenceSource: 'r1' }
          },
          {
            channel: 'q2',
            ratio: {
              qualifierArea: 90,
              reference: 0.5,
              toleranceMode: 'absolute',
              toleranceAbsolute: 0.1,
              referenceSource: 'r2'
            }
          }
        ]
      }
    ]
  })
  const result = analyseRow(input.results[0])
  assert.equal(result.ratio.state, 'fail')
  assert.equal(result.ratioChecks?.length, 2)
  assert.equal(result.ratioChecks?.[0].check.state, 'pass')
  assert.equal(result.ratioChecks?.[1].check.state, 'fail')
  const pass = analyseRow({
    id: '1',
    sample: 's',
    compound: 'c',
    ratio: {
      quantifierArea: 100,
      qualifierArea: 60,
      reference: 0.5,
      toleranceMode: 'absolute',
      toleranceAbsolute: 0.1,
      referenceSource: 'r'
    }
  })
  assert.equal(pass.ratio.state, 'pass')
})
test('selected export validates whitelist and CSV text cannot become a spreadsheet formula', () => {
  assert.deepEqual(validateExportSelection({ fields: ['cas', 'cas'], contents: [] }), {
    fields: ['cas'],
    contents: []
  })
  assert.throws(() => validateExportSelection({ fields: [], contents: [] }))
  assert.throws(() => validateExportSelection({ fields: ['password'], contents: [] }))
  assert.equal(csvCell('=SUM(1,2)'), '"\'=SUM(1,2)"')
  assert.equal(csvCell(-2), '"-2"')
  assert.equal(csvCell('a"b'), '"a""b"')
})
