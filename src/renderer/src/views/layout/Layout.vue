<script setup lang="ts">
import {ION_NAVIGATION_OPTIONS,ionModeFromRoute,ionNavigationTarget,ionCountLabel,ionDatabaseScope,ION_LIST_COUNT_EVENT} from '../../../../shared/ionNavigation.mjs'
import { adminWorkspace } from '../../utils/adminWorkspace'
import { invokeIPC } from '../../utils/ipcInvoke'

import type { RecordData } from '../../../../shared/dataPackage'
import { useRouter, useRoute } from 'vue-router'
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import type { CategoryTreeNode } from '../../../../shared/taxonomy'
import { ElMessage, ElMessageBox } from 'element-plus'
import { notifyDataChanged } from '../../utils/scopedIPC'
import ClassificationManager from '../../components/ClassificationManager.vue'
import ConnectionManager from '../../components/ConnectionManager.vue'
import EditDraftManager from '../../components/EditDraftManager.vue'
import MassBankUpdate from '../../components/MassBankUpdate.vue'
const draftsManager = ref<InstanceType<typeof EditDraftManager>>()
const connectionsManager = ref<InstanceType<typeof ConnectionManager>>()
const classificationManager = ref<InstanceType<typeof ClassificationManager>>()
const draftCount = ref(0)
function moreAction(command: string): void {
  if (command === 'drafts') void draftsManager.value?.open()
  else if (command === 'databases') void connectionsManager.value?.open()
  else if (command === 'classification') void classificationManager.value?.open()
  else if (command === 'logout') windowLogout()
}
defineProps<{ deliveryAvailable?: boolean }>()
const emit = defineEmits<{ delivery: [] }>()
const router = useRouter(), route = useRoute()
const sharedStatus = ref<any>({})
function sharedUpdated(_event: unknown, value: any): void { sharedStatus.value = value || {} }
const currentScope = computed(() => {
  const ids = (Array.isArray(route.query.db) ? route.query.db : [route.query.db]).filter(Boolean)
  return ids.length ? databases.value.filter(d => ids.includes(d.id)).map(d => d.name).join('、') || '所选数据库' : route.path === '/analysis' ? '检测结果' : '全部已启用数据库'
})
function windowLogout(): void { window.dispatchEvent(new Event('masspeclib2-admin-logout')) }
function refreshList(): void {
  notifyDataChanged()
}
const minimize = () => window.electron.ipcRenderer.send('window-minimize')
const maximize = () => window.electron.ipcRenderer.send('window-toggle-maximize')
const close = () => window.electron.ipcRenderer.send('window-close')
const groups = ref<RecordData[]>([]),
  categories = ref<CategoryTreeNode[]>([]),
  count = ref(0),
  partial = ref(false)
