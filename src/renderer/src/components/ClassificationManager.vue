<script setup lang="ts">
import {MAJOR_GROUPS} from '../../../shared/majorGroups.mjs'
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { notifyDataChanged } from '../utils/scopedIPC'
import { categoryKey, displayLibrary } from '../../../shared/classification.mjs'
import { categoryPath } from '../../../shared/taxonomy'
import {FIXED_MAJORS} from '../../../shared/fixedMajors.mjs'
import {mappingSuggestions} from '../../../shared/classificationSuggestions.mjs'
import type { RecordData } from '../../../shared/dataPackage'
const props = defineProps<{ assignment?: boolean; records?: RecordData[]; entries?: RecordData[]; scope?: RecordData; hideTrigger?: boolean }>()
const loadError = ref('')
const visible = ref(false), busy = ref(false), state = ref<RecordData>({ libraries: [], catalog: [], mappings: [], categories: [], roles: {} })
const targets = ref<string[]>([]), mode = ref('add'), name = ref(''), parentKey = ref(''), editKey = ref(''), axis = ref('application'), sortOrder = ref(0)
const project = ref(''), sourceKey = ref(''), mappingTargets = ref<string[]>([])
const localChoices = computed(() => state.value.catalog.map(c => ({ key: categoryKey(c), label: targetPath(c) })))
function targetPath(c:any):string{const group=MAJOR_GROUPS.find(g=>g.members.includes(c.parent_code||c.category_code));return(group?group.name+' / ':'')+categoryPath(state.value.catalog,c.namespace,c.category_code)}
const manualParents = computed(() => FIXED_MAJORS.map(c=>({...c,category_name:targetPath(c)})))
const selectedProject = computed(() => state.value.libraries.find(l => l.database_name === project.value))
const sourceChoices = computed(() => (selectedProject.value?.categories || []).map(c => ({ key: categoryKey(c), label: categoryPath(selectedProject.value.categories, c.namespace, c.category_code) })))
const allChoices=computed(()=>(state.value.allCatalog||state.value.catalog).map(c=>({key:categoryKey(c),label:categoryPath(state.value.allCatalog||state.value.catalog,c.namespace,c.category_code),disabled:!state.value.catalog.some(a=>categoryKey(a)===categoryKey(c)),fixed:c.fixed,ownDisabled:c.status==='disabled'})))
const suggestionsOpen=ref(false),suggestionPage=ref(1)
const suggestions=computed(()=>mappingSuggestions(selectedProject.value?.categories||[],state.value.catalog))
const matchedSuggestions=computed(()=>suggestions.value.filter(s=>s.candidates.length))
function beginEdit(key:string):void{const c=state.value.catalog.find(c=>categoryKey(c)===key);if(!c)return;editKey.value=key;name.value=c.category_name;axis.value=c.axis;sortOrder.value=c.sort_order||0;parentKey.value=c.parent_code?JSON.stringify([c.namespace,c.parent_code]):''}
async function toggleCategory(row:RecordData):Promise<void>{try{await ElMessageBox.confirm(row.ownDisabled?'重新启用此类别？子类别中单独停用的设置保持不变。':'停用此类别及其导航分支？原始分类、已生成交付和人工指定记录保留，重新启用后可恢复。','确认类别状态',{confirmButtonText:'是',cancelButtonText:'否'});await save('category-status',{key:row.key,status:row.ownDisabled?'active':'disabled'})}catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(String(e))}}
function useSuggestion(s:RecordData):void{sourceKey.value=s.sourceKey;mappingTargets.value=s.candidates.length===1?[s.candidates[0].key]:[];ElMessage.info('仅填入表单，尚未建立映射；核对分类含义后再保存')}
const labelLibrary = (l: RecordData): string => displayLibrary(l, state.value.libraries)
const labelTarget = (key: string): string => localChoices.value.find(c => c.key === key)?.label || key
const labelSource = (rule: RecordData): string => {
  const l = state.value.libraries.find(l => l.database_name === rule.database)
  const c = l?.categories.find(c => categoryKey(c) === rule.sourceKey)
  return l ? labelLibrary(l) + ' / ' + (c ? categoryPath(l.categories, c.namespace, c.category_code) : '类别已不可用') : '数据库已不可用'
}
async function load(): Promise<void> { state.value = await invokeIPC('delivery:call', 'GET', '/admin/classification/state') }
async function open(): Promise<void> {
  visible.value = true
  busy.value = true
  loadError.value = ''
  try { await load(); targets.value = []; mode.value = 'add' }
  catch (e) { loadError.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
defineExpose({ open })
async function save(action: string, body: RecordData): Promise<void> {
  busy.value = true
  try { const result = await invokeIPC('delivery:call', 'POST', '/admin/classification/' + action, body); await load(); notifyDataChanged(); ElMessage.success(result.staged ? '分类配置已加入待发布变更' : '已保存分类配置') }
  catch (e) { ElMessage.error(String(e)) } finally { busy.value = false }
}
async function assign(): Promise<void> {
  try {
    if (mode.value === 'add' && !targets.value.length) throw Error('追加分类请至少选择一个类别')
    await ElMessageBox.confirm(mode.value === 'unlock' ? `撤销所选 ${props.records?.length || 0} 条结果的人工指定，恢复按当前分类规则处理？` : `对勾选的 ${props.records?.length || 0} 条结果${mode.value === 'replace' ? '替换' : '追加'}本地分类${!targets.value.length ? '，清空后进入其他／待确认' : ''}。原项目分类保持不变。`, '确认人工归类', {confirmButtonText:'是',cancelButtonText:'否'})
    busy.value = true
    const result = await invokeIPC('classification:assign', { refs: props.records?.map(r => r.ref), scope: props.scope, categories: targets.value, mode: mode.value })
    visible.value = false; notifyDataChanged(); ElMessage.success(result.staged ? '归类操作已加入待发布变更' : '已完成归类')
  } catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) } finally { busy.value = false }
}

