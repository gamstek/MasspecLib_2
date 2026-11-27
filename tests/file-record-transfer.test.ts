import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileRecordGroup, importedFileRecord, lcForEditor, lcForWorkspace, needsFileDiscovery} from '../src/shared/fileRecordTransfer.ts'
import {canonicalStringify,encodePackage,decodePackage} from '../src/shared/dataPackage.ts'
test('LDS full package roundtrip retains numeric spectra, 0/negative values, source paths and records',()=>{
 const record={compound:{main_name:'test',cas:'50-00-0'},ms:[{id:'mrm:1',q1:100,q3:80,ce:-5}],lc:[{id:'lc:1',retention_times:[{value:0,methodIds:['mrm:1']}]}],spectra:[{id:'s:1',kind:'numeric',peaks:[{mz:100,intensity:0}],methodIds:['mrm:1']}],classification:{catalog:[],items:[],source_labels:['a','b'],source_paths:[['a','b']]},sources:[{name:'one',source_record_id:1},{name:'two',source_record_id:2}]}
 const group=fileRecordGroup(record,{connectionId:'file:test',key:'1'},[]);assert.doesNotThrow(()=>canonicalStringify(group));
 const decoded=decodePackage(encodePackage({formatVersion:2,schemaVersion:2,packageId:'test',mappingVersion:'test',groups:[group]}));
 const restored=importedFileRecord(decoded.groups[0],[],0);assert.deepEqual(restored.sources,record.sources);assert.deepEqual(restored.classification.source_paths,record.classification.source_paths);assert.equal(restored.ms[0].ce,-5);assert.deepEqual(restored.lc[0].retention_times[0].methodIds,['mrm:1']);assert.equal(restored.lc[0].retention_times[0].value,0)
})
test('editing LC association replaces original association without retaining stale alias',()=>{const lc=lcForEditor([{retention_times:[{methodIds:['mrm:1'],value:0}]}]);assert.deepEqual(lc[0].retention_times[0].methodLocalIds,['mrm:1']);lc[0].retention_times[0].methodLocalIds=['mrm:2'];const saved=lcForWorkspace(lc);assert.deepEqual(saved[0].retention_times[0].methodIds,['mrm:2']);assert(!('methodLocalIds' in saved[0].retention_times[0]))})
test('native-only export does not discover remote file libraries',()=>{assert.equal(needsFileDiscovery(['mysql:one'],true),false);assert.equal(needsFileDiscovery([],false),false);assert.equal(needsFileDiscovery(['file:one'],true),true);assert.equal(needsFileDiscovery([],true),true)})