const databases = ref<RecordData[]>([])
const categoryIssue=ref('')
const showEmptyCategories=ref(false)
type IonCount = { total:number; complete:boolean }
const ionCountCache = ref(new Map<string, Partial<Record<number,IonCount>>>())
const ionCounts = computed(() => ionCountCache.value.get(categoryScope.value) ?? {})
const visibleCategories=computed(()=>{const visible=(nodes:CategoryTreeNode[]):CategoryTreeNode[]=>nodes.filter(n=>showEmptyCategories.value||n.count===undefined||n.count>0).map(n=>({...n,children:visible(n.children||[])}));return [{key:'ion-mode',label:'离子模式',id:0,children:ION_NAVIGATION_OPTIONS.map(item=>({key:item.key,label:ionCountLabel(item,ionCounts.value[item.value]),id:0,children:[]}))},...visible(categories.value)]})
const categorySearch = ref('')
const categoryTree = ref()
function filterCategory(value: string, data: Record<string, unknown>): boolean {
  return (
    !value ||
    String(data.label ?? '')
      .toLocaleLowerCase()
      .includes(value.toLocaleLowerCase())
  )
}
const expandedCategories = ref<string[]>([...new Set(['ion-mode',...(adminWorkspace.value?.expandedCategories ?? readExpandedCategories())])])
function readExpandedCategories(): string[] {
  try { const value = JSON.parse(localStorage.getItem('masspeclib2.categoryExpanded') || '[]'); return Array.isArray(value) ? value.filter(v => typeof v === 'string') : [] } catch { return [] }
}
function rememberCategory(data: CategoryTreeNode, expanded: boolean): void {
  const keys = new Set(expandedCategories.value)
  if (expanded) keys.add(data.key); else keys.delete(data.key)
  expandedCategories.value = [...keys]
  if (!adminWorkspace.value) localStorage.setItem('masspeclib2.categoryExpanded', JSON.stringify(expandedCategories.value))
}
function selectCategory(data: CategoryTreeNode, node: any): void {
  const mode=ION_NAVIGATION_OPTIONS.find(item=>item.key===data.key)
  if(mode){void router.push(ionNavigationTarget(route.query,mode.value));return}
  if (data.children?.length) { if (node.expanded) node.collapse(); else node.expand(); rememberCategory(data, node.expanded) }
  if (data.id) void router.push({ path: '/' + data.id, query: {...route.query,ionMode:undefined} })
}
function restoreCategorySelection(): void {
  const id = Number(route.path.slice(1))
  const find = (nodes: CategoryTreeNode[]): CategoryTreeNode | undefined => { for (const n of nodes) { if (n.id === id) return n; const nested = find(n.children || []); if (nested) return nested } return undefined }
  const mode=route.path==='/-1'?ION_NAVIGATION_OPTIONS.find(item=>item.value===ionModeFromRoute(route.query.ionMode)):null
  categoryTree.value?.setCurrentKey(mode?.key||find(categories.value)?.key || null)
  if (categorySearch.value) categoryTree.value?.filter(categorySearch.value)
}
const categoryDatabaseIds = computed(() => (Array.isArray(route.query.db) ? route.query.db : [route.query.db])
  .filter((id): id is string => typeof id === 'string' && !!id).sort())
