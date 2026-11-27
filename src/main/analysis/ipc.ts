import { Worker } from 'node:worker_threads'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { app, dialog, type IpcMain } from 'electron'
import type {
  AnalysisFilters,
  DetectionPackage,
  DetectionResult,
  ReviewAction,
  StoredBatch
} from '../../shared/analysis/types'
import { CSV_HEADERS } from '../../shared/analysis/input'
import { detectionDemo } from '../../shared/analysis/demo'
import { AnalysisStore, resultCsv } from './store'
import { exportArchive } from './archive'
interface Job {
  id: string
  state: 'running' | 'preview' | 'failed' | 'cancelled' | 'saved'
  progress: number
  message?: string
  sourceName: string
  created: number
  input?: DetectionPackage
  results?: DetectionResult[]
  sourceHash?: string
  restoredBatch?: StoredBatch
  worker?: Worker
}
export function registerAnalysisIPC(ipc: IpcMain): void {
  const store = new AnalysisStore(join(app.getPath('userData'), 'detection-results'))
  const jobs = new Map<string, Job>()
  function job(id: string): Job {
    const found = jobs.get(id)
    if (!found) throw new Error('导入任务已失效，请重新选择文件')
    return found
  }
  function start(path?: string): { jobId: string } {
    for (const [id, j] of jobs)
      if (Date.now() - j.created > 30 * 60 * 1000 && j.state !== 'running') jobs.delete(id)
    if ([...jobs.values()].some((j) => j.state === 'running'))
      throw new Error('已有分析任务正在运行，请等待完成或取消')
    if ([...jobs.values()].filter((j) => j.state === 'preview').length >= 2)
      throw new Error('请先保存或取消已有的导入预览')
    const id = randomUUID(),
      current: Job = {
        id,
        state: 'running',
        progress: 0,
        sourceName: path ? basename(path) : '内置15条模拟演示',
        created: Date.now()
      }
    jobs.set(id, current)
    try {
      const worker = new Worker(join(__dirname, 'analysis-worker.js'), {
        workerData: { path, demo: !path }
      })
      current.worker = worker
      const timeout = setTimeout(
        () => {
          if (current.state === 'running') {
            current.state = 'failed'
            current.message = '分析超过5分钟，请缩小批次后重试'
            void worker.terminate()
          }
        },
        5 * 60 * 1000
      )
      worker.on('message', (value) => {
        if (current.state !== 'running') return
        if (value.kind === 'progress') current.progress = value.progress
        if (value.kind === 'done') {
          current.state = 'preview'
          current.progress = 100
          current.input = value.input
          current.results = value.results
          current.sourceHash = value.sourceHash
          current.restoredBatch = value.restoredBatch
        }
        if (value.kind === 'error') {
          current.state = 'failed'
          current.message = value.message
        }
      })
      worker.on('error', (error) => {
        if (current.state === 'running') {
          current.state = 'failed'
          current.message = error.message
        }
      })
      worker.on('exit', (code) => {
        clearTimeout(timeout)
        current.worker = undefined
        if (current.state === 'running') {
          current.state = 'failed'
          current.message = `分析进程提前退出（${code}）`
        }
      })
    } catch (error) {
      current.state = 'failed'
      current.message = String(error)
    }
    return { jobId: id }
  }
  ipc.handle('analysis:batches', () => store.list())
  ipc.handle('analysis:import', async () => {
    const file = await dialog.showOpenDialog({
      title: '选择检测结果文件',
      properties: ['openFile'],
      filters: [{ name: '检测结果（非谱库msldata）', extensions: ['json', 'csv', 'xlsx'] }]
    })
    return file.canceled || !file.filePaths[0] ? null : start(file.filePaths[0])
  })
  ipc.handle('analysis:demo', () => start())
  ipc.handle('analysis:job', (_, id: string) => {
    const current = job(id),
      results = current.results ?? []
    return {
      id,
      state: current.state,
      progress: current.progress,
      message: current.message,
      sourceName: current.sourceName,
      preview: current.input
        ? {
            batchName: current.input.batchName,
            methodName: current.input.methodName,
            ruleVersion: current.input.ruleVersion,
            demo: !!current.input.demo,
            restored: !!current.restoredBatch,
            total: results.length,
            abnormal: results.filter((r) => r.abnormal).length,
            incomplete: results.filter((r) => r.incomplete).length,
            rows: results.slice(0, 20)
          }
        : null
    }
  })
  ipc.handle('analysis:cancel', async (_, id: string) => {
    const current = job(id)
    current.state = 'cancelled'
    current.input = undefined
    current.results = undefined
    current.restoredBatch = undefined
    await current.worker?.terminate()
    jobs.delete(id)
  })
  ipc.handle('analysis:commit', async (_, id: string) => {
    const current = job(id)
    if (current.state !== 'preview' || !current.input || !current.results || !current.sourceHash)
      throw new Error('分析尚未完成，不能保存')
    const saved = current.restoredBatch
      ? await store.restore(current.restoredBatch)
      : await store.create(current.input, current.results, current.sourceName, current.sourceHash)
    current.state = 'saved'
    current.input = undefined
    current.results = undefined
    current.restoredBatch = undefined
    return saved
  })
  ipc.handle('analysis:results', (_, id: string, filters: AnalysisFilters) =>
    store.results(id, filters)
  )
  ipc.handle('analysis:detail', (_, id: string, resultId: string) => store.detail(id, resultId))
  ipc.handle(
    'analysis:review',
    (_, id: string, revision: number, review: Omit<ReviewAction, 'at'>) =>
      store.review(id, revision, review)
  )
  ipc.handle(
    'analysis:export',
    async (_, id: string, filters: AnalysisFilters, format: 'csv' | 'json') => {
      const batch = await store.get(id)
      const selected = await dialog.showSaveDialog({
        title: format === 'json' ? '导出完整批次备份（含曲线和复核记录）' : '导出当前筛选结果',
        defaultPath: `检测结果-${id.slice(0, 8)}.${format === 'json' ? 'json' : 'csv'}`,
        filters: [{ name: '检测结果', extensions: [format === 'json' ? 'json' : 'csv'] }]
      })
      if (selected.canceled || !selected.filePath) return false
      await writeFile(
        selected.filePath,
        format === 'json' ? exportArchive(batch) : resultCsv(batch, filters),
        'utf8'
      )
      return true
    }
  )
  ipc.handle('analysis:template', async (_, format: 'json' | 'csv') => {
    const extension = format === 'csv' ? 'csv' : 'json'
    const selected = await dialog.showSaveDialog({
      title: '保存检测结果格式模板',
      defaultPath: `检测结果模板.${extension}`,
      filters: [{ name: '模板', extensions: [extension] }]
    })
    if (selected.canceled || !selected.filePath) return false
    const demo = detectionDemo()
    // JSON is a full working synthetic example; CSV is a concise header + one synthetic result.
    const values = [
      'DEMO-1',
      '模拟样品',
      '模拟目标物',
      '模拟基质',
      '5',
      '3.5',
      '0.005',
      'mg/kg',
      'value',
      '',
      '0.01',
      'mg/kg',
      '模拟限量，非真实标准',
      '100000',
      '50000',
      '0.5',
      '30',
      '模拟标准品',
      '是',
      '',
      '',
      JSON.stringify(demo.peakRules),
      '模拟CSV批次',
      demo.methodName,
      'demo-1',
      '是'
    ]
    const csv =
      '\uFEFF' +
      [CSV_HEADERS, values]
        .map((row) => row.map((value) => '"' + String(value).replace(/"/g, '""') + '"').join(','))
        .join('\r\n')
    await writeFile(
      selected.filePath,
      format === 'csv' ? csv : JSON.stringify(demo, null, 2),
      'utf8'
    )
    return true
  })
  app.on('before-quit', () => {
    for (const current of jobs.values()) void current.worker?.terminate()
  })
}
