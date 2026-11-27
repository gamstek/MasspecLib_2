export function queryOptions(input = {}) {
  const q = { keyword: String(input.keyword || '').trim().toLowerCase(), source: String(input.source || ''), abnormal: input.abnormal === true || input.abnormal === 'true' }
  if (q.keyword.length > 200) throw new Error('搜索文字不能超过200字')
  for (const k of ['q1', 'q3']) {
    const v = input[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) throw new Error('离子质荷比必须为非负数值')
      q[k] = n
    }
  }
  if (input.polarity !== undefined && input.polarity !== null && String(input.polarity) !== '') {
    const n = Number(input.polarity)
    if (![0, 1].includes(n)) throw new Error('请选择正离子或负离子')
    q.polarity = n
  }
  const tolerance = Number(input.massTolerance || 0)
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10) throw new Error('离子容差应为0–10 Da')
  if (tolerance && (q.q1 !== undefined || q.q3 !== undefined)) q.massTolerance = tolerance
  if (input.recordIds !== undefined) {
    if (!Array.isArray(input.recordIds) || input.recordIds.some(id => typeof id !== 'string')) throw new Error('记录范围无效')
    q.recordIds = input.recordIds
  }
  if (input.categoryKeys !== undefined) {
    if (!Array.isArray(input.categoryKeys) || input.categoryKeys.length > 2000 || input.categoryKeys.some(k => typeof k !== 'string' || k.length > 300)) throw Error('分类查询范围无效')
    q.categoryKeys = [...new Set(input.categoryKeys)]
  }
  if (input.unclassified === true || input.unclassified === 'true') q.unclassified = true
  return q
}
export function hasMethodQuery(q) { return ['q1', 'q3', 'polarity'].some(k => q[k] !== undefined) }
export function matchesQuery(record, q) {
  if (q.source && (record.sourceKey || record.sourceTitle) !== q.source) return false
  if (q.unclassified && record.classification?.items?.length) return false
  if (q.categoryKeys && !(record.classification?.items || []).some(item => q.categoryKeys.includes(item.key))) return false
  if (q.recordIds && !q.recordIds.includes(record.id)) return false
  if (q.keyword && !Object.entries(record.compound || {}).some(([k,v]) => !k.endsWith('base64') && String(v ?? '').toLowerCase().includes(q.keyword))) return false
  if (q.abnormal && !(record.abnormal || record.checks?.some(c => c.abnormal))) return false
  if (hasMethodQuery(q) && !(record.ms || []).some(m => ['q1','q3','polarity'].every(k => q[k] === undefined || m[k] !== null && m[k] !== undefined && Number.isFinite(Number(m[k])) && Math.abs(Number(m[k]) - q[k]) <= (k === 'polarity' ? 0 : q.massTolerance || 0.000001) + 1e-9))) return false
  return true
}
export function methodColumns(rows, allowed) {
  return ['q1','q3','polarity'].filter(k => allowed.includes(k) && rows.some(r => r.ms?.some(m => m[k] !== null && m[k] !== undefined)))
}
