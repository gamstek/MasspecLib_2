import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import mysql from 'mysql2/promise'
import { createServer } from 'vite'
import { decodePackage } from '../src/shared/dataPackage.ts'
import { taxonomyKey } from '../src/shared/taxonomy.ts'
import { validateDatabaseTarget } from '../src/shared/databaseTarget.ts'
import { DEMO_DATABASE } from './create-taxonomy-demo.mjs'

const directory = resolve(process.argv[2] ?? 'outputs/分类功能演示库')
const database = validateDatabaseTarget(process.env.DEMO_DATABASE ?? DEMO_DATABASE)
const config = {
  host: process.env.DEMO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.DEMO_MYSQL_PORT ?? 44715),
  user: process.env.DEMO_MYSQL_USER ?? 'root',
  password: process.env.DEMO_MYSQL_PASSWORD ?? '',
  database
}
const temporary = mkdtempSync(join(tmpdir(), 'masspeclib2-classification-demo-'))
const configPath = join(temporary, '.env.masspeclib2')
writeFileSync(configPath, [
  `DATABASE_HOST=${config.host}`, `DATABASE_PORT=${config.port}`, `DATABASE_USER=${config.user}`,
  `DATABASE_PASSWORD=${JSON.stringify(config.password)}`, `DATABASE_NAME=${database}`, ''
].join('\n'), { mode: 0o600 })
const report = { status: 'running', checkedAt: new Date().toISOString(), database, checks: [],
  scope: '真实MySQL + 软件初始化/导入/联合查询/分类IPC/详情读取保存服务；不等同于Windows安装版鼠标验收',
  data: {}, error: null }
