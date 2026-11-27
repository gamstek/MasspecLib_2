import { randomBytes, createCipheriv, createDecipheriv, scrypt, verify } from 'node:crypto'
import { promisify } from 'node:util'
const derive = promisify(scrypt)
const format = 'MasspecLib2-encrypted-delivery', version = 2
function aad(p) { return Buffer.from(JSON.stringify([p.format,p.formatVersion,p.tenantId,p.releaseId,p.username,p.expiresAt,p.salt])) }
function check(p, tenant, now) {
  if (!p || p.format !== format || p.formatVersion !== version || !p.tenantId || !p.releaseId || typeof p.username !== 'string' || !/^[a-f0-9]{32}$/.test(p.salt) || !/^[a-f0-9]{24}$/.test(p.iv) || !/^[a-f0-9]{32}$/.test(p.tag) || typeof p.ciphertext !== 'string' || p.ciphertext.length > 360 * 1024 * 1024) throw Error('加密交付文件结构无效')
  if (tenant && p.tenantId !== tenant) throw Error('交付文件不属于当前客户')
  if (p.expiresAt && (!Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= now)) throw Error('离线交付已超过有效期')
}
export async function encryptOffline(data, username, password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || typeof username !== 'string' || !username.trim()) throw Error('离线账号或密码无效')
  data = { ...data, expiresAt: data.expiresAt || null }
  const p = { format, formatVersion:version, tenantId:data.tenantId, releaseId:data.manifest.id, username:username.trim(), expiresAt:data.expiresAt || null, salt:randomBytes(16).toString('hex'), iv:randomBytes(12).toString('hex'), tag:'', ciphertext:'' }
  const key = await derive(password,Buffer.from(p.salt,'hex'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024})
  try { const cipher=createCipheriv('aes-256-gcm',key,Buffer.from(p.iv,'hex'));cipher.setAAD(aad(p));p.ciphertext=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]).toString('base64');p.tag=cipher.getAuthTag().toString('hex');return p } finally { key.fill(0) }
}
export function inspectEncryptedOffline(envelope, publicKey, tenant, now=Date.now()) {
  if (!envelope?.payload || typeof envelope.signature !== 'string' || !verify(null,Buffer.from(JSON.stringify(envelope.payload)),publicKey,Buffer.from(envelope.signature,'base64'))) throw Error('交付文件签名验证失败')
  check(envelope.payload,tenant,now)
  return { username:envelope.payload.username,tenantId:envelope.payload.tenantId,releaseId:envelope.payload.releaseId,expiresAt:envelope.payload.expiresAt }
}
export async function decryptOffline(envelope, username, password, publicKey, tenant, now=Date.now()) {
  inspectEncryptedOffline(envelope,publicKey,tenant,now);const p=envelope.payload
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || typeof username !== 'string' || username.trim().toLowerCase() !== p.username.toLowerCase()) throw Error('本地账号或密码错误')
  const key=await derive(password,Buffer.from(p.salt,'hex'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});let data
  try {const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(p.iv,'hex'));decipher.setAAD(aad(p));decipher.setAuthTag(Buffer.from(p.tag,'hex'));data=JSON.parse(Buffer.concat([decipher.update(Buffer.from(p.ciphertext,'base64')),decipher.final()]).toString('utf8'))}catch{throw Error('本地账号或密码错误，或加密内容损坏')}finally{key.fill(0)}
  if (data?.format !== 'MasspecLib2-delivery' || data.tenantId !== p.tenantId || data.manifest?.id !== p.releaseId || data.expiresAt !== p.expiresAt || !Array.isArray(data.records)) throw Error('加密交付内容与签名身份不一致')
  return data
}
