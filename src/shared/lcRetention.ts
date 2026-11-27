export interface RetentionObservation { id: string; value: number; unit: 's' | 'min'; unit_source: 'explicit' | 'default'; peak_label: string; note: string; methodLocalIds: string[] }
export function retentionObservations(method: Record<string, any>, allowedMethods?: Set<string>): RetentionObservation[] {
  let conditions = method.conditions
  if (typeof conditions === 'string') { try { conditions = JSON.parse(conditions) } catch { throw new Error('液相方法条件不是有效JSON') } }
  const candidates = conditions?.retention_time_candidates_min
  const input = Object.hasOwn(method, 'retention_times') ? method.retention_times : conditions?.retention_times ?? (Array.isArray(candidates) ? candidates.map((value, i) => ({ id: `legacy-peak-${i + 1}`, value, unit: 'min', peak_label: `保留时间${i + 1}（峰归属待确认）`, methodLocalIds: [] })) : undefined)
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('多保留时间记录必须是数组')
  const ids = new Set<string>()
  return input.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('保留时间记录无效')
    if (r.value === null || (typeof r.value === 'string' && !r.value.trim()) || !['number', 'string'].includes(typeof r.value) || !Number.isFinite(Number(r.value)) || Number(r.value) < 0) throw new Error('保留时间必须为非负数值')
    const unit = r.unit || 'min'
    if (!['s', 'min'].includes(unit)) throw new Error('每条保留时间单位应为 s 或 min')
    const id = String(r.id ?? `peak-${i + 1}`)
    if (!id || id.length > 191 || ids.has(id)) throw new Error('保留时间记录标识重复或无效')
    ids.add(id)
    const peak_label = String(r.peak_label ?? '').trim(), note = String(r.note ?? '').trim()
    if (peak_label.length > 255 || note.length > 2000) throw new Error('保留时间的峰标识或备注过长')
    const references = r.methodLocalIds ?? []
    if (!Array.isArray(references) || references.some(x => typeof x !== 'string' || !x || x.length > 191)) throw new Error('MRM通道引用须为方法ID字符串数组')
    if (allowedMethods && references.some(x => !allowedMethods.has(x))) throw new Error('保留时间引用了不存在或已删除的MRM通道，请先保存通道并重新关联')
    return { id, value: Number(r.value), unit, unit_source: !r.unit || r.unit_source === 'default' ? 'default' : 'explicit', peak_label, note, methodLocalIds: [...new Set<string>(references)] }
  })
}
export function retentionConditions(method: Record<string, any>, conditions: Record<string, any> | null, allowedMethods?: Set<string>, remap?: Map<string, number>): Record<string, any> | null {
  const rows = retentionObservations(method, allowedMethods), result = { ...conditions }
  if (method.retention_times !== undefined || Object.hasOwn(result, 'retention_times') || Object.hasOwn(result, 'retention_time_candidates_min')) {
    result.retention_times = rows.map(r => ({ ...r, methodLocalIds: remap ? r.methodLocalIds.map(id => String(remap.get(id))) : r.methodLocalIds }))
  }
  return Object.keys(result).length ? result : null
}
