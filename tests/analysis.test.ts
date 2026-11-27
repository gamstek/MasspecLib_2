import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectionDemo } from '../src/shared/analysis/demo.ts'
import { normalizeDetectionPackage, tabularPackage } from '../src/shared/analysis/input.ts'
import {
  analysePackage,
  analysePeak,
  analyseRatio,
  analyseLimit,
  filterResults,
  summarize
} from '../src/shared/analysis/engine.ts'
import { ENGINE_VERSION } from '../src/shared/analysis/types.ts'
import type { DetectionRow, StoredBatch } from '../src/shared/analysis/types.ts'
import { AnalysisStore, resultCsv } from '../src/main/analysis/store.ts'
function first(): DetectionRow {
  return detectionDemo().results[0]
}
function batch(): StoredBatch {
  const input = normalizeDetectionPackage(detectionDemo())
  return {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    createdAt: new Date().toISOString(),
    input,
    results: analysePackage(input),
    reviews: [],
    sourceName: 'demo',
    sourceHash: 'demo-hash',
    engineVersion: ENGINE_VERSION
  }
}
test('synthetic examples exercise fronting, tailing, split peaks and independently combined anomalies', () => {
  const results = analysePackage(normalizeDetectionPackage(detectionDemo()))
  assert.equal(results.length, 15)
  assert.equal(results[0].peak.state, 'pass')
  assert.equal(results[0].ratio.state, 'pass')
  assert.equal(results[0].limit.state, 'pass')
  assert.equal(results[0].abnormal, false)
  assert(results[1].peak.flags.includes('fronting'))
  assert(results[2].peak.flags.includes('tailing'))
  assert(results[3].peak.flags.includes('split'))
  assert.equal(results[4].limit.state, 'fail')
  assert.equal(results[5].ratio.state, 'fail')
  assert(results[6].peak.flags.includes('tailing'))
  assert.equal(results[6].limit.state, 'fail')
  assert.equal(results[6].ratio.state, 'fail')
  assert.equal(results[7].peak.state, 'unknown')
  assert.equal(results[8].limit.state, 'unknown')
  assert.equal(results[9].ratio.state, 'unknown')
  assert.equal(results[10].limit.state, 'unknown')
  assert(results[11].peak.flags.includes('saturation'))
  assert(results[12].peak.flags.includes('insufficient'))
  assert.equal(results[13].ratio.state, 'na')
  assert(results[14].peak.flags.includes('truncated'))
  assert.equal(results[14].peak.tailingFactor, null)
})
test('peak integration and factor use actual irregular time coordinates; seconds normalize to minutes', () => {
  const row = first()
  row.integration = { start: 0, end: 5 }
  row.trace = {
    timeUnit: 'min',
    points: [
      [0, 0],
      [0.1, 1],
      [0.4, 4],
      [1, 10],
      [2, 7.5],
      [4, 2.5],
      [5, 0]
    ].map(([time, intensity]) => ({ time, intensity }))
  }
  const a = analysePeak(row, { minPoints: 5 })
  assert.equal(a.area, 25)
  assert(Math.abs(a.tailingFactor! - 2.5) < 1e-12)
  row.trace = { timeUnit: 's', points: row.trace.points.map((p) => ({ ...p, time: p.time * 60 })) }
  const b = analysePeak(row, { minPoints: 5 })
  assert.equal(b.area, a.area)
  assert.equal(b.tailingFactor, a.tailingFactor)
})
test('shape is not passed without method rules or target peak confirmation', () => {
  const row = first()
  assert.equal(analysePeak(row).state, 'unknown')
  delete row.expectedRt
  delete row.rtWindow
  assert.equal(analysePeak(row, detectionDemo().peakRules).state, 'warn')
})
test('ratio uses relative deviation and inclusive tolerance boundaries', () => {
  const row = first()
  row.ratio!.qualifierArea = 70000
  let result = analyseRatio(row)
  assert.equal(result.state, 'fail')
  assert(Math.abs(result.deviationPct! - 40) < 1e-10)
  row.ratio!.qualifierArea = 65000
  result = analyseRatio(row)
  assert.equal(result.state, 'pass')
  row.ratio!.qualifierArea = 35000
  assert.equal(analyseRatio(row).state, 'pass')
  row.ratio!.qualifierArea = 34999
  assert.equal(analyseRatio(row).state, 'fail')
})
test('missing signal/reference is unknown, zero tolerance is respected, not-applicable is explicit', () => {
  const row = first()
  row.ratio!.quantifierArea = 0
  assert.equal(analyseRatio(row).state, 'unknown')
  row.ratio!.quantifierArea = 100000
  row.ratio!.tolerancePct = 0
  assert.equal(analyseRatio(row).state, 'pass')
  row.ratio!.qualifierArea = 50001
  assert.equal(analyseRatio(row).state, 'fail')
  row.ratio!.referenceSource = ''
  assert.equal(analyseRatio(row).state, 'unknown')
  row.ratio = { required: false }
  assert.equal(analyseRatio(row).state, 'na')
})
test('imported and computed areas are not mixed; paired comparable traces can compute a ratio', () => {
  const row = first()
  delete row.ratio!.qualifierArea
  row.qualifierTrace = structuredClone(row.trace)
  assert.equal(analyseRatio(row).state, 'unknown')
  delete row.ratio!.quantifierArea
  row.qualifierTrace!.points = row.qualifierTrace!.points.map((p) => ({
    ...p,
    intensity: p.intensity / 2
  }))
  const result = analyseRatio(row)
  assert.equal(result.areaSource, 'trace')
  assert.equal(result.state, 'pass')
  assert(Math.abs(result.value! - 0.5) < 1e-12)
})
test('limit comparisons normalize mass units, preserve zero, equality and dimension incompatibility', () => {
  const row = first()
  row.measurement = { value: 10, unit: 'μg/kg' }
  assert.equal(analyseLimit(row).state, 'pass')
  row.measurement.value = 11
  assert.equal(analyseLimit(row).state, 'fail')
  row.measurement = { value: 0, unit: 'mg/kg' }
  row.limit!.value = 0
  assert.equal(analyseLimit(row).state, 'pass')
  row.measurement.value = 1e-12
  assert.equal(analyseLimit(row).state, 'fail')
  row.measurement = { value: 1, unit: 'mg/L' }
  assert.equal(analyseLimit(row).state, 'unknown')
})
test('unmatched matrices, missing limits and censored measurements are never defaulted to pass', () => {
  const row = first()
  row.limit!.matrix = '其他基质'
  assert.equal(analyseLimit(row).state, 'unknown')
  row.limit!.matrix = row.matrix
  for (const modifier of ['ND', 'ltLOQ', 'ltLOD'] as const) {
    row.measurement!.modifier = modifier
    assert.equal(analyseLimit(row).state, 'unknown')
  }
  delete row.limit
  assert.equal(analyseLimit(row).state, 'unknown')
})
test('package validation rejects malformed time series, ambiguous units, duplicate IDs and missing names', () => {
  const p = detectionDemo()
  p.results[0].trace!.points[1].time = 0
  assert.throws(() => normalizeDetectionPackage(p), /严格递增/)
  const u = detectionDemo()
  ;(u.results[0].trace as unknown as Record<string, unknown>).timeUnit = 'unknown'
  assert.throws(() => normalizeDetectionPackage(u), /timeUnit/)
  const d = detectionDemo()
  d.results[1].id = d.results[0].id
  assert.throws(() => normalizeDetectionPackage(d), /ID重复/)
  const n = detectionDemo()
  n.results[0].sample = ''
  assert.throws(() => normalizeDetectionPackage(n), /样品/)
})
test('rules and non-finite values are validated; unknown limits may be omitted without rejecting other checks', () => {
  const p = detectionDemo()
  p.peakRules!.tailingMin = 2
  assert.throws(() => normalizeDetectionPackage(p), /上下界/)
  const n = detectionDemo()
  n.results[0].ratio!.reference = Number.NaN
  assert.throws(() => normalizeDetectionPackage(n), /参考离子比/)
  const missing = detectionDemo()
  delete missing.results[0].limit
  assert.equal(analysePackage(normalizeDetectionPackage(missing))[0].limit.state, 'unknown')
})
test('Chinese and English tabular headers preserve zero and reject mixed method metadata', () => {
  const rows = [
    {
      sample: 'S1',
      compound: 'C1',
      concentration: 0,
      unit: 'mg/kg',
      limit: 0,
      limit_unit: 'mg/kg',
      limit_source: '示例规则',
      ratio_required: 'false'
    }
  ]
  const p = tabularPackage(rows, 'CSV批次')
  assert.equal(p.results[0].measurement!.value, 0)
  assert.equal(p.results[0].limit!.value, 0)
  assert.equal(analysePackage(p)[0].ratio.state, 'na')
  assert.equal(analysePackage(p)[0].limit.state, 'pass')
  assert.throws(
    () =>
      tabularPackage(
        [
          { 样品: 'S', 化合物: 'C', 方法名称: 'A' },
          { 样品: 'S2', 化合物: 'C', 方法名称: 'B' }
        ],
        'mixed'
      ),
    /多个方法/
  )
})
test('compound filters combine with all anomaly filters without duplicating multi-anomaly results', () => {
  const b = batch()
  assert.equal(
    filterResults(b, { sample: '演示样品7', peak: 'tailing', limit: 'fail', ratio: 'fail' }).length,
    1
  )
  const abnormal = filterResults(b, { view: 'abnormal' })
  assert.equal(new Set(abnormal.map((r) => r.id)).size, abnormal.length)
  assert.equal(filterResults(b, { limit: 'fail', ratio: 'pass' }).length, 1)
  const before = summarize(b).pending
  b.reviews.push({
    resultId: 'DEMO-07',
    action: 'reviewed',
    reason: '已核对',
    reviewer: '测试',
    at: new Date().toISOString()
  })
  assert.equal(summarize(b).pending, before - 1)
  assert.equal(filterResults(b, { review: 'reviewed' }).length, 1)
  assert.equal(filterResults(b, { review: 'reviewed' })[0].abnormal, true)
})
test('batch storage persists inputs and audit history, deduplicates imports, and rejects stale reviews and unsafe paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'masspeclib2-analysis-test-'))
  try {
    const store = new AnalysisStore(directory),
      b = batch()
    const created = await store.create(b.input, b.results, 'demo.json', 'same-hash')
    assert.equal(created.duplicate, false)
    assert.equal(
      (await store.create(b.input, b.results, 'other.json', 'same-hash')).duplicate,
      true
    )
    await store.review(created.id, 1, {
      resultId: 'DEMO-07',
      action: 'exclude',
      reason: '干扰需重测',
      reviewer: '测试者'
    })
    const reloaded = await new AnalysisStore(directory).get(created.id)
    assert.equal(reloaded.revision, 2)
    assert.equal(reloaded.reviews.length, 1)
    assert.equal(reloaded.results.find((r) => r.id === 'DEMO-07')!.limit.state, 'fail')
    assert.equal(reloaded.input.results[0].trace!.points.length, 501)
    await assert.rejects(
      store.review(created.id, 1, {
        resultId: 'DEMO-07',
        action: 'reviewed',
        reason: '旧版本',
        reviewer: '测试者'
      }),
      /已更新/
    )
    await assert.rejects(store.get('../outside'), /标识无效/)
    await assert.rejects(
      store.review(created.id, 2, {
        resultId: 'DEMO-07',
        action: 'reviewed',
        reason: '',
        reviewer: '测试者'
      }),
      /理由/
    )
    assert.equal((await store.list()).batches.length, 1)
    const contents = await readFile(join(directory, created.id + '.json'), 'utf8')
    assert.equal(JSON.parse(contents).reviews[0].reason, '干扰需重测')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test('filtered CSV retains anomaly/review evidence and escapes spreadsheet formula injection', () => {
  const b = batch()
  b.results[0].sample = '=HYPERLINK("bad")'
  const csv = resultCsv(b, { sample: '=HYPERLINK' })
  assert(csv.startsWith('\uFEFF'))
  assert(csv.includes("'=HYPERLINK"))
  assert(csv.includes('数据文件SHA256'))
  assert(!csv.includes('DEMO-07'))
})

test('complete archive revalidates computed results and restores review history without overwriting local edits', async () => {
  const { exportArchive, readArchive } = await import('../src/main/analysis/archive.ts')
  const directory = await mkdtemp(join(tmpdir(), 'masspeclib2-archive-test-'))
  try {
    const original = batch()
    original.sourceHash = 'a'.repeat(64)
    original.reviews.push({
      resultId: 'DEMO-07',
      action: 'retest',
      reason: '干扰需复测',
      reviewer: '测试者',
      at: new Date().toISOString()
    })
    original.revision = 2
    const restored = readArchive(JSON.parse(exportArchive(original)))
    assert.equal(restored.reviews.length, 1)
    const store = new AnalysisStore(directory)
    assert.equal((await store.restore(restored)).duplicate, false)
    await store.review(restored.id, 2, {
      resultId: 'DEMO-07',
      action: 'reviewed',
      reason: '已复测',
      reviewer: '复核者'
    })
    assert.equal((await store.restore(restored)).duplicate, true)
    assert.equal((await store.get(restored.id)).reviews.length, 2)
    const damaged = JSON.parse(exportArchive(original))
    damaged.batch.results[0].limit.state = 'fail'
    assert.throws(() => readArchive(damaged), /校验失败/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test(
  'dense local noise remains bounded and cannot create non-finite stored metrics',
  { timeout: 5000 },
  () => {
    const row = normalizeDetectionPackage(detectionDemo()).results[0]
    row.expectedRt = 5
    row.rtWindow = 5
    row.trace = {
      timeUnit: 'min',
      points: Array.from({ length: 100000 }, (_, i) => ({
        time: (i * 10) / 99999,
        intensity: i === 0 || i === 99999 ? 0 : 0.9 + (i % 4) * 0.03
      }))
    }
    const result = analysePeak(row, {
      tailingMin: 0.8,
      tailingMax: 1.6,
      splitMinRelativeHeight: 0.25,
      splitMaxValleyFraction: 0.5,
      splitMinDistanceMin: 0.1
    })
    assert.equal(result.pointCount, 100000)
    assert(!result.flags.includes('split'))
    assert(Number.isFinite(result.area))
    row.trace.points[1].intensity = -1e308
    row.trace.points[2].intensity = 1e308
  row.trace.points[3].intensity = 1e308
    const invalid = analysePeak(row)
    assert.equal(invalid.state, 'unknown')
    assert.equal(invalid.area, null)
  }
)

test('tabular batch metadata accepts one consistent nonempty value after a blank first row', () => {
  const result = tabularPackage(
    [
      { 样品: '一', 化合物: '甲' },
      { 样品: '二', 化合物: '乙', 批次名称: '实际批次', 方法名称: '实际方法', 规则版本: 'v1' }
    ],
    '文件名'
  )
  assert.equal(result.batchName, '实际批次')
  assert.equal(result.methodName, '实际方法')
  assert.equal(result.ruleVersion, 'v1')
})
