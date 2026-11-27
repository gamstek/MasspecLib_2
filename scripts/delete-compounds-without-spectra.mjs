import './legacy-disabled.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import mysql from 'mysql2/promise'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true })

const apply = process.argv.includes('--apply')
const supportedSchemas = new Set(['nist-ms2-v1', 'mass-spectrum-v1'])

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function decodeViewableSpectrum(value) {
  const raw = text(value)
  if (!raw) return null
  try {
    const encoded = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    if (!supportedSchemas.has(payload?.schemaVersion) || !Array.isArray(payload?.peaks)) return null
    const hasViewablePeak = payload.peaks.some(
      (peak) =>
        Number.isFinite(Number(peak?.mz)) &&
        Number(peak?.mz) > 0 &&
        Number.isFinite(Number(peak?.intensity)) &&
        Number(peak?.intensity) >= 0
    )
    return hasViewablePeak ? payload : null
  } catch {
    return null
  }
}

function analyzeCompounds(rows) {
  const compounds = new Map()
  for (const row of rows) {
    const compoundId = Number(row.compound_id)
    const item = compounds.get(compoundId) ?? {
      id: compoundId,
      mainName: text(row.main_name),
      isDeleted: Number(row.is_delete) !== 0,
      methodCount: 0,
      nonemptySpectrumCount: 0,
      viewableSpectrumCount: 0
    }
    if (row.method_id !== null && row.method_id !== undefined) {
      item.methodCount += 1
      if (text(row.mass_spectrum_base64)) item.nonemptySpectrumCount += 1
      if (decodeViewableSpectrum(row.mass_spectrum_base64)) item.viewableSpectrumCount += 1
    }
    compounds.set(compoundId, item)
  }
  const all = [...compounds.values()]
  return {
    all,
    targets: all.filter((item) => item.viewableSpectrumCount === 0),
    retained: all.filter((item) => item.viewableSpectrumCount > 0)
  }
}

async function createTargetTable(db, targetIds) {
  await db.query('DROP TEMPORARY TABLE IF EXISTS tmp_compounds_without_spectra')
  await db.query('DROP TEMPORARY TABLE IF EXISTS tmp_lc_methods_without_spectra')
  await db.query(
    'CREATE TEMPORARY TABLE tmp_compounds_without_spectra (id INT PRIMARY KEY) ENGINE=MEMORY'
  )
  for (let index = 0; index < targetIds.length; index += 500) {
    const ids = targetIds.slice(index, index + 500)
    if (!ids.length) continue
    await db.query('INSERT INTO tmp_compounds_without_spectra (id) VALUES ?', [
      ids.map((id) => [id])
    ])
  }
  await db.query(
    `CREATE TEMPORARY TABLE tmp_lc_methods_without_spectra (id INT PRIMARY KEY) ENGINE=MEMORY
     SELECT lm.id
     FROM lc_methods lm
     JOIN tmp_compounds_without_spectra t ON t.id = lm.compounds_id`
  )
}

async function relationCounts(db) {
  const statements = [
    ['compounds', 'SELECT COUNT(*) AS count FROM tmp_compounds_without_spectra'],
    [
      'classLinks',
      'SELECT COUNT(*) AS count FROM compound_class cc JOIN tmp_compounds_without_spectra t ON t.id = cc.compound_id'
    ],
    [
      'lcMethods',
      'SELECT COUNT(*) AS count FROM lc_methods lm JOIN tmp_lc_methods_without_spectra t ON t.id = lm.id'
    ],
    [
      'lcItems',
      'SELECT COUNT(*) AS count FROM lc_methods_items li JOIN tmp_lc_methods_without_spectra t ON t.id = li.lc_methods_id'
    ],
    [
      'msMethods',
      'SELECT COUNT(*) AS count FROM ms_methods mm JOIN tmp_compounds_without_spectra t ON t.id = mm.compounds_id'
    ]
  ]
  const counts = {}
  for (const [key, statement] of statements) {
    const [rows] = await db.query(statement)
    counts[key] = Number(rows[0].count)
  }
  return counts
}

async function compoundSpectrumState(db) {
  const [rows] = await db.query(
    `SELECT
       c.id AS compound_id,
       c.main_name,
       COALESCE(c.is_delete, 0) AS is_delete,
       m.id AS method_id,
       m.mass_spectrum_base64
     FROM compounds c
     LEFT JOIN ms_methods m ON m.compounds_id = c.id
     ORDER BY c.id, m.id`
  )
  return analyzeCompounds(rows)
}

