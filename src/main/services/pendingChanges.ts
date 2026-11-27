/* eslint-disable @typescript-eslint/no-explicit-any */
import { app, dialog } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { EditDrafts } from '../../shared/editDrafts.mjs'
import { adminEditIdentity } from '../delivery'

const context = new AsyncLocalStorage<{ id: string; sequence: number }>()
const store = (): EditDrafts => new EditDrafts(join(app.getPath('userData'), 'pending-changes'))
const handlers = new Map<string, (event: any, ...args: any[]) => Promise<any>>()
const busy = new Set<string>()
export function publishedOperationId(): string | undefined {
  const operation = context.getStore()
  return operation ? operation.id + '-' + operation.sequence++ : undefined
}
function routeMutation(args: any[]): boolean {
  if (args[0] !== 'POST') return false
  return args[1] === '/admin/source-updates/publish' || args[1] === '/admin/massbank-update/publish' || /^\/admin\/classification\/(category|category-status|mapping|default-major|role|assign|unlock)$/.test(args[1]) ||
    /^\/admin\/file-sources\/(change|mutate|update-compound|default-major|restore|register|convert)$/.test(args[1])
}
const writes = new Set(['federation:create', 'federation:records-change', 'federation:trash',
  'classification:assign', 'file-library:import-new', 'import:compounds', 'compounds:import-excel', 'import:undo'])
function label(channel: string, args: any[]): string {
  if (channel === 'file-library:import-new') return `新建并导入文件库 · ${args[2]}`
  if (channel === 'delivery:call') {
    if (args[1] === '/admin/source-updates/publish') return `数据源谱图更新 · ${args[2]?.selected?.length || 0} 张`
    if (args[1] === '/admin/massbank-update/publish') return `MassBank 谱图更新 · ${args[2]?.selected?.length || 0} 条`
    const action = args[1].split('/').pop()
    return ({ category: '新增或修改类别', 'category-status': '调整类别状态', mapping: '调整分类对应',
      'default-major': '调整默认分类', role: '调整分类来源', assign: '批量归类', unlock: '撤销人工归类',
      change: '记录删除或恢复', mutate: '文件库内容修改', 'update-compound': '编辑化合物',
      restore: '恢复管理工作区', register: '登记或更新文件库', convert: '生成文件副本' } as any)[action] || '共享内容修改'
  }
  return ({ 'federation:create': '新增化合物', 'federation:records-change': '记录删除或恢复',
    'federation:trash': '记录删除或恢复', 'classification:assign': '批量归类',
    'import:undo': '撤销导入' } as any)[channel] || '导入化合物'
}
export async function stageChange(channel: string, incoming: any[]): Promise<any | undefined> {
  if (context.getStore()) return undefined
  const envelope = incoming[0]?.__scope === 'masspeclib2'
  const args = envelope ? incoming[0].args : incoming
  if (!writes.has(channel) && !(channel === 'delivery:call' && routeMutation(args))) return undefined
  const identity = adminEditIdentity(), id = randomUUID(), copy = structuredClone(incoming)
  if (channel === 'import:compounds' || channel === 'compounds:import-excel' || channel === 'file-library:import-new') {
    const data = envelope ? copy[0].args : copy
    const content = readFileSync(data[0])
    if (content.length > 64 * 1024 * 1024) throw Error('导入文件超过64MiB')
    const hash = createHash('sha256').update(content).digest('hex')
    if (data[1] && data[1] !== hash) throw Error('文件已变化，请重新预览')
    const dir = join(app.getPath('userData'), 'pending-imports')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, id + extname(data[0]))
    copyFileSync(data[0], target)
    data[0] = target
    data[1] = hash
    if (channel === 'file-library:import-new') data[3] = id
  }
  const title = channel === 'federation:create' && args[0]?.compound?.main_name ? ' · ' + args[0].compound.main_name : ''
  const entry = { id, label: label(channel, args) + title, channel, args: copy, status: 'ready' }
  store().put(identity.owner, '@commands', id, entry)
  return { success: true, staged: true, affected: 0, changed: 0, imported: 0, skipped: 0, operationId: id }
}
export function registerPublishHandler(channel: string, handler: any): void { handlers.set(channel, handler) }
function selected(id: string): any {
  const identity = adminEditIdentity()
  const entry = store().get(identity.owner, '@commands', id)
  if (!entry) throw Error('待发布变更不存在')
  return { identity, entry }
}
export function listPendingChanges(): any[] {
  return store().list(adminEditIdentity().owner).map(value => ({
    id: value.id, label: value.label, savedAt: value.savedAt, status: value.status, result: value.result
  }))
}
export function inspectPendingChange(id: string): any {
  const { entry } = selected(id)
  return { label: entry.label, channel: entry.channel, args: entry.args, status: entry.status, result: entry.result }
}
export function discardPendingChange(id: string): any {
  const { identity, entry } = selected(id)
  if (busy.has(id)) throw Error('此变更正在发布')
  if (entry.channel === 'import:compounds' || entry.channel === 'compounds:import-excel' || entry.channel === 'file-library:import-new') {
    const args = entry.args[0]?.__scope ? entry.args[0].args : entry.args
    const file = args[0]
    if (typeof file === 'string' && file === join(app.getPath('userData'), 'pending-imports', id + extname(file))) {
      try { unlinkSync(file) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    }
  }
  store().remove(identity.owner, '@commands', id)
  return { success: true }
}
export async function publishPendingChange(id: string): Promise<any> {
  const { identity, entry } = selected(id)
  if (busy.has(id)) throw Error('此变更正在发布')
  if (entry.status === 'completed') return entry.result
  if (entry.status === 'uncertain') throw Error('上次发布结果尚未确认，请核对正式内容和操作结果后处理，变更已保留')
  const handler = handlers.get(entry.channel)
  if (!handler) throw Error('此变更入口不可用')
  busy.add(id)
  try {
    store().put(identity.owner, '@commands', id, { ...entry, status: 'uncertain' })
    const result = await context.run({ id, sequence: 0 }, () => handler(undefined, ...entry.args))
    if (result?.success === false) throw Error(JSON.stringify(result))
    if (adminEditIdentity().owner !== identity.owner) throw Error('账号已变化，结果请重新登录核对')
    store().put(identity.owner, '@commands', id, { ...entry, status: 'completed', result })
    return result
  } catch (error) {
    // Server requests have durable operation receipts and can safely be retried with the same ID.
    const serverOnly = entry.channel === 'delivery:call' || entry.channel === 'file-library:import-new' || entry.channel === 'classification:assign' ||
      JSON.stringify(entry.args).includes('file:')
    const publicationState = (error as { publicationState?: string })?.publicationState
    const status = publicationState === 'rejected' ? 'rejected'
      : publicationState === 'uncertain' || !serverOnly ? 'uncertain' : 'ready'
    store().put(identity.owner, '@commands', id, { ...entry, status, result: String(error) })
    throw error
  } finally { busy.delete(id) }
}
export async function exportPendingChange(id: string): Promise<any> {
  const data = inspectPendingChange(id)
  const choice = await dialog.showSaveDialog({ title: '备份待发布变更', defaultPath: '待发布变更.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (choice.canceled || !choice.filePath) return { cancelled: true }
  writeFileSync(choice.filePath, JSON.stringify(data, null, 2))
  return { saved: true }
}
