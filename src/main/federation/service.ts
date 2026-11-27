import { stageChange, listPendingChanges, inspectPendingChange, exportPendingChange, publishPendingChange, discardPendingChange } from '../services/pendingChanges'
import { draftView, saveFileDraft, listEditDrafts, publishEditDraft, discardEditDraft, readRecovery, writeRecovery, clearRecovery, inspectEditDraft, exportEditDraft } from '../services/editDrafts'
import { workspaceEntries, workspaceLibraryKey } from '../../shared/adminWorkspace.mjs'
import { adminWorkspace } from '../services/adminWorkspace'
import {MAJOR_GROUPS,majorGroupKey} from '../../shared/majorGroups.mjs'
import {remainderKey,remainderLabel} from '../../shared/categoryNavigation.mjs'
import {fileRecordGroup,needsFileDiscovery} from '../../shared/fileRecordTransfer'
import { fileConnections, filePage, fileDetail, isFileRef, fileFavoriteKeys, isFileFavorite } from '../services/fileLibrary'
import { normalizeAcquisition } from '../../shared/acquisitionParameters.mjs'
import { auditDetail } from '../audit/service'
import { ready as auditReady } from '../audit/repository'
import { catalogList, indexed, memberRows, toggleRootFavorite } from '../audit/catalog'
import { exportReport, exportCheckReport } from '../audit/export'
import { classificationRequest, fileLibraryRequest, administratorLoggedIn, loadAdminWorkspace } from '../delivery'
import { categoryKey, categoryViewNode, classificationMembership, displayLibrary } from '../../shared/classification.mjs'
import { buildCategoryTree } from '../../shared/taxonomy'
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IpcMain } from 'electron'
import { writeFileSync } from 'fs'
import { randomUUID, createHash } from 'crypto'
import {
  connections,
  workspaceConnections,
  connection,
  getState,
  saveConnection,
  removeConnection,
  setConnectionLinked,
  setLocalFavorite,
  saveGroup,
  query,
  removeGroup,
  credentials,
  registryCategoryId
} from './registry'
import {
  inspect,
  count,
  rows,
  detail,
  sources,
  forgetColumns
} from './adapters'
import { pageWindow, refKey, type UnifiedFilters, type RecordRef } from '../../shared/federation'
import { withDatabase, resetDatabaseClient } from '../database'
import { initializeDatabase } from '../databaseInitialization'
import { validateDatabaseTarget } from '../../shared/databaseTarget'
import { upgradeDatabase } from './upgrade'
import {
  encodePackage,
  validateGroup,
  contentHash,
  type CompoundGroup
} from '../../shared/dataPackage'
function active(filters: UnifiedFilters = {}): any[] {
  return workspaceConnections(filters.connectionIds).filter(
    (x) => x.enabled && (!filters.connectionIds?.length || filters.connectionIds.includes(x.id))
  )
}
function summary(entry: any): any {
  const { encryptedPassword, ...safe } = entry
  const peers = connections().map(e => ({ title: e.name, database_name: e.database, file_name: e.sourceFileName }))
  const name = displayLibrary({ title: entry.name, database_name: entry.database, file_name: entry.sourceFileName }, peers)
  return { ...safe, name, hasPassword: !!encryptedPassword || entry.id === getState().primaryId }
}
function localSelection(filters: UnifiedFilters): string | undefined {
  const key = Object.entries(getState().categoryIds || {}).find(([, id]) => id === Number(filters.classId))?.[0]
  if (!key) return undefined
  try { const value = JSON.parse(key); return value[0] === 'local-classification-v1' ? value[1] : undefined } catch { return undefined }
}
async function classificationFilters(filters: UnifiedFilters): Promise<Map<string, UnifiedFilters>> {
  const key = localSelection(filters), result = new Map<string, UnifiedFilters>()
  if (key === undefined) { for (const e of active(filters)) result.set(e.id, filters); return result }
  const response = await classificationRequest('POST', '/admin/classification/plans', { key, databases: active(filters).map(e => e.database) })
  for (const e of active(filters)) {
    const plan = response.plans.find((p: any) => p.database === e.database)
    if (!plan) throw new Error('此数据库未登记到服务器分类管理，请先完成数据库登记')
    result.set(e.id, { ...filters, classId: undefined, classificationPlan: plan })
  }
  return result
}
async function sqlFederatedList(filters: UnifiedFilters = {}): Promise<any> {
  const perEntry = await classificationFilters(filters)
  if (Number(filters.classId || 0) < 1000000000 && filters.unifiedView !== false && auditReady() && (await indexed(active(filters))))
    return catalogList(filters)
  if (filters.dataTypes?.length || filters.auditState)
    throw new Error('自动检查索引尚未就绪，请先完成数据库检查')
  const entries = active(filters),
    warnings: any[] = [],
    counts: number[] = []
  for (const entry of entries) {
    try {
      await inspect(entry)
      counts.push(await count(entry, perEntry.get(entry.id)!))
    } catch {
      counts.push(0)
      warnings.push({
        connectionId: entry.id,
        name: entry.name,
        message: '连接失败、结构不匹配或不支持当前筛选；请到数据库管理查看测试结果'
      })
    }
  }
  if(filters.countOnly)return{list:[],total:counts.reduce((a,b)=>a+b,0),page:filters.page??1,pageSize:filters.pageSize??50,warnings,complete:!warnings.length}
  const list: any[] = []
  for (const window of pageWindow(
    counts,
    Number(filters.page ?? 1),
    Number(filters.pageSize ?? 50)
  )) {
    const entry = entries[window.index]
    try {
      list.push(...(await rows(entry, perEntry.get(entry.id)!, window.offset, window.limit)))
    } catch {
      warnings.push({
        connectionId: entry.id,
        name: entry.name,
        message: '读取失败，请重新查询；本次结果不完整'
      })
    }
  }
  return {
    list,
    total: counts.reduce((a, b) => a + b, 0),
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? 50,
    warnings,
    complete: !warnings.length
  }
}
function fileFavorites(libraryId: string): Set<string> {
  const favorites = new Set<string>()
  for (const key of getState().favorites) {
    try {
      const [id, recordId] = JSON.parse(key)
      if (id === libraryId && Number.isSafeInteger(Number(recordId)) && Number(recordId) > 0) favorites.add(String(recordId))
    } catch { /* Ignore invalid legacy keys. */ }
  }
  return favorites
}
export async function federatedList(filters: UnifiedFilters = {}): Promise<any> {
  let files: any[] = [], discoveryWarning: any[] = []
  if (administratorLoggedIn()) {
    try {
      files = (await fileConnections()).filter(f => !filters.connectionIds?.length || filters.connectionIds.includes(f.id))
      const settings = adminWorkspace()
      if (settings) {
        const keys = new Set([...workspaceConnections(), ...files].map(workspaceLibraryKey))
        for (const key of settings.libraries) {
          const relevant = !filters.connectionIds?.length || filters.connectionIds.includes(key)
          if (relevant && !keys.has(key)) discoveryWarning.push({
            connectionId: key, name: '正式库', message: '服务器登记缺失，统计不完整'
          })
        }
      }
    }
    catch(e) { discoveryWarning = [{ connectionId:'file-sources',name:'文件数据源',message:String(e) }] }
  }
  const nativeIds = filters.connectionIds?.filter(id => !id.startsWith('file:'))
  const nativeEnabled = !filters.connectionIds?.length || !!nativeIds?.length
  if (!files.length && nativeEnabled) { const result=await sqlFederatedList(filters);result.warnings.push(...discoveryWarning);result.complete=result.complete&&!discoveryWarning.length;return result }
  let native:any={list:[],total:0,warnings:[],complete:true}
  if(nativeEnabled){try{native=await sqlFederatedList({...filters,connectionIds:nativeIds,page:1,pageSize:1,countOnly:true})}catch(e){native={list:[],total:0,warnings:[{connectionId:'sql',name:'数据库连接',message:String(e)}],complete:false}}}
  const warnings=[...native.warnings,...discoveryWarning],counts=[native.total],inputs:any[]=[],totalPages:any[]=[]
  const categoryKey = localSelection(filters)
  await Promise.all(files.map(async(file,index) => {
    const favoriteIds=Array.from(fileFavorites(file.id).keys(), Number)
    const group=filters.classId && filters.classId<1000000000 ? getState().groups.find(g=>g.id===filters.classId) : null
    const groupIds=group?.refs.flatMap(key=>{const [id,keyValue]=JSON.parse(key);return id===file.id?[Number(keyValue)]:[]})
    const ids=filters.favoriteOnly?favoriteIds:groupIds
    const input:any={keyword:filters.keyword,trash:filters.trashOnly,page:1,categoryKey,identityStatus:filters.identityStatus,polarity:filters.polarity,adduct:filters.adduct,spectrumKind:filters.spectrumKind,dataTypes:filters.dataTypes,auditState:filters.auditState,sourceQuery:filters.sourceQuery,sourceIds:filters.sourceIds,...(ids?.length?{onlySelected:true,compoundIds:ids}:{})}
    try {
      if(ids && !ids.length){counts[index+1]=0;totalPages[index]=null;inputs[index]=input;return}
      if(file.status!=='ready')throw Error(file.issue||'数据源不可用')
      const result=await filePage(file.id,{...input,countOnly:true});inputs[index]={...input,revision:result.revision};counts[index+1]=result.total;totalPages[index]=result
    }catch(e){counts[index+1]=0;totalPages[index]=null;warnings.push({connectionId:file.id,name:file.name,message:String(e)})}
    inputs[index]??=input
  }))
  if(filters.countOnly)return{list:[],total:counts.reduce((a,b)=>a+b,0),warnings,complete:!warnings.length,page:filters.page||1,pageSize:filters.pageSize||50,countBasis:'来源记录'}
  const list:any[]=[]
  for(const window of pageWindow(counts,Number(filters.page||1),Number(filters.pageSize||50))) {
    if(window.index===0) {const result=await sqlFederatedList({...filters,connectionIds:nativeIds,page:filters.page||1,pageSize:filters.pageSize||50});list.push(...result.list.slice(0,window.limit));continue}
    const index=window.index-1,file=files[index],first=Math.floor(window.offset/50)+1,last=Math.floor((window.offset+window.limit-1)/50)+1,buffer:any[]=[]
    for(let page=first;page<=last;page++){const result=await filePage(file.id,{...inputs[index],page});buffer.push(...result.rows)}
    const favorites = fileFavorites(file.id)
    list.push(...buffer.slice(window.offset%50,window.offset%50+window.limit).map(row=>({...row,ref:{connectionId:file.id,key:String(row.id)},rowKey:JSON.stringify([file.id,row.id]),connectionName:file.name,is_favorite:favorites.has(String(row.id)),readOnly:true,canDelete:!file.readOnly,sources:[{name:file.name}],sourceCount:1})))
  }
  return{list,total:counts.reduce((a,b)=>a+b,0),warnings,complete:!warnings.length,page:filters.page||1,pageSize:filters.pageSize||50,countBasis:'来源记录'}
}
export async function sourceOptions(text: string, offset = 0): Promise<any> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 9960)
    throw new Error('来源候选超过分页范围，请输入更具体的名称')
  const found: any[] = []
  const warnings: string[] = []
  for (const entry of active()) {
    try {
      await inspect(entry)
      found.push(...(await sources(entry, { text, limit: offset + 31 })))
    } catch {
      warnings.push(entry.name)
    }
  }
  const unique = [...new Map(found.map((x) => [x.id, { ...x, localKey: undefined }])).values()]
  const q = text.trim().toLocaleLowerCase()
  const matching = unique
    .filter((x) => !q || x.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => {
      const score = (x: any): number =>
        x.name.toLocaleLowerCase() === q ? 0 : x.name.toLocaleLowerCase().startsWith(q) ? 1 : 2
      return (
        score(a) - score(b) ||
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) ||
        a.id.localeCompare(b.id)
      )
    })
  return {
    list: matching.slice(offset, offset + 30),
    hasMore: offset + 30 < matching.length,
    warnings
  }
}
function unpackJson(value: any): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}
export async function exportFederated(info: any): Promise<any> {
  if (!info.selectionOnly && needsFileDiscovery(info.filters?.connectionIds,administratorLoggedIn()) && (await fileConnections()).some(f => !info.filters?.connectionIds?.length || info.filters.connectionIds.includes(f.id))) {
    const refs: RecordRef[]=[]
    for(let page=1;;page++){const result=await federatedList({...info.filters,page,pageSize:200});if(!result.complete)throw Error('查询不完整，请恢复连接或缩小范围后导出');if(result.total>10000)throw Error('最多导出10000条，请缩小范围');refs.push(...result.list.map(r=>r.ref));if(refs.length>=result.total)break}
    return exportFederated({...info,selectionOnly:true,refs})
  }
  if (info.format && info.format !== 'msldata') {
    if (!info.selectionOnly && Number(info.filters?.classId || 0) >= 1000000000) {
      const refs: RecordRef[] = []
      for (let page = 1; ; page++) {
        const result = await federatedList({ ...info.filters, page, pageSize: 200 })
        if (!result.complete) throw new Error('分类结果读取不完整，请恢复连接后再导出')
        if (result.total > 10000) throw new Error('最多导出10000条，请缩小筛选范围')
        refs.push(...result.list.map((r: any) => r.ref))
        if (refs.length >= result.total) break
      }
      if (!refs.length) throw new Error('当前分类没有可导出的记录')
      return exportReport({ ...info, selectionOnly: true, refs })
    }
    return exportReport(info)
  }
  const refs: RecordRef[] = []
  if (info.selectionOnly)
    for (const ref of info.refs ?? []) {
      if (ref.connectionId === '@unified')
        for (const m of await memberRows(ref.key, info.filters))
          refs.push({ connectionId: m.connection_id, key: m.record_key })
      else refs.push(ref)
    }
  if (info.selectionOnly && !refs.length) throw new Error('请先勾选需要导出的记录')
  if (!info.selectionOnly && Number(info.filters?.classId || 0) < 1000000000 && auditReady() && (await indexed(active(info.filters)))) {
    let seen = 0
    for (let page = 1; ; page++) {
      const result = await catalogList({ ...info.filters, page, pageSize: 200 })
      if (!result.complete) throw new Error('来源索引不是最新或读取失败，请先完成检查后导出')
      if (result.total > 10000) throw new Error('最多导出10000条，请缩小筛选范围')
      for (const record of result.list)
        for (const member of await memberRows(record.ref.key, info.filters))
          refs.push({ connectionId: member.connection_id, key: member.record_key })
      seen += result.list.length
      if (seen >= result.total) break
    }
  } else if(!info.selectionOnly&&needsFileDiscovery(info.filters?.connectionIds,administratorLoggedIn())&&(await fileConnections()).some(e=>!info.filters?.connectionIds?.length||info.filters.connectionIds.includes(e.id))){for(let page=1;;page++){const result=await federatedList({...info.filters,page,pageSize:200});if(!result.complete)throw Error('数据源读取不完整');if(result.total>10000)throw Error('当前导出上限10000条，请缩小范围');refs.push(...result.list.map((r:any)=>r.ref));if(refs.length>=result.total)break}} else if (!info.selectionOnly) {
    if (info.filters?.dataTypes?.length || info.filters?.auditState)
      throw new Error('请先完成自动检查索引后再按数据类型导出')
    const entries = active(info.filters)
    const perEntry = await classificationFilters(info.filters || {})
    for (const entry of entries) {
      await inspect(entry)
      const total = await count(entry, perEntry.get(entry.id)!)
      if (total > 10000 || refs.length + total > 10000)
        throw new Error('当前导出上限10000条，请通过筛选分包')
      for (let offset = 0; offset < total; offset += 200)
        refs.push(...(await rows(entry, perEntry.get(entry.id)!, offset, 200)).map((x) => x.ref))
    }
  }
  if (refs.length > 10000) throw new Error('展开来源记录超过10000条，请缩小筛选范围')
  const groups: CompoundGroup[] = []
  const warnings: string[] = []
  for (const ref of refs) {
    if(isFileRef(ref)) {
      const data=await fileDetail(ref,true),record=data.extensions.fileRecord
      groups.push(fileRecordGroup(record,ref,data.extensions.classifications))
      continue
    }
    const data = await detail(ref),
      entry = connection(ref.connectionId)
    const omit = (value: any, keys: string[]): any =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
    const compound = omit(data.compound, [
      'id',
      'ref',
      'rowKey',
      'connectionName',
      'readOnly',
      'schemaVersion',
      'is_favorite',
      'is_delete',
      'is_in_trash',
      'sources'
    ])
    const methods = data.methods
      .flatMap((x) => x.methods)
      .map((m) => ({
        ...omit(m, ['id', 'compounds_id', 'create_time', 'update_time']),
        conditions: normalizeAcquisition(m),
        localId: String(m.id)
      }))
    const lcMethods = data.lcMethods.map((m) => ({
      ...omit(m, ['id', 'compounds_id', 'create_time', 'update_time', 'methodsLinks']),
      localId: String(m.id),
      items: m.methodsLinks.map((step) =>
        omit(step, ['id', 'lc_methods_id', 'create_time', 'update_time'])
      )
    }))
    const spectra = data.extensions.spectra.map((s) => ({
      ...omit(s, ['id', 'compound_id', 'created_at', 'updated_at', 'methodIds']),
      localId: String(s.id),
      methodLocalIds: s.methodIds.map(String)
    }))
    const profiles = data.extensions.profiles.map((p) => ({
      ...omit(p, ['id', 'compound_id', 'created_at', 'updated_at']),
      localId: String(p.id)
    }))
    const table = entry.adapter === 'mapped' ? entry.mapping!.table : 'compounds',
      key = entry.adapter === 'mapped' ? entry.mapping!.key : 'id'
    const original = (
      await query(entry, `SELECT * FROM \`${table}\` WHERE \`${key}\`=?`, [ref.key])
    )[0]
    groups.push({
      source: {
        namespace: 'database-record:' + entry.id,
        key: ref.key,
        name: '数据库记录交换（原始来源见来源证据）',
        sourceType: 'unknown'
      },
      raw: {
        connection: { name: entry.name, database: entry.database, adapter: entry.adapter },
        original: original ?? null,
        provenance: data.extensions.sources
      },
      compound: {
        ...compound,
        ...(entry.adapter !== 'mapped'
          ? { formula_diagram_base64: original?.formula_diagram_base64 }
          : {}),
        name: unpackJson(compound.name)
      },
      classifications: data.extensions.classifications ?? [],
      methods,
      lcMethods,
      spectra,
      profiles,
      classes: data.classes.map((x) => ({ class_name: x.class_name, is_custom: x.is_custom })),
      provenance: data.extensions.sources
    })
    if (entry.adapter === 'mapped')
      warnings.push('基础映射适配只导出已映射字段和原始行；未配置的关系数据不在当前适配能力内')
  }
  const bytes = encodePackage({
    formatVersion: 2,
    schemaVersion: 2,
    packageId: randomUUID(),
    mappingVersion: 'federated-2.1',
    taxonomyCatalog: [
      ...new Map(
        (await Promise.all(refs.map((ref) => isFileRef(ref) ? fileDetail(ref) : detail(ref))))
          .flatMap((x) => x.extensions.taxonomyCatalog ?? [])
          .map((x) => [JSON.stringify([x.namespace, x.category_code]), x])
      ).values()
    ],
    groups
  })
  if (bytes.length > 64 * 1024 * 1024) throw new Error('数据包超过64MiB，请缩小范围分包')
  writeFileSync(info.filePath, bytes)
  const report = {
    exported: groups.length,
    connections: [...new Set(refs.map((x) => x.connectionId))].map((id) => ({
      id,
      name: id.startsWith('file:') ? '文件数据库' : connection(id).name,
      database: id.startsWith('file:') ? id : connection(id).database
    })),
    recordedAt: new Date().toISOString(),
    snapshot: '跨库逐记录读取，不保证全局同一时刻快照',
    warnings: [...new Set(warnings)],
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
  writeFileSync(info.filePath + '.report.json', JSON.stringify(report, null, 2))
  return {
    success: true,
    message: `已导出 ${groups.length} 条记录；来源证据及导出报告已保存`,
    report
  }
}
export async function createRecord(input: any): Promise<any> {
  if(String(input.connectionId).startsWith('file:')){const file=(await fileConnections()).find(e=>e.id===input.connectionId);if(!file?.canEditWorkspace)throw Error('此库不支持新增工作区记录');const current=await filePage(file.id,{});const result=await fileLibraryRequest('POST','/admin/file-sources/mutate',{libraryId:file.id,revision:current.revision,action:'create',record:{compound:input.compound,sources:[input.source||{name:'管理员新增'}]}});return{success:true,ref:{connectionId:file.id,key:String(result.ids[0])}}}
  return withDatabase(input.connectionId, true, async () => {
    const { prisma } = await import('../database'),
      now = new Date()
    const fields = ['main_name', 'name_zh', 'name_en', 'cas', 'formula']
    const compound = Object.fromEntries(
      fields
        .filter((key) => input.compound?.[key]?.trim())
        .map((key) => [key, input.compound[key].trim()])
    )
    const sourceInput = input.source ?? {},
      namespace =
        sourceInput.namespace ||
        'manual-source:' +
          contentHash([
            sourceInput.name ?? null,
            sourceInput.source_type ?? 'local',
            sourceInput.provider ?? null,
            sourceInput.location ?? null
          ]).slice(0, 40),
      sourceKeyValue = randomUUID()
    const group: CompoundGroup = {
      source: {
        namespace,
        key: sourceKeyValue,
        name: sourceInput.name || '人工录入',
        sourceType: sourceInput.source_type ?? 'local',
        provider: sourceInput.provider || undefined,
        location: sourceInput.location || undefined
      },
      compound
    }
    validateGroup(group)
    return prisma.$transaction(async (tx) => {
      const record = await tx.compounds.create({
        data: {
          ...compound,
          name: [],
          is_delete: false,
          is_in_trash: false,
          is_favorite: false,
          create_time: now,
          update_time: now
        }
      })
      if (sourceInput.name?.trim()) {
        const library = await tx.spectral_libraries.upsert({
          where: { namespace },
          update: {},
          create: {
            namespace,
            name: sourceInput.name.trim(),
            source_type: group.source.sourceType,
            provider: group.source.provider,
            location: group.source.location
          }
        })
        const batch = await tx.import_batches.create({
          data: {
            package_id: 'manual:' + sourceKeyValue,
            content_hash: contentHash(group),
            mapping_version: 'manual-2.1',
            status: 'completed'
          }
        })
        const evidence = await tx.source_records.create({
          data: {
            library_id: library.id,
            source_key: sourceKeyValue,
            content_hash: contentHash(group),
            raw: group as any,
            decision: 'created',
            batch_id: batch.id
          }
        })
        await tx.entity_sources.create({
          data: { source_record_id: evidence.id, entity_type: 'compound', entity_id: record.id }
        })
      }
      return { success: true, ref: { connectionId: input.connectionId, key: String(record.id) } }
    })
  })
}
export function registerFederationIPC(ipcMain: IpcMain): void {
  ipcMain.handle('pending-changes:list', () => listPendingChanges())
  ipcMain.handle('pending-changes:inspect', (_, id) => inspectPendingChange(id))
  ipcMain.handle('pending-changes:publish', (_, id) => publishPendingChange(id))
  ipcMain.handle('pending-changes:discard', (_, id) => discardPendingChange(id))
  ipcMain.handle('pending-changes:export', (_, id) => exportPendingChange(id))
  ipcMain.handle('edit-recovery:read', (_, ref) => readRecovery(ref))
  ipcMain.handle('edit-recovery:write', (_, ref, value) => writeRecovery(ref, value))
  ipcMain.handle('edit-recovery:clear', (_, ref) => clearRecovery(ref))
  ipcMain.handle('edit-drafts:inspect', (_, ref) => inspectEditDraft(ref))
  ipcMain.handle('edit-drafts:export', (_, ref) => exportEditDraft(ref))
  ipcMain.handle('edit-drafts:list', () => listEditDrafts())
  ipcMain.handle('edit-drafts:publish', (_, ref) => publishEditDraft(ref))
  ipcMain.handle('edit-drafts:discard', (_, ref) => discardEditDraft(ref))
  ipcMain.handle('audit:export', (_, info) => exportCheckReport(info))
  ipcMain.handle('federation:create', (_, input) => createRecord(input))
  ipcMain.handle('admin:workspace', async () => {
    const settings = await loadAdminWorkspace()
    if (!settings.defaultLibrary) return settings
    const nativeEntries = workspaceConnections()
    const candidates = await Promise.all(nativeEntries.map(async entry => {
      try { const status = await inspect(entry); return status.ok ? entry : null } catch { return null }
    }))
    let files: any[] = []
    try { files = (await fileConnections()).filter(entry => entry.status === 'ready' && entry.enabled) } catch { /* Show available SQL libraries if file discovery fails. */ }
    const available = [...candidates.filter((entry): entry is NonNullable<typeof entry> => !!entry), ...files]
    const chosen = available.find(entry => workspaceLibraryKey(entry) === settings.defaultLibrary) || available[0]
    return { ...settings, defaultConnectionId: chosen?.id,
      ...(chosen && workspaceLibraryKey(chosen) !== settings.defaultLibrary
        ? { workspaceWarning: '原默认库暂不可用，已进入可用正式库' } : {}) }

  })
  ipcMain.handle('connections:list', async (_, workspaceOnly = false, includeLocal = false) => {
    const settings = administratorLoggedIn() && adminWorkspace() ? await loadAdminWorkspace() : adminWorkspace()
    const localIds = includeLocal && settings ? connections().filter(e => !e.serverManaged).map(e => e.id) : []
    const native = workspaceOnly ? workspaceConnections(localIds) : getState().connections
    const entries = await Promise.all(native.map(async e => {
      const key = workspaceLibraryKey(e)
      const published = settings && key ? settings.libraries.includes(key) : undefined
      const detached = !published && (getState().disconnectedIds || []).includes(e.id)
      let compoundCount: number | null = null
      let issue: string | undefined
      if (e.enabled && !detached) {
        try { compoundCount = await count(e, {}) }
        catch { issue = '数据库暂不可用，请测试连接' }
      }
      return { ...summary(e), ...(published ? { name: e.name } : {}), compoundCount, location: e.database,
        enabled: e.enabled && !detached && !issue, detached, issue, published,
        removed: !!(key && settings?.removedLibraries?.includes(key)) }
    }))
    if (!administratorLoggedIn()) return entries
    if (workspaceOnly) {
      const list = [...entries, ...await fileConnections()]
      return settings ? [...workspaceEntries(settings, list), ...entries.filter(e => localIds.includes(e.id))] : list
    }
    const files = (await fileConnections(true)).map(entry => ({
      ...entry,
      published: settings ? settings.libraries.includes(entry.id) : undefined,
      removed: !!settings?.removedLibraries?.includes(entry.id)
    }))
    return [...entries, ...files]
  })
  ipcMain.handle('connections:set-writable', async (_, input) => {
    const entry = connection(String(input?.id || ''))
    if (entry.serverManaged || entry.adapter !== 'native' || typeof input.writable !== 'boolean')
      throw Error('此连接不支持调整读写权限')
    await saveConnection({ ...entry, writable: input.writable })
    forgetColumns(entry.id)
    await resetDatabaseClient(entry.id)
    return { success: true }
  })
  ipcMain.handle('connections:save', async (_, input) => {
    if (administratorLoggedIn() && !input?.id) throw Error('请通过数据库管理上传服务器文件库')
    await saveConnection(input)
    if (input.id) {
      forgetColumns(input.id)
      await resetDatabaseClient(input.id)
    }
    return { success: true }
  })
  ipcMain.handle('connections:remove', async (_, id) => {
    if(String(id).startsWith('file:')){if(!(await fileConnections(true)).some(e=>e.id===id))throw Error('文件库不存在');setConnectionLinked(id,false);return{success:true}}
    await removeConnection(id)
    forgetColumns(id)
    await resetDatabaseClient(id)
    return { success: true }
  })
  ipcMain.handle('connections:restore',async(_,id)=>{setConnectionLinked(id,true);return{success:true}})
  ipcMain.handle('connections:delete-server',async(_,input)=>{
    const id=String(input?.id||'');const libraryId=id.startsWith('file:')?id:connection(id).sourceLibraryId;
    if(!libraryId)throw Error('仅支持服务器登记的数据源');
    const result=await fileLibraryRequest('POST','/admin/file-sources/delete-database',{libraryId,password:input.password});setConnectionLinked(id,false);return result
  })
  ipcMain.handle('connections:test', async (_, id) => {
    try {
      if(String(id).startsWith('file:')){const entry=(await fileConnections(true)).find(e=>e.id===id);if(!entry)throw Error('服务器文件库未登记');if(entry.status!=='ready')throw Error(entry.issue||'服务器数据源不可用');await filePage(id,{page:1});return{ok:true,capabilities:['服务器SQLite文件库','基础信息','质谱方法','液相方法'],notice:'服务器路径：'+entry.location}}
      return await inspect(connection(id))
    } catch (error) {
      return { ok: false, message: String(error).replace(/password[^\s]*/gi, '凭据信息已隐藏') }
    }
  })
  ipcMain.handle('connections:initialize', async (_, id, path) => {
    const entry = connection(id)
    if (!entry.enabled || entry.adapter !== 'native' || !entry.writable)
      throw new Error('仅允许初始化启用且可写的新库连接')
    validateDatabaseTarget(entry.database)
    const result = await initializeDatabase(path, {
      config: await credentials(entry),
      configPath: '连接：' + entry.name
    })
    forgetColumns(id)
    await resetDatabaseClient(id)
    return result
  })
  ipcMain.handle('connections:upgrade', async (_, id) => {
    await upgradeDatabase(id)
    forgetColumns(id)
    await resetDatabaseClient(id)
    return { success: true }
  })
  ipcMain.handle('classification:assign', async (_, input) => {
    if (!Array.isArray(input?.refs) || !input.refs.length || input.refs.length > 500) throw new Error('每次请选择1–500条结果')
    if(input.refs.some((ref:any)=>isFileRef(ref))){if(input.refs.some((ref:any)=>!isFileRef(ref)))throw Error('请分别选择文件库和SQL库归类');let affected=0;for(const id of new Set<string>(input.refs.map((r:any)=>r.connectionId))){const current=await filePage(id,{});const result=await fileLibraryRequest('POST','/admin/file-sources/mutate',{libraryId:id,revision:current.revision,action:'assign',ids:input.refs.filter((r:any)=>r.connectionId===id).map((r:any)=>Number(r.key)),categories:input.categories,mode:input.mode});affected+=result.changed}return{affected}}
    const records = new Map<string, {database: string; id: string}>()
    for (const ref of input.refs) {
      const members = ref.connectionId === '@unified' ? (await memberRows(ref.key, input.scope || {})).map(m => ({ connectionId: m.connection_id, key: m.record_key })) : [ref]
      for (const member of members) { const entry = connection(member.connectionId); records.set(refKey(member), { database: entry.database, id: member.key }) }
    }
    if (!records.size || records.size > 500) throw new Error('展开后来源记录须为1–500条，请缩小勾选范围')
    const result = await classificationRequest('POST', input.mode === 'unlock' ? '/admin/classification/unlock' : '/admin/classification/assign', { records: [...records.values()], categories: input.categories, mode: input.mode })
    return { ...result, affected: records.size }
  })
  ipcMain.handle('federation:list', (_, filters) => federatedList(filters))
  ipcMain.handle('federation:detail', async (_, ref, scope) => {
    if(isFileRef(ref)){const data=await fileDetail(ref);return scope?.publishedOnly ? data : draftView(ref,data)}
    const data = await auditDetail(ref, scope)
    if (!administratorLoggedIn()) return data
    const state = await classificationRequest('GET', '/admin/classification/state')
    const members = ref.connectionId === '@unified' ? (await memberRows(ref.key, scope || {})).map(m => ({ connectionId: m.connection_id, key: m.record_key })) : [ref]
    const items = new Map<string, any>(); let pending = 0
    for (const member of members) {
      const entry = connection(member.connectionId), library = state.libraries.find((l: any) => l.database_name === entry.database)
      if (!library) throw new Error('当前来源记录尚未登记到分类管理')
      const bindings = await query(entry, 'SELECT category_id FROM compound_taxonomy WHERE compound_id=?', [member.key])
      const ids = new Set(bindings.map(b => String(b.category_id)))
      const keys = library.categories.filter((c: any) => ids.has(String(c.id))).map(categoryKey)
      const assigned = classificationMembership(state, library, keys, member.key)
      if (!assigned.length) pending++
      for (const item of assigned) {
        const key = categoryKey(item), previous = items.get(key) || { ...item, evidence: [] }
        previous.evidence.push(...item.evidence.map((e: any) => ({ ...e, record: member }))); items.set(key, previous)
      }
    }
    data.extensions.localClassification = { items: [...items.values()], catalog: state.catalog, pendingRecords: pending, checkedRecords: members.length }
    const concreteRef = data.compound.ref || ref
    return scope?.publishedOnly || concreteRef.connectionId === '@unified' ? data : draftView(concreteRef, data)
  })
  ipcMain.handle('federation:sources', (_, text, offset) => sourceOptions(text, offset))
  ipcMain.handle('federation:favorite', async (_, ref: RecordRef, value?: boolean) => {
    if (isFileRef(ref)) {
      const [key, legacyKey] = fileFavoriteKeys(ref)
      const favorite = setLocalFavorite(key, value ?? !isFileFavorite(ref), [legacyKey])
      return { success:true, is_favorite:favorite }
    }
    if (ref.connectionId === '@unified') {
      const favorite = await toggleRootFavorite(ref.key, value ?? !(await auditDetail(ref)).compound.is_favorite)
      return { success:true, is_favorite:favorite }
    }
    const favorite = setLocalFavorite(refKey(ref), value ?? !(await detail(ref)).compound.is_favorite)
    return { success:true, is_favorite:favorite }
  })
  ipcMain.handle('federation:categories', async (_event, scope?: { databaseIds?: string[] }) => {
    // Classification configuration is explicit server metadata; native source categories are read-only.
    const selected = scope?.databaseIds?.length ? new Set(scope.databaseIds) : null
    const entries = active().filter(e => !selected || selected.has(e.id))
    const files=(await fileConnections()).filter(e=>!selected||selected.has(e.id))
    const taxonomyResults=await Promise.allSettled(files.map(f=>fileLibraryRequest('POST','/admin/file-sources/categories',{libraryId:f.id,sourceTaxonomy:selected?.size === 1})))
    const fileTaxonomies:any[]=[],taxonomyIssues:string[]=[]
    taxonomyResults.forEach((result,i)=>{if(result.status==='fulfilled')fileTaxonomies.push(result.value);else taxonomyIssues.push(files[i].name+'：'+String(result.reason))})
    if(selected&&taxonomyIssues.length&&fileTaxonomies.length===0&&entries.length===0)throw Error(taxonomyIssues.join('；'))
    const counted=entries.length?await classificationRequest('POST','/admin/classification/counts',{databases:entries.map(e=>e.database)}):{libraries:[],catalog:[]}
    const state=counted
    const catalog=new Map<string,any>(state.catalog.map((c:any)=>[categoryKey(c),c]))
    for(const file of fileTaxonomies)for(const c of file.catalog){const key=categoryKey(c),prior=catalog.get(key);if(prior&&(prior.category_name!==c.category_name||prior.parent_code!==c.parent_code))throw Error('分类字典版本冲突，请核对数据源');catalog.set(key,c)}
    const locals=buildCategoryTree([...catalog.values()], key=>{const [,ns,code]=JSON.parse(key);return registryCategoryId(categoryViewNode(JSON.stringify([ns,code])))})
    const addLocalCounts = async (nodes: any[]): Promise<void> => {
      for (const node of nodes) {
        if (node.id) {
          const [, ns, code] = JSON.parse(node.key), key = JSON.stringify([ns, code]); let total = 0
          total += counted.libraries.reduce((n:number,l:any)=>n+(l.counts[key]||0),0)
          total += fileTaxonomies.reduce((n:number,f:any)=>n+(f.counts[key]||0),0)
          node.count = total; node.label += ' (' + total + ')'
        }
        await addLocalCounts(node.children)
      }
    }
    await addLocalCounts(locals)
    for(const major of locals){const [,,code]=JSON.parse(major.key);const total=counted.libraries.reduce((n:number,l:any)=>n+(l.remainders?.[code]||0),0)+fileTaxonomies.reduce((n:number,f:any)=>n+(f.remainders?.[code]||0),0);if(total>0){const key=remainderKey(code);major.children.push({key,id:registryCategoryId(categoryViewNode(key)),label:remainderLabel(code)+' ('+total+')',count:total,children:[]})}}
    let pending = fileTaxonomies.reduce((n:number,f:any)=>n+f.pending,0)
    pending += counted.libraries.reduce((n:number,l:any)=>n+l.pending,0)
    if(pending>0)locals.push({ key: 'local-pending', label: '未分类 (' + pending + ')', id: registryCategoryId(categoryViewNode('@pending')), children: [], count: pending })
    if(taxonomyIssues.length)locals.push({key:'classification-incomplete',label:'部分数据库分类未加载：'+taxonomyIssues.join('；'),children:[],disabled:true} as any)
    for(const group of MAJOR_GROUPS){const members=locals.filter(n=>group.members.some(code=>n.key===JSON.stringify(['taxonomy-v1','unified-consolidated-v2',code])));if(!members.length)continue;const total=counted.libraries.reduce((n:number,l:any)=>n+(l.groupCounts?.[group.code]||0),0)+fileTaxonomies.reduce((n:number,f:any)=>n+(f.groupCounts?.[group.code]||0),0);const key=majorGroupKey(group.code);const node={key,label:group.name+' ('+total+')',id:registryCategoryId(categoryViewNode(key)),count:total,children:members.map(m=>({...m,children:[]}))};const at=Math.min(...members.map(m=>locals.indexOf(m)));for(const m of members)locals.splice(locals.indexOf(m),1);locals.splice(at,0,node)}
    for(const node of locals){if(node.key===JSON.stringify(['taxonomy-v1','unified-consolidated-v2','cosmetics']))node.label='化妆品类 ('+node.count+')';if(node.key===JSON.stringify(['taxonomy-v1','unified-consolidated-v2','environment']))node.label='环境类 ('+node.count+')'}
    return locals
  })
  ipcMain.handle('federation:groups', async (_, delivery = false) => {
    const unified = !delivery && auditReady() && (await indexed(active()))
    const groups: any[] = []
    for (const group of getState().groups)
      groups.push({
        id: group.id,
        class_name: group.name,
        is_custom: true,
        count: unified
          ? (await catalogList({ classId: group.id, pageSize: 1 })).total
          : group.refs.length
      })
    return groups
  })
  ipcMain.handle('federation:group-delivery-refs', (_, id: number) => {
    if (!administratorLoggedIn()) throw new Error('请先登录管理员')
    const group = getState().groups.find(item => item.id === id)
    if (!group) throw new Error('分组不存在')
    const serverLibraries = new Map(workspaceConnections().flatMap(item =>
      item.serverManaged && item.sourceLibraryId ? [[item.id, item.sourceLibraryId] as const] : []))
    return group.refs.map(key => {
      const [connectionId, compoundId] = JSON.parse(key)
      return {
        libraryId: typeof connectionId === 'string' && connectionId.startsWith('file:')
          ? connectionId : serverLibraries.get(connectionId),
        compoundId
      }
    })
  })
  ipcMain.handle('federation:group-save', async (_, input) => {
    const old = getState().groups.find((x) => x.id === input.id)
    const stable: RecordRef[] = []
    for (const ref of input.refs)
      if (ref.connectionId === '@unified')
        for (const member of await memberRows(ref.key))
          stable.push({ connectionId: member.connection_id, key: member.record_key })
      else stable.push(ref)
    const incoming = stable.map(refKey)
    return saveGroup(
      input.id,
      input.name,
      input.append && old ? [...old.refs, ...incoming] : incoming
    )
  })
  ipcMain.handle('federation:group-remove', (_, id) => {
    removeGroup(Number(id))
    return { success: true }
  })
  ipcMain.handle('federation:group-remove-records', async (_, input) => {
    const old = getState().groups.find((x) => x.id === Number(input.id))
    if (!old) throw new Error('分组不存在')
    const remove = input.refs.map(refKey)
    for (const ref of input.refs)
      if (ref.connectionId === '@unified')
        for (const member of await memberRows(ref.key))
          remove.push(refKey({ connectionId: member.connection_id, key: member.record_key }))
    return saveGroup(
      old.id,
      old.name,
      old.refs.filter((x) => !remove.includes(x))
    )
  })
  ipcMain.handle('federation:export', async (_, info) => {
    try {
      return await exportFederated(info)
    } catch (error) {
      return { success: false, message: String(error) }
    }
  })
  ipcMain.handle('file-library:import-preview', async (_, file: string) => {
    if (!administratorLoggedIn()) throw Error('请先登录管理员')
    const { packageData } = await import('../services/fileScopedIPC')
    const { data, hash } = packageData(file)
    if (!data.groups.length) throw Error('导入文件没有化合物记录')
    return { estimated:true, newCount:data.groups.length, hash }
  })
  ipcMain.handle('file-library:import-new', async (_, file:string, expectedHash:string, title:string, id:string) => {
    if (!administratorLoggedIn()) throw Error('请先登录管理员')
    const { decodeFileImport } = await import('../services/fileScopedIPC')
    const { records, hash } = decodeFileImport(file,expectedHash)
    return fileLibraryRequest('POST','/admin/file-sources/create-import',{id,title,hash,records})
  })
  ipcMain.handle('file-library:workspace-backup',async(_,id)=>{if(!administratorLoggedIn())throw Error('请先登录管理员');const {dialog}=await import('electron');const choice=await dialog.showSaveDialog({title:'备份服务器文件库的管理工作区（不含源文件）',defaultPath:'文件库工作区备份.json',filters:[{name:'工作区备份',extensions:['json']}]});if(choice.canceled||!choice.filePath)return{cancelled:true};const data=await fileLibraryRequest('POST','/admin/file-sources/backup',{libraryId:id});writeFileSync(choice.filePath,JSON.stringify(data));return{saved:true}})
  ipcMain.handle('file-library:workspace-restore',async(_,id)=>{if(!administratorLoggedIn())throw Error('请先登录管理员');const {dialog}=await import('electron');const choice=await dialog.showOpenDialog({title:'恢复服务器文件库的管理工作区',properties:['openFile'],filters:[{name:'工作区备份',extensions:['json']}]});if(choice.canceled||!choice.filePaths[0])return{cancelled:true};const {readFileSync}=await import('node:fs');const backup=JSON.parse(readFileSync(choice.filePaths[0],'utf8'));const current=await filePage(id,{});const decision=await dialog.showMessageBox({type:'warning',title:'确认恢复管理工作区',message:'是否用这份备份恢复文件库的管理改动？',buttons:['否','是'],defaultId:0,cancelId:0});if(decision.response!==1)return{cancelled:true};return stageChange('delivery:call',['POST','/admin/file-sources/restore',{libraryId:id,revision:current.revision,confirmation:true,backup}])})
  ipcMain.handle('file-library:workspace-save', (_, input) => saveFileDraft(input, 'file-workspace'))
  ipcMain.handle('file-library:update-compound', (_, input) => saveFileDraft(input, 'file-basic'))
  ipcMain.handle('federation:records-change', async (_, input) => {
    if(!administratorLoggedIn())throw Error('请先登录管理员')
    if(!['delete','restore','purge'].includes(input?.action)||!Array.isArray(input.refs)||!input.refs.length||input.refs.length>500)throw Error('每次请选择1–500条来源记录')
    const ids=new Set(input.refs.map((r:any)=>r.connectionId));if(ids.size!==1||input.refs.some((r:any)=>r.connectionId==='@unified'||!/^\d{1,20}$/.test(String(r.key))))throw Error('请先选择一个具体可写数据库，再删除其中的来源记录')
    const id=input.refs[0].connectionId,keys=[...new Set<number>(input.refs.map((r:any)=>Number(r.key)))]
    if(keys.some(key=>!Number.isSafeInteger(key)||key<1))throw Error('记录编号无效')
    if(id.startsWith('file:')){
      const current=await filePage(id,{page:1,trash:input.action!=='delete'})
      return fileLibraryRequest('POST','/admin/file-sources/change',{libraryId:id,revision:current.revision,ids:keys,action:input.action})
    }
    return withDatabase(id,true,async()=>{const {prisma}=await import('../database');return prisma.$transaction(async tx=>{
      const found=await tx.compounds.findMany({where:{id:{in:keys},is_delete:false}})
      if(found.length!==keys.length||found.some(r=>r.is_in_trash!==(input.action!=='delete')))throw Error('记录状态已变化，请刷新')
      await tx.compounds.updateMany({where:{id:{in:keys}},data:input.action==='purge'?{is_delete:true,revision:{increment:1}}:{is_in_trash:input.action==='delete',revision:{increment:1}}})
      return{changed:keys.length}
    })})
  })
  ipcMain.handle('federation:trash', (_, ref) =>
    withDatabase(ref.connectionId, true, async () => {
      const { prisma } = await import('../database')
      const id = Number(ref.key)
      const old = await prisma.compounds.findUnique({ where: { id } })
      if (!old) throw new Error('记录不存在')
      await prisma.compounds.update({
        where: { id },
        data: { is_in_trash: !old.is_in_trash, revision: { increment: 1 } }
      })
      return {
        success: true,
        is_in_trash: !old.is_in_trash,
        message: old.is_in_trash ? '已恢复' : '已移入回收站'
      }
    })
  )
}
