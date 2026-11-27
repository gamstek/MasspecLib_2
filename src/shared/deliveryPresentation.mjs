// These helpers only choose how already-authorized values are displayed.
export function hasDisplayValue(value) {
  return value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '')
}
export function compoundColumns(rows, allowed) {
  return allowed.filter(key => {
    if (key.endsWith('base64')) return false
    const populated = rows.filter(row => hasDisplayValue(row.compound?.[key]))
    if (!populated.length) return false
    if (['name_zh', 'name_en'].includes(key) && allowed.includes('main_name')) {
      return populated.some(row => String(row.compound[key]).trim() !== String(row.compound.main_name ?? '').trim())
    }
    return true
  })
}
export function compoundColumnScopes(rows, allowed) {
  const scopes = { all: compoundColumns(rows, allowed), sources: {} }
  const grouped = new Map()
  for (const row of rows) {
    const key = row.sourceKey || row.sourceTitle
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(row)
  }
  for (const [key, records] of grouped) scopes.sources[key] = compoundColumns(records, allowed)
  return scopes
}
export function detailFields(group, row, allowed) {
  const keys = allowed.filter(key => !['image_base64', 'formula_diagram_base64', 'mass_spectrum_base64', 'peaks', 'points', 'gradient', 'retention_times'].includes(key) && hasDisplayValue(row[key]))
  return keys.filter(key => {
    if (group === 'compound' && ['name_zh', 'name_en'].includes(key) && keys.includes('main_name')) return String(row[key]).trim() !== String(row.main_name).trim()
    if (group === 'ms') {
      if (key === 'ce_unit' && keys.includes('ce')) return false
      if (key === 'transition_role' && row[key] === 'unspecified') return false
      const pressure = keys.includes('collision_gas_pressure') && row.collision_gas_pressure
      if (key === 'cad_value' && pressure && Number(row.cad_value) === Number(pressure.value)) return false
      if (key === 'cad_type' && (pressure && row.cad_type === pressure.unit || keys.includes('collision_gas_level') && row.cad_type === row.collision_gas_level)) return false
    }
    if (group === 'lc') {
      if (key === 'chromatographic_column_mode' && keys.includes('column_type') && row[key] === row.column_type) return false
      if (key === 'retention_time_unit' && keys.includes('retention_time')) return false
    }
    return true
  })
}
