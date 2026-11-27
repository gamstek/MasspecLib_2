/* eslint-disable @typescript-eslint/no-explicit-any */
import { BrowserWindow, type IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { connections, getState, saveAuditSettings, connection } from '../federation/registry'
import { rows, count, inspect, forgetColumns, detail } from '../federation/adapters'
import { objectValue, type AuditAsset, type AuditSettings } from '../../shared/audit'
import type { RecordRef } from '../../shared/federation'
import * as repository from './repository'
import * as catalog from './catalog'
import { sourceChoice, readPage } from './reader'
let running = false,
  stopping = false,
  error = '',
  timer: ReturnType<typeof setTimeout> | undefined,
  startupTimer: ReturnType<typeof setTimeout> | undefined
let phase = 'idle', lastSuccessful: string | null = null
let current: any = null,
  lastFinished: string | null = null
const workers = new Set<Worker>()
export function auditSettings(): AuditSettings {
  return (
    getState().audit ?? {
      enabled: true,
      connectionId: getState().primaryId,
      database: 'mspec_lib2_audit',
      intervalSeconds: 60
    }
  )
}
function emit(): void {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send('audit:updated', { running, current, error, lastFinished, paused: stopping })
}
export async function auditStatus(): Promise<any> {
  const scans = repository.ready() ? await repository.sql('SELECT * FROM qc_scans ORDER BY created_at DESC LIMIT 30') : []
  const latest = connections().filter(e => e.enabled).map(e => ({ name: e.name, scan: scans.find(s => s.connection_id === e.id) }))
  const stale = latest.filter(e => !e.scan || e.scan.state !== 'completed').map(e => e.name)
  return { phase, lastSuccessful, stale,

    settings: auditSettings(),
    ready: repository.ready(),
    running,
    paused: stopping,
    current,
    error,
    lastFinished,
    scans,
    merges: repository.ready()
      ? await repository.sql(
          'SELECT id,reviewer,reason,undone,created_at FROM qc_merges ORDER BY created_at DESC LIMIT 30'
        )
      : []
  }
}
function schedule(): void {
  clearTimeout(timer)
  try { auditSettings() } catch { phase = 'waiting'; return }
  if (!stopping && auditSettings().enabled) {
    timer = setTimeout(backgroundScan, auditSettings().intervalSeconds * 1000)
    timer.unref()
  }
}
async function calculate(assets: AuditAsset[]): Promise<any[]> {
  if (!assets.length) return []
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'audit-worker.js'), { workerData: { assets } })
    workers.add(worker)
    const timeout = setTimeout(() => {
      void worker.terminate()
      reject(new Error('本批检查超时，请缩小轨迹或检查数据'))
    }, 120000)
    const finish = (): void => {
      clearTimeout(timeout)
      workers.delete(worker)
    }
    worker.once('message', (message) => {
      finish()
      message.error ? reject(new Error(message.error)) : resolve(message.results)
    })
    worker.once('error', (err) => {
      finish()
      reject(err)
    })
    worker.once('exit', (code) => {
      finish()
      reject(new Error(code !== 0 ? '自动检查线程已退出' : '检查线程未返回结果，请重试'))
    })
  })
}
export async function runScan(force = false): Promise<any> {
  if (running) return { running: true }
  if (!force && !auditSettings().enabled) return { disabled: true }
  if (!force && stopping) return { paused: true }
  running = true
  phase = 'running'
  let failedSources = 0
  error = ''
  stopping = false
  clearTimeout(timer)
  emit()
  try {
    if (!repository.ready()) await repository.openRepository(auditSettings())
    for (const entry of connections().filter((x) => x.enabled)) {
      if (stopping) break
      const scan = randomUUID()
      current = { connectionId: entry.id, name: entry.name, processed: 0, checked: 0, total: 0, failures: 0, issues: [] }
      emit()
      await repository.sql('INSERT INTO qc_scans(id,connection_id,state) VALUES(?,?,?)', [
        scan,
        entry.id,
        'running'
      ])
      try {
        forgetColumns(entry.id)
        await inspect(entry)
        current.total = (await count(entry, {})) + (await count(entry, { trashOnly: true }))
        for (const trashOnly of [false, true]) {
          let offset = 0
          while (!stopping) {
            const page = await rows(entry, { trashOnly }, offset, 25)
            if (!page.length) break
            const consume = async (raw: any[]): Promise<void> => {
              let snapshots: Awaited<ReturnType<typeof readPage>>
              try {
                snapshots = await readPage(entry, raw)
              } catch (error) {
                if (stopping) throw error
                if (raw.length > 1) {
                  const half = Math.ceil(raw.length / 2)
                  await consume(raw.slice(0, half)); await consume(raw.slice(half)); return
                }
                current.failures++; current.processed++
                if (current.issues.length < 20) current.issues.push({ record: raw[0]?.ref?.key || raw[0]?.id || '未知记录', reason: error instanceof Error ? error.message : String(error) })
                return
              }
              let pending: AuditAsset[] = [],
                points = 0
              const flush = async (): Promise<void> => {
                const batch = pending
                pending = []
                points = 0
                const computed = await calculate(batch)
                for (const item of computed) {
                  if (item.error) {
                    current.failures++
                    if (current.issues.length < 20) current.issues.push({ record: item.id, reason: item.error })
                    continue
                  }
                  const asset = batch.find((x) => x.id === item.id)
                  if (asset) { await repository.saveCheck(asset, item.result); current.checked++ }
                }
              }
              for (const snapshot of snapshots) {
                await repository.saveMember(snapshot.row, snapshot.classes, scan)
                const changed = await repository.saveAssets(snapshot.row.ref, snapshot.assets, scan)
                for (const asset of changed) {
                  const n =
                    (asset.row?.trace?.points.length ?? 0) +
                    (asset.row?.qualifierTrace?.points.length ?? 0) +
                    (asset.row?.qualifiers ?? []).reduce(
                      (sum, q) => sum + (q.trace?.points.length ?? 0),
                      0
                    )
                  if (pending.length && points + n > 500000) await flush()
                  pending.push(asset)
                  points += n
                }
                current.processed++
              }
              await flush()
            }
            await consume(page)
            offset += page.length
            await repository.sql('UPDATE qc_scans SET progress=?,detail=? WHERE id=?', [
              current.processed,
              JSON.stringify(current),
              scan
            ])
            emit()
          }
        }
        if (stopping) throw new Error('检查已暂停；尚未扫描的记录保持原状态')
        if (current.failures) {
          failedSources++; await repository.sql("UPDATE qc_scans SET state='partial',detail=? WHERE id=?", [JSON.stringify(current), scan]); continue
        }
        await repository.transaction(async (tx) => {
          await repository.sql(
            'UPDATE qc_members SET present=0 WHERE connection_id=? AND scan_id<>?',
            [entry.id, scan],
            tx
          )
          await repository.sql(
            'UPDATE qc_assets SET present=0 WHERE connection_id=? AND scan_id<>?',
            [entry.id, scan],
            tx
          )
          await repository.sql(
            "UPDATE qc_scans SET state='completed',detail=? WHERE id=?",
            [JSON.stringify(current), scan],
            tx
          )
        })
      } catch (e) {
        if (!stopping) { failedSources++; error = String(e) }
        await repository.sql('UPDATE qc_scans SET state=?,detail=? WHERE id=?', [stopping ? 'paused' : 'failed', JSON.stringify({ ...current, error: stopping ? '用户已暂停，本轮尚未完成' : String(e) }), scan])
      }
    }
    lastFinished = new Date().toISOString(); phase = stopping ? 'paused' : failedSources ? 'partial' : 'completed'
    if (phase === 'completed') lastSuccessful = lastFinished
  } catch (e) {
    error = String(e); phase = stopping ? 'paused' : 'failed'
  } finally {
    running = false
    current = null
    emit()
    schedule()
  }
  return auditStatus()
}
export function startAudit(): void {
  stopping = false
  clearTimeout(startupTimer)
  startupTimer = setTimeout(() => { if (!stopping) backgroundScan() }, 1500); startupTimer.unref()
}
function backgroundScan(): void { void runScan().catch(e => { error = String(e); phase = 'waiting'; emit() }) }
export async function stopAudit(): Promise<void> {
  stopping = true
  clearTimeout(timer); clearTimeout(startupTimer)
  for (const worker of workers) await worker.terminate()
  await repository.closeRepository()
}
export async function auditDetail(ref: RecordRef, scope: any = {}): Promise<any> {
  const root = repository.ready() ? await catalog.rootFor(ref) : undefined
  if (!root) {
    if (ref.connectionId === '@unified') throw new Error('统一索引未就绪，请重新打开记录')
    return detail(ref)
  }
  const members =
    ref.connectionId === '@unified'
      ? await catalog.memberRows(root, scope)
      : (await catalog.memberRows(root, scope)).filter(
          (x) => x.connection_id === ref.connectionId && x.record_key === ref.key
        )
  if (!members.length) throw new Error('当前范围内没有该化合物记录，请刷新列表')
  const values: any[] = []
  for (const member of members) {
    const value = await detail({ connectionId: member.connection_id, key: member.record_key })
    if (scope.sourceIds?.length || scope.sourceQuery?.trim()) {
      const entry = connection(member.connection_id)
      const matches = (item: any): boolean => {
        const choice = sourceChoice(entry, item.source_record.library)
        return scope.sourceIds?.length
          ? scope.sourceIds.includes(choice.id)
          : choice.name.toLowerCase().includes(scope.sourceQuery.trim().toLowerCase())
      }
      const evidence = value.extensions.sources,
        chosen = evidence.filter(matches)
      const belongs = (type: string, id: any): boolean => {
        const specific = evidence.filter(
          (x) => x.appliesTo === type && String(x.entityId) === String(id)
        )
        if (specific.length) return specific.some(matches)
        const compoundSources = evidence.filter((x) => x.appliesTo === 'compound')
        return compoundSources.length === 1 && compoundSources.some(matches)
      }
      value.methods = value.methods
        .map((group) => ({
          ...group,
          methods: group.methods.filter((m) => belongs('ms_method', m.id))
        }))
        .filter((group) => group.methods.length)
      value.lcMethods = value.lcMethods.filter((m) => belongs('lc_method', m.id))
      value.extensions.spectra = value.extensions.spectra.filter((sp) => belongs('spectrum', sp.id))
      value.extensions.profiles = []
      value.extensions.sources = chosen
      value.compound.readOnly = true
    }
    values.push(value)
  }
  const result = values[0]
  const assets = await catalog.assetsFor(root, scope)
  result.audit = {
    rootId: root,
    assets: assets
      .filter((x) =>
        members.some((m) => m.connection_id === x.connection_id && m.record_key === x.record_key)
      )
      .map((x) => ({
        ...objectValue(x.data),
        checkId: x.check_id,
        check: objectValue(x.check_data)
      })),
    members: members.map((m) => ({
      ref: { connectionId: m.connection_id, key: m.record_key },
      name: connection(m.connection_id).name
    })),
    overview: catalog.overview(assets)
  }
  if (ref.connectionId === '@unified' && members.length > 1) {
    result.compound = {
      ...result.compound,
      ref,
      scope,
      memberRefs: result.audit.members.map((x) => x.ref)
    }
    result.compound.readOnly = true
    result.compound.is_favorite = members.some((m) => !!m.favorite)
    result.compound.name_zh = values.find((v) => v.compound.name_zh)?.compound.name_zh
    result.compound.name_en = values.find((v) => v.compound.name_en)?.compound.name_en
    const pref = (index: number, id: any): string =>
      `${members[index].connection_id}:${members[index].record_key}:${id}`
    result.methods = values.flatMap((v, index) =>
      v.methods.map((group) => ({
        ...group,
        methods: group.methods.map((m) => ({ ...m, id: pref(index, m.id) }))
      }))
    )
    result.lcMethods = values.flatMap((v, index) =>
      v.lcMethods.map((m) => ({ ...m, id: pref(index, m.id) }))
    )
    result.extensions = {
      ...result.extensions,
      spectra: values.flatMap((v, index) =>
        v.extensions.spectra.map((sp) => ({
          ...sp,
          id: pref(index, sp.id),
          methodIds: sp.methodIds.map((id) => pref(index, id))
        }))
      ),
      profiles: values.flatMap((v) => v.extensions.profiles),
      sources: values.flatMap((v) => v.extensions.sources),
      classifications: [
        ...new Map(
          values
            .flatMap((v) => v.extensions.classifications ?? [])
            .map((x) => [JSON.stringify([x.namespace, x.category_code]), x])
        ).values()
      ],
      taxonomyCatalog: [
        ...new Map(
          values
            .flatMap((v) => v.extensions.taxonomyCatalog ?? [])
            .map((x) => [JSON.stringify([x.namespace, x.category_code]), x])
        ).values()
      ],
      methodLabels: Object.assign(
        {},
        ...values.map((v, index) =>
          Object.fromEntries(
            Object.entries(v.extensions.methodLabels ?? {}).map(([id, label]) => [
              pref(index, id),
              label
            ])
          )
        )
      )
    }
  }
  return result
}
export function registerAuditIPC(ipcMain: IpcMain): void {
  ipcMain.handle('audit:status', () => auditStatus())
  ipcMain.handle('audit:run', () => runScan(true))
  ipcMain.handle('audit:pause', () => {
    stopping = true
    clearTimeout(timer); clearTimeout(startupTimer)
    emit()
    return { success: true }
  })
  ipcMain.handle('audit:settings', async (_, settings: AuditSettings) => {
    if (running) throw new Error('请先暂停检查，等待当前批次结束后再保存设置')
    if (
      !Number.isSafeInteger(settings.intervalSeconds) ||
      settings.intervalSeconds < 30 ||
      settings.intervalSeconds > 86400
    )
      throw new Error('检查间隔应为30—86400秒')
    connection(settings.connectionId)
    if (settings.enabled) await repository.openRepository(settings)
    saveAuditSettings(settings)
    stopping = false
    schedule()
    if (settings.enabled) void runScan()
    return auditStatus()
  })
  ipcMain.handle('audit:results', (_, filters) => catalog.checkRows(filters))
  ipcMain.handle('audit:history', (_, assetId) =>
    repository.sql(
      'SELECT id,engine_version,rule_version,created_at,abnormal,incomplete FROM qc_checks WHERE asset_id=? ORDER BY created_at DESC,id DESC LIMIT 100',
      [assetId]
    )
  )
  ipcMain.handle('audit:check', (_, id) => catalog.checkDetail(id))
  ipcMain.handle('audit:review', async (_, id, revision, value) => {
    await repository.reviewCheck(id, revision, value)
    emit()
    return { success: true }
  })
  ipcMain.handle(
    'audit:compound',
    async (_, ref, scope) => (await auditDetail(ref, scope)).audit ?? { assets: [], members: [] }
  )
  ipcMain.handle('audit:merge', async (_, refs: RecordRef[], reviewer, reason) => {
    if (running) throw new Error('请先暂停检查，再进行身份关联')
    const expanded: RecordRef[] = []
    for (const ref of refs)
      if (ref.connectionId === '@unified')
        for (const m of await catalog.memberRows(ref.key))
          expanded.push({ connectionId: m.connection_id, key: m.record_key })
      else expanded.push(ref)
    const id = await repository.mergeMembers(
      [...new Map(expanded.map((r) => [JSON.stringify(r), r])).values()],
      reviewer,
      reason
    )
    emit()
    return { id }
  })
  ipcMain.handle('audit:unmerge', async (_, id) => {
    if (running) throw new Error('请先暂停检查')
    await repository.undoMerge(id)
    emit()
    return { success: true }
  })
}
