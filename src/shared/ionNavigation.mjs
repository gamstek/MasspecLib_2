export const ION_NAVIGATION_OPTIONS=[{key:'ion-mode-positive',label:'正离子',value:1},{key:'ion-mode-negative',label:'负离子',value:0}]
export function ionModeFromRoute(value){return typeof value==='string'&&['0','1','2','3'].includes(value)?Number(value):undefined}
export function ionModeQuery(value){return typeof value==='number'&&[0,1,2,3].includes(value)?String(value):undefined}
export function ionNavigationTarget(query,mode){return{path:'/-1',query:{...query,ionMode:ionModeQuery(mode)}}}
export function ionFilterLabel(mode){return mode===1?'正离子':mode===0?'负离子':mode===3?'正负均有':mode===2?'未注明':'不限'}

export const ION_LIST_COUNT_EVENT = 'masspeclib2-ion-list-count'
export const ionDatabaseScope = (ids = []) => JSON.stringify([...new Set(ids)].sort())

export function ionCountLabel(option, result) {
  if (!result) return option.label
  return `${option.label} (${result.total}${result.complete ? '' : '，部分'})`
}

export function ionCountFromList(filters, result) {
  if (![0, 1].includes(filters.polarity) || !Number.isSafeInteger(result.total) || result.total < 0) return
  if (filters.keyword?.trim() || filters.sourceQuery?.trim() || filters.sourceIds?.length ||
      filters.adduct || filters.spectrumKind || filters.dataTypes?.length || filters.auditState ||
      filters.classId || filters.identityStatus || filters.favoriteOnly || filters.trashOnly) return
  return {
    scope: ionDatabaseScope(filters.connectionIds), mode: filters.polarity,
    total: result.total, complete: result.complete !== false
  }
}
