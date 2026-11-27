const path = require('node:path')
const fs = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const lds = require('./lds-sqlite.cjs')
const { compare } = require('./massbank-match.cjs')
const { fail } = require('./policy.cjs')

const comparisonVersion = 2

function open(folder) { return new DatabaseSync(path.join(folder,'candidates.sqlite')) }
function compareBatch(files,input) {
  const entry = files.writableEntry(input.libraryId)
  if(entry.adapter !== 'lds-cn')fail('请选择支持谱图更新且可编辑的服务器文件库')
  files.massbankCompare({libraryId:input.libraryId,candidates:[]})
  const db = open(input.batchFolder)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS comparison(accession TEXT PRIMARY KEY,status TEXT,payload TEXT); CREATE TABLE IF NOT EXISTS compared(revision TEXT); CREATE TABLE IF NOT EXISTS comparison_policy(version INTEGER)')
    const before=lds.revision(files.root,entry), saved=db.prepare('SELECT revision FROM compared').get()
    if(saved?.revision!==before || db.prepare('SELECT version FROM comparison_policy').get()?.version!==comparisonVersion) {
      db.exec('BEGIN; DELETE FROM comparison; DELETE FROM compared; DELETE FROM comparison_policy')
      try {
        const insert=db.prepare('INSERT INTO comparison VALUES(?,?,?)')
        const candidates={*[Symbol.iterator](){for(const row of db.prepare('SELECT payload FROM candidates ORDER BY accession').iterate())yield JSON.parse(row.payload)}}
        const metadata=JSON.parse(fs.readFileSync(path.join(input.batchFolder,'batch.json'),'utf8'))
        const sourceName=metadata.invalid?undefined:metadata.adapter==='massbank'?'MassBank / '+metadata.scope:metadata.adapter==='gnps'?'GNPS / '+metadata.scope:undefined
        let done=0;const total=db.prepare('SELECT COUNT(*) n FROM candidates').get().n
        const progress=(label)=>{const f=path.join(input.batchFolder,'progress.json');fs.writeFileSync(f+'.tmp',JSON.stringify({phase:'compare',label,completed:done,total,unit:'张谱图',at:new Date().toISOString()}));fs.renameSync(f+'.tmp',f)}
        progress('正在建立目标库索引并比对')
        const result=compare(files.root,entry,candidates,undefined,row=>{insert.run(row.accession,row.status,JSON.stringify(row));done++;if(done%100===0)progress('正在比对谱图')},sourceName)
        progress('比对完成，可查看差异')
        db.prepare('INSERT INTO compared VALUES(?)').run(result.revision)
        db.prepare('INSERT INTO comparison_policy VALUES(?)').run(comparisonVersion)
        db.exec('COMMIT')
      }catch(e){db.exec('ROLLBACK');throw e}
    }
    const counts=Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM comparison GROUP BY status').all().map(r=>[r.status,r.n]))
    const where=input.filter==='all'?'':"WHERE status<>'existing'"
    const total=db.prepare('SELECT COUNT(*) n FROM comparison '+where).get().n
    const page=Number.isSafeInteger(input.page)&&input.page>0?Math.min(input.page,Math.max(1,Math.ceil(total/100))):1
    const rows=db.prepare('SELECT payload FROM comparison '+where+' ORDER BY accession LIMIT 100 OFFSET ?').all((page-1)*100).map(r=>JSON.parse(r.payload))
    const invalid=db.prepare('SELECT line,reason FROM invalid LIMIT 10').all()
    return {revision:db.prepare('SELECT revision FROM compared').get().revision,rows,counts,total,page,pageSize:100,invalidExamples:invalid,
      spectra:db.prepare('SELECT COUNT(*) n FROM candidates').get().n,
      eligibleIds:input.selectAll ? db.prepare("SELECT accession FROM comparison WHERE status IN ('new','attach') ORDER BY accession").all().map(r=>r.accession) : undefined}
  }finally{db.close()}
}
function publishBatch(files,input) {
  const db=open(input.batchFolder)
  let candidates
  try { candidates=input.selected.map(id=>{const row=db.prepare('SELECT payload FROM candidates WHERE accession=?').get(id);if(!row)fail('候选谱图不存在',409);return JSON.parse(row.payload)}) }
  finally{db.close()}
  return files.massbankPublish({...input,candidates}, () => {
    const comparison = compareBatch(files, input)
    if (comparison.revision !== input.revision) fail('目标库已变化，请重新核对差异', 409)
    const compared = open(input.batchFolder)
    try {
      const status = compared.prepare('SELECT status FROM comparison WHERE accession=?')
      for (const id of input.selected) {
        const statusValue=status.get(id)?.status
        const confirmed=Array.isArray(input.confirmed)&&input.confirmed.includes(id)
        if (!['new','attach','merge'].includes(statusValue)&&!(statusValue==='review'&&confirmed))
          fail('选择含重复或待确认的谱图，请重新核对差异：'+id, 409)
      }
    } finally { compared.close() }
  })
}
function inspectBatch(files,input) {
  compareBatch(files,{...input,page:1})
  const db=open(input.batchFolder)
  let candidate,row
  try {candidate=JSON.parse(db.prepare('SELECT payload FROM candidates WHERE accession=?').get(input.accession)?.payload || 'null');row=JSON.parse(db.prepare('SELECT payload FROM comparison WHERE accession=?').get(input.accession)?.payload || 'null')}
  finally{db.close()}
  if(!candidate && row?.status!=='missing')fail('谱图不存在',404)
  const entry=files.writableEntry(input.libraryId)
  let current=null
  if(row?.target){const {db,dict}=lds.prepare(files.root,entry);try{const target=db.prepare('SELECT * FROM effective WHERE id=?').get(row.target);if(target)current=lds.record(db,target,dict,entry,{details:true})}finally{db.close()}}
  const previous=current?.spectra?.find(s=>s.raw?.source_record_id===input.accession)?.raw || current?.sources?.find(s=>s.source_record_id===input.accession)?.raw || null
  return {upstream:candidate?.record || null,previous,current,reason:row.reason,
    note:previous?'历史导入原文来自已保留的来源字段；当前正式记录单独显示。':'此记录没有可用的历史导入原文，不能进行自动三方覆盖。'}
}
module.exports={compareBatch,publishBatch,inspectBatch}
