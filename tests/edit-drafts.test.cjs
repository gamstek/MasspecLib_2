const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), http = require('node:http')
const ts = require('typescript')
const { EditDrafts } = require('../src/shared/editDrafts.mjs')
const { createLibrary } = require('../scripts/customer-delivery/file-libraries.cjs')
const { createService } = require('../scripts/customer-delivery/server.cjs')
const { Store } = require('../scripts/customer-delivery/store.cjs')

function loadModule(file, dependencies) {
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (!(name in dependencies)) throw Error('Unmocked dependency: ' + name)
    return dependencies[name]
  }, structuredClone, Buffer, console }, { filename: file })
  return module.exports
}

test('durable drafts isolate account/database/record and reject concurrent mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-draft-store-'))
  try {
    const store = new EditDrafts(root)
    store.put('admin-a', 'sql-A', '1', { kind: 'sql', payload: { title: 'draft' } })
    const reopened = new EditDrafts(root)
    assert.equal(reopened.get('admin-a', 'sql-A', '1').payload.title, 'draft')
    assert.equal(reopened.get('admin-b', 'sql-A', '1'), undefined)
    assert.equal(reopened.get('admin-a', 'sql-B', '1'), undefined)
    assert.equal(reopened.get('admin-a', 'sql-A', '2'), undefined)
    let release
    const operation = store.locked('admin-a', 'sql-A', '1', () => new Promise(resolve => { release = resolve }))
    await assert.rejects(store.locked('admin-a', 'sql-A', '1', async () => {}), /正在/)
    release(); await operation
    await assert.rejects(store.locked('admin-a', 'sql-A', '1', async () => { throw Error('failure') }), /failure/)
    await store.locked('admin-a', 'sql-A', '1', async () => store.remove('admin-a', 'sql-A', '1'))
    assert.equal(reopened.list('admin-a').length, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('two administrators: file save stays private, restart retains draft, publish changes shared data, stale publish preserves draft', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-file-draft-'))
  const store = new Store(root), server = http.createServer(createService({ directory: root, store }).handler)
  try {
    const password = 'Local-test-only-9876'
    for (const username of ['editor', 'observer']) await store.createUser({ username, password, role: 'admin' })
    const tokens = {}
    for (const username of ['editor', 'observer']) tokens[username] = (await store.login(username, password)).token
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    let actor = 'editor', session = 1, failWrite = false, dropReply = false, writeCount = 0
    const call = async (who, method, route, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
        headers: { Authorization: 'Bearer ' + tokens[who], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const data = await response.json()
      if (!response.ok) throw Error(data.error || JSON.stringify(data))
      return data
    }
    const file = path.join(root, 'incoming', 'library.sqlite')
    createLibrary(file, { title: 'Draft fixture', records: [{ id: 'test-1', compound: { main_name: 'Before' } }] })
    const registered = await call(actor, 'POST', '/admin/file-sources/register', { directory: path.dirname(file) })
    const ref = { connectionId: registered.libraryId, key: '1' }
    const delivery = {
      adminEditIdentity: () => ({ owner: actor, session }),
      fileLibraryRequest: async (method, route, input) => {
        if (route.endsWith('/update-compound') || route.endsWith('/mutate')) { writeCount++; if (failWrite) throw Error('simulated offline') }
        return call(actor, method, route, input)
      }
    }
    delivery.publicationResult = id => call(actor, 'GET', '/admin/publication/' + id)
    delivery.publishRequest = async (method, route, input, id) => {
      if (route.endsWith('/update-compound') || route.endsWith('/mutate')) { writeCount++; if (failWrite) throw Error('simulated offline') }
      const result = await call(actor, 'POST', '/admin/publication/' + id, { method, route, body: input }); if (dropReply) { dropReply = false; throw Error('lost-publication-reply') }; return result
    }
    const fileAPI = loadModule(path.join(__dirname, '../src/main/services/fileLibrary.ts'), {
      '../../shared/adminWorkspace.mjs': require('../src/shared/adminWorkspace.mjs'), './adminWorkspace': { adminWorkspace: () => undefined },
      '../../shared/fileRecordTransfer': { lcForEditor: lc => lc }, '../delivery': delivery,
      '../federation/registry': { getState: () => ({ favorites: [] }) }, '../../shared/federation': { refKey: ref => JSON.stringify(ref) }
    })
    const dependencies = { electron: { app: { getPath: () => path.join(root, 'client') } }, 'node:path': path, 'node:fs': fs, 'node:crypto': require('node:crypto'),
      '../../shared/editDrafts.mjs': { EditDrafts }, '../delivery': delivery, '../federation/registry': {}, '../federation/adapters': {}, '../database': {},
      './fileLibrary': fileAPI, '../../shared/fileRecordTransfer': { lcForEditor: lc => lc, lcForWorkspace: lc => lc } }
    const reopen = () => loadModule(path.join(__dirname, '../src/main/services/editDrafts.ts'), dependencies)
    let api = reopen()
    const published = await fileAPI.fileDetail(ref)
    await api.saveFileDraft({ ref, revision: published.compound.fileRevision, compound: { main_name: 'Private draft' } }, 'file-basic')
    assert.equal(writeCount, 0)
    assert.equal((await fileAPI.fileDetail(ref)).compound.main_name, 'Before')
    assert.equal(api.draftView(ref, published).compound.main_name, 'Private draft')
    api = reopen()
    assert.equal(api.listEditDrafts().length, 1)
    actor = 'observer'; session++
    assert.equal(api.listEditDrafts().length, 0)
    assert.equal(api.draftView(ref, await fileAPI.fileDetail(ref)).compound.main_name, 'Before')
    actor = 'editor'; session++
    failWrite = true
    await assert.rejects(api.publishEditDraft(ref), /offline/)
    assert.equal(api.listEditDrafts().length, 1)
    failWrite = false
    await api.publishEditDraft(ref)
    assert.equal(api.listEditDrafts().length, 0)
    actor = 'observer'; session++
    assert.equal((await fileAPI.fileDetail(ref)).compound.main_name, 'Private draft')
    const baseline = await fileAPI.fileDetail(ref)
    await api.saveFileDraft({ ref, revision: baseline.compound.fileRevision, compound: { main_name: 'Observer draft' } }, 'file-basic')
    actor = 'editor'; session++
    await api.saveFileDraft({ ref, revision: baseline.compound.fileRevision, compound: { main_name: 'Editor publication' } }, 'file-basic')
    await api.publishEditDraft(ref)
    actor = 'observer'; session++
    await assert.rejects(api.publishEditDraft(ref), /正式数据已被修改/)
    assert.equal(api.draftView(ref, await fileAPI.fileDetail(ref)).compound.draftConflict, true)
    assert.equal(api.listEditDrafts().length, 1)
    await api.discardEditDraft(ref)
    assert.equal((await fileAPI.fileDetail(ref)).compound.main_name, 'Editor publication')

    // Exercise the actual LDS workspace update route too, including basic -> full -> basic edits.
    const { DatabaseSync } = require('node:sqlite')
    const ldsFile = path.join(root, 'minimal-lds.sqlite'), db = new DatabaseSync(ldsFile)
    for (const sql of Object.values(require('./fixtures/lds-cn-schema.json'))) db.exec(sql)
    db.exec(`INSERT INTO 构建信息 VALUES('complete','true'); INSERT INTO 构建信息 VALUES('verified_peak_rows','0');
      INSERT INTO 化合物(化合物ID,身份键,身份状态,对象类型,化合物名称,来源名称与结构JSON,字段来源JSON)
      VALUES(1,'draft-fixture','structure_consistent','test','LDS Before','{}','{}'),(2,'draft-fixture-2','structure_consistent','test','LDS Second','{}','{}')`)
    db.close()
    actor = 'editor'; session++
    const lds = await call(actor, 'POST', '/admin/file-sources/register', { directory: ldsFile })
    const ldsRef = { connectionId: lds.libraryId, key: '1' }, ldsDetail = await fileAPI.fileDetail(ldsRef)
    await api.saveFileDraft({ ref: ldsRef, revision: ldsDetail.compound.fileRevision, compound: { main_name: 'LDS Basic draft' } }, 'file-basic')
    const full = structuredClone(api.draftView(ldsRef, ldsDetail).extensions.fileRecord)
    full.compound.main_name = 'LDS Full draft'
    full.ms = [{ id: 'draft-method', ms_mode: 'Fixture', q1: 100, q3: 50, ce: 5, polarity: 1 }]
    await api.saveFileDraft({ ref: ldsRef, revision: ldsDetail.compound.fileRevision, record: full }, 'file-workspace')
    await api.saveFileDraft({ ref: ldsRef, revision: ldsDetail.compound.fileRevision, compound: { main_name: 'LDS Final draft' } }, 'file-basic')
    const sibling = { ...ldsRef, key: '2' }
    await api.saveFileDraft({ ref: sibling, revision: ldsDetail.compound.fileRevision, compound: { main_name: 'LDS Second draft' } }, 'file-basic')
    actor = 'observer'; session++
    assert.equal((await fileAPI.fileDetail(ldsRef)).compound.main_name, 'LDS Before')
    actor = 'editor'; session++
    await api.publishEditDraft(ldsRef)
    await api.publishEditDraft(sibling)
    actor = 'observer'; session++
    assert.equal((await fileAPI.fileDetail(ldsRef)).compound.main_name, 'LDS Final draft')
    assert.equal((await fileAPI.fileDetail(ldsRef)).methods[0].methods[0].q1, 100)
    assert.equal((await fileAPI.fileDetail(sibling)).compound.main_name, 'LDS Second draft')
    actor = 'editor'; session++
    const retryBaseline = await fileAPI.fileDetail(ref)
    await api.saveFileDraft({ref, revision:retryBaseline.compound.fileRevision, compound:{main_name:'Reply recovery'}},'file-basic')
    dropReply = true
    await assert.rejects(api.publishEditDraft(ref), /lost-publication-reply/)
    assert.equal((await fileAPI.fileDetail(ref)).compound.main_name,'Reply recovery')
    assert.equal((await api.publishEditDraft(ref)).recoveredPublication,true)
    const orphanBase = await fileAPI.fileDetail(ref)
    await api.saveFileDraft({ref,revision:orphanBase.compound.fileRevision,compound:{main_name:'Orphan retained'}},'file-basic')
    await call(actor,'POST','/admin/file-sources/delete-database',{libraryId:ref.connectionId,password})
    assert.equal(api.inspectEditDraft(ref).compound.main_name,'Orphan retained')
    await api.discardEditDraft(ref)
    assert.equal(api.listEditDrafts().some(d => d.ref.connectionId === ref.connectionId),false)
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }) }
})

