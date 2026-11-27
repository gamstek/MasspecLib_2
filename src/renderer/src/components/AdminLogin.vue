<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { adminWorkspace } from '../utils/adminWorkspace'
const router = useRouter()
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import SharedServerConfig from './SharedServerConfig.vue'
const emit = defineEmits<{ ready: [] }>()
const username = ref(localStorage.getItem('masspec.admin.username') || 'gamstek'), password = ref(''), busy = ref(false), checking = ref(true), error = ref('')
function configure(): void { window.dispatchEvent(new Event('masspeclib2-configure-shared-server')) }
async function connect(): Promise<void> {
  let result = await invokeIPC('admin:connect')
  if (result.needsTrust) {
    await ElMessageBox.confirm(`请核对服务器指纹后连接：${result.fingerprint}`, '确认服务器身份', { confirmButtonText: '信任并连接', cancelButtonText: '取消' })
    result = await invokeIPC('admin:connect', result.fingerprint)
  }
  if (!result.connected) throw new Error('数据库连接未完成，请检查 SSH 配置后重试')
  const config = await invokeIPC('admin:workspace')
  await router.replace({ path: '/-1', query: { db: config.defaultConnectionId } })
  adminWorkspace.value = config
  if (config.workspaceWarning) ElMessage.warning(config.workspaceWarning)
  emit('ready')
}
async function login(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const session = await invokeIPC('delivery:configuration')
    if (!session.connected || session.user?.username !== username.value.trim()) await invokeIPC('delivery:login', { endpoint: session.endpoint, fingerprint: session.fingerprint, username: username.value.trim(), password: password.value, keepSignedIn: false })
    localStorage.setItem('masspec.admin.username', username.value.trim()); password.value = ''
    await connect()
  } catch(e) { if (e !== 'cancel' && e !== 'close') error.value = String(e) }
  finally { busy.value = false }
}
onMounted(async () => {
  window.electron.ipcRenderer.on('delivery:updated', restored)
  try { const s = await invokeIPC('delivery:configuration'); if (s.connected && s.user?.role === 'admin') { username.value = s.user.username; busy.value = true; await connect() } }
  catch(e) { error.value = String(e) }
  finally { checking.value = false; busy.value = false }
})
async function restored(_event: unknown, session: any): Promise<void> {
  if (!session.connected || session.user?.role !== 'admin' || busy.value) return
  busy.value = true; username.value = session.user.username
  try { await connect() } catch(e) { error.value = String(e) } finally { busy.value = false }
}
onUnmounted(() => window.electron.ipcRenderer.removeListener('delivery:updated', restored))
function send(channel: string): void { window.electron.ipcRenderer.send(channel) }
</script>
<template>
  <section class="admin-entry">
    <header><div class="brand"><span>M</span><strong>MasspecLib2</strong></div><div class="window-actions"><el-button text aria-label="最小化" @click="send('window-minimize')">—</el-button><el-button text aria-label="最大化或还原" @click="send('window-toggle-maximize')">□</el-button><el-button text aria-label="关闭" @click="send('window-close')">×</el-button></div></header>
    <main><el-card class="admin-login-card"><h1>管理员登录</h1><p>登录后进入数据库工作台</p><el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-form label-position="top" @submit.prevent="login"><el-form-item label="账号"><el-input v-model="username" autocomplete="username" :disabled="busy || checking" /></el-form-item><el-form-item label="密码"><el-input v-model="password" type="password" show-password autocomplete="current-password" :disabled="busy || checking" @keyup.enter="login" /></el-form-item><el-button class="login-action" type="primary" :loading="busy || checking" :disabled="!username.trim()" @click="login">登录</el-button></el-form>
      <el-button class="ssh-entry" text :disabled="busy || checking" @click="configure">连接诊断</el-button>
    </el-card></main><SharedServerConfig />
  </section>
</template>
<style scoped>
.admin-entry {height:100dvh;display:flex;flex-direction:column;background:#f4f7fb;color:#25364c}.admin-entry header {display:flex;justify-content:space-between;align-items:center;height:56px;padding:0 20px;background:white;border-bottom:1px solid #e2e9f2;-webkit-app-region:drag}.brand {display:flex;align-items:center;gap:10px;font-size:19px}.brand span {display:grid;place-items:center;background:#2f6fe4;color:white;width:32px;height:32px;border-radius:8px;font-size:24px}.brand strong {font-weight:600}.window-actions {-webkit-app-region:no-drag;display:flex}.window-actions .el-button {margin:0;width:36px}.admin-entry main {flex:1;overflow:auto;display:grid;place-items:center;padding:24px}.admin-login-card {width:min(400px,100%);border:1px solid #e1e8f1;border-radius:12px;box-shadow:0 10px 30px #25364c08}.admin-login-card :deep(.el-card__body) {padding:32px}.admin-login-card h1 {font-size:24px;font-weight:600;margin-bottom:8px}.admin-login-card p {color:#7c8a9d;margin-bottom:24px}.admin-login-card .el-alert {margin-bottom:16px}.login-action {width:100%;margin-top:8px}.ssh-entry {display:block;margin:14px auto 0;font-size:12px}
</style>
