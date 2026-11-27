import './legacy-disabled.mjs'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import process from 'process'
import { config as loadEnv } from 'dotenv'
import mysql from 'mysql2/promise'

const root = resolve(process.cwd())
const backupDir = join(root, 'backups')
const options = {
  apply: process.argv.includes('--apply'),
  docsDir: join(root, 'docs'),
  q1Tolerance: 0.5,
  q3Tolerance: 0.5
}

for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--docs') options.docsDir = resolve(process.argv[++i])
  if (process.argv[i] === '--q1-tolerance') options.q1Tolerance = Number(process.argv[++i])
  if (process.argv[i] === '--q3-tolerance') options.q3Tolerance = Number(process.argv[++i])
}

const normText = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
const normFormula = (value) =>
  String(value ?? '')
    .replace(/\s+/g, '')
    .toUpperCase()
const normCas = (value) => String(value ?? '').match(/\b\d{2,7}-\d{2}-\d\b/)?.[0] ?? ''
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}
const firstNumber = (value) => {
  const result = String(value ?? '').match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/)
  return result ? Number(result[0]) : null
}
const timestamp = () =>
  new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')

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
    sourceFile,
    sourceRecord,
    name: get('name'),
    synonyms: getAll('synon'),
    notes: get('notes'),
    precursorType: get('precursor_type'),
    spectrumType: get('spectrum_type').toUpperCase(),
    precursorMz: numberOrNull(get('precursormz')),
    instrumentType: get('instrument_type'),
    instrument: get('instrument'),
    sampleInlet: get('sample_inlet'),
    ionization: get('ionization'),
    collisionGas: get('collision_gas'),
    collisionEnergyText: get('collision_energy'),
    collisionEnergy: firstNumber(get('collision_energy')),
    ionMode: get('ion_mode').toUpperCase(),
    inchiKey: get('inchikey'),
    formula: get('formula'),
    molecularMass: numberOrNull(get('mw')),
    exactMass: numberOrNull(get('exactmass')),
    cas: normCas(casLine),
    nistNumber: casLine.match(/NIST#:\s*(\d+)/i)?.[1] ?? '',
    dbNumber: get('db#'),
    comments: get('comments'),
    peaks
  }

  record.names = [record.name, ...record.synonyms].map(normText).filter(Boolean)
  record.eligible =
    /^qqq(?:\/triplequadrupole)?$/i.test(record.instrumentType.replace(/\s+/g, '')) &&
    record.spectrumType === 'MS2' &&
    ['P', 'N'].includes(record.ionMode) &&
    record.precursorMz !== null &&
    record.peaks.length > 0
  return record
}

function parseMspec(file) {
  return readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/(?:\r?\n){2,}(?=Name:)/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => parseRecord(block, basename(file), index + 1))
}

function safeJson(value, fallback = []) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function localNames(compound) {
  const names = new Set([normText(compound.main_name)])
  for (const value of safeJson(compound.name)) {
    names.add(normText(typeof value === 'string' ? value : value?.name))
  }
  names.delete('')
  return names
}

function buildIndexes(spectra) {
  const byCas = new Map()
  const byNameFormula = new Map()
  for (const spectrum of spectra.filter((item) => item.eligible)) {
    if (spectrum.cas) byCas.set(spectrum.cas, [...(byCas.get(spectrum.cas) ?? []), spectrum])
    for (const name of spectrum.names) {
      const key = normFormula(spectrum.formula) + '|' + name
      byNameFormula.set(key, [...(byNameFormula.get(key) ?? []), spectrum])
    }
  }
  return { byCas, byNameFormula }
}

function identityCandidates(compound, indexes) {
  const cas = normCas(compound.cas)
  if (cas && indexes.byCas.has(cas)) return { type: 'cas', spectra: indexes.byCas.get(cas) }
  const formula = normFormula(compound.formula)
  if (!formula) return { type: '', spectra: [] }
  const found = new Set()
  for (const name of localNames(compound)) {
    for (const item of indexes.byNameFormula.get(formula + '|' + name) ?? []) found.add(item)
  }
  return { type: found.size ? 'name+formula' : '', spectra: [...found] }
}

const polarity = (method) =>
  Number(method.polarity) === 1 ? 'P' : Number(method.polarity) === 0 ? 'N' : ''

function closestPeak(spectrum, target) {
  return spectrum.peaks.reduce((best, peak) => {
    const error = Math.abs(peak.mz - target)
    if (
      !best ||
      error < best.error ||
      (error === best.error && peak.intensity > best.peak.intensity)
    ) {
      return { peak, error }
    }
    return best
  }, null)
}

