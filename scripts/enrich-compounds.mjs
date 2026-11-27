import './legacy-disabled.mjs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import process from 'process'
import { config as loadEnv } from 'dotenv'
import mysql from 'mysql2/promise'
import * as OCL from 'openchemlib'
import XLSX from 'xlsx'

const root = resolve(process.cwd())
const args = new Set(process.argv.slice(2))
const shouldFetch = args.has('--fetch')
const shouldApply = args.has('--apply')
const shouldRefresh = args.has('--refresh')
const retryCasImages = args.has('--retry-cas-images')
const imagesOnly = args.has('--images-only') || retryCasImages
const fetchImages = args.has('--images') || imagesOnly
const limitArg = process.argv.find((value) => value.startsWith('--limit='))
const fetchLimit = limitArg ? Number(limitArg.split('=')[1]) : Number.POSITIVE_INFINITY
const cacheFile = join(root, 'docs', 'enrichment-cache', 'pubchem-compounds.jsonl')
const reportFile = join(root, 'docs', 'compound-enrichment-report.json')
const awareFile = join(root, 'docs', 'classification-sources', 'who-aware-2023.xlsx')

const CLASS_NAMES = {
  antibiotic: '\u6297\u751f\u7d20',
  pfas: '\u5168\u6c1f\u5316\u5408\u7269',
  illegalAddition: '\u975e\u6cd5\u6dfb\u52a0',
  emergingContaminant: '\u65b0\u578b\u6c61\u67d3\u7269',
  mycotoxin: '\u771f\u83cc\u6bd2\u7d20'
}

const SOURCES = {
  compoundDetails: [
    'https://www.ncbi.nlm.nih.gov/books/NBK25500/',
    'https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest'
  ],
  antibiotic: 'https://www.who.int/publications/i/item/WHO-MHP-HPS-EML-2023.04',
  pfas: 'https://comptox.epa.gov/dashboard/chemical-lists/epapfasrl',
  illegalAddition: [
    'https://www.nhc.gov.cn/zwgk/csxx/201406/38e5c8a53615486888d93ed05ac9731a.shtml',
    'https://www.nhc.gov.cn/sps/s7891/201106/39bee4fe171b4ec4b82df40b61dcea6e.shtml',
    'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/spcjs/art/2025/art_ea94e4d81d4146b7b9bac6c85baf540b.html',
    'https://www.samr.gov.cn/cms_files/filemanager/1647978232/attach/20233/P020181214555096215303.pdf'
  ],
  emergingContaminant: 'https://www.mee.gov.cn/gzk/gz/202212/t20221230_1009192.shtml',
  mycotoxin: 'https://www.who.int/news-room/fact-sheets/detail/mycotoxins'
}

const NEW_POLLUTANT_CAS = new Set([
  '1763-23-1', '307-35-7', '2795-39-3', '29457-72-5', '29081-56-9', '70225-14-8',
  '56773-42-3', '251099-16-8', '335-67-1', '355-46-4', '1163-19-5', '85535-84-8',
  '68920-70-7', '71011-12-6', '85536-22-7', '85681-73-8', '108171-26-2', '87-68-3',
  '87-86-5', '131-52-2', '27735-64-4', '3772-94-9', '1825-21-4', '115-32-2',
  '10606-46-9', '13560-89-9', '135821-03-3', '135821-74-8', '75-09-2', '67-66-3',
  '25154-52-3', '84852-15-3', '25637-99-4', '3194-55-6', '134237-50-6',
  '134237-51-7', '134237-52-8', '57-74-9', '2385-85-5', '118-74-1', '50-29-3',
  '319-84-6', '319-85-7', '58-89-9', '115-29-7', '959-98-8', '33213-65-9', '1031-07-8'
])

const ILLEGAL_ADDITION_CAS = new Set([
  '149-44-0', '50-00-0', '842-07-9', '3118-97-6', '85-86-9', '85-83-6', '108-78-1',
  '10043-35-3', '1303-96-4', '540-72-7', '81-88-9', '569-64-2', '129-73-7',
  '548-62-9', '2465-27-2', '7758-01-2', '624-49-7', '62-73-7', '37148-27-9',
  '97825-25-7', '67-56-1', '64-19-7', '20859-73-8', '1758-73-2', '100-97-0',
  '131-52-2', '23696-28-8', '52-68-6', '77-09-8', '106650-56-0',
  '58-08-2', '139755-83-2', '171596-29-5', '1115-70-4', '122320-73-4',
  '111025-46-8', '834-28-6', '10238-21-8', '29094-61-9', '75330-75-5',
  '88150-42-9', '21829-25-4'
])

