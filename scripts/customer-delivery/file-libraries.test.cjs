const { test } = require('node:test'), assert = require('node:assert/strict'), fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto')
const { FileLibraries,createLibrary,LibrarySnapshotBuilder }=require('./file-libraries.cjs')
const record=(id,name)=>({id,compound:{main_name:name,name_en:name+' English',cas:'50-00-0',molecular_mass:0},classIds:[1],ms:[{id:'m1',q1:100.123456789,q3:20,raw:'SECRET'}],lc:[{id:'l1',retention_time:2.5,gradient:[{time:0,percentage_A:95,percentage_B:5,private:'SECRET'}]}],spectra:[],sources:[],chromatograms:[],experiments:[],private:'SECRET'})
test('file libraries scan, register, retain an immutable original, and version record trash operations',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'msl-file-'));try{
 const input=path.join(root,'incoming','library.sqlite'),id=crypto.randomUUID();createLibrary(input,{libraryId:id,title:'文件测试库',records:[record('a','甲'),record('b','乙')],classes:[{id:1,class_name:'测试分类'}]});const original=fs.readFileSync(input),catalog=new FileLibraries(path.join(root,'managed'))
 assert.equal(catalog.scan(path.dirname(input))[0].total,2);const entry=catalog.register(path.dirname(input));assert.equal(catalog.list()[0].total,2);assert.throws(()=>catalog.register(path.dirname(input)),/已注册/)
 const key=entry.libraryId,revision=entry.revision;assert.equal(catalog.rows({libraryId:key,keyword:'english'}).total,2);assert.equal(catalog.rows({libraryId:key,onlySelected:true,compoundIds:[2]}).rows[0].record.id,'b');assert.equal(catalog.rows({libraryId:key,classIds:[99]}).total,0)
 catalog.change({libraryId:key,revision,ids:[1],action:'delete'});assert.equal(catalog.rows({libraryId:key}).total,1);assert.equal(catalog.rows({libraryId:key,trash:true}).rows[0].id,1);assert.throws(()=>catalog.change({libraryId:key,revision,ids:[2],action:'delete'}),/修订已变化/)
 catalog.change({libraryId:key,ids:[1],action:'restore'});assert.equal(catalog.rows({libraryId:key}).total,2);catalog.change({libraryId:key,ids:[1],action:'delete'});catalog.change({libraryId:key,ids:[1],action:'purge'});assert.equal(catalog.rows({libraryId:key}).rows[0].id,2);assert.deepEqual(fs.readFileSync(input),original)
 assert.throws(()=>catalog.register(path.dirname(input),'file:'+crypto.randomUUID()),/另一个/);fs.appendFileSync(catalog.file(catalog.entry(key)),'tamper');assert.equal(catalog.list()[0].status,'error');assert.throws(()=>catalog.rows({libraryId:key}),/校验失败/)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('file source queries and delivery snapshots share selection, enforce field projection, and retain record identity across revisions',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'msl-file-snapshot-'));try{
 const input=path.join(root,'incoming','library.sqlite');createLibrary(input,{title:'文件库',records:[record('a','甲'),record('b','乙')],classes:[{id:1,class_name:'分类'}]});const catalog=new FileLibraries(path.join(root,'managed')),entry=catalog.register(path.dirname(input)),builder=new LibrarySnapshotBuilder(null,path.join(root,'datasets'),null,catalog)
 const selection={libraryId:entry.libraryId,revision:entry.revision,displayName:'客户库',onlySelected:true,compoundIds:[2]},policy={fields:{compound:['main_name','molecular_mass'],ms:['q1'],lc:['retention_time','retention_time_unit','gradient']},features:{spectra:true,lc:true}}
 assert.equal((await builder.candidates(selection)).total,1)
 const a=await builder.build({title:'客户',version:'r1',selections:[selection],policy});assert.equal(a.total,1);const row=builder.record(a,builder.index(a)[0].id);assert.equal(row.compound.main_name,'乙');assert.equal(row.compound.molecular_mass,0);assert.equal(row.ms[0].q1,100.123456789);assert.equal(row.lc[0].retention_time_unit,'min');assert.equal(row.compound.cas,undefined);assert(!JSON.stringify(row).includes('SECRET'))
 const b=await builder.build({title:'客户',version:'r2',selections:[selection],policy});assert.equal(builder.record(b,builder.index(b)[0].id).stableId,row.stableId);assert.notEqual(builder.index(b)[0].id,row.id)
 catalog.change({libraryId:entry.libraryId,ids:[2],action:'delete'});assert.equal(builder.index(a).length,1);await assert.rejects(()=>builder.build({title:'客户',version:'r3',selections:[selection],policy}),/修订已变化/)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
