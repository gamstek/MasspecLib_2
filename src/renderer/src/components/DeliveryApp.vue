<script setup lang="ts">
import { ref, markRaw, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
import DeliveryAdmin from './DeliveryAdmin.vue'
import DeliveryCustomer from './DeliveryCustomer.vue'
import DeliveryPersonal from './DeliveryPersonal.vue'
const personalOnly = ref(false), localLoginOpen = ref(false), protectedOffline = ref<any>()
const emit = defineEmits<{ legacy: [] }>()
const session = ref<any>({}), checking = ref(true), busy = ref(false), error = ref(''), offline = ref<any>(), username = ref(''), password = ref(''), endpoint = ref(''), fingerprint = ref(''), keepSignedIn = ref(true), advanced = ref<string[]>([])
let mounted = true
async function status(): Promise<void> { try { const s = await invokeIPC('delivery:configuration'); if (mounted) { session.value = s; if (!username.value && s.profile?.loginUsername) username.value = s.profile.loginUsername; if (s.restoreError) error.value = s.restoreError; if (!endpoint.value) endpoint.value = s.endpoint; if (!fingerprint.value) fingerprint.value = s.fingerprint } } catch (e) { error.value = String(e) } finally { checking.value = false } }
async function restore(): Promise<void> { busy.value = true; error.value = ''; try { session.value = await invokeIPC('delivery:restore'); if (!session.value.connected) error.value = session.value.restoreError || '未能恢复登录，请检查服务器连接' } catch (e) { error.value = String(e) } finally { busy.value = false } }
async function login(): Promise<void> {
  if (busy.value) return; busy.value = true; error.value = ''
  try { const result = await invokeIPC('delivery:login', { endpoint: endpoint.value, fingerprint: fingerprint.value, username: username.value, password: password.value, keepSignedIn: keepSignedIn.value }); password.value = ''; offline.value = undefined; session.value = result; if (result.storageUnavailable) ElMessage.warning('系统安全存储不可用，本次登录不会保存到磁盘') }
  catch (e) { error.value = String(e) } finally { busy.value = false }
}
async function logout(): Promise<void> {
  try { await ElMessageBox.confirm('退出当前账号，并清除本机自动登录凭据？', '退出登录'); busy.value = true; const result = await invokeIPC('delivery:logout'); offline.value = undefined; await status(); if (!result.serverRevoked) ElMessage.warning('本机已退出，服务器暂未确认会话撤销；可由管理员停用账号使会话失效') }
  catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) } finally { busy.value = false }
}
async function localLogin(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { offline.value = markRaw(await invokeIPC('delivery:offline-login', { username: username.value, password: password.value })); password.value = ''; localLoginOpen.value = false }
  catch(e) { error.value = String(e) } finally { busy.value = false }
}
async function localLogout(): Promise<void> { await invokeIPC('delivery:offline-logout'); offline.value = undefined; localLoginOpen.value = true; password.value = ''; error.value = '' }
async function localEntry(): Promise<void> { if (protectedOffline.value) { localLoginOpen.value = true; error.value = '' } else if (session.value.profile?.accessMode === 'offline') { localLoginOpen.value = true; error.value = '安装包内置数据缺失或格式不完整，请联系管理员重新生成安装包。' } else await openOffline(false) }
async function initializeOffline(): Promise<void> {
  try { const result = await invokeIPC('delivery:offline-status'); if (result.protected) { protectedOffline.value = result; username.value = result.username; localLoginOpen.value = true } else if (session.value.profile?.accessMode === 'offline') { localLoginOpen.value = true; error.value = '安装包内置数据缺失或格式不完整，请联系管理员重新生成安装包。' } else await openOffline(false) }
  catch(e) { error.value = String(e); localLoginOpen.value = session.value.profile?.accessMode === 'offline' }
}
async function openOffline(choose = false): Promise<void> { try { const result = await invokeIPC('delivery:offline', choose); if (result) offline.value = result; else if (!choose) error.value = '安装包未附带本地数据，请选择管理员提供的交付文件，或连接在线数据' } catch (e) { error.value = String(e); ElMessage.error(String(e)) } }
async function changePassword(): Promise<void> {
  try { const old = await ElMessageBox.prompt('输入当前软件账号密码', '修改密码', { inputType: 'password' }); const next = await ElMessageBox.prompt('输入10–128位新密码；修改后需要重新登录。', '设置新密码', { inputType: 'password', inputValidator: v => typeof v === 'string' && v.length >= 10 && v.length <= 128 || '密码需要10–128位' }); await invokeIPC('delivery:call', 'POST', '/password', { current: old.value, password: next.value }); await invokeIPC('delivery:logout'); await status(); ElMessage.success('密码已修改，请重新登录') }
  catch (e) { if (e !== 'cancel' && e !== 'close') ElMessage.error(String(e)) }
}
function updated(): void { void status() }
function minimize(): void { window.electron.ipcRenderer.send('window-minimize') }
function maximize(): void { window.electron.ipcRenderer.send('window-toggle-maximize') }
function close(): void { window.electron.ipcRenderer.send('window-close') }
onMounted(async () => { window.electron.ipcRenderer.on('delivery:updated', updated); await status(); if (session.value.profile?.edition === 'customer' && session.value.profile?.allowOffline) await initializeOffline() })
onUnmounted(() => { mounted = false; window.electron.ipcRenderer.removeListener('delivery:updated', updated) })
</script>
<template>
  <div class="delivery-app">
    <header class="delivery-titlebar"><div class="delivery-brand"><span class="brand-mark">M</span><div><strong>MasspecLib2</strong><small>{{ session.profile?.edition === 'admin' ? '客户交付工作台 · 管理员端' : '科学数据工作台 · 客户端' }}</small></div></div><div><span v-if="offline">本地交付数据</span><span v-else-if="session.user" class="account-status"><i />{{ session.user.username }}</span><el-button v-if="session.profile?.edition === 'admin'" text @click="emit('legacy')">返回数据库工作台</el-button><el-button v-if="session.connected" text :disabled="busy" @click="changePassword">修改密码</el-button><el-button v-if="session.connected" text :disabled="busy" @click="logout">退出登录</el-button><el-button v-if="offline && protectedOffline" text @click="localLogout">退出登录</el-button><el-button v-if="offline && session.profile?.accessMode !== 'offline'" text @click="offline = undefined; localLoginOpen = false">连接在线数据</el-button><div class="window-actions"><el-button text title="最小化" aria-label="最小化" @click="minimize">—</el-button><el-button text title="最大化／还原" aria-label="最大化" @click="maximize">□</el-button><el-button text title="关闭" aria-label="关闭" @click="close">×</el-button></div></div></header>
    <section v-if="personalOnly" class="personal-only"><el-button class="personal-return" @click="personalOnly = false">返回交付数据／连接页面</el-button><DeliveryPersonal :can-export="true" /></section>
    <DeliveryCustomer v-else-if="offline" :key="`offline:${offline.manifest.id}`" :session="session" :offline="offline" />
    <div v-else-if="localLoginOpen" class="delivery-login local-login"><el-card><h1>{{ session.profile?.customerName || '客户登录' }}</h1><p>请输入管理员提供的账号和密码。</p><el-alert v-if="error" :title="error" type="error" :closable="false" /><el-form label-position="top" @submit.prevent="localLogin"><el-form-item label="账号"><el-input v-model="username" autocomplete="username" :disabled="busy" /></el-form-item><el-form-item label="密码"><el-input v-model="password" type="password" show-password autocomplete="current-password" :disabled="busy" @keyup.enter="localLogin" /></el-form-item><el-button class="login-button" type="primary" :loading="busy" :disabled="!username || !password" @click="localLogin">登录</el-button></el-form></el-card></div>
    <DeliveryAdmin v-else-if="session.connected && session.user?.role === 'admin'" :key="session.user.id" />
    <DeliveryCustomer v-else-if="session.connected && session.user?.role === 'customer'" :key="session.user.id" :session="session" />
    <div v-else-if="checking || session.restoring" class="delivery-login">正在恢复服务器登录，请稍候…</div>
    <div v-else-if="session.profile?.edition === 'customer' && session.profile?.accessMode === 'offline'" class="delivery-login"><el-card><h1>客户登录</h1><el-alert :title="error || '正在读取安装包内置数据'" type="error" :closable="false" /><el-button :loading="busy" @click="initializeOffline">重新读取</el-button></el-card></div>
    <div v-else class="delivery-login"><el-card><h1>{{ session.profile?.edition === 'admin' ? '管理员登录' : session.profile?.customerName || '客户登录' }}</h1><p>登录后加载当前账号获授权的数据。</p><el-alert v-if="error" :title="error" type="error" :closable="false" /><el-button v-if="session.savedLogin" :loading="busy" @click="restore">恢复上次登录</el-button><el-form label-position="top" @submit.prevent="login"><p v-if="session.profile?.gateway">通过服务器 {{ session.profile.gateway.port }} 端口的专用加密通道访问，无需填写SSH管理员账号。</p><el-form-item label="服务器地址"><el-input v-model="endpoint" placeholder="https://服务器地址:8443" :disabled="busy" /></el-form-item><el-form-item label="软件账号"><el-input v-model="username" autocomplete="username" :disabled="busy" /></el-form-item><el-form-item label="密码"><el-input v-model="password" type="password" show-password autocomplete="current-password" :disabled="busy" @keyup.enter="login" /></el-form-item><el-checkbox v-model="keepSignedIn">保持登录，下次启动自动连接</el-checkbox><el-collapse v-model="advanced"><el-collapse-item title="服务器身份配置" name="identity"><p>证书指纹由管理员提供。更换服务器时请核对指纹。</p><el-input v-model="fingerprint" type="textarea" :rows="2" placeholder="SHA-256证书指纹" /></el-collapse-item></el-collapse><el-button class="login-button" type="primary" :loading="busy || checking" :disabled="!username || !password || !endpoint || !fingerprint" @click="login">登录</el-button></el-form><div v-if="session.profile?.edition === 'customer'" class="offline-actions"><el-button text @click="personalOnly = true">打开我的数据</el-button><el-button v-if="session.profile?.accessMode !== 'online'" text @click="localEntry">打开内置数据</el-button><el-button v-if="session.profile?.accessMode !== 'online' && !protectedOffline" text @click="openOffline(true)">打开离线交付文件</el-button></div></el-card></div>
  </div>
