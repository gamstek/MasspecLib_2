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
fs.writeFileSync(
  configuration,
  [
    'DATABASE_HOST=' + (process.env.DEMO_MYSQL_HOST || '127.0.0.1'),
    'DATABASE_PORT=' + (process.env.DEMO_MYSQL_PORT || 44715),
    'DATABASE_USER=' + (process.env.DEMO_MYSQL_USER || 'root'),
    'DATABASE_PASSWORD=' + JSON.stringify(process.env.DEMO_MYSQL_PASSWORD || ''),
    'DATABASE_NAME=' + database,
    ''
  ].join('\n'),
  { mode: 0o600 }
)
process.env.MASSPECLIB2_DATABASE_CONFIG = configuration
const handlers = new Map()
const fileChoices = [],
  saveChoices = []
const app = new EventEmitter()
const appPaths = { appData: directory, userData }
let startResolve, startReject
const started = new Promise((resolve, reject) => {
  startResolve = resolve
  startReject = reject
})
app.isPackaged = true
app.getPath = (key) => appPaths[key]
app.setPath = (key, value) => {
  appPaths[key] = value
}
app.setName = () => {}
app.setAppUserModelId = () => {}
app.whenReady = () => Promise.resolve()
app.quit = () => {
  startReject(new Error('Application quit during startup'))
}
class BrowserWindow extends EventEmitter {
  static windows = []
  static getAllWindows() {
    return BrowserWindow.windows
  }
  constructor(options) {
    super()
    this.options = options
    BrowserWindow.windows.push(this)
    this.webContents = new EventEmitter()
    this.webContents.setWindowOpenHandler = () => {}
    this.webContents.send = () => {}
  }
  loadFile(filename) {
    assert(fs.existsSync(filename), 'Renderer file does not exist')
    startResolve(filename)
    return Promise.resolve()
  }
  loadURL() {
    startReject(new Error('Expected production loadFile, got loadURL'))
  }
  show() {}
}
const electron = {
  app,
  BrowserWindow,
  ipcMain: {
    handle(channel, handler) {
      assert(!handlers.has(channel), 'Duplicate IPC handler: ' + channel)
      handlers.set(channel, handler)
    },
    on() {}
  },
  dialog: {
    async showOpenDialog() {
      const file = fileChoices.shift()
      return file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] }
    },
    async showSaveDialog() {
      const file = saveChoices.shift()
      return file ? { canceled: false, filePath: file } : { canceled: true }
    },
    async showMessageBox(options) {
      throw new Error('Unexpected startup dialog: ' + JSON.stringify(options))
    },
    showErrorBox(title, message) {
      startReject(new Error(title + ': ' + message))
    }
  },
  shell: { openExternal() {} }
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain)
}

