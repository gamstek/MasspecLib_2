<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { adminWorkspace } from './utils/adminWorkspace'

import { invokeIPC } from './utils/ipcInvoke'
import LegacyApp from './LegacyApp.vue'
import DeliveryApp from './components/DeliveryApp.vue'
import AdminLogin from './components/AdminLogin.vue'
const startupError = ref('')
const router = useRouter()
const workspaceInstance = ref(0)
let resetting = false
const edition = ref('loading'), deliveryOpen = ref(false), deliveryVisited = ref(false), adminReady = ref(false)
function openDelivery(): void { deliveryVisited.value = true; deliveryOpen.value = true }
function sessionUpdated(_event: unknown, session: any): void {
  if (edition.value === 'admin' && !session?.connected && !session?.restoring) { adminWorkspace.value = undefined; adminReady.value = false; deliveryOpen.value = false; deliveryVisited.value = false }
}
async function logout(): Promise<void> {
  try { if(await (window as any).masspecConfirmClose())await invokeIPC('admin:logout') } catch(e) { if (e !== 'cancel' && e !== 'close') console.error(e) }
}
async function restoreWorkspace(): Promise<void> {
  if (resetting || !adminReady.value) return
  resetting = true
  try {
    if (!(await (window as any).masspecConfirmClose())) return
    const settings = await invokeIPC('admin:workspace')
    if (!adminReady.value) return
    adminWorkspace.value = settings
    await router.replace({ path: '/-1', query: { db: settings.defaultConnectionId } })
    workspaceInstance.value++
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  } finally {
    resetting = false
  }
}
onMounted(async () => {
  ;(window as any).masspecConfirmClose=async():Promise<boolean>=>{
    const guards:Array<()=>Promise<boolean>>=[]
    window.dispatchEvent(new CustomEvent('masspeclib2-before-close',{detail:guards}))
    for(const guard of guards)if(!await guard())return false
    return true
  }
  window.electron.ipcRenderer.on('delivery:updated', sessionUpdated)
  window.addEventListener('masspeclib2-admin-logout', logout)
  window.addEventListener('masspeclib2-workspace-restore', restoreWorkspace)
  try { const config = await invokeIPC('delivery:configuration'); edition.value = config.profile?.edition || 'legacy' }
  catch (e) { startupError.value = String(e); edition.value = 'error' }
})
onUnmounted(() => { delete (window as any).masspecConfirmClose; window.electron.ipcRenderer.removeListener('delivery:updated', sessionUpdated); window.removeEventListener('masspeclib2-admin-logout', logout); window.removeEventListener('masspeclib2-workspace-restore', restoreWorkspace) })
</script>
<template>
  <div v-if="edition === 'loading'" style="padding:40px">正在启动…</div>
  <section v-else-if="edition === 'error'" style="padding:40px"><h2>软件配置读取失败</h2><p>{{ startupError }}</p><p>请检查安装包配置后重新启动软件。</p></section>
  <template v-else-if="edition === 'admin'">
    <AdminLogin v-if="!adminReady" @ready="adminReady = true" />
    <template v-else>
      <div v-show="!deliveryOpen"><LegacyApp :key="workspaceInstance" :delivery-available="true" @delivery="openDelivery" /></div>
      <DeliveryApp v-if="deliveryVisited" v-show="deliveryOpen" @legacy="deliveryOpen = false" />
    </template>
  </template>
  <DeliveryApp v-else-if="edition === 'customer'" />
  <LegacyApp v-else />
</template>
