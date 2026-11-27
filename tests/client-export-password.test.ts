import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {deliverySql} from '../src/shared/deliverySql.ts'
test('SQLite SQL export imports into an empty file and preserves Unicode, quotes, zero, negative CE and linked methods',()=>{
 const name="中文 O'Brien \\ ');DROP TABLE records; --",r={id:'record-1',compound:{main_name:name,cas:null},ms:[{id:'m1',q1:0,ce:-20}],lc:[{id:'lc1',retention_times:[{value:0,unit:'min',methodIds:['m1']}]}],sources:[{name:'测试来源'}],spectra:[]},data={manifest:{title:'导出测试'},records:[r]};
 const db=new DatabaseSync(':memory:');try{db.exec(deliverySql(data,true));const actual=JSON.parse(db.prepare('SELECT payload FROM records').get()!.payload as string);assert.equal(actual.compound.main_name,name);assert.deepEqual(actual.ms,r.ms);assert.deepEqual(actual.lc,r.lc);assert.equal(db.prepare("SELECT value FROM metadata WHERE key='product'").get()!.value,'MasspecLib2')}finally{db.close()}
 const basic=new DatabaseSync(':memory:');try{basic.exec(deliverySql(data,false));const actual=JSON.parse(basic.prepare('SELECT payload FROM records').get()!.payload as string);assert.deepEqual(actual.ms,[]);assert.deepEqual(actual.lc,[]);assert.deepEqual(actual.compound,r.compound)}finally{basic.close()}
 assert.throws(()=>deliverySql({records:[{id:'x',compound:{cas:'123'}}]},false),/名称/)
})
