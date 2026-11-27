import './legacy-disabled.mjs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import process from 'process'
import { config as loadEnv } from 'dotenv'
import mysql from 'mysql2/promise'
import * as OCL from 'openchemlib'

const root = resolve(process.cwd())
const args = new Set(process.argv.slice(2))
const shouldFetch = args.has('--fetch')
const synonymsOnly = args.has('--synonyms-only')
const shouldApply = args.has('--apply')
const shouldRefresh = args.has('--refresh')
const importReportFile = join(root, 'docs', 'nist-all-new-compounds-import-report.json')
const cacheFile = join(root, 'docs', 'enrichment-cache', 'nist-imported-pubchem.jsonl')
const generalCacheFile = join(root, 'docs', 'enrichment-cache', 'pubchem-compounds.jsonl')
const reportFile = join(root, 'docs', 'nist-imported-enrichment-report.json')

const CLASS = Object.freeze({
  pesticide: '农药', veterinary: '兽药', poison: '毒物', environmental: '环境污染物',
  biotoxin: '生物毒素', drug: '药物及代谢物', material: '化工材料', therapeutic: '治疗药物',
  food: '食品添加剂', natural: '天然产物', plasticizer: '塑化剂', antibiotic: '抗生素',
  pfas: '全氟化合物', illegal: '非法添加', emerging: '新型污染物', mycotoxin: '真菌毒素'
})

