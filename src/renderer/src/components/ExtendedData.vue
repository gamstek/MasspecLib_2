<script setup lang="ts">
import type { RecordData } from '../../../shared/dataPackage'
import { computed, ref, watch } from 'vue'
import {invokeIPC} from '../utils/ipcInvoke'
import { energyText, numericText, acquisitionRows } from '../../../shared/scientificDisplay'
import MassSpectrumChart from './MassSpectrumChart.vue'
const props = defineProps<{
  compoundId: number
  section: 'spectra' | 'profiles' | 'sources'
  active?: boolean
  editStatus: boolean
  data: RecordData
}>()
const emit = defineEmits<{ change: [data: RecordData] }>()
const selectedId = ref<number | string | null>(null)
const spectra = computed<RecordData[]>(() => props.data?.spectra ?? [])
const profiles = computed<RecordData[]>(() => props.data?.profiles ?? [])
const sources = computed<RecordData[]>(() => props.data?.sources ?? [])
const selected = computed(
  () => spectra.value.find((item) => item.id === selectedId.value) ?? spectra.value[0]
)
const loadingPeaks = ref(false)
const peakError = ref(false)
const retry = ref(0)
const loadedPeaks = ref(new Map<string | number, RecordData[]>())
const selectedPeaks = computed(() => selected.value?.peaksDeferred
  ? loadedPeaks.value.get(selected.value.id) ?? []
  : selected.value?.peaks ?? [])
