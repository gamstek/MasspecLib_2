import './legacy-disabled.mjs'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import process from 'process'
import { config as loadEnv } from 'dotenv'
import mysql from 'mysql2/promise'

const root = resolve(process.cwd())
const options = {
  apply: process.argv.includes('--apply'),
  docsDir: join(root, 'docs'),
  reportFile: join(root, 'docs', 'nist-all-new-compounds-import-report.json')
}
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--docs') options.docsDir = resolve(process.argv[++i])
  if (process.argv[i] === '--report') options.reportFile = resolve(process.argv[++i])
}

const CLASS = Object.freeze({
  pesticide: '农药', veterinary: '兽药', poison: '毒物', environmental: '环境污染物',
  biotoxin: '生物毒素', drug: '药物及代谢物', material: '化工材料', therapeutic: '治疗药物',
  food: '食品添加剂', natural: '天然产物', plasticizer: '塑化剂', antibiotic: '抗生素',
  pfas: '全氟化合物', illegal: '非法添加', emerging: '新型污染物', mycotoxin: '真菌毒素'
})

const PFAS_PATTERN = /(?:perfluoro|polyfluoro|fluorotelomer|\bpf(?:os|oa|hxs|bs|ds|da|doa|hps|hpa|hxda|na|nona|oda|pea|pesa|tes|teda|trda|uda|unda|eesa|osa)\b|mpf(?:os|oa|hxs)|\b\d{1,2}:\d(?:\/\d{1,2}:\d)?\s*(?:ft(?:oh|ca|uca|s|p)?|di\s*pap|pap)\b|8cl-pfos|全氟)/i
const MYCOTOXIN_PATTERN = /(?:aflatoxin|aflatoxicol|aflatrem|ochratoxin|patulin|fumonisin|zearalen|zearalan|nivalenol|deoxynivalenol|deepoxy[- ]?deoxynivalenol|\bdon(?:-|\b)|\bht-?2\b|\bt-?2(?:\s*toxin|-triol|-tetraol|\b)|neosolaniol|diacetoxyscirpenol|fusarenon|sterigmatocystin|citrinin|verrucarin|alternariol|tenuazonic)/i
const ANTIBIOTIC_PATTERN = /(?:\b[a-z]+floxacin\b|\b[a-z]*cillin\b|\bpenicillin\b|\bcef[a-z]+\b|\bceph[a-z]+\b|\b[a-z]+cycline\b|\bsulfa(?:diazine|dimethoxine|dimidine|furazole|isodimidine|lene|merazine|methazine|methizole|methoxazole|methoxypyridazine|monomethoxine|pyridine|quinoxaline|thiazole|doxin|chloropyridazine|benzamide|nitran)\b|amikacin|gentamicin|kanamycin|neomycin|streptomycin|tobramycin|apramycin|sisomicin|netilmicin|ribostamycin|hygromycin\s*b|spectinomycin|erythromycin|azithromycin|clarithromycin|roxithromycin|spiramycin|tilmicosin|tylosin|tulathromycin|gamithromycin|josamycin|oleandomycin|kitasamycin|leucomycin|virginiamycin|clindamycin|lincomycin|pirlimycin|chloramphenicol|thiamphenicol|florfenicol|metronidazole|tinidazole|ornidazole|ronidazole|dimetridazole|imipenem|meropenem|ertapenem|doripenem|vancomycin|teicoplanin|dalbavancin|oritavancin|linezolid|daptomycin|bacitracin|colistin|polymyxin|fosfomycin|tiamulin|valnemulin|pleuromutilin|nitrofurantoin|nitrofurazone|furazolidone|furaltadone)/i
const PESTICIDE_PATTERN = /(?:pesticide|insecticide|herbicide|fungicide|acaricide|nematicide|rodenticide|molluscicide|plant\s*growth\s*regulator|agrochemical|chlorpyrifos|atrazine|simazine|terbuthylazine|alachlor|metolachlor|glyphosate|glufosinate|paraquat|diquat|carbaryl|carbofuran|imidacloprid|acetamiprid|thiamethoxam|clothianidin|dinotefuran|fipronil|permethrin|cypermethrin|deltamethrin|bifenthrin|tebuconazole|propiconazole|hexaconazole|myclobutanil|azoxystrobin|boscalid|metalaxyl|dimethoate|malathion|parathion|diazinon|dichlorvos|triazophos|trichlorfon)/i
const VETERINARY_PATTERN = /(?:veterinary|animal\s*drug|anthelmintic|coccidiostat|coccidiocid|ivermectin|doramectin|eprinomectin|moxidectin|levamisole|albendazole|fenbendazole|oxfendazole|febantel|clenbuterol|ractopamine|zilpaterol|olaquindox)/i
const DRUG_PATTERN = /(?:pharmaceutical|therapeutic|medication|analgesic|anesthetic|antiviral|antiretroviral|antihypertensive|antidepressant|antipsychotic|anticonvulsant|opioid|barbitur|morphine|codeine|fentanyl|amphetamine|cocaine|ketamine|lidocaine|procaine|benzocaine|\b[a-z]+navir\b|\b[a-z]+vir\b|\b[a-z]+pril\b|\b[a-z]+sartan\b|\b[a-z]+olol\b|\b[a-z]+prazole\b|\b[a-z]+statin\b|\b[a-z]+zepam\b|\b[a-z]+oxetine\b|\b[a-z]+triptyline\b|\b[a-z]+caine\b)/i
const METABOLITE_PATTERN = /(?:metabolite|desmethyl|demethyl|n-desalkyl|o-desalkyl|glucuronide|sulfate\s+conjugate|acetylprocainamide|norcodeine|norcocaine|hydroxy\w+\s+metabolite)/i
const FOOD_PATTERN = /(?:food\s*additive|food\s*antioxidant|sweetener|preservative|flavou?r(?:ing)?|food\s*colo(?:u)?r|vitamin\s+[a-k]|ascorbic\s+acid|saccharin|aspartame|acesulfame|sucralose|benzoic\s+acid|sorbic\s+acid)/i
const NATURAL_PATTERN = /(?:natural\s*product|plant\s*metabolite|microbial\s*metabolite|phytochemical|flavonoid|anthocyan|terpenoid|alkaloid|catechin|quercetin|kaempferol|resveratrol|curcumin|vitamin\s+[a-k]|dopamine|serotonin|epinephrine|norepinephrine)/i
const PLASTICIZER_PATTERN = /(?:plasticizer|plasticiser|phthalate|adipate|sebacate|trimellitate|citrate\s+ester|bisphenol\s*[a-z]?)/i
const TOXIN_PATTERN = /(?:biotoxin|toxin|venom|poison|toxicant|saxitoxin|brevetoxin|ciguatoxin|tetrodotoxin|microcystin|anatoxin)/i
const ENVIRONMENT_PATTERN = /(?:environmental\s*(?:contaminant|pollutant)|emerging\s*contaminant|persistent\s*organic\s*pollutant|endocrine\s*disrupt|flame\s*retardant|polychlorinated\s*biphenyl|\bpcb[- ]?\d+|dioxin|dechlorane)/i
const MATERIAL_PATTERN = /(?:surfactant|detergent|polymer|monomer|industrial|solvent|dye|pigment|stabilizer|stabiliser|antioxidant|lubricant|corrosion\s*inhibitor|photoinitiator|benzotriazole|alkylbenzene|sulfonic\s*acid|phosphoric\s*acid.*ester|amine$)/i
const ILLEGAL_PATTERN = /(?:melamine|sudan\s*[ivx1-4]*|rhodamine\s*b|formaldehyde|sodium\s*formaldehyde\s*sulfoxylate|borax|boric\s*acid|clenbuterol|ractopamine|malachite\s*green|crystal\s*violet|leucomalachite|auramine\s*o|potassium\s*bromate|dimethyl\s*fumarate|dichlorvos|nitrofuran|furazolidone|furaltadone|nitrofurazone|nitrofurantoin|olaquindox|sodium\s*pentachlorophen|trichlorfon|acid\s*orange\s*ii|basic\s*yellow|methenamine|hexamethylenetetramine|sildenafil|tadalafil|vardenafil|sibutramine|phenolphthalein)/i

