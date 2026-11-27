const columns = ['name_en', 'cas', 'formula', 'ionModes', 'sources', 'database', 'audit', 'mrm1', 'mrm2']
const menus = ['databases', 'quality', 'groups', 'categories']

function uniqueStrings(value, max, accepts) {
  return Array.isArray(value) && value.length <= max && new Set(value).size === value.length &&
    value.every(item => typeof item === 'string' && accepts(item))
}

export function parseAdminWorkspace(value) {
  const validLibrary = key => /^(mspec_lib2_shared_[0-9a-f]{20}|file:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(key)
  if (value?.schemaVersion !== 1 || !uniqueStrings(value.libraries, 100, validLibrary) ||
    !uniqueStrings(value.removedLibraries ?? [], 500, validLibrary) || (value.defaultLibrary !== null && !value.libraries.includes(value.defaultLibrary)) ||
    !uniqueStrings(value.columns, columns.length, key => columns.includes(key)) ||
    ![20, 50, 100, 200].includes(value.pageSize) ||
    !Number.isInteger(value.navigationWidth) || value.navigationWidth < 200 || value.navigationWidth > 600 ||
    !uniqueStrings(value.expandedCategories, 100, key => key.length > 0 && key.length <= 500) ||
    !uniqueStrings(value.openMenus ?? ['databases'], menus.length, key => menus.includes(key))) {
    throw new Error('服务器管理员端默认配置无效，请联系维护人员')
  }
  return {
    schemaVersion: 1,
    libraries: [...value.libraries], defaultLibrary: value.defaultLibrary,
    ...(value.removedLibraries?.length ? { removedLibraries: [...value.removedLibraries] } : {}),
    columns: [...value.columns], pageSize: value.pageSize,
    navigationWidth: value.navigationWidth, expandedCategories: [...value.expandedCategories],
    openMenus: [...(value.openMenus ?? ['databases'])]
  }
}

export function workspaceLibraryKey(entry) {
  if (!entry.serverManaged) return undefined
  return entry.id.startsWith('file:') ? entry.id : entry.database
}

export function workspaceEntries(settings, entries) {
  if (!settings) return entries
  const byKey = new Map(entries.map(entry => [workspaceLibraryKey(entry), entry]))
  return settings.libraries.flatMap(key => byKey.has(key) ? [byKey.get(key)] : [])
}

export function workspaceEntryState(settings, entry, locallyDetached) {
  const published = settings ? settings.libraries.includes(workspaceLibraryKey(entry)) : undefined
  const detached = published ? false : locallyDetached
  const issue = entry.status === 'error' ? entry.issue || '服务器数据源不可用' : undefined
  return { published, detached, enabled: !detached && entry.enabled !== false && !issue, issue }
}