const PFAS_PATTERN = /(?:perfluoro|polyfluoro|fluorotelomer|\bpf(?:os|oa|hxs|bs|ds|da|doa|hps|hpa|hxda|na|nona|oda|pea|pesa|tes|teda|trda|uda|unda|eesa|osa)\b|mpf(?:os|oa|hxs)|\b\d{1,2}:\d(?:\/\d{1,2}:\d)?\s*(?:ft(?:oh|ca|uca|s|p)?|di\s*pap|pap)\b|8cl-pfos|全氟)/i
const MYCOTOXIN_PATTERN = /(?:aflatoxin|aflatoxicol|aflatrem|ochratoxin|patulin|fumonisin|zearalen|zearalan|nivalenol|deoxynivalenol|deepoxy[- ]?deoxynivalenol|\bdon(?:-|\b)|\bht-?2\b|\bt-?2(?:\s*toxin|-triol|-tetraol|\b)|neosolaniol|diacetoxyscirpenol|fusarenon|sterigmatocystin|citrinin|verrucarin|alternariol|tenuazonic)/i
const ANTIBIOTIC_PATTERN = /(?:antibiotic|\b[a-z]+floxacin\b|\b[a-z]*cillin\b|\bpenicillin\b|\bcef[a-z]+\b|\bceph[a-z]+\b|\b[a-z]+cycline\b|\bsulfa(?:diazine|dimethoxine|dimidine|furazole|isodimidine|lene|merazine|methazine|methizole|methoxazole|methoxypyridazine|monomethoxine|pyridine|quinoxaline|thiazole|doxin|chloropyridazine|benzamide|nitran)\b|amikacin|gentamicin|kanamycin|neomycin|streptomycin|tobramycin|apramycin|sisomicin|netilmicin|ribostamycin|hygromycin\s*b|spectinomycin|erythromycin|azithromycin|clarithromycin|roxithromycin|spiramycin|tilmicosin|tylosin|tulathromycin|gamithromycin|josamycin|oleandomycin|kitasamycin|leucomycin|virginiamycin|clindamycin|lincomycin|pirlimycin|chloramphenicol|thiamphenicol|florfenicol|metronidazole|tinidazole|ornidazole|ronidazole|dimetridazole|imipenem|meropenem|ertapenem|doripenem|vancomycin|teicoplanin|dalbavancin|oritavancin|linezolid|daptomycin|bacitracin|colistin|polymyxin|fosfomycin|tiamulin|valnemulin|pleuromutilin|nitrofurantoin|nitrofurazone|furazolidone|furaltadone)/i
const PESTICIDE_PATTERN = /(?:pesticide|insecticide|herbicide|fungicide|acaricide|nematicide|rodenticide|molluscicide|plant\s*growth\s*regulator|agrochemical|chlorpyrifos|atrazine|simazine|terbuthylazine|alachlor|metolachlor|glyphosate|glufosinate|paraquat|diquat|carbaryl|carbofuran|imidacloprid|acetamiprid|thiamethoxam|clothianidin|dinotefuran|fipronil|permethrin|cypermethrin|deltamethrin|bifenthrin|tebuconazole|propiconazole|hexaconazole|myclobutanil|azoxystrobin|boscalid|metalaxyl|dimethoate|malathion|parathion|diazinon|dichlorvos|triazophos|trichlorfon)/i
const VETERINARY_PATTERN = /(?:veterinary|animal\s*drug|anthelmintic|coccidiostat|coccidiocid|ivermectin|doramectin|eprinomectin|moxidectin|levamisole|albendazole|fenbendazole|oxfendazole|febantel|clenbuterol|ractopamine|zilpaterol|olaquindox)/i
const DRUG_PATTERN = /(?:pharmaceutical|\bdrugs?\b|therapeutic|medication|analgesic|anesthetic|antiviral|antiretroviral|antihypertensive|antidepressant|antipsychotic|anticonvulsant|opioid|barbitur|morphine|codeine|fentanyl|amphetamine|cocaine|ketamine|lidocaine|procaine|benzocaine|\[(?:inn|usan|ban|jan|vandf|who-dd)[^\]]*\]|\bdb\d{5}\b|\b[a-z]+navir\b|\b[a-z]+vir\b|\b[a-z]+pril\b|\b[a-z]+sartan\b|\b[a-z]+olol\b|\b[a-z]+prazole\b|\b[a-z]+statin\b|\b[a-z]+zepam\b|\b[a-z]+oxetine\b|\b[a-z]+triptyline\b|\b[a-z]+caine\b)/i
const METABOLITE_PATTERN = /(?:human\s*metabolite|drug\s*metabolite|metabolite|desmethyl|demethyl|n-desalkyl|o-desalkyl|glucuronide|sulfate\s+conjugate|acetylprocainamide|norcodeine|norcocaine|hydroxy\w+\s+metabolite)/i
const FOOD_PATTERN = /(?:food\s*additive|food\s*antioxidant|sweetener|preservative|flavou?r(?:ing)?|food\s*colo(?:u)?r|vitamin\s+[a-k]|ascorbic\s+acid|saccharin|aspartame|acesulfame|sucralose|benzoic\s+acid|sorbic\s+acid)/i
const NATURAL_PATTERN = /(?:natural\s*product|plant\s*metabolite|microbial\s*metabolite|phytochemical|flavonoid|anthocyan|terpenoid|alkaloid|catechin|quercetin|kaempferol|resveratrol|curcumin|vitamin\s+[a-k]|dopamine|serotonin|epinephrine|norepinephrine)/i
const PLASTICIZER_PATTERN = /(?:plasticizer|plasticiser|phthalate|adipate|sebacate|trimellitate|citrate\s+ester|bisphenol\s*[a-z]?)/i
const TOXIN_PATTERN = /(?:biotoxin|toxin|venom|poison|toxicant|saxitoxin|brevetoxin|ciguatoxin|tetrodotoxin|microcystin|anatoxin)/i
const ENVIRONMENT_PATTERN = /(?:environmental\s*(?:contaminant|pollutant)|emerging\s*contaminant|persistent\s*organic\s*pollutant|endocrine\s*disrupt|norman\s*suspect|flame\s*retardant|polychlorinated\s*biphenyl|\bpcb[- ]?\d+|dioxin|dechlorane)/i
const MATERIAL_PATTERN = /(?:surfactant|detergent|polymer|monomer|industrial|solvent|dye|pigment|stabilizer|stabiliser|lubricant|corrosion\s*inhibitor|photoinitiator|benzotriazole|alkylbenzene|sulfonic\s*acid|phosphoric\s*acid.*ester|chemical\s*material)/i
const ILLEGAL_PATTERN = /(?:melamine|sudan\s*[ivx1-4]*|rhodamine\s*b|formaldehyde|sodium\s*formaldehyde\s*sulfoxylate|borax|boric\s*acid|clenbuterol|ractopamine|malachite\s*green|crystal\s*violet|leucomalachite|auramine\s*o|potassium\s*bromate|dimethyl\s*fumarate|dichlorvos|nitrofuran|furazolidone|furaltadone|nitrofurazone|nitrofurantoin|olaquindox|sodium\s*pentachlorophen|trichlorfon|acid\s*orange\s*ii|basic\s*yellow|methenamine|hexamethylenetetramine|sildenafil|tadalafil|vardenafil|sibutramine|phenolphthalein)/i

