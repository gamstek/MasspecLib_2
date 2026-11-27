const { test } = require('node:test')
const assert = require('node:assert/strict')
const { configuration, validateAccess, readConfiguration } = require('./configuration.cjs')
const users = [{ id: 'u1', role: 'customer', tenantId: 't1', passwordHash: 'test-hash', disabled: false }, { id: 'u2', role: 'customer', tenantId: 't2', passwordHash: 'test-hash' }]
const input = { customerName: '客户甲', deliveryAt: '2026-10-28T09:00:00+08:00', access: { mode: 'online', userId: 'u1' } }
test('delivery projection defaults missing retention time units to minutes and preserves explicit units', () => {
  const { clean } = require('./snapshot.cjs')
  assert.deepEqual(clean({ retention_time: 2.95, retention_time_unit: null }, ['retention_time','retention_time_unit']), { retention_time: 2.95, retention_time_unit: 'min', retention_time_unit_source: 'default' })
  assert.deepEqual(clean({ retention_time: 120, retention_time_unit: 's' }, ['retention_time','retention_time_unit']), { retention_time: 120, retention_time_unit: 's' })
})
test('business time, revision and customer IDs remain separate', () => {
  const a = configuration(input, 't1', users), b = configuration(input, 't1', users)
  assert.equal(a.title, '客户甲'); assert.equal(a.deliveryAt, '2026-10-28T01:00:00.000Z')
  assert.notEqual(a.version, b.version); assert.equal(a.access.userId, 'u1'); assert.equal(a.notes, null)
})
test('no usable entry is rejected, including disabled or wrong-tenant accounts', () => {
  for (const access of [null, {}, { mode: 'online' }, { mode: 'online', userId: 'u2' }, { mode: 'offline' }, { mode: 'hybrid' }]) assert.throws(() => validateAccess(access, 't1', users))
  assert.throws(() => validateAccess(input.access, 't1', [{ ...users[0], disabled: true }]))
  assert.throws(() => validateAccess(input.access, 't1', [{ ...users[0], passwordHash: null }]))
})
test('configuration rejects invalid dates and oversized notes', () => {
  assert.throws(() => configuration({ ...input, deliveryAt: '' }, 't1', users))
  assert.throws(() => configuration({ ...input, deliveryAt: 'invalid' }, 't1', users))
  assert.throws(() => configuration({ ...input, notes: 'a'.repeat(2001) }, 't1', users))
})
test('legacy configuration refills all fields without fabricating credentials', () => {
  const r = { id: 'r1', tenantId: 't1', title: '旧标题', version: 'v1', createdAt: '2026-10-01', expiresAt: '2027-01-01', state: 'published', policy: { fields: {}, features: {} }, origins: [{ libraryId: 'lib1', displayName: '来源', selection: { keyword: 'abc', classIds: [2] } }] }
  const config = readConfiguration(r, [{ id: 't1', name: '客户甲' }])
  assert.equal(config.expiresAt, r.expiresAt); assert.equal(config.customerName, '客户甲'); assert.equal(config.selections[0].keyword, 'abc')
  assert.equal(config.access.mode, null); assert.equal(config.replacesId, 'r1'); assert.equal(r.title, '旧标题')
})
