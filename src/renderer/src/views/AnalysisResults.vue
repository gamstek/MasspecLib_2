<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import DatabaseResults from '../components/DatabaseResults.vue'
import ChromatogramChart from '../components/ChromatogramChart.vue'
import { CHECK_LABELS, PEAK_LABELS } from '../../../shared/analysis/types'
import type {
  AnalysisSummary,
  AnalysisFilters,
  DetectionRow,
  DetectionResult,
  PeakRules,
  ReviewAction,
  CheckState
} from '../../../shared/analysis/types'
const viewMode = ref('database')
interface ListRow extends DetectionResult {
  review: ReviewAction | null
  measurement: DetectionRow['measurement']
}
interface Detail {
  row: DetectionRow
  result: DetectionResult
  reviews: ReviewAction[]
  summary: AnalysisSummary
  rules: PeakRules
  sourceName: string
  sourceHash: string
  engineVersion: string
}
interface Preview {
  batchName: string
  methodName: string
  ruleVersion: string
  demo: boolean
  restored?: boolean
  total: number
  abnormal: number
  incomplete: number
  rows: DetectionResult[]
}
const batches = ref<AnalysisSummary[]>([]),
  batchId = ref(''),
  warnings = ref<string[]>([])
const rows = ref<ListRow[]>([]),
  total = ref(0),
  busy = ref(false),
  page = ref(1),
  pageSize = ref(50)
const filters = ref<AnalysisFilters>({ view: 'all' })
const summary = ref<AnalysisSummary>()
const drawer = ref(false),
  detail = ref<Detail>(),
  detailBusy = ref(false),
  reviewBusy = ref(false)
const reviewer = ref(localStorage.getItem('masspeclib2.reviewer') ?? ''),
  reason = ref(''),
  action = ref<ReviewAction['action']>('reviewed')
const importVisible = ref(false),
  jobId = ref(''),
  jobState = ref(''),
  progress = ref(0),
  importError = ref(''),
  preview = ref<Preview>(),
  saving = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let searchGeneration = 0,
  detailGeneration = 0
