/* eslint-disable @typescript-eslint/no-explicit-any */
import xlsx from 'xlsx'
import { prisma } from '../database'

type ImportStatus = 'ready' | 'warning' | 'error'
type EntityAction = 'match' | 'create'
type Polarity = 0 | 1

interface SpectrumPeak {
  mz: number
  intensity: number
}

export interface SpectrumImportRow {
  rowNo?: number
  spectrumId: string
  compoundId: number | string | null
  cas: string
  compoundName: string
  methodId: number | string | null
  msMode: string
  q1: number | string | null
  q3: number | string | null
  polarity: Polarity | string | null
  collisionEnergy: number | string | null
  precursorType: string
  precursorMz: number | string | null
  spectrumType: string
  instrumentType: string
  instrumentName: string
  ionization: string
  sourceName: string
  notes: string
  peaksText: string
  overwriteExisting: boolean
  compoundAction?: EntityAction
  methodAction?: EntityAction
  compoundMatchKey?: string
  methodMatchKey?: string
  status?: ImportStatus
  messages?: string[]
  peakCount?: number
  hasExistingSpectrum?: boolean
  massSpectrumBase64?: string
}

interface DatabaseCompound {
  id: number
  cas: string | null
  main_name: string | null
  name: unknown
}

interface DatabaseMethod {
  id: number
  compounds_id: number | null
  ms_mode: string | null
  q1: number | null
  q3: number | null
  ce: number | null
  adduct: string | null
  polarity: number | null
  ion_source: string | null
  mass_spectrum_base64: string | null
}

const requiredSpectrumHeaders = [
  '谱图编号*',
  'CAS号',
  '化合物名称',
  '质谱型号',
  'Q1',
  'Q3',
  '极性',
  '碰撞能量',
  '前体类型',
  '前体m/z',
  '谱图类型',
  '仪器类型',
  '仪器名称',
  '离子化方式',
  '谱图来源',
  '备注'
]
const peakHeaders = ['谱图编号*', 'm/z*', '相对强度*']
const numericTolerance = 0.000001

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).normalize('NFKC').trim()
}

function normalizedText(value: unknown): string {
  return textValue(value).toLowerCase().replace(/\s+/g, ' ')
}

function normalizedCas(value: unknown): string {
  return textValue(value).replace(/\s+/g, '')
}

function optionalNumber(
  value: unknown,
  label: string,
  messages: string[],
  options: { positive?: boolean } = {}
): number | null {
  if (value === null || value === undefined || textValue(value) === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    messages.push(`${label}必须是数值`)
    return null
  }
  if (options.positive && parsed <= 0) {
    messages.push(`${label}必须大于0`)
    return null
  }
  return parsed
}

function parsePolarity(value: unknown, messages: string[]): Polarity | null {
  if (value === null || value === undefined || textValue(value) === '') return null
  const normalized = normalizedText(value)
  if (['正', 'p', 'positive', '+', '1'].includes(normalized)) return 1
  if (['负', 'n', 'negative', '-', '0'].includes(normalized)) return 0
  messages.push('极性只能填写正/负、P/N、Positive/Negative或1/0')
  return null
}

function polarityLabel(value: Polarity | null): string {
  if (value === 1) return '正'
  if (value === 0) return '负'
  return ''
}

function closeNumber(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= numericTolerance
}

function compoundNames(compound: DatabaseCompound): string[] {
  const names = new Set<string>()
  if (compound.main_name) names.add(normalizedText(compound.main_name))
  if (Array.isArray(compound.name)) {
    for (const item of compound.name) {
      if (item && typeof item === 'object' && 'name' in item) {
        const name = normalizedText((item as { name?: unknown }).name)
        if (name) names.add(name)
      }
    }
  }
  return [...names]
}

function displayCompoundName(compound: DatabaseCompound): string {
  if (textValue(compound.main_name)) return textValue(compound.main_name)
  if (Array.isArray(compound.name)) {
    const first = compound.name.find(
      (item) => item && typeof item === 'object' && textValue((item as any).name)
    ) as { name?: unknown } | undefined
    if (first) return textValue(first.name)
  }
  return `化合物 ${compound.id}`
}

