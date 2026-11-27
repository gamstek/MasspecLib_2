/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync } from 'node:fs'
import { app, dialog } from 'electron'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { EditDrafts } from '../../shared/editDrafts.mjs'
import { adminEditIdentity, publicationResult, publishRequest } from '../delivery'
import { connection } from '../federation/registry'
import { detail } from '../federation/adapters'
import { withDatabase } from '../database'
import { fileDetail, isFileRef } from './fileLibrary'
import { lcForEditor } from '../../shared/fileRecordTransfer'
import type { RecordRef } from '../../shared/federation'

let store: EditDrafts | undefined
const drafts = (): EditDrafts => store ??= new EditDrafts(join(app.getPath('userData'), 'edit-drafts'))
function context(ref: RecordRef): { owner: string; session: number; target: string } {
  const identity = adminEditIdentity()
  if (!ref || !/^\d{1,20}$/.test(String(ref.key))) throw Error('请选择具体来源记录')
  if (isFileRef(ref)) return { ...identity, target: ref.connectionId }
  const entry = connection(ref.connectionId)
  return { ...identity, target: JSON.stringify(['sql', entry.host, entry.port, entry.database]) }
}
function check(ctx: { owner: string; session: number }): void {
  const now = adminEditIdentity()
  if (ctx.owner !== now.owner || ctx.session !== now.session) throw Error('登录状态已变化，请重新操作')
}
const revision = (data: any): any => data.compound.fileRecord ? data.compound.fileRevision : data.compound.revision
const publishedDetail = (ref: RecordRef): Promise<any> => isFileRef(ref) ? fileDetail(ref) : detail(ref)
function fileFingerprint(data: any): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return createHash('sha256').update(JSON.stringify(canonical(data.extensions.fileRecord))).digest('hex')
}
function changed(draft: any, published: any): boolean {
  // File revisions cover the whole library. Publishing a different record must not invalidate this draft.
  return draft.kind === 'sql' ? revision(published) !== draft.baseRevision
    : fileFingerprint(published) !== draft.baseFingerprint
}

export function ownDraft(ref: RecordRef): any {
  const ctx = context(ref)
  return drafts().get(ctx.owner, ctx.target, ref.key)
}
export function draftView(ref: RecordRef, published: any): any {
  if (!/^\d{1,20}$/.test(String(ref?.key))) return published
  const draft = ownDraft(ref)
  if (!draft) return published
  return { ...draft.view, audit: published.audit,
    compound: { ...draft.view.compound, ref, readOnly: published.compound.readOnly,
      canEditBasic: published.compound.canEditBasic, canEditWorkspace: published.compound.canEditWorkspace, canManageRecords: published.compound.canManageRecords,
      is_favorite: published.compound.is_favorite, hasDraft: true, draftSavedAt: draft.savedAt,
      draftConflict: changed(draft, published) },
    pendingSpectrumImports: draft.payload.pendingSpectrumImports || [] }
}

export async function saveSqlDraft(ref: RecordRef, input: any): Promise<any> {
  const ctx = context(ref)
  if (isFileRef(ref) || Number(ref.key) !== input?.compound?.id) throw Error('草稿记录归属不符')
  return drafts().locked(ctx.owner, ctx.target, ref.key, async () => {
    const old = drafts().get(ctx.owner, ctx.target, ref.key)
    const current = await publishedDetail(ref)
    check(ctx)
    if (current.compound.readOnly || current.compound.schemaVersion !== 4) throw Error('此数据库不可编辑')
    const baseRevision = old?.baseRevision ?? revision(current)
    if (input.compound.revision !== baseRevision) throw Error('数据版本已变化，请重新打开详情')
    if (current.compound.is_delete || current.compound.is_in_trash) throw Error('此记录已删除或移入回收站，请先恢复记录')
    const payload = structuredClone(input)
    // New methods have no database ID. Keep the original deletion baseline across repeated draft saves.
    for (const [deleted, list] of [['deletedMsMethodIds', 'compoundMsMethodList'], ['deletedLcMethodIds', 'compoundLcMethodList']]) {
      const ids = (value: any): number[] => (list === 'compoundMsMethodList' ? value[list].flatMap((g: any) => g.methods) : value[list]).map((m: any) => m.id).filter(Number.isSafeInteger)
      const original = old ? [...ids(old.payload), ...(old.payload[deleted] || [])] : [...ids(payload), ...(payload[deleted] || [])]
      const retained = new Set(ids(payload))
      payload[deleted] = [...new Set(original)].filter(id => !retained.has(id))
    }
    if (payload.pendingSpectrumImports?.length) {
      const { prepareSpectrumRows } = await import('./legacySpectra')
      await withDatabase(ref.connectionId, false, () => prepareSpectrumRows(payload.pendingSpectrumImports))
    }
    const view = { ...current, compound: { ...current.compound, ...payload.compound, ref },
      methods: payload.compoundMsMethodList, lcMethods: payload.compoundLcMethodList,
      classes: (old?.view.classes || current.classes).filter((c: any) => [...payload.classIdList, ...payload.customClassIdList].includes(c.id)),
      extensions: { ...current.extensions, ...payload.extensions } }
    check(ctx)
    drafts().put(ctx.owner, ctx.target, ref.key, { kind: 'sql', operationId: randomUUID(), ref, baseRevision, payload, view })
    return { success: true, draft: true, revision: baseRevision }
  })
}

