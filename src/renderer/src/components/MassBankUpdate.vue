<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import { notifyDataChanged } from '../utils/scopedIPC'
const emit=defineEmits<{staged:[];openLibrary:[libraryId:string]}>()
type Archive = {libraryId:string;title:string}
type Source={id:string;name:string;url:string;adapter:string;canAutoUpdate?:boolean;pinned?:boolean;scopes?:{id:string;label:string}[]}
type Task={id:string;sourceId:string;scope:string;libraryId:string;enabled:boolean;managed?:boolean;archiveBatchId?:string;archived?:{addedSpectra:number;existingSpectra:number;invalid?:number};needsTarget?:boolean;checkable?:boolean;nextRunAt?:string;unchanged?:boolean;uploaded?:boolean;running?:boolean;batchId?:string;failedBatchId?:string;version?:string;checkedAt?:string;error?:string;spectra?:number;compounds?:number;invalid?:number;conflicts?:number;progress?:{phase:string;label:string;completed:number;total:number;unit:string;bytes?:number;totalBytes?:number;filename?:string;valid?:number;invalid?:number}}
type Row={accession:string;name:string;status:string;reason:string;targetName?:string;level?:string;adduct?:string;energy?:string}
type Batch={batchId:string;revision:string;rows:Row[];counts:Record<string,number>;page:number;total:number;spectra:number;compounds:number;invalid:number;duplicates?:number;conflicts?:number;eligibleIds?:string[];invalidExamples:{line:number;reason:string}[]}
const call=<T,>(action:string,data:object={})=>invokeIPC('delivery:call','POST','/admin/source-updates/'+action,data) as Promise<T>
const visible=ref(false),adding=ref(false),busy=ref(false),issue=ref(''),tasks=ref<Task[]>([]),sources=ref<Source[]>([]),libraries=ref<{libraryId:string;title:string}[]>([]),scopes=ref<string[]>([])
const sourceId=ref('1'),scope=ref('AAFC'),libraryId=ref(''),active=ref<Task>(),batch=ref<Batch>(),selection=ref<string[]>([]),showAll=ref(false),page=ref(1)
const source=computed(()=>sources.value.find(s=>s.id===sourceId.value))
const canAutoUpdate = (source?: Source): boolean => source?.canAutoUpdate ??
  ['massbank','gnps','msdial','msnlib','file'].includes(source?.adapter || '')
