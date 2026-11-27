import * as echarts from 'echarts'

export function useECharts(element: HTMLElement): { chart: echarts.ECharts; dispose: () => void } {
  const chart = echarts.getInstanceByDom(element) ?? echarts.init(element)
  const observer = new ResizeObserver(() => {
    if (!chart.isDisposed()) chart.resize()
  })
  observer.observe(element)
  return {
    chart,
    dispose: () => {
      observer.disconnect()
      if (!chart.isDisposed()) chart.dispose()
    }
  }
}
