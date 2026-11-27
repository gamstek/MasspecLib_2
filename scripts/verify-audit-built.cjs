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
const prefix = 'mspec_lib2_auto_test_' + process.pid
const database = prefix + '_a'
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

const mysql = require('mysql2/promise')
const auditDatabase = prefix + '_audit',
  secondDatabase = prefix + '_b'
let admin
const report = {
  scope: '生产bundle + 真实MySQL + 真实Worker；Electron接口替身',
  checkedAt: new Date().toISOString(),
  checks: [],
  status: 'running'
}
function check(name) {
  report.checks.push({ name, result: 'passed' })
  console.log('PASS:', name)
}
async function invoke(channel, ...args) {
  assert(handlers.has(channel), channel)
  return structuredClone(await handlers.get(channel)({}, ...structuredClone(args)))
}
const deadline = setTimeout(() => {
  console.error('自动检查集成测试超时')
  process.exit(1)
}, 120000)
async function main() {
  admin = await mysql.createConnection({
    host: '127.0.0.1',
    port: 44715,
    user: 'root',
    multipleStatements: true
  })
  const [tables] = await admin.query('SHOW TABLES FROM mspec_lib2_classification_demo')
  for (const db of [database, secondDatabase]) {
    await admin.query(
      'CREATE DATABASE `' + db + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
    )
    for (const row of tables) {
      const table = Object.values(row)[0]
      await admin.query(
        'CREATE TABLE `' +
          db +
          '`.`' +
          table +
          '` LIKE mspec_lib2_classification_demo.`' +
          table +
          '`'
      )
      await admin.query(
        'INSERT INTO `' +
          db +
          '`.`' +
          table +
          '` SELECT * FROM mspec_lib2_classification_demo.`' +
          table +
          '`'
      )
    }
    await admin.query('USE `' + db + '`')
    await admin.query(fs.readFileSync('src/main/audit/experiment-schema.sql', 'utf8'))
    await admin.query('UPDATE compounds SET identifiers=? WHERE id=1', [
      JSON.stringify({ inchikey: 'AAAAAAAAAAAAAA-BBBBBBBBBB-C' })
    ])
  }
  await admin.query(
    'UPDATE `' + secondDatabase + '`.spectral_libraries SET name=CONCAT(name," 数据库乙")'
  )
  const demo = JSON.parse(fs.readFileSync('examples/analysis/检测结果演示_15条.json', 'utf8'))
  await admin.query('USE `' + secondDatabase + '`')
  const sourceId = (await admin.query('SELECT MIN(id) id FROM spectral_libraries'))[0][0].id
  for (let i = 0; i < demo.results.length; i++) {
    const row = { ...demo.results[i], peakRules: demo.peakRules }
    await admin.query(
      "INSERT INTO experiment_results(id,compound_id,source_library_id,batch_name,method_name,rule_version,status,data) VALUES(?,?,?,?,?,?,'completed',?)",
      [
        row.id,
        i === 0 ? 1 : (i % 7) + 2,
        sourceId,
        '自动检查集成测试',
        '测试方法',
        'test-1',
        JSON.stringify(row)
      ]
    )
  }
  await admin.query(
    "INSERT INTO chromatogram_traces(id,compound_id,source_library_id,method_name,rule_version,status,image_base64,data) VALUES('image-only',1,?,'图片参考','test-1','completed',?,?)",
    [sourceId, 'data:image/png;base64,iVBORw0KGgo=', JSON.stringify({ checks: ['peak'] })]
  )
  await admin.query(
    "INSERT INTO experiment_results(id,compound_id,batch_name,method_name,rule_version,status,data) VALUES('draft',1,'草稿','测试方法','test-1','draft','{}')"
  )
  const primaryId = '11111111-1111-4111-8111-111111111111',
    secondId = '22222222-2222-4222-8222-222222222222'
  const config = {
    host: '127.0.0.1',
    port: 44715,
    user: 'root',
    adapter: 'native',
    enabled: true,
    writable: true
  }
  fs.writeFileSync(
    path.join(userData, 'connections.json'),
    JSON.stringify({
      primaryId,
      connections: [
        { ...config, id: primaryId, name: '甲库', database },
        { ...config, id: secondId, name: '乙库', database: secondDatabase }
      ],
      favorites: [],
      groups: [],
      audit: {
        enabled: true,
        connectionId: primaryId,
        database: auditDatabase,
        intervalSeconds: 3600
      }
    })
  )
  require(path.resolve('out/main/index.js'))
  await started
  let state = await invoke('audit:status')
  for (let i = 0; i < 400; i++) {
    state = await invoke('audit:status')
    if (state.scans.filter((x) => x.state === 'completed').length === 2 && !state.running) break
    await new Promise((r) => setTimeout(r, 30))
  }
  assert.equal(state.error, '', JSON.stringify(state))
  assert(state.ready)
  assert.equal(state.scans.filter((s) => s.state === 'completed').length, 2)
  check('两来源库自动索引，独立SQL审核库正常初始化，未使用文件导入')
  let list = await invoke('federation:list', {})
  assert.equal(list.total, 15)
  assert.equal(list.unified, true)
  const merged = list.list.find((r) => r.memberCount === 2)
  assert(merged)
  assert.equal(merged.dataOverview.spectra, 4)
  assert.equal(merged.dataOverview.numericTraces, 1)
  assert.equal(merged.dataOverview.images, 1)
  assert(
    (await invoke('federation:list', { dataTypes: ['spectrum', 'numeric'] })).list.some(
      (x) => x.ref.key === merged.ref.key
    )
  )
  assert(
    (await invoke('federation:list', { dataTypes: ['image'] })).list.some(
      (x) => x.ref.key === merged.ref.key
    )
  )
  const raw = await invoke('federation:list', { unifiedView: false })
  assert.equal(raw.total, 16)
  check('完整结构标识自动关联，跨库相同本地ID隔离，数据标签与多条件筛选正确')
  const results = await invoke('audit:results', {})
  assert.equal(results.total, 16)
  assert.equal((await invoke('audit:results', { issue: 'fronting' })).total, 1)
  assert.equal((await invoke('audit:results', { issue: 'tailing' })).total, 3)
  assert.equal((await invoke('audit:results', { issue: 'split' })).total, 1)
  assert.equal((await invoke('audit:results', { issue: 'limit' })).total, 2)
  assert.equal((await invoke('audit:results', { issue: 'ratio' })).total, 2)
  assert.equal(
    (await invoke('audit:results', { state: 'incomplete' })).rows.find(
      (r) => r.result.id === 'chromatogram_traces:image-only'
    ).result.peak.state,
    'unknown'
  )
  check('数据库数值轨迹识别前延、拖尾、分叉、超限及离子比；仅图片为数据不足、草稿不检查')
  const nativeDetail = await invoke('federation:detail', merged.ref)
  assert.equal(nativeDetail.compound.readOnly, true)
  assert.equal(nativeDetail.extensions.spectra.length, 4)
  assert(nativeDetail.lcMethods[0].methodsLinks.length > 0)
  assert.equal(nativeDetail.audit.assets.filter((a) => a.kind !== 'spectrum').length, 2)
  const bSources = await invoke('federation:sources', '数据库乙', 0),
    aSources = await invoke('federation:sources', '农残资料', 0)
  const sourceA = aSources.list.find((x) => !x.name.includes('数据库乙'))
  assert(sourceA)
  const aOnly = await invoke('federation:list', { sourceIds: [sourceA.id], dataTypes: ['numeric'] })
  assert.equal(aOnly.total, 0)
  const bOnly = await invoke('federation:list', {
    sourceIds: [bSources.list.find((s) => s.name.includes('农残资料')).id],
    dataTypes: ['numeric']
  })
  assert(bOnly.total > 0)
  const sourceDetail = await invoke('federation:detail', merged.ref, { sourceIds: [sourceA.id] })
  assert.equal(sourceDetail.audit.assets.filter((a) => a.kind !== 'spectrum').length, 0)
  assert.equal(sourceDetail.extensions.spectra.length, 2)
  check('统一详情同时展示来源谱图、色谱及梯度；来源筛选不跨来源借用标签')
  const selected = results.rows.find((r) => r.result.id === 'experiment_results:DEMO-07')
  const evidence = await invoke('audit:check', selected.id)
  await invoke('audit:review', selected.id, evidence.revision, {
    reviewer: '集成测试',
    reason: '验证自动检查与人工复核隔离',
    action: 'retest'
  })
  const before = (
    await admin.query('SELECT COUNT(*) n FROM `' + auditDatabase + '`.qc_checks')
  )[0][0].n
  await invoke('audit:run')
  const after = (
    await admin.query('SELECT COUNT(*) n FROM `' + auditDatabase + '`.qc_checks')
  )[0][0].n
  assert.equal(before, after)
  assert.equal((await invoke('audit:check', selected.id)).reviews.length, 1)
  check('重复扫描不重复生成结果，人工复核和原始判定保留')
  await admin.query(
    'UPDATE `' +
      secondDatabase +
      '`.experiment_results SET data=JSON_SET(data,?,0.000001) WHERE id="DEMO-07"',
    ['$.measurement.value']
  )
  await invoke('audit:run')
  const updated = (await invoke('audit:results', {})).rows.find(
    (r) => r.result.id === 'experiment_results:DEMO-07'
  )
  assert.notEqual(updated.id, selected.id)
  assert.equal(updated.result.limit.state, 'pass')
  assert.equal((await invoke('audit:check', selected.id)).reviews.length, 1)
  check('Navicat式SQL修改自动重新检查，保存旧数据快照及复核历史')
  const json = path.join(directory, 'fields.json')
  await invoke('federation:export', {
    format: 'json',
    selectionOnly: true,
    refs: [merged.ref],
    filePath: json,
    selection: { fields: ['cas', 'formula'], contents: [] }
  })
  const exported = JSON.parse(fs.readFileSync(json, 'utf8'))
  assert.deepEqual(Object.keys(exported.records[0]).sort(), ['record_ref', 'cas', 'formula'].sort())
  const curve = path.join(directory, 'curve.json')
  await invoke('federation:export', {
    format: 'json',
    selectionOnly: true,
    refs: [merged.ref],
    filePath: curve,
    selection: { fields: ['main_name'], contents: ['chromatograms', 'checks'] }
  })
  const full = JSON.parse(fs.readFileSync(curve))
  assert.equal(full.records[0].chromatograms.length, 2)
  assert(full.records[0].checks.length === 2)
  for (const format of ['csv', 'xlsx'])
    await invoke('federation:export', {
      format,
      selectionOnly: true,
      refs: [merged.ref],
      filePath: path.join(directory, 'fields.' + format),
      selection: { fields: ['main_name', 'cas'], contents: [] }
    })
  check('JSON/CSV/Excel按字段导出，取消内容未泄漏，色谱与检查内容可选')
  const checkedFile = path.join(directory, 'selected-checks.json')
  await invoke('audit:export', {
    format: 'json',
    filePath: checkedFile,
    filters: { issue: 'ratio' },
    fields: ['compound', 'observedRatio']
  })
  const checkReport = JSON.parse(fs.readFileSync(checkedFile))
  assert.equal(checkReport.records.length, 2)
  assert.deepEqual(
    Object.keys(checkReport.records[0]).sort(),
    ['check_id', 'compound', 'observedRatio'].sort()
  )
  check('按异常筛选的检查结果支持字段选择导出')

  await admin.query(
    'INSERT INTO `' +
      secondDatabase +
      '`.experiment_rules(id,method_name,rule_version,active,data) VALUES("r1","测试方法","rules-2",1,?)',
    [JSON.stringify({ peakRules: demo.peakRules })]
  )
  await invoke('audit:run')
  const ruled = (await invoke('audit:results', {})).rows.find(
    (r) => r.result.id === 'experiment_results:DEMO-07'
  )
  assert.notEqual(ruled.id, updated.id)
  assert.equal((await invoke('audit:check', ruled.id)).rule_version, 'rules-2')
  const history = await invoke('audit:history', (await invoke('audit:check', ruled.id)).asset_id)
  assert(history.length >= 3)
  check('数据库规则版本改变触发重算，历史检查可逐次查看')
  await admin.query(
    'ALTER TABLE `' +
      secondDatabase +
      '`.experiment_results CHANGE status pending_status VARCHAR(32) NOT NULL'
  )
  await invoke('audit:run')
  const failed = await invoke('federation:list', {})
  assert.equal(failed.total, 15)
  assert.equal(failed.complete, false)
  assert(failed.warnings.some((x) => x.message.includes('先前索引')))
  await admin.query(
    'ALTER TABLE `' +
      secondDatabase +
      '`.experiment_results CHANGE pending_status status VARCHAR(32) NOT NULL'
  )
  await invoke('audit:run')
  check('来源读取失败时保留已有索引并提示过期，不把未读取记录当成已删除')
  await admin.query(
    'CREATE TABLE `' +
      secondDatabase +
      '`.custom_results(id INT PRIMARY KEY,analyte_id INT,sample_name VARCHAR(64),concentration DOUBLE,concentration_unit VARCHAR(32),max_value DOUBLE,max_unit VARCHAR(32),policy VARCHAR(64),complete VARCHAR(32))'
  )
  await admin.query(
    'INSERT INTO `' +
      secondDatabase +
      '`.custom_results VALUES(1,1,"映射样品",0.2,"mg/kg",0.1,"mg/kg","演示规则","done"),(2,1,"草稿",9,"mg/kg",0.1,"mg/kg","演示规则","draft")'
  )
  const entry = (await invoke('connections:list')).find((x) => x.id === secondId)
  await invoke('connections:save', {
    ...entry,
    auditMapping: {
      table: 'custom_results',
      key: 'id',
      compoundKey: 'analyte_id',
      completedValue: 'done',
      fields: {
        sample: 'sample_name',
        concentration: 'concentration',
        unit: 'concentration_unit',
        limit: 'max_value',
        limit_unit: 'max_unit',
        limit_source: 'policy',
        status: 'complete'
      }
    }
  })
  await invoke('audit:run')
  const mapped = await invoke('audit:results', {})
  assert.equal(mapped.total, 2)
  assert(mapped.rows.some((x) => x.result.sample === '映射样品' && x.result.limit.state === 'fail'))
  assert(!mapped.rows.some((x) => x.result.sample === '草稿'))
  await invoke('connections:save', { ...entry, auditMapping: undefined })
  await invoke('audit:run')
  check('非标准结果表的一次字段映射可读取，完成状态过滤有效')
  await admin.query(
    'UPDATE `' + secondDatabase + '`.experiment_results SET data=JSON_ARRAY(1,2) WHERE id="DEMO-15"'
  )
  await invoke('audit:run')
  const malformed = (await invoke('audit:results', {})).rows.find(
    (x) => x.result.id === 'experiment_results:DEMO-15'
  )
  assert(malformed.result.incomplete)
  assert.equal(malformed.result.peak.state, 'unknown')
  await admin.query(
    'UPDATE `' + secondDatabase + '`.experiment_results SET data=? WHERE id="DEMO-15"',
    [JSON.stringify({ ...demo.results[14], peakRules: demo.peakRules })]
  )
  await invoke('audit:run')
  check('单条检测JSON格式错误被标记为数据不足，其他记录继续检查')

  await invoke('audit:pause')
  const others = list.list.filter((r) => r.memberCount === 1).slice(0, 2)
  const event = await invoke(
    'audit:merge',
    others.map((x) => x.ref),
    '集成测试',
    '人工身份核对测试'
  )
  assert.equal((await invoke('federation:list', {})).total, 14)
  await invoke('audit:unmerge', event.id)
  assert.equal((await invoke('federation:list', {})).total, 15)
  check('人工关联和撤销保留来源、子数据及独立主键')
  await invoke('federation:group-save', { name: '统一记录分组验证', refs: [merged.ref] })
  const group = (await invoke('federation:groups')).find((x) => x.class_name === '统一记录分组验证')
  assert.equal(group.count, 1)
  assert.equal((await invoke('federation:list', { classId: group.id })).total, 1)
  await invoke('federation:group-remove-records', { id: group.id, refs: [merged.ref] })
  assert.equal((await invoke('federation:list', { classId: group.id })).total, 0)
  await invoke('federation:favorite', merged.ref)
  assert(
    (await invoke('federation:list', { favoriteOnly: true })).list.some(
      (x) => x.ref.key === merged.ref.key
    )
  )
  await invoke('federation:favorite', merged.ref)
  check('统一记录的本地分组保存、去重计数、移除及收藏操作正常')
  await admin.query('INSERT INTO `'+secondDatabase+'`.experiment_results(id,compound_id,batch_name,method_name,rule_version,status,data) SELECT CONCAT("capacity-",a.id,"-",b.id,"-",c.id,"-",d.id,"-",e.id),1,"容量检查","容量检查","cap-1","completed",JSON_OBJECT("checks",JSON_ARRAY()) FROM `'+secondDatabase+'`.compounds a CROSS JOIN `'+secondDatabase+'`.compounds b CROSS JOIN `'+secondDatabase+'`.compounds c CROSS JOIN `'+secondDatabase+'`.compounds d CROSS JOIN `'+secondDatabase+'`.compounds e LIMIT 10001')
  await invoke('audit:run');assert((await invoke('audit:status')).error.includes('10000'));assert.equal((await invoke('federation:list',{})).total,15)
  await admin.query('DELETE FROM `'+secondDatabase+'`.experiment_results WHERE id LIKE "capacity-%"');await invoke('audit:run');assert.equal((await invoke('audit:results',{})).total,16)
  check('容量上限在读取前拒绝超大单化合物批次，保留索引且恢复后可继续检查')


  report.status = 'passed'
}
main()
  .catch((error) => {
    report.status = 'failed'
    report.error = error.stack
    console.error(error)
  })
  .finally(async () => {
    clearTimeout(deadline)
    app.emit('before-quit')
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(
      path.join(output, '数据库自动检查集成测试.json'),
      JSON.stringify(report, null, 2)
    )
    if (admin) {
      for (const db of [database, secondDatabase, auditDatabase])
        await admin.query('DROP DATABASE IF EXISTS `' + db + '`')
      await admin.end()
    }
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length }))
    process.exit(report.status === 'passed' ? 0 : 1)
  })
