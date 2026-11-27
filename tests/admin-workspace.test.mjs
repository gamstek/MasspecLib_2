import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAdminWorkspace, workspaceEntries, workspaceEntryState } from '../src/shared/adminWorkspace.mjs'

const file = 'file:0f603299-1bab-46d1-9f70-99870b7f2190'
const sql = 'mspec_lib2_shared_ff143ed6f54e6f0e7b85'
const document = { schemaVersion: 1, libraries: [sql, file], defaultLibrary: sql,
  columns: ['name_en', 'cas', 'mrm1'], pageSize: 50, navigationWidth: 235, expandedCategories: [] }

test('only the centrally selected libraries are used, in the same order on fresh and upgraded clients', () => {
  const settings = parseAdminWorkspace(document)
  const mysql = { id: 'client-sql', database: sql, serverManaged: true }
  const sqlite = { id: file, serverManaged: true }
  const local = { id: 'local', database: sql, serverManaged: false }
  const legacy = { id: 'test', database: 'mspec_lib2_shared_a0c36b841d1e04c5c203', serverManaged: true }
  assert.deepEqual(workspaceEntries(settings, [local, sqlite, legacy, mysql]), [mysql, sqlite])
  assert.deepEqual(workspaceEntries(settings, [mysql, sqlite]), [mysql, sqlite])
})

test('a failed file remains registered but cannot appear enabled or contribute a ready count', () => {
  const state = workspaceEntryState(parseAdminWorkspace(document),
    { id: file, serverManaged: true, status: 'error', issue: '文件缺失' }, true)
  assert.deepEqual(state, { published: true, detached: false, enabled: false, issue: '文件缺失' })
})

test('malformed policy fails rather than falling back to historical settings', () => {
  for (const patch of [{ libraries: [] }, { libraries: [file, file] },
    { defaultLibrary: 'unknown' }, { columns: ['unknown'] }, { pageSize: 2 },
    { libraries: [sql, '/local/db.sqlite'] }, { navigationWidth: 999 }]) {
    assert.throws(() => parseAdminWorkspace({ ...document, ...patch }))
  }
})
