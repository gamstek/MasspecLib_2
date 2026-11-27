import type { DetectionPackage, DetectionRow, PeakRules, Trace } from './types.ts'
type Obj = Record<string, unknown>
function object(value: unknown, label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}必须为对象`)
  return value as Obj
}
function text(value: unknown, label: string, required = false, max = 500): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`缺少${label}`)
    return ''
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${label}必须为文字`)
  const v = String(value).trim()
  if (v.length > max || (required && !v)) throw new Error(`${label}为空或超过${max}字`)
  return v
}
function number(value: unknown, label: string, min = 0): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    throw new Error(`${label}不是有效数值`)
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) throw new Error(`${label}不是有效数值或小于${min}`)
  return n
}
function rules(value: unknown, label: string): PeakRules | undefined {
  if (value === undefined || value === null) return undefined
  const r = object(value, label),
    out: PeakRules = {}
  for (const key of [
    'tailingMin',
    'tailingMax',
    'minPoints',
    'splitMinRelativeHeight',
    'splitMaxValleyFraction',
    'splitMinDistanceMin',
    'saturationIntensity'
  ] as const) {
    const n = number(r[key], `${label}.${key}`)
    if (n !== undefined) out[key] = n
  }
  if (
    out.tailingMin !== undefined &&
    out.tailingMax !== undefined &&
    out.tailingMin >= out.tailingMax
  )
    throw new Error(`${label}拖尾因子上下界顺序错误`)
  if (out.minPoints !== undefined && (!Number.isInteger(out.minPoints) || out.minPoints < 5))
    throw new Error(`${label}.minPoints须为不小于5的整数`)
  for (const key of ['splitMinRelativeHeight', 'splitMaxValleyFraction'] as const)
    if (out[key] !== undefined && (out[key]! <= 0 || out[key]! >= 1))
      throw new Error(`${label}.${key}须在0与1之间`)
  return out
}
function trace(value: unknown, label: string): Trace | undefined {
  if (value === undefined || value === null) return undefined
  const t = object(value, label)
  if (!['s', 'min'].includes(String(t.timeUnit))) throw new Error(`${label}.timeUnit须明确为s或min`)
  if (!Array.isArray(t.points) || t.points.length > 100000)
    throw new Error(`${label}.points须为不超过100000点的数组`)
  let previous = -Infinity
  const points = t.points.map((point: unknown, index: number) => {
    const p = object(point, `${label}第${index + 1}点`)
    const time = number(p.time, `${label}时间`),
      intensity = number(p.intensity, `${label}强度`, -Number.MAX_VALUE)
    if (time === undefined || intensity === undefined || time <= previous)
      throw new Error(`${label}时间必须严格递增且点坐标完整`)
    previous = time
    return { time, intensity }
  })
  return { timeUnit: t.timeUnit as 's' | 'min', points }
}
export function normalizeDetectionPackage(value: unknown): DetectionPackage {
  const p = object(value, '数据包')
  if (p.formatVersion !== 1)
    throw new Error('检测结果数据包formatVersion必须为1（不同于谱库msldata格式）')
  if (!Array.isArray(p.results) || !p.results.length || p.results.length > 1000)
    throw new Error('每批需要1–1000条结果；大批数据请分批导入')
  const ids = new Set<string>()
  let points = 0
  const results: DetectionRow[] = p.results.map((item, index) => {
    const r = object(item, `第${index + 1}条结果`),
      label = `第${index + 1}条`
    const id = text(r.id, `${label}ID`, false, 100) || String(index + 1)
    if (ids.has(id)) throw new Error(`结果ID重复：${id}`)
    ids.add(id)
    const row: DetectionRow = {
      id,
      sample: text(r.sample, `${label}样品`, true),
      compound: text(r.compound, `${label}化合物`, true)
    }
    if (r.matrix != null) row.matrix = text(r.matrix, `${label}基质`)
    if (r.analyteKey != null) row.analyteKey = text(r.analyteKey, `${label}目标物键`)
    row.expectedRt = number(r.expectedRt, `${label}目标RT(min)`)
    row.rtWindow = number(r.rtWindow, `${label}RT半窗口(min)`)
    if (row.rtWindow === 0) throw new Error(`${label}RT半窗口必须大于0`)
    if (r.integration != null) {
      const w = object(r.integration, `${label}积分窗口`)
      const start = number(w.start, '窗口开始(min)'),
        end = number(w.end, '窗口结束(min)')
      if (start === undefined || end === undefined || start >= end)
        throw new Error(`${label}积分窗口无效`)
      row.integration = { start, end }
    }
    row.trace = trace(r.trace, `${label}定量曲线`)
    row.qualifierTrace = trace(r.qualifierTrace, `${label}定性曲线`)
    points += (row.trace?.points.length ?? 0) + (row.qualifierTrace?.points.length ?? 0)
    if (points > 500000) throw new Error('每批最多500000个曲线点，请拆分批次')
    row.peakRules = rules(r.peakRules, `${label}峰形规则`)
    if (r.measurement != null) {
      const m = object(r.measurement, `${label}测定值`)
      if (m.modifier != null && !['value', 'ND', 'ltLOQ', 'ltLOD'].includes(String(m.modifier)))
        throw new Error(`${label}测定修饰符无效`)
      row.measurement = {
        value: number(m.value, `${label}测定值`),
        unit: text(m.unit, `${label}浓度单位`),
        modifier: m.modifier as 'value' | 'ND' | 'ltLOQ' | 'ltLOD' | undefined,
        loq: number(m.loq, `${label}定量限`)
      }
    }
    if (r.limit != null) {
      const l = object(r.limit, `${label}限量`),
        n = number(l.value, `${label}限量`)
      if (n === undefined) throw new Error(`${label}限量对象缺少value；没有限量时省略limit对象`)
      row.limit = {
        value: n,
        unit: text(l.unit, `${label}限量单位`),
        source: text(l.source, `${label}限量依据`, false, 2000),
        matrix: text(l.matrix, `${label}限量基质`) || undefined
      }
    }
    if (r.ratio != null) {
      const v = object(r.ratio, `${label}离子比`)
      if (v.required != null && typeof v.required !== 'boolean')
        throw new Error(`${label}ratio.required必须为布尔值`)
      row.ratio = {
        required: v.required as boolean | undefined,
        quantifierArea: number(v.quantifierArea, `${label}定量面积`),
        qualifierArea: number(v.qualifierArea, `${label}定性面积`),
        reference: number(v.reference, `${label}参考离子比`),
        tolerancePct: number(v.tolerancePct, `${label}允许相对偏差`),
        referenceSource: text(v.referenceSource, `${label}参考来源`, false, 2000)
      }
    }
    if (r.ratio != null) {
      const v = object(r.ratio, `${label}离子比`)
      if (v.toleranceMode != null && !['relative', 'absolute'].includes(String(v.toleranceMode)))
        throw new Error(`${label}偏差类型无效`)
      if (v.toleranceMode) row.ratio!.toleranceMode = v.toleranceMode as 'relative' | 'absolute'
      if (v.toleranceAbsolute != null)
        row.ratio!.toleranceAbsolute = number(v.toleranceAbsolute, `${label}绝对偏差`)
    }
    if (r.qualifiers != null) {
      if (!Array.isArray(r.qualifiers) || r.qualifiers.length > 20)
        throw new Error(`${label}最多20个定性通道`)
      const channels = new Set<string>()
      row.qualifiers = r.qualifiers.map((item: unknown) => {
        const q = object(item, `${label}定性通道`),
          channel = text(q.channel, '通道名称', true)
        if (channels.has(channel)) throw new Error(`${label}通道名称重复`)
        channels.add(channel)
        const normalized = normalizeDetectionPackage({
          formatVersion: 1,
          batchName: '通道',
          methodName: '通道',
          ruleVersion: '通道',
          results: [
            {
              id: channel,
              sample: row.sample,
              compound: row.compound,
              ratio: q.ratio,
              qualifierTrace: q.trace
            }
          ]
        }).results[0]
        points += normalized.qualifierTrace?.points.length ?? 0
        if (points > 500000) throw new Error('每批最多500000个曲线点，请拆分批次')
        return { channel, trace: normalized.qualifierTrace, ratio: normalized.ratio ?? {} }
      })
    }
    return row
  })
  if (p.demo != null && typeof p.demo !== 'boolean') throw new Error('demo必须为布尔值')
  return {
    formatVersion: 1,
    batchName: text(p.batchName, '批次名称', true),
    methodName: text(p.methodName, '方法名称', true),
    ruleVersion: text(p.ruleVersion, '规则版本', true),
    demo: p.demo === true,
    peakRules: rules(p.peakRules, '批次峰形规则'),
    results
  }
}
// Fixed, explicit headers: no guessing columns or silently treating spectrum peaks as traces.
export const CSV_HEADERS = [
  '结果ID',
  '样品',
  '化合物',
  '基质',
  '目标RT_min',
  'RT半窗口_min',
  '测定值',
  '浓度单位',
  '结果修饰符',
  '定量限',
  '限量',
  '限量单位',
  '限量依据',
  '定量面积',
  '定性面积',
  '参考离子比',
  '允许相对偏差_pct',
  '离子比参考来源',
  '离子比适用',
  '定量曲线JSON',
  '定性曲线JSON',
  '峰形规则JSON',
  '批次名称',
  '方法名称',
  '规则版本',
  '模拟数据'
]
export function tabularPackage(
  rows: Record<string, unknown>[],
  defaultName: string
): DetectionPackage {
  if (!rows.length) throw new Error('表格没有结果记录')
  function pick(row: Obj, cn: string, en: string): unknown {
    return row[cn] ?? row[en]
  }
  function json(value: unknown, label: string): unknown {
    if (value == null || value === '') return undefined
    if (typeof value === 'object') return value
    try {
      return JSON.parse(String(value))
    } catch {
      throw new Error(`${label}不是合法JSON`)
    }
  }
  const fixed = (cn: string, en: string): string =>
    rows.map((row) => text(pick(row, cn, en), cn)).find(Boolean) ?? ''
  for (const [cn, en] of [
    ['批次名称', 'batch_name'],
    ['方法名称', 'method_name'],
    ['规则版本', 'rule_version']
  ]) {
    const values = new Set(rows.map((r) => text(pick(r, cn, en), cn)).filter(Boolean))
    if (values.size > 1) throw new Error(`同一文件存在多个${cn}，请按批次和方法拆分`)
  }
  return normalizeDetectionPackage({
    formatVersion: 1,
    batchName: fixed('批次名称', 'batch_name') || defaultName,
    methodName: fixed('方法名称', 'method_name') || '外部结果导入（方法待确认）',
    ruleVersion: fixed('规则版本', 'rule_version') || '未注明规则版本',
    demo: rows.every((r) =>
      ['true', '1', '是'].includes(String(pick(r, '模拟数据', 'demo') ?? '').toLowerCase())
    ),
    results: rows.map((r, i) => {
      const get = (cn: string, en: string): unknown => pick(r, cn, en)
      const value = get('测定值', 'concentration'),
        modifier = get('结果修饰符', 'modifier'),
        limit = get('限量', 'limit')
      return {
        id: get('结果ID', 'id') || String(i + 1),
        sample: get('样品', 'sample'),
        compound: get('化合物', 'compound'),
        matrix: get('基质', 'matrix'),
        expectedRt: get('目标RT_min', 'expected_rt'),
        rtWindow: get('RT半窗口_min', 'rt_window'),
        trace: json(get('定量曲线JSON', 'trace_json'), `第${i + 1}条定量曲线`),
        qualifierTrace: json(get('定性曲线JSON', 'qualifier_trace_json'), `第${i + 1}条定性曲线`),
        peakRules: json(get('峰形规则JSON', 'peak_rules_json'), `第${i + 1}条峰形规则`),
        measurement:
          (value != null && value !== '') || modifier
            ? {
                value,
                unit: get('浓度单位', 'unit'),
                modifier: modifier || 'value',
                loq: get('定量限', 'loq')
              }
            : undefined,
        limit:
          limit != null && limit !== ''
            ? {
                value: limit,
                unit: get('限量单位', 'limit_unit'),
                source: get('限量依据', 'limit_source')
              }
            : undefined,
        ratio: {
          required: !['false', '0', '否', '不适用'].includes(
            String(get('离子比适用', 'ratio_required') ?? '').toLowerCase()
          ),
          quantifierArea: get('定量面积', 'quantifier_area'),
          qualifierArea: get('定性面积', 'qualifier_area'),
          reference: get('参考离子比', 'ratio_reference'),
          tolerancePct: get('允许相对偏差_pct', 'ratio_tolerance_pct'),
          referenceSource: get('离子比参考来源', 'ratio_reference_source')
        }
      }
    })
  })
}
