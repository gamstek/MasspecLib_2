<script setup lang="ts">
import {ionModeLabel,ionModeHint} from '../../../shared/ionMode.mjs'
import { categoryPath, buildCategoryTree, taxonomyKey } from '../../../shared/taxonomy'
import { invokeIPC } from '../utils/ipcInvoke'

import { onActivated, onDeactivated, onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { RecordData } from '../../../shared/dataPackage'
import type { RecordRef } from '../../../shared/federation'
import SourceTags from '../components/SourceTags.vue'
import LiquidMethods from '../components/LiquidMethods.vue'
import ExtendedData from '../components/ExtendedData.vue'
import ChromatogramsTab from '../components/ChromatogramsTab.vue'
import MsInfoTab from './MsInfoTab.vue'
import { scopedInvoke, notifyDataChanged, notifyFavoritesChanged } from '../utils/scopedIPC'
function closeGuard(event: Event): void {
  if(!detailActive||!hasUnsavedChanges.value)return
  ;(event as CustomEvent).detail.push(async()=>{
    try{await ElMessageBox.confirm('是否保存当前修改后退出？','存在未保存修改',{confirmButtonText:'保存',cancelButtonText:'放弃修改',distinguishCancelAndClose:true});await save();return !editStatus.value}catch(e){if(e==='cancel'){await clearLocalRecovery();return true}return false}
  })
}
onMounted(()=>window.addEventListener('masspeclib2-before-close',closeGuard))
onUnmounted(()=>window.removeEventListener('masspeclib2-before-close',closeGuard))
const router = useRouter(),
  compound = ref<RecordData | null>(null),
  refValue = ref<RecordRef | null>(null)
const methods = ref<RecordData[]>([]),
  lcMethods = ref<RecordData[]>([]),
  extensions = ref<RecordData>({ spectra: [], sources: [] }),
  classes = ref<RecordData[]>([])
const auditData = ref<any>({ assets: [] })
const selectedCategories = ref<string[]>([])
const classificationOptions = computed(() =>
  buildCategoryTree(extensions.value.taxonomyCatalog ?? [], () => 1)
)
function localClassificationHint(item: RecordData): string {
  const kinds = (item.evidence || []).map((e: RecordData) => e.kind)
  return kinds.includes('manual-assignment') ? '人工归类（已锁定）' : kinds.includes('explicit-administrator-mapping') ? '按管理员明确设置的类别映射' : '沿用本地库原分类'
}
const editStatus = ref(false),
  busy = ref(false),
  activeTab = ref('info'),
  msMode = ref(''),
  pendingRows = ref<RecordData[]>([])
const informationFields=computed(()=>[['main_name','主显示名称'],['name_zh','中文名称'],['name_en','英文名称'],['cas','CAS号'],['formula','分子式']].filter(([key])=>editStatus.value||key==='main_name'||!['name_zh','name_en'].includes(key)||String(compound.value?.[key]||'').trim()!==String(compound.value?.main_name||'').trim()))
const originalMethodIds = ref<number[]>([]),
  originalLcIds = ref<number[]>([])
const viewingPublished = ref(false)
const canEditMethods = computed(
  () => !viewingPublished.value && !!compound.value && (compound.value.canEditWorkspace||!compound.value.readOnly && compound.value.schemaVersion === 4)
)
const canEdit = computed(() => canEditMethods.value || (!viewingPublished.value && !!compound.value?.canEditBasic))
const editingMethods = computed(() => editStatus.value && canEditMethods.value)
function beginEditing(): void {
  if (!canEditMethods.value) activeTab.value = 'info'
  editStatus.value = true
}
const editSnapshot = (): string => {
  const { is_favorite: _favorite, ...fields } = compound.value || {}
  return JSON.stringify({
    compound: compound.value ? fields : compound.value, methods: methods.value, lcMethods: lcMethods.value,
    extensions: extensions.value, classes: classes.value, selectedCategories: selectedCategories.value,
    pendingRows: pendingRows.value
  })
}
const baseline = ref('')
const hasUnsavedChanges = computed(() => editStatus.value && editSnapshot() !== baseline.value)
let recoveryTimer: ReturnType<typeof setTimeout> | undefined
async function clearLocalRecovery(): Promise<void> {
  clearTimeout(recoveryTimer)
  if (refValue.value) await invokeIPC('edit-recovery:clear', refValue.value).catch(() => {})
}
watch(() => hasUnsavedChanges.value ? editSnapshot() : '', value => {
  clearTimeout(recoveryTimer)
  if (!value || !refValue.value) return
  const target = { ...refValue.value }, view = JSON.parse(value)
  recoveryTimer = setTimeout(() => {
    void invokeIPC('edit-recovery:write', target, view).catch(() => ElMessage.warning('恢复草稿保存失败，请手动保存草稿'))
  }, 350)
})
async function cancelEdit(): Promise<void> {
  if (hasUnsavedChanges.value && !await confirmPending()) return
  await clearLocalRecovery()
  await load()
}
onUnmounted(() => clearTimeout(recoveryTimer))
async function confirmPending():Promise<boolean>{
  if(!hasUnsavedChanges.value)return true
  try{await ElMessageBox.confirm('是否保存当前修改后离开？','存在未保存修改',{confirmButtonText:'保存',cancelButtonText:'放弃修改',distinguishCancelAndClose:true});await save();return !editStatus.value}catch(e){if(e==='cancel'){await clearLocalRecovery();editStatus.value=false;return true}return false}
}
onBeforeRouteLeave(confirmPending)
async function openMember(member: any): Promise<void> {
  if(!await confirmPending())return
  sessionStorage.setItem('currentCompound', JSON.stringify({ ref: member.ref }))
  void openDetail()
}
let detailActive = false, auditGeneration = 0, detailGeneration = 0
async function openDetail(): Promise<void> {
  detailActive = true
  if (hasUnsavedChanges.value) return
  activeTab.value = 'info'
  await load()
}
async function load(publishedOnly = false): Promise<void> {
  viewingPublished.value = publishedOnly
  ++auditGeneration
  const generation = ++detailGeneration
  busy.value = true
  editStatus.value = false
  pendingRows.value = []
  try {
    const snapshot = JSON.parse(sessionStorage.getItem('currentCompound') ?? 'null')
    if (!snapshot?.ref) throw new Error('请从统一列表重新打开记录')
    refValue.value = snapshot.ref
    const result = await invokeIPC('federation:detail', snapshot.ref, { ...snapshot.scope, publishedOnly })
    if (generation !== detailGeneration) return
    compound.value = result.compound
    refValue.value = result.compound.ref ?? snapshot.ref
    auditData.value = result.audit ?? { assets: [] }
    methods.value = result.methods
    lcMethods.value = result.lcMethods
    classes.value = result.classes
    extensions.value = result.extensions
    pendingRows.value = result.pendingSpectrumImports || []
    selectedCategories.value = (result.extensions.classifications ?? []).map((x) =>
      taxonomyKey(x.namespace, x.category_code)
    )
    originalMethodIds.value = methods.value.flatMap((x) => x.methods.map((m) => m.id))
    originalLcIds.value = lcMethods.value.map((x) => x.id)
    for (const method of lcMethods.value) {
      for (const field of [
        'column_length_mm',
        'column_inner_diameter_mm',
        'column_particle_size_um',
        'column_temperature_c',
        'retention_time'
      ])
        method[field] =
          method[field] === null || method[field] === undefined ? undefined : Number(method[field])
      for (const step of method.methodsLinks)
        for (const field of ['time', 'flow_rate'])
          step[field] =
            step[field] === null || step[field] === undefined ? undefined : Number(step[field])
    }
    baseline.value = editSnapshot()
    if (!publishedOnly && refValue.value) {
      const recovered = await invokeIPC('edit-recovery:read', refValue.value).catch(() => null)
      if (recovered && generation === detailGeneration) {
        try {
          await ElMessageBox.confirm('发现此记录未保存的编辑，是否恢复？', '恢复编辑', {
            confirmButtonText: '恢复编辑', cancelButtonText: '放弃恢复', distinguishCancelAndClose: true
          })
          compound.value = { ...recovered.compound, is_favorite: compound.value?.is_favorite }
          methods.value = recovered.methods; lcMethods.value = recovered.lcMethods
          extensions.value = recovered.extensions; classes.value = recovered.classes
          selectedCategories.value = recovered.selectedCategories; pendingRows.value = recovered.pendingRows || []
          editStatus.value = true
        } catch (error) { if (error === 'cancel') await clearLocalRecovery() }
      }
    }
  } catch (e) {
    if (generation === detailGeneration) { ElMessage.error(String(e)); compound.value = null }
  } finally {
    if (generation === detailGeneration) busy.value = false
  }
}
async function save(): Promise<void> {
  if (!canEdit.value || !refValue.value) return
  busy.value = true
  try {
    if(compound.value?.canEditWorkspace){const original=extensions.value.fileRecord||{};await invokeIPC('file-library:workspace-save',{ref:refValue.value,revision:compound.value.fileRevision,pendingSpectrumImports:pendingRows.value,record:{compound:compound.value,ms:methods.value.flatMap(g=>g.methods),lc:lcMethods.value.map(m=>({...m,gradient:m.methodsLinks||[]})),spectra:extensions.value.spectra,sources:original.sources||[],chromatograms:original.chromatograms||[],experiments:original.experiments||[],classification:{...original.classification,items:selectedCategories.value.map(key=>{const[,ns,code]=JSON.parse(key);const itemKey=JSON.stringify([ns,code]);return original.classification?.items?.find((i:any)=>i.key===itemKey)||{key:itemKey,review_status:'confirmed'}})}}});ElMessage.success('已保存草稿，点击发布后其他管理员才能看到');editStatus.value=false;await clearLocalRecovery();notifyDataChanged();await load();return}
    if (compound.value?.canEditBasic && !canEditMethods.value) {
      const fields = ['main_name', 'name_zh', 'name_en', 'cas', 'formula', 'molecular_mass', 'monoisotopic_mass']
      const result = await invokeIPC('file-library:update-compound', {
        ref: refValue.value, revision: compound.value.fileRevision,
        compound: Object.fromEntries(fields.map(key => [key, compound.value?.[key] ?? null]))
      })
      if (!result?.success) throw Error('详细信息草稿未保存')
      ElMessage.success('已保存草稿，点击发布后其他管理员才能看到')
      editStatus.value = false
      await clearLocalRecovery()
      notifyDataChanged()
      await load()
      return
    }
    const currentMethodIds = methods.value.flatMap((x) => x.methods.map((m) => m.id))
    const result = await scopedInvoke(refValue.value.connectionId, 'compound:update', {
      compound: compound.value,
      classIdList: classes.value.filter((x) => !x.is_custom).map((x) => x.id),
      customClassIdList: classes.value.filter((x) => x.is_custom).map((x) => x.id),
      compoundMsMethodList: methods.value,
      compoundLcMethodList: lcMethods.value,
      deletedMsMethodIds: originalMethodIds.value.filter((x) => !currentMethodIds.includes(x)),
      deletedLcMethodIds: originalLcIds.value.filter(
        (x) => !lcMethods.value.some((m) => m.id === x)
      ),
      pendingSpectrumImports: pendingRows.value,
      extensions: {
        spectra: extensions.value.spectra,
        classifications: selectedCategories.value.map((key) => {
          const original = (extensions.value.classifications ?? []).find(
            (x) => taxonomyKey(x.namespace, x.category_code) === key
          )
          if (original) return original
          const [, namespace, category_code] = JSON.parse(key)
          return { namespace, category_code }
        })
      }
    })
    if (!result.success) throw new Error(result.error)
    ElMessage.success(result.draft ? '已保存草稿，点击发布后其他管理员才能看到' : '已保存到所属数据库')
    await clearLocalRecovery()
    notifyDataChanged()
    await load()
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
async function draftAction(action: 'publish' | 'discard'): Promise<void> {
  if (!refValue.value || editStatus.value || busy.value) return
  try {
    await ElMessageBox.confirm(action === 'publish' ? '发布当前记录的草稿？发布成功后其他管理员下次读取即可看到。' : '放弃当前记录的草稿并恢复已发布内容？', action === 'publish' ? '确认发布' : '放弃草稿', { confirmButtonText: '确定', cancelButtonText: '取消' })
    busy.value = true
    await invokeIPC('edit-drafts:' + action, refValue.value)
    ElMessage.success(action === 'publish' ? '已发布' : '已放弃草稿')
    notifyDataChanged()
    await load()
  } catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) }
  finally { busy.value = false }
}
async function openDraftEvent(event: Event): Promise<void> {
  if (detailActive) await openMember({ ref: (event as CustomEvent).detail })
}
onMounted(() => window.addEventListener('masspeclib2-open-draft', openDraftEvent))
onUnmounted(() => window.removeEventListener('masspeclib2-open-draft', openDraftEvent))
const favoriteBusy = ref(false)
async function favorite(): Promise<void> {
  const recordRef = refValue.value
  if (!recordRef || !compound.value || busy.value || favoriteBusy.value) return
  const generation = detailGeneration
  const desired = !compound.value.is_favorite
  favoriteBusy.value = true
  try {
    const result = await invokeIPC('federation:favorite', recordRef, desired)
    if (!result?.success || result.is_favorite !== desired) throw Error('收藏状态未确认，请重试')
    if (generation === detailGeneration && compound.value) compound.value.is_favorite = desired
    notifyFavoritesChanged()
    ElMessage.success(desired ? '已收藏' : '已取消收藏')
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    favoriteBusy.value = false
  }
}
async function trash(): Promise<void> {
  if ((!canEdit.value && !compound.value?.canManageRecords) || !refValue.value) return
  try {
    await ElMessageBox.confirm(
      compound.value?.is_in_trash ? '恢复这条记录？' : '将此记录移入其所属新库的回收站？',
      '确认', {confirmButtonText:'是',cancelButtonText:'否'}
    )
    if(refValue.value.connectionId.startsWith('file:'))await invokeIPC('federation:records-change',{action:compound.value?.is_in_trash?'restore':'delete',refs:[refValue.value]})
    else await invokeIPC('federation:trash', refValue.value)
    ElMessage.success('已加入待发布变更')
    notifyDataChanged()
    router.back()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  }
}
function addLC(): void {
  lcMethods.value.push({ phase_A: '', phase_B: '', methodsLinks: [] })
}
function addMethod(mode: string): void {
  if (!mode.trim()) {
    ElMessage.warning('请输入仪器型号')
    return
  }
  let group = methods.value.find((x) => x.ms_mode === mode)
  if (!group) {
    group = { ms_mode: mode, methods: [] }
    methods.value.push(group)
  }
  group.methods.push({
    ms_mode: mode,
    q1: undefined,
    q3: undefined,
    ce: undefined,
    dp: undefined,
    cxp: undefined,
    cad_value: undefined,
    polarity: undefined
  })
}
function deleteMethod(mode: string, index: number): void {
  methods.value.find((x) => x.ms_mode === mode)?.methods.splice(index, 1)
}
const detailRoot = ref<HTMLElement>()
watch(activeTab, () => { detailRoot.value?.querySelector('.el-tabs__content')?.scrollTo({ top: 0 }) })
async function refreshAudit(_event: unknown, value: any): Promise<void> {
  if (value?.running || !detailActive || editStatus.value || !refValue.value) return
  const generation = ++auditGeneration, target = { ...refValue.value }
  try {
    const snapshot = JSON.parse(sessionStorage.getItem('currentCompound') ?? 'null')
    const result = await invokeIPC('audit:compound', target, snapshot?.scope)
    if (generation === auditGeneration && detailActive) auditData.value = result
  } catch (error) { if (generation === auditGeneration && detailActive) ElMessage.warning('检查详情暂未更新：' + String(error)) }
}
onMounted(() => window.electron.ipcRenderer.on('audit:updated', refreshAudit))
onUnmounted(() => window.electron.ipcRenderer.removeListener('audit:updated', refreshAudit))
onDeactivated(() => { detailActive = false; ++auditGeneration })
onActivated(openDetail)
</script>
<template>
  <div ref="detailRoot" v-loading="busy" class="compound-detail">
    <div class="detail-heading">
      <h2>{{ compound?.main_name }}</h2>
      <div>
        <el-button v-if="viewingPublished" :disabled="busy" @click="load()">返回草稿</el-button>
        <el-button v-if="compound?.hasDraft" :disabled="editStatus || busy" @click="load(true)">查看已发布内容</el-button>
        <el-button v-if="compound?.hasDraft" type="primary" :disabled="editStatus || busy || compound?.draftConflict" @click="draftAction('publish')">发布</el-button>
        <el-button v-if="compound?.hasDraft" :disabled="editStatus || busy" @click="draftAction('discard')">放弃草稿</el-button>
        <el-button v-if="canEdit" :disabled="editStatus || busy" @click="beginEditing">编辑方法与详细信息</el-button>
        <el-button :disabled="!compound || busy" :loading="favoriteBusy" @click="favorite">{{
          compound?.is_favorite ? '取消收藏' : '收藏'
        }}</el-button
        ><el-button :disabled="!canEditMethods && !compound?.canManageRecords" @click="trash">{{
          compound?.is_in_trash ? '恢复' : '删除'
        }}</el-button
        ><el-button @click="router.back()">返回列表</el-button>
      </div>
    </div>
    <el-alert v-if="compound?.hasDraft" :closable="false" :type="compound.draftConflict ? 'warning' : 'info'" :title="compound.draftConflict ? '正式数据已有新版本。当前草稿已保留，请先核对正式数据；放弃草稿后可重新编辑。' : '当前显示本机当前账号的未发布草稿。列表检索仍使用已发布内容；点击发布后其他管理员才可读取改动。'" />
    <el-alert
      v-if="compound?.readOnly"
      :closable="false"
      type="info"
      :title="
        compound.canEditWorkspace?'维护改动先保存为本机草稿，发布后更新服务器管理工作区，原始谱库文件保留。MRM缺少单位时默认eV，原始单位来源可追溯。':compound.fileRecord ? (compound.canManageRecords ? '可编辑托管副本的基本信息并管理删除与恢复；方法和谱图在此处只读展示。' : '此文件库只读关联，不修改源文件。') : compound.schemaVersion === 2
          ? '旧版新库当前只读；可在数据库管理中备份后升级到结构版本4'
          : '此外部连接只读。收藏及自定义分组保存到本地，不修改外部库。'
      "
    />
    <div v-if="auditData.members?.length > 1" style="margin: 12px 0">
      已关联 {{ auditData.members.length }} 条来源记录；查看或编辑原记录：<el-button
        v-for="member in auditData.members"
        :key="JSON.stringify(member.ref)"
        link
        type="primary"
        @click="openMember(member)"
        >{{ member.name }} · {{ member.ref.key }}</el-button
      >
    </div>
    <el-tabs v-if="compound" v-model="activeTab" class="detail-tabs">
      <el-tab-pane label="详细信息" name="info">
        <el-form label-width="125px" :disabled="!editStatus" style="max-width: 950px">
          <el-form-item
            v-for="field in informationFields"
            :key="field[0]"
            :label="field[1]"
            ><el-input v-model="compound[field[0]]" :maxlength="field[0] === 'formula' ? 1000 : 255" placeholder="未提供"
          /></el-form-item>
          <el-form-item label="分子量"
            ><el-input-number
              v-model="compound.molecular_mass"
              :controls="false"
              :min="0" /></el-form-item
          ><el-form-item label="单同位质量"
            ><el-input-number v-model="compound.monoisotopic_mass" :controls="false" :min="0"
          /></el-form-item>
          <el-form-item label="其他名称"
            ><div>
              <div
                v-for="(name, index) in compound.name"
                :key="index"
                style="display: flex; gap: 10px; margin: 6px 0"
              >
                <el-input v-model="name.name" :disabled="compound.fileRecord" /><el-input
                  v-model="name.area"
                  :disabled="compound.fileRecord"
                  placeholder="原始地区信息（非语言）"
                /><el-button v-if="editStatus && !compound.fileRecord" @click="compound.name.splice(index, 1)"
                  >删除</el-button
                >
              </div>
              <el-button v-if="editStatus && !compound.fileRecord" @click="compound.name.push({ name: '', area: '' })"
                >增加名称</el-button
              >
            </div></el-form-item
          >
        </el-form>
        <p :title="ionModeHint({ms:methods.flatMap(g=>g.methods||[]),spectra:extensions.spectra||[]})"><strong>离子模式：</strong>{{ ionModeLabel({ms:methods.flatMap(g=>g.methods||[]),spectra:extensions.spectra||[]}) }}</p>
        <p><strong>所属数据库：</strong>{{ compound.connectionName }}</p>
        <p v-if="extensions.fileRecord?.classification?.source_labels?.length"><strong>来源原始分类：</strong>{{ extensions.fileRecord.classification.source_labels.join('；') }}</p><p><strong>数据来源：</strong><SourceTags :sources="extensions.sources" /></p>
        <el-form-item v-if="editingMethods" label="分类（可多选）">
          <el-tree-select
            v-model="selectedCategories"
            :data="classificationOptions"
            node-key="key"
            :props="{
              value: 'key',
              label: 'label',
              children: 'children',
              disabled: (data) => !data.id
            }"
            multiple
            show-checkbox
            check-strictly
            filterable
            clearable
            style="width: 100%"
            placeholder="选择分类；勾选父级仅归入父级"
          />
        </el-form-item>
        <p v-if="extensions.localClassification">
          <strong>软件统一分类：</strong>
          <el-tag v-for="item in extensions.localClassification.items" :key="item.namespace + ':' + item.category_code" style="margin: 3px" :title="localClassificationHint(item)">
            {{ categoryPath(extensions.localClassification.catalog, item.namespace, item.category_code) }}
          </el-tag>
          <el-tag v-if="!extensions.localClassification.items.length" type="info">待分类</el-tag>
          <span v-if="extensions.localClassification.items.length && extensions.localClassification.pendingRecords">另有 {{ extensions.localClassification.pendingRecords }} 条来源记录待分类</span>
        </p>
        <el-alert v-if="extensions.localClassification && !extensions.localClassification.items.length && extensions.classifications?.length" title="此记录保留了原有分类，但尚未建立统一分类映射。请在分类管理确认映射；未映射记录在分类查询和客户交付中仍显示未分类。" type="info" :closable="false" />
        <p v-if="extensions.classifications?.length">
          <strong>来源库原分类：</strong
          ><el-tag
            v-for="item in extensions.classifications"
            :key="item.namespace + ':' + item.category_code"
            style="margin: 3px"
          >
            {{ categoryPath(extensions.taxonomyCatalog ?? [], item.namespace, item.category_code) }}
          </el-tag>
        </p>
        <p v-if="classes.length">
          <strong>分类：</strong
          ><el-tag v-for="item in classes" :key="item.id" style="margin: 3px">{{
            item.class_name
          }}</el-tag>
        </p>
        <el-alert
          v-if="
            compound.properties?.identity_status &&
            compound.properties.identity_status !== 'structure_consistent'
          "
          :closable="false"
          type="warning"
          :title="
            compound.properties.identity_status === 'identity_conflict'
              ? '身份冲突：来源身份信息存在不一致，保留独立记录，尚未确认合并。'
              : '身份待解析：保留来源记录，尚未确认化合物身份。'
          "
        />
        <el-descriptions v-if="compound.fileRecord" :column="1" border style="margin:12px 0"><el-descriptions-item v-if="compound.smiles" label="SMILES">{{compound.smiles}}</el-descriptions-item><el-descriptions-item v-if="compound.calculated_formula" label="计算分子式">{{compound.calculated_formula}}</el-descriptions-item><el-descriptions-item label="显示分子式依据">{{compound.formula_source==='source'?'来源原值':compound.formula_source==='calculated'?'计算值':'未注明'}}</el-descriptions-item></el-descriptions>
        <LiquidMethods
          :methods="lcMethods"
          :ms-methods="methods.flatMap((group: any) => group.methods)"
          :editable="editingMethods"
          @add="addLC"
          @remove="lcMethods.splice($event, 1)"
        />
        <el-collapse
          ><el-collapse-item title="技术信息"
            ><p>原始记录键：{{ refValue?.key }}</p>
            <p>连接标识：{{ refValue?.connectionId }}</p></el-collapse-item
          ></el-collapse
        >
      </el-tab-pane>
      <el-tab-pane label="谱图与质谱方法" name="spectra">
        <ExtendedData
          :compound-id="compound.id"
          section="spectra"
          :active="activeTab === 'spectra'"
          :edit-status="editingMethods"
          :data="extensions"
          @change="extensions = $event"
        />
        <MsInfoTab
          :connection-id="refValue?.connectionId ?? ''"
          :compound-id="compound.id"
          :independent-spectrum-count="extensions.spectra?.length ?? 0"
          :independent-spectra="extensions.spectra ?? []"
          :ms-method-data="methods as any"
          :edit-status="editingMethods"
          :ms-mode="msMode"
          :is-active="activeTab === 'spectra'"
          @delete-ms-method-row="deleteMethod"
          @add-ms-method="addMethod"
          @change-ms-mode="msMode = $event"
          @stage-spectrum-import="pendingRows = $event"
        />
      </el-tab-pane>
      <el-tab-pane label="色谱图" name="chromatograms"
        ><ChromatogramsTab :data="auditData"
      /></el-tab-pane>
    </el-tabs>
    <div v-if="editStatus" style="margin-top: 20px">
      <el-button type="primary" :loading="busy" @click="save">保存草稿</el-button
      ><el-button @click="cancelEdit">取消编辑</el-button>
    </div>
  </div>
</template>

<style scoped>
.compound-detail { height: 100%; min-height: 0; box-sizing: border-box; background: white; padding: 16px 20px; display: flex; flex-direction: column; overflow: hidden; }
.detail-heading { display: flex; flex: 0 0 auto; justify-content: space-between; align-items: center; gap: 10px; }
.detail-heading h2 { min-width: 0; overflow-wrap: anywhere; margin: 0 0 10px; }
.detail-heading > div { flex-shrink: 0; }
.compound-detail > :deep(.el-alert) { flex-shrink: 0; }
.detail-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; margin-top: 8px; }
.detail-tabs :deep(.el-tabs__header) { flex-shrink: 0; margin-bottom: 12px; background: white; }
.detail-tabs :deep(.el-tabs__content) { flex: 1; min-height: 0; overflow: auto; padding-right: 8px; }
.detail-tabs :deep(.el-tab-pane) { min-height: 100%; }
</style>
