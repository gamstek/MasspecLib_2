<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { groupLiquidMethods } from '../../../shared/liquidMethodGroups.mjs'
import { computed, ref, watch } from 'vue'
import { quantityText } from '../../../shared/acquisitionParameters.mjs'
import { detailFields } from '../../../shared/deliveryPresentation.mjs'
import { classificationLabel } from '../../../shared/deliveryClassification.mjs'
import MassSpectrumChart from './MassSpectrumChart.vue'
import ChromatogramChart from './ChromatogramChart.vue'
const props = defineProps<{ record: any; manifest: any; offline?: boolean; preview?: boolean; favorite?: boolean }>()
const emit = defineEmits<{ close: []; favorite: []; review: [value: any] }>()
async function copyText(text: string): Promise<void> { try { await invokeIPC('delivery:copy-text', text); ElMessage.success('已复制') } catch (e) { ElMessage.error(String(e)) } }
function copyChannels(): void { void copyText([[ '通道', ...channelFields.value.map(k => labels.value.ms?.[k] || k)], ...props.record.ms.map((m: any, i: number) => [m.transition_label || `通道 ${i + 1}`, ...channelFields.value.map(k => channelValue(m, k))])].map(row => row.join('\t')).join('\n')) }
const tab = ref('info'), reviewAction = ref('reviewed'), reviewReason = ref(''), checkId = ref('')
watch(() => props.record?.id, () => { tab.value = 'info'; reviewReason.value = ''; checkId.value = props.record?.checks?.[0]?.id || '' }, { immediate: true })
const liquidGroups = computed(() => groupLiquidMethods<any>(props.record.lc || []))
const labels = computed(() => props.manifest.fieldLabels || {}), features = computed(() => props.manifest.policy.features)
function pairs(group: string, row: any): any[] {
  return detailFields(group, row, props.manifest.policy.fields[group] || []).map((key: string) => {
    let value = display(row[key])
    if (group === 'ms' && key === 'ce') value += ` ${row.ce_unit || ''}${row.ce_unit_source==='default'?'（默认）':''}`
    if (group === 'lc' && key === 'retention_time') value += ` ${row.retention_time_unit || 'min'}${!row.retention_time_unit || row.retention_time_unit_source === 'default' ? '（默认单位）' : ''}`
    if(key==='ce_unit_source')value=({default:'软件默认',explicit:'原文注明',administrator:'管理员填写'} as any)[row[key]]||value
    if (key === 'polarity' && [0, 1].includes(row[key])) value = row[key] === 1 ? '正离子' : '负离子'
    if (key === 'transition_role') value = ({ quantifier: '定量', qualifier: '定性' } as any)[row[key]] || value
    return { key, label: labels.value[group]?.[key] || key, value }
  })
}
const sharedMs = computed(() => {
  const methods = props.record.ms || []
  if (methods.length < 2) return []
  const perChannel = new Set(['q1', 'q3', 'ce', 'dp', 'cxp', 'polarity', 'transition_label', 'transition_role', 'method_name', 'name'])
  return pairs('ms', methods[0]).filter(p => p.key !== 'ion_source_parameters_raw' && !perChannel.has(p.key) && methods.every((m: any) => JSON.stringify(m[p.key]) === JSON.stringify(methods[0][p.key])))
})
const channelFields = computed(() => ['q1','q3','ce','dp','cxp','polarity','transition_role'].filter(key => props.record.ms.some((m: any) => pairs('ms', m).some(p => p.key === key))))
function channelValue(m: any, key: string): string { return pairs('ms', m).find(p => p.key === key)?.value || '—' }
function channelPairs(m: any): any[] { return pairs('ms', m).filter(p => !['transition_label','ion_source_parameters_raw', ...channelFields.value].includes(p.key) && !sharedMs.value.some(s => s.key === p.key)) }
const rawMethods = computed(() => {
  const groups = new Map<string, string[]>()
  for (const [i, m] of props.record.ms.entries()) {
    const raw = pairs('ms', m).find(p => p.key === 'ion_source_parameters_raw')?.value
    if (raw) groups.set(raw, [...(groups.get(raw) || []), m.transition_label || `通道${i + 1}`])
  }
  return [...groups.entries()].map(([text, channels]) => ({ text, channels: channels.join('、') }))
})
const names: Record<string, string> = { value: '数值', unit: '单位', unit_source: '单位来源', explicit: '原文注明', default: '默认单位', missing: '来源未提供', program: '流速程序', modifier: '标识', loq: '定量限', source: '依据', matrix: '基质', required: '是否必需', quantifierArea: '定量峰面积', qualifierArea: '定性峰面积', reference: '参考值', tolerancePct: '容许偏差(%)', toleranceMode: '偏差类型', toleranceAbsolute: '绝对偏差', referenceSource: '参考来源', min: '下限', max: '上限', type: '类型' }
function display(v: any): string { if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.value === 'number' && typeof v.unit === 'string') return quantityText(v); if (v === null || v === undefined) return '未提供'; if (Array.isArray(v)) return v.map(display).join('；'); if (typeof v === 'object') return Object.entries(v).filter(([, x]) => x !== null && x !== '').map(([k, x]) => `${names[k] || k}：${display(x)}`).join('；'); return v === true ? '是' : v === false ? '否' : String(v) }
function channelText(id: string): string {
  const i = props.record.ms.findIndex((m: any) => m.id === id), m = props.record.ms[i]
  if (!m) return '通道未交付'
  const pair = m.q1 != null || m.q3 != null ? `${m.q1 ?? '未交付'} → ${m.q3 ?? '未交付'}` : `通道 ${i + 1}`
  return pair + (m.ce != null ? ` · CE ${m.ce}${m.ce_unit || ''}` : '') + (m.transition_role === 'quantifier' ? ' · 定量' : m.transition_role === 'qualifier' ? ' · 定性' : '')
}
const emptyPeak: any = { start: null, end: null, baselineStart: null, baselineEnd: null, apexTime: null }
const checkNames: Record<string, string> = { peak: '峰形', ratio: '离子比', limit: '数值限量' }
const stateNames: Record<string, string> = { pass: '满足规则', fail: '异常', warn: '疑似异常', unknown: '数据不足', na: '不适用' }
const reviewNames: Record<string, string> = { reviewed: '已复核', retest: '建议复测', exclude: '排除' }
</script>
<template>
  <section class="delivery-detail">
    <div class="delivery-detail-heading">
      <div class="detail-title"><h2>{{ record.compound.main_name }}</h2><div><el-button @click="copyText(record.compound.main_name)">复制名称</el-button><el-button v-if="features.favorite && !preview" @click="emit('favorite')">{{ favorite ? '取消收藏' : '收藏' }}</el-button><el-button @click="emit('close')">返回列表</el-button></div></div>
      <el-alert :title="`${manifest.personal ? '个人本地数据' : preview ? '客户界面预览' : offline ? '离线交付数据' : '客户授权数据'} · ${manifest.title} · 所属数据库：${record.sourceTitle}`" type="info" :closable="false" />
    </div>
    <el-tabs v-model="tab" class="delivery-detail-tabs">
      <el-tab-pane label="详细信息" name="info">
        <dl class="field-grid"><template v-for="p in pairs('compound', record.compound)" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl>
        <section v-if="record.classification && manifest.policy.fields.classification?.length"><h3>化合物分类</h3><p v-if="manifest.policy.fields.classification?.includes('categories')">{{ classificationLabel(record) || '未分类' }}</p><p v-if="manifest.policy.fields.classification?.includes('source_labels') && record.classification.source_labels?.length"><strong>来源原始分类：</strong><el-tag v-for="label in record.classification.source_labels" :key="label" style="margin:3px">{{label}}</el-tag></p><el-tag v-for="item in (manifest.policy.fields.classification?.includes('categories')?record.classification.items:[])" :key="item.key" :type="item.review_status === 'confirmed' ? 'success' : 'info'" style="margin:3px">{{ record.classification.catalog.find((c: any) => JSON.stringify([c.namespace,c.category_code]) === item.key)?.category_name }}{{ item.review_status ? ' · ' + (item.review_status === 'confirmed' ? '已复核' : '待复核') : '' }}</el-tag></section>
        <img v-if="manifest.policy.fields.compound?.includes('formula_diagram_base64') && record.compound.formula_diagram_base64" class="delivery-image structure" :src="record.compound.formula_diagram_base64" alt="化合物结构图" />
        <section v-if="record.sources?.length"><dl v-for="(s, i) in record.sources" :key="i" class="field-grid"><template v-for="p in pairs('source', s)" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl></section>

      </el-tab-pane>
      <el-tab-pane v-if="features.lc && record.lc.length" label="液相方法" name="lc" lazy>
        <section v-if="features.lc"><h3>色谱方法</h3><el-empty v-if="!record.lc.length" description="此记录没有已交付的液相方法" /><el-card v-for="({ method: m, members }, index) in liquidGroups" :key="m.id" class="record-card"><template #header>色谱方法 {{ index + 1 }}<small v-if="members.length > 1"> · {{ members.length }} 条来源使用相同条件</small></template><details v-if="members.length > 1"><summary>查看来源</summary><p v-for="(source, sourceIndex) in members" :key="source.id">{{ source.method_source || "来源 " + (sourceIndex + 1) }}</p></details><dl class="field-grid"><template v-for="p in pairs('lc', m)" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl><section v-if="manifest.policy.fields.lc?.includes('retention_times') && m.retention_times?.length"><h4>保留时间 / 峰记录</h4><el-table :data="m.retention_times" border><el-table-column prop="value" label="保留时间" /><el-table-column label="单位"><template #default="s">{{ s.row.unit || 'min' }}{{ !s.row.unit || s.row.unit_source === 'default' ? '（默认单位）' : '' }}</template></el-table-column><el-table-column prop="peak_label" label="峰标识" /><el-table-column label="关联MRM通道" min-width="230"><template #default="scope">{{ scope.row.methodIds?.map(channelText).join('；') || (manifest.personal ? '未关联' : '未交付通道关联') }}</template></el-table-column><el-table-column v-if="manifest.personal" prop="note" label="备注" /></el-table></section><el-table v-if="manifest.policy.fields.lc?.includes('gradient') && m.gradient?.length" :data="m.gradient"><el-table-column prop="step_order" label="顺序" /><el-table-column prop="time" label="时间" /><el-table-column prop="time_unit" label="时间单位" /><el-table-column prop="percentage_A" label="A相比例" /><el-table-column prop="percentage_B" label="B相比例" /><el-table-column prop="flow_rate" label="流速" /><el-table-column prop="flow_rate_unit" label="流速单位" /></el-table></el-card></section>
      </el-tab-pane>
      <el-tab-pane v-if="features.spectra" label="质谱方法与谱图" name="spectra" lazy>
        <el-empty v-if="!record.ms.length && !record.spectra.length" description="此记录没有已交付的谱图或质谱方法" />
        <section v-if="record.ms.length && channelFields.length" class="channel-table"><h3>MRM 通道参数 <el-button size="small" @click="copyChannels">复制通道表</el-button></h3><el-table :data="record.ms" stripe border><el-table-column label="通道" width="100"><template #default="s">{{ s.row.transition_label || `通道 ${s.$index + 1}` }}</template></el-table-column><el-table-column v-for="key in channelFields" :key="key" :label="labels.ms?.[key] || key" :min-width="key === 'dp' ? 220 : 110"><template #default="s">{{ channelValue(s.row, key) }}</template></el-table-column></el-table></section>
        <el-card v-if="sharedMs.length" class="record-card"><template #header>公共采集条件 · 适用于全部通道</template><dl class="field-grid"><template v-for="p in sharedMs" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl></el-card>
        <template v-for="(m, index) in record.ms" :key="m.id"><el-card v-if="channelPairs(m).length || m.mass_spectrum_base64" class="record-card"><template #header>{{ m.transition_label || `质谱方法 ${index + 1}` }} · 补充信息</template><dl class="field-grid"><template v-for="p in channelPairs(m)" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl><img v-if="manifest.policy.fields.ms?.includes('mass_spectrum_base64') && m.mass_spectrum_base64" class="delivery-image" :src="m.mass_spectrum_base64" alt="质谱方法谱图" /></el-card></template>
        <details v-for="raw in rawMethods" :key="raw.text" class="raw-parameters"><summary>查看离子源参数原文 · {{ raw.channels }}</summary><p>{{ raw.text }}</p></details>
        <el-card v-for="s in record.spectra" :key="s.id" class="record-card"><dl class="field-grid"><template v-for="p in pairs('spectrum', s)" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl><MassSpectrumChart v-if="manifest.policy.fields.spectrum?.includes('peaks') && s.peaks?.length && tab === 'spectra'" :spectrum-data="s.peaks" height="350px" /><img v-if="manifest.policy.fields.spectrum?.includes('image_base64') && s.image_base64" class="delivery-image" :src="s.image_base64" alt="质谱图片" /></el-card>
      </el-tab-pane>
      <el-tab-pane v-if="features.chromatograms" label="色谱图" name="chromatograms" lazy>
        <el-empty v-if="!record.chromatograms.length" description="此记录没有已交付的色谱数据" />
        <el-card v-for="c in record.chromatograms" :key="c.id" class="record-card"><dl class="field-grid"><template v-for="p in pairs('chromatogram', c)" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl><ChromatogramChart v-if="manifest.policy.fields.chromatogram?.includes('points') && c.points?.length && ['s', 'min'].includes(c.time_unit) && tab === 'chromatograms'" :trace="{ points: c.points, timeUnit: c.time_unit }" :peak="record.checks.find((x: any) => x.id === c.id)?.peak || emptyPeak" /><el-alert v-else-if="manifest.policy.fields.chromatogram?.includes('points') && c.points?.length" title="未提供明确时间单位，暂不绘制时间曲线" type="info" :closable="false" /><img v-if="manifest.policy.fields.chromatogram?.includes('image_base64') && c.image_base64" class="delivery-image" :src="c.image_base64" alt="色谱图片" /></el-card>
      </el-tab-pane>
      <el-tab-pane v-if="features.experiments" label="测定结果" name="experiments" lazy>
        <el-empty v-if="!record.experiments.length" description="此记录没有已交付的测定结果" /><el-card v-for="e in record.experiments" :key="e.id" class="record-card"><dl class="field-grid"><template v-for="p in pairs('experiment', e)" :key="p.key"><dt>{{ p.label }}</dt><dd>{{ p.value }}</dd></template></dl></el-card>
      </el-tab-pane>
      <el-tab-pane v-if="features.checks" label="检查与复核" name="checks" lazy>
        <el-alert title="检查快照基于交付时的数据和页面标明的规则；不随原始库静默变化。色谱峰形使用当前引擎默认规则，实验室阈值须另行确认。" type="info" :closable="false" />
        <el-empty v-if="!record.checks.length" description="没有可检查的数据" />
        <el-card v-for="c in record.checks" :key="c.id" class="record-card"><h3>{{ c.type === 'chromatogram' ? '色谱检查' : '测定检查' }} · {{ c.abnormal ? '异常' : c.incomplete ? '数据不足／未完成' : '未发现异常' }}</h3><p v-if="c.issue">{{ c.issue }}</p><p v-for="k in ['peak', 'ratio', 'limit'].filter(k => c[k])" :key="k">{{ checkNames[k] }}：{{ stateNames[c[k].state] }}；{{ c[k].reasons?.join('；') }}</p><p v-if="c.labels?.length">{{ c.labels.join('；') }}</p></el-card>
        <section v-if="features.review && !preview && record.checks.length"><h3>提交人工复核</h3><p v-if="offline">复核记录保存在本机，安装包原始检查快照保持不变。</p><el-select v-model="checkId" placeholder="选择检查记录"><el-option v-for="(c, i) in record.checks" :key="c.id" :value="c.id" :label="`${i + 1} · ${c.type === 'chromatogram' ? '色谱' : '测定'}检查`" /></el-select><el-select v-model="reviewAction"><el-option v-for="(label, value) in reviewNames" :key="value" :label="label" :value="value" /></el-select><el-input v-model="reviewReason" type="textarea" :maxlength="2000" placeholder="填写复核依据；复核人由登录账号自动记录" /><el-button :disabled="!checkId || !reviewReason.trim()" @click="emit('review', { checkId, action: reviewAction, reason: reviewReason })">提交复核</el-button></section>
        <section v-if="record.reviews?.length"><h3>复核历史</h3><p v-for="r in record.reviews" :key="r.id">{{ r.at }} · {{ r.reviewer }} · {{ reviewNames[r.action] }}：{{ r.reason }}</p></section>
      </el-tab-pane>
    </el-tabs>
  </section>
