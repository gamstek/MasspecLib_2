<script setup lang="ts">
import FileSourceManager from './FileSourceManager.vue'
import { FIXED_MAJORS } from '../../../shared/fixedMajors.mjs'
import { setSharedLibraryRemoved } from '../utils/removeLibrary'
import { useRouter } from 'vue-router'
import { invokeIPC } from '../utils/ipcInvoke'

import type { RecordData } from '../../../shared/dataPackage'
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { notifyDataChanged } from '../utils/scopedIPC'
const props = defineProps<{ hideTrigger?: boolean; manageServerLibraries?: boolean }>()
const router = useRouter()
const fileMaintenance = ref(false)
const defaults = ref<RecordData>({})
const classificationLibraries = ref<RecordData[]>([])
async function setMajor(row: RecordData, major: string): Promise<void> {
  try {
    if (row.adapter === 'file') {
      await invokeIPC('delivery:call', 'POST', '/admin/file-sources/default-major', { libraryId: row.id, major })
    } else {
      await invokeIPC('delivery:call', 'POST', '/admin/classification/default-major', { database: row.database, major })
    }
    await load()
    ElMessage.success('默认大类已加入待发布变更')
    notifyDataChanged()
  } catch (error) { ElMessage.error(String(error)) }
}
function viewRecords(id: string): void {
  fileMaintenance.value = false
  visible.value = false
  void router.push({ path: '/-1', query: { db: id } })
}

const visible = ref(false),
  editing = ref(false),
  busy = ref(false)
const entries = ref<RecordData[]>([]),
  results = ref<Record<string, RecordData>>({})
const shared = ref<RecordData>({})
const form = ref<RecordData>({}),
  mapping = ref(''),
  auditMapping = ref('')
