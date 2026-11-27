const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {DatabaseSync}=require('node:sqlite')
const {fixture}=require('./fixtures/lds-fixture.cjs')
const {FileLibraries}=require('../scripts/customer-delivery/file-libraries.cjs')

test('an LDS without a complete marker can be checked, registered and read with 64-bit category IDs',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lds-format-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const file=fixture(directory),db=new DatabaseSync(file),files=new FileLibraries(path.join(directory,'managed'))
  try {
    db.exec("DELETE FROM 构建信息 WHERE 键='complete'; BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE 分类字典 SET 分类ID=3051868953375488717 WHERE 分类ID=1; UPDATE 分类字典 SET 父类ID=3051868953375488717 WHERE 分类ID=2; UPDATE 分类字典 SET 分类ID=3051868953375488718 WHERE 分类ID=2; UPDATE 化合物分类 SET 分类ID=3051868953375488718; COMMIT")
  } finally {db.close()}
  const original=fs.readFileSync(file)
  const report=files.checkFormat({directory:file})
  assert.equal(report.status,'ready')
  assert.match(report.validation.warnings.join(' '),/未提供构建完成标记/)
  assert.equal(fs.existsSync(files.registry),false)
  assert.equal(files.scan(directory)[0].status,'ready')
  const {libraryId}=files.register(file)
  const page=files.rows({libraryId,details:true})
  assert.equal(page.total,3)
  assert.ok(page.rows[0].record.classification.source_paths.some(p=>p.includes('抗生素类')))
  assert.deepEqual(fs.readFileSync(file),original)
})

test('register rechecks an LDS after a successful inspection and reports the incompatible field',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lds-format-change-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const file=fixture(directory),files=new FileLibraries(path.join(directory,'managed'))
  assert.equal(files.checkFormat({directory:file}).status,'ready')
  const db=new DatabaseSync(file)
  try {db.exec('ALTER TABLE 谱峰 RENAME COLUMN 强度 TO 强度旧')} finally {db.close()}
  assert.match(files.checkFormat({directory:file}).issue,/谱峰.强度/)
  assert.throws(()=>files.register(file),/谱峰.强度/)
  assert.equal(fs.existsSync(files.registry),false)
})

test('a complete marker does not bypass unreadable data or broken relationships',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lds-format-reference-'))
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
  const file=fixture(directory),files=new FileLibraries(path.join(directory,'managed'))
  const db=new DatabaseSync(file,{enableForeignKeyConstraints:false})
  try {db.exec('UPDATE 关联关系 SET 谱图ID=900 WHERE 关联ID=1')} finally {db.close()}
  assert.match(files.checkFormat({directory:file}).issue,/关联抽检失败.*关联关系.*900/)
  assert.throws(()=>files.register(file),/关联抽检失败/)
})