const normText = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')
const normFormula = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase()
const normCas = (value) => String(value ?? '').match(/\b\d{2,7}-\d{2}-\d\b/)?.[0] ?? ''
const connectivityKey = (value) => String(value ?? '').trim().toUpperCase().slice(0, 14)
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
const firstNumber = (value) => {
  const match = String(value ?? '').match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/)
  return match ? Number(match[0]) : null
}

function parseRecord(block, sourceFile, sourceRecord) {
  const lines = block.split(/\r?\n/)
  const fields = new Map()
  let peakStart = -1
  let peakCount = 0
  for (let index = 0; index < lines.length; index += 1) {
    const peakHeader = lines[index].match(/^Num\s+Peaks\s*:\s*(\d+)/i)
    if (peakHeader) {
      peakCount = Number(peakHeader[1])
      peakStart = index + 1
      break
    }
    const field = lines[index].match(/^([^:]+):\s*(.*)$/)
    if (field) {
      const key = field[1].trim().toLowerCase()
      fields.set(key, [...(fields.get(key) ?? []), field[2].trim()])
    }
  }
  const get = (name) => fields.get(name.toLowerCase())?.[0] ?? ''
  const getAll = (name) => fields.get(name.toLowerCase()) ?? []
  const peaks = []
  const numberPattern = /[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g
  for (let index = peakStart; index >= 0 && index < lines.length && peaks.length < peakCount; index += 1) {
    const values = lines[index].match(numberPattern)?.map(Number) ?? []
    for (let peakIndex = 0; peakIndex + 1 < values.length && peaks.length < peakCount; peakIndex += 2) {
      peaks.push({ mz: values[peakIndex], intensity: values[peakIndex + 1] })
    }
  }
  const casLine = get('cas#')
  const record = {
    sourceFile, sourceRecord, name: get('name'), synonyms: getAll('synon'), notes: get('notes'),
    precursorType: get('precursor_type'), spectrumType: get('spectrum_type').toUpperCase(),
    precursorMz: numberOrNull(get('precursormz')), instrumentType: get('instrument_type'),
    instrument: get('instrument'), sampleInlet: get('sample_inlet'), ionization: get('ionization'),
    collisionGas: get('collision_gas'), collisionEnergyText: get('collision_energy'),
    collisionEnergy: firstNumber(get('collision_energy')), ionMode: get('ion_mode').toUpperCase(),
    inchiKey: get('inchikey').toUpperCase(), formula: get('formula'),
    molecularMass: numberOrNull(get('mw')), exactMass: numberOrNull(get('exactmass')),
    cas: normCas(casLine), nistNumber: casLine.match(/NIST#:\s*(\d+)/i)?.[1] ?? '',
    dbNumber: get('db#'), comments: get('comments'), peaks
  }
  record.eligible = /^qqq(?:\/triplequadrupole)?$/i.test(record.instrumentType.replace(/\s+/g, '')) &&
    record.spectrumType === 'MS2' && ['P', 'N'].includes(record.ionMode) &&
    record.precursorMz !== null && record.peaks.length > 0
  return record
}

function parseMspec(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    .split(/(?:\r?\n){2,}(?=Name:)/).map((block) => block.trim()).filter(Boolean)
    .map((block, index) => parseRecord(block, basename(file), index + 1))
}

function safeAliases(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => typeof item === 'string' ? item : item?.name).filter(Boolean)
  } catch { return [] }
}

