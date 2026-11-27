/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IpcMain } from 'electron'
import { stageChange, registerPublishHandler } from '../services/pendingChanges'
import { administratorLoggedIn } from '../delivery'
import { withDatabase } from '../database'
const scoped =
  /^(compound:|compounds:|class:|lc-methods:|ms-methods:|spectrum-import:|spectrum:|import:|export:|compound-class:)/
const reads = new Set([
  'compound:detail',
  'compound:extensions',
  'compound:class-names',
  'compound:class:ids',
  'class:list',
  'class:customList',
  'compound:list',
  'compound:filter-options',
  'compounds:total-count',
  'lc-methods:list',
  'ms-methods:list',
  'import:preview',
  'spectrum-import:parse',
  'spectrum-import:validate'
])
export function installScopedIPC(ipcMain: IpcMain): void {
  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: any) => {
    const wrapped = async (event: any, ...incoming: any[]): Promise<any> => {
      if (administratorLoggedIn()) {
        const pending = await stageChange(channel, incoming)
        if (pending) return pending
      }
      const envelope = incoming[0]?.__scope === 'masspeclib2'
      const args = envelope ? incoming[0].args : incoming
      const id = envelope ? incoming[0].connectionId : undefined
      if (!scoped.test(channel)) return listener(event, ...args)
      if (channel === 'compound:update') {
        const { administratorLoggedIn, deliveryProfile } = await import('../delivery')
        if (deliveryProfile()?.edition === 'admin' || administratorLoggedIn()) {
          const { saveSqlDraft } = await import('../services/editDrafts')
          const { getState } = await import('./registry')
          const connectionId = id || getState().primaryId
          return saveSqlDraft({ connectionId, key: String(args[0]?.compound?.id) }, args[0])
        }
      }
      if(String(id).startsWith('file:')){const {fileScopedIPC}=await import('../services/fileScopedIPC');return fileScopedIPC(id!,channel,args)}
      return withDatabase(id, !reads.has(channel) && !channel.startsWith('export:'), () =>
        listener(event, ...args)
      )
    }
    registerPublishHandler(channel, wrapped)
    return original(channel, wrapped)
  }) as typeof ipcMain.handle
}
