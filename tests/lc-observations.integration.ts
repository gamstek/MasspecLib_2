/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { encodePackage, decodePackage } from '../src/shared/dataPackage.ts'
async function main(): Promise<void> {
  const old = parse(readFileSync('/tmp/masspeclib2-mysql-current-check/.env.masspeclib2'))
  const cfg = { host: '127.0.0.1', port: Number(old.DATABASE_PORT), user: 'root', password: '' }
  const admin = await mysql.createConnection(cfg)
  const [location]: any = await admin.query('SELECT @@datadir datadir'); assert(location[0].datadir.startsWith('/tmp/masspeclib2-mysql-'))
  const suffix = randomBytes(8).toString('hex'), database = 'mspec_lib2_rt_native_' + suffix, directory = mkdtempSync('/tmp/masspec-lc-observations-'), checks: string[] = []
  let prisma: any
  try {
    await admin.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4')
    const configPath = join(directory, '.env.masspeclib2')
    writeFileSync(configPath, `DATABASE_HOST=127.0.0.1\nDATABASE_PORT=${cfg.port}\nDATABASE_USER=root\nDATABASE_PASSWORD=\nDATABASE_NAME=${database}\n`)
    process.env.MASSPECLIB2_DATABASE_CONFIG = configPath
    require('../src/main/databaseConfig.ts').setDatabaseConfigDirectory(directory)
    const result = await require('../src/main/databaseInitialization.ts').initializeDatabase('/workspace/ptk-master2/prisma/masspeclib2-initialize.sql', { config: { ...cfg, database }, configPath })
    assert.equal(result.ok, true, JSON.stringify(result))
    prisma = require('../src/main/database.ts').prisma
    const exchange = require('../src/main/services/dataExchange.ts'), details = require('../src/main/services/compoundDetails.ts')
    const input = { formatVersion: 2, schemaVersion: 2, packageId: 'native-lc-' + suffix, mappingVersion: 'native-lc-v1', groups: [{ source: { namespace: 'native-lc-' + suffix, key: '1' }, compound: { main_name: '同方法双峰与MRM验证' }, methods: [{ localId: 'quant', ms_mode: 'MRM', q1: 301.1, q3: 123, ce: 20, transition_role: 'quantifier', conditions: { transition_label: 'MRM1', method_source: '测试方法分组', ion_source_parameters_raw: 'IS 5500V/-4500V，碰撞气Medium，CUR 30，GS1 50，GS2 55，TEM 500℃' } }, { localId: 'qual', ms_mode: 'MRM', q1: 301.1, q3: 151, ce: 30, transition_role: 'qualifier', conditions: { transition_label: 'MRM2', ion_source_parameters_raw: '碰撞气9psi，CUR 35psi' } }], lcMethods: [{ column_temperature_c: '室温', retention_times: [{ id: 'p1', value: 3.2, unit: 'min', peak_label: '待确认峰1', methodLocalIds: ['quant', 'qual'] }, { id: 'p2', value: 4.1, unit: 'min', peak_label: '待确认峰2', methodLocalIds: ['quant'] }], items: [] }] }] }
    const file = join(directory, 'input.msldata'); writeFileSync(file, encodePackage(input as any))
    const imported = await exchange.importDataPackage(file); assert.equal(imported.imported, 1, JSON.stringify(imported)); assert.equal(imported.errors.length, 0)
    const compound = await prisma.compounds.findFirst(), methods = await prisma.ms_methods.findMany({ orderBy: { id: 'asc' } }), lc = await prisma.lc_methods.findFirst()
    assert.equal(lc.column_temperature_c, null); assert.equal(lc.conditions.column_temperature_text, '室温'); assert.equal(lc.conditions.retention_times.length, 2)
    assert.deepEqual(lc.conditions.retention_times[0].methodLocalIds, methods.map((m: any) => String(m.id))); checks.push('真实导入将室温保存为文字，并把两条峰记录的通道引用重映射到新方法ID')
    assert.equal(methods[0].conditions.cur.unit_source, 'default'); assert.equal(methods[0].conditions.is_negative.value, -4500); assert.equal(methods[0].cad_value, null); assert.equal(methods[0].cad_type, 'Medium'); assert.equal(methods[1].cad_value, 9); checks.push('离子源正负电压、默认压力单位和文字档位经真实导入分别存储')
    const info = { compound, classIdList: [], customClassIdList: [], compoundLcMethodList: [{ ...lc, methodsLinks: [] }], compoundMsMethodList: [{ ms_mode: 'MRM', methods }], deletedLcMethodIds: [], deletedMsMethodIds: [] as number[] }
    info.compoundLcMethodList[0].conditions.column_temperature_text = '未控温'; info.compoundLcMethodList[0].conditions.retention_times[1].value = 4.3
    info.compoundMsMethodList[0].methods[0].conditions.cur = { value: 44, unit: 'kPa', unit_source: 'default' }
    const saved = await details.saveCompoundDetails(info); assert.equal(saved.success, true, JSON.stringify(saved))
    const updated = await prisma.lc_methods.findFirst(); assert.equal(updated.conditions.column_temperature_text, '未控温'); assert.equal(updated.conditions.retention_times[1].value, 4.3); checks.push('管理员原有详情保存流程保留文字柱温、多峰和MRM关联')
    const editedMS = await prisma.ms_methods.findFirst({ orderBy: { id: 'asc' } }); assert.equal(editedMS.conditions.cur.value, 44); assert.equal(editedMS.conditions.cur.unit, 'kPa'); assert.equal(editedMS.conditions.cur.unit_source, 'explicit'); checks.push('管理员修改仪器参数及单位后优先于原始文字，原文仍保留')
    const exported = join(directory, 'roundtrip.msldata'); await exchange.exportDataPackage(exported)
    const roundtrip = decodePackage(readFileSync(exported)), group = roundtrip.groups[0], known = new Set(group.methods!.map(m => m.localId))
    const peaks = group.lcMethods![0].conditions.retention_times; assert.equal(peaks.length, 2); assert(peaks.every((r: any) => r.methodLocalIds.every((id: string) => known.has(id)))); checks.push('原有导出格式完整保留峰记录并使用包内MRM方法标识')
    info.compound = await prisma.compounds.findFirst(); info.deletedMsMethodIds = [methods[0].id]
    const rejected = await details.saveCompoundDetails(info); assert.equal(rejected.success, false); assert.equal(await prisma.ms_methods.count(), 2); checks.push('删除仍被峰记录引用的MRM通道时拒绝并完整回滚')
    console.log(JSON.stringify({ status: 'passed', tests: checks.length, checks, isolatedTemporaryMySQL: true }))
  } finally {
    if (prisma) await prisma.$disconnect()
    assert.equal(database, 'mspec_lib2_rt_native_' + suffix)
    await admin.query('DROP DATABASE IF EXISTS `' + database + '`'); await admin.end(); rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
