import mysql from 'mysql2/promise'
import { createReadStream, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [sql, database] = process.argv.slice(2)
if (!sql || !/^mspec_unified_raw_[A-Za-z0-9_]+$/.test(database ?? '')) throw new Error('仅允许新建 mspec_unified_raw_ 开头的隔离暂存库')
const db = await mysql.createConnection({ host: '127.0.0.1', port: 44715, user: 'root', supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4', multipleStatements: false })
const [[runtime]] = await db.query('SELECT @@datadir AS dir')
if (runtime.dir !== '/tmp/masspeclib2-mysql-current-check/data/') throw new Error('拒绝连接非隔离服务')
await db.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
await db.query(`USE \`${database}\``)
let chunks = [], quoted = false, count = 0, lineNumber = 0
const start = Date.now()
try {
 for await (const line of createInterface({ input: createReadStream(sql), crlfDelay: Infinity })) {
  lineNumber++
  if (!quoted && (!line.trim() || /^\s*--/.test(line))) continue
  chunks.push(line)
  // NO_BACKSLASH_ESCAPES: doubled quotes preserve parity, backslashes are literal.
  for (const ch of line) if (ch === "'") quoted = !quoted
  if (!quoted && line.trimEnd().endsWith(';')) {
   const statement = chunks.join('\n')
   if (/^\s*(USE\b|CREATE\s+DATABASE\b|DROP\s+DATABASE\b|LOAD\b|DELIMITER\b)/i.test(statement) || /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(statement)) throw new Error('拒绝执行跨库或外部文件操作')
   await db.query(statement); chunks = []; count++
   if (count % 500 === 0) console.log(JSON.stringify({ statements: count, line: lineNumber, seconds: Math.round((Date.now()-start)/1000) }))
  }
 }
 if (chunks.length || quoted) throw new Error('SQL 结尾存在未完成语句')
 writeFileSync('outputs/统一谱库适配/staging-import.json', JSON.stringify({ database, statements: count, lines: lineNumber, seconds: (Date.now()-start)/1000, status: 'completed' }, null, 2))
 console.log('COMPLETED', database, count)
} catch (e) {
 writeFileSync('outputs/统一谱库适配/staging-import.json', JSON.stringify({ database, statements: count, line: lineNumber, status: 'failed', error: String(e) }, null, 2)); throw e
} finally { await db.end() }
