import type {
  Trace,
  TracePoint,
  DetectionRow,
  DetectionPackage,
  PeakRules,
  PeakCheck,
  RatioCheck,
  LimitCheck,
  DetectionResult,
  StoredBatch,
  AnalysisFilters,
  AnalysisSummary
} from './types.ts'
import { PEAK_LABELS } from './types.ts'
const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Number.EPSILON * 16 * Math.max(Number.MIN_VALUE, Math.abs(a), Math.abs(b))
export function traceMinutes(trace?: Trace): TracePoint[] {
  return (trace?.points ?? []).map((p) => ({
    time: trace?.timeUnit === 's' ? p.time / 60 : p.time,
    intensity: p.intensity
  }))
}
function interpolate(a: TracePoint, b: TracePoint, time: number): TracePoint {
  return {
    time,
    intensity: a.intensity + ((b.intensity - a.intensity) * (time - a.time)) / (b.time - a.time)
  }
}
function windowPoints(points: TracePoint[], start: number, end: number): TracePoint[] {
  if (
    !points.length ||
    start >= end ||
    start < points[0].time ||
    end > points[points.length - 1].time
  )
    return []
  const selected = points.filter((p) => p.time >= start && p.time <= end)
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1].time < start && points[i].time > start)
      selected.unshift(interpolate(points[i - 1], points[i], start))
    if (points[i - 1].time < end && points[i].time > end)
      selected.push(interpolate(points[i - 1], points[i], end))
  }
  return selected
}
export function analysePeak(
  row: DetectionRow,
  defaults: PeakRules = {},
  trace = row.trace
): PeakCheck {
  const result: PeakCheck = {
    state: 'unknown',
    reasons: [],
    flags: [],
    area: null,
    height: null,
    apexTime: null,
    start: null,
    end: null,
    baselineStart: null,
    baselineEnd: null,
    tailingFactor: null,
    widthHalfHeight: null,
    pointCount: 0
  }
  const raw = traceMinutes(trace)
  if (!raw.length) {
    result.reasons.push('没有时间—强度色谱曲线')
    return result
  }
  const rules = { ...defaults, ...row.peakRules }
  const start =
    row.integration?.start ??
    (usable(row.expectedRt) && usable(row.rtWindow) ? row.expectedRt - row.rtWindow : raw[0].time)
  const end =
    row.integration?.end ??
    (usable(row.expectedRt) && usable(row.rtWindow)
      ? row.expectedRt + row.rtWindow
      : raw[raw.length - 1].time)
  const points = windowPoints(raw, start, end)
  result.start = start
  result.end = end
  result.pointCount = points.length
  if (points.length < (rules.minPoints ?? 7)) {
    result.flags.push('insufficient')
    result.reasons.push('积分窗口超出曲线范围或有效采样点不足')
    return result
  }
  const first = points[0],
    last = points[points.length - 1]
  result.baselineStart = first.intensity
  result.baselineEnd = last.intensity
  // Linear endpoint baseline is explicit and reproducible. It is a QC estimate,
  // never silently substituted for an instrument's reported concentration.
  const signal = points.map((p) =>
    Math.max(
      0,
      p.intensity -
        (first.intensity + ((last.intensity - first.intensity) * (p.time - start)) / (end - start))
    )
  )
  if (signal.some((value) => !Number.isFinite(value))) {
    result.flags.push('insufficient')
    result.reasons.push('基线校正超出有效数值范围')
    return result
  }
  let apex = 0
  for (let i = 1; i < signal.length; i++) if (signal[i] > signal[apex]) apex = i
  const height = signal[apex]
  result.height = height
  result.apexTime = points[apex].time
  if (height <= 0 || apex === 0 || apex === signal.length - 1) {
    result.flags.push('insufficient')
    result.reasons.push('没有可独立评价的正信号峰')
    return result
  }
  let area = 0
  for (let i = 1; i < points.length; i++)
    area += ((signal[i - 1] + signal[i]) / 2) * (points[i].time - points[i - 1].time)
  if (!Number.isFinite(area)) {
    result.flags.push('insufficient')
    result.reasons.push('积分面积超出有效数值范围')
    return result
  }
  result.area = area
  function crossing(fraction: number, left: boolean): number | null {
    const target = height * fraction
    for (let i = apex; left ? i > 0 : i < signal.length - 1; left ? i-- : i++) {
      const j = left ? i - 1 : i + 1
      if (signal[j] <= target && signal[i] >= target && signal[j] !== signal[i]) {
        return (
          points[i].time +
          ((points[j].time - points[i].time) * (target - signal[i])) / (signal[j] - signal[i])
        )
      }
    }
    return null
  }
  const left5 = crossing(0.05, true),
    right5 = crossing(0.05, false)
  const left50 = crossing(0.5, true),
    right50 = crossing(0.5, false)
  if (left5 !== null && right5 !== null && result.apexTime > left5)
    result.tailingFactor = (right5 - left5) / (2 * (result.apexTime - left5))
  if (left50 !== null && right50 !== null) result.widthHalfHeight = right50 - left50
  // Detect clipped integration envelopes using the acquired signal's edges.
  // Endpoint baseline alone would force the edges to zero and conceal clipping.
  let rawMin = Infinity,
    rawMax = -Infinity
  for (const point of points) {
    rawMin = Math.min(rawMin, point.intensity)
    rawMax = Math.max(rawMax, point.intensity)
  }
  const rawSpan = rawMax - Math.min(raw[0].intensity, raw[raw.length - 1].intensity, rawMin)
  const acquiredBaseline = Math.min(raw[0].intensity, raw[raw.length - 1].intensity)
  if (
    rawSpan > 0 &&
    (first.intensity - acquiredBaseline > rawSpan * 0.05 ||
      last.intensity - acquiredBaseline > rawSpan * 0.05)
  ) {
    result.flags.push('truncated')
    result.reasons.push('积分边界信号仍高于峰高5%，峰形指标可能受截断影响')
    result.tailingFactor = null
  }
  if (
    usable(rules.saturationIntensity) &&
    points.some((p) => p.intensity >= rules.saturationIntensity!)
  ) {
    result.flags.push('saturation')
    result.reasons.push('信号达到方法设定的饱和检查阈值')
  }
  const factor = result.tailingFactor
  if (
    factor !== null &&
    usable(rules.tailingMin) &&
    factor < rules.tailingMin &&
    !close(factor, rules.tailingMin)
  ) {
    result.flags.push('fronting')
    result.reasons.push(`5%拖尾因子 ${factor.toFixed(3)} 低于方法下界 ${rules.tailingMin}`)
  }
  if (
    factor !== null &&
    usable(rules.tailingMax) &&
    factor > rules.tailingMax &&
    !close(factor, rules.tailingMax)
  ) {
    result.flags.push('tailing')
    result.reasons.push(`5%拖尾因子 ${factor.toFixed(3)} 高于方法上界 ${rules.tailingMax}`)
  }
  const splitConfigured =
    usable(rules.splitMinRelativeHeight) &&
    usable(rules.splitMaxValleyFraction) &&
    usable(rules.splitMinDistanceMin)
  if (splitConfigured) {
    const smoothed = signal.map((v, i) =>
      i === 0 || i === signal.length - 1 ? v : (signal[i - 1] + 2 * v + signal[i + 1]) / 4
    )
    const candidates: number[] = []
    for (let i = 1; i < smoothed.length - 1; i++)
      if (
        smoothed[i] > smoothed[i - 1] &&
        smoothed[i] >= smoothed[i + 1] &&
        smoothed[i] >= height * rules.splitMinRelativeHeight!
      )
        candidates.push(i)
    // Merge nearby local tops, then inspect disjoint valleys once. Dense noise
    // must not trigger a quadratic search over every possible peak pair.
    const separated: number[] = []
    for (const candidate of candidates) {
      const previous = separated[separated.length - 1]
      if (
        previous !== undefined &&
        points[candidate].time - points[previous].time < rules.splitMinDistanceMin!
      ) {
        if (smoothed[candidate] > smoothed[previous]) separated[separated.length - 1] = candidate
      } else separated.push(candidate)
    }
    for (let pair = 1; pair < separated.length; pair++) {
      const l = separated[pair - 1],
        r = separated[pair]
      let valley = Infinity
      for (let i = l; i <= r; i++) valley = Math.min(valley, smoothed[i])
      if (valley / Math.min(smoothed[l], smoothed[r]) <= rules.splitMaxValleyFraction!) {
        result.flags.push('split')
        result.reasons.push('同一评价窗口存在多个显著峰顶及峰间谷；需复核分叉、肩峰或干扰')
        break
      }
    }
  }
  const assessedShape = usable(rules.tailingMin) && usable(rules.tailingMax) && factor !== null
  result.state = result.flags.some((f) => f === 'fronting' || f === 'tailing' || f === 'saturation')
    ? 'fail'
    : result.flags.length
      ? 'warn'
      : assessedShape && splitConfigured
        ? 'pass'
        : 'unknown'
  if (!assessedShape || !splitConfigured)
    result.reasons.push('峰形规则未完整配置或部分指标不可计算，不能判为峰形合格')
  if (!row.integration && !(usable(row.expectedRt) && usable(row.rtWindow))) {
    result.reasons.push('未提供目标RT窗口，当前按整段曲线最高峰评价，需确认目标峰')
    if (result.state === 'pass') result.state = 'warn'
  }
  if (!result.reasons.length)
    result.reasons.push('在指定窗口内满足当前峰形规则；不代表已排除所有共洗脱干扰')
  return result
}
export function analyseRatio(row: DetectionRow, defaults: PeakRules = {}): RatioCheck {
  const r = row.ratio
  const result: RatioCheck = {
    state: r?.required === false ? 'na' : 'unknown',
    reasons: [],
    value: null,
    reference: r?.reference ?? null,
    deviationPct: null,
    lower: null,
    upper: null,
    tolerancePct: r?.tolerancePct ?? null,
    quantifierArea: null,
    qualifierArea: null,
    areaSource: null
  }
  if (r?.required === false) {
    result.reasons.push('方法明确不要求离子比检查')
    return result
  }
  const importedQuantifier = usable(r?.quantifierArea),
    importedQualifier = usable(r?.qualifierArea)
  if (importedQuantifier !== importedQualifier) {
    result.reasons.push('只导入一个通道面积；不能将未知单位的外部面积与曲线估计面积混用')
    return result
  }
  const quantifierArea = r?.quantifierArea ?? analysePeak(row, defaults).area
  const qualifierArea =
    r?.qualifierArea ??
    (row.qualifierTrace ? analysePeak(row, defaults, row.qualifierTrace).area : null)
  result.quantifierArea = quantifierArea ?? null
  result.qualifierArea = qualifierArea ?? null
  result.areaSource =
    usable(r?.quantifierArea) && usable(r?.qualifierArea)
      ? 'imported'
      : usable(r?.quantifierArea) || usable(r?.qualifierArea)
        ? 'mixed'
        : row.trace && row.qualifierTrace
          ? 'trace'
          : null
  if (
    !usable(quantifierArea) ||
    !usable(qualifierArea) ||
    quantifierArea <= 0 ||
    qualifierArea <= 0
  ) {
    result.reasons.push('定量／定性响应缺失或无有效正信号，不能计算有效离子比')
    return result
  }
  result.value = qualifierArea / quantifierArea
  if (!Number.isFinite(result.value)) {
    result.value = null
    result.reasons.push('离子比超出有效数值范围')
    return result
  }
  if (
    !usable(r?.reference) ||
    r.reference <= 0 ||
    (r?.toleranceMode === 'absolute' ? !usable(r.toleranceAbsolute) : !usable(r?.tolerancePct)) ||
    !r?.referenceSource?.trim()
  ) {
    result.reasons.push('缺少有效参考比、相对偏差范围或参考来源')
    return result
  }
  result.deviationPct = (result.value / r.reference - 1) * 100
  if (!Number.isFinite(result.deviationPct)) {
    result.deviationPct = null
    result.reasons.push('相对偏差超出有效数值范围')
    return result
  }
  const absolute = r.toleranceMode === 'absolute'
  const allowance = absolute ? r.toleranceAbsolute! : (r.reference * r.tolerancePct!) / 100
  result.lower = absolute
    ? Math.max(0, r.reference - allowance)
    : r.reference * (1 - r.tolerancePct! / 100)
  result.upper = absolute ? r.reference + allowance : r.reference * (1 + r.tolerancePct! / 100)
  const difference = Math.abs(result.value - r.reference)
  const actual = absolute ? difference : Math.abs(result.deviationPct)
  const allowed = absolute ? allowance : r.tolerancePct!
  result.state = actual < allowed || close(actual, allowed) ? 'pass' : 'fail'
  if (absolute) {
    result.toleranceMode = 'absolute'
    result.toleranceAbsolute = r.toleranceAbsolute
  }
  result.reasons.push(
    `定性／定量面积比；参考 ${r.reference}，允许${absolute ? '绝对' : '相对'}偏差 ±${absolute ? r.toleranceAbsolute : r.tolerancePct}${absolute ? '' : '%'}；来源：${r.referenceSource}`
  )
  if (result.areaSource !== 'imported')
    result.reasons.push('部分或全部面积由当前窗口及端点线性基线估计，须与方法积分方式核对')
  return result
}
function concentrationUnit(unit: string): { dimension: string; multiplier: number } | null {
  const key = unit.replace(/[μµ]/g, 'u').replace(/\s/g, '').toLowerCase()
  const values: Record<string, { dimension: string; multiplier: number }> = {
    'g/kg': { dimension: 'mass', multiplier: 1000 },
    'mg/kg': { dimension: 'mass', multiplier: 1 },
    'ug/kg': { dimension: 'mass', multiplier: 0.001 },
    'ng/kg': { dimension: 'mass', multiplier: 0.000001 },
    'g/l': { dimension: 'volume', multiplier: 1000 },
    'mg/l': { dimension: 'volume', multiplier: 1 },
    'ug/l': { dimension: 'volume', multiplier: 0.001 },
    'ng/l': { dimension: 'volume', multiplier: 0.000001 }
  }
  return values[key] ?? null
}
export function analyseLimit(row: DetectionRow): LimitCheck {
  const m = row.measurement,
    l = row.limit
  const result: LimitCheck = {
    state: 'unknown',
    reasons: [],
    measuredValue: m?.value ?? null,
    limitValue: l?.value ?? null,
    unit: l?.unit ?? m?.unit ?? null,
    factor: null,
    source: l?.source ?? null
  }
  if (!l || !l.source.trim()) {
    result.reasons.push('未提供适用于本样品的限量值或依据')
    return result
  }
  if (l.matrix && l.matrix.trim() !== row.matrix?.trim()) {
    result.reasons.push('限量基质与样品基质不一致')
    return result
  }
  if (!m || (m.modifier && m.modifier !== 'value') || !usable(m.value)) {
    result.reasons.push('未检出／低于检出或定量限不按0处理，当前不能直接进行数值超限比较')
    return result
  }
  const source = concentrationUnit(m.unit),
    target = concentrationUnit(l.unit)
  if (!source || !target || source.dimension !== target.dimension) {
    result.reasons.push('单位不支持或量纲不同，不能直接比较（例如mg/L与mg/kg）')
    return result
  }
  result.measuredValue = (m.value * source.multiplier) / target.multiplier
  if (!Number.isFinite(result.measuredValue)) {
    result.measuredValue = null
    result.reasons.push('单位换算结果超出有效数值范围')
    return result
  }
  result.factor =
    l.value > 0 && Number.isFinite(result.measuredValue / l.value)
      ? result.measuredValue / l.value
      : null
  result.state =
    result.measuredValue > l.value && !close(result.measuredValue, l.value) ? 'fail' : 'pass'
  result.reasons.push('按输入的适用限量进行数值比较；等于限量不标为数值超限。最终符合性另行复核')
  return result
}
export function analyseRow(row: DetectionRow, defaults: PeakRules = {}): DetectionResult {
  const peak = analysePeak(row, defaults),
    ratio = analyseRatio(row, defaults),
    limit = analyseLimit(row)
  const ratioChecks = row.qualifiers?.map((q) => ({
    channel: q.channel,
    check: analyseRatio(
      {
        ...row,
        qualifierTrace: q.trace,
        ratio: { ...q.ratio, quantifierArea: q.ratio.quantifierArea ?? row.ratio?.quantifierArea }
      },
      defaults
    )
  }))
  if (ratioChecks?.length) {
    const order = { fail: 0, unknown: 1, warn: 2, pass: 3, na: 4 }
    const worst = [...ratioChecks].sort((a, b) => order[a.check.state] - order[b.check.state])[0]
    Object.assign(ratio, worst.check, {
      reasons: ratioChecks.flatMap((q) =>
        q.check.reasons.map((reason) => q.channel + '：' + reason)
      )
    })
  }
  const labels = peak.flags.map((f) => PEAK_LABELS[f])
  if (peak.state === 'warn' && !peak.flags.length) labels.push('目标峰需确认')
  if (limit.state === 'fail') labels.push('数值超限')
  if (ratio.state === 'fail') labels.push('离子比不满足')
  const incomplete = [peak, ratio, limit].some((r) => r.state === 'unknown')
  if (incomplete) labels.push('部分检查数据不足')
  return {
    ...(ratioChecks?.length ? { ratioChecks } : {}),
    id: row.id,
    sample: row.sample,
    compound: row.compound,
    matrix: row.matrix ?? '',
    peak,
    ratio,
    limit,
    abnormal: [peak, ratio, limit].some((r) => r.state === 'fail' || r.state === 'warn'),
    incomplete,
    labels
  }
}
export function latestReviews(batch: StoredBatch): Map<string, StoredBatch['reviews'][number]> {
  return new Map(batch.reviews.map((r) => [r.resultId, r]))
}
export function summarize(batch: StoredBatch): AnalysisSummary {
  const reviews = latestReviews(batch)
  return {
    id: batch.id,
    batchName: batch.input.batchName,
    methodName: batch.input.methodName,
    ruleVersion: batch.input.ruleVersion,
    demo: !!batch.input.demo,
    createdAt: batch.createdAt,
    revision: batch.revision,
    total: batch.results.length,
    abnormal: batch.results.filter((r) => r.abnormal).length,
    incomplete: batch.results.filter((r) => r.incomplete).length,
    pending: batch.results.filter((r) => !reviews.has(r.id) && (r.abnormal || r.incomplete)).length
  }
}
export function filterResults(batch: StoredBatch, filters: AnalysisFilters): DetectionResult[] {
  const reviews = latestReviews(batch)
  const contains = (a: string, b?: string): boolean =>
    !b?.trim() || a.toLocaleLowerCase().includes(b.trim().toLocaleLowerCase())
  return batch.results.filter(
    (r) =>
      contains(r.sample, filters.sample) &&
      contains(r.compound, filters.compound) &&
      contains(r.matrix, filters.matrix) &&
      (!filters.view ||
        filters.view === 'all' ||
        (filters.view === 'abnormal' && r.abnormal) ||
        (filters.view === 'incomplete' && r.incomplete) ||
        (filters.view === 'pending' && !reviews.has(r.id) && (r.abnormal || r.incomplete))) &&
      (!filters.peak ||
        (filters.peak === 'pass' || filters.peak === 'unknown'
          ? r.peak.state === filters.peak
          : r.peak.flags.includes(filters.peak))) &&
      (!filters.ratio || r.ratio.state === filters.ratio) &&
      (!filters.limit || r.limit.state === filters.limit) &&
      (!filters.review ||
        (filters.review === 'pending'
          ? !reviews.has(r.id)
          : reviews.get(r.id)?.action === filters.review))
  )
}
export function analysePackage(input: DetectionPackage): DetectionResult[] {
  return input.results.map((row) => analyseRow(row, input.peakRules))
}
