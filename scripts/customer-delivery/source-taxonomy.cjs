const { fail } = require('./policy.cjs')

const gravityFile = '/workspace/DATA/引力波质谱数据库.sqlite'
const rootOrder = ['tree_bio', 'tree_chem', 'tree_natural', 'tree_environment', 'drugs', 'pesticides',
  'tree_cosmetics', 'tree_food', 'industrial', 'veterinary', 'toxins']
const sourceNamespace = entry => 'sqlite-native:' + entry.id
const hasSourceTaxonomy = entry => entry.origin === gravityFile

function sourceTree(db) {
  const categories = db.prepare(`SELECT CAST(分类ID AS TEXT) id, CAST(父类ID AS TEXT) parent,
    分类编码 code, 分类名称 name FROM 分类字典 ORDER BY 分类ID`).all()
  const byId = new Map(categories.map(category => [category.id, category]))
  const rootFor = category => {
    const seen = new Set()
    let current = category
    while (current?.parent) {
      if (seen.has(current.id)) fail('源库分类字典存在循环')
      seen.add(current.id)
      current = byId.get(current.parent)
    }
    return current
  }
  return categories.filter(category => rootOrder.includes(rootFor(category)?.code))
    .sort((a,b) => rootOrder.indexOf(rootFor(a).code) - rootOrder.indexOf(rootFor(b).code))
}

function sourceCategoryFilter(db, entry, key) {
  if (typeof key !== 'string' || !key.startsWith('["sqlite-native:')) return null
  let namespace, id
  try { [namespace, id] = JSON.parse(key) } catch { fail('源库分类键无效') }
  if (namespace !== sourceNamespace(entry) || !hasSourceTaxonomy(entry)) return { where: '0', params: [] }
  if (!sourceTree(db).some(category => category.id === id)) fail('源库分类不存在，请刷新分类列表')
  return {
    where: `c.id IN (WITH RECURSIVE branch(id) AS (
      SELECT CAST(? AS INTEGER) UNION SELECT child.分类ID FROM 分类字典 child JOIN branch ON child.父类ID=branch.id
    ) SELECT assignment.化合物ID FROM branch JOIN 化合物分类 assignment ON assignment.分类ID=branch.id)`,
    params: [id],
  }
}

function sourceCategories(db, entry) {
  const tree = sourceTree(db)
  const namespace = sourceNamespace(entry)
  const catalog = tree.map(category => ({ namespace, category_code:category.id,
    category_name: category.code === 'tree_chem' ? `${category.name}（含下属细类）` : category.name,
    parent_code:category.parent, axis:'source_taxonomy', fixed:true }))
  const counts = {}
  if (tree.length) {
    const seeds = tree.map(() => 'SELECT CAST(? AS INTEGER)').join(' UNION ALL ')
    for (const row of db.prepare(`WITH RECURSIVE selected(id) AS (${seeds}), branch(node,id) AS (
      SELECT id,id FROM selected UNION SELECT branch.node,child.分类ID FROM 分类字典 child JOIN branch ON child.父类ID=branch.id
    ) SELECT CAST(branch.node AS TEXT) node,COUNT(DISTINCT k.化合物ID) n
      FROM branch JOIN 化合物分类 k ON k.分类ID=branch.id
      JOIN 化合物 c ON c.化合物ID=k.化合物ID LEFT JOIN work.changes w ON w.id=c.化合物ID AND w.added=0
      WHERE coalesce(w.state,'active')='active' GROUP BY branch.node`).all(...tree.map(category => category.id))) {
      counts[JSON.stringify([namespace,row.node])] = row.n
    }
  }
  return { catalog, counts, groupCounts:{}, remainders:{}, pending:0 }
}

module.exports = { hasSourceTaxonomy, sourceCategories, sourceCategoryFilter }
