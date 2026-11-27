import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactive, ref } from 'vue'
import { ipcPayload, invokeIPC } from '../src/renderer/src/utils/ipcInvoke.ts'

test('startup filters with nested Vue connection arrays survive the Electron clone boundary', () => {
  const connections = ref<string[]>([])
  const filters = { connectionIds: connections.value, polarity: undefined, keyword: '' }
  assert.throws(() => structuredClone(filters), { name: 'DataCloneError' })
  assert.deepEqual(structuredClone(ipcPayload(filters)), filters)
  connections.value.push('A', 'B')
  assert.deepEqual(ipcPayload({ connectionIds: connections.value }).connectionIds, ['A', 'B'])
})

test('reactive detail forms preserve scientific zero, negatives, nulls and decimal text', () => {
  const input = reactive({
    ref: { connectionId: 'B', key: '1' },
    methods: [{ q1: '100.00000001', q3: null, dp: 0, ce: -15, missing: undefined }],
    spectra: [{ peaks: [{ mz: '100.0100', intensity: '100000' }] }],
    source: { name: 'MassBank / AAFC' },
    created: new Date('2026-10-14T00:00:00Z')
  })
  const payload = structuredClone(ipcPayload(input))
  assert.equal(payload.methods[0].dp, 0)
  assert.equal(payload.methods[0].ce, -15)
  assert.equal(payload.methods[0].q3, null)
  assert.ok(Object.hasOwn(payload.methods[0], 'missing'))
  assert.equal(payload.methods[0].missing, undefined)
  assert.equal(payload.methods[0].q1, '100.00000001')
  assert.equal(payload.spectra[0].peaks[0].mz, '100.0100')
  assert.deepEqual(payload.ref, { connectionId: 'B', key: '1' })
  assert.equal(payload.created.toISOString(), input.created.toISOString())
  payload.methods[0].ce = 20
  assert.equal(input.methods[0].ce, -15)
})

test('shared and cyclic plain data is preserved without mutating the form', () => {
  const item = reactive({ value: 0 })
  const graph: any = { first: item, second: item }
  graph.self = graph
  const payload = ipcPayload(graph)
  assert.equal(payload.first, payload.second)
  assert.equal(payload.self, payload)
})

test('all invoke arguments cross a clone-enforcing IPC mock including scoped envelopes', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const received: any[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    electron: { ipcRenderer: { invoke: async (channel: string, ...args: unknown[]) => {
      received.push({ channel, args: structuredClone(args) })
      return { ok: true }
    } } }
  } })
  try {
    await invokeIPC('federation:list', { connectionIds: ref<string[]>([]).value })
    await invokeIPC('connections:save', reactive({ name: '样例库', mapping: { table: 'compounds' } }))
    await invokeIPC('compound:update', { __scope: 'masspeclib2', connectionId: 'B', args: [reactive({ id: 1, ce: -15 })] })
    assert.equal(received.length, 3)
    assert.equal(received[2].args[0].args[0].ce, -15)
    await assert.rejects(invokeIPC('compound:update', { callback: () => 1 }), /compound:update/)
    assert.equal(received.length, 3)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
