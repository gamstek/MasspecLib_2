import type { AdminWorkspace } from '../../shared/adminWorkspace.mjs'

let settings: AdminWorkspace | undefined
export function adminWorkspace(): AdminWorkspace | undefined { return settings }
export function setAdminWorkspace(value: AdminWorkspace | undefined): void { settings = value }
