import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export const packageStreamFormat = 'indexed-offline-v1'
export const packageStreamType = 'application/vnd.masspeclib2.package-stream'
const maxHeaderBytes = 256 * 1024
const maxOfflineBytes = 368 * 1024 * 1024

export async function packageStream(metadata, bodyFile, indexed, signHeader, signal) {
  const { prefix, bodyBytes } = indexed
  const bytes = prefix.length + bodyBytes
  if (bytes > maxOfflineBytes) throw new Error('离线数据超过安装包支持的体积，请缩小交付范围')
  const hash = createHash('sha256').update(prefix)
  for await (const chunk of createReadStream(bodyFile, { signal })) hash.update(chunk)
  const header = Buffer.from(JSON.stringify(signHeader({...metadata, offlineSha256:hash.digest('hex'), offlineBytes:bytes}))+ '\n')
  if (header.length > maxHeaderBytes) throw new Error('安装包配置过大')
  async function* chunks() {
    yield header
    yield prefix
    yield* createReadStream(bodyFile, { signal })
  }
  return { chunks: chunks(), bytes:header.length+bytes }
}

export async function savePackageStream(response, file, verifyHeader, onProgress = () => {}) {
  const hash = createHash('sha256')
  let header = Buffer.alloc(0), metadata, bytes = 0
  await pipeline(response, async function* (chunks) {
    for await (let chunk of chunks) {
      if (!metadata) {
        const newline = chunk.indexOf(10)
        const end = newline < 0 ? chunk.length : newline
        if (header.length + end >= maxHeaderBytes) throw new Error('安装包配置过大')
        header = Buffer.concat([header,chunk.subarray(0,end)])
        if (newline < 0) continue
        metadata = verifyHeader(JSON.parse(header.toString('utf8')))
        if (!Number.isSafeInteger(metadata?.offlineBytes) || metadata.offlineBytes < 1 ||
            metadata.offlineBytes > maxOfflineBytes || !/^[a-f0-9]{64}$/.test(metadata.offlineSha256))
          throw new Error('安装包配置中的数据校验信息无效')
        chunk = chunk.subarray(newline+1)
      }
      if (!chunk.length) continue
      bytes += chunk.length
      if (bytes > metadata.offlineBytes) throw new Error('客户离线数据体积不符')
      hash.update(chunk)
      onProgress(bytes,metadata.offlineBytes)
      yield chunk
    }
  }, createWriteStream(file,{mode:0o600,flags:'wx'}))
  if (!metadata || bytes !== metadata.offlineBytes || hash.digest('hex') !== metadata.offlineSha256)
    throw new Error('客户离线数据下载不完整或校验失败，请重新生成')
  return metadata
}