async function load(): Promise<void> {
  entries.value = await invokeIPC('connections:list')
  shared.value = await invokeIPC('shared:status').catch(() => ({}))
  if (props.manageServerLibraries) {
    const state = await invokeIPC('delivery:call', 'GET', '/admin/classification/state').catch(() => undefined)
    defaults.value = state?.defaults || {}
    classificationLibraries.value = state?.libraries || []
  }
}
async function refreshLibraries(): Promise<void> {
  try { await load(); notifyDataChanged() } catch (error) { ElMessage.error(String(error)) }
}
async function syncShared(): Promise<void> {
  busy.value = true
  try { shared.value = await invokeIPC('shared:sync'); await load(); if (!shared.value.connected) throw new Error(shared.value.error || '请先登录服务器'); notifyDataChanged(); ElMessage.success(`已同步 ${shared.value.libraries} 个共享库，各库名称显示在左侧数据库列表`) }
  catch (e) { ElMessage.error(String(e)) }
  finally { busy.value = false }
}
function configureShared(): void {
  visible.value = false
  window.dispatchEvent(new Event('masspeclib2-configure-shared-server'))
}
const selectedId = ref<string>()
const selected = computed(() => entries.value.find(row => row.id === selectedId.value))
function canSetAccess(row: RecordData): boolean {
  return row.adapter === 'file'
    ? row.status === 'ready' && row.sourceAdapter !== 'unified-sqlite'
    : !row.serverManaged && row.adapter === 'native'
}
function accessReason(row: RecordData): string {
  if (row.adapter === 'file') return row.status !== 'ready' ? '文件库不可用' : '直接关联的源文件只支持读取'
  return row.serverManaged ? '服务器授予此 SQL 连接读取权限。软件里无法把它切换为可编辑。' : '此数据库结构仅支持读取'
}
async function setAccess(row: RecordData, writable: boolean): Promise<void> {
  if (busy.value || !canSetAccess(row)) return
  busy.value = true
  try {
    if (row.adapter === 'file') {
      await invokeIPC('delivery:call', 'POST', '/admin/file-sources/access', { libraryId: row.id, readOnly: !writable })
    } else {
      await invokeIPC('connections:set-writable', { id: row.id, writable })
    }
    await load()
    notifyDataChanged()
    ElMessage.success('读写权限已保存')
  } catch (error) { ElMessage.error(String(error)) }
  finally { busy.value = false }
}
async function open(): Promise<void> {
  visible.value = true
  try { await load() } catch (e) { ElMessage.error(String(e)) }
}
defineExpose({ open })
function edit(item?: RecordData): void {
  form.value = item
    ? { ...item, password: '' }
    : {
        name: '',
        host: 'localhost',
        port: 3306,
        database: '',
        user: '',
        password: '',
        adapter: 'native',
        enabled: true,
        writable: false
      }
  mapping.value = JSON.stringify(
    item?.mapping ?? {
      table: 'compounds',
      key: 'id',
      fields: { main_name: 'name', cas: 'cas', formula: 'formula', source_name: 'source' }
    },
    null,
    2
  )
  auditMapping.value = item?.auditMapping ? JSON.stringify(item.auditMapping, null, 2) : ''
  editing.value = true
}
async function save(): Promise<void> {
  busy.value = true
  try {
    const input = {
      ...form.value,
      auditMapping: auditMapping.value.trim() ? JSON.parse(auditMapping.value) : undefined,
      mapping: form.value.adapter === 'mapped' ? JSON.parse(mapping.value) : undefined
    }
    await invokeIPC('connections:save', input)
    editing.value = false
    await load()
    notifyDataChanged()
    ElMessage.success('连接已保存，请测试结构和权限')
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
async function test(id: string): Promise<void> {
  busy.value = true
  try {
    results.value[id] = await invokeIPC('connections:test', id)
  } catch (e) {
    ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
async function reconnect(id:string):Promise<void>{await invokeIPC('connections:restore',id);await load();notifyDataChanged()}
async function deleteServer(row:RecordData):Promise<void>{
 try{const {value}=await ElMessageBox.prompt(row.adapter==='file'?'将服务器源文件及管理副本移入服务器回收区，所有管理员连接都会受影响。请输入管理员软件密码确认。':'将永久删除服务器数据库，所有管理员连接都会受影响。请输入管理员软件密码确认。','删除服务器数据库',{inputType:'password',inputValidator:v=>!!v||'请输入管理员密码',confirmButtonText:'确认删除服务器数据',cancelButtonText:'否'});busy.value=true;await invokeIPC('connections:delete-server',{id:row.id,password:value});await load();notifyDataChanged();ElMessage.success('已从服务器移除数据库')}catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(String(e))}finally{busy.value=false}
}
const showRemoved = ref(false)
const removedEntries = computed(() => entries.value.filter(row => row.removed || (row.detached && !row.serverManaged)))
const visibleEntries = computed(() => showRemoved.value
  ? removedEntries.value : entries.value.filter(row => !removedEntries.value.includes(row)))
async function changeVisibility(row: RecordData, removed: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    if (row.serverManaged) {
      await setSharedLibraryRemoved(row.database, row.name, removed)
    } else if (removed) {
      await ElMessageBox.confirm(
        '从本机移除「' + row.name + '」？数据库文件和内容保留。',
        '移除数据库', { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' }
      )
      await invokeIPC('connections:remove', row.id)
    } else {
      await invokeIPC('connections:restore', row.id)
    }
    selectedId.value = undefined
    await load()
    notifyDataChanged()
    ElMessage.success(removed ? '数据库已移除' : row.published === false ? '已加入共享工作台' : '数据库已恢复')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  } finally { busy.value = false }
}
async function initialize(id: string): Promise<void> {
  try {
    const files = await invokeIPC('dialog:openFile', {
      title: '选择结构版本4初始化SQL（同目录须有manifest）',
      properties: ['openFile'],
      filters: [{ name: '初始化SQL', extensions: ['sql'] }]
    })
    if (!files?.length) return
    await ElMessageBox.confirm(
      '仅用于管理员已新建的空 MasspecLib2 数据库。非空库会被拒绝。',
      '初始化所选空库'
    )
    busy.value = true
    const result = await invokeIPC('connections:initialize', id, files[0])
    if (!result.ok) throw new Error(result.detail ?? result.message)
    await test(id)
    notifyDataChanged()
    ElMessage.success('空库初始化完成')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
async function upgrade(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '请先备份此 MasspecLib2 新库。升级增加字段并保留已有记录；MySQL DDL 不能整体回滚，失败后可检查并重试。原库和外部库不会升级。',
      '升级结构到版本4',
      { type: 'warning' }
    )
    busy.value = true
    await invokeIPC('connections:upgrade', id)
    await test(id)
    notifyDataChanged()
    ElMessage.success('新库结构升级完成')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <el-button v-if="!hideTrigger" @click="open">数据库管理</el-button>
  <el-dialog v-model="visible" title="数据库管理" width="min(900px, 94vw)" top="8vh" append-to-body @closed="selectedId = undefined">
    <div class="library-actions">
      <el-button v-if="!manageServerLibraries" size="small" @click="edit()">添加 SQL 连接</el-button>
      <el-button v-if="manageServerLibraries" type="primary" size="small" @click="fileMaintenance = true">上传数据库</el-button>
      <el-button v-if="shared.enabled" size="small" :loading="busy" :disabled="!shared.connected" @click="syncShared">刷新库清单</el-button>
      <el-button v-if="shared.enabled && !manageServerLibraries" size="small" @click="configureShared">连接配置</el-button>
      <el-checkbox v-if="removedEntries.length || showRemoved" v-model="showRemoved" @change="selectedId = undefined">已移除的库</el-checkbox>
    </div>
    <el-table :data="visibleEntries" row-key="id" size="small" max-height="55vh" empty-text="暂无数据库">
      <el-table-column prop="name" label="数据库" min-width="160" show-overflow-tooltip />
      <el-table-column label="状态" width="105"><template #default="{ row }">
        {{ showRemoved ? '已移除' : row.issue ? '不可用' : row.detached ? '已解除关联' : row.published === true ? '正式库' : !row.enabled ? '停用' : row.published === false ? '未列入' : '可用' }}
      </template></el-table-column>
      <el-table-column label="读写权限" width="135"><template #default="{ row }">
        <el-select v-if="!showRemoved && canSetAccess(row)" :model-value="!!row.writable" :disabled="busy" size="small" :aria-label="row.name + '读写权限'" @change="v => setAccess(row, v === true)">
          <el-option label="只读" :value="false" />
          <el-option label="可编辑" :value="true" />
        </el-select>
        <el-tooltip v-else-if="!showRemoved" :content="accessReason(row)">
          <el-button link @click="selectedId = row.id">只读 · {{ row.adapter === 'file' && row.status !== 'ready' ? '不可用' : '受限' }}</el-button>
        </el-tooltip>
      </template></el-table-column>
      <el-table-column label="操作" width="170"><template #default="{ row }">
        <el-button v-if="showRemoved" link type="primary" :disabled="busy" @click="changeVisibility(row, false)">恢复</el-button>
        <template v-else>
          <el-button v-if="row.enabled && (row.published || !manageServerLibraries)" link type="primary" @click="viewRecords(row.id)">查看</el-button>
          <el-button v-else-if="row.serverManaged && row.enabled && row.published === false" link type="primary" :disabled="busy" @click="changeVisibility(row, false)">加入工作台</el-button>
          <el-button link @click="selectedId = row.id">设置</el-button>
          <el-button link :disabled="busy" @click="changeVisibility(row, true)">{{ row.serverManaged ? "移除共享库" : "移除本机关联" }}</el-button>
        </template>
      </template></el-table-column>
    </el-table>
    <section v-if="selected" class="library-detail">
      <div class="library-actions">
        <strong>{{ selected.name }}</strong>
        <el-button link @click="selectedId = undefined">收起设置</el-button>
      </div>
      <div class="library-actions">
        <el-button v-if="!selected.serverManaged" size="small" @click="edit(selected)">编辑连接及启用状态</el-button>
        <el-button size="small" :disabled="busy" @click="test(selected.id)">测试连接</el-button>
        <el-button v-if="selected.detached" size="small" :disabled="busy" @click="reconnect(selected.id)">重新关联</el-button>
        <el-button v-if="results[selected.id]?.needsUpgrade && selected.writable" size="small" :disabled="busy" @click="upgrade(selected.id)">升级数据库</el-button>
        <el-button v-if="selected.adapter === 'native' && selected.writable" size="small" :disabled="busy" @click="initialize(selected.id)">初始化空库</el-button>
        <el-button v-if="selected.serverManaged" size="small" plain type="danger" :disabled="busy || selected.detached" @click="deleteServer(selected)">删除服务器数据</el-button>
      </div>
      <p v-if="!canSetAccess(selected)">{{ accessReason(selected) }}</p>
      <label v-if="(selected.adapter === 'file' && selected.status === 'ready') || classificationLibraries.some(l => l.database_name === selected?.database)" class="library-actions">
        无明确分类时归入
        <el-select size="small" style="width: 160px" :model-value="(selected.adapter === 'file' ? selected.defaultMajor : defaults[selected.database]) || 'other'" @change="v => selected && setMajor(selected, v)">
          <el-option v-for="c in FIXED_MAJORS" :key="c.category_code" :label="c.category_name" :value="c.category_code" />
        </el-select>
      </label>
      <p v-if="selected.detailIndex">查询索引 {{ selected.detailIndex.version }} · {{ (selected.detailIndex.bytes / 1048576).toFixed(1) }} MiB</p>
      <p v-if="selected.location">位置：{{ selected.location }}</p>
      <p v-if="selected.issue || results[selected.id]">{{ results[selected.id]?.ok ? '连接正常' : results[selected.id]?.message || selected.issue }} {{ results[selected.id]?.notice }}</p>
    </section>
  </el-dialog>
  <el-dialog v-model="fileMaintenance" title="服务器文件库" fullscreen destroy-on-close append-to-body>
    <div style="height: calc(100vh - 100px)"><FileSourceManager v-if="fileMaintenance" :formal-library-ids="entries.filter(e => e.published && e.adapter === 'file').map(e => String(e.id))" @changed="refreshLibraries" @view-library="viewRecords" /></div>
  </el-dialog>
  <el-dialog v-model="editing" title="连接配置" width="720px" append-to-body>
    <el-form label-width="100px">
      <el-form-item
        v-for="field in [
          ['name', '连接名称'],
          ['host', '主机'],
          ['database', '数据库'],
          ['user', '账号']
        ]"
        :key="field[0]"
        :label="field[1]"
        ><el-input v-model="form[field[0]]"
      /></el-form-item>
      <el-form-item label="端口"
        ><el-input-number v-model="form.port" :min="1" :max="65535"
      /></el-form-item>
      <el-form-item label="密码"
        ><el-input
          v-model="form.password"
          type="password"
          show-password
          placeholder="已有连接留空表示保留原密码"
      /></el-form-item>
      <el-form-item label="适配类型"
        ><el-select v-model="form.adapter" @change="form.writable = false"
          ><el-option value="native" label="MasspecLib2结构" /><el-option
            value="legacy"
            label="原MasspecLib结构（只读）" /><el-option
            value="mapped"
            label="自定义基础字段映射（只读）" /></el-select
      ></el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
      <el-form-item label="允许写入"
        ><el-switch v-model="form.writable" :disabled="form.adapter !== 'native'" /><span
          >仅结构版本4且名称为 mspec_lib2 或其后缀的新库支持写入。</span
        ></el-form-item
      >
      <el-form-item v-if="form.adapter === 'mapped'" label="字段映射"
        ><el-input v-model="mapping" type="textarea" :rows="12" />
        <p>
          主键必须非空且唯一。仅映射基础字段；复杂关系需专用适配器。允许
          main_name、name_zh、name_en、cas、formula、source_name、source_provider、source_location。
        </p></el-form-item
      >
      <el-collapse
        ><el-collapse-item title="检测数据字段映射（已有表格式不同时配置）" name="audit-mapping"
          ><p>
            使用标准experiment_results和chromatogram_traces表时留空；自定义表填写table、key、compoundKey、fields。示例见交付文档。
          </p>
          <el-input
            v-model="auditMapping"
            type="textarea"
            :rows="8"
            placeholder='{"table":"results","key":"id","compoundKey":"compound_id","fields":{"data":"result_json"}}' /></el-collapse-item
      ></el-collapse>
    </el-form>
    <template #footer
      ><el-button @click="editing = false">取消</el-button
      ><el-button type="primary" :loading="busy" @click="save">保存</el-button></template
    >
  </el-dialog>
</template>

<style scoped>
.library-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.library-actions :deep(.el-button + .el-button) { margin-left: 0; }
.library-detail { border-top: 1px solid var(--el-border-color); padding-top: 12px; }
.library-detail p { margin: 6px 0; overflow-wrap: anywhere; }
</style>