const PFAS_PATTERN = /(?:perfluoro|polyfluoro|fluorotelomer|\bpf(?:os|oa|hxs|bs|ds|da|doa|hps|hpa|hxda|na|nona|oda|pea|pesa|tes|teda|trda|uda|unda|eesa|osa)\b|mpf(?:os|oa|hxs)|\b\d{1,2}:\d(?:\/\d{1,2}:\d)?\s*(?:ft(?:oh|ca|uca|s|p)?|di\s*pap|pap)\b|8cl-pfos|\u5168\u6c1f)/i
const NEW_POLLUTANT_NAME_PATTERN = /(?:\bpfos\b|\bpfoa\b|\bpfhxs\b|mpf(?:os|oa|hxs)|8cl-pfos|pentachlorophenol|dicofol|dechlorane\s*plus|decabromodiphenyl|hexachlorobutadiene|dichloromethane|methylene\s*chloride|chloroform|trichloromethane|hexabromocyclododecane|chlordane|mirex|hexachlorobenzene|\bddt\b|lindane|endosulfan|polychlorinated\s*biphenyl|\bpcb[- ]?\d+)/i
const MYCOTOXIN_PATTERN = /(?:aflatoxin|aflatoxicol|aflatrem|ochratoxin|patulin|fumonisin|zearalen|zearalan|nivalenol|deoxynivalenol|deepoxy[- ]?deoxynivalenol|\bdon(?:-|\b)|\bht-?2\b|\bt-?2(?:\s*toxin|-triol|-tetraol|\b)|neosolaniol|diacetoxyscirpenol|fusarenon|sterigmatocystin|citrinin|verrucarin|alternariol|tenuazonic)/i
const ISOTOPE_LABEL_PATTERN = /(?:^|[-\s(])d\d+\b|\b\d{2,3}(?:c|n|o|s|h)\d*\b|deuteri|tritium|isotope/i
const ILLEGAL_EXACT_DRUG_NAMES = new Set([
  'phenolphthalein', 'sibutramine', 'caffeine', 'metformin', 'rosiglitazone',
  'pioglitazone', 'phenformin', 'glibenclamide', 'glyburide', 'glipizide',
  'lovastatin', 'amlodipine', 'nifedipine'
])
const ILLEGAL_NAME_PATTERN = /(?:melamine|sudan\s*[ivx1-4]*|rhodamine\s*b|formaldehyde|sodium\s*formaldehyde\s*sulfoxylate|borax|boric\s*acid|clenbuterol|ractopamine|malachite\s*green|crystal\s*violet|leucomalachite|auramine\s*o|potassium\s*bromate|dimethyl\s*fumarate|dichlorvos|nitrofuran|furazolidone|furaltadone|nitrofurazone|nitrofurantoin|\bolaquindox\b|sodium\s*pentachlorophen|trichlorfon|acid\s*orange\s*ii|basic\s*yellow|methenamine|hexamethylenetetramine|sodium\s*silicate|aluminium\s*phosphide|thiourea\s*dioxide|phthalate|febuxostat|sildenafil|tadalafil|vardenafil|udenafil|avanafil|lodenafil|mirodenafil|homosildenafil|hydroxyhomosildenafil|pseudovardenafil|norneosildenafil|aminotadalafil|acetylvardenafil|nortadalafil|\u897f\u5e03\u66f2\u660e|\u9170\u915e|\u897f\u5730\u90a3\u975e|\u4ed6\u8fbe\u62c9\u975e|\u4f10\u5730\u90a3\u975e|\u90a3\u975e|\u62c9\u975e|\u90bb\u82ef\u4e8c\u7532\u9178)/i
const ANTIBIOTIC_FAMILY_PATTERN = /(?:\b[a-z]+floxacin\b|\b[a-z]*cillin\b|\bpenicillin\b|\bcef[a-z]+\b|\bceph[a-z]+\b|\b[a-z]+cycline\b|\bsulfa(?:diazine|dimethoxine|dimidine|furazole|isodimidine|lene|merazine|methazine|methizole|methoxazole|methoxypyridazine|monomethoxine|pyridine|quinoxaline|thiazole|doxin|chloropyridazine|benzamide|nitran)\b|amikacin|gentamicin|kanamycin|neomycin|streptomycin|tobramycin|apramycin|sisomicin|netilmicin|ribostamycin|hygromycin\s*b|spectinomycin|erythromycin|azithromycin|clarithromycin|roxithromycin|spiramycin|tilmicosin|tylosin|tulathromycin|gamithromycin|josamycin|oleandomycin|kitasamycin|leucomycin|virginiamycin|clindamycin|lincomycin|pirlimycin|chloramphenicol|thiamphenicol|florfenicol|metronidazole|tinidazole|ornidazole|ronidazole|dimetridazole|imipenem|meropenem|ertapenem|doripenem|vancomycin|teicoplanin|dalbavancin|oritavancin|linezolid|daptomycin|bacitracin|colistin|polymyxin|fosfomycin|tiamulin|valnemulin|pleuromutilin|nitrofurantoin|nitrofurazone|furazolidone|furaltadone)/i

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

function safeNameEntries(value) {
  if (value === null || value === undefined) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => typeof item === 'string'
      ? { area: '', name: item.trim() }
      : { area: String(item?.area ?? '').trim(), name: String(item?.name ?? '').trim() })
      .filter((item) => item.name)
  } catch {
    return []
  }
}

const safeNames = (value) => safeNameEntries(value).map((item) => item.name)
const normalizeText = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim()
const normalizeFormula = (value) => String(value ?? '').replace(/[\s\u00b7]/g, '')
  .replace(/\((?:aq|s|l|g)\)$/i, '')