function buildExistingIndexes(compounds) {
  const activeIds = new Set(compounds.map((compound) => Number(compound.id)))
  const cas = new Set()
  const nameFormula = new Set()
  for (const compound of compounds) {
    for (const value of String(compound.cas ?? '').match(/\b\d{2,7}-\d{2}-\d\b/g) ?? []) cas.add(value)
    for (const name of [compound.main_name, ...safeAliases(compound.name)]) {
      const normalized = normText(name)
      if (normalized) nameFormula.add(`${normFormula(compound.formula)}|${normalized}`)
    }
  }
  const connectivity = new Set()
  const cacheFile = join(root, 'docs', 'enrichment-cache', 'pubchem-compounds.jsonl')
  if (existsSync(cacheFile)) {
    for (const line of readFileSync(cacheFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (!activeIds.has(Number(record.compoundId)) || record.status !== 'matched') continue
        const key = connectivityKey(record.property?.InChIKey)
        if (key) connectivity.add(key)
      } catch { /* Ignore a partial final cache line. */ }
    }
  }
  return { cas, nameFormula, connectivity }
}

function classify(records) {
  const text = records.flatMap((record) => [record.name, ...record.synonyms]).filter(Boolean).join(' | ')
  const classes = new Set()
  const reasons = []
  const add = (className, reason) => { classes.add(className); reasons.push({ className, reason }) }
  const antibiotic = ANTIBIOTIC_PATTERN.test(text)
  const pfas = PFAS_PATTERN.test(text)
  const mycotoxin = MYCOTOXIN_PATTERN.test(text)
  if (antibiotic) {
    add(CLASS.antibiotic, 'antibiotic name/family rule')
    add(CLASS.therapeutic, 'antibiotic therapeutic use')
    add(CLASS.drug, 'antibiotic drug identity')
    add(CLASS.emerging, 'project rule: antibiotics are emerging contaminants')
  }
  if (pfas) {
    add(CLASS.pfas, 'PFAS name rule')
    add(CLASS.environmental, 'PFAS environmental contaminant')
    add(CLASS.emerging, 'PFAS emerging contaminant')
  }
  if (mycotoxin) {
    add(CLASS.mycotoxin, 'mycotoxin name rule')
    add(CLASS.biotoxin, 'mycotoxin biological origin')
    add(CLASS.natural, 'mycotoxin natural origin')
  }
  if (PESTICIDE_PATTERN.test(text)) add(CLASS.pesticide, 'pesticide name/use rule')
  if (VETERINARY_PATTERN.test(text)) {
    add(CLASS.veterinary, 'veterinary drug rule')
    add(CLASS.therapeutic, 'veterinary therapeutic use')
    add(CLASS.drug, 'veterinary drug identity')
  }
  if (DRUG_PATTERN.test(text) && !antibiotic) {
    add(CLASS.therapeutic, 'drug/therapeutic name rule')
    add(CLASS.drug, 'drug identity rule')
  }
  if (METABOLITE_PATTERN.test(text)) add(CLASS.drug, 'drug/metabolite name rule')
  if (FOOD_PATTERN.test(text)) add(CLASS.food, 'food additive/nutrient rule')
  if (NATURAL_PATTERN.test(text)) add(CLASS.natural, 'natural product/metabolite rule')
  if (PLASTICIZER_PATTERN.test(text)) {
    add(CLASS.plasticizer, 'plasticizer name rule')
    add(CLASS.material, 'plasticizer material use')
  }
  if (TOXIN_PATTERN.test(text) && !mycotoxin) add(CLASS.poison, 'toxin/poison name rule')
  if (ENVIRONMENT_PATTERN.test(text)) add(CLASS.environmental, 'environmental contaminant rule')
  if (MATERIAL_PATTERN.test(text)) add(CLASS.material, 'industrial/material use rule')
  if (ILLEGAL_PATTERN.test(text)) add(CLASS.illegal, 'project illegal-addition name rule')
  const fallback = classes.size === 0
  if (fallback) add(CLASS.material, 'fallback: chemical substance pending finer project classification')
  return { classes: [...classes], reasons, confidence: fallback ? 'fallback' : 'rule-based' }
}