function methodKey(
  compoundKey: string,
  msMode: string,
  q1: number,
  q3: number,
  polarity: Polarity,
  ce: number | null,
  adduct: string
): string {
  return [
    compoundKey,
    normalizedText(msMode),
    q1.toFixed(6),
    q3.toFixed(6),
    String(polarity),
    ce === null ? 'unknown-energy' : String(ce),
    normalizedText(adduct)
  ].join('|')
}

function parsePeaks(peaksText: unknown, messages: string[]): SpectrumPeak[] {
  const lines = textValue(peaksText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const peaks: SpectrumPeak[] = []
  const seenMz = new Set<string>()
  let duplicateCount = 0

  for (const [index, line] of lines.entries()) {
    const parts = line.split(/[\t,，;；:：\s]+/).filter(Boolean)
    if (parts.length !== 2) {
      messages.push(`峰列表第${index + 1}行应为“m/z,相对强度”`)
      continue
    }
    const mz = Number(parts[0])
    const intensity = Number(parts[1])
    if (!Number.isFinite(mz) || mz <= 0) {
      messages.push(`峰列表第${index + 1}行的m/z必须大于0`)
      continue
    }
    if (!Number.isFinite(intensity) || intensity < 0) {
      messages.push(`峰列表第${index + 1}行的强度必须是非负的有限数值`)
      continue
    }
    const key = mz.toFixed(6)
    if (seenMz.has(key)) duplicateCount += 1
    seenMz.add(key)
    peaks.push({ mz, intensity })
  }

  if (duplicateCount) messages.push(`发现${duplicateCount}个重复m/z，已按原顺序全部保留`)
  if (!peaks.length) messages.push('至少需要一个有效谱峰')
  if (peaks.length && !peaks.some((peak) => peak.intensity > 0)) {
    messages.push('至少需要一个相对强度大于0的谱峰')
  }
  return peaks
}

function peaksToText(peaks: SpectrumPeak[]): string {
  return peaks.map((peak) => `${peak.mz},${peak.intensity}`).join('\n')
}

function hasHeader(sheet: xlsx.WorkSheet, requiredHeaders: string[]): string[] {
  const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null })
  const actual = new Set((rows[0] ?? []).map(textValue))
  return requiredHeaders.filter((header) => !actual.has(header))
}