test('SQL draft saves do not write, repeated edits keep deleted method baseline, publish failures retain draft', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-sql-draft-'))
  try {
    let actor = 'editor', writes = 0, fail = false
    const ref = { connectionId: 'sql-1', key: '7' }
    const official = { compound: { id: 7, ref, revision: 3, main_name: 'Before', schemaVersion: 4, readOnly: false },
      methods: [{ methods: [{ id: 10 }, { id: 11 }] }], lcMethods: [], classes: [], extensions: { classifications: [] } }
    const api = loadModule(path.join(__dirname, '../src/main/services/editDrafts.ts'), {
      electron: { app: { getPath: () => root } }, 'node:path': path, 'node:fs': fs, 'node:crypto': require('node:crypto'), '../../shared/editDrafts.mjs': { EditDrafts },
      '../delivery': { adminEditIdentity: () => ({ owner: actor, session: 1 }) },
      '../federation/registry': { connection: () => ({ host: 'localhost', port: 3306, database: 'test' }) },
      '../federation/adapters': { detail: async () => structuredClone(official) },
      '../database': { withDatabase: async (_id, _write, fn) => fn() }, './fileLibrary': { isFileRef: () => false },
      '../../shared/fileRecordTransfer': {}, './compoundDetails': { savedSqlPublication: async () => null, saveCompoundDetails: async payload => {
        writes++; if (fail) return { success: false, error: 'transaction failed' }
        assert.deepEqual(Array.from(payload.deletedMsMethodIds).sort((a,b)=>a-b), [10, 11])
        official.compound = { ...payload.compound, revision: payload.compound.revision + 1 }
        return { success: true }
      } }
    })
    const input = { compound: { ...official.compound, main_name: 'First' }, compoundMsMethodList: [{ methods: [{ id: 11 }] }], compoundLcMethodList: [],
      classIdList: [], customClassIdList: [], deletedMsMethodIds: [10], deletedLcMethodIds: [], extensions: { classifications: [] } }
    await api.saveSqlDraft(ref, input)
    const again = { ...input, compound: { ...input.compound, main_name: 'Second' }, compoundMsMethodList: [], deletedMsMethodIds: [11] }
    await api.saveSqlDraft(ref, again)
    assert.equal(writes, 0)
    actor = 'observer'
    assert.equal(api.draftView(ref, official).compound.main_name, 'Before')
    actor = 'editor'
    fail = true
    await assert.rejects(api.publishEditDraft(ref), /transaction failed/)
    assert.equal(api.listEditDrafts().length, 1)
    fail = false
    await api.publishEditDraft(ref)
    assert.equal(official.compound.main_name, 'Second')
    assert.equal(official.compound.revision, 4)
    assert.equal(api.listEditDrafts().length, 0)
    await api.saveSqlDraft(ref, { ...again, compound: { ...official.compound, main_name: 'Conflict' } })
    official.compound.revision++
    await assert.rejects(api.publishEditDraft(ref), /正式数据已被修改/)
    assert.equal(api.listEditDrafts().length, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('SQL edit IPC stages the scoped record and never executes the old shared save handler', async () => {
  let selected, legacyWrites = 0, loggedIn = true
  const handlers = new Map(), ipc = { handle: (channel, fn) => handlers.set(channel, fn) }
  const module = loadModule(path.join(__dirname, '../src/main/federation/ipcScope.ts'), {
    '../services/pendingChanges': { stageChange: async () => undefined, registerPublishHandler() {} },
    '../database': { withDatabase: async (_id, _write, fn) => fn() },
    '../delivery': { administratorLoggedIn: () => loggedIn, deliveryProfile: () => ({ edition: 'admin' }) }, './registry': { getState: () => ({ primaryId: 'primary' }) },
    '../services/editDrafts': { saveSqlDraft: async (ref, input) => { if (!loggedIn) throw Error('请先登录管理员'); selected = { ref, input }; return { success: true, draft: true } } }
  })
  module.installScopedIPC(ipc)
  ipc.handle('compound:update', () => { legacyWrites++ })
  const result = await handlers.get('compound:update')({}, { __scope: 'masspeclib2', connectionId: 'explicit-library', args: [{ compound: { id: 42 } }] })
  assert.equal(result.draft, true)
  assert.equal(selected.ref.connectionId, 'explicit-library')
  assert.equal(selected.ref.key, '42')
  assert.equal(legacyWrites, 0)
  loggedIn = false
  await assert.rejects(handlers.get('compound:update')({}, { compound: { id: 42 } }), /请先登录管理员/)
  assert.equal(legacyWrites, 0)
})
