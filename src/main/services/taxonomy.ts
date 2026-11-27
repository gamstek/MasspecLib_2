/* eslint-disable @typescript-eslint/no-explicit-any */
import { taxonomyKey, validateCatalog, type TaxonomyCategory, type Classification } from '../../shared/taxonomy'
export async function ensureTaxonomyCatalog(tx: any, catalog: TaxonomyCategory[]): Promise<void> {
  validateCatalog(catalog)
  for (const item of catalog) {
    const existing = await tx.taxonomy_categories.findUnique({ where: { namespace_category_code: { namespace: item.namespace, category_code: item.category_code } } })
    if (existing) {
      if (existing.category_name !== item.category_name || existing.axis !== item.axis || (existing.parent_code ?? null) !== (item.parent_code ?? null))
        throw new Error(`分类目录冲突：${item.category_code}；需使用新的目录命名空间`)
    } else await tx.taxonomy_categories.create({ data: item })
  }
}
export async function saveClassifications(tx: any, compoundId: number, assignments: Classification[]): Promise<void> {
  if (!Array.isArray(assignments)) throw new Error('分类关联必须是数组')
  const existing = await tx.compound_taxonomy.findMany({ where: { compound_id: compoundId }, include: { category: true } })
  const previous = new Map(existing.map(x => [taxonomyKey(x.category.namespace, x.category.category_code), x.evidence]))
  const seen = new Set<string>(), selected: number[] = []
  for (const item of assignments) {
    const key = taxonomyKey(item.namespace, item.category_code)
    if (seen.has(key)) throw new Error('分类关联重复')
    seen.add(key)
    const category = await tx.taxonomy_categories.findUnique({ where: { namespace_category_code: { namespace: item.namespace, category_code: item.category_code } } })
    if (!category) throw new Error('分类不在当前数据库目录中')
    selected.push(category.id)
    await tx.compound_taxonomy.upsert({
      where: { compound_id_category_id: { compound_id: compoundId, category_id: category.id } },
      update: {}, // Editing membership must not erase imported evidence.
      create: { compound_id: compoundId, category_id: category.id, evidence: item.evidence ?? previous.get(key) ?? [{ evidence_type: 'manual_assignment', review_status: 'user_assigned' }] }
    })
  }
  await tx.compound_taxonomy.deleteMany({ where: { compound_id: compoundId, category_id: { notIn: selected } } })
}
export async function exportClassifications(tx: any, compoundId: number): Promise<Classification[]> {
  return (await tx.compound_taxonomy.findMany({ where: { compound_id: compoundId }, include: { category: true }, orderBy: { category_id: 'asc' } }))
    .map(x => ({ namespace: x.category.namespace, category_code: x.category.category_code, evidence: x.evidence ?? [] }))
}
export async function exportCatalog(tx: any): Promise<TaxonomyCategory[]> {
  return tx.taxonomy_categories.findMany({ select: { namespace: true, category_code: true, category_name: true, axis: true, parent_code: true, description: true, status: true }, orderBy: { id: 'asc' } })
}
