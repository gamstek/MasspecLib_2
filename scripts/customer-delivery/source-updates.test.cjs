const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { sourceUpdates, nextMonthlyCheck } = require('./source-updates.cjs')

function setup(t, tasks, time) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'masspec-monthly-updates-'))
  const registry = path.join(directory, 'source-updates', 'tasks.json')
  fs.mkdirSync(path.dirname(registry))
  fs.writeFileSync(registry, JSON.stringify(tasks))
  const runs = []
  const open = () => sourceUpdates({
    directory, fileOp: async () => [],
    archive: { libraryId: 'file:archive', title: '自动更新谱库', ensure: async () => {} },
    clock: () => time.value,
    spawnJob: (_exe, [, folder]) => {
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      runs.push({ child, request: JSON.parse(fs.readFileSync(path.join(folder, 'request.json'))) })
      return child
    }
  })
  const updates = open()
  t.after(() => { updates.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { updates, open, runs, read: () => JSON.parse(fs.readFileSync(registry)),
    write: value => fs.writeFileSync(registry, JSON.stringify(value)) }
}
const november = '2026-11-25T05:00:00.000Z'
const decemberCheck = '2026-12-14T19:00:00.000Z'
const januaryCheck = '2027-01-14T19:00:00.000Z'
const februaryCheck = '2027-02-14T19:00:00.000Z'
const automatic = { id: 'aafc', sourceId: '1', scope: 'AAFC', libraryId: 'file:archive', enabled: true }

test('monthly checks follow the actual calendar and the Beijing time boundary', () => {
  const examples = {
    [november]: decemberCheck,
    '2026-12-14T18:59:59.999Z': decemberCheck,
    [decemberCheck]: januaryCheck,
    [januaryCheck]: februaryCheck,
    '2028-02-29T01:00:00.000Z': '2028-03-14T19:00:00.000Z'
  }
  for (const [date, next] of Object.entries(examples)) assert.equal(nextMonthlyCheck(Date.parse(date)), next)
})

test('legacy intervals migrate to the common monthly date and preserve paused and manual sources', async t => {
  const time = { value: Date.parse(november) }
  const { updates, read, runs } = setup(t, [
    { ...automatic, intervalHours: 24, nextRunAt: '2026-11-24T19:00:00.000Z' },
    { ...automatic, id: 'first-of-month', scope: 'First', schedule: 'monthly', nextRunAt: '2026-11-30T19:00:00.000Z' },
    { ...automatic, id: 'paused', scope: 'Other', enabled: false, intervalHours: 6, nextRunAt: november },
    { id: 'manual', sourceId: '7', intervalHours: 24, enabled: true, nextRunAt: november },
    { id: 'upload', uploaded: true, enabled: true, nextRunAt: november }
  ], time)
  const [enabled, moved, paused, manual, upload] = read()
  for (const task of [enabled, moved]) {
    assert.equal(task.intervalHours, undefined)
    assert.equal(task.schedule, 'monthly-15')
    assert.equal(task.nextRunAt, decemberCheck)
  }
  for (const task of [paused, manual, upload]) assert.equal(task.nextRunAt, undefined)
  await updates.tick()
  assert.equal(runs.length, 0)
  const added = await updates.configure({ sourceId: '1', scope: 'New', intervalHours: 1 })
  assert.equal(added.nextRunAt, decemberCheck)
  assert.equal(added.intervalHours, undefined)
  assert.equal(added.libraryId, 'file:archive')
})

test('an automatic check runs once per cycle, with explicit retry and resumed download files', async t => {
  const time = { value: Date.parse(november) }
  const { updates, runs, read, write, open } = setup(t, [automatic], time)
  time.value = Date.parse(decemberCheck)
  await updates.tick()
  assert.equal(runs.length, 1)
  assert.equal(read()[0].nextRunAt, januaryCheck)

  runs[0].child.emit('close', 1)
  assert.ok(read()[0].failedBatchId)
  assert.equal(read()[0].nextRunAt, januaryCheck)
  time.value += 60 * 60 * 1000
  await updates.tick()
  assert.equal(runs.length, 1)

  await updates.check({ taskId: automatic.id })
  assert.equal(runs.length, 2)
  assert.equal(runs[1].request.batchId, runs[0].request.batchId)
  assert.equal(read()[0].nextRunAt, januaryCheck)

  runs[1].child.emit('close', 1)
  const [interrupted] = read()
  delete interrupted.failedBatchId
  write([{ ...interrupted, running: true, runningBatchId: runs[1].request.batchId }])
  updates.close()
  const restarted = open()
  try {
    await restarted.tick()
    assert.equal(runs.length, 2)
    assert.equal(read()[0].nextRunAt, januaryCheck)
    assert.equal(read()[0].running, false)
    assert.equal(read()[0].failedBatchId, runs[1].request.batchId)
    time.value = Date.parse(januaryCheck) + 8 * 60 * 60 * 1000
    await restarted.tick()
    assert.equal(runs.length, 3)
    assert.equal(read()[0].nextRunAt, februaryCheck)
    runs[2].child.emit('close', 1)
  } finally {
    restarted.close()
  }
})