export async function saveFileDraft(input: any, kind: 'file-basic' | 'file-workspace'): Promise<any> {
  const ref = input.ref as RecordRef, ctx = context(ref)
  if (!isFileRef(ref)) throw Error('请选择文件库记录')
  return drafts().locked(ctx.owner, ctx.target, ref.key, async () => {
    const old = drafts().get(ctx.owner, ctx.target, ref.key), published = await fileDetail(ref)
    check(ctx)
    const current = old?.view || published, baseRevision = old?.baseRevision ?? revision(published)
    if (input.revision !== baseRevision) throw Error('文件库版本已变化，请重新打开详情')
    if (!published.compound.canEditBasic || (kind === 'file-workspace' && !published.compound.canEditWorkspace)) throw Error('此文件记录不可编辑')
    const payload = structuredClone(input)
    let record: any
    if (kind === 'file-basic') {
      const fields = ['main_name', 'name_zh', 'name_en', 'cas', 'formula', 'molecular_mass', 'monoisotopic_mass']
      payload.compound = Object.fromEntries(Object.entries(payload.compound || {}).filter(([key]) => fields.includes(key)))
      record = { ...current.extensions.fileRecord, compound: { ...current.extensions.fileRecord.compound, ...payload.compound } }
      if (old?.kind === 'file-workspace') { payload.record = record; kind = 'file-workspace' }
    } else {
      record = payload.record
      if (payload.pendingSpectrumImports?.length) {
        const { stagedFileSpectra } = await import('./fileScopedIPC')
        const staged = await stagedFileSpectra(ref.connectionId, Number(ref.key), payload.pendingSpectrumImports, record.ms || [])
        record.ms = [...(record.ms || []), ...staged.methods]
        record.spectra = [...(record.spectra || []).filter((s: any) => !staged.spectra.some(n => n.id === s.id)), ...staged.spectra]
      }
      const { lcForWorkspace } = await import('../../shared/fileRecordTransfer')
      record.lc = lcForWorkspace(record.lc || [])
      record.compound = Object.fromEntries(Object.entries(record.compound || {}).filter(([key]) => ['main_name', 'name_zh', 'name_en', 'cas', 'formula', 'molecular_mass', 'monoisotopic_mass', 'smiles'].includes(key)))
    }
    if (kind === 'file-workspace') {
      const fields = new Set(['compound', 'ms', 'lc', 'spectra', 'sources', 'chromatograms', 'experiments', 'classification', 'raw', 'provenance'])
      record = Object.fromEntries(Object.entries(record).filter(([key]) => fields.has(key)))
      payload.record = record
    }
    if (!String(record.compound?.main_name || '').trim()) throw Error('主显示名称不能为空')
    payload.pendingSpectrumImports = []
    const view = { ...current, compound: { ...current.compound, ...record.compound },
      methods: (record.ms || []).length ? [{ ms_mode: '质谱方法', methods: record.ms }] : [],
      lcMethods: lcForEditor(record.lc || []).map((m: any) => ({ ...m, methodsLinks: m.gradient || [] })),
      extensions: { ...current.extensions, fileRecord: record, spectra: record.spectra || [],
        classifications: (record.classification?.items || []).map((item: any) => { const [namespace, category_code] = JSON.parse(item.key); return { namespace, category_code, evidence: [{ review_status: item.review_status }] } }) } }
    check(ctx)
    drafts().put(ctx.owner, ctx.target, ref.key, { kind, operationId: randomUUID(), ref, baseRevision,
      baseFingerprint: old?.baseFingerprint ?? fileFingerprint(published), payload, view })
    return { success: true, draft: true, revision: baseRevision }
  })
}