const importing = computed(() => !!jobId.value)
const reviewLabels = { reviewed: '已复核', retest: '要求重测', exclude: '标记排除' }
function number(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(Number(value.toPrecision(7)))
    : '未提供'
}
function measurement(row: ListRow): string {
  const m = row.measurement
  if (!m) return '未提供'
  if (m.modifier === 'ND') return '未检出（原始结果）'
  if (m.modifier === 'ltLOQ') return '<LOQ' + (m.loq != null ? ' (' + number(m.loq) + ')' : '')
  if (m.modifier === 'ltLOD') return '<LOD'
  return number(m.value)
}
function color(state: CheckState): 'success' | 'danger' | 'warning' | 'info' {
  return state === 'pass'
    ? 'success'
    : state === 'fail'
      ? 'danger'
      : state === 'warn'
        ? 'warning'
        : 'info'
}
function limitLabel(state: CheckState): string {
  return state === 'fail' ? '数值超限' : state === 'pass' ? '未超限（数值）' : '无法比较'
}
function peakLabel(result: DetectionResult): string {
  return result.peak.flags.length
    ? result.peak.flags.map((f) => PEAK_LABELS[f]).join('、')
    : result.peak.state === 'pass'
      ? '满足峰形规则'
      : CHECK_LABELS[result.peak.state]
}
async function loadBatches(preferred?: string): Promise<void> {
  try {
    const data = await invokeIPC('analysis:batches')
    batches.value = data.batches
    warnings.value = data.warnings
    const desired = preferred ?? batchId.value ?? ''
    batchId.value = batches.value.some((b) => b.id === desired)
      ? desired
      : (batches.value[0]?.id ?? '')
    await search()
  } catch (error) {
    ElMessage.error(String(error))
  }
}
async function search(reset = true): Promise<void> {
  const generation = ++searchGeneration
  if (reset) page.value = 1
  if (!batchId.value) {
    rows.value = []
    total.value = 0
    summary.value = undefined
    return
  }
  busy.value = true
  try {
    const data = await invokeIPC('analysis:results', batchId.value, {
      ...filters.value,
      page: page.value,
      pageSize: pageSize.value
    })
    if (generation !== searchGeneration) return
    rows.value = data.rows
    total.value = data.total
    summary.value = data.summary
  } catch (error) {
    if (generation === searchGeneration) ElMessage.error(String(error))
  } finally {
    if (generation === searchGeneration) busy.value = false
  }
}
function reset(): void {
  filters.value = { view: 'all' }
  void search()
}
async function openDetail(row: DetectionResult): Promise<void> {
  const generation = ++detailGeneration
  detail.value = undefined
  drawer.value = true
  detailBusy.value = true
  reason.value = ''
  action.value = 'reviewed'
  try {
    const data = await invokeIPC('analysis:detail', batchId.value, row.id)
    if (generation === detailGeneration) detail.value = data
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    if (generation === detailGeneration) detailBusy.value = false
  }
}
async function saveReview(): Promise<void> {
  if (!detail.value || !reason.value.trim() || !reviewer.value.trim()) {
    ElMessage.warning('请填写复核人和处理理由')
    return
  }
  reviewBusy.value = true
  try {
    const current = detail.value
    await invokeIPC('analysis:review', current.summary.id, current.summary.revision, {
      resultId: current.result.id,
      action: action.value,
      reviewer: reviewer.value,
      reason: reason.value
    })
    localStorage.setItem('masspeclib2.reviewer', reviewer.value)
    detail.value = await invokeIPC('analysis:detail', current.summary.id, current.result.id)
    reason.value = ''
    await search(false)
    ElMessage.success('已保存复核记录，原始自动判定保留')
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    reviewBusy.value = false
  }
}
async function poll(): Promise<void> {
  if (!jobId.value) return
  const id = jobId.value
  try {
    const job = await invokeIPC('analysis:job', id)
    if (id !== jobId.value) return
    jobState.value = job.state
    progress.value = job.progress
    preview.value = job.preview ?? undefined
    if (job.state === 'failed') importError.value = job.message
    if (job.state === 'running') timer = setTimeout(() => void poll(), 400)
  } catch (error) {
    importError.value = String(error)
    jobState.value = 'failed'
  }
}
async function startImport(demo = false): Promise<void> {
  if (importing.value) return
  try {
    const result = await invokeIPC(demo ? 'analysis:demo' : 'analysis:import')
    if (!result) return
    jobId.value = result.jobId
    jobState.value = 'running'
    progress.value = 0
    importError.value = ''
    preview.value = undefined
    importVisible.value = true
    await poll()
  } catch (error) {
    ElMessage.error(String(error))
  }
}
async function cancelImport(): Promise<void> {
  if (timer) clearTimeout(timer)
  const id = jobId.value
  jobId.value = ''
  if (id) await invokeIPC('analysis:cancel', id).catch(() => undefined)
}
async function commit(): Promise<void> {
  saving.value = true
  try {
    const result = await invokeIPC('analysis:commit', jobId.value)
    jobId.value = ''
    importVisible.value = false
    filters.value = { view: 'all' }
    await loadBatches(result.id)
    ElMessage.success(
      result.duplicate ? '相同文件已经导入，已打开原有批次' : '已保存批次和自动检查结果'
    )
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    saving.value = false
  }
}
async function template(format: 'json' | 'csv'): Promise<void> {
  try {
    if (await invokeIPC('analysis:template', format))
      ElMessage.success('模板已保存；示例值均为模拟，请替换为真实数据和方法规则')
  } catch (error) {
    ElMessage.error(String(error))
  }
}
async function exportResults(format: 'json' | 'csv'): Promise<void> {
  try {
    if (await invokeIPC('analysis:export', batchId.value, filters.value, format))
      ElMessage.success('已导出')
  } catch (error) {
    ElMessage.error(String(error))
  }
}
onMounted(() => void loadBatches())
onUnmounted(() => {
  if (timer) clearTimeout(timer)
  void cancelImport()
})
</script>

