<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import DeliveryRecord from './DeliveryRecord.vue'
import FlatFieldsTable from './FlatFieldsTable.vue'
import {detailManifest} from '../../../shared/displayLayout.mjs'
import { classificationCatalog, classificationKey, classificationAxes } from '../../../shared/deliveryClassification.mjs'
import { compoundColumns } from '../../../shared/deliveryPresentation.mjs'
import { addDeliveryGroup } from '../../../shared/deliveryGroupSelection'
function closeGuard(event: Event): void {
  if(!wizard.value||JSON.stringify(draft)===wizardInitial.value)return
  ;(event as CustomEvent).detail.push(async()=>{
    try{await ElMessageBox.confirm('是否保存交付草稿后退出？','存在未保存草稿',{confirmButtonText:'保存草稿',cancelButtonText:'放弃修改',distinguishCancelAndClose:true});return await saveDraft()}catch(e){return e==='cancel'}
  })
}
onMounted(()=>window.addEventListener('masspeclib2-before-close',closeGuard))
onUnmounted(()=>window.removeEventListener('masspeclib2-before-close',closeGuard))
const clone = (value: any): any => JSON.parse(JSON.stringify(value))
const releaseStates: Record<string, string> = { draft: '待生成安装包', published: '已冻结内容', revoked: '已撤销', superseded: '已有新版本', deleted: '回收站' }
const tab = ref('releases'), busy = ref(false), error = ref(''), schema = ref<any>({ fields: {}, featureLabels: {} }), state = ref<any>({ users: [], tenants: [], releases: [], jobs: [], events: [] }), libraries = ref<any[]>([])
const releaseQuery = ref(''), releaseCustomer = ref(''), releaseStatus = ref('')
const activeReleases = computed(() => state.value.releases.filter((r: any) => r.state !== 'deleted'))
const deletedReleases = computed(() => state.value.releases.filter((r: any) => r.state === 'deleted'))
const filteredReleases = computed(() => activeReleases.value.filter((r: any) => (!releaseCustomer.value || r.tenantId === releaseCustomer.value) && (!releaseStatus.value || r.state === releaseStatus.value) && (!releaseQuery.value.trim() || [r.title, r.version, r.deliveryAt || '', displayTime(r), tenantName(r.tenantId), ...(r.sources || []).map((x: any) => x.displayName)].join(' ').toLowerCase().includes(releaseQuery.value.trim().toLowerCase()))))
const releaseStats = computed(() => [ { label: '全部交付', value: activeReleases.value.length, state: '' }, { label: '内容已就绪', value: activeReleases.value.filter((r: any) => r.state === 'published').length, state: 'published' }, { label: '待生成安装包', value: activeReleases.value.filter((r: any) => r.state === 'draft').length, state: 'draft' }, { label: '回收站', value: deletedReleases.value.length, state: 'deleted' } ])
function selectStat(status: string): void { tab.value = status === 'deleted' ? 'trash' : 'releases'; releaseStatus.value = status === 'deleted' ? '' : status }
const wizard = ref(false), step = ref(0), draft = reactive<any>({ title: '', version: '', tenantId: '', customerName: '', expiresAt: '', selections: [], policy: { fields: {}, features: {} } })
const wizardInitial=ref('')
const draftId = ref(''), draftRevision = ref(0), autoPreviewJob = ref(''), categoryKey = ref('')
const libraryId = ref(''), keyword = ref(''), classIds = ref<number[]>([]), candidatePage = ref(1), candidates = ref<any>({ rows: [], total: 0, classes: [] }), compoundIds = ref<number[]>([]), allMatching = ref(false), displayName = ref('')
const deliveryGroups = ref<{id:number;class_name:string;count:number}[]>([])
const deliveryGroupId = ref<number>()
const groupBusy = ref(false)
const groupIssue = ref('')
const configView = ref<any>(), fieldGroup = ref('compound'), fieldSearch = ref(''), selectedOnly = ref(false)
const loginAccount = reactive({ username: '', password: '', passwordConfirm: '' })
const credentialPasswordVisible=ref(false)
const loginAccountIssue=computed(()=>! /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{2,79}$/.test(loginAccount.username.trim())?'账号须为3–80位英文字母、数字或_.@-，首位为字母或数字':loginAccount.password.length<8||loginAccount.password.length>20?'密码须为8–20位':loginAccount.password!==loginAccount.passwordConfirm?'两次输入的密码不一致':'')
const preview = ref<any>(), previewRows = ref<any[]>([]), previewRecord = ref<any>(), packageMessage = ref(''), packageFile = ref('')
const packageSuccessOpen=ref(false)
const previewColumns = computed(() => preview.value?.compoundDisplay?.all || compoundColumns(previewRows.value, preview.value?.policy?.fields?.compound || []))
const candidateBusy = ref(false), candidateIssue = ref('')
const appliedCandidate = ref<{ libraryId:string; keyword:string; classIds:number[]; categoryKey:string }>()
function candidateCriteria() {
  return {libraryId:libraryId.value,keyword:keyword.value.trim(),classIds:[...classIds.value],categoryKey:categoryKey.value}
}
const candidateReady = computed(() => !candidateBusy.value && !candidateIssue.value &&
  !!appliedCandidate.value && JSON.stringify(appliedCandidate.value) === JSON.stringify(candidateCriteria()))
const selectedCandidateCount = computed(() => allMatching.value ? candidates.value.total : compoundIds.value.length)
const candidateSelection = computed(() => {
  if (!candidateReady.value || !appliedCandidate.value || !selectedCandidateCount.value) return undefined
  return {
    ...appliedCandidate.value, revision: candidates.value.revision, displayName: displayName.value.trim(),
    onlySelected: !allMatching.value, compoundIds: allMatching.value ? [] : [...compoundIds.value],
    estimatedCount: selectedCandidateCount.value
  }
})
const scopeNeedsUpdate = computed(() => {
  if (!allMatching.value && !compoundIds.value.length) return false
  const selection = candidateSelection.value
  if (!selection) return true
  const saved = draft.selections.find((item: any) => item.libraryId === selection.libraryId)
  if (!saved) return true
  return Object.entries(selection).some(([key, value]) => JSON.stringify(saved[key]) !== JSON.stringify(value))
})
let timer: ReturnType<typeof setInterval> | undefined, live = true, candidateGeneration = 0, previewGeneration = 0
let listing: Promise<void> | undefined
const pendingJobs = computed(() => state.value.jobs.filter((j: any) => j.state === 'building'))
const tenantName = (id: string): string => state.value.tenants.find((t: any) => t.id === id)?.name || '未知客户'
async function call(method: string, route: string, body?: any): Promise<any> { return invokeIPC('delivery:call', method, route, body) }
async function refresh(): Promise<void> {
  if (listing) return listing
  listing = refreshLists()
  return listing
}
async function refreshLists(): Promise<void> {
  try { const [s, l] = await Promise.all([call('GET', '/admin/state'), call('GET', '/admin/libraries')]); if (live) { state.value = s; libraries.value = l; error.value = ''; if(autoPreviewJob.value){ const job=s.jobs.find((j: any)=>j.id===autoPreviewJob.value);if(job?.state==='ready'){autoPreviewJob.value='';const release=s.releases.find((r: any)=>r.id===job.releaseId);if(release)await openPreview(release)}else if(job?.state==='failed')autoPreviewJob.value=''} } }
  catch (e) { if (live) error.value = String(e) }
  finally { listing = undefined }
}
function customerSuggestions(query: string, done: (rows: any[]) => void): void {
  const key = query.trim().normalize('NFKC').toLocaleLowerCase()
  done(key ? state.value.tenants.filter((t: any) => t.name.normalize('NFKC').toLocaleLowerCase().includes(key)).map((t: any) => { const releases = state.value.releases.filter((r: any) => r.tenantId === t.id); const latest = releases[releases.length - 1]; return { value: t.name, tenantId: t.id, detail: latest ? `最近交付：${latest.title} · ${latest.version}` : '沿用已有客户' } }) : [])
}
const matchingCustomers = computed(() => state.value.tenants.filter((t: any) => t.name.trim().normalize('NFKC').toLocaleLowerCase() === draft.customerName.trim().normalize('NFKC').toLocaleLowerCase()))
const customerHint = computed(() => draft.tenantId || matchingCustomers.value.length === 1 ? '将沿用该客户的交付记录。' : matchingCustomers.value.length > 1 ? '存在同名客户，请从输入提示中确认要沿用的客户。' : draft.customerName.trim() ? '生成草稿时自动建立客户记录，无需提前创建。' : '填写客户名称；已有客户可从输入提示中沿用。')