watch([() => props.data.spectra, () => props.data.fileLibraryId, () => props.data.fileRecordId], () => { loadedPeaks.value = new Map() })
watch(
  [() => props.active, () => props.data.fileLibraryId, () => props.data.fileRecordId, selected, retry],
  async ([active, libraryId, id, item], _previous, onCleanup) => {
    loadingPeaks.value = false
    peakError.value = false
    if (active === false || props.section !== 'spectra' || !item?.peaksDeferred ||
        !libraryId || id == null || loadedPeaks.value.has(item.id)) return
    let outdated = false
    onCleanup(() => { outdated = true })
    loadingPeaks.value = true
    try {
      const peaks = await invokeIPC('delivery:call', 'POST', '/admin/file-sources/peaks', {
        libraryId, id, spectrumId: item.id
      })
      if (!outdated) loadedPeaks.value.set(item.id, peaks)
    } catch {
      if (!outdated) peakError.value = true
    } finally {
      if (!outdated) loadingPeaks.value = false
    }
  },
  { immediate: true }
)
const points = computed(() =>
  selectedPeaks.value.map((peak: RecordData) => ({
    mz: Number(peak.mz),
    intensity: Number(peak.intensity)
  }))
)
const peakPage = ref(1)
watch(
  () => selected.value?.id,
  () => {
    peakPage.value = 1
  }
)
const peakRows = computed(() => {
  const peaks = selectedPeaks.value
  const max = peaks.reduce(
    (max: number, peak: RecordData) => Math.max(max, Number(peak.intensity)),
    0
  )
  return peaks.map((peak: RecordData, index: number) => ({
    ...peak,
    sequence: index + 1,
    relative: max > 0 ? ((Number(peak.intensity) / max) * 100).toFixed(2) : '—'
  }))
})
const linkedMethods = computed(() =>
  (selected.value?.methodIds ?? [])
    .map((id: number) => props.data?.methodLabels?.[id] ?? `质谱方法 ${id}`)
    .join('、')
)
function nature(value: unknown): string {
  const labels: Record<string, string> = {
    'synthetic-test': '软件测试数据',
    experimental: '实验测定',
    predicted: '预测数据',
    reference: '参考数据'
  }
  return labels[String(value)] ?? text(value)
}
function change(section: 'spectra' | 'profiles', id: number, field: string, value: unknown): void {
  const data = JSON.parse(JSON.stringify(props.data))
  const item = data[section].find((entry: RecordData) => entry.id === id)
  if (item) item[field] = value
  emit('change', data)
}
function text(value: unknown): string {
  return value === null || value === undefined
    ? '未知'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value)
}
</script>
<template>
  <section v-if="section === 'spectra'" style="margin-bottom: 24px">
    <h3>独立谱图</h3>
    <el-empty v-if="!spectra.length" description="没有独立谱图；下方可查看已有质谱方法或旧谱图" />
    <template v-else-if="selected">
      <el-select
        :model-value="selected.id"
        @update:model-value="selectedId = $event"
        style="width: 100%"
      >
        <el-option
          v-for="item in spectra"
          :key="item.id"
          :value="item.id"
          :label="`${item.spectrum_type ?? '类型未知'} | ${item.adduct ?? '加合未知'} | ${item.polarity === 1 ? '正' : item.polarity === 0 ? '负' : '极性未知'} | 谱图 ${item.id}`"
        />
      </el-select>
      <p v-if="loadingPeaks" role="status">正在加载谱峰…</p>
      <p v-else-if="peakError">谱峰加载失败。<el-button link type="primary" @click="retry++">重试</el-button></p>
      <el-descriptions :column="2" border class="spectrum-summary" style="margin-top: 16px">
        <el-descriptions-item label="谱图形式">{{
          selected.kind === 'image' ? '图片' : '数值谱'
        }}</el-descriptions-item>
        <el-descriptions-item label="母离子（前体）m/z">{{
          numericText(selected.precursor_mz)
        }}</el-descriptions-item>
        <el-descriptions-item label="碰撞能量">{{
          energyText(selected.collision_energy)
        }}</el-descriptions-item>
        <el-descriptions-item label="加合">
          <el-input
            v-if="editStatus"
            :model-value="selected.adduct"
            @update:model-value="change('spectra', selected.id, 'adduct', $event)"
          />
          <span v-else>{{ text(selected.adduct) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="极性">
          <el-select
            v-if="editStatus"
            :model-value="selected.polarity"
            clearable
            @update:model-value="
              change('spectra', selected.id, 'polarity', $event === '' ? null : $event)
            "
            ><el-option :value="1" label="正" /><el-option :value="0" label="负"
          /></el-select>
          <span v-else>{{
            selected.polarity === 1 ? '正' : selected.polarity === 0 ? '负' : '未知'
          }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="数据性质">{{ nature(selected.nature) }}</el-descriptions-item>
        <el-descriptions-item label="采集条件" :span="2">
          <el-descriptions v-if="acquisitionRows(selected.conditions).length" :column="2" border>
            <el-descriptions-item
              v-for="row in acquisitionRows(selected.conditions)"
              :key="row.label"
              :label="row.label"
            >{{ row.value }}</el-descriptions-item>
          </el-descriptions>
          <span v-else>未提供可展示的采集条件；可展开原始记录查看</span>
        </el-descriptions-item>
        <el-descriptions-item label="关联质谱方法">{{
          linkedMethods || '未提供关联'
        }}</el-descriptions-item>
      </el-descriptions>
      <el-collapse style="margin: 12px 0">
        <el-collapse-item :key="selected.id" title="查看原始能量与采集条件" :name="selected.id">
          <pre class="source-details">{{ JSON.stringify({
            collision_energy: selected.collision_energy,
            conditions: selected.conditions,
            record: selected.raw
          }, null, 2) }}</pre>
        </el-collapse-item>
      </el-collapse>
      <MassSpectrumChart
        v-if="selected.kind === 'numeric' && !loadingPeaks && !peakError"
        :key="selected.id"
        :spectrum-data="points"
        height="360px"
        intensity-label="原始强度"
      />
      <img
        v-else-if="selected.kind === 'image'"
        :src="`data:${selected.image_mime};base64,${selected.image_base64}`"
        alt="来源谱图图片"
        style="max-width: 100%; max-height: 500px"
      />
      <template v-if="selected.kind === 'numeric' && !loadingPeaks && !peakError">
        <p>谱峰表保留原始精度及重复 m/z；相对强度仅用于显示，按当前谱图最高原始强度计算。</p>
        <el-table :data="peakRows.slice((peakPage - 1) * 50, peakPage * 50)" border>
          <el-table-column prop="sequence" label="序号" width="80" />
          <el-table-column prop="mz" label="子离子/谱峰 m/z" />
          <el-table-column prop="intensity" label="原始强度" />
          <el-table-column prop="relative" label="相对强度（%）" />
        </el-table>
        <el-pagination
          v-model:current-page="peakPage"
          :page-size="50"
          :total="peakRows.length"
          layout="total, prev, pager, next"
        />
        <p>只有来源明确为二级质谱时，谱峰才可作为碎片离子解读；未知谱图类型不自动推断。</p>
      </template>
    </template>
  </section>
  <section v-else-if="section === 'profiles'">
    <el-empty v-if="!profiles.length" description="暂无检测扩展数据" />
    <el-card v-for="profile in profiles" :key="profile.id" style="margin-bottom: 16px">
      <el-form label-width="100px">
        <el-form-item label="档案名称"
          ><el-input
            :model-value="profile.title"
            :disabled="!editStatus"
            @update:model-value="change('profiles', profile.id, 'title', $event)"
        /></el-form-item>
        <el-form-item label="基质"
          ><el-input
            :model-value="profile.matrix"
            :disabled="!editStatus"
            @update:model-value="change('profiles', profile.id, 'matrix', $event)"
        /></el-form-item>
        <el-form-item label="验证状态"
          ><el-input
            :model-value="profile.verification_status"
            :disabled="!editStatus"
            @update:model-value="change('profiles', profile.id, 'verification_status', $event)"
        /></el-form-item>
      </el-form>
      <el-descriptions :column="1" border
        ><el-descriptions-item
          v-for="(value, key) in profile.data ?? {}"
          :key="String(key)"
          :label="String(key)"
          >{{ text(value) }}</el-descriptions-item
        ></el-descriptions
      >
    </el-card>
  </section>
  <section v-else>
    <el-empty v-if="!sources.length" description="暂无来源记录；旧版或人工录入数据可能缺少来源" />
    <el-card v-for="source in sources" :key="source.id" style="margin-bottom: 16px">
      <el-descriptions :column="2" border>
        <el-descriptions-item label="来源库">{{
          source.source_record.library.name
        }}</el-descriptions-item>
        <el-descriptions-item label="库版本">{{
          text(source.source_record.library.version)
        }}</el-descriptions-item>
        <el-descriptions-item label="来源键">{{
          source.source_record.source_key
        }}</el-descriptions-item>
        <el-descriptions-item label="导入批次">{{
          source.source_record.batch_id
        }}</el-descriptions-item>
        <el-descriptions-item label="提供者">{{
          text(source.source_record.library.provider)
        }}</el-descriptions-item>
        <el-descriptions-item label="许可">{{
          text(source.source_record.library.license)
        }}</el-descriptions-item>
      </el-descriptions>
      <el-collapse style="margin-top: 16px"
        ><el-collapse-item title="原始记录与来源修订">
          <pre style="white-space: pre-wrap; overflow-wrap: RecordDatawhere">{{
            JSON.stringify(source.source_record.raw, null, 2)
          }}</pre>
        </el-collapse-item></el-collapse
      >
    </el-card>
  </section>
</template>

<style scoped>
.spectrum-summary :deep(.el-descriptions__label) { min-width: 110px; width: 140px; }
.source-details { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow-y: auto; }
</style>