const categoryScope = computed(() => ionDatabaseScope(categoryDatabaseIds.value))
function rememberIonCount(event: Event): void {
  const {scope,mode,total,complete} = (event as CustomEvent<IonCount & {scope:string;mode:number}>).detail
  const cache = ionCountCache.value
  const counts = cache.get(scope)
  cache.delete(scope)
  cache.set(scope, { ...counts, [mode]:{ total,complete } })
  if (cache.size > 16) cache.delete(cache.keys().next().value!)
}
watch(categoryScope, () => { void refreshCategories() })
watch(()=>[route.path,route.query.ionMode],()=>{void nextTick().then(restoreCategorySelection)})
const navigationAside=ref<any>()
const navigationWidth = ref(adminWorkspace.value?.navigationWidth ?? 235)
const navigationMinWidth = 200
const navigationMaxWidth = 600
let resizingNavigation = false
let resizeStartX = 0
let resizeStartWidth = 235
function clampNavigationWidth(value: number): number {
  return Math.min(Math.max(navigationMinWidth,Math.min(navigationMaxWidth,window.innerWidth-420)), Math.max(navigationMinWidth, Math.round(value)))
}
function startNavigationResize(event: PointerEvent): void {
  if (event.button !== 0) return
  resizingNavigation = true
  resizeStartX = event.clientX
  resizeStartWidth = navigationWidth.value
  document.body.classList.add('resizing-navigation')
  window.addEventListener('pointermove', resizeNavigation)
  window.addEventListener('pointerup', stopNavigationResize, { once: true })
  window.addEventListener('pointercancel',stopNavigationResize,{once:true})
  window.addEventListener('blur',stopNavigationResize,{once:true})
  event.preventDefault()
}
function resizeNavigation(event: PointerEvent): void {
  if (!resizingNavigation) return
  navigationWidth.value = clampNavigationWidth(resizeStartWidth + event.clientX - resizeStartX)
}
function stopNavigationResize(): void {
  if (!resizingNavigation) return
  resizingNavigation = false
  document.body.classList.remove('resizing-navigation')
  window.removeEventListener('pointermove', resizeNavigation)
  window.removeEventListener('pointerup',stopNavigationResize)
  window.removeEventListener('pointercancel',stopNavigationResize)
  window.removeEventListener('blur',stopNavigationResize)
  localStorage.removeItem('masspeclib2.navigationWidth')
}
function keyboardNavigationResize(event:KeyboardEvent):void{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
  event.preventDefault()
  navigationWidth.value=clampNavigationWidth(event.key==='Home'?235:event.key==='End'?navigationMaxWidth:navigationWidth.value+(event.key==='ArrowRight'?20:-20))
  localStorage.removeItem('masspeclib2.navigationWidth')
}
function resetNavigationWidth(): void {
  stopNavigationResize();navigationWidth.value=adminWorkspace.value?.navigationWidth ?? 235;localStorage.removeItem('masspeclib2.navigationWidth')
  void nextTick(()=>{const el=navigationAside.value?.$el;if(el){el.scrollTop=0;el.scrollLeft=0}})
}
function resetHiddenNavigation():void{if(document.hidden)resetNavigationWidth()}
function auditUpdated(_event?: unknown, value?: { running?: boolean }): void {
  if (!value?.running) void refresh()
}
let navigationGeneration = 0, categoryGeneration = 0
async function refreshCategories(): Promise<void> {
  const own = ++categoryGeneration
  try {
    const result = await invokeIPC('federation:categories', { databaseIds: categoryDatabaseIds.value })
    if (own !== categoryGeneration) return
    categories.value = result
    categoryIssue.value = ''
    void nextTick().then(restoreCategorySelection)
  } catch (error) {
    if (own !== categoryGeneration) return
    categories.value = []
    categoryIssue.value = String(error)
  }
}
async function refresh(): Promise<void> {
  const own=++navigationGeneration
  const apply=(fn:()=>void):void=>{if(own===navigationGeneration)fn()}
  await Promise.allSettled([
    invokeIPC('connections:list', Boolean(adminWorkspace.value)).then(dbs=>apply(()=>{
      databases.value=dbs.filter((entry:RecordData)=>entry.enabled)
      count.value=databases.value.reduce((sum,entry)=>sum+(entry.compoundCount??0),0)
      partial.value=dbs.some((entry:RecordData)=>entry.issue || entry.enabled&&typeof entry.compoundCount!=='number')
    })).catch(()=>apply(()=>{partial.value=true})),
    invokeIPC('federation:groups').then(g=>apply(()=>{groups.value=g})),
    refreshCategories()
  ])
}
function refreshWorkspace(): void {
  ionCountCache.value.clear()
  void refresh()
}
async function renameGroup(group: RecordData): Promise<void> {
  try {
    const result = await ElMessageBox.prompt('输入分组名称', '重命名分组', {
      inputValue: group.class_name
    })
    await invokeIPC('federation:group-save', {
      id: group.id,
      name: result.value,
      refs: [],
      append: true
    })
    notifyDataChanged()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  }
}
async function deleteGroup(group: RecordData): Promise<void> {
  try {
    await ElMessageBox.confirm('删除本地分组，化合物记录保留。', '删除分组')
    await invokeIPC('federation:group-remove', group.id)
    notifyDataChanged()
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e))
  }
}
onMounted(() => {
  resetNavigationWidth()
  window.electron.ipcRenderer.on('workspace:reset-navigation',resetNavigationWidth)
  document.addEventListener('visibilitychange',resetHiddenNavigation)
  void refresh()
  void invokeIPC('shared:status').then(value => sharedStatus.value = value).catch(() => {})
  window.electron.ipcRenderer.on('shared:updated', sharedUpdated)
  window.addEventListener('masspeclib2-data-changed', refreshWorkspace)
  window.addEventListener(ION_LIST_COUNT_EVENT, rememberIonCount)
  window.electron.ipcRenderer.on('audit:updated', auditUpdated)
})
onUnmounted(() => {
  navigationGeneration++; categoryGeneration++
  document.removeEventListener('visibilitychange',resetHiddenNavigation)
  window.electron.ipcRenderer.removeListener('workspace:reset-navigation',resetNavigationWidth)
  window.removeEventListener('masspeclib2-data-changed', refreshWorkspace)
  window.removeEventListener(ION_LIST_COUNT_EVENT, rememberIonCount)
  window.electron.ipcRenderer.removeListener('audit:updated', auditUpdated)
  window.electron.ipcRenderer.removeListener('shared:updated', sharedUpdated)
  stopNavigationResize()
})
</script>
<template>
  <el-container class="app-shell">
    <el-header class="app-header" height="56px">
      <div class="app-brand"><span class="app-brand-icon">M</span><strong>MasspecLib2</strong></div>
      <span class="app-subtitle">多数据库统一检索</span>
      <div class="header-actions">
        <el-button v-if="deliveryAvailable" plain @click="moreAction('drafts')">待发布变更<template v-if="draftCount">（{{ draftCount }}）</template></el-button>
        <el-button plain @click="moreAction('databases')">数据库管理</el-button>
        <el-button v-if="deliveryAvailable" type="primary" plain @click="emit('delivery')">客户交付管理</el-button>
        <MassBankUpdate v-if="deliveryAvailable" @staged="moreAction('drafts')" @open-library="id=>router.push({path:'/-1',query:{db:id}})" />
        <el-button text @click="refreshList">刷新数量</el-button>
        <el-dropdown v-if="deliveryAvailable" trigger="click" @command="moreAction">
          <el-button text aria-label="更多操作">更多 <span class="more-arrow" aria-hidden="true">⌄</span></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-if="deliveryAvailable" command="classification">分类规则</el-dropdown-item>
              <el-dropdown-item v-if="deliveryAvailable" command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <div class="window-controls">
          <el-button text aria-label="最小化" @click="minimize">—</el-button>
          <el-button text aria-label="最大化或还原" @click="maximize">□</el-button>
          <el-button text class="window-close" aria-label="关闭" @click="close">×</el-button>
        </div>
      </div>
    </el-header>
    <div class="workspace-context"><span :class="{ disconnected: sharedStatus.enabled && !sharedStatus.connected }">{{ sharedStatus.connecting ? '服务器连接中…' : sharedStatus.connected ? '服务器已连接' : sharedStatus.enabled ? '服务器未连接' : '本地工作区' }}<template v-if="sharedStatus.connected && sharedStatus.host"> · {{ sharedStatus.host }}</template></span><span>当前范围：{{ currentScope }}</span><span v-if="sharedStatus.error" class="connection-error" :title="sharedStatus.error">{{ sharedStatus.error }}</span></div>
    <el-container class="workspace">
      <el-aside ref="navigationAside" class="navigation" :style="{ width: `${navigationWidth}px` }">
        <el-menu router :default-openeds="adminWorkspace?.openMenus ?? ['databases']" :default-active="$route.fullPath"
          ><el-menu-item index="/-1"
            >全部记录 {{ count }}{{ partial ? '（部分）' : '' }}</el-menu-item
          ><el-sub-menu index="databases">
            <template #title>数据库（{{ databases.length }}）</template>
            <el-menu-item v-for="entry in databases" :key="entry.id" :index="'/-1?db=' + encodeURIComponent(entry.id)" :title="entry.name + ' · ' + entry.database">
              <span class="database-count">（{{ typeof entry.compoundCount==='number'?entry.compoundCount:'—' }}）</span><span class="database-name">{{ entry.name }}</span>
            </el-menu-item>
            <div v-if="!databases.length" class="database-empty">暂无已发布数据库</div>
          </el-sub-menu><el-menu-item index="/analysis">检测结果</el-menu-item
          ><el-menu-item index="/-2">收藏夹</el-menu-item
          ><el-menu-item index="/-3">回收站</el-menu-item
          ><el-sub-menu index="quality"
            ><template #title>数据状态</template>
            <el-menu-item index="/-4">身份冲突</el-menu-item>
            <el-menu-item index="/-5">身份待解析</el-menu-item> </el-sub-menu
          ><el-sub-menu index="groups"
            ><template #title>自定义库／本地分组</template
            ><el-menu-item v-for="group in groups" :key="group.id" :index="'/' + group.id"
              >{{ group.class_name
              }}<el-button link @click.stop.prevent="renameGroup(group)">改名</el-button
              ><el-button link @click.stop.prevent="deleteGroup(group)">×</el-button></el-menu-item
            ></el-sub-menu
          ><el-sub-menu index="categories"
            ><template #title>分类</template>
            <div class="category-browser"><el-checkbox v-model="showEmptyCategories">显示空类别</el-checkbox><p v-if="categoryIssue" style="padding:8px;color:#b65c28">分类加载失败，可选择数据库后重试。{{ categoryIssue }}</p>
              <el-input
                v-model="categorySearch"
                placeholder="查找分类……"
                clearable
                @input="categoryTree?.filter(categorySearch)"
              />
              <el-tree
                ref="categoryTree"
                :data="visibleCategories"
                node-key="key"
                :props="{ label: 'label', children: 'children' }"
                :filter-node-method="filterCategory"
                :expand-on-click-node="false" :auto-expand-parent="false"
                :default-expanded-keys="expandedCategories"
                @node-expand="(data: CategoryTreeNode) => rememberCategory(data, true)"
                @node-collapse="(data: CategoryTreeNode) => rememberCategory(data, false)"
                highlight-current
                @node-click="selectCategory"
              >
              </el-tree>
            </div> </el-sub-menu
        ></el-menu></el-aside>
        <div
          class="navigation-resize-handle"
          role="separator"
          aria-label="左右拖动调整分类导航宽度"
          title="左右拖动调整宽度；双击恢复默认宽度"
          tabindex="0"
          @keydown="keyboardNavigationResize"
          aria-orientation="vertical"
          :aria-valuenow="navigationWidth"
          :aria-valuemin="navigationMinWidth"
          :aria-valuemax="navigationMaxWidth"
          @pointerdown="startNavigationResize"
          @dblclick="resetNavigationWidth"
      />
      <el-main class="workspace-content"
        ><router-view v-slot="{ Component }"
          ><keep-alive><component :is="Component" :key="$route.name" /></keep-alive
        ></router-view>
      </el-main>
    </el-container>
    <EditDraftManager v-if="deliveryAvailable" ref="draftsManager" hide-trigger @count="draftCount = $event" />
    <ClassificationManager v-if="deliveryAvailable" ref="classificationManager" hide-trigger />
    <ConnectionManager ref="connectionsManager" hide-trigger :manage-server-libraries="deliveryAvailable" />
  </el-container>
