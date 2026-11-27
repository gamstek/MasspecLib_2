const mysql = require('mysql2/promise'),
  fs = require('node:fs'),
  assert = require('node:assert/strict'),
  path = require('node:path')
const prefix = 'mspec_lib2_demo_sql_' + process.pid
async function main() {
  const db = await mysql.createConnection({
    host: process.env.DEMO_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.DEMO_MYSQL_PORT || 44715),
    user: process.env.DEMO_MYSQL_USER || 'root',
    password: process.env.DEMO_MYSQL_PASSWORD || '',
    multipleStatements: true
  })
  const statements = [
    '00_建立两个专用空库.sql',
    '01_初始化并填充演示甲库.sql',
    '02_初始化并填充演示乙库.sql'
  ]
  try {
    for (const file of statements) {
      const text = fs
        .readFileSync(path.join('examples/audit', file), 'utf8')
        .replaceAll('mspec_lib2_auto_demo_a', prefix + '_a')
        .replaceAll('mspec_lib2_auto_demo_b', prefix + '_b')
      await db.query(text)
    }
    for (const side of ['a', 'b']) {
      const name = prefix + '_' + side
      assert.equal((await db.query('SELECT COUNT(*) n FROM `' + name + '`.compounds'))[0][0].n, 8)
      assert.equal(
        (await db.query('SELECT state FROM `' + name + '`.app_metadata WHERE id=1'))[0][0].state,
        'ready'
      )
    }
    const rows = (
      await db.query(
        'SELECT status,COUNT(*) n FROM `' + prefix + '_b`.experiment_results GROUP BY status'
      )
    )[0]
    assert.equal(rows.find((r) => r.status === 'completed').n, 15)
    assert.equal(rows.find((r) => r.status === 'draft').n, 1)
    assert.equal(
      (await db.query('SELECT COUNT(*) n FROM `' + prefix + '_b`.chromatogram_traces'))[0][0].n,
      1
    )
    const report = {
      status: 'passed',
      scope: '交付SQL原文在MySQL8独立临时库执行，非软件导入',
      compoundsPerDatabase: 8,
      completedResults: 15,
      draftResults: 1,
      imageOnlyTraces: 1
    }
    const output = process.argv[2] || 'outputs/自动检查功能_2.3.0/检查记录'
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, 'Navicat演示SQL验证.json'), JSON.stringify(report, null, 2))
    console.log(report)
  } finally {
    for (const side of ['a', 'b'])
      await db.query('DROP DATABASE IF EXISTS `' + prefix + '_' + side + '`')
    await db.end()
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
