import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonalLibrary, localPersonalOwner, personalView, tablePackage } from '../src/shared/personalLibrary.ts'
import { LocalRecordTrash } from '../src/shared/localRecordTrash.mjs'

test('personal record restore and purge retain other record IDs across restarts and batch trash', () => {
  const root=mkdtempSync(join(tmpdir(),'msl-record-trash-'))
  try {
    const library=new PersonalLibrary(root,localPersonalOwner('customer')),data=tablePackage([{名称:'甲'},{名称:'乙'},{名称:'丙'}],'test'),id=library.save(Buffer.from('source'),'test',data).id
    const initial=personalView(library.read(id)).records,first=initial[0].id,last=initial[2].id
    library.changeRecords(id,[first],'delete');assert.equal(personalView(library.read(id)).records.length,2);assert.equal(personalView(library.read(id),true).records[0].id,first)
    library.changeRecords(id,[first],'restore');assert.equal(personalView(library.read(id)).records.length,3)
    library.changeRecords(id,[first],'delete');library.changeRecords(id,[first],'purge')
    const restarted=new PersonalLibrary(root,localPersonalOwner('customer'));assert.equal(personalView(restarted.read(id)).records[1].id,last);assert.equal(restarted.read(id).data.groups.length,2)
    assert.throws(()=>restarted.changeRecords(id,[first],'restore'),/状态已变化/)
    restarted.remove(id);restarted.restore(id);assert.equal(personalView(restarted.read(id)).records[1].id,last)
    assert.equal(new PersonalLibrary(root,localPersonalOwner('other')).list().length,0)
  }finally{rmSync(root,{recursive:true,force:true})}
})
test('packaged local deletions are tenant isolated, persist without data payloads, and follow stable IDs',()=>{
 const root=mkdtempSync(join(tmpdir(),'msl-local-trash-'))
 try{
 const records=[{id:'old',stableId:'stable-a',compound:{main_name:'sensitive'}}],store=new LocalRecordTrash(root,'tenant')
 store.change(records,'release1',['old'],'delete');assert.equal(new LocalRecordTrash(root,'tenant').states(records,'release1').old,'trash');assert.equal(new LocalRecordTrash(root,'other').states(records,'release1').old,'active')
 const updated=[{id:'new',stableId:'stable-a'}];assert.equal(store.states(updated,'release2').new,'trash');store.change(updated,'release2',['new'],'restore');assert.equal(store.states(records,'release1').old,'active')
 store.change(records,'release1',['old'],'delete');store.change(records,'release1',['old'],'purge');assert.equal(store.states(records,'release1').old,'purged');assert.throws(()=>store.change(records,'release1',['old'],'restore'),/状态已变化/)
 assert.throws(()=>store.change(records,'release1',['missing'],'delete'),/记录不存在/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
