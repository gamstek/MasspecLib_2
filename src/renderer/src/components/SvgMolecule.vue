<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
const props = withDefaults(defineProps<{ svg: string; width?: string; height?: string }>(), {
  width: '150px',
  height: '150px'
})
const sanitized = computed(() =>
  DOMPurify.sanitize(props.svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'image', 'a'],
    FORBID_ATTR: ['href', 'xlink:href']
  })
)
</script>
<template>
  <!-- eslint-disable-next-line vue/no-v-html -- Only the DOMPurify SVG result is rendered. -->
  <div class="molecule" :style="{ width, height }" v-html="sanitized" />
</template>
<style scoped>
.molecule {
  display: flex;
  align-items: center;
  justify-content: center;
}
.molecule :deep(svg) {
  max-width: 100%;
  max-height: 100%;
}
</style>
