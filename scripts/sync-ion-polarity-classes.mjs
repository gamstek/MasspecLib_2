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
const classSpecs = [
  { name: '正离子', polarity: 1 },
  { name: '负离子', polarity: 0 }
]
const supportedSchemas = new Set(['nist-ms2-v1', 'mass-spectrum-v1'])

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function hasViewableSpectrum(value) {
  const raw = text(value)
  if (!raw) return false
  try {
    const encoded = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    return (
      supportedSchemas.has(payload?.schemaVersion) &&
      Array.isArray(payload?.peaks) &&
      payload.peaks.some(
        (peak) =>
          Number.isFinite(Number(peak?.mz)) &&
          Number(peak?.mz) > 0 &&
          Number.isFinite(Number(peak?.intensity)) &&
          Number(peak?.intensity) >= 0
      )
    )
  } catch {
    return false
  }
}

async function loadTargets(db) {
  const [rows] = await db.query(
    `SELECT c.id AS compound_id, m.polarity, m.mass_spectrum_base64
     FROM compounds c
     JOIN ms_methods m ON m.compounds_id = c.id
     WHERE COALESCE(c.is_delete, 0) = 0
       AND m.mass_spectrum_base64 IS NOT NULL
       AND TRIM(m.mass_spectrum_base64) <> ''
     ORDER BY c.id, m.id`
  )
  const byPolarity = new Map(classSpecs.map((spec) => [spec.polarity, new Set()]))
  let invalidNonemptySpectra = 0
  for (const row of rows) {
    if (!hasViewableSpectrum(row.mass_spectrum_base64)) {
      invalidNonemptySpectra += 1
      continue
    }
    const target = byPolarity.get(Number(row.polarity))
    if (target) target.add(Number(row.compound_id))
  }
  return { byPolarity, invalidNonemptySpectra }
}

async function loadClassRows(db) {
  const [rows] = await db.query(
    'SELECT id, class_name, is_custom FROM classes WHERE class_name IN (?, ?) ORDER BY id',
    classSpecs.map((spec) => spec.name)
  )
  for (const spec of classSpecs) {
    const matches = rows.filter((row) => text(row.class_name) === spec.name)
    if (matches.length > 1) {
      throw new Error(`分类“${spec.name}”存在 ${matches.length} 条重复记录，无法安全同步`)
    }
  }
  return rows
}

async function ensureClasses(db, existingRows) {
  const classByName = new Map(existingRows.map((row) => [text(row.class_name), row]))
  for (const spec of classSpecs) {
    let row = classByName.get(spec.name)
    if (!row) {
      const [inserted] = await db.execute(
        'INSERT INTO classes (class_name, is_custom, create_time, update_time) VALUES (?, 0, NOW(), NOW())',
        [spec.name]
      )
      row = { id: Number(inserted.insertId), class_name: spec.name, is_custom: 0 }
      classByName.set(spec.name, row)
    } else if (Number(row.is_custom) !== 0) {
      await db.execute('UPDATE classes SET is_custom = 0, update_time = NOW() WHERE id = ?', [
        Number(row.id)
      ])
      row.is_custom = 0
    }
  }
  return classByName
}

async function loadExistingLinks(db, classId) {
  const [rows] = await db.query(
    `SELECT cc.compound_id
     FROM compound_class cc
     JOIN compounds c ON c.id = cc.compound_id
     WHERE cc.class_id = ? AND COALESCE(c.is_delete, 0) = 0`,
    [classId]
  )
  return new Set(rows.map((row) => Number(row.compound_id)))
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value))
}

async function insertLinks(db, classId, compoundIds) {
  let inserted = 0
  for (let index = 0; index < compoundIds.length; index += 500) {
    const ids = compoundIds.slice(index, index + 500)
    if (!ids.length) continue
    const [result] = await db.query(
      'INSERT IGNORE INTO compound_class (compound_id, class_id, create_time, update_time) VALUES ?',
      [ids.map((compoundId) => [compoundId, classId, new Date(), new Date()])]
    )
    inserted += Number(result.affectedRows)
  }
  return inserted
}

