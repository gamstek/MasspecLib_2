import './legacy-disabled.mjs'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import process from 'process'
import { config as loadEnv } from 'dotenv'
import mysql from 'mysql2/promise'

const root = resolve(process.cwd())
const backupDir = join(root, 'backups')
const applyChanges = process.argv.includes('--apply')
const createBackup = !process.argv.includes('--no-backup')
const createReport = !process.argv.includes('--no-report')
const identityFields = ['compounds_id', 'ms_mode', 'q1', 'q3', 'ce', 'dp', 'cxp', 'polarity']
const mergeFields = ['ion_source', 'scan_mode', 'cad_value', 'cad_type']
const numericFields = new Set([
  'compounds_id',
  'q1',
  'q3',
  'ce',
  'dp',
  'cxp',
  'polarity',
  'cad_value'
])

const timestamp = () =>
  new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')

function normalizedValue(field, value) {
  if (value === null || value === undefined || value === '') return ''
  if (numericFields.has(field)) {
    const number = Number(value)
    return Number.isFinite(number) ? String(number) : ''
  }
  return String(value).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function methodKey(method) {
  return identityFields.map((field) => normalizedValue(field, method[field])).join('|')
}

function decodeStoredSpectrum(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const encoded = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function spectrumRank(method) {
  const raw = String(method.mass_spectrum_base64 ?? '').trim()
  if (!raw) return 0
  const spectrum = decodeStoredSpectrum(raw)
  if (spectrum?.schemaVersion !== 'nist-ms2-v1') return 1
  if (spectrum.match?.type === 'strict') return 3
  if (spectrum.match?.type === 'representative') return 2
  return 1
}

function completeness(method) {
  return [...identityFields, ...mergeFields].reduce(
    (score, field) => score + (normalizedValue(field, method[field]) === '' ? 0 : 1),
    0
  )
}

function compareKeepPriority(left, right) {
  const spectrumDifference = spectrumRank(right) - spectrumRank(left)
  if (spectrumDifference) return spectrumDifference
  const completenessDifference = completeness(right) - completeness(left)
  if (completenessDifference) return completenessDifference
  return Number(left.id) - Number(right.id)
}

function previewGroup(group) {
  const keeper = group.keeper
  const duplicates = group.rows.slice(1)
  return {
    key: group.key,
    compoundId: keeper.compounds_id,
    keepId: Number(keeper.id),
    keepSpectrumRank: spectrumRank(keeper),
    deleteIds: duplicates.map((method) => Number(method.id)),
    mergedFields: Object.keys(group.changes)
  }
}

function mergeGroup(group) {
  const keeper = { ...group.rows[0] }
  const changes = {}

  for (const field of mergeFields) {
    if (normalizedValue(field, keeper[field]) !== '') continue
    const source = group.rows.find((method) => normalizedValue(field, method[field]) !== '')
    if (!source) continue
    keeper[field] = source[field]
    changes[field] = source[field]
  }

  return {
    ...group,
    keeper,
    changes
  }
}

async function deleteInBatches(db, ids) {
  const batchSize = 500
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize)
    await db.query(
      'DELETE FROM ms_methods WHERE id IN (' + batch.map(() => '?').join(',') + ')',
      batch
    )
  }
}

async function main() {
  const envFile = join(root, '.env')
  if (!existsSync(envFile)) throw new Error('Database config was not found: ' + envFile)
  loadEnv({ path: envFile, quiet: true })

  const db = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    charset: 'utf8mb4'
  })

  try {
    const [methods] = await db.query('SELECT * FROM ms_methods ORDER BY id')
    const grouped = new Map()

    for (const method of methods) {
      if (method.compounds_id === null || method.compounds_id === undefined) continue
      const key = methodKey(method)
      grouped.set(key, [...(grouped.get(key) ?? []), method])
    }

    const duplicateGroups = [...grouped.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([key, rows]) => ({ key, rows: [...rows].sort(compareKeepPriority) }))
      .map(mergeGroup)
    const rowsToDelete = duplicateGroups.flatMap((group) => group.rows.slice(1))
    const keeperRows = duplicateGroups.map((group) => group.keeper)
    const methodsToUpdate = duplicateGroups.filter((group) => Object.keys(group.changes).length)
    const runId = timestamp()

    if (createReport || (applyChanges && createBackup)) mkdirSync(backupDir, { recursive: true })
    const summary = {
      mode: applyChanges ? 'apply' : 'dry-run',
      generatedAt: new Date().toISOString(),
      scannedMethods: methods.length,
      duplicateGroups: duplicateGroups.length,
      rowsToDelete: rowsToDelete.length,
      methodsToUpdate: methodsToUpdate.length,
      backupEnabled: createBackup,
      strictSpectrumRowsDeleted: rowsToDelete.filter((method) => spectrumRank(method) === 3).length,
      representativeSpectrumRowsDeleted: rowsToDelete.filter((method) => spectrumRank(method) === 2)
        .length
    }

    let backupPath = null
    if (applyChanges && createBackup && rowsToDelete.length) {
      backupPath = join(backupDir, 'ms-method-dedup-before-' + runId + '.json')
      writeFileSync(
        backupPath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            summary,
            identityFields,
            keptRows: keeperRows,
            deletedRows: rowsToDelete
          },
          null,
          2
        ),
        'utf8'
      )
    }

    if (applyChanges && rowsToDelete.length) {
      await db.beginTransaction()
      try {
        for (const group of methodsToUpdate) {
          await db.execute(
            'UPDATE ms_methods SET ion_source = ?, scan_mode = ?, cad_value = ?, cad_type = ?, ' +
              'update_time = NOW() WHERE id = ?',
            [
              group.keeper.ion_source,
              group.keeper.scan_mode,
              group.keeper.cad_value,
              group.keeper.cad_type,
              group.keeper.id
            ]
          )
        }
        await deleteInBatches(
          db,
          rowsToDelete.map((method) => Number(method.id))
        )
        await db.commit()
      } catch (error) {
        await db.rollback()
        throw error
      }
    }

    let reportPath = null
    if (createReport) {
      reportPath = join(backupDir, 'ms-method-dedup-report-' + runId + '.json')
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            summary: {
              ...summary,
              backupPath,
              deletedRows: applyChanges ? rowsToDelete.length : 0
            },
            identityFields,
            mergeFields,
            groups: duplicateGroups.map(previewGroup)
          },
          null,
          2
        ),
        'utf8'
      )
    }

    console.log(
      JSON.stringify(
        { ...summary, backupPath, reportPath, deletedRows: applyChanges ? rowsToDelete.length : 0 },
        null,
        2
      )
    )
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
