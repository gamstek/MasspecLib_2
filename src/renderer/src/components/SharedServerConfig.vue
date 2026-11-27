<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { invokeIPC } from '../utils/ipcInvoke'
const visible = ref(false), busy = ref(false)
const form = ref<any>({ host: '', port: 2222, username: 'root', auth: 'password', password: '', keyFile: '', passphrase: '', rememberPassword: false, keepSignedIn: true, useSavedPassword: false })
async function open(): Promise<void> {
  try {
    const value = await invokeIPC('shared:configuration')
    if (!value.enabled || value.mode !== 'ssh') return
    form.value = { ...value, rememberPassword: false, password: '', passphrase: '' }
    visible.value = true
  } catch (error) { ElMessage.error(String(error)) }
}
async function chooseKey(): Promise<void> {
  const files = await invokeIPC('dialog:openFile', { title: '选择OpenSSH或PEM私钥', properties: ['openFile'], filters: [{ name: 'SSH私钥', extensions: ['*'] }] })
  if (files?.[0]) form.value.keyFile = files[0]
}
async function connect(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    let response = await invokeIPC('shared:configure', form.value)
    if (response.needsTrust) {
      await ElMessageBox.confirm(
        `${response.changed ? '服务器身份与之前不同，请核对后再连接。' : '首次连接此服务器，请核对服务器身份。'}\n${response.fingerprint}`,
        '确认服务器身份', { type: 'warning', confirmButtonText: '信任并连接', cancelButtonText: '取消' }
      )
      response = await invokeIPC('shared:configure', { ...form.value, approvedFingerprint: response.fingerprint })
    }
    if (!response.connected) throw new Error('服务器连接未完成，请重试')
    visible.value = false
    form.value.password = ''; form.value.passphrase = ''
    ElMessage.success(`已连接服务器，发现${response.libraries}个共享数据库`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  } finally { busy.value = false }
}
function disconnected(_event: unknown, value: any): void {
  // Connection settings open only through the explicit SSH configuration entry.
  void value
}
onMounted(() => {

  window.addEventListener('masspeclib2-configure-shared-server', open)
  window.electron.ipcRenderer.on('shared:updated', disconnected)
})
onUnmounted(() => {
  window.removeEventListener('masspeclib2-configure-shared-server', open)
  window.electron.ipcRenderer.removeListener('shared:updated', disconnected)
})
</script>
<template>
  <el-dialog v-model="visible" title="SSH 配置" width="560px" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" append-to-body>
    <p>默认使用已配置的服务器连接；需要更换服务器或认证方式时在此修改。连接成功后，软件会加载服务器中的共享数据库，并自动发现新库。</p>
    <el-form label-width="110px" :disabled="busy" @submit.prevent="connect">
      <el-form-item label="服务器地址"><el-input v-model="form.host" placeholder="例如 192.168.3.92" /></el-form-item>
      <el-form-item label="SSH端口"><el-input-number v-model="form.port" :min="1" :max="65535" /></el-form-item>
      <el-form-item label="SSH账号"><el-input v-model="form.username" autocomplete="username" /></el-form-item>
      <el-form-item label="登录方式"><el-select v-model="form.auth"><el-option label="密码" value="password" /><el-option label="私钥" value="key" /></el-select></el-form-item>
      <template v-if="form.auth === 'password'">
        <el-form-item v-if="form.hasPassword"><el-checkbox v-model="form.useSavedPassword">使用已保存密码（取消勾选可留空登录）</el-checkbox></el-form-item>
        <el-form-item label="SSH密码"><el-input v-model="form.password" type="password" show-password :disabled="form.useSavedPassword" :placeholder="form.useSavedPassword ? '使用已保存密码' : '可留空，由服务器验证'" autocomplete="current-password" @keyup.enter="connect" /></el-form-item>
      </template>
      <template v-else>
        <el-form-item label="私钥文件"><el-input v-model="form.keyFile" placeholder="OpenSSH或PEM格式"><template #append><el-button @click="chooseKey">选择</el-button></template></el-input></el-form-item>
        <el-form-item label="私钥口令"><el-input v-model="form.passphrase" type="password" show-password :placeholder="form.hasPassphrase ? '已保存；留空使用原口令' : '未加密的私钥可留空'" /></el-form-item>
      </template>
      <el-form-item><el-checkbox v-model="form.keepSignedIn">保持登录，下次打开自动连接</el-checkbox></el-form-item>
      <p>保持登录时，密码或私钥口令使用系统加密保存。密码可留空提交，由服务器决定是否接受；私钥文件需保留在本机。</p>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="visible = false">取消</el-button><el-button type="primary" :loading="busy" @click="connect">连接服务器</el-button></template>
  </el-dialog>
</template>
