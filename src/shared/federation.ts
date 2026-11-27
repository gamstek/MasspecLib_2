import type { AuditMapping } from './audit'
export type AdapterKind = 'native' | 'legacy' | 'mapped'
export interface RecordRef {
  connectionId: string
  key: string
}
export interface SourceChoice {
  id: string
  name: string
  sourceType: string
  provider?: string
  location?: string
  connectionName?: string
}
export interface ColumnMapping {
  table: string
  key: string
  fields: Record<string, string>
  sourceType?: 'public' | 'local' | 'unknown'
}
export interface ConnectionDefinition {
  id: string
  name: string
  host: string
  port: number
  user: string
  database: string
  adapter: AdapterKind
  enabled: boolean
  writable: boolean
  mapping?: ColumnMapping
  auditMapping?: AuditMapping
  encryptedPassword?: string
  sourceLibraryId?: string
  sourceFileName?: string
  serverManaged?: boolean
}
export interface UnifiedFilters {
  countOnly?: boolean
  classificationPlan?: { pending: boolean; nativeCategoryIds: number[]; ruleCategoryIds: number[]; overrideIds: string[]; includeIds: string[] }
  keyword?: string
  dataTypes?: string[]
  auditState?: string
  unifiedView?: boolean
  identityStatus?: string
  sourceQuery?: string
  sourceIds?: string[]
  connectionIds?: string[]
  polarity?: number
  adduct?: string
  spectrumKind?: string
  favoriteOnly?: boolean
  trashOnly?: boolean
  classId?: number
  page?: number
  pageSize?: number
}
export function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) throw new Error('表名或字段名不合法')
  return '`' + value + '`'
}
export function refKey(ref: RecordRef): string {
  return JSON.stringify([ref.connectionId, ref.key])
}
export function sourceKey(
  namespace: string,
  name: string,
  provider: string | null = null,
  type = 'unknown',
  location: string | null = null
): string {
  // Same authoritative namespace AND metadata may be federated; names alone are never enough.
  return JSON.stringify([namespace, name, provider ?? '', type, location ?? ''])
}
export function pageWindow(
  counts: number[],
  page: number,
  size: number
): { index: number; offset: number; limit: number }[] {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 200
  )
    throw new Error('分页参数不合法')
  let offset = (page - 1) * size,
    remaining = size
  const result: { index: number; offset: number; limit: number }[] = []
  for (const [index, count] of counts.entries()) {
    if (offset >= count) {
      offset -= count
      continue
    }
    const limit = Math.min(remaining, count - offset)
    if (limit) result.push({ index, offset, limit })
    remaining -= limit
    offset = 0
    if (!remaining) break
  }
  return result
}
export function sourceMatches(source: SourceChoice, query: string, selected: string[]): boolean {
  return selected.length
    ? selected.includes(source.id)
    : !query.trim() || source.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
}
export function validateConnection(input: ConnectionDefinition): void {
  validateAuditMapping(input.auditMapping)
  if (!input.name?.trim() || !input.host?.trim() || !input.user?.trim())
    throw new Error('连接名称、主机和账号不能为空')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
    throw new Error('端口不合法')
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(input.database)) throw new Error('数据库名称不合法')
  if (!['native', 'legacy', 'mapped'].includes(input.adapter)) throw new Error('适配类型不合法')
  if (input.adapter !== 'native' && input.writable) throw new Error('外部适配器仅支持只读')
  if (input.adapter === 'mapped') {
    if (!input.mapping) throw new Error('请配置外部库字段映射')
    if (
      input.mapping.sourceType &&
      !['public', 'local', 'unknown'].includes(input.mapping.sourceType)
    )
      throw new Error('来源类型不合法')
    sqlIdentifier(input.mapping.table)
    sqlIdentifier(input.mapping.key)
    for (const value of Object.values(input.mapping.fields)) sqlIdentifier(value)
    if (
      !['main_name', 'name_zh', 'name_en', 'cas', 'formula'].some((k) => input.mapping?.fields[k])
    )
      throw new Error('至少映射一个名称、CAS或分子式字段')
  }
}

export function validateAuditMapping(mapping?: AuditMapping): void {
  if (!mapping) return
  for (const value of [
    mapping.table,
    mapping.key,
    mapping.compoundKey,
    ...Object.values(mapping.fields)
  ])
    sqlIdentifier(value)
  const allowed = [
    'data',
    'sample',
    'compound',
    'matrix',
    'expected_rt',
    'rt_window',
    'trace_json',
    'qualifier_trace_json',
    'peak_rules_json',
    'concentration',
    'unit',
    'modifier',
    'loq',
    'limit',
    'limit_unit',
    'limit_source',
    'quantifier_area',
    'qualifier_area',
    'ratio_reference',
    'ratio_tolerance_pct',
    'ratio_reference_source',
    'ratio_required',
    'batch_name',
    'method_name',
    'rule_version',
    'status',
    'record_type',
    'source_library_id',
    'image',
    'checks'
  ]
  if (Object.keys(mapping.fields).some((key) => !allowed.includes(key)))
    throw new Error('检测字段映射中有不支持的字段')
  if (
    !mapping.fields.data &&
    !['trace_json', 'concentration', 'quantifier_area', 'image'].some((key) => mapping.fields[key])
  )
    throw new Error('至少映射检测JSON、曲线、测定值、离子响应或图片')
  if (mapping.fields.status && !mapping.completedValue)
    throw new Error('映射完成状态时必须指定completedValue')
}
