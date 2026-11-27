const { accessionPattern, keyPattern, hash } = require('./massbank-record.cjs')
const lds = require('./lds-sqlite.cjs')
const { fail } = require('./policy.cjs')

const keys = (...values) => [...new Set(values.filter(value => keyPattern.test(String(value || ''))))]
const add = (map, key, value) => {
  if (!key) return
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}
const normalized = value => String(value ?? '').trim().toLowerCase()
const peaksHash = peaks => hash(JSON.stringify(peaks.map(p => [Number(p.mz), Number(p.intensity)]).sort((a, b) => a[0] - b[0] || a[1] - b[1])))

function measurementKey(candidate) {
  const spectrum = candidate.record?.spectra?.[0]
  if (!candidate.key || !spectrum?.peaks?.length) return null
  return JSON.stringify([candidate.key, candidate.level, candidate.polarity, candidate.precursor,
    normalized(candidate.adduct), normalized(spectrum.collision_energy?.raw || candidate.energy),
    normalized(spectrum.conditions?.instrument), peaksHash(spectrum.peaks)])
}

function compare(root, entry, candidates, selected, onRow, sourceName, confirmed) {
  const before = lds.revision(root, entry)
  const { db, dict } = lds.prepare(root, entry)
  try {
    db.exec('BEGIN')
    const compounds = new Map(), byKey = new Map(), byName = new Set(), byCas = new Set(), accessions = new Map()
    const work = new Map(db.prepare('SELECT id, state, patch FROM work.changes').all().map(row =>
      [row.id, { state: row.state, patch: lds.parse(row.patch) || {} }]))
    for (const row of db.prepare('SELECT 化合物ID id, 化合物名称 name, 中文名称 chinese, CAS号 cas, 结构标识 structure, 身份状态 identity, 来源名称与结构JSON details FROM 化合物').iterate()) {
      const edit = work.get(row.id), details = lds.parse(row.details) || {}
      const values = keys(edit?.patch.compound?.inchikey, row.structure, details.inchikey, details.InChIKey)
      const item = { id: row.id, state: edit?.state || 'active', identity: edit?.patch.compound?.identity_status || row.identity,
        keys: values, names: [row.name, row.chinese, details.name_en, edit?.patch.compound?.main_name], cas: [row.cas, edit?.patch.compound?.cas] }
      compounds.set(row.id, item)
    }
    for (const row of db.prepare('SELECT 化合物ID id, 谱图ID spectrum, 来源JSON origin, 字段值JSON fields, 原始字段JSON raw FROM 来源记录').iterate()) {
      const origin = lds.parse(row.origin) || {}, fields = lds.parse(row.fields) || {}
      const raw = lds.parse(row.raw) || {}
      const item = compounds.get(row.id)
      if (item) {
        item.keys = keys(...item.keys, fields.InChIKey, fields.inchikey)
      }
      const accessionsHere = new Set([origin.source_record_id, origin.source_accession, fields.source_record_id, fields.source_accession, raw.ACCESSION])
      for (const value of accessionsHere) {
        if (accessionPattern.test(value || '')) add(accessions, value, { id: row.id, spectrumId: 'spectrum:' + row.spectrum, sha256: origin.sha256,sourceName:origin.name })
      }
    }
    for (const [id, { state, patch }] of work) {
      const compound = patch.compound || {}
      if (!compounds.has(id)) compounds.set(id, { id, state, identity: compound.identity_status,
        pilotIdentity: patch.raw?.massbankPilot === true && (patch.spectra || []).some(s => accessionPattern.test(s.raw?.source_record_id || '')),
        keys: keys(compound.inchikey), names: [compound.main_name, compound.name_en], cas: [compound.cas] })
      for (const spectrum of patch.spectra || []) {
        const accession = spectrum.raw?.source_record_id
        if (accessionPattern.test(accession || '')) add(accessions, accession, { id, spectrumId: spectrum.id, sha256: spectrum.raw.sha256,sourceName:(patch.sources||[]).find(s=>s.source_record_id===accession)?.name })
      }
      for (const source of patch.sources || []) {
        const accession = source.source_record_id
        if (accessionPattern.test(accession || '') && !(patch.spectra || []).some(s => s.raw?.source_record_id === accession))
          add(accessions, accession, { id, spectrumId:source.spectrumId, sha256:source.sha256,sourceName:source.name })
      }
    }
    for (const item of compounds.values()) {
      for (const key of item.keys) add(byKey, key, item)
      for (const name of item.names) if (name) byName.add(normalized(name))
      for (const cas of item.cas) if (cas) byCas.add(normalized(cas))
    }
    const recordCache = new Map()
    const readRecord = id => {
      if (recordCache.has(id)) return recordCache.get(id)
      const row = db.prepare('SELECT * FROM effective WHERE id=?').get(id)
      const result = row && lds.record(db, row, dict, entry, { details: true })
      if (recordCache.size >= 128) recordCache.delete(recordCache.keys().next().value)
      recordCache.set(id,result)
      return result
    }
    const peakRows = db.prepare('SELECT mz, 强度 intensity FROM 谱峰 WHERE 谱图ID=? ORDER BY 峰序号')
    function samePeaks(existing, incoming) {
      const peaks = existing.peaksDeferred ? peakRows.all(Number(existing.id.split(':')[1])) : existing.peaks
      return !!peaks?.length && peaksHash(peaks) === peaksHash(incoming.peaks)
    }
    function classify(candidate) {
      const matches = accessions.get(candidate.accession) || []
      if (candidate.deprecated) return { status: 'review', reason: '上游标为废弃' }
      if (matches.length) {
        if (matches.some(match => compounds.get(match.id)?.state !== 'active'))
          return { status: 'review', reason: '已有来源记录处于删除或排除状态' }
        const ids = [...new Set(matches.map(m => m.id))]
        if (ids.length > 1) return { status: 'review', reason: '相同上游编号关联多个化合物' }
        const current = readRecord(ids[0])
        const existing = current?.spectra.find(s => matches.some(m => m.spectrumId === s.id))
        if (!existing) return { status: 'review', target: ids[0], reason: '来源编号仍在，当前有效谱图已移除或无法定位' }
        if (matches.every(m => m.sha256 === candidate.sha256)) return { status: 'existing', target: ids[0], reason: '相同上游编号和原文校验值' }
        if (matches.some(m => m.sha256 && m.sha256 !== candidate.sha256))
          return { status: 'revision', target: ids[0], reason: '上游原始记录已变化' }
        const incoming = candidate.record.spectra[0]
        if (existing && samePeaks(existing, incoming)) return { status: 'existing', target: ids[0], reason: '相同上游编号且谱峰一致，历史原文版本未记录' }
        return { status: 'review', target: ids[0], reason: '上游编号已存在，历史原文或谱峰需核对' }
      }
      if (!candidate.key || !['MS', 'MS1', 'MS2', 'MS3', 'MS4'].includes(candidate.level) || candidate.polarity === null ||
          (candidate.level !== 'MS' && candidate.level !== 'MS1' && (!candidate.adduct || !candidate.precursor)))
        return { status: 'review', reason: '结构或关键谱图条件缺失' }
      const targets = byKey.get(candidate.key) || []
      if (!targets.length) {
        if (byName.has(normalized(candidate.name)) || byCas.has(normalized(candidate.record.compound.cas)))
          return { status: 'review', reason: '正式记录存在同名或同 CAS，需确认结构' }
        return { status: 'new', reason: '目标库无匹配化合物' }
      }
      const [target] = targets
      if (targets.length > 1 || target.state !== 'active' || target.keys.length !== 1 ||
          (target.identity !== 'structure_consistent' && !target.pilotIdentity))
        return { status: 'review', reason: '化合物归属存在多个候选、结构待确认或记录已移除' }
      const current = readRecord(target.id)
      const incoming = candidate.record.spectra[0]
      const exact = current.spectra.find(s => samePeaks(s,incoming) &&
        s.spectrum_type === incoming.spectrum_type && s.polarity === incoming.polarity &&
        s.precursor_mz === incoming.precursor_mz && normalized(s.adduct) === normalized(incoming.adduct) &&
        s.collision_energy?.raw && normalized(s.collision_energy.raw) === normalized(incoming.collision_energy?.raw) &&
        s.conditions?.instrument && normalized(s.conditions.instrument) === normalized(incoming.conditions?.instrument))
      if(exact) return {status:'merge',target:target.id,spectrumId:exact.id,reason:'完整结构、谱峰与已提供的采集条件一致，仅补充来源；需管理员选择'}
      // Identical peaks from another source require review before adding provenance.
      if (current.spectra.some(s => samePeaks(s, incoming)))
        return { status: 'review', target: target.id, reason: '已有相同谱峰，核对采集条件后可补充来源' }
      if (current.spectra.some(s => s.kind !== 'numeric'))
        return { status: 'review', target: target.id, reason: '已有图片谱，需人工确认是否重复' }
      return { status: 'attach', target: target.id, reason: '完整 InChIKey 匹配，谱峰不同' }
    }
    const rows = [],seen = new Set(), measurements = new Map()
    for (const candidate of candidates) {
      seen.add(candidate.accession)
      let result = classify(candidate)
      if (result.status === 'new' || result.status === 'attach') {
        const key = measurementKey(candidate)
        if (key) {
          const prior = measurements.get(key)
          if (prior) result = { status: 'duplicate', reason: '同批次已有相同谱图：'+prior, target: result.target }
          else measurements.set(key, candidate.accession)
        }
      }
      const row = { ...result, accession: candidate.accession, name: candidate.name, key: candidate.key, level: candidate.level,
        polarity: candidate.polarity, adduct: candidate.adduct, precursor: candidate.precursor, energy: candidate.energy,
        targetName: compounds.get(result.target)?.names.find(Boolean) }
      if (onRow) onRow(row); else rows.push(row)
    }
    if(sourceName)for(const [accession,matches] of accessions){
      if(!seen.has(accession)&&matches.some(m=>m.sourceName===sourceName&&compounds.get(m.id)?.state==='active')){
        const row={accession,status:'missing',reason:'完整选定范围中未再找到此上游编号；仅提示，不删除正式记录',target:matches[0].id,name:compounds.get(matches[0].id)?.names.find(Boolean)}
        if(onRow)onRow(row);else rows.push(row)
      }
    }
    const operations = []
    if (selected) {
      if (new Set(selected).size !== selected.length) fail('候选选择重复')
      const confirmedSet = new Set(Array.isArray(confirmed) ? confirmed : [])
      const indices = new Map(rows.map((row,index) => [row.accession,index]))
      for (const accession of selected) {
        const index = indices.get(accession), row = rows[index]
        const manuallyConfirmed = row?.status === 'review' && confirmedSet.has(accession)
        if (!row || (!['new', 'attach','merge'].includes(row.status) && !manuallyConfirmed)) fail('候选已变化，请重新核对：' + accession, 409)
        const record = candidates[index].record
        if(row.status==='merge'){
          operations.push({target:row.target,sourceOnly:true,record:{...record,spectra:[],ms:[],lc:[],sources:record.sources.map(s=>({...s,spectrumId:row.spectrumId,sha256:candidates[index].sha256,raw:record.spectra[0].raw}))}})
        }else operations.push({ target: row.target, record })
      }
    }
    if (before !== lds.revision(root, entry)) fail('目标数据库已变化，请重新检查', 409)
    return { rows, revision: before, operations }
  } finally { db.close() }
}

module.exports = { compare }
