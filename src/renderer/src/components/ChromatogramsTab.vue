<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { AUDIT_STATE_LABELS, analyseAsset } from '../../../shared/audit'
import ChromatogramChart from './ChromatogramChart.vue'
const props = defineProps<{ data?: any }>()
const selected = ref(''),
  checkDetail = ref<any>(),
  busy = ref(false)
const history = ref<any[]>([])
const reviewer = ref(''),
  reason = ref(''),
  action = ref('reviewed')
const assets = computed(() => (props.data?.assets ?? []).filter((x) => x.kind !== 'spectrum'))
const asset = computed(() => assets.value.find((x) => x.id === selected.value) ?? assets.value[0])
const shown = computed(() => checkDetail.value?.evidence ?? asset.value)
const result = computed(
  () =>
    checkDetail.value?.data ??
    asset.value?.check ??
    (asset.value ? analyseAsset({ ...asset.value, linkedResult: undefined }) : undefined)
)
const loading = ref(false)
let requestGeneration = 0, viewedAsset = ''
async function loadSnapshot(id?: string): Promise<void> {
  const generation = ++requestGeneration, target = asset.value?.id
  loading.value = true; checkDetail.value = undefined; history.value = []; viewedAsset = ''
  try {
    if (!target) return
    const [record, versions] = await Promise.all([
      id ? invokeIPC('audit:check', id) : undefined,
      invokeIPC('audit:history', target)
    ])
    if (generation !== requestGeneration || asset.value?.id !== target) return
    if (record && record.evidence?.id !== target) throw new Error('检查快照与当前记录不一致，请刷新后重试')
    checkDetail.value = record; history.value = versions; viewedAsset = target
  } catch (error) { if (generation === requestGeneration) ElMessage.error(String(error)) }
  finally { if (generation === requestGeneration) loading.value = false }
}
watch(() => [asset.value?.id, asset.value?.checkId], () => { reason.value = ''; void loadSnapshot(asset.value?.checkId) }, { immediate: true })
async function historical(id: string): Promise<void> {
  if (!busy.value) await loadSnapshot(id)
}
async function review(): Promise<void> {
  if (busy.value || loading.value || !checkDetail.value || viewedAsset !== asset.value?.id) return
  if (!reviewer.value.trim() || !reason.value.trim()) { ElMessage.warning('请填写复核人和复核理由'); return }
  const target = viewedAsset, id = checkDetail.value.id, revision = checkDetail.value.revision, generation = requestGeneration
  const value = { action: action.value, reviewer: reviewer.value.trim(), reason: reason.value.trim() }
  busy.value = true
  try {
    await invokeIPC('audit:review', id, revision, value)
    const refreshed = await invokeIPC('audit:check', id)
    if (generation === requestGeneration && asset.value?.id === target) { checkDetail.value = refreshed; reason.value = '' }
    ElMessage.success('复核已记录')
  } catch (error) { ElMessage.error(String(error)) }
  finally { busy.value = false }
}
</script>
<template>
  <div class="chromatograms">
    <el-empty
      v-if="!assets.length"
      description="当前范围暂无已关联的色谱或测定记录。只有参考质谱时不进行峰形检查。"
    />
    <template v-else>
      <p>按来源、方法和记录分别展示。数值轨迹可计算峰形；仅图片可查看，缺少数值时显示数据不足。</p>
      <el-select :disabled="busy" v-model="selected" :placeholder="asset?.methodName" style="width: 100%" filterable>
        <el-option
          v-for="item in assets"
          :key="item.id"
          :value="item.id"
          :label="`${item.batchName} · ${item.methodName} · ${item.row?.sample ?? item.recordKey} · ${item.sources.map((s) => s.name).join(' / ') || '来源未明确'}`"
        />
      </el-select>
      <p v-if="loading">正在加载当前记录的判定与历史…</p>
      <template v-if="asset && result && !loading">
        <p>
          {{ asset.sources.map((s) => s.name).join(' / ') || '来源未明确' }} ·
          {{ asset.methodName }} · {{ asset.ruleVersion }}
        </p>
        <el-alert
          v-if="asset.linkedResult"
          title="本曲线关联一条测定记录，综合离子比和超限判定请选对应的测定记录。"
          type="info"
          :closable="false"
        />
        <ChromatogramChart
          v-if="
            shown?.row?.trace ||
            shown?.row?.qualifierTrace ||
            shown?.row?.qualifiers?.some((q) => q.trace)
          "
          :trace="shown.row.trace"
          :qualifier-trace="shown.row.qualifierTrace"
          :qualifiers="shown.row.qualifiers"
          :peak="result.peak"
        />
        <img v-else-if="shown?.image" :src="shown.image" alt="来源色谱图" class="trace-image" />
        <el-empty v-else description="此记录没有可绘制的数值色谱或图片" />
        <div class="states">
          <el-tag
            v-for="kind in ['peak', 'ratio', 'limit']"
            :key="kind"
            :type="
              ['fail', 'warn'].includes(result[kind].state)
                ? 'danger'
                : result[kind].state === 'pass'
                  ? 'success'
                  : 'info'
            "
            >{{ { peak: '峰形', ratio: '离子比', limit: '超限' }[kind] }}：{{
              AUDIT_STATE_LABELS[result[kind].state]
            }}</el-tag
          >
        </div>
        <div v-for="kind in ['peak', 'ratio', 'limit']" :key="kind">
          <p v-for="text in result[kind].reasons" :key="text">{{ text }}</p>
        </div>
        <el-table v-if="result.ratioChecks?.length" :data="result.ratioChecks"
          ><el-table-column prop="channel" label="定性通道" /><el-table-column label="实测离子比"
            ><template #default="s">{{ s.row.check.value ?? '未提供' }}</template></el-table-column
          ><el-table-column label="判定"
            ><template #default="s">{{
              AUDIT_STATE_LABELS[s.row.check.state]
            }}</template></el-table-column
          ></el-table
        >
        <template v-if="checkDetail">
          <p>检查版本：{{ checkDetail.engine_version }}；检查时间：{{ checkDetail.created_at }}</p>
          <el-collapse
            ><el-collapse-item title="检查依据与原始数值" name="evidence">
              <pre>{{ JSON.stringify(checkDetail.evidence.row, null, 2) }}</pre>
            </el-collapse-item></el-collapse
          >
          <el-collapse
            ><el-collapse-item title="历次检查（点击查看当时的数据与规则快照）" name="history"
              ><el-table :data="history"
                ><el-table-column prop="created_at" label="时间" /><el-table-column
                  prop="engine_version"
                  label="引擎"
                /><el-table-column prop="rule_version" label="规则" /><el-table-column label="查看"
                  ><template #default="s"
                    ><el-button link type="primary" @click="historical(s.row.id)">{{
                      s.row.id === asset.checkId ? '当前检查' : '历史快照'
                    }}</el-button></template
                  ></el-table-column
                ></el-table
              ></el-collapse-item
            ></el-collapse
          ><el-alert
            v-if="checkDetail.id !== asset.checkId"
            title="正在查看历史快照，以下复核将记录到该次历史检查。"
            type="info"
            :closable="false"
          />
          <el-button v-if="checkDetail.id !== asset.checkId" link type="primary" :disabled="busy" @click="historical(asset.checkId)">回到当前检查</el-button>
          <h4>人工复核</h4>
          <div class="review">
            <el-input v-model="reviewer" placeholder="复核人" maxlength="100" /><el-select
              v-model="action"
              ><el-option label="已复核" value="reviewed" /><el-option
                label="需要复测"
                value="retest" /><el-option label="标记排除" value="exclude" /></el-select
            ><el-input v-model="reason" placeholder="复核理由（必填）" maxlength="2000" /><el-button
              :loading="busy"
              :disabled="loading || !reviewer.trim() || !reason.trim()"
              @click="review"
              >记录复核</el-button
            >
          </div>
          <el-table :data="checkDetail.reviews"
            ><el-table-column prop="reviewer" label="复核人" /><el-table-column
              prop="action"
              label="操作" /><el-table-column prop="reason" label="理由" /><el-table-column
              prop="created_at"
              label="时间"
          /></el-table>
        </template>
      </template>
    </template>
  </div>
</template>
<style scoped>
.chromatograms {
  padding: 12px 0;
}
.states,
.review {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 16px 0;
}
.review .el-input {
  width: 220px;
}
.trace-image {
  max-width: 100%;
  max-height: 520px;
  object-fit: contain;
}
pre {
  white-space: pre-wrap;
  max-height: 300px;
  overflow: auto;
}
</style>
