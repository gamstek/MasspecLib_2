function validateCatalog(categories) {
  const keys = new Set()
  for (const c of categories) { const key = JSON.stringify([c.namespace, c.category_code]); if (keys.has(key)) throw Error('分类编码重复'); keys.add(key) }
  for (const c of categories) if (c.parent_code && !keys.has(JSON.stringify([c.namespace, c.parent_code]))) throw Error('缺少父类别')
  const index = new Map(categories.map(c => [JSON.stringify([c.namespace,c.category_code]),c]))
  for (const item of categories) { const seen = new Set(); let c = item; while (c) { const key=JSON.stringify([c.namespace,c.category_code]); if(seen.has(key)) throw Error('分类目录存在父子循环'); seen.add(key); c=c.parent_code ? index.get(JSON.stringify([c.namespace,c.parent_code])) : null } }
}
module.exports = { validateCatalog }
