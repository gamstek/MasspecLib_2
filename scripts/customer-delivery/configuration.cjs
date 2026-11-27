const crypto = require('node:crypto')
const { fail, text } = require('./policy.cjs')

// Access modes describe startup, independently of the legacy signed-file export feature.
const accessCapabilities = Object.freeze({ online: true, offline: true, hybrid: true })
function validateAccess(access, tenantId, users, offlineCredentials = []) {
  if (!access || !['online', 'offline', 'hybrid'].includes(access.mode)) fail('请选择登录与访问方式')
  const result = { mode: access.mode }
  if (access.mode !== 'offline') {
    const account = users.find(u => u.id === access.userId && u.role === 'customer' && u.tenantId === tenantId)
    if (!account || account.disabled || !account.passwordHash) fail('请选择该客户已启用且已设置密码的在线账号')
    result.userId = account.id
  }
  if (access.mode !== 'online') {
    const credential = offlineCredentials.find(c => c.id === access.offlineCredentialId && c.tenantId === tenantId && !c.disabled)
    if (!credential || !credential.secret || !credential.passwordHash) fail('请先设置该客户的离线启动账号密码')
    result.offlineCredentialId = credential.id
  }
  return result
}
function configuration(input, tenantId, users, now = new Date(), offlineCredentials = []) {
  const name = text(input.customerName, '客户／交付名称')
  if (typeof input.deliveryAt !== 'string' || !input.deliveryAt.trim() || !Number.isFinite(Date.parse(input.deliveryAt))) fail('请填写有效的交付时间')
  if (input.notes != null && (typeof input.notes !== 'string' || input.notes.trim().length > 2000)) fail('备注不能超过2000字')
  const access = validateAccess(input.access, tenantId, users, offlineCredentials)
  return { configurationVersion: 1, customerName: name, title: name,
    deliveryAt: new Date(input.deliveryAt).toISOString(), notes: input.notes?.trim() || null,
    version: 'r-' + now.toISOString().replace(/[-:.TZ]/g, '') + '-' + crypto.randomBytes(4).toString('hex'), access }
}
function readConfiguration(release, tenants, users = [], offlineCredentials = []) {
  return { customerName: tenants.find(t => t.id === release.tenantId)?.name || '',
    tenantId: release.tenantId, title: release.title, deliveryAt: release.deliveryAt || release.createdAt || null,
    expiresAt: release.expiresAt || null, notes: release.notes || null,
    selections: release.configuration?.selections || (release.origins || []).map(o => ({ libraryId: o.libraryId, displayName: o.displayName, ...o.selection })),
    onlineUsername: users.find(u => u.id === release.access?.userId)?.username || '', offlineUsername: offlineCredentials.find(c => c.id === release.access?.offlineCredentialId)?.username || '',
    policy: release.policy, access: release.access || { mode: null, userId: null },
    replacesId: release.id, originalState: release.state,
    legacyVersion: release.version, revision: release.version, configurationVersion: release.configurationVersion || 0 }
}
module.exports = { accessCapabilities, validateAccess, configuration, readConfiguration }
