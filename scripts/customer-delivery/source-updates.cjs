const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { fail } = require('./policy.cjs')
const { hash } = require('./massbank-record.cjs')
const fileSources = require('./source-files.json')
const officialScope = '官方当前版本'
const catalog = require('./source-catalog.json').map(source => {
  const file = fileSources[source.id]
  if (file) return {...source, adapter:'file', pinned:!!file.filename,
    scopes:[{id:officialScope,label:file.filename || '发布方数据文件'}]}
  return source.adapter === 'snapshot' ? {...source, adapter:'manual'} : source
})
const gnpsScopes = ['LEAFBOT', 'MIADB', 'AASDB']
const adapters = new Set(['massbank', 'gnps', 'msdial', 'msnlib', 'file'])
const sourceFor = id => catalog.find(source => source.id === String(id))
const validBatch = id => /^[a-f0-9-]{36}$/.test(id || '')
const atomic = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 }); fs.renameSync(file + '.tmp', file) }

function statusMessage(failure, previous) {
  const phase = { metadata:'读取来源文件清单', download:'下载谱库文件', parse:'解析谱图', compare:'比对目标库', archive:'写入自动更新谱库' }[failure.phase] || '检查更新'
  const reason = {
    'upstream-unavailable':'上游响应中断或暂时不可用，请稍后重新检查。',
    'rate-limit':'上游访问次数受限，请稍后重新检查。',
    'upstream-http':'上游拒绝了请求，请稍后重新检查。',
    'disk-space':'服务器可用空间不足，请联系维护人员。',
    'timeout':'处理超时，请重新检查。',
    'download-failed':'文件处理失败，请重新检查。若仍失败，请联系维护人员。'
  }[failure.kind] || '处理未完成，请重新检查。若仍失败，请联系维护人员。'
  return phase + '失败。' + reason + (previous ? ' 上次成功结果仍可查看。' : '')
}

function legacyError(message, previous) {
  if (typeof message !== 'string' || !/Traceback|ExperimentalWarning|IncompleteRead/i.test(message)) return message
  const kind = /IncompleteRead|TimeoutError|ConnectionResetError|URLError/i.test(message)
    ? 'upstream-unavailable' : 'download-failed'
  return statusMessage({phase:'check',kind}, previous)
}

const monthlySchedule = 'monthly-15'

// 03:00 on the 15th of the month in China (UTC+08:00).
function nextMonthlyCheck(now) {
  const local = new Date(now + 8 * 60 * 60 * 1000)
  const year = local.getUTCFullYear(), month = local.getUTCMonth()
  const thisMonth = Date.UTC(year, month, 15, -5)
  return new Date(now < thisMonth ? thisMonth : Date.UTC(year, month + 1, 15, -5)).toISOString()
}

