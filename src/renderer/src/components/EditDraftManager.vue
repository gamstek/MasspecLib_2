<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { notifyDataChanged } from '../utils/scopedIPC'
defineProps<{ hideTrigger?: boolean }>()
const emit = defineEmits<{ count: [value: number] }>()
const router = useRouter(), route = useRoute()
const visible = ref(false), items = ref<any[]>([]), commands = ref<any[]>([]), issue = ref(''), busy = ref(false)
const preview = ref<any>()
const previewRows = computed(() => {
  const value = preview.value
  if (!value) return []
  if (value.compound) return [
    ['名称', value.compound.main_name], ['CAS号', value.compound.cas], ['分子式', value.compound.formula],
    ['质谱方法组', value.methods?.length || 0], ['色谱方法', value.lcMethods?.length || 0]
  ]
  return [['操作', value.label], ['状态', value.status === 'completed' ? '已发布' : value.status === 'uncertain' ? '结果待核对' : value.status === 'rejected' ? '发布被拒绝' : '待发布'],
    ['操作结果', value.result === undefined ? '尚未发布' : JSON.stringify(value.result)]]
})
async function refresh(): Promise<void> {
  try {
    const [records, pending] = await Promise.all([invokeIPC('edit-drafts:list'), invokeIPC('pending-changes:list')])
    items.value = records; commands.value = pending; issue.value = ''
    emit('count', records.length + pending.filter((c: any) => c.status !== 'completed').length)
  } catch (error) { issue.value = String(error) }
}
async function show(): Promise<void> { visible.value = true; await refresh() }
defineExpose({ open: show })
async function open(row: any): Promise<void> {
  visible.value = false
  if (route.path === '/detail') { window.dispatchEvent(new CustomEvent('masspeclib2-open-draft', { detail: row.ref })); return }
  sessionStorage.setItem('currentCompound', JSON.stringify({ ref: row.ref }))
  try { await router.push({ name: 'Detail' }) } catch (error) { ElMessage.error(String(error)) }
}
async function action(kind: 'record' | 'command', row: any, operation: string): Promise<void> {
  if (busy.value) return
  try {
    if (operation === 'discard' || operation === 'publish')
      await ElMessageBox.confirm(operation === 'publish' ? '发布这项变更？发布后更新正式共享内容。' : '移除此项待发布变更？',
        operation === 'publish' ? '确认发布' : '确认移除', { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' })
    busy.value = true
    const channel = kind === 'record' ? 'edit-drafts:' : 'pending-changes:'
    const result = await invokeIPC(channel + operation, kind === 'record' ? row.ref : row.id)
    if (operation === 'inspect') preview.value = result
    else if (!result.cancelled) ElMessage.success(operation === 'publish' ? '发布完成，请核对操作结果' : operation === 'export' ? '已导出' : '已移除')
    await refresh()
    notifyDataChanged()
  } catch (error) { if (error !== 'cancel' && error !== 'close') { ElMessage.error(String(error)); await refresh() } }
  finally { busy.value = false }
}
onMounted(() => { void refresh(); window.addEventListener('masspeclib2-data-changed', refresh) })
onUnmounted(() => window.removeEventListener('masspeclib2-data-changed', refresh))
</script>
<template>
  <el-button v-if="!hideTrigger" @click="show">待发布变更</el-button>
  <el-dialog v-model="visible" title="我的待发布变更" width="min(950px, 94vw)" append-to-body>
    <p>变更保存在本机当前账号下。发布后其他管理员才可读取。逐项发布并核对结果。</p>
    <el-alert v-if="issue" :title="issue" type="error" :closable="false" />
    <h3>记录编辑</h3>
    <el-table :data="items" empty-text="暂无记录草稿" max-height="260">
      <el-table-column prop="name" label="记录" />
      <el-table-column label="操作" min-width="310"><template #default="{ row }">
        <el-button link :disabled="busy" @click="open(row)">继续编辑</el-button>
        <el-button link :disabled="busy" @click="action('record', row, 'inspect')">查看草稿</el-button>
        <el-button link :disabled="busy" @click="action('record', row, 'export')">导出备份</el-button>
        <el-button link type="primary" :disabled="busy" @click="action('record', row, 'publish')">发布</el-button>
        <el-button link :disabled="busy" @click="action('record', row, 'discard')">放弃</el-button>
      </template></el-table-column>
    </el-table>
    <h3>新增、导入、删除和共享分类</h3>
    <el-table :data="commands" empty-text="暂无其他待发布变更" max-height="300">
      <el-table-column prop="label" label="变更" />
      <el-table-column label="状态" width="110"><template #default="{ row }">
        {{ row.status === 'completed' ? '已发布' : row.status === 'uncertain' ? '结果待核对' : row.status === 'rejected' ? '发布被拒绝' : '待发布' }}
      </template></el-table-column>
      <el-table-column label="操作" min-width="290"><template #default="{ row }">
        <el-button link :disabled="busy" @click="action('command', row, 'inspect')">查看内容及结果</el-button>
        <el-button link :disabled="busy" @click="action('command', row, 'export')">导出备份</el-button>
        <el-button v-if="['ready', 'rejected'].includes(row.status)" link type="primary" :disabled="busy" @click="action('command', row, 'publish')">{{row.status === 'rejected' ? '重试发布' : '发布'}}</el-button>
        <el-button link :disabled="busy" @click="action('command', row, 'discard')">{{ row.status === 'completed' ? '清除记录' : '放弃' }}</el-button>
      </template></el-table-column>
    </el-table>
  </el-dialog>
  <el-dialog :model-value="!!preview" title="草稿内容及操作结果" width="min(850px, 94vw)" append-to-body @close="preview = undefined">
    <el-descriptions :column="1" border>
      <el-descriptions-item v-for="row in previewRows" :key="String(row[0])" :label="String(row[0])">{{ row[1] || '未填写' }}</el-descriptions-item>
    </el-descriptions>
    <el-collapse><el-collapse-item title="查看完整变更数据"><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto">{{ JSON.stringify(preview, null, 2) }}</pre></el-collapse-item></el-collapse>
  </el-dialog>
</template>

