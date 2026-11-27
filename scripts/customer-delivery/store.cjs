const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { promisify } = require('node:util')
const { customerFor } = require('./customer-name.cjs')
const { hash, fail, text } = require('./policy.cjs')
const scrypt = promisify(crypto.scrypt)
async function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail('软件账号密码需要8–128个字符')
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `${salt}:${key.toString('hex')}`
}
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return false
  const [salt, key] = stored.split(':')
  const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return crypto.timingSafeEqual(actual, Buffer.from(key, 'hex'))
}
class Store {
  constructor(directory) {
    this.directory = directory; fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.file = path.join(directory, 'authorization.json')
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, users: [], tenants: [], releases: [], sessions: [], events: [], reviews: [] }
    this.tail = Promise.resolve()
  }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 }); fs.renameSync(tmp, this.file) }
  mutate(fn) {
    const run = this.tail.then(async () => {
      const before = structuredClone(this.data)
      try { const result = await fn(this.data); this.save(); return result } catch (e) { this.data = before; throw e }
    })
    this.tail = run.catch(() => {}); return run
  }
  event(actor, action, target) { this.data.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, target }) }
  async createUser(input, actor = 'bootstrap', vault) {
    const username = text(input.username, '账号', 80)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}$/.test(username)) fail('账号须为3–80位字母、数字或_.@-')
    const digest = await passwordHash(input.password)
    return this.mutate(d => {
      if (d.users.some(u => u.username.toLowerCase() === username.toLowerCase())) fail('账号已存在')
      const role = input.role === 'admin' ? 'admin' : 'customer'
      let tenantId = null
      if (role === 'customer') {
        const resolved = customerFor(d.tenants, input)
        tenantId = resolved.tenant.id
        if (resolved.created) d.tenants.push(resolved.tenant)
      }
      const user = { id: crypto.randomUUID(), username, passwordHash: digest, role, tenantId, disabled: false, authVersion: 1 }
      if (vault) user.credentialSecret = vault.seal(input.password, 'online:' + user.id)
      d.users.push(user); this.event(actor, 'create-user', user.id)
      return this.publicUser(user)
    })
  }
  async createAccessCredentials(input, actor, vault, authenticate = () => {}) {
    if (!['online', 'offline', 'hybrid'].includes(input.mode)) fail('请选择登录与访问方式')
    const username = text(input.username, '账号', 80)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}$/.test(username)) fail('账号须为3–80位字母、数字或_.@-')
    if(typeof input.password!=='string'||input.password.length<8||input.password.length>20)fail('客户密码需要8–20个字符')
    if (input.password !== input.passwordConfirm) fail('两次输入的密码不一致')
    const digest = await passwordHash(input.password), onlineId = crypto.randomUUID(), offlineId = crypto.randomUUID()
    const onlineSecret = input.mode !== 'offline' ? vault.seal(input.password, 'online:' + onlineId) : null
    const offlineSecret = input.mode !== 'online' ? vault.seal(input.password, 'offline:' + offlineId) : null
    return this.mutate(d => {
      authenticate()
      const resolved = customerFor(d.tenants, input)
      if (input.mode !== 'offline' && d.users.some(u => u.username.toLowerCase() === username.toLowerCase())) fail('在线账号已存在，请选择已有账号或使用其他账号名', 409)
      if (resolved.created) d.tenants.push(resolved.tenant)
      const access = { mode: input.mode }
      if (onlineSecret) { d.users.push({ id: onlineId, username, passwordHash: digest, credentialSecret: onlineSecret, role: 'customer', tenantId: resolved.tenant.id, disabled: false, authVersion: 1 }); access.userId = onlineId }
      if (offlineSecret) { (d.offlineCredentials ??= []).push({ id: offlineId, tenantId: resolved.tenant.id, username, passwordHash: digest, secret: offlineSecret, createdAt: new Date().toISOString() }); access.offlineCredentialId = offlineId }
      this.event(actor, 'configure-access', { tenantId: resolved.tenant.id, mode: input.mode, username })
      return { tenantId: resolved.tenant.id, access, username }
    })
  }
  publicUser(u) { const { passwordHash, credentialSecret, ...safe } = u; return credentialSecret ? { ...safe, credentialRecoverable: true } : safe }
  async login(username, password, keepSignedIn, expectedTenant) {
    const user = this.data.users.find(u => u.username.toLowerCase() === String(username).toLowerCase())
    const expectedHash = user?.passwordHash, expectedVersion = user?.authVersion
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64)
    const valid = await verifyPassword(password, user?.passwordHash ?? dummy)
    if (!valid || !user || user.disabled || (expectedTenant && user.tenantId !== expectedTenant)) fail('账号或密码错误，或账号不可用于此交付包', 401)
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + (keepSignedIn ? 90 * 86400000 : 12 * 3600000)
    await this.mutate(d => {
      // Recheck after asynchronous password verification and serialization.
      if (user.disabled || user.passwordHash !== expectedHash || user.authVersion !== expectedVersion || !d.users.includes(user)) fail('账号已停用', 401)
      d.sessions = d.sessions.filter(s => s.expiresAt > Date.now())
      d.sessions.push({ id: hash(token), userId: user.id, authVersion: user.authVersion, expiresAt })
      this.event(user.id, 'login', user.id)
    })
    return { token, expiresAt, user: this.publicUser(user) }
  }
  authenticate(token) {
    const session = this.data.sessions.find(s => s.id === hash(String(token)) && s.expiresAt > Date.now())
    const user = session && this.data.users.find(u => u.id === session.userId)
    if (!user || user.disabled || user.authVersion !== session.authVersion) fail('登录已失效，请重新登录', 401)
    return user
  }
  authorize(user, releaseId) {
    const release = this.data.releases.find(r => r.id === releaseId)
    if (!release || release.state !== 'published' || (release.expiresAt && new Date(release.expiresAt).getTime() <= Date.now()) || (user.role !== 'admin' && release.tenantId !== user.tenantId)) fail('数据集不存在或无访问权限', 403)
    return release
  }
  async logout(token) { await this.mutate(d => { d.sessions = d.sessions.filter(s => s.id !== hash(String(token))) }) }
}
module.exports = { Store, passwordHash, verifyPassword }
