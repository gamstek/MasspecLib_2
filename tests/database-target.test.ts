import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateDatabaseIdentity, validateDatabaseTarget, validateDatabaseStartupIdentity } from '../src/shared/databaseTarget.ts'

test('only MasspecLib2 target names are accepted', () => {
  for (const name of ['mspec_lib2', 'mspec_lib2_test_a'])
    assert.equal(validateDatabaseTarget(name), name)
  for (const name of [
    'mspec_lib',
    'mysql',
    'mspec_lib20',
    'mspec_lib2.old',
    'mspec_lib2;DROP DATABASE x'
  ]) {
    assert.throws(() => validateDatabaseTarget(name))
  }
})
test('product, model version and ready state must all agree', () => {
  validateDatabaseIdentity({ product: 'MasspecLib2', schema_version: 4, state: 'ready' })
  for (const metadata of [
    null,
    { product: 'MasspecLib', schema_version: 4, state: 'ready' },
    { product: 'MasspecLib2', schema_version: 2, state: 'ready' },
    { product: 'MasspecLib2', schema_version: 1, state: 'ready' },
    { product: 'MasspecLib2', schema_version: 4, state: 'incomplete' }
  ]) {
    assert.throws(() => validateDatabaseIdentity(metadata))
  }
})

test('ready legacy schemas can reach startup upgrade while write validation stays strict', () => {
  for (const version of [2, 3, 4]) {
    const metadata = { product: 'MasspecLib2', schema_version: version, state: 'ready' }
    validateDatabaseStartupIdentity(metadata)
    if (version < 4) assert.throws(() => validateDatabaseIdentity(metadata))
  }
  for (const metadata of [
    null,
    { product: 'MasspecLib', schema_version: 3, state: 'ready' },
    { product: 'MasspecLib2', schema_version: 1, state: 'ready' },
    { product: 'MasspecLib2', schema_version: 5, state: 'ready' },
    { product: 'MasspecLib2', schema_version: 3, state: 'pending' }
  ]) assert.throws(() => validateDatabaseStartupIdentity(metadata))
})
