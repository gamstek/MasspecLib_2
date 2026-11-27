import { workspaceEntries, workspaceEntryState } from '../../shared/adminWorkspace.mjs'
import { adminWorkspace } from './adminWorkspace'
import {lcForEditor} from '../../shared/fileRecordTransfer'
import { fileLibraryRequest } from '../delivery'
import { getState } from '../federation/registry'
import { refKey } from '../../shared/federation'
import type { RecordRef } from '../../shared/federation'
export const isFileRef = (ref: RecordRef): boolean => String(ref?.connectionId).startsWith('file:')
export function fileFavoriteKeys(ref: RecordRef): [string, string] {
  return [refKey({ ...ref, key: String(ref.key) }), JSON.stringify([ref.connectionId, Number(ref.key)])]
}
export function isFileFavorite(ref: RecordRef): boolean {
  return fileFavoriteKeys(ref).some(key => getState().favorites.includes(key))
}
export async function fileConnections(includeDisconnected=false): Promise<any[]> {
  const result = await fileLibraryRequest('GET', includeDisconnected ? '/admin/file-sources?includeRemoved=1' : '/admin/file-sources')
  const detached=getState().disconnectedIds||[]
  const entries = result.libraries.map((l: any) => ({ id: l.libraryId, name: l.title, database: l.libraryId, adapter: 'file', location:l.origin, writable: !l.readOnly&&l.status==='ready', readOnly: !!l.readOnly, defaultMajor: l.defaultMajor, displayFields:l.displayFields, filterCapabilities:l.adapter==='unified-sqlite'?['polarity','spectrumKind','dataTypes']:['polarity','adduct','spectrumKind','dataTypes','sourceQuery'],dataTypeCapabilities:l.adapter==='unified-sqlite'?['spectrum']:['spectrum','numeric','image','measurement','response'], sourceAdapter:l.adapter,canEditWorkspace:l.adapter==='lds-cn'&&!l.readOnly,compoundCount:l.status==='ready'?l.total:null,trashedCount:l.trashed,revision:l.revision,detailIndex:l.detailIndex,status: l.status, issue: l.issue, serverManaged: true }))
  const settings = adminWorkspace()
  const scoped = includeDisconnected ? entries : workspaceEntries(settings, entries)
  return scoped.map((entry: any) => ({
    ...entry, ...workspaceEntryState(settings, entry, detached.includes(entry.id))
  })).filter((entry: any) => includeDisconnected || !entry.detached)
}
export async function filePage(id: string, input: any): Promise<any> {
  return fileLibraryRequest('POST', '/admin/file-sources/records', { ...input, libraryId: id })
}
export async function fileDetail(ref: RecordRef,includePeaks=false): Promise<any> {
  let value: any
  try { value=await fileLibraryRequest('POST','/admin/file-sources/record',{libraryId:ref.connectionId,id:Number(ref.key),includePeaks}) }
  catch(e) { if(!String(e).includes('记录不存在'))throw e;value=await fileLibraryRequest('POST','/admin/file-sources/record',{libraryId:ref.connectionId,id:Number(ref.key),trash:true,includePeaks}) }
  const r = value.record
  const methods = (r.ms || []).map((m: any) => ({ ...m, compounds_id: Number(ref.key) }))
  return {
    compound: { ...r.compound, id: Number(ref.key), ref, readOnly: true, fileRecord:true,canEditBasic:!value.readOnly&&!value.trash,fileRevision:value.revision,canManageRecords:!value.readOnly,canEditWorkspace:!!value.workspace&&!value.readOnly&&!value.trash,name:r.compound.name||[],properties:{identity_status:r.compound.identity_status},rowKey: JSON.stringify(ref), is_favorite: isFileFavorite(ref), is_in_trash:!!value.trash },
    methods: methods.length ? [{ ms_mode: '质谱方法', methods }] : [],
    lcMethods: lcForEditor(r.lc || []).map((m: any) => ({ ...m, methodsLinks: m.gradient || [] })),
    classes: [],
    extensions: { spectra: r.spectra || [], profiles: [], sources:(r.sources||[]).map((s:any)=>({appliesTo:'compound',entityId:ref.key,source_record:{source_key:String(s.source_record_id||s.name),library:{name:s.name,version:s.version}}})),fileLibraryId:ref.connectionId,fileRecordId:Number(ref.key),taxonomyCatalog: r.classification?.catalog || [], classifications: (r.classification?.items || []).map((item: any) => { const [namespace,category_code] = JSON.parse(item.key); return { namespace,category_code,evidence:[{review_status:item.review_status}] } }), fileRecord: r }
  }
}