const automaticSources = computed(() => sources.value.filter(canAutoUpdate))
const manualSources = computed(() => sources.value.filter(item => !canAutoUpdate(item)))
const manualTasks = computed(() => new Map(tasks.value.filter(task => !task.uploaded && task.checkable === false).map(task => [task.sourceId, task])))
const tasksBySource = computed(() => {
  const index = new Map<string, Task[]>()
  for (const task of tasks.value) {
    if (task.uploaded || task.checkable === false) continue
    let list = index.get(task.sourceId)
    if (!list) { list = []; index.set(task.sourceId, list) }
    list.push(task)
  }
  return index
})
type UpdateRow = { key:string; name:string; source?:Source; task?:Task }
const sourceSearch = ref(''), updateTab = ref<'auto' | 'manual'>('auto')
const updateTabs = computed(() => [
  { name:'auto', label:`自动更新数据库（${automaticSources.value.length}）` },
  { name:'manual', label:`手动更新（${manualSources.value.length}）` }
])
const automaticRows = computed<UpdateRow[]>(() => {
  const keyword = sourceSearch.value.trim().toLowerCase()
  return automaticSources.value.filter(item => item.name.toLowerCase().includes(keyword)).flatMap(item => {
    const configured = tasksBySource.value.get(item.id)
    return configured?.length ? configured.map(task => ({key:task.id,name:item.name,source:item,task}))
      : [{key:'source:'+item.id,name:item.name,source:item}]
  })
})
const manualRows = computed<UpdateRow[]>(() => [
  ...tasks.value.filter(task => task.uploaded).map(task => ({key:task.id,name:task.scope,task})),
  ...manualSources.value.map(item => ({key:'source:'+item.id,name:item.name,source:item}))
])
const visibleRows = computed(() => updateTab.value === 'auto' ? automaticRows.value : manualRows.value)
const showingBatch = computed(() => !!batch.value && !!active.value && updateTab.value === (active.value.uploaded ? 'manual' : 'auto'))
const scheduleTime = new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', dateStyle:'short', timeStyle:'short' })
const supported = computed(() => canAutoUpdate(source.value))
const archive=ref<Archive>()
function openArchive():void {
 if(!archive.value)return
 visible.value=false
 emit('openLibrary',archive.value.libraryId)
}
const uploading=ref(false),uploadTarget=ref(''),uploadStatus=ref(''),inspecting=ref(false),inspection=ref<Record<string,unknown>>(),inspectionRow=ref<Row>()
async function inspect(row:Row):Promise<void>{try{inspectionRow.value=row;inspection.value=await call('inspect',{taskId:active.value?.id,batchId:batch.value?.batchId,accession:row.accession});inspecting.value=true}catch(e){ElMessage.error(String(e))}}
async function removeSource(task:Task):Promise<void>{try{await ElMessageBox.confirm(`移除「${sourceName(task.sourceId)} / ${scopeName(task)}」？只移除更新来源配置和本批次文件，不删除已经发布到目标库的数据。`,'移除数据源',{confirmButtonText:'移除',cancelButtonText:'取消',type:'warning'});await call('remove',{id:task.id});if(active.value?.id===task.id){active.value=undefined;batch.value=undefined;selection.value=[]}await refresh();ElMessage.success('数据源已移除')}catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(String(e))}}
async function deleteFailedBatch(task:Task):Promise<void>{try{await ElMessageBox.confirm('删除本次失败批次的临时文件、日志和断点数据？','删除失败批次',{confirmButtonText:'删除',cancelButtonText:'取消',type:'warning'});await call('delete-batch',{taskId:task.id,batchId:task.failedBatchId});await refresh();ElMessage.success('失败批次已删除')}catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(String(e))}}
function resetInspectionScroll():void{nextTick(()=>{const body=document.querySelector('.source-inspection-dialog .el-dialog__body');if(body)body.scrollTop=0;document.querySelectorAll('.source-inspection-dialog pre').forEach(node=>{(node as HTMLElement).scrollTop=0})})}
function toggleInspectionSelection():void {
 const accession=inspectionRow.value?.accession
 if(!accession||!inspectionRow.value||(!eligible(inspectionRow.value)&&!reviewSelectable(inspectionRow.value)))return
 selection.value=selection.value.includes(accession)?selection.value.filter(id=>id!==accession):[...selection.value,accession]
}
const labels:Record<string,string>={duplicate:'批次内重复',new:'新增化合物及谱图',attach:'向已有化合物补充谱图',merge:'仅补充来源（需手动勾选）',existing:'已存在',revision:'上游修订，需核对',review:'待确认',missing:'上游未再出现（保留正式记录）'}
const eligible=(r:Row)=>['new','attach','merge'].includes(r.status)
const reviewSelectable=(r:Row)=>r.status==='review'
const selectable=(r:Row)=>eligible(r)||reviewSelectable(r)
const sourceName=(id:string)=>id==='upload'?'上传文件':sources.value.find(s=>s.id===id)?.name||id
const targetName=(id:string)=>libraries.value.find(l=>l.libraryId===id)?.title||'目标库不可用'
let timer:ReturnType<typeof setTimeout>|undefined,disposed=false
function stop():void{clearTimeout(timer)}
onUnmounted(()=>{disposed=true;stop()})
async function refresh():Promise<void>{
 const r=await call<{tasks:Task[];catalog:Source[];libraries:{libraryId:string;title:string}[];gnpsScopes:string[];archive?:Archive}>('list')
 if(disposed)return
 const previous = new Map(tasks.value.map(task=>[task.id,task.archiveBatchId]))
 if(r.archive && (!archive.value || r.tasks.some(task=>task.archiveBatchId&&previous.get(task.id)!==task.archiveBatchId)))
   notifyDataChanged()
 archive.value=r.archive
 tasks.value=r.tasks;sources.value=r.catalog;libraries.value=r.libraries;scopes.value=r.gnpsScopes
 if(active.value)active.value=tasks.value.find(t=>t.id===active.value?.id)
 stop()
 const running = tasks.value.some(t=>t.running)
 if (visible.value&&(running||tasks.value.some(t=>t.nextRunAt)))
   timer=setTimeout(()=>void refresh().catch(e=>{issue.value=String(e)}),running?2500:15000)
}
async function open():Promise<void>{visible.value=true;issue.value='';busy.value=true;try{await refresh()}catch(e){issue.value=String(e)}finally{busy.value=false}}
const editingSource = ref<Task>()
const scopedSource = ref<Source>()
const availableScopes = (item?: Source) => item?.scopes ??
  (item?.adapter === 'gnps' ? scopes.value.map(id => ({ id, label: id })) : [])
