const crypto = require('node:crypto')
const { text, fail } = require('./policy.cjs')
const key = name => name.trim().normalize('NFKC').toLocaleLowerCase()
function customerFor(tenants, input) {
  const blankLegacyName = input.tenantId && (input.customerName === null || typeof input.customerName === 'string' && !input.customerName.trim())
  const name = input.customerName === undefined || blankLegacyName ? undefined : text(input.customerName, '客户名称')
  if (input.tenantId) {
    const existing = tenants.find(t => t.id === input.tenantId)
    if (!existing) fail('客户记录不存在，请重新填写客户名称')
    if (name && key(name) !== key(existing.name)) fail('客户名称已变化，请重新确认已有客户')
    return { tenant: existing, created: false }
  }
  if (!name) fail('请填写客户名称')
  const matches = tenants.filter(t => key(t.name) === key(name))
  if (matches.length > 1) fail('存在同名客户，请从输入提示中确认已有客户')
  return matches.length ? { tenant: matches[0], created: false } : { tenant: { id: crypto.randomUUID(), name }, created: true }
}
module.exports = { customerFor }
