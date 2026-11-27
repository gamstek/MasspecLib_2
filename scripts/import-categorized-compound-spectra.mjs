import './legacy-disabled.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import * as OCL from 'openchemlib'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true })

const apply = process.argv.includes('--apply')
const docsArg = process.argv.find((value) => value.startsWith('--docs='))
const docsDir = path.resolve(projectRoot, docsArg ? docsArg.slice('--docs='.length) : 'docs')
const sourceSpecs = [
  { file: '非法添加.csv', className: '非法添加' },
  { file: '农药.csv', className: '农药' },
  { file: '兽药.csv', className: '兽药' },
  { file: '新污染物.csv', className: '新型污染物' }
]
const requiredHeaders = [
  'pubchem_name',
  'chinese_name_final',
  'cas',
  'formula',
  'smiles',
  'inchikey',
  '前体类型',
  '碰撞能量',
  '前体m/z',
  '完整峰列表(m/z:强度)'
]
const derivedClasses = ['抗生素', '全氟化合物', '真菌毒素']
const numericTolerance = 0.01

const PFAS_PATTERN =
  /(?:perfluoro|polyfluoro|fluorotelomer|\bpf(?:os|oa|hxs|bs|ds|da|doa|hps|hpa|hxda|na|nona|oda|pea|pesa|tes|teda|trda|uda|unda|eesa|osa)\b|mpf(?:os|oa|hxs)|\b\d{1,2}:\d(?:\/\d{1,2}:\d)?\s*(?:ft(?:oh|ca|uca|s|p)?|di\s*pap|pap)\b|8cl-pfos|全氟)/i
const MYCOTOXIN_PATTERN =
  /(?:aflatoxin|aflatoxicol|aflatrem|ochratoxin|patulin|fumonisin|zearalen|zearalan|nivalenol|deoxynivalenol|deepoxy[- ]?deoxynivalenol|\bdon(?:-|\b)|\bht-?2\b|\bt-?2(?:\s*toxin|-triol|-tetraol|\b)|neosolaniol|diacetoxyscirpenol|fusarenon|sterigmatocystin|citrinin|verrucarin|alternariol|tenuazonic)/i
const ANTIBIOTIC_PATTERN =
  /(?:\b[a-z]+floxacin\b|\b[a-z]*cillin\b|\bpenicillin\b|\bcef[a-z]+\b|\bceph[a-z]+\b|\b[a-z]+cycline\b|\bsulfa(?:diazine|dimethoxine|dimidine|furazole|isodimidine|lene|merazine|methazine|methizole|methoxazole|methoxypyridazine|monomethoxine|pyridine|quinoxaline|thiazole|doxin|chloropyridazine|benzamide|nitran)\b|amikacin|gentamicin|kanamycin|neomycin|streptomycin|tobramycin|apramycin|sisomicin|netilmicin|ribostamycin|hygromycin\s*b|spectinomycin|erythromycin|azithromycin|clarithromycin|roxithromycin|spiramycin|tilmicosin|tylosin|tulathromycin|gamithromycin|josamycin|oleandomycin|kitasamycin|leucomycin|virginiamycin|clindamycin|lincomycin|pirlimycin|chloramphenicol|thiamphenicol|florfenicol|metronidazole|tinidazole|ornidazole|ronidazole|dimetridazole|imipenem|meropenem|ertapenem|doripenem|vancomycin|teicoplanin|dalbavancin|oritavancin|linezolid|daptomycin|bacitracin|colistin|polymyxin|fosfomycin|tiamulin|valnemulin|pleuromutilin|nitrofurantoin|nitrofurazone|furazolidone|furaltadone)/i

function text(value) {
  return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim()
}

function normalizedHeader(value) {
  return text(value).replaceAll('（', '(').replaceAll('）', ')')
}

function parseCsv(csvText, sourceFile) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index]
    if (quoted) {
      if (character === '"' && csvText[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
      continue
    }
    if (character === '"') quoted = true
    else if (character === ',') {
      row.push(cell)
      cell = ''
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && csvText[index + 1] === '\n') index += 1
      row.push(cell)
      cell = ''
      if (row.some((value) => text(value))) rows.push(row)
      row = []
    } else {
      cell += character
    }
  }
  if (quoted) throw new Error(`${sourceFile} 存在未闭合的 CSV 引号`)
  row.push(cell)
  if (row.some((value) => text(value))) rows.push(row)
  if (!rows.length) throw new Error(`${sourceFile} 没有可读取的数据`)

  const headers = rows[0].map(normalizedHeader)
  const duplicates = headers.filter((header, index) => header && headers.indexOf(header) !== index)
  if (duplicates.length) throw new Error(`${sourceFile} 存在重复表头：${[...new Set(duplicates)].join('、')}`)
  return {
    headers,
    rows: rows.slice(1).map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    )
  }
}

function normalizedName(value) {
  return text(value)
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function normalizedFormula(value) {
  return text(value).replace(/[\s·.]/g, '')
}

function normalizedInchiKey(value) {
  const candidate = text(value).toUpperCase()
  return /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(candidate) ? candidate : ''
}

function validCas(value) {
  if (!/^\d{2,7}-\d{2}-\d$/.test(value)) return false
  const digits = value.replaceAll('-', '')
  const sum = digits
    .slice(0, -1)
    .split('')
    .reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index + 1), 0)
  return sum % 10 === Number(digits.at(-1))
}

