<script setup lang="ts">
import { adminWorkspace } from '../utils/adminWorkspace'
import {createQueryCoordinator} from '../../../shared/queryCoordinator.mjs'
import {ionModeFromRoute,ionModeQuery,ionFilterLabel,ionCountFromList,ionDatabaseScope,ION_LIST_COUNT_EVENT} from '../../../shared/ionNavigation.mjs'
import {ionModeLabel,ionModeHint} from '../../../shared/ionMode.mjs'
import { invokeIPC } from '../utils/ipcInvoke'

import type { RecordData } from '../../../shared/dataPackage'
import { displayNameLines } from '../../../shared/scientificDisplay'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElLoading, ElMessage, ElMessageBox } from 'element-plus'
import {
  COMPOUND_EXPORT_FIELDS,
  EXPORT_CONTENTS,
  DEFAULT_EXPORT
} from '../../../shared/exportFields'
import ClassificationManager from '../components/ClassificationManager.vue'
import SourceTags from '../components/SourceTags.vue'
import { scopedInvoke, notifyDataChanged, favoritesChangedEvent } from '../utils/scopedIPC'
const route = useRoute(),
  router = useRouter()
const columnOptions=[['name_en','英文名'],['cas','CAS号'],['formula','分子式'],['ionModes','离子模式'],['sources','数据来源'],['database','所属数据库'],['audit','色谱与检查摘要'],['mrm1','离子对1摘要'],['mrm2','离子对2摘要']]
const showEmptyColumns=ref(false)
const selectedColumns=ref<string[]>(adminWorkspace.value ? [...adminWorkspace.value.columns] : ['name_en','cas','formula','ionModes','sources','database'])
if (!adminWorkspace.value) try{const saved=JSON.parse(localStorage.getItem('masspec.admin.columns')||'null');if(Array.isArray(saved)&&saved.every(k=>columnOptions.some(c=>c[0]===k)))selectedColumns.value=saved}catch{}
if(!adminWorkspace.value && !localStorage.getItem('masspec.admin.ionModeColumn.v1')){if(!selectedColumns.value.includes('ionModes'))selectedColumns.value.push('ionModes');localStorage.setItem('masspec.admin.columns',JSON.stringify(selectedColumns.value));localStorage.setItem('masspec.admin.ionModeColumn.v1','1')}
watch(selectedColumns,value=>{ if (!adminWorkspace.value) localStorage.setItem('masspec.admin.columns',JSON.stringify(value)) },{deep:true})
const visibleColumn=(key: string): boolean=>{if(!selectedColumns.value.includes(key))return false;if(showEmptyColumns.value||!connectionIds.value.length)return true;const scoped=entries.value.filter(e=>connectionIds.value.includes(e.id));return !scoped.length||scoped.some(e=>!Array.isArray(e.displayFields)||e.displayFields.includes(key))}
const advancedOpen = ref(false)
const advancedCount = computed(() => [sourceQuery.value || selectedSources.value.length, polarity.value !== undefined, adduct.value, spectrumKind.value, dataTypes.value.length, auditState.value].filter(Boolean).length)
const keyword = ref(''),
  sourceQuery = ref(''),
  sourceFocus = ref(false)
const selectedSources = ref<RecordData[]>([]),
  candidates = ref<RecordData[]>([]),
  sourceVisible = ref(false),
  hasMore = ref(false),
  sourceOffset = ref(0)
const sourceWarning = ref(''),
  sourceBusy = ref(false),
  sourceGeneration = ref(0)
const entries = ref<RecordData[]>([]),
  connectionIds = ref<string[]>([]),
  list = ref<RecordData[]>([]),
  selectedRows = ref<RecordData[]>([])
const page = ref(1),
  pageSize = ref(adminWorkspace.value?.pageSize ?? 50),
  total = ref(0),
  busy = ref(false),
  warnings = ref<RecordData[]>([]),
  requestGeneration = ref(0)
const polarity = ref<number>(),
  adduct = ref(''),
  spectrumKind = ref('')
const compoundTable = ref<any>()
const newImportTitle = ref(''), importToNewLibrary = ref(false)
const importVisible = ref(false),
  targetId = ref(''),
  report = ref<RecordData | null>(null),
  reportConnection = ref('')
const exportVisible = ref(false),
  selectionOnly = ref(false)
const exportFormat = ref('json'),
  exportSelection = ref(structuredClone(DEFAULT_EXPORT))
const dataTypes = ref<string[]>([]),
  auditState = ref('')
const scopedFiles=computed(()=>entries.value.filter(e=>e.adapter==='file'&&(!connectionIds.value.length||connectionIds.value.includes(e.id))))
const supportsFilter=(key:string):boolean=>scopedFiles.value.every(e=>e.filterCapabilities?.includes(key))
const supportsDataType=(key:string):boolean=>scopedFiles.value.every(e=>e.dataTypeCapabilities?.includes(key))
const unsupportedConditions=computed(()=>[
  sourceQuery.value&&!supportsFilter('sourceQuery')?'来源文字':null,
  selectedSources.value.length&&scopedFiles.value.length?'来源编号':null,
  polarity.value!==undefined&&!supportsFilter('polarity')?'极性':null,
  adduct.value&&!supportsFilter('adduct')?'加合离子':null,
  spectrumKind.value&&!supportsFilter('spectrumKind')?'谱图形式':null,
  dataTypes.value.some(t=>!supportsDataType(t))?'数据类型':null,
  auditState.value&&scopedFiles.value.length?'检查状态':null
].filter(Boolean))
function clearUnsupported():void{if(!supportsFilter('sourceQuery'))sourceQuery.value='';if(scopedFiles.value.length)selectedSources.value=[];if(!supportsFilter('polarity')){polarity.value=undefined;void router.replace({path:route.path,query:{...route.query,ionMode:undefined}})};if(!supportsFilter('adduct'))adduct.value='';if(!supportsFilter('spectrumKind'))spectrumKind.value='';dataTypes.value=dataTypes.value.filter(supportsDataType);if(scopedFiles.value.length)auditState.value='';void search()}
let auditRefresh: ReturnType<typeof setTimeout> | undefined
function auditUpdated(_event?: unknown, value?: any): void {
  if (value?.running) return
  invalidateResults()
  if (!activePage) return
  clearTimeout(auditRefresh)
  auditRefresh = setTimeout(() => void search(false, true), 900)
}
async function associate(): Promise<void> {
  const refs = selectedRows.value.map(row => ({ ...row.ref }))
  try {
    const reviewer = (
      await ElMessageBox.prompt(
        '请输入确认人；仅在确认这些记录是同一化合物时关联',
        '化合物身份关联'
      )
    ).value
    const reason = (
      await ElMessageBox.prompt('请输入关联依据；保留全部来源、谱图和测定记录', '关联理由')
    ).value
    await invokeIPC(
      'audit:merge',
      refs,
      reviewer,
      reason
    )
    await search()
    notifyDataChanged()
    ElMessage.success('已关联，可在检测结果的关联历史中撤销')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  }
}
const groupVisible = ref(false),
  groupName = ref(''),
  groupTarget = ref<number>(),
  localGroups = ref<RecordData[]>([])
