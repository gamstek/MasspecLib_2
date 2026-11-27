import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { encodePackage, decodePackage } from '../src/shared/dataPackage.ts'
import { validateCatalog } from '../src/shared/taxonomy.ts'

export const DEMO_DATABASE = 'mspec_lib2_classification_demo'
const NAMESPACE = 'unified-consolidated-v2'
const NOTE = '模拟数据，仅用于软件功能演示，不代表真实化合物或经验证检测方法。'

export function createDemoData() {
  // Select existing definitions, including their original ancestors; never invent or translate nodes.
  const original = JSON.parse(readFileSync('outputs/统一谱库适配/来源SQL最终52类目录.json', 'utf8'))
  const ids = new Map(original.map(item => [item.category_id, item]))
  const selectedCodes = new Set([
    'pesticides', 'pesticide_insecticide', 'pesticide_fungicide', 'drugs', 'antibiotics',
    'toxins', 'natural', 'metabolism', 'microbial_metabolites', 'chemicals', 'alkaloids', 'pending'
  ])
  const taxonomyCatalog = original.filter(item => selectedCodes.has(item.category_code)).map(item => ({
    namespace: NAMESPACE,
    category_code: item.category_code,
    category_name: item.category_name,
    axis: item.axis,
    parent_code: item.parent_id == null ? null : ids.get(item.parent_id).category_code,
    description: item.description,
    status: item.status
  }))
  assert.equal(taxonomyCatalog.length, selectedCodes.size)
  validateCatalog(taxonomyCatalog)
  const definitions = [
    ['A', '演示A·杀虫剂', 'Demo A - insecticide', ['pesticide_insecticide'], 'pesticide'],
    ['B', '演示B·杀菌剂', 'Demo B - fungicide', ['pesticide_fungicide'], 'pesticide'],
    ['C', '演示C·双重农药分类', 'Demo C - two pesticide categories', ['pesticide_insecticide', 'pesticide_fungicide'], 'pesticide'],
    ['D', '演示D·抗生素', 'Demo D - antibiotic', ['antibiotics'], 'general'],
    ['E', '演示E·跨维度多分类', 'Demo E - multiple classification axes', ['toxins', 'natural', 'microbial_metabolites'], 'general'],
    ['F', '演示F·仅一级分类', 'Demo F - parent category only', ['natural'], 'general'],
    ['G', '演示G·待分类', 'Demo G - pending classification', ['pending'], 'general'],
    ['H', '演示H·未指定分类', 'Demo H - no assigned category', [], 'general']
  ]
  const gradient = [
    [0, 95, 5], [1, 95, 5], [6, 5, 95], [8, 5, 95], [8.1, 95, 5], [10, 95, 5]
  ]
  const groups = definitions.map(([key, name, english, categories, topic], index) => {
    const precursor = 201.1234 + index * 20
    const q1 = precursor.toFixed(4)
    const polarity = index % 2 === 0 ? 1 : 0
    const adduct = polarity === 1 ? '[M+H]+' : '[M-H]-'
    const isMRM = index < 2
    const energies = key === 'A' ? [20, 35] : key === 'E' ? [15, 30] : [25]
    const methods = energies.map((ce, position) => ({
      localId: `method-${key}-${position}`,
      ms_mode: '功能演示仪器',
      scan_mode: isMRM ? 'MRM' : 'MS2',
      q1,
      q3: isMRM ? (precursor - 44.01).toFixed(4) : null,
      ce,
      dp: isMRM ? 0 : null,
      polarity,
      ion_source: 'ESI',
      adduct,
      transition_role: isMRM ? (position === 0 ? 'quantifier' : 'qualifier') : 'unspecified',
      ce_unit: 'eV',
      energy_type: 'absolute',
      conditions: { ionization_voltage: { value: '3.5', unit: 'kV' }, resolution: '17500', demo_note: NOTE }
    }))
    const spectra = methods.map((method, position) => ({
      localId: `spectrum-${key}-${position}`,
      kind: 'numeric',
      spectrum_type: 'MS2',
      polarity,
      adduct,
      precursor_mz: q1,
      collision_energy: { value: String(method.ce), unit: 'eV', energy_type: 'absolute' },
      nature: 'synthetic-test',
      conditions: { demo_note: NOTE },
      peaks: [
        { mz: (precursor - 120.04).toFixed(4), intensity: String(15000 + position * 5000) },
        { mz: (precursor - 82.02).toFixed(4), intensity: '28000' },
        { mz: (precursor - 44.01).toFixed(4), intensity: '100000' },
        { mz: (precursor - 18.01).toFixed(4), intensity: String(64000 - position * 12000) },
        { mz: q1, intensity: '11000' }
      ],
      methodLocalIds: [method.localId]
    }))
    const lcMethods = [{
      localId: `lc-${key}`,
      lc_mode: '功能演示液相方法',
      chromatographic_column_mode: '演示C18 100 × 2.1 mm, 1.8 uM',
      column_type: '演示C18',
      column_length_mm: '100',
      column_inner_diameter_mm: '2.1',
      column_particle_size_um: '1.8',
      column_temperature_c: '35',
      retention_time: (2.5 + index * 0.4).toFixed(2),
      retention_time_unit: 'min',
      phase_A: '水 + 0.1%甲酸（模拟条件）',
      phase_B: '乙腈 + 0.1%甲酸（模拟条件）',
      elution_mode: 'gradient',
      program_text: '0–1 min：5% B；1–6 min：5%→95% B；6–8 min：95% B；8.1 min恢复5% B；平衡至10 min。模拟程序，仅演示。',
      conditions: { demo_note: NOTE },
      items: gradient.map(([time, percentage_A, percentage_B], step_order) => ({
        step_order, time, percentage_A: String(percentage_A), percentage_B: String(percentage_B),
        flow_rate: 0.3, time_unit: 'min', flow_rate_unit: 'mL/min'
      }))
    }]
    return {
      source: {
        namespace: `masspeclib2-classification-demo:${topic}`,
        key: `demo-${key}`,
        name: topic === 'pesticide' ? '分类演示·农残资料' : '分类演示·综合资料',
        provider: 'MasspecLib2 功能演示',
        sourceType: 'local',
        version: '1.0',
        location: '本地分类演示包（模拟）'
      },
      compound: {
        main_name: name, name_zh: name, name_en: english,
        name: [{ name, area: '中国' }, { name: english, area: 'English' }],
        cas: null, formula: null, molecular_mass: null, monoisotopic_mass: null,
        properties: { demo: true, demo_note: NOTE }
      },
      classifications: categories.map(category_code => ({
        namespace: NAMESPACE, category_code,
        evidence: [{ original_label: taxonomyCatalog.find(c => c.category_code === category_code).category_name,
          evidence_type: 'demo_assignment', review_status: 'demo_only', evidence_text: NOTE }]
      })),
      methods, spectra, lcMethods
    }
  })
  return { formatVersion: 2, schemaVersion: 2, packageId: 'masspeclib2-classification-demo-20261016-v2',
    mappingVersion: 'taxonomy-demo-v2', taxonomyCatalog, groups }
}

