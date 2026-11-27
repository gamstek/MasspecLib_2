import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonalLibrary, personalOwner, localPersonalOwner, tablePackage, readPersonalPackage, personalView } from '../src/shared/personalLibrary.ts'
import { encodePackage } from '../src/shared/dataPackage.ts'

test('damaged batches remain recoverable without blocking healthy batches; trash restores exact bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'masspec-recovery-'))
  try {
    const library = new PersonalLibrary(root, localPersonalOwner('recovery'))
    const data = tablePackage([{ 名称: '正常记录' }], 'healthy')
    const originalBytes = encodePackage(data)
    const saved = library.save(originalBytes, '正常批次', data)
    const broken = 'a'.repeat(64), bytes = Buffer.from('{broken-json')
    writeFileSync(library.file(broken), bytes)
    assert.equal(library.list().length, 2)
    assert.equal(library.list().find(b => b.id === broken).damaged, true)
    assert.equal(library.read(saved.id).data.groups[0].compound.main_name, '正常记录')
    assert.throws(() => library.read(broken), /其他批次仍可使用/)
    assert.deepEqual(library.raw(broken), bytes)
    library.remove(broken); library.remove(saved.id)
    assert.equal(library.list().length, 0)
    assert.equal(new PersonalLibrary(root, localPersonalOwner('recovery')).list(true).length, 2)
    assert.throws(() => library.save(originalBytes, '正常批次', data), /个人回收站/)
    library.restore(saved.id); library.restore(broken)
    assert.deepEqual(library.raw(broken), bytes)
    assert.equal(library.read(saved.id).filename, '正常批次')
    library.remove(broken); assert.deepEqual(library.raw(broken, true), bytes)
    library.purge(broken); assert.equal(library.list(true).length, 0)
    assert.throws(() => library.purge('../x'))
    assert.throws(() => library.restore('../x'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('personal imports persist across restarts, isolate users, deduplicate files and remove only their own batch', () => {
  const root = mkdtempSync(join(tmpdir(), 'masspec-personal-'))
  try {
    const a = new PersonalLibrary(root, personalOwner('tenant', 'alice')), b = new PersonalLibrary(root, personalOwner('tenant', 'bob'))
    const data = tablePackage([{ 名称: '个人标准品', CAS号: '50-00-0', 分子量: '30.026' }], 'test')
    const bytes = encodePackage(data), saved = a.save(bytes, 'personal.msldata', data)
    assert.equal(saved.duplicate, false)
    assert.equal(a.save(bytes, 'same-file.msldata', data).duplicate, true)
    assert.equal(new PersonalLibrary(root, personalOwner('tenant', 'alice')).list().length, 1)
    assert.equal(b.list().length, 0)
    assert.throws(() => b.read(saved.id))
    assert.throws(() => a.read('../other'))
    assert.equal(a.read(saved.id).data.groups[0].compound.molecular_mass, 30.026)
    a.remove(saved.id); assert.equal(a.list().length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('personal package preserves linked spectra and rejects broken relationships and malformed inputs', () => {
  const data = tablePackage([{ main_name: '测试' }], 'test')
  data.groups[0].methods = [{ localId: 'm1', q1: 100, polarity: 1 }]
  data.groups[0].spectra = [{ kind: 'numeric', peaks: [{ mz: 50, intensity: 100 }], methodLocalIds: ['m1'] }]
  const decoded = readPersonalPackage(encodePackage(data))
  const view = personalView({ id: 'batch', filename: '数据.msldata', data: decoded })
  assert.equal(view.records[0].ms[0].q1, 100)
  assert.deepEqual(view.records[0].spectra[0].peaks, [{ mz: 50, intensity: 100 }])
  assert.equal(view.manifest.personal, true)
  assert.equal(view.manifest.policy.features.review, undefined)
  data.groups[0].spectra[0].methodLocalIds = ['missing']
  assert.throws(() => encodePackage(data), /不存在的方法/)
  assert.throws(() => readPersonalPackage(Buffer.from('{"groups":[]}')))
  assert.throws(() => tablePackage([{ CAS号: '50-00-0' }], 'test'), /缺少名称/)
  assert.throws(() => tablePackage([{ 名称: '测试', 分子量: '错误' }], 'test'), /非负数值/)
})
test('personal view excludes active image payloads but retains original data for backup', () => {
  const data = tablePackage([{ main_name: '测试', formula_diagram_base64: 'data:image/svg+xml;base64,PHN2Zz4=' }], 'test')
  const view = personalView({ id: 'batch', filename: '测试', data })
  assert.equal(view.records[0].compound.formula_diagram_base64, undefined)
  assert.ok(data.groups[0].compound.formula_diagram_base64)
  assert.notEqual(personalOwner('tenantA', 'sameuser'), personalOwner('tenantB', 'sameuser'))
  assert.throws(() => new PersonalLibrary('/tmp', '../x'))
})

test('local customer workspace persists independently of server user IDs; legacy adoption and rename preserve source records', () => {
  const root = mkdtempSync(join(tmpdir(), 'masspec-local-personal-'))
  try {
    const owner = localPersonalOwner('customer-A'), legacy = new PersonalLibrary(root, personalOwner('endpoint:customer-A', 'old-user'))
    const data = tablePackage([{ 名称: '旧个人标准品', 分子量: 0 }], 'migration'), bytes = encodePackage(data)
    const { id } = legacy.save(bytes, 'legacy.msldata', data)
    const current = new PersonalLibrary(root, owner); current.adopt(legacy); current.adopt(legacy)
    assert.equal(current.list().length, 1); assert.equal(legacy.list().length, 1)
    current.rename(id, ' 新批次名 ')
    const restarted = new PersonalLibrary(root, localPersonalOwner('customer-A'))
    assert.equal(restarted.list()[0].filename, '新批次名'); assert.deepEqual(restarted.read(id).data, data)
    assert.equal(new PersonalLibrary(root, localPersonalOwner('customer-B')).list().length, 0)
    assert.throws(() => current.rename(id, '  ')); assert.throws(() => current.rename(id, 'x'.repeat(121)))
    current.remove(id); current.adopt(legacy); assert.equal(current.list().length, 0); assert.equal(legacy.list().length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

