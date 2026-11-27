/* eslint-disable @typescript-eslint/no-explicit-any, vue/one-component-per-file */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vuePlugin from '@vitejs/plugin-vue'
import { createSSRApp, defineComponent, h, provide, inject } from 'vue'
import 'element-plus'
import { renderToString } from '@vue/server-renderer'
import { detectionDemo } from '../src/shared/analysis/demo.ts'
import { normalizeDetectionPackage } from '../src/shared/analysis/input.ts'
import { analysePackage, summarize } from '../src/shared/analysis/engine.ts'
import type { StoredBatch } from '../src/shared/analysis/types.ts'
// Render the actual result page with fixture IPC and desktop controls. Browser/canvas
// interaction is deliberately outside this test; evidence text and data routing are real.
test('actual result template renders abnormal rows, missing data and review evidence', async () => {
  const root = resolve(import.meta.dirname, '..')
  const input = normalizeDetectionPackage(detectionDemo()),
    results = analysePackage(input)
  const batch: StoredBatch = {
    id: 'c23a250b-f641-41e7-bb98-157da35d63aa',
    revision: 1,
    createdAt: new Date().toISOString(),
    sourceName: 'demo.json',
    sourceHash: 'a'.repeat(64),
    engineVersion: '1.0.0',
    input,
    results,
    reviews: []
  }
  const summary = summarize(batch),
    row = input.results[6]
  const savedWindow = (globalThis as any).window,
    savedStorage = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = { getItem: () => null }
  ;(globalThis as any).window = {
    electron: {
      ipcRenderer: {
        invoke: async (channel: string) => {
          if (channel === 'analysis:batches') return { batches: [summary], warnings: [] }
          if (channel === 'analysis:results')
            return {
              summary,
              total: 15,
              rows: results.map((r) => ({
                ...r,
                review: null,
                measurement: input.results.find((item) => item.id === r.id)?.measurement
              }))
            }
          if (channel === 'analysis:detail')
            return {
              summary,
              row,
              result: results[6],
              reviews: [],
              rules: input.peakRules,
              sourceName: batch.sourceName,
              sourceHash: batch.sourceHash,
              engineVersion: batch.engineVersion
            }
          throw new Error('Unexpected IPC: ' + channel)
        }
      }
    }
  }
  const server = await createServer({
    configFile: false,
    root,
    plugins: [
      vuePlugin(),
      {
        name: 'analysis-render-fixture',
        enforce: 'pre',
        async load(id) {
          if (id.endsWith('/ChromatogramChart.vue'))
            return '<template><div>色谱曲线组件位置</div></template>'
          if (id.endsWith('/AnalysisResults.vue'))
            return (await readFile(id, 'utf8')).replace(
              '</script>',
              'await loadBatches(); await openDetail(rows.value[6]);\n</script>'
            )
        }
      }
    ],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    appType: 'custom'
  })
  try {
    const { default: Page } = await server.ssrLoadModule(
      '/src/renderer/src/views/AnalysisResults.vue'
    )
    const app = createSSRApp(Page),
      key = Symbol('rows')
    const generic = defineComponent({
      props: ['label', 'title', 'description'],
      setup(p, { slots }) {
        return () =>
          h('section', [p.title, p.label, p.description, slots.default?.(), slots.footer?.()])
      }
    })
    const table = defineComponent({
      props: ['data'],
      setup(p, { slots }) {
        provide(key, p.data ?? [])
        return () => h('div', slots.default?.())
      }
    })
    const column = defineComponent({
      props: ['prop', 'label'],
      setup(p, { slots }) {
        const rows = inject<any[]>(key, [])
        return () =>
          h('section', [
            p.label,
            ...rows.map((row) => h('div', slots.default?.({ row }) ?? String(row[p.prop] ?? '')))
          ])
      }
    })
    for (const name of [
      'ElButton',
      'ElAlert',
      'ElSelect',
      'ElOption',
      'ElTag',
      'ElInput',
      'ElForm',
      'ElFormItem',
      'ElDescriptions',
      'ElDescriptionsItem',
      'ElDrawer',
      'ElDialog',
      'ElCollapse',
      'ElCollapseItem',
      'ElDivider',
      'ElEmpty',
      'ElPagination',
      'ElProgress'
    ])
      app.component(name, generic)
    app.component('ElTable', table)
    app.component('ElTableColumn', column)
    app.directive('loading', {})
    const html = await renderToString(app)
    for (const text of [
      '检测结果',
      '演示样品2·前延',
      '疑似分叉',
      '数值超限',
      '未评估／数据不足',
      '峰形与积分证据',
      '离子比检查',
      '限量数值比较',
      '记录人工复核',
      '5%拖尾因子',
      'DEMO-07'
    ])
      assert(html.includes(text), text)
  } finally {
    await server.close()
    ;(globalThis as any).window = savedWindow
    ;(globalThis as any).localStorage = savedStorage
  }
})
