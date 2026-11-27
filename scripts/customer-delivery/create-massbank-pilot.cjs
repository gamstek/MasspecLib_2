// Provision the empty pilot library. Run on Test1 with its delivery service stopped.
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { FileLibraries } = require('./file-libraries.cjs')
const { parseAdminWorkspace } = require('../../src/shared/adminWorkspace.mjs')
const configPath = process.argv[2]
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
if (config.massbankPilot) throw Error('MassBank pilot already configured')
const folder = path.join(config.directory, 'massbank-pilot')
const base = path.join(folder, 'MassBank 更新测试库.sqlite')
fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
if (fs.existsSync(base)) throw Error('MassBank pilot source already exists')
const db = new DatabaseSync(base)
try {
  for (const sql of Object.values(require('../../tests/fixtures/lds-cn-schema.json'))) db.exec(sql)
  db.exec("INSERT INTO 构建信息 VALUES('complete','true')")
} finally { db.close() }
const libraries = new FileLibraries(config.fileLibraryRoot || path.join(config.directory, 'source-libraries'))
const { libraryId } = libraries.register(base)
const workspaceFile = path.join(config.directory, 'admin-workspace.json')
const settings = parseAdminWorkspace(JSON.parse(fs.readFileSync(workspaceFile, 'utf8')))
settings.libraries.push(libraryId)
parseAdminWorkspace(settings)
function save(file, value) {
  fs.writeFileSync(file + '.massbank.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(file + '.massbank.tmp', file)
}
save(workspaceFile, settings)
config.massbankPilot = { libraryId }
save(configPath, config)
console.log(JSON.stringify({ libraryId, base }))
