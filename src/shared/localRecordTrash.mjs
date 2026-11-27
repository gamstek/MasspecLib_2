import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Local changes contain identifiers only. Signed packaged records remain immutable.
export class LocalRecordTrash {
  constructor(root, tenantId) {
    if (!tenantId || typeof tenantId !== 'string') throw Error('缺少客户身份')
    this.file = path.join(root, 'record-workspaces', crypto.createHash('sha256').update(tenantId).digest('hex') + '.json')
  }
  read() {
    if (!fs.existsSync(this.file)) return { version: 1, records: {} }
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    if (data.version !== 1 || !data.records || Array.isArray(data.records) || Object.values(data.records).some(v => !['trash', 'purged'].includes(v))) throw Error('本机回收站状态损坏，请备份后联系管理员')
    return data
  }
  key(record, releaseId) { return record.stableId || `${releaseId}:${record.id}` }
  states(records, releaseId) {
    const state = this.read().records
    return Object.fromEntries(records.map(r => [r.id, state[this.key(r, releaseId)] || 'active']))
  }
  change(records, releaseId, ids, action) {
    if (!['delete', 'restore', 'purge'].includes(action) || !Array.isArray(ids) || !ids.length || ids.length > 20000 || new Set(ids).size !== ids.length) throw Error('记录操作无效')
    const data = this.read(), lookup = new Map(records.map(r => [r.id, r]))
    for (const id of ids) {
      const record = lookup.get(id)
      if (!record) throw Error('记录不存在，请刷新')
      const key = this.key(record, releaseId), state = data.records[key] || 'active'
      if (action === 'delete' ? state !== 'active' : state !== 'trash') throw Error('记录状态已变化，请刷新')
    }
    for (const id of ids) {
      const key = this.key(lookup.get(id), releaseId)
      if (action === 'restore') delete data.records[key]
      else data.records[key] = action === 'delete' ? 'trash' : 'purged'
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.' + crypto.randomUUID() + '.tmp'
    try { fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, this.file) }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
  }
}
