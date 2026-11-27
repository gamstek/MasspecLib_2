/** Real-MySQL smoke check. Creates a uniquely named isolated test database only. */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { createHash, randomBytes } from 'node:crypto'
const [dir,reportPath]=process.argv.slice(2)
if(!dir||!reportPath)throw new Error('Usage: verify-delivery.mjs <SQL directory> <report.json>')
const db=await mysql.createConnection({host:'127.0.0.1',port:Number(process.env.PUBLIC_TEST_MYSQL_PORT??44715),user:'root',charset:'utf8mb4',supportBigNumbers:true,bigNumberStrings:true})
const [[place]]=await db.query('SELECT @@datadir AS datadir')
assert.ok(place.datadir.startsWith('/tmp/masspeclib2-mysql-'),'Refuse to create test database on an unrecognized server')
const name='mspec_lib2_public_sample_'+Date.now()+'_'+randomBytes(3).toString('hex')
const checks=[]
const check=(label,detail)=>{checks.push({label,status:'passed',detail});console.log('PASS',label)}
async function* statements(filename){
 let buffer='',delimiter=';'
 for await(const line of readline.createInterface({input:fs.createReadStream(filename),crlfDelay:Infinity})){
  const control=line.trim().match(/^DELIMITER\s+(\S+)$/i)
  if(control){delimiter=control[1];continue}
  buffer+=line+'\n'
  if(buffer.trimEnd().endsWith(delimiter)){
   const sql=buffer.trimEnd().slice(0,-delimiter.length).trim();buffer=''
   if(sql)yield sql
  }
 }
 if(buffer.trim()&&!/^--/.test(buffer.trim()))throw new Error('Unterminated SQL statement')
}
async function execute(file){for await(const sql of statements(path.join(dir,file)))await db.query(sql)}
try{
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'sql-manifest.json'),'utf8'))
 const hash=createHash('sha256');for await(const block of fs.createReadStream(path.join(dir,manifest.dataFile)))hash.update(block)
 assert.equal(hash.digest('hex'),manifest.sha256);check('SQL SHA256',manifest.sha256)
 await db.query('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');await db.query('USE `'+name+'`')
 await execute('00_初始化空库.sql');check('guarded initialization on new empty database')
 await execute(manifest.dataFile);check('sample data procedures executed')
 const [[meta]]=await db.query('SELECT * FROM app_metadata WHERE id=1');assert.equal(meta.schema_version,4);assert.equal(meta.state,'ready')
 for(const [table,count] of Object.entries(manifest.counts)){
  const [[r]]=await db.query('SELECT COUNT(*) n FROM `'+table+'`');assert.equal(Number(r.n),count,table)
 }
 const [[peaks]]=await db.query('SELECT SUM(JSON_LENGTH(peaks)) n FROM spectra');assert.equal(Number(peaks.n),manifest.peaks);check('schema, ready state and all entity/peak counts')
 const [[bad]]=await db.query("SELECT COUNT(*) n FROM entity_sources e LEFT JOIN source_records s ON s.id=e.source_record_id WHERE s.id IS NULL");assert.equal(Number(bad.n),0)
 const [[empty]]=await db.query("SELECT COUNT(*) n FROM spectra WHERE kind='numeric' AND (peaks IS NULL OR JSON_LENGTH(peaks)=0)");assert.equal(Number(empty.n),0);check('no orphan sources or empty numeric spectra')
 const [[column]]=await db.query('SELECT COUNT(*) n FROM lc_methods WHERE column_particle_size_um=1.8 AND column_length_mm=50 AND column_inner_diameter_mm=2');assert.ok(Number(column.n)>0);check('MassBank column 50 × 2 mm, 1.8 μm',column.n)
 const [[phase]]=await db.query('SELECT COUNT(*) n FROM lc_methods WHERE phase_A IS NOT NULL AND phase_B IS NOT NULL');assert.ok(Number(phase.n)>0)
 const [[gradient]]=await db.query('SELECT COUNT(*) n FROM lc_methods_items');assert.ok(Number(gradient.n)>0);check('mobile phase and gradient imported',{phase:phase.n,steps:gradient.n})
 const [[unknown]]=await db.query("SELECT COUNT(*) n FROM lc_methods WHERE retention_time IS NOT NULL AND retention_time_unit='unspecified'");check('unknown source RT units retained without guessing',unknown.n)
 const before=Number(manifest.counts.compounds)
 let refused=false
 try{await execute(manifest.dataFile)}catch(e){refused=e.sqlState==='45000'}
 assert.equal(refused,true);const [[again]]=await db.query('SELECT COUNT(*) n FROM compounds');assert.equal(Number(again.n),before);check('repeat SQL import refused without adding duplicates')
 refused=false
 try{await execute('00_初始化空库.sql')}catch(e){refused=e.sqlState==='45000'}
 assert.equal(refused,true);check('initialization refuses nonempty database without collation conflicts')
 fs.writeFileSync(reportPath,JSON.stringify({status:'passed',database:name,port:44715,scope:'isolated real MySQL SQL import; not Windows GUI verification',checks},null,2))
}catch(e){fs.writeFileSync(reportPath,JSON.stringify({status:'failed',database:name,checks,error:String(e)},null,2));throw e}
finally{await db.end()}
