<script setup lang="ts">
import {ref,onMounted,onUnmounted} from 'vue'
import {onBeforeRouteLeave} from 'vue-router'
import {ElMessage,ElMessageBox} from 'element-plus'
import {invokeIPC} from '../utils/ipcInvoke'
const props=defineProps<{record:Record<string,any>;recordRef:Record<string,any>}>(),emit=defineEmits<{saved:[]}>()
const visible=ref(false),busy=ref(false),draft=ref<Record<string,any>>({})
let original=''
const serialize=():string=>JSON.stringify(Object.fromEntries(Object.entries(draft.value).map(([k,v])=>[k,v??null])))
async function confirmDiscard():Promise<boolean>{if(!visible.value)return true;if(busy.value)return false;if(serialize()===original)return true;try{await ElMessageBox.confirm('是否放弃未保存的基本信息修改？','存在未保存修改',{confirmButtonText:'是',cancelButtonText:'否'});return true}catch{return false}}
async function close(done:()=>void):Promise<void>{if(await confirmDiscard())done()}
function closeGuard(event:Event):void{if(visible.value)(event as CustomEvent).detail.push(confirmDiscard)}
onMounted(()=>window.addEventListener('masspeclib2-before-close',closeGuard));onUnmounted(()=>window.removeEventListener('masspeclib2-before-close',closeGuard));onBeforeRouteLeave(confirmDiscard)
const textFields=[['main_name','主显示名称'],['name_zh','中文名称'],['name_en','英文名称'],['cas','CAS号'],['formula','分子式']]
function open():void{draft.value=Object.fromEntries([...textFields.map(f=>f[0]),'molecular_mass','monoisotopic_mass'].map(k=>[k,props.record[k]??null]));original=serialize();visible.value=true}
async function save():Promise<void>{busy.value=true;try{await invokeIPC('file-library:update-compound',{ref:props.recordRef,revision:props.record.fileRevision,compound:draft.value});visible.value=false;emit('saved');ElMessage.success('已保存草稿，点击发布后其他管理员才能看到')}catch(e){ElMessage.error(String(e))}finally{busy.value=false}}
</script>
<template>
 <el-button @click="open">编辑基本信息</el-button>
 <el-dialog v-model="visible" title="编辑化合物基本信息" width="min(660px,94vw)" append-to-body :before-close="close" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy">
  <p>保存为当前账号在本机的草稿，点击发布后才更新共享数据。谱图、方法及原始分类保持完整。</p>
  <el-form label-width="120px" :disabled="busy"><el-form-item v-for="f in textFields" :key="f[0]" :label="f[1]"><el-input v-model="draft[f[0]]" :maxlength="f[0]==='formula'?1000:255" /></el-form-item><el-form-item v-for="f in [['molecular_mass','分子量'],['monoisotopic_mass','单同位素质量']]" :key="f[0]" :label="f[1]"><el-input-number v-model="draft[f[0]]" :min="0" :controls="false" /></el-form-item></el-form>
  <template #footer><el-button :disabled="busy" @click="close(()=>visible=false)">取消</el-button><el-button type="primary" :loading="busy" :disabled="!draft.main_name?.trim()" @click="save">保存草稿</el-button></template>
 </el-dialog>
</template>
