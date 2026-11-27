/* eslint-disable @typescript-eslint/no-explicit-any */
import { parentPort } from 'node:worker_threads'
import { createHash, verify } from 'node:crypto'
import { createWriteStream, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { openIndexedOffline } from '../shared/indexedOffline.mjs'
import { decryptOffline, inspectEncryptedOffline } from '../shared/offlineAccess.mjs'
import { OfflineWorkspace, legacyManifest, listProjector } from '../shared/offlineWorkspace.mjs'
import { LocalRecordTrash } from '../shared/localRecordTrash.mjs'
import { LocalReviews } from '../shared/localReviews.mjs'
import { deliverySql } from '../shared/deliverySql'
import { deliveryTabular } from '../shared/deliveryTabular'

type Settings = { file: string; root: string; publicKey: string; tenant?: string; release?: string; requireEncrypted: boolean }
let session: any, index: any, workspace: any, reviews: any, legacy: any, username = '', stateVersion = ''

function assertCurrent(feature?: string): void {
  if (!session) throw Error('请先登录客户账号')
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) throw Error('离线交付已超过有效期')
  if (feature && !session.manifest.policy.features[feature]) throw Error('管理员未开放此操作')
}
async function prepare(settings: Settings, credentials?: { username: string; password: string }, status = false): Promise<any> {
  const { file, publicKey, tenant, requireEncrypted, release, root } = settings
  const candidate = await openIndexedOffline(file, publicKey, tenant)
  let data, envelope
  try {
    if (candidate) {
      if (release && candidate.status.releaseId !== release) throw Error('交付文件与安装包配置不一致')
      if (status) return { protected: true, ...candidate.status }
      if (!credentials) throw Error('请先登录安装包本地账号')
      data = await candidate.unlock(credentials.username, credentials.password)
    } else {
      envelope = JSON.parse(await readFile(file, 'utf8'))
      if (envelope?.payload?.formatVersion === 2) {
        const info = inspectEncryptedOffline(envelope, publicKey, tenant)
        if (release && info.releaseId !== release) throw Error('交付文件与安装包配置不一致')
        if (status) return { protected: true, ...info }
        if (!credentials) throw Error('请先登录安装包本地账号')
        data = await decryptOffline(envelope, credentials.username, credentials.password, publicKey, tenant)
      } else {
        if (requireEncrypted || credentials) throw Error('安装包内置数据格式不符合登录配置')
        if (status) return { protected: false }
        data = envelope?.payload
        if (!data || !verify(null, Buffer.from(JSON.stringify(data)), publicKey, Buffer.from(envelope.signature || '', 'base64'))) throw Error('交付文件签名验证失败')
        if (data.format !== 'MasspecLib2-delivery' || data.formatVersion !== 1 || !data.manifest?.policy?.features?.offline ||
            !Array.isArray(data.records) || tenant && data.tenantId !== tenant ||
            data.expiresAt && (!Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now())) throw Error('离线交付文件不适用于此客户，或已超过有效期')
      }
      data = { ...data, manifest: legacyManifest(data) }
    }
    const next = { tenantId: data.tenantId, manifest: data.manifest, expiresAt: data.expiresAt }
    const trash = new LocalRecordTrash(root, next.tenantId)
    const nextWorkspace = new OfflineWorkspace({ manifest: next.manifest, trash,
      rows: candidate ? candidate.rows : () => data.records,
      detail: candidate ? candidate.detail : row => row,
      list: candidate ? candidate.list : listProjector(next.manifest)
    })
    await index?.close()
    index = candidate; legacy = envelope; session = next; workspace = nextWorkspace
    reviews = new LocalReviews(root, session.tenantId)
    username = credentials?.username.trim() || '客户账号'
    stateVersion = ''
    return { tenantId: session.tenantId, manifest: session.manifest }
  } finally {
    if (candidate && index !== candidate) await candidate.close()
  }
}
function refreshState(): void {
  const stat = statSync(workspace.trash.file, { bigint: true, throwIfNoEntry: false })
  const version = stat ? [stat.ino, stat.size, stat.mtimeNs].join(':') : ''
  if (stateVersion === version) return
  stateVersion = version
  workspace.states = undefined
  workspace.lastQuery = undefined
  workspace.classificationCache.clear()
}
async function exportOffline(input: any): Promise<void> {
  assertCurrent('export')
  if (input.releaseId !== session.manifest.id) throw Error('未开放离线导出')
  const { manifest } = session
  if (input.format === 'msldelivery') {
    if (!index) return writeFile(input.file, JSON.stringify(legacy), { mode: 0o600 })
    const hash = createHash('sha256')
    let skip = index.bodyOffset
    await pipeline(index.copyStream(), async function* (chunks) {
      for await (const chunk of chunks) {
        const offset = Math.min(skip, chunk.length)
        skip -= offset
        hash.update(chunk.subarray(offset))
        yield chunk
      }
    }, createWriteStream(input.file, { mode: 0o600 }))
    if (!index.verifyCopy(hash.digest('hex'))) throw Error('交付文件校验失败')
    assertCurrent('export')
    return
  }
  if (!Array.isArray(input.fields) || !input.fields.length || input.fields.some(key => !manifest.policy.fields.compound.includes(key))) throw Error('导出字段不在交付范围')
  const { matches } = await workspace.query({ ...input, trash: false })
  const records: any[] = []
  const detail = input.includeDetails === true
  for (const row of matches) {
    const requiresImage = input.fields.some(key => key.endsWith('base64') && !Object.hasOwn(row.compound, key))
    const record = detail || requiresImage ? await workspace.detail(row) : row
    const compound = Object.fromEntries(input.fields.map(key => [key, record.compound[key] ?? null]))
    records.push(detail ? { ...record, compound } : { id: row.id, sourceTitle: row.sourceTitle, compound })
  }
  const data = { manifest, records }
  const content = input.format === 'json' ? JSON.stringify(data) :
    input.format === 'sql' ? deliverySql(data, detail) : deliveryTabular(data, input.format, detail)
  assertCurrent('export')
  await writeFile(input.file, content, { mode: 0o600 })
}
async function run(action: string, input: any): Promise<any> {
  if (action === 'status' || action === 'login' || action === 'open') return prepare(input.settings, input.credentials, action === 'status')
  assertCurrent()
  if (action === 'authorize') { assertCurrent(input.feature); return true }
  refreshState()
  if (action === 'page') return workspace.page(input)
  if (action === 'record') {
    const row = await workspace.find(input)
    const record = await workspace.detail(row)
    return session.manifest.policy.features.checks ? { ...record, reviews: reviews.list(session.manifest.id, row.id) } : record
  }
  if (action === 'review') {
    assertCurrent('review')
    const row = await workspace.find(input.recordId)
    if (workspace.state(row) !== 'active') throw Error('记录不存在或已删除')
    return reviews.add(session.manifest.id, await workspace.detail(row), input, username)
  }
  if (action === 'change') {
    const feature = ({ delete: 'deleteRecords', restore: 'restoreRecords', purge: 'purgeRecords' })[input.action]
    if (!feature) throw Error('记录操作无效')
    assertCurrent(feature)
    await workspace.change(input.action, input.ids)
    return { changed: true }
  }
  if (action === 'export') return exportOffline(input)
  throw Error('离线操作无效')
}

let pending = Promise.resolve()
parentPort?.on('message', ({ id, action, input }) => {
  pending = pending.then(async () => {
    try { parentPort?.postMessage({ id, value: await run(action, input) }) }
    catch (error) { parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) }) }
  })
})