function sourceUpdates({ directory, fileOp, libraryId, archive, isRemoved = () => false, spawnJob = spawn, clock = Date.now }) {
  const folder = path.join(directory, 'source-updates'), registry = path.join(folder, 'tasks.json')
  const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  const savedTasks = read(registry)
  let tasks = savedTasks || []
  if (!savedTasks && libraryId) {
    tasks = [{ id:randomUUID(), sourceId:'1', scope:'AAFC', libraryId:archive?.libraryId || libraryId, enabled:true }]
    atomic(registry,tasks)
  }
  const running = new Set()
  const children = new Set()
  const save = () => atomic(registry,tasks)
  const canSchedule = task => !task.uploaded && task.enabled && (archive || task.libraryId) && adapters.has(sourceFor(task.sourceId)?.adapter)
  function schedule(task, at = clock()) {
    if (canSchedule(task)) task.nextRunAt = nextMonthlyCheck(at)
    else delete task.nextRunAt
  }
  let updated = false
  for (const task of tasks) {
    if (task.running) {
      updated = true
      task.running = false
      if (validBatch(task.runningBatchId)) task.failedBatchId = task.runningBatchId
      delete task.runningBatchId
      task.error = '上次检查被中断，可重试上次批次。' + (task.batchId ? ' 上次成功结果仍可查看。' : '')
    }
    if (task.intervalHours !== undefined) { delete task.intervalHours; updated = true }
    if (!canSchedule(task)) {
      if (task.nextRunAt !== undefined) { delete task.nextRunAt; updated = true }
    } else if (task.schedule !== monthlySchedule || !Number.isFinite(Date.parse(task.nextRunAt))) {
      task.schedule = monthlySchedule
      schedule(task)
      updated = true
    }
  }
  if (updated) save()
  const taskFor = id => { const task = tasks.find(t => t.id === id); if (!task) fail('更新任务不存在',404); return task }
  const sameTarget = (task, batch) => batch.libraryId === task.libraryId ||
    !!(archive && !task.uploaded && (batch.libraryId === archive.libraryId && batch.archiveMode ||
      task.previousLibraryId && batch.libraryId === task.previousLibraryId))
  const batchFor = input => {
    const task = taskFor(input.taskId)
    if (!validBatch(input.batchId)) fail('请选择有效批次')
    const file = path.join(folder,'batches',input.batchId,'batch.json'), batch = read(file)
    if (!batch || batch.taskId !== task.id || !sameTarget(task,batch))
      fail('批次不存在或目标已改变',409)
    return {task,batch,file}
  }
  function requireTarget(libraryId) {
    if (isRemoved(libraryId)) fail('目标库已从共享工作台移除，请恢复后再使用', 409)
  }
  async function list() {
    const libraries = await fileOp('list',{})
    return {catalog:catalog.map(source=>({...source,canAutoUpdate:adapters.has(source.adapter)})), gnpsScopes, tasks:tasks.map(task=>{
      const supported = adapters.has(sourceFor(task.sourceId)?.adapter)
      const managed = !!archive && !task.uploaded
      const needsTarget = !managed && supported && !task.libraryId
      const batchId = task.runningBatchId || task.failedBatchId || task.batchId
      const progress = validBatch(batchId) ? read(path.join(folder,'batches',batchId,'progress.json')) : undefined
      return {...task,needsTarget,managed,progress,checkable:supported,error:legacyError(task.error,!!task.batchId)}
    }), libraries: libraries.filter(l => l.adapter === 'lds-cn' && !l.readOnly && !isRemoved(l.libraryId)),
      archive:archive && {libraryId:archive.libraryId,title:archive.title},
      guidance:archive ? '上游下载通过校验后自动汇入自动更新谱库。上传文件仍按所选业务库的流程处理。'
        : '检查和比对不会修改正式库；选择新增谱图加入待发布后，再点击发布。'}
  }
  async function configure(input) {
    const source = sourceFor(input.sourceId)
    if (!source || !adapters.has(source.adapter)) fail('此来源暂未接通谱库下载和解析，请通过官网获取后手动导入')
    const scope = String(input.scope || '').trim()
    const validScope = source.scopes ? source.scopes.some(item => item.id === scope)
      : source.adapter === 'massbank' ? /^[A-Za-z0-9_]{1,80}$/.test(scope)
      : source.adapter === 'gnps' && gnpsScopes.includes(scope)
    const task = input.id ? taskFor(input.id) : null
    if (!validScope) fail('请选择已支持的检查范围')
    if (task?.running) fail('请等待本次检查结束',409)
    if (task && task.sourceId !== source.id) fail('已有任务的来源不可改变')
    const upgrade = task && !task.libraryId
    if (task && !upgrade && (task.scope !== scope || !archive && task.libraryId !== input.libraryId))
      fail('已有任务的范围和目标不可改变，请添加新任务以保留批次记录')
    const duplicate = () => tasks.some(t => t !== task && t.sourceId === source.id && t.scope === scope &&
      (archive ? !task || upgrade && t.libraryId : t.libraryId === input.libraryId))
    if (duplicate())
      fail('相同来源、范围和目标的任务已经存在')
    if (!archive && input.enabled !== false) {
      if (!input.libraryId) fail('请选择目标数据库')
      requireTarget(input.libraryId)
      await fileOp('massbankCompare',{libraryId:input.libraryId,candidates:[]})
    }
    if (task && (!tasks.includes(task) || running.has(task.id))) fail('任务状态已变化，请刷新后重试',409)
    if (duplicate())
      fail('相同来源、范围和目标的任务已经存在')
    let next = task
    if (!task || upgrade && task.scope !== scope || upgrade && !archive) {
      next = {id:task?.id || randomUUID(),sourceId:source.id,scope,libraryId:archive?.libraryId || input.libraryId}
      if (task) tasks[tasks.indexOf(task)] = next
      else tasks.push(next)
    }
    const keepSchedule = next.enabled && next.schedule === monthlySchedule && Number.isFinite(Date.parse(next.nextRunAt))
    next.enabled = input.enabled !== false
    next.schedule = monthlySchedule
    if (!next.enabled || !keepSchedule) schedule(next)
    save()
    return next
  }
  async function remove(input) {
    const task = taskFor(input.id)
    if (task.running || running.has(task.id)) fail('请等待本次检查结束后再移除来源', 409)
    const batches = path.join(folder, 'batches')
    if (fs.existsSync(batches)) {
      for (const name of fs.readdirSync(batches)) {
        if (!validBatch(name)) continue
        const batchFolder = path.join(batches, name)
        if (!fs.statSync(batchFolder).isDirectory()) continue
        const owner = read(path.join(batchFolder,'request.json')) || read(path.join(batchFolder,'batch.json'))
        if (owner?.taskId === task.id || task.failedBatchId === name) fs.rmSync(batchFolder, { recursive: true, force: true })
      }
    }
    tasks = tasks.filter(item => item !== task)
    save()
    return { removed: true, id: task.id }
  }
  async function deleteBatch(input) {
    const task = taskFor(input.taskId)
    if (task.running || running.has(task.id)) fail('请先停止正在运行的任务', 409)
    const batchId = input.batchId || task.failedBatchId
    if (!validBatch(batchId) || task.failedBatchId !== batchId || task.batchId === batchId)
      fail('只能删除此来源的失败批次', 404)
    const batchFolder = path.join(folder, 'batches', batchId)
    const owner = read(path.join(batchFolder,'request.json'))
    if (owner && owner.taskId !== task.id) fail('失败批次不属于此来源',404)
    fs.rmSync(batchFolder, { recursive: true, force: true })
    delete task.failedBatchId
    delete task.error
    save()
    return { deleted: true, batchId }
  }
  async function check(input) {
    const task = taskFor(input.taskId)
    if (!task.enabled) fail('请先启用此任务')
    if (closed || running.size || task.running) fail('服务器已有下载任务，完成后可检查其他来源',409)
    const source = sourceFor(task.sourceId)
    if (!adapters.has(source?.adapter)) fail('此来源暂未接通谱库下载和解析')
    if (archive) await archive.ensure()
    else {
      if (!task.libraryId) fail('请先选择更新范围和目标数据库')
      requireTarget(task.libraryId)
      await fileOp('massbankCompare',{libraryId:task.libraryId,candidates:[]})
    }
    if (closed || running.size || !task.enabled || !tasks.includes(task)) fail('更新任务状态已变化，请重试',409)
    const failedId = task.failedBatchId
    const failedRequest = validBatch(failedId) && read(path.join(folder,'batches',failedId,'request.json'))
    const target = archive?.libraryId || task.libraryId
    const resumable = failedRequest && failedRequest.taskId === task.id &&
      (failedRequest.libraryId === target || archive && failedRequest.archiveMode && sameTarget(task,failedRequest)) &&
      failedRequest.adapter === source.adapter && failedRequest.scope === task.scope
    const batchId = resumable ? failedId : randomUUID()
    const batchFolder = path.join(folder,'batches',batchId)
    fs.mkdirSync(batchFolder,{recursive:true})
    const config = {taskId:task.id,batchId,libraryId:target,adapter:source.adapter,scope:task.scope,
      sourceId:source.id,sourceName:source.name,archiveMode:!!archive}
    if (validBatch(task.batchId) && (!archive || task.archiveBatchId === task.batchId)) {
      const priorFolder = path.join(folder,'batches',task.batchId)
      const prior = read(path.join(priorFolder,'batch.json'))
      if (prior?.adapter === source.adapter && fs.existsSync(path.join(priorFolder,'candidates.sqlite'))) {
        config.previousChecksum = prior.upstreamChecksum
        config.previousValidators = prior.upstreamValidators
        config.previousVersion = prior.version
      }
    }
    for (const name of ['unchanged.json','failure.json','progress.json']) fs.rmSync(path.join(batchFolder,name),{force:true})
    if (resumable) {
      for (const name of ['candidates.sqlite','batch.json'])
        fs.rmSync(path.join(batchFolder,name),{force:true})
    }
    atomic(path.join(batchFolder,'request.json'),config)
    delete task.unchanged
    const now = clock()
    task.lastAttemptAt = new Date(now).toISOString()
    if (Date.parse(task.nextRunAt) <= now) schedule(task, now)
    task.running = true; task.runningBatchId=batchId; delete task.error; running.add(task.id); save()
    const child = spawnJob(process.execPath,[path.join(__dirname,'source-update-job.cjs'),batchFolder],{stdio:['ignore','ignore','pipe']})
    children.add(child)
    let error = '', finished = false, timedOut = false, phase = 'download'
    child.stderr.on('data',d => { error = (error + d).slice(-16000) })
    const maxDownloadHours = source.adapter === 'massbank' ? 2 : 12
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, maxDownloadHours * 60 * 60 * 1000)
    const finish = async code => {
      if (finished) return; finished = true; clearTimeout(timer); children.delete(child)
      try {
        const unchanged = code === 0 && read(path.join(batchFolder,'unchanged.json'))
        if (unchanged?.upstreamChecksum === config.previousChecksum && unchanged?.upstreamChecksum) {
          task.unchanged = true
          task.checkedAt = new Date().toISOString()
          task.version = unchanged.version
          delete task.failedBatchId
          fs.rmSync(batchFolder,{recursive:true,force:true})
          return
        }
        if (code !== 0 || !read(path.join(batchFolder,'batch.json'))) throw Error('下载进程中断，退出状态：'+String(code))
        const batch = read(path.join(batchFolder,'batch.json'))
        phase = archive ? 'archive' : 'compare'
        if (archive) {
          atomic(path.join(batchFolder,'progress.json'),{phase,label:'正在写入自动更新谱库',completed:0,total:0,unit:'张谱图'})
          task.archived = await archive.write({batchFolder,sourceId:source.id})
          task.archiveBatchId = batchId
        } else await fileOp('sourceCompare',{libraryId:task.libraryId,batchFolder,page:1})
        task.batchId = batchId; task.version = batch.version; task.checkedAt = batch.checkedAt; task.spectra = batch.count; task.compounds = batch.compounds; task.invalid = batch.invalid; task.conflicts = batch.conflicts
        delete task.failedBatchId
      } catch(e) {
        task.failedBatchId = batchId
        let progress, reported
        try {
          progress = read(path.join(batchFolder,'progress.json'))
          reported = read(path.join(batchFolder,'failure.json'))
        } catch (diagnosticError) {
          error += '\n' + diagnosticError.message
        }
        const failure = timedOut ? {phase:progress?.phase || phase,kind:'timeout'}
          : reported || {phase:['compare','archive'].includes(phase) ? phase : progress?.phase || phase,kind:'download-failed'}
        task.error = statusMessage(failure, !!task.batchId)
        try {
          fs.writeFileSync(path.join(batchFolder,'diagnostics.log'),
            new Date().toISOString() + ' ' + JSON.stringify(failure) + '\n' + String(e.stack || e) + '\n' + error,
            { mode:0o600 })
        } catch (logError) {
          console.error('无法保存更新任务诊断日志',batchId,logError.message)
        }
      }
      finally { task.running = false; delete task.runningBatchId; running.delete(task.id); save() }
    }
    child.on('error',e => {error=e.message;void finish(1) });child.on('close',code => void finish(code))
    return {running:true}
  }
  let closed = false, ticking = false
  async function tick() {
    if (closed || ticking || running.size) return
    const now = clock()
    const task = tasks.filter(t => canSchedule(t) && Date.parse(t.nextRunAt) <= now)
      .sort((a,b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0]
    if (!task) return
    ticking = true
    try { await check({taskId:task.id}) }
    catch (error) {
      if (closed || !tasks.includes(task) || !canSchedule(task)) return
      if (!running.size) {
        task.error = String(error.message).slice(0,500)
        schedule(task)
        save()
      }
    } finally { ticking = false }
  }
  const scheduler = setInterval(() => void tick().catch(error => console.error('谱库调度失败',error.message)), 15000)
  scheduler.unref()
  async function warmArchive() {
    if (!archive) return
    await archive.ensure()
    for (const task of tasks) {
      if (closed || task.running || task.uploaded || !validBatch(task.batchId) || task.archiveBatchId === task.batchId ||
          !adapters.has(sourceFor(task.sourceId)?.adapter)) continue
      const batchId = task.batchId
      const batchFolder = path.join(folder,'batches',batchId)
      if (!fs.existsSync(path.join(batchFolder,'candidates.sqlite'))) continue
      try {
        const archived = await archive.write({batchFolder,sourceId:task.sourceId})
        if (task.batchId !== batchId) continue
        task.archived = archived
        task.archiveBatchId = batchId
        save()
      } catch (error) { console.error('已有下载批次归档未完成',batchId,error.message) }
    }
  }
  async function compare(input) {
    const {batch,file} = batchFor(input)
    if (batch.archiveMode) fail('此批次已自动汇入自动更新谱库',409)
    return {...await fileOp('sourceCompare',{libraryId:batch.libraryId,batchFolder:path.dirname(file),page:input.page,filter:input.filter,selectAll:input.selectAll}), batchId:batch.batchId,version:batch.version,invalid:batch.invalid,duplicates:batch.duplicates,conflicts:batch.conflicts,compounds:batch.compounds}
  }
  async function publish(input) {
    const {batch,file} = batchFor(input)
    if (batch.archiveMode) fail('此批次已自动汇入自动更新谱库',409)
    requireTarget(batch.libraryId)
    if (!Array.isArray(input.selected) || !input.selected.length || new Set(input.selected).size !== input.selected.length) fail('请选择谱图，且不能重复选择')
    const confirmed=Array.isArray(input.confirmed)?[...new Set(input.confirmed)].sort():[]
    const result = await fileOp('sourcePublish',{libraryId:batch.libraryId,batchFolder:path.dirname(file),selected:input.selected,confirmed,revision:input.revision,actor:input.actor,
      hash:hash(JSON.stringify([batch.batchId,batch.libraryId,[...input.selected].sort(),confirmed]))})
    return {...result,batchId:batch.batchId}
  }
  async function inspect(input) {
    const {batch,file}=batchFor(input)
    return fileOp('sourceInspect',{libraryId:batch.libraryId,batchFolder:path.dirname(file),accession:input.accession})
  }
  async function upload(input) {
    if(closed||running.size)fail('服务器已有下载或上传任务，请完成后重试',409)
    const target=String(input.libraryId||'')
    if(!target) fail('请选择目标数据库')
    requireTarget(target)
    const entry=await fileOp('list',{});if(!entry.some(e=>e.libraryId===target&&e.adapter==='lds-cn'&&!e.readOnly))fail('目标数据库不可编辑或不可用',409)
    if(running.size)fail('服务器已有下载或上传任务，请完成后重试',409)
    const batchId=randomUUID(), taskId='upload-'+batchId
    const task={id:taskId,sourceId:'upload',scope:require('node:path').basename(input.filename||''),libraryId:target,enabled:true,uploaded:true,running:true,runningBatchId:batchId}
    tasks.push(task);running.add(taskId);save()
    try{
      const {Worker}=require('node:worker_threads')
      const batch=await new Promise((resolve,reject)=>{const worker=new Worker(path.join(__dirname,'source-upload.cjs'),{workerData:{folder,input:{...input,batchId,taskId}}});let answered=false;worker.once('message',r=>{answered=true;r.error?reject(Error(r.error)):resolve(r.batch)});worker.once('error',reject);worker.once('exit',()=>{if(!answered)reject(Error('上传解析进程中断'))})})
      await fileOp('sourceCompare',{libraryId:target,batchFolder:path.join(folder,'batches',batchId),page:1})
      Object.assign(task,{batchId,spectra:batch.count,compounds:batch.compounds,version:batch.version,checkedAt:batch.checkedAt,invalid:batch.invalid,conflicts:batch.conflicts})
      return {taskId,batchId,libraryId:target,filename:batch.filename,spectra:batch.count,compounds:batch.compounds,version:batch.version,uploaded:true}
    }catch(e){task.failedBatchId=batchId;task.error='上传未完成：'+String(e.message).slice(0,500);throw e}
    finally{task.running=false;delete task.runningBatchId;running.delete(taskId);save()}
  }

  return {list,configure,remove,deleteBatch,check,compare,publish,inspect,upload,tick,warmArchive,
    close(){closed=true;clearInterval(scheduler);for(const child of children)child.kill('SIGTERM')}}
}
module.exports = {sourceUpdates,nextMonthlyCheck}
