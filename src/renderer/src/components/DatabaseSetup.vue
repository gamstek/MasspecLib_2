<script setup lang="ts">
import { invokeIPC } from '../utils/ipcInvoke'

import { ref } from 'vue'
import { ElMessage } from 'element-plus'
const props = defineProps<{ database: string; exists: boolean }>()
const emit = defineEmits<{ ready: [] }>()
const busy = ref(false)
const error = ref('')
async function initialize(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const result = await invokeIPC('database:initialize')
    if (result.cancelled) return
    if (!result.ok) {
      error.value = result.detail ?? result.message
      return
    }
    ElMessage.success('MasspecLib2 新库初始化完成')
    emit('ready')
  } catch (cause) {
    error.value = String(cause)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <main style="padding: 48px; max-width: 800px; margin: auto">
    <h1>MasspecLib2</h1>
    <p>目标数据库：{{ props.database }}</p>
    <p v-if="!props.exists">请先由管理员创建此空的新库并授予必要权限，再重新检测。</p>
    <p v-else>请选择新版初始化 SQL；同目录须包含对应的 .manifest.json 文件。</p>
    <p>初始化只适用于空的新库。日常追加使用导入化合物。</p>
    <el-button type="primary" :loading="busy" :disabled="!props.exists" @click="initialize"
      >初始化化合物</el-button
    >
    <el-button @click="emit('ready')">重新检测</el-button>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      style="margin-top: 20px; white-space: pre-wrap"
    />
  </main>
</template>
