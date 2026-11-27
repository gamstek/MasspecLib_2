import { createHash } from 'node:crypto'
import type { StoredBatch } from '../../shared/analysis/types.ts'
import { ENGINE_VERSION } from '../../shared/analysis/types.ts'
import { normalizeDetectionPackage } from '../../shared/analysis/input.ts'
import { analysePackage } from '../../shared/analysis/engine.ts'
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function exportArchive(batch: StoredBatch): string {
  return JSON.stringify({ archiveVersion: 1, checksum: digest(batch), batch }, null, 2)
}
export function readArchive(value: unknown): StoredBatch {
  const archive = value as { archiveVersion?: unknown; checksum?: unknown; batch?: StoredBatch }
  const batch = archive?.batch
  if (archive?.archiveVersion !== 1 || !batch || archive.checksum !== digest(batch))
    throw new Error('批次备份校验失败或格式不支持')
  if (![ENGINE_VERSION, '1.0.0'].includes(batch.engineVersion))
    throw new Error('备份的分析引擎版本不同，请使用原始检测数据重新分析')
  if (
    !/^[a-f0-9-]{36}$/.test(batch.id) ||
    !/^[a-f0-9]{64}$/.test(batch.sourceHash) ||
    !Number.isSafeInteger(batch.revision) ||
    batch.revision < 1 ||
    !Number.isFinite(Date.parse(batch.createdAt)) ||
    typeof batch.sourceName !== 'string' ||
    batch.sourceName.length > 500
  )
    throw new Error('备份批次元数据无效')
  const input = normalizeDetectionPackage(batch.input),
    results = analysePackage(input)
  if (digest(results) !== digest(batch.results))
    throw new Error('备份自动判定与输入数据不一致，拒绝恢复')
  if (
    !Array.isArray(batch.reviews) ||
    batch.reviews.length > 10000 ||
    batch.revision !== batch.reviews.length + 1 ||
    batch.reviews.some(
      (r) =>
        !results.some((row) => row.id === r.resultId) ||
        !['reviewed', 'retest', 'exclude'].includes(r.action) ||
        typeof r.reason !== 'string' ||
        !r.reason.trim() ||
        r.reason.length > 2000 ||
        typeof r.reviewer !== 'string' ||
        !r.reviewer.trim() ||
        r.reviewer.length > 100 ||
        !Number.isFinite(Date.parse(r.at))
    )
  )
    throw new Error('备份复核记录无效')
  return { ...batch, input, results }
}
