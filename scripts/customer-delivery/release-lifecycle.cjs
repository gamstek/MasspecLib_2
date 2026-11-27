const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { fail } = require('./policy.cjs')

async function changeRelease({ store, directory, id, action, confirmation, actor, authenticate }) {
  const moved=[]
  try {
    await store.mutate(d => {
      authenticate()
      const r = d.releases.find(x => x.id === id)
      if (!r) fail('交付版本不存在', 404)
      const target = { releaseId: r.id, title: r.title, version: r.version, tenantId: r.tenantId, total: r.total }
      if (action === 'delete') {
        if (r.state === 'deleted') fail('此版本已在回收站', 409)
        r.deletedFrom = r.state; r.state = 'deleted'; r.deletedAt = new Date().toISOString()
      } else if (action === 'restore') {
        if (r.state !== 'deleted') fail('只能恢复回收站中的版本', 409)
        r.state = 'draft'; delete r.deletedAt; delete r.deletedFrom; delete r.publishedAt
      } else if (action === 'purge') {
        if (r.state !== 'deleted') fail('请先将版本移入回收站', 409)
        if (confirmation !== true && confirmation !== `${r.title} ${r.version}`) fail('请确认删除此交付版本')
        const root=path.resolve(directory),snapshots=[...new Set([r.id,r.snapshotId,...(r.snapshotHistory||[]).map(h=>h.snapshotId)].filter(Boolean))]
        for(const snapshot of snapshots){
          if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshot))fail('交付版本目录无效')
          const original=path.resolve(root,snapshot)
          if(path.dirname(original)!==root)fail('交付版本目录无效')
          if(d.releases.some(other=>other.id!==r.id&&(other.id===snapshot||other.snapshotId===snapshot||(other.snapshotHistory||[]).some(h=>h.snapshotId===snapshot))))fail('交付快照仍被其他交付使用',409)
          if(fs.existsSync(original)){
            if(fs.lstatSync(original).isSymbolicLink()||fs.realpathSync(root)!==root)fail('交付目录不允许符号链接')
            const quarantine=path.join(root,`.purged-${snapshot}-${crypto.randomUUID()}`)
            fs.renameSync(original,quarantine);moved.push({original,quarantine})
          }
        }
        d.releases = d.releases.filter(x => x.id !== id)
        d.reviews = d.reviews.filter(x => x.releaseId !== id)
      } else fail('版本操作无效')
      store.event(actor, `${action}-release`, target)
    })
  } catch (e) {
    for(const {original,quarantine}of moved.reverse())fs.renameSync(quarantine,original)
    throw e
  }
  let cleanupPending=false
  for (const {quarantine}of moved) {
    try { fs.rmSync(quarantine, { recursive: true }) }
    catch (e) { console.error('release-purge-cleanup', path.basename(quarantine), e.message); cleanupPending=true }
  }
  return cleanupPending?{ok:true,cleanupPending:true}:{ok:true}
}
module.exports = { changeRelease }
