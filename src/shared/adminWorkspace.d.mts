export interface AdminWorkspace {
  schemaVersion: 1
  libraries: string[]
  removedLibraries?: string[]
  defaultLibrary: string | null
  columns: string[]
  pageSize: number
  navigationWidth: number
  expandedCategories: string[]
  openMenus: string[]
}
interface WorkspaceEntry {
  id: string
  serverManaged?: boolean
  database?: string
  enabled?: boolean
  status?: string
  issue?: string
}
export function parseAdminWorkspace(value: unknown): AdminWorkspace
export function workspaceLibraryKey(entry: WorkspaceEntry): string | undefined
export function workspaceEntries<T extends WorkspaceEntry>(settings: AdminWorkspace | undefined, entries: T[]): T[]
export function workspaceEntryState(settings: AdminWorkspace | undefined, entry: WorkspaceEntry, locallyDetached: boolean): {
  published: boolean | undefined
  detached: boolean
  enabled: boolean
  issue: string | undefined
}
