// Formatting for display only. The original numeric text and source objects remain intact.
export function numericText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未提供'
  return String(value)
    .replace(/(\.\d*?[1-9])0+$/, '$1')
    .replace(/\.0+$/, '')
}
function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
function scalar(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'object') return null
  return String(value)
}
export function energyText(value: unknown): string {
  const energy = record(value)
  if (!energy) return scalar(value) ?? '未提供'
  const number = scalar(energy.value)
  const unit = scalar(energy.scale) ?? scalar(energy.unit)
  if (number !== null) {
    const label = unit ? ` ${unit}` : ''
    const normalized = energy.energy_type === 'normalized' ? '（归一化）' : ''
    return numericText(number) + label + normalized
  }
  return scalar(energy.raw) ?? '未提供；可展开原始记录查看'
}
export interface SpectrumDisplay {
  kind?: unknown
  spectrum_type?: unknown
  peaks?: unknown
  methodIds?: readonly unknown[]
}
export interface MethodDisplay {
  id?: unknown
  ms_mode?: unknown
  q1?: unknown
  q3?: unknown
  scan_mode?: unknown
}

export function displayNameLines(row: {
  name_zh?: unknown
  name_en?: unknown
  main_name?: unknown
}): string[] {
  const name = (value: unknown): string => scalar(value)?.trim() ?? ''
  const bilingual = [...new Set([name(row.name_zh), name(row.name_en)].filter(Boolean))]
  return bilingual.length ? bilingual : [name(row.main_name)].filter(Boolean)
}

export function energyTypeText(value: unknown): string {
  const labels: Record<string, string> = { normalized: '归一化', fixed: '固定能量' }
  const text = scalar(value)?.trim()
  return text ? (labels[text.toLowerCase()] ?? text) : '未提供'
}

export function ms2PeakCount(spectra: readonly SpectrumDisplay[] = []): number {
  const ms2 = spectra.filter(
    (spectrum) =>
      spectrum.kind === 'numeric' &&
      ['MS2', 'MS/MS', 'LC-MS/MS'].includes(
        String(spectrum.spectrum_type ?? '')
          .trim()
          .toUpperCase()
      )
  )
  const validNumber = (value: unknown): boolean =>
    (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isFinite(Number(value))
  return ms2.reduce(
    (total, spectrum) =>
      total +
      (Array.isArray(spectrum.peaks)
        ? spectrum.peaks.filter((peak: unknown) => {
            const point = record(peak)
            return (
              point &&
              validNumber(point.mz) &&
              Number(point.mz) > 0 &&
              validNumber(point.intensity) &&
              Number(point.intensity) >= 0
            )
          }).length
        : 0),
    0
  )
}

export function transitionText(
  q1: unknown,
  q3: unknown,
  _scanMode?: unknown,
  spectra: readonly SpectrumDisplay[] = []
): string {
  const precursor = numericText(q1)
  if (hasValue(q3)) return `${precursor} → ${numericText(q3)}`
  const count = ms2PeakCount(spectra)
  const fragments = count ? `MS2碎片谱峰 ${count} 条；` : ''
  return `${precursor} → ${fragments}固定Q3未指定`
}

export function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

export function productIonText(q3: unknown, spectra: readonly SpectrumDisplay[] = []): string {
  if (hasValue(q3)) return numericText(q3)
  const count = ms2PeakCount(spectra)
  return count ? `${count} 条MS2谱峰` : '未提供'
}

export function methodTransitionText(
  method: MethodDisplay,
  spectra: readonly SpectrumDisplay[] = []
): string {
  const linked =
    method.id === null || method.id === undefined
      ? []
      : spectra.filter((spectrum) =>
          spectrum.methodIds?.some((id) => String(id) === String(method.id))
        )
  return transitionText(method.q1, method.q3, method.scan_mode, linked)
}

export function methodLabel(
  method: MethodDisplay,
  spectra: readonly SpectrumDisplay[] = []
): string {
  return `${scalar(method.ms_mode) || '仪器未提供'} · ${scalar(method.scan_mode) || '采集模式未提供'} · ${methodTransitionText(method, spectra)}`
}
export function energyMethodText(value: unknown, unit: unknown, type: unknown): string {
  if (value === null || value === undefined || value === '') return '未提供'
  const suffix = unit ? ` ${unit}` : ''
  const normalized = type === 'normalized' ? '（归一化）' : ''
  return `${numericText(value)}${suffix}${normalized}`
}

function sourceStrings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) value = parsed
    } catch {
      // Keep the unrecognized source text.
    }
  }
  return (Array.isArray(value) ? value : [value]).flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [item.trim()]
    const entry = record(item)
    const phase = typeof entry?.field === 'string' ? entry.field.match(/^(?:Solvent|Phase|MobilePhase)[_ ]?([AB])$/i) : null
    return phase && typeof entry?.value === 'string'
      ? ['SOLVENT ' + phase[1].toUpperCase() + ' ' + entry.value] : []
  })
}

