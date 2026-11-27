const assert = require('node:assert/strict')
const { createHash, generateKeyPairSync, randomUUID, verify } = require('node:crypto')
const { createServer } = require('node:http')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { createService } = require('./server.cjs')
const { Store } = require('./store.cjs')
const { CredentialVault } = require('./credential-vault.cjs')
const { LocalRecordTrash } = require('../../src/shared/localRecordTrash.mjs')
const { openIndexedOffline } = require('../../src/shared/indexedOffline.mjs')
const { OfflineWorkspace } = require('../../src/shared/offlineWorkspace.mjs')
const { packageStreamFormat, packageStreamType, savePackageStream } = require('../../src/shared/deliveryPackageStream.mjs')
const { decryptOffline } = require('../../src/shared/offlineAccess.mjs')

const sha = data => createHash('sha256').update(data).digest('hex')
test('customer MSI preparation streams indexed data while old administrators can still request the legacy format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'masspec-indexed-test-'))
  const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' })
  const store = new Store(root), credentialKeyFile = join(root, 'test.key'), templateFile = join(root, 'template.zip')
  const password = 'test-password', username = 'offline-customer', releaseId = randomUUID()
  const admin = await store.createUser({ username: 'test-admin', password, role: 'admin' })
  const login = await store.login(admin.username, password)
  const { tenantId, access } = await store.createAccessCredentials({ customerName: 'Indexed test', mode: 'offline',
    username, password, passwordConfirm: password }, admin.id, new CredentialVault(credentialKeyFile))
  const snap = join(root, 'datasets', releaseId)
  mkdirSync(snap, { recursive: true })
  const rows = []
  for (let i = 0; i < 107; i++) {
    const id = sha(String(i)).slice(0, 32), stableId = 'stable-' + i
    const row = { id, stableId, sourceKey: 'test', sourceTitle: 'Test', compound: { main_name: 'Compound ' + i } }
    const detail = { ...row, ms: [{ q1: 100+i, polarity: i%2 }], lc: [{ retention_time: 150, retention_time_unit: 's', gradient: [{ time: 2 }] }],
      spectra: [{ collision_energy: 25, peaks: [[10, 100], [15, 500]] }], checks: [{ id: 'c', abnormal: i === 50 }] }
    const raw = JSON.stringify(detail)
    writeFileSync(join(snap, id + '.json'), raw)
    rows.push({ ...row, sha256: sha(raw) })
  }
  const index = JSON.stringify(rows)
  writeFileSync(join(snap, 'index.json'), index)
  writeFileSync(templateFile, 'test template')
  writeFileSync(templateFile + '.indexed.json', JSON.stringify({ sha256: sha('test template'), version: '2.8.64' }))
  store.data.releases.push({ id: releaseId, indexHash: sha(index), tenantId, state: 'published', expiresAt: null, access,
    total: rows.length, version: '1', policy: { presentation: { listFields: ['compound.main_name', 'lc.retention_time'] },
      fields: { compound: ['main_name'], ms: ['q1', 'polarity'], lc: ['retention_time', 'retention_time_unit', 'gradient'], spectrum: ['peaks'] },
      features: { offline: true, export: true, spectra: true, lc: true, checks: true } } })
  const service = createService({ directory: root, credentialKeyFile, templateFile, privateKey: pair.privateKey, publicKey, store })
  const server = createServer(service.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const request = format => fetch(`http://127.0.0.1:${server.address().port}/admin/releases/${releaseId}/package`, {
    method: 'POST', headers: { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' },
    body: JSON.stringify(format ? { format } : {})
  })
  const file = join(root, 'offline.msldelivery')
  let reader
  try {
    const response = await request(packageStreamFormat)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), packageStreamType)
    const metadata = await savePackageStream(response.body, file, envelope => {
      assert.ok(verify(null, Buffer.from(JSON.stringify(envelope.payload)), publicKey, Buffer.from(envelope.signature, 'base64')))
      return envelope.payload
    })
    assert.equal(metadata.profile.version, '2.8.64')
    assert.equal(metadata.offlineSha256, sha(readFileSync(file)))
    await assert.rejects(openIndexedOffline(file, publicKey, 'wrong-tenant'), /不属于/)
    reader = await openIndexedOffline(file, publicKey, tenantId)
    await assert.rejects(reader.unlock(username, 'wrong-password'), /密码/)
    const session = await reader.unlock(username, password)
    assert.equal(session.records, undefined)
    assert.deepEqual(session.manifest.methodQueryFields, ['q1', 'polarity'])
    const trash = new LocalRecordTrash(root, tenantId)
    const workspace = new OfflineWorkspace({ manifest: session.manifest, rows: reader.rows, list: reader.list, detail: reader.detail, trash })
    const page = await workspace.page({ page: 2 })
    assert.equal(page.rows.length, 50)
    assert.equal(page.rows[0].compound.main_name, 'Compound 50')
    assert.equal(page.rows[0].spectra, undefined)
    assert.equal(page.rows[0].lc[0].retention_time, 150)
    assert.equal(page.rows[0].lc[0].gradient, undefined)
    assert.equal((await workspace.page({ page: 3 })).rows.length, 7)
    const result = await workspace.page({ q1: 150, abnormal: true, recordIds: [rows[50].id] })
    assert.deepEqual(result.matchedIds, [rows[50].id])
    const row = await workspace.find(rows[50].id)
    const detail = await reader.detail(row)
    assert.deepEqual(detail.spectra[0].peaks, [[10, 100], [15, 500]])
    assert.deepEqual(detail.lc[0].gradient, [{ time: 2 }])
    await workspace.change('delete', [row.id])
    assert.equal((await workspace.page({})).total, 106)
    assert.equal((await workspace.page({ trash: true })).rows[0].id, row.id)
    await workspace.change('restore', [row.id])
    assert.equal((await workspace.page({})).total, 107)

    const offset = reader.bodyOffset + row.detail[0] + 30
    const corrupted = readFileSync(file)
    corrupted[offset] ^= 1
    const bad = join(root, 'corrupted.msldelivery')
    writeFileSync(bad, corrupted)
    const forged = await openIndexedOffline(bad, publicKey, tenantId)
    try {
      await forged.unlock(username, password)
      await assert.rejects(forged.detail(row), /校验失败/)
    } finally { await forged.close() }
    const old = await (await request()).json()
    assert.equal(old.payload.offline.payload.formatVersion, 2)
    assert.equal((await decryptOffline(old.payload.offline, username, password, publicKey, tenantId)).records.length, 107)
    assert.equal(readdirSync(root).some(name => name.startsWith('.indexed-package-')), false)
  } finally {
    await reader?.close()
    await new Promise(resolve => server.close(resolve))
    service.closeUpdates()
    rmSync(root, { recursive: true, force: true })
  }
})