<template>
  <div class="analysis-page">
    <el-radio-group v-model="viewMode"
      ><el-radio-button value="database">数据库自动检查</el-radio-button
      ><el-radio-button value="files">文件导入与历史</el-radio-button></el-radio-group
    >
    <DatabaseResults v-if="viewMode === 'database'" />
    <div v-show="viewMode === 'files'">
      <div class="analysis-title">
        <div>
          <h2>检测结果</h2>
          <p>自动检查峰形、数值超限和离子比，查看证据并记录复核。</p>
        </div>
        <div class="actions">
          <el-button type="primary" :disabled="importing" @click="startImport(false)"
            >导入检测数据</el-button
          ><el-button :disabled="importing" @click="startImport(true)">载入模拟演示</el-button>
        </div>
      </div>
      <div class="template-actions">
        <el-button link @click="template('json')">下载JSON完整模板</el-button
        ><el-button link @click="template('csv')">下载CSV结果模板</el-button
        ><span>结果保存在本机用户数据目录，可导出完整备份。</span>
      </div>
      <el-alert
        v-for="warning in warnings"
        :key="warning"
        :title="warning"
        type="warning"
        :closable="false"
      />
      <el-alert
        v-if="summary?.demo"
        title="当前为模拟测试数据，所有阈值和测定值仅用于功能演示。"
        type="warning"
        :closable="false"
      />
      <div class="batch-bar">
        <label>检测批次</label
        ><el-select v-model="batchId" placeholder="请选择或导入批次" filterable @change="search()"
          ><el-option
            v-for="batch in batches"
            :key="batch.id"
            :label="batch.batchName"
            :value="batch.id" /></el-select
        ><el-button @click="loadBatches()">刷新批次</el-button
        ><el-button :disabled="!batchId" @click="exportResults('csv')">导出筛选结果</el-button
        ><el-button :disabled="!batchId" @click="exportResults('json')">完整备份</el-button>
      </div>
      <template v-if="summary">
        <div class="statistics">
          <div>
            <b>{{ summary.total }}</b
            ><span>全部结果</span>
          </div>
          <div>
            <b>{{ summary.abnormal }}</b
            ><span>存在异常</span>
          </div>
          <div>
            <b>{{ summary.incomplete }}</b
            ><span>部分检查数据不足</span>
          </div>
          <div>
            <b>{{ summary.pending }}</b
            ><span>异常／不足待复核</span>
          </div>
        </div>
        <p class="method-line">
          方法：{{ summary.methodName }}　规则版本：{{ summary.ruleVersion }}　<span
            >异常与数据不足数量可重叠，同一结果在列表中只显示一次。</span
          >
        </p>
        <div class="filter-panel">
          <div class="text-filters">
            <el-input
              v-model="filters.sample"
              placeholder="样品名称……"
              clearable
              @keyup.enter="search()"
            /><el-input
              v-model="filters.compound"
              placeholder="化合物名称……"
              clearable
              @keyup.enter="search()"
            /><el-input
              v-model="filters.matrix"
              placeholder="基质……"
              clearable
              @keyup.enter="search()"
            /><el-button type="primary" @click="search()">搜索</el-button
            ><el-button @click="reset">重置</el-button>
          </div>
          <el-radio-group v-model="filters.view" @change="search()"
            ><el-radio-button value="all">全部</el-radio-button
            ><el-radio-button value="abnormal">仅异常</el-radio-button
            ><el-radio-button value="incomplete">数据不足</el-radio-button
            ><el-radio-button value="pending">待复核</el-radio-button></el-radio-group
          >
          <div class="state-filters">
            <el-select v-model="filters.peak" placeholder="全部峰形" clearable @change="search()"
              ><el-option label="满足峰形规则" value="pass" /><el-option
                v-for="(label, value) in PEAK_LABELS"
                :key="value"
                :label="label"
                :value="value" /><el-option label="未评估／数据不足" value="unknown"
            /></el-select>
            <el-select
              v-model="filters.limit"
              placeholder="全部限量状态"
              clearable
              @change="search()"
              ><el-option label="数值超限" value="fail" /><el-option
                label="未超限（数值）"
                value="pass" /><el-option label="无法比较" value="unknown"
            /></el-select>
            <el-select
              v-model="filters.ratio"
              placeholder="全部离子比状态"
              clearable
              @change="search()"
              ><el-option label="满足规则" value="pass" /><el-option
                label="不满足规则"
                value="fail" /><el-option label="证据不足" value="unknown" /><el-option
                label="不适用"
                value="na"
            /></el-select>
            <el-select
              v-model="filters.review"
              placeholder="全部复核状态"
              clearable
              @change="search()"
              ><el-option label="未复核" value="pending" /><el-option
                v-for="(label, value) in reviewLabels"
                :key="value"
                :label="label"
                :value="value"
            /></el-select>
          </div>
        </div>
        <el-table v-loading="busy" :data="rows" border row-key="id" @row-dblclick="openDetail">
          <el-table-column prop="sample" label="样品" min-width="190" /><el-table-column
            prop="compound"
            label="化合物"
            min-width="180"
            ><template #default="{ row }"
              ><el-button link type="primary" @click="openDetail(row)">{{
                row.compound
              }}</el-button></template
            ></el-table-column
          >
          <el-table-column prop="matrix" label="基质" min-width="100" /><el-table-column
            label="测定值"
            min-width="120"
            ><template #default="{ row }"
              >{{ measurement(row) }} {{ row.measurement?.unit }}</template
            ></el-table-column
          >
          <el-table-column label="限量" min-width="115"
            ><template #default="{ row }"
              >{{ number(row.limit.limitValue) }} {{ row.limit.unit }}</template
            ></el-table-column
          >
          <el-table-column label="限量比较" min-width="135"
            ><template #default="{ row }"
              ><el-tag :type="color(row.limit.state)">{{
                limitLabel(row.limit.state)
              }}</el-tag></template
            ></el-table-column
          >
          <el-table-column label="峰形" min-width="190"
            ><template #default="{ row }"
              ><el-tag :type="color(row.peak.state)">{{ peakLabel(row) }}</el-tag></template
            ></el-table-column
          >
          <el-table-column label="离子比" min-width="145"
            ><template #default="{ row }"
              ><el-tag :type="color(row.ratio.state)">{{
                CHECK_LABELS[row.ratio.state as CheckState]
              }}</el-tag></template
            ></el-table-column
          >
          <el-table-column label="复核" min-width="115"
            ><template #default="{ row }">{{
              row.review ? reviewLabels[row.review.action as keyof typeof reviewLabels] : '未复核'
            }}</template></el-table-column
          >
        </el-table>
        <div class="pagination">
          <span>筛选后共 {{ total }} 条</span
          ><el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :page-sizes="[20, 50, 100]"
            :total="total"
            layout="sizes, prev, pager, next"
            @current-change="search(false)"
            @size-change="search()"
          />
        </div>
        <p class="footnote">
          筛选仅影响查看与导出，原始数据保留。数值超限、离子比及峰形检查分别展示，最终符合性需结合适用方法复核。
        </p>
      </template>
      <el-empty
        v-else
        description="还没有检测结果。可先载入15条模拟演示，或下载模板导入真实检测数据。"
      />

      <el-dialog
        v-model="importVisible"
        title="检测数据分析与预览"
        width="850px"
        :close-on-click-modal="false"
        :show-close="!saving"
        @closed="cancelImport"
      >
        <el-progress :percentage="progress" />
        <p v-if="jobState === 'running'">正在后台分析；可取消任务。</p>
        <el-alert v-if="importError" :title="importError" type="error" :closable="false" />
        <template v-if="preview"
          ><el-alert
            v-if="preview.restored"
            title="这是完整批次备份，将恢复原批次和复核历史；不会覆盖本机已有批次。"
            type="info"
            :closable="false"
          />
          <h3>{{ preview.batchName }}</h3>
          <p>方法：{{ preview.methodName }}　规则：{{ preview.ruleVersion }}</p>
          <el-alert
            v-if="preview.demo"
            title="模拟数据，仅用于软件功能演示。"
            type="warning"
            :closable="false"
          />
          <p>
            共 {{ preview.total }} 条，异常 {{ preview.abnormal }} 条，部分检查数据不足
            {{ preview.incomplete }} 条。
          </p>
          <el-table :data="preview.rows" max-height="320"
            ><el-table-column prop="sample" label="样品" min-width="180" /><el-table-column
              label="异常及数据不足标签"
              min-width="270"
              ><template #default="{ row }">{{
                row.labels.join('；') || '满足当前配置规则'
              }}</template></el-table-column
            ></el-table
          >
          <p class="footnote">
            预览最多显示前20条。确认保存后才能在检测结果中筛选、查看和复核。
          </p></template
        >
        <template #footer
          ><el-button :disabled="saving" @click="importVisible = false">取消</el-button
          ><el-button
            type="primary"
            :disabled="jobState !== 'preview'"
            :loading="saving"
            @click="commit"
            >确认保存批次</el-button
          ></template
        >
      </el-dialog>

      <el-drawer v-model="drawer" title="检测结果详情与复核" size="88%">
        <div v-loading="detailBusy">
          <template v-if="detail">
            <h3>{{ detail.row.sample }} · {{ detail.row.compound }}</h3>
            <p>{{ detail.summary.methodName }}　规则 {{ detail.summary.ruleVersion }}</p>
            <div class="detail-tags">
              <el-tag v-for="label in detail.result.labels" :key="label" type="warning">{{
                label
              }}</el-tag
              ><el-tag v-if="!detail.result.labels.length" type="success">满足当前配置规则</el-tag>
            </div>
            <ChromatogramChart
              :trace="detail.row.trace"
              :qualifier-trace="detail.row.qualifierTrace"
              :qualifiers="detail.row.qualifiers"
              :peak="detail.result.peak"
            />
            <p class="footnote">
              曲线为时间—强度数据；基线为窗口端点线性估计，面积单位为强度×min，不替代外部软件浓度。
            </p>
            <el-descriptions title="峰形与积分证据" :column="3" border>
              <el-descriptions-item label="状态">{{
                peakLabel(detail.result)
              }}</el-descriptions-item
              ><el-descriptions-item label="5%拖尾因子">{{
                number(detail.result.peak.tailingFactor)
              }}</el-descriptions-item
              ><el-descriptions-item label="接受区间"
                >{{ number(detail.rules.tailingMin) }} ～
                {{ number(detail.rules.tailingMax) }}</el-descriptions-item
              >
              <el-descriptions-item label="峰顶RT (min)">{{
                number(detail.result.peak.apexTime)
              }}</el-descriptions-item
              ><el-descriptions-item label="半高宽 (min)">{{
                number(detail.result.peak.widthHalfHeight)
              }}</el-descriptions-item
              ><el-descriptions-item label="窗口点数">{{
                detail.result.peak.pointCount
              }}</el-descriptions-item>
              <el-descriptions-item label="估计积分面积">{{
                number(detail.result.peak.area)
              }}</el-descriptions-item
              ><el-descriptions-item label="窗口 (min)"
                >{{ number(detail.result.peak.start) }} ～
                {{ number(detail.result.peak.end) }}</el-descriptions-item
              ><el-descriptions-item label="峰形依据">{{
                detail.result.peak.reasons.join('；')
              }}</el-descriptions-item>
            </el-descriptions>
            <el-descriptions title="离子比检查" :column="3" border>
              <el-descriptions-item label="状态">{{
                CHECK_LABELS[detail.result.ratio.state]
              }}</el-descriptions-item
              ><el-descriptions-item label="实测定性／定量比">{{
                number(detail.result.ratio.value)
              }}</el-descriptions-item
              ><el-descriptions-item label="参考比">{{
                number(detail.result.ratio.reference)
              }}</el-descriptions-item>
              <el-descriptions-item label="相对偏差 (%)">{{
                number(detail.result.ratio.deviationPct)
              }}</el-descriptions-item
              ><el-descriptions-item label="允许相对偏差 (%)"
                >±{{ number(detail.result.ratio.tolerancePct) }}</el-descriptions-item
              ><el-descriptions-item label="面积来源">{{
                detail.result.ratio.areaSource === 'imported'
                  ? '外部导入'
                  : detail.result.ratio.areaSource === 'trace'
                    ? '曲线估计'
                    : detail.result.ratio.areaSource === 'mixed'
                      ? '导入与曲线估计混合'
                      : '未提供'
              }}</el-descriptions-item>
              <el-descriptions-item label="定量面积">{{
                number(detail.result.ratio.quantifierArea)
              }}</el-descriptions-item
              ><el-descriptions-item label="定性面积">{{
                number(detail.result.ratio.qualifierArea)
              }}</el-descriptions-item
              ><el-descriptions-item label="依据">{{
                detail.result.ratio.reasons.join('；')
              }}</el-descriptions-item>
            </el-descriptions>
            <el-descriptions title="限量数值比较" :column="3" border>
              <el-descriptions-item label="状态">{{
                limitLabel(detail.result.limit.state)
              }}</el-descriptions-item
              ><el-descriptions-item label="换算后测定值"
                >{{ number(detail.result.limit.measuredValue) }}
                {{ detail.result.limit.unit }}</el-descriptions-item
              ><el-descriptions-item label="限量"
                >{{ number(detail.result.limit.limitValue) }}
                {{ detail.result.limit.unit }}</el-descriptions-item
              >
              <el-descriptions-item label="测定值／限量">{{
                number(detail.result.limit.factor)
              }}</el-descriptions-item
              ><el-descriptions-item label="限量依据">{{
                detail.result.limit.source || '未提供'
              }}</el-descriptions-item
              ><el-descriptions-item label="说明">{{
                detail.result.limit.reasons.join('；')
              }}</el-descriptions-item>
            </el-descriptions>
            <el-divider />
            <h3>记录人工复核</h3>
            <p class="footnote">
              复核保留原始自动判定。“标记排除”保留原始记录和外部浓度，不会删除数据。
            </p>
            <el-form label-width="90px"
              ><el-form-item label="处理"
                ><el-select v-model="action"
                  ><el-option
                    v-for="(label, value) in reviewLabels"
                    :key="value"
                    :label="label"
                    :value="value" /></el-select></el-form-item
              ><el-form-item label="复核人"
                ><el-input v-model="reviewer" maxlength="100" /></el-form-item
              ><el-form-item label="理由"
                ><el-input
                  v-model="reason"
                  type="textarea"
                  :rows="2"
                  maxlength="2000"
                  show-word-limit /></el-form-item
              ><el-form-item
                ><el-button type="primary" :loading="reviewBusy" @click="saveReview"
                  >保存复核记录</el-button
                ></el-form-item
              ></el-form
            >
            <el-table v-if="detail.reviews.length" :data="detail.reviews" border
              ><el-table-column prop="at" label="时间" min-width="190" /><el-table-column
                prop="reviewer"
                label="复核人" /><el-table-column label="处理"
                ><template #default="{ row }">{{
                  reviewLabels[row.action as keyof typeof reviewLabels]
                }}</template></el-table-column
              ><el-table-column prop="reason" label="理由" min-width="230"
            /></el-table>
            <el-collapse class="original"
              ><el-collapse-item title="查看规则及原始记录"
                ><p>文件：{{ detail.sourceName }}　引擎：{{ detail.engineVersion }}</p>
                <p>文件SHA-256：{{ detail.sourceHash }}</p>
                <pre>{{ JSON.stringify({ rules: detail.rules, row: detail.row }, null, 2) }}</pre>
              </el-collapse-item></el-collapse
            >
          </template>
        </div>
      </el-drawer>
    </div>
  </div>