function liquidOriginal(method: Record<string, unknown>) {
  const conditions = record(method.conditions) ?? {}
  return {
    values: record(conditions.original_values) ?? {},
    chromatography: record(conditions.original_chromatography) ?? {},
    particleSize: conditions.particle_size_original
  }
}

type Phase = 'A' | 'B'
function labeledPhases(values: string[]): Partial<Record<Phase, string>> | null {
  const separator = /(?:[;；\n]+|,\s*)(?=\s*(?:SOLVENT\s+|MOBILE\s+PHASE\s+)?[AB](?:\s|[:：=]))/i
  const phases: Partial<Record<Phase, string>> = {}
  for (const text of values.flatMap(value => value.split(separator))) {
    const match = text.trim().match(/^(?:(?:SOLVENT\s+|MOBILE\s+PHASE\s+)([AB])(?:\s*[:：=]\s*|\s+)|([AB])\s*[:：=]\s*)(.+)$/i)
    if (!match) return null
    const phase = (match[1] || match[2]).toUpperCase() as Phase
    const value = match[3].trim()
    if (!value || (phases[phase] && phases[phase] !== value)) return null
    phases[phase] = value
  }
  return phases
}

export function mobilePhaseDisplay(method: Record<string, unknown>) {
  const a = sourceStrings(method.phase_A)
  const b = sourceStrings(method.phase_B)
  const fromA = labeledPhases(a)
  const fromB = labeledPhases(b)
  const original = liquidOriginal(method)
  const fromSource = labeledPhases(sourceStrings(original.values.mobile_phase ?? original.chromatography.SOLVENT))
  return {
    phase_A: (fromA ? fromA.A : a.join('；')) || fromB?.A || fromSource?.A || '',
    phase_B: (fromB ? fromB.B : b.join('；')) || fromA?.B || fromSource?.B || '',
    source: fromA?.B || fromB?.A ? [...a, ...b].join('；') : ''
  }
}

interface ProgramStep {
  time: string | null
  time_unit: 'min' | 's' | null
  percentage_A: number
  percentage_B: number | null
}

