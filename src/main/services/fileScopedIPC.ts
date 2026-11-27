import {importedFileRecord} from '../../shared/fileRecordTransfer'
import{readFileSync,statSync}from'node:fs'
import{createHash}from'node:crypto'
import{extname}from'node:path'
import * as XLSX from'xlsx'
import{decodePackage}from'../../shared/dataPackage'
import{personalFlat}from'../../shared/personalFlat.mjs'
import{fileLibraryRequest}from'../delivery'
import{filePage,fileDetail}from'./fileLibrary'
export function packageData(file:string):any{if(statSync(file).size>64*1024*1024)throw Error('文件超过64MiB，请分包后导入');const bytes=readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex'),extension=extname(file).toLowerCase();let data:any;if(['.csv','.xlsx','.xls'].includes(extension)){const book=extension==='.csv'?XLSX.read(bytes.toString('utf8').replace(/^\uFEFF/,''),{type:'string',raw:true}):XLSX.read(bytes,{type:'buffer'});data=personalFlat.readBook(book,XLSX,hash)}else data=decodePackage(bytes);if(data.groups.length>20000)throw Error('每批最多20000条，请拆分后导入');return{data,hash}}
export function decodeFileImport(file:string,expectedHash?:string): {records:any[];hash:string} {
 const {data,hash}=packageData(file)
 if(expectedHash && expectedHash!==hash)throw Error('文件在预览后已变化，请重新预览')
 const records=data.groups.map((group:any,index:number)=>importedFileRecord(group,data.taxonomyCatalog||[],index))
 if(Buffer.byteLength(JSON.stringify(records))>50*1024*1024)throw Error('导入展开内容超过50MiB，请分包')
 return {records,hash}
}
async function validateSpectra(id:string,input:any[]):Promise<any[]> {
 const legacy=await import('./legacySpectra'),compounds:any[]=[],methods:any[]=[];const ids=[...new Set(input.map(r=>Number(r.compoundId)).filter(n=>Number.isSafeInteger(n)&&n>0))];if(ids.length>500)throw Error('每次谱图导入最多涉及500个化合物');
 for(const key of ids){const data=await fileDetail({connectionId:id,key:String(key)});compounds.push(data.compound);methods.push(...data.methods.flatMap(g=>g.methods.map((m:any,index:number)=>({...m,id:m.original_method_id||Number(String(m.id).split(':').pop())||index+1,compounds_id:key}))))}
 return legacy.validateRows(input,{compounds,methods});
}
export async function stagedFileSpectra(id:string,recordId:number,input:any[],currentMethods:any[]):Promise<{spectra:any[];methods:any[]}>{
 const rows=await validateSpectra(id,input),spectra:any[]=[],methods:any[]=[];if(rows.some(r=>r.status==='error'||Number(r.compoundId)!==recordId))throw Error('谱图未通过校验或不属于当前化合物，请修正模板后重试');
 for(const row of rows){const stored=JSON.parse(Buffer.from(row.massSpectrumBase64,'base64').toString('utf8')),key=createHash('sha256').update(JSON.stringify([row.spectrumId,row.compoundId,row.q1,row.q3,row.polarity,row.peaksText])).digest('hex').slice(0,24);let method=currentMethods.find(m=>Number(m.original_method_id||String(m.id).split(':').pop())===Number(row.methodId));
 if(!method){method={id:'import-ms:'+key,ms_mode:row.msMode,q1:row.q1,q3:row.q3,ce:row.collisionEnergy,ce_unit:'eV',ce_unit_source:'default',polarity:row.polarity,ion_source:row.ionization,method_source:row.sourceName};methods.push(method)}
 spectra.push({id:'import-spectrum:'+key,kind:'numeric',spectrum_type:row.spectrumType||'MS2',precursor_mz:row.precursorMz??row.q1,polarity:row.polarity,adduct:row.precursorType,collision_energy:{value:row.collisionEnergy,unit:null},peaks:stored.peaks,methodIds:[method.id],raw:stored});
 }return{spectra,methods};
}
export async function fileScopedIPC(id:string,channel:string,args:any[]):Promise<any>{
 if(channel==='spectrum-import:parse'||channel==='spectrum-import:validate'){try{const legacy=await import('./legacySpectra'),input=channel.endsWith(':parse')?legacy.readTemplate(args[0]).map(r=>({...r,compoundId:r.compoundId??args[1]??null})):args[0],rows=await validateSpectra(id,input);return{success:true,rows,summary:legacy.validationSummary(rows)}}catch(e){return{success:false,error:String(e)}}}
 if(channel==='import:preview'){const{data,hash}=packageData(args[0]);return{hash,newCount:data.groups.length,skipped:0,conflicts:0,estimated:true,notice:'相同来源文件只导入一次；同CAS/同名不同记录分别保留。'}}
 if(channel==='import:compounds'||channel==='compounds:import-excel'){
  const{records,hash}=decodeFileImport(args[0],args[1]);const current=await filePage(id,{}),result=await fileLibraryRequest('POST','/admin/file-sources/mutate',{libraryId:id,revision:current.revision,action:'import',hash,records});return{success:true,imported:result.changed,skipped:result.duplicate?records.length:0,batchId:hash,revision:result.revision};
 }
 if(channel==='import:undo'){const current=await filePage(id,{});return fileLibraryRequest('POST','/admin/file-sources/mutate',{libraryId:id,revision:current.revision,action:'undo-import',hash:args[0]})}
 if(['compound:detail','compound:extensions','ms-methods:list','lc-methods:list'].includes(channel)){const data=await fileDetail({connectionId:id,key:String(args[0])});return channel==='compound:detail'?data.compound:channel==='compound:extensions'?data.extensions:channel==='ms-methods:list'?data.methods:data.lcMethods}
 throw Error('此文件库操作请通过统一列表和详情入口执行：'+channel)
}
