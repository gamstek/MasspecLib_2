/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
// Delayed CommonJS imports let this integration test set a temporary target before creating clients.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import mysql from 'mysql2/promise'
import { encodePackage, decodePackage } from '../src/shared/dataPackage.ts'

async function main(): Promise<void> {
  const runtime = JSON.parse(
    await readFile('/workspace/outputs/MasspecLib2_临时测试库运行记录.json', 'utf8')
  )
  const configPath = process.env.MASSPECLIB2_INTEGRATION_CONFIG
  if (!configPath || !configPath.startsWith('/tmp/masspeclib2-mysql-'))
    throw new Error('仅允许使用本次临时测试服务配置')
  process.env.MASSPECLIB2_DATABASE_CONFIG = configPath
  const roundtripMode = process.argv[2] === '--roundtrip'
  const work = resolve('test-results')
  await mkdir(work, { recursive: true })
  if (roundtripMode) {
    const { importDataPackage, exportDataPackage } = require('../src/main/services/dataExchange.ts')
    const { prisma } = require('../src/main/database.ts')
    try {
      const result = await importDataPackage(process.argv[3])
      assert.equal(result.imported, 1)
      assert.equal(result.errors.length, 0)
      await exportDataPackage(resolve(work, 'roundtrip.msldata'))
      const rows = await prisma.spectrum_method_links.findMany()
      assert.equal(rows.length, 1)
      const spectrum = await prisma.spectra.findUniqueOrThrow({
        where: { id: rows[0].spectrum_id }
      })
      const method = await prisma.ms_methods.findUniqueOrThrow({ where: { id: rows[0].method_id } })
      assert.equal(spectrum.compound_id, method.compounds_id)
    } finally {
      await prisma.$disconnect()
    }
    process.exit(0)
  }
  const admin = await mysql.createConnection({
    host: '127.0.0.1',
    port: runtime.port,
    user: 'root',
    password: ''
  })
  const [location]: any = await admin.query('SELECT @@datadir AS datadir, @@version AS version')
  assert.ok(location[0].datadir.startsWith('/tmp/masspeclib2-mysql-'))
  const steps: any[] = []
  const record = (name: string, detail?: any): void => {
    steps.push({ name, status: 'passed', detail })
    console.log('PASS ' + name)
  }
  let prisma: any
  try {
    // These names exist only in the temporary service proven above, never in the user's service.
    for (const name of ['mspec_lib2_test_a', 'mspec_lib2_test_b']) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`)
      await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`)
    }
    const { initializeDatabase } = require('../src/main/databaseInitialization.ts')
    const initialized = await initializeDatabase(resolve('prisma/masspeclib2-initialize.sql'))
    assert.equal(initialized.ok, true, JSON.stringify(initialized))
    const refused = await initializeDatabase(resolve('prisma/masspeclib2-initialize.sql'))
    assert.equal(refused.ok, false)
    record('初始化成功及非空库拒绝')
    const exchange = require('../src/main/services/dataExchange.ts')
    const details = require('../src/main/services/compoundDetails.ts')
    prisma = require('../src/main/database.ts').prisma
    const example = JSON.parse(await readFile('examples/synthetic-source.json', 'utf8'))
    const input = resolve(work, 'synthetic.msldata')
    await writeFile(input, encodePackage(example))
    const preview = await exchange.previewDataPackage(input)
    assert.equal(preview.newCount, 1)
    const first = await exchange.importDataPackage(input, preview.hash)
    assert.equal(first.imported, 1, JSON.stringify(first))
    const repeated = await exchange.importDataPackage(input, preview.hash)
    assert.equal(repeated.imported, 0)
    assert.equal(repeated.skipped, 1)
    assert.equal(await prisma.compounds.count(), 1)
    record('正常导入、来源幂等与数量归账', {
      imported: first.imported,
      repeatSkipped: repeated.skipped
    })
    const spectrum = await prisma.spectra.findFirstOrThrow()
    const method = await prisma.ms_methods.findFirstOrThrow()
    assert.deepEqual(spectrum.peaks, example.groups[0].spectra[0].peaks)
    assert.equal(method.ce, -15)
    assert.equal(method.dp, 0)
    assert.equal(method.q3, null)
    const lc = await prisma.lc_methods.findFirstOrThrow()
    assert.equal(lc.retention_time_unit, null)
    const item = await prisma.lc_methods_items.findFirstOrThrow()
    assert.equal(item.flow_rate, 0)
    record('重复峰、十进制文本、高强度、负 CE、零和未知单位保真')
    const listing = require('../src/main/services/compoundList.ts')
    assert.equal((await listing.listCompounds({ spectrumKind: 'numeric', polarity: 2 })).total, 1)
    assert.equal((await listing.listCompounds({ spectrumKind: 'image' })).total, 0)
    assert.equal((await listing.listCompounds({ polarity: 1 })).total, 0)
    const library = await prisma.spectral_libraries.findFirstOrThrow()
    assert.equal(
      (await listing.listCompounds({ libraryId: library.id, keyword: '测试化合物' })).total,
      1
    )
    assert.equal((await listing.listCompounds({ keyword: "' OR 1=1 --" })).total, 0)
    const [countRows] = await admin.query(
      'SELECT COUNT(*) AS total FROM mspec_lib2_test_a.compounds'
    )
    assert.equal((countRows as any)[0].total, 1)
    record('来源、极性、形式、名称筛选及参数化查询')
    const undone = await exchange.undoImportBatch(first.batchId)
    assert.equal(undone.undone, 1, JSON.stringify(undone))
    assert.equal(await prisma.compounds.count(), 0)
    const undoneAgain = await exchange.undoImportBatch(first.batchId)
    assert.equal(undoneAgain.alreadyUndone, 1)
    const recreated = await exchange.importDataPackage(input)
    assert.equal(recreated.imported, 1, JSON.stringify(recreated))
    record('新增撤销、重复撤销与撤销后重导')
    const changed = structuredClone(example)
    changed.packageId = 'changed-source'
    changed.groups[0].methods[0].ce = -25
    const changedPath = resolve(work, 'changed.msldata')
    await writeFile(changedPath, encodePackage(changed))
    const conflict = await exchange.importDataPackage(changedPath)
    assert.equal(conflict.imported, 0)
    assert.equal(conflict.conflicts.length, 1)
    assert.equal((await prisma.ms_methods.findFirstOrThrow()).ce, -15)
    record('同来源新修订不静默覆盖')
    const output = resolve(work, 'export.msldata')
    await exchange.exportDataPackage(output)
    const exported = decodePackage(await readFile(output))
    assert.deepEqual(exported.groups[0].spectra![0].peaks, example.groups[0].spectra[0].peaks)
    assert.equal(exported.groups[0].provenance?.length, 1)
    const configB = resolve(runtime.root, '.env.masspeclib2-b')
    await writeFile(
      configB,
      (await readFile(configPath, 'utf8')).replace('mspec_lib2_test_a', 'mspec_lib2_test_b'),
      { mode: 0o600 }
    )
    process.env.MASSPECLIB2_DATABASE_CONFIG = configB
    assert.equal((await initializeDatabase(resolve('prisma/masspeclib2-initialize.sql'))).ok, true)
    process.env.MASSPECLIB2_DATABASE_CONFIG = configPath
    execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'tests/integration.ts', '--roundtrip', output],
      {
        env: { ...process.env, MASSPECLIB2_INTEGRATION_CONFIG: configB },
        stdio: 'pipe'
      }
    )
    const roundtrip = decodePackage(await readFile(resolve(work, 'roundtrip.msldata')))
    assert.deepEqual(roundtrip.groups[0].spectra![0].peaks, exported.groups[0].spectra![0].peaks)
    assert.equal(roundtrip.groups[0].methods![0].ce, exported.groups[0].methods![0].ce)
    assert.deepEqual(
      roundtrip.groups[0].lcMethods![0].items,
      exported.groups[0].lcMethods![0].items
    )
    record('第二空库回导、方法关联 ID 重映射及核心语义比较')
    const compound = await prisma.compounds.findFirstOrThrow()
    const ms = await prisma.ms_methods.findMany({ where: { compounds_id: compound.id } })
    const lcs = await prisma.lc_methods.findMany({
      where: { compounds_id: compound.id },
      include: { methodsLinks: true }
    })
    const info = {
      compound: { ...compound, main_name: '不应被保存' },
      classIdList: [2147483647],
      customClassIdList: [],
      compoundMsMethodList: [{ ms_mode: '', methods: ms }],
      compoundLcMethodList: lcs,
      formulaDiagramBase64: ''
    }
    const badSave = await details.saveCompoundDetails(info)
    assert.equal(badSave.success, false)
    assert.equal(
      (await prisma.compounds.findUniqueOrThrow({ where: { id: compound.id } })).revision,
      1
    )
    assert.equal(
      (await prisma.compounds.findUniqueOrThrow({ where: { id: compound.id } })).main_name,
      compound.main_name
    )
    record('详情关联写入失败时整体回滚')
    info.classIdList = []
    info.compound.main_name = '人工修改后的测试名称'
    const goodSave = await details.saveCompoundDetails(info)
    assert.equal(goodSave.success, true, JSON.stringify(goodSave))
    assert.equal((await details.saveCompoundDetails(info)).success, false)
    const protectedUndo = await exchange.undoImportBatch(first.batchId)
    assert.equal(protectedUndo.undone, 0)
    assert.equal(protectedUndo.conflicts.length, 1)
    assert.equal((await prisma.ms_methods.findFirstOrThrow()).ms_mode, null)
    record('编辑修订冲突与人工修改后的撤销保护')
    const legacy = require('../src/main/services/legacySpectra.ts')
    const templateRow = {
      spectrumId: 'template-1',
      compoundId: compound.id,
      cas: '',
      compoundName: info.compound.main_name,
      methodId: null,
      msMode: '模板测试仪器',
      q1: 150,
      q3: 75,
      polarity: 1,
      collisionEnergy: -10,
      precursorType: '[M+H]+',
      precursorMz: 150,
      spectrumType: '',
      instrumentType: '',
      instrumentName: '',
      ionization: '',
      sourceName: '测试造数',
      notes: '',
      peaksText: '100.0000000001,100000\n100.0000000001,5000',
      overwriteExisting: false
    }
    const ambiguous = await legacy.validateRows([{ ...templateRow, compoundId: null }])
    assert.equal(ambiguous[0].status, 'error')
    assert.equal(ambiguous[0].compoundId, null)
    const prepared = await legacy.prepareSpectrumRows([
      templateRow,
      { ...templateRow, spectrumId: 'template-2', collisionEnergy: -20 }
    ])
    assert.equal(prepared.length, 2)
    const templateSave = await details.saveCompoundDetails({
      ...info,
      compound: { ...info.compound, revision: goodSave.revision },
      pendingSpectrumImports: prepared
    })
    assert.equal(templateSave.success, true, JSON.stringify(templateSave))
    const templateMethods = await prisma.ms_methods.findMany({ where: { ms_mode: '模板测试仪器' } })
    assert.equal(templateMethods.length, 2)
    assert.deepEqual(
      templateMethods.map((row: any) => row.ce).sort((a: number, b: number) => a - b),
      [-20, -10]
    )
    const templateSpectrum = JSON.parse(
      Buffer.from(templateMethods[0].mass_spectrum_base64, 'base64').toString('utf8')
    )
    assert.equal(templateSpectrum.peaks.length, 2)
    assert.equal(templateSpectrum.raw.peaksText, templateRow.peaksText)
    assert.equal(templateSpectrum.acquisition.instrumentType, '')
    record('旧模板显式身份、不同 CE 分离、重复峰与原始文本保留、同事务保存')
    await admin.query(
      "CREATE TRIGGER mspec_lib2_test_a.inject_unit_failure BEFORE INSERT ON mspec_lib2_test_a.compounds FOR EACH ROW BEGIN IF NEW.main_name='模拟故障记录' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected unit failure'; END IF; END"
    )
    const faulty = structuredClone(example)
    faulty.packageId = 'fault-injection'
    faulty.groups[0].source.key = 'injected-failure'
    faulty.groups[0].compound.main_name = '模拟故障记录'
    const valid = structuredClone(example.groups[0])
    valid.source.key = 'after-error'
    faulty.groups.push(valid)
    const faultPath = resolve(work, 'fault.msldata')
    await writeFile(faultPath, encodePackage(faulty))
    const fault = await exchange.importDataPackage(faultPath)
    assert.equal(fault.errors.length, 1)
    assert.equal(fault.imported, 1)
    assert.equal(await prisma.compounds.count(), 2)
    const faultResume = await exchange.importDataPackage(faultPath)
    assert.equal(faultResume.errors.length, 1)
    assert.equal(faultResume.skipped, 1)
    assert.equal(await prisma.compounds.count(), 2)
    await admin.query('DROP TRIGGER mspec_lib2_test_a.inject_unit_failure')
    const recovered = await exchange.importDataPackage(faultPath)
    assert.equal(recovered.imported, 1)
    assert.equal(recovered.skipped, 1)
    assert.equal(recovered.errors.length, 0)
    assert.equal(await prisma.compounds.count(), 3)
    record('单元故障无半条关联、解除故障后续跑与重复归账')
    const createdRecord = await prisma.source_records.findFirstOrThrow({
      where: { batch_id: fault.batchId, source_key: 'after-error' }
    })
    const createdLink = await prisma.entity_sources.findFirstOrThrow({
      where: { source_record_id: createdRecord.id, entity_type: 'compound' }
    })
    const sharedBatch = await prisma.import_batches.create({
      data: {
        package_id: 'shared-reference-test',
        content_hash: 'a'.repeat(64),
        mapping_version: 'test',
        status: 'completed'
      }
    })
    const sharedLibrary = await prisma.spectral_libraries.create({
      data: { namespace: 'shared-test', name: '测试共享引用' }
    })
    const sharedRecord = await prisma.source_records.create({
      data: {
        library_id: sharedLibrary.id,
        source_key: 'shared',
        content_hash: 'b'.repeat(64),
        raw: {},
        decision: 'linked',
        batch_id: sharedBatch.id
      }
    })
    const sharedLink = await prisma.entity_sources.create({
      data: {
        source_record_id: sharedRecord.id,
        entity_type: 'compound',
        entity_id: createdLink.entity_id
      }
    })
    const sharedUndo = await exchange.undoImportBatch(fault.batchId)
    assert.equal(sharedUndo.undone, 1)
    assert.equal(sharedUndo.conflicts.length, 1)
    await prisma.entity_sources.delete({ where: { id: sharedLink.id } })
    assert.equal((await exchange.undoImportBatch(fault.batchId)).undone, 1)
    record('共享来源引用阻止撤销，解除引用后可撤销本批新增')
    await admin.query("UPDATE mspec_lib2_test_a.app_metadata SET product='OtherProduct' WHERE id=1")
    await assert.rejects(prisma.compounds.count())
    await assert.rejects(prisma.$queryRawUnsafe('SELECT 1'))
    await admin.query("UPDATE mspec_lib2_test_a.app_metadata SET product='MasspecLib2' WHERE id=1")
    record('错误库身份同时阻断模型和原始 SQL 访问')
    await writeFile(
      resolve(work, 'integration-report.json'),
      JSON.stringify(
        {
          status: 'passed',
          mysqlVersion: location[0].version,
          dataDirectory: location[0].datadir,
          executedAt: new Date().toISOString(),
          steps
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    if (prisma) await prisma.$disconnect()
    await admin.end()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