const normText = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim()
const connectivityKey = (value) => String(value ?? '').trim().toUpperCase().slice(0, 14)
const extractCas = (value) => [...String(value ?? '').matchAll(/\b\d{2,7}-\d{2}-\d\b/g)]
  .map((match) => match[0])
function validCas(value) {
  if (!/^\d{2,7}-\d{2}-\d$/.test(value)) return false
  const digits = value.replace(/-/g, '')
  const sum = digits.slice(0, -1).split('').reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index + 1), 0)
  return sum % 10 === Number(digits.at(-1))
}
function formulaCounts(value) {
  const counts = new Map()
  for (const match of String(value ?? '').matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2] || 1))
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
}
const sameFormula = (left, right) =>
  JSON.stringify(formulaCounts(left)) === JSON.stringify(formulaCounts(right))

function loadImportScope() {
  if (!existsSync(importReportFile)) throw new Error('NIST import report not found: ' + importReportFile)
  const report = JSON.parse(readFileSync(importReportFile, 'utf8'))
  const candidates = new Map((report.candidates ?? []).map((item) => [item.identityKey, item]))
  const inserted = (report.inserted ?? []).map((item) => ({ ...item,
    candidate: candidates.get(item.identityKey) })).filter((item) => item.candidate)
  if (!inserted.length) throw new Error('NIST import report contains no inserted compounds')
  return { report, inserted }
}

function loadCache() {
  const cache = new Map()
  if (!existsSync(cacheFile)) return cache
  for (const line of readFileSync(cacheFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      if (record?.compoundId) cache.set(Number(record.compoundId), record)
    } catch { /* Ignore a partial final cache line. */ }
  }
  return cache
}
function appendCache(record, cache) {
  mkdirSync(dirname(cacheFile), { recursive: true })
  appendFileSync(cacheFile, JSON.stringify(record) + '\n', 'utf8')
  cache.set(Number(record.compoundId), record)
}

let lastRequestAt = 0
async function requestJson(url) {
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = Math.max(0, 750 - (Date.now() - lastRequestAt))
    if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait))
    lastRequestAt = Date.now()
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'MasspecLib-nist-import/1.0' },
        signal: AbortSignal.timeout(15_000)
      })
      if (response.status === 404) return null
      if (response.ok) return response.json()
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000 : Math.min(20_000, 800 * 2 ** attempt)
      await new Promise((resolveWait) => setTimeout(resolveWait, delay))
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`)
    } catch (error) {
      lastError = error
      if (attempt < 5) await new Promise((resolveWait) =>
        setTimeout(resolveWait, Math.min(20_000, 800 * 2 ** attempt)))
    }
  }
  throw lastError ?? new Error('PubChem request retries exhausted')
}

function normalizeProperty(raw) {
  if (!raw) return null
  return { ...raw,
    CanonicalSMILES: raw.CanonicalSMILES ?? raw.ConnectivitySMILES ?? null,
    IsomericSMILES: raw.IsomericSMILES ?? raw.SMILES ?? null }
}

async function fetchProperty(inputType, value) {
  const fields = 'Title,IUPACName,MolecularFormula,MolecularWeight,MonoisotopicMass,InChIKey,CanonicalSMILES,IsomericSMILES'
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${inputType}/${encodeURIComponent(value)}/property/${fields}/JSON`
  const data = await requestJson(url)
  return (data?.PropertyTable?.Properties ?? []).map(normalizeProperty)
}

function collectStrings(value, result = []) {
  if (typeof value === 'string') result.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, result)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, result)
  return result
}