const check = (name, evidence) => { report.checks.push({ name, result: 'pass', evidence }); console.log('PASS:', name) }
let server, db, registry, clients, entry
try {
  const data = decodePackage(readFileSync(join(directory, '分类功能演示包.msldata')))
  const standalone = await mysql.createConnection({ ...config, database: undefined })
  try {
    await standalone.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally { await standalone.end() }
  db = await mysql.createConnection(config)
  const [tables] = await db.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [database])
  server = await createServer({ configFile: false, root: process.cwd(), server: { middlewareMode: true },
    appType: 'custom', optimizeDeps: { noDiscovery: true }, ssr: { external: ['@prisma/adapter-mariadb', 'mariadb', 'mysql2', 'xlsx'] } })
  const module = file => server.ssrLoadModule('/' + file)
  const configuration = await module('src/main/databaseConfig.ts')
  configuration.setDatabaseConfigDirectory(temporary)
  const initialization = await module('src/main/databaseInitialization.ts')
  if (!tables.length) {
    const result = await initialization.initializeDatabase(join(directory, 'masspeclib2-initialize.sql'), { config, configPath })
    assert.equal(result.ok, true, JSON.stringify(result))
    check('使用软件初始化流程建立结构4演示库', { schemaVersion: 4, initialized: true })
  } else {
    const [metadata] = await db.query('SELECT product,schema_version,state FROM app_metadata WHERE id=1')
    assert.deepEqual(metadata[0], { product: 'MasspecLib2', schema_version: 4, state: 'ready' })
    const [existing] = await db.query('SELECT package_id FROM import_batches')
    assert(existing.every(item => item.package_id === data.packageId), '现有数据库含其他数据包，拒绝使用')
    check('复用已初始化的独立演示库', metadata[0])
  }
  registry = await module('src/main/federation/registry.ts')
  entry = registry.connection(registry.getState().primaryId)
  clients = await module('src/main/database.ts')
  const exchange = await module('src/main/services/dataExchange.ts')
  const scoped = operation => clients.withDatabase(entry.id, true, operation)
  const path = join(directory, '分类功能演示包.msldata')
  const preview = await scoped(() => exchange.previewDataPackage(path))
  assert.equal(preview.total, 8)
  check('软件数据包预览识别8条记录', { total: preview.total, newCount: preview.newCount, skipped: preview.skipped })
  const imported = await scoped(() => exchange.importDataPackage(path, preview.hash))
  assert.equal(imported.success, true, JSON.stringify(imported))
  assert.equal(imported.imported + imported.skipped, 8)
  check('使用软件导入服务写入演示数据', imported)
  const secondImport = await scoped(() => exchange.importDataPackage(path))
  assert.equal(secondImport.imported, 0)
  assert.equal(secondImport.skipped, 8)
  check('重复导入跳过相同数据，未产生重复记录', { imported: 0, skipped: 8 })
  const federation = await module('src/main/federation/service.ts')
  const adapters = await module('src/main/federation/adapters.ts')
  const ipc = new Map()
  federation.registerFederationIPC({ handle(channel, handler) { ipc.set(channel, handler) } })
  const all = await federation.federatedList({})
  assert.equal(all.complete, true, JSON.stringify(all.warnings))
  assert.equal(all.total, 8)
  check('全部化合物列表返回8条记录', { total: all.total, complete: all.complete })
  const tree = await ipc.get('federation:categories')(null)
  const nodes = new Map()
  function visit(items) { for (const item of items) { nodes.set(item.key, item); visit(item.children ?? []) } }
  visit(tree)
  const ns = data.taxonomyCatalog[0].namespace
  const expectedCounts = { pesticides: 3, pesticide_insecticide: 2, pesticide_fungicide: 2, drugs: 1, antibiotics: 1,
    toxins: 1, natural: 2, metabolism: 1, microbial_metabolites: 1, chemicals: 0, alkaloids: 0, pending: 1 }
  for (const [code, expected] of Object.entries(expectedCounts)) {
    const node = nodes.get(taxonomyKey(ns, code))
    assert(node, '缺少分类 ' + code)
    assert.equal(node.count, expected, '分类计数 ' + code)
    const filtered = await federation.federatedList({ classId: node.id })
    assert.equal(filtered.complete, true, JSON.stringify(filtered.warnings))
    assert.equal(filtered.total, expected, '分类筛选 ' + code)
    assert.equal(new Set(filtered.list.map(item => item.ref.key)).size, expected)
  }
  check('12个分类节点及其检索数量正确，父级检索去重', expectedCounts)
  assert(tree.some(axis => axis.label === '应用与检测对象'))
  assert(tree.some(axis => axis.label === '来源与生物来源'))
  assert(nodes.get(taxonomyKey(ns, 'pesticides')).children.some(node => node.key === taxonomyKey(ns, 'pesticide_insecticide')))
  check('分类树保留原SQL维度分组和父子层级', { dimensions: tree.map(node => node.label) })
  const pesticideId = nodes.get(taxonomyKey(ns, 'pesticides')).id
  const keyword = await federation.federatedList({ classId: pesticideId, keyword: '演示C' })
  assert.equal(keyword.total, 1)
  const sourceCandidates = await federation.sourceOptions('分类演示')
  assert.equal(sourceCandidates.list.length, 2)
  const source = sourceCandidates.list.find(item => item.name === '分类演示·农残资料')
  assert(source)
  assert.equal((await federation.federatedList({ classId: pesticideId, sourceIds: [source.id] })).total, 3)
  assert.equal((await federation.federatedList({ classId: pesticideId, sourceQuery: '综合资料' })).total, 0)
  check('分类可结合名称、来源输入及来源多选进行检索', { keywordCount: 1, matchingSource: 3, otherSource: 0 })
  const multi = all.list.find(item => item.main_name === '演示E·跨维度多分类')
  assert(multi, '未返回跨维度示例记录')
  const multiDetail = await adapters.detail(multi.ref)
  assert.equal(multiDetail.extensions.classifications.length, 3)
  check('详情返回跨维度多分类完整归属', { categories: multiDetail.extensions.classifications.map(c => c.category_code) })
  const unclassified = all.list.find(item => item.main_name === '演示H·未指定分类')
  assert.equal((await adapters.detail(unclassified.ref)).extensions.classifications.length, 0)
  check('未指定分类记录保留空归属，不自动放入其他类别', { classifications: 0 })
  let spectra = 0, peaks = 0, liquid = 0, steps = 0
  for (const record of all.list) {
    const detail = await adapters.detail(record.ref)
    spectra += detail.extensions.spectra.length
    for (const s of detail.extensions.spectra) {
      peaks += s.peaks.length
      assert.equal(s.nature, 'synthetic-test')
      assert.equal(s.methodIds.length, 1)
      assert(s.peaks.every(p => Number.isFinite(Number(p.mz)) && Number.isFinite(Number(p.intensity))))
    }
    for (const m of detail.lcMethods) {
      liquid++
      steps += m.methodsLinks.length
      assert.equal(Number(m.column_particle_size_um), 1.8)
      assert.equal(m.retention_time_unit, 'min')
      assert(m.phase_A && m.phase_B)
      assert.equal(m.elution_mode, 'gradient')
      assert.equal(m.methodsLinks.length, 6)
      assert(m.methodsLinks.every(s => Number(s.percentage_A) + Number(s.percentage_B) === 100))
    }
  }
  assert.deepEqual({ spectra, peaks, liquid, steps }, { spectra: 10, peaks: 50, liquid: 8, steps: 48 })
  check('详情保留谱峰、谱图方法关联、柱参数和全部液相梯度', { spectra, peaks, liquid, steps })
  const target = all.list.find(item => item.main_name === '演示F·仅一级分类')
  const baseline = await adapters.detail(target.ref)
  const edits = await module('src/main/services/compoundDetails.ts')
  const save = detail => scoped(() => edits.saveCompoundDetails({
    compound: detail.compound, classIdList: [], customClassIdList: [],
    compoundMsMethodList: detail.methods, compoundLcMethodList: detail.lcMethods,
    deletedMsMethodIds: [], deletedLcMethodIds: [], pendingSpectrumImports: [],
    extensions: { spectra: detail.extensions.spectra, classifications: detail.extensions.classifications }
  }))
  const changed = structuredClone(baseline)
  changed.extensions.classifications.push({ namespace: ns, category_code: 'alkaloids' })
  changed.lcMethods[0].retention_time = 3.75
  changed.lcMethods[0].methodsLinks[2].percentage_A = '10'
  changed.lcMethods[0].methodsLinks[2].percentage_B = '90'
  changed.lcMethods[0].methodsLinks[2].flow_rate = 0.35
  try {
    const result = await save(changed)
    assert.equal(result.success, true, JSON.stringify(result))
    const updated = await adapters.detail(target.ref)
    assert.equal(updated.extensions.classifications.length, 2)
    assert.equal(Number(updated.lcMethods[0].retention_time), 3.75)
    assert.equal(updated.lcMethods[0].methodsLinks[2].percentage_B, '90')
    assert.equal(Number(updated.lcMethods[0].methodsLinks[2].flow_rate), 0.35)
    assert.equal(updated.extensions.spectra.length, baseline.extensions.spectra.length)
    const updatedSearch = await federation.federatedList({ classId: nodes.get(taxonomyKey(ns, 'alkaloids')).id })
    assert.equal(updatedSearch.total, 1)
    const afterTree = await ipc.get('federation:categories')(null)
    const afterNodes = new Map()
    function walk(items) { for (const item of items) { afterNodes.set(item.key, item); walk(item.children ?? []) } }
    walk(afterTree)
    assert.equal(afterNodes.get(taxonomyKey(ns, 'alkaloids')).count, 1)
    check('通过详情保存服务修改分类、保留时间和梯度，重读及分类统计同步更新', { addedCategory: 'alkaloids', retentionTime: 3.75, percentageB: 90, flowRate: 0.35 })
  } finally {
    const latest = await adapters.detail(target.ref)
    const restore = structuredClone(baseline)
    restore.compound.revision = latest.compound.revision
    for (const spectrum of restore.extensions.spectra)
      spectrum.revision = latest.extensions.spectra.find(s => s.id === spectrum.id).revision
    // Method revisions do not gate writes but retaining the current objects ensures ownership remains checked.
    const restored = await save(restore)
    assert.equal(restored.success, true, JSON.stringify(restored))
  }
  const restored = await adapters.detail(target.ref)
  assert.equal(restored.extensions.classifications.length, 1)
  assert.equal(Number(restored.lcMethods[0].retention_time), Number(baseline.lcMethods[0].retention_time))
  check('验证后恢复演示数据，保留可重复操作的初始状态', { target: target.main_name })
  const [counts] = await db.query(`SELECT
    (SELECT COUNT(*) FROM compounds) compounds,
    (SELECT COUNT(*) FROM taxonomy_categories) categories,
    (SELECT COUNT(*) FROM compound_taxonomy) classifications,
    (SELECT COUNT(*) FROM spectra) spectra,
    (SELECT COUNT(*) FROM lc_methods) lcMethods,
    (SELECT COUNT(*) FROM lc_methods_items) gradientSteps,
    (SELECT COUNT(*) FROM spectral_libraries) sources`)
  report.data = counts[0]
  report.status = 'passed'
  writeFileSync(join(directory, '软件服务验证报告.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(directory, '预期分类树.json'), JSON.stringify(tree, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, database, checks: report.checks.length, ...report.data }, null, 2))
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  writeFileSync(join(directory, '软件服务验证报告.json'), JSON.stringify(report, null, 2) + '\n')
  console.error(error)
  process.exitCode = 1
} finally {
  if (clients && entry) await clients.resetDatabaseClient(entry.id)
  if (registry && entry) await (await registry.pool(entry)).end()
  if (db) await db.end()
  if (server) await server.close()
}
