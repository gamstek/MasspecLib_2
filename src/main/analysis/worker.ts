import { readArchive } from './archive'
import type { StoredBatch } from '../../shared/analysis/types'
import type { DetectionResult } from '../../shared/analysis/types'
import { parentPort, workerData } from 'node:worker_threads'
import { readFile, stat } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { normalizeDetectionPackage, tabularPackage } from '../../shared/analysis/input'
import { analyseRow } from '../../shared/analysis/engine'
import { detectionDemo } from '../../shared/analysis/demo'
async function run(): Promise<void> {
  let value: unknown, sourceHash: string
  if (workerData.demo) {
    value = detectionDemo()
    sourceHash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
  } else {
    const path = String(workerData.path)
    if ((await stat(path)).size > 32 * 1024 * 1024)
      throw new Error('检测文件超过32 MiB，请分批导入')
    const buffer = await readFile(path)
    sourceHash = createHash('sha256').update(buffer).digest('hex')
    if (extname(path).toLowerCase() === '.json')
      value = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
    else {
      const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, sheetRows: 1002 })
      const sheet = workbook.Sheets['结果'] ?? workbook.Sheets[workbook.SheetNames[0]]
      if (!sheet) throw new Error('工作簿没有结果表')
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
      if (rows.length > 1000) throw new Error('每批最多1000条结果，请分批导入')
      value = tabularPackage(rows, basename(path, extname(path)))
    }
  }
  let restoredBatch: StoredBatch | undefined
  if (value && typeof value === 'object' && 'archiveVersion' in value) {
    restoredBatch = readArchive(value)
    value = restoredBatch.input
  }
  const input = normalizeDetectionPackage(value)
  const results: DetectionResult[] = []
  for (const [index, row] of input.results.entries()) {
    results.push(analyseRow(row, input.peakRules))
    if (index % 10 === 0 || index === input.results.length - 1)
      parentPort?.postMessage({
        kind: 'progress',
        progress: Math.round(((index + 1) / input.results.length) * 100)
      })
  }
  parentPort?.postMessage({ kind: 'done', input, results, sourceHash, restoredBatch })
}
run().catch((error) =>
  parentPort?.postMessage({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error)
  })
)
