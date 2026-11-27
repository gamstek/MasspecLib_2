const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { fixture } = require('./fixtures/lds-fixture.cjs')
const { FileLibraries } = require('../scripts/customer-delivery/file-libraries.cjs')
const { createService } = require('../scripts/customer-delivery/server.cjs')
const { hash } = require('../scripts/customer-delivery/massbank-record.cjs')

const key = 'KWILGNNWGSNMPA-UHFFFAOYSA-N'
function source(suffix, name, inchikey, intensity = 55) {
  const accession = 'MSBNK-AAFC-' + suffix
  const text = [
    'ACCESSION: ' + accession, 'CH$NAME: ' + name, 'CH$LINK: INCHIKEY ' + inchikey,
    'AC$MASS_SPECTROMETRY: MS_TYPE MS2', 'AC$MASS_SPECTROMETRY: ION_MODE POSITIVE',
    'AC$MASS_SPECTROMETRY: COLLISION_ENERGY 10(NCE)', 'MS$FOCUSED_ION: PRECURSOR_M/Z 179.07',
    'MS$FOCUSED_ION: PRECURSOR_TYPE [M+H]+', 'PK$NUM_PEAK: 1', 'PK$PEAK: m/z int. rel.int.',
    '  101.0 ' + intensity + ' 999', '//', ''
  ].join('\n')
  return { accession, sha256: hash(text), text }
}

test('MassBank compares the target and publishes selected additions once without replacing existing records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'massbank-pilot-'))
  const file = fixture(root)
  const base = new DatabaseSync(file)
  base.prepare('UPDATE 化合物 SET 结构标识=? WHERE 化合物ID=2').run(key)
  const removed = source('REMOVED', 'Removed', key)
  base.prepare('UPDATE 来源记录 SET 来源JSON=? WHERE 来源记录ID=1').run(JSON.stringify({ source_record_id: removed.accession }))
  base.close()
  const original = hash(fs.readFileSync(file))
  const libraryRoot = path.join(root, 'source-libraries'), files = new FileLibraries(libraryRoot)
  const entry = files.register(file), libraryId = entry.libraryId
  files.mutate({ libraryId, action: 'delete', id: 1, revision: entry.revision })
  const records = [source('ATTACH', 'Mellein', key), source('NEW', 'New sample', 'AAAAAAAAAAAAAA-BBBBBBBBBB-C'), removed]
  const commit = 'a'.repeat(40)
  const stash = path.join(root, 'massbank-pilot')
  fs.mkdirSync(stash)
  const save = () => fs.writeFileSync(path.join(stash, 'snapshot.json'), JSON.stringify({ commit, version: '2026.03', records }))
  save()
  const store = { data: {}, authenticate(token) {
    if (token === 'a' || token === 'b') return { id: token, role: 'admin' }
    return { id: token, role: 'customer' }
  }, mutate: async fn => fn(), event() {} }
  const server = http.createServer(createService({ directory: root, fileLibraryRoot: libraryRoot, store,
    requirePublication: true, massbankPilot: { libraryId, downloader: '' } }).handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const prefix = '/admin/massbank-update/'
  const call = async (route, body, token = 'a') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer ' + token }
    })
    return { status: response.status, data: await response.json() }
  }
  try {
    assert.equal((await call(prefix + 'compare', { libraryId }, 'customer')).status, 403)
    assert.equal((await call(prefix + 'status', { libraryId: 'another-library' })).data.enabled, false)
    const { data: status } = await call(prefix + 'status', {})
    assert.equal(status.libraryId, libraryId)
    assert.equal(status.libraryName, entry.title)
    assert.equal((await call(prefix + 'publish', { libraryId })).status, 409)
    const { data: preview } = await call(prefix + 'compare', { libraryId }, 'b')
    assert.deepEqual(preview.rows.map(row => row.status), ['attach', 'new', 'review'])
    const read = async () => (await call('/admin/file-sources/record', { libraryId, id: 2 }, 'b')).data.record
    assert.equal((await read()).spectra.length, 1)
    const body = { libraryId, commit, revision: preview.revision, selected: records.slice(0, 2).map(r => r.accession) }
    const publication = input => ({ method: 'POST', route: prefix + 'publish', body: input })
    const published = await call('/admin/publication/' + randomUUID(), publication(body))
    assert.equal(published.status, 200, JSON.stringify(published))
    assert.equal(published.data.changed, 2)
    assert.equal(published.data.addedSpectra, 2)
    const detail = await read()
    assert.equal(detail.compound.main_name, 'Compound 2')
    assert.deepEqual(detail.spectra.map(s => s.id), ['spectrum:10', 'massbank:' + records[0].accession])
    assert.equal(detail.spectra[1].collision_energy.unit, 'NCE')
    assert.equal((await call('/admin/publication/' + randomUUID(), publication(body))).data.duplicate, true)
    assert.equal((await call('/admin/publication/' + randomUUID(), publication({ ...body, selected: [records[1].accession] }))).status, 409)
    assert.deepEqual((await call(prefix + 'compare', { libraryId })).data.rows.map(row => row.status), ['existing', 'existing', 'review'])
    records[0] = source('ATTACH', 'Mellein', key, 68)
    save()
    assert.equal((await call(prefix + 'compare', { libraryId })).data.rows[0].status, 'revision')
    assert.equal((await read()).spectra[1].peaks[0].intensity, 55)
    records.push(source('LATER', 'New sample', 'AAAAAAAAAAAAAA-BBBBBBBBBB-C', 78))
    save()
    const later = (await call(prefix + 'compare', { libraryId })).data
    assert.equal(later.rows.at(-1).status, 'attach')
    assert.equal((await call('/admin/publication/' + randomUUID(), publication({
      ...body, revision: later.revision, selected: [records.at(-1).accession]
    }))).status, 200)
    assert.equal(hash(fs.readFileSync(file)), original)
  } finally {
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
