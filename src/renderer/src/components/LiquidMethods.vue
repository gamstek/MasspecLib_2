<script setup lang="ts">
import { computed, reactive } from 'vue'
import { ElCard } from 'element-plus'
import { groupLiquidMethods } from '../../../shared/liquidMethodGroups.mjs'
import {
  liquidConditionRows,
  numericText,
  columnFilmThickness,
  liquidProgramDisplay,
  mobilePhaseDisplay,
  columnDimensionValue,
  hasValue,
  retentionTimeInMinutes,
  retentionTimeText
} from '../../../shared/scientificDisplay'
import { acquisitionView, lcFlowRate, quantityText } from '../../../shared/acquisitionParameters.mjs'
import { lcTemperature } from '../../../shared/lcTemperature'
import { retentionObservations } from '../../../shared/lcRetention'
import type { RecordData } from '../../../shared/dataPackage'
const props = defineProps<{ methods: RecordData[]; editable: boolean; msMethods?: RecordData[] }>()
const emit = defineEmits<{ remove: [index: number]; add: [] }>()
const openMethods = reactive(new WeakSet<RecordData>())
const fields = [
  ['column_type', '色谱柱'],
  ['column_length_mm', '色谱柱长度_mm'],
  ['column_inner_diameter_mm', '色谱柱内径_mm'],
  ['column_particle_size_um', '色谱柱粒径_μm']
]
const stepFields = [
  ['time', '时间'],
  ['percentage_A', 'A相比例（%）'],
  ['percentage_B', 'B相比例（%）'],
  ['flow_rate', '流速'],
  ['time_unit', '时间单位'],
  ['flow_rate_unit', '流速单位']
]
const displayMethods = computed(() => groupLiquidMethods(props.methods, props.editable).map(({ method, members }) => {
  const savedSteps = method.methodsLinks || []
  const parsed = liquidProgramDisplay(method.program_text)
  const steps = savedSteps.length ? savedSteps : parsed.steps
  const parsedSteps = !savedSteps.length && parsed.steps.length > 0
  const column = Object.fromEntries(fields.map(([key]) => [key, columnDimensionValue(method, key)]))
  return {
    method,
    members,
    phases: mobilePhaseDisplay(method),
    steps,
    parsedSteps,
    elution: method.elution_mode || (savedSteps.length ? null : parsed.elution),
    filmThickness: columnFilmThickness(method),
    column,
    visibleColumnFields: props.editable ? fields : fields.filter(([key]) => hasValue(column[key])),
    visibleStepFields: props.editable
      ? stepFields
      : stepFields.filter(([key]) => steps.some((step) => hasValue(step[key])))
  }
}))
function updateOpenMethod(method: RecordData, event: Event): void {
  if ((event.currentTarget as HTMLDetailsElement).open) openMethods.add(method)
  else openMethods.delete(method)
}
function retentionSummary(method: RecordData): string {
  const values = new Map<number | string, string>()
  const observations = [{ value: method.retention_time, unit: method.retention_time_unit }, ...times(method)]
  for (const { value, unit } of observations) {
    if (!hasValue(value)) continue
    const label = retentionTimeText(value, unit)
    const key = retentionTimeInMinutes(value, unit) ?? label
    if (!values.has(key)) values.set(key, label)
  }
  return values.size > 2 ? `${values.size} 个保留时间` : [...values.values()].join(' / ')
}
function setRetentionTime(method: RecordData, value: number | undefined): void {
  method.retention_time = value ?? null
  method.retention_time_unit = value == null ? null : 'min'
}
function extraRows(method: RecordData) {
  return liquidConditionRows(method.conditions).filter((row) => row.label === '流速')
}
function addStep(method: RecordData): void {
  method.methodsLinks.push({
    time: undefined,
    percentage_A: '',
    percentage_B: '',
    flow_rate: undefined,
    time_unit: null,
    flow_rate_unit: null,
    step_order: method.methodsLinks.length
  })
}
function temperature(method: RecordData) { return lcTemperature(method) }
function temperatureMode(method: RecordData): string { return method._temperatureMode || (temperature(method).column_temperature_text ? 'text' : 'numeric') }
function setTemperatureMode(method: RecordData, mode: string): void {
  const previous = temperature(method); method._temperatureMode = mode
  method.conditions = { ...(previous.conditions || {}) }
  method.column_temperature_text = mode === 'text' ? previous.column_temperature_text || '' : null
  if (mode === 'text') method.column_temperature_c = null
  else delete method.conditions.column_temperature_text
}
function setTemperatureText(method: RecordData, value: string): void {
  method.column_temperature_c = null; method.column_temperature_text = value
  method.conditions = { ...(method.conditions || {}), column_temperature_text: value }
}
function times(method: RecordData): RecordData[] { return method.retention_times ?? method.conditions?.retention_times ?? retentionObservations(method) }
function addTime(method: RecordData): void {
  method.retention_times = times(method).map(r => ({ ...r, methodLocalIds: [...(r.methodLocalIds || [])] }))
  if (!method.retention_times.length && method.retention_time != null && ['s', 'min'].includes(method.retention_time_unit)) {
    method.retention_times.push({ id: crypto.randomUUID(), value: Number(method.retention_time), unit: method.retention_time_unit, peak_label: '原有保留时间', note: '', methodLocalIds: [] })
    method.retention_time = null; method.retention_time_unit = null
  }
  method.retention_times.push({ id: crypto.randomUUID(), value: undefined, unit: 'min', peak_label: '', note: '', methodLocalIds: [] })
}
function removeTime(method: RecordData, index: number): void { method.retention_times = [...times(method)]; method.retention_times.splice(index, 1) }
function channelLabel(id: string, methods?: RecordData[]): string { const m = methods?.find(m => String(m.id) === id); return m ? `${m.q1 ?? '?'} → ${m.q3 ?? '?'} · CE ${m.ce ?? '未提供'}${m.ce_unit || ''} · ${m.transition_role === 'quantifier' ? '定量' : m.transition_role === 'qualifier' ? '定性' : '用途未标注'}` : '关联通道未提供' }
function unknown(value: unknown): string {
  return value === undefined || value === null || value === '' ? '未提供' : String(value)
}
</script>
<template>
  <div>
    <h3>色谱方法 <el-button v-if="editable" @click="emit('add')">增加方法</el-button></h3>
    <el-empty v-if="!methods.length" description="未提供色谱方法" />
    <div v-if="!editable && displayMethods.length" class="method-grid method-grid-header" aria-hidden="true">
      <span>方法</span><span>色谱柱</span><span>保留时间</span><span>来源记录</span>
    </div>
    <component
      :is="editable ? ElCard : 'details'"
      v-for="({ method, members, phases, steps, parsedSteps, elution, filmThickness, column, visibleColumnFields, visibleStepFields }, index) in displayMethods"
      :key="method.id ?? index"
      :class="editable ? 'method-editor' : 'method-row'"
      :open="editable ? undefined : openMethods.has(method)"
      @toggle="updateOpenMethod(method, $event)"
    >
      <template v-if="editable" #header
        >色谱方法 {{ index + 1 }} <small v-if="members.length > 1"> · {{ members.length }} 条来源使用相同条件</small><span v-if="method.lc_mode">· {{ method.lc_mode }}</span
        ><el-button
          v-if="editable"
          link
          type="danger"
          style="float: right"
          @click="emit('remove', index)"
          >删除本方法</el-button
        ></template
      >
      <summary v-if="!editable" class="method-grid method-summary">
        <span class="method-number">方法 {{ index + 1 }}</span>
        <span>{{ column.column_type || '—' }}<small v-if="method.lc_mode"> · {{ method.lc_mode }}</small></span>
        <span class="method-retention">{{ retentionSummary(method) || '—' }}</span>
        <span class="method-source-count">{{ members.length }} 条</span>
      </summary>
      <div v-if="editable || openMethods.has(method)" :class="{ 'method-details': !editable }">
      <el-table v-if="visibleColumnFields.length" :data="[method]" border
        ><el-table-column v-for="field in visibleColumnFields" :key="field[0]" :label="field[1]" min-width="150"
          ><template #default="scope"
            ><el-input
              v-if="editable && field[0] === 'column_type'"
              v-model="scope.row[field[0]]"
              :placeholder="hasValue(column[field[0]]) ? String(column[field[0]]) : undefined"
            /><el-input-number
              v-else-if="editable"
              v-model="scope.row[field[0]]"
              :placeholder="hasValue(column[field[0]]) ? String(column[field[0]]) : undefined"
              :min="0"
              :controls="false"
              style="width: 100%"
            /><span v-else>{{
              numericText(column[field[0]])
            }}<small v-if="!hasValue(scope.row[field[0]]) && hasValue(column[field[0]])" title="从源记录提取，供查看">（原文解析）</small></span></template
          ></el-table-column
        ></el-table
      >
      <p v-if="members.length === 1 && acquisitionView(method).method_source">方法来源／分组：{{ acquisitionView(method).method_source }}</p>
      <details v-if="members.length > 1" class="method-sources"><summary>查看来源与通道关联</summary>
        <p v-for="(member, sourceIndex) in members" :key="member.id ?? sourceIndex">
          {{ acquisitionView(member).method_source || '来源 ' + (sourceIndex + 1) }}
          <span v-for="(time, timeIndex) in times(member)" :key="timeIndex">
            · {{ time.value }} {{ time.unit }}
            {{ time.methodLocalIds?.map((id: string) => channelLabel(id, msMethods)).join('；') || '' }}
          </span>
        </p>
      </details>
      <p v-if="lcFlowRate(method)">流速及单位：{{ lcFlowRate(method).program ? '程序流速，见下方液相步骤' : quantityText(lcFlowRate(method)) }}</p>
      <p v-if="filmThickness !== null">毛细管柱膜厚：{{ filmThickness }} μm</p>
      <p v-if="method.chromatographic_column_mode && method.chromatographic_column_mode !== column.column_type">
        原始色谱柱说明：{{ method.chromatographic_column_mode }}
      </p>
      <p v-if="!editable && hasValue(method.retention_time) && times(method).length > 1">
        方法保留时间：{{ retentionTimeText(method.retention_time, method.retention_time_unit) }}
      </p>
      <el-form v-if="editable || temperature(method).column_temperature_text || temperature(method).column_temperature_c != null" inline style="margin-top: 15px"
        ><el-form-item label="柱温">
          <template v-if="editable"><el-select :model-value="temperatureMode(method)" style="width:110px; margin-right:8px" @change="setTemperatureMode(method, $event)"><el-option label="数值温度" value="numeric" /><el-option label="文字条件" value="text" /></el-select><el-input v-if="temperatureMode(method) === 'text'" :model-value="temperature(method).column_temperature_text || ''" placeholder="例如：室温、未控温" :maxlength="255" style="width:200px" @update:model-value="setTemperatureText(method, $event)" /><template v-else><el-input-number v-model="method.column_temperature_c" :controls="false" /><span> ℃</span></template></template>
          <span v-else>{{ temperature(method).column_temperature_text || (temperature(method).column_temperature_c != null ? `${temperature(method).column_temperature_c} ℃` : '未提供') }}</span></el-form-item
        ><el-form-item v-if="editable" label="保留时间">
            <el-input-number
              :model-value="
                retentionTimeInMinutes(method.retention_time, method.retention_time_unit) ??
                undefined
              "
              @update:model-value="setRetentionTime(method, $event)"
              :min="0"
              :controls="false"
            /><span style="margin-left: 6px">min</span>
            <span
              v-if="
                method.retention_time != null &&
                retentionTimeInMinutes(method.retention_time, method.retention_time_unit) === null
              "
              style="margin-left: 8px"
              >原值：{{
                retentionTimeText(method.retention_time, method.retention_time_unit)
              }}</span
            >
        </el-form-item></el-form
      >
      <section v-if="editable || times(method).length > 1 || times(method).some(t => t.peak_label || t.note || t.methodLocalIds?.length)" style="margin:16px 0"><h4>保留时间 / 峰记录 <el-button v-if="editable" size="small" @click="addTime(method)">增加保留时间</el-button></h4>
        <p v-if="editable" style="color:#8490a0;font-size:12px">同一方法可记录多个峰；逐条填写时间、单位、峰标识及对应MRM通道。新增MRM通道须先保存，再关联；未确认的双峰不会自动归为异构体。</p>
        <el-table v-if="times(method).length" :data="editable ? times(method) : retentionObservations(method)" border>
          <el-table-column label="保留时间" width="150"><template #default="s"><el-input-number v-if="editable" v-model="s.row.value" :min="0" :controls="false" style="width:120px" /><span v-else>{{ s.row.value }}</span></template></el-table-column>
          <el-table-column label="单位" width="100"><template #default="s"><el-select v-if="editable" :model-value="s.row.unit || 'min'" @update:model-value="s.row.unit = $event; s.row.unit_source = 'explicit'"><el-option label="min" value="min" /><el-option label="s" value="s" /></el-select><span v-else>{{ s.row.unit }}{{ s.row.unit_source === 'default' ? '（默认单位）' : '' }}</span></template></el-table-column>
          <el-table-column label="峰标识" min-width="140"><template #default="s"><el-input v-if="editable" v-model="s.row.peak_label" :maxlength="255" placeholder="如：待确认峰1" /><span v-else>{{ s.row.peak_label || '未标注' }}</span></template></el-table-column>
          <el-table-column v-if="members.length === 1" label="关联MRM通道" min-width="260"><template #default="s"><el-select v-if="editable" v-model="s.row.methodLocalIds" multiple clearable placeholder="选择已保存通道"><el-option v-for="m in (msMethods || []).filter(m => m.id && m.q1 != null && m.q3 != null)" :key="m.id" :value="String(m.id)" :label="channelLabel(String(m.id), msMethods)" /></el-select><span v-else>{{ s.row.methodLocalIds?.map((id: string) => channelLabel(id, msMethods)).join('；') || '未关联' }}</span></template></el-table-column>
          <el-table-column label="备注" min-width="160"><template #default="s"><el-input v-if="editable" v-model="s.row.note" :maxlength="2000" /><span v-else>{{ s.row.note || '—' }}</span></template></el-table-column>
          <el-table-column v-if="editable" label="操作" width="70"><template #default="s"><el-button link type="danger" @click="removeTime(method, s.$index)">删除</el-button></template></el-table-column>
        </el-table><el-empty v-else description="未录入多峰记录，可使用上方原有保留时间或增加记录" :image-size="40" />
      </section>
      <el-table v-if="editable || hasValue(phases.phase_A) || hasValue(phases.phase_B)" :data="[method]" border
        ><el-table-column v-if="editable || hasValue(phases.phase_A)" label="流动相A" min-width="240"
          ><template #default="scope"
            ><el-input v-if="editable" v-model="scope.row.phase_A" type="textarea" /><span v-else>{{
              unknown(phases.phase_A)
            }}</span></template
          ></el-table-column
        ><el-table-column v-if="editable || hasValue(phases.phase_B)" label="流动相B" min-width="240"
          ><template #default="scope"
            ><el-input v-if="editable" v-model="scope.row.phase_B" type="textarea" /><span v-else>{{
              unknown(phases.phase_B)
            }}</span></template
          ></el-table-column
        ></el-table
      >
      <el-form v-if="editable || hasValue(elution) || hasValue(method.program_text)" label-width="90px" style="margin: 15px 0"
        ><el-form-item v-if="editable || hasValue(elution)" label="洗脱方式"
          ><el-select v-if="editable" v-model="method.elution_mode" clearable
            ><el-option value="isocratic" label="等度" /><el-option
              value="gradient"
              label="梯度" /></el-select
          ><span v-else>{{
            elution === 'isocratic' ? '等度' : elution === 'gradient' ? '梯度' : unknown(elution)
          }}</span></el-form-item
        ><el-form-item v-if="editable || hasValue(method.program_text)" label="液相程序"
          ><el-input
            v-if="editable"
            v-model="method.program_text"
            type="textarea"
            placeholder="填写液相程序原文"
          /><span v-else>{{ unknown(method.program_text) }}</span></el-form-item
        ></el-form
      >
      <p v-if="parsedSteps" class="source-program-note">下表从液相程序原文解析。</p>
      <p v-else-if="!steps.length && method.program_text" class="source-program-note">程序请见上方原文，暂未识别出完整步骤。</p>
      <el-table v-if="steps.length" :data="steps" border
        ><el-table-column type="index" label="步骤" width="65" /><el-table-column
          v-for="field in visibleStepFields"
          :key="field[0]"
          :label="field[1]"
          min-width="120"
          ><template #default="scope"
            ><el-input-number
              v-if="editable && !parsedSteps && ['time', 'flow_rate'].includes(field[0])"
              v-model="scope.row[field[0]]"
              :controls="false"
              style="width: 100%"
            /><el-input v-else-if="editable && !parsedSteps" v-model="scope.row[field[0]]" /><span v-else>{{
              numericText(scope.row[field[0]])
            }}</span></template
          ></el-table-column
        ><el-table-column v-if="editable && !parsedSteps" label="操作"
          ><template #default="scope"
            ><el-button link type="danger" @click="method.methodsLinks.splice(scope.$index, 1)"
              >删除</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <el-button v-if="editable" style="margin-top: 10px" @click="addStep(method)"
        >增加程序步骤</el-button
      >
      <el-descriptions v-if="extraRows(method).length" :column="2" border style="margin-top: 15px">
        <el-descriptions-item
          v-for="row in extraRows(method)"
          :key="row.label"
          :label="row.label"
          >{{ row.value }}</el-descriptions-item
        >
      </el-descriptions>
      <el-collapse v-if="method.conditions || phases.source" style="margin-top: 15px">
        <el-collapse-item title="来源原始液相记录（导入时原文）">
          <p v-if="phases.source">流动相：{{ phases.source }}</p>
          <pre v-if="method.conditions" class="raw-liquid-conditions">{{ JSON.stringify(method.conditions, null, 2) }}</pre>
        </el-collapse-item>
      </el-collapse>
      </div>
    </component>
  </div>
