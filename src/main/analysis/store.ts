import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AnalysisFilters,
  DetectionPackage,
  DetectionResult,
  ReviewAction,
  StoredBatch
} from '../../shared/analysis/types.ts'
import { ENGINE_VERSION, CHECK_LABELS, PEAK_LABELS } from '../../shared/analysis/types.ts'
import { filterResults, latestReviews, summarize } from '../../shared/analysis/engine.ts'
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error('检测批次标识无效')
  return value
}
export class AnalysisStore {
  private queue: Promise<unknown> = Promise.resolve()
  private directory: string
  constructor(directory: string) {
    this.directory = directory
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async save(batch: StoredBatch): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, id(batch.id) + '.json'),
      temporary = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify(batch), { mode: 0o600 })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  async get(batchId: string): Promise<StoredBatch> {
    const content = await readFile(join(this.directory, id(batchId) + '.json'), 'utf8')
    const batch = JSON.parse(content) as StoredBatch
    if (batch.id !== batchId || !Array.isArray(batch.results) || !batch.input)
      throw new Error('批次文件损坏，请从备份恢复')
    return batch
  }
  async list(): Promise<{ batches: ReturnType<typeof summarize>[]; warnings: string[] }> {
    await mkdir(this.directory, { recursive: true })
    const entries = (await readdir(this.directory)).filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name)
    )
    const batches: ReturnType<typeof summarize>[] = [],
      warnings: string[] = []
    for (const name of entries) {
      try {
        batches.push(summarize(await this.get(name.slice(0, -5))))
      } catch {
        warnings.push(`批次文件 ${name} 无法读取；原文件已保留`)
      }
    }
    return { batches: batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), warnings }
  }
  async create(
    input: DetectionPackage,
    results: DetectionResult[],
    sourceName: string,
    sourceHash: string
  ): Promise<{ id: string; duplicate: boolean }> {
    return this.serial(async () => {
      const entries = await this.list()
      for (const summary of entries.batches) {
        const previous = await this.get(summary.id)
        if (previous.sourceHash === sourceHash && previous.engineVersion === ENGINE_VERSION)
          return { id: summary.id, duplicate: true }
      }
      const batch: StoredBatch = {
        id: randomUUID(),
        revision: 1,
        createdAt: new Date().toISOString(),
        sourceName,
        sourceHash,
        engineVersion: ENGINE_VERSION,
        input,
        results,
        reviews: []
      }
      await this.save(batch)
      return { id: batch.id, duplicate: false }
    })
  }
  async restore(batch: StoredBatch): Promise<{ id: string; duplicate: boolean }> {
    return this.serial(async () => {
      const existing = await this.list()
      for (const entry of existing.batches) {
        const previous = await this.get(entry.id)
        if (entry.id === batch.id) {
          if (previous.sourceHash !== batch.sourceHash)
            throw new Error('备份批次标识与本机数据冲突，拒绝覆盖')
          return { id: entry.id, duplicate: true }
        }
        if (
          previous.sourceHash === batch.sourceHash &&
          previous.engineVersion === batch.engineVersion
        )
          return { id: entry.id, duplicate: true }
      }
      await this.save(batch)
      return { id: batch.id, duplicate: false }
    })
  }
  async results(batchId: string, filters: AnalysisFilters = {}): Promise<unknown> {
    const batch = await this.get(batchId),
      all = filterResults(batch, filters),
      reviews = latestReviews(batch)
    const page = Number(filters.page ?? 1),
      size = Number(filters.pageSize ?? 50)
    if (!Number.isSafeInteger(page) || page < 1 || ![20, 50, 100].includes(size))
      throw new Error('分页参数无效')
    const rows = all
      .slice((page - 1) * size, page * size)
      .map((r) => ({
        ...r,
        review: reviews.get(r.id) ?? null,
        measurement: batch.input.results.find((row) => row.id === r.id)?.measurement ?? null
      }))
    return { summary: summarize(batch), rows, total: all.length, page, pageSize: size }
  }
  async detail(batchId: string, resultId: string): Promise<unknown> {
    const batch = await this.get(batchId),
      row = batch.input.results.find((r) => r.id === resultId),
      result = batch.results.find((r) => r.id === resultId)
    if (!row || !result) throw new Error('未找到对应检测结果')
    return {
      row,
      result,
      reviews: batch.reviews.filter((r) => r.resultId === resultId),
      summary: summarize(batch),
      rules: { ...batch.input.peakRules, ...row.peakRules },
      sourceName: batch.sourceName,
      sourceHash: batch.sourceHash,
      engineVersion: batch.engineVersion
    }
  }
  async review(batchId: string, revision: number, review: Omit<ReviewAction, 'at'>): Promise<void> {
    return this.serial(async () => {
      const batch = await this.get(batchId)
      if (batch.revision !== revision) throw new Error('批次已更新，请刷新后重新复核')
      if (
        !batch.results.some((r) => r.id === review.resultId) ||
        !['reviewed', 'retest', 'exclude'].includes(review.action)
      )
        throw new Error('复核目标或操作无效')
      if (
        typeof review.reason !== 'string' ||
        !review.reason.trim() ||
        review.reason.length > 2000 ||
        typeof review.reviewer !== 'string' ||
        !review.reviewer.trim() ||
        review.reviewer.length > 100
      )
        throw new Error('请填写复核人及处理理由（理由不超过2000字）')
      batch.reviews.push({
        ...review,
        reason: review.reason.trim(),
        reviewer: review.reviewer.trim(),
        at: new Date().toISOString()
      })
      batch.revision++
      await this.save(batch)
    })
  }
}
export function resultCsv(batch: StoredBatch, filters: AnalysisFilters): string {
  const reviews = latestReviews(batch)
  const rows: unknown[][] = [
    [
      '批次',
      '方法',
      '规则版本',
      '模拟数据',
      '结果ID',
      '样品',
      '化合物',
      '基质',
      '测定值',
      '原始单位',
      '结果修饰符',
      '限量',
      '比较单位',
      '换算测定值',
      '限量状态',
      '限量依据',
      '峰形状态',
      '峰形标签',
      '5%拖尾因子',
      'RT_min',
      '离子比',
      '参考比',
      '相对偏差_pct',
      '离子比状态',
      '异常标签',
      '检查原因',
      '复核操作',
      '复核人',
      '复核理由',
      '复核时间',
      '数据文件SHA256',
      '分析引擎版本'
    ]
  ]
  for (const r of filterResults(batch, filters)) {
    const input = batch.input.results.find((row) => row.id === r.id)!,
      review = reviews.get(r.id)
    rows.push([
      batch.input.batchName,
      batch.input.methodName,
      batch.input.ruleVersion,
      batch.input.demo ? '是（模拟）' : '否',
      r.id,
      r.sample,
      r.compound,
      r.matrix,
      input.measurement?.value,
      input.measurement?.unit,
      input.measurement?.modifier ?? '',
      r.limit.limitValue,
      r.limit.unit,
      r.limit.measuredValue,
      CHECK_LABELS[r.limit.state],
      r.limit.source,
      CHECK_LABELS[r.peak.state],
      r.peak.flags.map((flag) => PEAK_LABELS[flag]).join(';'),
      r.peak.tailingFactor,
      r.peak.apexTime,
      r.ratio.value,
      r.ratio.reference,
      r.ratio.deviationPct,
      CHECK_LABELS[r.ratio.state],
      r.labels.join(';'),
      [...r.peak.reasons, ...r.ratio.reasons, ...r.limit.reasons].join(';'),
      review
        ? { reviewed: '已复核', retest: '要求重测', exclude: '标记排除' }[review.action]
        : '未复核',
      review?.reviewer,
      review?.reason,
      review?.at,
      batch.sourceHash,
      batch.engineVersion
    ])
  }
  // Text originating outside the app must not become a spreadsheet formula.
  function cell(value: unknown): string {
    let text = value == null ? '' : String(value)
    if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = "'" + text
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n')
}