export function liquidProgramDisplay(value: unknown): {
  steps: ProgramStep[]
  elution: 'gradient' | 'isocratic' | null
} {
  const empty = { steps: [], elution: null }
  const text = sourceStrings(value).join('; ')
  if (!text) return empty
  const ratio = '(\\d+(?:\\.\\d+)?)\\s*%?\\s*[/：:]\\s*(\\d+(?:\\.\\d+)?)\\s*%?'
  const time = '(\\d+(?:\\.\\d+)?)(?:\\s*[-–—]\\s*(\\d+(?:\\.\\d+)?))?'
  const unit = '(min(?:ute)?s?|s(?:ec(?:ond)?s?)?|分钟|秒)'
  const ratioAtTime = new RegExp('^' + ratio + '\\s+at\\s+' + time + '(?:\\s*' + unit + ')?$', 'i')
  const timedA = new RegExp('^' + time + '\\s*' + unit + '\\s+(\\d+(?:\\.\\d+)?)\\s*%\\s*A$', 'i')
  const fixed = text.match(new RegExp('^' + ratio + '\\s+(?:isocratic|等度)$', 'i'))
  const valid = (a: number, b: number | null) =>
    a >= 0 && a <= 100 && (b === null || (b >= 0 && b <= 100 && Math.abs(a + b - 100) <= 0.05))
  if (fixed) {
    const a = Number(fixed[1]), b = Number(fixed[2])
    return valid(a, b) ? { steps: [{ time: null, time_unit: null, percentage_A: a, percentage_B: b }], elution: 'isocratic' } : empty
  }

  const steps: ProgramStep[] = []
  let lastSeconds: number | undefined
  for (const token of text.split(/[,，;；\r\n]+/).map(part => part.trim()).filter(Boolean)) {
    const part = token.replace(/\b(min|s)\s+\1\b/i, '$1')
    const pair = part.match(ratioAtTime)
    const single = pair ? null : part.match(timedA)
    if (!pair && !single) return empty
    const a = Number(pair ? pair[1] : single![4])
    const b = pair ? Number(pair[2]) : null
    const start = pair ? pair[3] : single![1]
    const end = pair ? pair[4] : single![2]
    const rawUnit = pair ? pair[5] : single![3]
    const timeUnit = rawUnit ? (/^(min|分钟)/i.test(rawUnit) ? 'min' : 's') : null
    if (!valid(a, b) || !Number.isFinite(Number(start)) ||
        (end !== undefined && (!Number.isFinite(Number(end)) || Number(end) < Number(start)))) return empty
    if (timeUnit) {
      const factor = timeUnit === 'min' ? 60 : 1
      if (lastSeconds !== undefined && Number(start) * factor < lastSeconds) return empty
      lastSeconds = Number(end ?? start) * factor
    } else lastSeconds = undefined
    steps.push({ time: end === undefined ? start : start + '–' + end, time_unit: timeUnit,
      percentage_A: a, percentage_B: b })
  }
  const changes = steps.some(step => step.percentage_A !== steps[0]?.percentage_A ||
    (step.percentage_B !== null && steps[0]?.percentage_B != null && step.percentage_B !== steps[0].percentage_B))
  return { steps, elution: changes ? 'gradient' : null }
}

function mainColumnDescriptions(method: Record<string, unknown>): string[] {
  const original = liquidOriginal(method)
  return [method.column_type, method.chromatographic_column_mode, original.chromatography.COLUMN_NAME, original.values.column]
    .flatMap(sourceStrings)
    .map(text => text.split(/\b(?:pre[-\s]?column|guard(?:\s+column)?)\b|预柱|保护柱/i)[0])
    .filter(Boolean)
}

const micron = /(?<![\d.\-])(\d+(?:\.\d+)?)\s*[uμµ]m\b/gi
const filmLabel = /(?:film\s+thickness|膜厚|涂层厚度)/i