</template>
<style scoped>
.analysis-page {
  padding: 24px;
  max-width: 1900px;
  margin: 0 auto;
}
.analysis-title,
.actions,
.batch-bar,
.pagination,
.template-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.analysis-title {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 24px;
}
p {
  line-height: 1.6;
}
.analysis-title p,
.template-actions,
.footnote,
.method-line span {
  color: #6b7280;
  font-size: 13px;
}
.template-actions {
  margin: 0 0 18px;
}
.batch-bar {
  margin: 18px 0;
}
.batch-bar .el-select {
  width: 380px;
}
.statistics {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 14px;
}
.statistics > div {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 15px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.statistics b {
  font-size: 25px;
}
.statistics span {
  font-size: 13px;
  color: #606266;
}
.filter-panel {
  border: 1px solid #e4e7ed;
  background: #fafbfd;
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 18px;
}
.text-filters,
.state-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.text-filters {
  margin-bottom: 14px;
}
.text-filters .el-input {
  width: 210px;
}
.state-filters {
  margin-top: 14px;
}
.state-filters .el-select {
  width: 190px;
}
.pagination {
  justify-content: space-between;
  margin-top: 16px;
}
.detail-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
:deep(.el-descriptions) {
  margin: 20px 0;
}
:deep(.el-tag) {
  white-space: normal;
  height: auto;
  min-height: 24px;
  line-height: 1.5;
}
.original {
  margin-top: 25px;
}
.original pre {
  max-height: 350px;
  overflow: auto;
  font-size: 12px;
}
@media (max-width: 1000px) {
  .analysis-page {
    padding: 16px;
  }
  .statistics {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
