<script setup lang="ts">
import { ref, computed, onMounted, watch,nextTick,markRaw } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { classificationTree,classificationDescendants,classificationKey } from '../../../shared/deliveryClassification.mjs'
import FlatFieldsTable from './FlatFieldsTable.vue'
import DeliveryRecord from './DeliveryRecord.vue'
import {compoundColumns} from '../../../shared/deliveryPresentation.mjs'
import {personalHeaders,personalDisplayPolicy} from '../../../shared/displayLayout.mjs'

import { queryOptions, matchesQuery, methodColumns } from '../../../shared/deliveryQuery.mjs'

const props=defineProps<{ canExport?: boolean; features?: Record<string,boolean>;policy?:any }>()
const personalTable=ref()
const recordTrash = ref<any[]>([])
const batches = ref<any[]>([]), batchId = ref(''), loaded = ref<any[]>([]), detail = ref<any>(), keyword = ref(''), page = ref(1), busy = ref(false), error = ref(''), preview = ref<any>(), previewOpen = ref(false)
const canImport = ref(false), importIssue = ref(''), trashOpen = ref(false), trashBatches = ref<any[]>([])
const matchMode = ref('exact'), massTolerance = ref(0.1)
const q1 = ref(''), q3 = ref(''), polarity = ref<number | ''>(''), advancedOpen = ref(false), applied = ref<any>({})
const data = computed(() => {
  const views = loaded.value.filter(v => !batchId.value || v.manifest.id === batchId.value)
  if (!views.length) return undefined
  return { manifest: { ...views[0].manifest, title: batchId.value ? views[0].manifest.title : '我的全部数据' }, records: views.flatMap(v => v.records.map((r: any) => ({ ...r, batchTitle: v.manifest.title }))) }
})
const configuredHeaders=computed(()=>!props.policy?personalHeaders:personalDisplayPolicy({...props.policy,presentation:{mode:'table'}},data.value?.records||[]).fields.personal)
const damagedBatches = computed(() => batches.value.filter(b => b.damaged))
const selectedCategory=ref('')
watch(()=>props.features?.classification,enabled=>{if(enabled===false){selectedCategory.value='';search()}})
const categoryNodes=computed(()=>classificationTree(data.value?.records||[],{navigationDepth:props.policy?.classification?.navigationDepth}))
const categoryCatalog=computed(()=>[...new Map((data.value?.records||[]).flatMap((r:any)=>r.classification?.catalog||[]).map((c:any)=>[classificationKey(c),c])).values()])
const draftQuery = (): any => queryOptions({...(selectedCategory.value?{categoryKeys:classificationDescendants(categoryCatalog.value,selectedCategory.value)}:{}), keyword: keyword.value, q1: q1.value, q3: q3.value, polarity: polarity.value, massTolerance: matchMode.value === 'tolerance' ? massTolerance.value : 0 })
const pendingQuery = computed(() => { try { return JSON.stringify(draftQuery()) !== JSON.stringify(applied.value) } catch { return true } })
const matches = computed(() => (data.value?.records || []).filter((r: any) => matchesQuery(r, applied.value)))