const report = {
  version: require('../package.json').version,
  checkedAt: new Date().toISOString(),
  scope: '生产主进程+真实worker线程+真实MySQL启动；Electron桌面接口替身，非真实GUI',
  checks: [],
  status: 'running'
}
function check(name, detail) {
  report.checks.push({ name, detail })
  console.log('PASS:', name)
}
async function invoke(channel, ...args) {
  assert(handlers.has(channel), channel)
  return structuredClone(await handlers.get(channel)({}, ...structuredClone(args)))
}
async function complete(start) {
  for (let i = 0; i < 300; i++) {
    const job = await invoke('analysis:job', start.jobId)
    if (job.state === 'failed') throw new Error(job.message)
    if (job.state === 'preview') return job
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Worker preview timeout')
}
const deadline = setTimeout(() => {
  console.error('Integration timeout')
  process.exit(1)
}, 60000)
async function main() {
  require(path.resolve('out/main/index.js'))
  await started
  assert.equal((await invoke('database:status')).ok, true)
  const preview = await complete(await invoke('analysis:demo'))
  assert.equal(preview.preview.total, 15)
  const saved = await invoke('analysis:commit', preview.id)
  const id = saved.id
  let page = await invoke('analysis:results', id, {})
  assert.equal(page.total, 15)
  check('生产worker计算15条模拟色谱数据并保存批次', page.summary)
  assert.equal((await invoke('analysis:results', id, { peak: 'fronting' })).total, 1)
  assert.equal((await invoke('analysis:results', id, { peak: 'tailing' })).total, 3)
  assert.equal((await invoke('analysis:results', id, { peak: 'split' })).total, 1)
  assert.equal((await invoke('analysis:results', id, { limit: 'fail' })).total, 2)
  assert.equal((await invoke('analysis:results', id, { ratio: 'fail' })).total, 2)
  check('前延、拖尾、分叉、超限及离子比筛选正确')
  const detail = await invoke('analysis:detail', id, 'DEMO-07')
  assert.equal(detail.row.trace.points.length, 501)
  assert.equal(detail.result.ratio.state, 'fail')
  assert.equal(detail.result.limit.state, 'fail')
  await invoke('analysis:review', id, detail.summary.revision, {
    resultId: 'DEMO-07',
    action: 'retest',
    reviewer: '集成检查',
    reason: '验证保留自动判定'
  })
  const reviewed = await invoke('analysis:detail', id, 'DEMO-07')
  assert.equal(reviewed.reviews.length, 1)
  assert.equal(reviewed.result.ratio.state, 'fail')
  check('详细曲线和规则返回可克隆；人工复核保留原判定')
  const csv = path.join(directory, 'filtered.csv')
  saveChoices.push(csv)
  await invoke('analysis:export', id, { limit: 'fail' }, 'csv')
  const csvContent = fs.readFileSync(csv, 'utf8')
  assert(csvContent.includes('DEMO-05'))
  assert(!csvContent.includes('DEMO-01'))
  const backup = path.join(directory, 'backup.json')
  saveChoices.push(backup)
  await invoke('analysis:export', id, {}, 'json')
  assert.equal(JSON.parse(fs.readFileSync(backup)).batch.reviews.length, 1)
  fileChoices.push(backup)
  const restoration = await complete(await invoke('analysis:import'))
  assert.equal(restoration.preview.restored, true)
  const restored = await invoke('analysis:commit', restoration.id)
  assert.equal(restored.duplicate, true)
  check('筛选CSV导出和含复核历史的备份JSON恢复成功')
  for (const extension of ['json', 'csv', 'xlsx']) {
    fileChoices.push(path.resolve('examples/analysis/检测结果演示_15条.' + extension))
    const job = await complete(await invoke('analysis:import'))
    assert.equal(job.preview.total, 15)
    const committed = await invoke('analysis:commit', job.id)
    const result = await invoke('analysis:results', committed.id, {})
    assert.equal(result.total, 15)
    assert.equal((await invoke('analysis:results', committed.id, { peak: 'fronting' })).total, 1)
    check(extension.toUpperCase() + '真实文件导入、预览和保存成功', { records: 15 })
  }
  const bad = path.join(directory, 'invalid.json')
  fs.writeFileSync(bad, '{ invalid')
  fileChoices.push(bad)
  const invalid = await invoke('analysis:import')
  await assert.rejects(() => complete(invalid))
  await invoke('analysis:cancel', invalid.jobId)
  const cancelled = await invoke('analysis:demo')
  await invoke('analysis:cancel', cancelled.jobId)
  await assert.rejects(() => invoke('analysis:job', cancelled.jobId))
  check('无效文件错误反馈与worker取消成功')
  const batches = await invoke('analysis:batches')
  assert.equal(batches.warnings.length, 0)
  assert(batches.batches.length >= 2)
  check('本地批次持久化列表正确', { batches: batches.batches.length })
  report.status = 'passed'
}
main()
  .catch((error) => {
    report.status = 'failed'
    report.error = error.stack
    console.error(error)
  })
  .finally(() => {
    clearTimeout(deadline)
    app.emit('before-quit')
    fs.writeFileSync(
      path.join(output, '检测结果生产构建集成检查.json'),
      JSON.stringify(report, null, 2) + '\n'
    )
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length }))
    process.exit(report.status === 'passed' ? 0 : 1)
  })
