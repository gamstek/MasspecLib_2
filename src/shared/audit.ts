import { analyseRow } from './analysis/engine.ts'
import { normalizeDetectionPackage } from './analysis/input.ts'
import type { DetectionRow, DetectionResult, CheckState } from './analysis/types.ts'
import type { RecordRef, SourceChoice } from './federation.ts'
export type AssetKind = 'spectrum' | 'chromatogram' | 'measurement'
export type CheckKind = 'peak' | 'ratio' | 'limit'
export interface AuditMapping {
  table: string
  key: string
  compoundKey: string
  fields: Record<string, string>
  completedValue?: string
  defaultRecordType?: 'sample' | 'reference'
}
export interface AuditSettings {
  enabled: boolean
  connectionId: string
  database: string
  intervalSeconds: number
}
export interface AuditAsset {
  id: string
  ref: RecordRef
  recordKey: string
  kind: AssetKind
  sources: SourceChoice[]
  methodName: string
  ruleVersion: string
  batchName: string
  row?: DetectionRow
  image?: string
  linkedResult?: string
  checks: CheckKind[]
  metadata?: any
  issue?: string
  fingerprint: string
}
export interface DataOverview {
  spectra: number
  numericTraces: number
  images: number
  measurements: number
  responses: number
  abnormal: number
  incomplete: number
  checked: number
  pending: number
}
export const EMPTY_OVERVIEW: DataOverview = {
  spectra: 0,
  numericTraces: 0,
  images: 0,
  measurements: 0,
  responses: 0,
  abnormal: 0,
  incomplete: 0,
  checked: 0,
  pending: 0
}
export function objectValue(value: unknown): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}
export function identityKey(compound: any): string | undefined {
  const ids = objectValue(compound.identifiers) ?? {}
  const props = objectValue(compound.properties) ?? {}
  if (props.identity_conflict || /conflict|冲突/i.test(String(props.identity_status ?? ''))) return
  const value = String(ids.inchikey ?? ids.InChIKey ?? ids.INCHIKEY ?? compound.inchikey ?? '')
    .trim()
    .toUpperCase()
    .replace(/^INCHIKEY=/, '')
  return /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(value) ? value : undefined
}
export function normalizeAuditRow(value: unknown, compoundName: string): DetectionRow {
  const row = objectValue(value)
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('检测数据必须为JSON对象')
  return normalizeDetectionPackage({
    formatVersion: 1,
    batchName: '数据库记录',
    methodName: '来源方法',
    ruleVersion: '来源规则',
    results: [{ ...row, sample: row.sample || '参考记录', compound: row.compound || compoundName }]
  }).results[0]
}
export function applicableChecks(
  row?: DetectionRow,
  image?: string,
  declared?: unknown
): CheckKind[] {
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.some((x) => !['peak', 'ratio', 'limit'].includes(x)))
      throw new Error('checks必须是peak、ratio、limit数组')
    return [...new Set(declared)] as CheckKind[]
  }
  const result: CheckKind[] = []
  if (row?.trace || image || row?.integration || row?.expectedRt !== undefined) result.push('peak')
  if (row?.ratio || row?.qualifierTrace || row?.qualifiers?.length) result.push('ratio')
  if (row?.measurement || row?.limit) result.push('limit')
  return result
}
export function analyseAsset(asset: AuditAsset): DetectionResult | null {
  if (asset.kind === 'spectrum' || asset.linkedResult) return null
  const row = asset.row ?? { id: asset.recordKey, sample: '来源记录', compound: '未关联化合物' }
  const result = analyseRow(row)
  for (const kind of ['peak', 'ratio', 'limit'] as const) {
    if (!asset.checks.includes(kind)) {
      result[kind].state = 'na'
      result[kind].reasons = ['此记录未声明该类检查数据']
    } else if (asset.issue) {
      result[kind].state = 'unknown'
      result[kind].reasons = [asset.issue]
    }
  }
  if (asset.image && !row.trace && asset.checks.includes('peak')) {
    result.peak.state = 'unknown'
    result.peak.reasons = ['仅有色谱图片，没有时间—强度数值轨迹']
  }
  if (asset.issue) result.peak.flags = []
  result.labels = []
  if (result.peak.state !== 'na') {
    const labels = {
      fronting: '前延',
      tailing: '拖尾',
      split: '疑似分叉／肩峰',
      saturation: '疑似饱和',
      truncated: '峰边界截断',
      insufficient: '信号／采样不足'
    }
    result.labels.push(...result.peak.flags.map((x) => labels[x]))
    if (result.peak.state === 'warn' && !result.peak.flags.length)
      result.labels.push('目标峰需确认')
  }
  if (result.ratio.state === 'fail') result.labels.push('离子比不满足')
  if (result.limit.state === 'fail') result.labels.push('数值超限')
  result.incomplete = asset.checks.some((k) => result[k].state === 'unknown')
  result.abnormal = asset.checks.some((k) => ['fail', 'warn'].includes(result[k].state))
  if (result.incomplete) result.labels.push('部分检查数据不足')
  return result
}
export function safeImage(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)
    ? value
    : undefined
}
export const AUDIT_STATE_LABELS: Record<CheckState, string> = {
  pass: '满足规则',
  fail: '不满足',
  warn: '疑似异常',
  unknown: '数据不足',
  na: '不适用'
}
