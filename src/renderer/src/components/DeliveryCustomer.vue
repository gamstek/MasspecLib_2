<script setup lang="ts">
import { ref, computed, nextTick, markRaw, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import DeliveryRecord from './DeliveryRecord.vue'
import FlatFieldsTable from './FlatFieldsTable.vue'
import {detailManifest} from '../../../shared/displayLayout.mjs'
import DeliveryPersonal from './DeliveryPersonal.vue'
import { queryOptions } from '../../../shared/deliveryQuery.mjs'
import { classificationDescendants, classificationKey, classificationNavigationEnabled } from '../../../shared/deliveryClassification.mjs'
import { compoundColumns } from '../../../shared/deliveryPresentation.mjs'
const matchMode = ref('exact'), massTolerance = ref(0.1)
const trashOpen = ref(false)
const personalOpen = ref(false), source = ref(''), advancedOpen = ref(false), q1 = ref(''), q3 = ref(''), polarity = ref<number | ''>(''), applied = ref<any>({}), matchedIds = ref<string[]>([])
const selectedCategory = ref('');const customerTable=ref()
const expandedCategoryKeys=ref<string[]>([])
function rememberCategory(node:any,expanded:boolean):void{const keys=new Set(expandedCategoryKeys.value);if(expanded)keys.add(node.key);else keys.delete(node.key);expandedCategoryKeys.value=[...keys]}
function clickCategory(data:any,node:any):void{if(node?.childNodes?.length){if(node.expanded)node.collapse();else node.expand();rememberCategory(data,node.expanded)}void chooseCategory(data)}
const props = defineProps<{ session: any; offline?: any }>()
const releases = ref<any[]>([]), releaseId = ref(''), records = ref<any[]>([]), total = ref(0), page = ref(1), keyword = ref(''), abnormal = ref(false), busy = ref(false), error = ref(''), detail = ref<any>(), selected = ref<any[]>([])
const manifest = computed(() => releases.value.find(r => r.id === releaseId.value))
type CompoundGroup = { id: string; name: string; recordIds: string[] }
const groupsEnabled = computed(() => manifest.value?.policy.features.groups === true)
const groups = ref<CompoundGroup[]>([]), groupId = ref('')
const activeGroup = computed(() => groupsEnabled.value ? groups.value.find(group => group.id === groupId.value) : undefined)
const groupPicker = ref<'add' | 'rename'>(), destinationGroup = ref(''), newGroupName = ref('')
const columns = computed(() => {
  const ids=manifest.value?.policy.presentation?.listFields;if(ids?.length)return ids.filter((id:string)=>id.startsWith('compound.')).map((id:string)=>id.slice(9))
  const summary = manifest.value?.compoundDisplay
  const known = source.value ? summary?.sources?.[source.value] : summary?.all
  return known || compoundColumns(records.value, manifest.value?.policy.fields.compound || [])
})
const currentTitle = computed(() => source.value ? manifest.value?.sources?.find((s: any) => (s.sourceKey || s.displayName) === source.value)?.displayName : manifest.value?.title)
const searchPlaceholder = computed(() => '搜索' + [columns.value.includes('main_name') ? '名称' : '', columns.value.includes('name_en') ? '英文名' : '', columns.value.includes('cas') ? 'CAS号' : '', columns.value.includes('formula') ? '分子式' : ''].filter(Boolean).join('、'))
const classification = ref<{nodes:any[];catalog:any[];unclassified:number}>()
const categoryNodes = computed(() => classification.value?.nodes || [])
const categoryCatalog = computed(() => classification.value?.catalog || [])
const unclassifiedCount = computed(() => classification.value?.unclassified || 0)
const classificationEnabled = computed(() => classificationNavigationEnabled(manifest.value?.policy))
watch(classificationEnabled,enabled=>{if(!enabled)selectedCategory.value=''})
const categoryName = computed(() => selectedCategory.value === '@pending' ? '未分类' : (categoryCatalog.value as any[]).find((c: any) => classificationKey(c) === selectedCategory.value)?.category_name || '')
async function chooseCategory(node: any): Promise<void> { if (!classificationEnabled.value || node.key.startsWith('axis:')) return; selectedCategory.value = node.key; personalOpen.value = false; page.value = 1; await load() }
const scopedRecordIds = computed(() => {
  const ids = activeGroup.value?.recordIds
  if (!favoriteOnly.value) return ids
  if (!ids) return favorites.value
  const members = new Set(ids)
  return favorites.value.filter(id => members.has(id))
})
const draftQuery = (): any => queryOptions({ ...(selectedCategory.value === '@pending' ? { unclassified: true } : selectedCategory.value ? { categoryKeys: classificationDescendants(categoryCatalog.value, selectedCategory.value) } : {}), keyword: keyword.value, source: source.value, abnormal: abnormal.value, q1: q1.value, q3: q3.value, polarity: polarity.value, massTolerance: matchMode.value === 'tolerance' ? massTolerance.value : 0, ...(scopedRecordIds.value ? { recordIds: scopedRecordIds.value } : {}) })
const pendingQuery = computed(() => { try { return JSON.stringify(draftQuery()) !== JSON.stringify(applied.value) } catch { return true } })
const scopeName = computed(() => {
  const title = manifest.value?.sources?.find((s: any) => (s.sourceKey || s.displayName) === applied.value.source)?.displayName || '当前交付全部数据库'
  return [activeGroup.value?.name, favoriteOnly.value ? '收藏' : '', title].filter(Boolean).join(' · ')
})
const exportCount = computed(() => exportFormat.value === 'msldelivery' ? manifest.value?.total || 0 : exportSelection.value ? selected.value.length : total.value)
const personalAllowed = computed(() => true)
const personalExport = computed(() => true)
watch(personalAllowed, allowed => { if (!allowed) personalOpen.value = false })
const exportVisible = ref(false), exportFormat = ref('json'), exportFields = ref<string[]>([]), exportSelection = ref(false), exportDetails = ref(false)
watch(exportFormat,format=>{if(format==='sql'&&!exportFields.value.includes('main_name'))exportFields.value.push('main_name')})
let generation = 0, refreshTimer: ReturnType<typeof setInterval> | undefined, live = true, refreshing = false
const localTenant = computed(() => props.session.profile?.tenantId || props.offline?.tenantId || props.session.user?.tenantId)
const groupStorageKey = computed(() => groupsEnabled.value && localTenant.value && releaseId.value
  ? `masspec.delivery.groups:${localTenant.value}:${releaseId.value}` : '')
watch(groupStorageKey, key => {
  groupId.value = ''
  groupPicker.value = undefined
  try {
    const saved = key ? JSON.parse(localStorage.getItem(key) || '[]') : []
    groups.value = Array.isArray(saved) ? saved.filter(group => typeof group?.id === 'string' &&
      typeof group.name === 'string' && Array.isArray(group.recordIds) && group.recordIds.every(id => typeof id === 'string')) : []
  } catch { groups.value = [] }
}, { flush: 'sync' })
function saveGroups(next: CompoundGroup[]): boolean {
  if (!groupStorageKey.value) return false
  try {
    localStorage.setItem(groupStorageKey.value, JSON.stringify(next))
    groups.value = next
    return true
  } catch {
    ElMessage.error('无法保存本机分组')
    return false
  }
}
function openGroupPicker(mode: 'add' | 'rename'): void {
  destinationGroup.value = mode === 'rename' ? groupId.value : ''
  newGroupName.value = mode === 'rename' ? activeGroup.value?.name || '' : ''
  groupPicker.value = mode
}
async function submitGroup(): Promise<void> {
  if (!groupsEnabled.value || trashOpen.value) return
  const target = groups.value.find(group => group.id === destinationGroup.value)
  const name = newGroupName.value.trim()
  const renaming = groupPicker.value === 'rename'
  if (renaming && !target || !renaming && !selected.value.length) return
  if (renaming || !target) {
    if (!name || name.length > 80) return
    const normalized = name.normalize('NFKC').toLowerCase()
    if (groups.value.some(group => group !== target && group.name.normalize('NFKC').toLowerCase() === normalized)) {
      ElMessage.warning('已有同名分组')
      return
    }
  }
  const ids = selected.value.map(row => String(row.id))
  const next = target ? groups.value.map(group => group !== target ? group : renaming
    ? { ...group, name } : { ...group, recordIds: [...new Set([...group.recordIds, ...ids])] })
    : [...groups.value, { id: crypto.randomUUID(), name, recordIds: [...new Set(ids)] }]
  if (!saveGroups(next)) return
  groupPicker.value = undefined
  if (!renaming && activeGroup.value?.id === target?.id && target) await load()
}
async function removeGroupMembers(): Promise<void> {
  const group = activeGroup.value
  if (!group || !selected.value.length) return
  const ids = new Set(selected.value.map(row => String(row.id)))
  if (!saveGroups(groups.value.map(item => item === group ? { ...item, recordIds: item.recordIds.filter(id => !ids.has(id)) } : item))) return
  page.value = 1
  await load()
}
async function deleteGroup(): Promise<void> {
  const group = activeGroup.value, key = groupStorageKey.value
  if (!group) return
  try { await ElMessageBox.confirm(`删除本机分组「${group.name}」？化合物仍保留在交付库中。`, '删除分组', { type: 'warning' }) }
  catch { return }
  if (key !== groupStorageKey.value || !saveGroups(groups.value.filter(item => item.id !== group.id))) return
  await changeRelease()
}
const favoriteKey = computed(() => `masspec.delivery.favorites:${localTenant.value}:local:${releaseId.value}`)
const favorites = ref<string[]>([]), favoriteOnly = ref(false)
const visibleRecords = computed(() => records.value)
const methodFields = computed(() => manifest.value?.methodQueryFields || [])
function loadFavorites(): void {
  const read = (key: string): string[] => { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter(x => typeof x === 'string') : [] } catch { return [] } }
  const ids = new Set(read(favoriteKey.value))
  const oldKeys = [`masspec.delivery.favorites:${localTenant.value}:offline:${releaseId.value}`, `masspec.delivery.favorites:${localTenant.value}:${props.session.user?.id || 'offline'}:${releaseId.value}`]
  for (const key of oldKeys) {
    const marker = `${favoriteKey.value}:migrated:${key}`
    if (!localStorage.getItem(marker)) { for (const id of read(key)) ids.add(id); localStorage.setItem(marker, '1') }
  }
  favorites.value = [...ids]; localStorage.setItem(favoriteKey.value, JSON.stringify(favorites.value))
}
function favorite(row=detail.value): void { if (!row) return; const id = row.id; favorites.value = favorites.value.includes(id) ? favorites.value.filter(x => x !== id) : [...favorites.value, id]; localStorage.setItem(favoriteKey.value, JSON.stringify(favorites.value)) }
async function changeRecords(action: string, ids: string[]): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { const result = await invokeIPC('delivery:record-change', { action, ids }); if (result.changed) { detail.value = undefined; await load(); ElMessage.success('操作完成') } }
  catch(e) { error.value = String(e) } finally { busy.value = false }
}
async function call(method: string, route: string, body?: any): Promise<any> { return invokeIPC('delivery:call', method, route, body) }
async function refresh(): Promise<void> {
  if (!live || refreshing) return
  refreshing = true
  try {
    const result = props.offline ? [props.offline.manifest] : await call('GET', '/releases')
    if (!live) return
    const recovering = !!error.value
    releases.value = result
    if (!result.some((r: any) => r.id === releaseId.value)) {
      releaseId.value = result.find((r: any) => r.id === props.session.profile?.defaultReleaseId)?.id || result[0]?.id || ''
      await changeRelease()
    } else if (recovering) await load(true)
    error.value = ''
  } catch (e) { ++generation; error.value = String(e); detail.value = undefined; records.value = []; total.value = 0 }
  finally { refreshing = false }
}
async function changeRelease(nextSource = '', nextGroup = ''): Promise<void> { trashOpen.value = false; personalOpen.value = false; source.value = nextSource; groupId.value = nextGroup; selectedCategory.value = ''; classification.value = undefined; ++generation; detail.value = undefined; records.value = []; selected.value = []; page.value = 1; keyword.value = ''; abnormal.value = false; favoriteOnly.value = false; q1.value = ''; q3.value = ''; polarity.value = ''; matchMode.value = 'exact'; loadFavorites(); await load() }
async function load(useApplied = false): Promise<void> {
  const own = ++generation, id = releaseId.value
  selected.value = []
  if (!id) { records.value = []; total.value = 0; return }
  busy.value = true
  try {
    let result: any
    const query = useApplied ? applied.value : draftQuery()
    if (props.offline) result = await invokeIPC('delivery:offline-query', { ...query, page: page.value, trash: trashOpen.value })
    else result = await call('POST', `/releases/${encodeURIComponent(id)}/query`, { ...query, page: page.value, pageSize: 50 })
    if (own !== generation || !live) return
    if (props.offline) page.value = result.page
    classification.value = result.classification ? markRaw(result.classification) : undefined
    applied.value = query; matchedIds.value = result.matchedIds || []
    records.value = markRaw(result.rows); total.value = result.total; error.value = '';await nextTick();if(own===generation)customerTable.value?.setScrollTop(0)
  } catch (e) { if (own === generation) { error.value = String(e); records.value = []; total.value = 0; detail.value = undefined } }
  finally { if (own === generation) busy.value = false }
}
async function open(row: any): Promise<void> {
  const own = ++generation; busy.value = true; detail.value = undefined
  try { const result = props.offline ? await invokeIPC('delivery:offline-record', row.id) : await call('GET', `/releases/${releaseId.value}/records/${row.id}`); if (own === generation && live) detail.value = markRaw(result) }
  catch (e) { if (own === generation) ElMessage.error(String(e)) }
  finally { if (own === generation) busy.value = false }
}
async function review(value: any): Promise<void> {
  if (busy.value || !detail.value) return
  const current = detail.value
  busy.value = true
  try { if(props.offline)await invokeIPC('delivery:local-review',{...value,recordId:current.id});else await call('POST', `/releases/${releaseId.value}/review/${current.id}`, value); ElMessage.success('已记录复核意见'); await open(current) }
  catch (e) { ElMessage.error(String(e)) }
  finally { busy.value = false }
}
function showExport(): void { if (pendingQuery.value) { ElMessage.info('请先应用查询条件，再导出'); return }; exportFields.value = manifest.value?.policy.presentation?.mode==='table'?[...manifest.value.policy.fields.compound]:[...columns.value]; exportFormat.value = 'xlsx'; exportSelection.value = selected.value.length > 0; exportDetails.value = manifest.value?.policy.presentation?.mode==='table'; exportVisible.value = true }
async function exportData(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const recordIds = exportSelection.value ? selected.value.map(r => r.id) : applied.value.recordIds ? matchedIds.value : undefined
    if (recordIds && !recordIds.length && exportFormat.value !== 'msldelivery') throw new Error('当前范围没有可导出的记录')
    const result = await invokeIPC('delivery:export', { ...applied.value, releaseId: releaseId.value, format: exportFormat.value, fields: exportFields.value, recordIds, includeDetails: exportDetails.value, offline: !!props.offline })
    if (!result.cancelled) { ElMessage.success('导出完成'); exportVisible.value = false }
  } catch (e) { ElMessage.error(String(e)) }
  finally { busy.value = false }
}
async function sync(): Promise<void> { if (!props.offline) await refresh(); if (!error.value || props.offline) { await load(true); if (!error.value) ElMessage.success('已刷新授权目录和当前数据') } }
onMounted(async () => { await refresh(); if (!props.offline) refreshTimer = setInterval(() => { void refresh() }, 30000) })
onUnmounted(() => { live = false; ++generation; clearInterval(refreshTimer) })
</script>
<template>
  <div class="customer-workspace">
    <aside>
      <div class="sidebar-brand"><div><strong>数据工作区</strong><small>{{ session.profile?.customerName || '客户数据中心' }}</small></div></div>
      <div class="nav-caption">{{ offline ? '交付数据库' : '在线授权数据库' }}</div>
      <div v-for="r in releases" :key="r.id" class="release-group">
        <button class="dataset" :class="{ active: r.id === releaseId && !personalOpen && !source && !favoriteOnly && !activeGroup && !trashOpen }" @click="releaseId = r.id; changeRelease()"><strong>{{ r.title }}</strong><span>{{ r.total }} 条记录 · {{ r.sources?.length || 0 }} 个数据库</span></button>
        <button v-for="(s, i) in r.sources || []" :key="s.sourceKey || i" class="library-link" :class="{ active: !personalOpen && releaseId === r.id && source === (s.sourceKey || s.displayName) }" @click="releaseId = r.id; changeRelease(s.sourceKey || s.displayName)"><span class="library-icon">▤</span><span>{{ s.displayName }}</span><em>{{ s.count }}</em></button>
      </div>
      <section v-if="classificationEnabled" class="customer-category-browser"><div class="nav-caption">化合物分类</div><el-tree :data="categoryNodes" node-key="key" :expand-on-click-node="false" :auto-expand-parent="false" :default-expanded-keys="expandedCategoryKeys" @node-expand="data=>rememberCategory(data,true)" @node-collapse="data=>rememberCategory(data,false)" :props="{ label: 'label', children: 'children' }" @node-click="clickCategory" /><button class="library-link" :class="{ active: selectedCategory === '@pending' }" @click="chooseCategory({key:'@pending'})">未分类 <em>{{ unclassifiedCount }}</em></button></section>
      <button v-if="manifest?.policy.features.favorite" class="library-link" :class="{ active: favoriteOnly && !personalOpen }" @click="personalOpen = false; trashOpen = false; groupId = ''; favoriteOnly = true; source = ''; selectedCategory = ''; page = 1; load()">我的收藏 <em>{{ favorites.length }}</em></button><div v-if="personalAllowed" class="personal-nav"><div class="nav-caption">我的工作区</div><button class="dataset" :class="{ active: personalOpen }" @click="personalOpen = true"><strong>我的数据</strong><span>导入本机数据 · 与共享库独立保存</span></button></div>
      <section v-if="groupsEnabled && groups.length">
        <div class="nav-caption">本机化合物分组</div>
        <button v-for="group in groups" :key="group.id" class="library-link" :class="{ active: !personalOpen && group.id === groupId }"
          @click="changeRelease('', group.id)"><span>{{ group.name }}</span><em>{{ group.recordIds.length }}</em></button>
      </section>
      <button v-if="offline && (manifest?.policy.features.deleteRecords || manifest?.policy.features.restoreRecords)" class="library-link" :class="{ active: trashOpen && !personalOpen }" @click="personalOpen = false; trashOpen = !trashOpen; groupId = ''; detail = undefined; selectedCategory = ''; favoriteOnly = false; source = ''; keyword = ''; page = 1; load()">{{ trashOpen ? '返回交付数据库' : '本机回收站' }}</button><div class="sidebar-footer"><el-button v-if="!offline" :disabled="busy" @click="sync">同步授权目录</el-button><p>{{ offline ? '已验证签名的离线交付' : '仅展示管理员向当前账号发布的内容' }}</p></div>
    </aside>
    <main v-if="personalOpen"><DeliveryPersonal :key="localTenant" :can-export="personalExport" :features="manifest?.policy.features" :policy="manifest?.policy" /></main>
    <main v-else v-loading="busy">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <DeliveryRecord v-if="detail && manifest" :key="`${releaseId}:${detail.id}`" :record="detail" :manifest="detailManifest(manifest)" :offline="!!offline" :favorite="favorites.includes(detail.id)" @close="detail = undefined; ++generation; if (favoriteOnly) load()" @favorite="favorite" @review="review" />
      <template v-else-if="manifest">
        <div class="workspace-heading">
          <div class="heading-copy"><h2>{{ trashOpen ? '本机回收站' : activeGroup ? activeGroup.name : favoriteOnly ? '我的收藏' : currentTitle }}</h2><span v-if="categoryName">{{ categoryName }}</span></div>
          <div class="result-summary"><strong>{{ total }}</strong> 条记录<span class="summary-divider">/</span>{{ manifest.sources?.length || 0 }} 个库</div>
        </div>
        <div class="customer-toolbar">
          <el-input v-model="keyword" clearable :placeholder="searchPlaceholder" aria-label="搜索化合物" @clear="page = 1; load()" @keyup.enter="page = 1; load()" />
          <el-button type="primary" :disabled="busy" @click="page = 1; load()">搜索</el-button>
          <el-select v-if="manifest.sources?.length > 1" v-model="source" clearable placeholder="当前交付全部数据库" aria-label="数据库范围" @change="page = 1; load()"><el-option v-for="(s, i) in manifest.sources || []" :key="s.sourceKey || i" :value="s.sourceKey || s.displayName" :label="s.displayName" /></el-select>
          <el-button :disabled="busy" @click="keyword = ''; q1 = ''; q3 = ''; polarity = ''; matchMode = 'exact'; abnormal = false; selectedCategory = ''; page = 1; load()">清空筛选</el-button>
          <el-checkbox v-if="manifest.policy.features.checks" v-model="abnormal" @change="page = 1; load()">仅异常</el-checkbox>
          <el-checkbox v-if="manifest.policy.features.favorite" v-model="favoriteOnly" @change="page = 1; load()">仅收藏</el-checkbox><el-button v-if="methodFields.length" @click="advancedOpen = !advancedOpen">高级查询</el-button>
          <el-button v-if="groupsEnabled && !trashOpen" :disabled="busy || !selected.length" @click="openGroupPicker('add')">加入分组</el-button>
          <template v-if="activeGroup">
            <el-button :disabled="busy || !selected.length" @click="removeGroupMembers">移出分组</el-button>
            <el-dropdown trigger="click" @command="action => action === 'rename' ? openGroupPicker('rename') : deleteGroup()">
              <el-button>管理分组</el-button>
              <template #dropdown><el-dropdown-menu><el-dropdown-item command="rename">重命名</el-dropdown-item><el-dropdown-item command="delete">删除分组</el-dropdown-item></el-dropdown-menu></template>
            </el-dropdown>
          </template>
          <el-button v-if="manifest.policy.features.export && !trashOpen" class="export-action" :disabled="busy || !visibleRecords.length || pendingQuery" @click="showExport">导出</el-button>
        </div>
        <div v-if="advancedOpen && methodFields.length" class="advanced-query">
          <label v-if="methodFields.includes('q1')">母离子 <el-input v-model="q1" placeholder="如184" @keyup.enter="page = 1; load()" /></label>
          <label v-if="methodFields.includes('q3')">子离子 <el-input v-model="q3" placeholder="如143" @keyup.enter="page = 1; load()" /></label>
          <label v-if="methodFields.includes('polarity')">极性 <el-select v-model="polarity" clearable placeholder="全部"><el-option label="正离子" :value="1" /><el-option label="负离子" :value="0" /></el-select></label>
          <el-button type="primary" @click="page = 1; load()">应用条件</el-button><label>匹配 <el-select v-model="matchMode"><el-option value="exact" label="精确" /><el-option value="tolerance" label="容差" /></el-select></label><label v-if="matchMode === 'tolerance'">± <el-input-number v-model="massTolerance" :min="0" :max="10" :step="0.1" :precision="4" /> Da</label><span>多个条件须匹配同一通道</span>
        </div>
        <div v-if="offline && (manifest.policy.features.deleteRecords || trashOpen)" class="record-actions"><span>{{ trashOpen ? '只管理当前 Windows 用户的本机工作区，安装包及服务器数据保持原样。' : '删除仅影响本机，可在回收站恢复。' }}</span><el-button v-if="!trashOpen && manifest.policy.features.deleteRecords" type="danger" plain :disabled="!selected.length || busy" @click="changeRecords('delete', selected.map(r => r.id))">删除所选</el-button><template v-if="trashOpen"><el-button v-if="manifest.policy.features.restoreRecords" :disabled="!selected.length || busy" @click="changeRecords('restore', selected.map(r => r.id))">恢复所选</el-button><el-button v-if="manifest.policy.features.purgeRecords" type="danger" plain :disabled="!selected.length || busy" @click="changeRecords('purge', selected.map(r => r.id))">彻底删除所选</el-button></template></div><div class="query-context"><span>查询范围：{{ scopeName }}{{ categoryName ? ' · ' + categoryName : '' }}</span><span v-if="pendingQuery" class="pending-query">条件未应用，请点击搜索；导出暂不可用</span><span v-else>勾选限当前页，翻页后清空</span></div>
        <FlatFieldsTable v-if="manifest.policy.presentation?.mode==='table'||manifest.policy.presentation?.listFields?.length" :details="manifest.policy.presentation?.mode!=='table'" @open="open" :records="visibleRecords" :manifest="manifest" :selectable="groupsEnabled && !trashOpen || manifest.policy.features.export || (!!offline && (manifest.policy.features.deleteRecords || trashOpen))" @selection="rows=>selected=rows"><template v-if="manifest.policy.features.favorite" #actions="{row}"><el-button link @click="favorite(row)">{{favorites.includes(row.id)?'取消收藏':'收藏'}}</el-button></template></FlatFieldsTable><el-table v-else ref="customerTable" stripe :data="visibleRecords" height="100%" row-key="id" @row-dblclick="open" @cell-click="(row,column)=>column.property==='compound.main_name'&&open(row)" @selection-change="(rows: any[]) => selected = rows">
          <el-table-column v-if="groupsEnabled && !trashOpen || manifest.policy.features.export || (offline && (manifest.policy.features.deleteRecords || trashOpen))" type="selection" width="40" />
          <el-table-column v-for="key in columns" :key="key" :prop="'compound.'+key" :fixed="key==='main_name'?'left':undefined" :label="manifest.fieldLabels?.compound?.[key] || key" :min-width="key === 'main_name' || key === 'name_en' ? 200 : 130" show-overflow-tooltip><template #default="scope">{{ scope.row.compound[key] ?? '—' }}</template></el-table-column>
          <el-table-column v-if="!source && manifest.sources?.length > 1" prop="sourceTitle" label="所属数据库" min-width="160" show-overflow-tooltip />
          <el-table-column :width="offline && (manifest.policy.features.deleteRecords || trashOpen) ? 190 : 76" label="操作" fixed="right"><template #default="scope"><el-button link type="primary" @click="open(scope.row)">查看</el-button><el-button v-if="offline && !trashOpen && manifest.policy.features.deleteRecords" link type="danger" @click="changeRecords('delete', [scope.row.id])">删除</el-button><template v-if="offline && trashOpen"><el-button v-if="manifest.policy.features.restoreRecords" link @click="changeRecords('restore', [scope.row.id])">恢复</el-button><el-button v-if="manifest.policy.features.purgeRecords" link type="danger" @click="changeRecords('purge', [scope.row.id])">彻底删除</el-button></template></template></el-table-column>
          <template #empty><el-empty :description="favoriteOnly ? '当前范围没有收藏记录' : '没有符合当前筛选条件的记录'" :image-size="65" /></template>
        </el-table>
        <div class="list-footer"><span v-if="selected.length">已选 {{ selected.length }} 条</span><span v-else>{{manifest.policy.presentation?.mode==='table'?'左右滑动查看所选字段':'双击记录可查看详情'}}</span><el-pagination v-model:current-page="page" :page-size="50" :total="total" layout="total, prev, pager, next" @current-change="load(true)" /></div>
      </template>
      <el-empty v-else-if="!error" description="当前账号尚未获得数据集授权，请联系管理员" />
    </main>
    <el-dialog :model-value="!!groupPicker" :title="groupPicker === 'rename' ? '重命名分组' : '加入分组'"
      width="min(420px,90vw)" append-to-body @close="groupPicker = undefined">
      <el-form label-position="top" @submit.prevent="submitGroup">
        <el-form-item v-if="groupPicker === 'add' && groups.length" label="目标分组">
          <el-select v-model="destinationGroup" aria-label="目标分组"><el-option label="新建分组" value="" />
            <el-option v-for="group in groups" :key="group.id" :value="group.id" :label="group.name" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="groupPicker === 'rename' || !destinationGroup" label="分组名称">
          <el-input v-model="newGroupName" maxlength="80" placeholder="输入分组名称" />
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="groupPicker = undefined">取消</el-button>
        <el-button type="primary" :disabled="(groupPicker === 'rename' || !destinationGroup) && !newGroupName.trim()" @click="submitGroup">保存</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="exportVisible" title="导出授权内容" width="640px" :close-on-click-modal="false"><el-form label-width="100px"><el-alert :title="`本次导出 ${exportCount} 条记录 · ${exportFormat === 'msldelivery' ? '完整交付范围' : scopeName}`" type="info" :closable="false" /><el-form-item label="格式"><el-select v-model="exportFormat"><el-option label="JSON" value="json" /><el-option label="CSV" value="csv" /><el-option label="Excel" value="xlsx" /><el-option label="SQL（SQLite文件库）" value="sql" /><el-option v-if="manifest?.policy.features.offline" label="签名离线交付文件（完整交付范围）" value="msldelivery" /></el-select></el-form-item><template v-if="exportFormat !== 'msldelivery'"><el-form-item label="记录范围"><el-radio-group v-model="exportSelection"><el-radio :value="false">{{ applied.recordIds ? '当前筛选结果' : '当前库的搜索结果' }}</el-radio><el-radio :value="true" :disabled="!selected.length">本页勾选记录</el-radio></el-radio-group></el-form-item><el-alert v-if="manifest?.policy.presentation?.mode==='table' && ['csv','xlsx'].includes(exportFormat)" title="按已配置的全部表格字段和列顺序导出。" type="info" :closable="false" /><el-form-item v-else label="基本字段"><el-checkbox-group v-model="exportFields"><el-checkbox v-for="k in columns" :key="k" :value="k" :disabled="exportFormat==='sql'&&k==='main_name'">{{ manifest.fieldLabels?.compound?.[k] || k }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="manifest?.policy.presentation?.mode!=='table' || !['csv','xlsx'].includes(exportFormat)" label="关联内容"><el-checkbox v-model="exportDetails">包含已交付的质谱方法、液相、谱图及检查快照（Excel分表，CSV按记录类型展开）</el-checkbox></el-form-item></template><el-alert v-if="exportFormat === 'msldelivery'" title="此格式包含完整授权快照，已导出的文件无法远程收回。" type="info" :closable="false" /></el-form><template #footer><el-button :disabled="busy" @click="exportVisible = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="exportFormat !== 'msldelivery' && !exportFields.length" @click="exportData">导出</el-button></template></el-dialog>
  </div>
</template>
<style scoped>
.customer-workspace { display: flex; flex: 1; min-height: 0; overflow: hidden; background: #f4f6fa; color: #26374b; }
aside { width: 226px; flex: none; background: #fff; padding: 16px 12px; display: flex; flex-direction: column; overflow: auto; border-right: 1px solid #e6ebf2; }
main { flex: 1; min-width: 0; min-height: 0; padding: 16px 18px 10px; display: flex; flex-direction: column; overflow: hidden; background: #fff; margin: 10px; border: 1px solid #e7edf4; border-radius: 9px; }
.sidebar-brand { display: flex; gap: 10px; align-items: center; margin: 2px 6px 18px; }.brand-mark { display: grid; place-items: center; flex: none; width: 34px; height: 34px; border-radius: 9px; color: #fff; background: #3679ee; font-size: 22px; font-weight: 700; }.sidebar-brand strong,.sidebar-brand small { display: block; }.sidebar-brand small { margin-top: 5px; color: #8794a7; font-size: 11px; overflow-wrap: anywhere; }
.nav-caption { color: #8b96a7; font-size: 11px; margin: 8px 10px; }.release-group { margin-bottom: 12px; }
.dataset { width: 100%; display: flex; flex-direction: column; gap: 6px; text-align: left; border: 0; border-radius: 7px; padding: 12px; margin-bottom: 4px; cursor: pointer; color: #28384e; background: #f8faff; overflow-wrap: anywhere; }.dataset.active { color: #2871e8; background: #eaf2ff; }.dataset span { font-size: 11px; color: #7a899c; line-height: 1.5; }
.library-link { display: flex; width: 100%; gap: 8px; align-items: center; border: 0; border-radius: 6px; padding: 10px 8px 10px 16px; background: transparent; color: #536379; cursor: pointer; text-align: left; }.library-link:hover,.library-link.active { color: #2871e8; background: #edf4ff; }.library-link span:nth-child(2) { flex: 1; overflow-wrap: anywhere; font-size: 12px; }.library-link em { font-style: normal; font-size: 11px; background: #eef1f6; padding: 2px 5px; border-radius: 4px; }
.sidebar-footer { margin-top: auto; padding: 16px 8px 0; color: #93a0b2; font-size: 11px; line-height: 1.6; }.personal-nav { margin-top: 12px; border-top: 1px solid #edf0f5; }
.workspace-heading { display: flex; flex: none; align-items: center; justify-content: space-between; gap: 14px; min-height: 34px; margin-bottom: 10px; }.heading-copy { min-width: 0; display: flex; align-items: baseline; gap: 14px; }.heading-copy h2 { margin: 0; font-size: 19px; font-weight: 600; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.heading-copy > span { font-size: 11px; color: #8895a6; white-space: nowrap; }.result-summary { font-size: 12px; color: #7a889b; white-space: nowrap; }.result-summary strong { color: #2871e8; font-size: 17px; margin-right: 4px; }.summary-divider { color: #c8d0dc; padding: 0 10px; }
.customer-toolbar { display: flex; flex: none; align-items: center; gap: 8px; padding: 9px 10px; margin-bottom: 10px; background: #f8faff; border: 1px solid #edf1f7; border-radius: 7px; }.customer-toolbar .el-input { flex: 1; min-width: 150px; max-width: 320px; }.customer-toolbar .el-select { width: 190px; flex: none; }.customer-toolbar :deep(.el-button + .el-button) { margin-left: 0; }.customer-toolbar .el-checkbox { margin-right: 0; font-size: 12px; }.export-action { margin-left: auto !important; }
.el-table { flex: 1; min-height: 0; font-size: 13px; }.customer-workspace :deep(.el-table th.el-table__cell) { background: #f5f7fb; color: #66768d; font-weight: 500; padding: 7px 0; }.customer-workspace :deep(.el-table td.el-table__cell) { padding: 4px 0; height: 36px; }.customer-workspace :deep(.el-table .cell) { padding-left: 10px; padding-right: 10px; line-height: 22px; }.customer-workspace :deep(.el-table .el-button) { min-height: 24px; padding: 3px 6px; }
.list-footer { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 8px; font-size: 11px; color: #96a1b0; }.list-footer .el-pagination { flex: none; margin: 0; }
@media(max-width:1150px) { aside { width: 202px; } main { padding: 12px; margin: 8px; }.customer-toolbar .el-select { width: 164px; } .customer-toolbar { flex-wrap: wrap; }.heading-copy > span { display: none; } }
@media(max-width:850px) { aside { width: 180px; }.customer-toolbar { flex-wrap: wrap; }.customer-toolbar .el-input { max-width: none; }.result-summary { font-size: 11px; }.summary-divider { padding: 0 5px; }.list-footer > span { display: none; } }
.advanced-query { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:0 0 10px; font-size:12px; }.advanced-query label { display:flex;align-items:center;gap:8px; }.advanced-query .el-input,.advanced-query .el-select { width:110px; }.advanced-query > span { color:#8390a1; }

aside { width:220px;padding:14px 10px;border-color:#e2e9f2; }
main { border-color:#e2e9f2;border-radius:9px;margin:10px;padding:14px 16px 10px; }
.sidebar-brand { margin:2px 10px 14px; }.sidebar-brand strong { font-size:14px;font-weight:600; }.sidebar-brand small { font-size:11px;color:#78889c; }
.nav-caption { margin:8px 10px;font-size:11px; }.dataset { padding:10px 12px;gap:5px;background:#f7f9fc;border-radius:7px; }.dataset strong { font-size:12px;line-height:1.6;font-weight:500; }.dataset.active { background:#edf4ff;color:#2f6fe4; }
.library-link { padding:9px 10px 9px 14px; }.library-link span:nth-child(2) { font-size:12px; }.library-link em { font-variant-numeric:tabular-nums; }
.workspace-heading { margin-bottom:8px; }.heading-copy h2 { font-size:19px;font-weight:600; }.result-summary strong { font-size:18px;font-variant-numeric:tabular-nums; }
.customer-toolbar { padding:8px 10px;background:#f7f9fc;border-color:#e8edf4;gap:7px; }.customer-toolbar :deep(.el-button),.customer-toolbar :deep(.el-checkbox__label) { font-size:12px; }.customer-toolbar .el-select { width:190px; }
.list-footer { color:#8290a2; }.personal-nav { margin-top:14px;padding-top:4px; }
@media(max-width:1150px) { aside { width:196px; } main { margin:8px;padding:12px; }.customer-toolbar { flex-wrap:wrap; }.customer-toolbar .el-select { width:164px; } }
@media(max-width:850px) { aside { width:174px; } }

.query-context { display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between;flex:none;padding-bottom:6px;color:#8290a2;font-size:11px; }.pending-query { color:#b7731c; }.advanced-query .el-input-number { width:130px; }
</style>

<style scoped>.record-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}.record-actions>span{flex:1;font-size:12px;color:#7a889b;min-width:180px}.record-actions .el-button+.el-button{margin-left:0}.customer-toolbar{flex-wrap:wrap}.customer-toolbar .el-input{min-width:180px}</style>
