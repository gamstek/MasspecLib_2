<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RecordData } from '../../../shared/dataPackage'
const props = defineProps<{ sources: RecordData[] }>()
const selected = ref<RecordData | null>(null)
const visible = ref(false)
const entries = computed(() => {
  const map = new Map<string, RecordData>()
  for (const source of props.sources ?? []) {
    const library = source.source_record?.library ?? source
    const key = JSON.stringify([
      library.namespace,
      library.name,
      library.provider,
      library.location
    ])
    const old = map.get(key)
    if (old) {
      old.appliesTo = [...new Set([...(old.appliesTo ?? []), source.appliesTo ?? '化合物'])]
      old.evidence.push(source)
    } else
      map.set(key, { ...library, appliesTo: [source.appliesTo ?? '化合物'], evidence: [source] })
  }
  return [...map.values()]
})
const types = { public: '公共库', local: '本地库', unknown: '未知' }
function open(item: RecordData): void {
  selected.value = item
  visible.value = true
}
</script>
<template>
  <span v-if="!entries.length">来源未提供</span>
  <el-tag
    v-for="(item, index) in entries"
    :key="index"
    style="margin: 3px; cursor: pointer"
    @click.stop="open(item)"
    >{{ item.name }}</el-tag
  >
  <el-dialog v-model="visible" title="数据来源" width="620px" append-to-body>
    <el-descriptions v-if="selected" :column="1" border>
      <el-descriptions-item label="来源名称">{{ selected.name }}</el-descriptions-item>
      <el-descriptions-item label="来源类型">{{
        types[selected.source_type as keyof typeof types] ?? '未知'
      }}</el-descriptions-item>
      <el-descriptions-item label="提供者">{{
        selected.provider || '未提供'
      }}</el-descriptions-item>
      <el-descriptions-item label="来源位置"
        ><span style="overflow-wrap: anywhere; white-space: pre-wrap; user-select: text">{{
          selected.location || '未提供'
        }}</span></el-descriptions-item
      >
    </el-descriptions>
    <el-collapse v-if="selected" style="margin-top: 16px"
      ><el-collapse-item title="技术追溯信息"
        ><p>关联信息：{{ selected.appliesTo?.join('、') }}</p>
        <pre style="white-space: pre-wrap; overflow-wrap: anywhere">{{
          JSON.stringify(selected.evidence, null, 2)
        }}</pre>
      </el-collapse-item></el-collapse
    >
  </el-dialog>
</template>
