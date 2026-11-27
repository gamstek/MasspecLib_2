const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { fail } = require('./policy.cjs')

const chunkBytes = 4 * 1024 * 1024
const maxBytes = 2 * 1024 * 1024 * 1024
const expiryMs = 24 * 60 * 60 * 1000
const uploadId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const sqliteHeader = Buffer.from('SQLite format 3\0')

function databaseUploads(root) {
  const validating = new Set()
  const paths = id => {
    if (!uploadId.test(id)) fail('上传编号无效')
    const folder = path.join(root, id)
    return { folder, pending: path.join(folder, 'upload.json'), partial: path.join(folder, 'database.part') }
  }
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
  function get(owner, id) {
    const p = paths(id)
    if (!fs.existsSync(p.pending)) fail('上传已结束或不存在', 404)
    const metadata = read(p.pending)
    if (metadata.owner !== owner) fail('上传不存在', 404)
    return { ...p, ...metadata }
  }
  function discardFiles(p) {
    fs.rmSync(p.partial, { force:true })
    fs.rmSync(p.pending, { force:true })
    // An unrelated file appearing in this folder must be left intact.
    try { fs.rmdirSync(p.folder) } catch (error) {
      if (!['ENOENT','ENOTEMPTY'].includes(error.code)) throw error
    }
  }
  function start(owner, { filename, bytes } = {}) {
    if (typeof filename !== 'string' || !/\.sqlite$/iu.test(filename) ||
      /[<>:"/\\|?*\x00-\x1f]/u.test(filename) || Buffer.byteLength(filename) > 220)
      fail('请选择 SQLite 数据库文件（.sqlite）')
    if (!Number.isSafeInteger(bytes) || bytes < 100 || bytes > maxBytes)
      fail('本机上传支持不超过 2 GiB 的 SQLite 文件。较大的库请先传到服务器。', 413)
    fs.mkdirSync(root, { recursive:true, mode:0o750 })
    let reserved = 0
    let count = 0
    for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
      if (!entry.isDirectory() || !uploadId.test(entry.name)) continue
      const p = paths(entry.name)
      if (!fs.existsSync(p.pending) || !fs.existsSync(p.partial)) continue
      if (!validating.has(entry.name) && Date.now() - fs.statSync(p.pending).mtimeMs > expiryMs) {
        discardFiles(p)
        continue
      }
      const metadata = read(p.pending)
      reserved += metadata.bytes * 2 - fs.statSync(p.partial).size
      count++
    }
    if (count >= 3) fail('服务器同时有多个文件正在上传，请稍后重试', 409)
    const disk = fs.statfsSync(root)
    // Reserve space for one full managed copy and a working margin.
    if (disk.bavail * disk.bsize - reserved < bytes * 2 + 1024 ** 3)
      fail('服务器可用空间不足，无法上传并建立文件库', 409)
    const id = randomUUID(), p = paths(id)
    fs.mkdirSync(p.folder, { mode:0o700 })
    try {
      fs.writeFileSync(p.partial, '', { flag:'wx', mode:0o600 })
      fs.writeFileSync(p.pending, JSON.stringify({ owner, filename, bytes }), { flag:'wx', mode:0o600 })
    } catch (error) {
      discardFiles(p)
      throw error
    }
    return { id, chunkBytes }
  }
  async function append(owner, id, offset, req) {
    get(owner, id)
    const length = Number(req.headers['content-length'])
    if (!Number.isSafeInteger(length) || length < 1 || length > chunkBytes) fail('无效的上传分块长度', 413)
    const chunks = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.length
      if (received > length) fail('上传分块超过约定长度', 413)
      chunks.push(chunk)
    }
    if (received !== length) fail('上传分块不完整')
    const p = get(owner, id)
    if (!Number.isSafeInteger(offset) || offset !== fs.statSync(p.partial).size || offset + received > p.bytes ||
      validating.has(id)) fail('上传进度已变化，请重新上传该文件', 409)
    const data = Buffer.concat(chunks, received)
    if (offset === 0 && !data.subarray(0, sqliteHeader.length).equals(sqliteHeader))
      fail('文件不是 SQLite 数据库')
    try { fs.appendFileSync(p.partial, data) }
    catch(error) { fs.truncateSync(p.partial, offset); throw error }
    const now = new Date()
    fs.utimesSync(p.pending, now, now)
    return { received:offset + received }
  }
  async function finish(owner, id, checkFormat, authenticate) {
    const p = get(owner, id)
    if (validating.has(id) || fs.statSync(p.partial).size !== p.bytes) fail('文件尚未完整上传或正在检查', 409)
    validating.add(id)
    try {
      const report = await checkFormat({ directory:p.partial })
      authenticate()
      if (report.status !== 'ready') {
        discardFiles(p)
        return { ...report, title:p.filename, directory:'' }
      }
      const file = path.join(p.folder, p.filename)
      if (fs.existsSync(file)) fail('上传目录已有同名文件', 409)
      fs.renameSync(p.partial, file)
      fs.rmSync(p.pending)
      const title = ['lds-cn','unified-sqlite'].includes(report.adapter) ? path.parse(p.filename).name : report.title
      return { ...report, directory:file, title }
    } finally { validating.delete(id) }
  }
  function cancel(owner, id) {
    const p = get(owner, id)
    if (validating.has(id)) fail('服务器正在检查文件，请稍候', 409)
    discardFiles(p)
    return { cancelled:true }
  }
  return { root, start, append, finish, cancel, maxBytes }
}
module.exports = { databaseUploads }
