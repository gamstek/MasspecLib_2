/* eslint-disable @typescript-eslint/no-explicit-any */
import { workspaceEntries } from '../../shared/adminWorkspace.mjs'
import { adminWorkspace } from '../services/adminWorkspace'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { createHash } from 'node:crypto'
import { sharedServerProfile, sharedServerDefaults, type SharedServerProfile } from '../sharedServerProfile'
import { createPool, type Pool } from 'mysql2/promise'
import { getDatabaseConfigDirectory, loadDatabaseConfig } from '../databaseConfig'
import { validateConnection, type ConnectionDefinition } from '../../shared/federation'
import { validateDatabaseTarget } from '../../shared/databaseTarget'
interface StoredState {
  disconnectedIds?: string[]
  sharedMode?: boolean
  audit?: import('../../shared/audit').AuditSettings
  connections: ConnectionDefinition[]
  primaryId: string
  favorites: string[]
  categoryIds?: Record<string, number>
  excludedFavorites?: string[]
  groups: { id: number; name: string; refs: string[] }[]
}
let state: StoredState | undefined
const pools = new Map<string, Pool>()
function file(): string {
  return join(getDatabaseConfigDirectory(), 'connections.json')
}
function persist(): void {
  mkdirSync(getDatabaseConfigDirectory(), { recursive: true })
  const temporary = file() + '.tmp'
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(temporary, file())
}
export function getState(): StoredState {
  if (state) return state
  if (existsSync(file())) state = JSON.parse(readFileSync(file(), 'utf8'))
  else {
    const { config } = loadDatabaseConfig()
    const id = randomUUID()
    state = {
      primaryId: id,
      connections: [
        {
          id,
          name: '当前谱库',
          host: config.host,
          port: config.port,
          user: config.user,
          database: config.database,
          adapter: 'native',
          enabled: true,
          writable: true
        }
      ],
      favorites: [],
      groups: []
    }
    persist()
  }
  return state!
}
export function connections(): ConnectionDefinition[] {
  return getState().connections.filter(e => !(getState().disconnectedIds || []).includes(e.id) &&
    !(e.serverManaged && adminWorkspace()?.removedLibraries?.includes(e.database)))
}
export function workspaceConnections(explicitIds?: string[]): ConnectionDefinition[] {
  const settings = adminWorkspace()
  if (!settings) return connections()
  const published = workspaceEntries(settings, getState().connections)
  const local = explicitIds?.length
    ? connections().filter(entry => !entry.serverManaged && explicitIds.includes(entry.id))
    : []
  return [...published, ...local]
}
export function connection(id: string): ConnectionDefinition {
  const entry = workspaceConnections().find(x => x.id === id) || connections().find(x => x.id === id)
  if (!entry) throw new Error('数据库连接不存在，请重新查询')
  return entry
}
export async function credentials(entry: ConnectionDefinition): Promise<any> {
  if (entry.serverManaged) {
    const profile = sharedServerProfile()
    if (!profile || profile.host !== entry.host || profile.port !== entry.port || profile.user !== entry.user)
      throw new Error('共享服务器配置已变化，请重新同步')
    return { host: entry.host, port: entry.port, user: profile.user, password: profile.password, database: entry.database }
  }
  let password = ''
  if (entry.id === getState().primaryId && !entry.encryptedPassword)
    password = loadDatabaseConfig().config.password
  else if (entry.encryptedPassword) {
    const { safeStorage } = await import('electron')
    password = safeStorage.decryptString(Buffer.from(entry.encryptedPassword, 'base64'))
  }
  return {
    host: entry.host,
    port: entry.port,
    user: entry.user,
    password,
    database: entry.database
  }
}
export async function pool(entry: ConnectionDefinition): Promise<Pool> {
  let result = pools.get(entry.id)
  if (!result) {
    result = createPool({
      ...(await credentials(entry)),
      connectionLimit: 4,
      connectTimeout: 7000,
      enableKeepAlive: true,
      charset: 'utf8mb4',
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false
    })
    pools.set(entry.id, result)
  }
  return result
}
export async function query(
  entry: ConnectionDefinition,
  sql: string,
  params: any[] = []
): Promise<any[]> {
  const [rows] = await (await pool(entry)).query({ sql, timeout: 12000 }, params)
  return rows as any[]
}
export async function saveConnection(
  input: ConnectionDefinition & { password?: string }
): Promise<void> {
  if (input.serverManaged || connections().some((x) => x.id === input.id && x.serverManaged))
    throw new Error('共享库由服务器自动管理，请通过服务器上传目录新增数据库')
  const all = connections()
  const existing = all.find((x) => x.id === input.id)
  const entry: ConnectionDefinition = {
    ...input,
    id: existing?.id ?? randomUUID(),
    writable: input.adapter === 'native' && !!input.writable
  }
  delete (entry as any).password
  validateConnection(entry)
  if (entry.writable) validateDatabaseTarget(entry.database)
  if (
    all.some(
      (x) =>
        x.id !== entry.id &&
        x.host.toLowerCase() === entry.host.toLowerCase() &&
        x.port === entry.port &&
        x.database === entry.database
    )
  )
    throw new Error('此数据库连接已存在')
  if (
    existing?.id === getState().primaryId &&
    (entry.host !== existing.host ||
      entry.port !== existing.port ||
      entry.database !== existing.database ||
      entry.adapter !== 'native')
  )
    throw new Error('当前主连接的地址保持不变；不同数据库请添加新连接')
  entry.encryptedPassword = existing?.encryptedPassword
  if (input.password) {
    const { safeStorage } = await import('electron')
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('系统凭据加密不可用，无法保存数据库密码')
    entry.encryptedPassword = safeStorage.encryptString(input.password).toString('base64')
  }
  if (existing) all.splice(all.indexOf(existing), 1, entry)
  else all.push(entry)
  await pools.get(entry.id)?.end()
  pools.delete(entry.id)
  persist()
}
export function setConnectionLinked(id:string, linked:boolean):void { const s=getState();s.disconnectedIds=(s.disconnectedIds||[]).filter(x=>x!==id);if(!linked)s.disconnectedIds.push(id);persist() }
export async function removeConnection(id: string): Promise<void> {
  connection(id);setConnectionLinked(id,false);await pools.get(id)?.end();pools.delete(id)
}
export function localFavorite(key: string, original: unknown): boolean {
  return (
    getState().favorites.includes(key) ||
    (!!Number(original) && !(getState().excludedFavorites ?? []).includes(key))
  )
}
export function setLocalFavorite(key: string, value: boolean, aliases: string[] = []): boolean {
  const stored = getState(),
    excluded = (stored.excludedFavorites ??= [])
  const keys = new Set([key, ...aliases])
  stored.favorites = stored.favorites.filter(x => !keys.has(x))
  stored.excludedFavorites = excluded.filter(x => !keys.has(x))
  if (value) stored.favorites.push(key)
  else stored.excludedFavorites.push(key)
  persist()
  return value
}
export function toggleLocalFavorite(key: string, current: boolean): boolean {
  return setLocalFavorite(key, !current)
}
export function saveGroup(id: number | undefined, name: string, refs: string[]): any {
  if (!name.trim()) throw new Error('分组名称不能为空')
  const groups = getState().groups
  let group = groups.find((x) => x.id === id)
  if (group) {
    group.name = name.trim()
    group.refs = [...new Set(refs)]
  } else {
    group = {
      id: Math.max(0, ...groups.map((x) => x.id)) + 1,
      name: name.trim(),
      refs: [...new Set(refs)]
    }
    groups.push(group)
  }
  persist()
  return group
}
export async function closePools(): Promise<void> {
  await Promise.allSettled([...pools.values()].map((x) => x.end()))
  pools.clear()
}

