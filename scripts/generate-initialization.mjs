import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
const output = process.argv[2] ?? 'prisma/masspeclib2-initialize.sql'
const schema = execFileSync(
  process.execPath,
  [
    'node_modules/prisma/build/index.js',
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema',
    'prisma/schema.prisma',
    '--script'
  ],
  { encoding: 'utf8' }
)
if (!schema.includes('CREATE TABLE `app_metadata`') || !schema.includes('CREATE TABLE `spectra`'))
  throw new Error('Prisma 未生成完整的新库结构，停止输出初始化文件')
const sql =
  schema +
  `\nINSERT INTO app_metadata (id, product, schema_version, instance_id, state) VALUES (1, 'MasspecLib2', 4, '${randomUUID()}', 'pending');\n`
writeFileSync(output, sql)
const manifest = {
  product: 'MasspecLib2',
  schemaVersion: 4,
  generatedAt: new Date().toISOString(),
  sha256: createHash('sha256').update(sql).digest('hex'),
  schemaHash: createHash('sha256').update(readFileSync('prisma/schema.prisma')).digest('hex'),
  content: '空的新库结构与产品版本元数据；不含正式化合物数据'
}
writeFileSync(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n')
console.log('已生成 ' + output + ' 及校验清单；未连接数据库。')