function completePolicy(policy: any): any {
  const features = { classification: false, classificationSubdivide: true, personalImport: true,
    personalDelete: true, personalRestore: true, ...policy?.features, offline: false }
  if (!features.chromatograms && !features.experiments) features.checks = false
  if (!features.checks) features.review = false
  const fields = Object.fromEntries(Object.keys(schema.value.fields).map(group =>
    [group, [...(policy?.fields?.[group] || (group === 'classification' ? ['categories', 'status', 'source_labels'] : []))]]))
  if (schema.value.fields.compound?.main_name && !fields.compound.includes('main_name')) fields.compound.unshift('main_name')
  return { presentation:{mode:'standard',listFields:[],detailFields:[],columns:[],...policy?.presentation},classification:{tagDepth:policy?.classification?.tagDepth??(policy?.classification?.sourceLabelDepth?Math.max(0,policy.classification.sourceLabelDepth-1):0),sourceLabelDepth:policy?.classification?.sourceLabelDepth??0,navigationDepth:policy?.classification?.navigationDepth??(policy?.features?.classificationSubdivide===false?1:2)},fields, features }
}
function newDeliveryPolicy(): any {
  return completePolicy({
    fields: { classification: [] },
    features: {
      classificationSubdivide: false,
      personalImport: false,
      personalDelete: false,
      personalRestore: false
    }
  })
}
async function loadConfiguration(r: any): Promise<any> { return call('GET', `/admin/releases/${r.id}/configuration`) }
async function viewConfiguration(r: any): Promise<void> {
  try { configView.value = { ...(await loadConfiguration(r)), release: r } } catch (e) { ElMessage.error(String(e)) }
}
async function startWizard(r?: any): Promise<void> {
  if (!schema.value.accessCapabilities) { ElMessage.error('交付服务需要更新到本版后才能创建或重新配置'); return }
  try {
    const saved = r ? await loadConfiguration(r) : null
    draftId.value = '';draftRevision.value=0
    Object.assign(draft, { title: saved?.title || '', tenantId: saved?.tenantId || '', customerName: saved?.customerName || '', replacesId: r?.id || null,expectedRevision:saved?.revision||null,
      offlineUsername: saved?.offlineUsername || '', deliveryAt: saved?.deliveryAt || new Date().toISOString(), expiresAt: saved?.expiresAt || '', notes: saved?.notes || '',
      access: { mode: 'offline', offlineCredentialId: saved?.access?.offlineCredentialId || '' },
      selections: saved ? clone(saved.selections) : [], policy: saved ? completePolicy(saved.policy) : newDeliveryPolicy() })
    libraryId.value = ''; categoryKey.value = ''; resetCandidates()
    deliveryGroupId.value = undefined
    groupIssue.value = ''
    loginAccount.username = saved?.offlineUsername || saved?.onlineUsername || ''; loginAccount.password = ''; loginAccount.passwordConfirm = '';  fieldGroup.value = 'compound'; fieldSearch.value = ''; selectedOnly.value = false
    step.value = 0; wizardInitial.value=JSON.stringify(draft); wizard.value = true
  } catch (e) { ElMessage.error(String(e)) }
}
const candidateCategories = computed(() => {
  const catalog = classificationCatalog(candidates.value.categories || [])
  const nodes = new Map<string, { key:string; label:string; children:any[] }>()
  for (const item of catalog) {
    const key = classificationKey(item)
    nodes.set(key, { key, label:item.category_name, children:[] })
  }
  const axes = new Map<string, { key:string; label:string; children:any[] }>()
  for (const item of catalog) {
    const node = nodes.get(classificationKey(item))!
    if (item.parent_code) { nodes.get(JSON.stringify([item.namespace, item.parent_code]))?.children.push(node); continue }
    const key = 'axis:' + item.axis
    if (!axes.has(key)) axes.set(key, { key, label:classificationAxes[item.axis as keyof typeof classificationAxes], children:[] })
    axes.get(key)!.children.push(node)
  }
  return [...axes.values()]
})
watch(() => draft.customerName, () => {
  if(draft.access?.offlineCredentialId)return
  const customer=state.value.tenants.find((t: any)=>t.id===draft.tenantId)||matchingCustomers.value.length===1&&matchingCustomers.value[0]
  if(!customer)return
  const options=(state.value.offlineCredentials||[]).filter((c: any)=>c.tenantId===customer.id),credential=options[options.length-1]
  if(credential){draft.tenantId=customer.id;draft.access={mode:'offline',offlineCredentialId:credential.id};draft.offlineUsername=credential.username;loginAccount.username=credential.username}
})
const accessIssues = computed(() => draft.access?.offlineCredentialId ? [] : [loginAccountIssue.value || '请点击「保存客户账号密码」'])
function accessLabel(mode: string): string { return mode === 'offline' ? '账号密码登录 · 安装包内置数据' : '旧版交付；重新配置后使用安装包内置数据' }
async function createAccessAccount(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = await call('POST', '/admin/access-credentials', { ...loginAccount, mode: 'offline', customerName: draft.customerName, tenantId: draft.tenantId || undefined })
    draft.tenantId = result.tenantId; draft.access = { mode: 'offline', offlineCredentialId: result.access.offlineCredentialId }
    draft.offlineUsername = result.username
    loginAccount.password = ''; loginAccount.passwordConfirm = ''; await refresh()
    ElMessage.success('客户账号密码已保存；生成安装包后即可使用')
  } catch (e) { ElMessage.error(String(e)) } finally { busy.value = false }
}
const credentialOpen = ref(false), credentialBusy = ref(false), credentialResult = ref<any>(), credentialKind = ref('online'), administratorPassword = ref(''), credentialRelease = ref<any>()
let credentialTimer: ReturnType<typeof setTimeout> | undefined
function clearCredentialView(): void { credentialPasswordVisible.value=false; clearTimeout(credentialTimer); credentialResult.value = undefined; administratorPassword.value = '' }
function openCredentials(release: any): void { clearCredentialView(); credentialRelease.value = release; credentialKind.value = release.access?.mode === 'offline' ? 'offline' : 'online'; credentialOpen.value = true }
async function revealCredentials(): Promise<void> {
  if (credentialBusy.value) return
  credentialBusy.value = true; const releaseId = credentialRelease.value?.id, kind = credentialKind.value
  try { const result = await call('POST', '/admin/view-credentials', { releaseId, kind, currentPassword: administratorPassword.value }); if (!credentialOpen.value || credentialRelease.value?.id !== releaseId || credentialKind.value !== kind) return; credentialResult.value = result; credentialTimer = setTimeout(clearCredentialView, 60000) }
  catch(e) { ElMessage.error(String(e)) } finally { administratorPassword.value = ''; credentialBusy.value = false }
}
async function copyCredential(value: string): Promise<void> { try { await invokeIPC('delivery:copy-text', value); ElMessage.success('已复制') } catch(e) { ElMessage.error(String(e)) } }
onUnmounted(clearCredentialView)
const visibleFieldOptions = computed(() => Object.entries(schema.value.fields[fieldGroup.value] || {}).filter(([key, label]) => (!fieldSearch.value.trim() || String(label).toLowerCase().includes(fieldSearch.value.trim().toLowerCase())) && (!selectedOnly.value || (draft.policy.fields[fieldGroup.value] || []).includes(key))))
function chooseVisibleFields(checked: boolean): void {
  const group = fieldGroup.value, chosen = new Set<string>(draft.policy.fields[group] || [])
  for (const [key] of visibleFieldOptions.value) { if (checked) chosen.add(key); else if (group !== 'compound' || key !== 'main_name') chosen.delete(key) }
  draft.policy.fields[group] = [...chosen]
}
const featureGroups = [ { name: '查询与查看', keys: ['classification','spectra', 'lc', 'chromatograms', 'experiments', 'favorite', 'groups'] }, { name: '内置数据管理（仅客户本机）', keys: ['deleteRecords', 'restoreRecords', 'purgeRecords'] }, { name: '个人数据', keys: ['personalImport', 'personalDelete', 'personalRestore', 'personalPurge'] }, { name: '数据导出与检查', keys: ['export'] } ]
const canCheckData = computed(() => !!(draft.policy.features.chromatograms || draft.policy.features.experiments))
watch([canCheckData, () => draft.policy.features.checks], ([available, checks]) => {
  if (!available) draft.policy.features.checks = false
  if (!available || !checks) draft.policy.features.review = false
})
watch(() => [draft.policy.features.restoreRecords, draft.policy.features.purgeRecords, draft.policy.features.personalRestore, draft.policy.features.personalPurge], () => { const f = draft.policy.features; if (f.restoreRecords || f.purgeRecords) f.deleteRecords = true; if (f.personalRestore || f.personalPurge) f.personalDelete = true })
watch(() => JSON.stringify(draft.policy), () => {
  const p=draft.policy;if(!p?.fields||!p.features)return
  const allowed=new Set(Object.entries(p.fields).flatMap(([g,keys])=>(keys as string[]).map(k=>g+'.'+k)));if(p.presentation)for(const key of ['listFields','detailFields','columns'])p.presentation[key]=(p.presentation[key]||[]).filter((id:string)=>allowed.has(id))
  const add=(group: string,key: string): void=>{p.fields[group]||=[];if(!p.fields[group].includes(key))p.fields[group].push(key)}
  if(p.fields.lc?.includes('retention_time'))add('lc','retention_time_unit')
  if(p.fields.ms?.includes('ce'))add('ms','ce_unit')
  if(p.fields.ms?.includes('ce_unit'))add('ms','ce_unit_source')
  if(p.fields.chromatogram?.includes('points'))add('chromatogram','time_unit')
  if(p.features.classificationSubdivide){add('classification','categories');add('classification','source_labels')}
  if(p.fields.classification?.includes('status'))add('classification','categories')
})
function displayTime(r: any): string { const value = r.deliveryAt || r.createdAt; return value ? new Date(value).toLocaleString() : '未记录' }
function resetCandidates(): void {
  ++candidateGeneration
  candidateIssue.value = ''
  candidateBusy.value = false
  appliedCandidate.value = undefined
  candidates.value = {rows:[],total:0,classes:[]}
  clearCandidateSelection()
}
function clearCandidateSelection(): void {
  allMatching.value = false
  compoundIds.value = []
}
function toggleAllMatching(): void {
  if (allMatching.value) { clearCandidateSelection(); return }
  if (!candidateReady.value || !candidates.value.total) return
  allMatching.value = true
  compoundIds.value = []
}
async function selectLibrary(): Promise<void> {
  resetCandidates()
  keyword.value = ''; classIds.value = []; categoryKey.value = ''
  displayName.value = libraries.value.find(l => l.id === libraryId.value)?.title || ''
  candidatePage.value = 1
  await searchCandidates()
}
async function searchCandidates(): Promise<void> {
  if (!libraryId.value) return
  const own = ++candidateGeneration, criteria = candidateCriteria()
  const previous = appliedCandidate.value, previousRevision = candidates.value.revision
  candidateBusy.value = true
  candidateIssue.value = ''
  try {
    const result = await call('POST', '/admin/candidates', {...criteria, page:candidatePage.value})
    if (own !== candidateGeneration) return
    if (previous && (JSON.stringify(previous) !== JSON.stringify(criteria) ||
        (previousRevision && result.revision !== previousRevision))) clearCandidateSelection()
    candidates.value = result
    appliedCandidate.value = criteria
  } catch (error) {
    if (own === candidateGeneration) {
      candidateIssue.value = String(error)
      candidates.value = {...candidates.value,rows:[],total:0}
    }
  } finally { if (own === candidateGeneration) candidateBusy.value = false }
}
function toggleCompound(id: number, checked: any): void {
  if (!candidateReady.value || allMatching.value) return
  compoundIds.value = checked ? [...new Set([...compoundIds.value, Number(id)])] : compoundIds.value.filter(x => x !== Number(id))
}
async function editSelection(selection: any): Promise<void> {
  resetCandidates()
  libraryId.value=selection.libraryId;keyword.value=selection.keyword||'';classIds.value=[...(selection.classIds||[])]
  categoryKey.value=selection.categoryKey||'';compoundIds.value=[...(selection.compoundIds||[])]
  allMatching.value=!selection.onlySelected;displayName.value=selection.displayName;candidatePage.value=1
  appliedCandidate.value = candidateCriteria()
  candidates.value = {...candidates.value,revision:selection.revision}
  await searchCandidates()
}
function addSelection(): void {
  const selection = candidateSelection.value
  if (!selection) { ElMessage.warning('请先查询并选择需要交付的记录'); return }
  if (!selection.displayName || draft.selections.some((s: any) => s.libraryId !== selection.libraryId && s.displayName === selection.displayName)) {
    ElMessage.warning('请为每个交付库设置不同的数据库显示名称')
    return
  }
  const index = draft.selections.findIndex((s: any) => s.libraryId === selection.libraryId)
  if (index >= 0) draft.selections[index] = selection
  else draft.selections.push(selection)
  ElMessage.success(index >= 0 ? '已更新交付范围' : '已加入交付范围')
}
watch([wizard, step], async ([open, activeStep], _, onCleanup) => {
  if (!open || activeStep !== 1) return
  let cancelled = false
  onCleanup(() => { cancelled = true })
  try {
    const groups = await invokeIPC('federation:groups', true)
    if (!cancelled) deliveryGroups.value = groups
  } catch (error) {
    if (!cancelled) groupIssue.value = `无法读取自建分组。${String(error)}`
  }
})
async function addGroupSelection(): Promise<void> {
  const group = deliveryGroups.value.find(item => item.id === deliveryGroupId.value)
  if (!group || groupBusy.value || scopeNeedsUpdate.value) return
  const original = JSON.stringify(draft.selections)
  groupBusy.value = true
  groupIssue.value = ''
  try {
    const members = await invokeIPC('federation:group-delivery-refs', group.id)
    const selections = await addDeliveryGroup(members, libraries.value, JSON.parse(original),
      criteria => call('POST', '/admin/candidates', criteria))
    if (!wizard.value || step.value !== 1 || original !== JSON.stringify(draft.selections) || scopeNeedsUpdate.value)
      throw new Error('当前交付范围已变化，请重新加入分组')
    draft.selections = selections
    resetCandidates()
    libraryId.value = ''
    ElMessage.success(`已将「${group.class_name}」整组加入交付范围`)
  } catch (error) { groupIssue.value = String(error) }
  finally { groupBusy.value = false }
}
function groupVisible(group: string): boolean { const f = draft.policy.features; return group === 'compound' || group === 'classification' || group === 'source' || (['ms', 'spectrum'].includes(group) && f.spectra) || (group === 'lc' && f.lc) || (group === 'chromatogram' && f.chromatograms) || (group === 'experiment' && f.experiments) }
watch(() => groupVisible(fieldGroup.value), visible => {
  if (!visible) fieldGroup.value = 'compound'
})
const policyIssues = computed(() => {
  const f = draft.policy.features, fields = draft.policy.fields, issues: string[] = []
  if (!(fields.compound || []).includes('main_name')) issues.push('在「基本信息」中选择「名称」')
  if ((f.restoreRecords || f.purgeRecords) && !f.deleteRecords) issues.push('恢复及彻底删除内置数据需要开放删除')
  if ((f.personalRestore || f.personalPurge) && !f.personalDelete) issues.push('恢复及彻底删除个人数据需要开放删除')
  if (f.review && !f.checks) issues.push('人工复核需要同时开放检查结果')
  if (f.checks && !f.chromatograms && !f.experiments) issues.push('检查结果需要色谱或测定数据')
  if (f.offline && !f.export) issues.push('离线交付需要允许导出，已交付文件不能远程收回')
  if ((fields.chromatogram || []).includes('points') && !(fields.chromatogram || []).includes('time_unit') && f.chromatograms) issues.push('在「色谱图」中勾选「时间单位」')
  if (f.checks && f.chromatograms && !(fields.chromatogram || []).includes('points')) issues.push('在「色谱图」中勾选「数值曲线」，以生成色谱检查结果')
  if (f.checks && f.experiments && !['measurement', 'ratio'].some(k => (fields.experiment || []).includes(k))) issues.push('在「测定结果」中勾选「测定值及单位」或「离子比及规则」')
  if (f.spectra && !fields.ms?.length && !fields.spectrum?.length)
    issues.push('在「质谱方法」或「谱图」中至少勾选一个字段')
  if (f.lc && !fields.lc?.length) issues.push('在「液相方法」中至少勾选一个字段')
  if (f.chromatograms && !fields.chromatogram?.length && !f.checks)
    issues.push('在「色谱图」中至少勾选一个字段')
  if (f.experiments && !fields.experiment?.length && !f.checks)
    issues.push('在「测定结果」中至少勾选一个字段')
  return issues
})
const nameIssues = computed(() => {
  const issues: string[] = []
  if (!draft.customerName?.trim()) issues.push('请填写客户名称')
  else if (!draft.tenantId && matchingCustomers.value.length > 1)
    issues.push('请从客户名称的下拉建议中选择一个同名客户')
  if (!draft.deliveryAt || !Number.isFinite(Date.parse(draft.deliveryAt))) issues.push('请选择有效的交付时间')
  return issues
})
const scopeIssues = computed(() => {
  if (groupBusy.value) return ['正在核对自建分组的记录']
  if (scopeNeedsUpdate.value) return ['请点击「加入／更新交付范围」，应用当前选择']
  return draft.selections?.length ? [] : ['请将数据库筛选结果或自建分组加入交付范围']
})
const wizardIssues = computed(() => {
  switch (step.value) {
    case 0: return nameIssues.value
    case 1: return scopeIssues.value
    case 3: return policyIssues.value
    case 4: return accessIssues.value
    case 5: return [...nameIssues.value, ...scopeIssues.value, ...policyIssues.value, ...accessIssues.value]
    default: return []
  }
})