function strictMatch(method, spectra) {
  const q1 = numberOrNull(method.q1)
  const q3 = numberOrNull(method.q3)
  const mode = polarity(method)
  if (q1 === null || q3 === null || !mode) return null

  const candidates = []
  for (const spectrum of spectra) {
    if (spectrum.ionMode !== mode) continue
    const q1Error = Math.abs(spectrum.precursorMz - q1)
    if (q1Error > options.q1Tolerance) continue
    const product = closestPeak(spectrum, q3)
    if (!product || product.error > options.q3Tolerance) continue
    const ce = numberOrNull(method.ce)
    candidates.push({
      spectrum,
      q1Error,
      q3Error: product.error,
      matchedQ3: product.peak.mz,
      q3Intensity: product.peak.intensity,
      ceError:
        ce !== null && spectrum.collisionEnergy !== null
          ? Math.abs(ce - spectrum.collisionEnergy)
          : Number.MAX_SAFE_INTEGER
    })
  }

  candidates.sort(
    (a, b) =>
      a.q1Error - b.q1Error ||
      a.q3Error - b.q3Error ||
      a.ceError - b.ceError ||
      b.q3Intensity - a.q3Intensity ||
      Number(/consensus/i.test(b.spectrum.notes)) - Number(/consensus/i.test(a.spectrum.notes))
  )
  return candidates[0] ?? null
}

function representativeMatch(methods, spectra) {
  const candidates = []
  for (const method of methods) {
    for (const spectrum of spectra) {
      const mode = polarity(method)
      const q1 = numberOrNull(method.q1)
      const ce = numberOrNull(method.ce)
      candidates.push({
        method,
        spectrum,
        polarityPenalty: mode && mode !== spectrum.ionMode ? 1 : 0,
        q1Error: q1 !== null ? Math.abs(q1 - spectrum.precursorMz) : Number.MAX_SAFE_INTEGER,
        ceError:
          ce !== null && spectrum.collisionEnergy !== null
            ? Math.abs(ce - spectrum.collisionEnergy)
            : Number.MAX_SAFE_INTEGER,
        consensusPenalty: /consensus/i.test(spectrum.notes) ? 0 : 1
      })
    }
  }
  candidates.sort(
    (a, b) =>
      a.polarityPenalty - b.polarityPenalty ||
      a.q1Error - b.q1Error ||
      a.ceError - b.ceError ||
      a.consensusPenalty - b.consensusPenalty ||
      b.spectrum.peaks.length - a.spectrum.peaks.length
  )
  return candidates[0] ?? null
}
function buildRepresentativeMethod(spectrum) {
  const productPeaks = spectrum.peaks.filter(
    (peak) => Math.abs(peak.mz - spectrum.precursorMz) > options.q3Tolerance
  )
  const basePeak = (productPeaks.length ? productPeaks : spectrum.peaks)
    .slice()
    .sort((a, b) => b.intensity - a.intensity)[0]
  return {
    id: null,
    ms_mode: ('NIST ' + (spectrum.instrument || 'QqQ')).slice(0, 255),
    q1: spectrum.precursorMz,
    q3: basePeak?.mz ?? null,
    ce: spectrum.collisionEnergy,
    polarity: spectrum.ionMode === 'P' ? 1 : 0,
    ion_source: spectrum.ionization || null,
    scan_mode: 'MS2'
  }
}

