import { readFile } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { validateInitializationSql } from '../shared/initializationSql'
import {
  PRODUCT,
  SCHEMA_VERSION,
  validateDatabaseIdentity,
  validateDatabaseStartupIdentity,
  validateDatabaseTarget
} from '../shared/databaseTarget'
import { createReadStream, existsSync, statSync } from 'fs'
import { extname, resolve } from 'path'
import { createConnection, type Connection } from 'mariadb'
import { loadDatabaseConfig, type DatabaseConfig } from './databaseConfig'

const REQUIRED_TABLES = [
  'taxonomy_categories',
  'compound_taxonomy',
  'classes',
  'compound_class',
  'compounds',
  'lc_methods',
  'lc_methods_items',
  'ms_methods',
  'app_metadata',
  'spectra',
  'spectral_libraries',
  'source_records',
  'import_batches',
  'entity_sources',
  'detection_profiles',
  'spectrum_method_links'
] as const

export type DatabaseInitializationErrorKind =
  | 'configuration-error'
  | 'mysql-unavailable'
  | 'access-denied'
  | 'connection-failed'
  | 'schema-file-missing'
  | 'schema-data-missing'
  | 'initialization-failed'

interface DatabaseFailure {
  ok: false
  kind: DatabaseInitializationErrorKind
  message: string
  detail: string
}

export type DatabaseConnectionCheckResult =
  | {
      ok: true
      database: string
      databaseExists: boolean
      initialized: boolean
      configPath: string
    }
  | DatabaseFailure

export type DatabaseInitializationResult =
  | {
      ok: true
      action: 'empty-database-initialized'
      database: string
      configPath: string
      schemaPath: string
      tableCount: number
      dataStatementCount: number
    }
  | DatabaseFailure

interface DriverError extends Error {
  code?: string
  errno?: number
}

interface TableRow {
  TABLE_NAME: string
}

const UNAVAILABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT'
])

const ACCESS_DENIED_ERROR_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'])

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getDriverError(error: unknown): DriverError {
  return error instanceof Error ? (error as DriverError) : new Error(String(error))
}

async function analyzeSqlFile(
  schemaPath: string
): Promise<{ dataStatementCount: number; hasDatabaseStatement: boolean }> {
  const stream = createReadStream(schemaPath, { encoding: 'utf8' })
  let pendingLine = ''
  let dataStatementCount = 0
  let hasDatabaseStatement = false

  const analyzeLine = (line: string): void => {
    if (/^\s*(?:INSERT(?:\s+IGNORE)?\s+INTO|REPLACE\s+INTO|LOAD\s+DATA)\b/i.test(line)) {
      dataStatementCount += 1
    }

    if (/^\s*(?:(?:CREATE|DROP)\s+DATABASE|USE\s+)/i.test(line)) {
      hasDatabaseStatement = true
    }
  }

  for await (const chunk of stream) {
    const lines = `${pendingLine}${chunk}`.split(/\r?\n/)
    pendingLine = lines.pop() ?? ''

    for (const line of lines) {
      analyzeLine(line)
    }
  }

  analyzeLine(pendingLine)

  return { dataStatementCount, hasDatabaseStatement }
}