export function readTemplate(filePath: string): SpectrumImportRow[] {
  const workbook = xlsx.readFile(filePath, { cellDates: false, raw: true })
  const spectrumSheet = workbook.Sheets['谱图信息']
  const peakSheet = workbook.Sheets['峰列表']
  if (!spectrumSheet || !peakSheet) {
    throw new Error('模板必须包含“谱图信息”和“峰列表”工作表')
  }
  const missingSpectrumHeaders = hasHeader(spectrumSheet, requiredSpectrumHeaders)
  const missingPeakHeaders = hasHeader(peakSheet, peakHeaders)
  if (missingSpectrumHeaders.length || missingPeakHeaders.length) {
    const details = [
      missingSpectrumHeaders.length ? `谱图信息缺少：${missingSpectrumHeaders.join('、')}` : '',
      missingPeakHeaders.length ? `峰列表缺少：${missingPeakHeaders.join('、')}` : ''
    ].filter(Boolean)
    throw new Error(`模板表头不完整。${details.join('；')}`)
  }

  const peakRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(peakSheet, {
    defval: null,
    raw: true
  })
  const peaksBySpectrumId = new Map<string, string[]>()
  for (const row of peakRows) {
    const spectrumId = textValue(row['谱图编号*'])
    const mz = textValue(row['m/z*'])
    const intensity = textValue(row['相对强度*'])
    if (!spectrumId && !mz && !intensity) continue
    if (!spectrumId) throw new Error('“峰列表”中存在未填写谱图编号的数据行')
    const line = `${mz},${intensity}`
    peaksBySpectrumId.set(spectrumId, [...(peaksBySpectrumId.get(spectrumId) ?? []), line])
  }

  const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(spectrumSheet, {
    defval: null,
    raw: true
  })
  const inputRows = rows
    .map((row, index) => ({ row, rowNo: index + 2 }))
    .filter(({ row }) => {
      const meaningfulHeaders = requiredSpectrumHeaders.filter(
        (header) => !['谱图类型', '仪器类型', '离子化方式'].includes(header)
      )
      return meaningfulHeaders.some((header) => textValue(row[header]))
    })
    .map(({ row, rowNo }) => {
      const spectrumId = textValue(row['谱图编号*'])
      return {
        rowNo,
        spectrumId,
        compoundId: null,
        cas: textValue(row['CAS号']),
        compoundName: textValue(row['化合物名称']),
        methodId: null,
        msMode: textValue(row['质谱型号']),
        q1: row['Q1'] as number | string | null,
        q3: row['Q3'] as number | string | null,
        polarity: row['极性'] as string | null,
        collisionEnergy: row['碰撞能量'] as number | string | null,
        precursorType: textValue(row['前体类型']),
        precursorMz: row['前体m/z'] as number | string | null,
        spectrumType: textValue(row['谱图类型']),
        instrumentType: textValue(row['仪器类型']),
        instrumentName: textValue(row['仪器名称']),
        ionization: textValue(row['离子化方式']),
        sourceName: textValue(row['谱图来源']) || '用户谱图模板',
        notes: textValue(row['备注']),
        peaksText: (peaksBySpectrumId.get(spectrumId) ?? []).join('\n'),
        overwriteExisting: false
      }
    })
  const knownSpectrumIds = new Set(inputRows.map((row) => row.spectrumId).filter(Boolean))
  const orphanSpectrumIds = [...peaksBySpectrumId.keys()].filter(
    (spectrumId) => spectrumId && !knownSpectrumIds.has(spectrumId)
  )
  if (orphanSpectrumIds.length) {
    throw new Error(`“峰列表”存在未在“谱图信息”定义的编号：${orphanSpectrumIds.join('、')}`)
  }
  return inputRows
}