function encodeSpectrum(spectrum, method, match) {
  const payload = {
    schemaVersion: 'nist-ms2-v1',
    source: {
      name: 'NIST',
      library: 'lr_msms_nist',
      sourceFile: spectrum.sourceFile,
      sourceRecord: spectrum.sourceRecord,
      nistNumber: spectrum.nistNumber,
      dbNumber: spectrum.dbNumber
    },
    compound: {
      name: spectrum.name,
      synonyms: spectrum.synonyms,
      cas: spectrum.cas,
      formula: spectrum.formula,
      molecularMass: spectrum.molecularMass,
      exactMass: spectrum.exactMass,
      inchiKey: spectrum.inchiKey
    },
    acquisition: {
      precursorType: spectrum.precursorType,
      precursorMz: spectrum.precursorMz,
      spectrumType: spectrum.spectrumType,
      instrumentType: spectrum.instrumentType,
      instrument: spectrum.instrument,
      sampleInlet: spectrum.sampleInlet,
      ionization: spectrum.ionization,
      ionMode: spectrum.ionMode,
      collisionGas: spectrum.collisionGas,
      collisionEnergy: spectrum.collisionEnergy,
      collisionEnergyText: spectrum.collisionEnergyText,
      notes: spectrum.notes,
      comments: spectrum.comments
    },
    match: {
      type: match.type,
      identityType: match.identityType,
      methodId: Number(method.id),
      q1: numberOrNull(method.q1),
      q3: numberOrNull(method.q3),
      q1ErrorDa: Number.isFinite(match.q1Error) ? match.q1Error : null,
      q3ErrorDa: Number.isFinite(match.q3Error) ? match.q3Error : null,
      matchedQ3: match.matchedQ3 ?? null,
      q3Intensity: match.q3Intensity ?? null,
      ceError: Number.isFinite(match.ceError) ? match.ceError : null
    },
    peaks: spectrum.peaks
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

function mergeNames(existing, spectrum) {
  const result = []
  const seen = new Set()
  for (const value of safeJson(existing)) {
    const name = typeof value === 'string' ? value : value?.name
    const key = normText(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(typeof value === 'string' ? { area: '', name } : value)
  }
  for (const name of [spectrum.name, ...spectrum.synonyms]) {
    const key = normText(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({ area: '北美', name })
  }
  return result
}

function reportItem(action, compound, method, spectrum, match) {
  return {
    action,
    compoundId: Number(compound.id),
    methodId: method.id === null || method.id === undefined ? null : Number(method.id),
    localName: compound.main_name,
    localCas: compound.cas,
    localFormula: compound.formula,
    nistFormula: spectrum.formula,
    localPolarity: polarity(method),
    nistName: spectrum.name,
    cas: spectrum.cas,
    localQ1: numberOrNull(method.q1),
    localQ3: numberOrNull(method.q3),
    localCe: numberOrNull(method.ce),
    ionMode: spectrum.ionMode,
    precursorMz: spectrum.precursorMz,
    nistCe: spectrum.collisionEnergyText,
    nistNumber: spectrum.nistNumber,
    dbNumber: spectrum.dbNumber,
    sourceFile: spectrum.sourceFile,
    identityType: match.identityType,
    q1ErrorDa: Number.isFinite(match.q1Error) ? match.q1Error : null,
    q3ErrorDa: Number.isFinite(match.q3Error) ? match.q3Error : null,
    matchedQ3: match.matchedQ3 ?? null
  }
}

async function main() {
  const envFile = join(root, '.env')
  if (!existsSync(envFile)) throw new Error('Database config was not found: ' + envFile)
  loadEnv({ path: envFile, quiet: true })

  const files = readdirSync(options.docsDir)
    .filter((name) => /\.mspec$/i.test(name))
    .sort()
    .map((name) => join(options.docsDir, name))
  if (!files.length) throw new Error('No MSPEC files were found: ' + options.docsDir)

  const parsed = files.flatMap(parseMspec)
  const eligible = parsed.filter((item) => item.eligible)
  const indexes = buildIndexes(eligible)
  const db = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    charset: 'utf8mb4'
  })

  try {
    const [compounds] = await db.query(
      'SELECT id, main_name, name, formula, cas, molecular_mass, monoisotopic_mass ' +
        'FROM compounds WHERE COALESCE(is_delete, 0) = 0'
    )
    const [methods] = await db.query(
      'SELECT id, compounds_id, ms_mode, q1, q3, ce, polarity, ion_source, ' +
        'scan_mode, mass_spectrum_base64 FROM ms_methods ORDER BY id'
    )
    const methodsByCompound = new Map()
    for (const method of methods) {
      const key = Number(method.compounds_id)
      methodsByCompound.set(key, [...(methodsByCompound.get(key) ?? []), method])
    }

    const updates = []
    const representatives = []
    const enrichment = new Map()
    const matches = []
    let identityCount = 0
    let compoundsWithoutMethods = 0
    let strictCount = 0
    let representativeCount = 0

    for (const compound of compounds) {
      const identity = identityCandidates(compound, indexes)
      if (!identity.spectra.length) continue
      identityCount += 1
      const compoundMethods = methodsByCompound.get(Number(compound.id)) ?? []
      if (!compoundMethods.length) {
        compoundsWithoutMethods += 1
        continue
      }

      const hasStoredSpectrum = compoundMethods.some((method) =>
        String(method.mass_spectrum_base64 ?? '').trim()
      )
      let strictForCompound = 0
      for (const method of compoundMethods) {
        if (String(method.mass_spectrum_base64 ?? '').trim()) continue
        const selected = strictMatch(method, identity.spectra)
        if (!selected) continue
        const match = { ...selected, type: 'strict', identityType: identity.type }
        updates.push({
          methodId: Number(method.id),
          compoundId: Number(compound.id),
          value: encodeSpectrum(selected.spectrum, method, match)
        })
        matches.push(reportItem('STRICT_MATCH', compound, method, selected.spectrum, match))
        enrichment.set(Number(compound.id), { compound, spectrum: selected.spectrum })
        strictForCompound += 1
        strictCount += 1
      }

      if (strictForCompound === 0 && !hasStoredSpectrum) {
        const selected = representativeMatch(compoundMethods, identity.spectra)
        if (selected) {
          const draftMethod = buildRepresentativeMethod(selected.spectrum)
          const match = {
            type: 'representative',
            identityType: identity.type,
            anchorMethodId: Number(selected.method.id),
            q1Error: selected.q1Error,
            q3Error: null,
            ceError: selected.ceError
          }
          representatives.push({
            compoundId: Number(compound.id),
            spectrum: selected.spectrum,
            method: draftMethod,
            match
          })
          matches.push(
            reportItem('REPRESENTATIVE_NEW_METHOD', compound, draftMethod, selected.spectrum, match)
          )
          enrichment.set(Number(compound.id), { compound, spectrum: selected.spectrum })
          representativeCount += 1
        }
      }
    }

    mkdirSync(backupDir, { recursive: true })
    const runId = timestamp()
    const summary = {
      mode: options.apply ? 'apply' : 'dry-run',
      generatedAt: new Date().toISOString(),
      q1Tolerance: options.q1Tolerance,
      q3Tolerance: options.q3Tolerance,
      sourceFiles: files.map((file) => ({
        name: basename(file),
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
      })),
      parsedSpectra: parsed.length,
      eligibleQqQMs2Spectra: eligible.length,
      activeCompounds: compounds.length,
      methods: methods.length,
      compoundsWithNistIdentity: identityCount,
      compoundsWithoutMethods,
      strictMatches: strictCount,
      representativeMatches: representativeCount,
      methodsToUpdate: updates.length,
      methodsToCreate: representatives.length,
      compoundsToEnrich: enrichment.size
    }
    const reportPath = join(backupDir, 'nist-ms-match-report-' + runId + '.json')
    writeFileSync(reportPath, JSON.stringify({ summary, matches }, null, 2), 'utf8')

    if (options.apply && (updates.length || representatives.length)) {
      const compoundIds = [
        ...new Set([
          ...updates.map((item) => item.compoundId),
          ...representatives.map((item) => item.compoundId)
        ])
      ]
      const methodIds = [...new Set(updates.map((item) => item.methodId))]
      const [oldCompounds] = await db.query(
        'SELECT * FROM compounds WHERE id IN (' + compoundIds.map(() => '?').join(',') + ')',
        compoundIds
      )
      const oldMethods = methodIds.length
        ? (
            await db.query(
              'SELECT * FROM ms_methods WHERE id IN (' + methodIds.map(() => '?').join(',') + ')',
              methodIds
            )
          )[0]
        : []
      const backupPath = join(backupDir, 'nist-ms-import-before-' + runId + '.json')
      writeFileSync(
        backupPath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            summary,
            compounds: oldCompounds,
            ms_methods: oldMethods,
            representative_methods_to_create: representatives.map((item) => ({
              compoundId: item.compoundId,
              method: item.method,
              nistNumber: item.spectrum.nistNumber
            }))
          },
          null,
          2
        ),
        'utf8'
      )

      await db.beginTransaction()
      try {
        for (const update of updates) {
          await db.execute(
            'UPDATE ms_methods SET mass_spectrum_base64 = ?, update_time = NOW() ' +
              "WHERE id = ? AND (mass_spectrum_base64 IS NULL OR TRIM(mass_spectrum_base64) = '')",
            [update.value, update.methodId]
          )
        }
        const createdMethodIds = []
        for (const representative of representatives) {
          const method = representative.method
          const [result] = await db.execute(
            'INSERT INTO ms_methods ' +
              '(compounds_id, ms_mode, q1, q3, ce, polarity, ion_source, scan_mode, ' +
              'create_time, update_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
            [
              representative.compoundId,
              method.ms_mode,
              method.q1,
              method.q3,
              method.ce,
              method.polarity,
              method.ion_source,
              method.scan_mode
            ]
          )
          const methodId = Number(result.insertId)
          const storedMethod = { ...method, id: methodId }
          const value = encodeSpectrum(representative.spectrum, storedMethod, representative.match)
          await db.execute('UPDATE ms_methods SET mass_spectrum_base64 = ? WHERE id = ?', [
            value,
            methodId
          ])
          createdMethodIds.push(methodId)
        }
        for (const { compound, spectrum } of enrichment.values()) {
          await db.execute(
            'UPDATE compounds SET main_name = ?, name = ?, formula = ?, cas = ?, ' +
              'molecular_mass = ?, monoisotopic_mass = ?, update_time = NOW() WHERE id = ?',
            [
              spectrum.name || compound.main_name,
              JSON.stringify(mergeNames(compound.name, spectrum)),
              spectrum.formula || compound.formula,
              spectrum.cas || compound.cas,
              spectrum.molecularMass ?? compound.molecular_mass,
              spectrum.exactMass ?? compound.monoisotopic_mass,
              compound.id
            ]
          )
        }
        await db.commit()
        summary.createdMethodIds = createdMethodIds
        summary.backupPath = backupPath
      } catch (error) {
        await db.rollback()
        throw error
      }
    }

    console.log(JSON.stringify({ ...summary, reportPath }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
