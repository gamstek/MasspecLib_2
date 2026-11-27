const fs = require('node:fs')
const path = require('node:path')
const { parseAdminWorkspace } = require('../../src/shared/adminWorkspace.mjs')

// Prepare a reviewable configuration on stdout, using exact server paths.
const registryFile = process.argv[2]
if (!registryFile) {
  console.error('Usage: node prepare-admin-workspace.cjs /path/to/source-libraries/registry.json')
  process.exit(2)
}
const { libraries } = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
const sql = 'mspec_lib2_shared_ff143ed6f54e6f0e7b85'
const files = [
  '/workspace/LocalDataSet/hainan_delivery_20261030/pharmacopoeia_2025',
  '/workspace/LocalDataSet/hainan_delivery_20261030/cosmetics_1027',
  '/workspace/LDS/LDS.sqlite'
].map(origin => {
  const matches = libraries.filter(entry => path.resolve(entry.origin) === path.resolve(origin))
  if (matches.length !== 1 || !fs.existsSync(origin)) {
    throw new Error(`服务器登记或文件不能唯一确认：${origin}`)
  }
  return 'file:' + matches[0].id
})
const configuration = parseAdminWorkspace({
  schemaVersion: 1, libraries: [sql, ...files], defaultLibrary: sql,
  columns: ['name_en', 'cas', 'formula', 'ionModes', 'mrm1'],
  pageSize: 50, navigationWidth: 235, expandedCategories: [], openMenus: ['databases']
})
process.stdout.write(JSON.stringify(configuration, null, 2) + '\n')
