/* eslint-disable @typescript-eslint/no-explicit-any */
import {ionModePredicate,ionFlags} from '../../shared/ionMode.mjs'
import { workspaceConnections, connections, getState, connection, toggleLocalFavorite } from '../federation/registry'
import { EMPTY_OVERVIEW, objectValue, type AuditAsset, type DataOverview } from '../../shared/audit'
import { refKey, type RecordRef, type UnifiedFilters } from '../../shared/federation'
import { ENGINE_VERSION } from '../../shared/analysis/types'
import { sql, ready } from './repository'
export function sourceClause(alias: string, filters: any, params: any[]): string {
  if (filters.sourceIds?.length) {
    params.push(...filters.sourceIds)
    return (
      '(' +
      filters.sourceIds
        .map(() => `JSON_CONTAINS(${alias}.sources,JSON_OBJECT('id',?))`)
        .join(' OR ') +
      ')'
    )
  }
  if (filters.sourceQuery?.trim()) {
    params.push(
      '%' +
        filters.sourceQuery
          .trim()
          .toLowerCase()
          .replace(/[\\%_]/g, '\\$&') +
        '%'
    )
    return `JSON_SEARCH(LOWER(CAST(${alias}.sources AS CHAR)),'one',?,NULL,'$[*].name') IS NOT NULL`
  }
  return '1=1'
}
export function memberScope(filters: any = {}, alias = 'm', params: any[] = []): string {
  const ids = workspaceConnections(filters.connectionIds)
    .filter(
      (x) => x.enabled && (!filters.connectionIds?.length || filters.connectionIds.includes(x.id))
    )
    .map((x) => x.id)
  if (!ids.length) return '1=0'
  params.push(...ids)
  let where = `${alias}.present=1 AND ${alias}.connection_id IN (${ids.map(() => '?').join(',')})`
  where += ` AND ${alias}.in_trash=${filters.trashOnly ? 1 : 0}`
  where += ' AND ' + sourceClause(alias, filters, params)
  return where
}
const capabilities: Record<string, string> = {
  spectrum: "a.kind='spectrum'",
  numeric:
    "JSON_LENGTH(JSON_EXTRACT(a.data,'$.row.trace.points'))>0 OR JSON_LENGTH(JSON_EXTRACT(a.data,'$.row.qualifierTrace.points'))>0",
  image: "JSON_EXTRACT(a.data,'$.image') IS NOT NULL",
  measurement: "JSON_EXTRACT(a.data,'$.row.measurement') IS NOT NULL",
  response:
    "JSON_EXTRACT(a.data,'$.row.ratio.qualifierArea') IS NOT NULL OR JSON_EXTRACT(a.data,'$.row.ratio.quantifierArea') IS NOT NULL OR JSON_EXTRACT(a.data,'$.row.qualifierTrace') IS NOT NULL OR JSON_LENGTH(JSON_EXTRACT(a.data,'$.row.qualifiers'))>0"
}
function assetExists(root: string, filters: any, condition: string, params: any[]): string {
  const scope = memberScope(filters, 'b', params),
    sources = sourceClause('a', filters, params)
  return `EXISTS(SELECT 1 FROM qc_assets a JOIN qc_members b ON b.connection_id=a.connection_id AND b.record_key=a.record_key LEFT JOIN qc_checks ck ON ck.id=a.current_check AND ck.fingerprint=a.fingerprint AND ck.engine_version='${ENGINE_VERSION}' WHERE b.entity_id=${root} AND a.present=1 AND ${scope} AND ${sources} AND (${condition}))`
}
export function catalogWhere(filters: UnifiedFilters, params: any[]): string {
  let where = memberScope(filters, 'm', params)
  if (filters.keyword?.trim()) {
    where += ' AND LOCATE(LOWER(?),LOWER(m.name_text))>0'
    params.push(filters.keyword.trim())
  }
  if (filters.identityStatus) {
    where += " AND JSON_UNQUOTE(JSON_EXTRACT(m.data,'$.properties.identity_status'))=?"
    params.push(filters.identityStatus)
  }
  if (filters.favoriteOnly) where += ' AND m.favorite=1'
  if (filters.polarity !== undefined) {
    const mode=Number(filters.polarity),has=(p:number):string=>{const scope=memberScope(filters,'ip',params);return `EXISTS(SELECT 1 FROM qc_members ip WHERE ip.entity_id=m.entity_id AND ${scope} AND JSON_CONTAINS(JSON_EXTRACT(ip.data,'$.polarities'),'${p}'))`};
    if(mode===1||mode===0)where+=' AND '+has(mode);else where+=' AND '+ionModePredicate(mode,has(1),has(0));
  }
  if (filters.adduct?.trim()) {
    where += " AND JSON_CONTAINS(JSON_EXTRACT(m.data,'$.adducts'),JSON_QUOTE(?))"
    params.push(filters.adduct.trim())
  }
  if (filters.classId) {
    if (filters.classId >= 1000000000) {
      where += ' AND JSON_CONTAINS(m.class_ids,CAST(? AS JSON))'
      params.push(JSON.stringify(filters.classId))
    } else {
      const refs = getState().groups.find((x) => x.id === filters.classId)?.refs ?? []
      const conditions: string[] = []
      for (const text of refs) {
        try {
          const [id, key] = JSON.parse(text)
          if (id === '@unified') {
            conditions.push('m.entity_id=?')
            params.push(key)
          } else {
            conditions.push('(m.connection_id=? AND m.record_key=?)')
            params.push(id, key)
          }
        } catch {
          /* malformed old group ref */
        }
      }
      where += ' AND (' + (conditions.join(' OR ') || '1=0') + ')'
    }
  }
  for (const type of filters.dataTypes ?? []) {
    if (!capabilities[type]) throw new Error('数据类型筛选无效')
    where += ' AND ' + assetExists('m.entity_id', filters, capabilities[type], params)
  }
  if (filters.spectrumKind) {
    where +=
      ' AND ' +
      assetExists(
        'm.entity_id',
        filters,
        "a.kind='spectrum' AND JSON_UNQUOTE(JSON_EXTRACT(a.data,'$.metadata.kind'))=?",
        params
      )
    params.push(filters.spectrumKind)
  }
  if (filters.auditState) {
    const terms: Record<string, string> = {
      abnormal: 'ck.abnormal=1',
      incomplete: 'ck.incomplete=1',
      pending:
        "a.kind<>'spectrum' AND JSON_EXTRACT(a.data,'$.linkedResult') IS NULL AND JSON_LENGTH(JSON_EXTRACT(a.data,'$.checks'))>0 AND ck.id IS NULL",
      unreviewed:
        '(ck.abnormal=1 OR ck.incomplete=1) AND NOT EXISTS(SELECT 1 FROM qc_reviews rv WHERE rv.check_id=ck.id)'
    }
    if (!terms[filters.auditState]) throw new Error('自动检查筛选无效')
    where += ' AND ' + assetExists('m.entity_id', filters, terms[filters.auditState], params)
  }
  return where
}
export async function indexed(entries = connections().filter((x) => x.enabled)): Promise<boolean> {
  if (!ready()) return false
  for (const entry of entries)
    if (
      !(
        await sql("SELECT id FROM qc_scans WHERE connection_id=? AND state='completed' LIMIT 1", [
          entry.id
        ])
      ).length
    )
      return false
  return true
}
export async function assetsFor(root: string, filters: any = {}): Promise<any[]> {
  const args: any[] = [root],
    scope = memberScope(filters, 'm', args),
    source = sourceClause('a', filters, args)
  return sql(
    `SELECT a.*,ck.id AS check_id,ck.data AS check_data,ck.revision,ck.created_at AS checked_at FROM qc_assets a JOIN qc_members m ON m.connection_id=a.connection_id AND m.record_key=a.record_key LEFT JOIN qc_checks ck ON ck.id=a.current_check AND ck.fingerprint=a.fingerprint AND ck.engine_version='${ENGINE_VERSION}' WHERE m.entity_id=? AND a.present=1 AND ${scope} AND ${source} ORDER BY a.kind,a.id`,
    args
  )
}
export function overview(items: any[]): DataOverview {
  const result = { ...EMPTY_OVERVIEW }
  const linked = new Set(
    items
      .filter((x) => objectValue(x.data).linkedResult)
      .map((x) => objectValue(x.data).linkedResult)
  )
  for (const item of items) {
    const a = objectValue(item.data) as AuditAsset
    if (a.kind === 'spectrum') result.spectra++
    if (a.image) result.images++
    if (a.row?.measurement) result.measurements++
    if (
      a.row?.ratio?.qualifierArea !== undefined ||
      a.row?.ratio?.quantifierArea !== undefined ||
      a.row?.qualifierTrace ||
      a.row?.qualifiers?.length
    )
      result.responses++
    if (!linked.has(a.recordKey)) {
      if (
        a.row?.trace?.points.length ||
        a.row?.qualifierTrace?.points.length ||
        a.row?.qualifiers?.some((q) => q.trace?.points.length)
      )
        result.numericTraces++
      if (a.row?.qualifierTrace?.points.length) result.numericTraces++
      result.numericTraces += a.row?.qualifiers?.filter((q) => q.trace?.points.length).length ?? 0
    }
    if (a.kind === 'spectrum' || a.linkedResult || !a.checks.length) continue
    const check = objectValue(item.check_data)
    if (check) {
      result.checked++
      if (check.abnormal) result.abnormal++
      if (check.incomplete) result.incomplete++
    } else result.pending++
  }
  return result
}
export async function catalogList(filters: UnifiedFilters = {}): Promise<any> {
  const page = Number(filters.page ?? 1),
    size = Number(filters.pageSize ?? 50)
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 200
  )
    throw new Error('分页参数无效')
  const args: any[] = [],
    where = catalogWhere(filters, args)
  const total = Number(
    (await sql(`SELECT COUNT(DISTINCT m.entity_id) AS n FROM qc_members m WHERE ${where}`, args))[0]
      .n
  )
  const roots = filters.countOnly?[]:await sql(
    `SELECT m.entity_id FROM qc_members m WHERE ${where} GROUP BY m.entity_id ORDER BY MIN(m.name_text),m.entity_id LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size]
  )
  const list: any[] = []
  for (const root of roots) {
    const scopedArgs: any[] = [root.entity_id],
      scope = memberScope(filters, 'm', scopedArgs)
    const members = await sql(
      `SELECT * FROM qc_members m WHERE m.entity_id=? AND ${scope} ORDER BY m.connection_id,m.record_key`,
      scopedArgs
    )
    const values = members.map((m) => objectValue(m.data)),
      base = values[0]
    if (!base) continue
    const assets = await assetsFor(root.entity_id, filters)
    list.push({
      ...base,
      ionModes:ionFlags(values.flatMap(v=>v.polarities||[])),
      ref: { connectionId: '@unified', key: root.entity_id },
      rowKey: root.entity_id,
      canonicalId: root.entity_id,
      is_favorite: members.some((m) => !!m.favorite),
      memberRefs: values.map((v) => v.ref),
      memberCount: members.length,
      connectionName: [...new Set(values.map((v) => v.connectionName))].join(' / '),
      name_zh: values.find((v) => v.name_zh)?.name_zh,
      name_en: values.find((v) => v.name_en)?.name_en,
      sources: [...new Map(values.flatMap((v) => v.sources ?? []).map((v) => [v.id, v])).values()],
      dataOverview: overview(assets),
      identityIssue: members.map((m) => m.identity_issue).filter(Boolean),
      scope: {
        connectionIds: filters.connectionIds,
        sourceIds: filters.sourceIds,
        sourceQuery: filters.sourceQuery,
        trashOnly: filters.trashOnly
      }
    })
  }
  const warnings: any[] = []
  for (const entry of connections().filter(
    (x) => x.enabled && (!filters.connectionIds?.length || filters.connectionIds.includes(x.id))
  )) {
    const last = (
      await sql(
        'SELECT state,updated_at,detail FROM qc_scans WHERE connection_id=? ORDER BY created_at DESC,id DESC LIMIT 1',
        [entry.id]
      )
    )[0]
    if (last?.state === 'failed')
      warnings.push({
        connectionId: entry.id,
        name: entry.name,
        message:
          '最新扫描失败；当前显示先前索引，可能不是最新数据。' +
          (objectValue(last.detail)?.error ?? '')
      })
  }
  return {
    list,
    total,
    page,
    pageSize: size,
    warnings,
    complete: !warnings.length,
    unified: true,
    indexed: true
  }
}
export async function rootFor(ref: RecordRef): Promise<string | undefined> {
  if (ref.connectionId === '@unified') return ref.key
  return (
    await sql(
      'SELECT entity_id FROM qc_members WHERE connection_id=? AND record_key=? AND present=1',
      [ref.connectionId, ref.key]
    )
  )[0]?.entity_id
}
export async function memberRows(root: string, filters: any = {}): Promise<any[]> {
  const args: any[] = [root],
    scope = memberScope(filters, 'm', args)
  return sql(
    `SELECT m.* FROM qc_members m WHERE m.entity_id=? AND ${scope} ORDER BY m.connection_id,m.record_key`,
    args
  )
}
export async function checkDetail(id: string): Promise<any> {
  const item = (await sql('SELECT * FROM qc_checks WHERE id=?', [id]))[0]
  if (!item) throw new Error('检查结果不存在')
  return {
    ...item,
    data: objectValue(item.data),
    evidence: objectValue(item.evidence),
    reviews: await sql('SELECT * FROM qc_reviews WHERE check_id=? ORDER BY created_at,id', [id])
  }
}
export async function checkRows(filters: any = {}): Promise<any> {
  const args: any[] = [],
    scope = memberScope(filters, 'm', args),
    sources = sourceClause('a', filters, args)
  let where = `a.present=1 AND ${scope} AND ${sources}`
  if (filters.rootId) {
    where += ' AND m.entity_id=?'
    args.push(filters.rootId)
  }
  if (filters.keyword) {
    where +=
      " AND LOCATE(LOWER(?),LOWER(CONCAT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ck.data,'$.sample')),''),' ',m.name_text)))>0"
    args.push(filters.keyword)
  }
  const states: Record<string, string> = {
    abnormal: 'ck.abnormal=1',
    incomplete: 'ck.incomplete=1',
    unreviewed:
      '(ck.abnormal=1 OR ck.incomplete=1) AND NOT EXISTS(SELECT 1 FROM qc_reviews r WHERE r.check_id=ck.id)'
  }
  if (filters.state) {
    if (!states[filters.state]) throw new Error('检查状态无效')
    where += ' AND ' + states[filters.state]
  }
  const predicates: Record<string, string> = {
    fronting: "JSON_CONTAINS(JSON_EXTRACT(ck.data,'$.peak.flags'),JSON_QUOTE('fronting'))",
    tailing: "JSON_CONTAINS(JSON_EXTRACT(ck.data,'$.peak.flags'),JSON_QUOTE('tailing'))",
    split: "JSON_CONTAINS(JSON_EXTRACT(ck.data,'$.peak.flags'),JSON_QUOTE('split'))",
    limit: "JSON_UNQUOTE(JSON_EXTRACT(ck.data,'$.limit.state'))='fail'",
    ratio: "JSON_UNQUOTE(JSON_EXTRACT(ck.data,'$.ratio.state'))='fail'"
  }
  if (filters.issue) {
    if (!predicates[filters.issue]) throw new Error('异常类型无效')
    where += ' AND ' + predicates[filters.issue]
  }
  const from = `FROM qc_checks ck JOIN qc_assets a ON a.current_check=ck.id AND a.fingerprint=ck.fingerprint AND ck.engine_version='${ENGINE_VERSION}' AND a.present=1 JOIN qc_members m ON m.connection_id=a.connection_id AND m.record_key=a.record_key`
  const page = Number(filters.page ?? 1),
    size = Number(filters.pageSize ?? 50)
  if (!Number.isSafeInteger(page) || page < 1 || ![20, 50, 100].includes(size))
    throw new Error('分页参数无效')
  const total = Number((await sql(`SELECT COUNT(*) n ${from} WHERE ${where}`, args))[0].n)
  const data = await sql(
    `SELECT ck.id,ck.revision,ck.data,ck.created_at,m.entity_id,m.connection_id,m.record_key,JSON_UNQUOTE(JSON_EXTRACT(a.data,'$.batchName')) batch_name,JSON_UNQUOTE(JSON_EXTRACT(a.data,'$.methodName')) method_name,(SELECT action FROM qc_reviews WHERE check_id=ck.id ORDER BY created_at DESC,id DESC LIMIT 1) review ${from} WHERE ${where} ORDER BY ck.created_at DESC,ck.id LIMIT ? OFFSET ?`,
    [...args, size, (page - 1) * size]
  )
  return {
    total,
    page,
    pageSize: size,
    rows: data.map((x) => ({
      ...x,
      result: objectValue(x.data),
      connectionName: connection(x.connection_id).name
    }))
  }
}
export async function toggleRootFavorite(root: string, value: boolean): Promise<boolean> {
  const members = await memberRows(root)
  for (const member of members)
    toggleLocalFavorite(
      refKey({ connectionId: member.connection_id, key: member.record_key }),
      !value
    )
  await sql('UPDATE qc_members SET favorite=? WHERE entity_id=?', [value, root])
  return value
}