function columnMicrons(method: Record<string, unknown>, film: boolean): number | null {
  const descriptions = mainColumnDescriptions(method)
  if (!film) descriptions.push(...sourceStrings(liquidOriginal(method).particleSize))
  const candidates = new Set<number>()
  for (const text of descriptions) {
    for (const match of text.matchAll(micron)) {
      const before = text.slice(0, match.index).match(/[^,，;；()（）]*$/)?.[0] ?? ''
      const after = text.slice(match.index + match[0].length).match(/^[^,，;；()（）]*/)?.[0] ?? ''
      if (filmLabel.test(before) || filmLabel.test(after)) {
        if (!film) continue
      } else if (film) continue
      const value = Number(match[1])
      if (Number.isFinite(value) && value > 0) candidates.add(value)
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null
}

// Accept source spellings such as uM only in column descriptions, never in solvent concentrations.
export function columnParticleSize(method: Record<string, unknown>): number | null {
  if (hasValue(method.column_particle_size_um)) {
    const value = Number(method.column_particle_size_um)
    return Number.isFinite(value) ? value : null
  }
  return columnMicrons(method, false)
}

export function columnFilmThickness(method: Record<string, unknown>): number | null {
  return columnMicrons(method, true)
}

export function retentionTimeInMinutes(value: unknown, unit: unknown): number | null {
  if (!hasValue(value) || !Number.isFinite(Number(value))) return null
  const sourceUnit = (scalar(unit) ?? 'min').trim().toLowerCase() || 'min'
  const factors: Record<string, number> = {
    min: 1,
    'min.': 1,
    minute: 1,
    minutes: 1,
    分钟: 1,
    s: 1 / 60,
    sec: 1 / 60,
    second: 1 / 60,
    seconds: 1 / 60,
    秒: 1 / 60,
    h: 60,
    hr: 60,
    hour: 60,
    hours: 60,
    小时: 60,
    ms: 1 / 60000,
    millisecond: 1 / 60000,
    milliseconds: 1 / 60000
  }
  const factor = factors[sourceUnit]
  return factor === undefined ? null : Number((Number(value) * factor).toPrecision(15))
}

export function retentionTimeText(value: unknown, unit: unknown): string {
  if (!hasValue(value)) return '未提供'
  const minutes = retentionTimeInMinutes(value, unit)
  return minutes === null
    ? `${numericText(value)} ${scalar(unit) ?? ''}（原始单位）`.trim()
    : `${numericText(minutes)} min${scalar(unit)?.trim() ? '' : '（默认单位）'}`
}

export interface ConditionRow {
  label: string
  value: string
}

export function liquidConditionRows(value: unknown): ConditionRow[] {
  const conditions = record(value)
  if (!conditions) return []
  const original = record(conditions.original_chromatography) ?? {}
  const first = (key: string): unknown => {
    const v = original[key]
    return Array.isArray(v) ? v[0] : v
  }
  const solvent = (Array.isArray(original.SOLVENT) ? original.SOLVENT : []) as unknown[]
  const solventText = solvent.map(String).join('；')
  const entries: [string, unknown][] = [
    [
      '来源记录数',
      Array.isArray(conditions.record_accessions) ? conditions.record_accessions.length : null
    ],
    ['流速', first('FLOW_RATE')],
    ['原始保留时间', first('RETENTION_TIME')],
    ['NAPS_RTI（来源原字段）', first('NAPS_RTI')],
    ['原始色谱柱', first('COLUMN_NAME')],
    ['原始流动相', solventText],
    ['原始梯度', first('FLOW_GRADIENT')],
    ['粒径说明', conditions.particle_size_mapping],
    ['保留时间说明', conditions.retention_time_mapping]
  ]
  return entries.flatMap(([label, v]) => (scalar(v) === null ? [] : [{ label, value: String(v) }]))
}

export function acquisitionRows(value: unknown, scanMode?: unknown): ConditionRow[] {
  const parsed = record(value)
  const conditions = parsed ?? {}
  const original = record(conditions.original_mass_spectrometry) ?? {}
  function originalValue(key: string): unknown {
    const v = original[key]
    return Array.isArray(v) ? v[0] : v
  }
  const voltage = record(conditions.ionization_voltage)
  const voltageText = voltage
    ? scalar(voltage.value) !== null
      ? `${numericText(voltage.value)}${scalar(voltage.unit) ? ' ' + voltage.unit : ''}`
      : scalar(voltage.raw)
    : scalar(conditions.ionization_voltage)
  const comments = (
    Array.isArray(conditions.source_comments)
      ? conditions.source_comments
      : [conditions.source_comments]
  )
    .map(scalar)
    .filter((comment): comment is string => comment !== null && comment.trim() !== '')
  const confidence = comments.filter((comment) =>
    /^CONFIDENCE(?:\s+|[:：]\s*)\S/i.test(comment.trim())
  )
  const notes = comments.filter((comment) => !confidence.includes(comment))
  const confidenceText = [
    ...new Set([scalar(conditions.confidence), ...confidence].filter(Boolean))
  ].join('；')
  const entries: [string, unknown][] = [
    ['采集模式', scalar(scanMode) ?? conditions.scan_mode ?? originalValue('MS_TYPE')],
    ['仪器类型', conditions.instrument_type],
    ['离子源', conditions.ion_source ?? conditions.ionization ?? originalValue('IONIZATION')],
    ['离子源电压', voltageText ?? originalValue('IONIZATION_VOLTAGE')],
    ['碎裂方式', conditions.fragmentation_mode ?? originalValue('FRAGMENTATION_MODE')],
    ['分辨率', conditions.resolution ?? originalValue('RESOLUTION')],
    ['原始记录编号', conditions.source_accession],
    ['数据置信度（来源声明）', confidenceText],
    ['来源备注', [...new Set(notes)].join('；')],
    ['条件说明', !parsed ? scalar(value) : null]
  ]
  return entries.flatMap(([label, v]) => (scalar(v) === null ? [] : [{ label, value: String(v) }]))
}

// Display-only extraction. Existing dimensions take precedence over source text.
export function columnDimensionValue(method: Record<string, unknown>, field: string): unknown {
  if (field !== 'column_type' && hasValue(method[field])) return method[field]
  if (field === 'column_type') {
    const descriptions = [...new Set(mainColumnDescriptions(method))]
    return descriptions.length === 1 ? descriptions[0].trim().replace(/\bwith\s*$/i, '').trim() : method.column_type || null
  }
  if (field === 'column_particle_size_um') return columnParticleSize(method)
  if (field !== 'column_length_mm' && field !== 'column_inner_diameter_mm') return method[field]

  const pairs = new Map<string, { length: number; diameter: number }>()
  const add = (length: number, diameter: number) => {
    if (diameter > 0 && diameter <= 10 && length >= 20 && length > diameter)
      pairs.set(length + ':' + diameter, { length, diameter })
  }
  const millimeters = (value: string, unit: string) => Number(value) * (unit.toLowerCase() === 'm' ? 1000 : 1)
  for (const text of mainColumnDescriptions(method)) {
    for (const match of text.matchAll(/(?<![\d.\-])(\d+(?:\.\d+)?)\s*(mm|m)?\s*[x×✕*]\s*(\d+(?:\.\d+)?)\s*(mm|m)\b/gi)) {
      const a = millimeters(match[1], match[2] || match[4])
      const b = millimeters(match[3], match[4])
      const length = Math.max(a, b)
      if (length <= (/^m$/i.test(match[2] || '') || /^m$/i.test(match[4]) ? 150000 : 1000))
        add(length, Math.min(a, b))
    }

    const meterLengths = [...text.matchAll(/(?<![\d.\-])(\d+(?:\.\d+)?)\s*m\b/gi)]
    const diameters = [...text.matchAll(/(?<![\d.\-])(\d+(?:\.\d+)?)\s*mm\s*(?:i\.?\s*d\.?\b|内径)|(?:内径|i\.?\s*d\.?)\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*mm\b/gi)]
    if (meterLengths.length === 1 && diameters.length === 1) {
      const length = millimeters(meterLengths[0][1], 'm')
      if (length <= 150000) add(length, Number(diameters[0][1] || diameters[0][2]))
    }
  }
  if (pairs.size !== 1) return null
  const pair = [...pairs.values()][0]
  return field === 'column_length_mm' ? pair.length : pair.diameter
}