export async function validateRows(inputRows: SpectrumImportRow[], context?: {compounds:DatabaseCompound[];methods:DatabaseMethod[]}): Promise<SpectrumImportRow[]> {
  const [compounds, methods] = context?[context.compounds,context.methods]:await Promise.all([
    prisma.compounds.findMany({
      where: { is_delete: false },
      select: { id: true, cas: true, main_name: true, name: true }
    }) as Promise<DatabaseCompound[]>,
    prisma.ms_methods.findMany({
      select: {
        id: true,
        compounds_id: true,
        ms_mode: true,
        q1: true,
        q3: true,
        ce: true,
        adduct: true,
        polarity: true,
        ion_source: true,
        mass_spectrum_base64: true
      }
    }) as Promise<DatabaseMethod[]>
  ])

  const compoundsByCas = new Map<string, DatabaseCompound[]>()
  const compoundsByName = new Map<string, DatabaseCompound[]>()
  for (const compound of compounds) {
    const cas = normalizedCas(compound.cas)
    if (cas) compoundsByCas.set(cas, [...(compoundsByCas.get(cas) ?? []), compound])
    for (const name of compoundNames(compound)) {
      compoundsByName.set(name, [...(compoundsByName.get(name) ?? []), compound])
    }
  }
  const methodsByCompound = new Map<number, DatabaseMethod[]>()
  for (const method of methods) {
    if (method.compounds_id === null) continue
    methodsByCompound.set(method.compounds_id, [
      ...(methodsByCompound.get(method.compounds_id) ?? []),
      method
    ])
  }

  const results: SpectrumImportRow[] = []
  for (const [index, input] of inputRows.entries()) {
    const errors: string[] = []
    const warnings: string[] = []
    const spectrumId = textValue(input.spectrumId)
    const cas = normalizedCas(input.cas)
    const inputName = textValue(input.compoundName)
    const normalizedName = normalizedText(inputName)
    const q1Input = optionalNumber(input.q1, 'Q1', errors, { positive: true })
    const q3Input = optionalNumber(input.q3, 'Q3', errors, { positive: true })
    const collisionEnergyInput = optionalNumber(input.collisionEnergy, '碰撞能量', errors)
    const precursorMzInput = optionalNumber(input.precursorMz, '前体m/z', errors, {
      positive: true
    })
    const polarityInput = parsePolarity(input.polarity, errors)
    if (!spectrumId) errors.push('谱图编号不能为空')

    let compound: DatabaseCompound | null = null
    let compoundAction: EntityAction | undefined
    let compoundMatchKey = ''

    if (
      input.compoundId !== null &&
      input.compoundId !== undefined &&
      textValue(input.compoundId)
    ) {
      compound = compounds.find((item) => item.id === Number(input.compoundId)) ?? null
      if (!compound) errors.push('指定化合物 ID 不存在或已删除')
      else {
        compoundAction = 'match'
        compoundMatchKey = `id:${compound.id}`
        if (cas && normalizedCas(compound.cas) && cas !== normalizedCas(compound.cas))
          errors.push('模板 CAS 与指定化合物 ID 不一致，请核对身份')
      }
    } else if (cas || normalizedName) {
      const candidates = [
        ...(cas ? (compoundsByCas.get(cas) ?? []) : []),
        ...(normalizedName ? (compoundsByName.get(normalizedName) ?? []) : [])
      ]
      if (candidates.length) errors.push('存在同 CAS/名称候选，请明确填写化合物 ID；不会自动合并')
      else {
        compoundAction = 'create'
        compoundMatchKey = `new:${spectrumId}`
        warnings.push('将新建独立化合物；多谱图关联可使用新版数据包')
      }
    } else errors.push('请填写化合物名称、CAS 或明确的化合物 ID')

    if (compoundAction === 'create' && !inputName) errors.push('新增化合物必须填写化合物名称')

    if (!textValue(input.msMode)) errors.push('质谱型号不能为空')
    if (q1Input === null) errors.push('Q1不能为空')
    if (q3Input === null) errors.push('Q3不能为空')
    if (polarityInput === null) errors.push('极性不能为空')

    let method: DatabaseMethod | null = null
    let methodAction: EntityAction | undefined
    let methodMatchKey = ''
    const methodIdentityComplete =
      Boolean(compoundMatchKey) &&
      Boolean(textValue(input.msMode)) &&
      q1Input !== null &&
      q3Input !== null &&
      polarityInput !== null

    if (methodIdentityComplete) {
      methodMatchKey = methodKey(
        compoundMatchKey,
        textValue(input.msMode),
        q1Input,
        q3Input,
        polarityInput,
        collisionEnergyInput,
        textValue(input.precursorType)
      )
      if (compound) {
        const candidates = (methodsByCompound.get(compound.id) ?? []).filter(
          (candidate) =>
            normalizedText(candidate.ms_mode) === normalizedText(input.msMode) &&
            closeNumber(candidate.q1, q1Input) &&
            closeNumber(candidate.q3, q3Input) &&
            candidate.polarity === polarityInput &&
            ((candidate.ce === null && collisionEnergyInput === null) ||
              closeNumber(candidate.ce, collisionEnergyInput)) &&
            normalizedText(candidate.adduct) === normalizedText(input.precursorType)
        )
        if (candidates.length) {
          candidates.sort((left, right) => {
            const spectrumDifference =
              Number(Boolean(textValue(left.mass_spectrum_base64))) -
              Number(Boolean(textValue(right.mass_spectrum_base64)))
            return spectrumDifference || left.id - right.id
          })
          method = candidates[0]
          methodAction = 'match'
          if (candidates.length > 1) {
            warnings.push(`发现${candidates.length}条重复方法，已选取方法ID ${method.id}`)
          }
          if (
            collisionEnergyInput !== null &&
            method.ce !== null &&
            !closeNumber(collisionEnergyInput, method.ce)
          ) {
            errors.push('目标方法的碰撞能量与模板不一致，请选择独立方法')
          }
        } else {
          methodAction = 'create'
          warnings.push('未完全匹配到质谱方法，将新增质谱方法')
        }
      } else if (compoundAction === 'create') {
        methodAction = 'create'
        warnings.push('新化合物将同时新增对应质谱方法')
      }
    }

    const peakMessages: string[] = []
    const peaks = parsePeaks(input.peaksText, peakMessages)
    for (const message of peakMessages) {
      if (message.startsWith('发现')) warnings.push(message)
      else errors.push(message)
    }

    const hasExistingSpectrum = Boolean(textValue(method?.mass_spectrum_base64))
    if (hasExistingSpectrum) warnings.push('目标质谱方法已有谱图，保存前必须确认覆盖')

    const resolvedCompoundId = compound?.id ?? null
    const resolvedMethodId = method?.id ?? null
    const resolvedQ1 = method?.q1 ?? q1Input
    const resolvedQ3 = method?.q3 ?? q3Input
    const resolvedPolarity = (method?.polarity as Polarity | null) ?? polarityInput
    const resolvedCollisionEnergy = collisionEnergyInput ?? method?.ce ?? null
    const resolvedName = compound ? displayCompoundName(compound) : inputName
    const resolvedCas = compound ? textValue(compound.cas) : textValue(input.cas)
    const spectrum = {
      schemaVersion: 'mass-spectrum-v1',
      raw: {
        peaksText: input.peaksText,
        cas: input.cas,
        compoundName: input.compoundName,
        precursorType: input.precursorType,
        collisionEnergy: input.collisionEnergy,
        instrumentType: input.instrumentType,
        instrumentName: input.instrumentName,
        ionization: input.ionization
      },
      source: {
        name: textValue(input.sourceName) || '用户谱图模板',
        library: '用户模板',
        nistNumber: '',
        dbNumber: spectrumId
      },
      compound: { id: resolvedCompoundId, name: resolvedName, cas: resolvedCas },
      acquisition: {
        precursorType: textValue(input.precursorType),
        precursorMz: precursorMzInput ?? resolvedQ1,
        spectrumType: textValue(input.spectrumType),
        instrumentType: textValue(input.instrumentType),
        instrument: textValue(input.instrumentName),
        ionization: textValue(input.ionization) || textValue(method?.ion_source),
        ionMode: polarityLabel(resolvedPolarity),
        collisionEnergyText: resolvedCollisionEnergy === null ? '' : String(resolvedCollisionEnergy)
      },
      match: {
        type: 'template',
        q1: resolvedQ1,
        q3: resolvedQ3,
        compoundId: resolvedCompoundId,
        methodId: resolvedMethodId
      },
      metadata: { spectrumId, notes: textValue(input.notes) },
      peaks
    }
    const status: ImportStatus = errors.length ? 'error' : warnings.length ? 'warning' : 'ready'
    results.push({
      rowNo: input.rowNo ?? index + 2,
      spectrumId,
      compoundId: resolvedCompoundId,
      cas: resolvedCas,
      compoundName: resolvedName,
      methodId: resolvedMethodId,
      msMode: method?.ms_mode ?? textValue(input.msMode),
      q1: resolvedQ1,
      q3: resolvedQ3,
      polarity: resolvedPolarity,
      collisionEnergy: resolvedCollisionEnergy,
      precursorType: textValue(input.precursorType),
      precursorMz: precursorMzInput ?? resolvedQ1,
      spectrumType: textValue(input.spectrumType),
      instrumentType: textValue(input.instrumentType),
      instrumentName: textValue(input.instrumentName),
      ionization: textValue(input.ionization) || textValue(method?.ion_source),
      sourceName: textValue(input.sourceName) || '用户谱图模板',
      notes: textValue(input.notes),
      peaksText: peaksToText(peaks),
      overwriteExisting: Boolean(input.overwriteExisting),
      compoundAction,
      methodAction,
      compoundMatchKey,
      methodMatchKey,
      status,
      messages: [...errors, ...warnings],
      peakCount: peaks.length,
      hasExistingSpectrum,
      massSpectrumBase64: errors.length
        ? undefined
        : Buffer.from(JSON.stringify(spectrum), 'utf8').toString('base64')
    })
  }

  const rowsBySpectrumId = new Map<string, SpectrumImportRow[]>()
  const rowsByMethodKey = new Map<string, SpectrumImportRow[]>()
  for (const row of results) {
    if (row.spectrumId) {
      rowsBySpectrumId.set(row.spectrumId, [...(rowsBySpectrumId.get(row.spectrumId) ?? []), row])
    }
    if (row.methodMatchKey) {
      rowsByMethodKey.set(row.methodMatchKey, [
        ...(rowsByMethodKey.get(row.methodMatchKey) ?? []),
        row
      ])
    }
  }
  for (const [spectrumId, rows] of rowsBySpectrumId) {
    if (rows.length < 2) continue
    for (const row of rows) {
      row.status = 'error'
      row.messages = [...(row.messages ?? []), `谱图编号 ${spectrumId} 在同一批次中重复`]
      row.massSpectrumBase64 = undefined
    }
  }
  for (const rows of rowsByMethodKey.values()) {
    if (rows.length < 2) continue
    for (const row of rows) {
      row.status = 'error'
      row.messages = [...(row.messages ?? []), '同一批次中相同化合物和质谱方法出现多次']
      row.massSpectrumBase64 = undefined
    }
  }
  return results
}

