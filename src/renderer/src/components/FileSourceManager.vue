<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { setSharedLibraryRemoved } from '../utils/removeLibrary'
import DeliveryRecord from './DeliveryRecord.vue'
const props = defineProps<{ formalLibraryIds?: string[] }>()
const emit = defineEmits<{ changed: []; "view-library": [id: string] }>()
const uploadRoot = ref(''), uploadMaxMiB = ref(0), usingServerFile = ref(false)
const progress = ref<{phase:string;sent:number;total:number}>()
const directory = ref(''), libraries = ref<any[]>([]), scanned = ref<any[]>([]), busy = ref(false), error = ref('')
const formatReport = ref<any>()
const detail = ref<any>()
const current = ref<any>(), rows = ref<any[]>([]), total = ref(0), page = ref(1), keyword = ref(''), trash = ref(false), revision = ref(''), selected = ref<any[]>([])
const call = (route: string, data?: any): Promise<any> => invokeIPC('delivery:call', data === undefined ? 'GET' : 'POST', '/admin/file-sources' + route, data)
async function perform(fn: () => Promise<void>): Promise<void> { if (busy.value) return; busy.value = true; error.value = ''; try { await fn() } catch(e) { error.value = String(e) } finally { busy.value = false } }
async function refresh(): Promise<void> {
  const result = await call('')
  uploadRoot.value = result.uploadRoot || ''
  uploadMaxMiB.value = (result.uploadMaxBytes || 0) / 1024 ** 2
  libraries.value = result.libraries
  emit('changed')
}
function updateProgress(_event: unknown, value: {phase:string;sent:number;total:number}): void {
  progress.value = value
}
function showServerFiles(): void {
  usingServerFile.value = !usingServerFile.value
  if (usingServerFile.value && !directory.value) directory.value = uploadRoot.value
}
async function upload(): Promise<void> {
  await perform(async () => {
    try {
      const result = await invokeIPC('delivery:database-upload')
      if (!result.cancelled) {
        formatReport.value = result
        if (result.directory) scanned.value = [result]
      }
    } finally { progress.value = undefined }
  })
}
async function workspaceAction(row:any,action:string):Promise<void>{await perform(async()=>{const result=await invokeIPC('file-library:workspace-'+action,row.libraryId);if(!result.cancelled){await refresh();ElMessage.success(result.staged?'工作区恢复已加入待发布变更':action==='backup'?'管理工作区已备份':'管理工作区已恢复')}})}
async function scan(): Promise<void> { await perform(async () => { scanned.value = await call('/scan', { directory: directory.value.trim() }); if (!scanned.value.length) ElMessage.info('未发现支持的 SQLite 文件，请检查服务器目录或文件路径') }) }
async function checkFormat(): Promise<void> {
  await perform(async () => {
    const result = await call('/check-format', { directory: directory.value.trim() })
    formatReport.value = result
    const index = scanned.value.findIndex(row => row.directory === result.directory)
    if (index === -1) scanned.value.push(result)
    else scanned.value.splice(index, 1, result)
  })
}
function linkedLibrary(row: any): any {
  return libraries.value.find(library => library.origin === row.directory ||
    (row.libraryId && (library.id === row.libraryId || library.libraryId === row.libraryId)))
}
async function register(row: any): Promise<void> {
  await perform(async () => {
    const existing = linkedLibrary(row)
    if (existing) {
      try {
        await ElMessageBox.confirm('是否从此文件更新关联？已生成的交付不变。', '重新关联', {confirmButtonText:'确认',cancelButtonText:'取消'})
      } catch (error) {
        if (error === 'cancel' || error === 'close') return
        throw error
      }
    }
    const result = await call('/register', {directory:row.directory, ...(existing ? {libraryId:existing.libraryId} : {})})
    formatReport.value = undefined
    await refresh()
    ElMessage.success(result.staged ? '文件库登记已加入待发布变更' : existing ? '已重新关联' : '已注册文件库')
  })
}
async function removeLibrary(row: any): Promise<void> {
  try {
    await setSharedLibraryRemoved(row.libraryId, row.title, true)
    scanned.value = []
    await perform(refresh)
    if (!error.value) ElMessage.success('数据库已移除')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  }
}
async function load(): Promise<void> { const result = await call('/records', { libraryId: current.value.libraryId, keyword: keyword.value, page: page.value, trash: trash.value }); rows.value = result.rows; total.value = result.total; revision.value = result.revision; selected.value = [] }
async function open(row: any, showTrash = false): Promise<void> { await perform(async () => { current.value = row; keyword.value = ''; trash.value = showTrash; page.value = 1; await load() }) }
async function view(row: any): Promise<void> { await perform(async () => { detail.value = await call('/record', { libraryId: current.value.libraryId, revision: revision.value, id: row.id, trash: trash.value }) }) }
async function change(action: string, ids: number[]): Promise<void> {
  const label = action === 'delete' ? '将所选化合物移入此文件库的回收站' : action === 'restore' ? '恢复所选化合物' : '从当前工作修订彻底删除所选化合物'
  try { await ElMessageBox.confirm(`是否${label}？已生成交付和历史备份不受影响。`, '确认操作', { confirmButtonText: '是', cancelButtonText: '否', type: action === 'restore' ? 'info' : 'warning' }); await perform(async () => { const result = await call('/change', { libraryId: current.value.libraryId, revision: revision.value, ids, action }); await load(); await refresh(); ElMessage.success(result.staged ? '已加入待发布变更' : '操作完成') }) } catch(e) { if(e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) }
}
onMounted(() => {
  window.electron.ipcRenderer.on('delivery:database-upload-progress', updateProgress)
  void perform(refresh)
})
onUnmounted(() => window.electron.ipcRenderer.removeListener('delivery:database-upload-progress', updateProgress))
</script>
<template>
  <section class="file-sources" v-loading="busy && !progress">
    <el-dialog :model-value="!!detail" title="文件库化合物详情" fullscreen @close="detail = undefined"><DeliveryRecord v-if="detail" :record="detail.record" :manifest="detail.manifest" preview @close="detail = undefined" /></el-dialog>
    <el-dialog :model-value="!!formatReport" title="数据库格式检查" width="min(760px,94vw)" append-to-body @close="formatReport=undefined"><template v-if="formatReport"><p class="format-path">{{formatReport.directory}}</p><el-alert :type="formatReport.status==='ready'?'success':'error'" :title="formatReport.status==='ready'?'格式检查通过，可以关联': '格式检查未通过'" :closable="false"/><el-table :data="formatReport.validation?.checks"><el-table-column prop="label" label="检查项目" min-width="160"/><el-table-column label="结果" width="80"><template #default="{row}">{{row.status==='passed'?'通过':'未通过'}}</template></el-table-column><el-table-column prop="detail" label="说明" min-width="260"/></el-table><p v-for="warning in formatReport.validation?.warnings" :key="warning" class="format-warning">{{warning}}</p><p>{{formatReport.validation?.note}}</p></template><template #footer><el-button @click="formatReport=undefined">关闭</el-button><el-button v-if="formatReport?.status==='ready'" type="primary" :disabled="busy" @click="register(formatReport)">加入待发布</el-button></template></el-dialog>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="!current">
      <div class="source-tools">
        <el-button type="primary" :disabled="busy || !!progress" @click="upload">从本机上传 SQLite</el-button>
        <el-button :disabled="busy || !!progress" @click="showServerFiles">使用服务器上的文件</el-button>
        <el-button text @click="perform(refresh)">刷新列表</el-button>
      </div>
      <p v-if="uploadRoot">上传目录：{{ uploadRoot }}<template v-if="uploadMaxMiB">。单文件上限 {{ uploadMaxMiB }} MiB，更大的库请先传到服务器。</template></p>
      <div v-if="progress" aria-live="polite">
        <p>{{ progress.phase === 'check' ? '已上传，正在检查数据库格式' : '正在上传数据库' }}</p>
        <el-progress :percentage="Math.floor(progress.sent * 100 / progress.total)" />
      </div>
      <div v-if="usingServerFile" class="source-tools"><el-input v-model="directory" placeholder="服务器目录或 SQLite 文件绝对路径" @keyup.enter="checkFormat" /><el-button type="primary" :disabled="!directory.trim()" @click="checkFormat">检查格式</el-button><el-button :disabled="!directory.trim()" @click="scan">扫描目录</el-button></div>
      <el-table v-if="scanned.length" :data="scanned" max-height="220"><el-table-column prop="title" label="发现的数据库" /><el-table-column prop="directory" label="服务器目录" min-width="260" /><el-table-column label="检查结果"><template #default="s">{{ s.row.issue || `格式通过 · ${s.row.total} 条记录` }}</template></el-table-column><el-table-column label="操作" width="180"><template #default="s"><el-button link @click="formatReport = s.row">检查详情</el-button><el-button link type="primary" :disabled="s.row.status !== 'ready'" @click="register(s.row)">{{ linkedLibrary(s.row) ? '重新关联' : '注册' }}</el-button></template></el-table-column></el-table>
      <el-table :data="libraries" height="100%" empty-text="尚未注册文件库"><el-table-column prop="title" label="文件数据库" min-width="180" /><el-table-column label="状态" width="100"><template #default="s"><el-tag :type="s.row.status === 'ready' ? 'success' : 'danger'">{{ s.row.status === 'ready' ? '可用' : '异常' }}</el-tag></template></el-table-column><el-table-column label="化合物" width="100"><template #default="{ row }">{{ row.status === 'ready' ? row.total : '—' }}</template></el-table-column><el-table-column prop="trashed" label="回收站" width="100" /><el-table-column label="路径／问题" min-width="260"><template #default="s">{{ s.row.issue || s.row.origin }}</template></el-table-column><el-table-column label="操作" width="280"><template #default="s"><el-button link type="primary" :disabled="s.row.status !== 'ready'" @click="props.formalLibraryIds?.includes(s.row.libraryId) ? emit('view-library', s.row.libraryId) : open(s.row)">查看记录</el-button><el-button v-if="!s.row.readOnly && props.formalLibraryIds?.includes(s.row.libraryId)" link @click="open(s.row, true)">回收站</el-button><el-button link @click="usingServerFile = true; directory = s.row.origin; scan()">从源文件更新</el-button><el-button link :disabled="busy" @click="removeLibrary(s.row)">移除</el-button><template v-if="s.row.status === 'ready' && s.row.adapter==='lds-cn'"><el-button link @click="workspaceAction(s.row,'backup')">备份工作区</el-button><el-button link :disabled="s.row.readOnly" @click="workspaceAction(s.row,'restore')">恢复工作区</el-button></template></template></el-table-column></el-table>
    </template>
    <template v-else>
      <div class="source-tools"><el-button @click="current = undefined">返回数据源</el-button><strong>{{ current.title }}{{ trash ? ' · 回收站' : '' }}</strong><el-input v-model="keyword" clearable placeholder="查询名称、英文名、CAS或分子式" @keyup.enter="page = 1; perform(load)" /><el-button type="primary" @click="page = 1; perform(load)">查询</el-button><el-button v-if="!current.readOnly" @click="trash = !trash; page = 1; perform(load)">{{ trash ? '返回数据库' : '回收站' }}</el-button></div>
      <div class="source-tools"><span>{{ total }} 条记录 · 已选 {{ selected.length }} 条</span><el-button v-if="!trash && !current.readOnly" type="danger" plain :disabled="!selected.length" @click="change('delete', selected.map(r => r.id))">删除所选</el-button><template v-else-if="!current.readOnly"><el-button :disabled="!selected.length" @click="change('restore', selected.map(r => r.id))">恢复所选</el-button><el-button type="danger" plain :disabled="!selected.length" @click="change('purge', selected.map(r => r.id))">彻底删除所选</el-button></template></div>
      <el-table :data="rows" height="100%" row-key="id" @selection-change="(value: any[]) => selected = value"><el-table-column type="selection" width="44" /><el-table-column prop="main_name" label="名称" min-width="180" show-overflow-tooltip /><el-table-column prop="name_en" label="英文名" min-width="180" show-overflow-tooltip /><el-table-column prop="cas" label="CAS号" width="140" /><el-table-column prop="formula" label="分子式" width="140" /><el-table-column label="操作" width="210"><template #default="s"><el-button link type="primary" @click="view(s.row)">查看</el-button><el-button v-if="!trash && !current.readOnly" link type="danger" @click="change('delete', [s.row.id])">删除</el-button><template v-else-if="!current.readOnly"><el-button link @click="change('restore', [s.row.id])">恢复</el-button><el-button link type="danger" @click="change('purge', [s.row.id])">彻底删除</el-button></template></template></el-table-column></el-table>
      <el-pagination v-model:current-page="page" :page-size="50" :total="total" layout="total, prev, pager, next" @current-change="perform(load)" />
    </template>
  </section>
</template>
<style scoped>
.format-path{overflow-wrap:anywhere}.format-warning{color:var(--el-color-warning)}.file-sources{display:flex;flex-direction:column;min-height:0;height:100%;gap:10px}.source-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:none}.source-tools .el-input{max-width:520px;min-width:180px;flex:1}.source-tools .el-button+.el-button{margin-left:0}.file-sources>p{font-size:12px;color:#748398;margin:0;overflow-wrap:anywhere}.file-sources>.el-table{flex:1;min-height:200px}.file-sources :deep(td.el-table__cell){padding:5px 0}.source-tools>span{font-size:12px;color:#748398}
</style>
