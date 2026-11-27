import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import mysql from 'mysql2/promise'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createSSRApp, defineComponent, h, inject, provide } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { DEMO_DATABASE } from './create-taxonomy-demo.mjs'
import { validateDatabaseTarget } from '../src/shared/databaseTarget.ts'

const directory = resolve(process.argv[2] ?? 'outputs/分类功能演示库')
const database = validateDatabaseTarget(process.env.DEMO_DATABASE ?? DEMO_DATABASE)
const db = await mysql.createConnection({ host: process.env.DEMO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.DEMO_MYSQL_PORT ?? 44715), user: process.env.DEMO_MYSQL_USER ?? 'root',
  password: process.env.DEMO_MYSQL_PASSWORD ?? '', database })
const root = process.cwd()
const server = await createServer({ configFile: false, root,
  plugins: [vue(), { name: 'verify-chart-input', enforce: 'pre', load(id) {
    if (id.endsWith('/MassSpectrumChart.vue'))
      return '<script setup>defineProps(["spectrumData"])</script><template><div data-chart-input>{{ JSON.stringify(spectrumData) }}</div></template>'
  } }], resolve: { alias: { '@renderer': resolve(root, 'src/renderer/src') } },
  server: { middlewareMode: true }, appType: 'custom', optimizeDeps: { noDiscovery: true } })
const rowsKey = Symbol('rows')
const table = defineComponent({ props: ['data'], setup(props, { slots }) {
  provide(rowsKey, props.data ?? []); return () => h('div', slots.default?.())
} })
const column = defineComponent({ props: ['label', 'prop'], setup(props, { slots }) {
  const rows = inject(rowsKey, [])
  return () => h('section', [h('b', props.label ?? ''), ...rows.map((row, index) =>
    h('div', slots.default?.({ row, $index: index }) ?? String(row[props.prop] ?? '')))])
} })
const wrap = defineComponent({ setup(_, { slots }) { return () => h('div', [slots.header?.(), slots.default?.()]) } })
const item = defineComponent({ props: ['label'], setup(props, { slots }) {
  return () => h('section', [h('b', props.label ?? ''), slots.default?.()])
} })
const input = defineComponent({ props: ['modelValue'], setup(props) {
  return () => h('input', { value: props.modelValue ?? '' })
} })
async function render(file, props) {
  const { default: component } = await server.ssrLoadModule(file)
  const app = createSSRApp(component, props)
  for (const name of ['el-card', 'el-form', 'el-descriptions', 'el-collapse', 'el-collapse-item', 'el-button',
    'el-option', 'el-select', 'el-empty', 'el-pagination']) app.component(name, wrap)
  app.component('el-table', table); app.component('el-table-column', column)
  app.component('el-descriptions-item', item); app.component('el-form-item', item)
  app.component('el-input-number', input); app.component('el-input', input)
  return renderToString(app)
}
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const report = { status: 'running', database, checks: [],
  scope: '真实数据库数据通过生产Vue模板进行服务端渲染；Element控件及图表使用替身，仅验证文本、字段、图表输入与编辑控件，不验证浏览器交互或Canvas绘图。' }
try {
  const [compounds] = await db.query('SELECT id,main_name FROM compounds ORDER BY id')
  assert.equal(compounds.length, 8)
  for (const c of compounds) {
    const [liquid] = await db.query('SELECT * FROM lc_methods WHERE compounds_id=? ORDER BY id', [c.id])
    for (const m of liquid) {
      const [steps] = await db.query('SELECT * FROM lc_methods_items WHERE lc_methods_id=? ORDER BY step_order', [m.id])
      m.conditions = parse(m.conditions); m.methodsLinks = steps
    }
    const liquidHTML = await render('/src/renderer/src/components/LiquidMethods.vue', { methods: liquid, editable: false })
    for (const phrase of ['色谱柱粒径_μm', '1.8', '保留时间', 'min', '流动相A', '流动相B', '液相程序',
      'A相比例（%）', 'B相比例（%）', '流速', '0.3', '8.1', '95']) assert(liquidHTML.includes(phrase), c.main_name + ': 缺少液相显示 ' + phrase)
    assert(!liquidHTML.includes('RT单位'))
    const editableHTML = await render('/src/renderer/src/components/LiquidMethods.vue', { methods: liquid, editable: true })
    assert(editableHTML.includes('增加程序步骤'))
    assert(editableHTML.includes('value="0.3"'))
    const [spectra] = await db.query('SELECT * FROM spectra WHERE compound_id=? ORDER BY id', [c.id])
    for (const s of spectra) {
      s.peaks = parse(s.peaks); s.conditions = parse(s.conditions); s.collision_energy = parse(s.collision_energy)
      const [links] = await db.query('SELECT method_id FROM spectrum_method_links WHERE spectrum_id=?', [s.id])
      s.methodIds = links.map(x => x.method_id)
    }
    const html = await render('/src/renderer/src/components/ExtendedData.vue', {
      compoundId: c.id, section: 'spectra', editStatus: false,
      data: { spectra, methodLabels: Object.fromEntries(spectra.flatMap(s => s.methodIds.map(id => [id, '功能演示仪器']))) }
    })
    assert(html.includes('软件测试数据'))
    assert(html.includes('子离子/谱峰 m/z'))
    assert(html.includes('data-chart-input'))
    for (const peak of spectra[0].peaks) {
      assert(html.includes(String(peak.mz)), c.main_name + ': 谱峰表缺少 ' + peak.mz)
      assert(html.includes(String(Number(peak.mz))), c.main_name + ': 图表输入缺少 ' + peak.mz)
    }
    assert(html.includes('100.00'))
    report.checks.push({ record: c.main_name, result: 'pass', liquidReadAndEdit: true,
      retentionUnit: 'min', particleSize: '1.8 μm', gradientSteps: liquid[0].methodsLinks.length,
      spectra: spectra.length, chartInputPeaks: spectra[0].peaks.length })
    console.log('PASS: 液相/梯度/谱峰表/图表输入模板', c.main_name)
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1; console.error(error)
} finally {
  writeFileSync(join(directory, '页面模板验证报告.json'), JSON.stringify(report, null, 2) + '\n')
  await db.end(); await server.close()
}