async function validateSchemaFile(
  schemaFilePath: string
): Promise<{ ok: true; path: string; dataStatementCount: number } | DatabaseFailure> {
  const schemaPath = resolve(schemaFilePath)

  if (extname(schemaPath).toLowerCase() !== '.sql') {
    return {
      ok: false,
      kind: 'schema-file-missing',
      message: '请选择 SQL 文件',
      detail: `不支持的文件类型：${schemaPath}`
    }
  }

  if (!existsSync(schemaPath) || !statSync(schemaPath).isFile()) {
    return {
      ok: false,
      kind: 'schema-file-missing',
      message: '数据库初始化文件不存在',
      detail: schemaPath
    }
  }

  if (statSync(schemaPath).size > 64 * 1024 * 1024)
    return {
      ok: false,
      kind: 'initialization-failed',
      message: '初始化文件超过 64 MiB',
      detail: '请使用新版结构初始化文件，再通过数据包分批导入业务数据。'
    }

  let analysis: Awaited<ReturnType<typeof analyzeSqlFile>>

  try {
    analysis = await analyzeSqlFile(schemaPath)
  } catch (error) {
    return {
      ok: false,
      kind: 'schema-file-missing',
      message: '无法读取数据库初始化文件',
      detail: `${schemaPath}\n\n${getErrorMessage(error)}`
    }
  }

  if (analysis.hasDatabaseStatement) {
    return {
      ok: false,
      kind: 'initialization-failed',
      message: 'SQL 文件包含不允许的数据库操作',
      detail: `${schemaPath} 包含 CREATE DATABASE、DROP DATABASE 或 USE 指令。新库由管理员预先创建并由 MasspecLib2 配置指定，请移除这些指令后重试。`
    }
  }

  if (analysis.dataStatementCount === 0) {
    return {
      ok: false,
      kind: 'schema-data-missing',
      message: '初始化文件不包含基础数据',
      detail: `${schemaPath} 只包含表结构，没有 INSERT、REPLACE 或 LOAD DATA 数据语句。为避免再次出现基础数据缺失，软件未执行初始化。请替换为同时包含表结构和基础数据的 SQL 文件。`
    }
  }

  return { ok: true, path: schemaPath, dataStatementCount: analysis.dataStatementCount }
}

function loadConfig(): { ok: true; config: DatabaseConfig; configPath: string } | DatabaseFailure {
  try {
    const { config, path: configPath } = loadDatabaseConfig()
    return { ok: true, config, configPath }
  } catch (error) {
    return {
      ok: false,
      kind: 'configuration-error',
      message: '数据库配置不可用',
      detail: getErrorMessage(error)
    }
  }
}

function classifyConnectionError(
  error: unknown,
  config: DatabaseConfig,
  configPath: string
): DatabaseFailure {
  const driverError = getDriverError(error)
  const location = `${config.host}:${config.port}`

  if (driverError.code && UNAVAILABLE_ERROR_CODES.has(driverError.code)) {
    return {
      ok: false,
      kind: 'mysql-unavailable',
      message: '未检测到可用的 MySQL 数据库',
      detail: `无法连接 ${location}。请安装并启动 MySQL 8.0 或更高版本，然后重新检测。\n\n${driverError.message}`
    }
  }

  if (
    driverError.errno === 1045 ||
    (driverError.code && ACCESS_DENIED_ERROR_CODES.has(driverError.code))
  ) {
    return {
      ok: false,
      kind: 'access-denied',
      message: 'MySQL 账号验证失败',
      detail: `已检测到 ${location} 的 MySQL 服务，但账号或密码不正确。请修改配置文件后重试：\n${configPath}\n\n${driverError.message}`
    }
  }

  return {
    ok: false,
    kind: 'connection-failed',
    message: '无法连接 MySQL 数据库',
    detail: `连接地址：${location}\n配置文件：${configPath}\n\n${driverError.message}`
  }
}

async function connectToServer(
  config: DatabaseConfig,
  configPath: string
): Promise<{ ok: true; connection: Connection } | DatabaseFailure> {
  try {
    const connection = await createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      connectTimeout: 5000,
      socketTimeout: 600000,
      charset: 'utf8mb4'
    })

    return { ok: true, connection }
  } catch (error) {
    return classifyConnectionError(error, config, configPath)
  }
}

async function databaseExists(connection: Connection, database: string): Promise<boolean> {
  const rows = await connection.query<Array<{ SCHEMA_NAME: string }>>(
    'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
    [database]
  )

  return rows.length > 0
}

async function getDatabaseTables(connection: Connection, database: string): Promise<string[]> {
  const rows = await connection.query<TableRow[]>(
    'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?',
    [database]
  )

  return rows.map((row) => row.TABLE_NAME)
}

async function closeConnection(connection: Connection): Promise<void> {
  try {
    await connection.end()
  } catch (error) {
    console.error('[database] 关闭数据库连接时发生错误：', error)
  }
}

