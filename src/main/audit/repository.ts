/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPool, type Pool, type PoolConnection } from 'mysql2/promise'
import { randomUUID, createHash } from 'node:crypto'
import { credentials, connection, connections, registryCategoryId } from '../federation/registry'
import { identityKey, objectValue, type AuditSettings, type AuditAsset } from '../../shared/audit'
import { type RecordRef } from '../../shared/federation'
import { ENGINE_VERSION } from '../../shared/analysis/types'
import { taxonomyKey } from '../../shared/taxonomy'
export const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
let database: Pool | undefined, currentSettings: AuditSettings | undefined
const ddl = [
  `CREATE TABLE IF NOT EXISTS qc_meta (id INT PRIMARY KEY, version INT NOT NULL) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS qc_entities (id CHAR(36) PRIMARY KEY, identity_key VARCHAR(64) UNIQUE NULL, formula VARCHAR(255) NULL, created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS qc_members (connection_id VARCHAR(64) NOT NULL, record_key VARCHAR(191) NOT NULL, entity_id CHAR(36) NOT NULL, manual_identity BOOLEAN NOT NULL DEFAULT 0, identity_issue VARCHAR(255) NULL, fingerprint CHAR(64) NOT NULL, scan_id CHAR(36) NOT NULL, present BOOLEAN NOT NULL DEFAULT 1, name_text TEXT, sources JSON NOT NULL, class_ids JSON NOT NULL, data JSON NOT NULL, in_trash BOOLEAN NOT NULL DEFAULT 0, favorite BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY(connection_id,record_key), INDEX(entity_id), INDEX(connection_id,present)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS qc_assets (id CHAR(64) PRIMARY KEY, connection_id VARCHAR(64) NOT NULL, record_key VARCHAR(191) NOT NULL, kind VARCHAR(32) NOT NULL, sources JSON NOT NULL, data JSON NOT NULL, fingerprint CHAR(64) NOT NULL, scan_id CHAR(36) NOT NULL, present BOOLEAN NOT NULL DEFAULT 1, current_check CHAR(64) NULL, updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX(connection_id,record_key,present)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS qc_checks (id CHAR(64) PRIMARY KEY, asset_id CHAR(64) NOT NULL, fingerprint CHAR(64) NOT NULL, engine_version VARCHAR(32) NOT NULL, rule_version VARCHAR(255) NOT NULL, data JSON NOT NULL, evidence JSON NOT NULL, abnormal BOOLEAN NOT NULL, incomplete BOOLEAN NOT NULL, revision INT NOT NULL DEFAULT 1, created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6), INDEX(asset_id,created_at)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS qc_reviews (id CHAR(36) PRIMARY KEY, check_id CHAR(64) NOT NULL, action VARCHAR(32) NOT NULL, reviewer VARCHAR(100) NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6), INDEX(check_id,created_at)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS qc_scans (id CHAR(36) PRIMARY KEY, connection_id VARCHAR(64) NOT NULL, state VARCHAR(32) NOT NULL, progress INT NOT NULL DEFAULT 0, detail JSON NULL, created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6), updated_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX(connection_id,created_at)) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS qc_merges (id CHAR(36) PRIMARY KEY, operation VARCHAR(32) NOT NULL, before_data JSON NOT NULL, reviewer VARCHAR(100) NOT NULL, reason TEXT NOT NULL, undone BOOLEAN NOT NULL DEFAULT 0, created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB`
]
export async function openRepository(settings: AuditSettings): Promise<void> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(settings.database))
    throw new Error('审核库名只能包含字母、数字和下划线')
  if (
    connections().some(
      (x) =>
        x.host === connection(settings.connectionId).host &&
        x.port === connection(settings.connectionId).port &&
        x.database === settings.database
    )
  )
    throw new Error('审核库必须独立于来源数据库，不能使用同名来源库')
  const config = await credentials(connection(settings.connectionId))
  const candidate = createPool({
    ...config,
    database: undefined,
    connectionLimit: 2,
    connectTimeout: 6000,
    charset: 'utf8mb4',
    decimalNumbers: true
  })
  try {
    await candidate.query(
      `CREATE DATABASE IF NOT EXISTS \`${settings.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    )
    const next = createPool({
      ...config,
      database: settings.database,
      connectionLimit: 3,
      connectTimeout: 6000,
      charset: 'utf8mb4',
      decimalNumbers: true
    })
    try {
      const [tables] = await next.query<any[]>(
        'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
        [settings.database]
      )
      const permitted = new Set(ddl.map((x) => /EXISTS (\w+)/.exec(x)![1]))
      if (tables.some((x) => !permitted.has(x.TABLE_NAME)))
        throw new Error('指定审核库含有其他业务表，拒绝在其中初始化')
      for (const statement of ddl) await next.query(statement)
      await next.query('INSERT IGNORE INTO qc_meta VALUES(1,1)')
      const [version] = await next.query<any[]>('SELECT version FROM qc_meta WHERE id=1')
      if (Number(version[0]?.version) !== 1) throw new Error('审核库版本不支持')
      const previous = database
      database = next
      currentSettings = settings
      await previous?.end()
    } catch (error) {
      await next.end()
      throw error
    }
  } finally {
    await candidate.end()
  }
}
export function ready(): boolean {
  return !!database
}
export function settings(): AuditSettings | undefined {
  return currentSettings
}
export async function closeRepository(): Promise<void> {
  const old = database
  database = undefined
  try{await old?.end()}catch(error){console.warn('检查连接已清理，服务器连接已失效',String(error))}
}
export async function sql(text: string, params: any[] = [], tx?: PoolConnection): Promise<any[]> {
  if (!database) throw new Error('审核库尚未就绪，请到数据库管理配置自动检查')
  const [result] = await (tx ?? database).query(text, params)
  return result as any[]
}
export async function transaction<T>(fn: (tx: PoolConnection) => Promise<T>): Promise<T> {
  if (!database) throw new Error('审核库尚未就绪')
  const tx = await database.getConnection()
  try {
    await tx.beginTransaction()
    const result = await fn(tx)
    await tx.commit()
    return result
  } catch (error) {
    await tx.rollback()
    throw error
  } finally {
    tx.release()
  }
}
export async function saveMember(row: any, classes: number[], scan: string): Promise<void> {
  await transaction(async (tx) => {
    const ref = row.ref as RecordRef,
      previous = (
        await sql(
          'SELECT * FROM qc_members WHERE connection_id=? AND record_key=? FOR UPDATE',
          [ref.connectionId, ref.key],
          tx
        )
      )[0]
    let entity = previous?.entity_id,
      issue: string | null = null
    const identity = identityKey(row)
    if (previous && !previous.manual_identity) {
      const oldIdentity = (
        await sql('SELECT identity_key FROM qc_entities WHERE id=?', [entity], tx)
      )[0]?.identity_key
      if (oldIdentity && oldIdentity !== identity) {
        entity = undefined
        issue = '来源身份变化，已隔离并等待确认'
      }
      if (!oldIdentity && identity) entity = undefined
    }
    if (!entity && identity && !issue) {
      const target = (
        await sql('SELECT * FROM qc_entities WHERE identity_key=? FOR UPDATE', [identity], tx)
      )[0]
      if (target && target.formula && row.formula && target.formula !== row.formula)
        issue = '结构标识相同但分子式冲突，未自动关联'
      else if (target) entity = target.id
    }
    if (!entity) {
      entity = randomUUID()
      await sql(
        'INSERT INTO qc_entities(id,identity_key,formula) VALUES(?,?,?)',
        [entity, issue ? null : (identity ?? null), row.formula ?? null],
        tx
      )
    }
    if (previous && !previous.manual_identity) {
      const current = (
        await sql('SELECT identity_key FROM qc_entities WHERE id=?', [entity], tx)
      )[0]
      if (current?.identity_key && identity && current.identity_key !== identity)
        issue = '来源化合物身份发生变化，需确认关联'
    }
    const labels = [...new Set(classes)]
    await sql(
      `INSERT INTO qc_members(connection_id,record_key,entity_id,identity_issue,fingerprint,scan_id,present,name_text,sources,class_ids,data,in_trash,favorite) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE entity_id=VALUES(entity_id),identity_issue=VALUES(identity_issue),fingerprint=VALUES(fingerprint),scan_id=VALUES(scan_id),present=1,name_text=VALUES(name_text),sources=VALUES(sources),class_ids=VALUES(class_ids),data=VALUES(data),in_trash=VALUES(in_trash),favorite=VALUES(favorite)`,
      [
        ref.connectionId,
        ref.key,
        entity,
        issue,
        hash(row),
        scan,
        [
          row.main_name,
          row.name_zh,
          row.name_en,
          row.cas,
          row.formula,
          ...(row.name ?? []).map((x) => x.name)
        ]
          .filter(Boolean)
          .join('\n'),
        JSON.stringify(row.sources ?? []),
        JSON.stringify(labels),
        JSON.stringify(row),
        !!row.is_in_trash || !!row.is_delete,
        !!row.is_favorite
      ],
      tx
    )
  })
}
export async function saveAssets(
  ref: RecordRef,
  assets: AuditAsset[],
  scan: string
): Promise<AuditAsset[]> {
  const changed: AuditAsset[] = []
  for (const asset of assets) {
    const old = (
      await sql('SELECT fingerprint,current_check FROM qc_assets WHERE id=?', [asset.id])
    )[0]
    const expected = hash([asset.id, asset.fingerprint, ENGINE_VERSION])
    await sql(
      `INSERT INTO qc_assets(id,connection_id,record_key,kind,sources,data,fingerprint,scan_id,present) VALUES(?,?,?,?,?,?,?,?,1) ON DUPLICATE KEY UPDATE kind=VALUES(kind),sources=VALUES(sources),data=IF(fingerprint=VALUES(fingerprint),data,VALUES(data)),fingerprint=VALUES(fingerprint),scan_id=VALUES(scan_id),present=1`,
      [
        asset.id,
        ref.connectionId,
        ref.key,
        asset.kind,
        JSON.stringify(asset.sources),
        JSON.stringify(asset),
        asset.fingerprint,
        scan
      ]
    )
    if (
      asset.kind !== 'spectrum' &&
      !asset.linkedResult &&
      asset.checks.length > 0 &&
      old?.current_check !== expected
    )
      changed.push(asset)
  }
  // This member's assets were read as one consistent source snapshot.
  await sql(
    'UPDATE qc_assets SET present=0 WHERE connection_id=? AND record_key=? AND scan_id<>?',
    [ref.connectionId, ref.key, scan]
  )
  return changed
}
export async function saveCheck(asset: AuditAsset, result: any): Promise<void> {
  if (!result) return
  const id = hash([asset.id, asset.fingerprint, ENGINE_VERSION])
  await transaction(async (tx) => {
    const current = (
      await sql(
        'SELECT fingerprint FROM qc_assets WHERE id=? AND present=1 FOR UPDATE',
        [asset.id],
        tx
      )
    )[0]
    if (current?.fingerprint !== asset.fingerprint) return
    await sql(
      'INSERT IGNORE INTO qc_checks(id,asset_id,fingerprint,engine_version,rule_version,data,evidence,abnormal,incomplete) VALUES(?,?,?,?,?,?,?,?,?)',
      [
        id,
        asset.id,
        asset.fingerprint,
        ENGINE_VERSION,
        asset.ruleVersion,
        JSON.stringify(result),
        JSON.stringify(asset),
        result.abnormal,
        result.incomplete
      ],
      tx
    )
    await sql('UPDATE qc_assets SET current_check=? WHERE id=?', [id, asset.id], tx)
  })
}
export async function reviewCheck(id: string, revision: number, review: any): Promise<void> {
  if (
    !['reviewed', 'retest', 'exclude'].includes(review.action) ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim() ||
    review.reviewer.length > 100 ||
    typeof review.reason !== 'string' ||
    !review.reason.trim() ||
    review.reason.length > 2000
  )
    throw new Error('请填写有效的复核操作、复核人及理由')
  await transaction(async (tx) => {
    const row = (await sql('SELECT revision FROM qc_checks WHERE id=? FOR UPDATE', [id], tx))[0]
    if (!row || row.revision !== revision) throw new Error('检查记录已更新，请刷新后重新复核')
    await sql(
      'INSERT INTO qc_reviews(id,check_id,action,reviewer,reason) VALUES(?,?,?,?,?)',
      [randomUUID(), id, review.action, review.reviewer.trim(), review.reason.trim()],
      tx
    )
    await sql('UPDATE qc_checks SET revision=revision+1 WHERE id=?', [id], tx)
  })
}
export async function mergeMembers(
  refs: RecordRef[],
  reviewer: string,
  reason: string
): Promise<string> {
  if (
    !Array.isArray(refs) ||
    refs.length < 2 ||
    refs.length > 100 ||
    !reviewer?.trim() ||
    !reason?.trim() ||
    reviewer.length > 100 ||
    reason.length > 2000
  )
    throw new Error('请选择2—100条记录，填写确认人及关联理由')
  return transaction(async (tx) => {
    const before: any[] = []
    for (const ref of refs) {
      const member = (
        await sql(
          'SELECT connection_id,record_key,entity_id,manual_identity FROM qc_members WHERE connection_id=? AND record_key=? AND present=1 FOR UPDATE',
          [ref.connectionId, ref.key],
          tx
        )
      )[0]
      if (!member) throw new Error('记录尚未完成索引或已失效')
      before.push(member)
    }
    const ids = [...new Set(before.map((x) => x.entity_id))]
    const all = await sql(
      `SELECT connection_id,record_key,entity_id,manual_identity FROM qc_members WHERE entity_id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`,
      ids,
      tx
    )
    const entity = before[0].entity_id,
      event = randomUUID()
    await sql(
      `UPDATE qc_members SET entity_id=?,manual_identity=1 WHERE entity_id IN (${ids.map(() => '?').join(',')})`,
      [entity, ...ids],
      tx
    )
    await sql(
      'INSERT INTO qc_merges(id,operation,before_data,reviewer,reason) VALUES(?,?,?,?,?)',
      [
        event,
        'merge',
        JSON.stringify({ target: entity, members: all }),
        reviewer.trim(),
        reason.trim()
      ],
      tx
    )
    return event
  })
}
export async function undoMerge(event: string): Promise<void> {
  await transaction(async (tx) => {
    const row = (await sql('SELECT * FROM qc_merges WHERE id=? FOR UPDATE', [event], tx))[0]
    if (!row || row.undone) throw new Error('关联操作不存在或已撤销')
    const before = objectValue(row.before_data)
    const members = await sql(
      'SELECT connection_id,record_key FROM qc_members WHERE entity_id=? FOR UPDATE',
      [before.target],
      tx
    )
    if (
      members.length !== before.members.length ||
      members.some(
        (x) =>
          !before.members.some(
            (y) => x.connection_id === y.connection_id && x.record_key === y.record_key
          )
      )
    )
      throw new Error('关联后成员已经变化，不能直接撤销，请先核对后续操作')
    for (const member of before.members)
      await sql(
        'UPDATE qc_members SET entity_id=?,manual_identity=1 WHERE connection_id=? AND record_key=?',
        [member.entity_id, member.connection_id, member.record_key],
        tx
      )
    await sql('UPDATE qc_merges SET undone=1 WHERE id=?', [event], tx)
  })
}
export function classIds(catalog: any[], selected: any[], legacy: any[]): number[] {
  const result = legacy.map((x) => x.id)
  const byCode = new Map(catalog.map((x) => [taxonomyKey(x.namespace, x.category_code), x]))
  for (const item of selected) {
    let node = byCode.get(taxonomyKey(item.namespace, item.category_code)),
      count = 0
    while (node && count++ < 100) {
      result.push(registryCategoryId(taxonomyKey(node.namespace, node.category_code)))
      node = node.parent_code
        ? byCode.get(taxonomyKey(node.namespace, node.parent_code))
        : undefined
    }
  }
  return [...new Set(result)]
}
