<template>
  <div class="ms-info-tab-wrap">
    <div v-if="editStatus" class="spectrum-actions">
      <el-button type="primary" @click="selectedMsMethodFile">添加谱图</el-button>
      <el-tag v-if="pendingImportRows.length" type="warning">
        已暂存 {{ pendingImportRows.length }} 张谱图，保存后写入数据库
      </el-tag>
    </div>
    <SpectrumImportDialog
      v-if="importPreviewVisible"
      :rows="importRows"
      :loading="importLoading"
      @validate="validateImportRows"
      @change="syncPendingImportRows"
    />
    <template v-if="!spectrumEntries.length && !independentSpectrumCount">
      <el-empty class="empty-contain" :description="noSpectrumDescription" />
    </template>
    <div v-else-if="selectedSpectrum" class="spectrum-view">
      <div class="spectrum-header">
        <div>
          <strong>{{ ui.title }}</strong>
        </div>
        <el-select
          v-if="spectrumEntries.length > 1"
          v-model="selectedSpectrumKey"
          style="width: 360px"
        >
          <el-option
            v-for="entry in spectrumEntries"
            :key="entry.key"
            :value="entry.key"
            :label="`${entry.method.ms_mode} | ${transitionForMethod(entry.method)}`"
          />
        </el-select>
      </div>
      <MassSpectrumChart
        ref="spectrumChartRef"
        :spectrum-data="selectedSpectrumData"
        height="360px"
        :intensity-label="ui.relativeIntensity"
        :show-label-threshold="0.1"
      />
    </div>
    <div class="ms-method-chart-data-wrap">
      <div class="title">
        <span>质谱方法：</span>
        <div class="right" v-if="editStatus">
          <el-select
            v-model="msModeName"
            filterable
            allow-create
            default-first-option
            placeholder="输入仪器型号"
            style="width: 160px; margin-right: 8px"
          >
            <el-option label="MS8000" value="MS8000" />
            <el-option label="MS6000" value="MS6000" />
          </el-select>
          <el-icon class="add-ms-method" @click="() => addMsMethod(msModeName)"><Plus /></el-icon>
        </div>
      </div>
      <el-divider />
      <div v-if="msMethodData?.length">
        <div class="ms-method-table-wrap" v-for="(item, index) in msMethodData" :key="index">
          <p>{{ item.ms_mode }}</p>
          <el-alert
            v-if="item.methods.some(usesDefaultTransitionUnit)"
            title="标为默认的MRM单位采用eV；原始记录未注明单位。"
            type="info"
            :closable="false"
          />
          <el-table :data="item.methods" highlight-current-row :style="{ width: '100%' }">
            <el-table-column v-if="item.methods.some(transitionLabel)" label="MRM编号" min-width="110">
              <template #default="{ row }">{{ transitionLabel(row) || '—' }}</template>
            </el-table-column>
            <el-table-column label="方法来源／分组" min-width="190">
              <template #default="{ row }">{{ acquisitionView(row).method_source || '未提供' }}</template>
            </el-table-column>
            <el-table-column v-if="item.methods.some(method => methodQualityIssue(method))" label="数据提示" min-width="190">
              <template #default="{ row }">{{ methodQualityIssue(row) || '—' }}</template>
            </el-table-column>
            <el-table-column prop="scan_mode" label="采集模式" align="center" min-width="120">
              <template #default="scope">
                <el-input v-if="editStatus" v-model="scope.row.scan_mode" />
                <span v-else>{{ scope.row.scan_mode }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="q1" label="母离子 m/z" align="center" min-width="120">
              <template #default="scope">
                <el-input-number
                  v-if="editStatus"
                  v-model="scope.row.q1"
                  :controls="false"
                  style="width: 100%"
                />
                <span v-else>{{ numericText(scope.row.q1) }}</span>
              </template>
            </el-table-column>
            <el-table-column
              prop="q3"
              :label="editStatus ? '固定子离子 m/z（Q3）' : '子离子／谱峰'"
              align="center"
              min-width="170"
            >
              <template #default="scope">
                <el-input-number
                  v-if="editStatus"
                  v-model="scope.row.q3"
                  :controls="false"
                  style="width: 100%"
                />
                <span v-else>{{ productForMethod(scope.row) }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-if="editStatus || item.methods.some((method) => hasValue(method.transition_role))"
              label="用途"
              min-width="90"
              ><template #default="scope"
                ><el-select v-if="editStatus" v-model="scope.row.transition_role" clearable
                  ><el-option value="quantifier" label="定量" /><el-option
                    value="qualifier"
                    label="定性" /></el-select
                ><span v-else>{{
                  scope.row.transition_role === 'quantifier'
                    ? '定量'
                    : scope.row.transition_role === 'qualifier'
                      ? '定性'
                      : '未指定'
                }}</span></template
              ></el-table-column
            >
            <el-table-column prop="adduct" label="加合" align="center" min-width="110">
              <template #default="scope"
                ><el-input v-if="editStatus" v-model="scope.row.adduct" /><span v-else>{{
                  scope.row.adduct ?? '未知'
                }}</span></template
              >
            </el-table-column>
            <el-table-column
              v-if="editStatus"
              prop="ce_unit"
              label="CE单位"
              align="center"
              min-width="110"
            >
              <template #default="scope"
                ><el-input v-if="editStatus" v-model="scope.row.ce_unit" /><span v-else>{{
                  scope.row.ce_unit ?? '未知'
                }}</span></template
              >
            </el-table-column>
            <el-table-column
              v-if="editStatus"
              prop="energy_type"
              label="能量类型"
              align="center"
              min-width="110"
            >
              <template #default="scope"
                ><el-input v-if="editStatus" v-model="scope.row.energy_type" /><span v-else>{{
                  energyTypeText(scope.row.energy_type)
                }}</span></template
              >
            </el-table-column>
            <el-table-column prop="ce" label="碰撞能量" align="center" min-width="155">
              <template #default="scope">
                <el-input-number
                  v-if="editStatus"
                  v-model="scope.row.ce"
                  :controls="false"
                  style="width: 100%"
                />
                <span v-else>{{
                  energyMethodText(scope.row.ce, scope.row.ce_unit, scope.row.energy_type)
                }}{{scope.row.ce_unit_source==='default'?'（默认）':''}}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-if="editStatus || item.methods.some((method) => hasValue(method.dp))"
              prop="dp"
              label="DP"
              align="center"
              min-width="120"
            >
              <template #default="scope">
                <el-input-number
                  v-if="editStatus"
                  v-model="scope.row.dp"
                  :controls="false"
                  style="width: 100%"
                />
                <span v-else>{{ scope.row.dp }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-if="editStatus || item.methods.some((method) => hasValue(method.cxp))"
              prop="cxp"
              label="CXP"
              align="center"
              min-width="120"
            >
              <template #default="scope">
                <el-input-number
                  v-if="editStatus"
                  v-model="scope.row.cxp"
                  :controls="false"
                  style="width: 100%"
                />
                <span v-else>{{ scope.row.cxp }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="polarity" label="离子极性" align="center" min-width="100">
              <template #default="scope">
                <el-select v-if="editStatus" v-model="scope.row.polarity" placeholder="请选择极性">
                  <el-option label="正" :value="1" />
                  <el-option label="负" :value="0" />
                </el-select>
                <span v-else>{{
                  scope.row.polarity === 1 ? '正' : scope.row.polarity === 0 ? '负' : '未知'
                }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-if="editStatus"
              prop="ion_source"
              label="离子源"
              align="center"
              min-width="120"
            >
              <template #default="scope">
                <el-input v-if="editStatus" v-model="scope.row.ion_source" />
                <span v-else>{{
                  scope.row.ion_source ||
                  spectrumForMethod(scope.row)?.acquisition.ionization ||
                  '-'
                }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-if="editStatus"
              :label="ui.precursorType"
              align="center"
              min-width="130"
            >
              <template #default="scope">
                {{ spectrumForMethod(scope.row)?.acquisition.precursorType || '-' }}
              </template>
            </el-table-column>
            <el-table-column
              v-if="editStatus"
              prop="cad_value"
              label="值(CAD)"
              align="center"
              min-width="120"
            >
              <template #default="scope">
                <el-input-number
                  v-if="editStatus"
                  v-model="scope.row.cad_value"
                  :controls="false"
                />
                <span v-else>{{ scope.row.cad_value }}</span>
              </template>
            </el-table-column>
            <el-table-column
              v-if="editStatus"
              fixed="right"
              label="Operations"
              min-width="120"
              align="center"
            >
              <template #default="scope">
                <el-button
                  link
                  type="danger"
                  size="small"
                  @click.prevent="deleteMsMethodRow(item.ms_mode, scope.$index)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <p class="method-note">MRM/SRM 显示固定子离子；MS2 的全部谱峰见上方谱图与谱峰表。</p>
          <el-collapse>
            <el-collapse-item title="离子源与其他采集条件">
              <div v-for="method in item.methods" :key="method.id" class="acquisition-method">
                <div class="acquisition-heading">
                  <strong
                    >方法 {{ method.id ?? '未编号' }} · {{ method.ms_mode || '仪器未提供' }}</strong
                  >
                  <el-button v-if="editStatus" link @click="editConditions(method)"
                    >编辑离子源及其他条件</el-button
                  >
                </div>
                <el-descriptions :column="2" border>
                  <el-descriptions-item
                    v-for="row in methodConditions(method)"
                    :key="row.label"
                    :label="row.label"
                    >{{ row.value }}</el-descriptions-item
                  >
                </el-descriptions>
                <el-collapse v-if="method.conditions" class="raw-acquisition">
                  <el-collapse-item title="查看原始采集条件">
                    <pre>{{ JSON.stringify(method.conditions, null, 2) }}</pre>
                  </el-collapse-item>
                </el-collapse>
              </div>
            </el-collapse-item>
          </el-collapse>
          <el-button
            v-if="editStatus"
            class="mt-4"
            style="width: 100%; margin-top: 8px"
            @click="() => addMsMethod(item.ms_mode)"
            >添加行</el-button
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { acquisitionView, acquisitionRowsForMethod, isTransitionMethod, methodQualityIssue } from '../../../shared/acquisitionParameters.mjs'
import { invokeIPC } from '../utils/ipcInvoke'

import type { MsMethodsList, SpectrumImportRow } from '@renderer/type'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
// import { MsMethodsList, SpectrumData } from '@renderer/type'
import { computed, onMounted, ref, toRaw, watch } from 'vue'
import MassSpectrumChart from '@renderer/components/MassSpectrumChart.vue'
import { scopedInvoke } from '../utils/scopedIPC'
import {
  acquisitionRows,
  hasValue,
  productIonText,
  energyMethodText,
  energyTypeText,
  numericText,
  methodTransitionText,
  type SpectrumDisplay
} from '../../../shared/scientificDisplay'
import SpectrumImportDialog from '@renderer/components/SpectrumImportDialog.vue'

async function editConditions(method: MsMethod): Promise<void> {
  try {
    const result = await ElMessageBox.prompt(
      '按来源填写参数及单位，以JSON对象保存。例如 {"源温度":{"value":500,"unit":"℃"}}；示例值不代表推荐实验条件。',
      '离子源及其他采集条件',
      {
        inputType: 'textarea',
        inputValue: JSON.stringify(method.conditions ?? {}, null, 2),
        inputValidator: (text) => {
          try {
            const value = JSON.parse(text)
            return value && typeof value === 'object' && !Array.isArray(value)
              ? true
              : '需要JSON对象'
          } catch {
            return 'JSON格式无效'
          }
        }
      }
    )
    method.conditions = JSON.parse(result.value)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  }
}
interface StoredSpectrum {
  schemaVersion: string
  source: { name: string; library: string; nistNumber: string; dbNumber: string }
  acquisition: {
    precursorType: string
    precursorMz: number
    spectrumType: string
    instrumentType: string
    instrument: string
    ionization: string
    ionMode: string
    collisionEnergyText: string
  }
  match: {
    type: 'strict' | 'representative' | 'template' | 'imported'
    q1: number | null
    q3: number | null
  }
  peaks: { mz: number; intensity: number }[]
}

interface SpectrumEntry {
  key: string
  method: MsMethodsList['methods'][number]
  spectrum: StoredSpectrum
}

const ui = {
  title: '已有方法谱图',
  precursorType: '前体类型',
  relativeIntensity: '相对强度'
}
function decodeSpectrum(value: unknown): StoredSpectrum | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const encoded = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredSpectrum
    if (
      !['nist-ms2-v1', 'mass-spectrum-v1'].includes(parsed.schemaVersion) ||
      !Array.isArray(parsed.peaks)
    )
      return null
    if (
      parsed.peaks.some((point) => !Number.isFinite(point.mz) || !Number.isFinite(point.intensity))
    )
      return null
    return parsed
  } catch {
    return null
  }
}

type MsMethod = MsMethodsList['methods'][number]
function transitionLabel(method: MsMethod): string {
  return isTransitionMethod(method) ? acquisitionView(method).transition_label?.trim() || '' : ''
}
function usesDefaultTransitionUnit(method: MsMethod & { ce_unit_source?: string }): boolean {
  return isTransitionMethod(method) && method.ce_unit_source === 'default'
}
const decodedSpectrumCache = new WeakMap<object, StoredSpectrum | null>()

function spectrumForMethod(method: MsMethod): StoredSpectrum | null {
  const cached = decodedSpectrumCache.get(method)
  if (cached !== undefined) return cached
  const spectrum = decodeSpectrum(method.mass_spectrum_base64)
  decodedSpectrumCache.set(method, spectrum)
  return spectrum
}

const props = defineProps<{
  connectionId: string
  compoundId?: number
  independentSpectrumCount?: number
  independentSpectra?: SpectrumDisplay[]
  isActive: boolean
  editStatus: boolean
  msMode: string
  msMethodData: MsMethodsList[]
}>()

function spectraForMethod(method: MsMethod): SpectrumDisplay[] {
  const spectra = (props.independentSpectra ?? []).filter(
    (spectrum) =>
      method.id !== undefined && spectrum.methodIds?.some((id) => String(id) === String(method.id))
  )
  const legacy = spectrumForMethod(method)
  if (legacy)
    spectra.push({
      kind: 'numeric',
      spectrum_type: legacy.acquisition?.spectrumType,
      peaks: legacy.peaks,
      methodIds: [method.id]
    })
  return spectra
}
function transitionForMethod(method: MsMethod): string {
  return methodTransitionText(method, spectraForMethod(method))
}
function productForMethod(method: MsMethod): string {
  return productIonText(method.q3, spectraForMethod(method))
}
function methodConditions(method: MsMethod) {
  const rows = [...acquisitionRowsForMethod(method), ...acquisitionRows(method.conditions, method.scan_mode)]
  const extra: [string, unknown][] = [
    ['离子源', method.ion_source || spectrumForMethod(method)?.acquisition.ionization],
    ['前体类型', method.adduct || spectrumForMethod(method)?.acquisition.precursorType],
    ['能量类型', hasValue(method.energy_type) ? energyTypeText(method.energy_type) : null],
    [
      'CAD',
      hasValue(method.cad_value) ? `${method.cad_value} ${method.cad_type ?? ''}`.trim() : null
    ]
  ]
  for (const [label, value] of extra)
    if (hasValue(value) && !rows.some((row) => row.label === label))
      rows.push({ label, value: String(value) })
  return rows
}

const noSpectrumDescription = computed(() => {
  const methods = props.msMethodData.flatMap((group) => group.methods)
  if (methods.some((method) => method.mass_spectrum_base64 && !spectrumForMethod(method)))
    return '旧谱图解析失败，原始数据已保留，可在来源中核对'
  return methods.length ? '有方法，无可显示的旧谱图' : '暂无谱图或方法数据'
})
const spectrumEntries = computed<SpectrumEntry[]>(() =>
  props.msMethodData.flatMap((group) =>
    group.methods.flatMap((method) => {
      const spectrum = spectrumForMethod(method)
      return spectrum
        ? [
            {
              key: String(method.id ?? group.ms_mode + '-' + method.q1 + '-' + method.q3),
              method,
              spectrum
            }
          ]
        : []
    })
  )
)
const selectedSpectrumKey = ref('')
const selectedSpectrum = computed(
  () =>
    spectrumEntries.value.find((entry) => entry.key === selectedSpectrumKey.value) ??
    spectrumEntries.value[0]
)
const selectedSpectrumData = computed(() => selectedSpectrum.value?.spectrum.peaks ?? [])

watch(
  spectrumEntries,
  (entries) => {
    if (!entries.some((entry) => entry.key === selectedSpectrumKey.value)) {
      selectedSpectrumKey.value = entries[0]?.key ?? ''
    }
  },
  { immediate: true }
)
const emit = defineEmits([
  'deleteMsMethodRow',
  'addMsMethod',
  'changeMsMode',
  'stageSpectrumImport'
])
const spectrumChartRef = ref<typeof MassSpectrumChart>()
const msModeName = computed({
  get: () => props.msMode,
  set: (val: string) => {
    emit('changeMsMode', val)
  }
})
// const data: SpectrumData = [
//   { mz: 81.11, intensity: 12000 },
//   { mz: 172.21, intensity: 95000 },
//   { mz: 368.93, intensity: 371000 },
//   { mz: 369.22, intensity: 255000 }
// ]

/**
 * 删除质谱方法内容行
 * @param msMode 质谱型号
 * @param index 内容行索引
 */
const deleteMsMethodRow = (msMode: string, index: number) => {
  emit('deleteMsMethodRow', msMode, index)
}

/**
 * 添加质谱方法
 */
const addMsMethod = (msMode: string) => {
  emit('addMsMethod', msMode)
}

const importPreviewVisible = ref(false)
const importLoading = ref(false)
const importRows = ref<SpectrumImportRow[]>([])
const pendingImportRows = ref<SpectrumImportRow[]>([])

const cloneImportRows = (rows: SpectrumImportRow[]): SpectrumImportRow[] =>
  rows.map((row) => {
    const raw = toRaw(row)
    return { ...raw, messages: raw.messages ? [...raw.messages] : undefined }
  })

const syncPendingImportRows = (rows: SpectrumImportRow[]) => {
  const clonedRows = cloneImportRows(rows)
  pendingImportRows.value = clonedRows
  emit('stageSpectrumImport', clonedRows)
}

const selectedMsMethodFile = async () => {
  const option = {
    title: '选择已填写的谱图批量导入模板',
    filters: [{ name: 'Excel 谱图模板', extensions: ['xlsx', 'xls'] }]
  }
  const paths = (await invokeIPC('dialog:openFile', option)) as string[] | null
  if (!paths?.length) return
  importLoading.value = true
  try {
    const result = await scopedInvoke(
      props.connectionId,
      'spectrum-import:parse',
      paths[0],
      props.compoundId
    )
    if (!result.success) {
      ElMessage.error(result.error || '谱图模板解析失败')
      return
    }
    importRows.value = result.rows
    importPreviewVisible.value = true
    syncPendingImportRows(result.rows)
  } finally {
    importLoading.value = false
  }
}

const validateImportRows = async (rows: SpectrumImportRow[]) => {
  importLoading.value = true
  try {
    const result = await scopedInvoke(props.connectionId, 'spectrum-import:validate', rows)
    if (!result.success) {
      ElMessage.error(result.error || '谱图数据校验失败')
      return
    }
    importRows.value = result.rows
    syncPendingImportRows(result.rows)
    if (result.summary.errors) ElMessage.warning(`仍有 ${result.summary.errors} 张谱图未通过校验`)
    else ElMessage.success('谱图数据校验通过')
  } finally {
    importLoading.value = false
  }
}

watch(
  () => props.editStatus,
  (editing) => {
    if (!editing) {
      importPreviewVisible.value = false
      importRows.value = []
      pendingImportRows.value = []
      emit('stageSpectrumImport', [])
    }
  }
)

// 组件加载后延迟重新绘制echart实列
watch(
  () => props.isActive,
  () => {
    if (props.isActive) {
      const timmer = setTimeout(() => {
        spectrumChartRef.value?.resize()
        clearTimeout(timmer)
      }, 100)
    }
  },
  { immediate: true }
)

onMounted(() => {
  console.log(props, 'test')
})
</script>
<style lang="less" scoped>
.ms-info-tab-wrap {
  width: 100%;
  padding: 8px;
  .spectrum-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-bottom: 12px;
  }
  .spectrum-view {
    margin-bottom: 32px;
    padding: 16px;
    border: 1px solid #ebeef5;
    border-radius: 6px;
    background: #fff;
  }
  .spectrum-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-bottom: 12px;
  }

  .ms-method-chart-data-wrap {
    margin-top: 32px;
    .ms-method-table-wrap {
      margin-bottom: 32px;
    }
    .title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      .right {
        display: flex;
        align-items: center;
        .add-ms-method {
          cursor: pointer;
        }
      }
    }
  }
  .empty-contain {
    width: 100%;
  }
}
</style>

<style scoped>
.method-note {
  margin: 10px 0;
  font-size: 13px;
  color: #606266;
}
.acquisition-method {
  margin: 8px 0 16px;
}
.acquisition-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.raw-acquisition {
  margin-top: 10px;
}
.raw-acquisition pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 360px;
  overflow-y: auto;
}
</style>
