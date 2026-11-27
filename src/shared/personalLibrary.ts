import {personalFlat} from './personalFlat.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { acquisitionFields, acquisitionView, lcFlowRate } from './acquisitionParameters.mjs'
import { lcTemperature } from './lcTemperature.ts'
import { retentionObservations } from './lcRetention.ts'
import { decodePackage, validatePackage, type DataPackage, type CompoundGroup } from './dataPackage.ts'
import { classificationCatalog, classificationKey, projectClassification } from './deliveryClassification.mjs'
import { localCatalog } from './classification.mjs'

export const personalFields = {
  classification: { categories: '规范分类与字典', status: '分类复核状态',source_labels:'来源原始分类标签' },
  compound: { main_name: '名称', name_zh: '中文名', name_en: '英文名', cas: 'CAS号', formula: '分子式', molecular_mass: '分子量', monoisotopic_mass: '单同位素质量', formula_diagram_base64: '结构图' },
  ms: { ...acquisitionFields, ms_mode: '质谱模式', q1: '母离子', q3: '子离子', ce: '碰撞能量', dp: '去簇电压', cxp: '碰撞室出口电压', polarity: '极性', ion_source: '离子源', adduct: '加合离子', ce_unit: '碰撞能量单位', transition_role: '通道用途', mass_spectrum_base64: '谱图图片' },
  spectrum: { kind: '谱图形式', peaks: '数值谱峰', image_base64: '谱图图片', spectrum_type: '谱图类型', polarity: '极性', adduct: '加合离子', precursor_mz: '前体离子质荷比', collision_energy: '碰撞能量', nature: '谱图性质' },
  lc: { method_source: '液相方法来源／分组', flow_rate: '流速及单位', lc_mode: '液相模式', retention_time: '保留时间', retention_time_unit: '时间单位', phase_A: '流动相A', phase_B: '流动相B', column_type: '色谱柱', column_length_mm: '柱长(mm)', column_inner_diameter_mm: '内径(mm)', column_particle_size_um: '粒径(μm)', column_temperature_c: '柱温(℃)', column_temperature_text: '柱温文字说明', retention_times: '保留时间/峰记录', gradient: '梯度程序' },
  source: { name: '来源名称', version: '来源版本', provider: '提供方', license: '许可说明' }
}
export function personalOwner(tenant: string, user: string): string {
  if (!tenant || !user) throw new Error('缺少个人数据所属账号')
  return createHash('sha256').update(JSON.stringify([tenant, user])).digest('hex')
}
export function localPersonalOwner(tenant: string): string {
  return personalOwner(tenant, 'local-workspace-v1')
}
export function tablePackage(rows: Record<string, unknown>[], fileHash: string): DataPackage {
  const groups: CompoundGroup[] = rows.map((row, i) => {
    const compound: Record<string, unknown> = {}
    for (const [key, label] of Object.entries(personalFields.compound)) {
      const v = row[key] ?? row[label]
      if (v !== undefined && v !== null && String(v).trim()) compound[key] = String(v).trim()
    }
    if (!compound.main_name) throw new Error(`第${i + 2}行缺少名称（main_name 或 名称列）`)
    for (const k of ['molecular_mass', 'monoisotopic_mass']) if (compound[k] !== undefined) {
      const n = Number(compound[k]); if (!Number.isFinite(n) || n < 0) throw new Error(`第${i + 2}行${k}应为非负数值`); compound[k] = n
    }
    return { source: { namespace: `personal:${fileHash}`, key: String(i + 1), sourceType: 'local' }, compound }
  })
  const data: DataPackage = { formatVersion: 2, schemaVersion: 2, packageId: `personal:${fileHash}`, mappingVersion: 'personal-table-v1', groups }
  validatePackage(data); return data
}
export function readPersonalPackage(bytes: Uint8Array): DataPackage {
  const data = decodePackage(bytes)
  if (!data.groups.length) throw new Error('数据包中没有化合物')
  for (const [i, g] of data.groups.entries()) if (!g.compound.main_name?.trim()) throw new Error(`第${i + 1}个化合物缺少名称`)
  return data
}
function raster(v: unknown, mime = 'image/png'): string | undefined {
  if (typeof v !== 'string') return undefined
  const value = v.startsWith('data:') ? v : `data:${mime};base64,${v}`
  return /^data:image\/(png|jpeg|webp|gif|bmp);base64,[a-zA-Z0-9+/=\r\n]+$/.test(value) ? value : undefined
}
function fields(row: any, group: keyof typeof personalFields): any {
  const out: any = {}
  for (const k of Object.keys(personalFields[group])) {
    const v = row[k]
    if (k.endsWith('base64')) { const image = raster(v, row.image_mime); if (image) out[k] = image }
    else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v
  }
  return out
}
export function personalView(batch: any, trashed = false): any {
  const deleted = new Set(batch.trashedRecordKeys || [])
  const catalog=classificationCatalog(localCatalog(batch.data.taxonomyCatalog||[])),keys=new Set(catalog.map(classificationKey))
  const classification=(g: CompoundGroup): any=>{
    const items=(g.classifications||[]).filter(c=>keys.has(classificationKey(c))).map(c=>({key:classificationKey(c),review_status:c.evidence?.find(e=>e.review_status)?.review_status||'unreviewed'}))
    const source_labels=[...(g.classes||[]).map(c=>c.class_name),...(g.classifications||[]).flatMap(c=>(c.evidence||[]).map(e=>e.original_label).filter((s):s is string=>typeof s==='string'))]
    return items.length||source_labels.length?projectClassification({catalog,items,source_labels},Object.keys(personalFields.classification)):undefined
  }
  const records = batch.data.groups.map((g: CompoundGroup, i: number) => ({
    id: `${batch.id}:${batch.recordKeys?.[i] ?? i}`, sourceTitle: g.source.name || batch.filename,
    compound: fields(g.compound, 'compound'),sanming:personalFlat.flatGroup(g,batch.data.taxonomyCatalog),
    classification: personalFlat.clip(classification(g)),
    sources: [{ name: g.source.name || batch.filename, version: g.source.version, provider: g.source.provider, license: g.source.license }],
    ms: (g.methods || []).map((m, n) => ({ id: `m${n}`, ...fields(m, 'ms'), ...acquisitionView(m) })),
    lc: (g.lcMethods || []).map((m, n) => ({ id: `l${n}`, ...fields({ ...m, ...lcTemperature(m), retention_time_unit: m.retention_time_unit || (m.retention_time != null ? 'min' : null), method_source: acquisitionView(m).method_source }, 'lc'), retention_time_unit_source: m.retention_time != null && !m.retention_time_unit ? 'default' : 'explicit', flow_rate: lcFlowRate(m), retention_times: retentionObservations(m).map(r => ({ ...r, methodIds: r.methodLocalIds.map(id => (g.methods || []).findIndex(m => m.localId === id)).filter(i => i >= 0).map(i => `m${i}`), methodLocalIds: undefined })), gradient: m.items || [] })),
    spectra: (g.spectra || []).map((s, n) => ({ id: `s${n}`, ...fields(s, 'spectrum'),methodIds:(s.methodLocalIds||[]).map(id=>(g.methods||[]).findIndex(m=>m.localId===id)).filter(i=>i>=0).map(i=>`m${i}`), ...(s.kind === 'numeric' ? { peaks: s.peaks.map((p: any) => ({ mz: Number(p.mz), intensity: Number(p.intensity) })) } : {}) })),
    chromatograms: [], experiments: [], checks: [], reviews: []
  })).filter((r: any) => deleted.has(Number(r.id.slice(r.id.lastIndexOf(':') + 1))) === trashed)
  return { records, manifest: { id: batch.id, title: batch.filename, version: '个人本地数据', personal: true, total: records.length, fieldLabels: personalFields, policy: { fields: Object.fromEntries(Object.entries(personalFields).map(([k, v]) => [k, Object.keys(v)])), features: { spectra: true, lc: true } } } }
}
export class PersonalLibrary {
  directory: string
  constructor(root: string, owner: string) {
    if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('个人数据账号无效')
    this.directory = join(root, 'personal-data', owner)
  }
  file(id: string): string { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('个人数据标识无效'); return join(this.directory, id + '.json') }
  list(trashed = false): any[] {
    const directory = trashed ? join(this.directory, 'trash') : this.directory
    if (!existsSync(directory)) return []
    return readdirSync(directory).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => {
      const id = f.slice(0, -5)
      try {
        const b = JSON.parse(readFileSync(join(directory, f), 'utf8'))
        if (b.id !== id || !b.filename || !Array.isArray(b.data?.groups)) throw new Error('批次结构无效')
        return { id, filename: b.filename, importedAt: String(b.importedAt || ''), total: personalView(b).records.length, trashedRecords: (b.trashedRecordKeys || []).length, damaged: false }
      } catch { return { id, filename: '无法读取的批次 · ' + id.slice(0, 8), importedAt: '', total: 0, damaged: true, issue: '批次文件损坏，其他批次仍可使用；可备份原文件或移入个人回收站' } }
    }).sort((a, b) => b.importedAt.localeCompare(a.importedAt))
  }
  save(bytes: Uint8Array, filename: string, data: DataPackage): any {
    validatePackage(data)
    if (!data.groups.length) throw new Error('没有可导入的化合物')
    const id = createHash('sha256').update(bytes).digest('hex'), file = this.file(id)
    if (existsSync(file)) return { id, duplicate: true }
    if (existsSync(join(this.directory, 'trash', id + '.json'))) throw new Error('相同批次在个人回收站中，请先恢复；若文件损坏，请先备份并删除回收站文件，再重新导入')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temp = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(temp, JSON.stringify({ id, filename, importedAt: new Date().toISOString(), data }), { mode: 0o600, flag: 'wx' }); renameSync(temp, file) }
    finally { if (existsSync(temp)) unlinkSync(temp) }
    return { id, duplicate: false }
  }
  read(id: string): any { try { const batch = JSON.parse(readFileSync(this.file(id), 'utf8')); if (batch.id !== id) throw new Error('批次标识不一致'); validatePackage(batch.data); return batch } catch { throw new Error('此批次无法读取，请备份原文件后重新导入；其他批次仍可使用') } }
  rename(id: string, name: string): void {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw new Error('批次名称应为1–120字')
    const batch = this.read(id), file = this.file(id), tmp = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(tmp, JSON.stringify({ ...batch, filename: name.trim() }), { mode: 0o600, flag: 'wx' }); renameSync(tmp, file) }
    finally { if (existsSync(tmp)) unlinkSync(tmp) }
  }
  changeRecords(id: string, recordIds: string[], action: 'delete' | 'restore' | 'purge'): void {
    if (!['delete', 'restore', 'purge'].includes(action) || !Array.isArray(recordIds) || !recordIds.length || recordIds.length > 20000 || new Set(recordIds).size !== recordIds.length) throw new Error('记录操作无效')
    const batch = this.read(id), keys: number[] = batch.recordKeys || batch.data.groups.map((_: any, i: number) => i)
    if (keys.length !== batch.data.groups.length || new Set(keys).size !== keys.length || keys.some(k => !Number.isSafeInteger(k) || k < 0)) throw new Error('记录标识损坏，请先备份')
    const deleted = new Set<number>(batch.trashedRecordKeys || []), selected = new Set<number>()
    for (const recordId of recordIds) {
      const key = keys.find(k => recordId === `${id}:${k}`)
      if (key === undefined || (action === 'delete' ? deleted.has(key) : !deleted.has(key))) throw new Error('记录状态已变化，请刷新后重试')
      selected.add(key)
    }
    if (action === 'delete') for (const key of selected) deleted.add(key)
    else for (const key of selected) deleted.delete(key)
    if (action === 'purge') batch.data.groups = batch.data.groups.filter((_: any, i: number) => !selected.has(keys[i]))
    batch.recordKeys = action === 'purge' ? keys.filter(k => !selected.has(k)) : keys
    batch.trashedRecordKeys = [...deleted]
    const file = this.file(id), tmp = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(tmp, JSON.stringify(batch), { mode: 0o600, flag: 'wx' }); renameSync(tmp, file) }
    finally { if (existsSync(tmp)) unlinkSync(tmp) }
  }
  adopt(previous: PersonalLibrary): void {
    if (previous.directory === this.directory) return
    const marker = join(this.directory, 'migrated-' + createHash('sha256').update(previous.directory).digest('hex'))
    if (existsSync(marker)) return
    for (const entry of previous.list()) {
      if (entry.damaged) continue
      if (existsSync(this.file(entry.id))) continue
      let batch: any
      try { batch = previous.read(entry.id); validatePackage(batch.data) } catch { continue }
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const file = this.file(entry.id), tmp = file + '.' + randomUUID() + '.tmp'
      try { writeFileSync(tmp, JSON.stringify(batch), { mode: 0o600, flag: 'wx' }); renameSync(tmp, file) }
      finally { if (existsSync(tmp)) unlinkSync(tmp) }
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeFileSync(marker, new Date().toISOString(), { mode: 0o600 })
  }
  raw(id: string, trashed = false): Buffer { const file = this.file(id); return readFileSync(trashed ? join(this.directory, 'trash', id + '.json') : file) }
  purge(id: string): void { this.file(id); unlinkSync(join(this.directory, 'trash', id + '.json')) }
  remove(id: string): void {
    const file = this.file(id), directory = join(this.directory, 'trash'), target = join(directory, id + '.json')
    if (existsSync(target)) throw new Error('个人回收站已有相同批次，请先恢复或删除回收站中的旧批次')
    mkdirSync(directory, { recursive: true, mode: 0o700 }); renameSync(file, target)
  }
  restore(id: string): void {
    const target = this.file(id), source = join(this.directory, 'trash', id + '.json')
    if (existsSync(target)) throw new Error('我的数据中已有相同批次')
    renameSync(source, target)
  }
}
