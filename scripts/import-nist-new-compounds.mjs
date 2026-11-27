import './legacy-disabled.mjs'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import process from 'process'
import { config as loadEnv } from 'dotenv'
import mysql from 'mysql2/promise'
import * as OCL from 'openchemlib'

const root = resolve(process.cwd())
const options = {
  apply: process.argv.includes('--apply'),
  docsDir: join(root, 'docs'),
  reportFile: join(root, 'docs', 'nist-new-compound-import-report.json')
}
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--docs') options.docsDir = resolve(process.argv[++i])
  if (process.argv[i] === '--report') options.reportFile = resolve(process.argv[++i])
}

// Reviewed first batch. PubChem supplies identity/structure; NIST supplies QqQ MS2 data.
const MANIFEST = [
  {
    cas: '62-67-9', name: 'Nalorphine', pubchemCid: 5284595,
    formula: 'C19H21NO3', inchiKey: 'UIQMVEYFGZJHCZ-UTMVYBGDSA-N',
    smiles: 'C=CCN1CC[C@]23[C@@H]4[C@H]1CC5=C2C(=C(C=C5)O)O[C@H]3[C@H](C=C4)O',
    aliases: ['N-Allylnormorphine'], classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies nalorphine as an opioid antagonist drug.'
  },
  {
    cas: '77-26-9', name: 'Butalbital', pubchemCid: 2481,
    formula: 'C11H16N2O3', inchiKey: 'UZVHFVZFNXBMQJ-UHFFFAOYSA-N',
    smiles: 'CC(C)CC1(C(=O)NC(=O)NC1=O)CC=C', aliases: ['Allylbarbital'],
    classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies butalbital as a barbiturate drug.'
  },
  {
    cas: '139110-80-8', name: 'Zanamivir', pubchemCid: 60855,
    formula: 'C12H20N4O7', inchiKey: 'ARAIBEBZBOPLMB-TZMJUOFKSA-N',
    smiles: 'CC(=O)N[C@@H]1[C@H](C=C(O[C@H]1[C@@H]([C@@H](CO)O)O)C(=O)O)N=C(N)N',
    aliases: ['Relenza'], classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies zanamivir as an antiviral drug.'
  },
  {
    cas: '65052-63-3', name: 'Cefetamet', pubchemCid: 5487888,
    formula: 'C14H15N5O5S2', inchiKey: 'MQLRYUCJDNBWMV-GHXIOONMSA-N',
    smiles: 'CC1=C(N2[C@@H]([C@@H](C2=O)NC(=O)/C(=N\\OC)/C3=CSC(=N3)N)SC1)C(=O)O',
    aliases: ['Cefetamet free acid'],
    classes: ['抗生素', '治疗药物', '药物及代谢物', '新型污染物'],
    rationale: 'PubChem classifies cefetamet as a cephalosporin antibiotic; project rules also classify antibiotics as emerging contaminants.'
  },
  {
    cas: '555-30-6', name: 'Methyldopa', pubchemCid: 38853,
    formula: 'C10H13NO4', inchiKey: 'CJCSPKMFHVPWAR-UHFFFAOYSA-N',
    smiles: 'C[C@](CC1=CC(=C(C=C1)O)O)(C(=O)O)N', aliases: ['Alpha-Methyldopa'],
    classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies methyldopa as an antihypertensive drug.'
  },
  {
    cas: '103577-45-3', name: 'Lansoprazole', pubchemCid: 3883,
    formula: 'C16H14F3N3O2S', inchiKey: 'MJIHNNLFOKEZEW-UHFFFAOYSA-N',
    smiles: 'CC1=C(C=CN=C1CS(=O)C2=NC3=CC=CC=C3N2)OCC(F)(F)F', aliases: ['Prevacid'],
    classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies lansoprazole as a proton-pump inhibitor drug.'
  },
  {
    cas: '73590-58-6', name: 'Omeprazole', pubchemCid: 4594,
    formula: 'C17H19N3O3S', inchiKey: 'SUBDBMMJDZJVOS-UHFFFAOYSA-N',
    smiles: 'CC1=CN=C(C(=C1OC)C)CS(=O)C2=NC3=C(N2)C=C(C=C3)OC', aliases: ['Prilosec', 'Losec'],
    classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies omeprazole as a proton-pump inhibitor drug.'
  },
  {
    cas: '50-81-7', name: 'Vitamin C', pubchemCid: 54670067,
    formula: 'C6H8O6', inchiKey: 'CIWBSHSKHKDKBQ-JLAZNSOCSA-N',
    smiles: 'C([C@@H]([C@@H]1C(=C(C(=O)O1)O)O)O)O',
    aliases: ['L-Ascorbic acid', 'Ascorbic acid', 'E 300'],
    classes: ['食品添加剂', '天然产物', '治疗药物'],
    rationale: 'PubChem identifies L-ascorbic acid as vitamin C, a natural plant metabolite, food additive and therapeutic nutrient.'
  },
  {
    cas: '52-43-7', name: 'Allobarbital', pubchemCid: 5842,
    formula: 'C10H12N2O3', inchiKey: 'FDQGNLOWMMVRQL-UHFFFAOYSA-N',
    smiles: 'C=CCC1(C(=O)NC(=O)NC1=O)CC=C', aliases: ['Allobarbitone', 'Diallylbarbital'],
    classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies allobarbital as a sedative barbiturate.'
  },
  {
    cas: '56-29-1', name: 'Hexobarbital', pubchemCid: 3608,
    formula: 'C12H16N2O3', inchiKey: 'UYXAWHWODHRRMR-UHFFFAOYSA-N',
    smiles: 'CC1(C(=O)NC(=O)N(C1=O)C)C2=CCCCC2', aliases: ['Hexobarbitone', 'Evipan'],
    classes: ['治疗药物', '药物及代谢物'],
    rationale: 'PubChem identifies hexobarbital as a hypnotic and sedative barbiturate.'
  }
]