export function validationSummary(rows: SpectrumImportRow[]): {
  total: number
  errors: number
  warnings: number
  ready: number
  compounds: number
  methods: number
  newCompounds: number
  newMethods: number
} {
  const errors = rows.filter((row) => row.status === 'error').length
  const warnings = rows.filter((row) => row.status === 'warning').length
  const compoundKeys = new Set(rows.map((row) => row.compoundMatchKey).filter(Boolean))
  const methodKeys = new Set(rows.map((row) => row.methodMatchKey).filter(Boolean))
  const newCompoundKeys = new Set(
    rows
      .filter((row) => row.compoundAction === 'create')
      .map((row) => row.compoundMatchKey)
      .filter(Boolean)
  )
  const newMethodKeys = new Set(
    rows
      .filter((row) => row.methodAction === 'create')
      .map((row) => row.methodMatchKey)
      .filter(Boolean)
  )
  return {
    total: rows.length,
    ready: rows.length - errors,
    errors,
    warnings,
    compounds: compoundKeys.size,
    methods: methodKeys.size,
    newCompounds: newCompoundKeys.size,
    newMethods: newMethodKeys.size
  }
}

function spectrumWithResolvedIds(
  row: SpectrumImportRow,
  compoundId: number,
  methodId: number
): string {
  if (!row.massSpectrumBase64) throw new Error(`谱图 ${row.spectrumId} 缺少编码数据`)
  const spectrum = JSON.parse(Buffer.from(row.massSpectrumBase64, 'base64').toString('utf8'))
  spectrum.compound = { ...(spectrum.compound ?? {}), id: compoundId }
  spectrum.match = { ...(spectrum.match ?? {}), compoundId, methodId }
  return Buffer.from(JSON.stringify(spectrum), 'utf8').toString('base64')
}

