import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createHash } from 'node:crypto'
import { encodePackage, validateGroup, canonicalStringify } from '../../src/shared/dataPackage.ts'
const [input,output]=process.argv.slice(2)
if(!input||!output)throw new Error('Usage: package-staging.mjs <export directory> <new package directory>')
const report=JSON.parse(fs.readFileSync(path.join(input,'staging-export-report.json'),'utf8'))
if(report.errors?.length)throw new Error('Staging conversion contains errors')
if(fs.existsSync(path.join(output,'conversion-report.json')))throw new Error('Output already exists')
fs.mkdirSync(output,{recursive:true})
const taxonomyCatalog=JSON.parse(fs.readFileSync(path.join(input,'catalog.json'),'utf8'))
let groups=[],bytes=0,converted=0,spectra=0,peaks=0
const parts=[],errors=[]
function flush(){
 if(!groups.length)return
 const index=parts.length+1
 const data={formatVersion:2,schemaVersion:2,packageId:`public-01-35-${report.mode}-v1-${String(index).padStart(5,'0')}`,mappingVersion:report.mappingVersion,taxonomyCatalog,groups}
 const buffer=encodePackage(data),file=`part-${String(index).padStart(5,'0')}.msldata`
 fs.writeFileSync(path.join(output,file),buffer)
 parts.push({file,groups:groups.length,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex')})
 groups=[];bytes=0
}
for await(const line of readline.createInterface({input:fs.createReadStream(path.join(input,'groups.ndjson')),crlfDelay:Infinity})){
 const group=JSON.parse(line);validateGroup(group)
 const size=Buffer.byteLength(canonicalStringify(group))
 if(groups.length>=100||bytes+size>20*1024*1024)flush()
 groups.push(group);bytes+=size;converted++;spectra+=group.spectra.length;peaks+=group.spectra.reduce((n,s)=>n+s.peaks.length,0)
}
flush()
if(converted!==report.convertedGroups||spectra!==report.spectra||peaks!==report.peaks)throw new Error('Counts differ from SQLite conversion')
fs.writeFileSync(path.join(output,'conversion-report.json'),JSON.stringify({...report,parts,errors,status:'completed'},null,2))
console.log(JSON.stringify({converted,spectra,peaks,parts:parts.length}))
