/* eslint-disable @typescript-eslint/no-explicit-any */
import {ionModePredicate} from '../../shared/ionMode.mjs'
import { prisma } from '../database'
export function compoundFilterSql(filters: any): {
  from: string
  where: string
  parameters: any[]
} {
  let from = 'FROM compounds c'
  let where = 'WHERE c.is_delete = 0 AND c.is_in_trash = ' + (filters.trashOnly ? '1' : '0')
  const parameters: any[] = []
  if (filters.favoriteOnly) where += ' AND c.is_favorite = 1'
  if (Number(filters.classId) > 0) {
    from += ' INNER JOIN compound_class cc ON cc.compound_id = c.id'
    where += ' AND cc.class_id = ?'
    parameters.push(Number(filters.classId))
  }
  if (Number(filters.libraryId) > 0) {
    where +=
      " AND EXISTS (SELECT 1 FROM entity_sources es JOIN source_records sr ON sr.id = es.source_record_id WHERE es.entity_type = 'compound' AND es.entity_id = c.id AND sr.library_id = ?)"
    parameters.push(Number(filters.libraryId))
  }
  const polarity = filters.polarity
  if(polarity!==undefined&&polarity!==null&&polarity!==''){const has=(p:number)=>`(EXISTS(SELECT 1 FROM ms_methods m WHERE m.compounds_id=c.id AND m.polarity=${p}) OR EXISTS(SELECT 1 FROM spectra s WHERE s.compound_id=c.id AND s.polarity=${p}))`;where+=' AND '+ionModePredicate(polarity,has(1),has(0))}
  const adduct = String(filters.adduct ?? '').trim()
  const kind = ['numeric', 'image'].includes(filters.spectrumKind) ? filters.spectrumKind : ''
  if (adduct || kind) {
    const clauses = ['s.compound_id = c.id']
    if (adduct) {
      clauses.push('s.adduct LIKE ?')
      parameters.push(`%${adduct}%`)
    }
    if (kind) {
      clauses.push('s.kind = ?')
      parameters.push(kind)
    }
    let acquisition = `EXISTS (SELECT 1 FROM spectra s WHERE ${clauses.join(' AND ')})`
    if (!kind) {
      const methodClauses = ['m.compounds_id = c.id']
      if (adduct) {
        methodClauses.push('m.adduct LIKE ?')
        parameters.push(`%${adduct}%`)
      }
      acquisition += ` OR EXISTS (SELECT 1 FROM ms_methods m WHERE ${methodClauses.join(' AND ')})`

    }
    where += ` AND (${acquisition})`
  }
  const keyword = String(filters.keyword ?? '').trim()
  if (keyword) {
    where +=
      " AND (EXISTS (SELECT 1 FROM JSON_TABLE(c.name, '$[*]' COLUMNS (val VARCHAR(255) PATH '$.name')) jt WHERE jt.val LIKE ?) OR c.formula LIKE ? OR c.cas LIKE ? OR c.main_name LIKE ? OR c.name_zh LIKE ? OR c.name_en LIKE ?)"
    parameters.push(...Array(6).fill(`%${keyword}%`))
  }
  return { from, where, parameters }
}
export async function filteredCompoundIds(
  filters: any = {},
  client: any = prisma
): Promise<number[]> {
  const { from, where, parameters } = compoundFilterSql(filters)
  const rows = await client.$queryRawUnsafe(
    `SELECT c.id ${from} ${where} ORDER BY c.id DESC`,
    ...parameters
  )
  return rows.map((row: any) => Number(row.id))
}
export async function listCompounds(filters: any): Promise<any> {
  const page = Number(filters.page ?? 1),
    pageSize = Number(filters.pageSize ?? 20)
  if (
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > 1000
  )
    throw new Error('分页参数无效')
  const { from, where, parameters } = compoundFilterSql(filters)
  const [list, counts] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT c.*, m1.q1 AS mrm1_q1, m1.q3 AS mrm1_q3, m1.dp AS mrm1_dp, m1.ce AS mrm1_ce,
      m2.q1 AS mrm2_q1, m2.q3 AS mrm2_q3, m2.dp AS mrm2_dp, m2.ce AS mrm2_ce
      FROM (SELECT c.id ${from} ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?) filtered
      JOIN compounds c ON c.id = filtered.id
      LEFT JOIN ms_methods m1 ON m1.compounds_id = c.id AND m1.id = (SELECT id FROM ms_methods WHERE compounds_id=c.id ORDER BY id DESC LIMIT 1)
      LEFT JOIN ms_methods m2 ON m2.compounds_id = c.id AND m2.id = (SELECT id FROM ms_methods WHERE compounds_id=c.id ORDER BY id DESC LIMIT 1,1)
      ORDER BY c.id DESC`,
      ...parameters,
      pageSize,
      (page - 1) * pageSize
    ),
    prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) AS total ${from} ${where}`, ...parameters)
  ])
  return { list, total: Number(counts[0].total), page, pageSize }
}