export async function checkDatabaseConnection(): Promise<DatabaseConnectionCheckResult> {
  const loadedConfig = loadConfig()

  if (!loadedConfig.ok) {
    return loadedConfig
  }

  const { config, configPath } = loadedConfig
  const connected = await connectToServer(config, configPath)

  if (!connected.ok) {
    return connected
  }

  try {
    const exists = await databaseExists(connected.connection, config.database)
    let initialized = false
    if (exists) {
      const tables = await getDatabaseTables(connected.connection, config.database)
      if (tables.includes('app_metadata')) {
        const rows = await connected.connection.query(
          `SELECT product, schema_version, state FROM ${connected.connection.escapeId(config.database)}.app_metadata WHERE id = 1`
        )
        validateDatabaseStartupIdentity(rows[0] ?? null)
        initialized = true
      } else if (tables.length) {
        throw new Error('目标库已有数据表但没有 MasspecLib2 身份标记，拒绝作为新版目标使用')
      }
    }
    return { ok: true, database: config.database, databaseExists: exists, initialized, configPath }
  } catch (error) {
    return {
      ok: false,
      kind: 'connection-failed',
      message: 'MySQL 状态检查失败',
      detail: getErrorMessage(error)
    }
  } finally {
    await closeConnection(connected.connection)
  }
}

export async function initializeDatabase(
  schemaFilePath: string,
  override?: { config: DatabaseConfig; configPath: string }
): Promise<DatabaseInitializationResult> {
  const loadedConfig = override ? { ok: true as const, ...override } : loadConfig()

  if (!loadedConfig.ok) {
    return loadedConfig
  }
  validateDatabaseTarget(loadedConfig.config.database)

  const schema = await validateSchemaFile(schemaFilePath)

  if (!schema.ok) {
    return schema
  }

  const { config, configPath } = loadedConfig
  const connected = await connectToServer(config, configPath)

  if (!connected.ok) {
    return connected
  }

  const { connection } = connected
  try {
    if (!(await databaseExists(connection, config.database))) {
      throw new Error(
        '请先由管理员创建配置指定的空 MasspecLib2 新库，并授予该库的初始化权限。软件不创建或删除数据库。'
      )
    }
    const existing = await getDatabaseTables(connection, config.database)
    if (existing.length) throw new Error('目标库非空，已拒绝初始化。日常追加请使用“导入化合物”。')
    const content = await readFile(schema.path, 'utf8')
    const manifest = JSON.parse(await readFile(`${schema.path}.manifest.json`, 'utf8'))
    const hash = createHash('sha256').update(content).digest('hex')
    if (
      manifest.product !== PRODUCT ||
      manifest.schemaVersion !== SCHEMA_VERSION ||
      manifest.sha256 !== hash
    ) {
      throw new Error('初始化文件的产品、版本或 SHA256 与 manifest 不符')
    }
    const statements = validateInitializationSql(content)
    await connection.query(`USE ${connection.escapeId(config.database)}`)
    for (const statement of statements) await connection.query(statement)
    const tables = await getDatabaseTables(connection, config.database)
    const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table))
    if (missingTables.length) throw new Error(`初始化缺少数据表：${missingTables.join('、')}`)
    const metadata = await connection.query(
      'SELECT product, schema_version, state FROM app_metadata WHERE id = 1'
    )
    if (
      metadata[0]?.product !== PRODUCT ||
      metadata[0]?.schema_version !== SCHEMA_VERSION ||
      metadata[0]?.state !== 'pending'
    ) {
      throw new Error('初始化产品元数据不符，目标仍未开放使用')
    }
    await connection.query(
      "UPDATE app_metadata SET instance_id = ?, state = 'ready' WHERE id = 1",
      [randomUUID()]
    )
    validateDatabaseIdentity({ ...metadata[0], state: 'ready' })
    return {
      ok: true,
      action: 'empty-database-initialized',
      database: config.database,
      configPath,
      schemaPath: schema.path,
      tableCount: tables.length,
      dataStatementCount: schema.dataStatementCount
    }
  } catch (error) {
    return {
      ok: false,
      kind: 'initialization-failed',
      message: 'MasspecLib2 初始化失败',
      detail: `数据库：${config.database}\n初始化文件：${schema.path}\n\n${getErrorMessage(error)}\n已完成的 DDL 可能保留。软件不会删除数据库，请按报告由管理员处理新库。`
    }
  } finally {
    await closeConnection(connection)
  }
}
