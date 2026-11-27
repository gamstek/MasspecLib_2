const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { parseRecord } = require('./massbank-record.cjs')
const { parseGNPS } = require('./gnps-record.cjs')
const { parsePublishedSpectrum } = require('./source-upload.cjs')
async function run(folder) {
  const config = JSON.parse(fs.readFileSync(path.join(folder,'request.json'),'utf8'))
  const progressFile=path.join(folder,'progress.json')
  const progress=(value)=>{fs.writeFileSync(progressFile+'.tmp',JSON.stringify({...value,at:new Date().toISOString()}));fs.renameSync(progressFile+'.tmp',progressFile)}
  progress({phase:'download',label:'正在下载并校验源文件',completed:0,total:0,unit:'文件'})
  await new Promise((resolve,reject) => {
    const child=spawn('python3',['-B',path.join(__dirname,'source-download.py'),folder],{stdio:['ignore','ignore','pipe']})
    child.stderr.pipe(process.stderr, { end:false })
    child.on('error',reject)
    child.on('close',code=>code===0?resolve():reject(Error('下载程序退出，退出状态：'+String(code))))
    process.once('SIGTERM',()=>{child.kill('SIGTERM');process.exitCode=1})
  })
  if (fs.existsSync(path.join(folder,'unchanged.json'))) return
  progress({phase:'parse',label:'下载完成，正在解析谱图',completed:0,total:0,unit:'条'})
  const metadata=JSON.parse(fs.readFileSync(path.join(folder,'download.json'),'utf8'))
  const db=new DatabaseSync(path.join(folder,'candidates.sqlite'))
  db.exec('CREATE TABLE candidates(accession TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE invalid(line INTEGER, reason TEXT); BEGIN')
  const insert=db.prepare('INSERT INTO candidates VALUES(?,?)'), bad=db.prepare('INSERT INTO invalid VALUES(?,?)')
  const published = ['msdial','msnlib','file'].includes(config.adapter)
  const prior = db.prepare('SELECT payload FROM candidates WHERE accession=?')
  const remove = db.prepare('DELETE FROM candidates WHERE accession=?')
  const conflicting = new Set()
  let count=0,invalid=0,line=0,duplicates=0,conflicts=0
  let compounds
  try {
    for await (const text of readline.createInterface({input:fs.createReadStream(path.join(folder,'records.jsonl')),crlfDelay:Infinity})) {
      line++
      try {
        const raw=JSON.parse(text)
        const candidate = published ? parsePublishedSpectrum(raw.text,config,metadata)
          : config.adapter==='massbank' ? parseRecord(raw,metadata.version) : parseGNPS(raw,metadata.version,config.scope)
        if (published && conflicting.has(candidate.accession)) throw Error('发布编号存在多条冲突记录')
        const previous = published && prior.get(candidate.accession)
        if (previous) {
          if (JSON.parse(previous.payload).sha256 === candidate.sha256) duplicates++
          else {
            conflicting.add(candidate.accession)
            remove.run(candidate.accession)
            count--
            conflicts++
            throw Error('发布编号重复且谱图内容不同，已排除该编号')
          }
        } else {
          insert.run(candidate.accession,JSON.stringify(candidate))
          count++
        }
      } catch(e) { invalid++;bad.run(line,String(e.message).slice(0,500)) }
      if(line%100===0)progress({phase:'parse',label:'正在解析谱图',completed:line,total:metadata.downloadCount||0,unit:'条',valid:count,invalid})
    }
    compounds=db.prepare("SELECT COUNT(DISTINCT json_extract(payload,'$.key')) n FROM candidates").get().n
    db.exec('COMMIT')
  } finally {db.close()}
  if(!count)throw Error('没有可解析的谱图；请检查下载文件和来源格式')
  const batch={...config,...metadata,count,invalid,duplicates,conflicts,compounds,checkedAt:new Date().toISOString()}
  delete batch.downloader
  delete batch.previousChecksum
  delete batch.previousValidators
  delete batch.previousReceipt
  fs.writeFileSync(path.join(folder,'batch.json.tmp'),JSON.stringify(batch));fs.renameSync(path.join(folder,'batch.json.tmp'),path.join(folder,'batch.json'))
  progress({phase:'compare',label:'解析完成，准备与目标库比对',completed:count,total:count,unit:'条',valid:count,invalid})
}
if(require.main===module)run(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={run}