export function writeDemo(outputDirectory = 'outputs/分类功能演示库') {
  const data = createDemoData()
  const bytes = encodePackage(data)
  const decoded = decodePackage(bytes)
  assert.deepEqual(decoded.groups, data.groups)
  assert.deepEqual(decoded.taxonomyCatalog, data.taxonomyCatalog)
  assert.equal(decoded.packageId, data.packageId)
  mkdirSync(outputDirectory, { recursive: true })
  writeFileSync(join(outputDirectory, '分类功能演示包.msldata'), bytes)
  writeFileSync(join(outputDirectory, '分类目录.json'), JSON.stringify(data.taxonomyCatalog, null, 2) + '\n')
  writeFileSync(join(outputDirectory, '演示数据.json'), JSON.stringify(data, null, 2) + '\n')
  for (const file of ['masspeclib2-initialize.sql', 'masspeclib2-initialize.sql.manifest.json'])
    copyFileSync(join('prisma', file), join(outputDirectory, file))
  writeFileSync(join(outputDirectory, '00_建立空演示数据库.sql'),
    '-- 仅建立演示空库，后续请在软件中初始化并导入演示包。\n' +
    `CREATE DATABASE IF NOT EXISTS \`${DEMO_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`)
  const summary = {
    packageId: data.packageId, targetDatabase: DEMO_DATABASE, targetSchemaVersion: 4,
    catalogOrigin: '原SQL的52类目录子集，编码、名称、维度及父子关系保持一致',
    compounds: data.groups.length, categories: data.taxonomyCatalog.length,
    classificationLinks: data.groups.reduce((n, g) => n + g.classifications.length, 0),
    sources: new Set(data.groups.map(g => g.source.namespace)).size,
    spectra: data.groups.reduce((n, g) => n + g.spectra.length, 0),
    peaks: data.groups.reduce((n, g) => n + g.spectra.reduce((k, s) => k + s.peaks.length, 0), 0),
    msMethods: data.groups.reduce((n, g) => n + g.methods.length, 0),
    lcMethods: data.groups.reduce((n, g) => n + g.lcMethods.length, 0),
    gradientSteps: data.groups.reduce((n, g) => n + g.lcMethods.reduce((k, m) => k + m.items.length, 0), 0),
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    note: NOTE
  }
  writeFileSync(join(outputDirectory, '数据清单.json'), JSON.stringify(summary, null, 2) + '\n')
  return summary
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(writeDemo(process.argv[2]), null, 2))
