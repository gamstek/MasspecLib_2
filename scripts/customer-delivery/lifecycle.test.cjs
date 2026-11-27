const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const { Store } = require('./store.cjs'), { changeRelease } = require('./release-lifecycle.cjs')
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masspec-lifecycle-')), store = new Store(root), directory = path.join(root, 'datasets'), id = crypto.randomUUID()
  fs.mkdirSync(path.join(directory, id), { recursive: true }); fs.writeFileSync(path.join(directory, id, 'index.json'), '[]')
  store.data.releases.push({ id, title: '测试交付', version: 'v1', state: 'published', tenantId: 'customer-a', total: 2 }); store.save()
  const change = (action, extra = {}) => changeRelease({ store, directory, id, action, actor: 'admin', authenticate() {}, ...extra })
  return { root, store, directory, id, change }
}
test('delete stops authorization, restore is draft, purge removes only selected snapshot and retains audit', async () => {
  const f = fixture()
  try {
    const other = crypto.randomUUID(); fs.mkdirSync(path.join(f.directory, other)); f.store.data.reviews.push({ releaseId: f.id }, { releaseId: other })
    await f.change('delete'); assert.equal(f.store.data.releases[0].state, 'deleted'); assert(fs.existsSync(path.join(f.directory, f.id)))
    assert.throws(() => f.store.authorize({ role: 'customer', tenantId: 'customer-a' }, f.id))
    await assert.rejects(f.change('delete')); await f.change('restore'); assert.equal(f.store.data.releases[0].state, 'draft')
    await assert.rejects(f.change('purge', { confirmation: '测试交付 v1' }))
    await f.change('delete'); await assert.rejects(f.change('purge', { confirmation: false })); await assert.rejects(f.change('purge'))
    await f.change('purge', { confirmation: true })
    assert.equal(f.store.data.releases.length, 0); assert(!fs.existsSync(path.join(f.directory, f.id))); assert(fs.existsSync(path.join(f.directory, other)))
    assert.deepEqual(f.store.data.reviews, [{ releaseId: other }]); assert.equal(f.store.data.events.at(-1).action, 'purge-release'); assert.equal(f.store.data.events.at(-1).target.title, '测试交付')
  } finally { fs.rmSync(f.root, { recursive: true }) }
})
test('purge rolls back snapshot rename and metadata if saving fails', async () => {
  const f = fixture()
  try {
    await f.change('delete'); f.store.save = () => { throw Error('disk write failed') }
    await assert.rejects(f.change('purge', { confirmation: true }), /disk write failed/)
    assert.equal(f.store.data.releases[0].state, 'deleted'); assert(fs.existsSync(path.join(f.directory, f.id, 'index.json'))); assert(!fs.readdirSync(f.directory).some(x => x.startsWith('.purged-')))
  } finally { fs.rmSync(f.root, { recursive: true }) }
})
test('lifecycle rechecks administrator access and rejects unsafe snapshot paths', async () => {
  const f = fixture()
  try {
    await assert.rejects(f.change('delete', { authenticate() { throw Error('forbidden') } }), /forbidden/)
    assert.equal(f.store.data.releases[0].state, 'published')
    f.store.data.releases[0].id = '../escape'; f.store.data.releases[0].state = 'deleted'
    await assert.rejects(f.change('purge', { id: '../escape', confirmation: '测试交付 v1' }), /目录无效/)
  } finally { fs.rmSync(f.root, { recursive: true }) }
})
