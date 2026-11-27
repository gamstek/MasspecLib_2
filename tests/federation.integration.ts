/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { encodePackage, decodePackage } from '../src/shared/dataPackage.ts'
async function main(): Promise<void> {
  const runtime = JSON.parse(
    await readFile('/workspace/outputs/MasspecLib2_临时测试库运行记录.json', 'utf8')
  )
  const db = await mysql.createConnection({
    host: '127.0.0.1',
    port: runtime.port,
    user: 'root',
    password: ''
  })
  const [place]: any = await db.query('SELECT @@datadir AS datadir')
  assert.ok(place[0].datadir.startsWith('/tmp/masspeclib2-mysql-'))
  const dir = await mkdtemp('/tmp/masspeclib2-federation-'),
    config = join(dir, '.env.masspeclib2')
  await writeFile(
    config,
    `DATABASE_HOST=127.0.0.1\nDATABASE_PORT=${runtime.port}\nDATABASE_USER=root\nDATABASE_PASSWORD=\nDATABASE_NAME=mspec_lib2_federation_c\n`
  )
  process.env.MASSPECLIB2_DATABASE_CONFIG = config
  require('../src/main/databaseConfig.ts').setDatabaseConfigDirectory(dir)
  const defs = ['C', 'D'].map((id, index) => ({
    id,
    name: '测试库' + id,
    host: '127.0.0.1',
    port: runtime.port,
    user: 'root',
    database: 'mspec_lib2_federation_' + (index ? 'd' : 'c'),
    adapter: 'native',
    writable: true,
    enabled: true
  }))
  defs.push({
    id: 'E',
    name: '自定义格式库',
    host: '127.0.0.1',
    port: runtime.port,
    user: 'root',
    database: 'external_federation_test',
    adapter: 'mapped',
    writable: false,
    enabled: true,
    mapping: {
      table: 'items',
      key: 'record_uuid',
      fields: { main_name: 'title', source_name: 'origin', source_provider: 'provider' },
      sourceType: 'local'
    }
  } as any)
  await writeFile(
    join(dir, 'connections.json'),
    JSON.stringify({ primaryId: 'C', connections: defs, favorites: [], groups: [] })
  )
  const steps: any[] = [],
    record = (name: string): void => {
      steps.push({ name, status: 'passed' })
      console.log('PASS ' + name)
    }
  const { withDatabase, prisma, resetDatabaseClient } = require('../src/main/database.ts')
  const registry = require('../src/main/federation/registry.ts'),
    adapters = require('../src/main/federation/adapters.ts')
  const service = require('../src/main/federation/service.ts'),
    exchange = require('../src/main/services/dataExchange.ts')
  try {
    for (const entry of defs) {
      await db.query('DROP DATABASE IF EXISTS `' + entry.database + '`')
      await db.query('CREATE DATABASE `' + entry.database + '` CHARACTER SET utf8mb4')
    }
    for (const entry of defs.slice(0, 2)) {
      const initialized = await require('../src/main/databaseInitialization.ts').initializeDatabase(
        resolve('prisma/masspeclib2-initialize.sql'),
        {
          config: {
            host: entry.host,
            port: entry.port,
            user: entry.user,
            password: '',
            database: entry.database
          },
          configPath: '临时测试连接'
        }
      )
      assert.equal(initialized.ok, true, JSON.stringify(initialized))
    }
    record('指定新增连接的空库初始化及结构版本3校验')
    await db.query('USE external_federation_test')
    await db.query(
      'CREATE TABLE items (record_uuid VARCHAR(64) PRIMARY KEY,title VARCHAR(255),origin VARCHAR(255),provider VARCHAR(255))'
    )
    await db.query('INSERT INTO items VALUES (?,?,?,?),(?,?,?,?)', [
      'uuid-1',
      '外部中文',
      '中药药典',
      '甲',
      'uuid-2',
      '外部中文二',
      '中药药典',
      '乙'
    ])
    const base = JSON.parse(await readFile('examples/synthetic-source.json', 'utf8'))
    base.groups[0].source = {
      namespace: 'test-common-source',
      key: 'case-1',
      name: '中药药典（测试）',
      sourceType: 'public',
      provider: '测试提供者',
      location: '仅供软件测试'
    }
    Object.assign(base.groups[0].compound, {
      main_name: '测试化合物C',
      name_zh: '测试中文C',
      name_en: 'Test C',
      formula_diagram_base64: 'HISTORICAL_STRUCTURE_RETAINED'
    })
    Object.assign(base.groups[0].lcMethods[0], {
      column_type: '测试柱',
      column_length_mm: '100.000',
      column_inner_diameter_mm: '2.100',
      column_particle_size_um: '1.700',
      column_temperature_c: 0,
      elution_mode: 'gradient',
      program_text: '测试梯度'
    })
    const input = join(dir, 'input.msldata')
    await writeFile(input, encodePackage(base))
    for (const id of ['C', 'D']) {
      const result = await withDatabase(id, true, () => exchange.importDataPackage(input))
      assert.equal(result.imported, 1, JSON.stringify(result))
      assert.equal((await adapters.rows(registry.connection(id), {}, 0, 10))[0].ref.key, '1')
    }
    const unified = await service.federatedList({ pageSize: 1, page: 1 })
    assert.equal(unified.total, 4)
    assert.equal(unified.list[0].ref.connectionId, 'C')
    const second = await service.federatedList({ pageSize: 1, page: 2 })
    assert.equal(second.list[0].ref.connectionId, 'D')
    assert.notEqual(second.list[0].rowKey, unified.list[0].rowKey)
    assert.equal(unified.list[0].formula_diagram_base64, undefined)
    assert.equal(unified.list[0].sources[0].raw, undefined)
    record('两个库相同ID独立定位、跨库分页且列表不传结构图和原始大对象')
    assert.equal((await service.federatedList({ sourceQuery: '中药', pageSize: 50 })).total, 4)
    assert.equal(
      (await service.federatedList({ keyword: '测试中文C', sourceQuery: '中药', pageSize: 50 }))
        .total,
      2
    )
    assert.equal(
      (await service.federatedList({ keyword: '不存在', sourceQuery: '中药', pageSize: 50 })).total,
      0
    )
    const choices = await service.sourceOptions('中药')
    const common = choices.list.find((x: any) => x.name === '中药药典（测试）')
    assert.ok(common)
    assert.equal(choices.list.filter((x: any) => x.name === '中药药典（测试）').length, 1)
    assert.equal(
      (await service.federatedList({ sourceQuery: '输入其他文字', sourceIds: [common.id] })).total,
      2
    )
    const mappedA = choices.list.find((x: any) => x.provider === '甲')
    assert.equal((await service.federatedList({ sourceIds: [mappedA.id] })).total, 1)
    record('来源仅输入模糊匹配、已选精确OR、化合物AND与同名提供者区分')
    const external = await adapters.detail({ connectionId: 'E', key: 'uuid-1' })
    assert.equal(external.compound.main_name, '外部中文')
    assert.equal(external.compound.readOnly, true)
    await assert.rejects(() => withDatabase('E', true, () => prisma.compounds.count()))
    await assert.rejects(() =>
      service.createRecord({ connectionId: 'E', compound: { main_name: '拒绝写入' } })
    )
    registry.toggleLocalFavorite(external.compound.rowKey, false)
    registry.saveGroup(undefined, '测试分组', [external.compound.rowKey, unified.list[0].rowKey])
    assert.equal((await service.federatedList({ favoriteOnly: true })).total, 1)
    assert.equal((await service.federatedList({ classId: 1 })).total, 2)
    record('字符串记录键适配、外库写入拒绝、本地收藏和多库分组')
    await Promise.all(
      ['C', 'D'].map((id) =>
        withDatabase(id, true, () =>
          prisma.compounds.update({ where: { id: 1 }, data: { main_name: '独立编辑' + id } })
        )
      )
    )
    assert.equal(
      (await adapters.detail({ connectionId: 'C', key: '1' })).compound.main_name,
      '独立编辑C'
    )
    assert.equal(
      (await adapters.detail({ connectionId: 'D', key: '1' })).compound.main_name,
      '独立编辑D'
    )
    const handlers = new Map<string, any>(),
      fakeIPC = {
        handle: (channel: string, handler: any): void => {
          handlers.set(channel, handler)
        }
      }
    require('../src/main/federation/ipcScope.ts').installScopedIPC(fakeIPC)
    fakeIPC.handle(
      'spectrum-import:validate',
      async () => (await prisma.compounds.findUniqueOrThrow({ where: { id: 1 } })).main_name
    )
    assert.equal(
      await handlers.get('spectrum-import:validate')(
        {},
        { __scope: 'masspeclib2', connectionId: 'D', args: [] }
      ),
      '独立编辑D'
    )
    fakeIPC.handle('compound:unit-write', async () =>
      prisma.compounds.update({ where: { id: 1 }, data: { main_name: '不可写' } })
    )
    registry.connection('D').writable = false
    await assert.rejects(() =>
      handlers.get('compound:unit-write')(
        {},
        { __scope: 'masspeclib2', connectionId: 'D', args: [] }
      )
    )
    registry.connection('D').writable = true
    record('谱图导入预览按详情连接路由、消息层阻止只读连接写入')
    record('并发异步写入分别路由到所属库，无重复ID串库')
    // Simulate an existing structure-v2 new database; upgrade preserves its rows.
    await db.query('USE mspec_lib2_federation_d')
    await db.query('ALTER TABLE compounds DROP COLUMN name_zh, DROP COLUMN name_en')
    await db.query('ALTER TABLE spectral_libraries DROP COLUMN source_type')
    await db.query('ALTER TABLE ms_methods DROP COLUMN transition_role')
    await db.query(
      'ALTER TABLE lc_methods DROP COLUMN column_type,DROP COLUMN column_length_mm,DROP COLUMN column_inner_diameter_mm,DROP COLUMN column_particle_size_um,DROP COLUMN column_temperature_c,DROP COLUMN elution_mode,DROP COLUMN program_text'
    )
    await db.query('UPDATE app_metadata SET schema_version=2')
    adapters.forgetColumns('D')
    assert.equal((await adapters.inspect(registry.connection('D'))).needsUpgrade, true)
    assert.equal((await adapters.detail({ connectionId: 'D', key: '1' })).compound.readOnly, true)
    await assert.rejects(() =>
      withDatabase('D', true, () =>
        prisma.compounds.update({ where: { id: 1 }, data: { main_name: '禁止旧结构写入' } })
      )
    )
    await require('../src/main/federation/upgrade.ts').upgradeDatabase('D')
    adapters.forgetColumns('D')
    await resetDatabaseClient('D')
    assert.equal((await adapters.inspect(registry.connection('D'))).schemaVersion, 3)
    assert.equal(
      (await adapters.detail({ connectionId: 'D', key: '1' })).compound.main_name,
      '独立编辑D'
    )
    await require('../src/main/federation/upgrade.ts').upgradeDatabase('D')
    record('结构2只读、受控升级3保留数据、重复升级安全')
    const out = join(dir, 'export.msldata')
    const exported = await service.exportFederated({
      selectionOnly: true,
      refs: [{ connectionId: 'C', key: '1' }],
      filePath: out
    })
    assert.equal(exported.success, true)
    const pkg = decodePackage(await readFile(out))
    assert.equal(pkg.groups[0].compound.formula_diagram_base64, 'HISTORICAL_STRUCTURE_RETAINED')
    assert.equal(pkg.groups[0].lcMethods![0].column_temperature_c, '0.000')
    const imported = await withDatabase('D', true, () => exchange.importDataPackage(out))
    assert.equal(imported.imported, 1, JSON.stringify(imported))
    const newRows = await adapters.rows(registry.connection('D'), {}, 0, 50)
    const newRef = newRows.find((x: any) => x.ref.key !== '1').ref
    const data = await adapters.detail(newRef)
    assert.ok(
      data.extensions.sources.some((x: any) => x.source_record.library.name === '中药药典（测试）')
    )
    assert.deepEqual(data.extensions.spectra[0].peaks, base.groups[0].spectra[0].peaks)
    assert.equal(data.extensions.spectra[0].methodIds[0], data.methods[0].methods[0].id)
    assert.equal((await withDatabase('D', true, () => exchange.importDataPackage(out))).skipped, 1)
    const undo = await withDatabase('D', true, () => exchange.undoImportBatch(imported.batchId))
    assert.equal(undo.undone, 1, JSON.stringify(undo))
    assert.equal(undo.conflicts.length, 0)
    record('跨库导出回导保留名称、液相新字段、原始谱峰、历史结构及来源证据，关联重映射与撤销')
    const created = await service.createRecord({
      connectionId: 'D',
      compound: { name_zh: '手工中文', name_en: 'Manual Test' },
      source: { name: '本地试验库', source_type: 'local', provider: '测试', location: '测试文件' }
    })
    const manual = await adapters.detail(created.ref)
    assert.equal(manual.compound.name_zh, '手工中文')
    assert.equal(manual.extensions.sources[0].source_record.library.source_type, 'local')
    record('手动新增到指定新库并保留四项来源信息')
    registry.getState().connections.push({ ...defs[0], id: 'OFFLINE', name: '离线测试库', port: 1 })
    const partial = await service.federatedList({})
    assert.equal(partial.complete, false)
    assert.equal(partial.warnings.length, 1)
    await assert.rejects(() =>
      service.exportFederated({
        selectionOnly: false,
        filters: {},
        filePath: join(dir, 'partial.msldata')
      })
    )
    record('连接故障明确提示不完整、完整范围导出拒绝静默漏库')
    await mkdir(resolve('test-results'), { recursive: true })
    await writeFile(
      resolve('test-results/federation-integration-report.json'),
      JSON.stringify({ passed: steps.length, steps, temporaryDirectory: dir }, null, 2)
    )
  } finally {
    await prisma.$disconnect()
    for (const entry of defs) await resetDatabaseClient(entry.id)
    await registry.closePools()
    await db.end()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