const actionLabels: Record<string, string> = { 'delete-delivery-draft': '删除配置草稿', 'configure-access': '配置客户登录', 'view-credentials': '查看客户凭据', 'create-customer': '建立客户记录', 'create-user': '创建账号', 'update-user': '更新账号', login: '登录', 'change-password': '修改密码', 'build-release': '生成交付草稿', 'publish-release': '发布交付', 'revoke-release': '撤销授权', 'delete-release': '移入回收站', 'restore-release': '恢复为草稿', 'purge-release': '彻底删除版本', 'supersede-release': '替换旧版本', 'register-file-source': '注册文件数据库', 'relink-file-source': '重新关联文件库', 'file-record-delete': '删除源库化合物', 'file-record-restore': '恢复源库化合物', 'file-record-purge': '彻底删除源库化合物', 'prepare-package': '准备客户安装包', review: '提交人工复核', export: '导出数据' }
const groupNames: Record<string, string> = { classification: '化合物分类', compound: '基本信息', ms: '质谱方法', lc: '液相方法', spectrum: '谱图', chromatogram: '色谱图', experiment: '测定结果', source: '来源说明' }
function fieldCount(group: string): string {
  return `${(draft.policy.fields[group] || []).length}/${Object.keys(schema.value.fields[group] || {}).length}`
}
async function saveDraft(): Promise<boolean> {
  if(busy.value)return false;busy.value=true
  try{const saved=await call('POST','/admin/drafts',{...clone(draft),id:draftId.value||undefined,revision:draftRevision.value});draftId.value=saved.id;draftRevision.value=saved.revision;await refresh();wizardInitial.value=JSON.stringify(draft);ElMessage.success('草稿已保存，可稍后继续');return true}catch(e){ElMessage.error(String(e));return false}finally{busy.value=false}
}
async function deleteDraft(saved: any): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const name = saved.customerName?.trim() || '未命名客户'
    await ElMessageBox.confirm('删除「' + name + '」的配置草稿？', '删除配置草稿', {
      type: 'warning', confirmButtonText: '删除草稿', cancelButtonText: '取消'
    })
    await call('POST', '/admin/drafts/delete', { id: saved.id, revision: saved.revision })
    await listing
    state.value.drafts = (state.value.drafts || []).filter((item: any) => item.id !== saved.id)
    await refresh()
    ElMessage.success('配置草稿已删除')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') {
      ElMessage.error(String(e))
      await refresh()
    }
  } finally { busy.value = false }
}
async function resumeDraft(saved: any): Promise<void> {
  libraryId.value = ''; categoryKey.value = ''; resetCandidates()
  Object.assign(draft, clone(saved), {
    customerName: saved.customerName || '', tenantId: saved.tenantId || '', replacesId: saved.replacesId || null,
    expectedRevision: saved.expectedRevision || null, deliveryAt: saved.deliveryAt || '', expiresAt: saved.expiresAt || '',
    notes: saved.notes || '', offlineUsername: saved.offlineUsername || '', selections: clone(saved.selections || []),
    access: { mode: 'offline', offlineCredentialId: saved.access?.offlineCredentialId || '' },
    policy: saved.policy ? completePolicy(saved.policy) : newDeliveryPolicy()
  })
  fieldGroup.value = 'compound'; fieldSearch.value = ''; selectedOnly.value = false
  draftId.value=saved.id;draftRevision.value=saved.revision;loginAccount.username=saved.offlineUsername||'';loginAccount.password='';loginAccount.passwordConfirm='';step.value=0;wizardInitial.value=JSON.stringify(draft);wizard.value=true
}
async function leaveWizard(done?: () => void): Promise<void> {
  if(busy.value)return
  if(JSON.stringify(draft)===wizardInitial.value){if(done)done();else wizard.value=false;return}
  try{await ElMessageBox.confirm('是否保存当前配置草稿？','离开交付配置',{confirmButtonText:'保存草稿',cancelButtonText:'放弃本次修改',distinguishCancelAndClose:true});if(await saveDraft()){if(done)done();else wizard.value=false}}catch(e){if(e==='cancel'){if(done)done();else wizard.value=false}}
}
async function build(): Promise<void> {
  if (busy.value) return; busy.value = true
  try { if (wizardIssues.value.length) throw new Error(wizardIssues.value.join('；')); const job = await call('POST', '/admin/releases', { ...draft, draftId: draftId.value, draftRevision: draftRevision.value, title: draft.customerName, deliveryAt: new Date(draft.deliveryAt).toISOString() }); autoPreviewJob.value=job.id; wizard.value = false; tab.value = 'releases'; await refresh(); ElMessage.success('正在准备预览内容，完成后核对并生成 MSI。') }
  catch (e) { ElMessage.error(String(e)) } finally { busy.value = false }
}
async function openPreview(r: any): Promise<void> {
  const own = ++previewGeneration; previewRecord.value = undefined
  try { const result = await call('GET', `/admin/releases/${r.id}/records`); if (own === previewGeneration) { preview.value = { ...result.manifest, tenantId: r.tenantId }; previewRows.value = result.rows } }
  catch (e) { ElMessage.error(String(e)) }
}
async function openPreviewRecord(r: any): Promise<void> { const own = ++previewGeneration; try { const result = await call('GET', `/admin/releases/${preview.value.id}/records/${r.id}`); if (own === previewGeneration) previewRecord.value = result } catch (e) { ElMessage.error(String(e)) } }
async function revoke(r: any): Promise<void> {
  try { await ElMessageBox.confirm(`撤销「${r.title}」的在线访问？已导出的文件和离线包无法远程收回。`, '撤销授权'); await call('POST', `/admin/releases/${r.id}/revoke`, {}); await refresh(); ElMessage.success('已撤销在线授权') }
  catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) }
}
async function manageRelease(r: any, action: 'delete' | 'restore' | 'purge'): Promise<void> {
  if (busy.value) return
  try {
    if (action === 'restore') {
      await ElMessageBox.confirm(`将「${r.title} ${r.version}」恢复为草稿？核对后可重新生成安装包。`, '恢复交付版本', { confirmButtonText: '恢复为草稿', cancelButtonText: '取消', type: 'info' })
    } else {
      await ElMessageBox.confirm(`是否确认删除「${r.title} ${r.version}」？${action === 'purge' ? '删除后无法恢复。' : '删除后将进入回收站。'}`, '确认删除', { confirmButtonText: '是', cancelButtonText: '否', type: 'warning', closeOnClickModal: false, autofocus: false, customClass: 'release-delete-confirm' })
    }
    busy.value = true
    const result = await call('POST', `/admin/releases/${r.id}/${action}`, { confirmation: action === 'purge' ? true : undefined })
    if (preview.value?.id === r.id) { preview.value = undefined; previewRecord.value = undefined; ++previewGeneration }
    await refresh()
    if (result.cleanupPending) ElMessage.warning('版本已删除，服务器快照文件清理未完成，请联系管理员处理')
    else ElMessage.success(action === 'delete' ? '已移入回收站' : action === 'restore' ? '已恢复为草稿，可保存配置并预览' : '已彻底删除此交付版本')
  } catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) } finally { busy.value = false }
}
async function packageRelease(r: any): Promise<void> {
  if (busy.value) return; busy.value = true; packageMessage.value = '正在准备打包…'
  try { const result = await invokeIPC('delivery:package', r.id); if(result.cancelled){ElMessage.info('已取消生成客户 MSI');return}if(!result.file)throw Error('打包未返回安装包文件位置');packageFile.value=result.file;packageSuccessOpen.value=true;try{await refresh()}catch{ElMessage.warning('安装包已生成，交付列表暂未刷新，可稍后重新进入查看')} }
  catch (e) { ElMessage.error(String(e)) } finally { busy.value = false; packageMessage.value = '' }
}
function progress(_event: any, message: string): void { packageMessage.value = message }
onMounted(async () => { try { schema.value = await call('GET', '/schema') } catch (e) { error.value = String(e) }; await refresh(); timer = setInterval(() => { void refresh() }, 5000); window.electron.ipcRenderer.on('delivery:package-progress', progress) })
onUnmounted(() => { live = false; ++candidateGeneration; ++previewGeneration; clearInterval(timer); window.electron.ipcRenderer.removeListener('delivery:package-progress', progress) })
</script>
<template>
  <div class="admin-workspace">
    <el-dialog v-model="packageSuccessOpen" title="客户 MSI 生成成功" width="min(650px,94vw)" append-to-body :close-on-click-modal="false"><el-result icon="success" title="客户 MSI 生成成功" sub-title="安装包已保存到以下位置，可提供给客户安装。" /><p style="overflow-wrap:anywhere;user-select:text">{{packageFile}}</p><template #footer><el-button @click="packageSuccessOpen=false">关闭</el-button><el-button type="primary" @click="invokeIPC('delivery:show-package',packageFile).catch(e=>ElMessage.error(String(e)))">打开所在文件夹</el-button></template></el-dialog>
    <div class="admin-heading"><div><h2>客户交付管理</h2><p>导入内部库后，选择数据和字段，设置客户账号并预览，确认后生成内置数据的 MSI。</p></div><el-button type="primary" :disabled="busy || !schema.fields.compound?.main_name" @click="startWizard()">创建客户交付</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert v-if="packageMessage" :title="packageMessage" type="info" :closable="false" /><el-alert v-for="j in pendingJobs" :key="j.id" :title="`正在生成快照，已处理 ${j.count} 个化合物…`" type="info" :closable="false" /><el-alert v-for="j in state.jobs.filter((j: any) => j.state === 'failed')" :key="j.id" :title="`交付生成失败：${j.error}`" type="error" />
    <div class="release-stats"><button v-for="item in releaseStats" :key="item.label" class="stat-card" :class="{ selected: (item.state === 'deleted' ? tab === 'trash' : tab === 'releases' && releaseStatus === item.state) }" @click="selectStat(item.state)"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.state === 'deleted' ? '可恢复为草稿' : '查看版本 →' }}</small></button></div>
    <div v-if="packageFile" class="package-result"><span>安装包已生成：{{ packageFile }}</span><el-button link type="primary" @click="invokeIPC('delivery:show-package', packageFile)">打开文件位置</el-button></div>
    <section v-if="state.drafts?.length" class="saved-drafts">
      <h3>未完成的配置草稿</h3>
      <el-table :data="state.drafts" row-key="id" max-height="180">
        <el-table-column label="客户名称"><template #default="{ row }">{{ row.customerName?.trim() || '未命名客户' }}</template></el-table-column>
        <el-table-column label="保存时间"><template #default="{ row }">{{ new Date(row.updatedAt).toLocaleString() }}</template></el-table-column>
        <el-table-column label="操作" width="185"><template #default="{ row }">
          <el-button link type="primary" :disabled="busy" @click="resumeDraft(row)">继续配置</el-button>
          <el-button link type="danger" :disabled="busy" @click="deleteDraft(row)">删除草稿</el-button>
        </template></el-table-column>
      </el-table>
    </section>
    <el-tabs v-model="tab" class="management-tabs">

      <el-tab-pane label="交付记录" name="releases"><div class="version-filters"><el-input v-model="releaseQuery" clearable placeholder="搜索客户名称、交付日期或数据库" /><el-select v-model="releaseCustomer" clearable placeholder="全部客户"><el-option v-for="t in state.tenants" :key="t.id" :label="t.name" :value="t.id" /></el-select><el-select v-model="releaseStatus" clearable placeholder="全部状态"><el-option v-for="key in ['draft','published','revoked','superseded']" :key="key" :value="key" :label="releaseStates[key]" /></el-select><el-button @click="releaseQuery = ''; releaseCustomer = ''; releaseStatus = ''">重置</el-button><span>{{ filteredReleases.length }} 条交付记录</span></div><el-table :data="filteredReleases" empty-text="尚未创建客户交付"><el-table-column label="客户名称" min-width="200" show-overflow-tooltip><template #default="s">{{ tenantName(s.row.tenantId) }}<small v-if="s.row.title !== tenantName(s.row.tenantId)" class="legacy-title">{{ s.row.title }}</small></template></el-table-column><el-table-column label="交付时间" width="170"><template #default="s">{{ displayTime(s.row) }}</template></el-table-column><el-table-column label="交付数据库" min-width="220"><template #default="s"><div v-for="(db, i) in s.row.sources || []" :key="db.sourceKey || i">{{ db.displayName }}（{{ db.count }}）</div></template></el-table-column><el-table-column prop="total" label="化合物" width="84" align="right" /><el-table-column label="状态" width="130"><template #default="s"><el-tag :type="s.row.state === 'published' ? 'success' : s.row.state === 'draft' ? 'warning' : 'info'" effect="light">{{ releaseStates[s.row.state] || s.row.state }}</el-tag><small v-if="s.row.packageInfo"> · 已生成安装包</small></template></el-table-column><el-table-column label="有效期" width="100"><template #default="s">{{ s.row.expiresAt ? new Date(s.row.expiresAt).toLocaleDateString() : '长期' }}</template></el-table-column><el-table-column label="操作" width="264" fixed="right"><template #default="s"><el-button link :type="s.row.state === 'draft' ? 'primary' : 'default'" @click="openPreview(s.row)">客户预览</el-button><el-button v-if="['draft','published'].includes(s.row.state)" link type="primary" :disabled="busy" @click="openPreview(s.row)">生成客户MSI</el-button><el-dropdown trigger="click" :disabled="busy" @command="(action: string) => action === 'credentials' ? openCredentials(s.row) : action === 'view' ? viewConfiguration(s.row) : action === 'new' ? startWizard(s.row) : action === 'revoke' ? revoke(s.row) : manageRelease(s.row, 'delete')"><el-button link :disabled="busy">更多操作</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="view">查看配置</el-dropdown-item><el-dropdown-item command="credentials">查看登录凭据</el-dropdown-item><el-dropdown-item command="new">编辑配置</el-dropdown-item><el-dropdown-item v-if="s.row.access?.mode !== 'offline' && s.row.state !== 'revoked'" command="revoke">撤销在线授权</el-dropdown-item><el-dropdown-item command="delete" divided>删除</el-dropdown-item></el-dropdown-menu></template></el-dropdown></template></el-table-column></el-table></el-tab-pane>
      <el-tab-pane :label="`回收站（${deletedReleases.length}）`" name="trash"><el-alert title="删除后进入回收站，已有客户安装包仍可使用。恢复后为草稿，可重新预览生成；彻底删除仅清除此交付快照及复核记录，源数据库和操作记录保留。" type="info" :closable="false" /><el-table :data="deletedReleases" empty-text="回收站为空"><el-table-column label="客户"><template #default="s">{{ tenantName(s.row.tenantId) }}</template></el-table-column><el-table-column prop="title" label="交付名称" min-width="210" show-overflow-tooltip /><el-table-column prop="version" label="版本" /><el-table-column prop="total" label="化合物" width="84" align="right" /><el-table-column label="删除时间"><template #default="s">{{ new Date(s.row.deletedAt).toLocaleString() }}</template></el-table-column><el-table-column label="操作" width="200" fixed="right"><template #default="s"><el-button link @click="viewConfiguration(s.row)">查看配置</el-button><el-button link type="primary" :disabled="busy" @click="manageRelease(s.row, 'restore')">恢复为草稿</el-button><el-button link type="danger" :disabled="busy" @click="manageRelease(s.row, 'purge')">删除</el-button></template></el-table-column></el-table></el-tab-pane>
      <el-tab-pane label="操作记录" name="events"><el-table :data="state.events"><el-table-column prop="at" label="时间" width="220" /><el-table-column label="操作" width="180"><template #default="s">{{ actionLabels[s.row.action] || s.row.action }}</template></el-table-column><el-table-column label="操作者"><template #default="s">{{ state.users.find((u: any) => u.id === s.row.actor)?.username || s.row.actor }}</template></el-table-column><el-table-column label="对象"><template #default="s">{{ typeof s.row.target === 'object' ? JSON.stringify(s.row.target) : s.row.target }}</template></el-table-column></el-table></el-tab-pane>
    </el-tabs>
    <el-dialog v-model="wizard" :before-close="leaveWizard" class="delivery-wizard" :title="draft.replacesId ? '重新配置交付' : '创建客户交付'" width="1050px" :close-on-click-modal="false">
      <el-steps :active="step" finish-status="success"><el-step title="名称及时间" /><el-step title="数据范围" /><el-step title="显示方式及功能" /><el-step title="交付字段" /><el-step title="客户账号" /><el-step title="核对生成" /></el-steps>
      <el-form v-if="step === 0" label-width="140px" class="wizard-step">
        <el-alert v-if="draft.replacesId" title="保存后更新此交付的配置与预览，并保留历史快照；核对预览后需重新生成安装包。" type="info" :closable="false" />
        <el-form-item label="客户名称"><div class="customer-name-field"><el-autocomplete v-model="draft.customerName" :fetch-suggestions="customerSuggestions" :trigger-on-focus="false" :maxlength="120" :disabled="!!draft.replacesId" clearable placeholder="填写客户名称" @input="draft.tenantId = ''; draft.access.userId = ''; draft.access.offlineCredentialId = ''" @select="(item: any) => { draft.tenantId = item.tenantId; draft.access.userId = ''; draft.access.offlineCredentialId = '' }"><template #default="{ item }"><span>{{ item.value }}</span><small>{{ item.detail }}</small></template></el-autocomplete><span class="customer-hint">{{ customerHint }}</span></div></el-form-item>
        <el-form-item label="交付时间"><el-date-picker v-model="draft.deliveryAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" :clearable="false" /></el-form-item>
        <el-form-item label="授权到期时间"><el-date-picker v-model="draft.expiresAt" type="datetime" placeholder="留空表示长期" value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="draft.notes" type="textarea" :maxlength="2000" show-word-limit /></el-form-item>
      </el-form>
      <div v-if="step === 1" class="wizard-step">
        <div class="filter-line">
          <el-select v-model="deliveryGroupId" placeholder="选择自建分组" clearable filterable :disabled="groupBusy">
            <el-option v-for="group in deliveryGroups" :key="group.id" :label="`${group.class_name}（${group.count} 条）`" :value="group.id" :disabled="!group.count" />
          </el-select>
          <el-button :loading="groupBusy" :disabled="!deliveryGroupId || scopeNeedsUpdate" @click="addGroupSelection">整组加入</el-button>
        </div>
        <p v-if="groupIssue" role="alert">{{ groupIssue }}</p>
        <div class="filter-line">
          <el-select v-model="libraryId" placeholder="选择原始数据库" @change="selectLibrary">
            <el-option v-for="l in libraries" :key="l.id" :label="l.title" :value="l.id" />
          </el-select>
          <el-input v-model="keyword" placeholder="按名称、CAS或分子式筛选" @keyup.enter="candidatePage = 1; searchCandidates()" />
          <el-tree-select v-model="categoryKey" :data="candidateCategories" node-key="key" :props="{label:'label',children:'children',value:'key'}" check-strictly clearable filterable placeholder="规范分类筛选" />
          <el-button @click="candidatePage = 1; searchCandidates()">查询</el-button>
        </div>
        <p v-if="candidateIssue" role="alert">{{ candidateIssue }}</p>
        <p v-else-if="libraryId && !candidateReady && !candidateBusy">请先查询并核对当前条件，才能加入交付范围。</p>
        <el-table v-loading="candidateBusy" :data="candidates.rows" height="270">
          <el-table-column width="55">
            <template #default="{ row }">
              <el-checkbox
                :disabled="!candidateReady || allMatching"
                :model-value="allMatching || compoundIds.includes(Number(row.id))"
                :aria-label="`选择 ${row.main_name}`"
                @change="value => toggleCompound(row.id, value)"
              />
            </template>
          </el-table-column>
          <el-table-column prop="main_name" label="名称" />
          <el-table-column prop="cas" label="CAS" />
          <el-table-column prop="formula" label="分子式" />
        </el-table>
        <el-pagination v-model:current-page="candidatePage" :disabled="!candidateReady" :total="candidates.total" :page-size="50" layout="total, prev, pager, next" @current-change="searchCandidates" />
        <div class="filter-line">
          <el-button :disabled="!allMatching && (!candidateReady || !candidates.total)" :type="allMatching ? 'primary' : 'default'" :aria-pressed="allMatching" @click="toggleAllMatching">
            {{ allMatching ? '取消全选' : '全选筛选结果' }}
          </el-button>
          <span v-if="candidateReady" role="status">{{ allMatching ? `已全选 ${selectedCandidateCount} 条（含其他页）` : `已选择 ${selectedCandidateCount} 条` }}</span>
          <el-input v-model="displayName" placeholder="客户看到的数据来源名称" :maxlength="120" />
          <el-button :disabled="!candidateSelection" @click="addSelection">加入／更新交付范围</el-button>
        </div>
        <el-table :data="draft.selections" empty-text="尚未加入交付范围">
          <el-table-column prop="displayName" label="交付来源名称" />
          <el-table-column label="条件"><template #default="s">{{ s.row.onlySelected ? `勾选 ${s.row.compoundIds.length} 条` : (s.row.estimatedCount == null ? '全部匹配记录' : `全部匹配 · ${s.row.estimatedCount} 条`) }}；{{ s.row.keyword || '不限文字' }}；{{ s.row.categoryKey ? "已选分类" : (s.row.classIds?.length ? `${s.row.classIds.length} 个分类条件` : "不限分类") }}</template></el-table-column>
          <el-table-column width="140">
            <template #default="s">
              <el-button link type="primary" @click="editSelection(s.row)">编辑</el-button>
              <el-button link type="danger" @click="draft.selections.splice(s.$index, 1)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div v-if="step === 2" class="wizard-step"><el-form label-position="top"><el-form-item label="客户端显示方式"><el-radio-group v-model="draft.policy.presentation.mode"><el-radio value="standard">列表＋详情</el-radio><el-radio value="table" :disabled="schema.presentationVersion!==1">单页表格（自选字段）</el-radio></el-radio-group></el-form-item></el-form><p>下一步选择字段；表格模式仅显示已选字段，默认无详情入口。</p>
        <section v-for="group in featureGroups" :key="group.name" class="feature-group">
          <h3>{{ group.name }}</h3>
          <el-checkbox v-for="key in group.keys.filter(k => schema.featureLabels[k])" :key="key"
            v-model="draft.policy.features[key]">{{ schema.featureLabels[key] }}</el-checkbox>
          <template v-if="group.keys.includes('export') && canCheckData">
            <el-checkbox v-if="schema.featureLabels.checks" v-model="draft.policy.features.checks">
              {{ schema.featureLabels.checks }}
            </el-checkbox>
            <el-checkbox v-if="draft.policy.features.checks && schema.featureLabels.review" v-model="draft.policy.features.review">
              {{ schema.featureLabels.review }}
            </el-checkbox>
          </template>
        </section>
        <el-form v-if="draft.policy.features.classification" label-position="top"><el-form-item label="分类导航层级"><el-select v-model="draft.policy.classification.navigationDepth" @change="v=>draft.policy.features.classificationSubdivide=v===2"><el-option :value="1" label="一级：固定大类" /><el-option :value="2" label="两级：固定大类 → 统一细类" /></el-select><p>三级及更细原分类保留为详情标签，不生成更多导航层级。</p></el-form-item></el-form><el-form v-if="draft.policy.fields.classification?.includes('source_labels')" label-position="top"><el-form-item label="原始分类标签保留深度"><el-select v-model="draft.policy.classification.tagDepth"><el-option :value="0" label="保留全部层级" /><el-option v-for="depth in 10" :key="depth" :value="depth" :label="`保留原始分类前 ${depth} 级`" /></el-select><p>此项控制原始标签交付范围，不增加左侧导航层级。保留全部时可在详情查看完整原始分类；单页表格可选择原始分类标签列。</p></el-form-item></el-form><el-alert title="所选数据随安装包交付。彻底删除默认关闭；内置数据操作只影响客户本机工作区。个人数据导入可配置；客户自有数据始终可以备份和导出。选择离子源参数原文将交付整段原文，请在预览中核对。" type="info" :closable="false" />
      </div>
      <div v-if="step === 3" class="wizard-step">
        <p>选择客户可以看到的字段。字段按功能分组，至少保留一个质谱或谱图字段，以及一个液相方法字段。</p>
        <div class="field-workspace">
          <el-menu :default-active="fieldGroup" @select="key => fieldGroup = key">
            <el-menu-item v-for="group in Object.keys(schema.fields).filter(groupVisible)" :key="group" :index="group">
              {{ groupNames[group] }}<small>{{ fieldCount(group) }}</small>
            </el-menu-item>
          </el-menu>
          <div class="field-panel">
            <div class="filter-line">
              <el-input v-model="fieldSearch" clearable placeholder="查找字段" />
              <el-checkbox v-model="selectedOnly">只显示已选</el-checkbox>
              <el-button @click="chooseVisibleFields(true)">全选当前字段</el-button>
              <el-button @click="chooseVisibleFields(false)">清空当前字段</el-button>
            </div>
            <div class="field-options">
              <el-checkbox v-for="[key,label] in visibleFieldOptions" :key="key" :model-value="draft.policy.fields[fieldGroup]?.includes(key)" :disabled="fieldGroup === 'compound' && key === 'main_name'" @change="checked => {
                const selected = new Set(draft.policy.fields[fieldGroup] || [])
                if (checked) selected.add(key)
                else if (!(fieldGroup === 'compound' && key === 'main_name')) selected.delete(key)
                draft.policy.fields[fieldGroup] = [...selected]
              }">{{ label }}</el-checkbox>
            </div>
          </div>
        </div>
      </div>
      <div v-if="step === 4" class="wizard-step access-account"><h3>客户登录账号</h3>
        <p>所选数据将内置到客户 MSI。客户安装后输入此账号和密码即可使用，无需连接服务器。</p>
        <el-alert v-if="draft.access.offlineCredentialId" :title="`已设置客户账号${draft.offlineUsername ? '：' + draft.offlineUsername : ''}；不重新设置则沿用原账号密码。`" type="success" :closable="false" />
        <el-divider content-position="left">{{ draft.access.offlineCredentialId ? '重新设置账号密码（可选）' : '设置账号密码' }}</el-divider>
        <p>账号3–80位，以英文字母或数字开头，可使用_.@-；密码8–20位，区分大小写，两次输入须一致。</p><el-alert v-if="loginAccountIssue" :title="loginAccountIssue" type="info" :closable="false" /><el-form label-width="100px"><el-form-item label="账号"><el-input v-model="loginAccount.username" autocomplete="off" placeholder="至少3位，字母数字及_.@-" /></el-form-item><el-form-item label="密码"><el-input v-model="loginAccount.password" type="password" show-password autocomplete="new-password" placeholder="8–20位" maxlength="20" /></el-form-item><el-form-item label="确认密码"><el-input v-model="loginAccount.passwordConfirm" type="password" show-password autocomplete="new-password" /></el-form-item><el-form-item><el-button :loading="busy" :disabled="!!loginAccountIssue" @click="createAccessAccount">保存客户账号密码</el-button></el-form-item></el-form>
        <el-alert title="重新设置只用于接下来生成的交付和安装包，已发送安装包的账号密码保持原样。" type="info" :closable="false" />
      </div>
      <div v-if="step === 5" class="wizard-step"><div class="filter-line"><el-button @click="step=1">修改数据范围</el-button><el-button @click="step=2">修改功能</el-button><el-button @click="step=3">修改字段</el-button><el-button @click="step=4">修改账号</el-button></div><h3>{{ draft.customerName }}</h3><p>交付时间：{{ new Date(draft.deliveryAt).toLocaleString() }}；授权期限：{{ draft.expiresAt ? new Date(draft.expiresAt).toLocaleString() : '长期' }}</p><p>客户登录：{{ draft.offlineUsername }}；所选数据内置安装包</p><p v-if="draft.notes">备注：{{ draft.notes }}</p><p v-for="selected in draft.selections" :key="selected.libraryId">数据库：{{ selected.displayName }} · {{ selected.onlySelected ? `勾选 ${selected.compoundIds.length} 条` : '符合当前筛选的记录' }}</p><p>开放功能：{{ Object.keys(draft.policy.features).filter(k => draft.policy.features[k]).map(k => schema.featureLabels[k]).join('、') || '基本信息查询' }}</p><p v-for="group in Object.keys(schema.fields).filter(groupVisible)" :key="group">{{ groupNames[group] }}：{{ (draft.policy.fields[group] || []).map((k: string) => schema.fields[group][k]).join('、') || '不交付' }}</p><el-alert title="保存修改覆盖当前配置，自动更新预览前100条；核对后生成MSI，已发安装包保持不变。" type="info" :closable="false" /></div>
      <template #footer>
        <ul v-if="wizardIssues.length" class="wizard-issues" aria-live="polite">
          <li v-for="issue in wizardIssues" :key="issue">{{ issue }}</li>
        </ul>
        <el-button :disabled="busy" @click="leaveWizard()">关闭</el-button>
        <el-button :disabled="busy" @click="saveDraft">保存草稿</el-button>
        <el-button v-if="step > 0" :disabled="busy" @click="step--">上一步</el-button>
        <el-button v-if="step < 5" type="primary" :disabled="busy || !!wizardIssues.length" @click="step++">下一步</el-button>
        <el-button v-else type="primary" :loading="busy" :disabled="!!wizardIssues.length" @click="build">保存配置并预览</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="credentialOpen" class="credential-dialog" title="客户登录凭据" width="560px" :close-on-click-modal="false" @closed="clearCredentialView"><p>{{ credentialRelease?.title }} · {{ credentialRelease ? displayTime(credentialRelease) : '' }}</p><el-radio-group v-if="credentialRelease?.access?.mode !== 'offline'" v-model="credentialKind" @change="clearCredentialView"><el-radio value="online" :disabled="!credentialRelease?.access?.userId">在线账号</el-radio><el-radio value="offline" :disabled="!credentialRelease?.access?.offlineCredentialId">安装包本地账号</el-radio></el-radio-group><template v-if="!credentialResult"><el-form label-position="top"><el-form-item label="再次输入管理员密码"><el-input v-model="administratorPassword" type="password" show-password autocomplete="current-password" @keyup.enter="revealCredentials" /></el-form-item></el-form><el-button type="primary" :loading="credentialBusy" :disabled="!administratorPassword" @click="revealCredentials">验证并查看</el-button></template><template v-else><el-form label-position="top"><el-form-item label="客户账号"><el-input :model-value="credentialResult.username" readonly><template #append><el-button @click="copyCredential(credentialResult.username)">复制</el-button></template></el-input></el-form-item><el-form-item label="客户密码"><el-input :model-value="credentialResult.password" :type="credentialPasswordVisible ? 'text' : 'password'" readonly><template #append><el-button @click="copyCredential(credentialResult.password)">复制</el-button></template></el-input></el-form-item></el-form><el-checkbox v-model="credentialPasswordVisible">显示客户密码</el-checkbox></template><el-alert title="凭据默认遮挡，60秒后清除显示；查看操作会记录审计。旧账号未加密留存的密码只能重新设置。" type="info" :closable="false" /><template #footer><el-button @click="credentialOpen = false; clearCredentialView()">关闭</el-button></template></el-dialog>
    <el-dialog :model-value="!!configView" title="交付配置" width="850px" @close="configView = undefined"><template v-if="configView"><el-descriptions :column="2" border><el-descriptions-item label="客户名称">{{ configView.customerName }}</el-descriptions-item><el-descriptions-item label="交付时间">{{ displayTime(configView) }}</el-descriptions-item><el-descriptions-item label="有效期">{{ configView.expiresAt || '长期' }}</el-descriptions-item><el-descriptions-item label="登录方式">{{ accessLabel(configView.access?.mode) }}</el-descriptions-item><el-descriptions-item label="修订标识">{{ configView.revision }}</el-descriptions-item><el-descriptions-item label="备注">{{ configView.notes || '—' }}</el-descriptions-item></el-descriptions><h3>数据范围</h3><p v-for="selected in configView.selections" :key="selected.libraryId">{{ selected.displayName }} · {{ selected.keyword || '不限文字' }} · {{ selected.onlySelected ? `指定 ${selected.compoundIds?.length || 0} 条` : '符合筛选的记录' }}</p><h3>字段与功能</h3><p v-for="(keys, group) in configView.policy.fields" :key="group">{{ groupNames[group] }}：{{ (keys as string[]).map(k => schema.fields[group]?.[k] || k).join('、') || '不交付' }}</p><p>{{ Object.keys(configView.policy.features).filter(k => configView.policy.features[k]).map(k => schema.featureLabels[k]).join('、') }}</p></template></el-dialog>
    <el-dialog :model-value="!!preview" title="客户界面预览" fullscreen @close="preview = undefined; previewRecord = undefined; ++previewGeneration"><div v-if="preview" class="preview-workspace"><div class="preview-actions"><span>预览前100条；安装包包含完整已选范围。</span><el-button type="primary" :loading="busy" @click="packageRelease(state.releases.find((r: any) => r.id === preview.id))">确认并生成客户 MSI</el-button></div><DeliveryRecord v-if="previewRecord" :record="previewRecord" :manifest="detailManifest(preview)" preview @close="previewRecord = undefined" /><template v-else><h2>{{ preview.title }} · {{ preview.version }}</h2><p>{{ tenantName(preview.tenantId) }} · 共 {{ preview.total }} 个化合物，预览前100条。生成客户软件后只显示此客户获授权的数据。</p><p>关联内容：{{ Object.entries(preview.contents || {}).map(([k,v]) => `${({ compounds: '化合物', ms: '质谱方法', lc: '液相方法', spectra: '谱图', chromatograms: '色谱', experiments: '测定结果' } as Record<string,string>)[k] || k}：${v}`).join('；') }}</p><FlatFieldsTable v-if="preview.policy.presentation?.mode==='table'||preview.policy.presentation?.listFields?.length" :details="preview.policy.presentation?.mode!=='table'" @open="openPreviewRecord" :records="previewRows" :manifest="preview" /><el-table v-else :data="previewRows" @row-dblclick="openPreviewRecord"><el-table-column v-for="k in previewColumns" :key="k" :label="preview.fieldLabels?.compound?.[k] || k"><template #default="s">{{ s.row.compound[k] }}</template></el-table-column><el-table-column prop="sourceTitle" label="数据来源" /><el-table-column label="操作"><template #default="s"><el-button link @click="openPreviewRecord(s.row)">查看详情</el-button></template></el-table-column></el-table></template></div></el-dialog>
  </div>
