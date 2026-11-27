const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { parseRecord, hash } = require('./massbank-record.cjs')
const { fail } = require('./policy.cjs')

function massbankUpdates({ directory, fileOp, libraryId }) {
  const folder = path.join(directory, 'massbank-pilot')
  const snapshot = path.join(folder, 'snapshot.json')
  let job
  const read = () => fs.existsSync(snapshot) ? JSON.parse(fs.readFileSync(snapshot, 'utf8')) : null
  const available = input => {
    if (!libraryId || input.libraryId !== libraryId) fail('此数据库未启用 MassBank 试用', 404)
  }
  function status(input) {
    if (!libraryId || (input.libraryId !== undefined && input.libraryId !== libraryId)) return { enabled: false }
    const saved = read()
    return { enabled: true, libraryId, version: saved?.version, commit: saved?.commit, checkedAt: saved?.checkedAt,
      running: job?.running || false, error: job?.error, sampleSize: saved?.records.length || 0 }
  }
  async function download(input) {
    available(input)
    if (job?.running) return status(input)
    await fileOp('massbankCompare', { libraryId, candidates: [] })
    if (job?.running) return status(input)
    job = { running: true }
    void (async () => {
      try {
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
        const previous = read()
        const { stdout } = await promisify(execFile)('python3', [
          '-B', path.join(__dirname, 'massbank-download.py'), path.join(folder, 'downloads'), '--previous', previous?.commit || ''
        ], { timeout: 300000, maxBuffer: 32 * 1024 * 1024 })
        const result = JSON.parse(stdout)
        if (result.unchanged) result.records = previous.records
        if (!Array.isArray(result.records) || !result.records.length) throw Error('没有已校验的谱图记录')
        for (const record of result.records) parseRecord(record, result.version)
        result.checkedAt = new Date().toISOString()
        fs.writeFileSync(snapshot + '.tmp', JSON.stringify(result), { mode: 0o600 })
        fs.renameSync(snapshot + '.tmp', snapshot)
        job = { running: false }
      } catch (error) {
        console.error('MassBank pilot download:', error.message.slice(0, 1000))
        job = { running: false, error: 'MassBank 获取或校验失败。已保留上次成功获取的批次，可重试。' }
      }
    })()
    return status(input)
  }
  async function compare(input, publish = false) {
    available(input)
    const saved = read()
    if (!saved) fail('请先检查更新并等待下载完成', 409)
    if (publish && (input.commit !== saved.commit || !Array.isArray(input.selected) || !input.selected.length || input.selected.length > 30))
      fail('候选批次已变化或未选择谱图，请重新核对', 409)
    const candidates = saved.records.map(record => parseRecord(record, saved.version))
    const options = { libraryId, candidates, ...publish && {
      selected: input.selected, revision: input.revision, actor: input.actor,
      hash: hash(JSON.stringify(['massbank-add', saved.commit, [...input.selected].sort()]))
    } }
    const result = await fileOp(publish ? 'massbankPublish' : 'massbankCompare', options)
    return { ...result, commit: saved.commit, version: saved.version }
  }
  return { status, download, compare }
}

module.exports = { massbankUpdates }