const MONOISOTOPIC_MASSES = Object.freeze({
  H: 1.00782503223, D: 2.01410177812, C: 12, N: 14.00307400443,
  O: 15.99491461957, F: 18.99840316273, P: 30.97376199842,
  S: 31.9720711744, Cl: 34.968852682, Br: 78.9183376, I: 126.9044719,
  B: 11.00930536, Si: 27.97692653465, Se: 79.9165218, As: 74.92159457,
  Li: 7.0160034366, Na: 22.989769282, Mg: 23.985041697, Al: 26.98153853,
  K: 38.9637064864, Ca: 39.962590863, Ti: 47.94794198, V: 50.94395704,
  Cr: 51.94050623, Mn: 54.93804391, Fe: 55.93493633, Co: 58.93319429,
  Ni: 57.93534241, Cu: 62.92959772, Zn: 63.92914201, Rb: 84.9117897379,
  Sr: 87.9056125, Zr: 89.9046977, Mo: 97.90540482, Pd: 105.9034804,
  Ag: 106.9050916, Cd: 113.90336509, Sn: 119.90220163, Cs: 132.905451961,
  Ba: 137.905247, W: 183.95093092, Pt: 194.9647917, Au: 196.96656879,
  Hg: 201.9706434, Pb: 207.9766525, U: 238.0507884
})

function calculateMonoisotopicMass(formula, isotopeAtomCount = 0) {
  if (Number(isotopeAtomCount) > 0) return null
  const compact = normalizeFormula(formula).replace(/[.?]/g, '')
  if (!compact || /[()[\]{}+\-]/.test(compact)) return null
  const pattern = /([A-Z][a-z]?)(\d*)/g
  let cursor = 0
  let mass = 0
  for (const match of compact.matchAll(pattern)) {
    if (match.index !== cursor || MONOISOTOPIC_MASSES[match[1]] === undefined) return null
    mass += MONOISOTOPIC_MASSES[match[1]] * Number(match[2] || 1)
    cursor += match[0].length
  }
  return cursor === compact.length ? Number(mass.toFixed(6)) : null
}
const normalizeDrugName = (value) => normalizeText(value)
  .replace(/[\uff08(].*?[\uff09)]/g, '').replace(/_(?:iv|oral)$/i, '')
  .replace(/\b(?:sodium|potassium|calcium|hydrochloride|mesylate|phosphate|sulfate|sulphate|maleate|besylate|fumarate|tartrate|hydrate|hemihydrate|monohydrate|dihydrate)\b/g, '')
  .replace(/[^a-z0-9]+/g, '')
const extractCas = (value) => [...String(value ?? '').matchAll(/\b\d{2,7}-\d{2}-\d\b/g)]
  .map((match) => match[0])

function validCas(value) {
  if (!/^\d{2,7}-\d{2}-\d$/.test(value)) return false
  const digits = value.replace(/-/g, '')
  const sum = digits.slice(0, -1).split('').reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index + 1), 0)
  return sum % 10 === Number(digits.at(-1))
}

const casSet = (compound) => new Set(extractCas(compound.cas).filter(validCas))
const allText = (compound) => [compound.main_name, ...safeNames(compound.name)]
  .filter(Boolean).join(' | ')

function readAwareAntibiotics() {
  if (!existsSync(awareFile)) throw new Error('WHO AWaRe workbook was not found: ' + awareFile)
  const workbook = XLSX.readFile(awareFile, { cellDates: false })
  const sheet = workbook.Sheets['AWaRe classification 2023']
  if (!sheet) throw new Error('WHO AWaRe classification sheet was not found')
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  return new Set(rows.slice(4).map((row) => normalizeDrugName(row[0])).filter(Boolean))
}

function isAntibiotic(compound, awareAntibiotics) {
  const names = [compound.main_name, ...safeNames(compound.name)].filter(Boolean)
  if (/cephalochromin/i.test(names.join(' | '))) return false

  return names.some((name) => awareAntibiotics.has(normalizeDrugName(name))) ||
    ANTIBIOTIC_FAMILY_PATTERN.test(names.join(' | '))
}

function classifyCompound(compound, awareAntibiotics) {
  const classes = []
  const text = allText(compound)
  const cases = casSet(compound)
  const antibiotic = isAntibiotic(compound, awareAntibiotics)
  const pfas = PFAS_PATTERN.test(text)
  const mycotoxin = MYCOTOXIN_PATTERN.test(text)
  const exactIllegalDrug = [compound.main_name, ...safeNames(compound.name)].filter(Boolean)
    .some((name) => ILLEGAL_EXACT_DRUG_NAMES.has(normalizeDrugName(name)))
  const illegalAntibiotic = antibiotic &&
    /(?:floxacin|quinolone|oxolinic|cinoxacin|flumequine|pipemidic|nalidixic|cillin|penicillin|\bcef|\bceph|cycline|\bsulfa|chloramphenicol|thiamphenicol|florfenicol)/i.test(text)
  const illegalName = ILLEGAL_NAME_PATTERN.test(text) && !/terephthalate/i.test(text)
  const illegal = [...cases].some((value) => ILLEGAL_ADDITION_CAS.has(value)) ||
    illegalName || exactIllegalDrug || illegalAntibiotic
  const emerging = antibiotic || [...cases].some((value) => NEW_POLLUTANT_CAS.has(value)) ||
    NEW_POLLUTANT_NAME_PATTERN.test(text)
  if (antibiotic) classes.push(CLASS_NAMES.antibiotic)
  if (pfas) classes.push(CLASS_NAMES.pfas)
  if (illegal) classes.push(CLASS_NAMES.illegalAddition)
  if (emerging) classes.push(CLASS_NAMES.emergingContaminant)
  if (mycotoxin) classes.push(CLASS_NAMES.mycotoxin)
  return classes
}