async function fetchChemicalClasses(cid) {
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON?heading=Chemical%20Classes`
  const data = await requestJson(url)
  return [...new Set(collectStrings(data).filter((value) => value.length <= 500))]
}

async function resolveOne(item) {
  const candidate = item.candidate
  const queries = []
  if (/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(String(candidate.inchiKey ?? ''))) {
    queries.push({ type: 'inchikey', value: candidate.inchiKey })
  }
  if (candidate.cas) queries.push({ type: 'name', value: candidate.cas })
  if (candidate.name) queries.push({ type: 'name', value: candidate.name })
  let property = null
  let matchedBy = null
  for (const query of queries) {
    const properties = await fetchProperty(query.type, query.value)
    property = properties.find((candidateProperty) =>
      connectivityKey(candidateProperty.InChIKey) === item.identityKey &&
      sameFormula(candidateProperty.MolecularFormula, candidate.formula)) ?? null
    if (property) { matchedBy = query.type; break }
  }
  if (!property) return { compoundId: item.compoundId, identityKey: item.identityKey,
    status: 'unmatched', reason: 'no PubChem property matched NIST connectivity InChIKey and formula',
    fetchedAt: new Date().toISOString() }
  const chemicalClassStrings = await fetchChemicalClasses(property.CID)
  return { compoundId: item.compoundId, identityKey: item.identityKey,
    status: 'matched', matchedBy, property, chemicalClassStrings, synonyms: [],
    fetchedAt: new Date().toISOString() }
}

async function fetchDetails(items, cache) {
  const pending = synonymsOnly ? [] : items.filter((item) => shouldRefresh || !cache.has(Number(item.compoundId)) ||
    cache.get(Number(item.compoundId))?.status === 'error')
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]
    try { appendCache(await resolveOne(item), cache) }
    catch (error) { appendCache({ compoundId: item.compoundId, identityKey: item.identityKey,
      status: 'error', error: error instanceof Error ? error.message : String(error),
      fetchedAt: new Date().toISOString() }, cache) }
    if ((index + 1) % 25 === 0 || index + 1 === pending.length) {
      const matched = items.filter((candidate) =>
        cache.get(Number(candidate.compoundId))?.status === 'matched').length
      console.log(`PubChem properties/classes: ${index + 1}/${pending.length}; matched=${matched}`)
    }
  }

  const synonymPending = items.map((item) => cache.get(Number(item.compoundId))).filter((record) =>
    record?.status === 'matched' && record.property?.CID && !(record.synonyms?.length))
  for (let offset = 0; offset < synonymPending.length; offset += 25) {
    const batch = synonymPending.slice(offset, offset + 25)
    const cids = batch.map((record) => Number(record.property.CID))
    try {
      const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cids.join(',')}/synonyms/JSON`
      const data = await requestJson(url)
      const byCid = new Map((data?.InformationList?.Information ?? [])
        .map((record) => [Number(record.CID), record.Synonym ?? []]))
      for (const record of batch) appendCache({ ...record,
        synonyms: byCid.get(Number(record.property.CID)) ?? [],
        fetchedAt: new Date().toISOString() }, cache)
    } catch (error) {
      console.warn(`PubChem synonym batch ${offset + 1}-${offset + batch.length} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    console.log(`PubChem synonyms: ${Math.min(offset + 25, synonymPending.length)}/${synonymPending.length}`)
  }
}

function usefulSynonym(value) {
  const text = String(value ?? '').trim()
  if (!text || validCas(text) || !/[A-Za-z\u4e00-\u9fff]/.test(text)) return false
  if (/^(?:DTX(?:SID|CID)|RefChem:|SCHEMBL|CHEMBL|AKOS|NSC?[-_ ]?\d|UNII-|InChI=)/i.test(text)) return false
  if (/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(text) || /\b(?:d\d+|\d{2,3}[cnosh]\d*)\b/i.test(text)) return false
  return text.length <= 240
}

function safeNameEntries(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => typeof item === 'string'
      ? { area: '', name: item.trim() }
      : { area: String(item?.area ?? '').trim(), name: String(item?.name ?? '').trim() })
      .filter((item) => item.name)
  } catch { return [] }
}

function mergeNames(compound, record) {
  const result = safeNameEntries(compound.name)
  const seen = new Set([compound.main_name, ...result.map((item) => item.name)]
    .filter(Boolean).map(normText))
  const candidates = [record.property?.Title, record.property?.IUPACName,
    ...(record.synonyms ?? []).filter(usefulSynonym).slice(0, 20)]
  for (const name of candidates) {
    const key = normText(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({ area: '北美', name: String(name) })
  }
  return result
}

function structureSvg(record, expectedFormula) {
  if (record?.status !== 'matched') return null
  const smiles = record.property?.IsomericSMILES ?? record.property?.CanonicalSMILES
  if (!smiles || !sameFormula(record.property?.MolecularFormula, expectedFormula)) return null
  try {
    const molecule = OCL.Molecule.fromSmiles(String(smiles))
    if (!sameFormula(molecule.getMolecularFormula().formula, expectedFormula)) return null
    molecule.inventCoordinates()
    return molecule.toSVG(300, 300, '', { autoCrop: true })
  } catch { return null }
}

function classify(item, compound, record) {
  const text = [compound.main_name, ...safeNameEntries(compound.name).map((entry) => entry.name),
    record?.property?.Title, record?.property?.IUPACName, ...(record?.synonyms ?? []),
    ...(record?.chemicalClassStrings ?? [])].filter(Boolean).join(' | ')
  const classes = new Set()
  const evidence = []
  const add = (className, reason) => { classes.add(className); evidence.push({ className, reason }) }
  const antibiotic = ANTIBIOTIC_PATTERN.test(text)
  const pfas = PFAS_PATTERN.test(text)
  const mycotoxin = MYCOTOXIN_PATTERN.test(text)
  if (antibiotic) {
    add(CLASS.antibiotic, 'PubChem/NIST antibiotic classification')
    add(CLASS.therapeutic, 'antibiotic therapeutic use')
    add(CLASS.drug, 'antibiotic drug identity')
    add(CLASS.emerging, 'project rule: antibiotics are emerging contaminants')
  }
  if (pfas) {
    add(CLASS.pfas, 'PFAS identity')
    add(CLASS.environmental, 'PFAS environmental contaminant')
    add(CLASS.emerging, 'PFAS emerging contaminant')
  }
  if (mycotoxin) {
    add(CLASS.mycotoxin, 'mycotoxin identity')
    add(CLASS.biotoxin, 'mycotoxin biological origin')
    add(CLASS.natural, 'mycotoxin natural origin')
  }
  if (PESTICIDE_PATTERN.test(text)) add(CLASS.pesticide, 'PubChem/NIST pesticide classification')
  if (VETERINARY_PATTERN.test(text)) {
    add(CLASS.veterinary, 'veterinary drug classification')
    add(CLASS.therapeutic, 'veterinary therapeutic use')
    add(CLASS.drug, 'veterinary drug identity')
  }
  if (DRUG_PATTERN.test(text) && !antibiotic) {
    add(CLASS.therapeutic, 'PubChem drug/pharmaceutical classification')
    add(CLASS.drug, 'PubChem drug/pharmaceutical classification')
  }
  if (METABOLITE_PATTERN.test(text)) add(CLASS.drug, 'metabolite classification')
  if (FOOD_PATTERN.test(text)) add(CLASS.food, 'food additive/nutrient classification')
  if (NATURAL_PATTERN.test(text)) add(CLASS.natural, 'natural product classification')
  if (PLASTICIZER_PATTERN.test(text)) {
    add(CLASS.plasticizer, 'plasticizer classification')
    add(CLASS.material, 'plasticizer material use')
  }
  if (TOXIN_PATTERN.test(text) && !mycotoxin) add(CLASS.poison, 'toxin/poison classification')
  if (ENVIRONMENT_PATTERN.test(text)) add(CLASS.environmental, 'environmental contaminant classification')
  if (MATERIAL_PATTERN.test(text)) add(CLASS.material, 'industrial/material classification')
  if (ILLEGAL_PATTERN.test(text)) add(CLASS.illegal, 'project illegal-addition rule')
  if (!classes.size) add(CLASS.material, 'fallback: no finer PubChem project class was available')
  return { classes: [...classes], evidence,
    removeFallbackMaterial: item.classificationConfidence === 'fallback' &&
      classes.size > 1 && classes.has(CLASS.material) === false ||
      item.classificationConfidence === 'fallback' && [...classes].some((name) => name !== CLASS.material) }
}

function buildUpdate(compound, item, record) {
  if (record?.status !== 'matched') return { update: null, svg: null }
  const update = {}
  const names = mergeNames(compound, record)
  if (JSON.stringify(names) !== JSON.stringify(safeNameEntries(compound.name))) {
    update.name = JSON.stringify(names)
  }
  if ((!compound.cas || !extractCas(compound.cas).some(validCas))) {
    const cas = (record.synonyms ?? []).flatMap(extractCas).find(validCas)
    if (cas) update.cas = cas
  }
  if (!compound.formula && record.property?.MolecularFormula) update.formula = record.property.MolecularFormula
  if (compound.molecular_mass === null && Number.isFinite(Number(record.property?.MolecularWeight))) {
    update.molecular_mass = Number(record.property.MolecularWeight)
  }
  if (compound.monoisotopic_mass === null && Number.isFinite(Number(record.property?.MonoisotopicMass))) {
    update.monoisotopic_mass = Number(record.property.MonoisotopicMass)
  }
  const svg = !compound.formula_diagram_base64
    ? structureSvg(record, item.candidate.formula || record.property?.MolecularFormula) : null
  if (svg) update.formula_diagram_base64 = svg
  return { update: Object.keys(update).length ? update : null, svg }
}

async function applyChanges(db, items, compoundsById, cache, classifications) {
  const [classRows] = await db.query('SELECT id, class_name FROM classes')
  const classIds = new Map(classRows.map((row) => [String(row.class_name), Number(row.id)]))
  const updates = []
  let structures = 0
  for (const item of items) {
    const compound = compoundsById.get(Number(item.compoundId))
    const record = cache.get(Number(item.compoundId))
    const result = buildUpdate(compound, item, record)
    if (result.update) updates.push({ compound, update: result.update })
    if (result.svg) structures += 1
  }
  let insertedClassLinks = 0
  let removedFallbackLinks = 0
  await db.beginTransaction()
  try {
    for (const { compound, update } of updates) {
      const entries = Object.entries(update)
      await db.query('UPDATE compounds SET ' + entries.map(([column]) => `\`${column}\` = ?`).join(', ') +
        ', update_time = NOW() WHERE id = ?', [...entries.map(([, value]) => value), compound.id])
    }
    const [linkRows] = await db.query('SELECT compound_id, class_id FROM compound_class WHERE compound_id IN (?)',
      [items.map((item) => Number(item.compoundId))])
    const links = new Set(linkRows.map((row) => `${row.compound_id}:${row.class_id}`))
    for (const item of classifications) {
      if (item.removeFallbackMaterial) {
        const materialId = classIds.get(CLASS.material)
        const key = `${item.compoundId}:${materialId}`
        if (links.has(key)) {
          await db.query('DELETE FROM compound_class WHERE compound_id = ? AND class_id = ?',
            [item.compoundId, materialId])
          links.delete(key)
          removedFallbackLinks += 1
        }
      }
      for (const className of item.classes) {
        const classId = classIds.get(className)
        if (!classId) throw new Error('Project class not found: ' + className)
        const key = `${item.compoundId}:${classId}`
        if (links.has(key)) continue
        await db.query('INSERT INTO compound_class ' +
          '(compound_id, class_id, create_time, update_time) VALUES (?, ?, NOW(), NOW())',
        [item.compoundId, classId])
        links.add(key)
        insertedClassLinks += 1
      }
    }
    await db.commit()
  } catch (error) { await db.rollback(); throw error }

  for (const item of items) {
    const record = cache.get(Number(item.compoundId))
    if (record?.status !== 'matched') continue
    const compound = compoundsById.get(Number(item.compoundId))
    const svg = structureSvg(record, item.candidate.formula || record.property?.MolecularFormula)
    appendFileSync(generalCacheFile, JSON.stringify({ compoundId: Number(item.compoundId),
      status: 'matched', matchedBy: `nist-${record.matchedBy}`, query: item.candidate.inchiKey || item.candidate.cas,
      cids: [record.property.CID], property: record.property, synonyms: record.synonyms,
      fetchedAt: new Date().toISOString(), ...(svg ? { structureSvg: svg,
        structureSource: 'PubChem SMILES rendered locally with OpenChemLib' } : {}),
      localName: compound.main_name }) + '\n', 'utf8')
  }
  return { updatedCompounds: updates.length, addedStructures: structures,
    insertedClassLinks, removedFallbackLinks }
}

