import * as XLSX from 'xlsx'
import {displayColumns,fieldValue} from './displayLayout.mjs'
import { classificationLabel } from './deliveryClassification.mjs'
import { quantityText } from './acquisitionParameters.mjs'
function cell(value: any): string | number | boolean {
  if (value === null || value === undefined) return ''
  let result: any = value
  if (typeof value === 'object') result = typeof value.value === 'number' && typeof value.unit === 'string' ? quantityText(value) : JSON.stringify(value)
  if (typeof result === 'string' && /^[\s]*[=+@-]/.test(result)) return "'" + result
  return result
}
/** Every input record has already been projected and authorized by the delivery API. */
export function deliveryTabular(data: any, format: 'csv' | 'xlsx', includeDetails: boolean): string | Buffer {
  if(data.manifest?.policy?.presentation?.mode==='table'){
    const columns=displayColumns(data.manifest,data.records),rows=[columns.map(c=>c.label),...data.records.map(r=>columns.map(c=>cell(fieldValue(r,c))))];
    if(format==='xlsx'&&rows.some(row=>row.some(v=>typeof v==='string'&&v.length>32767)))throw Error('字段内容超过Excel单元格限制，请使用JSON或SQL导出保留全部数据');
    const sheet=XLSX.utils.aoa_to_sheet(rows);if(format==='csv')return '\ufeff'+XLSX.utils.sheet_to_csv(sheet);const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'数据');return XLSX.write(book,{type:'buffer',bookType:'xlsx'});
  }
  const labels = data.manifest?.fieldLabels || {}, groups = [ ['ms', 'ms', '质谱方法'], ['lc', 'lc', '液相方法'], ['spectra', 'spectrum', '谱图'], ['chromatograms', 'chromatogram', '色谱图'], ['experiments', 'experiment', '测定结果'], ['checks', 'checks', '检查快照'], ['reviews', 'reviews', '人工复核'] ]
  const tables: { name: string; rows: Record<string, any>[] }[] = [{ name: '化合物', rows: data.records.map((r: any) => ({ 化合物记录ID: r.id, 所属数据库: cell(r.sourceTitle), ...(r.classification ? {规范分类:cell(classificationLabel(r)),...(r.classification.source_labels ? {来源原始分类:cell(r.classification.source_labels.join('；'))} : {})} : {}), ...Object.fromEntries(Object.entries(r.compound || {}).map(([k, v]) => [labels.compound?.[k] || k, cell(v)])) })) }]
  if (includeDetails) for (const [key, group, name] of groups) {
    const rows = data.records.flatMap((r: any) => (r[key] || []).map((item: any) => ({ 化合物记录ID: r.id, 所属数据库: cell(r.sourceTitle), 名称: cell(r.compound.main_name || ''), 关联记录ID: item.id || '', ...Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'id').map(([k, v]) => [labels[group]?.[k] || ({ methodIds: '关联质谱方法ID', type: '类型', abnormal: '是否异常', labels: '检查标记', reason: '复核依据', reviewer: '复核人', at: '复核时间' } as Record<string, string>)[k] || k, cell(v)])) })))
    if (rows.length) tables.push({ name, rows })
  }
  const book = XLSX.utils.book_new()
  if (format === 'csv') {
    const rows = tables.flatMap(t => t.rows.map(r => Object.fromEntries([['记录类型', t.name], ...Object.entries(r).map(([k, v]) => [includeDetails && !['化合物记录ID', '所属数据库', '名称', '关联记录ID'].includes(k) ? `${t.name}：${k}` : k, v])])))
    return '\ufeff' + XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows))
  }
  for (const table of tables) {
    if (table.rows.some(r => Object.values(r).some(v => typeof v === 'string' && v.length > 32767))) throw new Error('关联内容超过Excel单元格32767字符限制，请改用JSON导出以保留完整数据')
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(table.rows), table.name)
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
}