export function registryCategoryId(key: string): number {
  const categories = (getState().categoryIds ??= {})
  if (!categories[key]) {
    categories[key] = Math.max(1000000000, ...Object.values(categories)) + 1
    persist()
  }
  return categories[key]
}
export function removeGroup(id: number): void {
  getState().groups = getState().groups.filter((x) => x.id !== id)
  persist()
}

export function saveAuditSettings(value: import('../../shared/audit').AuditSettings): void {
  getState().audit = value
  persist()
}

export function initializeSharedState(): boolean {
  const profile = sharedServerDefaults()
  if (!profile) return false
  if (!existsSync(file())) {
    state = {
      sharedMode: true, primaryId: '@shared-server', connections: [], favorites: [], groups: [],
      audit: { enabled: false, connectionId: '@shared-server', database: profile.auditDatabase, intervalSeconds: 60 }
    }
    persist()
  }
  return true
}
export async function closeSharedPools(): Promise<void> {
  if(!state&&!existsSync(file()))return
  const results=await Promise.allSettled(connections().filter(entry => entry.serverManaged).map(async entry => {
    const existing = pools.get(entry.id); pools.delete(entry.id)
    if (existing) await existing.end()
  }))
  for(const result of results)if(result.status==='rejected')console.warn('共享连接已移除，清理时连接已失效',String(result.reason))
}
export async function reconcileSharedConnections(
  records: Record<string, any>[], profile: SharedServerProfile
): Promise<boolean> {
  const stored = getState()
  const next: ConnectionDefinition[] = records.map((row) => {
    if (!/^[a-f0-9]{64}$/.test(row.id) || !/^mspec_lib2_shared_[a-f0-9]{20}$/.test(row.database_name) || Number(row.schema_version) !== 4)
      throw new Error('共享库清单格式无效')
    const hex = createHash('sha256').update(`${profile.serverId ?? `${profile.host}:${profile.port}`}:${row.id}`).digest('hex')
    const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`
    return { id, name: String(row.title).slice(0,255), host: profile.host, port: profile.port,
      user: profile.user, sourceLibraryId: String(row.id), sourceFileName: String(row.file_name || ''), database: row.database_name, adapter: 'native', enabled: true, writable: false, serverManaged: true }
  })
  const old = stored.connections.filter((x) => x.serverManaged)
  if (JSON.stringify(old) === JSON.stringify(next)) return false
  for (const entry of old) { await pools.get(entry.id)?.end(); pools.delete(entry.id) }
  stored.connections = [...stored.connections.filter((x) => !x.serverManaged), ...next]
  if (stored.sharedMode && !stored.connections.some((x) => x.id === stored.primaryId)) {
    stored.primaryId = '@shared-server'
    stored.audit = { enabled: false, connectionId: '@shared-server', database: profile.auditDatabase, intervalSeconds: 60 }
  }
  if (stored.sharedMode && next.length && stored.primaryId === '@shared-server') {
    stored.primaryId = next[0].id
    stored.audit = { enabled: true, connectionId: next[0].id, database: profile.auditDatabase, intervalSeconds: 60 }
  }
  persist()
  return true
}