const columns=computed(()=>compoundColumns(data.value?.records||[],data.value?.manifest?.policy?.fields?.compound||[]))
const methodFields = computed(() => methodColumns(data.value?.records || [], ['q1','q3','polarity']))
const rows = computed(() => matches.value.slice((page.value - 1) * 50, page.value * 50))
watch(rows,async()=>{const current=rows.value;await nextTick();if(current===rows.value)personalTable.value?.setScrollTop(0)})
async function perform(fn: () => Promise<void>): Promise<void> { if (busy.value) return; busy.value = true; error.value = ''; try { await fn() } catch (e) { error.value = String(e) } finally { busy.value = false } }
function search(): void { try { applied.value = draftQuery(); page.value = 1; error.value = '' } catch(e) { error.value = String(e) } }
function reset(): void { selectedCategory.value=''; keyword.value = ''; q1.value = ''; q3.value = ''; polarity.value = ''; matchMode.value = 'exact'; search() }
async function refresh(preferred?: string): Promise<void> {
  batches.value = await invokeIPC('delivery:personal-list')
  if (preferred) batchId.value = preferred
  if (!batches.value.some(b => b.id === batchId.value)) batchId.value = ''
  const availability = await invokeIPC('delivery:personal-status'); canImport.value = availability.canImport; importIssue.value = availability.issue
  const results = await Promise.allSettled(batches.value.filter(b => !b.damaged).map(async b => { try { return await invokeIPC('delivery:personal-read', b.id) } catch(e) { b.damaged = true; b.issue = String(e); throw e } }))
  loaded.value = results.flatMap(r => r.status === 'fulfilled' ? [markRaw(r.value)] : [])
  trashBatches.value = await invokeIPC('delivery:personal-trash')
  recordTrash.value = await invokeIPC('delivery:personal-record-trash')
  detail.value = undefined; reset()
}
async function prepare(): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-prepare'); if (!result.cancelled) { preview.value = result; previewOpen.value = true } }) }
async function commit(): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-commit', preview.value.id); previewOpen.value = false; await refresh(result.id); ElMessage.success(result.duplicate ? '此文件已导入，已打开原有批次' : '已导入本机我的数据') }) }
async function remove(): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-remove', batchId.value); if (result.removed) await refresh() }) }
async function rename(): Promise<void> {
  try { const current = batches.value.find(b => b.id === batchId.value); const result = await ElMessageBox.prompt('填写新的批次名称', '重命名批次', { inputValue: current.filename, inputValidator: v => !!v?.trim() && v.trim().length <= 120 || '名称应为1–120字' }); await perform(async () => { await invokeIPC('delivery:personal-rename', batchId.value, result.value); await refresh(batchId.value); ElMessage.success('批次已重命名') }) } catch(e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) }
}
async function backup(): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-export', batchId.value); if (result.saved) ElMessage.success('当前完整批次已备份') }) }
async function exportQuery(format: string): Promise<void> { if (pendingQuery.value) { ElMessage.info('请先应用查询条件，再导出'); return }; await perform(async () => { const result = await invokeIPC('delivery:personal-export-query', { format, headers:configuredHeaders.value,recordIds: matches.value.map((r: any) => r.id) }); if (result.saved) ElMessage.success(`已导出 ${matches.value.length} 条查询结果`) }) }
async function template(): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-template',{headers:configuredHeaders.value}); if (result.saved) ElMessage.success('模板已保存，填写后即可导入') }) }
async function restoreBatch(id: string): Promise<void> { await perform(async () => { await invokeIPC('delivery:personal-restore', id); await refresh(id); trashOpen.value = false; ElMessage.success('批次已恢复') }) }
async function rawBackup(id: string, trashed = false): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-backup-raw', id, trashed); if (result.saved) ElMessage.success('已备份原文件') }) }
async function purgeBatch(id: string): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-purge', id); if (result.removed) { await refresh(); ElMessage.success('已永久删除') } }) }
async function removeDamaged(id: string): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-remove', id); if (result.removed) await refresh() }) }
async function changeRecord(row: any, action: string): Promise<void> { await perform(async () => { const result = await invokeIPC('delivery:personal-record-change', { batchId: row.batchId || row.id.split(':')[0], ids: [row.id], action }); if(result.changed) { await refresh(); ElMessage.success('操作完成') } }) }
function cancel(): void { previewOpen.value = false; void invokeIPC('delivery:personal-cancel') }
onMounted(() => perform(() => refresh()))
</script>
<template>
  <section class="personal-workspace" v-loading="busy">
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <DeliveryRecord v-if="policy?.presentation?.mode!=='table' && detail && data && !trashOpen" :record="detail" :manifest="data.manifest" @close="detail=undefined" />
    <template v-else>
      <div class="personal-heading"><h2>{{ trashOpen ? '个人回收站' : '我的数据' }}</h2><span>{{ batches.length }} 个批次 · {{ data?.records.length || 0 }} 条记录</span></div>
      <p class="storage-notice">保存在本机当前 Windows 用户的客户工作区，无需联网，不修改交付数据库。独立于内置交付数据保存；更换电脑前请备份。</p>
      <el-alert v-if="importIssue" :title="importIssue" type="info" :closable="false" />
      <div v-if="damagedBatches.length && !trashOpen" class="damaged-batches"><div v-for="b in damagedBatches" :key="b.id"><span>{{ b.filename }}：此批次无法读取，其他批次可继续使用</span><el-button link @click="rawBackup(b.id)">备份原文件</el-button><el-button v-if="features?.personalDelete" link type="danger" @click="removeDamaged(b.id)">移入个人回收站</el-button></div></div>
      <div class="personal-toolbar"><el-button @click="trashOpen = !trashOpen; detail = undefined">{{ trashOpen ? '返回我的数据' : `个人回收站（${trashBatches.length}）` }}</el-button><el-button type="primary" :disabled="busy || !canImport || trashOpen" @click="prepare">导入个人数据</el-button><el-button :disabled="busy || !canImport || trashOpen" @click="template">下载表格模板</el-button><el-select v-model="batchId" clearable placeholder="我的全部数据" :disabled="busy || trashOpen" @change="detail = undefined; reset()"><el-option v-for="b in batches" :key="b.id" :value="b.id" :disabled="b.damaged" :label="`${b.filename} · ${b.total} 条`" /></el-select><el-button :disabled="busy || !batchId || trashOpen" @click="rename">重命名</el-button><el-button v-if="canExport" :disabled="busy || !batchId || trashOpen" @click="backup">备份完整批次</el-button><el-button v-if="features?.personalDelete" type="danger" plain :disabled="busy || !batchId || trashOpen" @click="remove">删除批次</el-button></div>
      <el-table v-if="trashOpen" :data="trashBatches" stripe height="100%"><el-table-column prop="filename" label="批次名称" min-width="220" /><el-table-column label="记录"><template #default="s">{{ s.row.damaged ? '文件损坏' : s.row.total }}</template></el-table-column><el-table-column label="操作" width="230"><template #default="s"><el-button link @click="rawBackup(s.row.id, true)">备份原文件</el-button><el-button v-if="features?.personalRestore" link type="primary" @click="restoreBatch(s.row.id)">恢复</el-button><el-button v-if="features?.personalPurge" link type="danger" @click="purgeBatch(s.row.id)">删除</el-button></template></el-table-column><template #empty>个人回收站为空</template></el-table>
      <el-table v-if="trashOpen" :data="recordTrash" max-height="280" empty-text="没有删除的单条化合物"><el-table-column prop="compound.main_name" label="已删除的化合物" min-width="180" /><el-table-column prop="batchTitle" label="所属批次" min-width="180" /><el-table-column label="操作" width="180"><template #default="s"><el-button v-if="features?.personalRestore" link @click="changeRecord(s.row, 'restore')">恢复</el-button><el-button v-if="features?.personalPurge" link type="danger" @click="changeRecord(s.row, 'purge')">彻底删除</el-button></template></el-table-column></el-table>
      <template v-if="!trashOpen && data">
        <div class="personal-search"><el-tree-select v-if="features?.classification !== false && categoryNodes.length" v-model="selectedCategory" :data="categoryNodes" node-key="key" :props="{label:'label',children:'children',value:'key'}" clearable filterable check-strictly placeholder="分类筛选" @change="search" /><el-input v-model="keyword" clearable placeholder="查询名称、英文名、CAS或分子式" @keyup.enter="search" @clear="search" /><el-button type="primary" @click="search">查询</el-button><el-button @click="reset">清空条件</el-button><el-button v-if="methodFields.length" @click="advancedOpen = !advancedOpen">高级查询</el-button><el-dropdown v-if="canExport" @command="exportQuery"><el-button :disabled="!matches.length || pendingQuery">导出 {{ matches.length }} 条结果</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="xlsx">Excel</el-dropdown-item><el-dropdown-item command="csv">CSV</el-dropdown-item><el-dropdown-item command="json">JSON</el-dropdown-item><el-dropdown-item command="sql">SQL（SQLite文件库）</el-dropdown-item></el-dropdown-menu></template></el-dropdown></div>
        <div v-if="advancedOpen && methodFields.length" class="advanced-query"><label v-if="methodFields.includes('q1')">母离子<el-input v-model="q1" @keyup.enter="search" /></label><label v-if="methodFields.includes('q3')">子离子<el-input v-model="q3" @keyup.enter="search" /></label><label v-if="methodFields.includes('polarity')">极性<el-select v-model="polarity" clearable placeholder="全部"><el-option label="正离子" :value="1" /><el-option label="负离子" :value="0" /></el-select></label><el-button @click="search">应用条件</el-button><label>匹配<el-select v-model="matchMode"><el-option value="exact" label="精确" /><el-option value="tolerance" label="容差" /></el-select></label><label v-if="matchMode === 'tolerance'">±<el-input-number v-model="massTolerance" :min="0" :max="10" :step="0.1" :precision="4" /> Da</label><span>多个条件须匹配同一通道</span></div>
        <div class="query-context"><span>查询范围：{{ data.manifest.title }} · {{ matches.length }} 条结果</span><span v-if="pendingQuery" class="pending-query">条件未应用，请点击查询；导出暂不可用</span></div>
        <FlatFieldsTable v-if="policy?.presentation?.mode==='table'" :records="rows" :manifest="{...data.manifest,policy:personalDisplayPolicy(policy,data.records)}" ><template v-if="features?.personalDelete" #actions="{row}"><el-button link type="danger" @click="changeRecord(row,'delete')">删除</el-button></template></FlatFieldsTable>        <el-table v-else ref="personalTable" stripe :data="rows" height="100%" @row-dblclick="(r: any) => detail = r"><el-table-column v-for="key in columns" :key="key" :prop="`compound.${key}`" :label="data.manifest.fieldLabels?.compound?.[key] || key" min-width="160" show-overflow-tooltip /><el-table-column v-if="!batchId" prop="batchTitle" label="导入批次" min-width="160" show-overflow-tooltip /><el-table-column :width="features?.personalDelete ? 130 : 76" label="操作"><template #default="scope"><el-button link type="primary" @click="detail = scope.row">查看</el-button><el-button v-if="features?.personalDelete" link type="danger" @click="changeRecord(scope.row, 'delete')">删除</el-button></template></el-table-column></el-table><el-pagination v-model:current-page="page" :page-size="50" :total="matches.length" layout="total, prev, pager, next" />
      </template>
      <el-empty v-else-if="!trashOpen" description="还没有个人数据，可导入 .msldata / JSON 数据包，或使用 Excel / CSV 化合物模板" />
    </template>
    <el-dialog v-model="previewOpen" title="确认导入个人数据" width="800px" :close-on-click-modal="false" :show-close="false" :close-on-press-escape="false"><template v-if="preview"><p>{{ preview.filename }} · 共 {{ preview.total }} 个化合物（预览前50个）</p><el-alert v-if="preview.duplicate" title="此文件已导入，确认后打开已有批次，不重复保存。" type="warning" :closable="false" /><el-alert :title="preview.notice" type="info" :closable="false" /><el-table :data="preview.rows" max-height="320"><el-table-column v-for="h in [...new Set([...personalHeaders,...(preview.rows||[]).flatMap((r:any)=>Object.keys(r).filter(k=>/^MRM[0-9]+_|^碰撞能[0-9]+$/.test(k)))])]" :key="h" :prop="h" :label="h" width="180" show-overflow-tooltip /></el-table></template><template #footer><el-button :disabled="busy" @click="cancel">取消</el-button><el-button type="primary" :loading="busy" @click="commit">{{ preview?.duplicate ? '打开已有数据' : '确认导入本机' }}</el-button></template></el-dialog>
  </section>
