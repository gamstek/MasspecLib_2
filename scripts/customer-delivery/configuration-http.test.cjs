const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http')
const { Store } = require('./store.cjs'), { createService } = require('./server.cjs')
test('HTTP enforces startup access at build, publication and packaging; full configuration is recoverable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-config-http-'))
  const store = new Store(directory), pair = crypto.generateKeyPairSync('ed25519')
  await store.createUser({ username: 'test_admin', password: 'test-password', role: 'admin' })
  const account = await store.createUser({ username: 'test_customer', password: 'test-password', customerName: '客户甲' })
  const token = (await store.login('test_admin', 'test-password')).token
  const templateFile = path.join(directory, 'client-template.zip'); fs.writeFileSync(templateFile, 'test-template')
  const service = createService({ directory, store, templateFile, connect: null, engine: null, privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) })
  service.builder.index = () => []
  service.builder.build = async input => ({ id: crypto.randomUUID(), title: input.title, version: input.version, createdAt: new Date().toISOString(), total: 1, origins: [], sources: [], policy: input.policy })
  const server = http.createServer(service.handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  try {
    const input = { customerName: '客户甲', tenantId: account.tenantId, deliveryAt: '2026-10-28T00:00:00Z', notes: '真实配置', expiresAt: '2099-01-01T00:00:00Z', selections: [{ libraryId: 'lib1', keyword: 'abc', classIds: [2] }], policy: { fields: { compound: ['main_name'] }, features: {} }, access: { mode: 'online', userId: account.id } }
    assert.equal((await api('/admin/releases', 'POST', { ...input, access: null })).status, 400)
    const legacy = { ...input }; delete legacy.access; delete legacy.deliveryAt
    const upgrade = await api('/admin/releases', 'POST', legacy)
    assert.equal(upgrade.status, 409); assert.match(upgrade.data.error, /升级管理员端/)
    const result = await api('/admin/releases', 'POST', input); assert.equal(result.status, 202)
    for (let i = 0; i < 100 && service.jobs.get(result.data.id).state === 'building'; i++) await new Promise(r => setTimeout(r, 5))
    const job = service.jobs.get(result.data.id); assert.equal(job.state, 'ready')
    const id = job.releaseId, config = (await api(`/admin/releases/${id}/configuration`)).data
    assert.equal(config.notes, input.notes); assert.equal(config.expiresAt, '2099-01-01T00:00:00.000Z'); assert.deepEqual(config.selections, input.selections); assert.deepEqual(config.access, input.access)
    const customer = store.data.users.find(u => u.id === account.id)
    customer.disabled = true
    assert.equal((await api(`/admin/releases/${id}/publish`, 'POST', {})).status, 400)
    customer.disabled = false
    assert.equal((await api(`/admin/releases/${id}/publish`, 'POST', {})).status, 200)
    store.data.releases[0].policy.features.offline = true
    store.data.releases[0].policy.features.export = true
    const packaged = await api(`/admin/releases/${id}/package`, 'POST', {})
    assert.equal(packaged.status, 409)
    assert.match(packaged.data.error, /重新配置/)
    customer.disabled = true
    assert.equal((await api(`/admin/releases/${id}/package`, 'POST', {})).status, 409)
    assert.equal((await api(`/admin/releases/${id}/delete`, 'POST', {})).status, 200)
    assert.equal((await api(`/admin/releases/${id}/configuration`)).status, 200)
    assert.equal(store.data.releases[0].state, 'deleted')
  } finally { await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }) }
})
