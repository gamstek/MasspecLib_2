const identityKeys = new Set(['id', 'localId', 'method_source', 'source_record_id',
  'sourceRecordId', 'methodIds', 'methodLocalIds', 'record_ids', 'record_keys'])
function conditions(value) {
  if (Array.isArray(value)) return value.map(conditions)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).filter(key => !identityKeys.has(key)).sort().map(key => [key, conditions(value[key])]))
  return value
}
export function groupLiquidMethods(methods, editable = false) {
  if (editable) return methods.map(method => ({ method, members: [method] }))
  const groups = new Map()
  for (const method of methods) {
    const key = JSON.stringify(conditions(method))
    const prior = groups.get(key)
    if (prior) prior.members.push(method)
    else groups.set(key, { method, members: [method] })
  }
  return [...groups.values()]
}
