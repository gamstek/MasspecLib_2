import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Each account and physical database has a separate durable draft namespace.
export class EditDrafts {
  constructor(directory) { this.directory = directory; this.busy = new Set() }
  folder(owner) { return join(this.directory, hash(owner)) }
  file(owner, target, key) { return join(this.folder(owner), hash([target, String(key)]) + '.json') }
  get(owner, target, key) {
    const file = this.file(owner, target, key)
    if (!existsSync(file)) return undefined
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value.schemaVersion !== 1) throw Error('草稿格式不受支持，请保留草稿并联系管理员')
    return value
  }
  list(owner) {
    const folder = this.folder(owner)
    if (!existsSync(folder)) return []
    return readdirSync(folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(folder, name), 'utf8')))
  }
  put(owner, target, key, value) {
    mkdirSync(this.folder(owner), { recursive: true })
    const bytes = JSON.stringify({ ...value, schemaVersion: 1, savedAt: new Date().toISOString() })
    if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw Error('单条草稿超过64MiB，请减少本次修改')
    const file = this.file(owner, target, key), temporary = file + '.' + randomUUID() + '.tmp'
    try { writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, file) }
    finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }
  remove(owner, target, key) {
    const file = this.file(owner, target, key)
    if (existsSync(file)) unlinkSync(file)
  }
  removeRef(owner, ref) {
    const folder = this.folder(owner)
    if (!existsSync(folder)) return
    for (const name of readdirSync(folder)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const file = join(folder, name), value = JSON.parse(readFileSync(file, 'utf8'))
      if (value.kind !== 'recovery' && value.ref?.connectionId === ref.connectionId && value.ref?.key === ref.key) {
        if (this.busy.has(file)) throw Error('此草稿正在保存或发布')
        unlinkSync(file)
        return
      }
    }
  }
  async locked(owner, target, key, action) {
    const lock = this.file(owner, target, key)
    if (this.busy.has(lock)) throw Error('此草稿正在保存或发布，请稍后重试')
    this.busy.add(lock)
    try { return await action() } finally { this.busy.delete(lock) }
  }
}
