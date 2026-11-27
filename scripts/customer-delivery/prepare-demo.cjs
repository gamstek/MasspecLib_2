// Creates only explicitly named acceptance customers using the authenticated admin API.
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), crypto = require('node:crypto')
const base = '/workspace/mysql-masspeclib2/customer-delivery', config = JSON.parse(fs.readFileSync(path.join(base, 'config.json')))
let token = ''
async function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const request = https.request('https://127.0.0.1:8443' + route, { method, ca: fs.readFileSync(config.tlsCert), headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
      const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => { const value = JSON.parse(Buffer.concat(chunks)); response.statusCode < 300 ? resolve(value) : reject(new Error(value.error)) })
    }); request.on('error', reject); if (data) request.write(data); request.end()
  })
}
async function main() {
  const credentialFile = path.join(base, 'acceptance-accounts.json')
  if (fs.existsSync(credentialFile)) { console.log('验收账号已准备，保留现有账号和交付内容。'); return }
  const password = fs.readFileSync(path.join(base, 'initial-admin-login.txt'), 'utf8').match(/密码：([^\n]+)/)[1]
  token = (await call('POST', '/login', { username: 'masspec_admin', password })).token
  try {
    const libraries = await call('GET', '/admin/libraries'), source = libraries.find(l => l.title === '共享数据库测试_模拟数据')
    if (!source) throw new Error('未找到明确标注为模拟数据的验收库，未创建客户')
    const candidates = await call('POST', '/admin/candidates', { libraryId: source.id, page: 1 })
    if (candidates.rows.length < 2) throw new Error('模拟数据不足')
    const users = []
    for (const [i, name] of ['验收客户甲', '验收客户乙'].entries()) {
      const password = crypto.randomBytes(15).toString('base64url'), username = 'acceptance_' + (i ? 'b' : 'a')
      const user = await call('POST', '/admin/users', { customerName: name, username, password })
      const schema = await call('GET', '/schema'), policy = structuredClone(schema.templates.find(t => t.id === (i ? 'spectra' : 'review')).policy)
      if (!i) {
        policy.features.spectra = true; policy.features.lc = true; policy.features.offline = true
        policy.fields.ms = ['ms_mode', 'q1', 'q3', 'ce', 'polarity']; policy.fields.spectrum = ['kind', 'peaks', 'image_base64', 'polarity']; policy.fields.lc = ['lc_mode', 'retention_time', 'retention_time_unit', 'gradient']
      }
      const selected = candidates.rows.filter((_, index) => i ? index >= Math.ceil(candidates.rows.length / 2) : index < Math.ceil(candidates.rows.length / 2)).map(row => Number(row.id))
      const job = await call('POST', '/admin/releases', { tenantId: user.tenantId, title: name + ' · 模拟数据交付', version: '2026.10.1', policy, selections: [{ libraryId: source.id, displayName: '交付演示谱库', onlySelected: true, compoundIds: selected }] })
      let completed
      for (let n = 0; n < 300; n++) {
        const state = await call('GET', '/admin/state'); completed = state.jobs.find(j => j.id === job.id)
        if (completed.state === 'failed') throw new Error(completed.error)
        if (completed.state === 'ready') break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (completed.state !== 'ready') throw new Error('交付生成超时')
      const preview = await call('GET', `/admin/releases/${completed.releaseId}/records`)
      if (preview.total !== selected.length) throw new Error('交付数量核对失败')
      await call('POST', `/admin/releases/${completed.releaseId}/publish`, {})
      users.push({ username, password, customerName: name, tenantId: user.tenantId, releaseId: completed.releaseId, compounds: selected.length })
    }
    const output = { administrator: { username: 'masspec_admin', password }, customers: users }
    fs.writeFileSync(credentialFile, JSON.stringify(output, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ status: 'prepared', accountsFile: credentialFile, customers: users.map(({ username, customerName, compounds }) => ({ username, customerName, compounds })) }))
  } finally { await call('POST', '/logout', {}) }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
