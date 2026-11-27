import { toRaw } from 'vue'

// Electron cannot clone Vue proxies, including proxies nested inside plain DTOs.
// Preserve missing fields, null, zero, dates and shared references without JSON conversion.
export function ipcPayload<T>(value: T): T {
  const seen = new WeakMap<object, object>()
  function unwrap(input: unknown): unknown {
    if (input === null || typeof input !== 'object') return input
    const raw = toRaw(input)
    if (seen.has(raw)) return seen.get(raw)
    if (Array.isArray(raw)) {
      const result: unknown[] = new Array(raw.length)
      seen.set(raw, result)
      for (let i = 0; i < raw.length; i++) if (i in raw) result[i] = unwrap(raw[i])
      return result
    }
    const prototype = Object.getPrototypeOf(raw)
    if (prototype === Object.prototype || prototype === null) {
      const result: Record<string, unknown> = {}
      seen.set(raw, result)
      for (const key of Object.keys(raw)) {
        Object.defineProperty(result, key, {
          value: unwrap((raw as Record<string, unknown>)[key]),
          enumerable: true,
          writable: true,
          configurable: true
        })
      }
      return result
    }
    return raw
  }
  return structuredClone(unwrap(value)) as T
}

export async function invokeIPC(channel: string, ...args: unknown[]): Promise<any> {
  let payload: unknown[]
  try {
    payload = ipcPayload(args)
  } catch {
    throw new Error(`无法传递界面数据（${channel}），请检查输入内容`)
  }
  try { return await window.electron.ipcRenderer.invoke(channel, ...payload) }
  catch (error) { throw new Error(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')) }
}
