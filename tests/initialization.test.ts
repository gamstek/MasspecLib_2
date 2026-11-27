import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  splitInitializationSql,
  validateInitializationSql
} from '../src/shared/initializationSql.ts'

test('generated new schema and identity script satisfy the accepted SQL subset', () => {
  const sql = readFileSync('prisma/masspeclib2-initialize.sql', 'utf8')
  assert.ok(validateInitializationSql(sql).length >= 14)
})
test('semicolons and keywords in quoted content do not become executable statements', () => {
  const sql =
    "-- comment\nINSERT INTO compounds (main_name) VALUES ('USE old; DROP DATABASE old; 中文');"
  assert.equal(splitInitializationSql(sql).length, 1)
  assert.equal(validateInitializationSql(sql).length, 1)
})
test('database switching, cross-schema writes, executable comments and destructive SQL are rejected', () => {
  for (const sql of [
    'USE mspec_lib; INSERT INTO compounds (id) VALUES (1)',
    'INSERT INTO `mspec_lib`.`compounds` (id) VALUES (1)',
    'INSERT INTO mspec_lib.compounds (id) VALUES (1)',
    '/*!50000 DROP DATABASE mspec_lib */; INSERT INTO compounds (id) VALUES (1)',
    'DROP TABLE compounds; INSERT INTO compounds (id) VALUES (1)',
    'INSERT INTO compounds (id) SELECT 1',
    'INSERT INTO compounds (id) VALUES (SLEEP(10))',
    "INSERT INTO compounds (main_name) VALUES ('unclosed)"
  ])
    assert.throws(() => validateInitializationSql(sql), sql)
})