const representativeScore = (record) => Number(record.collisionEnergy !== null) * 1_000_000 +
  record.peaks.length * 1_000 + Number(/consensus/i.test(record.notes)) * 100 +
  Number(record.precursorType === '[M+H]+' || record.precursorType === '[M-H]-') * 10
const selectRepresentative = (records) => [...records].sort((left, right) =>
  representativeScore(right) - representativeScore(left) ||
  left.sourceFile.localeCompare(right.sourceFile) || left.sourceRecord - right.sourceRecord)[0]

function baseProductPeak(spectrum) {
  const products = spectrum.peaks.filter((peak) => Math.abs(peak.mz - spectrum.precursorMz) > 0.5)
  return (products.length ? products : spectrum.peaks).slice()
    .sort((left, right) => right.intensity - left.intensity || left.mz - right.mz)[0]
}

function identityFor(records, spectrum) {
  const cas = records.map((record) => record.cas).find(Boolean) ?? ''
  const source = records.find((record) => record.cas === cas && record.formula) ?? spectrum
  return {
    name: source.name || spectrum.name, cas, formula: source.formula || spectrum.formula,
    inchiKey: source.inchiKey || spectrum.inchiKey,
    molecularMass: source.molecularMass ?? spectrum.molecularMass,
    exactMass: source.exactMass ?? spectrum.exactMass
  }
}