</template>

<style scoped>
.workspace-context {display:flex;gap:20px;align-items:center;flex:none;min-height:28px;padding:3px 18px;background:#f7f9fc;color:#63758a;font-size:12px;border-bottom:1px solid #e2e9f2}.disconnected {color:#b46922}.connection-error {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b46922;min-width:0}
.app-shell {
  height: 100vh;
  height: 100dvh;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
}
.app-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 20px;
  padding: 0 16px;
  background: #383d43;
  color: #fff;
  -webkit-app-region: drag;
}
.app-brand {
  font-size: 23px;
  flex-shrink: 0;
}
.app-subtitle {
  font-size: 14px;
  color: #d8dde4;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  -webkit-app-region: no-drag;
}
.header-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
.app-header :deep(button),
.app-header :deep(.el-dialog) {
  -webkit-app-region: no-drag;
}
.workspace {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.navigation {
  position: relative;
  flex: 0 0 auto;
  min-width: 0;
  background: #f5f7fa;
  border-right: 1px solid #e4e7ed;
  overflow: auto;
}
.navigation-resize-handle {
  position: relative;
  flex: 0 0 10px;
  align-self: stretch;
  z-index: 20;
  cursor: col-resize;
  touch-action: none;
  background: #edf2f8;
  border-left: 1px solid #dce4ef;
  border-right: 1px solid #dce4ef;
  -webkit-app-region: no-drag;
}
.navigation-resize-handle::after {
  position: absolute;
  top: 50%;
  left: 3px;
  width: 2px;
  height: 44px;
  transform: translateY(-50%);
  background: #8fa4bf;
  box-shadow: 3px 0 #8fa4bf;
  content: '';
  border-radius: 2px;
}
.navigation-resize-handle:hover,
.navigation-resize-handle:focus-visible {background:#d7e8ff;outline:2px solid #409eff;outline-offset:-2px}
.navigation-resize-handle:active {background:#bdd9ff}
:global(body.resizing-navigation),
:global(body.resizing-navigation *) {
  cursor: col-resize !important;
  user-select: none !important;
}
.database-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.database-empty { padding: 12px 20px; color: #909399; }
.category-browser {
  padding: 8px 12px 16px;
}
.category-browser :deep(.el-tree) {
  margin-top: 10px;
  background: transparent;
  font-size: 14px;
}
.category-browser :deep(.el-tree-node__content) {
  height: auto;
  min-height: 34px;
  align-items: flex-start;
  padding-top: 4px;
  padding-bottom: 4px;
}
.category-browser :deep(.el-tree-node__label) {white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;line-height:24px;min-width:0;flex:1}
.category-browser :deep(.el-tree-node__expand-icon) {flex:none}
.navigation :deep(.el-menu) {
  border-right: 0;
  background: transparent;
}
.workspace-content {
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: auto;
  background: #fff;
}
@media (max-width: 1000px) {
  
  .app-subtitle {
    display: none;
  }
}

.app-header { background:#fff;color:#25364c;border-bottom:1px solid #e2e9f2;gap:18px;padding:0 18px; }
.app-brand { display:flex;align-items:center;gap:10px;font-size:18px; }
.app-brand strong { font-weight:600; }.app-brand-icon { display:grid;place-items:center;width:32px;height:32px;background:#2f6fe4;color:#fff;border-radius:8px;font-size:23px;font-weight:700; }
.app-subtitle { color:#8491a3;font-size:12px; }.header-actions { gap:7px; }
.header-actions :deep(.el-button) { font-size:12px;padding:8px 11px; }
.header-actions { flex-shrink:0;gap:6px; }
.more-arrow { margin-left:5px;font-size:14px;color:#8491a3; }
.window-controls { display:flex;gap:2px;margin-left:8px;padding-left:10px;border-left:1px solid #e2e9f2; }
.window-controls :deep(.el-button) { width:30px;padding:0;font-size:17px;color:#63758a; }
.window-controls :deep(.window-close:hover) { background:#e65050;color:#fff; }
@media (max-width:1100px) { .app-subtitle { display:none; } }
.workspace { background:#f4f7fb; }.workspace-content { background:#f4f7fb; }
.navigation { background:#fff;border-color:#e2e9f2; }
.navigation :deep(.el-menu) { padding:8px 6px; }.navigation :deep(.el-menu--inline) { padding:0; }
.navigation :deep(.el-menu-item),.navigation :deep(.el-sub-menu__title) { height:40px;line-height:40px;font-size:13px;border-radius:6px;margin:2px 0; }
.navigation :deep(.el-menu-item.is-active) { background:#edf4ff;color:#2f6fe4;font-weight:500; }
.database-empty { padding:10px 20px;font-size:12px; }.category-browser { padding:8px 10px 12px; }

</style>

<style scoped>.database-count{flex:none;margin-right:4px;font-variant-numeric:tabular-nums}.database-name{min-width:0;overflow:hidden;text-overflow:ellipsis}</style>
