export type CheckState = 'pass' | 'fail' | 'warn' | 'unknown' | 'na'
export type PeakFlag =
  | 'fronting'
  | 'tailing'
  | 'split'
  | 'saturation'
  | 'truncated'
  | 'insufficient'
export interface TracePoint {
  time: number
  intensity: number
}
export interface Trace {
  timeUnit: 'min' | 's'
  points: TracePoint[]
}
export interface PeakRules {
  tailingMin?: number
  tailingMax?: number
  minPoints?: number
  splitMinRelativeHeight?: number
  splitMaxValleyFraction?: number
  splitMinDistanceMin?: number
  saturationIntensity?: number
}
export interface DetectionRow {
  id: string
  sample: string
  compound: string
  matrix?: string
  analyteKey?: string
  expectedRt?: number
  rtWindow?: number
  integration?: { start: number; end: number }
  trace?: Trace
  qualifierTrace?: Trace
  peakRules?: PeakRules
  measurement?: {
    value?: number
    unit: string
    modifier?: 'value' | 'ltLOQ' | 'ltLOD' | 'ND'
    loq?: number
  }
  limit?: { value: number; unit: string; source: string; matrix?: string }
  qualifiers?: { channel: string; trace?: Trace; ratio: NonNullable<DetectionRow['ratio']> }[]
  ratio?: {
    required?: boolean
    quantifierArea?: number
    qualifierArea?: number
    reference?: number
    tolerancePct?: number
    toleranceMode?: 'relative' | 'absolute'
    toleranceAbsolute?: number
    referenceSource?: string
  }
}
export interface DetectionPackage {
  formatVersion: 1
  batchName: string
  methodName: string
  ruleVersion: string
  demo?: boolean
  peakRules?: PeakRules
  results: DetectionRow[]
}
export interface CheckResult {
  state: CheckState
  reasons: string[]
}
export interface PeakCheck extends CheckResult {
  flags: PeakFlag[]
  area: number | null
  height: number | null
  apexTime: number | null
  start: number | null
  end: number | null
  baselineStart: number | null
  baselineEnd: number | null
  tailingFactor: number | null
  widthHalfHeight: number | null
  pointCount: number
}
export interface RatioCheck extends CheckResult {
  toleranceMode?: 'relative' | 'absolute'
  toleranceAbsolute?: number
  value: number | null
  reference: number | null
  deviationPct: number | null
  lower: number | null
  upper: number | null
  tolerancePct: number | null
  quantifierArea: number | null
  qualifierArea: number | null
  areaSource: 'imported' | 'trace' | 'mixed' | null
}
export interface LimitCheck extends CheckResult {
  measuredValue: number | null
  limitValue: number | null
  unit: string | null
  factor: number | null
  source: string | null
}
export interface DetectionResult {
  id: string
  sample: string
  compound: string
  matrix: string
  ratioChecks?: { channel: string; check: RatioCheck }[]
  peak: PeakCheck
  ratio: RatioCheck
  limit: LimitCheck
  abnormal: boolean
  incomplete: boolean
  labels: string[]
}
export interface ReviewAction {
  resultId: string
  action: 'reviewed' | 'retest' | 'exclude'
  reason: string
  reviewer: string
  at: string
}
export interface StoredBatch {
  id: string
  revision: number
  createdAt: string
  sourceName: string
  sourceHash: string
  engineVersion: string
  input: DetectionPackage
  results: DetectionResult[]
  reviews: ReviewAction[]
}
export interface AnalysisSummary {
  id: string
  batchName: string
  methodName: string
  ruleVersion: string
  demo: boolean
  createdAt: string
  revision: number
  total: number
  abnormal: number
  incomplete: number
  pending: number
}
export interface AnalysisFilters {
  sample?: string
  compound?: string
  matrix?: string
  view?: 'all' | 'abnormal' | 'incomplete' | 'pending'
  peak?: PeakFlag | 'pass' | 'unknown'
  ratio?: CheckState
  limit?: CheckState
  review?: 'pending' | 'reviewed' | 'retest' | 'exclude'
  page?: number
  pageSize?: number
}
export const ENGINE_VERSION = '1.1.0'
export const CHECK_LABELS: Record<CheckState, string> = {
  pass: '满足规则',
  fail: '不满足',
  warn: '疑似异常',
  unknown: '未评估／数据不足',
  na: '不适用'
}
export const PEAK_LABELS: Record<PeakFlag, string> = {
  fronting: '前延',
  tailing: '拖尾',
  split: '疑似分叉／肩峰',
  saturation: '疑似饱和',
  truncated: '峰边界截断',
  insufficient: '信号／采样不足'
}