function buildNames(identity, records) {
  const names = [identity.name, ...records.flatMap((record) => [record.name, ...record.synonyms])]
  const result = []
  const seen = new Set()
  for (const name of names) {
    const key = normText(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({ area: '北美', name })
  }
  return result
}

function encodeSpectrum(identity, spectrum, methodId, q3) {
  const payload = {
    schemaVersion: 'nist-ms2-v1',
    source: { name: 'NIST', library: 'lr_msms_nist', sourceFile: spectrum.sourceFile,
      sourceRecord: spectrum.sourceRecord, nistNumber: spectrum.nistNumber,
      dbNumber: spectrum.dbNumber },
    compound: { name: identity.name, synonyms: spectrum.synonyms, cas: identity.cas,
      formula: identity.formula, molecularMass: identity.molecularMass,
      exactMass: identity.exactMass, inchiKey: identity.inchiKey },
    acquisition: { precursorType: spectrum.precursorType, precursorMz: spectrum.precursorMz,
      spectrumType: spectrum.spectrumType, instrumentType: spectrum.instrumentType,
      instrument: spectrum.instrument, sampleInlet: spectrum.sampleInlet,
      ionization: spectrum.ionization, ionMode: spectrum.ionMode,
      collisionGas: spectrum.collisionGas, collisionEnergy: spectrum.collisionEnergy,
      collisionEnergyText: spectrum.collisionEnergyText, notes: spectrum.notes,
      comments: spectrum.comments },
    match: { type: 'imported', identityType: 'new-compound-nist-deduplicated', methodId,
      q1: spectrum.precursorMz, q3, q1ErrorDa: 0, q3ErrorDa: 0, matchedQ3: q3 },
    peaks: spectrum.peaks
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

function buildCandidates(eligible, indexes) {
  const groups = new Map()
  for (const spectrum of eligible) {
    const key = connectivityKey(spectrum.inchiKey) ||
      `${normFormula(spectrum.formula)}|${normText(spectrum.name)}`
    groups.set(key, [...(groups.get(key) ?? []), spectrum])
  }
  const excluded = []
  const candidates = []
  for (const [key, records] of groups) {
    const cases = [...new Set(records.map((record) => record.cas).filter(Boolean))]
    const duplicateCas = cases.find((value) => indexes.cas.has(value))
    if (duplicateCas) { excluded.push({ key, reason: 'existing-cas', value: duplicateCas }); continue }
    if (key.length === 14 && indexes.connectivity.has(key)) {
      excluded.push({ key, reason: 'existing-connectivity-inchikey', value: key }); continue
    }
    const duplicateName = records.flatMap((record) => [record.name, ...record.synonyms])
      .find((name) => records.some((record) =>
        indexes.nameFormula.has(`${normFormula(record.formula)}|${normText(name)}`)))
    if (duplicateName) { excluded.push({ key, reason: 'existing-name-formula', value: duplicateName }); continue }
    const spectrum = selectRepresentative(records)
    const identity = identityFor(records, spectrum)
    candidates.push({ key, records, spectrum, identity, classification: classify(records) })
  }
  return { groups, excluded, candidates }
}

async function main() {
  const envFile = join(root, '.env')
  if (!existsSync(envFile)) throw new Error('Database config was not found: ' + envFile)
  loadEnv({ path: envFile, quiet: true })
  const files = readdirSync(options.docsDir).filter((name) => /\.mspec$/i.test(name)).sort()
    .map((name) => join(options.docsDir, name))
  if (!files.length) throw new Error('No MSPEC files were found: ' + options.docsDir)
  const parsed = files.flatMap(parseMspec)
  const eligible = parsed.filter((record) => record.eligible)
  const db = await mysql.createConnection({ host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT), user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME,
    charset: 'utf8mb4' })
  const inserted = []
  try {
    const [compounds] = await db.query(
      'SELECT id, main_name, name, formula, cas FROM compounds WHERE COALESCE(is_delete, 0) = 0')
    const indexes = buildExistingIndexes(compounds)
    const { groups, excluded, candidates } = buildCandidates(eligible, indexes)
    const classNames = [...new Set(candidates.flatMap((candidate) => candidate.classification.classes))]
    const [classRows] = classNames.length
      ? await db.query('SELECT id, class_name FROM classes WHERE class_name IN (' +
        classNames.map(() => '?').join(',') + ')', classNames)
      : [[]]
    const classIds = new Map(classRows.map((row) => [String(row.class_name), Number(row.id)]))
    const missingClasses = classNames.filter((className) => !classIds.has(className))
    if (missingClasses.length) throw new Error('Project classes were not found: ' + missingClasses.join(', '))

    if (options.apply && candidates.length) {
      await db.beginTransaction()
      try {
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]
          const { identity, spectrum, classification } = candidate
          const q3 = baseProductPeak(spectrum)?.mz ?? null
          const [compoundResult] = await db.execute(
            'INSERT INTO compounds (main_name, name, formula, cas, molecular_mass, ' +
            'monoisotopic_mass, formula_diagram_base64, is_favorite, is_in_trash, is_delete, ' +
            'create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, NOW(), NOW())',
            [identity.name, JSON.stringify(buildNames(identity, candidate.records)), identity.formula,
              identity.cas || null, identity.molecularMass, identity.exactMass])
          const compoundId = Number(compoundResult.insertId)
          for (const className of classification.classes) {
            await db.execute('INSERT INTO compound_class ' +
              '(compound_id, class_id, create_time, update_time) VALUES (?, ?, NOW(), NOW())',
            [compoundId, classIds.get(className)])
          }
          const [methodResult] = await db.execute(
            'INSERT INTO ms_methods (compounds_id, ms_mode, q1, q3, ce, polarity, ion_source, ' +
            'scan_mode, create_time, update_time, mass_spectrum_base64) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL)',
            [compoundId, 'MS8000', spectrum.precursorMz, q3, spectrum.collisionEnergy,
              spectrum.ionMode === 'P' ? 1 : 0, spectrum.ionization || null, 'MS2'])
          const methodId = Number(methodResult.insertId)
          await db.execute('UPDATE ms_methods SET mass_spectrum_base64 = ? WHERE id = ?',
            [encodeSpectrum(identity, spectrum, methodId, q3), methodId])
          inserted.push({ compoundId, methodId, identityKey: candidate.key, name: identity.name,
            cas: identity.cas, formula: identity.formula, classes: classification.classes,
            classificationConfidence: classification.confidence, msMode: 'MS8000',
            spectrumLabel: null, q1: spectrum.precursorMz, q3,
            collisionEnergy: spectrum.collisionEnergy, peakCount: spectrum.peaks.length,
            sourceFile: spectrum.sourceFile, sourceRecord: spectrum.sourceRecord })
          if ((index + 1) % 100 === 0 || index + 1 === candidates.length) {
            console.log(`Database import: ${index + 1}/${candidates.length}`)
          }
        }
        await db.commit()
      } catch (error) {
        await db.rollback()
        throw error
      }
    }

    const report = {
      summary: {
        mode: options.apply ? 'apply' : 'dry-run', generatedAt: new Date().toISOString(),
        sourceLibrary: 'NIST lr_msms_nist', parsedSpectra: parsed.length,
        eligibleQqQMs2Spectra: eligible.length, uniqueNistCompounds: groups.size,
        activeLocalCompoundsBefore: compounds.length, excludedExistingCompounds: excluded.length,
        candidateCompounds: candidates.length,
        candidateWithCas: candidates.filter((candidate) => Boolean(candidate.identity.cas)).length,
        candidateWithoutCas: candidates.filter((candidate) => !candidate.identity.cas).length,
        candidateWithCollisionEnergy: candidates.filter((candidate) =>
          candidate.spectrum.collisionEnergy !== null).length,
        candidateWithoutCollisionEnergy: candidates.filter((candidate) =>
          candidate.spectrum.collisionEnergy === null).length,
        fallbackClassifications: candidates.filter((candidate) =>
          candidate.classification.confidence === 'fallback').length,
        insertedCompounds: inserted.length, insertedMethods: inserted.length,
        insertedSpectra: inserted.length, methodMode: 'MS8000', spectrumLabel: 'none',
        deduplicationRules: ['active local CAS exact match',
          'active local PubChem connectivity InChIKey match',
          'active local normalized name + formula match',
          'NIST candidates grouped by connectivity InChIKey'],
        eligibilityRules: ['NIST Instrument_type = QqQ', 'NIST Spectrum_type = MS2',
          'ion mode is P or N', 'precursor m/z is present', 'peak list is non-empty'],
        sourceFiles: files.map((file) => ({ name: basename(file),
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }))
      },
      candidates: candidates.map((candidate) => ({ identityKey: candidate.key,
        name: candidate.identity.name, cas: candidate.identity.cas, formula: candidate.identity.formula,
        inchiKey: candidate.identity.inchiKey, sourceSpectrumCount: candidate.records.length,
        classes: candidate.classification.classes,
        classificationConfidence: candidate.classification.confidence,
        classificationReasons: candidate.classification.reasons,
        method: { msMode: 'MS8000', q1: candidate.spectrum.precursorMz,
          q3: baseProductPeak(candidate.spectrum)?.mz ?? null,
          collisionEnergy: candidate.spectrum.collisionEnergy,
          polarity: candidate.spectrum.ionMode, spectrumLabel: null,
          peakCount: candidate.spectrum.peaks.length,
          originalInstrument: candidate.spectrum.instrument,
          sourceFile: candidate.spectrum.sourceFile,
          sourceRecord: candidate.spectrum.sourceRecord } })),
      excluded, inserted
    }
    mkdirSync(dirname(options.reportFile), { recursive: true })
    writeFileSync(options.reportFile, JSON.stringify(report, null, 2), 'utf8')
    console.log(JSON.stringify({ ...report.summary, reportFile: options.reportFile,
      insertedIdRange: inserted.length ? [inserted[0].compoundId, inserted.at(-1).compoundId] : [] }, null, 2))
  } finally { await db.end() }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
