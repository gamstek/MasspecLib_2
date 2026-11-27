const {recordIonFlags}=require('../../src/shared/ionMode.mjs')

function mrmListFields(methods) {
  const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) &&
    Number.isFinite(Number(value)) ? Number(value) : null
  const fields = {}
  let index = 0
  for (const method of methods || []) {
    const q1 = number(method?.q1), q3 = number(method?.q3)
    if (!(q1 > 0 && q3 > 0)) continue
    const prefix = 'mrm' + ++index + '_'
    fields[prefix + 'q1'] = q1
    fields[prefix + 'q3'] = q3
    fields[prefix + 'dp'] = number(method.dp)
    fields[prefix + 'ce'] = number(method.ce)
    if (index === 2) break
  }
  return fields
}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), https = require('node:https')
const { fields, featureLabels, templates, normalizePolicy, fail, text, hash } = require('./policy.cjs')
const { customerFor } = require('./customer-name.cjs')
const { CredentialVault } = require('./credential-vault.cjs')
const { encryptOffline } = require('../../src/shared/offlineAccess.mjs')
const { writeIndexedOffline } = require('../../src/shared/indexedOffline.mjs')
const { offlineSummary, listProjector } = require('../../src/shared/offlineWorkspace.mjs')
const { packageStream, packageStreamFormat, packageStreamType } = require('../../src/shared/deliveryPackageStream.mjs')
const { pipeline } = require('node:stream/promises')
const { ClassificationService } = require('./classification.cjs')
const { Store, passwordHash } = require('./store.cjs')
const { SnapshotBuilder } = require('./snapshot.cjs')
const { FileLibraries, LibrarySnapshotBuilder, projectRecord } = require('./file-libraries.cjs')
const { databaseUploads } = require('./database-upload.cjs')
const { changeRelease } = require('./release-lifecycle.cjs')
const { accessCapabilities, validateAccess, configuration, readConfiguration } = require('./configuration.cjs')
const { queryOptions, matchesQuery, hasMethodQuery, methodColumns } = require('../../src/shared/deliveryQuery.mjs')
const { compoundColumnScopes } = require('../../src/shared/deliveryPresentation.mjs')
function discardUncommittedSnapshot(directory, result, store) {
  if (!result || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.id) || store.data.releases.some(r => r.id === result.id || r.snapshotId === result.id)) return
  const root = path.resolve(directory, 'datasets'), target = path.resolve(root, result.id)
  if (path.dirname(target) !== root || !fs.existsSync(target)) return
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isDirectory()) return
  try { if (JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')).id !== result.id) return; fs.rmSync(target, { recursive: true }) } catch { /* Unverified paths are retained for diagnosis. */ }
}
function createService({ directory, connect, maintenanceConnect, engine, privateKey, publicKey, publicUrl, certificateFingerprint, templateFile, gateway, credentialKeyFile, fileLibraryRoot, databaseUploadRoot, massbankPilot, requirePublication = false, store = new Store(directory) }) {
  const fileLibraries = new FileLibraries(fileLibraryRoot || path.join(directory, 'source-libraries'))
  const fileOp=require('./file-operations.cjs').fileOperations(fileLibraries.root)
  const uploads = databaseUploads(databaseUploadRoot || path.join(fileLibraries.root, 'uploads'))
  const builder = new LibrarySnapshotBuilder(connect, path.join(directory, 'datasets'), engine, fileLibraries), jobs = new Map(), loginAttempts = new Map()
  const vault = new CredentialVault(credentialKeyFile || path.join(directory, 'private-keys', 'credential-vault.key')), credentialAttempts = new Map()
  const classifications = new ClassificationService(directory, connect)
  builder.classificationProvider = classifications
  const publications = require('./publication.cjs').publicationStore(directory)
  const massbank = require('./massbank-update.cjs').massbankUpdates({ directory, fileOp, ...massbankPilot })
  const { parseAdminWorkspace } = require('../../src/shared/adminWorkspace.mjs')
  const workspaceFile = path.join(directory, 'admin-workspace.json')
  function readWorkspace(required = false) {
    try { return parseAdminWorkspace(JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))) }
    catch (error) {
      if (error.code === 'ENOENT' && !required) return null
      if (error.code === 'ENOENT') fail('服务器尚未设置管理员端正式配置', 503)
      fail('服务器管理员端正式配置无法读取，请联系维护人员', 503)
    }
  }
  function saveWorkspace(config) {
    const temp = workspaceFile + '.' + crypto.randomUUID() + '.tmp'
    try {
      fs.writeFileSync(temp, JSON.stringify(parseAdminWorkspace(config)), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, workspaceFile)
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
  }
  function includeLibrary(config, id) {
    if (!config || config.libraries.includes(id)) return
    if (config.libraries.length >= 100) fail('工作台数据库配置已达 100 个，请联系维护人员', 409)
    config.libraries.push(id)
    saveWorkspace(config)
  }
  function removeWorkspaceReference(key) {
    const config = readWorkspace()
    if (!config || !config.libraries.includes(key) && !config.removedLibraries?.includes(key)) return undefined
    const libraries = config.libraries.filter(id => id !== key)
    const removedLibraries = (config.removedLibraries || []).filter(id => id !== key)
    const defaultLibrary = config.defaultLibrary === key ? libraries.find(id => !removedLibraries.includes(id)) ?? null : config.defaultLibrary
    saveWorkspace({ ...config, libraries, removedLibraries, defaultLibrary })
    return () => saveWorkspace(config)
  }
  const isRemoved = (id, config = readWorkspace()) => !!config?.removedLibraries?.includes(id)
  async function requireAvailableLibrary(id) {
    const config = readWorkspace()
    if (isRemoved(id, config)) fail('该数据库已从共享工作台移除，请恢复后再使用', 409)
    if (!/^[a-f0-9]{64}$/.test(id) || !config?.removedLibraries?.some(key => key.startsWith('mspec_lib2_shared_'))) return
    const connection = await connect()
    try {
      const [rows] = await connection.query('SELECT database_name FROM mspec_lib2_catalog.libraries WHERE id=?', [id])
      if (isRemoved(rows[0]?.database_name, config)) fail('该数据库已从共享工作台移除，请恢复后再使用', 409)
    } finally { await connection.end() }
  }
  let workspaceTail = Promise.resolve()
  function changeWorkspace(action) {
    const result = workspaceTail.then(action)
    workspaceTail = result.catch(() => {})
    return result
  }
  const sourceArchive = databaseUploadRoot ? require('./source-archive.cjs') : null
  const archive = sourceArchive && {
    libraryId:sourceArchive.libraryId,
    title:sourceArchive.title,
    ensure:()=>changeWorkspace(async () => {
      const config = readWorkspace()
      const result = await fileOp('ensureSourceArchive',{uploadRoot:uploads.root})
      if (!isRemoved(result.libraryId,config)) includeLibrary(config,result.libraryId)
      return result
    }),
    write:input=>fileOp('archiveSourceBatch',input)
  }
  const updates = require('./source-updates.cjs').sourceUpdates({ directory, fileOp, ...massbankPilot, archive, isRemoved })
  function registerFile(input) {
    return changeWorkspace(async () => {
      const config = readWorkspace()
      if (!input.libraryId && config?.libraries.length >= 100) fail('工作台数据库配置已达 100 个，请联系维护人员', 409)
      const result = await fileOp('registerInput', input)
      if (!input.libraryId || !isRemoved(result.libraryId, config)) includeLibrary(config, result.libraryId)
      return result
    })
  }
  let building = false
  const sign = payload => ({ payload, signature: crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') })
  const displayCache = new Map()
  function publicRelease(r) {
    const { origins, tenantId, configuration: _configuration, access: _access, snapshotHistory:_history,snapshotId:_snapshot,...visible } = r
    const key = r.id + ':' + r.indexHash
    if (!displayCache.has(key)) {
      const rows = builder.index(r), allowed = r.policy.fields.ms || []
      displayCache.set(key, { compoundDisplay: compoundColumnScopes(rows, r.policy.fields.compound), methodQueryFields: allowed.some(k => ['q1','q3','polarity'].includes(k)) ? methodColumns(rows.map(row => builder.record(r, row.id, row)), allowed) : [] })
    }
    return { ...visible, ...displayCache.get(key) }
  }
  function current(token, role) { const u = store.authenticate(token); if (role && u.role !== role) fail('无此操作权限', 403); return u }
  function releaseFor(token, id) { const u = current(token); return store.authorize(u, id) }
  async function body(req) {
    let size = 0, chunks = []
    for await (const chunk of req) { size += chunk.length; if (size > (req.url === '/admin/source-updates/upload'?88:(['/admin/file-sources/mutate','/admin/file-sources/create-import','/admin/file-sources/restore','/admin/source-updates/publish'].includes(req.url) || req.url.startsWith('/admin/publication/'))?64:2) * 1024 * 1024) fail('请求配置过大，请分批选择化合物', 413); chunks.push(chunk) }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { fail('请求格式无效') }
  }
  function expiry(value) { if (!value) return null; const d = new Date(value); if (!Number.isFinite(+d) || +d <= Date.now()) fail('有效期必须晚于当前时间'); return d.toISOString() }
  function recordList(release, criteria) {
    let input
    try { input = queryOptions(criteria instanceof URLSearchParams ? Object.fromEntries(criteria) : criteria) }
    catch (error) { fail(error.message) }
    if (input.abnormal && !release.policy.features.checks) fail('此交付未开放检查结果', 403)
    if (hasMethodQuery(input) && ['q1','q3','polarity'].some(k => input[k] !== undefined && !(release.policy.fields.ms || []).includes(k))) fail('查询字段未开放', 403)
    return builder.index(release).filter(row => matchesQuery(hasMethodQuery(input) ? builder.record(release, row.id, row) : row, input))
  }
  const { classificationNavigationEnabled, classificationTree } = require('../../src/shared/deliveryClassification.mjs')
  const classificationCache = new Map()
  function classificationSummary(release, source) {
    const key = JSON.stringify([release.id, release.indexHash, source])
    if (classificationCache.has(key)) return classificationCache.get(key)
    const rows = builder.index(release).filter(row => !source || (row.sourceKey || row.sourceTitle) === source)
    const catalog = new Map()
    let unclassified = 0
    for (const { classification } of rows) {
      if (!classification?.items?.length) unclassified++
      for (const c of classification?.catalog || []) catalog.set(JSON.stringify([c.namespace, c.category_code]), c)
    }
    const summary = {
      catalog: [...catalog.values()],
      nodes: classificationTree(rows, { navigationDepth: release.policy.classification?.navigationDepth }),
      unclassified
    }
    if (classificationCache.size >= 48) classificationCache.delete(classificationCache.keys().next().value)
    classificationCache.set(key, summary)
    return summary
  }
  function displayRows(r,rows){return (r.policy.presentation?.mode==='table'||r.policy.presentation?.listFields?.some(id=>!id.startsWith('compound.')))?rows.map(row=>builder.record(r,row.id,row)):rows}
  async function offline(release) {
    if (!release.policy.features.offline) fail('未允许离线交付', 403)
    const records = builder.index(release).map(row => builder.record(release, row.id, row))
    return sign({ format: 'MasspecLib2-delivery', formatVersion: 1, tenantId: release.tenantId, issuedAt: new Date().toISOString(), expiresAt: release.expiresAt, manifest: publicRelease(release), records })
  }
  async function protectedOffline(release) {
    validateAccess(release.access, release.tenantId, store.data.users, store.data.offlineCredentials || [])
    const credential = store.data.offlineCredentials.find(c => c.id === release.access.offlineCredentialId)
    const password = vault.open(credential.secret, 'offline:' + credential.id)
    const data = { format: 'MasspecLib2-delivery', formatVersion: 1, tenantId: release.tenantId, issuedAt: new Date().toISOString(), expiresAt: release.expiresAt || null, manifest: publicRelease(release), records: builder.index(release).map(row => builder.record(release, row.id, row)) }
    return sign(await encryptOffline(data, credential.username, password))
  }
  async function handler(req, res) {
    const started = Date.now()
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (data, status = 200) => { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
    const url = new URL(req.url, 'https://localhost'), route = url.pathname.split('/').filter(Boolean), method = req.method
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    try {
      if (method === 'GET' && url.pathname === '/health') return send({ product: 'MasspecLib2 Delivery', version: require('../../package.json').version })
      if (method === 'POST' && url.pathname === '/login') {
        const input = await body(req), key = String(req.socket.remoteAddress) + ':' + String(input.username).toLowerCase().slice(0, 80)
        if (loginAttempts.size > 10000) for (const [k, v] of loginAttempts) if (v.until < Date.now()) loginAttempts.delete(k)
        const attempts = loginAttempts.get(key) ?? { count: 0, until: Date.now() + 15 * 60000 }
        if (attempts.until <= Date.now()) { attempts.count = 0; attempts.until = Date.now() + 15 * 60000 }
        if (attempts.count >= 10) fail('登录尝试过多，请15分钟后再试', 429)
        attempts.count++; loginAttempts.set(key, attempts)
        const result = await store.login(input.username, input.password, input.keepSignedIn === true, input.expectedTenant)
        loginAttempts.delete(key); return send(result)
      }
      const user = current(token)
      if (method === 'GET' && url.pathname === '/me') return send({ user: store.publicUser(user), customerName: store.data.tenants.find(t => t.id === user.tenantId)?.name || '', publicKey })
      if (method === 'POST' && url.pathname === '/logout') { await store.logout(token); return send({ ok: true }) }
      if (method === 'POST' && url.pathname === '/password') {
        const input = await body(req), { verifyPassword } = require('./store.cjs')
        if (!await verifyPassword(input.current, user.passwordHash)) fail('当前密码错误', 403)
        const digest = await passwordHash(input.password)
        await store.mutate(d => { current(token); user.passwordHash = digest; if (user.role === 'customer') user.credentialSecret = vault.seal(input.password, 'online:' + user.id); user.authVersion++; d.sessions = d.sessions.filter(s => s.userId !== user.id); store.event(user.id, 'change-password', user.id) })
        return send({ ok: true, loginRequired: true })
      }
      if (method === 'GET' && url.pathname === '/schema') { current(token, 'admin'); return send({ fields, featureLabels, templates, accessCapabilities,presentationVersion:1,inPlaceConfiguration:true, configurationVersion: 1, minimumAdminVersion: '2.6.3' }) }
      if (route[0] === 'admin' && route[1] === 'publication' && route.length === 3) {
        current(token, 'admin')
        if (method === 'GET') return send(publications.read(user.id, route[2]) || { state: 'missing' })
        if (method === 'POST') {
          const result = await publications.execute(user.id, route[2], await body(req), req.headers.authorization, handler)
          return send(result.data, result.status)
        }
      }
      if (route[0] === 'admin') {
        current(token, 'admin')
        if (route[1] === 'source-updates' && route.length === 3 && method === 'POST') {
          const input = await body(req)
          if (route[2] === 'list') return send(await updates.list())
          if (route[2] === 'upload') return send(await updates.upload({...input,actor:current(token,'admin').id}))
          if (route[2] === 'configure') return send(await updates.configure(input))
          if (route[2] === 'remove') return send(await updates.remove(input))
          if (route[2] === 'delete-batch') return send(await updates.deleteBatch(input))
          if (route[2] === 'check') return send(await updates.check(input),202)
          if (route[2] === 'compare') return send(await updates.compare(input))
          if (route[2] === 'inspect') return send(await updates.inspect(input))
          if (route[2] === 'publish') {
            if (!req.published) fail('请通过待发布变更发布',409)
            const result = await updates.publish({...input,actor:user.id})
            await store.mutate(()=>store.event(user.id,'source-update-publish',{batchId:result.batchId,changed:result.changed}))
            return send(result)
          }
        }
        if (route[1] === 'massbank-update' && route.length === 3 && method === 'POST') {
          const input = await body(req)
          if (route[2] === 'status') {
            const status = massbank.status(input)
            if (!status.enabled) return send(status)
            try { return send({ ...status, libraryName: fileLibraries.entry(status.libraryId).title }) }
            catch (error) { if (error.status !== 404) throw error; return send({ enabled: false }) }
          }
          if (route[2] === 'check') return send(await massbank.download(input), 202)
          if (route[2] === 'compare') return send(await massbank.compare(input))
          if (route[2] === 'publish') {
            if (!req.published) fail('请通过待发布变更发布', 409)
            const { operations: _, rows: _rows, ...result } = await massbank.compare({ ...input, actor: user.id }, true)
            await store.mutate(() => store.event(user.id, 'massbank-pilot-publish', { libraryId: input.libraryId, commit: result.commit, count: result.changed }))
            return send(result)
          }
        }
        if (requirePublication && method === 'POST' && !req.published &&
          (/^\/admin\/classification\/(category|category-status|mapping|default-major|role|assign|unlock)$/.test(url.pathname) ||
           /^\/admin\/file-sources\/(mutate|change|update-compound|default-major|restore|register|convert|create-import)$/.test(url.pathname)))
          fail('请升级管理员端到2.8.24或以上，并通过待发布变更发布共享修改', 409)
        if (url.pathname === '/admin/workspace' || url.pathname === '/admin/workspace/library-visibility') {
          if (method === 'GET' && url.pathname === '/admin/workspace') {
            const config = readWorkspace(true)
            const libraries = config.libraries.filter(id => !config.removedLibraries?.includes(id))
            const defaultLibrary = libraries.includes(config.defaultLibrary) ? config.defaultLibrary : null
            return send({ ...config, libraries, defaultLibrary })
          }
          if (method === 'POST' && url.pathname === '/admin/workspace/library-visibility') {
            const { key, removed } = await body(req)
            current(token, 'admin')
            if (typeof removed !== 'boolean' || typeof key !== 'string' ||
              !/^(mspec_lib2_shared_[0-9a-f]{20}|file:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(key)) fail('数据库标识无效')
            await changeWorkspace(async () => {
              current(token, 'admin')
              if (key.startsWith('file:')) fileLibraries.entry(key)
              else {
                const reader = await connect()
                try {
                  const [rows] = await reader.query('SELECT id FROM mspec_lib2_catalog.libraries WHERE database_name=?', [key])
                  if (!rows.length) fail('数据库未登记', 404)
                } finally { await reader.end() }
              }
              current(token, 'admin')
              const config = readWorkspace(true), hidden = new Set(config.removedLibraries)
              if (removed) {
                hidden.add(key)
              } else {
                hidden.delete(key)
                if (!config.libraries.includes(key)) {
                  if (config.libraries.length >= 100) fail('工作台数据库配置已达 100 个，请联系维护人员', 409)
                  config.libraries.push(key)
                }
              }
              if (hidden.size > 500) fail('已移除列表已满，请先恢复不再隐藏的条目')
              saveWorkspace({ ...config, removedLibraries: [...hidden] })
            })
            return send({ removed })
          }
        }
        if(method==='POST'&&url.pathname==='/admin/file-sources/delete-database'){
          const input=await body(req),key='delete:'+user.id,attempt=credentialAttempts.get(key)||{count:0,until:Date.now()+15*60000};
          if(attempt.until<Date.now()){attempt.count=0;attempt.until=Date.now()+15*60000}if(attempt.count>=5)fail('密码尝试过多，请15分钟后再试',429);attempt.count++;credentialAttempts.set(key,attempt);
          if(!await require('./store.cjs').verifyPassword(input.password,user.passwordHash))fail('管理员密码错误，未删除服务器数据',403);
          current(token,'admin');if(building)fail('正在生成交付，请完成后再删除数据库',409);building=true;
          try {
            const result = await changeWorkspace(async () => {
              current(token,'admin')
              if (!String(input.libraryId).startsWith('file:')) {
                return require('./database-removal.cjs').removeServerDatabase({
                  libraryId:input.libraryId,fileLibraries,connect,maintenanceConnect,directory,
                  removeWorkspaceReference
                })
              }
              const entry = fileLibraries.entry(input.libraryId)
              if (entry.managedSourceArchive) fail('自动更新谱库由服务器维护，可从工作台隐藏',403)
              const restoreReference = removeWorkspaceReference(input.libraryId)
              try {
                return await fileOp('removeFileDatabase',{libraryId:input.libraryId,serverDirectory:directory})
              } catch (error) {
                if (fileLibraries.state().libraries.some(item => item.id === entry.id)) restoreReference?.()
                throw error
              }
            })
            await store.mutate(()=>{store.event(user.id,'delete-server-database',input.libraryId)})
            credentialAttempts.delete(key)
            return send(result)
          } finally {building=false}
        }
        if (method === 'GET' && url.pathname === '/admin/file-sources') {
          const libraries = await fileOp('list')
          const configFile = path.join(directory, 'admin-workspace.json')
          let removed = []
          try { removed = JSON.parse(fs.readFileSync(configFile, 'utf8')).removedLibraries || [] }
          catch (error) { if (error.code !== 'ENOENT') throw error }
          return send({ root: fileLibraries.root, uploadRoot: uploads.root, uploadMaxBytes: uploads.maxBytes, libraries: url.searchParams.get('includeRemoved') === '1'
            ? libraries : libraries.filter(entry => !removed.includes(entry.libraryId)) })
        }
        if (route[1] === 'file-sources' && route[2] === 'upload' && route.length === 4) {
          const id = route[3]
          if (method === 'POST' && id === 'start') return send(uploads.start(user.id, await body(req)), 201)
          if (method === 'PUT') return send(await uploads.append(user.id, id, Number(url.searchParams.get('offset') ?? NaN), req))
          if (method === 'POST') return send(await uploads.finish(user.id, id,
            input => fileOp('checkFormat', input), () => current(token, 'admin')))
          if (method === 'DELETE') return send(uploads.cancel(user.id, id))
        }
        if (method === 'POST' && url.pathname === '/admin/file-sources/convert')
          fail('请通过「数据库管理 → 上传数据库」添加服务器文件库', 409)
        if (method === 'POST' && url.pathname === '/admin/file-sources/check-format') return send(await fileOp('checkFormat',await body(req)))
        if (method === 'POST' && url.pathname === '/admin/file-sources/scan') return send(await fileOp('scan',(await body(req)).directory))
        if (method === 'POST' && url.pathname === '/admin/file-sources/create-import') {
          if (!req.published) fail('请通过待发布变更发布新库',409)
          const input = await body(req)
          const result = await changeWorkspace(async () => {
            current(token,'admin')
            const config = readWorkspace(true)
            if (!config.libraries.includes('file:'+input.id) && config.libraries.length >= 100) fail('工作台数据库配置已达100个',409)
            const result = await fileOp('createImportedLibrary',{...input,uploadRoot:uploads.root,actor:user.id})
            includeLibrary(config,result.libraryId)
            return result
          })
          await store.mutate(()=>store.event(user.id,'create-import-file-library',result.libraryId))
          return send(result,201)
        }
        if (method === 'POST' && url.pathname === '/admin/file-sources/register') {
          const input = await body(req); current(token, 'admin')
          const result = await registerFile(input)
          await store.mutate(() => store.event(user.id, input.libraryId ? 'relink-file-source' : 'register-file-source', { libraryId: result.libraryId, revision: result.revision })); return send(result, 201)
        }
        if (method === 'POST' && url.pathname === '/admin/file-sources/access') {
          const input = await body(req)
          current(token, 'admin')
          const result = await fileOp('setAccess', input)
          await store.mutate(() => store.event(user.id, 'set-file-access', { libraryId: input.libraryId, readOnly: result.readOnly }))
          return send(result)
        }
        if(method==='POST'&&url.pathname==='/admin/file-sources/default-major'){const input=await body(req);current(token,'admin');const result=await fileOp('setDefault',input);await store.mutate(()=>{current(token,'admin');store.event(user.id,'set-file-default-major',{libraryId:input.libraryId,major:input.major})});return send(result)}
        if (method === 'POST' && url.pathname === '/admin/file-sources/records') {
          const result = await fileOp('rows',{...await body(req),includeMrmSummary:true})
          return send({ total: result.total, page: result.page, revision: result.entry.revision, categories: result.categories || [], classes: result.classes,
            rows: result.rows.map(r => ({ id: r.id, key: r.key, ...r.record.compound,
              ...mrmListFields(r.record.mrmPreview ?? r.record.ms), ionModes: recordIonFlags(r.record) })) })
        }
        if (method === 'POST' && url.pathname === '/admin/file-sources/categories') return send(await fileOp('categories',await body(req)))
        if(method==='POST'&&['/admin/file-sources/backup','/admin/file-sources/restore'].includes(url.pathname)){const input=await body(req);current(token,'admin');const result=await fileOp(url.pathname.endsWith('/backup')?'backup':'restore',{...input,actor:user.id});if(url.pathname.endsWith('/restore'))await store.mutate(()=>store.event(user.id,'restore-lds-workspace',{libraryId:input.libraryId}));return send(result)}
        if(method==='POST'&&url.pathname==='/admin/file-sources/peaks')return send(await fileOp('peaks',await body(req)))
        if(method==='POST'&&url.pathname==='/admin/file-sources/mutate'){const input=await body(req);if(input.action==='massbank-add')fail('请使用 MassBank 待发布变更');current(token,'admin');const result=await fileOp('mutate',{...input,actor:user.id});await store.mutate(()=>store.event(user.id,'lds-'+input.action,{libraryId:input.libraryId,count:result.changed,revision:result.revision}));return send(result)}
        if (method === 'POST' && url.pathname === '/admin/file-sources/record') {
          const input = await body(req), result = await fileOp('rows',{ ...input, onlySelected: true, compoundIds: [input.id], details: true }), row = result.rows[0]
          if (!row) fail('记录不存在，请刷新', 404)
          const policy = normalizePolicy({ fields: Object.fromEntries(Object.entries(fields).map(([g,f]) => [g,Object.keys(f)])), features: { spectra: true, lc: true, chromatograms: true, experiments: true } })
          const record = projectRecord(row.record, policy, hash(result.entry.id + ':' + row.key).slice(0,32), result.entry.id, result.entry.title, hash(result.entry.id + ':' + row.key), { normalizeLiquid: false })
          return send({ record:result.entry.adapter==='lds-cn'?{...row.record,sourceTitle:result.entry.title}:record, workspace:result.entry.adapter==='lds-cn',revision:result.entry.revision, readOnly:!!result.entry.readOnly,trash:!!input.trash, manifest: { title: result.entry.title, policy, fieldLabels: fields } })
        }
        if (method === 'POST' && url.pathname === '/admin/file-sources/update-compound') {
          const input=await body(req);current(token,'admin');const result=await fileOp('updateCompound',{...input,actor:user.id})
          await store.mutate(()=>{current(token,'admin');store.event(user.id,'edit-file-compound',{libraryId:input.libraryId,id:input.id,revision:result.revision})});return send(result)
        }
        if (method === 'POST' && url.pathname === '/admin/file-sources/change') {
          const input = await body(req); current(token, 'admin')
          const result = await fileOp('change',{...input,actor:user.id})
          await store.mutate(() => { current(token, 'admin'); store.event(user.id, 'file-record-' + input.action, { libraryId: input.libraryId, count: result.changed, revision: result.revision }) }); return send(result)
        }
        if (route[1] === 'classification') {
          const authenticate = () => current(token, 'admin')
          if (method === 'GET' && route[2] === 'state') return send(await classifications.state(user.id, authenticate))
          if (method === 'POST') {
            const input = await body(req)
            if (route[2] === 'plans') return send(await classifications.plans(input.key, input.databases, user.id, authenticate))
            if (route[2] === 'counts') return send(await classifications.counts(input.databases, user.id, authenticate))
            const action = { 'default-major':'saveDefault',role: 'saveRole', category: 'saveCategory', 'category-status':'setCategoryStatus', mapping: 'saveMapping', assign: 'assign', unlock: 'unlock' }[route[2]]
            if (action && route.length === 3) return send(await classifications[action](input, user.id, authenticate))
          }
          fail('分类操作不存在', 404)
        }
        if (method === 'GET' && route.length === 2 && route[1] === 'state') return send({ drafts: store.data.drafts || [], offlineCredentials: (store.data.offlineCredentials || []).map(c => ({ id: c.id, tenantId: c.tenantId, username: c.username })), users: store.data.users.map(u => store.publicUser(u)), tenants: store.data.tenants, releases: store.data.releases, jobs: [...jobs.values()], events: store.data.events.slice(-200).reverse() })
        if (method === 'POST' && route.length === 2 && route[1] === 'drafts') {
          const input = await body(req), id = input.id || crypto.randomUUID()
          if (!/^[a-f0-9-]{36}$/.test(id)) fail('草稿标识无效')
          const draft = { id, updatedAt: new Date().toISOString(), actor: user.id, revision: 1 }
          for (const key of ['customerName', 'tenantId', 'deliveryAt', 'expiresAt', 'notes', 'selections', 'policy', 'access', 'offlineUsername', 'replacesId', 'expectedRevision']) {
            if (Object.hasOwn(input, key)) draft[key] = input[key]
          }
          await store.mutate(d => {
            current(token, 'admin')
            d.drafts ||= []
            if (input.id) {
              const index = d.drafts.findIndex(x => x.id === id)
              if (index < 0) fail('配置草稿已删除或已用于生成交付，请重新创建', 409)
              if (input.revision !== d.drafts[index].revision) fail('草稿已被修改，请重新打开后保存', 409)
              draft.revision = d.drafts[index].revision + 1
              d.drafts[index] = draft
            } else d.drafts.push(draft)
            store.event(user.id, 'save-delivery-draft', id)
          })
          return send(draft)
        }
        if (method === 'POST' && route.length === 3 && route[1] === 'drafts' && route[2] === 'delete') {
          const { id, revision } = await body(req)
          if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('草稿标识无效')
          await store.mutate(d => {
            current(token, 'admin')
            const index = (d.drafts || []).findIndex(x => x.id === id)
            if (index < 0) return
            if (revision !== d.drafts[index].revision) fail('草稿已被修改，请核对最新版本后再删除', 409)
            d.drafts.splice(index, 1)
            store.event(user.id, 'delete-delivery-draft', id)
          })
          return send({ ok: true })
        }
        if (method === 'POST' && route.length === 2 && route[1] === 'access-credentials') return send(await store.createAccessCredentials(await body(req), user.id, vault, () => current(token, 'admin')), 201)
        if (method === 'POST' && route.length === 2 && route[1] === 'view-credentials') {
          const input = await body(req), { verifyPassword } = require('./store.cjs'), attempts = credentialAttempts.get(user.id) || { count: 0, until: Date.now() + 15 * 60000 }
          if (attempts.until <= Date.now()) { attempts.count = 0; attempts.until = Date.now() + 15 * 60000 }
          if (attempts.count >= 10) fail('验证尝试过多，请15分钟后再试', 429)
          attempts.count++; credentialAttempts.set(user.id, attempts)
          if (!await verifyPassword(input.currentPassword, user.passwordHash)) fail('管理员密码验证失败', 403)
          current(token, 'admin'); credentialAttempts.delete(user.id)
          const release = store.data.releases.find(r => r.id === input.releaseId)
          if (!release) fail('交付不存在', 404)
          let username, password
          if (input.kind === 'offline') {
            const credential = (store.data.offlineCredentials || []).find(c => c.id === release.access?.offlineCredentialId && c.tenantId === release.tenantId)
            if (!credential) fail('此交付未设置离线凭据', 409)
            username = credential.username; password = vault.open(credential.secret, 'offline:' + credential.id)
          } else if (input.kind === 'online') {
            const account = store.data.users.find(u => u.id === release.access?.userId && u.role === 'customer' && u.tenantId === release.tenantId)
            if (!account) fail('此交付未关联在线账号', 409)
            username = account.username; password = vault.open(account.credentialSecret, 'online:' + account.id)
          } else fail('请选择在线或离线凭据')
          await store.mutate(() => { current(token, 'admin'); store.event(user.id, 'view-credentials', { releaseId: release.id, kind: input.kind, username }) })
          return send({ username, password, kind: input.kind, deliveryAt: release.deliveryAt, revision: release.version })
        }
        if (method === 'GET' && route.length === 2 && route[1] === 'libraries') {
          const libraries = await builder.libraries(), config = readWorkspace()
          return send(libraries.filter(library => !isRemoved(library.id, config) && !isRemoved(library.database_name, config)))
        }
        if (method === 'POST' && route.length === 2 && route[1] === 'candidates') {
          const input = await body(req)
          await requireAvailableLibrary(input.libraryId)
          return send(await builder.candidates(input))
        }
        if (method === 'POST' && route.length === 2 && route[1] === 'users') {
          const input = await body(req)
          // Additional administrator provisioning is deliberately a server maintenance action.
          return send(await store.createUser({ ...input, role: 'customer' }, user.id, vault), 201)
        }
        if (method === 'PATCH' && route.length === 3 && route[1] === 'users') {
          const input = await body(req), target = store.data.users.find(u => u.id === route[2] && u.role === 'customer')
          if (!target) fail('客户账号不存在', 404)
          const digest = input.password ? await passwordHash(input.password) : undefined
          await store.mutate(d => { current(token, 'admin'); if (typeof input.disabled === 'boolean') target.disabled = input.disabled; if (digest) { target.passwordHash = digest; target.credentialSecret = vault.seal(input.password, 'online:' + target.id) }; target.authVersion++; d.sessions = d.sessions.filter(s => s.userId !== target.id); store.event(user.id, 'update-user', target.id) })
          return send(store.publicUser(target))
        }
        if (method === 'POST' && route.length === 2 && route[1] === 'releases') {
          const input = await body(req); normalizePolicy(input.policy)
          if (Array.isArray(input.selections)) for (const selection of input.selections) await requireAvailableLibrary(selection?.libraryId)
          function checkSavedDraft(data) {
            if (!input.draftId) return
            const saved = (data.drafts || []).find(draft => draft.id === input.draftId)
            if (!saved) fail('配置草稿已删除或已用于生成交付，请重新创建', 409)
            if (input.draftRevision !== undefined && input.draftRevision !== saved.revision)
              fail('草稿已被修改，请重新打开后生成交付', 409)
          }
          checkSavedDraft(store.data)
          if (!Object.hasOwn(input, 'access') && !Object.hasOwn(input, 'deliveryAt')) fail('请升级管理员端到 2.6.3 或更高版本，并补齐登录与交付时间配置', 409)
          const chosenCustomer = customerFor(store.data.tenants, input)
          input.tenantId = chosenCustomer.tenant.id
          const config = configuration(input, input.tenantId, store.data.users, new Date(), store.data.offlineCredentials || [])
          Object.assign(input, config)
          const expiresAt = expiry(input.expiresAt)
          const previous = input.replacesId && store.data.releases.find(r => r.id === input.replacesId && r.tenantId === input.tenantId && r.state !== 'deleted')
          if (input.replacesId && !previous) fail('交付不存在或不属于该客户')
          if(previous&&input.expectedRevision&&previous.version!==input.expectedRevision)fail('配置已被其他管理员更新，请重新打开',409)
          if(previous&&!input.expectedRevision)fail('请重新打开已有配置后保存',409)
          const expectedVersion=previous?.version,expectedState=previous?.state
          if (building) fail('已有交付任务正在生成，请等待完成', 409)
          const job = { id: crypto.randomUUID(), state: 'building', count: 0, error: '', createdAt: new Date().toISOString() }
          jobs.set(job.id, job); building = true
          void (async () => {
            let result
            try {
              result = await builder.build(input, n => { job.count = n })
              await store.mutate(d => { current(token, 'admin'); checkSavedDraft(d); const resolved = customerFor(d.tenants, chosenCustomer.created ? { customerName: chosenCustomer.tenant.name } : { tenantId: input.tenantId, customerName: input.customerName }); if (resolved.created) { d.tenants.push(resolved.tenant); store.event(user.id, 'create-customer', resolved.tenant.id) }; validateAccess(config.access, resolved.tenant.id, d.users, d.offlineCredentials || []); if (previous && !d.releases.some(r => r.id === previous.id && r.tenantId === resolved.tenant.id && r.state !== 'deleted')) fail('原交付已删除或发生变化，请重新打开配置', 409); if (expiresAt && Date.parse(expiresAt) <= Date.now()) fail('生成期间授权到期，请重新设置有效期', 409); if(input.draftId)d.drafts=(d.drafts||[]).filter(x=>x.id!==input.draftId); const updated={ ...result, ...config, configuration: { selections: JSON.parse(JSON.stringify(input.selections)) }, tenantId: resolved.tenant.id, expiresAt, familyId: previous?.familyId || previous?.id || result.id, replacesId: null, state: previous?.state==='published'?'published':'draft' };if(previous){const target=d.releases.find(x=>x.id===previous.id);if(!target||target.version!==expectedVersion||target.state!==expectedState)fail('配置已更新，本次保存已取消',409);const history=[...(target.snapshotHistory||[]),{snapshotId:target.snapshotId||target.id,version:target.version,indexHash:target.indexHash,savedAt:new Date().toISOString()}];Object.assign(target,updated,{id:target.id,snapshotId:result.id,snapshotHistory:history,packageInfo:null})}else d.releases.push(updated); store.event(user.id, 'build-release', result.id) })
              job.state = 'ready'; job.releaseId = previous?.id || result.id
            } catch (e) { discardUncommittedSnapshot(directory, result, store); job.state = 'failed'; job.error = e.status ? e.message : '生成失败，请查看服务器日志'; console.error(new Date().toISOString(), 'release-build', e.message) }
            finally { building = false }
          })()
          return send(job, 202)
        }
        if (route[1] === 'releases' && route.length >= 3) {
          if (method === 'POST' && route.length === 4 && ['delete', 'restore', 'purge'].includes(route[3])) {
            const input = await body(req)
            return send(await changeRelease({ store, directory: path.join(directory, 'datasets'), id: route[2], action: route[3], confirmation: input.confirmation, actor: user.id, authenticate: () => current(token, 'admin') }))
          }
          const r = store.data.releases.find(r => r.id === route[2]); if (!r) fail('交付版本不存在', 404)
          if (method === 'POST' && route.length === 4 && route[3] === 'packaged') {
            const input=await body(req);if(r.state!=='published'||!(/^[a-f0-9]{64}$/.test(input.sha256))||!Number.isSafeInteger(input.bytes)||input.bytes<1)fail('安装包记录无效')
            await store.mutate(()=>{current(token,'admin');r.packageInfo={generatedAt:new Date().toISOString(),sha256:input.sha256,bytes:input.bytes};store.event(user.id,'package-complete',{releaseId:r.id,...r.packageInfo})});return send({ok:true})
          }
          if (method === 'GET' && route.length === 4 && route[3] === 'configuration') return send(readConfiguration(r, store.data.tenants, store.data.users, store.data.offlineCredentials || []))
          if (r.state === 'deleted') fail('此版本已移入回收站，请先恢复为草稿', 409)
          if (method === 'POST' && route.length === 4 && route[3] === 'publish') {
            if (r.state !== 'draft') fail('只有草稿可以发布')
            if (r.expiresAt && Date.parse(r.expiresAt) <= Date.now()) fail('交付有效期已过')
            validateAccess(r.access, r.tenantId, store.data.users, store.data.offlineCredentials || [])
            builder.index(r)
            await store.mutate(() => { current(token, 'admin'); if (r.state !== 'draft') fail('只有草稿可以发布'); validateAccess(r.access, r.tenantId, store.data.users, store.data.offlineCredentials || []); for (const old of store.data.releases) if (old.id !== r.id && old.tenantId === r.tenantId && (old.familyId || old.id) === r.familyId && old.state === 'published') { old.state = 'superseded'; store.event(user.id, 'supersede-release', old.id) }; r.state = 'published'; r.publishedAt = new Date().toISOString(); store.event(user.id, 'publish-release', r.id) })
            return send(r)
          }
          if (method === 'POST' && route.length === 4 && route[3] === 'revoke') { await store.mutate(() => { current(token, 'admin'); if (r.state === 'deleted') fail('此版本已移入回收站', 409); r.state = 'revoked'; store.event(user.id, 'revoke-release', r.id) }); return send({ ok: true }) }
          if (method === 'GET' && route.length === 4 && route[3] === 'records') return send({ manifest: publicRelease(r), rows: recordList(r, url.searchParams).slice(0, 100).map(row=>(r.policy.presentation?.mode==='table'||r.policy.presentation?.listFields?.some(id=>!id.startsWith('compound.')))?builder.record(r,row.id,row):row), total: r.total })
          if (method === 'GET' && route.length === 5 && route[3] === 'records') return send(builder.record(r, route[4]))
          if (method === 'POST' && route.length === 4 && route[3] === 'package') {
            const input = await body(req)
            store.authorize(user, r.id)
            if (r.access?.mode !== 'offline') fail('请先重新配置客户账号密码并生成内置数据交付，再生成 MSI', 409)
            validateAccess(r.access, r.tenantId, store.data.users, store.data.offlineCredentials || [])
            const tenant = store.data.tenants.find(t => t.id === r.tenantId)
            if (!templateFile || !fs.existsSync(templateFile)) fail('客户端打包模板尚未准备好', 503)
            const templateHash = await new Promise((resolve, reject) => { const h = crypto.createHash('sha256'), s = fs.createReadStream(templateFile); s.on('data', chunk => h.update(chunk)); s.on('error', reject); s.on('end', () => resolve(h.digest('hex'))) })
            current(token, 'admin'); store.authorize(user, r.id); validateAccess(r.access, r.tenantId, store.data.users, store.data.offlineCredentials || [])
            const profile = { enabled: true, edition: 'customer', tenantId: tenant.id, customerName: tenant.name, title: r.title, defaultReleaseId: r.id, accessMode: 'offline', loginUsername: store.data.offlineCredentials.find(c => c.id === r.access.offlineCredentialId)?.username || '', allowOffline: true, endpoint: '', certificateFingerprint: '', publicKey, version: require('../../package.json').version }
            const prepare = async () => {
              current(token, 'admin'); store.authorize(user, r.id); validateAccess(r.access, r.tenantId, store.data.users, store.data.offlineCredentials || [])
              await store.mutate(() => store.event(user.id, 'prepare-package', { releaseId: r.id, tenantId: r.tenantId, templateHash }))
            }
            const manifest = publicRelease(r)
            let indexedTemplate
            if (input.format === packageStreamFormat) {
              try {
                const template = JSON.parse(await fs.promises.readFile(templateFile + '.indexed.json', 'utf8'))
                if (template.sha256 === templateHash && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(template.version)) indexedTemplate = template
              } catch (error) { if (error.code !== 'ENOENT') throw error }
            }
            if (!indexedTemplate) {
              const payload = { profile, templateHash, release: manifest, offline: await protectedOffline(r) }
              await prepare()
              return send(sign(payload))
            }
            profile.version = indexedTemplate.version
            const controller = new AbortController(), abort = () => { if (!res.writableFinished) controller.abort() }
            res.once('close', abort)
            let temporary
            try {
              temporary = await fs.promises.mkdtemp(path.join(directory, '.indexed-package-'))
              const file = path.join(temporary, 'body'), credential = store.data.offlineCredentials.find(c => c.id === r.access.offlineCredentialId)
              const password = vault.open(credential.secret, 'offline:' + credential.id)
              const snapshot = { ...r }
              const records = (function* () { for (const row of builder.index(snapshot)) yield builder.record(snapshot, row.id, row) })()
              const indexed = await writeIndexedOffline(file, {
                tenantId: r.tenantId, manifest, expiresAt: r.expiresAt, records, summarize: offlineSummary, project: listProjector(manifest)
              }, credential.username, password, sign, controller.signal)
              const stream = await packageStream({ profile, templateHash, release: manifest }, file, indexed, sign, controller.signal)
              await prepare()
              if (r.indexHash !== snapshot.indexHash || r.version !== snapshot.version) fail('交付配置已变化，请重新生成', 409)
              res.writeHead(200, { 'Content-Type': packageStreamType, 'Content-Length': stream.bytes })
              await pipeline(stream.chunks, res, { signal: controller.signal })
              return
            } finally {
              res.off('close', abort)
              if (temporary) await fs.promises.rm(temporary, { recursive: true, force: true })
            }
          }
        }
        if (method === 'GET' && route.length === 2 && route[1] === 'client-template') {
          if (!templateFile || !fs.existsSync(templateFile)) fail('客户端模板尚未准备好', 503)
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(templateFile).size })
          const stream = fs.createReadStream(templateFile); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return
        }
        fail('接口不存在', 404)
      }
      if (method === 'GET' && route.length === 1 && route[0] === 'releases') return send(store.data.releases.filter(r => { try { store.authorize(user, r.id); return true } catch { return false } }).map(publicRelease))
      if (route[0] === 'releases' && route.length >= 2) {
        const r = releaseFor(token, route[1])
        if (method === 'GET' && route.length === 3 && route[2] === 'records') {
          const rows = recordList(r, url.searchParams), page = Math.max(1, Math.min(1000000, Math.trunc(Number(url.searchParams.get('page')) || 1))), size = Math.max(1, Math.min(200, Math.trunc(Number(url.searchParams.get('pageSize')) || 50)))
          return send({ rows: displayRows(r,rows.slice((page - 1) * size, page * size)), total: rows.length, page, pageSize: size, manifest: publicRelease(r) })
        }
        if (method === 'POST' && route.length === 3 && route[2] === 'query') {
          const input = await body(req)
          const rows = recordList(r, input)
          const page = Math.max(1, Math.trunc(Number(input.page) || 1)), size = Math.max(1, Math.min(200, Math.trunc(Number(input.pageSize) || 50)))
          const classification = classificationNavigationEnabled(r.policy)
            ? classificationSummary(r, String(input.source || '')) : undefined
          return send({ rows: displayRows(r,rows.slice((page-1)*size, page*size)), matchedIds: input.recordIds ? rows.map(row => row.id) : undefined, total: rows.length, manifest: publicRelease(r), classification })
        }
        if (method === 'GET' && route.length === 4 && route[2] === 'records') return send({ ...builder.record(r, route[3]), reviews: store.data.reviews.filter(x => x.tenantId === user.tenantId && x.releaseId === r.id && x.recordId === route[3]).map(({ tenantId, userId, ...x }) => x) })
        if (method === 'POST' && route.length === 4 && route[2] === 'review') {
          if (!r.policy.features.review) fail('未开放人工复核', 403)
          const record = builder.record(r, route[3]), input = await body(req)
          if (!['reviewed', 'retest', 'exclude'].includes(input.action)) fail('复核操作无效')
          if (!record.checks.some(x => x.id === input.checkId)) fail('检查记录不存在')
          const review = { id: crypto.randomUUID(), tenantId: user.tenantId, releaseId: r.id, recordId: record.id, checkId: input.checkId, action: input.action, reason: text(input.reason, '复核说明', 2000), userId: user.id, reviewer: user.username, at: new Date().toISOString() }
          await store.mutate(d => { current(token); store.authorize(user, r.id); d.reviews.push(review); store.event(user.id, 'review', review.id) }); return send({ ok: true })
        }
        if (method === 'GET' && route.length === 3 && route[2] === 'offline') { const result = await offline(r); releaseFor(token, r.id); return send(result) }
        if (method === 'POST' && route.length === 3 && route[2] === 'export') {
          if (!r.policy.features.export) fail('未开放数据导出', 403)
          const input = await body(req)
          const { recordIds, ...criteria } = input
          const available = recordList(r, criteria)
          let selected = available
          if (recordIds !== undefined) {
            if (!Array.isArray(recordIds) || !recordIds.length) fail('请选择导出记录')
            const allowed = new Set(available.map(row => row.id))
            if (recordIds.some(id => !allowed.has(id))) fail('导出记录不在授权范围或不匹配当前筛选', 403)
            const ids = new Set(recordIds)
            selected = available.filter(row => ids.has(row.id))
          }
          const selectedFields = input.fields ?? r.policy.fields.compound
          if (!Array.isArray(selectedFields) || !selectedFields.length || selectedFields.some(f => !r.policy.fields.compound.includes(f))) fail('导出字段不在授权范围', 403)
          const includeDetails = input.includeDetails === true
          releaseFor(token, r.id)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.write('{"manifest":' + JSON.stringify(publicRelease(r)) + ',"records":[')
          for (let i = 0; i < selected.length; i++) {
            releaseFor(token, r.id)
            const record = builder.record(r, selected[i].id, selected[i]), compound = Object.fromEntries(selectedFields.map(f => [f, record.compound[f] ?? null]))
            if (includeDetails && r.policy.features.review) record.reviews = store.data.reviews.filter(x => x.tenantId === r.tenantId && x.releaseId === r.id && x.recordId === record.id).map(({ tenantId, userId, ...x }) => x)
            const out = includeDetails ? { ...record, compound } : { id: record.id, sourceTitle: record.sourceTitle, compound }
            if (!res.write((i ? ',' : '') + JSON.stringify(out))) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve) })
            if (res.destroyed) return
            await new Promise(resolve => setImmediate(resolve))
          }
          releaseFor(token, r.id); res.end(']}')
          await store.mutate(() => store.event(user.id, 'export', { releaseId: r.id, records: selected.length, fields: selectedFields, includeDetails }))
          return
        }
      }
      fail('接口不存在', 404)
    } catch (e) {
      if (res.headersSent) { res.destroy(); return }
      if (!e.status) console.error(new Date().toISOString(), 'request', req.method, url.pathname, e.message)
      send({ error: e.status ? e.message : '服务器处理失败，请联系管理员', ...(e.publicationState ? { publicationState: e.publicationState } : {}) }, e.status || 500)
    } finally {
      if (Date.now() - started > 30000) console.info('slow-request', req.method, url.pathname)
    }
  }
  return { handler, store, builder, jobs, sign, warmUpdates:()=>updates.warmArchive(), closeUpdates:()=>updates.close() }
}
if (require.main === module) {
  const configFile = process.argv[2] || '/workspace/mysql-masspeclib2/customer-delivery/config.json'
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  const mysql = require(require('node:module').createRequire(path.join(config.project, 'package.json')).resolve('mysql2/promise'))
  const credential = JSON.parse(fs.readFileSync(config.databaseCredentials, 'utf8'))
  const maintenanceConnect=config.maintenanceCredentials?()=>{const secret=JSON.parse(fs.readFileSync(config.maintenanceCredentials,'utf8'));return mysql.createConnection({socketPath:config.socketPath,user:'root',password:secret.root,multipleStatements:false})}:undefined
  const service = createService({ ...config, maintenanceConnect, privateKey: fs.readFileSync(config.privateKey), publicKey: fs.readFileSync(config.publicKey, 'utf8'), engine: require(path.join(config.directory, 'engine.cjs')), connect: () => mysql.createConnection({ socketPath: config.socketPath, user: credential.user, password: credential.password, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true }) })
  const lockFile = path.join(config.directory, 'service.lock')
  if (fs.existsSync(lockFile)) { const pid = Number(fs.readFileSync(lockFile)); try { process.kill(pid, 0); throw new Error('已有客户服务实例运行') } catch (e) { if (e.code !== 'ESRCH') throw e } }
  fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600 })
  const server = https.createServer({ key: fs.readFileSync(config.tlsKey), cert: fs.readFileSync(config.tlsCert), minVersion: 'TLSv1.2' }, service.handler)
  server.requestTimeout = 120000; server.headersTimeout = 15000
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ status: 'listening', host: config.host, port: config.port }))
    void service.warmUpdates().catch(error=>console.error('无法初始化自动更新谱库',error.message))
  })
  function stop() { service.closeUpdates(); server.close(() => { fs.rmSync(lockFile, { force: true }); process.exit(0) }); setTimeout(() => process.exit(1), 10000).unref() }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
module.exports = { createService }