const writable = computed(() =>
  entries.value.filter((x) => x.enabled && (x.adapter === 'native'||x.canEditWorkspace) && x.writable)
)
const createVisible = ref(false),
  createBusy = ref(false),
  createTarget = ref('')
const newCompound = ref<RecordData>({}),
  newSource = ref<RecordData>({ source_type: 'local' })
async function createCompound(): Promise<void> {
  createBusy.value = true
  try {
    if (!createTarget.value) throw new Error('请选择写入数据库')
    const result = await invokeIPC('federation:create', {
      connectionId: createTarget.value,
      compound: newCompound.value,
      source: newSource.value
    })
    createVisible.value = false
    newCompound.value = {}
    newSource.value = { source_type: 'local' }
    notifyDataChanged()
    if (result.staged) ElMessage.success('已保存新增草稿，请在待发布变更中发布')
    else openDetail({ ref: result.ref })
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    createBusy.value = false
  }
}
function filters(): RecordData {
  const classId = Number(route.params.id)
  return {
    keyword: keyword.value,
    sourceQuery: sourceQuery.value,
    sourceIds: selectedSources.value.map((x) => x.id),
    connectionIds: connectionIds.value,
    polarity: polarity.value,
    adduct: adduct.value,
    spectrumKind: spectrumKind.value,
    dataTypes: dataTypes.value,
    auditState: auditState.value || undefined,
    classId: classId > 0 ? classId : undefined,
    identityStatus:
      classId === -4 ? 'identity_conflict' : classId === -5 ? 'unresolved' : undefined,
    favoriteOnly: classId === -2,
    trashOnly: classId === -3,
    page: page.value,
    pageSize: pageSize.value
  }
}
async function refreshConnections(): Promise<void> {
  await Promise.allSettled([
    invokeIPC('connections:list', Boolean(adminWorkspace.value), true).then(value => { entries.value = value }),
    invokeIPC('federation:groups').then(value => { localGroups.value = value })
  ])
}
let activePage = false
let listRouteKey = ''
let visibleResultAt = 0
let dataRevision = 0
const returnReuseMs = 15_000
const loadResults = (input: RecordData) => invokeIPC('federation:list', input)
const queryCoordinator = createQueryCoordinator(loadResults)
const favoritesCoordinator = createQueryCoordinator(loadResults)
let ionCountGeneration = 0
function canLoadIonCounts(input: RecordData): boolean {
  return !input.keyword?.trim() && !input.sourceQuery?.trim() && !input.sourceIds?.length &&
    !input.adduct && !input.spectrumKind && !input.dataTypes?.length && !input.auditState &&
    input.classId === undefined && !input.identityStatus && !input.favoriteOnly && !input.trashOnly
}
function refreshIonCounts(input: RecordData): void {
  const generation = ++ionCountGeneration
  if (!canLoadIonCounts(input)) return
  const scope = ionDatabaseScope(input.connectionIds || [])
  void Promise.allSettled([0, 1].map(mode => loadResults({ ...input, polarity: mode, page: 1, pageSize: 1 }))).then(results => {
    if (generation !== ionCountGeneration) return
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled' || !Number.isSafeInteger(result.value?.total)) return
      window.dispatchEvent(new CustomEvent(ION_LIST_COUNT_EVENT, { detail: { scope, mode: index, total: result.value.total, complete: result.value.complete !== false } }))
    })
  })
}
function invalidateResults(): void {
  dataRevision++
  visibleResultAt = 0
  queryCoordinator.clear()
  favoritesCoordinator.clear()
}
const appliedFilters = ref<RecordData>({})
function criteria(value: RecordData): string { const { page: _page, pageSize: _size, ...rest } = value; return JSON.stringify(rest) }
const pendingQuery = computed(() => criteria(filters()) !== criteria(appliedFilters.value))
const queryScope = computed(() => {
  if (appliedFilters.value.favoriteOnly) return '收藏夹'
  const ids = appliedFilters.value.connectionIds || []
  return ids.length ? entries.value.filter(e => ids.includes(e.id)).map(e => e.name).join('、') : '全部已启用数据库'
})
const libraryTotal = computed(() => {
  const ids = connectionIds.value
  const scoped = entries.value.filter(e => e.enabled && (!ids.length || ids.includes(e.id)))
  if (!scoped.length || scoped.some(e => typeof e.compoundCount !== 'number')) return null
  return scoped.reduce((sum, entry) => sum + entry.compoundCount, 0)
})
const exportCount = computed(() => selectionOnly.value ? selectedRows.value.length : total.value)
async function search(reset = true, useApplied = false): Promise<void> {
  if(!activePage)return
  visibleResultAt = 0
  if (reset) page.value = 1
  selectedRows.value = []; compoundTable.value?.clearSelection()
  const generation = ++requestGeneration.value
  const revision = dataRevision
  busy.value = true
  try {
    if(unsupportedConditions.value.length)throw Error('当前数据源不支持这些条件：'+unsupportedConditions.value.join('、')+'。请清除这些条件或缩小数据库范围。')
    const snapshot = JSON.parse(JSON.stringify(useApplied && Object.keys(appliedFilters.value).length ? { ...appliedFilters.value, page: page.value, pageSize: pageSize.value } : filters()))
    const coordinator = snapshot.favoriteOnly ? favoritesCoordinator : queryCoordinator
    const result = await coordinator.run(snapshot)
    if (generation !== requestGeneration.value) return
    appliedFilters.value = snapshot
    list.value = result.list
    total.value = result.total
    warnings.value = result.warnings
    const count = revision === dataRevision ? ionCountFromList(snapshot, result) : undefined
    if (count) window.dispatchEvent(new CustomEvent(ION_LIST_COUNT_EVENT, { detail:count }))
    if (revision === dataRevision) refreshIonCounts(snapshot)
    visibleResultAt = result.complete ? Date.now() : 0
    await nextTick();if(generation===requestGeneration.value)compoundTable.value?.setScrollTop(0)
    if (reset) selectedRows.value = []
  } catch (e) {
    if((e as Error)?.name==='SupersededQuery')return
    if(generation===requestGeneration.value){visibleResultAt=0;list.value=[];total.value=0;warnings.value=[{name:'查询失败',message:String(e)}];ElMessage.error(String(e))}
  } finally {
    if (generation === requestGeneration.value) busy.value = false
  }
}
function reset(): void {
  keyword.value = ''
  sourceQuery.value = ''
  selectedSources.value = []
  polarity.value = undefined
  void router.replace({path:route.path,query:{...route.query,ionMode:undefined}})
  adduct.value = ''
  spectrumKind.value = ''
  dataTypes.value = []
  auditState.value = ''
  void search()
}
async function lookup(more = false): Promise<void> {
  if(scopedFiles.value.length){sourceVisible.value=false;return}
  const generation = ++sourceGeneration.value
  sourceBusy.value = true
  if (!more) {
    sourceOffset.value = 0
    candidates.value = []
  }
  try {
    const result = await invokeIPC('federation:sources', sourceQuery.value, sourceOffset.value)
    if (generation !== sourceGeneration.value) return
    candidates.value = more ? [...candidates.value, ...result.list] : result.list
    hasMore.value = result.hasMore
    sourceOffset.value += result.list.length
    sourceWarning.value = result.warnings.length ? '部分连接不可用，候选可能不完整' : ''
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    if (generation === sourceGeneration.value) sourceBusy.value = false
  }
}
let debounce: ReturnType<typeof setTimeout> | undefined
function onSourceFocus(): void {
  sourceFocus.value = true
  lookup()
}
function applySources(): void {
  sourceVisible.value = false
  search()
}
function onSourceInput(): void {
  clearTimeout(debounce)
  sourceGeneration.value++
  debounce = setTimeout(() => lookup(), 220)
}
function toggleSource(item: RecordData, checked: boolean): void {
  if (checked && !selectedSources.value.some((x) => x.id === item.id))
    selectedSources.value.push(item)
  if (!checked) selectedSources.value = selectedSources.value.filter((x) => x.id !== item.id)
}
function removeSource(id: string): void {
  selectedSources.value = selectedSources.value.filter((x) => x.id !== id)
  search()
}
function highlighted(name: string): { text: string; match: boolean }[] {
  const q = sourceQuery.value.trim()
  if (!q) return [{ text: name, match: false }]
  const index = name.toLocaleLowerCase().indexOf(q.toLocaleLowerCase())
  if (index < 0) return [{ text: name, match: false }]
  return [
    { text: name.slice(0, index), match: false },
    { text: name.slice(index, index + q.length), match: true },
    { text: name.slice(index + q.length), match: false }
  ]
}
const isTrash = computed(() => Number(route.params.id) === -3)
const isFavorites = computed(() => Number(route.params.id) === -2)
const removingFavorites = ref(false)
async function removeFavorites(rows: RecordData[]): Promise<void> {
  if (busy.value || removingFavorites.value || !isFavorites.value || !appliedFilters.value.favoriteOnly) return
  removingFavorites.value = true
  const removed = new Set<string>()
  let failures = 0
  try {
    for (const row of rows) {
      try {
        const result = await invokeIPC('federation:favorite', row.ref, false)
        if (!result?.success || result.is_favorite !== false) throw Error('未取消收藏')
        removed.add(row.rowKey)
      } catch { failures++ }
    }
    favoritesCoordinator.clear()
    if (appliedFilters.value.favoriteOnly) visibleResultAt = 0
    if (activePage && isFavorites.value && appliedFilters.value.favoriteOnly) {
      const remaining = list.value.filter(row => !removed.has(row.rowKey))
      total.value = Math.max(0, total.value - (list.value.length - remaining.length))
      list.value = remaining
      page.value = Math.min(page.value, Math.max(1, Math.ceil(total.value / pageSize.value)))
      await search(false, true)
    }
    if (failures) ElMessage.warning(`已取消收藏 ${removed.size} 条，${failures} 条未确认，请核对收藏夹`)
    else if (removed.size) ElMessage.success(`已取消收藏 ${removed.size} 条`)
  } finally { removingFavorites.value = false }
}
const canManageSelected = computed(() => selectedRows.value.length>0 && new Set(selectedRows.value.map(row=>row.ref.connectionId)).size===1 && selectedRows.value.every(row=>row.ref.connectionId!=='@unified' && entries.value.some(e=>e.id===row.ref.connectionId&&e.writable)))
async function changeRecords(action: string, rows: RecordData[] = selectedRows.value): Promise<void> {
  try{
    await ElMessageBox.confirm(`是否确认${action==='restore'?'恢复':action==='purge'?'彻底删除':'删除'}所选 ${rows.length} 条来源记录？${action==='delete'?'删除后可在回收站恢复。':''}`,'确认操作',{confirmButtonText:'是',cancelButtonText:'否',closeOnClickModal:false})
    busy.value=true;const result=await invokeIPC('federation:records-change',{action,refs:rows.map(row=>row.ref)});await search(false);notifyDataChanged();ElMessage.success(result.staged ? '已加入待发布变更' : '操作完成')
  }catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(String(e))}finally{busy.value=false}
}
function openDetail(row: RecordData): void {
  window.sessionStorage.setItem(
    'currentCompound',
    JSON.stringify({ ref: row.ref, id: row.id, scope: row.scope, tab: row.tab })
  )
  router.push({ name: 'Detail', query: route.query })
}
async function importPackage(): Promise<void> {
  const createNew = importToNewLibrary.value
  const title = newImportTitle.value.trim()
  if (createNew ? !title : !targetId.value) {
    ElMessage.warning(createNew ? '请输入新数据库名称' : '请选择目标数据库')
    return
  }
  let loading: ReturnType<typeof ElLoading.service> | undefined
  try {
    const paths = await invokeIPC('dialog:openFile', {
      title: '选择化合物数据包',
      filters: [{ name: '化合物迁移包', extensions: ['msldata', 'json','xlsx','xls','csv'] }]
    })
    if (!paths?.[0]) return
    const preview = createNew ? await invokeIPC('file-library:import-preview', paths[0]) : await scopedInvoke(targetId.value, 'import:preview', paths[0])
    await ElMessageBox.confirm(
      `目标：${createNew ? `新建「${title}」` : entries.value.find((x) => x.id === targetId.value)?.name}。${preview.estimated ? "文件内 " + preview.newCount + " 条，发布导入时核对新增、重复和冲突" : "新增 " + preview.newCount + "，跳过 " + preview.skipped + "，冲突 " + preview.conflicts}。同来源变化不覆盖，跨来源同名不自动合并。`,
      '导入预览'
    )
    loading = ElLoading.service({ text: '正在导入…', lock: true })
    report.value = createNew ? await invokeIPC('file-library:import-new', paths[0], preview.hash, title) : await scopedInvoke(targetId.value, 'import:compounds', paths[0], preview.hash)
    if (report.value?.staged) { report.value = null; ElMessage.success('导入文件已保存在本机，发布后导入共享库') }
    reportConnection.value = createNew ? '' : targetId.value
    importVisible.value = false
    if (createNew) newImportTitle.value = ''
    notifyDataChanged()
    await search()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  } finally {
    loading?.close()
  }
}
async function undoImport(): Promise<void> {
  const batchId = report.value?.batchId
  if (!batchId) return
  try {
    await ElMessageBox.confirm('只撤销本批未修改且未共享的新增记录。', '撤销导入')
    const result = await scopedInvoke(reportConnection.value, 'import:undo', batchId)
    ElMessageBox.alert(JSON.stringify(result, null, 2), '撤销结果')
    notifyDataChanged()
    search()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  }
}
async function exportPackage(): Promise<void> {
  if (pendingQuery.value) { ElMessage.warning('条件已修改，请先查询再导出'); return }
  const refs = selectedRows.value.map(row => ({ ...row.ref }))
  const snapshot = JSON.parse(JSON.stringify({ filters: appliedFilters.value, format: exportFormat.value, selection: exportSelection.value, selectionOnly: selectionOnly.value }))
  let loading: ReturnType<typeof ElLoading.service> | undefined
  try {
    if (snapshot.selectionOnly && !refs.length) throw new Error('请先勾选记录')
    const path = await invokeIPC('dialog:saveFile', {
      title: '导出化合物',
      filters: [{ name: '化合物数据', extensions: [exportFormat.value] }],
      defaultPath: 'MasspecLib2.' + exportFormat.value
    })
    if (!path) return
    loading = ElLoading.service({ text: '正在导出…', lock: true })
    const result = await invokeIPC('federation:export', {
      filePath: path,
      format: snapshot.format,
      selection: snapshot.selection,
      selectionOnly: snapshot.selectionOnly,
      refs,
      filters: snapshot.filters
    })
    if (!result.success) throw new Error(result.message)
    ElMessage.success(result.message)
    exportVisible.value = false
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    loading?.close()
  }
}
async function saveGroup(): Promise<void> {
  try {
    await invokeIPC('federation:group-save', {
      id: groupTarget.value,
      append: !!groupTarget.value,
      name: groupTarget.value
        ? localGroups.value.find((x) => x.id === groupTarget.value)?.class_name
        : groupName.value,
      refs: selectedRows.value.map((x) => x.ref)
    })
    groupVisible.value = false
    groupName.value = ''
    notifyDataChanged()
    ElMessage.success('分组已保存到本地，不修改外部库')
  } catch (e) {
    ElMessage.error(String(e))
  }
}
async function removeFromGroup(): Promise<void> {
  try {
    await invokeIPC('federation:group-remove-records', {
      id: Number(route.params.id),
      refs: selectedRows.value.map((x) => x.ref)
    })
    notifyDataChanged()
  } catch (e) {
    ElMessage.error(String(e))
  }
}
function databaseScopeFromRoute(): void {
  polarity.value=ionModeFromRoute(route.query.ionMode)
  const value = route.query.db
  connectionIds.value = (Array.isArray(value) ? value : value ? [value] : []).filter((id): id is string => typeof id === 'string')
}
let searchScopeChange: string | undefined
function changeDatabaseRange(): void {
  searchScopeChange = JSON.stringify(connectionIds.value.length ? connectionIds.value : null)
  void router.replace({ path: route.path, query: { ...route.query, db: connectionIds.value.length ? [...connectionIds.value] : undefined } })
}
function changeIonMode():void {void router.replace({path:route.path,query:{...route.query,ionMode:ionModeQuery(polarity.value)}})}
function clearRouteFilters(): void {
  keyword.value = ''; sourceQuery.value = ''; selectedSources.value = []
  adduct.value = ''; spectrumKind.value = ''; dataTypes.value = []; auditState.value = ''
}
const listRouteState = () => [route.params.id, route.query.db, route.query.ionMode]
watch(listRouteState, (next, previous) => {
  if (!activePage || route.name !== 'MainList') return
  const nextKey = JSON.stringify(next)
  if (nextKey === listRouteKey) return
  listRouteKey = nextKey
  if (next[0] === '-2' && previous[0] !== '-2') clearRouteFilters()
  if (next[0] === '-1' && next[1] !== previous[1] && JSON.stringify(next[1] ?? null) !== searchScopeChange) clearRouteFilters()
  searchScopeChange = undefined
  databaseScopeFromRoute(); void search()
})
async function onChange(): Promise<void> {
  invalidateResults()
  await refreshConnections()
  if (activePage&&route.name === 'MainList') await search(false)
}
function onFavoritesChanged(): void {
  favoritesCoordinator.clear()
  if (appliedFilters.value.favoriteOnly) visibleResultAt = 0
  if (activePage && route.name === 'MainList' && isFavorites.value) {
    void search(false, Boolean(appliedFilters.value.favoriteOnly))
  }
}
onActivated(() => {
  activePage = true
  const nextKey = JSON.stringify(listRouteState())
  const sameRoute = nextKey === listRouteKey
  listRouteKey = nextKey
  const enteringFavorites = Number(route.params.id) === -2 && !appliedFilters.value.favoriteOnly
  if (enteringFavorites) clearRouteFilters()
  databaseScopeFromRoute()
  if (sameRoute && Date.now() - visibleResultAt < returnReuseMs &&
      page.value === appliedFilters.value.page && pageSize.value === appliedFilters.value.pageSize) return
  void search(!sameRoute || enteringFavorites, sameRoute)
})
onDeactivated(() => {
  activePage = false
  requestGeneration.value++
  busy.value = false
  queryCoordinator.cancelPending()
  favoritesCoordinator.cancelPending()
})
onMounted(() => {
  void refreshConnections()
  window.addEventListener('masspeclib2-data-changed', onChange)
  window.addEventListener(favoritesChangedEvent, onFavoritesChanged)
  window.electron.ipcRenderer.on('audit:updated', auditUpdated)
})
onUnmounted(() => {
  clearTimeout(debounce)
  window.removeEventListener('masspeclib2-data-changed', onChange)
  window.removeEventListener(favoritesChangedEvent, onFavoritesChanged)
  clearTimeout(auditRefresh)
  window.electron.ipcRenderer.removeListener('audit:updated', auditUpdated)
})
</script>
<template>
  <div class="main-list-page"><div class="query-context"><span>当前结果范围：{{ queryScope }} · {{ total }} 条<template v-if="appliedFilters.polarity!==undefined"> · 离子模式：{{ ionFilterLabel(appliedFilters.polarity) }}</template></span><span :class="{ pending: pendingQuery }">{{ busy ? '正在按所选条件查询…' : pendingQuery ? '条件已修改，请点击搜索后应用；当前仍显示上次结果' : '勾选仅作用于当前页' }}</span></div>
    <div class="search-line primary-search">
      <label for="compound-search">化合物</label>
      <el-input
        id="compound-search"
        v-model="keyword"
        placeholder="输入名称、CAS 或分子式"
        clearable
        @keyup.enter="applySources"
      />
      <el-button type="primary" @click="applySources">搜索</el-button>
    </div>
    <div class="actions search-scope">
      <label for="database-scope">数据库</label>
      <el-select
        id="database-scope"
        v-model="connectionIds"
        class="database-scope"
        multiple collapse-tags clearable
        placeholder="全部启用库"
        @change="changeDatabaseRange"
      >
        <el-option
          v-for="entry in entries.filter((x) => x.enabled)"
          :key="entry.id" :label="entry.name" :value="entry.id"
        />
      </el-select>
      <el-button @click="advancedOpen = !advancedOpen">{{ advancedOpen ? '收起筛选' : '高级筛选' }}{{ advancedCount ? `（${advancedCount}）` : '' }}</el-button>
      <el-button text @click="reset">清空条件</el-button>
    </div>
    <div v-show="advancedOpen" class="search-line">
      <label>数据来源：</label>
      <el-popover
        v-model:visible="sourceVisible"
        :disabled="!!scopedFiles.length"
        trigger="click"
        placement="bottom-start"
        :width="620"
      >
        <template #reference
          ><div class="source-input">
            <el-tag
              v-for="source in selectedSources"
              :key="source.id"
              closable
              @close.stop="removeSource(source.id)"
              >{{ source.name }}</el-tag
            ><el-input
              v-model="sourceQuery"
              :disabled="!supportsFilter('sourceQuery')"
              :placeholder="
                sourceFocus
                  ? ''
                  : selectedSources.length
                    ? '继续输入来源名称……'
                    : scopedFiles.length ? '按来源名称文字查询' : '全部来源；输入来源名称以选择……'
              "
              clearable
              @focus="onSourceFocus"
              @blur="sourceFocus = false"
              @input="onSourceInput"
              @keyup.enter="applySources"
            /></div
        ></template>
        <div v-loading="sourceBusy" style="max-height: 300px; overflow: auto">
          <p v-if="!candidates.length && !sourceBusy">没有找到匹配来源</p>
          <div v-for="item in candidates" :key="item.id" class="source-choice">
            <el-checkbox
              :model-value="selectedSources.some((x) => x.id === item.id)"
              @change="toggleSource(item, !!$event)"
              ><span
                v-for="(part, index) in highlighted(item.name)"
                :key="index"
                :style="part.match ? { color: '#c00000', fontWeight: 'bold' } : {}"
                >{{ part.text }}</span
              ></el-checkbox
            ><span
              >{{
                item.sourceType === 'public'
                  ? '公共库'
                  : item.sourceType === 'local'
                    ? '本地库'
                    : '类型未知'
              }}
              · {{ item.provider || item.connectionName }}</span
            >
          </div>
        </div>
        <el-button v-if="hasMore" link :disabled="sourceBusy" @click="lookup(true)"
          >加载更多来源</el-button
        >
        <p>
          {{
            selectedSources.length
              ? '已勾选：仅搜索所选来源'
              : '未勾选：按输入文字搜索全部匹配来源；为空时不限制来源'
          }}
        </p>
        <p v-if="sourceWarning" style="color: #b66">{{ sourceWarning }}</p>
        <el-button type="primary" @click="applySources">应用来源筛选</el-button>
      </el-popover>
    </div>
    <div v-show="advancedOpen" class="actions">
      <span>离子模式</span
      ><el-select
        v-model="polarity"
        clearable
        placeholder="全部"
        style="width: 130px"
        @change="changeIonMode"
        ><el-option :value="1" label="正离子" /><el-option :value="0" label="负离子" /><el-option :value="3" label="正负均有" /><el-option
          :value="2"
          label="未注明" /></el-select
      ><span>加合</span
      ><el-input
        v-model="adduct"
        :disabled="!supportsFilter('adduct')"
        clearable
        placeholder="不限"
        style="width: 180px"
        @keyup.enter="search()"
      /><span>谱图形式</span
      ><el-select
        v-model="spectrumKind"
        clearable
        placeholder="全部"
        style="width: 140px"
        @change="search()"
        ><el-option value="numeric" label="数值谱" /><el-option value="image" label="图片谱"
      /></el-select>
    </div>
    <div class="actions result-actions">
      <div v-if="!isTrash" class="action-group">
        <el-button @click="createVisible = true">新增化合物</el-button>
        <el-button @click="importVisible = true">导入化合物</el-button>
      </div>
      <div class="action-group display-actions">
        <el-popover trigger="click" width="220">
          <template #reference><el-button>显示列</el-button></template>
          <el-checkbox-group v-model="selectedColumns">
            <el-checkbox v-for="column in columnOptions" :key="column[0]" :value="column[0]" style="display:flex">{{ column[1] }}</el-checkbox>
          </el-checkbox-group>
          <el-divider />
          <el-checkbox v-model="showEmptyColumns">显示当前库空列</el-checkbox>
        </el-popover>
        <el-button :disabled="pendingQuery || busy || !total" @click="exportVisible = true">导出化合物</el-button>
      </div>
    </div>
    <div v-if="selectedRows.length" class="actions selection-actions">
      <span>已勾选 {{ selectedRows.length }} 条</span>
      <template v-if="!isTrash">
        <ClassificationManager :records="selectedRows" :entries="entries" :scope="appliedFilters" assignment />
        <el-button @click="groupVisible = true">保存为分组</el-button>
        <el-button v-if="Number(route.params.id) > 0 && Number(route.params.id) < 1000000000" @click="removeFromGroup">从本分组移除</el-button>
        <el-button v-if="isFavorites" plain :disabled="busy || removingFavorites" @click="removeFavorites([...selectedRows])">取消收藏所选</el-button>
        <el-button v-else type="danger" plain :disabled="!canManageSelected || busy" @click="changeRecords('delete')">删除所选</el-button>
      </template>
      <template v-else>
        <el-button :disabled="!canManageSelected || busy" @click="changeRecords('restore')">恢复所选</el-button>
        <el-button type="danger" :disabled="!canManageSelected || busy" @click="changeRecords('purge')">彻底删除</el-button>
      </template>
    </div>
    <el-alert v-if="unsupportedConditions.length" type="warning" :closable="false" :title="'当前范围不支持：'+unsupportedConditions.join('、')"><el-button link type="primary" @click="clearUnsupported">清除不支持的条件</el-button></el-alert>
    <p v-if="advancedOpen && scopedFiles.length" class="filter-scope-hint">筛选按当前数据库范围提供；灰色项目暂不支持。文件库尚未建立自动检查索引，不能按检查状态筛选。</p>
    <el-alert v-if="warnings.length" type="warning" :closable="false" title="本次结果不完整"
      ><p v-for="warning in warnings" :key="warning.connectionId">
        {{ warning.name }}：{{ warning.message }}
      </p></el-alert
    >
    <div v-show="advancedOpen" class="data-filters" style="display: flex; gap: 14px; flex-wrap: wrap; margin: 14px 0">
      <el-select
        v-model="dataTypes"
        multiple
        clearable
        placeholder="数据类型（可多选，同时具备）"
        style="width: 300px"
        @change="search()"
        ><el-option
          v-for="item in [
            ['spectrum', '有质谱'],
            ['numeric', '有数值色谱'],
            ['image', '有色谱图片'],
            ['measurement', '有定量结果'],
            ['response', '有离子响应']
          ]"
          :key="item[0]"
          :value="item[0]"
          :label="item[1]"
          :disabled="!supportsDataType(item[0])"
      /></el-select>
      <el-select
        v-model="auditState"
        :disabled="!!scopedFiles.length"
        clearable
        placeholder="检查状态"
        style="width: 200px"
        @change="search()"
        ><el-option
          v-for="item in [
            ['abnormal', '存在异常'],
            ['incomplete', '数据不足'],
            ['pending', '待检查'],
            ['unreviewed', '异常待复核']
          ]"
          :key="item[0]"
          :value="item[0]"
          :label="item[1]"
      /></el-select>
      <el-button :disabled="selectedRows.length < 2 || selectedRows.some(r=>r.ref.connectionId.startsWith('file:'))" @click="associate">关联为同一化合物</el-button>
    </div>
    <el-table
      ref="compoundTable"
      v-loading="busy"
      :data="list"
      row-key="rowKey"
      border
      @selection-change="selectedRows = $event"
      @row-dblclick="openDetail"
    >
      <el-table-column type="selection" width="45" fixed="left" />
      <el-table-column label="名称" fixed="left" min-width="210" show-overflow-tooltip
        ><template #default="scope">
          <template v-for="(name, index) in displayNameLines(scope.row).slice(0,1)" :key="name">
            <el-link v-if="index === 0" type="primary" @click="openDetail(scope.row)">{{
              name
            }}</el-link>
            <div v-else>{{ name }}</div>
          </template>
          <span v-if="!displayNameLines(scope.row).length">名称未提供</span>
        </template></el-table-column
      >
      <el-table-column v-if="visibleColumn('name_en')" prop="name_en" label="英文名" min-width="170" show-overflow-tooltip />
      <el-table-column v-if="visibleColumn('cas')"
        prop="cas"
        label="CAS"
        min-width="135"
        show-overflow-tooltip
      /><el-table-column v-if="visibleColumn('formula')" prop="formula" label="分子式" min-width="140" show-overflow-tooltip />
      <el-table-column v-if="selectedColumns.includes('ionModes')" label="离子模式" width="140"><template #default="s"><span :title="ionModeHint(s.row)">{{ ionModeLabel(s.row) }}</span></template></el-table-column>
      <el-table-column v-if="selectedColumns.includes('sources')" label="数据来源" min-width="190"
        ><template #default="scope"><SourceTags :sources="scope.row.sources" /></template
      ></el-table-column>
      <el-table-column v-if="selectedColumns.includes('database')"
        prop="connectionName"
        label="所属数据库"
        min-width="140"
        show-overflow-tooltip
      />
      <el-table-column v-if="selectedColumns.includes('audit')" label="色谱与检查" min-width="230"
        ><template #default="s"
          ><template v-if="s.row.dataOverview"
            ><el-link type="primary" @click="openDetail({ ...s.row, tab: 'chromatograms' })"
              >数值色谱 {{ s.row.dataOverview.numericTraces }} · 图片
              {{ s.row.dataOverview.images }}</el-link
            >
            <div>
              异常 {{ s.row.dataOverview.abnormal }} · 数据不足
              {{ s.row.dataOverview.incomplete }} · 待检 {{ s.row.dataOverview.pending }}
            </div></template
          ><span v-else>索引尚未完成</span></template
        ></el-table-column
      >
      <el-table-column
        v-for="index in [1, 2].filter(i=>selectedColumns.includes('mrm'+i))"
        :key="index"
        :label="'离子对' + index + '摘要'"
        align="center"
        ><el-table-column
          v-for="field in [
            ['q1', '母离子 m/z（Q1）'],
            ['q3', '子离子 m/z（Q3）'],
            ['dp', 'DP'],
            ['ce', 'CE']
          ]"
          :key="field[0]"
          :prop="'mrm' + index + '_' + field[0]"
          :label="field[1]"
          :min-width="field[0][0] === 'q' ? 155 : 80"
          show-overflow-tooltip
      /></el-table-column>
      <el-table-column label="操作" :width="isFavorites ? 154 : 130" :fixed="isFavorites ? 'right' : false">
        <template #default="s">
          <el-button link type="primary" @click="openDetail(s.row)">查看</el-button>
          <el-button v-if="isFavorites" link :disabled="busy || removingFavorites" @click="removeFavorites([s.row])">取消收藏</el-button>
          <el-button v-else-if="s.row.ref.connectionId !== '@unified' && entries.some(e=>e.id===s.row.ref.connectionId&&e.writable)" link :type="isTrash?'primary':'danger'" @click="changeRecords(isTrash?'restore':'delete',[s.row])">{{isTrash?'恢复':'删除'}}</el-button>
        </template>
      </el-table-column>
    </el-table>
    <p v-if="isFavorites">点击名称或双击查看详情。</p>
    <p v-else>点击名称或双击查看详情。删除请先选择具体可写数据库；方法与检查摘要可在“显示列”中开启。</p>
    <el-dialog v-model="createVisible" title="新增化合物" width="650px">
      <el-form label-width="110px"
        ><el-form-item label="写入数据库"
          ><el-select v-model="createTarget" placeholder="选择可写新库"
            ><el-option
              v-for="entry in entries.filter(
                (x) => x.enabled && (x.adapter === 'native'||x.canEditWorkspace) && x.writable
              )"
              :key="entry.id"
              :value="entry.id"
              :label="entry.name" /></el-select></el-form-item
        ><el-form-item
          v-for="field in [
            ['main_name', '主显示名称'],
            ['name_zh', '中文名称'],
            ['name_en', '英文名称'],
            ['cas', 'CAS号'],
            ['formula', '分子式']
          ]"
          :key="field[0]"
          :label="field[1]"
          ><el-input v-model="newCompound[field[0]]" /></el-form-item
        ><el-divider>来源（有资料时填写）</el-divider
        ><el-form-item label="来源名称"><el-input v-model="newSource.name" /></el-form-item
        ><el-form-item label="来源类型"
          ><el-select v-model="newSource.source_type"
            ><el-option value="public" label="公共库" /><el-option
              value="local"
              label="本地库" /><el-option value="unknown" label="未知" /></el-select></el-form-item
        ><el-form-item label="提供者"><el-input v-model="newSource.provider" /></el-form-item
        ><el-form-item label="来源位置"
          ><el-input
            v-model="newSource.location"
            placeholder="网址、文件位置或文献引用" /></el-form-item
      ></el-form>
      <p>至少填写一项名称、CAS或分子式。其他方法信息可在新增后的详情页补全。</p>
      <template #footer
        ><el-button @click="createVisible = false">取消</el-button
        ><el-button type="primary" :loading="createBusy" @click="createCompound"
          >创建并打开详情</el-button
        ></template
      >
    </el-dialog>
    <el-pagination
      v-model:current-page="page"
      v-model:page-size="pageSize"
      :total="total"
      :page-sizes="[20, 50, 100, 200]"
      layout="slot,sizes,prev,pager,next,jumper"
      @size-change="page = 1; search(false, true)"
      @current-change="search(false, true)"
    ><span v-if="isFavorites">收藏结果 {{ total.toLocaleString() }} 条</span><span v-else-if="libraryTotal !== null">库内共 {{ libraryTotal.toLocaleString() }} 条</span></el-pagination>
    <el-dialog v-model="importVisible" title="导入记录到数据库" width="600px"
      ><el-radio-group v-model="importToNewLibrary"><el-radio :value="false">导入已有库</el-radio><el-radio :value="true">新建服务器文件库</el-radio></el-radio-group>
      <el-input v-if="importToNewLibrary" v-model="newImportTitle" :maxlength="120" placeholder="输入新数据库名称" />
      <el-select v-else v-model="targetId" placeholder="选择目标数据库"
        ><el-option
          v-for="entry in writable"
          :key="entry.id"
          :label="entry.name"
          :value="entry.id" /></el-select
      ><template #footer
        ><el-button @click="importVisible = false">取消</el-button
        ><el-button type="primary" @click="importPackage">选择数据包并预览</el-button></template
      ></el-dialog
    >
    <el-dialog v-model="exportVisible" title="导出化合物" width="600px"
      ><el-alert :title="`导出 ${exportCount} 条 · ${queryScope}`" type="info" :closable="false" /><el-radio-group v-model="selectionOnly"
        ><el-radio :value="false">导出当前筛选结果</el-radio
        ><el-radio :value="true">导出当前页勾选记录</el-radio></el-radio-group
      >
      <p>导出格式：</p>
      <el-select v-model="exportFormat"
        ><el-option label="JSON（完整曲线和所选内容）" value="json" /><el-option
          label="CSV（字段报告）"
          value="csv" /><el-option label="Excel（字段报告）" value="xlsx" /><el-option
          label="MSLDATA（完整迁移包）"
          value="msldata"
      /></el-select>
      <template v-if="exportFormat !== 'msldata'"
        ><p>基础字段：</p>
        <el-checkbox-group v-model="exportSelection.fields"
          ><el-checkbox v-for="item in COMPOUND_EXPORT_FIELDS" :key="item[0]" :value="item[0]">{{
            item[1]
          }}</el-checkbox></el-checkbox-group
        >
        <p>关联内容：</p>
        <el-checkbox-group v-model="exportSelection.contents"
          ><el-checkbox v-for="item in EXPORT_CONTENTS" :key="item[0]" :value="item[0]">{{
            item[1]
          }}</el-checkbox></el-checkbox-group
        >
        <p>
          所选内容会展开为单元格JSON；含大段曲线时建议JSON。记录标识始终保留以便核对。
        </p></template
      >
      <p v-else>
        迁移包保留原始数据库记录和全部原生关联字段，不进行字段裁剪；新增实验扩展表请另外备份。
      </p>
      <p>
        所有参与连接必须可用，失败时不输出不完整包。跨库逐记录读取不保证同一时刻快照；导出报告记录参与库与时间。
      </p>
      <template #footer
        ><el-button @click="exportVisible = false">取消</el-button
        ><el-button type="primary" :disabled="pendingQuery || !exportCount" @click="exportPackage">选择位置并导出</el-button></template
      ></el-dialog
    >
    <el-dialog :model-value="!!report" title="导入报告" width="650px" @close="report = null">
      <pre style="white-space: pre-wrap">{{ JSON.stringify(report, null, 2) }}</pre>
      <el-button v-if="report?.imported" type="warning" @click="undoImport"
        >撤销本批未修改的新增记录</el-button
      ></el-dialog
    >
    <el-dialog v-model="groupVisible" title="本地分组" width="500px"
      ><el-select
        v-model="groupTarget"
        clearable
        placeholder="新建分组；也可选择已有分组"
        style="width: 100%; margin-bottom: 12px"
        ><el-option
          v-for="group in localGroups"
          :key="group.id"
          :label="group.class_name"
          :value="group.id" /></el-select
      ><el-input v-if="!groupTarget" v-model="groupName" placeholder="新分组名称" />
      <p>将当前勾选的 {{ selectedRows.length }} 条跨库记录保存为本地分组。</p>
      <template #footer><el-button @click="saveGroup">保存</el-button></template></el-dialog
    >
  </div>
