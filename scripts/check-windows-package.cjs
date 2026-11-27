const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const asar = require('@electron/asar')
const version = require('../package.json').version
const root = process.argv[2] || 'dist/health-check-2.1.8/win-unpacked'
const output = process.argv[3] || 'outputs/服务器健康检查_20261016/Windows包内容检查.json'
const archive = path.join(root, 'resources/app.asar')
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(pkg.version, version)
assert(fs.readFileSync(path.join(root, 'MasspecLib2.exe')).subarray(0, 2).equals(Buffer.from('MZ')))
const files = asar.listPackage(archive)
assert(!files.some(file => /(^|\/)\.env(?:\.|$)/.test(file)))
function checkCompiled(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) checkCompiled(file)
    else assert(fs.readFileSync(file).equals(asar.extractFile(archive, file.split(path.sep).join('/'))), file + ' differs from current build')
  }
}
checkCompiled('out/main')
assert(files.includes('/out/main/analysis-worker.js'), 'Missing analysis worker')
assert(files.includes('/out/main/audit-worker.js'), 'Missing database audit worker')
assert(fs.existsSync(path.join(root,'resources/database/experiment-schema-v1.sql')), 'Missing optional experiment schema')
for (const file of ['/out/renderer/index.html', '/node_modules/@prisma/client/runtime/query_compiler_bg.mysql.js',
  '/node_modules/@prisma/client/runtime/query_compiler_bg.mysql.wasm-base64.js']) assert(files.includes(file))
const init = path.join(root, 'resources/database/masspeclib2-initialize.sql')
const manifest = JSON.parse(fs.readFileSync(init + '.manifest.json', 'utf8'))
assert.equal(manifest.schemaVersion, 4)
assert.equal(manifest.sha256, createHash('sha256').update(fs.readFileSync(init)).digest('hex'))
assert.equal(manifest.schemaHash, createHash('sha256').update(fs.readFileSync('prisma/schema.prisma')).digest('hex'))
const report = { status: 'passed', applicationVersion: version, schemaVersion: 4, windowsExe: true,
  compiledMainFilesMatch: true, analysisWorkerIncluded: true, databaseAuditWorkerIncluded: true, prismaRuntimeIncluded: true, initializationManifestValid: true,
  actualDatabaseConfigIncluded: false, scope: 'Windows目录包静态校验；未执行MSI安装和真实桌面窗口' }
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
