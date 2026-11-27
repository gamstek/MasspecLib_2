import { shallowRef } from 'vue'
import type { AdminWorkspace } from '../../../shared/adminWorkspace.mjs'

export const adminWorkspace = shallowRef<(AdminWorkspace & { defaultConnectionId?: string })>()