function loadCache() {
  const cache = new Map()
  if (!existsSync(cacheFile)) return cache
  for (const line of readFileSync(cacheFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line)
      if (item?.compoundId) cache.set(Number(item.compoundId), item)
    } catch {
      // A partial final line is ignored so an interrupted download can resume.
    }
  }
  return cache
}

function appendCache(record, cache) {
  mkdirSync(dirname(cacheFile), { recursive: true })
  appendFileSync(cacheFile, JSON.stringify(record) + '\n', 'utf8')
  cache.set(Number(record.compoundId), record)
}

function candidateQueries(compound) {
  const queries = [...casSet(compound)].map((value) => ({ type: 'cas', value }))
  for (const rawName of [compound.main_name, ...safeNames(compound.name)]) {
    const name = String(rawName ?? '').trim()
    if (!name || /^\d+$/.test(name)) continue
    queries.push({ type: 'name', value: name })
    const shortName = name.split(/[\uff08(]/)[0].trim()
    if (shortName && shortName !== name) queries.push({ type: 'name', value: shortName })
  }
  const seen = new Set()
  return queries.filter((query) => {
    const key = query.type + ':' + normalizeText(query.value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

let lastEntrezRequestAt = 0
async function entrezRateLimit() {
  const wait = Math.max(0, 380 - (Date.now() - lastEntrezRequestAt))
  if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait))
  lastEntrezRequestAt = Date.now()
}

async function entrezRequest(endpoint, parameters, method = 'GET') {
  const url = new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${endpoint}`)
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) form.set(key, String(value))
  if (method === 'GET') for (const [key, value] of form) url.searchParams.set(key, value)
  let lastFailure = 'unknown'
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await entrezRateLimit()
    const response = await fetch(url, { method,
      headers: { 'User-Agent': 'MasspecLib-compound-enrichment/1.0',
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: form } : {}) })
    if (response.ok) return response.json()
    if (![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`PubChem Entrez request failed (${response.status}): ${endpoint}`)
    }
    lastFailure = `${response.status} ${response.statusText}`.trim()
    const retryAfter = Number(response.headers.get('retry-after'))
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000 : 1000 * 2 ** attempt
    console.warn(`PubChem Entrez ${lastFailure}; retrying in ${Math.ceil(backoff / 1000)}s`)
    await new Promise((resolveWait) => setTimeout(resolveWait, backoff))
  }
  throw new Error(`PubChem Entrez retries exhausted (${lastFailure}): ${endpoint}`)
}

function propertyMatches(compound, property, query) {
  const localFormula = normalizeFormula(compound.formula)
  const remoteFormula = normalizeFormula(property?.MolecularFormula)
  const formulaMatch = Boolean(localFormula && remoteFormula && localFormula === remoteFormula)
  if (query.type === 'cas') return !localFormula || formulaMatch
  if (query.type === 'cas-relaxed') {
    if (/\bC\d{1,2}[-\s]/i.test(String(compound.main_name ?? '')) && !formulaMatch) return false
    return true
  }
  if (formulaMatch) return true
  const localNames = [compound.main_name, ...safeNames(compound.name)]
    .filter(Boolean).map(normalizeDrugName)
  return !localFormula && localNames.includes(normalizeDrugName(query.value))
}

function propertyFromSummary(summary) {
  const isotopeAtomCount = Number(summary?.isotopeatomcount || 0)
  const formula = summary?.molecularformula ? String(summary.molecularformula) : null
  const synonyms = Array.isArray(summary?.synonymlist) ? summary.synonymlist.map(String) : []
  const title = summary?.meshheadinglist?.[0] ?? synonyms[0] ?? summary?.iupacname ?? null
  return { property: { CID: Number(summary.cid), Title: title,
    IUPACName: summary?.iupacname ?? null, MolecularFormula: formula,
    MolecularWeight: summary?.molecularweight === '' ? null : Number(summary.molecularweight),
    MonoisotopicMass: calculateMonoisotopicMass(formula, isotopeAtomCount),
    IsotopeAtomCount: isotopeAtomCount, InChI: summary?.inchi ?? null,
    InChIKey: summary?.inchikey ?? null,
    CanonicalSMILES: summary?.canonicalsmiles ?? null,
    IsomericSMILES: summary?.isomericsmiles ?? null }, synonyms }
}

async function fetchSummaryMap(cids) {
  const byCid = new Map()
  const uniqueCids = [...new Set(cids.map(Number).filter(Number.isFinite))]
  for (let index = 0; index < uniqueCids.length; index += 100) {
    const batch = uniqueCids.slice(index, index + 100)
    const data = await entrezRequest('esummary.fcgi', { db: 'pccompound',
      id: batch.join(','), retmode: 'json', tool: 'MasspecLib' })
    for (const cid of data?.result?.uids ?? []) {
      const summary = data.result[String(cid)]
      if (summary) byCid.set(Number(cid), propertyFromSummary(summary))
    }
  }
  return byCid
}

function summaryNameIndex(summaries) {
  const index = new Map()
  for (const summary of summaries.values()) {
    const names = [summary.property.Title, summary.property.IUPACName, ...summary.synonyms]
    for (const name of names.filter(Boolean)) {
      const key = normalizeText(name)
      if (!index.has(key)) index.set(key, [])
      index.get(key).push(summary)
    }
  }
  return index
}

async function batchResolveCompounds(compounds, cache) {
  const states = compounds.map((compound) => {
    const queries = candidateQueries(compound)
    if (!retryCasImages) return { compound, queries }
    const casQueries = queries.filter((query) => query.type === 'cas')
    return { compound, queries: [...casQueries,
      ...casQueries.map((query) => ({ ...query, type: 'cas-relaxed' }))] }
  })
  const unresolved = new Set(states)
  const maxQueries = Math.max(0, ...states.map((state) => state.queries.length))
  let processedQueries = 0
  const totalQueries = states.reduce((total, state) => total + state.queries.length, 0)
  for (let round = 0; round < maxQueries && unresolved.size; round += 1) {
    const roundStates = [...unresolved].filter((state) => state.queries[round])
    for (let index = 0; index < roundStates.length; index += 25) {
      const batch = roundStates.slice(index, index + 25)
      try {
        const terms = batch.map((state) => {
          const value = String(state.queries[round].value).replace(/"/g, '\\"')
          return `"${value}"[synonym]`
        })
        const search = await entrezRequest('esearch.fcgi', { db: 'pccompound',
          term: terms.join(' OR '), retmode: 'json', retmax: 500, tool: 'MasspecLib' }, 'POST')
        const summaries = await fetchSummaryMap(search?.esearchresult?.idlist ?? [])
        const byName = summaryNameIndex(summaries)
        for (const state of batch) {
          const query = state.queries[round]
          const candidates = byName.get(normalizeText(query.value)) ?? []
          const match = candidates.find((item) =>
            propertyMatches(state.compound, item.property, query))
          if (!match) continue
          appendCache({ compoundId: Number(state.compound.id), status: 'matched',
            matchedBy: query.type, query: query.value, cids: [match.property.CID],
            property: match.property, synonyms: match.synonyms,
            fetchedAt: new Date().toISOString() }, cache)
          unresolved.delete(state)
        }
      } catch (error) {
        for (const state of batch) {
          appendCache({ compoundId: Number(state.compound.id), status: 'error',
            error: error instanceof Error ? error.message : String(error),
            fetchedAt: new Date().toISOString() }, cache)
          unresolved.delete(state)
        }
      }
      processedQueries += batch.length
      console.log(`PubChem query candidates: ${processedQueries}/${totalQueries}; unresolved=${unresolved.size}`)
    }
  }
  for (const state of unresolved) appendCache({ compoundId: Number(state.compound.id),
    status: 'unmatched', reason: 'no-formula-validated-exact-pubchem-synonym',
    fetchedAt: new Date().toISOString() }, cache)
}

async function enrichSummaries(compoundsById, records, cache) {
  const pending = records.filter((record) =>
    (record.status === 'resolved' && Array.isArray(record.cids)) ||
    (fetchImages && record.status === 'matched' && record.property?.CID &&
      !record.property?.IsomericSMILES && !record.property?.CanonicalSMILES))
  if (!pending.length) return
  const byCid = await fetchSummaryMap(pending.flatMap((record) =>
    Array.isArray(record.cids) ? record.cids : [record.property?.CID]))
  for (const record of pending) {
    const compound = compoundsById.get(Number(record.compoundId))
    const cids = Array.isArray(record.cids) ? record.cids : [record.property?.CID]
    const match = cids.map((cid) => byCid.get(Number(cid))).find((item) =>
      item && propertyMatches(compound, item.property,
        { type: record.matchedBy, value: record.query }))
    if (match) appendCache({ ...record, status: 'matched', property: match.property,
      synonyms: match.synonyms, fetchedAt: new Date().toISOString() }, cache)
    else if (record.status === 'resolved') appendCache({ ...record, status: 'unmatched',
      reason: 'formula-mismatch',
      candidateFormulas: cids.map((cid) => byCid.get(Number(cid))?.property?.MolecularFormula)
        .filter(Boolean), fetchedAt: new Date().toISOString() }, cache)
  }
}
let lastImageRequestAt = 0
async function pubchemImageRequest(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wait = Math.max(0, 1000 - (Date.now() - lastImageRequestAt))
    if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait))
    lastImageRequestAt = Date.now()
    const response = await fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/' + path,
      { headers: { 'User-Agent': 'MasspecLib-compound-enrichment/1.0' } })
    if (response.status === 404) return null
    if (response.ok) return Buffer.from(await response.arrayBuffer())
    if (![429, 500, 503, 504].includes(response.status)) {
      throw new Error(`PubChem image request failed (${response.status}): ${path}`)
    }
    const retryAfter = Number(response.headers.get('retry-after'))
    await new Promise((resolveWait) => setTimeout(resolveWait,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt))
  }
  throw new Error('PubChem image request retries exhausted: ' + path)
}
async function enrichImages(compoundsById, records, cache) {
  if (!fetchImages) return
  const pending = records.filter((record) => {
    const compound = compoundsById.get(Number(record.compoundId))
    return record.status === 'matched' && record.property?.CID && !record.structureSvg &&
      !record.structureImageBase64 && compound && isBlank(compound.formula_diagram_base64)
  })
  for (let index = 0; index < pending.length; index += 1) {
    const record = pending[index]
    const smiles = record.property?.IsomericSMILES ?? record.property?.CanonicalSMILES
    let structureSvg = null
    if (smiles) {
      try {
        const molecule = OCL.Molecule.fromSmiles(String(smiles))
        molecule.inventCoordinates()
        structureSvg = molecule.toSVG(300, 300, '', { autoCrop: true })
      } catch (error) {
        console.warn(
          `Could not render PubChem CID ${record.property.CID}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    appendCache(structureSvg ? { ...record, structureSvg,
      structureSource: 'PubChem SMILES rendered locally with OpenChemLib' } : record, cache)
    if ((index + 1) % 25 === 0 || index + 1 === pending.length) {
      console.log(`PubChem structures: ${index + 1}/${pending.length}`)
    }
  }
}

async function fetchMissingDetails(compounds, cache) {
  const targets = compounds.filter((compound) => isBlank(compound.main_name) ||
    isBlank(compound.cas) || isBlank(compound.formula) || compound.molecular_mass === null ||
    compound.monoisotopic_mass === null || safeNames(compound.name).length === 0 ||
    (fetchImages && isBlank(compound.formula_diagram_base64)))
    .filter((compound) => shouldRefresh || !cache.has(Number(compound.id)) ||
      cache.get(Number(compound.id))?.status === 'error' ||
      (retryCasImages && isBlank(compound.formula_diagram_base64) &&
        casSet(compound).size)).slice(0, fetchLimit)
  await batchResolveCompounds(targets, cache)
  const compoundsById = new Map(compounds.map((item) => [Number(item.id), item]))
  let records = compounds.map((compound) => cache.get(Number(compound.id))).filter(Boolean)
  await enrichSummaries(compoundsById, records, cache)
  records = compounds.map((compound) => cache.get(Number(compound.id))).filter(Boolean)
  await enrichImages(compoundsById, records, cache)
}

function preferredCas(record) {
  for (const synonym of record?.synonyms ?? []) {
    const cas = extractCas(synonym).find(validCas)
    if (cas) return cas
  }
  return null
}

function isIdentifierOnlyName(value) {
  const text = String(value ?? '').trim()
  if (!text || validCas(text) || !/[A-Za-z\u4e00-\u9fff]/.test(text)) return true
  return /^(?:DTX(?:SID|CID)|RefChem:|SCHEMBL|CHEMBL|AKOS|NSC?[-_ ]?\d|UNII-|InChI=)/i.test(text) ||
    /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(text) || /^(?=.*\d)(?:[A-Z][a-z]?\d*)+$/.test(text)
}

function preferredDisplayName(compound, record) {
  const official = (record.synonyms ?? []).find((name) =>
    /\[(?:INN|USAN|JAN|BAN|WHO-DD)\]/i.test(String(name)))
  const cleanOfficial = official?.replace(/\s*\[(?:INN|USAN|JAN|BAN|WHO-DD)\]\s*/ig, '').trim()
  const exactLocalQuery = isBlank(compound.main_name) && record.matchedBy === 'name'
    ? String(record.query ?? '').trim() : null
  const candidates = [exactLocalQuery, cleanOfficial, record.property?.Title, record.query,
    ...(record.synonyms ?? []), record.property?.IUPACName]
  return candidates.find((name) => name && !isIdentifierOnlyName(name)) ?? null
}
function buildCompoundUpdate(compound, record) {
  if (!record || record.status !== 'matched') return null
  const property = record.property ?? {}
  const displayName = preferredDisplayName(compound, record)
  const update = {}
  const isotopeLabeled = Number(property.IsotopeAtomCount) > 0 || ISOTOPE_LABEL_PATTERN.test(
    [compound.main_name, ...safeNames(compound.name), property.Title, property.IUPACName]
      .filter(Boolean).join(' '))
  if (isBlank(compound.main_name) && displayName) update.main_name = String(displayName)
  if (isBlank(compound.formula) && property.MolecularFormula && !isotopeLabeled) {
    update.formula = String(property.MolecularFormula)
  }
  if (compound.molecular_mass === null && !isBlank(property.MolecularWeight) && Number.isFinite(Number(property.MolecularWeight))) {
    update.molecular_mass = Number(property.MolecularWeight)
  }
  if (compound.monoisotopic_mass === null && !isBlank(property.MonoisotopicMass) && Number.isFinite(Number(property.MonoisotopicMass))) {
    update.monoisotopic_mass = Number(property.MonoisotopicMass)
  }
  const cas = preferredCas(record)
  if ((!extractCas(compound.cas).some(validCas) || isBlank(compound.cas)) && cas) update.cas = cas
  const existingNames = safeNameEntries(compound.name)
  const seen = new Set([compound.main_name, ...existingNames.map((item) => item.name)]
    .filter(Boolean).map(normalizeText))
  const merged = [...existingNames]
  for (const name of [...new Set([displayName, property.IUPACName])].filter(Boolean).slice(0, 2)) {
    const normalized = normalizeText(name)
    if (!seen.has(normalized)) {
      merged.push({ area: '北美', name: String(name) })
      seen.add(normalized)
    }
  }
  if (merged.length !== existingNames.length) update.name = JSON.stringify(merged)
  if (isBlank(compound.formula_diagram_base64) && record.structureImageBase64) {
    update.formula_diagram_base64 = 'data:image/png;base64,' + record.structureImageBase64
  } else if (isBlank(compound.formula_diagram_base64) && record.structureSvg) {
    update.formula_diagram_base64 = record.structureSvg
  }
  if (imagesOnly) return update.formula_diagram_base64
    ? { formula_diagram_base64: update.formula_diagram_base64 } : null
  return Object.keys(update).length ? update : null
}

async function ensureClasses(db) {
  const [rows] = await db.query('SELECT id, class_name FROM classes')
  const byName = new Map(rows.map((row) => [String(row.class_name), Number(row.id)]))
  for (const className of Object.values(CLASS_NAMES)) {
    if (byName.has(className)) continue
    const [result] = await db.query(
      'INSERT INTO classes (class_name, is_custom, create_time, update_time) VALUES (?, 0, NOW(), NOW())',
      [className])
    byName.set(className, Number(result.insertId))
  }
  return byName
}

async function applyChanges(db, compounds, cache, classifications) {
  const updates = compounds.map((compound) =>
    ({ compound, update: buildCompoundUpdate(compound, cache.get(Number(compound.id))) }))
    .filter((item) => item.update)
  let backupPath = null
  if (updates.length) {
    backupPath = join(root, 'backups',
      `compound-enrichment-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    mkdirSync(dirname(backupPath), { recursive: true })
    writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(),
      rows: updates.map(({ compound, update }) => ({ id: compound.id,
        previous: Object.fromEntries(Object.keys(update).map((column) => [column, compound[column]])) }))
    }, null, 2), 'utf8')
  }
  let rebuiltManagedClassLinks = false
  let insertedClassLinks = 0
  const classIds = imagesOnly ? new Map() : await ensureClasses(db)
  await db.beginTransaction()
  try {
    for (const { compound, update } of updates) {
      const entries = Object.entries(update)
      const sql = 'UPDATE compounds SET ' + entries.map(([column]) => `\`${column}\` = ?`).join(', ') +
        ', update_time = NOW() WHERE id = ?'
      await db.query(sql, [...entries.map(([, value]) => value), compound.id])
    }
    if (!imagesOnly) {
      const managedClassIds = Object.values(CLASS_NAMES).map((className) => classIds.get(className))
      const [duplicateLinks] = await db.query(
        'SELECT compound_id, class_id FROM compound_class WHERE class_id IN (?) ' +
        'GROUP BY compound_id, class_id HAVING COUNT(*) > 1 LIMIT 1', [managedClassIds])
      if (duplicateLinks.length) {
        await db.query('DELETE FROM compound_class WHERE class_id IN (?)', [managedClassIds])
        rebuiltManagedClassLinks = true
      }
      const [existingLinks] = await db.query(
        'SELECT compound_id, class_id FROM compound_class WHERE class_id IN (?)', [managedClassIds])
      const linkKeys = new Set(existingLinks.map((item) => `${item.compound_id}:${item.class_id}`))
      for (const item of classifications) for (const className of item.classes) {
        const classId = classIds.get(className)
        const key = `${item.compoundId}:${classId}`
        if (linkKeys.has(key)) continue
        await db.query('INSERT INTO compound_class (compound_id, class_id, create_time, update_time) VALUES (?, ?, NOW(), NOW())',
          [item.compoundId, classId])
        linkKeys.add(key)
        insertedClassLinks += 1
      }
    }
    await db.commit()
  } catch (error) {
    await db.rollback()
    throw error
  }
  return { updatedCompounds: updates.length, backupPath, insertedClassLinks,
    rebuiltManagedClassLinks }
}

function detailSummary(compounds, cache) {
  const records = compounds.map((compound) => cache.get(Number(compound.id))).filter(Boolean)
  return {
    activeCompounds: compounds.length,
    incompleteCompounds: compounds.filter((compound) => isBlank(compound.main_name) ||
      isBlank(compound.cas) || isBlank(compound.formula) || compound.molecular_mass === null ||
      compound.monoisotopic_mass === null || safeNames(compound.name).length === 0).length,
    missingMainName: compounds.filter((item) => isBlank(item.main_name)).length,
    missingCas: compounds.filter((item) => isBlank(item.cas)).length,
    missingFormula: compounds.filter((item) => isBlank(item.formula)).length,
    missingMolecularMass: compounds.filter((item) => item.molecular_mass === null).length,
    missingMonoisotopicMass: compounds.filter((item) => item.monoisotopic_mass === null).length,
    missingSynonyms: compounds.filter((item) => safeNames(item.name).length === 0).length,
    missingStructureDiagram: compounds.filter((item) => isBlank(item.formula_diagram_base64)).length,
    pubchemMatched: records.filter((item) => item.status === 'matched').length,
    pubchemUnmatched: records.filter((item) => item.status === 'unmatched').length,
    pubchemErrors: records.filter((item) => item.status === 'error').length
  }
}

async function main() {
  const envFile = join(root, '.env')
  if (!existsSync(envFile)) throw new Error('Database config was not found: ' + envFile)
  loadEnv({ path: envFile, quiet: true })
  const db = await mysql.createConnection({ host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT), user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME, charset: 'utf8mb4' })
  try {
    const [compounds] = await db.query(
      'SELECT id, main_name, name, formula, cas, molecular_mass, monoisotopic_mass, ' +
      'formula_diagram_base64 FROM compounds WHERE COALESCE(is_delete, 0) = 0 ORDER BY id')
    const awareAntibiotics = readAwareAntibiotics()
    const cache = loadCache()
    if (shouldFetch) await fetchMissingDetails(compounds, cache)
    const originalClassifications = compounds.map((compound) => ({ compoundId: Number(compound.id),
      mainName: compound.main_name, cas: compound.cas,
      classes: classifyCompound(compound, awareAntibiotics) })).filter((item) => item.classes.length)
    const originalClassById = new Map(originalClassifications.map((item) =>
      [item.compoundId, new Set(item.classes)]))
    const previewCompounds = compounds.map((compound) => ({ ...compound,
      ...(buildCompoundUpdate(compound, cache.get(Number(compound.id))) ?? {}) }))
    const classifications = previewCompounds.map((compound) => ({ compoundId: Number(compound.id),
      mainName: compound.main_name, cas: compound.cas,
      classes: classifyCompound(compound, awareAntibiotics) })).filter((item) => item.classes.length)
    const classCounts = Object.values(CLASS_NAMES).map((className) => ({ className,
      compoundCount: classifications.filter((item) => item.classes.includes(className)).length }))
    const originalClassCounts = Object.values(CLASS_NAMES).map((className) => ({ className,
      compoundCount: originalClassifications.filter((item) => item.classes.includes(className)).length }))
    const classificationAdditions = classifications.map((item) => ({ ...item,
      classes: item.classes.filter((className) => !originalClassById.get(item.compoundId)?.has(className)) }))
      .filter((item) => item.classes.length)
    const applied = shouldApply ? await applyChanges(db, compounds, cache, classifications) : null
    const reportCompounds = shouldApply ? (await db.query(
      'SELECT id, main_name, name, formula, cas, molecular_mass, monoisotopic_mass, ' +
      'formula_diagram_base64 FROM compounds WHERE COALESCE(is_delete, 0) = 0 ORDER BY id'))[0] : compounds
    const proposedUpdates = compounds.map((compound) => {
      const record = cache.get(Number(compound.id))
      const update = buildCompoundUpdate(compound, record)
      if (!update) return null
      const fields = Object.keys(update)
      return { compoundId: Number(compound.id), mainName: compound.main_name,
        matchedBy: record?.matchedBy, query: record?.query, fields,
        values: Object.fromEntries(Object.entries(update)
          .filter(([key]) => key !== 'formula_diagram_base64')),
        hasStructureImage: fields.includes('formula_diagram_base64') }
    }).filter(Boolean)
    const proposedUpdateCounts = Object.keys(proposedUpdates.reduce((counts, item) => {
      for (const field of item.fields) counts[field] = (counts[field] ?? 0) + 1
      return counts
    }, {})).sort().reduce((result, field) => {
      result[field] = proposedUpdates.filter((item) => item.fields.includes(field)).length
      return result
    }, {})
    const report = { generatedAt: new Date().toISOString(),
      mode: shouldApply ? 'apply' : shouldFetch ? 'fetch-preview' : 'preview', sources: SOURCES,
      detailSummary: detailSummary(reportCompounds, cache), awareAntibioticEntries: awareAntibiotics.size,
      proposedUpdateCounts, proposedUpdates, originalClassCounts, classCounts,
      classificationAdditions, classificationMatches: classifications,
      unmatchedPubChem: compounds.map((compound) => ({ compound,
        record: cache.get(Number(compound.id)) })).filter((item) => item.record?.status === 'unmatched')
        .map(({ compound }) => ({ compoundId: compound.id, mainName: compound.main_name,
          cas: compound.cas, formula: compound.formula })), applied }
    mkdirSync(dirname(reportFile), { recursive: true })
    writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8')
    console.log(JSON.stringify({ reportFile, ...report.detailSummary, classCounts, applied }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})