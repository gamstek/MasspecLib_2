import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { normalizeAcquisition, lcFlowRate, acquisitionFields } from '../../src/shared/acquisitionParameters.mjs'
import { lcTemperature } from '../../src/shared/lcTemperature.ts'
import { retentionConditions } from '../../src/shared/lcRetention.ts'
import { encodePackage, validatePackage } from '../../src/shared/dataPackage.ts'
const [input, output] = process.argv.slice(2)
if (!input || !output || path.resolve(input) === path.resolve(output)) throw new Error('请提供原始JSON数据包路径和独立输出目录')
const original = fs.readFileSync(input), data = JSON.parse(original), originalHash = createHash('sha256').update(original).digest('hex')
validatePackage(data)
const counts = { compounds: data.groups.length, ms: 0, lc: 0, multiRetentionMethods: 0, roomTemperatureMethods: 0, fields: {}, defaultUnits: {}, preservedSourceText: 0 }, failures = []
for (const group of data.groups) {
  for (const method of group.methods || []) {
    method.conditions = normalizeAcquisition(method)
    const c = method.conditions
    if (method.cad_value == null && c.collision_gas_pressure) { method.cad_value = c.collision_gas_pressure.value; method.cad_type = c.collision_gas_pressure.unit }
    if (!method.cad_type && c.collision_gas_level) method.cad_type = c.collision_gas_level
    for (const key of Object.keys(acquisitionFields)) if (c[key] != null && c[key] !== '') { counts.fields[key] = (counts.fields[key] || 0) + 1; if (c[key]?.unit_source === 'default') counts.defaultUnits[key] = (counts.defaultUnits[key] || 0) + 1 }
    if (c.ion_source_parameters_raw) { counts.preservedSourceText++; for (const key of ['cur', 'gs1', 'gs2', 'source_temperature']) if (!c[key]) failures.push({ sourceKey: group.source.key, method: method.localId, missing: key }) }
    counts.ms++
  }
  const methods = new Set((group.methods || []).filter(m => m.localId).map(m => m.localId))
  for (const method of group.lcMethods || []) {
    const t = lcTemperature(method)
    method.column_temperature_c = t.column_temperature_c
    method.conditions = retentionConditions(method, t.conditions, methods) || {}
    const flow = lcFlowRate(method); if (flow && !flow.program) method.conditions.flow_rate = flow
    if (method.conditions.retention_times?.length > 1) counts.multiRetentionMethods++
    if (method.conditions.column_temperature_text) counts.roomTemperatureMethods++
    counts.lc++
  }
}
if (failures.length) throw new Error('存在未映射的源参数：' + JSON.stringify(failures.slice(0, 20)))
data.packageId = randomUUID(); data.mappingVersion = 'xlsx-source-parameters-v2-default-units'
validatePackage(data)
fs.mkdirSync(output, { recursive: true })
const prefix = path.basename(input, '.json').replace('-package', '') + '-字段补全'
const jsonFile = path.join(output, prefix + '.json'), packageFile = path.join(output, prefix + '.msldata')
fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2)); fs.writeFileSync(packageFile, encodePackage(data))
const report = { status: 'passed', originalInput: path.basename(input), originalSha256: originalHash, inputUnchanged: createHash('sha256').update(fs.readFileSync(input)).digest('hex') === originalHash, jsonFile, packageFile, counts, failures }
fs.writeFileSync(path.join(output, prefix + '-映射核对.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
