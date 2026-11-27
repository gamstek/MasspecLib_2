// Executes the production main bundle with desktop interfaces replaced by a small test double.
// This checks startup/configuration/IPC against real MySQL; it does not open an Electron window.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const output = path.resolve(process.argv[2] || 'outputs/服务器健康检查_20261016')
fs.mkdirSync(output, { recursive: true })
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'masspeclib2-built-startup-'))
const userData = path.join(directory, 'MasspecLib2')
fs.mkdirSync(userData)
const database = process.env.DEMO_DATABASE || 'mspec_lib2_classification_demo'
assert.match(database, /^mspec_lib2(?:_[A-Za-z0-9]+)*$/)
const configuration = path.join(userData, '.env.masspeclib2')
fs.writeFileSync(configuration, [
  'DATABASE_HOST=' + (process.env.DEMO_MYSQL_HOST || '127.0.0.1'),
  'DATABASE_PORT=' + (process.env.DEMO_MYSQL_PORT || 44715),
  'DATABASE_USER=' + (process.env.DEMO_MYSQL_USER || 'root'),
  'DATABASE_PASSWORD=' + JSON.stringify(process.env.DEMO_MYSQL_PASSWORD || ''),
  'DATABASE_NAME=' + database, ''
].join('\n'), { mode: 0o600 })
process.env.MASSPECLIB2_DATABASE_CONFIG = configuration
const handlers = new Map()
const app = new EventEmitter()
const appPaths = { appData: directory, userData }
let startResolve, startReject
const started = new Promise((resolve, reject) => { startResolve = resolve; startReject = reject })
app.isPackaged = true
app.getPath = key => appPaths[key]
app.setPath = (key, value) => { appPaths[key] = value }
app.setName = () => {}
app.setAppUserModelId = () => {}
app.whenReady = () => Promise.resolve()
app.quit = () => { startReject(new Error('Application quit during startup')) }
class BrowserWindow extends EventEmitter {
  static windows = []
  static getAllWindows() { return BrowserWindow.windows }
  constructor(options) {
    super(); this.options = options; BrowserWindow.windows.push(this)
    this.webContents = new EventEmitter()
    this.webContents.setWindowOpenHandler = () => {}
    this.webContents.send = () => {}
  }
  loadFile(filename) { assert(fs.existsSync(filename), 'Renderer file does not exist'); startResolve(filename); return Promise.resolve() }
  loadURL() { startReject(new Error('Expected production loadFile, got loadURL')) }
  show() {}
}
const electron = {
  app, BrowserWindow,
  ipcMain: {
    handle(channel, handler) { assert(!handlers.has(channel), 'Duplicate IPC handler: ' + channel); handlers.set(channel, handler) },
    on() {}
  },
  dialog: {
    async showMessageBox(options) { throw new Error('Unexpected startup dialog: ' + JSON.stringify(options)) },
    showErrorBox(title, message) { startReject(new Error(title + ': ' + message)) }
  },
  shell: { openExternal() {} }
}
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain)
}
const report = { checkedAt: new Date().toISOString(), version: require('../package.json').version, database,
  scope: '生产main bundle，桌面接口替身，真实MySQL，IPC入参和返回值执行structuredClone；非真实GUI/安装验证', checks: [], status: 'running' }
function check(name, detail) { report.checks.push({ name, result: 'passed', detail }); console.log('PASS:', name) }
async function invoke(channel, ...args) {
  assert(handlers.has(channel), 'Missing IPC handler: ' + channel)
  const result = await handlers.get(channel)({}, ...structuredClone(args))
  return structuredClone(result)
}
const deadline = setTimeout(() => { console.error('Startup check timed out'); process.exit(1) }, 20000)
async function main() {
  require(path.resolve('out/main/index.js'))
  const rendererFile = await started
  check('生产主进程完成配置与MySQL检查，加载页面文件', { rendererFile })
  const status = await invoke('database:status')
  assert.equal(status.ok, true, JSON.stringify(status))
  check('编译后数据库状态IPC成功且可克隆', { ok: true })
  const connections = await invoke('connections:list')
  assert.equal(connections.length, 1)
  const id = connections[0].id
  check('编译后连接列表IPC完成', { connections: 1 })
  const result = await invoke('federation:list', { page: 1, pageSize: 50 })
  assert.equal(result.complete, true)
  assert.equal(result.total, 8)
  check('编译后统一列表IPC返回全部演示记录', { total: result.total })
  const tree = await invoke('federation:categories')
  assert(tree.length >= 4)
  const parent = tree.flatMap(node => node.children).find(node => node.label.startsWith('农药及农残'))
  assert.equal(parent.count, 3)
  const category = await invoke('federation:list', { classId: parent.id })
  assert.equal(category.total, 3)
  check('编译后分类树与分类查询IPC成功', { pesticideCount: 3 })
  const detail = await invoke('federation:detail', result.list[0].ref)
  assert(detail.extensions.spectra.length > 0)
  assert.equal(detail.lcMethods[0].methodsLinks.length, 6)
  check('编译后详情IPC包含谱峰及液相梯度', { spectra: detail.extensions.spectra.length, steps: 6 })
  const preview = await invoke('import:preview', { __scope: 'masspeclib2', connectionId: id,
    args: [path.resolve('outputs/分类功能演示库/分类功能演示包.msldata')] })
  assert.equal(preview.total, 8)
  assert.equal(preview.skipped, 8)
  check('编译后作用域导入预览IPC成功', { total: 8, skipped: 8 })
  await invoke('connections:save', {
    name: '独立全新演示库复测', host: process.env.DEMO_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.DEMO_MYSQL_PORT || 44715), user: process.env.DEMO_MYSQL_USER || 'root',
    database: 'mspec_lib2_classification_fresh_check_20261016', adapter: 'native',
    enabled: true, writable: true
  })
  const both = await invoke('connections:list')
  const added = both.find(connection => connection.id !== id)
  assert(added)
  try {
    const combined = await invoke('federation:list', {})
    assert.equal(combined.complete, true)
    assert.equal(combined.total, 16)
    const refs = combined.list.map(record => JSON.stringify([record.ref.connectionId, record.ref.key]))
    assert.equal(new Set(refs).size, 16)
    const firstIds = combined.list.filter(record => record.ref.key === '1')
    assert.equal(new Set(firstIds.map(record => record.ref.connectionId)).size, 2)
    const combinedTree = await invoke('federation:categories')
    const combinedParent = combinedTree.flatMap(node => node.children).find(node => node.label.startsWith('农药及农残'))
    assert.equal(combinedParent.count, 6)
    assert.equal((await invoke('federation:list', { classId: combinedParent.id })).total, 6)
    check('编译后多数据库合并、相同记录ID隔离和统一分类统计成功', { databases: 2, records: 16, pesticideCount: 6 })
    const combinedSources = await invoke('federation:sources', '农残资料', 0)
    assert.equal(combinedSources.list.length, 1)
    assert.equal((await invoke('federation:list', { sourceIds: [combinedSources.list[0].id] })).total, 6)
    check('编译后跨数据库来源合并与来源检索成功', { matchingSources: 1, records: 6 })
  } finally {
    await invoke('connections:remove', added.id)
  }
  report.status = 'passed'
  report.registeredChannels = handlers.size
}
main().catch(error => { report.status = 'failed'; report.error = error.stack || String(error); console.error(error) }).finally(() => {
  clearTimeout(deadline)
  fs.writeFileSync(path.join(output, '编译后启动与IPC检查.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, registeredChannels: handlers.size }))
  process.exit(report.status === 'passed' ? 0 : 1)
})
