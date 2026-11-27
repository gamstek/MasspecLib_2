<!-- eslint-disable @typescript-eslint/no-explicit-any -->
<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { useECharts } from '@renderer/utils/echarts'
import * as echarts from 'echarts'
import type { SpectrumPoint } from '@renderer/type'

const props = defineProps<{
  spectrumData: SpectrumPoint[]
  height?: string
  intensityLabel?: string
  showLabelThreshold?: number // 显示标签的强度阈值比例，默认 0.15（前15%）
}>()

const chartRef = ref<HTMLElement | null>(null)
let chartInstance: echarts.ECharts | null = null
let disposeChart: (() => void) | null = null

const heightStyle = computed(() => props.height || '500px')
const threshold = computed(() => props.showLabelThreshold ?? 0.15)

// 计算最高强度，用于动态显示标签
const maxIntensity = computed(() => {
  return props.spectrumData.reduce((max, point) => Math.max(max, point.intensity), 1)
})
const xRange = computed(() => {
  if (!props.spectrumData.length) return { min: 0, max: 100 }
  const dataMin = props.spectrumData.reduce((min, point) => Math.min(min, point.mz), Infinity)
  const dataMax = props.spectrumData.reduce((max, point) => Math.max(max, point.mz), -Infinity)
  const padding = Math.max((dataMax - dataMin) * 0.04, 2)
  return {
    min: Math.max(0, Math.floor(dataMin - padding)),
    max: Math.ceil(dataMax + padding)
  }
})

const getOption = () => ({
  backgroundColor: '#fff',
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: 'cross' },
    confine: true,
    formatter: (params: any) => {
      const p = params[0]
      if (!p) return ''
      return `
        <strong>m/z:</strong> ${p.data[0].toFixed(4)}<br/>
        <strong>${props.intensityLabel || 'Intensity'}:</strong> ${p.data[1].toLocaleString()}
      `
    }
  },
  toolbox: {
    left: 'right',
    itemSize: 14,
    top: 0,
    feature: {
      dataZoom: {
        yAxisIndex: 'none'
      },
      restore: {}
    }
  },
  grid: {
    left: 70,
    right: 50,
    top: 50,
    bottom: 80
  },
  xAxis: {
    type: 'value' as const,
    name: 'm/z',
    nameLocation: 'middle' as const,
    nameGap: 30,
    min: xRange.value.min,
    max: xRange.value.max,
    axisLabel: {
      fontSize: 12,
      color: '#333'
    }
  },
  yAxis: {
    type: 'value' as const,
    name: props.intensityLabel || 'Intensity',
    nameLocation: 'middle' as const,
    nameGap: 50,
    nameRotate: 90,
    axisLabel: {
      fontSize: 11,
      formatter: (value: number) => {
        if (value >= 1e6) return `${(value / 1e6).toFixed(1)}e6`
        if (value >= 1e5) return `${(value / 1e5).toFixed(1)}e5`
        if (value >= 1e4) return `${(value / 1e3).toFixed(0)}e3`
        return value.toFixed(0)
      }
    }
  },
  dataZoom: [
    {
      type: 'inside'
    }
  ],
  series: [
    {
      type: 'bar' as const,
      name: 'Mass Spectrum',
      barWidth: 1,
      itemStyle: {
        color: '#ff7701',
        borderColor: '#ff7701'
      },
      emphasis: {
        focus: 'series' as const
      },
      data: props.spectrumData.map((p) => [p.mz, p.intensity]),
      label: {
        show: true,
        position: 'top' as const,
        fontSize: 10,
        color: '#d4380d',
        fontWeight: 'bold' as const,
        formatter: (param: any) => {
          const intensity = param.data[1] as number
          if (intensity > maxIntensity.value * threshold.value) {
            return param.data[0].toFixed(2)
          }
          return ''
        }
      }
    }
  ]
})

const resizeChart = () => {
  if (chartInstance) {
    // 关键：强制让 ECharts 重新计算容器大小
    chartInstance.resize()
  }
}

onMounted(() => {
  if (chartRef.value) {
    const { chart, dispose } = useECharts(chartRef.value)
    chartInstance = chart
    disposeChart = dispose
    chart.setOption(getOption())
  }
})

watch(
  () => props.spectrumData,
  () => {
    if (chartInstance) {
      chartInstance.setOption(getOption(), true)
    }
  },
  { deep: true }
)

onUnmounted(() => {
  disposeChart?.()
})

defineExpose({
  resize: resizeChart
})
</script>

<template>
  <div class="test" ref="chartRef" :style="{ width: '100%', height: heightStyle }" />
</template>

<style scoped>
/* 可选：让图表容器支持响应式 */
:deep(.echarts) {
  width: 100% !important;
}
</style>
