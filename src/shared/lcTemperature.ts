/** Keep qualitative temperature conditions separate from numeric Celsius values. */
export function lcTemperature(method: Record<string, any>): { column_temperature_c: number | null; column_temperature_text: string | null; conditions: Record<string, any> | null } {
  let original = method.conditions
  if (typeof original === 'string') { try { original = JSON.parse(original) } catch { throw new Error('液相方法条件不是有效JSON') } }
  const conditions = original && typeof original === 'object' && !Array.isArray(original) ? { ...original } : {}
  const hasText = Object.hasOwn(method, 'column_temperature_text') || Object.hasOwn(conditions, 'column_temperature_text')
  const oldRaw = conditions.column_temperature_raw
  const oldText = typeof oldRaw === 'string' && oldRaw.trim() && !Number.isFinite(Number(oldRaw)) ? oldRaw : undefined
  const explicit = hasText ? (Object.hasOwn(method, 'column_temperature_text') ? method.column_temperature_text : conditions.column_temperature_text) : oldText
  if (explicit != null && typeof explicit !== 'string') throw new Error('柱温文字说明必须为文本')
  let text = String(explicit ?? '').trim(), numeric: number | null = null
  const raw = method.column_temperature_c ?? (!hasText && !oldText && (typeof oldRaw === 'number' || typeof oldRaw === 'string' && oldRaw.trim()) ? oldRaw : null)
  if (raw !== null && raw !== undefined && raw !== '') {
    if (typeof raw === 'number' && !Number.isFinite(raw)) throw new Error('柱温数值无效')
    if (typeof raw !== 'number' && typeof raw !== 'string') throw new Error('柱温须为数值或文字说明')
    const match = String(raw).trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:℃|°\s*C)?$/i)
    if (match) { numeric = Number(match[1]); if (!Number.isFinite(numeric)) throw new Error('柱温数值无效') }
    else if (!text) text = String(raw).trim()
    else if (text !== String(raw).trim()) throw new Error('柱温文字说明与原值不一致')
  }
  if (text.length > 255) throw new Error('柱温文字说明不能超过255字')
  if (text && numeric !== null) throw new Error('柱温不能同时填写数值和文字，请选择一种记录方式')
  if (text) conditions.column_temperature_text = text
  else delete conditions.column_temperature_text
  return { column_temperature_c: numeric, column_temperature_text: text || null, conditions: Object.keys(conditions).length ? conditions : null }
}
