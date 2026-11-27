import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, verify } from 'node:crypto'
import { open } from 'node:fs/promises'
import { promisify } from 'node:util'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const magic = Buffer.from('MSLOFF3\n')
const prefixSize = magic.length + 4
const maxHeader = 8 * 1024 * 1024
const maxData = 360 * 1024 * 1024
const derive = promisify(scrypt)
const format = 'MasspecLib2-indexed-delivery'

function validateLogin(username, password) {
  return typeof username === 'string' && username.trim() &&
    typeof password === 'string' && password.length >= 8 && password.length <= 128
}
function keyFor(password, salt) {
  return derive(password, Buffer.from(salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}
function aad(p, kind, id = '') {
  return Buffer.from(JSON.stringify([p.format, p.tenantId, p.releaseId, p.username, p.expiresAt, p.salt, kind, id]))
}
function seal(value, key, p, kind, id) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(p, kind, id))
  const data = deflateRawSync(Buffer.from(JSON.stringify(value)), { level: 1 })
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}
function unseal(frame, key, p, kind, id) {
  const decipher = createDecipheriv('aes-256-gcm', key, frame.subarray(0, 12))
  decipher.setAAD(aad(p, kind, id))
  decipher.setAuthTag(frame.subarray(12, 28))
  const data = Buffer.concat([decipher.update(frame.subarray(28)), decipher.final()])
  return JSON.parse(inflateRawSync(data, { maxOutputLength: maxData }).toString('utf8'))
}
async function read(handle, length, position) {
  const output = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await handle.read(output, offset, length - offset, position + offset)
    if (!bytesRead) throw Error('交付文件不完整')
    offset += bytesRead
  }
  return output
}
const range = (start, length, limit) => Number.isSafeInteger(start) && Number.isSafeInteger(length) &&
  start >= 0 && length >= 28 && start + length <= limit

// A signed header and separately authenticated frames keep login and random reads independent of the snapshot size.
export async function writeIndexedOffline(bodyFile, { tenantId, manifest, expiresAt, records, summarize, project }, username, password, signHeader, signal) {
  if (!validateLogin(username, password)) throw Error('离线账号或密码无效')
  const p = { format, formatVersion: 3, tenantId, releaseId: manifest.id, username: username.trim(), expiresAt: expiresAt || null, salt: randomBytes(16).toString('hex') }
  const key = await keyFor(password, p.salt)
  let handle
  try {
    handle = await open(bodyFile, 'wx', 0o600)
    const rows = [], bodyHash = createHash('sha256')
    let bytes = 0
    async function add(value, kind, id) {
      const frame = seal(value, key, p, kind, id), start = bytes
      if (bytes + frame.length > maxData) throw Error('离线数据超过安装包支持的体积，请缩小交付范围')
      await handle.writeFile(frame)
      bodyHash.update(frame)
      bytes += frame.length
      return [start, frame.length]
    }
    for (const record of records) {
      signal?.throwIfAborted()
      const detail = await add(record, 'detail', record.id)
      const projection = project(record)
      rows.push({ ...summarize(record), detail, ...(projection ? { list: await add(projection, 'list', record.id) } : {}) })
    }
    const index = await add(rows, 'index')
    const metadata = seal({ manifest, index }, key, p, 'metadata').toString('base64')
    const header = Buffer.from(JSON.stringify(signHeader({ ...p, bodyBytes: bytes, bodySha256: bodyHash.digest('hex'), metadata })))
    if (header.length > maxHeader) throw Error('安装包配置过大')
    const prefix = Buffer.alloc(prefixSize)
    magic.copy(prefix)
    prefix.writeUInt32BE(header.length, magic.length)
    return { prefix: Buffer.concat([prefix, header]), bodyBytes: bytes }
  } finally {
    key.fill(0)
    await handle?.close()
  }
}

export async function openIndexedOffline(file, publicKey, tenant, now = Date.now()) {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    if (size < prefixSize) { await handle.close(); return undefined }
    const prefix = await read(handle, prefixSize, 0)
    if (!prefix.subarray(0, magic.length).equals(magic)) { await handle.close(); return undefined }
    const length = prefix.readUInt32BE(magic.length), bodyOffset = prefixSize + length
    if (!length || length > maxHeader || bodyOffset > size) throw Error('加密交付文件结构无效')
    const { payload: p, signature } = JSON.parse((await read(handle, length, prefixSize)).toString('utf8'))
    if (!p || typeof signature !== 'string' || !verify(null, Buffer.from(JSON.stringify(p)), publicKey, Buffer.from(signature, 'base64'))) throw Error('交付文件签名验证失败')
    if (p.format !== format || p.formatVersion !== 3 || !p.tenantId || !p.releaseId || typeof p.username !== 'string' ||
        !/^[a-f0-9]{32}$/.test(p.salt) || !/^[a-f0-9]{64}$/.test(p.bodySha256) ||
        !range(0, p.bodyBytes, maxData) || size !== bodyOffset + p.bodyBytes) throw Error('加密交付文件结构无效')
    if (tenant && p.tenantId !== tenant) throw Error('交付文件不属于当前客户')
    const checkExpiry = (time = Date.now()) => {
      if (p.expiresAt && (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= time)) throw Error('离线交付已超过有效期')
    }
    checkExpiry(now)
    let key, meta, rows
    async function block(location, kind, id) {
      checkExpiry()
      if (!key || !Array.isArray(location) || !range(location[0], location[1], p.bodyBytes)) throw Error('交付文件索引无效')
      try { return unseal(await read(handle, location[1], bodyOffset + location[0]), key, p, kind, id) }
      catch { throw Error('交付数据校验失败，请联系管理员重新生成安装包') }
    }
    return {
      status: { username: p.username, tenantId: p.tenantId, releaseId: p.releaseId, expiresAt: p.expiresAt },
      async unlock(username, password) {
        checkExpiry()
        if (!validateLogin(username, password) || username.trim().toLowerCase() !== p.username.toLowerCase()) throw Error('本地账号或密码错误')
        const candidate = await keyFor(password, p.salt)
        try {
          meta = unseal(Buffer.from(p.metadata, 'base64'), candidate, p, 'metadata')
          if (meta.manifest?.id !== p.releaseId || !meta.manifest.policy?.features?.offline ||
              !Array.isArray(meta.index) || meta.index.length !== 2 || !range(meta.index[0], meta.index[1], p.bodyBytes)) throw Error('交付信息无效')
        } catch {
          candidate.fill(0)
          throw Error('本地账号或密码错误，或加密内容损坏')
        }
        key?.fill(0)
        key = candidate
        return { tenantId: p.tenantId, manifest: meta.manifest, expiresAt: p.expiresAt }
      },
      async rows() { checkExpiry(); return rows ??= await block(meta?.index, 'index') },
      detail: row => block(row.detail, 'detail', row.id),
      list: row => row.list ? block(row.list, 'list', row.id) : undefined,
      copyStream: () => handle.createReadStream({ start: 0, autoClose: false }),
      verifyCopy: hash => hash === p.bodySha256,
      bodyOffset,
      async close() { key?.fill(0); rows = undefined; meta = undefined; await handle.close() }
    }
  } catch (error) {
    await handle.close()
    throw error
  }
}