function storedDraft(ref: RecordRef): any {
  const identity = adminEditIdentity()
  const draft = drafts().list(identity.owner).find(d => d.ref?.connectionId === ref?.connectionId && d.ref?.key === ref?.key && d.kind !== 'recovery')
  if (!draft) throw Error('草稿不存在')
  return { identity, draft }
}
export function listEditDrafts(): any[] {
  const ctx = adminEditIdentity()
  return drafts().list(ctx.owner).filter(d => d.kind !== 'recovery').map(d => ({ ref: d.ref, name: d.view.compound.main_name, savedAt: d.savedAt }))
}
export function inspectEditDraft(ref: RecordRef): any {
  return storedDraft(ref).draft.view
}
export async function exportEditDraft(ref: RecordRef): Promise<any> {
  const { draft, identity } = storedDraft(ref)
  const selected = await dialog.showSaveDialog({ title: '导出草稿备份', defaultPath: '未发布草稿.json', filters: [{ name: '草稿备份', extensions: ['json'] }] })
  if (selected.canceled || !selected.filePath) return { cancelled: true }
  check(identity)
  writeFileSync(selected.filePath, JSON.stringify({ format: 'MasspecLib2-edit-draft', draft }, null, 2))
  return { saved: true }
}
export async function discardEditDraft(ref: RecordRef): Promise<any> {
  const { identity } = storedDraft(ref)
  check(identity)
  drafts().removeRef(identity.owner, ref)
  return { success: true }
}
const recoveryKey = (ref: RecordRef): string => createHash('sha256').update(JSON.stringify([ref.connectionId, ref.key])).digest('hex')
export function readRecovery(ref: RecordRef): any {
  const ctx = adminEditIdentity()
  return drafts().get(ctx.owner, '@recovery', recoveryKey(ref))?.view
}
export function writeRecovery(ref: RecordRef, view: any): any {
  const ctx = adminEditIdentity()
  drafts().put(ctx.owner, '@recovery', recoveryKey(ref), { kind: 'recovery', ref, view })
  return { success: true }
}
export function clearRecovery(ref: RecordRef): any {
  const ctx = adminEditIdentity()
  drafts().remove(ctx.owner, '@recovery', recoveryKey(ref))
  return { success: true }
}
export async function publishEditDraft(ref: RecordRef): Promise<any> {
  const ctx = context(ref)
  return drafts().locked(ctx.owner, ctx.target, ref.key, async () => {
    const draft = drafts().get(ctx.owner, ctx.target, ref.key)
    if (!draft) throw Error('没有待发布草稿')
    if (!draft.operationId) {
      draft.operationId = randomUUID()
      drafts().put(ctx.owner, ctx.target, ref.key, draft)
    }
    if (draft.kind === 'sql') {
      const { savedSqlPublication } = await import('./compoundDetails')
      const saved = await withDatabase(ref.connectionId, true, () => savedSqlPublication(draft.operationId))
      if (saved) { drafts().remove(ctx.owner, ctx.target, ref.key); return saved }
    } else {
      if (!draft.operationId) {
        draft.operationId = randomUUID()
        drafts().put(ctx.owner, ctx.target, ref.key, draft)
      }
      const previous = await publicationResult(draft.operationId)
      if (previous.state === 'completed' && previous.status < 300) {
        drafts().remove(ctx.owner, ctx.target, ref.key)
        return { ...previous.data, success: true, recoveredPublication: true }
      }
    }
    const published = await publishedDetail(ref)
    check(ctx)
    if (draft.kind !== 'sql' && (!published.compound.canEditBasic ||
      (draft.kind === 'file-workspace' && !published.compound.canEditWorkspace))) {
      throw Error('此文件记录不可编辑，草稿已保留')
    }
    if (changed(draft, published)) throw Error('正式数据已被修改，草稿已保留；请核对最新数据后重新编辑，不能直接覆盖')
    if (published.compound.is_delete || published.compound.is_in_trash) throw Error('记录已删除或移入回收站，草稿已保留')
    let result: any
    if (draft.kind === 'sql') {
      const { saveCompoundDetails } = await import('./compoundDetails')
      result = await withDatabase(ref.connectionId, true, () => { check(ctx); return saveCompoundDetails({ ...draft.payload, publicationId: draft.operationId }) })
      if (!result.success) throw Error(result.error || '发布失败，草稿已保留')
    } else if (draft.kind === 'file-basic') {
      result = await publishRequest('POST', '/admin/file-sources/update-compound', { libraryId: ref.connectionId, id: Number(ref.key), revision: revision(published), compound: draft.payload.compound }, draft.operationId)
    } else {
      result = await publishRequest('POST', '/admin/file-sources/mutate', { libraryId: ref.connectionId, id: Number(ref.key), revision: revision(published), action: 'update', record: draft.payload.record }, draft.operationId)
    }
    drafts().remove(ctx.owner, ctx.target, ref.key)
    return { ...result, success: true }
  })
}
