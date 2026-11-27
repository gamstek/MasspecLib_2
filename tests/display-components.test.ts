/* eslint-disable @typescript-eslint/no-explicit-any, vue/one-component-per-file, vue/require-prop-types, vue/component-definition-name-casing */
// Small Element control stubs intentionally share this test fixture and match template tag names.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import vuePlugin from '@vitejs/plugin-vue'
import { createSSRApp, defineComponent, h, provide, inject } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createRouter, createMemoryHistory } from 'vue-router'

// Render the production templates with lightweight control and chart stubs.
test('actual detail templates render the scientific display regression cases', async (t) => {
  const root = resolve(import.meta.dirname, '..')
  const server = await createServer({
    configFile: false,
    root,
    plugins: [
      vuePlugin(),
      {
        name: 'display-test-chart',
        enforce: 'pre',
        load(id) {
          if (id.endsWith('/ConnectionManager.vue'))
            return '<template><button>数据库管理</button></template>'
          if (id.endsWith('/MassSpectrumChart.vue'))
            return '<script setup>defineProps(["spectrumData"])</script><template><div /></template>'
        }
      }
    ],
    resolve: { alias: { '@renderer': resolve(root, 'src/renderer/src') } },
    server: { middlewareMode: true },
    appType: 'custom'
  })
  const rowsKey = Symbol('table-rows')
  const table = defineComponent({
    props: ['data'],
    setup(props, { slots }) {
      provide(rowsKey, props.data ?? [])
      return () => h('div', slots.default?.())
    }
  })
  const column = defineComponent({
    props: ['label', 'prop'],
    setup(props, { slots }) {
      const rows = inject<any[]>(rowsKey, [])
      return () =>
        h('section', [
          h('b', props.label ?? ''),
          ...rows.map((row) => h('div', slots.default?.({ row }) ?? String(row[props.prop] ?? '')))
        ])
    }
  })
  const item = defineComponent({
    props: ['label'],
    setup(props, { slots }) {
      return () =>
        h('section', { 'data-field': props.label }, [h('b', props.label), slots.default?.()])
    }
  })
  const wrap = defineComponent({
    setup(_, { slots }) {
      return () => h('div', [slots.header?.(), slots.default?.()])
    }
  })
  async function render(file: string, props: Record<string, any>, openMethod?: number): Promise<string> {
    const { default: component } = await server.ssrLoadModule(file)
    const app = createSSRApp(component, props)
    if (openMethod !== undefined) {
      app.mixin({
        serverPrefetch() {
          if (this.$.parent) return
          // SSR cannot dispatch a native details event. Exercise the component's toggle handler.
          const { displayMethods, updateOpenMethod } = this.$.setupState
          updateOpenMethod(displayMethods[openMethod].method, { currentTarget: { open: true } })
        }
      })
    }
    for (const name of [
      'el-card',
      'el-form',
      'el-form-item',
      'el-descriptions',
      'el-collapse',
      'el-collapse-item',
      'el-button',
      'el-divider',
      'el-tag',
      'el-select',
      'el-option',
      'el-empty',
      'el-pagination',
      'el-input',
      'el-input-number',
      'el-icon',
      'el-container',
      'el-header',
      'el-aside',
      'el-main',
      'el-menu',
      'el-menu-item',
      'el-sub-menu'
    ])
      app.component(name, wrap)
    app.component('el-descriptions-item', item)
    app.component('el-form-item', item)
    if (file.endsWith('/Layout.vue')) {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          {
            path: '/:pathMatch(.*)*',
            component: defineComponent({ render: () => h('div', '内容区') })
          }
        ]
      })
      app.use(router)
      await router.push('/-1')
      await router.isReady()
    }
    app.component('el-table', table)
    app.component('el-table-column', column)
    return renderToString(app)
  }
  function field(html: string, label: string): string {
    return (
      html.match(new RegExp(`<section data-field="${label}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ??
      ''
    )
  }
  const method = {
    id: 1,
    ms_mode: '测试仪器',
    q1: 329.065,
    q3: null,
    ce: 30,
    ce_unit: 'NCE',
    energy_type: 'normalized',
    scan_mode: 'MS2',
    conditions: {
      source_comments: ['仪器维护后采集'],
      original_mass_spectrometry: { MS_TYPE: ['MS2'] }
    }
  }
  const props = {
    connectionId: 'A',
    compoundId: 1,
    independentSpectrumCount: 0,
    independentSpectra: [],
    isActive: true,
    editStatus: false,
    msMode: '测试仪器',
    msMethodData: [{ ms_mode: '测试仪器', methods: [method] }]
  }
  try {
    await t.test(
      'liquid template fills particle size from column text and defaults unspecified retention units to minutes',
      async () => {
        const liquidFile = '/src/renderer/src/components/LiquidMethods.vue'
        const liquidProps = {
          editable: false,
          methods: [
            {
              id: 1,
              retention_time: 2.95,
              retention_time_unit: null,
              column_particle_size_um: null,
              chromatographic_column_mode: 'Agilent RRHD Eclipse 50 x 2 mm, 1.8 uM',
              methodsLinks: [],
              conditions: {
                original_chromatography: { RETENTION_TIME: ['2.95'], NAPS_RTI: ['750'] }
              }
            }
          ]
        }
        const summary = await render(liquidFile, liquidProps)
        assert.match(summary, /<span class="method-retention"[^>]*>2\.95 min（默认单位）<\/span>/)
        assert.doesNotMatch(summary, /class="method-details"/)

        const details = await render(liquidFile, liquidProps, 0)
        assert.match(details, /class="method-details"/)
        assert.doesNotMatch(details, /RT单位/)
        assert.match(details, /<b>色谱柱粒径_μm<\/b><div><span[^>]*>1\.8<small[^>]*>（原文解析）<\/small>/)
        assert.match(details, /来源原始液相记录（导入时原文）/)
      }
    )
    await t.test('known seconds convert to minutes in the actual liquid template', async () => {
      const html = await render('/src/renderer/src/components/LiquidMethods.vue', {
        editable: false,
        methods: [{ id: 1, retention_time: 120, retention_time_unit: 's', methodsLinks: [] }]
      })
      assert.match(html, /<span class="method-retention"[^>]*>2 min<\/span>/)
      assert.doesNotMatch(html, /<span class="method-retention"[^>]*>120 min<\/span>/)
    })
    await t.test(
      'the application has one full-width header followed by navigation and content',
      async () => {
        const html = await render('/src/renderer/src/views/layout/Layout.vue', {})
        const header = html.indexOf('class="app-header"')
        const body = html.indexOf('class="workspace"')
        assert.ok(header >= 0 && body > header)
        assert.equal((html.match(/MasspecLib2/g) ?? []).length, 1)
        assert.ok(html.indexOf('class="app-brand"') < body)
        assert.ok(html.indexOf('class="workspace-content"') > body)
      }
    )
    await t.test(
      'a method without spectra has no invented fragments, repeated mode or confidence',
      async () => {
        const html = await render('/src/renderer/src/views/MsInfoTab.vue', props)
        assert.doesNotMatch(html, /多个MS2碎片|MS2碎片谱峰|未指定；MS2碎片见谱图/)
        assert.equal((html.match(/data-field="采集模式"/g) ?? []).length, 1)
        assert.match(field(html, '来源备注'), /仪器维护后采集/)
        assert.doesNotMatch(html, /data-field="数据置信度/)
        assert.match(html, />归一化</)
        assert.doesNotMatch(html, />normalized</)
      }
    )
    await t.test('the concise MRM table retains real Q3, zero DP and method roles', async () => {
      const html = await render('/src/renderer/src/views/MsInfoTab.vue', {
        ...props,
        msMethodData: [
          {
            ms_mode: '测试仪器',
            methods: [
              {
                ...method,
                q3: 311.055,
                dp: 0,
                cxp: null,
                transition_role: 'quantifier',
                scan_mode: 'MRM'
              }
            ]
          }
        ]
      })
      assert.match(html, />311\.055</)
      assert.match(html, /<b>DP<\/b>[\s\S]*?>0</)
      assert.match(html, />定量</)
      assert.doesNotMatch(html, /<b>CXP<\/b>|<b>CE单位<\/b>/)
    })
    await t.test(
      'the real method table counts only spectra associated with its method',
      async () => {
        const html = await render('/src/renderer/src/views/MsInfoTab.vue', {
          ...props,
          independentSpectrumCount: 2,
          independentSpectra: [
            {
              kind: 'numeric',
              spectrum_type: 'MS2',
              methodIds: [1],
              peaks: [{ mz: '100', intensity: '5' }]
            },
            {
              kind: 'numeric',
              spectrum_type: 'MS2',
              methodIds: [2],
              peaks: [{ mz: '200', intensity: '6' }]
            }
          ]
        })
        assert.match(html, /1 条MS2谱峰/)
        assert.doesNotMatch(html, /2 条MS2谱峰/)
        assert.doesNotMatch(html, /母离子 → 固定子离子|固定Q3未指定|CE单位/)
      }
    )
  } finally {
    await server.close()
  }
})
