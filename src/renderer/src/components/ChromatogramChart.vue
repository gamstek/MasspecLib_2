<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { ECharts, EChartsOption } from 'echarts'
import { useECharts } from '../utils/echarts'
import { traceMinutes } from '../../../shared/analysis/engine'
import type { Trace, TracePoint, PeakCheck } from '../../../shared/analysis/types'
const props = defineProps<{
  trace?: Trace
  qualifierTrace?: Trace
  qualifiers?: { channel: string; trace?: Trace }[]
  peak: PeakCheck
}>()
const element = ref<HTMLElement>()
let chart: ECharts | undefined
let dispose: (() => void) | undefined
// Keep extrema per time-ordered bucket. Analysis always uses all acquired points.
function displayPoints(points: TracePoint[]): number[][] {
  if (points.length <= 5000) return points.map((p) => [p.time, p.intensity])
  const output: TracePoint[] = [points[0]]
  const width = Math.ceil((points.length - 2) / 2400)
  for (let start = 1; start < points.length - 1; start += width) {
    let min = start,
      max = start
    for (let i = start; i < Math.min(points.length - 1, start + width); i++) {
      if (points[i].intensity < points[min].intensity) min = i
      if (points[i].intensity > points[max].intensity) max = i
    }
    for (const i of [...new Set([min, max])].sort((a, b) => a - b)) output.push(points[i])
  }
  output.push(points[points.length - 1])
  return output.map((p) => [p.time, p.intensity])
}
function render(): void {
  if (!chart) return
  const p = props.peak
  const lines = [
    p.apexTime == null ? null : { xAxis: p.apexTime, name: '峰顶' },
    p.start == null ? null : { xAxis: p.start, name: '窗口开始' },
    p.end == null ? null : { xAxis: p.end, name: '窗口结束' }
  ].filter(Boolean)
  const series: EChartsOption['series'] = [
    {
      name: '定量通道',
      type: 'line',
      showSymbol: false,
      data: displayPoints(traceMinutes(props.trace)),
      lineStyle: { width: 1.6 },
      markLine: { symbol: 'none', data: lines as never[] }
    }
  ]
  if (props.qualifierTrace?.points.length)
    series.push({
      name: '定性通道',
      type: 'line',
      showSymbol: false,
      data: displayPoints(traceMinutes(props.qualifierTrace)),
      lineStyle: { width: 1.5 }
    })
  for (const q of props.qualifiers ?? [])
    if (q.trace?.points.length)
      series.push({
        name: '定性 ' + q.channel,
        type: 'line',
        showSymbol: false,
        data: displayPoints(traceMinutes(q.trace)),
        lineStyle: { width: 1.5 }
      })
  if (p.start !== null && p.end !== null && p.baselineStart !== null && p.baselineEnd !== null)
    series.push({
      name: '估计基线',
      type: 'line',
      showSymbol: false,
      data: [
        [p.start, p.baselineStart],
        [p.end, p.baselineEnd]
      ],
      lineStyle: { type: 'dashed', width: 1, color: '#8c929b' }
    })
  chart.setOption(
    {
      animation: false,
      tooltip: { trigger: 'axis', renderMode: 'richText', confine: true },
      legend: { top: 8 },
      grid: { left: 80, right: 25, top: 55, bottom: 80 },
      xAxis: { type: 'value', name: '时间 (min)', nameLocation: 'middle', nameGap: 30 },
      yAxis: { type: 'value', name: '信号强度', scale: true },
      dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8 }],
      series
    } as EChartsOption,
    true
  )
}
function update(): void {
  if (!element.value) {
    dispose?.()
    chart = undefined
    dispose = undefined
    return
  }
  if (!chart) {
    const instance = useECharts(element.value)
    chart = instance.chart
    dispose = instance.dispose
  }
  render()
}
onMounted(update)
watch(() => [props.trace, props.qualifierTrace, props.qualifiers, props.peak], update, {
  deep: true,
  flush: 'post'
})
onUnmounted(() => dispose?.())
</script>
<template>
  <div
    v-if="
      trace?.points.length ||
      qualifierTrace?.points.length ||
      qualifiers?.some((q) => q.trace?.points.length)
    "
    ref="element"
    class="chromatogram"
    aria-label="色谱时间—强度曲线"
  />
  <el-empty v-else description="没有色谱曲线；其他结果检查仍可查看" />
</template>
<style scoped>
.chromatogram {
  height: 370px;
  width: 100%;
}
</style>
