import { invokeIPC } from './ipcInvoke'
export function scopedInvoke(
  connectionId: string | undefined,
  channel: string,
  ...args: unknown[]
): Promise<any> {
  return invokeIPC(channel, { __scope: 'masspeclib2', connectionId, args })
}
export function notifyDataChanged(): void {
  window.dispatchEvent(new Event('masspeclib2-data-changed'))
}

export const favoritesChangedEvent = 'masspeclib2-favorites-changed'
export function notifyFavoritesChanged(): void {
  window.dispatchEvent(new Event(favoritesChangedEvent))
}