</template>
<style scoped>
.personal-workspace { display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden; }.personal-heading { display:flex;align-items:center;justify-content:space-between;gap:12px; }.personal-heading h2 { margin:0;font-size:19px; }.personal-heading span,.storage-notice { color:#7c899a;font-size:12px;line-height:1.6; }.storage-notice { margin:10px 0; }.personal-toolbar,.personal-search,.advanced-query { display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px; }.personal-toolbar .el-select { width:220px; }.personal-toolbar :deep(.el-button + .el-button),.personal-search :deep(.el-button + .el-button) { margin-left:0; }.personal-search .el-input { max-width:360px;flex:1;min-width:180px; }.personal-workspace > .el-table { flex:1;min-height:0;font-size:13px; }.personal-workspace :deep(td.el-table__cell) { padding:4px 0;height:36px; }.el-pagination { margin-top:8px; }.advanced-query { font-size:12px; }.advanced-query label { display:flex;align-items:center;gap:8px; }.advanced-query .el-input,.advanced-query .el-select { width:110px; }.advanced-query > span { color:#8390a1; }
.query-context { display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:12px;color:#78889a;margin:0 0 8px; }.pending-query { color:#b7731c; }.damaged-batches { border:1px solid #f1dab6;background:#fffaf0;padding:8px 12px;margin:8px 0;font-size:12px; }.damaged-batches > div { display:flex;gap:12px;align-items:center;flex-wrap:wrap; }.personal-workspace > .el-alert { flex:none;margin:8px 0; }.advanced-query .el-input-number { width:130px; }
</style>

