const { hash, keyPattern } = require('./massbank-record.cjs')
const clean = value => {
  const text = String(value ?? '').trim()
  return /^(?:null|none|n\/a|undefined)$/i.test(text) ? '' : text
}
function parseGNPS(row, version, scope) {
  const accession = clean(row.spectrum_id || row.SpectrumID)
  if (!/^CCMSLIB[0-9]+$/.test(accession)) throw Error('GNPS 谱图缺少稳定的 CCMSLIB 编号')
  const name = clean(row.Compound_Name)
  const pairs = typeof row.peaks_json === 'string' ? JSON.parse(row.peaks_json) : row.peaks_json
  if (!name || !Array.isArray(pairs) || !pairs.length) throw Error('GNPS 名称或谱峰缺失：' + accession)
  const peaks = pairs.map(p => ({ mz: Number(p[0]), intensity: Number(p[1]) }))
  if (peaks.some(p => !Number.isFinite(p.mz) || p.mz <= 0 || !Number.isFinite(p.intensity) || p.intensity < 0))
    throw Error('GNPS 谱峰数值无效：' + accession)
  const reportedKeys = [...new Set([row.InChIKey_smiles, row.InChIKey_inchi, row.InChIKey].map(clean).filter(k => keyPattern.test(k)))]
  const key = reportedKeys.length === 1 ? reportedKeys[0] : null
  const mode = clean(row.Ion_Mode).toLowerCase()
  const polarity = mode === 'positive' ? 1 : mode === 'negative' ? 0 : null
  const level = /^\d+$/.test(clean(row.ms_level)) ? 'MS' + row.ms_level : null
  const precursor = Number(row.Precursor_MZ) > 0 ? Number(row.Precursor_MZ) : null
  const adduct = clean(row.Adduct) || null
  const energy = clean(row.Collision_Energy) || null
  // Compare scientific content. Export ordering and annotation history do not imply changed spectra.
  const record = {
    compound: { main_name: name, name_en: name, inchikey: key, smiles: clean(row.Smiles) || null,
      formula: clean(row.Formula_smiles || row.Formula_inchi) || null, cas: clean(row.CAS_Number) || null },
    spectra: [{ id:'gnps:' + accession, kind:'numeric', nature:'measured', spectrum_type:level,
      precursor_mz:precursor, polarity, adduct, collision_energy: energy ? {raw:energy} : null,
      peaks, methodIds:['gnps-method:' + accession], conditions:{instrument:clean(row.Instrument)} }],
    ms: [{ id:'gnps-method:' + accession, ms_mode:clean(row.Instrument) || 'GNPS', scan_mode:level,
      q1:precursor, polarity, adduct, conditions:{collision_energy_raw:energy}, method_source:'GNPS / ' + scope }],
    lc: [], sources:[{id:'gnps-source:'+accession, name:'GNPS / '+scope, namespace:'gnps',
      source_record_id:accession, version, source_url:'https://gnps.ucsd.edu/ProteoSAFe/gnpslibraryspectrum.jsp?SpectrumID='+accession}]
  }
  const sha256 = hash(JSON.stringify({compound:record.compound, level, polarity, precursor, adduct, energy, instrument:clean(row.Instrument), peaks:[...peaks].sort((a,b)=>a.mz-b.mz || a.intensity-b.intensity)}))
  record.spectra[0].raw = {source_record_id:accession, sha256, original:row}
  return { accession, sha256, record, name, key, level, polarity, adduct, precursor, energy }
}
module.exports = {parseGNPS}