</template>
<style scoped>
.delivery-app { height: 100vh; display: flex; flex-direction: column; color: #26374b; background: white; overflow: hidden; }.delivery-titlebar { height: 54px; min-height: 54px; display: flex; align-items: center; justify-content: space-between; background: #fff; border-bottom: 1px solid #e1e8f1; padding: 0 20px; -webkit-app-region: drag; gap: 14px; }.delivery-titlebar > div { -webkit-app-region: no-drag; display: flex; align-items: center; }.delivery-titlebar span { margin-right: 12px; }.delivery-login { flex: 1; overflow: auto; display: grid; place-items: center; background: #f4f7fb; padding: 32px; }.delivery-login .el-card { width: min(460px, 100%); }.delivery-login h1 { font-size: 25px; margin: 8px 0 12px; }.delivery-login p { color: #738197; line-height: 1.6; }.login-button { width: 100%; margin-top: 18px; }.delivery-login .el-collapse { margin-top: 12px; }.offline-actions { display: flex; justify-content: space-between; margin-top: 16px; }
.delivery-brand { gap: 12px; }.brand-mark { width: 36px; height: 36px; margin: 0 !important; border-radius: 10px; background: #2878dc; color: white; display: grid; place-items: center; font-size: 24px; font-weight: 700; }.delivery-brand strong { display: block; font-size: 19px; letter-spacing: .2px; }.delivery-brand small { display: block; font-size: 11px; color: #8090a4; margin-top: 3px; }.delivery-brand,.delivery-brand > div { -webkit-app-region: drag !important; }.account-status { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; background: #f2f7fc; border-radius: 18px; padding: 7px 12px; }.account-status i { background: #36aa7d; width: 7px; height: 7px; border-radius: 50%; }.window-actions { display: flex; border-left: 1px solid #e4eaf1; margin-left: 8px; padding-left: 8px; }.window-actions .el-button { width: 34px; margin: 0; font-size: 20px; }.window-actions .el-button:last-child:hover { background: #fce8e8; color: #cf4141; }@media(max-width:1000px) { .delivery-titlebar { padding: 0 12px; }.delivery-titlebar :deep(.el-button) { padding: 8px; }.delivery-brand small { display: none; }.account-status { max-width: 120px; overflow: hidden; } }

.delivery-titlebar { border-color:#e2e9f2;padding:0 18px; }.delivery-brand { gap:10px; }.delivery-brand strong { font-size:18px;font-weight:600; }.delivery-brand small { font-size:10px; }.brand-mark { width:32px;height:32px;border-radius:8px;font-size:23px;background:#2f6fe4; }
.delivery-titlebar :deep(.el-button) { font-size:12px; }.delivery-titlebar > div > span:not(.brand-mark) { font-size:12px;color:#718197; }.window-actions .el-button { font-size:19px; }
.delivery-login .el-card { width:min(440px,100%);border-radius:12px;border-color:#e1e8f1;box-shadow:0 8px 28px #1d3f6b0a; }.delivery-login h1 { font-size:22px;font-weight:600; }.delivery-login p { font-size:12px; }.delivery-login :deep(.el-card__body) { padding:26px; }

.personal-only { display:flex;flex:1;min-height:0;flex-direction:column;padding:16px 24px;gap:12px; }.personal-return { align-self:flex-start; }.offline-actions { flex-wrap:wrap;gap:6px; }
</style>
