export const acquisitionFields = {
  is_positive: '电喷雾电压 IS（正模式）', is_negative: '电喷雾电压 IS（负模式）',
  collision_gas_pressure: '碰撞气压力', collision_gas_level: '碰撞气档位',
  cur: '气帘气 CUR', gs1: '雾化气 GS1', gs2: '辅助气／加热气 GS2',
  source_temperature: '离子源温度 TEM', ion_source_parameters_raw: '离子源参数原文',
  method_source: '方法来源／方法分组', transition_label: 'MRM通道编号',
  method_notes: '方法备注', adduct_note: '加合离子说明'
}
export const parameterDefaultUnits = Object.freeze({ is_positive: 'V', is_negative: 'V', collision_gas_pressure: 'psi', cur: 'psi', gs1: 'psi', gs2: 'psi', source_temperature: '℃', flow_rate: 'mL/min', retention_time: 'min' })
export const quantityParameterKeys = Object.keys(parameterDefaultUnits).filter(k => !['flow_rate', 'retention_time'].includes(k))
export function object(value) { if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return {} } }; return value && typeof value === 'object' && !Array.isArray(value) ? value : {} }
function number(value) { return (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null }
export function isTransitionMethod(method) {
  const scan = String(method.scan_mode ?? '').trim()
  const transition = /\b(?:MRM|SRM)(?:\d+)?\b|多反应监测|选择反应监测/i
  if (transition.test(scan)) return true
  if (/\b(?:MS\s*\d+|MS\s*\/\s*MS|DDA|DIA|PRM|EPI|IDA)\b|full[ -]?scan|全扫描/i.test(scan)) return false
  if (transition.test(String(method.ms_mode ?? ''))) return true
  return number(method.q3) > 0 || method.original_method_id != null ||
    ['quantifier', 'qualifier'].includes(method.transition_role) ||
    Boolean(method.transition_label || object(method.conditions).transition_label)
}

const ionPairIssues = new Set(['离子对不完整', '原始离子对不完整或无效'])
export function methodQualityIssue(method, validate = false) {
  const issue = String(method.quality_issue ?? '').trim()
  if (issue && !ionPairIssues.has(issue)) return issue
  if (!isTransitionMethod(method)) return ''
  if (!validate) return issue
  return number(method.q1) > 0 && number(method.q3) > 0 ? '' : '离子对不完整'
}
export function parameterQuantity(value, defaultUnit) {
  if (value === null || value === undefined || value === '') return null
  const item = typeof value === 'object' && !Array.isArray(value) ? value : { value }
  const n = number(item.value)
  if (n === null) throw new Error('仪器参数必须包含有效数值，文字档位应另行填写')
  const unit = typeof item.unit === 'string' && item.unit.trim() ? item.unit.trim() : defaultUnit
  if (!unit || unit.length > 64) throw new Error('参数单位无效')
  return { value: n, unit, unit_source: !item.unit || item.unit_source === 'default' && item.unit.trim() === defaultUnit ? 'default' : item.unit_source === 'configured' ? 'configured' : 'explicit' }
}
const labels = [
  ['is', /(?:电喷雾电压|喷雾电压|离子源电压|离子化电压)\s*(?:[（(]?\s*IS\s*[）)]?)?|\bIS(?=\s|[:：=]|[+-]?\d|$)/gi],
  ['collision', /碰撞气(?:压力|压强)?\s*(?:[（(]?\s*CAD\s*[）)]?)?|\bCAD(?=\s|[:：=]|[+-]?\d|$)/gi],
  ['cur', /气帘气(?:压力)?\s*(?:[（(]?\s*CUR\s*[）)]?)?|\bCUR(?=\s|[:：=]|[+-]?\d|$)/gi],
  ['gs1', /雾化气(?:压力)?\s*(?:[（(]?\s*GS1\s*[）)]?)?|\bGS1(?=\s|[:：=]|[+-]?\d|$)/gi],
  ['gs2', /(?:辅助气|加热气)(?:压力)?\s*(?:[（(]?\s*GS2\s*[）)]?)?|\bGS2(?=\s|[:：=]|[+-]?\d|$)/gi],
  ['source_temperature', /离子源温度\s*(?:[（(]?\s*TEM\s*[）)]?)?|源温\s*(?:[（(]?\s*TEM\s*[）)]?)?|\bTEM(?=\s|[:：=]|[+-]?\d|$)/gi]
]
function tokens(raw) {
  const text = raw.replace(/[−–－]/g, '-'), positions = []
  for (const [key, expression] of labels) { expression.lastIndex = 0; for (const m of text.matchAll(expression)) positions.push({ key, start: m.index, end: m.index + m[0].length }) }
  positions.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept = positions.filter((p, i) => !positions.some((q, j) => j < i && q.start <= p.start && q.end > p.start))
  return kept.map((p, i) => ({ key: p.key, text: text.slice(p.end, kept[i + 1]?.start ?? text.length).replace(/^[\s:：=）)]+/, '') }))
}
export function normalizeAcquisition(method = {}) {
  const conditions = { ...object(method.conditions) }, derived = {}
  const rawValue = method.ion_source_parameters_raw ?? conditions.ion_source_parameters_raw
  const raw = typeof rawValue === 'string' ? rawValue : ''
  const readNumber = text => {
    const m = text.match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(psi|kpa|mpa|mbar|bar|pa|kv|v|℃|°\s*c)?/i)
    return m ? { value: Number(m[1]), ...(m[2] ? { unit: /^°\s*c$/i.test(m[2]) ? '℃' : m[2] } : {}) } : null
  }
  for (const part of tokens(raw)) {
    if (part.key === 'is') {
      const prefix = part.text.match(/^[\s正负模式:：(),（）]*[+-]?[\d.]+(?:\s*(?:kV|V))?(?:\s*[/／、,，;；]\s*[+-]?[\d.]+\s*(?:kV|V)?)*[\sVv]*/)?.[0] || ''
      for (const m of prefix.matchAll(/([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(kV|V)?/gi)) {
        const key = Number(m[1]) < 0 ? 'is_negative' : 'is_positive'
        derived[key] = parameterQuantity({ value: Number(m[1]), ...(m[2] ? { unit: m[2] } : {}) }, parameterDefaultUnits[key])
      }
    } else if (part.key === 'collision') {
      const level = part.text.match(/^(Medium|Low|High|中|低|高)(?:\b|档|级|$)/i)
      if (level) derived.collision_gas_level = level[1]
      else { const value = readNumber(part.text); if (value) derived.collision_gas_pressure = parameterQuantity(value, parameterDefaultUnits.collision_gas_pressure) }
    } else { const value = readNumber(part.text); if (value) derived[part.key] = parameterQuantity(value, parameterDefaultUnits[part.key]) }
  }
  const oldVoltage = conditions.ionization_voltage
  if (!derived.is_positive && !derived.is_negative && oldVoltage != null) {
    const voltage = typeof oldVoltage === 'object' ? oldVoltage : readNumber(String(oldVoltage))
    if (voltage && number(voltage.value) !== null) { const key = Number(voltage.value) < 0 ? 'is_negative' : 'is_positive'; derived[key] = parameterQuantity(voltage, parameterDefaultUnits[key]) }
  }
  if (!derived.collision_gas_pressure && method.cad_value != null && /^(psi|kpa|pa|bar|mbar)$/i.test(method.cad_type || '')) derived.collision_gas_pressure = parameterQuantity({ value: method.cad_value, unit: method.cad_type }, 'psi')
  if (!derived.collision_gas_level && /^(Medium|Low|High|中|低|高)$/i.test(method.cad_type || '')) derived.collision_gas_level = method.cad_type
  const adduct = raw.match(/(?:母离子|前体离子).{0,20}?(?:多为|主要为|通常为|一般为)[^\n；;]*/)?.[0]
  if (adduct) derived.adduct_note = adduct
  for (const key of Object.keys(acquisitionFields)) {
    const explicit = Object.hasOwn(method, key) ? method[key] : Object.hasOwn(conditions, key) ? conditions[key] : undefined
    const value = explicit === undefined ? derived[key] : explicit
    if (value === undefined) continue
    if (quantityParameterKeys.includes(key)) conditions[key] = parameterQuantity(value, parameterDefaultUnits[key])
    else {
      if (value !== null && typeof value !== 'string') throw new Error(`${acquisitionFields[key]}必须为文字`)
      if (typeof value === 'string' && value.length > (key === 'ion_source_parameters_raw' ? 200000 : 4000)) throw new Error(`${acquisitionFields[key]}过长`)
      conditions[key] = value
    }
  }
  return conditions
}
export function acquisitionView(method = {}) {
  const conditions = normalizeAcquisition(method)
  return Object.fromEntries(Object.keys(acquisitionFields).filter(k => conditions[k] !== undefined && conditions[k] !== null && conditions[k] !== '').map(k => [k, conditions[k]]))
}
export function quantityText(value) {
  if (!value) return '未提供'
  return `${value.value} ${value.unit}${value.unit_source === 'default' ? '（默认单位）' : value.unit_source === 'configured' ? '（配置单位）' : ''}`
}
export function acquisitionRowsForMethod(method) { return Object.entries(acquisitionView(method)).map(([key, value]) => ({ label: acquisitionFields[key], value: quantityParameterKeys.includes(key) ? quantityText(value) : String(value) })) }
export function lcFlowRate(method = {}) {
  const c = object(method.conditions)
  if (Object.hasOwn(method, 'flow_rate')) return parameterQuantity(method.flow_rate, parameterDefaultUnits.flow_rate)
  if (c.flow_rate != null) return parameterQuantity(c.flow_rate, parameterDefaultUnits.flow_rate)
  if (c.flow_rate_mL_min != null) return parameterQuantity({ value: c.flow_rate_mL_min, unit: 'mL/min' }, 'mL/min')
  const steps = method.items || method.methodsLinks || method.gradient || []
  const flows = steps.filter(x => number(x.flow_rate) !== null).map(x => ({ ...parameterQuantity({ value: x.flow_rate, unit: x.flow_rate_unit }, 'mL/min'), time: x.time ?? null, time_unit: x.time_unit || 'min' }))
  if (!flows.length) return null
  return flows.every(x => x.value === flows[0].value && x.unit === flows[0].unit && x.unit_source === flows[0].unit_source) ? { value: flows[0].value, unit: flows[0].unit, unit_source: flows[0].unit_source } : { program: flows }
}
