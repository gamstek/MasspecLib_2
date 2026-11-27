const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http')
const { normalizePolicy, templates, raster, points } = require('./policy.cjs'), { Store } = require('./store.cjs'), { clean, measurement, ratio, SnapshotBuilder } = require('./snapshot.cjs'), { createService } = require('./server.cjs')
function directory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'masspec-delivery-test-')) }
test('new source parameter choices project only authorized typed values and retain MRM numbering separately from roles', () => {
  const policy = normalizePolicy({ fields: { compound: ['main_name'], ms: ['cur', 'transition_label', 'transition_role'] }, features: { spectra: true } })
  const row = clean({ transition_role: 'qualifier', conditions: { transition_label: 'MRM5', ion_source_parameters_raw: 'CUR 30，GS1 50', private: 'secret' } }, policy.fields.ms)
  assert.deepEqual(row.cur, { value: 30, unit: 'psi', unit_source: 'default' }); assert.equal(row.transition_label, 'MRM5'); assert.equal(row.transition_role, 'qualifier')
  assert.equal(row.ion_source_parameters_raw, undefined); assert.equal(row.gs1, undefined); assert.equal(row.conditions, undefined)
})
test('personal import and export are independently configurable', () => {
  const base = { fields: { compound: ['main_name'] } }
  assert.equal(normalizePolicy(base).features.personalImport, false)
  const policy = normalizePolicy({ ...base, features: { personalImport: true } })
  assert.equal(policy.features.personalImport, true); assert.equal(policy.features.export, false)
  assert.equal(policy.features.checks, false)
})
test('all delivery templates are valid and contain a display name', () => { for (const t of templates) assert(normalizePolicy(t.policy).fields.compound.includes('main_name')) })
test('unknown compound fields and raw JSON fields cannot be published', () => { for (const field of ['raw', 'properties', 'password', '__proto__', 'identifiers']) assert.throws(() => normalizePolicy({ fields: { compound: ['main_name', field] } })) })
test('hidden feature clears its fields before materialization', () => { const p = normalizePolicy({ fields: { compound: ['main_name'], ms: ['q1'], spectrum: ['peaks'] } }); assert.deepEqual(p.fields.ms, []); assert.deepEqual(p.fields.spectrum, []) })
test('review and offline dependencies are enforced', () => { assert.throws(() => normalizePolicy({ fields: { compound: ['main_name'] }, features: { review: true } })); assert.throws(() => normalizePolicy({ fields: { compound: ['main_name'] }, features: { offline: true } })) })
test('peak checking requires numerical data, not pictures', () => { assert.throws(() => normalizePolicy({ fields: { compound: ['main_name'], chromatogram: ['image_base64'] }, features: { checks: true, chromatograms: true } })) })
test('projection removes nested and top-level private fields', () => {
  const value = clean({ main_name: 'public', raw: 'private', peaks: [{ mz: 1, intensity: 2, secret: 'never' }], collision_energy: { value: 20, unit: 'eV', private: 'never' } }, ['main_name', 'peaks', 'collision_energy'])
  assert.equal(JSON.stringify(value).includes('never'), false); assert.deepEqual(value.peaks, [{ mz: 1, intensity: 2 }]); assert.deepEqual(value.collision_energy, { value: 20, unit: 'eV' })
})
test('only raster data images enter delivery documents', () => { assert.equal(raster('data:image/svg+xml;base64,AAAA'), null); assert.equal(raster('https://example.com/a.png'), null); assert.equal(raster('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA') })
test('trace point projection excludes arbitrary metadata and invalid numbers', () => { assert.deepEqual(points([{ time: 1, intensity: 2, path: '/private' }], 'time'), [{ time: 1, intensity: 2 }]); assert.deepEqual(points([{ time: 1, intensity: 2 }, { time: 'oops', intensity: 2 }], 'time'), []); assert.deepEqual(points([{ time: null, intensity: 2 }], 'time'), []); assert.deepEqual(points([{ time: 2, intensity: 1 }, { time: 1, intensity: 2 }], 'time'), []) })
test('measurement and ratio projection use fixed fields', () => { assert.deepEqual(measurement({ value: 10, unit: 'mg/kg', raw: 'never' }), { value: 10, unit: 'mg/kg' }); assert.deepEqual(ratio({ reference: 0.5, secret: 'never' }), { reference: 0.5 }) })
test('compound selection cannot inject SQL', () => { const b = new SnapshotBuilder(null, directory(), null); assert.throws(() => b.selection({ onlySelected: true, compoundIds: ['1) OR 1=1'] })); assert.throws(() => b.selection({ classIds: [-1] })); assert.throws(() => b.selection({ onlySelected: true })); const s = b.selection({ keyword: "%' OR 1=1 --", classIds: [2], onlySelected: true, compoundIds: [1] }); assert.equal(s.where.includes("%' OR"), false); assert(s.params.includes("%%' OR 1=1 --%")); fs.rmSync(b.directory, { recursive: true }) })
test('customer sessions bind tenant and auth version; revocation and persistence work', async () => {
  const dir = directory(), store = new Store(dir)
  try {
    const a = await store.createUser({ username: 'customer_a', customerName: 'A', password: 'test-password-a' }), b = await store.createUser({ username: 'customer_b', customerName: 'B', password: 'test-password-b' })
    await assert.rejects(() => store.login('customer_a', 'test-password-a', true, b.tenantId))
    const login = await store.login('customer_a', 'test-password-a', true, a.tenantId), user = store.authenticate(login.token)
    assert.equal(user.tenantId, a.tenantId)
    assert.equal(fs.readFileSync(store.file, 'utf8').includes(login.token), false)
    const release = { id: crypto.randomUUID(), tenantId: a.tenantId, state: 'published', expiresAt: null }
    await store.mutate(d => d.releases.push(release))
    assert.equal(store.authorize(user, release.id), release); assert.throws(() => store.authorize(store.data.users.find(u => u.id === b.id), release.id))
    release.state = 'revoked'; assert.throws(() => store.authorize(user, release.id)); release.state = 'published'; release.expiresAt = new Date(Date.now() - 1).toISOString(); assert.throws(() => store.authorize(user, release.id))
    const restored = new Store(dir); assert.equal(restored.authenticate(login.token).id, a.id)
    user.authVersion++; assert.throws(() => store.authenticate(login.token))
    await store.logout(login.token); assert.equal(store.data.sessions.length, 0)
  } finally { fs.rmSync(dir, { recursive: true }) }
})
test('failed mutations roll back and concurrent duplicate accounts are rejected', async () => {
  const dir = directory(), store = new Store(dir)
  try {
    await assert.rejects(() => store.mutate(d => { d.tenants.push({ id: 'bad' }); throw new Error('rollback') })); assert.equal(store.data.tenants.length, 0)
    const results = await Promise.allSettled([store.createUser({ username: 'same_user', customerName: 'A', password: 'test-password' }), store.createUser({ username: 'same_user', customerName: 'B', password: 'test-password' })]); assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(store.data.users.length, 1)
  } finally { fs.rmSync(dir, { recursive: true }) }
})
test('HTTP authorization blocks admin routes, expired sessions and other customer releases', async () => {
  const dir = directory(), store = new Store(dir), pair = crypto.generateKeyPairSync('ed25519')
  const a = await store.createUser({ username: 'customer_a', customerName: 'A', password: 'test-password-a' }), b = await store.createUser({ username: 'customer_b', customerName: 'B', password: 'test-password-b' })
  const login = await store.login('customer_a', 'test-password-a', true)
  const ownId = crypto.randomUUID(), otherId = crypto.randomUUID()
  const index = JSON.stringify([{ sourceKey: 'own-source', compound: { main_name: '甲', name_zh: '甲', name_en: 'Alpha', cas: null } }])
  fs.mkdirSync(path.join(dir, 'datasets', ownId), { recursive: true }); fs.writeFileSync(path.join(dir, 'datasets', ownId, 'index.json'), index)
  store.data.releases.push({ id: ownId, indexHash: crypto.createHash('sha256').update(index).digest('hex'), tenantId: a.tenantId, state: 'published', expiresAt: null, policy: { fields: { compound: ['main_name', 'name_zh', 'name_en', 'cas'] }, features: { export: false, review: false } } }, { id: otherId, tenantId: b.tenantId, state: 'published', expiresAt: null })
  const service = createService({ directory: dir, connect: null, engine: null, privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), store }), server = http.createServer(service.handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port
  const query = (route, method = 'GET', token = login.token) => fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token } })
  try {
    assert.equal((await query('/admin/state')).status, 403); assert.equal((await query('/schema')).status, 403)
    const releases = await (await query('/releases')).json(); assert.deepEqual(releases.map(r => r.id), [ownId])
    assert.deepEqual(releases[0].compoundDisplay, { all: ['main_name', 'name_en'], sources: { 'own-source': ['main_name', 'name_en'] } })
    for (const route of [`/releases/${otherId}/records`, `/releases/${otherId}/records/abc`, `/releases/${otherId}/offline`]) assert.equal((await query(route)).status, 403)
    assert.equal((await query(`/releases/${ownId}/export`, 'POST')).status, 403); assert.equal((await query(`/releases/${ownId}/review/abc`, 'POST')).status, 403)
    assert.equal((await query('/me', 'GET', 'forged-token')).status, 401)
    store.data.users.find(u => u.id === a.id).disabled = true; assert.equal((await query('/me')).status, 401)
  } finally { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true }) }
})
