const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { Readable } = require('node:stream')
function publicationStore(directory) {
  const folder = path.join(directory, 'publication-results'), pending = new Map()
  const valid = id => typeof id === 'string' && /^[a-f0-9-]{36}(?:-\d+)?$/.test(id)
  const rejected = new Set([400, 403, 404, 409, 413, 422, 429])
  function file(owner, id) {
    if (!valid(id)) throw Object.assign(Error('发布编号无效'), { status: 400 })
    const key = crypto.createHash('sha256').update(owner + ':' + id).digest('hex')
    return path.join(folder, key + '.json')
  }
  function read(owner, id) {
    const target = file(owner, id)
    return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null
  }
  function save(owner, id, value) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    const target = file(owner, id), temp = target + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, target)
  }
  async function execute(owner, id, input, authorization, handler) {
    const target = file(owner, id)
    const digest = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const inProgress = pending.get(target)
    if (inProgress) {
      if (inProgress.digest !== digest) throw Object.assign(Error('发布内容已变化，请核对上次结果'), { status: 409, publicationState: 'uncertain' })
      return inProgress.task
    }
    const previous = read(owner, id)
    if (previous) {
      if (previous.digest !== digest) throw Object.assign(Error('发布内容已变化，请核对上次结果'), { status: 409, publicationState: 'uncertain' })
      const previousSuccess = previous.state === 'completed' && previous.status < 300
      if (previousSuccess) return previous
      const explicitRejection = previous.state === 'rejected' ||
        (previous.state === 'completed' && rejected.has(previous.status))
      if (!explicitRejection)
        throw Object.assign(Error('上次发布结果待核对，未重复执行'), { status: 409, publicationState: 'uncertain' })
    }
    if (input.method !== 'POST' || !/^\/admin\/(?:source-updates\/publish|massbank-update\/publish|file-sources\/(?:mutate|change|update-compound|default-major|restore|register|convert|create-import)|classification\/(?:category|category-status|mapping|default-major|role|assign|unlock))$/.test(input.route))
      throw Object.assign(Error('不支持此发布操作'), { status: 400 })
    const task = (async () => {
      save(owner, id, { state: 'running', digest })
      let response
      const req = Readable.from([Buffer.from(JSON.stringify(input.body || {}))])
      req.method = input.method; req.url = input.route
      req.published = true; req.headers = { authorization }; req.socket = { remoteAddress: 'publication' }
      const res = {
        destroyed: false, headersSent: false, status: 200,
        setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true },
        end(text) { response = { state: 'completed', status: this.status, data: JSON.parse(text), digest } },
        destroy() { this.destroyed = true }
      }
      await handler(req, res)
      if (!response) throw Error('发布响应未完成，请核对结果')
      if (response.status >= 300) {
        response.state = rejected.has(response.status) ? 'rejected' : 'uncertain'
        response.data = { ...response.data, publicationState: response.state }
      }
      save(owner, id, response)
      return response
    })()
    pending.set(target, { digest, task })
    try { return await task } finally { pending.delete(target) }
  }
  return { read, execute }
}
module.exports = { publicationStore }
