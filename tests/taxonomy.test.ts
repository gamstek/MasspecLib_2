import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCatalog, taxonomyKey, descendantCodes, buildCategoryTree, categoryPath } from '../src/shared/taxonomy.ts'
const catalog = [
  { namespace: 'unified-v2', axis: 'application', category_code: 'pesticides', category_name: '农药及农残' },
  { namespace: 'unified-v2', axis: 'application', category_code: 'insecticides', category_name: '杀虫剂', parent_code: 'pesticides' },
  { namespace: 'unified-v2', axis: 'chemical_structure', category_code: 'structure', category_name: '结构候选', parent_code: 'pesticides' }
]
test('catalog preserves hierarchy, descendants, stable cross-database key and full path', () => {
  validateCatalog(catalog)
  assert.equal(taxonomyKey('unified-v2','pesticides'), taxonomyKey('unified-v2','pesticides'))
  assert.deepEqual([...descendantCodes(catalog,'unified-v2','pesticides')], ['pesticides','insecticides','structure'])
  assert.equal(categoryPath(catalog,'unified-v2','insecticides'),'农药及农残 / 杀虫剂')
  const tree = buildCategoryTree(catalog, () => 1000000001)
  assert.equal(tree[0].children[0].children.length,2)
})
test('missing parent, duplicate codes, cycles and invalid axes are rejected', () => {
  assert.throws(() => validateCatalog([...catalog, catalog[0]]))
  assert.throws(() => validateCatalog([{...catalog[0],parent_code:'missing'}]))
  assert.throws(() => validateCatalog([{...catalog[0],parent_code:'insecticides'},catalog[1]]))
  assert.throws(() => validateCatalog([{...catalog[0],axis:'invented'}]))
})