</script>
<template>
  <el-button v-if="!hideTrigger" :loading="busy" :disabled="assignment && !records?.length" @click="open">{{ assignment ? '批量本地分类' : '分类规则' }}</el-button>
  <el-dialog v-model="visible" :title="assignment ? '人工批量归类' : '分类规则'" width="min(960px, 94vw)" append-to-body destroy-on-close>
    <div v-loading="busy" class="classification-manager">
      <div v-if="loadError">
        <el-alert type="error" :closable="false" title="分类规则加载失败" :description="loadError" />
        <el-button :loading="busy" @click="open">重试</el-button>
      </div>
      <template v-else-if="!busy || state.catalog.length">
      <template v-if="assignment">
        <p>勾选 {{ records?.length || 0 }} 条结果。统一记录按当前范围展开来源记录；每次最多 500 条来源记录。人工结果会锁定，不受后续映射变更影响。</p>
        <el-radio-group v-model="mode"><el-radio value="add">追加本地分类</el-radio><el-radio value="replace">替换本地分类</el-radio><el-radio value="unlock">撤销人工指定</el-radio></el-radio-group>
        <p><el-select v-model="targets" multiple filterable clearable placeholder="选择本地类别；替换时可留空进入其他／待确认" style="width: 100%"><el-option v-for="c in localChoices" :key="c.key" :value="c.key" :label="c.label" /></el-select></p>
        <el-button type="primary" @click="assign">保存人工归类</el-button>
      </template>
      <el-tabs v-else>
        <el-tab-pane label="分类目录">
          <p>管理工作台里显示的分类。大类由系统预设，可在大类下添加细类。</p>
          <el-select v-model="parentKey" clearable filterable placeholder="选择预设大类或其细类作为父类别" style="width: 340px"><el-option v-for="c in manualParents" :key="categoryKey(c)" :label="labelTarget(categoryKey(c))" :value="categoryKey(c)" /></el-select>
          <el-input v-model="name" placeholder="类别名称" maxlength="255" style="width: 240px; margin: 8px" /><el-select v-model="axis" style="width:140px"><el-option value="application" label="用途分类" /><el-option value="chemical_structure" label="结构分类" /><el-option value="origin" label="生物来源" /><el-option value="biological_role" label="生物作用" /></el-select><el-input-number v-model="sortOrder" :min="0" :max="9999" /><el-button :disabled="!name.trim()" @click="save('category', { name, parentKey, axis, key: editKey || undefined, sort_order: sortOrder })">{{ editKey ? '保存修改' : '新增类别' }}</el-button><el-button v-if="editKey" @click="editKey='';name='';parentKey=''">取消编辑</el-button>
          <el-table :data="allChoices" max-height="380"><el-table-column prop="label" label="现有本地类别（含子类路径）" /><el-table-column label="状态" width="125"><template #default="s">{{ s.row.ownDisabled?'已停用':s.row.disabled?'父类别已停用':'已启用' }}</template></el-table-column><el-table-column label="操作" width="155"><template #default="s"><el-button link :disabled="s.row.fixed||s.row.disabled" @click="beginEdit(s.row.key)">编辑</el-button><el-button link :disabled="s.row.fixed||(s.row.disabled&&!s.row.ownDisabled)" @click="toggleCategory(s.row)">{{ s.row.ownDisabled?'启用':'停用' }}</el-button></template></el-table-column></el-table>
        </el-tab-pane>
        <el-tab-pane label="SQL 分类对应">
          <p>在这里设置 MySQL 库的原有分类与工作台分类的对应关系。服务器文件库的默认分类可在「数据库管理 → 设置」中调整。</p>
          <p v-if="!state.libraries.length">当前没有登记的 SQL 库。</p>
          <el-button :disabled="!project" @click="suggestionsOpen=!suggestionsOpen;suggestionPage=1">{{suggestionsOpen?'收起映射建议':'查看待确认映射建议'}}</el-button>
          <div v-if="suggestionsOpen"><p>仅比较类别名称、完整路径及已知分类维度，不根据化合物名称或文件名猜测。{{suggestions.length-matchedSuggestions.length}} 个类别暂无对应；建议不会自动保存或启用。</p><el-table :data="matchedSuggestions.slice((suggestionPage-1)*10,suggestionPage*10)" max-height="300"><el-table-column prop="sourcePath" label="项目类别" /><el-table-column label="建议目标与依据"><template #default="s"><div v-for="c in s.row.candidates" :key="c.key">{{c.path}} · {{c.reason}}</div></template></el-table-column><el-table-column label="处理" width="120"><template #default="s"><el-button link @click="useSuggestion(s.row)">{{s.row.candidates.length===1?'填入待确认':'有歧义，手动选'}}</el-button></template></el-table-column></el-table><el-pagination v-if="matchedSuggestions.length>10" v-model:current-page="suggestionPage" :page-size="10" :total="matchedSuggestions.length" layout="prev,pager,next" /></div>
          <div class="classification-map-form">
            <label>
              来源 SQL 库
              <el-select v-model="project" filterable placeholder="选择 SQL 库" @change="sourceKey = ''; mappingTargets = []">
                <el-option v-for="l in state.libraries" :key="l.database_name" :label="labelLibrary(l)" :value="l.database_name" />
              </el-select>
            </label>
            <label>
              库里的原分类
              <el-select v-model="sourceKey" filterable :disabled="!sourceChoices.length"
                :placeholder="project && !sourceChoices.length ? '此库没有可对应的原分类' : '选择原分类'">
                <el-option v-for="c in sourceChoices" :key="c.key" :label="c.label" :value="c.key" />
              </el-select>
            </label>
            <label>
              对应到工作台分类
              <el-select v-model="mappingTargets" multiple filterable :disabled="!sourceKey" placeholder="选择目标分类">
                <el-option v-for="c in localChoices" :key="c.key" :label="c.label" :value="c.key" />
              </el-select>
            </label>
            <el-button type="primary" :disabled="!project || !sourceKey || !mappingTargets.length" @click="save('mapping', { database: project, sourceKey, targets: mappingTargets })">保存对应关系</el-button>
          </div>
          <el-table :data="state.mappings" max-height="350" empty-text="还没有已保存的对应关系"><el-table-column label="原分类"><template #default="s">{{ labelSource(s.row) }}</template></el-table-column><el-table-column label="工作台分类"><template #default="s">{{ s.row.targets.map(labelTarget).join('、') }}</template></el-table-column><el-table-column label="状态" width="140"><template #default="s"><el-button link @click="save('mapping', { ...s.row, enabled: !s.row.enabled })">{{ s.row.enabled ? '已启用 · 停用' : '已停用 · 启用' }}</el-button></template></el-table-column></el-table>
        </el-tab-pane>
      </el-tabs>
      </template>
      <p class="classification-footnote">分类规则保存在服务器。工作台按规则显示分类，源库原分类仍可在记录详情中查看。</p>
    </div>
  </el-dialog>
</template>
<style scoped>
.classification-map-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; }
.classification-map-form label { display: grid; gap: 5px; }
.classification-map-form > .el-button { align-self: end; justify-self: start; }
.classification-footnote { color: #637086; line-height: 1.7; margin-top: 16px; }
</style>
