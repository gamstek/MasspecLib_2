export const COMPOUND_EXPORT_FIELDS = [
  ['name_zh', '中文名称'],
  ['name_en', '英文名称'],
  ['main_name', '主名称'],
  ['name', '同义词'],
  ['cas', 'CAS号'],
  ['formula', '分子式'],
  ['ion_mode', '离子模式'],
  ['molecular_mass', '分子量'],
  ['monoisotopic_mass', '单同位素质量'],
  ['identifiers', '其他标识'],
  ['properties', '其他属性']
] as const
export const EXPORT_CONTENTS = [
  ['sources', '数据来源'],
  ['classifications', '分类'],
  ['methods', '质谱方法与离子对'],
  ['lcMethods', '液相方法与梯度'],
  ['spectra', '质谱谱图'],
  ['chromatograms', '色谱数据与测定记录'],
  ['checks', '自动检查与复核记录']
] as const
export interface ExportSelection {
  fields: string[]
  contents: string[]
}
export const DEFAULT_EXPORT: ExportSelection = {
  fields: COMPOUND_EXPORT_FIELDS.map((x) => x[0]),
  contents: EXPORT_CONTENTS.map((x) => x[0])
}
export function validateExportSelection(value?: ExportSelection): ExportSelection {
  if (!value) return structuredClone(DEFAULT_EXPORT)
  const fields = new Set(COMPOUND_EXPORT_FIELDS.map((x) => x[0]) as string[]),
    contents = new Set(EXPORT_CONTENTS.map((x) => x[0]) as string[])
  if (
    !Array.isArray(value.fields) ||
    !Array.isArray(value.contents) ||
    value.fields.some((x) => !fields.has(x)) ||
    value.contents.some((x) => !contents.has(x))
  )
    throw new Error('导出字段或内容选项无效')
  if (!value.fields.length && !value.contents.length)
    throw new Error('请至少选择一个字段或一类内容')
  return { fields: [...new Set(value.fields)], contents: [...new Set(value.contents)] }
}
export function csvCell(value: unknown): string {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}
export const RESULT_EXPORT_FIELDS = [
  ['sample', '样品'],
  ['compound', '化合物'],
  ['sources', '数据来源'],
  ['method', '方法'],
  ['batch', '批次'],
  ['peak', '峰形判定'],
  ['flags', '峰形标记'],
  ['limit', '超限判定'],
  ['measuredValue', '测定值'],
  ['limitValue', '限量'],
  ['ratio', '离子比判定'],
  ['observedRatio', '实测离子比'],
  ['review', '人工复核'],
  ['checkedAt', '检查时间'],
  ['engineVersion', '引擎版本'],
  ['ruleVersion', '规则版本'],
  ['traces', '色谱数值']
] as const
