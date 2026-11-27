import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SharedServerProfile {
  sshDefaults?: { host: string; port: number; username: string; hostFingerprint: string }
  enabled: boolean
  mode?: 'ssh' | 'direct'
  host: string
  port: number
  user: string
  password: string
  catalog: string
  auditDatabase: string
  intervalSeconds: number
  databaseHost?: string
  databasePort?: number
  serverId?: string
}
let runtime: SharedServerProfile | undefined
export function sharedServerDefaults(): SharedServerProfile | undefined {
  const configured = process.env.MASSPECLIB2_SHARED_PROFILE
  const file = configured || (app.isPackaged
    ? typeof process.resourcesPath === 'string' ? join(process.resourcesPath, 'shared-server.json') : ''
    : join(__dirname, '../../resources/shared-server.json'))
  if (!file || !existsSync(file)) return
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!value.enabled) return
  if (typeof value.host !== 'string' || (!value.host.trim() && value.mode !== 'ssh') ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.user !== 'string' || !value.user.trim() || typeof value.password !== 'string' ||
      !/^mspec_lib2_[a-z0-9_]+$/.test(value.catalog) || !/^mspec_lib2_[a-z0-9_]+$/.test(value.auditDatabase))
    throw new Error('共享服务器配置无效')
  return { ...value, intervalSeconds: 30 }
}
export function sharedServerProfile(): SharedServerProfile | undefined {
  if (runtime) return runtime
  const defaults = sharedServerDefaults()
  return defaults?.mode === 'ssh' ? undefined : defaults
}
export function setSharedRuntimeProfile(value?: SharedServerProfile): void { runtime = value }