export async function prepareSpectrumRows(
  inputRows: SpectrumImportRow[]
): Promise<SpectrumImportRow[]> {
  const rows = await validateRows(Array.isArray(inputRows) ? inputRows : [])
  for (const row of rows)
    if (row.hasExistingSpectrum && !row.overwriteExisting) {
      row.status = 'error'
      row.messages = [...(row.messages ?? []), '目标方法已有谱图，尚未确认覆盖']
    }
  if (!rows.length || validationSummary(rows).errors)
    throw new Error('存在未通过校验的谱图，整批数据未写入')
  return rows
}

export async function writePreparedSpectrumRows(
  tx: any,
  rows: SpectrumImportRow[]
): Promise<{ newCompoundCount: number; newMethodCount: number }> {
  const compoundIds = new Map<string, number>()
  for (const row of rows) {
    if (row.compoundAction === 'match' && row.compoundMatchKey) {
      compoundIds.set(row.compoundMatchKey, Number(row.compoundId))
    }
  }

  const newCompoundGroups = new Map<string, SpectrumImportRow[]>()
  for (const row of rows) {
    if (row.compoundAction !== 'create' || !row.compoundMatchKey) continue
    newCompoundGroups.set(row.compoundMatchKey, [
      ...(newCompoundGroups.get(row.compoundMatchKey) ?? []),
      row
    ])
  }
  for (const [key, group] of newCompoundGroups) {
    const cas = group.map((row) => textValue(row.cas)).find(Boolean) || null
    const name = group.map((row) => textValue(row.compoundName)).find(Boolean) || null
    const created = await tx.compounds.create({
      data: {
        cas,
        main_name: name,
        name: name ? [{ name, area: '' }] : undefined,
        formula: null,
        molecular_mass: null,
        monoisotopic_mass: null,
        formula_diagram_base64: '',
        is_favorite: false,
        is_in_trash: false,
        is_delete: false,
        create_time: new Date()
      }
    })
    compoundIds.set(key, created.id)
  }

  let newMethodCount = 0
  for (const row of rows) {
    const compoundId = compoundIds.get(row.compoundMatchKey ?? '')
    if (!compoundId) throw new Error(`谱图 ${row.spectrumId} 无法解析化合物ID`)

    if (row.methodAction === 'match') {
      const methodId = Number(row.methodId)
      const massSpectrumBase64 = spectrumWithResolvedIds(row, compoundId, methodId)
      const data: any = {
        mass_spectrum_base64: massSpectrumBase64,
        update_time: new Date(),
        revision: { increment: 1 }
      }
      if (row.collisionEnergy !== null && textValue(row.collisionEnergy)) {
        data.ce = Number(row.collisionEnergy)
      }
      if (textValue(row.ionization)) data.ion_source = textValue(row.ionization)
      if (textValue(row.spectrumType)) data.scan_mode = textValue(row.spectrumType)
      const result = await tx.ms_methods.updateMany({
        where: { id: methodId, compounds_id: compoundId },
        data
      })
      if (result.count !== 1) {
        throw new Error(`谱图 ${row.spectrumId} 的目标质谱方法已发生变化，请重新加载模板`)
      }
    } else if (row.methodAction === 'create') {
      const method = await tx.ms_methods.create({
        data: {
          compounds_id: compoundId,
          ms_mode: textValue(row.msMode),
          adduct: textValue(row.precursorType) || null,
          q1: Number(row.q1),
          q3: Number(row.q3),
          ce: textValue(row.collisionEnergy) ? Number(row.collisionEnergy) : null,
          dp: null,
          cxp: null,
          polarity: Number(row.polarity),
          ion_source: textValue(row.ionization) || null,
          scan_mode: textValue(row.spectrumType) || null,
          cad_value: null,
          cad_type: null,
          mass_spectrum_base64: null,
          create_time: new Date()
        }
      })
      const massSpectrumBase64 = spectrumWithResolvedIds(row, compoundId, method.id)
      await tx.ms_methods.update({
        where: { id: method.id },
        data: { mass_spectrum_base64: massSpectrumBase64, update_time: new Date() }
      })
      newMethodCount += 1
    } else {
      throw new Error(`谱图 ${row.spectrumId} 缺少质谱方法处理方式`)
    }
  }
  return { newCompoundCount: newCompoundGroups.size, newMethodCount }
}