</template>

<style scoped>
.method-editor { margin: 15px 0; }
.method-grid {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr) minmax(7.5rem, 22%) 5rem;
  align-items: start;
  gap: 0.5rem;
  padding: 9px 12px;
  overflow-wrap: anywhere;
}
.method-grid-header {
  color: var(--el-text-color-secondary);
  border-bottom: 1px solid var(--el-border-color-light);
}
.method-row { border-bottom: 1px solid var(--el-border-color-lighter); }
.method-summary { cursor: pointer; list-style: none; }
.method-summary::-webkit-details-marker { display: none; }
.method-summary:hover, .method-row[open] > .method-summary { background: var(--el-fill-color-light); }
.method-retention, .method-source-count { font-variant-numeric: tabular-nums; }
.method-number::before { content: '▸'; margin-right: 0.35em; }
.method-row[open] > .method-summary .method-number::before { content: '▾'; }
.method-details { padding: 8px 12px 14px; }
@media (max-width: 720px) {
  .method-grid {
    grid-template-columns: 3.6rem minmax(0, 1fr) minmax(4rem, 22%) 3.6rem;
    padding-inline: 6px;
  }
}
.source-program-note { color: var(--el-text-color-secondary); font-size: 13px; }
.raw-liquid-conditions {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 360px;
  overflow-y: auto;
}
</style>
