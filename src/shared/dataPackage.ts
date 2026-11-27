import { validateCatalog, taxonomyKey, type TaxonomyCategory, type Classification } from './taxonomy.ts'
import { createHash } from 'node:crypto'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { lcTemperature } from './lcTemperature.ts'
import { retentionObservations } from './lcRetention.ts'
import { normalizeAcquisition } from './acquisitionParameters.mjs'

// Source-specific JSON fields are validated at this boundary before database mapping.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RecordData = Record<string, any>
export interface CompoundGroup {
  source: {
    namespace: string
    key: string
    name?: string
    version?: string
    provider?: string
    license?: string
    sourceType?: 'public' | 'local' | 'unknown'
    location?: string
  }
  compound: RecordData
  classifications?: Classification[]
  classes?: RecordData[]
  methods?: RecordData[]
  lcMethods?: RecordData[]
  spectra?: RecordData[]
  profiles?: RecordData[]
  provenance?: RecordData[]
  raw?: unknown
}
/** Explicit scientific origins take precedence over the package's grouping source. */
export function hasEntityProvenance(group: CompoundGroup, type: string, localId: unknown): boolean {
  if (typeof localId !== 'string' || !localId) return false
  return (group.provenance ?? []).some((evidence) => {
    const origin = evidence.source_record?.library
    return (
      (evidence.appliesTo ?? evidence.entity_type) === type &&
      (evidence.entityId ?? evidence.entity_id) === localId &&
      typeof origin?.namespace === 'string' &&
      Boolean(origin.namespace.trim()) &&
      Boolean(origin.name) &&
      !origin.namespace.startsWith('database-record:')
    )
  })
}
export interface DataPackage {
  formatVersion: 2
  schemaVersion: 2
  packageId: string
  mappingVersion: string
  taxonomyCatalog?: TaxonomyCategory[]
  groups: CompoundGroup[]
}
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024
const MAX_GROUP_BYTES = 16 * 1024 * 1024

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value)
    if (result === undefined) throw new Error('数据包含不可序列化字段')
    return result
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']'
  const record = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalStringify(record[key]))
      .join(',') +
    '}'
  )
}
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex')
}
function requiredString(value: unknown, label: string, limit = 191): void {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error(`${label}必须是长度不超过${limit}的非空字符串`)
}
function validateOptionalNumber(value: unknown, label: string, positive = false): void {
  if (value === null || value === undefined) return
  if (
    value === '' ||
    !['number', 'string'].includes(typeof value) ||
    !Number.isFinite(Number(value)) ||
    (positive && Number(value) <= 0)
  )
    throw new Error(`${label}数值无效`)
}
export function validateGroup(group: CompoundGroup): void {
  if (!group || typeof group !== 'object' || !group.source || !group.compound)
    throw new Error('处理单元缺少化合物或来源')
  requiredString(group.source.namespace, '来源命名空间')
  requiredString(group.source.key, '来源键')
  if (
    group.source.sourceType !== undefined &&
    !['public', 'local', 'unknown'].includes(group.source.sourceType)
  )
    throw new Error('来源类型无效')
  if (
    group.compound.name !== null &&
    group.compound.name !== undefined &&
    !Array.isArray(group.compound.name)
  )
    throw new Error('名称集合必须是数组')
  for (const name of group.compound.name ?? [])
    if (typeof name.name !== 'string') throw new Error('别名必须是字符串，可保留空字符串')
  for (const field of ['main_name', 'name_zh', 'name_en', 'cas', 'formula'])
    if (group.compound[field] !== null && group.compound[field] !== undefined) {
      if (typeof group.compound[field] !== 'string' || group.compound[field].length > 255)
        throw new Error(`${field}必须是长度不超过255的字符串，可保留空字符串`)
    }
  if (
    !group.compound.main_name &&
    !group.compound.name_zh &&
    !group.compound.name_en &&
    !group.compound.name?.length &&
    !group.compound.cas &&
    !group.compound.formula
  )
    throw new Error('化合物至少需要一项可展示的身份信息')
  for (const field of [
    'classes',
    'methods',
    'lcMethods',
    'spectra',
    'profiles',
    'provenance'
  ] as const) {
    if (group[field] !== undefined && !Array.isArray(group[field]))
      throw new Error(`${field}必须是数组`)
  }
  const methodIds = new Set<string>()
  for (const method of group.methods ?? []) {
    normalizeAcquisition(method)
    if (method.localId !== undefined) {
      requiredString(method.localId, '方法包内 ID')
      if (methodIds.has(method.localId)) throw new Error('方法包内 ID 重复')
      methodIds.add(method.localId)
    }
    if (
      method.transition_role != null &&
      !['quantifier', 'qualifier', 'unspecified'].includes(method.transition_role)
    )
      throw new Error('离子对用途无效')
    for (const key of ['q1', 'q3', 'ce', 'dp', 'cxp', 'cad_value'])
      validateOptionalNumber(method[key], key)
    if (
      method.polarity !== null &&
      method.polarity !== undefined &&
      ![0, 1].includes(method.polarity)
    )
      throw new Error('极性必须是 0、1 或 null')
  }
  for (const spectrum of group.spectra ?? []) {
    if (!['numeric', 'image'].includes(spectrum.kind))
      throw new Error('谱图 kind 必须是 numeric 或 image')
    if (spectrum.kind === 'numeric') {
      if (!Array.isArray(spectrum.peaks) || !spectrum.peaks.length)
        throw new Error('数值谱至少需要一个谱峰')
      for (const peak of spectrum.peaks) {
        validateOptionalNumber(peak.mz, 'm/z', true)
        validateOptionalNumber(peak.intensity, '强度')
        if (
          peak.mz === null ||
          peak.mz === undefined ||
          peak.intensity === null ||
          peak.intensity === undefined
        )
          throw new Error('谱峰缺少 m/z 或强度')
      }
    } else {
      requiredString(spectrum.image_base64, '图片 Base64', MAX_GROUP_BYTES)
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(spectrum.image_mime))
        throw new Error('不支持的谱图图片 MIME')
      const bytes = Buffer.from(spectrum.image_base64, 'base64')
      if (!bytes.length || bytes.toString('base64') !== spectrum.image_base64)
        throw new Error('图片 Base64 无效')
      const valid =
        spectrum.image_mime === 'image/png'
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : spectrum.image_mime === 'image/jpeg'
            ? bytes[0] === 255 && bytes[1] === 216
            : spectrum.image_mime === 'image/gif'
              ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
              : bytes.subarray(0, 4).toString() === 'RIFF' &&
                bytes.subarray(8, 12).toString() === 'WEBP'
      if (!valid) throw new Error('图片内容与 MIME 不符')
    }
    if (
      spectrum.polarity !== null &&
      spectrum.polarity !== undefined &&
      ![0, 1].includes(spectrum.polarity)
    )
      throw new Error('谱图极性无效')
    validateOptionalNumber(spectrum.precursor_mz, '前体 m/z', true)
    if (spectrum.methodLocalIds !== undefined && !Array.isArray(spectrum.methodLocalIds))
      throw new Error('谱图方法引用必须是数组')
    for (const id of spectrum.methodLocalIds ?? [])
      if (!methodIds.has(id)) throw new Error(`谱图引用不存在的方法：${id}`)
  }
  for (const method of group.lcMethods ?? []) {
    validateOptionalNumber(method.retention_time, '保留时间')
    for (const key of ['column_length_mm', 'column_inner_diameter_mm', 'column_particle_size_um'])
      validateOptionalNumber(method[key], key, true)
    lcTemperature(method)
    retentionObservations(method, methodIds)
    if (method.items !== undefined && !Array.isArray(method.items))
      throw new Error('梯度步骤必须是数组')
    for (const item of method.items ?? []) {
      validateOptionalNumber(item.time, '梯度时间')
      validateOptionalNumber(item.flow_rate, '流量')
    }
  }
  for (const item of group.classes ?? []) {
    requiredString(item.class_name, '分类名称', 255)
  }
  for (const profile of group.profiles ?? []) requiredString(profile.title, '检测档案标题', 255)
  if (Buffer.byteLength(canonicalStringify(group)) > MAX_GROUP_BYTES)
    throw new Error('单个处理单元超过 16 MiB')
}
export function validatePackage(data: DataPackage): void {
  if (data.formatVersion !== 2 || data.schemaVersion !== 2 || !Array.isArray(data.groups))
    throw new Error('不支持的数据包版本或结构')
  requiredString(data.packageId, '数据包 ID')
  requiredString(data.mappingVersion, '映射版本', 64)
  const catalog = data.taxonomyCatalog ?? []
  validateCatalog(catalog)
  const categoryKeys = new Set(catalog.map(x => taxonomyKey(x.namespace, x.category_code)))
  const keys = new Set<string>()
  for (const group of data.groups) {
    validateGroup(group)
    if (group.classifications !== undefined && !Array.isArray(group.classifications)) throw new Error('化合物分类关联必须是数组')
    const seen = new Set<string>()
    for (const item of group.classifications ?? []) {
      const key = taxonomyKey(item.namespace, item.category_code)
      if (!categoryKeys.has(key)) throw new Error('化合物引用了目录中不存在的分类')
      if (seen.has(key)) throw new Error('化合物分类关联重复')
      seen.add(key)
      if (item.evidence !== undefined && !Array.isArray(item.evidence)) throw new Error('分类证据必须是数组')
    }
    const key = canonicalStringify([group.source.namespace, group.source.key])
    if (keys.has(key)) throw new Error('一个数据包中出现重复来源键；不同修订请分包导入')
    keys.add(key)
  }
}
export function encodePackage(data: DataPackage): Uint8Array {
  validatePackage(data)
  const records = strToU8(data.groups.map(canonicalStringify).join('\n'))
  if (records.length > MAX_UNPACKED_BYTES) throw new Error('数据包解压总量超过 256 MiB，请分包')
  const manifest = {
    ...data,
    groups: undefined,
    groupCount: data.groups.length,
    files: [
      {
        path: 'groups.ndjson',
        bytes: records.length,
        sha256: createHash('sha256').update(records).digest('hex')
      }
    ]
  }
  const output = zipSync(
    { 'manifest.json': strToU8(JSON.stringify(manifest)), 'groups.ndjson': records },
    { level: 6 }
  )
  if (output.length > MAX_FILE_BYTES) throw new Error('数据包超过 64 MiB，请分包')
  return output
}
export function decodePackage(bytes: Uint8Array): DataPackage {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('文件超过 64 MiB，请先分包')
  if (bytes[0] !== 80 || bytes[1] !== 75) {
    const legacy = JSON.parse(strFromU8(bytes))
    if (legacy.formatVersion === 2) {
      validatePackage(legacy)
      return legacy
    }
    if (legacy.exportVersion !== '1.0' || !Array.isArray(legacy.compounds))
      throw new Error('不支持的旧包格式')
    const fileHash = createHash('sha256').update(bytes).digest('hex')
    const groups = legacy.compounds.map((compound: RecordData, index: number) => ({
      source: { namespace: `legacy:${fileHash}`, key: String(compound.id ?? index) },
      compound: {
        ...compound,
        name:
          typeof compound.name === 'string'
            ? compound.name
              ? [{ name: compound.name, area: '' }]
              : []
            : compound.name
      },
      classes: compound.classes ?? [],
      methods: (compound.ms_methods ?? []).map((method: RecordData) => ({
        ...method,
        localId: String(method.id)
      })),
      lcMethods: compound.lc_methods ?? [],
      spectra: [],
      profiles: [],
      raw: compound
    }))
    const data: DataPackage = {
      formatVersion: 2,
      schemaVersion: 2,
      packageId: `legacy:${fileHash}`,
      mappingVersion: 'legacy-v1',
      groups
    }
    validatePackage(data)
    return data
  }
  let expanded = 0
  const names = new Set<string>()
  const files = unzipSync(bytes, {
    filter: (entry) => {
      if (!['manifest.json', 'groups.ndjson'].includes(entry.name) || names.has(entry.name))
        throw new Error('数据包含未知或重复文件')
      names.add(entry.name)
      expanded += entry.originalSize
      if (
        expanded > MAX_UNPACKED_BYTES ||
        (entry.name === 'manifest.json' && entry.originalSize > 1024 * 1024)
      )
        throw new Error('数据包解压大小超限')
      return true
    }
  })
  if (!files['manifest.json'] || !files['groups.ndjson'])
    throw new Error('数据包缺少 manifest 或记录文件')
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  const metadata = manifest.files?.find((entry: RecordData) => entry.path === 'groups.ndjson')
  if (
    metadata?.bytes !== files['groups.ndjson'].length ||
    metadata?.sha256 !== createHash('sha256').update(files['groups.ndjson']).digest('hex')
  )
    throw new Error('数据包长度或 SHA256 校验失败')
  const text = strFromU8(files['groups.ndjson'])
  const groups = text ? text.split('\n').map((line) => JSON.parse(line)) : []
  if (groups.length !== manifest.groupCount) throw new Error('数据包记录数不符')
  const data = { ...manifest, groups } as DataPackage
  validatePackage(data)
  return data
}
