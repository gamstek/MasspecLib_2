<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { RESULT_EXPORT_FIELDS } from '../../../shared/exportFields'
import { AUDIT_STATE_LABELS } from '../../../shared/audit'
import ChromatogramsTab from './ChromatogramsTab.vue'
const router = useRouter(),
  status = ref<any>({ settings: {} }),
  settings = ref<any>({}),
  connections = ref<any[]>([]),
  rows = ref<any[]>([]),
  total = ref(0),
  page = ref(1),
  keyword = ref(''),
  state = ref(''),
  issue = ref(''),
  configVisible = ref(false),
  busy = ref(false),
  detail = ref<any>(),
  visible = ref(false)
const exportVisible = ref(false),
  exportFormat = ref('json'),
  exportFields = ref(
    RESULT_EXPORT_FIELDS.filter((x) => x[0] !== 'traces').map((x) => x[0] as string)
  )
const loadingResults = ref(false)
const appliedFilters = ref<any>({})
const draftFilters = (): any => ({ keyword: keyword.value, state: state.value || undefined, issue: issue.value || undefined })
const pendingQuery = computed(() => JSON.stringify(draftFilters()) !== JSON.stringify(appliedFilters.value))
let requestGeneration = 0, detailGeneration = 0
async function exportResults(): Promise<void> {
  if (pendingQuery.value) { ElMessage.info('请先筛选，再导出'); return }
  if (loadingResults.value) { ElMessage.info('请等待当前筛选完成'); return }
  const filterSnapshot = { ...appliedFilters.value }
  try {
    const path = await invokeIPC('dialog:saveFile', {
      title: '导出筛选后的数据库检查结果',
      defaultPath: '检查结果.' + exportFormat.value,
      filters: [{ name: '检查结果', extensions: [exportFormat.value] }]
    })
    if (!path) return
    const result = await invokeIPC('audit:export', {
      filePath: path,
      format: exportFormat.value,
      fields: exportFields.value,
      filters: filterSnapshot
    })
    exportVisible.value = false
    ElMessage.success(`已导出${result.total}条检查记录`)
  } catch (e) {
    ElMessage.error(String(e))
  }
}
let refreshTimer: ReturnType<typeof setTimeout> | undefined
async function load(useApplied = false): Promise<void> {
  const generation = ++requestGeneration
  const filters = { ...(useApplied && Object.keys(appliedFilters.value).length ? appliedFilters.value : draftFilters()), page: page.value }
  loadingResults.value = true
  try {
    const nextStatus = await invokeIPC('audit:status')
    if (generation !== requestGeneration) return
    status.value = nextStatus
    if (!configVisible.value) settings.value = { ...nextStatus.settings }
    if (nextStatus.ready) {
      const response = await invokeIPC('audit:results', filters)
      if (generation !== requestGeneration) return
      rows.value = response.rows; total.value = response.total
      const { page: _page, ...applied } = filters; appliedFilters.value = applied
    } else { rows.value = []; total.value = 0 }
  } catch (error) { if (generation === requestGeneration) ElMessage.error(String(error)) }
  finally { if (generation === requestGeneration) loadingResults.value = false }
}
async function openSettings(): Promise<void> {
  try {
    const current = await invokeIPC('audit:status')
    connections.value = await invokeIPC('connections:list')
    settings.value = { ...current.settings }; configVisible.value = true
  } catch (error) { ElMessage.error(String(error)) }
}
function search(): void {
  page.value = 1
  void load()
}
function updated(): void {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void load(true), 600)
}
async function run(): Promise<void> {
  busy.value = true
  try {
    await invokeIPC('audit:run')
    await load()
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
async function pause(): Promise<void> {
  try {
    await invokeIPC('audit:pause')
    await load()
  } catch (e) {
    ElMessage.error(String(e))
  }
}
async function save(): Promise<void> {
  try {
    await invokeIPC('audit:settings', settings.value)
    configVisible.value = false
    await load()
  } catch (e) {
    ElMessage.error(String(e))
  }
}
async function open(row: any): Promise<void> {
  const generation = ++detailGeneration
  try {
    const record = await invokeIPC('audit:check', row.id)
    if (generation !== detailGeneration) return
    detail.value = { assets: [{ ...record.evidence, check: record.data, checkId: record.id }] }
    visible.value = true
  } catch (e) {
    ElMessage.error(String(e))
  }
}
function scanDetail(scan: any): any { try { return typeof scan.detail === 'string' ? JSON.parse(scan.detail) : scan.detail || {} } catch { return {} } }
function scanState(value: string): string { return ({ running: '检查中', completed: '完成', partial: '部分失败', paused: '已暂停', failed: '失败' } as Record<string, string>)[value] || value }
function compound(row: any): void {
  sessionStorage.setItem(
    'currentCompound',
    JSON.stringify({ ref: { connectionId: '@unified', key: row.entity_id }, tab: 'chromatograms' })
  )
  void router.push('/detail')
}
async function unmerge(id: string): Promise<void> {
  try {
    await invokeIPC('audit:unmerge', id)
    await load()
    ElMessage.success('已撤销关联')
  } catch (e) {
    ElMessage.error(String(e))
  }
}
onMounted(async () => {
  connections.value = await invokeIPC('connections:list')
  await load()
  window.electron.ipcRenderer.on('audit:updated', updated)
})
onUnmounted(() => {
  clearTimeout(refreshTimer)
  window.electron.ipcRenderer.removeListener('audit:updated', updated)
})
</script>
<template>
  <section class="database-results">
    <div class="toolbar">
      <el-button type="primary" :loading="busy" :disabled="status.running" @click="run"
        >立即检查数据库</el-button
      ><el-button @click="pause">暂停自动检查</el-button
      ><el-button @click="openSettings">自动检查设置</el-button
      ><el-button @click="load(true)">刷新结果</el-button
      ><el-button :disabled="!status.ready || loadingResults || pendingQuery || !total" @click="exportVisible = true">导出筛选结果</el-button>
    </div>
    <p>
      连接数据库后自动读取已完成的色谱和测定记录。每
      {{ status.settings.intervalSeconds }} 秒核对数据变化；相同数据与规则保留已有检查和复核。
    </p>
    <el-alert v-if="status.error" :title="status.error" type="error" :closable="false" />
    <el-alert
      v-if="!status.ready"
      title="审核库尚未就绪。请在自动检查设置中选择可写入的服务器连接；来源数据库可保持只读。"
      type="info"
      :closable="false"
    />
    <p v-if="status.running">
      正在检查 {{ status.current?.name }}：{{ status.current?.processed ?? 0 }} /
      {{ status.current?.total ?? 0 }} 条化合物；已计算 {{ status.current?.checked ?? 0 }} 个检查项目，失败 {{ status.current?.failures ?? 0 }} 项。
    </p>
    <p v-else-if="status.paused">自动检查已暂停；已完成结果保留。点击“立即检查数据库”重新核对，未变内容不重复计算。</p>
    <p v-else-if="!status.settings.enabled">自动检查已停用；仍可点击“立即检查数据库”执行一次。</p>
    <p v-else>本轮状态：{{ ({ completed: '完成', partial: '部分失败', failed: '失败', idle: '未开始', paused: '已暂停' } as any)[status.phase] || '未开始' }} · 最近结束：{{ status.lastFinished || '尚未运行' }}</p>
    <el-alert v-if="status.ready && status.stale?.length" :title="`以下数据库尚无最新完整检查：${status.stale.join('、')}。历史结果仍可查看，请勿视为本轮全部成功。`" type="warning" :closable="false" />
    <details v-if="status.scans?.some((s: any) => ['partial','failed','paused'].includes(s.state))" class="scan-issues"><summary>查看未完成记录与原因 · 处理后点击“立即检查数据库”重试</summary><template v-for="scan in status.scans.filter((s: any) => ['partial','failed','paused'].includes(s.state))" :key="scan.id"><p>{{ scan.state === 'paused' ? '已暂停' : scan.state === 'partial' ? '部分失败' : '失败' }} · {{ scan.created_at }}</p><p v-if="scanDetail(scan).error">{{ scanDetail(scan).error }}</p><p v-for="(item, i) in scanDetail(scan).issues || []" :key="i">记录 {{ item.record }}：{{ item.reason }}</p></template></details>
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="样品或化合物名称"
        clearable
        @keyup.enter="search"
      /><el-select v-model="state" placeholder="全部检查状态" clearable @change="search"
        ><el-option label="异常" value="abnormal" /><el-option
          label="数据不足"
          value="incomplete" /><el-option label="待复核异常" value="unreviewed" /></el-select
      ><el-select v-model="issue" placeholder="全部异常类型" clearable @change="search"
        ><el-option
          v-for="item in [
            ['fronting', '前延'],
            ['tailing', '拖尾'],
            ['split', '疑似分叉／肩峰'],
            ['limit', '超限'],
            ['ratio', '离子比不满足']
          ]"
          :key="item[0]"
          :label="item[1]"
          :value="item[0]" /></el-select
      ><el-button @click="search">筛选</el-button>
    </div>
    <p v-if="pendingQuery" class="pending-query">条件未应用，请点击筛选；当前显示上次结果，导出暂不可用。</p><el-table v-loading="loadingResults" :data="rows" @row-dblclick="open"
      ><el-table-column prop="result.sample" label="样品" /><el-table-column label="化合物"
        ><template #default="s"
          ><el-link type="primary" @click="compound(s.row)">{{
            s.row.result.compound
          }}</el-link></template
        ></el-table-column
      ><el-table-column prop="method_name" label="方法" /><el-table-column
        v-for="kind in ['peak', 'ratio', 'limit']"
        :key="kind"
        :label="{ peak: '峰形', ratio: '离子比', limit: '超限' }[kind]"
        ><template #default="s"
          ><el-tag
            :type="['fail', 'warn'].includes(s.row.result[kind].state) ? 'danger' : 'info'"
            >{{ AUDIT_STATE_LABELS[s.row.result[kind].state] }}</el-tag
          ></template
        ></el-table-column
      ><el-table-column prop="review" label="复核状态" /><el-table-column label="查看"
        ><template #default="s"
          ><el-button link type="primary" @click="open(s.row)">曲线与判定依据</el-button></template
        ></el-table-column
      ></el-table
    >
    <el-pagination
      v-model:current-page="page"
      :page-size="50"
      :total="total"
      layout="total,prev,pager,next"
      @current-change="load(true)"
    />
    <el-collapse
      ><el-collapse-item title="扫描记录与身份关联历史" name="history"
        ><el-table :data="status.scans"
          ><el-table-column label="数据库"><template #default="s">{{ connections.find(c => c.id === s.row.connection_id)?.name || s.row.connection_id }}</template></el-table-column><el-table-column
            label="状态"><template #default="s">{{ scanState(s.row.state) }}</template></el-table-column><el-table-column prop="progress" label="已扫描" /><el-table-column
            prop="updated_at"
            label="时间" /></el-table
        ><el-table :data="status.merges"
          ><el-table-column prop="reviewer" label="关联确认人" /><el-table-column
            prop="reason"
            label="理由"
          /><el-table-column label="操作"
            ><template #default="s"
              ><el-button v-if="!s.row.undone" :disabled="status.running" @click="unmerge(s.row.id)"
                >撤销关联</el-button
              ><span v-else>已撤销</span></template
            ></el-table-column
          ></el-table
        ></el-collapse-item
      ></el-collapse
    >
    <el-dialog v-model="configVisible" title="数据库自动检查设置" width="620px"
      ><el-form label-width="140px"
        ><el-form-item label="启用自动检查"><el-switch v-model="settings.enabled" /></el-form-item
        ><el-form-item label="审核库服务器连接"
          ><el-select v-model="settings.connectionId"
            ><el-option
              v-for="c in connections"
              :key="c.id"
              :value="c.id"
              :label="c.name" /></el-select></el-form-item
        ><el-form-item label="独立审核数据库"><el-input v-model="settings.database" /></el-form-item
        ><el-form-item label="检查间隔（秒）"
          ><el-input-number
            v-model="settings.intervalSeconds"
            :min="30"
            :max="86400" /></el-form-item
      ></el-form>
      <p>
        审核库保存数据索引、检查历史及复核记录；须具有创建审核库和写入审核表的权限。来源库不会被初始化或改写。暂停后仍可查询结果，重新启用请保存设置。
      </p>
      <template #footer
        ><el-button @click="configVisible = false">取消</el-button
        ><el-button :disabled="status.running" type="primary" @click="save"
          >保存</el-button
        ></template
      ></el-dialog
    >
    <el-dialog v-model="exportVisible" title="导出筛选后的检查记录" width="650px"
      ><el-alert :title="`导出 ${total} 条 · 当前已应用的筛选结果`" type="info" :closable="false" /><el-select v-model="exportFormat"
        ><el-option label="JSON" value="json" /><el-option label="CSV" value="csv" /><el-option
          label="Excel"
          value="xlsx"
      /></el-select>
      <p>导出符合当前样品/化合物、检查状态和异常类型筛选的记录；检查标识始终保留。</p>
      <el-checkbox-group v-model="exportFields"
        ><el-checkbox v-for="item in RESULT_EXPORT_FIELDS" :key="item[0]" :value="item[0]">{{
          item[1]
        }}</el-checkbox></el-checkbox-group
      ><template #footer
        ><el-button @click="exportVisible = false">取消</el-button
        ><el-button type="primary" @click="exportResults">选择位置并导出</el-button></template
      ></el-dialog
    >
    <el-dialog v-model="visible" title="数据库检查记录" width="90%"
      ><ChromatogramsTab :data="detail"
    /></el-dialog>
  </section>
</template>
<style scoped>
.database-results {
  padding: 16px;
}
.toolbar {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.toolbar .el-input {
  width: 240px;
}
.toolbar .el-select {
  width: 200px;
}
.el-pagination {
  margin: 18px 0;
}
.scan-issues { padding:10px 14px;border:1px solid #eadbc4;background:#fffaf2;border-radius:6px;font-size:12px;margin:10px 0; }.scan-issues summary { cursor:pointer; }.scan-issues p { margin:6px 0;overflow-wrap:anywhere; }
</style>
