import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import XLSX from 'xlsx'
import { detectionDemo } from '../src/shared/analysis/demo.ts'
import { normalizeDetectionPackage, CSV_HEADERS } from '../src/shared/analysis/input.ts'
import { analysePackage } from '../src/shared/analysis/engine.ts'
const directory = resolve(process.argv[2] ?? 'examples/analysis')
mkdirSync(directory, { recursive: true })
const data = normalizeDetectionPackage(detectionDemo()),
  results = analysePackage(data)
writeFileSync(join(directory, '检测结果演示_15条.json'), JSON.stringify(data, null, 2) + '\n')
const rows = data.results.map((r) => [
  r.id,
  r.sample,
  r.compound,
  r.matrix ?? '',
  r.expectedRt ?? '',
  r.rtWindow ?? '',
  r.measurement?.value ?? '',
  r.measurement?.unit ?? '',
  r.measurement?.modifier ?? 'value',
  r.measurement?.loq ?? '',
  r.limit?.value ?? '',
  r.limit?.unit ?? '',
  r.limit?.source ?? '',
  r.ratio?.quantifierArea ?? '',
  r.ratio?.qualifierArea ?? '',
  r.ratio?.reference ?? '',
  r.ratio?.tolerancePct ?? '',
  r.ratio?.referenceSource ?? '',
  r.ratio?.required === false ? '否' : '是',
  r.trace ? JSON.stringify(r.trace) : '',
  r.qualifierTrace ? JSON.stringify(r.qualifierTrace) : '',
  JSON.stringify({ ...data.peakRules, ...r.peakRules }),
  data.batchName,
  data.methodName,
  data.ruleVersion,
  '是'
])
// Integration-window clipping has no column in this concise table template. Preserve the
// corresponding case's evaluation window through its RT fields instead.
rows[14][4] = 5
rows[14][5] = 0.2
const sheet = XLSX.utils.aoa_to_sheet([CSV_HEADERS, ...rows])
const workbook = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(workbook, sheet, '结果')
XLSX.writeFile(workbook, join(directory, '检测结果演示_15条.xlsx'))
writeFileSync(
  join(directory, '检测结果演示_15条.csv'),
  '\uFEFF' + XLSX.utils.sheet_to_csv(sheet),
  'utf8'
)
writeFileSync(
  join(directory, '演示预期结果.json'),
  JSON.stringify(
    results.map((r) => ({
      id: r.id,
      sample: r.sample,
      peak: r.peak.state,
      flags: r.peak.flags,
      limit: r.limit.state,
      ratio: r.ratio.state,
      labels: r.labels
    })),
    null,
    2
  ) + '\n'
)
console.log(
  JSON.stringify({
    directory,
    records: results.length,
    abnormal: results.filter((r) => r.abnormal).length,
    incomplete: results.filter((r) => r.incomplete).length,
    templates: ['json', 'csv', 'xlsx']
  })
)
