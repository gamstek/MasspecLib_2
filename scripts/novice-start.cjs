/* Windows source launcher: no credentials are embedded and no server data is modified. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..'), runtime = path.join(root, '.runtime', 'novice')
const fail = message => { throw new Error(message) }
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
  catch { fail(`无法读取 JSON 配置：${file}。请让管理员重新提供原文件，不要用 Word 编辑。`) }
}
function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  return major === 24 || (major === 22 && minor >= 13)
}
function fingerprint(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.replaceAll(':', '')) }
function sharedSshFingerprint(value) {
  return fingerprint(value) || (typeof value === 'string' && /^SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/.test(value))
}
function validateDelivery(p) {
  if (!p || p.enabled !== true || p.edition !== 'admin') fail('管理员配置必须启用，且 edition 必须是 admin。请勿使用客户端配置。')
  let url; try { url = new URL(p.endpoint) } catch { fail('管理员配置缺少有效的 HTTPS 服务地址。') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('管理员配置中的服务地址必须是 HTTPS 根地址。')
  if (!fingerprint(p.certificateFingerprint)) fail('管理员配置缺少有效的 HTTPS 证书指纹，请向管理员获取完整配置。')
  try { if (crypto.createPublicKey(p.publicKey).asymmetricKeyType !== 'ed25519') throw Error() }
  catch { fail('管理员配置缺少有效的交付签名公钥，请向管理员获取完整配置。') }
  if (p.gateway) {
    if (!p.gateway.username || typeof p.gateway.password !== 'string' || !Number.isInteger(p.gateway.port) || p.gateway.port < 1 || p.gateway.port > 65535 || !fingerprint(p.gateway.hostFingerprint)) fail('管理员配置中的 SSH 网关参数不完整，请向管理员获取原配置。')
  }
}
function validateShared(p) {
  if (!p || p.enabled !== true) fail('共享连接配置尚未启用。shared-server.example.json 只是占位样例，不能用于实际登录。')
  if (!p.user || typeof p.password !== 'string' || !/^mspec_lib2_[a-z0-9_]+$/.test(p.catalog || '') || !/^mspec_lib2_[a-z0-9_]+$/.test(p.auditDatabase || '')) fail('共享连接配置缺少数据库账号或目录信息，请向管理员获取完整文件。')
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || !['ssh', 'direct', undefined].includes(p.mode)) fail('共享连接配置中的模式或端口不正确。')
  if (p.mode === 'ssh') {
    const s = p.sshDefaults
    if (!s || !s.host || !s.username || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || !sharedSshFingerprint(s.hostFingerprint)) fail('共享连接配置缺少 SSH 地址、账号、端口或服务器指纹。')
  } else if (!p.host) fail('直连模式缺少数据库服务器地址。')
}
function profiles(directory = root) {
  const candidates = [path.join(directory, '连接配置', 'admin-profile.json'), path.join(directory, '连接配置', 'delivery-profile.json'), path.join(directory, 'resources', 'delivery-profile.json')]
  const delivery = candidates.find(p => fs.existsSync(p))
  const shared = [path.join(directory, '连接配置', 'shared-server.json'), path.join(directory, 'resources', 'shared-server.json')].find(p => fs.existsSync(p))
  if (!delivery || !shared) fail('缺少公司连接配置。\n请向管理员获取 admin-profile.json 和 shared-server.json 两个文件，\n将它们放入项目的“连接配置”文件夹，再双击“启动软件.cmd”。\n本包没有默认账号密码，也不会自动连接本地 MySQL。详情见 README.md 第 2 步。')
  validateDelivery(readJSON(delivery)); validateShared(readJSON(shared))
  return { delivery, shared }
}
function hashFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function inputHash() {
  const hash = crypto.createHash('sha256')
  function visit(folder) {
    if (!fs.existsSync(folder)) return
    for (const e of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink() || e.name === 'generated' || e.name === 'node_modules') continue
      const p = path.join(folder, e.name)
      if (e.isDirectory()) visit(p)
      else { hash.update(path.relative(root, p)); hash.update(fs.readFileSync(p)) }
    }
  }
  for (const name of ['src', 'prisma']) visit(path.join(root, name))
  for (const name of ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.node.json', 'tsconfig.web.json', 'prisma.config.ts']) { hash.update(name); hash.update(fs.readFileSync(path.join(root, name))) }
  return hash.digest('hex')
}
function stamp(file) { try { return readJSON(file) } catch { return {} } }
function writeStamp(file, value) { fs.mkdirSync(runtime, { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)) }
function command(exe, args, log) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.MASSPEC_BUILD_OUT
    if (args[0]?.endsWith(path.join('electron', 'install.js'))) { delete env.ELECTRON_SKIP_BINARY_DOWNLOAD; env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/' }
    const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] })
    child.stdout.on('data', b => { process.stdout.write(b); log.write(b) }); child.stderr.on('data', b => { process.stderr.write(b); log.write(b) })
    child.once('error', () => reject(Error('无法运行安装工具。请检查 Node.js 是否完整安装，并重新打开启动脚本。')))
    child.once('close', code => code === 0 ? resolve() : reject(Error(`工具执行失败（退出码 ${code}），请查看 logs/启动日志.txt。不要删除服务器或数据库。`)))
  })
}
async function main() {
  if (process.platform !== 'win32') fail('此一键启动入口适用于 Windows 10/11 64 位电脑；服务器部署请看 docs/server-deployment.md。')
  if (process.arch !== 'x64') fail('此入口按 Windows x64 验证，请使用 64 位 Windows 和 x64 Node.js。')
  if (!supportedNode(process.version)) fail(`当前 Node.js 为 ${process.version}。请安装 Node.js 24.x 或 22.13 以上的 22.x（x64），安装后重新打开启动脚本。`)
  const selected = profiles()
  console.log('公司连接配置检查完成（不会显示密码或密钥内容）。')
  console.log('启动模式：连接已有公司服务器；本机不安装 MySQL，不执行建库或初始化 SQL。')
  if (process.argv.includes('--check')) {
    const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    console.log(`Node.js ${process.version}；Electron ${fs.existsSync(exe) ? '已下载' : '尚未下载，首次启动会下载'}。`)
    console.log('检查完成。实际网络和登录权限会在软件登录时验证。'); return
  }
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
  const log = fs.createWriteStream(path.join(root, 'logs', '启动日志.txt'), { flags: 'a' })
  log.write(`\n--- ${new Date().toISOString()} Node ${process.version} ---\n`)
  const npm = args => command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ' + args.join(' ')], log)
  try {
    const installKey = [hashFile(path.join(root, 'package-lock.json')), process.versions.node.split('.')[0], process.platform, process.arch].join(':')
    const dependencyStamp = path.join(runtime, 'dependencies.json')
    if (stamp(dependencyStamp).key !== installKey || !fs.existsSync(path.join(root, 'node_modules/.package-lock.json'))) {
      console.log('[1/4] 首次安装依赖，需要联网下载，请等待。')
      await npm(['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'])
      writeStamp(dependencyStamp, { key: installKey })
    } else console.log('[1/4] 已有依赖，跳过重新安装。')
    const electronExe = path.join(root, 'node_modules/electron/dist/electron.exe')
    if (!fs.existsSync(electronExe)) {
      console.log('[2/4] 下载 Electron 桌面运行环境，请等待。')
      // npm ci skips optional native builds; Electron's own installer is run explicitly.
      await command(process.execPath, [path.join(root, 'node_modules/electron/install.js')], log)
    } else console.log('[2/4] 桌面运行环境已就绪。')
    if (!fs.existsSync(electronExe)) fail('Electron 下载未完成，请检查网络后重新运行启动脚本。')
    const buildStamp = path.join(runtime, 'build.json')
    const built = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'src/generated/prisma/client.ts'].every(p => fs.existsSync(path.join(root, p)))
    if (!built || stamp(buildStamp).key !== inputHash() || process.argv.includes('--rebuild')) {
      console.log('[3/4] 生成程序并编译。这里只生成代码，不连接数据库。')
      await npm(['run', 'db:gen']); await npm(['run', 'build'])
      writeStamp(buildStamp, { key: inputHash(), completedAt: new Date().toISOString() })
    } else console.log('[3/4] 程序已构建，跳过编译。')
    if (process.argv.includes('--prepare-only')) { console.log('准备完成；本次未打开软件窗口。'); return }
    console.log('[4/4] 正在打开管理员登录窗口。请使用管理员分配的软件账号。')
    const env = { ...process.env, NODE_ENV: 'production', MASSPECLIB2_DELIVERY_CONFIG: selected.delivery, MASSPECLIB2_SHARED_PROFILE: selected.shared }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
    await new Promise((resolve, reject) => {
      const child = spawn(electronExe, [root], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
      child.once('error', () => reject(Error('无法打开软件，请查看 README 的常见问题。')))
      child.once('close', code => code === 0 ? resolve() : reject(Error(`软件已退出（退出码 ${code}）。请记录窗口提示后联系维护人员。`)))
    })
  } finally { log.end() }
}
module.exports = { supportedNode, validateDelivery, validateShared, profiles }
if (require.main === module) main().catch(error => { console.error('\n启动未完成：' + error.message); process.exitCode = 1 })
