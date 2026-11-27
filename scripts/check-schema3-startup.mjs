import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { createServer } from 'vite'
import { splitInitializationSql } from '../src/shared/initializationSql.ts'
const directory='outputs/服务器健康检查_20261016'
const config={host:'127.0.0.1',port:44715,user:'root',password:'',database:'mspec_lib2_schema3_startup_check'}
const db=await mysql.createConnection({...config,database:undefined})
let server
try {
  const [place]=await db.query('SELECT @@datadir AS directory')
  assert(place[0].directory.startsWith('/tmp/masspeclib2-mysql-'), 'Only the isolated test service is permitted')
  await db.query('CREATE DATABASE IF NOT EXISTS `'+config.database+'` CHARACTER SET utf8mb4')
  await db.query('USE `'+config.database+'`')
  const [tables]=await db.query('SHOW TABLES')
  if(!tables.length){
    for(const sql of splitInitializationSql(fs.readFileSync('tests/fixtures/schema3-initialize.sql','utf8')))await db.query(sql)
    await db.query("UPDATE app_metadata SET state='ready' WHERE id=1")
  }
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'masspeclib2-schema3-startup-'))
  fs.writeFileSync(path.join(temp,'.env.masspeclib2'),`DATABASE_HOST=${config.host}\nDATABASE_PORT=${config.port}\nDATABASE_USER=${config.user}\nDATABASE_PASSWORD=\nDATABASE_NAME=${config.database}\n`)
  server=await createServer({configFile:false,server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true}})
  const configuration=await server.ssrLoadModule('/src/main/databaseConfig.ts')
  configuration.setDatabaseConfigDirectory(temp)
  const initialization=await server.ssrLoadModule('/src/main/databaseInitialization.ts')
  const result=await initialization.checkDatabaseConnection()
  const [metadata]=await db.query('SELECT product,schema_version,state FROM app_metadata WHERE id=1')
  const report={scope:'真实旧结构3空测试库的启动状态检查；允许进入升级界面，写入仍要求结构4',metadata:metadata[0],result,status:result.ok&&result.initialized?'passed':'failed'}
  fs.writeFileSync(path.join(directory,'旧结构3首次启动兼容检查.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
  if(process.argv.includes('--expect-pass'))assert.equal(report.status,'passed')
}finally{await db.end();if(server)await server.close()}