</template>
<style scoped>
.delivery-detail { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.delivery-detail-heading { flex: none; background: white; padding-bottom: 8px; }
.detail-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.detail-title h2 { margin: 0; font-size: 21px; overflow-wrap: anywhere; }
.delivery-detail-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.delivery-detail-tabs :deep(.el-tabs__header) { flex: none; margin: 0; }
.delivery-detail-tabs :deep(.el-tabs__content) { flex: 1; min-height: 0; overflow: auto; padding-top: 16px; }
.field-grid { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 9px 20px; font-size: 14px; line-height: 1.6; }
dt { color: #687384; word-break: keep-all; overflow-wrap: normal; } dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.record-card { margin: 12px 0; }.record-card h3 { margin: 0 0 12px; font-size: 15px; }.delivery-detail-heading :deep(.el-alert) { margin-top: 8px; padding: 6px 10px; }.record-card :deep(.el-card__header) { padding: 10px 16px; font-size: 14px; }.record-card :deep(.el-card__body) { padding: 12px 16px; } .delivery-image { max-width: 100%; max-height: 600px; object-fit: contain; } .structure { max-height: 250px; }
section .el-select { width: 220px; margin: 12px 12px 12px 0; } section .el-textarea { margin-bottom: 12px; }
@media(max-width:1000px) { .field-grid { grid-template-columns: 210px minmax(0,1fr); gap: 8px 14px; font-size: 13px; } }
.raw-parameters { margin:12px 0;padding:12px 16px;border:1px solid #e5eaf1;border-radius:6px;font-size:13px; }.raw-parameters summary { cursor:pointer;color:#65778d; }.raw-parameters p { white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7; }.channel-table h3 { font-size:15px;margin:0 0 12px; }

.detail-title h2 { font-size:20px;font-weight:600; }.delivery-detail-tabs :deep(.el-tabs__item) { font-size:13px; }.delivery-detail-tabs :deep(.el-tabs__content) { padding-top:12px; }
.field-grid { font-size:13px;line-height:1.7;gap:8px 18px; }.field-grid dt { color:#718197; }.field-grid dd { color:#25364c; }
.record-card { box-shadow:none;border-color:#e2e9f2;border-radius:7px; }.record-card :deep(.el-card__header) { background:#f8fafd;font-size:13px;font-weight:600; }.channel-table h3 { font-weight:600;font-size:14px; }
.raw-parameters { background:#fafbfd;border-color:#e2e9f2; }.delivery-detail-heading :deep(.el-alert__title) { font-size:11px;color:#7b899b; }

</style>