const selectedScopes = computed(() => {
  const options = availableScopes(source.value)
  const used = new Set(tasksBySource.value.get(sourceId.value)?.filter(task => task.id !== editingSource.value?.id).map(task => task.scope))
  return options.filter(item => !used.has(item.id))
})
function resetScope(): void {
  scope.value = source.value?.adapter === 'massbank'
    ? (tasksBySource.value.get(sourceId.value)?.some(task => task.scope === 'AAFC') ? '' : 'AAFC')
    : selectedScopes.value[0]?.id || ''
}
function openSource(task?: Task, catalogSource?: Source): void {
  editingSource.value = task
  scopedSource.value = catalogSource
  sourceId.value = task?.sourceId || catalogSource?.id || automaticSources.value[0]?.id || ''
  const sharedTarget = tasks.value.find(item => !item.uploaded && libraries.value.some(library => library.libraryId === item.libraryId))
  libraryId.value = task?.libraryId || sharedTarget?.libraryId || (libraries.value.length === 1 ? libraries.value[0].libraryId : '')
  resetScope()
  if (task?.scope && (source.value?.adapter==='massbank' || selectedScopes.value.some(item=>item.id===task.scope))) scope.value = task.scope
  adding.value = true
}
function scopeName(task: Task): string {
  const preset = sources.value.find(item => item.id === task.sourceId)?.scopes?.find(item => item.id === task.scope)
  return preset?.label || task.scope
}
async function configure(): Promise<void> {
  busy.value = true
  const existing = editingSource.value
  try {
    await call('configure', { id: existing?.id, sourceId: sourceId.value,
      scope: scope.value, libraryId: libraryId.value,
      enabled: existing?.enabled })
    adding.value = false
    updateTab.value = 'auto'
    await refresh()
    ElMessage.success(existing ? '更新设置已保存' : '已添加更新任务')
  } catch (error) { ElMessage.error(String(error)) }
  finally { busy.value = false }
}
async function upload():Promise<void>{busy.value=true;uploadStatus.value='请选择文件（JSON / MGF / MSP，最大 64 MB）';try{if(!uploadTarget.value)throw Error('请选择目标数据库');const picked=await invokeIPC('delivery:source-upload') as {cancelled?:boolean;filename?:string;content?:string};if(picked.cancelled)return;if(!picked.content||!picked.filename)throw Error('未选择文件');uploadStatus.value='正在上传并解析文件，请稍候…';const result=await call<{taskId:string;batchId:string;libraryId:string;filename:string;spectra:number;compounds:number}>('upload',{libraryId:uploadTarget.value,filename:picked.filename,content:picked.content});active.value={id:result.taskId,sourceId:'upload',scope:result.filename,libraryId:result.libraryId,enabled:true,uploaded:true,batchId:result.batchId,spectra:result.spectra,compounds:result.compounds};batch.value=undefined;uploadStatus.value='正在与目标数据库比对…';await refresh();await view(active.value);updateTab.value='manual';uploading.value=false;ElMessage.success('文件已上传并完成比对，请核对差异')}catch(e){ElMessage.error(String(e))}finally{busy.value=false;uploadStatus.value=''}}
async function selectAll():Promise<void>{if(!batch.value||!active.value)return;busy.value=true;try{const r=await call<Batch>('compare',{taskId:active.value.id,batchId:batch.value.batchId,page:page.value,filter:showAll.value?'all':'actionable',selectAll:true});if(r.revision!==batch.value.revision){selection.value=[];batch.value=r;throw Error('目标库已变化，请重新核对后选择')};selection.value=r.eligibleIds||[]}catch(e){ElMessage.error(String(e))}finally{busy.value=false}}
async function toggle(t:Task):Promise<void>{try{await call('configure',{...t,enabled:!t.enabled});await refresh()}catch(e){ElMessage.error(String(e))}}
async function check(t:Task):Promise<void>{busy.value=true;try{await call('check',{taskId:t.id});batch.value=undefined;active.value=t;await refresh()}catch(e){ElMessage.error(String(e))}finally{busy.value=false}}
async function view(t?:Task):Promise<void>{
 if(t){active.value=t;updateTab.value=t.uploaded?'manual':'auto';page.value=1;showAll.value=false;selection.value=[]}
 if(!active.value?.batchId)return
 busy.value=true;issue.value=''
 try{const previous=batch.value?.revision;batch.value=await call<Batch>('compare',{taskId:active.value.id,batchId:active.value.batchId,page:page.value,filter:showAll.value?'all':'actionable'});page.value=batch.value.page;if(previous&&previous!==batch.value.revision){selection.value=[];ElMessage.warning('目标库已变化，已清空选择，请重新核对')}}catch(e){batch.value=undefined;issue.value=String(e)}finally{busy.value=false}
}
async function stage():Promise<void>{
 if(!batch.value||!active.value)return
 busy.value=true
 try{const r=await call<{staged?:boolean}>('publish',{taskId:active.value.id,batchId:batch.value.batchId,revision:batch.value.revision,selected:[...selection.value],confirmed:[...selection.value.filter(id=>batch.value?.rows.some(row=>row.accession===id&&row.status==='review'))]});if(!r.staged)throw Error('未能加入待发布变更');visible.value=false;emit('staged');ElMessage.success('已加入待发布，发布后其他管理员可见')}catch(e){ElMessage.error(String(e))}finally{busy.value=false}
}
</script>
<template>
 <el-button plain @click="open">数据源更新</el-button>
 <el-dialog v-model="visible" class="source-update-center" title="数据源更新中心" width="min(1120px,94vw)" top="4vh" append-to-body @close="stop">
  <el-alert v-if="issue" :title="issue" type="warning" :closable="false"/>
  <div class="toolbar">
    <p>{{archive?'通过校验的下载数据自动汇入谱库。':'检查更新后核对差异，再加入待发布。'}}</p>
    <span><el-button v-if="archive" plain @click="openArchive">打开{{archive.title}}</el-button>
      <el-button v-if="updateTab==='manual'" plain :disabled="busy" @click="uploading=true">上传文件并查重</el-button></span>
  </div>
  <el-tabs v-model="updateTab">
    <el-tab-pane v-for="tab in updateTabs" :key="tab.name" :label="tab.label" :name="tab.name" lazy>
      <template v-if="updateTab===tab.name">
        <div v-if="tab.name==='auto'" class="toolbar"><span>每月 15 日 03:00（北京时间）起按顺序检查</span>
          <el-input v-model="sourceSearch" placeholder="搜索来源名称" clearable class="source-search" />
        </div>
        <el-table :data="visibleRows" row-key="key" empty-text="没有符合条件的来源" max-height="43vh">
          <el-table-column label="来源／范围" min-width="250">
            <template #default="{row: {name,task}}">
              <div>{{name}}</div>
              <small v-if="task?.uploaded">上传文件</small>
              <small v-else-if="task && !task.needsTarget">{{scopeName(task)}} · {{task.version?.startsWith('sha256:')?'文件版本 '+task.version.slice(7,19):task.version||'尚未检查'}}</small>
            </template>
          </el-table-column>
          <el-table-column label="目标库" min-width="130"><template #default="{row: {task}}">
            {{tab.name==='auto'&&archive ? archive.title : task?.libraryId ? targetName(task.libraryId) : '—'}}
          </template></el-table-column>
          <el-table-column label="状态" min-width="220">
            <template #default="{row: {task}}">
              <span v-if="!task">{{tab.name==='auto'?'未配置':'需手动下载'}}</span>
              <template v-else>
                <div v-if="task.running&&task.progress">
                 <b>{{task.progress.label}}</b>
                 <el-progress :percentage="task.progress.total?Math.min(100,Math.round(task.progress.completed*100/task.progress.total)):0" :show-text="!!task.progress.total" :indeterminate="!task.progress.total" :stroke-width="6"/>
                 <small v-if="task.progress.bytes!==undefined">已下载 {{(task.progress.bytes/1048576).toFixed(2)}} MB<template v-if="task.progress.totalBytes"> / {{(task.progress.totalBytes/1048576).toFixed(2)}} MB</template></small>
                 <small v-else-if="task.progress.completed">{{task.progress.completed}}<template v-if="task.progress.total"> / {{task.progress.total}}</template> {{task.progress.unit}}</small>
                 <small v-if="task.progress.filename" class="progress-file">{{task.progress.filename}}</small>
                </div>
                <span v-else-if="task.running">任务已启动，正在等待进度…</span>
                <span v-else-if="task.needsTarget">请选择更新范围和目标库</span>
                <span v-else-if="!task.enabled">已停用</span>
                <span v-else-if="task.error" class="error">{{task.error}}</span>
                <span v-else-if="task.archived"><template v-if="task.unchanged">上游文件未变化</template><template v-else>新增 {{task.archived.addedSpectra}} 张 · 已存在 {{task.archived.existingSpectra}} 张</template><template v-if="task.invalid||task.archived.invalid"> · 跳过 {{(task.invalid||0)+(task.archived.invalid||0)}} 条异常</template></span>
                <span v-else-if="task.batchId&&task.spectra>0"><template v-if="task.unchanged">上游文件未变化 · </template>{{task.spectra}} 张谱图 · {{task.compounds}} 个已知结构<span v-if="task.invalid"> · {{task.invalid}} 条解析异常</span></span>
                <span v-else>{{task.uploaded ? "已上传" : "待检查"}}</span>
                <div v-if="task.checkedAt"><small>上次成功 {{new Date(task.checkedAt).toLocaleString()}}</small></div>
                <div v-if="task.nextRunAt&&!task.running"><small>下次检查 {{scheduleTime.format(new Date(task.nextRunAt))}}</small></div>
              </template>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="305">
            <template #default="{row: {source: item,task}}">
              <template v-if="task">
                <el-button v-if="task.needsTarget" link type="primary" :disabled="busy" @click="openSource(task)">设置更新</el-button>
                <template v-else-if="!task.uploaded">
                  <el-button link type="primary" :disabled="busy||task.running||!task.enabled" @click="check(task)">{{task.failedBatchId?'重试':'检查更新'}}</el-button>
                  <el-button link :disabled="busy||task.running" @click="toggle(task)">{{task.enabled?'停用':'启用'}}</el-button>
                </template>
                <el-button v-if="!task.managed&&task.batchId&&task.spectra>0" link :disabled="busy" @click="view(task)">查看差异</el-button>
                <el-button v-if="task.failedBatchId" link type="danger" :disabled="busy||task.running" @click="deleteFailedBatch(task)">删除失败批次</el-button>
                <el-button link type="danger" :disabled="busy||task.running" @click="removeSource(task)">移除</el-button>
              </template>
              <el-button v-if="tab.name==='auto' && !task" link type="primary" :disabled="busy" @click="openSource(undefined,item)">配置更新</el-button>
              <template v-if="tab.name==='manual' && item">
                <el-link v-if="/^https?:\/\//i.test(item.url)" :href="item.url" target="_blank" rel="noopener noreferrer" type="primary">打开官网</el-link>
                <el-button link class="manual-action" @click="uploading=true">上传文件</el-button>
                <el-button v-if="manualTasks.has(item.id)" link type="danger" :disabled="busy"
                  @click="removeSource(manualTasks.get(item.id)!)">移除旧任务</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-tab-pane>
  </el-tabs>
  <template v-if="showingBatch&&batch&&active">
   <h4>{{sourceName(active.sourceId)}} / {{scopeName(active)}} → {{targetName(active.libraryId)}}</h4>
   <p>已比对 {{batch.spectra}} 张谱图，涉及 {{batch.compounds}} 个已知化合物结构；缺少结构的谱图进入待确认。</p>
   <div class="toolbar"><span>可新增 {{(batch.counts.new||0)+(batch.counts.attach||0)}} · 补充来源 {{batch.counts.merge||0}} · 已存在 {{batch.counts.existing||0}} · 上游修订 {{batch.counts.revision||0}} · 待确认 {{batch.counts.review||0}} · 批次内重复 {{batch.counts.duplicate||0}} · 上游未再出现 {{batch.counts.missing||0}}（谱图数）</span><el-checkbox v-model="showAll" :disabled="busy" @change="page=1;view()">显示已存在</el-checkbox></div>
   <p v-if="batch.conflicts || batch.duplicates">来源编号冲突 {{batch.conflicts||0}} 个，内容完全重复 {{batch.duplicates||0}} 条。有冲突的记录不纳入发布。</p>
   <el-alert v-if="batch.invalid" :title="`${batch.invalid} 条原始记录存在异常，未计入可发布谱图。${batch.invalidExamples.map(i=>'第'+i.line+'条 '+i.reason).join('；')}`" type="warning" :closable="false"/>
   <div class="toolbar"><span>已选择 {{selection.length}} 张（跨页保留）</span><span><el-button :disabled="busy" @click="selectAll">选择全部明确新增项（{{(batch.counts.new||0)+(batch.counts.attach||0)}}）</el-button><el-button :disabled="busy" @click="selection=[...new Set([...selection,...batch.rows.filter(r=>['new','attach'].includes(r.status)).map(r=>r.accession)])]">选择本页新增项</el-button><el-button :disabled="busy" @click="selection=[]">清空选择</el-button></span></div>
   <el-checkbox-group v-model="selection"><el-table :data="batch.rows" row-key="accession" size="small" max-height="36vh" empty-text="没有待处理谱图">
    <el-table-column label="选择" width="60"><template #default="{row}"><el-checkbox :model-value="selection.includes(row.accession)" :disabled="!selectable(row)" :aria-label="'选择 '+row.accession" @change="checked => { selection = checked ? [...new Set([...selection,row.accession])] : selection.filter(id => id !== row.accession) }"/></template></el-table-column>
    <el-table-column label="化合物／谱图" min-width="190"><template #default="{row}"><div>{{row.name}}</div><small>{{row.accession}}</small></template></el-table-column>
    <el-table-column label="采集条件" min-width="120"><template #default="{row}">{{[row.level,row.adduct,row.energy].filter(Boolean).join(' · ')}}</template></el-table-column>
    <el-table-column label="比对结果" min-width="240"><template #default="{row}"><div>{{labels[row.status]}}</div><small>{{row.reason}}{{row.targetName?' · '+row.targetName:''}}</small></template></el-table-column>
    <el-table-column label="核对" width="80"><template #default="{row}"><el-button link @click="inspect(row)">详情</el-button></template></el-table-column>
   </el-table></el-checkbox-group>
   <div class="toolbar"><el-pagination v-model:current-page="page" :page-size="100" :total="batch.total" layout="total,prev,pager,next" :disabled="busy" @current-change="view()"/><small>每页显示 100 条；选择全部可跨页加入待发布，发布前重新核对目标库。</small></div>
  </template>
  <p v-if="updateTab === 'auto'" class="hint">上游修订、疑似重复和已人工排除的记录不会自动覆盖。停用来源不会删除已发布数据。</p>
  <template #footer><el-button :disabled="busy" @click="visible=false">关闭</el-button><el-button v-if="showingBatch" type="primary" :disabled="busy||!selection.length" :loading="busy" @click="stage">加入待发布（{{selection.length}} 张谱图）</el-button></template>
 </el-dialog>
 <el-dialog v-model="uploading" title="上传文件并查重" width="min(600px,94vw)" append-to-body :close-on-click-modal="!busy" :show-close="!busy"><p>选择目标数据库后上传 JSON（GNPS）、MGF 或 MSP 文件（最大 64 MB）。文件先查重，加入待发布后仍需点击发布。</p><el-select v-model="uploadTarget" style="width:100%" placeholder="选择可编辑的目标数据库" :disabled="busy"><el-option v-for="l in libraries" :key="l.libraryId" :value="l.libraryId" :label="l.title"/></el-select><p v-if="uploadStatus">{{uploadStatus}}</p><template #footer><el-button :disabled="busy" @click="uploading=false">取消</el-button><el-button type="primary" :loading="busy" :disabled="busy||!uploadTarget" @click="upload">选择文件并查重</el-button></template></el-dialog>
 <el-dialog v-model="inspecting" class="source-inspection-dialog" title="来源与正式记录核对" width="min(1000px,94vw)" top="4vh" append-to-body @opened="resetInspectionScroll">
  <p>{{inspection?.note}}</p>
  <el-alert v-if="inspectionRow && reviewSelectable(inspectionRow)" title="请确认当前正式记录与上游记录后，再选择加入待发布。" type="warning" :closable="false"/>
  <el-tabs><el-tab-pane label="上游新记录"><pre>{{JSON.stringify(inspection?.upstream,null,2)}}</pre></el-tab-pane><el-tab-pane label="历史导入原文"><pre>{{JSON.stringify(inspection?.previous,null,2)}}</pre></el-tab-pane><el-tab-pane label="当前正式记录"><pre>{{JSON.stringify(inspection?.current,null,2)}}</pre></el-tab-pane></el-tabs>
  <template #footer><el-button @click="inspecting=false">关闭</el-button><el-button v-if="inspectionRow && (eligible(inspectionRow)||reviewSelectable(inspectionRow))" type="primary" @click="toggleInspectionSelection">{{selection.includes(inspectionRow.accession)?'取消选择':reviewSelectable(inspectionRow)?'确认并选择':'选择此谱图'}}</el-button></template>
 </el-dialog>
 <el-dialog v-model="adding" :title="editingSource ? '设置数据源更新' : '添加来源'" width="min(650px,94vw)" append-to-body>
  <el-form label-position="top">
   <el-form-item label="来源"><el-select v-model="sourceId" filterable style="width:100%" :disabled="!!editingSource || !!scopedSource" @change="resetScope"><el-option v-for="s in automaticSources" :key="s.id" :value="s.id" :label="s.name"/></el-select></el-form-item>
   <template v-if="supported">
    <el-form-item :label="source?.adapter==='massbank'?'贡献机构目录（如 AAFC）':'更新范围'">
     <el-input v-if="source?.adapter==='massbank'" v-model="scope" :disabled="!!editingSource?.scope"/>
     <el-select v-else v-model="scope" :disabled="!!editingSource?.scope&&selectedScopes.some(item=>item.id===editingSource?.scope)"><el-option v-for="s in selectedScopes" :key="s.id" :value="s.id" :label="s.label"/></el-select>
     <small v-if="source?.pinned">按当前指定的发布附件检查</small>
    </el-form-item>
    <el-form-item v-if="!archive" label="目标数据库"><el-select v-model="libraryId" :disabled="!!editingSource?.libraryId" style="width:100%" placeholder="选择目标服务器文件库"><el-option v-for="l in libraries" :key="l.libraryId" :value="l.libraryId" :label="l.title"/></el-select></el-form-item>
    <el-form-item label="检查时间">每月 15 日 03:00（北京时间）</el-form-item>
   </template>
   <el-alert v-else :title="`此来源暂未接通自动下载。官网 ${source?.url||''}`" type="info" :closable="false"/>
  </el-form>
  <template #footer><el-button @click="adding=false">取消</el-button><el-button v-if="supported" type="primary" :disabled="busy||!scope||(!archive&&!libraryId)" :loading="busy" @click="configure">{{ editingSource ? '保存' : '添加任务' }}</el-button></template>
 </el-dialog>
</template>
<style scoped>
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0}.toolbar p{margin:0}.hint,small{color:var(--el-text-color-secondary)}.hint{margin:14px 0 0;font-size:13px}.progress-file{display:block;overflow-wrap:anywhere}.error{color:var(--el-color-danger)}h4{margin:20px 0 8px}
.manual-action{margin-left:12px}.source-search{width:min(280px,42%)}
pre{white-space:pre-wrap;overflow:auto;max-height:60vh;word-break:break-word}
:global(.source-update-center .el-dialog__body){max-height:calc(92vh - 145px);overflow:auto}
:global(.source-inspection-dialog .el-dialog){max-height:92vh;display:flex;flex-direction:column;margin-top:4vh!important;margin-bottom:4vh}
:global(.source-inspection-dialog .el-dialog__body){min-height:0;overflow:auto}
:global(.source-inspection-dialog .el-dialog__footer){flex:none}
</style>