</template>
<style scoped>
.field-workspace {display:grid;grid-template-columns:170px 1fr;border:1px solid #e2e8f0;min-height:260px;border-radius:6px;overflow:hidden}.field-workspace .el-menu {border-right:1px solid #e2e8f0}.field-workspace .el-menu-item {height:40px;gap:10px}.field-workspace small {color:#7c8a9d;margin-left:auto;font-size:11px}.field-panel {padding:0 18px}.field-options {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.field-options .el-checkbox {white-space:normal;height:auto;min-height:30px;line-height:1.6;margin-right:8px}.feature-group {padding:5px 0 15px;border-bottom:1px solid #eef1f6}.feature-group h3 {font-size:14px}.access-account {margin-top:25px}.access-account .el-select {min-width:300px}

.customer-name-field {width:100%;display:flex;flex-direction:column;gap:6px}.customer-name-field :deep(.el-autocomplete) {width:100%}.customer-hint {font-size:12px;color:#7c8a9d;line-height:1.6}.customer-name-field small {margin-left:12px;color:#8491a2}
.admin-workspace { padding: 28px; background: #f5f7fb; flex: 1; min-height: 0; overflow: auto; }.admin-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }.admin-heading h2 { margin: 0; }.admin-heading p { color: #6b7c92; }.wizard-step { margin-top: 28px; max-height: 58vh; overflow: auto; padding: 0 10px 16px; }.filter-line { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 16px 0; }.filter-line .el-input, .filter-line .el-select { width: 250px; }.preview-workspace { height: calc(100vh - 110px); min-height: 0; }.el-alert { margin: 14px 0; }
.workspace-eyebrow { font-size: 11px; letter-spacing: 2px; color: #6c839e; display: block; margin-bottom: 8px; }.admin-heading h2 { font-size: 25px; }.admin-heading :deep(.el-button--primary) { height: 42px; padding: 0 22px; border-radius: 8px; }.release-stats { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 16px; margin: 20px 0 24px; }.stat-card { text-align: left; background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 20px; cursor: pointer; color: #677b94; display: grid; grid-template-columns: 1fr auto; gap: 8px; transition: border-color .15s, box-shadow .15s; }.stat-card:hover,.stat-card.selected { border-color: #91bdf6; box-shadow: 0 3px 12px #2164a50d; }.stat-card strong { grid-row: span 2; align-self: center; font-size: 30px; color: #263e5d; }.stat-card small { color: #8c9cb0; }.management-tabs { background: white; border: 1px solid #e4eaf2; border-radius: 12px; padding: 8px 20px 20px; }.version-filters { display: flex; align-items: center; gap: 12px; padding: 10px 0 20px; flex-wrap: wrap; }.version-filters .el-input { width: 300px; }.version-filters .el-select { width: 190px; }.version-filters > span { margin-left: auto; font-size: 13px; color: #8190a3; }.admin-workspace :deep(.el-table th.el-table__cell) { background: #f5f8fc; color: #5f738e; }.admin-workspace :deep(.el-table .cell) { padding-top: 6px; padding-bottom: 6px; }@media(max-width:900px) { .release-stats { gap: 8px; }.stat-card { padding: 12px; }.management-tabs { padding: 4px 12px 16px; } }
.package-result { display:flex;align-items:center;gap:12px;padding:10px 14px;margin:10px 0;background:#f0f9ed;border:1px solid #d8ead0;border-radius:6px;font-size:13px; }.package-result span { overflow-wrap:anywhere; }

.admin-workspace { padding:20px 24px;display:flex;flex-direction:column;gap:0;overflow:hidden;background:#f4f7fb; }
.admin-heading { flex:none;gap:16px; }
.admin-heading h2 { font-size:22px;font-weight:600;line-height:1.4; }
.admin-heading p { margin-top:5px;font-size:12px;color:#78869a; }
.admin-heading :deep(.el-button--primary) { height:34px;padding:0 16px;border-radius:7px; }
.release-stats { flex:none;gap:12px;margin:16px 0; }
.stat-card { border-radius:8px;padding:12px 16px;gap:4px 12px;box-shadow:none; }
.stat-card.selected { background:#f0f5ff;border-color:#a6c1f3;box-shadow:none; }
.stat-card strong { font-size:25px;font-weight:600;font-variant-numeric:tabular-nums; }
.stat-card span { font-size:12px;color:#61748d; }.stat-card small { font-size:11px; }
.management-tabs { flex:1;min-height:0;display:flex;flex-direction:column;padding:4px 16px 14px;border-radius:9px;border-color:#e2e9f2; }
.management-tabs :deep(.el-tabs__header) { margin:0;flex:none; }
.management-tabs :deep(.el-tabs__content) { flex:1;min-height:0;overflow:auto; }
.management-tabs :deep(.el-tabs__item) { font-size:13px;height:44px; }
.version-filters { padding:12px 0;gap:8px; }
.version-filters .el-input { width:270px; }.version-filters .el-select { width:170px; }
.admin-workspace :deep(.el-table) { font-size:13px; }
.admin-workspace :deep(.el-table th .cell) { padding-top:3px;padding-bottom:3px;font-weight:600; }
.admin-workspace :deep(.el-table td .cell) { padding-top:5px;padding-bottom:5px;line-height:23px; }
.admin-workspace :deep(.el-table .el-dropdown) { margin-left:8px;vertical-align:middle; }
.admin-workspace :deep(.el-table .el-button--text),.admin-workspace :deep(.el-table .el-button.is-link) { font-size:12px; }
.admin-workspace :deep(.el-tag) { border-radius:5px; }
.admin-workspace > .el-alert { flex:none;margin:10px 0; }
.wizard-step { margin-top:20px; }.filter-line { gap:8px;margin:12px 0; }
@media(max-width:1100px) { .admin-workspace { padding:16px; }.version-filters .el-input { width:230px; }.version-filters .el-select { width:150px; } }
@media(max-width:800px) { .admin-workspace { padding:12px; }.release-stats { grid-template-columns:repeat(2,minmax(0,1fr));gap:8px; }.stat-card { padding:8px 12px; }.admin-heading p { max-width:350px; }.admin-heading h2 { font-size:20px; } }

</style>

<style scoped>.admin-workspace .admin-heading{margin-bottom:10px}.admin-workspace .release-stats{margin:10px 0}.admin-workspace .stat-card{padding:8px 14px}.admin-workspace .stat-card strong{font-size:24px}.admin-workspace .stat-card small{display:none}.legacy-title{display:block;color:#8a96a5;font-size:11px}.admin-workspace :deep(#pane-file-sources){height:100%;min-height:0}</style>

<style scoped>.preview-workspace{display:flex;flex-direction:column;height:calc(100vh - 110px);min-height:360px}.preview-workspace>.el-table{flex:1;min-height:0}.preview-actions{flex:none}.filter-line>.el-select{min-width:260px;flex:1}</style>

<style scoped>
.wizard-issues { margin: 0 0 12px; padding-left: 20px; text-align: left; color: var(--el-color-warning-dark-2); }
</style>