const normText = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')
const normCas = (value) => String(value ?? '').match(/\b\d{2,7}-\d{2}-\d\b/)?.[0] ?? ''
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}
const firstNumber = (value) => {
  const match = String(value ?? '').match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/)
  return match ? Number(match[0]) : null
}
const connectivityKey = (value) => String(value ?? '').trim().toUpperCase().slice(0, 14)

function formulaCounts(value) {
  const counts = new Map()
  for (const match of String(value ?? '').matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2] || 1))
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
}
const sameFormula = (left, right) =>
  JSON.stringify(formulaCounts(left)) === JSON.stringify(formulaCounts(right))

function parseRecord(block, sourceFile, sourceRecord) {
  const lines = block.split(/\r?\n/)
  const fields = new Map()
  let peakStart = -1
  let peakCount = 0
  for (let i = 0; i < lines.length; i += 1) {
    const peakHeader = lines[i].match(/^Num\s+Peaks\s*:\s*(\d+)/i)
    if (peakHeader) {
      peakCount = Number(peakHeader[1])
      peakStart = i + 1
      break
    }
    const field = lines[i].match(/^([^:]+):\s*(.*)$/)
    if (field) {
      const key = field[1].trim().toLowerCase()
      fields.set(key, [...(fields.get(key) ?? []), field[2].trim()])
    }
  }
  const get = (name) => fields.get(name.toLowerCase())?.[0] ?? ''
  const getAll = (name) => fields.get(name.toLowerCase()) ?? []
  const peaks = []
  const numberPattern = /[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g
  for (let i = peakStart; i >= 0 && i < lines.length && peaks.length < peakCount; i += 1) {
    const values = lines[i].match(numberPattern)?.map(Number) ?? []
    for (let p = 0; p + 1 < values.length && peaks.length < peakCount; p += 2) {
      peaks.push({ mz: values[p], intensity: values[p + 1] })
    }
  }
  const casLine = get('cas#')
  const record = {
    sourceFile, sourceRecord, name: get('name'), synonyms: getAll('synon'),
    notes: get('notes'), precursorType: get('precursor_type'),
    spectrumType: get('spectrum_type').toUpperCase(),
    precursorMz: numberOrNull(get('precursormz')),
    instrumentType: get('instrument_type'), instrument: get('instrument'),
    sampleInlet: get('sample_inlet'), ionization: get('ionization'),
    collisionGas: get('collision_gas'), collisionEnergyText: get('collision_energy'),
    collisionEnergy: firstNumber(get('collision_energy')), ionMode: get('ion_mode').toUpperCase(),
    inchiKey: get('inchikey').toUpperCase(), formula: get('formula'),
    molecularMass: numberOrNull(get('mw')), exactMass: numberOrNull(get('exactmass')),
    cas: normCas(casLine), nistNumber: casLine.match(/NIST#:\s*(\d+)/i)?.[1] ?? '',
    dbNumber: get('db#'), comments: get('comments'), peaks
  }
  record.eligible = /^qqq(?:\/triplequadrupole)?$/i.test(record.instrumentType.replace(/\s+/g, '')) &&
    record.spectrumType === 'MS2' && ['P', 'N'].includes(record.ionMode) &&
    record.precursorMz !== null && record.collisionEnergy !== null && record.peaks.length > 0
  return record
}

function parseMspec(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    .split(/(?:\r?\n){2,}(?=Name:)/).map((block) => block.trim()).filter(Boolean)
    .map((block, index) => parseRecord(block, basename(file), index + 1))
}

function createStructure(item) {
  const molecule = OCL.Molecule.fromSmiles(item.smiles)
  const calculatedFormula = molecule.getMolecularFormula().formula
  if (!sameFormula(calculatedFormula, item.formula)) {
    throw new Error(`PubChem structure formula mismatch for ${item.name}: ${calculatedFormula}`)
  }
  molecule.inventCoordinates()
  return molecule.toSVG(300, 300, '', { autoCrop: true })
}

const score = (record) => record.peaks.length * 1_000 +
  Number(/consensus/i.test(record.notes)) * 100 +
  Number(record.precursorType === '[M+H]+' || record.precursorType === '[M-H]-') * 10 + 1
const selectRepresentative = (records) => [...records].sort((left, right) =>
  score(right) - score(left) || left.sourceFile.localeCompare(right.sourceFile) ||
  left.sourceRecord - right.sourceRecord)[0]

function baseProductPeak(spectrum) {
  const products = spectrum.peaks.filter((peak) => Math.abs(peak.mz - spectrum.precursorMz) > 0.5)
  return (products.length ? products : spectrum.peaks).slice()
    .sort((left, right) => right.intensity - left.intensity || left.mz - right.mz)[0]
}

function buildNames(item, spectrum) {
  const result = []
  const seen = new Set()
  for (const value of [item.name, ...item.aliases, spectrum.name, ...spectrum.synonyms]) {
    const key = normText(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({ area: '北美', name: value })
  }
  return result
}

function encodeSpectrum(item, spectrum, methodId, q3) {
  const payload = {
    schemaVersion: 'nist-ms2-v1',
    source: { name: 'NIST', library: 'lr_msms_nist', sourceFile: spectrum.sourceFile,
      sourceRecord: spectrum.sourceRecord, nistNumber: spectrum.nistNumber,
      dbNumber: spectrum.dbNumber },
    compound: { name: item.name, synonyms: [...item.aliases, ...spectrum.synonyms],
      cas: item.cas, formula: item.formula, molecularMass: spectrum.molecularMass,
      exactMass: spectrum.exactMass, inchiKey: item.inchiKey, pubchemCid: item.pubchemCid,
      pubchemUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${item.pubchemCid}` },
    acquisition: { precursorType: spectrum.precursorType, precursorMz: spectrum.precursorMz,
      spectrumType: spectrum.spectrumType, instrumentType: spectrum.instrumentType,
      instrument: spectrum.instrument, sampleInlet: spectrum.sampleInlet,
      ionization: spectrum.ionization, ionMode: spectrum.ionMode,
      collisionGas: spectrum.collisionGas, collisionEnergy: spectrum.collisionEnergy,
      collisionEnergyText: spectrum.collisionEnergyText, notes: spectrum.notes,
      comments: spectrum.comments },
    match: { type: 'imported', identityType: 'new-compound-cas+inchikey', methodId,
      q1: spectrum.precursorMz, q3, q1ErrorDa: 0, q3ErrorDa: 0, matchedQ3: q3 },
    peaks: spectrum.peaks
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

function loadCachedConnectivityKeys() {
  const file = join(root, 'docs', 'enrichment-cache', 'pubchem-compounds.jsonl')
  const keys = new Map()
  if (!existsSync(file)) return keys
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      const key = connectivityKey(record.property?.InChIKey)
      if (key && record.status === 'matched') {
        keys.set(key, { compoundId: Number(record.compoundId), title: record.property?.Title ?? '' })
      }
    } catch { /* Ignore a partial final cache line. */ }
  }
  return keys
}

function reportCandidate(item, spectrum, status, reason = '') {
  const q3 = spectrum ? baseProductPeak(spectrum)?.mz ?? null : null
  return {
    status, reason, name: item.name, cas: item.cas, formula: item.formula,
    inchiKey: item.inchiKey, pubchemCid: item.pubchemCid,
    pubchemUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${item.pubchemCid}`,
    classes: item.classes, classificationRationale: item.rationale,
    method: { msMode: 'MS8000', spectrumLabel: null },
    nist: spectrum ? { sourceFile: spectrum.sourceFile, sourceRecord: spectrum.sourceRecord,
      nistNumber: spectrum.nistNumber, instrumentType: spectrum.instrumentType,
      instrument: spectrum.instrument, spectrumType: spectrum.spectrumType,
      ionMode: spectrum.ionMode, precursorType: spectrum.precursorType,
      q1: spectrum.precursorMz, q3, collisionEnergy: spectrum.collisionEnergy,
      collisionEnergyText: spectrum.collisionEnergyText, peakCount: spectrum.peaks.length } : null,
    structure: { source: 'PubChem SMILES rendered locally with OpenChemLib', smiles: item.smiles }
  }
}

async function main() {
  const envFile = join(root, '.env')
  if (!existsSync(envFile)) throw new Error('Database config was not found: ' + envFile)
  loadEnv({ path: envFile, quiet: true })
  const files = readdirSync(options.docsDir).filter((name) => /\.mspec$/i.test(name)).sort()
    .map((name) => join(options.docsDir, name))
  if (!files.length) throw new Error('No MSPEC files were found: ' + options.docsDir)
  const spectra = files.flatMap(parseMspec)
  const eligible = spectra.filter((spectrum) => spectrum.eligible)
  const eligibleByCas = new Map()
  for (const spectrum of eligible) {
    eligibleByCas.set(spectrum.cas, [...(eligibleByCas.get(spectrum.cas) ?? []), spectrum])
  }
  const db = await mysql.createConnection({ host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT), user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD, database: process.env.DATABASE_NAME,
    charset: 'utf8mb4' })
  const candidates = []
  const skipped = []
  const inserted = []
  try {
    const [activeCompounds] = await db.query(
      'SELECT id, main_name, name, cas, formula FROM compounds WHERE COALESCE(is_delete, 0) = 0')
    const classNames = [...new Set(MANIFEST.flatMap((item) => item.classes))]
    const [classRows] = await db.query('SELECT id, class_name FROM classes WHERE class_name IN (' +
      classNames.map(() => '?').join(',') + ')', classNames)
    const classesByName = new Map(classRows.map((row) => [row.class_name, Number(row.id)]))
    const missingClasses = classNames.filter((name) => !classesByName.has(name))
    if (missingClasses.length) throw new Error('Project classes were not found: ' + missingClasses.join(', '))

    const existingCas = new Map()
    const existingNames = new Map()
    for (const compound of activeCompounds) {
      for (const cas of String(compound.cas ?? '').match(/\b\d{2,7}-\d{2}-\d\b/g) ?? []) {
        existingCas.set(cas, { id: Number(compound.id), name: compound.main_name })
      }
      const names = [compound.main_name]
      try {
        const aliases = typeof compound.name === 'string' ? JSON.parse(compound.name) : compound.name
        if (Array.isArray(aliases)) {
          for (const alias of aliases) names.push(typeof alias === 'string' ? alias : alias?.name)
        }
      } catch { /* Legacy invalid aliases do not block CAS/InChIKey checks. */ }
      for (const name of names) {
        const key = normText(name)
        if (key) existingNames.set(key, { id: Number(compound.id), name: compound.main_name })
      }
    }
    const cachedConnectivity = loadCachedConnectivityKeys()

    for (const item of MANIFEST) {
      const records = (eligibleByCas.get(item.cas) ?? []).filter((record) =>
        sameFormula(record.formula, item.formula) &&
        connectivityKey(record.inchiKey) === connectivityKey(item.inchiKey))
      const spectrum = selectRepresentative(records)
      if (!spectrum) {
        skipped.push(reportCandidate(item, null, 'SKIPPED', 'No matching QqQ + MS2 NIST spectrum'))
        continue
      }
      const casDuplicate = existingCas.get(item.cas)
      const structureDuplicate = cachedConnectivity.get(connectivityKey(item.inchiKey))
      const nameDuplicate = existingNames.get(normText(item.name))
      if (casDuplicate || structureDuplicate || nameDuplicate) {
        const duplicate = casDuplicate ?? structureDuplicate ?? nameDuplicate
        const type = casDuplicate ? 'CAS' : structureDuplicate ? 'connectivity InChIKey' : 'name'
        skipped.push(reportCandidate(item, spectrum, 'SKIPPED',
          `${type} already exists as compound ${duplicate.id ?? duplicate.compoundId} (${duplicate.name ?? duplicate.title})`))
        continue
      }
      const structureSvg = createStructure(item)
      candidates.push({ item, spectrum, structureSvg, report: reportCandidate(item, spectrum, 'READY') })
    }

    if (options.apply && candidates.length) {
      await db.beginTransaction()
      try {
        for (const candidate of candidates) {
          const { item, spectrum, structureSvg } = candidate
          const q3 = baseProductPeak(spectrum)?.mz ?? null
          const [compoundResult] = await db.execute(
            'INSERT INTO compounds (main_name, name, formula, cas, molecular_mass, ' +
            'monoisotopic_mass, formula_diagram_base64, is_favorite, is_in_trash, is_delete, ' +
            'create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NOW(), NOW())',
            [item.name, JSON.stringify(buildNames(item, spectrum)), item.formula, item.cas,
              spectrum.molecularMass, spectrum.exactMass, structureSvg])
          const compoundId = Number(compoundResult.insertId)
          for (const className of item.classes) {
            await db.execute('INSERT INTO compound_class ' +
              '(compound_id, class_id, create_time, update_time) VALUES (?, ?, NOW(), NOW())',
            [compoundId, classesByName.get(className)])
          }
          const [methodResult] = await db.execute(
            'INSERT INTO ms_methods (compounds_id, ms_mode, q1, q3, ce, polarity, ion_source, ' +
            'scan_mode, create_time, update_time, mass_spectrum_base64) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL)',
            [compoundId, 'MS8000', spectrum.precursorMz, q3, spectrum.collisionEnergy,
              spectrum.ionMode === 'P' ? 1 : 0, spectrum.ionization || null, 'MS2'])
          const methodId = Number(methodResult.insertId)
          await db.execute('UPDATE ms_methods SET mass_spectrum_base64 = ?, update_time = NOW() WHERE id = ?',
            [encodeSpectrum(item, spectrum, methodId, q3), methodId])
          inserted.push({ compoundId, methodId, name: item.name, cas: item.cas,
            msMode: 'MS8000', spectrumLabel: null,
            classes: item.classes, q1: spectrum.precursorMz, q3,
            collisionEnergy: spectrum.collisionEnergy, peakCount: spectrum.peaks.length })
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
        sourceLibrary: 'NIST lr_msms_nist', parsedSpectra: spectra.length,
        eligibleQqQMs2WithCollisionEnergy: eligible.length,
        reviewedManifestCompounds: MANIFEST.length, readyCompounds: candidates.length,
        skippedCompounds: skipped.length, insertedCompounds: inserted.length,
        insertedMethods: inserted.length, insertedSpectra: inserted.length,
        classificationComplete: candidates.every((candidate) => candidate.item.classes.length > 0),
        structureComplete: candidates.every((candidate) => Boolean(candidate.structureSvg)),
        sourceFiles: files.map((file) => ({ name: basename(file),
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })),
        identityRules: ['NIST Instrument_type = QqQ', 'NIST Spectrum_type = MS2',
          'CAS exact match to reviewed manifest', 'NIST and PubChem formula agreement',
          'NIST and PubChem connectivity InChIKey agreement',
          'No active local CAS, exact normalized name, or cached connectivity InChIKey duplicate',
          'Collision energy and non-empty peak list required',
          'At least one explicit project classification required'],
        compoundDetailSource: 'PubChem', spectrumSource: 'NIST lr_msms_nist',
        methodMode: 'MS8000', spectrumLabel: 'none', structureRenderer: 'OpenChemLib'
      },
      ready: candidates.map((candidate) => candidate.report), skipped, inserted
    }
    mkdirSync(dirname(options.reportFile), { recursive: true })
    writeFileSync(options.reportFile, JSON.stringify(report, null, 2), 'utf8')
    console.log(JSON.stringify({ ...report.summary, reportFile: options.reportFile, inserted }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
