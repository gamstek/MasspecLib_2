<script setup lang="ts">
import { invokeIPC } from './utils/ipcInvoke'
import { ref, onMounted, onUnmounted } from 'vue'
import { notifyDataChanged } from './utils/scopedIPC'
import Layout from './views/layout/Layout.vue'
import ConnectionManager from './components/ConnectionManager.vue'
import DatabaseSetup from './components/DatabaseSetup.vue'
import SharedServerConfig from './components/SharedServerConfig.vue'
defineProps<{ deliveryAvailable?: boolean }>()
const emit = defineEmits<{ delivery: [] }>()
const ready = ref(false), checking = ref(true), connecting = ref(false)
const database = ref(''), exists = ref(false), error = ref('')
let revision = -1, checkGeneration = 0
function login(): void { window.dispatchEvent(new Event('masspeclib2-configure-shared-server')) }
function close(): void { window.electron.ipcRenderer.send('window-close') }
async function check(): Promise<void> {
  const own = ++checkGeneration
  if (!ready.value) checking.value = true
  try {
    const shared = await invokeIPC('shared:status')
    if (own !== checkGeneration) return
    if (shared?.enabled) {
      connecting.value = !!shared.connecting
      // Keep the mounted workspace during a successful catalog sync or a candidate login.
      if (shared.connecting) { error.value = ''; return }
      if (shared.connected) { ready.value = true; error.value = ''; revision = shared.revision ?? 0; return }
      // Keep mounted editors while the connection recovers.
      error.value = shared.connecting ? '' : shared.error || '请登录服务器'
      return
    }
    const connections = await invokeIPC('connections:list')
    for (const entry of connections.filter((item: { enabled: boolean }) => item.enabled)) {
      const first = await invokeIPC('connections:test', entry.id)
      if (own !== checkGeneration) return
      if (first.ok) { ready.value = true; error.value = ''; return }
    }
    const status = await invokeIPC('database:status')
    if (own !== checkGeneration) return
    if (!status.ok) { error.value = status.detail ?? status.message; return }
    error.value = ''; database.value = status.database; exists.value = status.databaseExists; ready.value = status.initialized
  } catch (cause) { if (own === checkGeneration) error.value = String(cause) }
  finally { if (own === checkGeneration) checking.value = false }
}
function sharedUpdated(_event: unknown, value: any): void {
  const changed = value?.connected && !value.connecting && revision !== (value.revision ?? 0)
  if (changed) { revision = value.revision ?? 0; notifyDataChanged() }
  void check()
}
onMounted(() => { window.electron.ipcRenderer.on('shared:updated', sharedUpdated); void check() })
onUnmounted(() => window.electron.ipcRenderer.removeListener('shared:updated', sharedUpdated))
</script>
<template>
  <Layout v-if="ready" :delivery-available="deliveryAvailable" @delivery="emit('delivery')" />
  <div v-else class="startup-page">
    <header><strong>MasspecLib2</strong><div><el-button v-if="deliveryAvailable" @click="emit('delivery')">客户交付管理</el-button><el-button @click="close">关闭软件</el-button></div></header>
    <div v-if="checking || connecting">{{ connecting ? '正在恢复服务器登录，请稍候…' : '正在检测数据库…' }}</div>
    <div v-else-if="error">
      <el-alert :title="error" type="info" :closable="false" />
      <p><el-button type="primary" @click="login">服务器登录</el-button><ConnectionManager :manage-server-libraries="deliveryAvailable" /><el-button @click="check">重新检测</el-button></p>
    </div>
    <DatabaseSetup v-else :database="database" :exists="exists" @ready="check" />
  </div>
  <SharedServerConfig />
</template>
<style scoped>
.startup-page { min-height: 100vh; padding: 24px 48px; box-sizing: border-box; }
.startup-page header { -webkit-app-region: drag; display: flex; align-items: center; justify-content: space-between; margin-bottom: 48px; }
.startup-page header :deep(button) { -webkit-app-region: no-drag; }
</style>
