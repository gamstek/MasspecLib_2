// Explicitly scoped deployment: creates only customer-delivery/ and a SELECT-only MySQL user.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process'), { createRequire } = require('node:module')
const { isIP } = require('node:net')
const project = process.env.MSL_PROJECT || '/workspace/ptk-master2', base = process.env.MSL_SERVER || '/workspace/mysql-masspeclib2'
const directory = path.resolve(process.env.MSL_DELIVERY_DIR || path.join(base, 'customer-delivery')), requireProject = createRequire(path.join(project, 'package.json'))
const { Store } = require('./store.cjs')
async function main() {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const configPath = path.join(directory, 'config.json')
  if (fs.existsSync(configPath)) { console.log('客户服务已初始化，保留现有账号、证书和配置。'); return }
  const publicUrl = new URL(process.env.MSL_DELIVERY_URL || 'https://192.168.3.92:8443')
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash)
    throw Error('MSL_DELIVERY_URL 必须是 HTTPS 服务地址')
  const host = process.env.MSL_DELIVERY_HOST || '0.0.0.0'
  const port = Number(process.env.MSL_DELIVERY_PORT || publicUrl.port || 443)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('交付服务端口无效')
  const publicHost = publicUrl.hostname.replace(/^\[|\]$/g, '')
  const altNames = [...new Set(['IP:127.0.0.1', 'DNS:localhost', (isIP(publicHost) ? 'IP:' : 'DNS:') + publicHost])]
  const maintenanceCredentials = path.resolve(process.env.MSL_MYSQL_ROOT_CREDENTIALS || path.join(base, 'credentials.json'))
  const root = JSON.parse(fs.readFileSync(maintenanceCredentials, 'utf8'))
  if (typeof root.root !== 'string') throw Error('MySQL 维护凭据缺少 root 字段')
  const mysql = requireProject('mysql2/promise'), socketPath = process.env.MSL_MYSQL_SOCKET || path.join(base, 'run/mysql.sock'), user = 'mspec_delivery_reader'
  const keyFile = path.join(directory, 'signing-private.pem'), publicFile = path.join(directory, 'signing-public.pem')
  const pair = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  fs.writeFileSync(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
  const tlsKey = path.join(directory, 'tls-key.pem'), tlsCert = path.join(directory, 'tls-cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '3650', '-keyout', tlsKey, '-out', tlsCert, '-subj', '/CN=MasspecLib2 Delivery', '-addext', 'subjectAltName=' + altNames.join(',')], { stdio: 'ignore' })
  fs.chmodSync(tlsKey, 0o600)
  const certificateFingerprint = new crypto.X509Certificate(fs.readFileSync(tlsCert)).fingerprint256.replaceAll(':', '').toLowerCase()
  const password = crypto.randomBytes(32).toString('base64url')
  const c = await mysql.createConnection({ socketPath, user: 'root', password: root.root })
  try {
    const catalog = fs.readFileSync(path.join(__dirname, 'shared-catalog.sql'), 'utf8')
    for (const statement of catalog.split(';').filter(sql => sql.trim())) await c.query(statement)
    await c.query("CREATE USER ?@'localhost' IDENTIFIED BY ?", [user, password])
    await c.query("GRANT SELECT ON mspec_lib2_catalog.* TO ?@'localhost'", [user])
    // Database-level wildcard grant automatically covers future native imports, but grants no writes.
    await c.query("GRANT SELECT ON `mspec\\_lib2\\_shared\\_%`.* TO ?@'localhost'", [user])
  } finally { await c.end() }
  const databaseCredentials = path.join(directory, 'database-credentials.json')
  fs.writeFileSync(databaseCredentials, JSON.stringify({ user, password }), { mode: 0o600 })
  const store = new Store(directory), adminPassword = crypto.randomBytes(18).toString('base64url')
  await store.createUser({ username: 'masspec_admin', password: adminPassword, role: 'admin' })
  fs.writeFileSync(path.join(directory, 'initial-admin-login.txt'), `MasspecLib2 管理员软件账号（不是SSH账号）\n账号：masspec_admin\n密码：${adminPassword}\n首次登录后请修改密码。\n`, { mode: 0o600 })
  requireProject('esbuild').buildSync({ stdin: { contents: `export {analyseRow} from './src/shared/analysis/engine.ts'; export {normalizeDetectionPackage} from './src/shared/analysis/input.ts'; export {ENGINE_VERSION} from './src/shared/analysis/types.ts'`, resolveDir: project }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'engine.cjs') })
  const databaseUploadRoot = path.resolve(process.env.MSL_UPLOAD_ROOT || path.join(directory, 'uploads'))
  const { parseAdminWorkspace } = require('../../src/shared/adminWorkspace.mjs')
  const workspace = parseAdminWorkspace({ schemaVersion: 1, libraries: [], defaultLibrary: null,
    columns: ['name_en','cas','formula','ionModes','sources','database','mrm1','mrm2'],
    pageSize: 50, navigationWidth: 240, expandedCategories: [], openMenus: ['databases','quality','groups','categories'] })
  fs.writeFileSync(path.join(directory, 'admin-workspace.json'), JSON.stringify(workspace), { mode: 0o600, flag: 'wx' })
  const config = { directory, project, socketPath, databaseCredentials, maintenanceCredentials,
    privateKey: keyFile, publicKey: publicFile, tlsKey, tlsCert, publicUrl: publicUrl.origin, certificateFingerprint, host, port,
    databaseUploadRoot, requirePublication: true, templateFile: path.join(directory, 'client-template.zip') }
  const profile = { enabled: true, edition: 'admin', endpoint: config.publicUrl, certificateFingerprint, publicKey: fs.readFileSync(publicFile, 'utf8') }
  fs.writeFileSync(path.join(directory, 'admin-profile.json'), JSON.stringify(profile, null, 2), { mode: 0o600 })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ initialized: true, configPath, adminCredentialsFile: path.join(directory, 'initial-admin-login.txt'), profile: path.join(directory, 'admin-profile.json') }))
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
