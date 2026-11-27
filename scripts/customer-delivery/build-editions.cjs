const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module')
const project = process.env.MSL_PROJECT || path.resolve(__dirname, '../..')
const directory = process.env.MSL_DELIVERY || '/workspace/mysql-masspeclib2/customer-delivery'
const req = createRequire(path.join(project, 'package.json')), builder = req('electron-builder'), { Arch } = req('builder-util')
const version = req('./package.json').version
function sanitizeCustomer() {
  const resources = path.resolve(directory, 'releases/' + version + '/customer/win-unpacked/resources')
  for (const name of ['database', 'database-config.example.env', 'delivery-tools']) {
    const target = path.resolve(resources, name)
    if (!target.startsWith(resources + path.sep)) throw new Error('Unsafe customer resource path')
    fs.rmSync(target, { recursive: true, force: true })
  }
  const allowed = new Set(['app.asar', 'app.asar.unpacked', 'shared-server.json', 'delivery-profile.json'])
  for (const name of fs.readdirSync(resources)) if (!allowed.has(name)) throw new Error('Unexpected customer resource: ' + name)
  const shared = JSON.parse(fs.readFileSync(path.join(resources, 'shared-server.json')))
  if (shared.enabled !== false || Object.keys(shared).length !== 1) throw new Error('Customer direct database profile must be disabled')
  const delivery = JSON.parse(fs.readFileSync(path.join(resources, 'delivery-profile.json')))
  if (delivery.enabled !== false || Object.keys(delivery).length !== 1) throw new Error('Customer template must have an empty delivery profile')
}
async function main() {
  const admin = JSON.parse(fs.readFileSync(path.join(directory, 'admin-profile.json'), 'utf8'))
  if (admin.enabled !== true || admin.edition !== 'admin' || !admin.endpoint || !admin.certificateFingerprint || !admin.publicKey)
    throw new Error('管理员端配置缺少服务器地址、证书指纹或公钥')
  fs.writeFileSync(path.join(directory, 'customer-template-profile.json'), '{"enabled":false}')
  fs.writeFileSync(path.join(directory, 'disabled-shared-profile.json'), '{"enabled":false}')
  const output = path.join(directory, 'releases/' + version)
  for (const edition of ['customer', 'admin']) {
    const extraResources = [
      { from: path.join(directory, edition === 'admin' ? 'admin-profile.json' : 'customer-template-profile.json'), to: 'delivery-profile.json' },
      { from: edition === 'admin' ? path.join(project, 'resources/shared-server.json') : path.join(directory, 'disabled-shared-profile.json'), to: 'shared-server.json' }
    ]
    if (edition === 'admin') {
      extraResources.push({ from: path.join(directory, 'packaging-tools'), to: 'delivery-tools' })
      for (const [from, to] of [['.env.masspeclib2.example', 'database-config.example.env'], ['prisma/masspeclib2-initialize.sql', 'database/masspeclib2-initialize.sql'], ['prisma/masspeclib2-initialize.sql.manifest.json', 'database/masspeclib2-initialize.sql.manifest.json'], ['src/main/audit/experiment-schema.sql', 'database/experiment-schema-v1.sql']]) extraResources.push({ from: path.join(project, from), to })
    }
    await builder.build({ projectDir: project, targets: builder.Platform.WINDOWS.createTarget(['dir'], Arch.x64), publish: 'never', config: { appId: 'com.gamstek.masspeclib2.' + edition, productName: 'MasspecLib2 ' + (edition === 'admin' ? '管理员端' : '客户端'), directories: { output: path.join(output, edition) }, extraResources, win: { executableName: 'MasspecLib2', signAndEditExecutable: false }, npmRebuild: false } })
  }
  sanitizeCustomer()
  console.log(JSON.stringify({ status: 'built', output, customerResourcesSanitized: true }))
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1 })
module.exports = { sanitizeCustomer }
