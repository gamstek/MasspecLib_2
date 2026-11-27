import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { encodePackage } from '../src/shared/dataPackage.ts'
const [input, output] = process.argv.slice(2)
if (!input || !output)
  throw new Error(
    '用法：npm run data:convert -- <统一字段 JSON> <输出.msldata>。源 MySQL 字段适配须先完成映射，不能猜测源结构。'
  )
const data = JSON.parse(readFileSync(input, 'utf8'))
const bytes = encodePackage(data)
writeFileSync(output, bytes)
const report = {
  input,
  output,
  groups: data.groups.length,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  mappingVersion: data.mappingVersion
}
writeFileSync(output + '.report.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
