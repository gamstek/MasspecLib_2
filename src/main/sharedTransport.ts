/* eslint-disable @typescript-eslint/no-explicit-any */
import { safeStorage } from 'electron'
import { createServer, type Socket } from 'node:net'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabaseConfigDirectory } from './databaseConfig'
import { sharedServerDefaults } from './sharedServerProfile'

const { Client } = require('ssh2') as { Client: new () => any }
export interface SharedSSHInput {
  host: string; port: number; username: string; auth: 'password' | 'key'
  password?: string; keyFile?: string; passphrase?: string; rememberPassword?: boolean
  useSavedPassword?: boolean
  keepSignedIn?: boolean
  approvedFingerprint?: string
}
export interface SharedTunnel {
  host: string; port: number; fingerprint: string; input: SharedSSHInput
  close(): void; onClose?: () => void
}
function file(): string { return join(getDatabaseConfigDirectory(), 'shared-server.connection.json') }
function stored(): any { return existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {} }
export function sharedSSHConfiguration(): any {
  const value = stored(), defaults = sharedServerDefaults()
  return { enabled: !!defaults, mode: defaults?.mode ?? 'direct', host: value.host ?? defaults?.sshDefaults?.host ?? '',
    port: value.port ?? defaults?.sshDefaults?.port ?? 2222, username: value.username ?? defaults?.sshDefaults?.username ?? 'root', auth: value.auth ?? 'password',
    keyFile: value.keyFile ?? '', rememberPassword: !!value.rememberPassword,
    keepSignedIn: value.keepSignedIn ?? true,
    hasTrustedServer: !!value.fingerprint,
    hasPassword: !!value.encryptedPassword, useSavedPassword: !!value.encryptedPassword, hasPassphrase: !!value.encryptedPassphrase }
}
export function automaticSSHInput(): SharedSSHInput | undefined {
  const value = stored()
  if (!value.keepSignedIn || !value.fingerprint || !value.host || !value.username) return
  if (value.auth === 'password' && !value.passwordIsEmpty && !value.encryptedPassword) return
  return { host: value.host, port: value.port, username: value.username, auth: value.auth,
    keyFile: value.keyFile, password: '', useSavedPassword: !!value.encryptedPassword,
    keepSignedIn: true, rememberPassword: !!value.rememberPassword }
}
export function clearSharedLogin(): void {
  if (!existsSync(file())) return
  const value = stored()
  value.keepSignedIn = false
  delete value.encryptedPassword; delete value.encryptedPassphrase; delete value.passwordIsEmpty
  writeFileSync(file() + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(file() + '.tmp', file())
}
function decrypt(value?: string): string {
  return value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : ''
}
export function saveSharedSSH(input: SharedSSHInput, fingerprint: string): void {
  const previous = stored()
  const same = previous.host === input.host && previous.port === input.port && previous.username === input.username && previous.auth === input.auth && (previous.keyFile ?? '') === (input.keyFile ?? '')
  const value: any = { host: input.host, port: input.port, username: input.username, auth: input.auth,
    keyFile: input.keyFile ?? '', rememberPassword: !!input.rememberPassword,
    keepSignedIn: !!input.keepSignedIn, fingerprint,
    passwordIsEmpty: input.auth === 'password' && !input.useSavedPassword && !input.password }
  if (input.rememberPassword || input.keepSignedIn) {
    const needsEncryption = input.password || input.passphrase || (same && (previous.encryptedPassword || previous.encryptedPassphrase))
    if (needsEncryption && !safeStorage?.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，请取消保持登录后连接')
    if (same && input.useSavedPassword) value.encryptedPassword = previous.encryptedPassword
    else if (!input.useSavedPassword && input.password) value.encryptedPassword = safeStorage.encryptString(input.password).toString('base64')
    if (input.passphrase) value.encryptedPassphrase = safeStorage.encryptString(input.passphrase).toString('base64')
    else if (same) value.encryptedPassphrase = previous.encryptedPassphrase
  }
  mkdirSync(getDatabaseConfigDirectory(), { recursive: true })
  writeFileSync(file() + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(file() + '.tmp', file())
}
export async function openSharedTunnel(input: SharedSSHInput): Promise<SharedTunnel> {
  if (!input.host?.trim() || /[\s/\\]/.test(input.host) || !input.username?.trim() ||
      !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || !['password', 'key'].includes(input.auth))
    throw new Error('请填写有效的服务器地址、SSH端口、账号和登录方式')
  input = { ...input, host: input.host.trim(), username: input.username.trim() }
  const previous = stored(), defaults = sharedServerDefaults()
  const sameHost = previous.host === input.host && previous.port === input.port
  const sameUser = sameHost && previous.username === input.username && previous.auth === input.auth
  if (input.auth === 'password' && input.useSavedPassword && (!sameUser || !previous.encryptedPassword))
    throw new Error('此账号没有可用的已保存密码，请取消使用已保存密码后连接')
  const password = input.useSavedPassword ? decrypt(previous.encryptedPassword) : (input.password ?? '')
  const passphrase = input.passphrase || (sameUser && previous.keyFile === input.keyFile ? decrypt(previous.encryptedPassphrase) : '')
  if ((input.rememberPassword || input.keepSignedIn) && (password || passphrase) && !safeStorage?.isEncryptionAvailable())
    throw new Error('系统凭据加密不可用，请取消保持登录后连接')
  if (input.auth === 'key' && !input.keyFile) throw new Error('请选择OpenSSH或PEM格式的私钥文件')
  const privateKey = input.auth === 'key' ? readFileSync(input.keyFile!) : undefined
  let fingerprint = '', trustError: any
  const client = new Client(), sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, defaults?.databaseHost ?? '127.0.0.1', defaults?.databasePort ?? 3306, (error: Error | undefined, stream: any) => {
      if (error) { socket.destroy(error); return }
      stream.on('error', () => socket.destroy())
      socket.on('close', () => stream.destroy())
      socket.pipe(stream).pipe(socket)
    })
  })
  let result: SharedTunnel | undefined
  const close = (): void => { for (const socket of sockets) socket.destroy(); server.close(); client.end() }
  return new Promise((resolve, reject) => {
    client.on('error', (error: any) => {
      close()
      reject(trustError ?? new Error(error.level === 'client-authentication' ? (input.auth === 'key' ? 'SSH密钥认证失败，请检查账号、私钥和私钥口令' : 'SSH密码认证被服务器拒绝；允许提交空密码，但服务器需接受该认证方式') : 'SSH连接失败，请检查服务器地址、端口和网络'))
    })
    client.on('close', () => { for (const socket of sockets) socket.destroy(); server.close(); result?.onClose?.() })
    server.on('error', () => { close(); reject(new Error('无法建立本机内部连接通道')) })
    client.on('ready', () => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { close(); reject(new Error('内部连接通道未就绪')); return }
        result = { host: '127.0.0.1', port: address.port, fingerprint, input, close }
        resolve(result)
      })
    })
    client.connect({ host: input.host, port: input.port, username: input.username,
      password: input.auth === 'password' ? password : undefined, privateKey,
      passphrase: passphrase || undefined, readyTimeout: 12000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      hostHash: 'sha256', hostVerifier: (hex: string) => {
        fingerprint = 'SHA256:' + Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')
        const expected = input.approvedFingerprint || (sameHost ? previous.fingerprint : undefined)
        if (expected === fingerprint) return true
        trustError = Object.assign(new Error('请确认服务器身份'), { code: 'SSH_HOST_TRUST', fingerprint, changed: !!expected })
        return false
      }
    })
  })
}
