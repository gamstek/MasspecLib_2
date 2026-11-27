// Developer utility: export the existing synthetic classification fixture and add
// synthetic assay records. It reads the fixture database and writes files only.
const fs = require('node:fs'),
  path = require('node:path'),
  mysql = require('mysql2/promise')
const target = path.resolve(process.argv[2] || 'examples/audit')
const order = [
  'compounds',
  'classes',
  'compound_class',
  'ms_methods',
  'lc_methods',
  'lc_methods_items',
  'spectral_libraries',
  'import_batches',
  'source_records',
  'spectra',
  'spectrum_method_links',
  'detection_profiles',
  'entity_sources',
  'taxonomy_categories',
  'compound_taxonomy'
]
function literal(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text ? `CONVERT(0x${Buffer.from(text, 'utf8').toString('hex')} USING utf8mb4)` : "''"
}
function insert(table, row) {
  return `INSERT INTO \`${table}\` (${Object.keys(row)
    .map((k) => '`' + k + '`')
    .join(',')}) VALUES (${Object.values(row).map(literal).join(',')});\n`
}
async function main() {
  fs.mkdirSync(target, { recursive: true })
  const db = await mysql.createConnection({
    host: process.env.DEMO_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.DEMO_MYSQL_PORT || 3306),
    user: process.env.DEMO_MYSQL_USER || 'root',
    password: process.env.DEMO_MYSQL_PASSWORD || '',
    database: process.env.DEMO_DATABASE || 'mspec_lib2_classification_demo',
    dateStrings: true
  })
  try {
    const fixture = {}
    for (const table of order) fixture[table] = (await db.query('SELECT * FROM `' + table + '`'))[0]
    const schema = fs.readFileSync('prisma/masspeclib2-initialize.sql', 'utf8'),
      extension = fs.readFileSync('src/main/audit/experiment-schema.sql', 'utf8'),
      demo = JSON.parse(fs.readFileSync('examples/analysis/检测结果演示_15条.json', 'utf8'))
    fs.copyFileSync(
      'src/main/audit/experiment-schema.sql',
      path.join(target, '可选实验扩展结构1.sql')
    )
    const image =
      'data:image/png;base64,' +
      fs.readFileSync(path.join(target, '模拟色谱图片.png')).toString('base64')
    fs.writeFileSync(
      path.join(target, '00_建立两个专用空库.sql'),
      '-- 仅建立全新演示库。如已存在会报错，请停止并换用新的演示空库。\nCREATE DATABASE `mspec_lib2_auto_demo_a` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nCREATE DATABASE `mspec_lib2_auto_demo_b` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n'
    )
    for (const [side, name] of [
      ['a', '演示甲库'],
      ['b', '演示乙库']
    ]) {
      const database = 'mspec_lib2_auto_demo_' + side
      let sql =
        `-- ${name}：全部为模拟数据，只允许在全新专用空库执行一次。发生任何错误立即停止。\n-- id=1的人工格式标识仅用于演示关联，不是真实InChIKey。\nUSE \`${database}\`;\nSET NAMES utf8mb4;\n` +
        schema +
        '\n' +
        extension +
        '\nSTART TRANSACTION;\n'
      for (const table of order)
        for (const original of fixture[table]) {
          const row = { ...original }
          if (table === 'compounds' && Number(row.id) === 1) {
            row.identifiers = { inchikey: 'AAAAAAAAAAAAAA-BBBBBBBBBB-C' }
            row.properties = {
              ...row.properties,
              synthetic: true,
              identity_note: '仅演示自动关联的格式化标识，不是真实化合物身份'
            }
          }
          if (table === 'spectral_libraries') row.name = row.name + ' · ' + name
          sql += insert(table, row)
        }
      if (side === 'b') {
        const source = fixture.spectral_libraries[0].id
        for (let i = 0; i < demo.results.length; i++) {
          const row = demo.results[i]
          sql += insert('experiment_results', {
            id: row.id,
            compound_id: i === 0 ? 1 : (i % 7) + 2,
            source_library_id: source,
            batch_name: '数据库自动检查模拟演示',
            method_name: demo.methodName,
            rule_version: 'demo-1',
            record_type: 'sample',
            status: 'completed',
            data: { ...row, peakRules: demo.peakRules }
          })
        }
        sql += insert('chromatogram_traces', {
          id: 'image-only',
          compound_id: 1,
          source_library_id: source,
          method_name: '仅图片演示',
          rule_version: 'demo-1',
          status: 'completed',
          image_base64: image,
          data: { checks: ['peak'] }
        })
        sql += insert('experiment_results', {
          id: 'draft',
          compound_id: 1,
          batch_name: '尚未完成',
          method_name: demo.methodName,
          rule_version: 'demo-1',
          status: 'draft',
          data: { checks: ['peak', 'ratio', 'limit'] }
        })
      }
      sql +=
        "UPDATE app_metadata SET instance_id=UUID(),state='ready' WHERE id=1 AND product='MasspecLib2' AND schema_version=4;\nCOMMIT;\n"
      fs.writeFileSync(
        path.join(
          target,
          side === 'a' ? '01_初始化并填充演示甲库.sql' : '02_初始化并填充演示乙库.sql'
        ),
        sql,
        'utf8'
      )
    }
    fs.writeFileSync(
      path.join(target, '03_只读核对.sql'),
      "SELECT '甲库' AS 数据库,COUNT(*) AS 化合物数 FROM mspec_lib2_auto_demo_a.compounds UNION ALL SELECT '乙库',COUNT(*) FROM mspec_lib2_auto_demo_b.compounds;\nSELECT status,COUNT(*) FROM mspec_lib2_auto_demo_b.experiment_results GROUP BY status;\nSELECT COUNT(*) AS 色谱图片记录数 FROM mspec_lib2_auto_demo_b.chromatogram_traces;\n"
    )
    console.log('Generated SQL demonstration in ' + target)
  } finally {
    await db.end()
  }
}
main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
