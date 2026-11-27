<template>
  <section class="spectrum-import-preview">
    <div class="preview-header">
      <div>
        <h3>批量导入 MS2 谱图预览</h3>
        <p>当前内容仅在页面中暂存；点击页面底部“保存”后写入数据库，点击“取消”则放弃。</p>
      </div>
      <el-button :loading="loading" @click="handleValidate">重新校验</el-button>
    </div>
    <el-alert
      class="import-summary"
      :type="summary.errors ? 'error' : summary.warnings ? 'warning' : 'success'"
      :closable="false"
      show-icon
      :title="summaryTitle"
      description="这里只回显、编辑和校验模板数据；点击页面底部“保存”后才会写入数据库。"
    />

    <el-table
      :data="localRows"
      row-key="spectrumId"
      border
      highlight-current-row
      max-height="420"
      @current-change="handleCurrentChange"
    >
      <el-table-column type="expand" width="48">
        <template #default="scope">
          <el-form class="spectrum-editor" label-position="top">
            <el-row :gutter="12">
              <el-col :span="4">
                <el-form-item label="谱图编号">
                  <el-input v-model="scope.row.spectrumId" />
                </el-form-item>
              </el-col>
              <el-col :span="5">
                <el-form-item label="CAS 号">
                  <el-input v-model="scope.row.cas" />
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="化合物名称">
                  <el-input v-model="scope.row.compoundName" />
                </el-form-item>
              </el-col>
              <el-col :span="7">
                <el-form-item label="质谱型号">
                  <el-input v-model="scope.row.msMode" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row :gutter="12">
              <el-col :span="3">
                <el-form-item label="Q1">
                  <el-input v-model="scope.row.q1" />
                </el-form-item>
              </el-col>
              <el-col :span="3">
                <el-form-item label="Q3">
                  <el-input v-model="scope.row.q3" />
                </el-form-item>
              </el-col>
              <el-col :span="3">
                <el-form-item label="极性">
                  <el-select v-model="scope.row.polarity" style="width: 100%">
                    <el-option label="正" :value="1" />
                    <el-option label="负" :value="0" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="3">
                <el-form-item label="碰撞能量">
                  <el-input v-model="scope.row.collisionEnergy" />
                </el-form-item>
              </el-col>
              <el-col :span="4">
                <el-form-item label="前体类型">
                  <el-input v-model="scope.row.precursorType" />
                </el-form-item>
              </el-col>
              <el-col :span="4">
                <el-form-item label="前体 m/z">
                  <el-input v-model="scope.row.precursorMz" />
                </el-form-item>
              </el-col>
              <el-col :span="4">
                <el-form-item label="谱图来源">
                  <el-input v-model="scope.row.sourceName" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row :gutter="12">
              <el-col :span="4">
                <el-form-item label="仪器类型">
                  <el-input v-model="scope.row.instrumentType" />
                </el-form-item>
              </el-col>
              <el-col :span="5">
                <el-form-item label="仪器名称">
                  <el-input v-model="scope.row.instrumentName" />
                </el-form-item>
              </el-col>
              <el-col :span="3">
                <el-form-item label="离子化方式">
                  <el-input v-model="scope.row.ionization" />
                </el-form-item>
              </el-col>
              <el-col :span="6">
                <el-form-item label="备注">
                  <el-input v-model="scope.row.notes" />
                </el-form-item>
              </el-col>
              <el-col :span="6">
                <el-form-item label="峰列表（每行：m/z,相对强度）">
                  <el-input v-model="scope.row.peaksText" type="textarea" :rows="5" />
                </el-form-item>
              </el-col>
            </el-row>
          </el-form>
        </template>
      </el-table-column>
      <el-table-column label="校验" width="92" align="center">
        <template #default="scope">
          <el-tag :type="statusTagType(scope.row.status)">
            {{ statusLabel(scope.row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="spectrumId" label="谱图编号" min-width="130" />
      <el-table-column label="化合物处理" width="110" align="center">
        <template #default="scope">
          <el-tag :type="entityActionTagType(scope.row.compoundAction)">
            {{ entityActionLabel(scope.row.compoundAction) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="compoundId" label="化合物 ID" width="105">
        <template #default="scope"
          ><el-input-number v-model="scope.row.compoundId" :min="1" :controls="false"
        /></template>
      </el-table-column>
      <el-table-column prop="compoundName" label="化合物" min-width="180" show-overflow-tooltip />
      <el-table-column prop="cas" label="CAS 号" min-width="125" />
      <el-table-column label="方法处理" width="105" align="center">
        <template #default="scope">
          <el-tag :type="entityActionTagType(scope.row.methodAction)">
            {{ entityActionLabel(scope.row.methodAction) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="methodId" label="方法 ID" width="95">
        <template #default="scope">{{ scope.row.methodId || '-' }}</template>
      </el-table-column>
      <el-table-column prop="msMode" label="质谱型号" min-width="105" />
      <el-table-column prop="q1" label="Q1" width="82" />
      <el-table-column prop="q3" label="Q3" width="82" />
      <el-table-column label="极性" width="70" align="center">
        <template #default="scope">{{ polarityLabel(scope.row.polarity) }}</template>
      </el-table-column>
      <el-table-column prop="collisionEnergy" label="碰撞能量" width="100" />
      <el-table-column prop="peakCount" label="峰数" width="70" />
      <el-table-column label="覆盖已有谱图" width="125" align="center">
        <template #default="scope">
          <el-switch v-if="scope.row.hasExistingSpectrum" v-model="scope.row.overwriteExisting" />
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column label="校验说明" min-width="260" show-overflow-tooltip>
        <template #default="scope">
          {{ scope.row.messages?.join('；') || '校验通过' }}
        </template>
      </el-table-column>
    </el-table>

    <div v-if="previewRow" class="spectrum-preview">
      <div class="preview-title">
        <strong>谱图回显：{{ previewRow.spectrumId }}</strong>
        <span
          >{{ previewRow.compoundName }} · {{ previewRow.msMode }} · Q1 {{ previewRow.q1 }} &gt; Q3
          {{ previewRow.q3 }}</span
        >
      </div>
      <MassSpectrumChart
        :spectrum-data="previewPeaks"
        height="260px"
        intensity-label="相对强度"
        :show-label-threshold="0.1"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import type { SpectrumImportRow, SpectrumImportStatus, SpectrumPoint } from '@renderer/type'
import MassSpectrumChart from '@renderer/components/MassSpectrumChart.vue'

const props = defineProps<{
  rows: SpectrumImportRow[]
  loading: boolean
}>()

const emit = defineEmits<{
  (event: 'validate', rows: SpectrumImportRow[]): void
  (event: 'change', rows: SpectrumImportRow[]): void
}>()

const localRows = ref<SpectrumImportRow[]>([])
const previewRow = ref<SpectrumImportRow | null>(null)

function cloneRows(rows: SpectrumImportRow[]): SpectrumImportRow[] {
  return rows.map((row) => {
    const raw = toRaw(row)
    return {
      ...raw,
      messages: raw.messages ? [...raw.messages] : undefined
    }
  })
}

watch(
  () => props.rows,
  (rows) => {
    localRows.value = cloneRows(rows)
    previewRow.value = localRows.value[0] ?? null
  },
  { immediate: true }
)

watch(localRows, (rows) => emit('change', cloneRows(rows)), { deep: true })

const summary = computed(() => {
  const errors = localRows.value.filter((row) => row.status === 'error').length
  const warnings = localRows.value.filter((row) => row.status === 'warning').length
  const newCompounds = new Set(
    localRows.value
      .filter((row) => row.compoundAction === 'create')
      .map((row) => row.compoundMatchKey)
      .filter(Boolean)
  ).size
  const newMethods = new Set(
    localRows.value
      .filter((row) => row.methodAction === 'create')
      .map((row) => row.methodMatchKey)
      .filter(Boolean)
  ).size
  return { total: localRows.value.length, errors, warnings, newCompounds, newMethods }
})

const summaryTitle = computed(
  () =>
    `共 ${summary.value.total} 张谱图；错误 ${summary.value.errors}；警告 ${summary.value.warnings}；待新增化合物 ${summary.value.newCompounds}；待新增方法 ${summary.value.newMethods}`
)

const previewPeaks = computed<SpectrumPoint[]>(() => {
  if (!previewRow.value) return []
  return previewRow.value.peaksText
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[\t,，;；:：\s]+/))
    .filter((parts) => parts.length === 2)
    .map(([mz, intensity]) => ({ mz: Number(mz), intensity: Number(intensity) }))
    .filter((point) => Number.isFinite(point.mz) && Number.isFinite(point.intensity))
})

function entityActionLabel(action?: SpectrumImportRow['compoundAction']): string {
  if (action === 'match') return '匹配已有'
  if (action === 'create') return '待新增'
  return '未确定'
}

function entityActionTagType(
  action?: SpectrumImportRow['compoundAction']
): 'success' | 'warning' | 'info' {
  if (action === 'match') return 'success'
  if (action === 'create') return 'warning'
  return 'info'
}
function statusLabel(status?: SpectrumImportStatus): string {
  if (status === 'error') return '错误'
  if (status === 'warning') return '警告'
  return '通过'
}

function statusTagType(status?: SpectrumImportStatus): 'success' | 'warning' | 'danger' {
  if (status === 'error') return 'danger'
  if (status === 'warning') return 'warning'
  return 'success'
}

function polarityLabel(value: SpectrumImportRow['polarity']): string {
  if (value === 1 || String(value).trim() === '1' || String(value).trim() === '正') return '正'
  if (value === 0 || String(value).trim() === '0' || String(value).trim() === '负') return '负'
  return '-'
}

function handleCurrentChange(row: SpectrumImportRow | null): void {
  if (row) previewRow.value = row
}

function handleValidate(): void {
  emit('validate', cloneRows(localRows.value))
}
</script>

<style scoped lang="less">
.spectrum-import-preview {
  margin-bottom: 24px;
  padding: 16px;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  background: #fff;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;

  h3,
  p {
    margin: 0;
  }

  p {
    margin-top: 6px;
    color: #909399;
  }
}

.import-summary {
  margin-bottom: 14px;
}

.spectrum-editor {
  padding: 12px 18px 0;
  background: #f8fafc;
}

.spectrum-preview {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
}

.preview-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  color: #606266;
}
</style>
