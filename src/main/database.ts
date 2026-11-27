/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'async_hooks'
import { PrismaClient } from '../generated/prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { loadDatabaseConfig } from './databaseConfig'
import { validateDatabaseIdentity, validateDatabaseTarget } from '../shared/databaseTarget'
const context = new AsyncLocalStorage<any>()
function createClient(config: any) {
  const base = new PrismaClient({
    adapter: new PrismaMariaDb({
      ...config,
      connectionLimit: 4,
      acquireTimeout: 12000,
      charset: 'utf8mb4'
    })
  })
  return base.$extends({
    query: {
      $allOperations: async ({ args, query }) => {
        validateDatabaseIdentity(await base.app_metadata.findUnique({ where: { id: 1 } }))
        return query(args)
      }
    }
  })
}
let primary: ReturnType<typeof createClient> | undefined
const clients = new Map<string, any>()
export const prisma = new Proxy({} as ReturnType<typeof createClient>, {
  get(_target, key) {
    const client = context.getStore() ?? (primary ??= createClient(loadDatabaseConfig().config))
    const value = client[key]
    return typeof value === 'function' ? value.bind(client) : value
  }
})
export async function withDatabase<T>(
  id: string | undefined,
  write: boolean,
  operation: () => Promise<T>
): Promise<T> {
  const { connection, getState, credentials } = await import('./federation/registry')
  const entry = connection(id ?? getState().primaryId)
  if (!entry.enabled) throw new Error('数据库连接已停用')
  if (entry.adapter !== 'native') throw new Error('此连接只能通过只读适配器访问')
  if (write && !entry.writable) throw new Error('此数据库为只读，操作已拒绝')
  if (write) validateDatabaseTarget(entry.database)
  let client = clients.get(entry.id)
  if (!client) {
    client = createClient(await credentials(entry))
    clients.set(entry.id, client)
  }
  return context.run(client, operation)
}
export async function resetDatabaseClient(id: string): Promise<void> {
  await clients.get(id)?.$disconnect()
  clients.delete(id)
}
