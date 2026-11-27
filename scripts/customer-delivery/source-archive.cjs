const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { accessionPattern, keyPattern, hash } = require('./massbank-record.cjs')
const lds = require('./lds-sqlite.cjs')
const { fail } = require('./policy.cjs')

const id = 'c08e2ce1-21ce-4a4f-bd40-d3236bc39efa'
const libraryId = 'file:' + id
const title = '自动更新谱库'
const checksum = /^[a-f0-9]{64}$/

function ensure(files, { uploadRoot }) {
  const state = files.state()
  const prior = state.libraries.find(entry => entry.id === id)
  const origin = path.join(uploadRoot, title, 'library.sqlite')
  if (prior) {
    if (!prior.managedSourceArchive || prior.origin !== origin) fail('自动更新谱库配置冲突', 409)
    return { libraryId, title }
  }
  fs.mkdirSync(path.dirname(origin), { recursive:true, mode:0o700 })
  if (!fs.existsSync(origin)) {
    const temp = origin + '.' + randomUUID() + '.tmp'
    try {
      const db = new DatabaseSync(temp)
      try { db.exec(fs.readFileSync(path.join(__dirname,'lds-empty.sql'),'utf8')) }
      finally { db.close() }
      fs.chmodSync(temp,0o600)
      fs.renameSync(temp,origin)
    } finally { fs.rmSync(temp,{force:true}) }
  }
  const { validation, ...metadata } = lds.inspectLDS(origin)
  const entry = { ...metadata, id, title, origin, readOnly:true, managedSourceArchive:true, registeredAt:new Date().toISOString() }
  lds.initializeMembership(files.root,entry)
  entry.revision = lds.revision(files.root,entry)
  state.libraries.push(entry)
  files.save(state)
  return { libraryId, title }
}

function archive(files, { batchFolder, sourceId }) {
  const entry = files.entry(libraryId)
  if (!entry.managedSourceArchive || entry.adapter !== 'lds-cn') fail('自动更新谱库配置无效',409)
  if (!/^[1-9][0-9]*$/.test(sourceId)) fail('下载来源编号无效')
  const batch = JSON.parse(fs.readFileSync(path.join(batchFolder,'batch.json'),'utf8'))
  if (!['massbank','gnps','msdial','msnlib','file'].includes(batch.adapter) ||
      batch.sourceId && batch.sourceId !== sourceId) fail('只接受已解析的上游下载批次')
  const content = batch.commit || batch.upstreamChecksum || batch.batchId
  if (!content || !Number.isSafeInteger(batch.count) || batch.count < 1) fail('下载批次缺少内容版本或谱图')
  const receiptHash = hash(JSON.stringify([sourceId,batch.scope,content]))
  const revision = lds.revision(files.root,entry)
  const previous = new Map(), seen = new Set()
  const workspace = new DatabaseSync(lds.workspace(files.root,entry),{readOnly:true})
  try {
    if (workspace.prepare('SELECT 1 FROM imports WHERE hash=?').get('source-archive:'+receiptHash))
      return { libraryId, addedSpectra:0, existingSpectra:batch.count, duplicate:true, revision }
    for (const row of workspace.prepare("SELECT id, json_extract(patch,'$.raw.sourceArchiveKey') key FROM changes WHERE state='active'").iterate())
      if (row.key) previous.set(row.key,row.id)
    for (const row of workspace.prepare("SELECT json_extract(s.value,'$.id') id FROM changes, json_each(patch,'$.spectra') s WHERE state='active'").iterate())
      if (row.id) seen.add(row.id)
  } finally { workspace.close() }

  const candidates = new DatabaseSync(path.join(batchFolder,'candidates.sqlite'),{readOnly:true})
  const operations = []
  let existingSpectra = 0
  let invalid = 0
  try {
    if (candidates.prepare('SELECT count(*) count FROM candidates').get().count !== batch.count)
      fail('候选谱图数量与下载回执不一致')
    for (const {accession,payload} of candidates.prepare('SELECT accession,payload FROM candidates ORDER BY accession').iterate()) {
      const {sha256,record} = JSON.parse(payload)
      const spectrum = record?.spectra?.[0]
      if (!accessionPattern.test(accession) || !checksum.test(sha256) || !record?.compound?.main_name?.trim() ||
          record.spectra.length !== 1 || spectrum?.kind !== 'numeric' || !spectrum.peaks?.length ||
          !spectrum.peaks.every(peak=>Number.isFinite(peak.mz)&&peak.mz>0&&Number.isFinite(peak.intensity)&&peak.intensity>=0)) {
        invalid++
        continue
      }
      const item = hash(JSON.stringify([sourceId, accession, sha256]))
      const spectrumId = 'source-archive:' + item
      if (seen.has(spectrumId)) { existingSpectra++; continue }
      seen.add(spectrumId)
      const inchikey = record.compound.inchikey
      const identityKey = keyPattern.test(inchikey) ? 'structure:'+inchikey : 'upstream:'+sourceId+':'+accession
      const methodIds = new Map((record.ms||[]).map((method,index)=>[method.id,spectrumId+':method:'+index]))
      operations.push({
        identityKey,
        target:previous.get(identityKey),
        record:{
          compound:record.compound,
          spectra:[{...spectrum,id:spectrumId,methodIds:(spectrum.methodIds||[]).map(method=>methodIds.get(method)).filter(Boolean)}],
          ms:(record.ms||[]).map(method=>({...method,id:methodIds.get(method.id)})),
          lc:(record.lc||[]).map((method,index)=>({...method,id:spectrumId+':lc:'+index})),
          sources:(record.sources||[]).map((source,index)=>({...source,id:spectrumId+':source:'+index,
            ...(source.spectrumId ? {spectrumId} : {})}))
        }
      })
    }
  } finally { candidates.close() }
  if (invalid && !operations.length && !existingSpectra) fail('批次没有可存入自动更新谱库的有效谱图')
  const result = lds.mutate(files.root,entry,{action:'source-archive',hash:receiptHash,operations,revision,actor:'source-update'})
  return {libraryId,addedSpectra:operations.length,existingSpectra,invalid,revision:result.revision,total:result.total}
}

module.exports = { archive, ensure, libraryId, title }
