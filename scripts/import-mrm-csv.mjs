import './legacy-disabled.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'
import xlsx from 'xlsx'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true })

const apply = process.argv.includes('--apply')
const overwrite = process.argv.includes('--overwrite')
const csvArg = process.argv.find((argument) => argument.startsWith('--file='))
const csvPath = path.resolve(projectRoot, csvArg ? csvArg.slice('--file='.length) : 'docs/MRM.csv')
const requiredHeaders = ['质谱方法ID', '化合物ID', '主名称', 'CAS号', '峰数', '峰列表']

function text(value) {
  return value === null || value === undefined ? '' : String(value).normalize('NFKC').trim()
}

function decodeStoredSpectrum(value) {
  const encoded = text(value)
  if (!encoded) return null
  try {
    const content = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded
    return JSON.parse(Buffer.from(content, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function parseCsv(csvBytes) {
  const csvText = new TextDecoder('gb18030').decode(csvBytes)
  const workbook = xlsx.read(csvText, { type: 'string', raw: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('MRM.csv 中没有可读取的数据表')
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true })
  const actualHeaders = new Set(
    xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true })[0]?.map(text) ?? []
  )
  const missingHeaders = requiredHeaders.filter((header) => !actualHeaders.has(header))
  if (missingHeaders.length) throw new Error(`MRM.csv 缺少字段：${missingHeaders.join('、')}`)

  return rows.map((row, index) => {
    const rowNo = index + 2
    const methodId = Number(row['质谱方法ID'])
    const compoundId = Number(row['化合物ID'])
    const declaredPeakCount = Number(row['峰数'])
    let peakPairs
    try {
      peakPairs = JSON.parse(text(row['峰列表']))
    } catch (error) {
      throw new Error(
        `第 ${rowNo} 行峰列表不是有效 JSON：${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!Number.isInteger(methodId) || methodId <= 0)
      throw new Error(`第 ${rowNo} 行质谱方法ID无效`)
    if (!Number.isInteger(compoundId) || compoundId <= 0)
      throw new Error(`第 ${rowNo} 行化合物ID无效`)
    if (!Array.isArray(peakPairs) || !peakPairs.length) throw new Error(`第 ${rowNo} 行峰列表为空`)
    if (peakPairs.length !== declaredPeakCount) {
      throw new Error(
        `第 ${rowNo} 行峰数不一致：字段为 ${declaredPeakCount}，实际为 ${peakPairs.length}`
      )
    }
    const peaks = peakPairs
      .map((peak, peakIndex) => {
        if (!Array.isArray(peak) || peak.length < 2) {
          throw new Error(`第 ${rowNo} 行第 ${peakIndex + 1} 个峰格式无效`)
        }
        const mz = Number(peak[0])
        const intensity = Number(peak[1])
        if (!Number.isFinite(mz) || mz <= 0 || !Number.isFinite(intensity) || intensity < 0) {
          throw new Error(`第 ${rowNo} 行第 ${peakIndex + 1} 个峰数值无效`)
        }
        return { mz, intensity }
      })
      .sort((left, right) => left.mz - right.mz)

    return {
      rowNo,
      methodId,
      compoundId,
      csvName: text(row['主名称']),
      csvCas: text(row['CAS号']),
      peaks
    }
  })
}

function createPayload(entry, method, sourceSha256) {
  const polarity = Number(method.polarity)
  return {
    schemaVersion: 'mass-spectrum-v1',
    source: {
      name: 'MRM.csv',
      library: '本地MRM数据',
      nistNumber: '',
      dbNumber: String(method.id)
    },
    compound: {
      id: Number(method.compounds_id),
      name: text(method.main_name) || entry.csvName,
      cas: text(method.cas) || entry.csvCas
    },
    acquisition: {
      precursorType: '',
      precursorMz: Number(method.q1),
      spectrumType: 'MS2',
      instrumentType: 'QqQ',
      instrument: text(method.ms_mode),
      ionization: text(method.ion_source),
      ionMode: polarity === 1 ? '正' : polarity === 0 ? '负' : '',
      collisionEnergyText: method.ce === null ? '' : String(method.ce)
    },
    match: {
      type: 'imported',
      q1: method.q1 === null ? null : Number(method.q1),
      q3: method.q3 === null ? null : Number(method.q3),
      compoundId: Number(method.compounds_id),
      methodId: Number(method.id)
    },
    metadata: {
      spectrumId: `MRM-${method.id}`,
      sourceFile: 'MRM.csv',
      sourceRow: entry.rowNo,
      sourceSha256,
      peakCount: entry.peaks.length,
      notes: '按质谱方法ID和化合物ID关联导入'
    },
    peaks: entry.peaks
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('.env 中缺少 DATABASE_URL')
  const csvBytes = await fs.readFile(csvPath)
  const sourceSha256 = crypto.createHash('sha256').update(csvBytes).digest('hex')
  const entries = parseCsv(csvBytes)
  const methodIds = entries.map((entry) => entry.methodId)
  if (new Set(methodIds).size !== methodIds.length)
    throw new Error('MRM.csv 中存在重复的质谱方法ID')

  const db = await mysql.createConnection(process.env.DATABASE_URL)
  try {
    const [methods] = await db.query(
      'SELECT m.id, m.compounds_id, m.ms_mode, m.q1, m.q3, m.ce, m.polarity, m.ion_source, m.mass_spectrum_base64, c.main_name, c.cas, c.is_delete FROM ms_methods m LEFT JOIN compounds c ON c.id=m.compounds_id WHERE m.id IN (?)',
      [methodIds]
    )
    const methodsById = new Map(methods.map((method) => [Number(method.id), method]))
    const missingMethods = entries.filter((entry) => !methodsById.has(entry.methodId))
    const compoundMismatches = entries.filter(
      (entry) => Number(methodsById.get(entry.methodId)?.compounds_id) !== entry.compoundId
    )
    const deletedCompounds = entries.filter((entry) => methodsById.get(entry.methodId)?.is_delete)
    if (missingMethods.length)
      throw new Error(
        `有 ${missingMethods.length} 个质谱方法ID不存在，例如 ${missingMethods
          .slice(0, 10)
          .map((entry) => entry.methodId)
          .join('、')}`
      )
    if (compoundMismatches.length)
      throw new Error(`有 ${compoundMismatches.length} 条记录的化合物ID与质谱方法不一致`)
    if (deletedCompounds.length)
      throw new Error(`有 ${deletedCompounds.length} 条记录关联已删除化合物`)

    const pending = []
    let unchanged = 0
    let conflicts = 0
    let q3Present = 0
    for (const entry of entries) {
      const method = methodsById.get(entry.methodId)
      const q3 = Number(method.q3)
      if (Number.isFinite(q3) && entry.peaks.some((peak) => Math.abs(peak.mz - q3) <= 0.6))
        q3Present += 1
      const existing = decodeStoredSpectrum(method.mass_spectrum_base64)
      if (
        existing?.schemaVersion === 'mass-spectrum-v1' &&
        existing?.metadata?.sourceFile === 'MRM.csv' &&
        existing?.metadata?.sourceSha256 === sourceSha256 &&
        Number(existing?.match?.methodId) === entry.methodId
      ) {
        unchanged += 1
        continue
      }
      if (text(method.mass_spectrum_base64) && !overwrite) {
        conflicts += 1
        continue
      }
      const payload = createPayload(entry, method, sourceSha256)
      pending.push({
        entry,
        encoded: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
      })
    }

    const summary = {
      source: path.relative(projectRoot, csvPath).replaceAll('\\', '/'),
      sourceSha256,
      rows: entries.length,
      compounds: new Set(entries.map((entry) => entry.compoundId)).size,
      peaks: entries.reduce((sum, entry) => sum + entry.peaks.length, 0),
      matchedMethods: methods.length,
      pending: pending.length,
      unchanged,
      conflicts,
      q3PresentWithin06: q3Present
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary }, null, 2))
    if (conflicts)
      throw new Error(`有 ${conflicts} 个目标方法已存在其他谱图；如确认覆盖请使用 --overwrite`)
    if (!apply || !pending.length) return

    await db.beginTransaction()
    try {
      for (const { entry, encoded } of pending) {
        const whereSpectrum = overwrite
          ? ''
          : " AND (mass_spectrum_base64 IS NULL OR TRIM(mass_spectrum_base64) = '')"
        const [result] = await db.execute(
          `UPDATE ms_methods SET mass_spectrum_base64 = ?, update_time = NOW() WHERE id = ? AND compounds_id = ?${whereSpectrum}`,
          [encoded, entry.methodId, entry.compoundId]
        )
        if (result.affectedRows !== 1) {
          throw new Error(`方法ID ${entry.methodId} 写入失败，数据可能已被其他操作修改`)
        }
      }
      await db.commit()
    } catch (error) {
      await db.rollback()
      throw error
    }

    const [storedRows] = await db.query(
      'SELECT id, compounds_id, mass_spectrum_base64 FROM ms_methods WHERE id IN (?)',
      [methodIds]
    )
    let verified = 0
    let verifiedPeaks = 0
    for (const row of storedRows) {
      const payload = decodeStoredSpectrum(row.mass_spectrum_base64)
      if (
        payload?.schemaVersion !== 'mass-spectrum-v1' ||
        payload?.metadata?.sourceSha256 !== sourceSha256 ||
        Number(payload?.match?.methodId) !== Number(row.id) ||
        Number(payload?.match?.compoundId) !== Number(row.compounds_id) ||
        !Array.isArray(payload?.peaks)
      )
        continue
      verified += 1
      verifiedPeaks += payload.peaks.length
    }
    if (verified !== entries.length || verifiedPeaks !== summary.peaks) {
      throw new Error(
        `写入后校验失败：谱图 ${verified}/${entries.length}，峰 ${verifiedPeaks}/${summary.peaks}`
      )
    }
    console.log(JSON.stringify({ committed: pending.length, verified, verifiedPeaks }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
