import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { CONFIG_FILE, validateDatabaseTarget } from '../shared/databaseTarget'
import { parse } from 'dotenv'

let configDirectory = process.cwd()
export function setDatabaseConfigDirectory(directory: string): void {
  configDirectory = directory
}

export function getDatabaseConfigDirectory(): string {
  return configDirectory
}

export interface DatabaseConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export interface LoadedDatabaseConfig {
  config: DatabaseConfig
  path: string
}

function getConfigCandidates(): string[] {
  const configuredPath = process.env.MASSPECLIB2_DATABASE_CONFIG
  if (configuredPath)
    return [isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath)]
  return [join(configDirectory, CONFIG_FILE)]
}

function requireString(
  config: Record<string, string>,
  key: string,
  configPath: string,
  allowEmpty = false
): string {
  const value = config[key]

  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`数据库配置项 ${key} 必须是${allowEmpty ? '' : '非空'}字符串：${configPath}`)
  }

  return value
}

function requirePort(config: Record<string, string>, configPath: string): number {
  const rawValue = requireString(config, 'DATABASE_PORT', configPath)
  const value = Number(rawValue)

  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new Error(`数据库配置项 DATABASE_PORT 必须是 1 到 65535 之间的整数：${configPath}`)
  }

  return value
}

function requireDatabaseName(config: Record<string, string>, configPath: string): string {
  return validateDatabaseTarget(requireString(config, 'DATABASE_NAME', configPath))
}

export function loadDatabaseConfig(): LoadedDatabaseConfig {
  const candidates = getConfigCandidates()
  const configPath = candidates.find((candidate) => existsSync(candidate))

  if (!configPath) {
    throw new Error(`未找到数据库配置文件 ${CONFIG_FILE}。已检查：${candidates.join('、')}`)
  }

  let config: Record<string, string>

  try {
    config = parse(readFileSync(configPath))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取数据库配置文件：${configPath}（${message}）`)
  }

  return {
    path: configPath,
    config: {
      host: requireString(config, 'DATABASE_HOST', configPath),
      port: requirePort(config, configPath),
      user: requireString(config, 'DATABASE_USER', configPath),
      password: requireString(config, 'DATABASE_PASSWORD', configPath, true),
      database: requireDatabaseName(config, configPath)
    }
  }
}
