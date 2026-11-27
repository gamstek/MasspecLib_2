/* eslint-disable @typescript-eslint/no-explicit-any */
import { connectionError } from '../shared/connectionErrors.mjs'
import { disconnectSharedResources } from '../shared/sharedShutdown.mjs'
import { BrowserWindow, type IpcMain } from 'electron'
import { createConnection } from 'mysql2/promise'
import { sharedServerDefaults, sharedServerProfile, setSharedRuntimeProfile } from './sharedServerProfile'
import { closeSharedPools, reconcileSharedConnections } from './federation/registry'
import { startAudit, stopAudit } from './audit/service'
import { automaticSSHInput, clearSharedLogin, openSharedTunnel, saveSharedSSH, sharedSSHConfiguration, type SharedSSHInput, type SharedTunnel } from './sharedTransport'

let timer: ReturnType<typeof setTimeout> | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> | undefined
let stopped = false, configuring = false, tunnel: SharedTunnel | undefined, generation = 0, retryCount = 0
const status = { enabled: false, connected: false, connecting: false, needsConfiguration: false, mode: 'direct', host: '', port: 3306, libraries: 0, revision: 0, error: '', checkedAt: '' }
export function sharedServerStatus(): typeof status { return { ...status } }
function emit(): void { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('shared:updated', sharedServerStatus()) }
function scheduleSharedSync():void {
  clearTimeout(timer)
  if(stopped||!status.enabled)return
  timer=setTimeout(()=>{if(configuring)scheduleSharedSync();else void syncSharedServer().catch(error=>console.warn('共享同步未完成',String(error))).finally(scheduleSharedSync)},30000);timer.unref()
}
export async function syncSharedServer(): Promise<void> {
  if(stopped)return
  if (pending) return pending
  const ownGeneration=generation
  pending = (async () => {
    const defaults = sharedServerDefaults(), profile = sharedServerProfile()
    if (!defaults) return
    status.enabled = true; status.mode = defaults.mode ?? 'direct'
    if (!profile) { status.needsConfiguration = !status.connecting; return }
    const previous = JSON.stringify({ ...status, checkedAt: '' })
    let changed = false, stage = 'connect'
    try {
      const client = await createConnection({ host: profile.host, port: profile.port, user: profile.user, password: profile.password, database: profile.catalog, connectTimeout: 5000 })
      try {
        stage = 'identity'
        const [identity] = await client.query<import('mysql2').RowDataPacket[]>({ sql: 'SELECT @@server_uuid id', timeout: 5000 })
        profile.serverId = String(identity[0].id)
        stage = 'catalog'
        const [rows] = await client.query<import('mysql2').RowDataPacket[]>({ sql: 'SELECT id,database_name,title,file_name,schema_version FROM libraries ORDER BY published_at,id', timeout: 5000 })
        if (rows.length > 1000) throw new Error('共享库数量超过1000，请联系管理员')
        stage = 'local'
        if(stopped||ownGeneration!==generation)return
        changed = await reconcileSharedConnections(rows, profile)
        status.libraries = rows.length; status.connected = true; status.error = ''; status.needsConfiguration = false
        status.host = tunnel?.input.host ?? profile.host; status.port = tunnel?.input.port ?? profile.port
      } finally { await client.end() }
    } catch (error) {
      if(stopped||ownGeneration!==generation)return
      status.connected = false
      status.error = connectionError(error, stage, !!tunnel)
    }
    status.checkedAt = new Date().toISOString()
    if(stopped||ownGeneration!==generation)return
    if (changed) { ++status.revision; await stopAudit(); if (status.libraries) startAudit() }
    if (changed || previous !== JSON.stringify({ ...status, checkedAt: '' })) emit()
  })()
  try { await pending } finally { pending = undefined }
}
function scheduleReconnect(): void {
  clearTimeout(reconnectTimer)
  if (stopped || !automaticSSHInput() || !Number.isFinite(retryCount)) {
    status.connecting = false; status.needsConfiguration = true; emit(); return
  }
  status.connecting = true; status.needsConfiguration = false
  status.error = '服务器连接中断，正在自动重新连接…'; emit()
  reconnectTimer = setTimeout(() => { void restoreLogin() }, Math.min(30000,3000*2**Math.min(retryCount++,4))+Math.floor(Math.random()*500))
  reconnectTimer.unref()
}
async function configure(input: SharedSSHInput): Promise<any> {
  if (configuring) throw new Error('正在连接服务器，请稍候')
  const defaults = sharedServerDefaults()
  if (!defaults) throw new Error('此安装包未启用共享服务器功能')
  configuring = true; clearTimeout(reconnectTimer)
  const ownGeneration = ++generation
  if (pending) await pending
  const previousProfile = sharedServerProfile(), previousTunnel = tunnel, previousStatus = { ...status }
  let candidate: SharedTunnel | undefined
  status.connecting = true; emit()
  try {
    candidate = await openSharedTunnel(input)
    if (ownGeneration !== generation || stopped) throw new Error('服务器连接已取消')
    tunnel = candidate
    setSharedRuntimeProfile({ ...defaults, host: candidate.host, port: candidate.port })
    await syncSharedServer()
    if (ownGeneration !== generation || stopped) throw new Error('服务器连接已取消')
    if (!status.connected) throw new Error(status.error)
    saveSharedSSH(candidate.input, candidate.fingerprint)
    candidate.onClose = () => {
      if (tunnel !== candidate) return
      tunnel = undefined; setSharedRuntimeProfile(undefined)
      status.connected = false; status.error = '服务器连接已断开，请重新登录'
      void stopAudit(); void closeSharedPools(); retryCount = 0; scheduleReconnect()
    }
    previousTunnel?.close(); retryCount = 0
    status.connecting = false; emit()
    scheduleSharedSync()
    return { ...sharedServerStatus(), needsTrust: false }
  } catch (error) {
    candidate?.close()
    if (ownGeneration === generation && !stopped) {
      tunnel = previousTunnel; setSharedRuntimeProfile(previousProfile); Object.assign(status, previousStatus)
      status.connecting = false
      if (candidate && previousProfile) await syncSharedServer()
      emit()
    }
    if ((error as any).code === 'SSH_HOST_TRUST') return { needsTrust: true, fingerprint: (error as any).fingerprint, changed: (error as any).changed }
    throw error
  } finally { configuring = false }
}
async function restoreLogin(): Promise<void> {
  if (stopped || configuring) return
  try {
    const input = automaticSSHInput()
    if (!input) { status.connecting = false; status.needsConfiguration = true; emit(); return }
    const result = await configure(input)
    if (result.needsTrust) {
      status.connecting = false; status.needsConfiguration = true
      status.error = '服务器身份发生变化，请重新登录并核对服务器指纹'; emit()
    }
  } catch (error) {
    if (stopped) return
    status.connected = false; status.error = String(error)
    if (/SSH登录失败|认证失败|认证被服务器拒绝|加密|已保存密码|ENOENT/.test(String(error))) retryCount = Infinity
    scheduleReconnect()
  }
}
export function keepSharedLogin(): void {
  if (tunnel) saveSharedSSH({ ...tunnel.input, keepSignedIn: true }, tunnel.fingerprint)
}
export async function disconnectSharedServer(): Promise<void> {
  const warnings=await disconnectSharedResources({
    stopBackground:()=>{stopped=true;++generation;clearTimeout(timer);clearTimeout(reconnectTimer);retryCount=3},
    clearSavedLogin:clearSharedLogin,
    waitForSync:()=>pending,
    closeAudit:stopAudit,
    closePools:closeSharedPools,
    closeTunnel:()=>{const old=tunnel;tunnel=undefined;old?.close()},
    clearProfile:()=>setSharedRuntimeProfile(undefined),
    publishDisconnected:()=>{Object.assign(status,{connected:false,connecting:false,needsConfiguration:true,libraries:0,error:'已退出服务器登录'});emit()}
  })
  if(warnings.length)console.warn('服务器连接已退出，部分清理操作未正常返回',warnings)
}
export async function startSharedServer(): Promise<void> {
  stopped = false; retryCount = 0
  const defaults = sharedServerDefaults()
  if (!defaults) return
  status.enabled = true; status.mode = defaults.mode ?? 'direct'
  if (defaults.mode === 'ssh' && automaticSSHInput()) { status.connecting = true; await restoreLogin() }
  else await syncSharedServer()
  scheduleSharedSync()
}
export function stopSharedServer(): void {
  stopped = true; ++generation; clearTimeout(timer); clearTimeout(reconnectTimer)
  const old = tunnel; tunnel = undefined; old?.close()
  void closeSharedPools().catch(error=>console.warn('关闭共享连接时已忽略失效连接',String(error)))
}
export function registerSharedServerIPC(ipcMain: IpcMain): void {
  ipcMain.handle('shared:status', () => sharedServerStatus())
  ipcMain.handle('shared:configuration', () => sharedSSHConfiguration())
  ipcMain.handle('shared:configure', (_, input: SharedSSHInput) => {stopped=false;return configure(input)})
  ipcMain.handle('shared:disconnect', () => disconnectSharedServer())
  ipcMain.handle('shared:sync', async () => { await syncSharedServer(); return sharedServerStatus() })
}

export async function connectDefaultSharedServer(approvedFingerprint?: string): Promise<any> {
  stopped = false
  for (let i = 0; configuring && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 100))
  if (status.connected) return sharedServerStatus()
  const value = automaticSSHInput() || { ...sharedSSHConfiguration(), password: '', keepSignedIn: true }
  const defaults = sharedServerDefaults()?.sshDefaults
  // Only the packaged, independently verified server identity is trusted by default.
  const packagedPin = !sharedSSHConfiguration().hasTrustedServer && defaults && value.host === defaults.host && value.port === defaults.port ? defaults.hostFingerprint : undefined
  return configure({ ...value, approvedFingerprint: approvedFingerprint || packagedPin })
}