</template>
<style scoped>
.query-context {display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#718096;font-size:12px;padding-bottom:8px;border-bottom:1px solid #e2e9f2}.query-context .pending {color:#a46712}
.main-list-page {
  background: white;
  padding: 20px;
}
.search-line {
  display: flex;
  align-items: flex-start;
  margin: 12px 0;
  max-width: 900px;
}
.search-line > label {
  width: 100px;
  flex-shrink: 0;
  padding-top: 8px;
}
.source-input {
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  padding: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
  min-width: 400px;
}
.source-input .el-input {
  min-width: 250px;
  flex: 1;
}
.source-choice {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 5px;
}
.source-choice > span {
  font-size: 12px;
  color: #777;
}
.actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin: 15px 0;
}
.el-pagination {
  margin-top: 20px;
}
pre {
  overflow-wrap: anywhere;
}

.main-list-page { margin:12px;padding:16px 18px;border:1px solid #e2e9f2;border-radius:9px; }
.search-line { margin:10px 0; }.search-line > label { width:88px;font-size:13px; }
.source-input { min-width:220px;border-radius:6px; }.source-input .el-input { min-width:160px; }
.actions { margin:12px 0;gap:8px; }.actions :deep(.el-button + .el-button) { margin-left:0; }
.el-pagination { margin-top:12px; }
.primary-search { align-items: center; gap: 8px; margin-bottom: 0; max-width: 900px; }
.primary-search > label, .search-scope > label { padding: 0; width: 64px; font-size: 13px; }
.primary-search > .el-input { flex: 1; min-width: 0; }
.database-scope { width: min(300px, 100%); }
.search-scope { margin: 8px 0; }
.result-actions { border-top: 1px solid #e2e9f2; padding-top: 10px; margin: 6px 0 10px; }
.action-group { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.display-actions { margin-left: auto; }
.selection-actions { padding: 7px 10px; background: #f4f7fb; border-radius: 6px; margin: 0 0 8px; }
.selection-actions > span { font-size: 13px; color: #536780; }

</style>

<style>
/* MasspecLib2: bounded compound list, persistent table scrollbars. */
.workspace-content:has(> .main-list-page) {
  display: flex !important;
  flex-direction: column;
  overflow: hidden !important;
}
.workspace-content > .main-list-page {
  box-sizing: border-box;
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.main-list-page > .query-context,
.main-list-page > .search-line,
.main-list-page > .actions,
.main-list-page > p,
.main-list-page > .el-pagination {
  flex: 0 0 auto;
}
.main-list-page > .el-table {
  flex: 1 1 0;
  min-height: 140px;
  min-width: 0;
  width: 100%;
  overflow: hidden;
}
.main-list-page > .el-table .el-table__inner-wrapper {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}
.main-list-page > .el-table .el-table__header-wrapper,
.main-list-page > .el-table .el-table__footer-wrapper {
  flex: 0 0 auto;
}
.main-list-page > .el-table .el-table__body-wrapper {
  flex: 1 1 0;
  min-height: 0;
}
.main-list-page > .el-table .el-table__body-wrapper .el-scrollbar {
  height: 100%;
  min-height: 0;
}
.main-list-page > .el-table .el-table__body-wrapper .el-scrollbar__wrap {
  height: 100%;
  max-height: 100%;
}
.main-list-page > .el-table .el-scrollbar__bar.is-horizontal {
  bottom: 1px;
  height: 12px;
  opacity: 1 !important;
  z-index: 5;
}
.main-list-page > .el-table .el-scrollbar__bar.is-vertical {
  width: 10px;
  opacity: 1 !important;
}
.main-list-page > .el-table .el-scrollbar__thumb {
  background: #75869c;
  opacity: .72;
}
.main-list-page > p {
  margin: 8px 0 0;
  font-size: 12px;
}
.main-list-page > .el-pagination {
  margin-top: 8px;
}

</style>
