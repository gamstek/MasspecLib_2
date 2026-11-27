const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash, randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { signature } = require('./unified-sqlite.cjs')
const { fail } = require('./policy.cjs')

const references = [
  { name:'source_rows', table:'来源记录', id:'来源记录ID', view:'source_by_compound' },
  { name:'mrm_rows', table:'MRM参数', id:'MRM记录ID', view:'mrm_by_compound' },
  { name:'category_rows', table:'化合物分类', id:'分类记录ID', view:'category_by_compound' },
  { name:'spectrum_links', table:'关联关系', id:'关联ID', view:'links_by_compound' }
]

function indexPath(root, entry) {
  const version = createHash('sha256').update(JSON.stringify([entry.origin,entry.sourceSignature,1])).digest('hex').slice(0,20)
  return path.join(root,'libraries',entry.id,'detail-index-'+version+'.sqlite')
}

function buildDetailIndex(root, entry) {
  const file = indexPath(root, entry)
  if (fs.existsSync(file)) return file
  if (signature(entry.origin) !== entry.sourceSignature) fail('谱库文件已更新，请重新检查格式',409)
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700})
  const tmp = file+'.'+randomUUID()+'.tmp'
  const db = new DatabaseSync(tmp)
  try {
    db.exec('PRAGMA busy_timeout=3000')
    db.prepare('ATTACH DATABASE ? AS source').run(pathToFileURL(entry.origin).href+'?mode=ro')
    db.exec('BEGIN IMMEDIATE')
    for (const {name,table,id} of references) {
      db.exec(`CREATE TABLE "${name}" (compound_id INTEGER, source_id INTEGER, PRIMARY KEY (compound_id,source_id)) WITHOUT ROWID;
        INSERT INTO "${name}" SELECT 化合物ID,"${id}" FROM source."${table}" WHERE 化合物ID IS NOT NULL`)
    }
    if (signature(entry.origin) !== entry.sourceSignature) fail('建立查询索引期间源文件已变化，请重新关联',409)
    db.exec('COMMIT')
    db.close()
    fs.renameSync(tmp,file)
    return file
  } catch (error) {
    try { db.close() } catch {}
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    if (error.errcode === 5) fail('谱库文件正在写入或被锁定，请待写入完成后重新关联', 409)
    throw error
  }
}

function detailViews(db, root, entry) {
  const file = indexPath(root, entry)
  let indexed = fs.existsSync(file)
  if (indexed) {
    try { db.prepare('ATTACH DATABASE ? AS lookup').run(pathToFileURL(file).href + '?mode=ro&immutable=1') }
    catch (error) {
      if (fs.existsSync(file)) throw error
      indexed = false
    }
  }
  for (const {name,table,id,view} of references) {
    // Preserve index-first join order for single-compound lookups.
    db.exec(indexed
      ? `CREATE TEMP VIEW "${view}" AS SELECT i.compound_id AS lookup_compound_id, s.* FROM lookup."${name}" i
           CROSS JOIN main."${table}" s ON s."${id}"=i.source_id`
      : `CREATE TEMP VIEW "${view}" AS SELECT s.化合物ID AS lookup_compound_id, s.* FROM main."${table}" s`)
  }
}

function detailIndexInfo(root, entry) {
  const file = indexPath(root, entry)
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  return stat?.isFile() ? { version: path.basename(file).slice(13, -7), bytes: stat.size } : undefined
}

function pruneDetailIndexes(root, entry, previous) {
  const current = indexPath(root, entry)
  if (!fs.existsSync(current)) return
  const directory = path.dirname(current)
  const rollback = previous?.adapter === 'lds-cn' ? indexPath(root, previous) : current
  try {
    const obsolete = fs.readdirSync(directory, { withFileTypes: true }).filter(item =>
      item.isFile() && /^detail-index-[0-9a-f]{20}\.sqlite$/.test(item.name) &&
      path.join(directory, item.name) !== current)
    // On repeated registration keep the most recently built older index.
    obsolete.sort((a, b) => fs.statSync(path.join(directory, b.name)).mtimeMs -
      fs.statSync(path.join(directory, a.name)).mtimeMs)
    const keep = rollback === current ? obsolete[0]?.name : path.basename(rollback)
    for (const item of obsolete) {
      if (item.name === keep) continue
      try { fs.unlinkSync(path.join(directory, item.name)) }
      catch (error) { if (error.code !== 'ENOENT') console.warn('Index cleanup deferred:', error.code) }
    }
  } catch (error) { console.warn('Index cleanup deferred:', error.code) }
}

module.exports = { buildDetailIndex, detailViews, detailIndexInfo, pruneDetailIndexes }
