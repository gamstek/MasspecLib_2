const crypto = require('node:crypto')
const { acquisitionFields } = require('../../src/shared/acquisitionParameters.mjs')
const fields = {
  classification: { categories: '规范分类与字典', status: '分类复核状态', source_labels: '原始分类标签' },
  compound: { smiles:'SMILES',identity_status:'身份状态',calculated_formula:'计算分子式',formula_source:'分子式依据',main_name: '名称', name_zh: '中文名', name_en: '英文名', cas: 'CAS号', formula: '分子式', molecular_mass: '分子量', monoisotopic_mass: '单同位素质量', formula_diagram_base64: '结构图' },
  ms: { ...acquisitionFields,ce_unit_source:'碰撞参数单位来源',quality_issue:'方法数据提示', ms_mode: '质谱模式', q1: '母离子', q3: '子离子', ce: '碰撞能量', dp: '去簇电压', cxp: '碰撞室出口电压', polarity: '极性', ion_source: '离子源', scan_mode: '扫描模式', cad_value: '碰撞气数值', cad_type: '碰撞气类型', transition_role: '通道角色', adduct: '加合离子', ce_unit: '碰撞能量单位', energy_type: '能量类型', mass_spectrum_base64: '谱图图片' },
  lc: { method_source: '液相方法来源／分组', flow_rate: '流速及单位', lc_mode: '液相模式', chromatographic_column_mode: '色谱柱模式', retention_time: '保留时间', retention_time_unit: '时间单位', phase_A: '流动相A', phase_B: '流动相B', column_type: '色谱柱', column_length_mm: '柱长(mm)', column_inner_diameter_mm: '内径(mm)', column_particle_size_um: '粒径(μm)', column_temperature_c: '柱温(℃)', column_temperature_text: '柱温文字说明', retention_times: '保留时间/峰记录', elution_mode: '洗脱模式', program_text: '程序说明', gradient: '梯度程序' },
  spectrum: { kind: '谱图形式', peaks: '数值谱峰', image_base64: '谱图图片', spectrum_type: '谱图类型', polarity: '极性', adduct: '加合离子', precursor_mz: '前体离子质荷比', collision_energy: '碰撞能量', nature: '谱图性质' },
  chromatogram: { channel_role: '通道角色', time_unit: '时间单位', points: '数值曲线', image_base64: '色谱图片', method_name: '方法名称', rule_version: '规则版本', status: '记录状态' },
  experiment: { batch_name: '批次名称', method_name: '方法名称', rule_version: '规则版本', record_type: '记录类型', status: '记录状态', measurement: '测定值及单位', limit: '限量依据', ratio: '离子比及规则' },
  source: {ce_unit:'关联MRM碰撞参数单位',ce_unit_source:'关联MRM单位来源',name: '来源名称', version: '来源版本', provider: '提供方', license: '许可说明' }
}
const featureLabels = { classification: '化合物分类导航', classificationSubdivide:'按原有分类标签细分（大类下）', spectra: '谱图与质谱方法', lc: '液相方法', chromatograms: '色谱图', experiments: '测定结果', checks: '自动检查结果', review: '人工复核', export: '数据导出', offline: '签名离线文件导出', favorite: '本地收藏', groups: '本机化合物分组', personalImport: '个人数据导入', deleteRecords: '删除内置化合物（仅本机）', restoreRecords: '恢复内置化合物', purgeRecords: '彻底删除本机记录', personalDelete: '删除个人记录及批次', personalRestore: '恢复个人记录及批次', personalPurge: '彻底删除个人记录及批次' }
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }) }
function text(value, label, max = 120) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label}不能为空且不能超过${max}字`); return value.trim() }
function normalizePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('交付配置无效')
  const features = {}
  for (const key of Object.keys(featureLabels)) features[key] = input.features?.[key] === true
  if ((features.restoreRecords || features.purgeRecords) && !features.deleteRecords) fail('内置数据恢复和彻底删除需要先开放删除')
  if ((features.personalRestore || features.personalPurge) && !features.personalDelete) fail('个人数据恢复和彻底删除需要先开放删除')
  if (features.review && !features.checks) fail('人工复核需要同时开放检查结果')
  if (features.checks && !features.chromatograms && !features.experiments) fail('检查结果需要至少开放色谱图或测定结果')
  if (features.offline && !features.export) fail('离线交付需要同时允许导出，已交付文件无法远程收回')
  const chosen = {}
  for (const [group, options] of Object.entries(fields)) {
    const list = input.fields?.[group] ?? []
    if (!Array.isArray(list) || list.some(key => typeof key !== 'string' || !Object.hasOwn(options, key))) fail(`不支持的${group}字段`)
    chosen[group] = [...new Set(list)]
  }
  if(features.classificationSubdivide){for(const key of ['categories','source_labels'])if(!chosen.classification.includes(key))chosen.classification.push(key)}
  if(features.classification&&!chosen.classification.includes('categories'))chosen.classification.unshift('categories')
  if(chosen.classification.includes('status')&&!chosen.classification.includes('categories'))fail('分类复核状态需要同时交付分类字典')
  if(chosen.lc.includes('retention_time')&&!chosen.lc.includes('retention_time_unit'))chosen.lc.push('retention_time_unit')
  if(chosen.ms.includes('ce')&&!chosen.ms.includes('ce_unit'))chosen.ms.push('ce_unit')
  if(chosen.ms.includes('ce_unit')&&!chosen.ms.includes('ce_unit_source'))chosen.ms.push('ce_unit_source')
  if (!chosen.compound.includes('main_name')) fail('必须保留化合物名称')
  if (!features.spectra) chosen.ms = chosen.spectrum = []
  if (!features.lc) chosen.lc = []
  if (!features.chromatograms) chosen.chromatogram = []
  if (!features.experiments) chosen.experiment = []
  if (features.spectra && !chosen.ms.length && !chosen.spectrum.length) fail('谱图页签至少需要一个质谱或谱图字段')
  if (features.lc && !chosen.lc.length) fail('液相方法至少需要一个字段')
  if (features.chromatograms && !chosen.chromatogram.length) fail('色谱图至少需要一个字段')
  if (features.experiments && !chosen.experiment.length) fail('测定结果至少需要一个字段')
  if (chosen.chromatogram.includes('points') && !chosen.chromatogram.includes('time_unit')) fail('数值色谱曲线必须同时交付时间单位')
  if (features.checks && features.chromatograms && !chosen.chromatogram.includes('points')) fail('色谱检查需要交付数值曲线，图片不能替代数值数据')
  if (features.checks && features.experiments && !['measurement', 'ratio'].some(k => chosen.experiment.includes(k))) fail('测定检查需要交付测定值或离子比')
  const navigationDepth=input.classification?.navigationDepth??2;if(![1,2].includes(navigationDepth))fail('分类导航只支持1或2级')
  const tagDepth=input.classification?.tagDepth;if(tagDepth!==undefined&&(!Number.isInteger(tagDepth)||tagDepth<0||tagDepth>10))fail('原始标签深度应为0（全部）或1–10级')
  const depth=input.classification?.sourceLabelDepth
  if(depth!==undefined&&(!Number.isInteger(depth)||depth<0||depth>10))fail('分类标签保留层级应为0（全部）或1–10级')
  const presentation=require('./presentation.cjs').normalizePresentation(input.presentation,chosen)
  return { fields: chosen, features,presentation,classification:{navigationDepth,...(tagDepth!==undefined?{tagDepth}:{}),...(depth!==undefined?{sourceLabelDepth:depth}:{})} }
}
const templates = [
  { id: 'spectra', name: '谱库查询版', policy: { fields: { compound: ['main_name', 'cas', 'formula', 'molecular_mass'], ms: ['ms_mode', 'q1', 'q3', 'ce', 'ce_unit', 'polarity'], spectrum: ['kind', 'peaks', 'image_base64', 'polarity', 'adduct'], source: ['name', 'version'] }, features: { spectra: true, favorite: true } } },
  { id: 'chromatography', name: '色谱分析版', policy: { fields: { compound: ['main_name', 'cas', 'formula'], lc: ['lc_mode', 'retention_time', 'retention_time_unit', 'column_type', 'gradient'], chromatogram: ['channel_role', 'time_unit', 'points', 'image_base64', 'method_name', 'rule_version'], source: ['name'] }, features: { lc: true, chromatograms: true, checks: true, favorite: true } } },
  { id: 'review', name: '复核协作版', policy: { fields: { compound: ['main_name', 'cas', 'formula'], chromatogram: ['channel_role', 'time_unit', 'points', 'image_base64'], experiment: ['batch_name', 'method_name', 'rule_version', 'measurement', 'limit', 'ratio'] }, features: { chromatograms: true, experiments: true, checks: true, review: true, export: true, favorite: true } } },
  { id: 'offline', name: '可导出签名文件版', policy: { fields: { compound: ['main_name', 'cas', 'formula', 'molecular_mass'], ms: ['q1', 'q3', 'ce'], spectrum: ['kind', 'peaks', 'image_base64'] }, features: { spectra: true, export: true, offline: true, favorite: true } } }
].map(x => ({ ...x, policy: normalizePolicy(x.policy) }))
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function safeScalar(v) { return v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v : null }
function pick(row, keys) { return Object.fromEntries(keys.filter(k => Object.hasOwn(row, k)).map(k => [k, safeScalar(row[k])])) }
function json(value) { if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch { return null } }
function points(value, x) {
  const data = json(value)
  if (!Array.isArray(data)) return []
  const numeric = v => v !== null && v !== undefined && (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN
  const result = data.map(p => Array.isArray(p) ? { [x]: numeric(p[0]), intensity: numeric(p[1]) } : { [x]: numeric(p?.[x]), intensity: numeric(p?.intensity) })
  if (result.some((p, i) => !Number.isFinite(p[x]) || !Number.isFinite(p.intensity) || (x === 'time' && i > 0 && p[x] <= result[i - 1][x]))) return []
  return result
}
function raster(value, mime = 'image/png') {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:')) return /^data:image\/(png|jpeg|gif|webp|bmp);base64,[a-zA-Z0-9+/=\r\n]+$/.test(value) ? value : null
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(mime) && /^[a-zA-Z0-9+/=\r\n]+$/.test(value) ? `data:${mime};base64,${value}` : null
}
module.exports = { fields, featureLabels, templates, normalizePolicy, fail, text, hash, pick, json, points, raster }