async function orphanCounts(db) {
  const [rows] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM compound_class cc LEFT JOIN compounds c ON c.id = cc.compound_id WHERE c.id IS NULL) AS classLinks,
       (SELECT COUNT(*) FROM lc_methods lm LEFT JOIN compounds c ON c.id = lm.compounds_id WHERE c.id IS NULL) AS lcMethods,
       (SELECT COUNT(*) FROM lc_methods_items li LEFT JOIN lc_methods lm ON lm.id = li.lc_methods_id WHERE lm.id IS NULL) AS lcItems,
       (SELECT COUNT(*) FROM ms_methods mm LEFT JOIN compounds c ON c.id = mm.compounds_id WHERE mm.compounds_id IS NOT NULL AND c.id IS NULL) AS msMethods`
  )
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]))
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('.env 中缺少 DATABASE_URL')
  const db = await mysql.createConnection(process.env.DATABASE_URL)
  let transactionOpen = false
  try {
    await db.beginTransaction()
    transactionOpen = true

    const before = await compoundSpectrumState(db)
    const targetIds = before.targets.map((item) => item.id)
    await createTargetTable(db, targetIds)
    const relations = await relationCounts(db)
    const beforeOrphans = await orphanCounts(db)
    const targetBreakdown = {
      noMethods: before.targets.filter((item) => item.methodCount === 0).length,
      methodsWithoutSpectrum: before.targets.filter(
        (item) => item.methodCount > 0 && item.nonemptySpectrumCount === 0
      ).length,
      invalidNonemptySpectrum: before.targets.filter((item) => item.nonemptySpectrumCount > 0)
        .length
    }

    const preview = {
      mode: apply ? 'apply' : 'dry-run',
      compoundsBefore: before.all.length,
      activeCompoundsBefore: before.all.filter((item) => !item.isDeleted).length,
      compoundsWithViewableSpectrumBefore: before.retained.length,
      compoundsToDelete: before.targets.length,
      softDeletedTargets: before.targets.filter((item) => item.isDeleted).length,
      targetBreakdown,
      relatedRowsToDelete: relations,
      existingOrphans: beforeOrphans,
      targetSample: before.targets.slice(0, 20).map((item) => ({
        id: item.id,
        name: item.mainName,
        methodCount: item.methodCount
      }))
    }
    console.log(JSON.stringify(preview, null, 2))

    if (!apply) {
      await db.rollback()
      transactionOpen = false
      return
    }

    const [deletedLcItems] = await db.query(
      'DELETE li FROM lc_methods_items li JOIN tmp_lc_methods_without_spectra t ON t.id = li.lc_methods_id'
    )
    const [deletedLcMethods] = await db.query(
      'DELETE lm FROM lc_methods lm JOIN tmp_lc_methods_without_spectra t ON t.id = lm.id'
    )
    const [deletedMsMethods] = await db.query(
      'DELETE mm FROM ms_methods mm JOIN tmp_compounds_without_spectra t ON t.id = mm.compounds_id'
    )
    const [deletedClassLinks] = await db.query(
      'DELETE cc FROM compound_class cc JOIN tmp_compounds_without_spectra t ON t.id = cc.compound_id'
    )
    const remainingRelations = await relationCounts(db)
    if (
      remainingRelations.classLinks !== 0 ||
      remainingRelations.lcMethods !== 0 ||
      remainingRelations.lcItems !== 0 ||
      remainingRelations.msMethods !== 0
    ) {
      throw new Error(`删除化合物前仍有关联数据：${JSON.stringify(remainingRelations)}`)
    }
    const [deletedCompounds] = await db.query(
      'DELETE c FROM compounds c JOIN tmp_compounds_without_spectra t ON t.id = c.id'
    )

    const deleted = {
      compounds: Number(deletedCompounds.affectedRows),
      classLinks: Number(deletedClassLinks.affectedRows),
      lcMethods: Number(deletedLcMethods.affectedRows),
      lcItems: Number(deletedLcItems.affectedRows),
      msMethods: Number(deletedMsMethods.affectedRows)
    }
    for (const key of Object.keys(relations)) {
      if (deleted[key] !== relations[key]) {
        throw new Error(`删除行数校验失败：${key} 预期 ${relations[key]}，实际 ${deleted[key]}`)
      }
    }

    const after = await compoundSpectrumState(db)
    const afterOrphans = await orphanCounts(db)
    const targetRowsRemaining = after.all.filter((item) => targetIds.includes(item.id)).length
    if (targetRowsRemaining !== 0)
      throw new Error(`删除后仍有 ${targetRowsRemaining} 个目标化合物存在`)
    if (after.targets.length !== 0) {
      throw new Error(`删除后仍有 ${after.targets.length} 个化合物没有可显示谱图`)
    }
    for (const key of Object.keys(beforeOrphans)) {
      if (afterOrphans[key] !== beforeOrphans[key]) {
        throw new Error(
          `孤立记录校验失败：${key} 删除前 ${beforeOrphans[key]}，删除后 ${afterOrphans[key]}`
        )
      }
    }

    await db.commit()
    transactionOpen = false
    console.log(
      JSON.stringify(
        {
          deleted,
          verification: {
            compoundsAfter: after.all.length,
            activeCompoundsAfter: after.all.filter((item) => !item.isDeleted).length,
            compoundsWithMethodsAfter: after.all.filter((item) => item.methodCount > 0).length,
            compoundsWithViewableSpectrumAfter: after.retained.length,
            compoundsWithoutViewableSpectrumAfter: after.targets.length,
            orphanCounts: afterOrphans
          }
        },
        null,
        2
      )
    )
  } catch (error) {
    if (transactionOpen) await db.rollback()
    throw error
  } finally {
    try {
      await db.query('DROP TEMPORARY TABLE IF EXISTS tmp_lc_methods_without_spectra')
      await db.query('DROP TEMPORARY TABLE IF EXISTS tmp_compounds_without_spectra')
    } finally {
      await db.end()
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