function normalizedCas(value) {
  const raw = text(value)
  const direct = raw.match(/\b\d{2,7}-\d{2}-\d\b/)?.[0] ?? ''
  if (validCas(direct)) return direct
  const date = raw.match(/^(\d{2,7})\/(\d{1,2})\/(\d)$/)
  if (date) {
    const firstParts = /^(?:19|20)\d{2}$/.test(date[1])
      ? [date[1].slice(-2), date[1]]
      : [date[1]]
    for (const firstPart of firstParts) {
      const candidate = `${firstPart}-${date[2].padStart(2, '0')}-${date[3]}`
      if (validCas(candidate)) return candidate
    }
  }
  return ''
}

function formulaCounts(value) {
  const counts = new Map()
  const formula = normalizedFormula(value)
  for (const match of formula.matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2] || 1))
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function sameFormula(left, right) {
  return JSON.stringify(formulaCounts(left)) === JSON.stringify(formulaCounts(right))
}

function firstNumber(value) {
  const match = text(value).match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/)
  if (!match) return null
  const number = Number(match[0])
  return Number.isFinite(number) ? number : null
}

function scalarCollisionEnergy(value) {
  const raw = text(value)
  const matches = raw.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []
  if (matches.length !== 1) return null
  const number = Number(matches[0])
  return Number.isFinite(number) ? number : null
}

function polarityFromPrecursor(value) {
  const precursor = text(value).replaceAll(' ', '')
  if (!precursor) return null
  if (/^\[?M-H\]?-?$/i.test(precursor)) return 0
  if (/(?:\]|\d)\+$/i.test(precursor) || /positive/i.test(precursor)) return 1
  if (/(?:\]|\d)-$/i.test(precursor) || /negative/i.test(precursor)) return 0
  return null
}

function parsePeaks(value, sourceLabel) {
  const peaksByMz = new Map()
  let rawPeakCount = 0
  for (const part of text(value).split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(':')
    if (separator < 1) throw new Error(`${sourceLabel} 的峰“${trimmed}”缺少冒号`)
    const mz = Number(trimmed.slice(0, separator).trim())
    const intensity = Number(trimmed.slice(separator + 1).trim())
    if (!Number.isFinite(mz) || mz <= 0 || !Number.isFinite(intensity) || intensity < 0) {
      throw new Error(`${sourceLabel} 的峰“${trimmed}”数值无效`)
    }
    rawPeakCount += 1
    const key = mz.toFixed(6)
    const existing = peaksByMz.get(key)
    if (!existing || intensity > existing.intensity) peaksByMz.set(key, { mz, intensity })
  }
  const peaks = [...peaksByMz.values()]
  if (!peaks.length) throw new Error(`${sourceLabel} 没有有效峰`)
  return {
    peaks: peaks.sort((left, right) => left.mz - right.mz),
    rawPeakCount,
    duplicatePeakCount: rawPeakCount - peaks.length
  }
}

function selectProductIon(peaks, precursorMz) {
  if (!Number.isFinite(precursorMz)) return null
  const products = peaks.filter((peak) => Math.abs(peak.mz - precursorMz) > 0.5)
  const candidates = products.length ? products : peaks
  return [...candidates].sort(
    (left, right) => right.intensity - left.intensity || left.mz - right.mz
  )[0]
}

function structureFromSmiles(smiles, expectedFormula) {
  try {
    const molecule = OCL.Molecule.fromSmiles(smiles)
    const formula = molecule.getMolecularFormula()
    molecule.inventCoordinates()
    return {
      svg: molecule.toSVG(300, 300, '', { autoCrop: true }),
      molecularMass: Number.isFinite(formula.relativeWeight)
        ? Number(formula.relativeWeight.toFixed(6))
        : null,
      monoisotopicMass: Number.isFinite(formula.absoluteWeight)
        ? Number(formula.absoluteWeight.toFixed(6))
        : null,
      calculatedFormula: text(formula.formula),
      formulaMatches: sameFormula(formula.formula, expectedFormula),
      error: ''
    }
  } catch (error) {
    return {
      svg: '',
      molecularMass: null,
      monoisotopicMass: null,
      calculatedFormula: '',
      formulaMatches: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function parseNames(value) {
  if (value === null || value === undefined) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) =>
        typeof item === 'string'
          ? { area: '', name: text(item) }
          : { area: text(item?.area), name: text(item?.name) }
      )
      .filter((item) => item.name)
  } catch {
    return []
  }
}

function mergeNames(existing, records) {
  const merged = parseNames(existing)
  const seen = new Set(merged.map((item) => normalizedName(item.name)).filter(Boolean))
  for (const record of records) {
    for (const [name, area] of [
      [record.englishName, '北美'],
      [record.chineseName, '中国']
    ]) {
      const key = normalizedName(name)
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push({ name, area })
    }
  }
  return merged
}

