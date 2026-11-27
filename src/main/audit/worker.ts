import { parentPort, workerData } from 'node:worker_threads'
import { analyseAsset } from '../../shared/audit'
try {
  parentPort?.postMessage({
    results: workerData.assets.map((asset) => { try { return { id: asset.id, result: analyseAsset(asset) } } catch(e) { return { id: asset.id, error: e instanceof Error ? e.message : String(e) } } })
  })
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
}
