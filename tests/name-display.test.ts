import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayNameLines } from '../src/shared/scientificDisplay.ts'
test('list names prefer Chinese then distinct English and never repeat the same value', () => {
  assert.deepEqual(
    displayNameLines({
      name_zh: '黄曲霉毒素M1',
      name_en: 'Aflatoxin M1',
      main_name: 'Aflatoxin M1'
    }),
    ['黄曲霉毒素M1', 'Aflatoxin M1']
  )
  assert.deepEqual(
    displayNameLines({ name_zh: null, name_en: 'Aflatoxin M1', main_name: 'Aflatoxin M1' }),
    ['Aflatoxin M1']
  )
  assert.deepEqual(displayNameLines({ name_zh: '中文', name_en: '中文', main_name: '中文' }), [
    '中文'
  ])
  assert.deepEqual(displayNameLines({ name_zh: '', name_en: null, main_name: null }), [])
})

test('the shared list formatter only falls back to main name when both language fields are missing', () => {
  assert.deepEqual(
    displayNameLines({
      name_zh: ' 黄曲霉毒素M1 ',
      name_en: ' Aflatoxin M1 ',
      main_name: 'Other main name'
    }),
    ['黄曲霉毒素M1', 'Aflatoxin M1']
  )
  assert.deepEqual(displayNameLines({ name_zh: ' ', name_en: null, main_name: ' Aflatoxin M1 ' }), [
    'Aflatoxin M1'
  ])
  assert.deepEqual(displayNameLines({ name_zh: '中文', main_name: 'Unclassified alias' }), ['中文'])
})