function decodeSpectrum(value) {
  const encoded = text(value)
  if (!encoded) return null
  try {
    const content = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded
    return JSON.parse(Buffer.from(content, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function parseSources() {
  const records = []
  const sourceFiles = []
  const validation = {
    invalidCas: 0,
    repairedDateCas: 0,
    invalidSmiles: 0,
    formulaMismatch: 0,
    missingPrecursorType: 0,
    missingPrecursorMz: 0,
    missingCollisionEnergy: 0,
    nonScalarCollisionEnergy: 0,
    missingPolarity: 0,
    noProductIon: 0,
    q3AbovePrecursorByTen: 0
  }
  for (const source of sourceSpecs) {
    const filePath = path.join(docsDir, source.file)
    const bytes = fs.readFileSync(filePath)
    const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const csvText = new TextDecoder('gb18030').decode(bytes)
    const csv = parseCsv(csvText, source.file)
    const headerSet = new Set(csv.headers)
    const missing = requiredHeaders.filter((item) => !headerSet.has(item))
    if (missing.length) {
      throw new Error(
        `${source.file} 缺少字段：${missing.join('、')}；实际表头：${csv.headers.join('、')}`
      )
    }
    const rows = csv.rows
    sourceFiles.push({ file: source.file, className: source.className, rows: rows.length, sourceSha256 })
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const rowNo = index + 2
      const sourceLabel = `${source.file} 第 ${rowNo} 行`
      const rawCas = text(row.cas)
      const cas = normalizedCas(rawCas)
      if (!cas) validation.invalidCas += 1
      if (cas && rawCas.includes('/')) validation.repairedDateCas += 1
      const formula = text(row.formula)
      const smiles = text(row.smiles)
      const structure = structureFromSmiles(smiles, formula)
      if (structure.error) validation.invalidSmiles += 1
      else if (!structure.formulaMatches) validation.formulaMismatch += 1
      const precursorType = text(row['前体类型'])
      const precursorMz = firstNumber(row['前体m/z'])
      const collisionEnergyText = text(row['碰撞能量'])
      const collisionEnergy = scalarCollisionEnergy(collisionEnergyText)
      const polarity = polarityFromPrecursor(precursorType)
      const parsedPeaks = parsePeaks(row['完整峰列表(m/z:强度)'], sourceLabel)
      const peaks = parsedPeaks.peaks
      const productIon = precursorMz === null ? null : selectProductIon(peaks, precursorMz)
      if (!precursorType) validation.missingPrecursorType += 1
      if (precursorMz === null || precursorMz <= 0) validation.missingPrecursorMz += 1
      if (!collisionEnergyText) validation.missingCollisionEnergy += 1
      else if (collisionEnergy === null) validation.nonScalarCollisionEnergy += 1
      if (polarity === null) validation.missingPolarity += 1
      if (
        precursorMz !== null &&
        productIon &&
        !peaks.some((peak) => Math.abs(peak.mz - precursorMz) > 0.5)
      ) {
        validation.noProductIon += 1
      }
      if (precursorMz !== null && productIon && productIon.mz > precursorMz + 10) {
        validation.q3AbovePrecursorByTen += 1
      }
      records.push({
        id: records.length,
        sourceFile: source.file,
        sourceClass: source.className,
        sourceSha256,
        rowNo,
        englishName: text(row.pubchem_name),
        chineseName: text(row.chinese_name_final),
        rawCas,
        cas,
        formula,
        smiles,
        inchiKey: normalizedInchiKey(row.inchikey),
        precursorType,
        collisionEnergyText,
        collisionEnergy,
        precursorMz,
        polarity,
        peaks,
        rawPeakCount: parsedPeaks.rawPeakCount,
        duplicatePeakCount: parsedPeaks.duplicatePeakCount,
        productIon,
        structure,
        spectrumEligible:
          precursorMz !== null && precursorMz > 0 && polarity !== null && Boolean(productIon)
      })
    }
  }
  return { records, sourceFiles, validation }
}

function groupRecords(records) {
  const grouped = new Map()
  for (const record of records) {
    const identity = record.cas
      ? `cas:${record.cas}`
      : record.inchiKey
        ? `inchi:${record.inchiKey}:${normalizedFormula(record.formula)}`
        : record.smiles
          ? `smiles:${record.smiles}:${normalizedFormula(record.formula)}`
          : `name:${normalizedName(record.englishName)}:${normalizedFormula(record.formula)}`
    grouped.set(identity, [...(grouped.get(identity) ?? []), record])
  }
  return [...grouped.values()].map((group) => buildGroup(group))
}

function recordSpectrumSignature(record) {
  return JSON.stringify({
    precursorType: record.precursorType,
    q1: record.precursorMz,
    q3: record.productIon?.mz ?? null,
    polarity: record.polarity,
    collisionEnergyText: record.collisionEnergyText,
    peaks: record.peaks
  })
}

function methodIdentity(record) {
  return [
    record.precursorMz?.toFixed(4) ?? '',
    record.productIon?.mz?.toFixed(4) ?? '',
    record.polarity ?? ''
  ].join('|')
}

function buildGroup(records) {
  const ranked = [...records].sort((left, right) => {
    const score = (record) =>
      Number(Boolean(record.cas)) * 100000 +
      Number(Boolean(record.chineseName)) * 10000 +
      Number(record.spectrumEligible) * 1000 +
      Number(record.structure.formulaMatches) * 100 +
      record.peaks.length
    return score(right) - score(left) || left.sourceFile.localeCompare(right.sourceFile) || left.rowNo - right.rowNo
  })
  const canonical = ranked[0]
  const names = mergeNames([], records)
  const classes = new Set(records.map((record) => record.sourceClass))
  const searchableText = names.map((item) => item.name).join(' | ')
  if (ANTIBIOTIC_PATTERN.test(searchableText)) {
    classes.add('抗生素')
    classes.add('新型污染物')
  }
  if (PFAS_PATTERN.test(searchableText)) classes.add('全氟化合物')
  if (MYCOTOXIN_PATTERN.test(searchableText)) classes.add('真菌毒素')

  const methodCandidates = new Map()
  for (const record of records.filter((item) => item.spectrumEligible)) {
    const identity = methodIdentity(record)
    const existing = methodCandidates.get(identity)
    if (!existing) {
      methodCandidates.set(identity, record)
      continue
    }
    const score = (item) =>
      item.peaks.length * 100 + Number(item.collisionEnergy !== null) * 10 + Number(Boolean(item.precursorType))
    if (score(record) > score(existing)) methodCandidates.set(identity, record)
  }
  return {
    records,
    canonical,
    names,
    classes: [...classes],
    methodCandidates: [...methodCandidates.values()],
    inchiKeys: new Set(records.map((record) => record.inchiKey).filter(Boolean)),
    casValues: new Set(records.map((record) => record.cas).filter(Boolean)),
    formulas: new Set(records.map((record) => normalizedFormula(record.formula)).filter(Boolean)),
    normalizedNames: new Set(
      records.flatMap((record) => [record.englishName, record.chineseName]).map(normalizedName).filter(Boolean)
    )
  }
}

function loadInchiKeyCache(activeIds) {
  const cachePath = path.join(docsDir, 'enrichment-cache', 'pubchem-compounds.jsonl')
  const result = new Map()
  if (!fs.existsSync(cachePath)) return result
  for (const line of fs.readFileSync(cachePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      const compoundId = Number(record.compoundId)
      const key = normalizedInchiKey(record.property?.InChIKey)
      if (!key || !activeIds.has(compoundId) || record.status !== 'matched') continue
      result.set(key, new Set([...(result.get(key) ?? []), compoundId]))
    } catch {
      // Ignore a partial cache line.
    }
  }
  return result
}

function buildDatabaseIndexes(compounds) {
  const byCas = new Map()
  const byName = new Map()
  for (const compound of compounds) {
    for (const match of text(compound.cas).matchAll(/\b\d{2,7}-\d{2}-\d\b/g)) {
      if (!validCas(match[0])) continue
      byCas.set(match[0], new Set([...(byCas.get(match[0]) ?? []), Number(compound.id)]))
    }
    for (const name of [compound.main_name, ...parseNames(compound.name).map((item) => item.name)]) {
      const key = normalizedName(name)
      if (!key) continue
      byName.set(key, new Set([...(byName.get(key) ?? []), Number(compound.id)]))
    }
  }
  return { byCas, byName }
}

function compoundCasValues(compound) {
  return new Set(
    [...text(compound.cas).matchAll(/\b\d{2,7}-\d{2}-\d\b/g)]
      .map((match) => match[0])
      .filter(validCas)
  )
}

function resolveExistingCompound(group, compoundsById, indexes, byInchiKey) {
  const inchiIds = new Set(
    [...group.inchiKeys].flatMap((key) => [...(byInchiKey.get(key) ?? [])])
  )
  const casIds = new Set([...group.casValues].flatMap((cas) => [...(indexes.byCas.get(cas) ?? [])]))
  const nameIds = new Set(
    [...group.normalizedNames].flatMap((name) => [...(indexes.byName.get(name) ?? [])])
  )
  const candidatesFor = (ids) =>
    [...ids]
      .map((id) => compoundsById.get(id))
      .filter(Boolean)
      .sort((left, right) => Number(left.id) - Number(right.id))
  const formulaCompatible = (compound) =>
    !normalizedFormula(compound.formula) ||
    [...group.formulas].some((formula) => sameFormula(compound.formula, formula))
  const formulaExact = (compound) =>
    Boolean(normalizedFormula(compound.formula)) &&
    [...group.formulas].some((formula) => sameFormula(compound.formula, formula))
  const nameCompatible = (compound) =>
    [compound.main_name, ...parseNames(compound.name).map((item) => item.name)].some((name) =>
      group.normalizedNames.has(normalizedName(name))
    )
  if (casIds.size) {
    const casCandidates = candidatesFor(casIds)
    const compatible = casCandidates.filter(formulaCompatible)
    const formulaPool = compatible.length ? compatible : casCandidates
    const inchiMatches = formulaPool.filter((compound) => inchiIds.has(Number(compound.id)))
    let selected = null
    if (inchiMatches.length === 1) {
      selected = inchiMatches[0]
    }
    if (!selected) {
      const nameMatches = formulaPool.filter(nameCompatible)
      if (nameMatches.length === 1) selected = nameMatches[0]
    }
    selected ??= formulaPool[0]
    const warnings = []
    if (!compatible.length) warnings.push('CAS 精确命中，但源分子式与本地记录不一致；未覆盖本地基础信息')
    if (casCandidates.length > 1) {
      warnings.push(
        `CAS 在本地对应 ${casCandidates.length} 条记录，按分子式/InChIKey/名称优先后选择 ID ${selected.id}`
      )
    }
    return {
      compound: selected,
      matchType: 'cas',
      conflict: '',
      warnings,
      duplicateCandidates: Math.max(0, casCandidates.length - 1)
    }
  }

  const structuralMatches = candidatesFor(inchiIds).filter(formulaExact)
  const nameFormulaMatches = candidatesFor(nameIds).filter(formulaExact)
  if (group.casValues.size) {
    const warnings = []
    if (structuralMatches.length) {
      warnings.push(`源 CAS 未命中，但相同结构已以其他 CAS 存在（ID ${structuralMatches.map((item) => item.id).join('、')}）`)
    } else if (nameFormulaMatches.length) {
      warnings.push(`源 CAS 未命中，但相同名称与分子式已以其他 CAS 存在（ID ${nameFormulaMatches.map((item) => item.id).join('、')}）`)
    }
    return {
      compound: null,
      matchType: 'new',
      conflict: '',
      warnings,
      duplicateCandidates: 0
    }
  }

  for (const [matchType, candidates] of [
    ['inchikey', structuralMatches],
    ['name+formula', nameFormulaMatches]
  ]) {
    if (candidates.length === 1) {
      return { compound: candidates[0], matchType, conflict: '', warnings: [], duplicateCandidates: 0 }
    }
    if (candidates.length > 1) {
      return {
        compound: null,
        matchType,
        conflict: `${matchType} 对应多个本地化合物：${candidates.map((item) => item.id).join('、')}`,
        warnings: [],
        duplicateCandidates: candidates.length - 1
      }
    }
  }
  return { compound: null, matchType: 'new', conflict: '', warnings: [], duplicateCandidates: 0 }
}

function buildExistingUpdate(compound, group) {
  const canonical = group.canonical
  const update = {}
  if (!text(compound.main_name) && canonical.englishName) update.main_name = canonical.englishName
  if (!text(compound.formula) && canonical.formula) update.formula = canonical.formula
  const existingValidCas = [...text(compound.cas).matchAll(/\b\d{2,7}-\d{2}-\d\b/g)].some((match) =>
    validCas(match[0])
  )
  if (!existingValidCas && canonical.cas) update.cas = canonical.cas
  if (compound.molecular_mass === null && canonical.structure.molecularMass !== null) {
    update.molecular_mass = canonical.structure.molecularMass
  }
  if (compound.monoisotopic_mass === null && canonical.structure.monoisotopicMass !== null) {
    update.monoisotopic_mass = canonical.structure.monoisotopicMass
  }
  if (!text(compound.formula_diagram_base64) && canonical.structure.svg) {
    update.formula_diagram_base64 = canonical.structure.svg
  }
  const mergedNames = mergeNames(compound.name, group.records)
  const oldNames = parseNames(compound.name)
  if (JSON.stringify(mergedNames) !== JSON.stringify(oldNames)) update.name = JSON.stringify(mergedNames)
  return update
}

function methodsMatch(method, record) {
  const closeNullable = (left, right) => {
    const leftNumber = left === null || left === undefined || left === '' ? null : Number(left)
    const rightNumber = right === null || right === undefined || right === '' ? null : Number(right)
    if (leftNumber === null || rightNumber === null) return leftNumber === rightNumber
    return (
      Number.isFinite(leftNumber) &&
      Number.isFinite(rightNumber) &&
      Math.abs(leftNumber - rightNumber) <= numericTolerance
    )
  }
  return (
    normalizedName(method.ms_mode) === normalizedName('MS8000') &&
    closeNullable(method.polarity, record.polarity) &&
    closeNullable(method.q1, record.precursorMz) &&
    closeNullable(method.q3, record.productIon?.mz ?? null)
  )
}

function normalizedPeaks(peaks) {
  if (!Array.isArray(peaks)) return []
  return peaks
    .map((peak) => ({ mz: Number(peak?.mz), intensity: Number(peak?.intensity) }))
    .filter((peak) => Number.isFinite(peak.mz) && Number.isFinite(peak.intensity))
    .sort((left, right) => left.mz - right.mz || left.intensity - right.intensity)
}

function spectrumMatchesRecord(spectrum, record) {
  return JSON.stringify(normalizedPeaks(spectrum?.peaks)) === JSON.stringify(normalizedPeaks(record.peaks))
}

function importKey(group, record) {
  const identity = [...group.casValues][0] || [...group.inchiKeys][0] || normalizedName(group.canonical.englishName)
  const spectrumHash = crypto
    .createHash('sha256')
    .update(recordSpectrumSignature(record))
    .digest('hex')
    .slice(0, 16)
  return `categorized-csv:${identity}:${spectrumHash}`
}

function buildPayload(group, record, compoundId, methodId, methodQ1, methodQ3) {
  const canonical = group.canonical
  const payload = {
    schemaVersion: 'mass-spectrum-v1',
    source: {
      name: record.sourceFile,
      library: '分类化合物CSV',
      nistNumber: '',
      dbNumber: `${record.sourceFile}:${record.rowNo}`
    },
    compound: {
      id: compoundId,
      name: canonical.englishName,
      synonyms: group.names.map((item) => item.name),
      cas: canonical.cas,
      formula: canonical.formula,
      inchiKey: canonical.inchiKey,
      smiles: canonical.smiles,
      molecularMass: canonical.structure.molecularMass,
      exactMass: canonical.structure.monoisotopicMass
    },
    acquisition: {
      precursorType: record.precursorType,
      precursorMz: methodQ1,
      spectrumType: 'MS2',
      instrumentType: 'QqQ',
      instrument: 'MS8000',
      ionization: '',
      ionMode: record.polarity === 1 ? 'P' : 'N',
      collisionEnergy: record.collisionEnergy,
      collisionEnergyText: record.collisionEnergyText
    },
    match: {
      type: 'imported',
      identityType: canonical.cas ? 'cas-exact' : canonical.inchiKey ? 'inchikey' : 'name+formula',
      q1: methodQ1,
      q3: methodQ3,
      compoundId,
      methodId
    },
    metadata: {
      importKey: importKey(group, record),
      sourceFile: record.sourceFile,
      sourceRow: record.rowNo,
      sourceSha256: record.sourceSha256,
      classes: group.classes,
      peakCount: record.peaks.length,
      rawPeakCount: record.rawPeakCount,
      duplicatePeakCount: record.duplicatePeakCount,
      q3DerivedFromSpectrum: true,
      q3Selection: 'highest-product-excluding-precursor',
      q3FallbackToPrecursorPeak: !record.peaks.some(
        (peak) => Math.abs(peak.mz - record.precursorMz) > 0.5
      ),
      q3AbovePrecursorBy: Math.max(0, record.productIon.mz - record.precursorMz),
      requiresReview:
        !record.peaks.some((peak) => Math.abs(peak.mz - record.precursorMz) > 0.5) ||
        record.productIon.mz > record.precursorMz + 10,
      notes: '按分类CSV导入'
    },
    peaks: record.peaks
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

async function createPlan(db, parsed) {
  const [compounds] = await db.query(
    'SELECT id, main_name, name, formula, cas, molecular_mass, monoisotopic_mass, formula_diagram_base64 FROM compounds WHERE COALESCE(is_delete, 0) = 0'
  )
  const [methods] = await db.query(
    'SELECT id, compounds_id, ms_mode, q1, q3, ce, polarity, ion_source, scan_mode, mass_spectrum_base64 FROM ms_methods'
  )
  const [classRows] = await db.query('SELECT id, class_name, is_custom FROM classes')
  const compoundsById = new Map(compounds.map((item) => [Number(item.id), item]))
  const methodsByCompound = new Map()
  for (const method of methods) {
    const compoundId = Number(method.compounds_id)
    methodsByCompound.set(compoundId, [...(methodsByCompound.get(compoundId) ?? []), method])
  }
  const indexes = buildDatabaseIndexes(compounds)
  const byInchiKey = loadInchiKeyCache(new Set(compoundsById.keys()))
  const classByName = new Map(classRows.map((item) => [text(item.class_name), item]))
  const groups = groupRecords(parsed.records)
  const plans = []
  const conflicts = []
  const identityWarnings = []
  const matchCounts = { inchikey: 0, cas: 0, 'name+formula': 0, new: 0 }
  let spectraToCreate = 0
  let spectraToFill = 0
  let spectraAlreadyImported = 0
  let spectraPreserved = 0
  let duplicateCompoundCandidates = 0
  let duplicateMethodCandidates = 0
  const spectrumConflicts = []
  const pendingCompoundStates = new Map()
  for (const group of groups) {
    const resolved = resolveExistingCompound(group, compoundsById, indexes, byInchiKey)
    if (resolved.conflict) {
      conflicts.push({
        name: group.canonical.englishName,
        cas: group.canonical.cas,
        inchiKey: group.canonical.inchiKey,
        reason: resolved.conflict
      })
      continue
    }
    for (const warning of resolved.warnings ?? []) {
      identityWarnings.push({
        name: group.canonical.englishName,
        cas: group.canonical.cas,
        inchiKey: group.canonical.inchiKey,
        warning
      })
    }
    duplicateCompoundCandidates += resolved.duplicateCandidates ?? 0
    matchCounts[resolved.matchType] += 1
    const methodPlans = []
    const existingMethods = resolved.compound ? methodsByCompound.get(Number(resolved.compound.id)) ?? [] : []
    for (const record of group.methodCandidates) {
      const candidates = existingMethods.filter((method) => methodsMatch(method, record))
      duplicateMethodCandidates += Math.max(0, candidates.length - 1)
      if (!candidates.length) {
        spectraToCreate += 1
        methodPlans.push({ action: 'create', record, method: null })
        continue
      }
      const exactSpectrumMethod = candidates.find((method) => {
        const spectrum = decodeSpectrum(method.mass_spectrum_base64)
        return (
          spectrum?.metadata?.importKey === importKey(group, record) ||
          spectrumMatchesRecord(spectrum, record)
        )
      })
      if (exactSpectrumMethod) {
        spectraAlreadyImported += 1
        methodPlans.push({ action: 'unchanged', record, method: exactSpectrumMethod })
        continue
      }
      const emptyMethod = candidates.find((method) => !decodeSpectrum(method.mass_spectrum_base64))
      if (emptyMethod) {
        spectraToFill += 1
        methodPlans.push({ action: 'fill', record, method: emptyMethod })
      } else {
        spectraPreserved += 1
        const method = [...candidates].sort((left, right) => Number(left.id) - Number(right.id))[0]
        methodPlans.push({ action: 'preserve', record, method })
        spectrumConflicts.push({
          compoundId: Number(resolved.compound?.id),
          compoundName: group.canonical.englishName,
          methodId: Number(method.id),
          sourceFile: record.sourceFile,
          sourceRow: record.rowNo,
          reason: '相同 MS8000/Q1/Q3/极性的方法已有不同谱图，保留原谱图'
        })
      }
    }
    let compoundUpdate = {}
    if (resolved.compound) {
      const compoundId = Number(resolved.compound.id)
      const effectiveCompound = pendingCompoundStates.get(compoundId) ?? { ...resolved.compound }
      compoundUpdate = buildExistingUpdate(effectiveCompound, group)
      pendingCompoundStates.set(compoundId, { ...effectiveCompound, ...compoundUpdate })
    }
    plans.push({
      group,
      existingCompound: resolved.compound,
      matchType: resolved.matchType,
      compoundUpdate,
      methodPlans
    })
  }
  const requiredClassNames = new Set(plans.flatMap((plan) => plan.group.classes))
  const missingClasses = [...requiredClassNames].filter((name) => !classByName.has(name))
  return {
    groups,
    plans,
    conflicts,
    identityWarnings,
    spectrumConflicts,
    matchCounts,
    classByName,
    missingClasses,
    counts: {
      sourceRows: parsed.records.length,
      identityGroups: groups.length,
      readyGroups: plans.length,
      conflictingGroups: conflicts.length,
      newCompounds: plans.filter((plan) => !plan.existingCompound).length,
      matchedCompounds: plans.filter((plan) => plan.existingCompound).length,
      existingCompoundsToEnrich: plans.filter(
        (plan) => plan.existingCompound && Object.keys(plan.compoundUpdate).length
      ).length,
      structureAvailable: plans.filter((plan) => Boolean(plan.group.canonical.structure.svg)).length,
      classifiedGroups: plans.filter((plan) => plan.group.classes.length > 0).length,
      eligibleSpectrumCandidates: plans.reduce((sum, plan) => sum + plan.group.methodCandidates.length, 0),
      spectraToCreate,
      spectraToFill,
      spectraAlreadyImported,
      spectraPreserved,
      duplicateCompoundCandidates,
      duplicateMethodCandidates,
      sourceRowsWithoutImportableSpectrum: parsed.records.filter((record) => !record.spectrumEligible).length
    }
  }
}

async function applyPlan(db, plan) {
  const classByName = new Map(plan.classByName)
  const result = {
    insertedCompounds: 0,
    enrichedCompounds: 0,
    insertedClassLinks: 0,
    insertedMethods: 0,
    filledSpectra: 0,
    preservedSpectra: plan.counts.spectraPreserved,
    unchangedSpectra: plan.counts.spectraAlreadyImported,
    compoundIds: [],
    spectrumMethodIds: []
  }
  await db.beginTransaction()
  try {
    for (const className of plan.missingClasses) {
      const [inserted] = await db.execute(
        'INSERT INTO classes (class_name, is_custom, create_time, update_time) VALUES (?, 0, NOW(), NOW())',
        [className]
      )
      classByName.set(className, { id: Number(inserted.insertId), class_name: className, is_custom: 0 })
    }
    for (const item of plan.plans) {
      const canonical = item.group.canonical
      let compoundId
      if (item.existingCompound) {
        compoundId = Number(item.existingCompound.id)
        const entries = Object.entries(item.compoundUpdate)
        if (entries.length) {
          const sql =
            'UPDATE compounds SET ' +
            entries.map(([column]) => `\`${column}\` = ?`).join(', ') +
            ', update_time = NOW() WHERE id = ?'
          await db.execute(sql, [...entries.map(([, value]) => value), compoundId])
          result.enrichedCompounds += 1
        }
      } else {
        const [inserted] = await db.execute(
          'INSERT INTO compounds (main_name, name, formula, cas, molecular_mass, monoisotopic_mass, formula_diagram_base64, is_favorite, is_in_trash, is_delete, create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NOW(), NOW())',
          [
            canonical.englishName || null,
            JSON.stringify(item.group.names),
            canonical.formula || null,
            canonical.cas || null,
            canonical.structure.molecularMass,
            canonical.structure.monoisotopicMass,
            canonical.structure.svg || '',
          ]
        )
        compoundId = Number(inserted.insertId)
        result.insertedCompounds += 1
      }
      result.compoundIds.push(compoundId)
      for (const className of item.group.classes) {
        const classId = Number(classByName.get(className).id)
        const [link] = await db.execute(
          'INSERT IGNORE INTO compound_class (compound_id, class_id, create_time, update_time) VALUES (?, ?, NOW(), NOW())',
          [compoundId, classId]
        )
        result.insertedClassLinks += link.affectedRows
      }
      for (const methodPlan of item.methodPlans) {
        if (methodPlan.action === 'preserve' || methodPlan.action === 'unchanged') continue
        const record = methodPlan.record
        let methodId
        let methodQ1
        let methodQ3
        if (methodPlan.action === 'fill') {
          methodId = Number(methodPlan.method.id)
          methodQ1 = Number(methodPlan.method.q1)
          methodQ3 = Number(methodPlan.method.q3)
        } else {
          const [insertedMethod] = await db.execute(
            'INSERT INTO ms_methods (compounds_id, ms_mode, q1, q3, ce, dp, cxp, polarity, ion_source, scan_mode, cad_value, cad_type, create_time, update_time, mass_spectrum_base64) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, NOW(), NOW(), NULL)',
            [
              compoundId,
              'MS8000',
              record.precursorMz,
              record.productIon.mz,
              record.collisionEnergy,
              record.polarity,
              'MS2'
            ]
          )
          methodId = Number(insertedMethod.insertId)
          methodQ1 = record.precursorMz
          methodQ3 = record.productIon.mz
          result.insertedMethods += 1
        }
        const encoded = buildPayload(item.group, record, compoundId, methodId, methodQ1, methodQ3)
        const [updated] = await db.execute(
          "UPDATE ms_methods SET mass_spectrum_base64 = ?, ce = COALESCE(ce, ?), scan_mode = COALESCE(NULLIF(TRIM(scan_mode), ''), 'MS2'), update_time = NOW() WHERE id = ? AND compounds_id = ? AND (mass_spectrum_base64 IS NULL OR TRIM(mass_spectrum_base64) = '')",
          [encoded, record.collisionEnergy, methodId, compoundId]
        )
        if (updated.affectedRows !== 1) {
          throw new Error(`方法ID ${methodId} 的谱图写入失败，数据可能已被其他操作修改`)
        }
        result.filledSpectra += 1
        result.spectrumMethodIds.push(methodId)
      }
    }
    await db.commit()
  } catch (error) {
    await db.rollback()
    throw error
  }
  return result
}

async function verifyApplied(db, plan, applied) {
  const uniqueCompoundIds = [...new Set(applied.compoundIds)]
  const uniqueMethodIds = [...new Set(applied.spectrumMethodIds)]
  const [compoundRows] = uniqueCompoundIds.length
    ? await db.query(
        'SELECT id, formula_diagram_base64 FROM compounds WHERE COALESCE(is_delete, 0) = 0 AND id IN (?)',
        [uniqueCompoundIds]
      )
    : [[]]
  const [methodRows] = uniqueMethodIds.length
    ? await db.query('SELECT id, compounds_id, mass_spectrum_base64 FROM ms_methods WHERE id IN (?)', [
        uniqueMethodIds
      ])
    : [[]]
  let verifiedSpectra = 0
  let verifiedPeaks = 0
  for (const method of methodRows) {
    const payload = decodeSpectrum(method.mass_spectrum_base64)
    if (
      payload?.schemaVersion !== 'mass-spectrum-v1' ||
      !Array.isArray(payload.peaks) ||
      !payload.peaks.every(
        (peak) => Number.isFinite(Number(peak.mz)) && Number.isFinite(Number(peak.intensity))
      ) ||
      Number(payload?.match?.methodId) !== Number(method.id) ||
      Number(payload?.match?.compoundId) !== Number(method.compounds_id)
    ) {
      continue
    }
    verifiedSpectra += 1
    verifiedPeaks += payload.peaks.length
  }
  const requiredLinkKeys = new Set()
  for (const [index, item] of plan.plans.entries()) {
    const compoundId = Number(applied.compoundIds[index])
    for (const className of item.group.classes) requiredLinkKeys.add(`${compoundId}|${className}`)
  }
  const [classLinkRows] = uniqueCompoundIds.length
    ? await db.query(
        'SELECT cc.compound_id, cc.class_id, c.class_name FROM compound_class cc JOIN classes c ON c.id = cc.class_id WHERE cc.compound_id IN (?)',
        [uniqueCompoundIds]
      )
    : [[]]
  const actualLinkKeys = new Set(
    classLinkRows.map((row) => `${Number(row.compound_id)}|${text(row.class_name)}`)
  )
  const missingRequiredLinks = [...requiredLinkKeys].filter((key) => !actualLinkKeys.has(key))
  const [totals] = await db.query(
    "SELECT (SELECT COUNT(*) FROM compounds WHERE COALESCE(is_delete, 0) = 0) AS activeCompounds, (SELECT COUNT(*) FROM ms_methods WHERE mass_spectrum_base64 IS NOT NULL AND TRIM(mass_spectrum_base64) <> '') AS methodSpectra, (SELECT COUNT(DISTINCT compounds_id) FROM ms_methods WHERE mass_spectrum_base64 IS NOT NULL AND TRIM(mass_spectrum_base64) <> '') AS compoundSpectra"
  )
  if (verifiedSpectra !== uniqueMethodIds.length) {
    throw new Error(`写入后谱图校验失败：${verifiedSpectra}/${uniqueMethodIds.length}`)
  }
  if (compoundRows.filter((row) => text(row.formula_diagram_base64)).length !== compoundRows.length) {
    throw new Error('写入后结构图校验失败：存在缺少结构图的影响化合物')
  }
  if (missingRequiredLinks.length) {
    throw new Error(`写入后分类校验失败：缺少 ${missingRequiredLinks.length} 条必需关联`)
  }
  return {
    verifiedCompounds: compoundRows.length,
    verifiedStructures: compoundRows.filter((row) => text(row.formula_diagram_base64)).length,
    verifiedSpectra,
    verifiedPeaks,
    classLinksForAffectedCompounds: classLinkRows.length,
    verifiedRequiredClassLinks: requiredLinkKeys.size,
    totals: totals[0]
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('.env 中缺少 DATABASE_URL')
  const parsed = parseSources()
  const db = await mysql.createConnection(process.env.DATABASE_URL)
  try {
    const plan = await createPlan(db, parsed)
    const summary = {
      mode: apply ? 'apply' : 'dry-run',
      sourceFiles: parsed.sourceFiles,
      validation: parsed.validation,
      ...plan.counts,
      matchCounts: plan.matchCounts,
      missingClasses: plan.missingClasses,
      enrichmentSample: plan.plans
        .filter((item) => item.existingCompound && Object.keys(item.compoundUpdate).length)
        .slice(0, 20)
        .map((item) => ({
          compoundId: Number(item.existingCompound.id),
          cas: item.group.canonical.cas,
          name: item.group.canonical.englishName,
          fields: Object.keys(item.compoundUpdate)
        })),
      conflictSample: plan.conflicts.slice(0, 20),
      identityWarningCount: plan.identityWarnings.length,
      identityWarningSample: plan.identityWarnings.slice(0, 20),
      spectrumConflictCount: plan.spectrumConflicts.length,
      spectrumConflictSample: plan.spectrumConflicts.slice(0, 20)
    }
    console.log(JSON.stringify(summary, null, 2))
    if (!apply) return
    const applied = await applyPlan(db, plan)
    const verification = await verifyApplied(db, plan, applied)
    const { compoundIds: _compoundIds, spectrumMethodIds: _spectrumMethodIds, ...appliedCounts } =
      applied
    console.log(JSON.stringify({ applied: appliedCounts, verification }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
