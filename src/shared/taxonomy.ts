export const AXIS_LABELS: Record<string, string> = {
  application: '用途分类', origin: '生物来源',
  chemical_structure: '结构分类', biological_role: '生物作用',
  source_taxonomy: '来源分类', source_scope: '来源专题', unresolved: '待分类'
}
export interface TaxonomyCategory {
  namespace: string
  category_code: string
  category_name: string
  axis: string
  parent_code?: string | null
  description?: string | null
  status?: string
}
export interface Classification {
  namespace: string
  category_code: string
  evidence?: Record<string, unknown>[]
}
export interface CategoryTreeNode {
  key: string
  label: string
  id: number
  children: CategoryTreeNode[]
  databaseId?: string
  count?: number
}
export function taxonomyKey(namespace: string, code: string): string {
  return JSON.stringify(['taxonomy-v1', namespace, code])
}
export function validateCatalog(catalog: TaxonomyCategory[]): void {
  if (!Array.isArray(catalog)) throw new Error('统一分类目录必须是数组')
  const index = new Map<string, TaxonomyCategory>()
  for (const item of catalog) {
    for (const [key, max] of [['namespace', 64], ['category_code', 100], ['category_name', 255], ['axis', 64]] as const)
      if (typeof item?.[key] !== 'string' || !item[key].trim() || item[key].length > max) throw new Error(`分类 ${key} 为空或过长`)
    if (item.parent_code != null && (typeof item.parent_code !== 'string' || !item.parent_code.trim() || item.parent_code.length > 100)) throw new Error('分类父编码无效')
    if (!AXIS_LABELS[item.axis]) throw new Error(`不支持的分类维度：${item.axis}`)
    const key = taxonomyKey(item.namespace, item.category_code)
    if (index.has(key)) throw new Error('分类命名空间及编码重复')
    index.set(key, item)
  }
  for (const item of catalog) {
    const seen = new Set<string>(); let current: TaxonomyCategory | undefined = item
    while (current) {
      const key = taxonomyKey(current.namespace, current.category_code)
      if (seen.has(key)) throw new Error('分类目录存在父子循环')
      seen.add(key)
      if (!current.parent_code) break
      current = index.get(taxonomyKey(current.namespace, current.parent_code))
      if (!current) throw new Error('分类目录缺少父节点')
    }
  }
}
export function descendantCodes(catalog: TaxonomyCategory[], namespace: string, code: string): Set<string> {
  const result = new Set([code]); let size = 0
  while (size !== result.size) {
    size = result.size
    for (const item of catalog) if (item.namespace === namespace && item.parent_code && result.has(item.parent_code)) result.add(item.category_code)
  }
  return result
}
export function categoryPath(catalog: TaxonomyCategory[], namespace: string, code: string): string {
  const result: string[] = [], seen = new Set<string>()
  let current = catalog.find(x => x.namespace === namespace && x.category_code === code)
  while (current && !seen.has(current.category_code)) {
    seen.add(current.category_code); result.unshift(current.category_name)
    current = catalog.find(x => x.namespace === namespace && x.category_code === current!.parent_code)
  }
  return result.join(' / ')
}
export function buildCategoryTree(catalog: TaxonomyCategory[], idForKey: (key: string) => number): CategoryTreeNode[] {
  validateCatalog(catalog)
  const roots: CategoryTreeNode[] = [], index = new Map<string, CategoryTreeNode>(), axes = new Map<string, CategoryTreeNode>()
  for (const item of catalog) {
    const key = taxonomyKey(item.namespace, item.category_code)
    index.set(key, { key, label: item.category_name, id: idForKey(key), children: [] })
  }
  for (const item of catalog) {
    const node = index.get(taxonomyKey(item.namespace, item.category_code))!
    if (item.parent_code) index.get(taxonomyKey(item.namespace, item.parent_code))!.children.push(node)
    else {
      // Preserve source hierarchy even where a child's axis differs from its parent.
      let axis = axes.get(item.axis)
      if (!axis) { axis = { key: 'axis:' + item.axis, label: AXIS_LABELS[item.axis], id: 0, children: [] }; axes.set(item.axis, axis); roots.push(axis) }
      axis.children.push(node)
    }
  }
  return catalog.some((c:any)=>c.fixed)?roots.flatMap(r=>r.children):roots
}