async function main() {
  const envFile = join(root, '.env')
  if (!existsSync(envFile)) throw new Error('Database config was not found: ' + envFile)
  loadEnv({ path: envFile, quiet: true })
  const { inserted } = loadImportScope()
  const cache = loadCache()
  if (shouldFetch) await fetchDetails(inserted, cache)
  const db = await mysql.createConnection({ host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT), user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME,
    charset: 'utf8mb4' })
  try {
    const ids = inserted.map((item) => Number(item.compoundId))
    const [compounds] = await db.query('SELECT id, main_name, name, formula, cas, molecular_mass, ' +
      'monoisotopic_mass, formula_diagram_base64 FROM compounds WHERE id IN (?)', [ids])
    const compoundsById = new Map(compounds.map((compound) => [Number(compound.id), compound]))
    if (compounds.length !== inserted.length) throw new Error('Imported compound scope no longer matches database')
    const classifications = inserted.map((item) => ({ compoundId: Number(item.compoundId),
      ...classify(item, compoundsById.get(Number(item.compoundId)), cache.get(Number(item.compoundId))) }))
    const updates = inserted.map((item) => {
      const compound = compoundsById.get(Number(item.compoundId))
      const record = cache.get(Number(item.compoundId))
      const result = buildUpdate(compound, item, record)
      return { compoundId: Number(item.compoundId), name: compound.main_name,
        pubchemStatus: record?.status ?? 'not-fetched', pubchemCid: record?.property?.CID ?? null,
        updateFields: result.update ? Object.keys(result.update) : [], hasStructure: Boolean(result.svg),
        classes: classifications.find((entry) => entry.compoundId === Number(item.compoundId))?.classes ?? [] }
    })
    const applied = shouldApply ? await applyChanges(db, inserted, compoundsById, cache, classifications) : null
    const records = inserted.map((item) => cache.get(Number(item.compoundId))).filter(Boolean)
    const classCounts = Object.values(CLASS).map((className) => ({ className,
      count: classifications.filter((item) => item.classes.includes(className)).length }))
    const report = { generatedAt: new Date().toISOString(),
      mode: shouldApply ? 'apply' : shouldFetch ? 'fetch-preview' : 'preview',
      scope: { compounds: inserted.length, minId: Math.min(...ids), maxId: Math.max(...ids) },
      pubchem: { matched: records.filter((record) => record.status === 'matched').length,
        unmatched: records.filter((record) => record.status === 'unmatched').length,
        errors: records.filter((record) => record.status === 'error').length,
        notFetched: inserted.length - records.length },
      proposedStructures: updates.filter((item) => item.hasStructure).length,
      proposedCasAdditions: updates.filter((item) => item.updateFields.includes('cas')).length,
      classCounts, applied, updates,
      unmatched: inserted.filter((item) => cache.get(Number(item.compoundId))?.status !== 'matched')
        .map((item) => ({ compoundId: item.compoundId, name: item.name, cas: item.cas,
          inchiKey: item.candidate.inchiKey, record: cache.get(Number(item.compoundId)) ?? null })) }
    mkdirSync(dirname(reportFile), { recursive: true })
    writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8')
    console.log(JSON.stringify({ reportFile, ...report.scope, ...report.pubchem,
      proposedStructures: report.proposedStructures, proposedCasAdditions: report.proposedCasAdditions,
      classCounts, applied }, null, 2))
  } finally { await db.end() }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
