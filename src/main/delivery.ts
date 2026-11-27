/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseAdminWorkspace } from '../shared/adminWorkspace.mjs'
import { setAdminWorkspace } from './services/adminWorkspace'
import {personalFlat} from '../shared/personalFlat.mjs'
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron'
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync, createWriteStream, createReadStream } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { join, basename, extname } from 'node:path'
import { createHash, verify } from 'node:crypto'
import https from 'node:https'
import tls from 'node:tls'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { generateDeliveryWix } from '../shared/deliveryInstaller'
import { Client as SSHClient } from 'ssh2'
import * as XLSX from 'xlsx'
import { PersonalLibrary, personalOwner, localPersonalOwner, personalView,  readPersonalPackage } from '../shared/personalLibrary'
import { encodePackage } from '../shared/dataPackage'
import {deliverySql} from '../shared/deliverySql'
import { deliveryTabular } from '../shared/deliveryTabular'
import { queryOptions } from '../shared/deliveryQuery.mjs'
import { packageStreamFormat, packageStreamType, savePackageStream } from '../shared/deliveryPackageStream.mjs'

interface DeliveryProfile { instanceId?: string; accessMode?: 'online' | 'offline' | 'hybrid'; loginUsername?: string; enabled: boolean; edition: 'admin' | 'customer'; endpoint: string; certificateFingerprint: string; publicKey: string; tenantId?: string; customerName?: string; title?: string; defaultReleaseId?: string; allowOffline?: boolean; version?: string; gateway?: { username: string; password: string; port: number; hostFingerprint: string } }
let profile: DeliveryProfile | undefined
let databaseUploading = false
export async function publicationResult(id: string): Promise<any> {
  if (!administratorLoggedIn()) throw Error('请先登录管理员')
  return request('GET', '/admin/publication/' + id)
}
export async function publishRequest(method: string, route: string, body: any, id?: string): Promise<any> {
  if (!administratorLoggedIn()) throw Error('请先登录管理员')
  const { publishedOperationId } = await import('./services/pendingChanges')
  const mutation = method === 'POST' && /^\/admin\/(source-updates\/publish|massbank-update\/publish|file-sources\/(mutate|change|update-compound|default-major|restore|register|convert|create-import)|classification\/(category|category-status|mapping|default-major|role|assign|unlock))$/.test(route)
  const operation = id || (mutation ? publishedOperationId() : undefined)
  return operation && mutation
    ? request('POST', '/admin/publication/' + operation, { method, route, body }, { timeout: 610000 })
    : request(method, route, body, { timeout: 610000 })
}
export async function classificationRequest(method: string, route: string, body?: any): Promise<any> {
  if (!administratorLoggedIn()) throw new Error('请先登录管理员；分类配置需要新版服务器服务')
  if (!route.startsWith('/admin/classification/')) throw new Error('分类请求路径无效')
  return publishRequest(method, route, body)
}
export async function fileLibraryRequest(method: string, route: string, body?: any): Promise<any> {
  if (!administratorLoggedIn()) throw new Error('请先登录管理员')
  if (!route.startsWith('/admin/file-sources')) throw new Error('数据源请求路径无效')
  return publishRequest(method, route, body)
}
export async function loadAdminWorkspace() {
  if (!administratorLoggedIn()) throw new Error('请先登录管理员')
  const config = parseAdminWorkspace(await request('GET', '/admin/workspace'))
  setAdminWorkspace(config)
  return config
}
export function deliveryPackaging(): boolean { return packaging }
export function deliveryProfile(): DeliveryProfile | undefined {
  if (profile) return profile
  const file = process.env.MASSPECLIB2_DELIVERY_CONFIG || (app.isPackaged ? join(process.resourcesPath, 'delivery-profile.json') : join(app.getAppPath(), 'resources/delivery-profile.json'))
  if (!existsSync(file)) return undefined
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed.enabled) return undefined
  if (!['admin', 'customer'].includes(parsed.edition)) throw new Error('软件版本配置无效')
  profile = parsed
  return profile
}
let offlineSession: any, pendingPersonal: any, lastPackageFile = ''
let offlineEpoch = 0, offlineAttempts = 0, offlineAttemptUntil = 0, offlineId = 0
let offlineWorker: Worker | undefined, localLoginPending = false
const offlineRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
async function stopOffline(): Promise<void> {
  const worker = offlineWorker
  offlineWorker = undefined; offlineSession = undefined; ++offlineEpoch
  const pending = [...offlineRequests.values()]
  offlineRequests.clear()
  try { await worker?.terminate() }
  finally { for (const request of pending) request.reject(Error('离线操作已取消')) }
}
function offlineCall(action: string, input?: any): Promise<any> {
  if (deliveryProfile()?.edition !== 'customer') throw Error('仅客户端支持本地交付')
  if (!offlineWorker) {
    const worker = new Worker(join(__dirname, 'offline-delivery-worker.js'))
    offlineWorker = worker
    worker.on('message', ({ id, error, value }) => {
      const request = offlineRequests.get(id)
      offlineRequests.delete(id)
      if (error) request?.reject(Error(error))
      else request?.resolve(value)
    })
    const close = () => { if (offlineWorker === worker) void stopOffline().catch(() => {}) }
    worker.on('error', close)
    worker.on('exit', close)
    worker.unref()
  }
  const worker = offlineWorker
  return new Promise((resolve, reject) => {
    const id = ++offlineId
    offlineRequests.set(id, { resolve, reject })
    try { worker.postMessage({ id, action, input }) }
    catch (error) { offlineRequests.delete(id); reject(error) }
  })
}
const builtinOffline = (): string => join(process.resourcesPath, 'offline-delivery.msldelivery')
function offlineSettings(file: string, builtin = true): any {
  const p = deliveryProfile()!
  return { file, root: app.getPath('userData'), publicKey: publicKey || p.publicKey, tenant: p.tenantId,
    release: builtin ? p.defaultReleaseId : undefined, requireEncrypted: p.accessMode === 'offline' || p.accessMode === 'hybrid' }
}
let restoring = false, restoreError = ''
let token = '', endpoint = '', fingerprint = '', publicKey = '', user: any, epoch = 0, persistent = false, packaging = false
const active = new Set<import('node:http').ClientRequest>()
const transportAgents=new Map<string,https.Agent>()
function closeTransports():void{for(const agent of transportAgents.values())agent.destroy();transportAgents.clear()}
function reusableAgent(host:string,port:number,pin:string):https.Agent{const key=JSON.stringify([epoch,host,port,pin]);let agent=transportAgents.get(key);if(!agent){agent=agentFor(host,port,pin);transportAgents.set(key,agent);while(transportAgents.size>4){const key=transportAgents.keys().next().value!;transportAgents.get(key)!.destroy();transportAgents.delete(key)}}return agent}
function notify(): void { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('delivery:updated', state()) }
function state(): any { return { profile: deliveryProfile(), endpoint: endpoint || profile?.endpoint || '', fingerprint: fingerprint || profile?.certificateFingerprint || '', user, connected: !!token && !!user, persistent, restoring, restoreError, savedLogin: existsSync(sessionFile()) } }
const sessionFile = (): string => join(app.getPath('userData'), 'delivery-session.json')
function secureStorage(): boolean { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text') }
function clearLocal(): void {
  void stopOffline().catch(() => {})
  pendingPersonal = undefined
  ++epoch; for (const req of active) req.destroy(new Error('操作已取消')); active.clear(); closeTransports()
  token = ''; user = undefined; persistent = false
  setAdminWorkspace(undefined)
  if (existsSync(sessionFile())) unlinkSync(sessionFile())
  notify()
}
function normalizeEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请输入HTTPS服务器地址，例如 https://服务器地址:8443')
  return url.origin
}
function normalizeFingerprint(value: string): string {
  const result = String(value).replaceAll(':', '').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('服务器证书指纹须为SHA-256的64位十六进制字符')
  return result
}
function agentFor(host: string, port: number, pin: string): https.Agent {
  const agent = new https.Agent({ keepAlive:true,keepAliveMsecs:15000,maxSockets:4,maxFreeSockets:2,timeout:60000 })
  let disposed=false;const cancellations=new Set<()=>void>()
  const destroyAgent = agent.destroy.bind(agent)
  agent.destroy = (): void => { disposed = true; for(const cancel of [...cancellations])cancel();cancellations.clear(); destroyAgent() }
  ;(agent as any).createConnection = (_options: any, callback: any): void => {
    const gateway = deliveryProfile()?.gateway, own = epoch
    let delivered = false, failed = false, closed = false, ssh: any, stream: any, socket: tls.TLSSocket | undefined
    const close = (): void => {
      if (closed) return
      closed = true; cancellations.delete(cancelConnection)
      socket?.destroy(); stream?.destroy(); ssh?.end()
    }
    const finish = (error: Error): void => {
      if (failed) return
      failed = true
      if (!delivered) { delivered = true; callback(error) }
      else socket?.destroy(error)
      close()
    }
    const cancelled = (): boolean => disposed || closed || failed || own !== epoch
    const cancelConnection = (): void => { if (!delivered) finish(new Error('操作已取消')); else close() }
    cancellations.add(cancelConnection)
    if (disposed) { cancelConnection(); return }
    const startTLS = (transport?: any): void => {
      if (cancelled()) { transport?.destroy(); return }
      try {
        socket = tls.connect({ ...(transport ? { socket: transport } : { host, port }), rejectUnauthorized: false, minVersion: 'TLSv1.2', servername: require('node:net').isIP(host) ? undefined : host })
        socket.setTimeout(15000, () => finish(new Error('服务器连接超时')))
        // Keep error listeners for the transport lifetime: ssh2 can emit another error during close.
        socket.on('error', finish)
        socket.once('close', () => { if (!delivered) finish(new Error('服务器连接在验证前已关闭')); else close() })
        socket.once('secureConnect', () => {
          if (cancelled()) { close(); return }
          try {
            const cert = socket!.getPeerCertificate(), actual = createHash('sha256').update(cert.raw).digest('hex')
            if (actual !== pin || !Number.isFinite(Date.parse(cert.valid_to)) || !Number.isFinite(Date.parse(cert.valid_from)) || Date.parse(cert.valid_to) <= Date.now() || Date.parse(cert.valid_from) > Date.now()) {
              finish(new Error('服务器证书不匹配或已过期，请向管理员核对证书指纹')); return
            }
            socket!.setTimeout(0); delivered = true; callback(null, socket)
          } catch { finish(new Error('服务器证书验证失败，请核对服务器身份')) }
        })
      } catch (error) { finish(error as Error) }
    }
    if (!gateway) startTLS()
    else {
      ssh = new SSHClient()
      ssh.on('error', () => finish(new Error('客户服务通道连接失败，请检查服务器地址和端口')))
      ssh.once('close', () => { if (!closed) finish(new Error('客户服务通道已关闭')) })
      ssh.once('ready', () => {
        if (cancelled()) { close(); return }
        try { ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error: any, channel: any) => {
          if (channel) { stream = channel; channel.on('error', () => finish(new Error('客户服务通道已中断'))) }
          if (cancelled()) { channel?.destroy(); return }
          if (error || !channel) { finish(new Error('服务器未开放客户服务通道')); return }
          startTLS(channel)
        }) } catch (error) { finish(error as Error) }
      })
      try { ssh.connect({ host, port: gateway.port, username: gateway.username, password: gateway.password, readyTimeout: 30000,keepaliveInterval:15000,keepaliveCountMax:3, hostHash: 'sha256', hostVerifier: (value: string) => value === gateway.hostFingerprint, algorithms: { serverHostKey: ['ssh-ed25519'] } }) }
      catch (error) { finish(error as Error) }
    }
  }
  return agent
}
async function openRequest(method: string, route: string, body?: any, options: { base?: string; pin?: string; authorization?: string; timeout?: number } = {}): Promise<import('node:http').IncomingMessage> {
  const base = normalizeEndpoint(options.base || endpoint), url = new URL(route, base)
  if (!route.startsWith('/') || route.startsWith('//') || url.origin !== base) throw new Error('请求地址无效')
  const own = epoch, binary = Buffer.isBuffer(body)
  const data = binary ? body : body === undefined ? undefined : JSON.stringify(body)
  const agent = reusableAgent(url.hostname, Number(url.port) || 443, normalizeFingerprint(options.pin || fingerprint))
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, agent, headers: { ...(data ? { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...((options.authorization ?? token) ? { Authorization: 'Bearer ' + (options.authorization ?? token) } : {}) } }, res => {
      if (own !== epoch) { req.destroy(new Error('操作已取消')); return }
      res.once('end', () => { active.delete(req) }); res.once('close', () => { active.delete(req) })
      resolve(res)
    })
    active.add(req)
    req.setTimeout(options.timeout || 30000, () => req.destroy(new Error(route.startsWith('/admin/file-sources') && method!=='GET' ? '服务器响应超时，操作结果待确认。请刷新数据检查结果后再操作' : '服务器响应超时，请重试')))
    req.on('error', e => { active.delete(req); reject(e) })
    if (data) req.write(data)
    req.end()
  })
}
async function requestOnce(method: string, route: string, body?: any, options = {}): Promise<any> {
  const own = epoch, res = await openRequest(method, route, body, options), chunks: Buffer[] = []
  for await (const chunk of res) chunks.push(Buffer.from(chunk))
  if (own !== epoch) throw new Error('操作已取消')
  let result: any
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('服务器响应不完整，请重试') }
  if ((res.statusCode || 500) >= 400) {
    if (res.statusCode === 401 && route !== '/login') clearLocal()
    throw Object.assign(new Error(result.error || '服务器请求失败'), { status: res.statusCode, publicationState: result.publicationState })
  }
  return result
}
async function request(method:string,route:string,body?:any,options={}):Promise<any>{const own=epoch;try{return await requestOnce(method,route,body,options)}catch(error){const readOnly=method==='GET'||method==='POST'&&['/admin/file-sources/records','/admin/file-sources/categories','/admin/file-sources/record','/admin/classification/counts','/admin/classification/plans','/admin/candidates'].includes(route);if(!readOnly||own!==epoch||!/(ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|通道.*(失败|关闭|中断)|服务器响应不完整)/i.test(String(error)))throw error;await new Promise(resolve=>setTimeout(resolve,250));if(own!==epoch)throw Error('操作已取消');return requestOnce(method,route,body,options)}}
function saveSession(): void {
  if (!persistent || !secureStorage()) return
  mkdirSync(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify({ token, endpoint, fingerprint, publicKey })).toString('base64')
  writeFileSync(sessionFile(), JSON.stringify({ encrypted }), { mode: 0o600 })
}
export async function restoreDeliverySession(): Promise<void> {
  const p = deliveryProfile()
  if (!p || token || restoring || !existsSync(sessionFile()) || !secureStorage()) return
  restoring = true; restoreError = ''; notify()
  try {
    const saved = JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(readFileSync(sessionFile(), 'utf8')).encrypted, 'base64')))
    endpoint = normalizeEndpoint(saved.endpoint); fingerprint = normalizeFingerprint(saved.fingerprint); token = saved.token; publicKey = saved.publicKey
    const me = await request('GET', '/me')
    if (me.user.role !== p.edition || (p.tenantId && me.user.tenantId !== p.tenantId)) throw new Error('此账号不适用于当前安装包')
    user = me.user; publicKey = me.publicKey; persistent = true; saveSession()
  } catch (error) { token = ''; user = undefined; persistent = false; restoreError = String(error) }
  finally { restoring = false; notify() }
}
export function deliveryLoggedIn(): boolean { return !!token }
export function adminEditIdentity(): { owner: string; session: number } {
  if (!administratorLoggedIn()) throw new Error('请先登录管理员')
  return { owner: JSON.stringify([endpoint, fingerprint, user.id]), session: epoch }
}
export function administratorLoggedIn(): boolean { return !!token && user?.role === 'admin' && !restoring }
export async function logoutDelivery(): Promise<{ serverRevoked: boolean }> {
  let serverRevoked = !token
  if (token) try { await request('POST', '/logout', {}, { timeout: 5000 }); serverRevoked = true } catch { /* local credentials are still removed */ }
  clearLocal(); return { serverRevoked }
}
export function keepDeliveryLogin(): void { persistent = true; saveSession() }
function verifiedEnvelope(envelope: any): any {
  if (!publicKey && !profile?.publicKey) throw new Error('缺少服务器签名公钥')
  if (!envelope?.payload || !verify(null, Buffer.from(JSON.stringify(envelope.payload)), publicKey || profile!.publicKey, Buffer.from(envelope.signature || '', 'base64'))) throw new Error('交付文件签名验证失败')
  return envelope.payload
}
function validateOffline(envelope: any): any {
  const payload = verifiedEnvelope(envelope), p = deliveryProfile()
  if (p?.accessMode === 'offline' || p?.accessMode === 'hybrid') throw new Error('此安装包要求加密交付数据，不能用旧格式绕过本地登录')
  if (payload.format !== 'MasspecLib2-delivery' || payload.formatVersion !== 1 || !payload.manifest?.policy?.features?.offline || (p?.tenantId && payload.tenantId !== p.tenantId) || (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now())) throw new Error('离线交付文件不适用于此客户，或已超过有效期')
  return payload
}
async function download(route: string, file: string, expectedHash?: string, method = 'GET', body?: any): Promise<void> {
  const own = epoch, tmp = file + '.part', res = await openRequest(method, route, body, { timeout: 300000 })
  if (res.statusCode !== 200) {
    const chunks: Buffer[] = []; for await (const c of res) chunks.push(Buffer.from(c))
    let message = '下载失败'; try { message = JSON.parse(Buffer.concat(chunks).toString()).error } catch { /* default */ }
    throw new Error(message)
  }
  try {
    await pipeline(res, createWriteStream(tmp, { mode: 0o600 }))
    if (own !== epoch) throw new Error('下载已取消')
    if (expectedHash) {
      const h = createHash('sha256'); for await (const c of createReadStream(tmp)) h.update(c)
      if (h.digest('hex') !== expectedHash) throw new Error('安装模板校验失败')
    }
    renameSync(tmp, file)
  } catch (e) { if (existsSync(tmp)) unlinkSync(tmp); throw e }
}
async function exportData(input: any): Promise<any> {
  if (!token && !input.offline) throw new Error('请先登录')
  if (!['json', 'csv', 'xlsx', 'sql', 'msldelivery'].includes(input.format)) throw new Error('导出格式无效')
  const selection = await dialog.showSaveDialog({ title: '导出授权数据', defaultPath: `客户交付.${input.format}`, filters: [{ name: '交付数据', extensions: [input.format] }] })
  if (selection.canceled || !selection.filePath) return { cancelled: true }
  const file = selection.filePath, tmp = file + '.part', id = encodeURIComponent(input.releaseId), own = epoch
  try {
    if (input.offline) {
      if (!offlineSession) throw Error('请先登录客户账号')
      await offlineCall('export', { ...input, file: tmp })
    } else if (input.format === 'msldelivery') {
      const envelope = await request('GET', `/releases/${id}/offline`); validateOffline(envelope)
      await request('GET', `/releases/${id}/records?pageSize=1`)
      writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 })
    } else {
      const payload = { ...queryOptions(input), fields: input.fields, includeDetails: input.includeDetails === true }
      await download(`/releases/${id}/export`, tmp, undefined, 'POST', payload)
      // Permission is rechecked after download; an incomplete file never replaces the target.
      await request('GET', `/releases/${id}/records?pageSize=1`)
      if (input.format !== 'json') {
        const data = JSON.parse(readFileSync(tmp, 'utf8'))
        writeFileSync(tmp, input.format==='sql'?deliverySql(data,input.includeDetails===true):deliveryTabular(data, input.format, input.includeDetails === true))
      }
    }
    if (own !== epoch) throw new Error('导出已取消')
    renameSync(tmp, file); return { file }
  } catch (e) { for (const f of [tmp, tmp + '.part']) if (existsSync(f)) unlinkSync(f); throw e }
}
export function registerDeliveryIPC(): void {
  const builtinContext = (feature?: string): void => {
    if (deliveryProfile()?.edition !== 'customer' || !offlineSession) throw new Error('请先登录客户账号')
    if (offlineSession.manifest.expiresAt && Date.parse(offlineSession.manifest.expiresAt) <= Date.now()) throw Error('离线交付已超过有效期')
    if (feature && !offlineSession.manifest.policy.features[feature]) throw new Error('管理员未开放此操作')
  }
  const requirePersonalPermission = (action: string): void => { const key = ({ delete: 'personalDelete', restore: 'personalRestore', purge: 'personalPurge' } as Record<string,string>)[action]; if (!key) throw new Error('记录操作无效'); builtinContext(key) }
  ipcMain.handle('delivery:offline-query', (_, input: any) => { builtinContext(); return offlineCall('page', input) })
  ipcMain.handle('delivery:offline-record', (_, id: string) => { builtinContext(); return offlineCall('record', id) })
  ipcMain.handle('delivery:local-review', (_, input: any) => { builtinContext('review'); return offlineCall('review', input) })
  ipcMain.handle('delivery:record-change', async (_, input: any) => {
    const key = ({ delete: 'deleteRecords', restore: 'restoreRecords', purge: 'purgeRecords' } as Record<string,string>)[input?.action]
    if (!key) throw new Error('记录操作无效')
    builtinContext(key)
    const revision = offlineEpoch, label = input.action === 'delete' ? '将所选记录移入本机回收站' : input.action === 'restore' ? '恢复所选记录' : '从本机工作区彻底删除所选记录'
    const choice = await dialog.showMessageBox({ type: 'warning', title: '确认操作', message: `是否${label}？只影响当前 Windows 用户的客户工作区，不改动服务器、安装包及备份。`, buttons: ['否', '是'], defaultId: 0, cancelId: 0 })
    if (choice.response !== 1) return { cancelled: true }
    if (revision !== offlineEpoch) throw Error('登录状态已变化，请重试')
    return offlineCall('change', input)
  })

  ipcMain.handle('delivery:copy-text', (_, text: string) => { if (typeof text !== 'string' || text.length > 200000) throw new Error('复制内容过长'); clipboard.writeText(text); return true })
  const personalContext = async (requireImport = false): Promise<{ library: PersonalLibrary; owner: string; canExport: boolean; revision: number }> => {
    const revision = epoch
    const p = deliveryProfile()
    if (p?.edition !== 'customer') throw new Error('仅客户端支持个人数据')
    if (p.accessMode === 'offline' && !offlineSession) throw new Error('请先登录客户账号')
    const tenant = p.tenantId || user?.tenantId
    if (!tenant) throw new Error('缺少客户身份配置')
    const owner = localPersonalOwner(tenant), library = new PersonalLibrary(app.getPath('userData'), owner)
    if (user?.role === 'customer' && user.tenantId === tenant) library.adopt(new PersonalLibrary(app.getPath('userData'), personalOwner(endpoint + ':' + user.tenantId, user.id)))
    if (requireImport) {
      let authorized = false
      try {
        if (offlineSession) authorized = await offlineCall('authorize', { feature: 'personalImport' })
      } catch { /* Existing personal data stays usable even when the delivery is unavailable. */ }
      if (!authorized && token && user?.role === 'customer') {
        const releases = await request('GET', '/releases')
        if (revision !== epoch) throw new Error('连接状态已切换，请重试')
        authorized = releases.some((r: any) => r.policy?.features?.personalImport)
      }
      if (!authorized) throw new Error('当前没有有效的个人导入授权；已有个人数据仍可读取、备份和恢复')
    }
    return { owner, revision, library, canExport: true }
  }
  ipcMain.handle('delivery:personal-status', async () => {
    try { await personalContext(true); return { canImport: true, issue: '' } }
    catch (e) { return { canImport: false, issue: e instanceof Error ? e.message : '个人导入暂不可用；已有数据仍可使用' } }
  })
  ipcMain.handle('delivery:personal-trash', async () => (await personalContext()).library.list(true))
  ipcMain.handle('delivery:personal-restore', async (_, id: string) => { requirePersonalPermission('restore'); (await personalContext()).library.restore(id); return { restored: true } })
  ipcMain.handle('delivery:personal-backup-raw', async (_, id: string, trashed = false) => {
    const ctx = await personalContext(), bytes = ctx.library.raw(id, trashed === true)
    const choice = await dialog.showSaveDialog({ title: '备份原始批次文件（保留损坏内容供恢复）', defaultPath: '个人批次原文件.json', filters: [{ name: '原始批次', extensions: ['json'] }] })
    if (choice.canceled || !choice.filePath) return { cancelled: true }
    if (ctx.revision !== epoch) throw new Error('工作区已变化，请重试')
    writeFileSync(choice.filePath, bytes); return { saved: true }
  })
  ipcMain.handle('delivery:personal-purge', async (_, id: string) => {
    requirePersonalPermission('purge')
    const ctx = await personalContext(), batch = ctx.library.list(true).find(b => b.id === id)
    if (!batch) throw new Error('回收站批次不存在，请刷新')
    const choice = await dialog.showMessageBox({ type: 'warning', title: '永久删除个人批次', message: `是否确认永久删除“${batch.filename}”？删除后无法恢复，请先备份需要保留的数据。`, buttons: ['否', '是'], defaultId: 0, cancelId: 0 })
    if (choice.response !== 1) return { cancelled: true }
    if (ctx.revision !== epoch) throw new Error('工作区已变化，请重试')
    requirePersonalPermission('purge'); ctx.library.purge(id); return { removed: true }
  })
  ipcMain.handle('delivery:personal-record-trash', async () => {
    const ctx = await personalContext()
    return ctx.library.list().filter(b => !b.damaged).flatMap(b => personalView(ctx.library.read(b.id), true).records.map((record: any) => ({ ...record, batchId: b.id, batchTitle: b.filename })))
  })
  ipcMain.handle('delivery:personal-record-change', async (_, input: any) => {
    requirePersonalPermission(input?.action)
    const ctx = await personalContext(), label = input.action === 'delete' ? '将所选个人记录移入回收站' : input.action === 'restore' ? '恢复所选个人记录' : '彻底删除所选个人记录'
    const choice = await dialog.showMessageBox({ type: 'warning', title: '确认操作', message: `是否${label}？`, buttons: ['否', '是'], defaultId: 0, cancelId: 0 })
    if (choice.response !== 1) return { cancelled: true }
    const current = await personalContext(); if (current.owner !== ctx.owner || current.revision !== ctx.revision) throw new Error('登录状态已变化，请重试')
    requirePersonalPermission(input.action); current.library.changeRecords(input.batchId, input.ids, input.action); return { changed: true }
  })
  ipcMain.handle('delivery:personal-list', async () => (await personalContext()).library.list())
  ipcMain.handle('delivery:personal-read', async (_, id: string) => personalView((await personalContext()).library.read(id)))
  ipcMain.handle('delivery:personal-prepare', async () => {
    pendingPersonal = undefined
    const ctx = await personalContext(true)
    const choice = await dialog.showOpenDialog({ title: '导入个人数据（仅保存在本机）', properties: ['openFile'], filters: [{ name: '个人数据包或化合物表格', extensions: ['msldata', 'json', 'xlsx', 'xls', 'csv'] }] })
    if (choice.canceled || !choice.filePaths[0]) return { cancelled: true }
    if (ctx.revision !== epoch) throw new Error('账号已切换，请重新选择文件')
    const file = choice.filePaths[0], bytes = readFileSync(file), filename = basename(file), extension = extname(file).toLowerCase()
    let data: any
    if (['.xlsx', '.xls', '.csv'].includes(extension)) {
      const book = extension === '.csv' ? XLSX.read(bytes.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', raw: true }) : XLSX.read(bytes, { type: 'buffer' })
      data=personalFlat.readBook(book,XLSX,createHash('sha256').update(bytes).digest('hex'))
    } else if (['.msldata', '.json'].includes(extension)){const parsed=extension==='.json'?JSON.parse(bytes.toString('utf8')):null;data=Array.isArray(parsed?.records)?personalFlat.parse(parsed.records.map((r:any)=>r.sanming||r.compound),createHash('sha256').update(bytes).digest('hex')):readPersonalPackage(bytes)}
    else throw new Error('请选择 .msldata、JSON 数据包或化合物 Excel/CSV 模板')
    if (!data.groups.length) throw new Error('文件中没有可导入的化合物')
    if (ctx.revision !== epoch) throw new Error('账号已切换，请重新导入')
    const existingCAS=new Set<string>()
    for(const batch of ctx.library.list().filter(b=>!b.damaged)){try{for(const group of ctx.library.read(batch.id).data.groups)if(group.compound.cas)existingCAS.add(String(group.compound.cas).trim())}catch{}}
    for(const cas of new Set(data.groups.map((g:any)=>g.compound.cas).filter(Boolean)))if(existingCAS.has(String(cas).trim()))(data._warnings||=[]).push(`CAS ${cas} 已存在于本机其他批次，本次仍单独保留，不自动合并。`)
    const id = createHash('sha256').update(bytes).digest('hex')
    pendingPersonal = { owner: ctx.owner, bytes, filename, data, at: Date.now(), revision: ctx.revision, id }
    return { id, filename, total: data.groups.length, duplicate: ctx.library.list().some(b => b.id === id), rows: data.groups.slice(0, 50).map((g: any) => ({ ...personalFlat.flatGroup(g,data.taxonomyCatalog),main_name: g.compound.main_name, cas: g.compound.cas, spectra: g.spectra?.length || 0, methods: g.methods?.length || 0 })), notice: (data._warnings?.length?'提醒：'+data._warnings.slice(0,20).join('；')+'。':'')+'原始数据包完整保存在个人数据区。此页支持基本信息、质谱方法、数值或图片谱图、液相方法；规范分类与来源标签按数据包字典显示；检测档案及其他扩展信息保留在备份中，不自动计算。' }
  })
  ipcMain.handle('delivery:personal-commit', async (_, id: string) => {
    const ctx = await personalContext(true), p = pendingPersonal
    if (!p || p.id !== id || p.owner !== ctx.owner || p.revision !== ctx.revision || Date.now() - p.at > 15 * 60 * 1000) throw new Error('导入预览已失效，请重新选择文件')
    const result = ctx.library.save(p.bytes, p.filename, p.data); pendingPersonal = undefined; return result
  })
  ipcMain.handle('delivery:personal-rename', async (_, id: string, name: string) => {
    const ctx = await personalContext(); ctx.library.rename(id, name); return { renamed: true }
  })
  ipcMain.handle('delivery:personal-export-query', async (_, input: any) => {
    const ctx = await personalContext(); if (!ctx.canExport) throw new Error('此交付未开放导出')
    if (!['xlsx', 'csv', 'json','sql'].includes(input.format)) throw new Error('导出格式无效')
    if (!Array.isArray(input.recordIds) || !input.recordIds.length) throw new Error('没有可导出的查询结果')
    const ids = new Set(input.recordIds), views = ctx.library.list().filter(b => !b.damaged).flatMap(b => { try { return [personalView(ctx.library.read(b.id))] } catch { return [] } })
    const records = views.flatMap(v => v.records).filter(r => ids.has(r.id))
    if (records.length !== ids.size) throw new Error('个人数据已变化，请刷新后重试')
    const result = await dialog.showSaveDialog({ title: `导出 ${records.length} 条个人数据查询结果`, defaultPath: `我的数据查询结果.${input.format}`, filters: [{ name: '查询结果', extensions: [input.format] }] })
    if (result.canceled || !result.filePath) return { cancelled: true }
    const current = await personalContext()
    if (current.owner !== ctx.owner || !current.canExport || current.revision !== ctx.revision) throw new Error('工作区已变化，请重试')
    const data = { manifest: views[0].manifest, records }
    writeFileSync(result.filePath, input.format === 'json' ? JSON.stringify(data) : input.format==='sql'?deliverySql(data,true):personalFlat.exportRows(XLSX,records,input.format,input.headers)); return { saved: true }
  })
  ipcMain.handle('delivery:personal-cancel', () => { pendingPersonal = undefined })
  ipcMain.handle('delivery:personal-remove', async (_, id: string) => {
    requirePersonalPermission('delete')
    const ctx = await personalContext(), batch = ctx.library.list().find(b => b.id === id)
    if (!batch) throw new Error('批次不存在，请刷新')
    const choice = await dialog.showMessageBox({ type: 'warning', title: '删除个人导入批次', message: `是否将本机的“${batch.filename}”移入个人回收站？可随时恢复，交付数据库不受影响。`, buttons: ['否', '是'], defaultId: 0, cancelId: 0 })
    if (choice.response !== 1) return { cancelled: true }
    const current = await personalContext(); if (current.owner !== ctx.owner || current.revision !== ctx.revision) throw new Error('账号已切换')
    requirePersonalPermission('delete'); current.library.remove(id); return { removed: true }
  })
  ipcMain.handle('delivery:personal-template', async (_, input?:any) => {
    const ctx = await personalContext(true), choice = await dialog.showSaveDialog({ title: '保存个人数据模板', defaultPath: '个人化合物模板.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (choice.canceled || !choice.filePath) return { cancelled: true }
    if (ctx.revision !== epoch) throw new Error('账号已切换')
    XLSX.writeFile(personalFlat.template(XLSX,input?.headers),choice.filePath);return {saved:true}
  })
  ipcMain.handle('delivery:personal-export', async (_, id: string) => {
    const ctx = await personalContext(); if (!ctx.canExport) throw new Error('管理员尚未开放导出')
    const batch = ctx.library.read(id), choice = await dialog.showSaveDialog({ title: '备份个人数据', defaultPath: '个人数据.msldata', filters: [{ name: 'MasspecLib2 数据包', extensions: ['msldata'] }] })
    if (choice.canceled || !choice.filePath) return { cancelled: true }
    const current = await personalContext(); if (current.owner !== ctx.owner || current.revision !== ctx.revision || !current.canExport) throw new Error('导出权限或账号已变化')
    writeFileSync(choice.filePath, encodePackage(batch.data)); return { saved: true }
  })
  ipcMain.handle('delivery:configuration', () => state())
  ipcMain.handle('delivery:restore', async () => { await restoreDeliverySession(); return state() })
  ipcMain.handle('delivery:login', async (_, input: any) => {
    if (restoring) throw new Error('正在恢复上次登录，请稍候')
    restoreError = ''
    if (token) await logoutDelivery()
    closeTransports(); ++epoch
    const p = deliveryProfile()!
    endpoint = normalizeEndpoint(input.endpoint); fingerprint = normalizeFingerprint(input.fingerprint)
    const result = await request('POST', '/login', { username: input.username, password: input.password, keepSignedIn: input.keepSignedIn === true, expectedTenant: p.tenantId })
    token = result.token
    const me = await request('GET', '/me')
    if (me.user.role !== p.edition || (p.tenantId && me.user.tenantId !== p.tenantId)) { await logoutDelivery(); throw new Error('此账号不适用于当前软件版本或客户') }
    publicKey = me.publicKey; user = me.user; persistent = input.keepSignedIn === true && secureStorage(); saveSession(); notify()
    return { ...state(), storageUnavailable: input.keepSignedIn === true && !persistent }
  })
  ipcMain.handle('delivery:logout', () => logoutDelivery())
  ipcMain.handle('delivery:database-upload', async (event) => {
    if (!administratorLoggedIn()) throw Error('请先登录管理员')
    const own = epoch
    if (databaseUploading) throw Error('已有数据库正在上传')
    databaseUploading = true
    let file: Awaited<ReturnType<typeof import('node:fs/promises').open>> | undefined
    let uploadUrl: string | undefined
    const progress = (data: { phase: string; sent: number; total: number }): void => {
      if (!event.sender.isDestroyed()) event.sender.send('delivery:database-upload-progress', data)
    }
    try {
      const chosen = await dialog.showOpenDialog({ title:'选择 SQLite 数据库', properties:['openFile'],
        filters:[{ name:'SQLite 数据库', extensions:['sqlite'] }] })
      if (chosen.canceled || !chosen.filePaths[0]) return { cancelled:true }
      if (own !== epoch) throw Error('登录账号已变化，请重新上传')
      const local = chosen.filePaths[0]
      if (extname(local).toLowerCase() !== '.sqlite') throw Error('请选择 .sqlite 文件')
      for (const suffix of ['-wal','-journal']) {
        const sidecar = local + suffix
        if (existsSync(sidecar) && statSync(sidecar).size) throw Error('源文件正在写入或有未合并的日志，请关闭数据库后上传')
      }
      const opened = await import('node:fs/promises').then(fs => fs.open(local, 'r'))
      file = opened
      const initial = await opened.stat()
      if (!initial.isFile()) throw Error('请选择 SQLite 文件')
      const { id, chunkBytes } = await request('POST', '/admin/file-sources/upload/start',
        { filename:basename(local), bytes:initial.size })
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw Error('服务器返回的上传编号无效')
      uploadUrl = '/admin/file-sources/upload/' + id
      if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 8 * 1024 * 1024)
        throw Error('服务器返回的上传分块大小无效')
      const buffer = Buffer.alloc(chunkBytes)
      let sent = 0
      progress({phase:'upload',sent,total:initial.size})
      while (sent < initial.size) {
        if (own !== epoch) throw Error('操作已取消')
        const { bytesRead } = await opened.read(buffer, 0, Math.min(buffer.length, initial.size - sent), sent)
        if (!bytesRead) throw Error('上传期间源文件已变化')
        const result = await request('PUT', uploadUrl + '?offset=' + sent, buffer.subarray(0, bytesRead), { timeout:90000 })
        if (result.received !== sent + bytesRead) throw Error('服务器确认的上传进度不一致')
        sent = result.received
        progress({phase:'upload',sent,total:initial.size})
      }
      const latest = await opened.stat()
      if (latest.size !== initial.size || latest.mtimeMs !== initial.mtimeMs) throw Error('上传期间源文件已变化')
      progress({phase:'check',sent,total:initial.size})
      return await request('POST', uploadUrl, undefined, { timeout:300000 })
    } catch (error) {
      if (uploadUrl && own === epoch) await request('DELETE', uploadUrl).catch(() => {})
      throw error
    } finally {
      try { await file?.close() } finally { databaseUploading = false }
    }
  })
  ipcMain.handle('delivery:source-upload', async () => {
    const uploadEpoch = epoch
    if (!token || profile?.edition !== 'admin' || user?.role !== 'admin') throw new Error('无管理员权限')
    const choice = await dialog.showOpenDialog({ title: '上传谱图库文件并查重', properties: ['openFile'], filters: [{ name: '谱图库文件', extensions: ['json', 'mgf', 'msp'] }] })
    if (choice.canceled || !choice.filePaths[0]) return { cancelled: true }
    if (uploadEpoch !== epoch) throw new Error('账号已切换，请重新选择文件')
    if (!token || profile?.edition !== 'admin' || user?.role !== 'admin') throw new Error('无管理员权限')
    const file = choice.filePaths[0]
    if (statSync(file).size > 64 * 1024 * 1024) throw new Error('上传文件不能超过64 MB')
    const bytes = readFileSync(file)
    if (bytes.length > 64 * 1024 * 1024) throw new Error('上传文件不能超过64 MB')
    return { file, filename: basename(file), content: bytes.toString('base64') }
  })
  ipcMain.handle('delivery:call', async (_, method: string, route: string, body?: any) => {
    if (!token) throw new Error('请先登录')
    if (!['GET', 'POST', 'PATCH'].includes(method) || !/^\/(schema|me|password|releases(?:\/|\?|$)|admin(?:\/|$))/.test(route)) throw new Error('请求无效')
    if (route.startsWith('/admin') && (profile?.edition !== 'admin' || user?.role !== 'admin')) throw new Error('无管理员权限')
    return publishRequest(method, route, body)
  })
  ipcMain.handle('delivery:export', (_, input: any) => exportData(input))
  ipcMain.handle('delivery:offline-status', async () => {
    const p = deliveryProfile()
    if (p?.edition !== 'customer' || p.accessMode === 'online') return { protected: false }
    const file = builtinOffline()
    if (!existsSync(file)) { if (p.accessMode) throw new Error('安装包缺少内置加密数据，请联系管理员重新生成'); return { protected: false } }
    return offlineCall('status', { settings: offlineSettings(file) })
  })
  ipcMain.handle('delivery:offline-login', async (_, input: any) => {
    const p = deliveryProfile(), revision = offlineEpoch
    if (p?.edition !== 'customer' || p.accessMode === 'online') throw new Error('此安装包未开放本地登录')
    if (localLoginPending) throw Error('正在验证本地账号')
    if (offlineAttemptUntil <= Date.now()) { offlineAttempts = 0; offlineAttemptUntil = Date.now() + 15 * 60000 }
    if (offlineAttempts >= 10) throw new Error('本地登录尝试过多，请15分钟后再试')
    ++offlineAttempts
    localLoginPending = true
    try {
      const data = await offlineCall('login', { settings: offlineSettings(builtinOffline()), credentials: { username: input?.username, password: input?.password } })
      if (revision !== offlineEpoch) throw Error('本地登录已取消')
      offlineSession = data; offlineAttempts = 0
      return data
    } finally { localLoginPending = false }
  })
  ipcMain.handle('delivery:offline-logout', async () => { ++epoch; pendingPersonal = undefined; await stopOffline(); return { success: true } })
  ipcMain.handle('delivery:offline', async (_, choose = false) => {
    if (deliveryProfile()?.accessMode === 'online') throw new Error('此安装包仅支持在线登录；签名文件导出不提供独立离线启动')
    let file = builtinOffline()
    if (choose) { const result = await dialog.showOpenDialog({ title: '打开离线交付文件', properties: ['openFile'], filters: [{ name: '签名交付文件', extensions: ['msldelivery'] }] }); if (result.canceled) return null; file = result.filePaths[0] }
    if (!existsSync(file)) return null
    const revision = offlineEpoch
    const data = await offlineCall('open', { settings: offlineSettings(file, !choose) })
    if (revision !== offlineEpoch) throw Error('本地登录已取消')
    offlineSession = data
    return data
  })
  ipcMain.handle('delivery:show-package', (_, file: string) => { if (profile?.edition !== 'admin' || user?.role !== 'admin' || !lastPackageFile || file !== lastPackageFile || !existsSync(file)) throw new Error('安装包文件不可用'); shell.showItemInFolder(file) })
  ipcMain.handle('delivery:package', async (_, releaseId: string) => {
    if (profile?.edition !== 'admin' || user?.role !== 'admin') throw new Error('无管理员权限')
    if (process.platform !== 'win32') throw new Error('生成MSI需要在Windows管理员端执行，已内置打包工具')
    if (packaging) throw new Error('已有安装包正在生成')
    const catalog = await request('GET', '/admin/state'), chosen = catalog.releases.find((r: any) => r.id === releaseId), tenant = catalog.tenants.find((t: any) => t.id === chosen?.tenantId)
    if (!chosen || !['draft','published'].includes(chosen.state)) throw new Error('此交付不可生成，请重新配置')
    const safeName = (s: string): string => String(s).replace(/[<>:\x22/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 55) || '交付'
    const suggestedName = ['MasspecLib2', tenant?.name || '客户', ...(chosen.title !== tenant?.name ? [chosen.title] : []), `${chosen.sources?.length || 0}个库`, app.getVersion()].map(safeName).join('-') + '.msi'
    const selection = await dialog.showSaveDialog({ title: '生成客户专用安装包', defaultPath: suggestedName, filters: [{ name: 'Windows安装包', extensions: ['msi'] }] })
    if (selection.canceled || !selection.filePath) return { cancelled: true }
    if (packaging) throw Error('已有安装包正在生成')
    packaging = true; const own = epoch
    const jobRoot = join(app.getPath('userData'), 'package-jobs')
    let work: string | undefined
    const progress = (message: string): void => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('delivery:package-progress', message) }
    try {
      mkdirSync(jobRoot, { recursive: true })
      work = await mkdtemp(join(jobRoot, 'delivery-'))
      const zip = join(work, 'client.zip'), application = join(work, 'application')
      if (chosen.state === 'draft') await request('POST', `/admin/releases/${encodeURIComponent(releaseId)}/publish`, {})
      progress('正在获取客户交付配置…')
      const packageRoute = `/admin/releases/${encodeURIComponent(releaseId)}/package`
      const response = await openRequest('POST', packageRoute, { format: packageStreamFormat }, { timeout: 300000 })
      const offlineFile = join(work, 'offline-delivery.msldelivery')
      let payload: any
      if (response.statusCode === 200 && response.headers['content-type'] === packageStreamType) {
        let lastPercent = -1
        payload = await savePackageStream(response, offlineFile, verifiedEnvelope, (received: number, size: number) => {
          const percent = Math.floor(received / size * 100)
          if (percent !== lastPercent) { lastPercent = percent; progress(`正在下载客户离线数据… ${percent}%`) }
        })
      } else {
        const chunks: Buffer[] = []
        for await (const chunk of response) chunks.push(Buffer.from(chunk))
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (response.statusCode !== 200) throw Error(envelope.error || '服务器准备客户安装包失败')
        payload = verifiedEnvelope(envelope)
      }
      if (own !== epoch) throw Error('打包已取消')
      progress('正在下载并验证客户端模板…'); await download('/admin/client-template', zip, payload.templateHash)
      const run = promisify(execFile), quote = (s: string): string => "'" + s.replaceAll("'", "''") + "'"
      progress('正在展开客户端模板…')
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(application)}`], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      if (!existsSync(join(application, 'MasspecLib2.exe'))) throw new Error('客户端模板结构无效')
      writeFileSync(join(application, 'resources', 'delivery-profile.json'), JSON.stringify(payload.profile, null, 2))
      const targetOffline = join(application, 'resources', 'offline-delivery.msldelivery')
      if (existsSync(offlineFile)) await rename(offlineFile, targetOffline)
      else if (payload.offline) { verifiedEnvelope(payload.offline); writeFileSync(targetOffline, JSON.stringify(payload.offline)) }
      else throw Error('安装包缺少离线交付数据')
      writeFileSync(join(application, 'resources', 'delivery-contents.json'), JSON.stringify({ customerName: payload.profile.customerName, title: payload.release.title, version: payload.release.version, databases: payload.release.sources, total: payload.release.total, fieldLabels: payload.release.fieldLabels, features: payload.release.policy.features }, null, 2), { mode: 0o600 })
      const name = `MasspecLib2 客户端 ${payload.profile.customerName}`, identity = 'customer-' + payload.profile.tenantId, wxs = join(work, 'installer.wxs'), obj = join(work, 'installer.wixobj'), msi = join(work, 'delivery.msi')
      generateDeliveryWix({ application, output: wxs, name, identity, version: app.getVersion(), icon: join(process.resourcesPath, 'delivery-tools/icon.ico') })
      const wix = join(process.resourcesPath, 'delivery-tools/wix')
      progress('正在生成客户MSI安装包…')
      await run(join(wix, 'candle.exe'), ['-nologo', '-arch', 'x64', '-out', obj, wxs], { cwd: work, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 600000 })
      await run(join(wix, 'light.exe'), ['-nologo', '-sval', '-out', msi, obj], { cwd: work, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 600000 })
      if (own !== epoch) throw new Error('打包已取消')
      // Recheck publication immediately before handing over the artifact.
      const latest = await request('GET', '/admin/state'), release = latest.releases.find((r: any) => r.id === releaseId)
      if (!release || release.state !== 'published' || (release.expiresAt && Date.parse(release.expiresAt) <= Date.now())) throw new Error('交付授权已失效，未输出安装包')
      const target = selection.filePath + '.part'
      try {
        await pipeline(createReadStream(msi), createWriteStream(target))
        if (own !== epoch) throw Error('打包已取消')
        await rename(target, selection.filePath)
      } finally { await rm(target, { force: true }).catch(() => {}) }
      lastPackageFile = selection.filePath
      try {
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(selection.filePath)) hash.update(chunk)
        await request('POST', `/admin/releases/${encodeURIComponent(releaseId)}/packaged`, { sha256: hash.digest('hex'), bytes: statSync(selection.filePath).size })
      } catch { progress('安装包已生成，服务器生成记录暂未更新') }
      progress('客户安装包已生成')
      return { file: selection.filePath, customer: payload.profile.customerName }
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
      packaging = false
    }
  })
}