async function deleteLinks(db, classId, compoundIds) {
  let deleted = 0
  for (let index = 0; index < compoundIds.length; index += 500) {
    const ids = compoundIds.slice(index, index + 500)
    if (!ids.length) continue
    const [result] = await db.query(
      'DELETE FROM compound_class WHERE class_id = ? AND compound_id IN (?)',
      [classId, ids]
    )
    deleted += Number(result.affectedRows)
  }
  return deleted
}

async function buildPlan(db, targets, classRows) {
  const classByName = new Map(classRows.map((row) => [text(row.class_name), row]))
  const items = []
  for (const spec of classSpecs) {
    const row = classByName.get(spec.name)
    const targetIds = targets.byPolarity.get(spec.polarity)
    const existingIds = row ? await loadExistingLinks(db, Number(row.id)) : new Set()
    items.push({
      ...spec,
      classId: row ? Number(row.id) : null,
      isCustom: row ? Number(row.is_custom) !== 0 : false,
      targetIds,
      existingIds,
      toAdd: difference(targetIds, existingIds),
      toRemove: difference(existingIds, targetIds)
    })
  }
  const positiveIds = targets.byPolarity.get(1)
  const negativeIds = targets.byPolarity.get(0)
  const both = [...positiveIds].filter((id) => negativeIds.has(id)).length
  const union = new Set([...positiveIds, ...negativeIds])
  const [compoundCountRows] = await db.query(
    'SELECT COUNT(*) AS count FROM compounds WHERE COALESCE(is_delete, 0) = 0'
  )
  return {
    items,
    both,
    coveredCompounds: union.size,
    activeCompounds: Number(compoundCountRows[0].count),
    invalidNonemptySpectra: targets.invalidNonemptySpectra
  }
}

async function verify(db, plan, classByName) {
  const result = {}
  const covered = new Set()
  for (const item of plan.items) {
    const classRow = classByName.get(item.name)
    const actual = await loadExistingLinks(db, Number(classRow.id))
    const missing = difference(item.targetIds, actual)
    const extra = difference(actual, item.targetIds)
    if (missing.length || extra.length) {
      throw new Error(
        `分类“${item.name}”校验失败：缺少 ${missing.length} 条，多出 ${extra.length} 条`
      )
    }
    for (const id of actual) covered.add(id)
    result[item.name] = { classId: Number(classRow.id), compounds: actual.size }
  }
  if (covered.size !== plan.activeCompounds) {
    throw new Error(`离子分类未覆盖所有化合物：${covered.size}/${plan.activeCompounds}`)
  }
  return { classes: result, bothPolarities: plan.both, coveredCompounds: covered.size }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('.env 中缺少 DATABASE_URL')
  const db = await mysql.createConnection(process.env.DATABASE_URL)
  let transactionOpen = false
  try {
    const targets = await loadTargets(db)
    const classRows = await loadClassRows(db)
    const plan = await buildPlan(db, targets, classRows)
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          activeCompounds: plan.activeCompounds,
          coveredCompounds: plan.coveredCompounds,
          bothPolarities: plan.both,
          invalidNonemptySpectra: plan.invalidNonemptySpectra,
          classes: plan.items.map((item) => ({
            name: item.name,
            polarity: item.polarity,
            classId: item.classId,
            needsStandardClassification: item.isCustom,
            targetCompounds: item.targetIds.size,
            existingLinks: item.existingIds.size,
            linksToAdd: item.toAdd.length,
            linksToRemove: item.toRemove.length
          }))
        },
        null,
        2
      )
    )
    if (!apply) return

    await db.beginTransaction()
    transactionOpen = true
    const lockedClassRows = await loadClassRows(db)
    const classByName = await ensureClasses(db, lockedClassRows)
    const applied = {}
    for (const item of plan.items) {
      const classId = Number(classByName.get(item.name).id)
      const existingIds = await loadExistingLinks(db, classId)
      const toAdd = difference(item.targetIds, existingIds)
      const toRemove = difference(existingIds, item.targetIds)
      applied[item.name] = {
        classId,
        insertedLinks: await insertLinks(db, classId, toAdd),
        deletedStaleLinks: await deleteLinks(db, classId, toRemove)
      }
    }
    const verification = await verify(db, plan, classByName)
    await db.commit()
    transactionOpen = false
    console.log(JSON.stringify({ applied, verification }, null, 2))
  } catch (error) {
    if (transactionOpen) await db.rollback()
    throw error
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
