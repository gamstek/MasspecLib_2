const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { createService } = require('./server.cjs')
const { Store } = require('./store.cjs')
const { FileLibraries } = require('./file-libraries.cjs')
const { fixture } = require('../../tests/fixtures/lds-fixture.cjs')

test('admin sign-ins share one explicit configuration and reject a missing or invalid one', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'masspec-admin-workspace-'))
  const store = new Store(directory)
  const sql = 'mspec_lib2_shared_ff143ed6f54e6f0e7b85'
  const connect = async () => ({
    query: async (_statement, [key]) => [key === sql ? [{ id: 'fixture' }] : []],
    end: async () => {}
  })
  const server = http.createServer(createService({ directory, store, connect }).handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const token = async username => {
      const password = 'test-password-123'
      await store.createUser({ username, password, role: 'admin' })
      return (await store.login(username, password)).token
    }
    const first = await token('admin-first')
    const second = await token('admin-second')
    const get = async token => {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/admin/workspace`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      return [result.status, await result.json()]
    }
    assert.equal((await get('invalid'))[0], 401)
    assert.equal((await get(first))[0], 503)
    const config = {
      schemaVersion: 1, libraries: ['mspec_lib2_shared_ff143ed6f54e6f0e7b85'],
      defaultLibrary: 'mspec_lib2_shared_ff143ed6f54e6f0e7b85',
      columns: ['name_en', 'cas', 'formula', 'ionModes', 'mrm1'],
      pageSize: 50, navigationWidth: 235, expandedCategories: [], openMenus: ['databases']
    }
    const file = path.join(directory, 'admin-workspace.json')
    fs.writeFileSync(file, JSON.stringify(config))
    assert.deepEqual(await get(first), [200, config])
    assert.deepEqual(await get(second), [200, config])
    const base = 'http://127.0.0.1:' + server.address().port
    const change = async (auth, key, removed) => fetch(base + '/admin/workspace/library-visibility', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, removed })
    })
    const files = new FileLibraries(path.join(directory, 'source-libraries'))
    const source = fixture(directory)
    const { libraryId } = files.register(source)
    fs.unlinkSync(source)
    assert.equal(files.list()[0].status, 'error')
    assert.equal((await change('invalid', libraryId, true)).status, 401)
    assert.equal((await change(first, libraryId, true)).status, 200)
    const list = async (query = '') => (await (await fetch(base + '/admin/file-sources' + query, {
      headers: { Authorization: 'Bearer ' + second }
    })).json()).libraries
    assert.deepEqual(await list(), [])
    assert.equal((await list('?includeRemoved=1'))[0].libraryId, libraryId)
    assert.equal(files.entry(libraryId).origin, source)
    assert.equal((await change(first, sql, true)).status, 200)
    const [status, empty] = await get(second)
    assert.equal(status, 200)
    assert.deepEqual(empty.libraries, [])
    assert.equal(empty.defaultLibrary, null)
    assert.equal((await change(second, sql, false)).status, 200)
    assert.equal((await get(first))[1].defaultLibrary, sql)
    assert.equal((await change(second, libraryId, false)).status, 200)
    assert.equal((await list())[0].status, 'error')
    fs.writeFileSync(file, '{"schemaVersion":99}')
    assert.equal((await get(first))[0], 503)
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
