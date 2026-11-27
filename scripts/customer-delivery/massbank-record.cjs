const { createHash } = require('node:crypto')

const accessionPattern = /^(?:MSBNK-[A-Za-z0-9_]+-[A-Z0-9_]+|CCMSLIB[0-9]+|(?:UPLOAD|MSDIAL|MSNLIB|SOURCEFILE)-[a-f0-9]{64})$/
const keyPattern = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/
const hash = value => createHash('sha256').update(value).digest('hex')

function parseRecord(input, version) {
  const raw = input.text
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256) || hash(raw) !== input.sha256)
    throw Error('MassBank 文件校验失败')
  const field = prefix => raw.split('\n').find(line => line.startsWith(prefix))?.slice(prefix.length).trim()
  const accession = field('ACCESSION:')
  if (!accessionPattern.test(accession || '') || accession !== input.accession) throw Error('MassBank 谱图编号与文件不符')
  if (/^DEPRECATED:/m.test(raw)) return { accession, deprecated: true, sha256: input.sha256 }
  const name = field('CH$NAME:')
  const key = field('CH$LINK: INCHIKEY ')
  const level = field('AC$MASS_SPECTROMETRY: MS_TYPE ')
  const ionMode = field('AC$MASS_SPECTROMETRY: ION_MODE ')
  const polarity = ionMode === 'POSITIVE' ? 1 : ionMode === 'NEGATIVE' ? 0 : null
  const precursor = Number(field('MS$FOCUSED_ION: PRECURSOR_M/Z '))
  const adduct = field('MS$FOCUSED_ION: PRECURSOR_TYPE ') || null
  const energy = field('AC$MASS_SPECTROMETRY: COLLISION_ENERGY ') || null
  const instrument = field('AC$INSTRUMENT:') || null
  const instrumentType = field('AC$INSTRUMENT_TYPE:') || null
  const peaksText = raw.match(/^PK\$PEAK:[^\n]*\n([\s\S]*?)^\/\/\s*$/m)?.[1]
  const peaks = peaksText?.trim().split(/\r?\n/).map(line => {
    const [mz, intensity] = line.trim().split(/\s+/).map(Number)
    return { mz, intensity }
  })
  if (!name || !peaks?.length || peaks.length !== Number(field('PK$NUM_PEAK:')) ||
      peaks.some(p => !Number.isFinite(p.mz) || p.mz <= 0 || !Number.isFinite(p.intensity) || p.intensity < 0))
    throw Error('MassBank 谱峰或名称无效：' + accession)
  const energyNumber = energy?.match(/^(\d+(?:\.\d+)?)\s*(eV|\(NCE\)|% NCE)$/i)
  const collision = energyNumber
    ? { value: Number(energyNumber[1]), unit: energyNumber[2].toLowerCase() === 'ev' ? 'eV' : 'NCE', raw: energy }
    : energy ? { raw: energy } : null
  const methodId = 'massbank-method:' + accession
  const contributor = accession.split('-')[1]
  const origin = { name: 'MassBank / ' + contributor, source_record_id: accession, namespace: 'massbank:' + contributor,
    version, license: field('LICENSE:') || null, source_url: 'https://massbank.eu/MassBank/RecordDisplay?id=' + accession }
  const spectrum = {
    id: 'massbank:' + accession, kind: 'numeric', nature: 'measured', spectrum_type: level || null,
    polarity, adduct, precursor_mz: Number.isFinite(precursor) && precursor > 0 ? precursor : null,
    collision_energy: collision, peaks, methodIds: [methodId],
    conditions: { instrument, instrument_type: instrumentType, source_accession: accession },
    raw: { source_record_id: accession, sha256: input.sha256, text: raw }
  }
  const retention = field('AC$CHROMATOGRAPHY: RETENTION_TIME ')?.match(/^(\d+(?:\.\d+)?)\s*(min|s)$/)
  const column = field('AC$CHROMATOGRAPHY: COLUMN_NAME ')
  const gradient = field('AC$CHROMATOGRAPHY: FLOW_GRADIENT ')
  const phases = raw.split(/\r?\n/).filter(line => /^AC\$CHROMATOGRAPHY: SOLVENT [AB] /.test(line))
    .map(line => line.slice('AC$CHROMATOGRAPHY: '.length))
  const record = {
    compound: { main_name: name, name_en: name, formula: field('CH$FORMULA:') || null,
      cas: field('CH$LINK: CAS ') || null, smiles: field('CH$SMILES:') || null,
      inchikey: keyPattern.test(key || '') ? key : null },
    sources: [{ ...origin, id: 'massbank-source:' + accession }],
    spectra: [spectrum],
    ms: [{ id: methodId, ms_mode: instrumentType, scan_mode: level || null, polarity,
      q1: spectrum.precursor_mz, ce: collision?.value ?? null, ce_unit: collision?.unit ?? null,
      ion_source: field('AC$MASS_SPECTROMETRY: IONIZATION ') || null,
      conditions: { instrument, collision_energy_raw: energy }, method_source: origin.name }],
    lc: column || gradient || retention || phases.length ? [{
      id: 'massbank-lc:' + accession, method_source: accession, column_type: column || null,
      program_text: gradient || null, phase_A: phases.length ? JSON.stringify(phases) : null,
      retention_time: retention ? Number(retention[1]) : null, retention_time_unit: retention?.[2]
    }] : []
  }
  return { accession, sha256: input.sha256, record, name, key: record.compound.inchikey, level, polarity, adduct, precursor: spectrum.precursor_mz, energy }
}

module.exports = { parseRecord, accessionPattern, keyPattern, hash }
