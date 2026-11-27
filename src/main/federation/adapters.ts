import {ionFlags,ionModePredicate} from '../../shared/ionMode.mjs'
import { classificationWhere } from '../../shared/classification.mjs'
import { taxonomyKey, descendantCodes } from '../../shared/taxonomy'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { connection, query, getState, localFavorite, registryCategoryId } from './registry'
import {
  sqlIdentifier,
  sourceKey,
  sourceMatches,
  refKey,
  type ConnectionDefinition,
  type UnifiedFilters,
  type RecordRef,
  type SourceChoice
} from '../../shared/federation'

import { compoundFilterSql } from '../services/compoundList'
import { methodLabel } from '../../shared/scientificDisplay'
export interface SourceEntry extends SourceChoice {
  localKey: string
}
const columns = new Map<string, Map<string, Set<string>>>()
export function forgetColumns(id: string): void {
  columns.delete(id)
}
export async function schema(entry: ConnectionDefinition): Promise<Map<string, Set<string>>> {
  let map = columns.get(entry.id)
  if (!map) {
    const rows = await query(
      entry,
      'SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?',
      [entry.database]
    )
    map = new Map()
    for (const row of rows) {
      const set = map.get(row.TABLE_NAME) ?? new Set<string>()
      set.add(row.COLUMN_NAME)
      map.set(row.TABLE_NAME, set)
    }
    columns.set(entry.id, map)
  }
  return map
}
export async function inspect(entry: ConnectionDefinition): Promise<any> {
  const tables = await schema(entry)
  if (entry.adapter === 'native') {
    const rows = await query(
      entry,
      'SELECT product,schema_version,state FROM app_metadata WHERE id=1'
    )
    const metadata = rows[0]
    if (
      !metadata ||
      metadata.product !== 'MasspecLib2' ||
      metadata.state !== 'ready' ||
      ![2, 3, 4].includes(Number(metadata.schema_version))
    )
      throw new Error('不是受支持的已初始化 MasspecLib2 数据库')
    return {
      ok: true,
      schemaVersion: Number(metadata.schema_version),
      needsUpgrade: Number(metadata.schema_version) < 4,
      capabilities: ['基础信息', '来源', '质谱', '液相', '谱图'],
      writable: entry.writable && Number(metadata.schema_version) === 4
    }
  }
  if (entry.adapter === 'legacy') {
    for (const table of ['compounds', 'ms_methods', 'lc_methods', 'lc_methods_items'])
      if (!tables.has(table)) throw new Error(`旧库缺少 ${table}；请使用自定义映射或提供真实表结构`)
    if (!tables.get('compounds')?.has('id')) throw new Error('旧库缺少稳定记录键')
    return {
      ok: true,
      capabilities: ['基础信息', '旧质谱方法', '旧液相方法'],
      writable: false,
      notice: '旧库未声明来源时保持来源未提供；不以数据库名称代替'
    }
  }
  const mapping = entry.mapping!
  const available = tables.get(mapping.table)
  if (!available) throw new Error('映射表不存在')
  for (const field of [mapping.key, ...Object.values(mapping.fields)])
    if (!available.has(field)) throw new Error(`映射字段不存在：${field}`)
  const rows = await query(
    entry,
    `SELECT ${sqlIdentifier(mapping.key)} AS record_key, COUNT(*) AS n FROM ${sqlIdentifier(mapping.table)} GROUP BY ${sqlIdentifier(mapping.key)} HAVING record_key IS NULL OR COUNT(*)>1 LIMIT 1`
  )
  if (rows.length) throw new Error('映射记录键存在空值或重复，不能稳定定位记录')
  return {
    ok: true,
    capabilities: ['映射的基础字段', ...(mapping.fields.source_name ? ['来源'] : [])],
    writable: false,
    notice: '自定义映射为基础字段只读适配；复杂质谱、液相关联须专用适配器'
  }
}
export async function sources(
  entry: ConnectionDefinition,
  options: { text?: string; limit?: number } = {}
): Promise<SourceEntry[]> {
  const keyword = (options.text ?? '').trim().toLocaleLowerCase(),
    limit = options.limit
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000))
    throw new Error('来源分页范围无效')
  const order = keyword
    ? ' ORDER BY CASE WHEN LOWER(name)=? THEN 0 WHEN LOCATE(?,LOWER(name))=1 THEN 1 ELSE 2 END,BINARY name,namespace,provider'
    : ' ORDER BY BINARY name,namespace,provider'
  const arguments_ = keyword ? [keyword, keyword, keyword] : []
  if (entry.adapter === 'native') {
    const available = (await schema(entry)).get('spectral_libraries')!
    const rows = await query(
      entry,
      `SELECT id,namespace,name,provider,location,${available.has('source_type') ? 'source_type' : "'unknown' AS source_type"} FROM spectral_libraries WHERE namespace NOT LIKE 'database-record:%'${keyword ? ' AND LOCATE(?, LOWER(name))>0' : ''}${order}${limit ? ' LIMIT ' + limit : ''}`,
      arguments_
    )
    return rows.map((x) => ({
      id: sourceKey(x.namespace, x.name, x.provider, x.source_type ?? 'unknown', x.location),
      localKey: String(x.id),
      name: x.name,
      sourceType: x.source_type,
      provider: x.provider,
      location: x.location,
      connectionName: entry.name
    }))
  }
  if (entry.adapter === 'mapped' && entry.mapping?.fields.source_name) {
    const f = entry.mapping.fields
    const rows = await query(
      entry,
      `SELECT * FROM (SELECT DISTINCT ${sqlIdentifier(f.source_name)} AS name,${f.source_provider ? sqlIdentifier(f.source_provider) : 'NULL'} AS provider,${f.source_location ? sqlIdentifier(f.source_location) : 'NULL'} AS location FROM ${sqlIdentifier(entry.mapping.table)} WHERE ${sqlIdentifier(f.source_name)} IS NOT NULL) source_rows${keyword ? ' WHERE LOCATE(?,LOWER(name))>0' : ''} ${keyword ? 'ORDER BY CASE WHEN LOWER(name)=? THEN 0 WHEN LOCATE(?,LOWER(name))=1 THEN 1 ELSE 2 END,' : 'ORDER BY'} BINARY name,provider${limit ? ' LIMIT ' + limit : ''}`,
      arguments_
    )
    return rows.map((x) => ({
      id: sourceKey(
        'mapped:' + entry.id,
        x.name,
        x.provider,
        entry.mapping?.sourceType ?? 'unknown',
        x.location
      ),
      localKey: x.name,
      name: x.name,
      sourceType: entry.mapping?.sourceType ?? 'unknown',
      provider: x.provider,
      location: x.location,
      connectionName: entry.name
    }))
  }
  return []
}
function namesWhere(
  entry: ConnectionDefinition,
  filters: UnifiedFilters,
  available: Set<string>
): { where: string; params: any[] } {
  const params: any[] = []
  const clauses: string[] = []
  if (available.has('is_delete')) clauses.push('COALESCE(c.is_delete,0)=0')
  if (available.has('is_in_trash'))
    clauses.push(`COALESCE(c.is_in_trash,0)=${filters.trashOnly ? 1 : 0}`)
  else if (filters.trashOnly) clauses.push('1=0')
  const mapping = entry.adapter === 'mapped' ? entry.mapping!.fields : {}
  if (filters.identityStatus) {
    if (!['structure_consistent','identity_conflict','unresolved','source_parameters_unverified','reference_only_no_spectrum'].includes(filters.identityStatus)) throw new Error('身份状态筛选无效')
    if (entry.adapter !== 'native' || !available.has('properties')) clauses.push('1=0')
    else { clauses.push("JSON_UNQUOTE(JSON_EXTRACT(c.properties,'$.identity_status'))=?"); params.push(filters.identityStatus) }
  }
  const keyword = String(filters.keyword ?? '').trim()
  if (keyword) {
    const fields =
      entry.adapter === 'mapped'
        ? ['main_name', 'name_zh', 'name_en', 'cas', 'formula']
            .map((k) => mapping[k])
            .filter(Boolean)
        : ['main_name', 'name_zh', 'name_en', 'cas', 'formula'].filter((k) => available.has(k))
    const matches = fields.map((field) => {
      params.push('%' + keyword + '%')
      return `c.${sqlIdentifier(field)} LIKE ?`
    })
    if (entry.adapter !== 'mapped' && available.has('name')) {
      matches.push('CAST(c.name AS CHAR) LIKE ?')
      params.push('%' + keyword + '%')
    }
    clauses.push('(' + (matches.join(' OR ') || '1=0') + ')')
  }
  return { where: 'WHERE ' + (clauses.join(' AND ') || '1=1'), params }
}
export async function filter(
  entry: ConnectionDefinition,
  filters: UnifiedFilters
): Promise<{ from: string; where: string; params: any[] }> {
  const tables = await schema(entry)
  if (
    entry.adapter === 'mapped' &&
    (filters.polarity !== undefined || filters.adduct || filters.spectrumKind)
  )
    throw new Error('基础映射库不支持极性、加合及谱图筛选；请提供专用关系适配器')
  let result: { from: string; where: string; params: any[] }
  if (entry.adapter === 'native') {
    const native = compoundFilterSql({
      ...filters,
      keyword: undefined,
      favoriteOnly: false,
      trashOnly: filters.trashOnly,
      classId: undefined
    })
    result = { from: native.from, where: native.where, params: native.parameters }
    const named = namesWhere(entry, filters, tables.get('compounds')!)
    result.where += ' AND (' + named.where.slice(6) + ')'
    result.params.push(...named.params)
  } else {
    const table = entry.adapter === 'mapped' ? entry.mapping!.table : 'compounds'
    result = {
      from: `FROM ${sqlIdentifier(table)} c`,
      ...namesWhere(entry, filters, tables.get(table)!),
      params: []
    }
    const named = namesWhere(entry, filters, tables.get(table)!)
    result.where = named.where
    result.params = named.params
    if (
      entry.adapter === 'legacy' &&
      (filters.polarity !== undefined || filters.adduct || filters.spectrumKind)
    ) {
      if (filters.adduct || filters.spectrumKind)
        throw new Error('旧库没有独立加合／谱图形式索引，无法保证此筛选；请使用专用适配器')
      const p = filters.polarity
      result.where += ' AND '+ionModePredicate(p,'EXISTS(SELECT 1 FROM ms_methods m WHERE m.compounds_id=c.id AND m.polarity=1)','EXISTS(SELECT 1 FROM ms_methods m WHERE m.compounds_id=c.id AND m.polarity=0)')
    }
  }
  if (filters.classificationPlan) {
    if (entry.adapter !== 'native') throw new Error('本地分类关联暂仅支持标准数据库')
    const part = classificationWhere(filters.classificationPlan)
    result.where += ' AND (' + part.where + ')'
    result.params.push(...part.params)
  }
  const key = entry.adapter === 'mapped' ? entry.mapping!.key : 'id'
  let allowed: string[] | undefined
  if (filters.favoriteOnly) {
    const fav = getState()
      .favorites.map((x) => JSON.parse(x))
      .filter((x) => x[0] === entry.id)
      .map((x) => x[1])
    const excluded = (getState().excludedFavorites ?? [])
      .map((x) => JSON.parse(x))
      .filter((x) => x[0] === entry.id)
      .map((x) => x[1])
    const fields = entry.adapter === 'mapped' ? new Set<string>() : tables.get('compounds')!
    const clauses: string[] = []
    if (fields.has('is_favorite')) {
      clauses.push(
        'COALESCE(c.is_favorite,0)=1' +
          (excluded.length ? ' AND c.id NOT IN (' + excluded.map(() => '?').join(',') + ')' : '')
      )
      result.params.push(...excluded)
    }
    if (fav.length) {
      clauses.push(
        'c.' +
          sqlIdentifier(entry.adapter === 'mapped' ? entry.mapping!.key : 'id') +
          ' IN (' +
          fav.map(() => '?').join(',') +
          ')'
      )
      result.params.push(...fav)
    }
    result.where += ' AND (' + (clauses.map((x) => '(' + x + ')').join(' OR ') || 'FALSE') + ')'
  }
  if (Number(filters.classId) > 0 && Number(filters.classId) < 1000000000) {
    const group = getState().groups.find((x) => x.id === Number(filters.classId))
    const grouped =
      group?.refs
        .map((x) => JSON.parse(x))
        .filter((x) => x[0] === entry.id)
        .map((x) => x[1]) ?? []
    allowed = allowed ? allowed.filter((x) => grouped.includes(x)) : grouped
  }
  if (Number(filters.classId) >= 1000000000) {
    if (entry.adapter === 'mapped' || !tables.has('classes')) result.where += ' AND 1=0'
    else {
      let matched = false
      if (tables.has('taxonomy_categories')) {
        const catalog = await query(entry, 'SELECT * FROM taxonomy_categories')
        for (const category of catalog) {
          if (registryCategoryId(taxonomyKey(category.namespace, category.category_code)) !== Number(filters.classId)) continue
          const codes = descendantCodes(catalog, category.namespace, category.category_code)
          const ids = catalog.filter(x => x.namespace === category.namespace && codes.has(x.category_code)).map(x => x.id)
          result.where += ` AND EXISTS(SELECT 1 FROM compound_taxonomy ct WHERE ct.compound_id=c.id AND ct.category_id IN (${ids.map(() => '?').join(',')}))`
          result.params.push(...ids); matched = true; break
        }
      }
      if (!matched) {
        const cats = await query(entry, 'SELECT id FROM classes')
        const match = cats.find(x => categoryId(entry.id, String(x.id)) === Number(filters.classId))
        if (match) {
          result.where += ' AND EXISTS(SELECT 1 FROM compound_class cc WHERE cc.compound_id=c.id AND cc.class_id=?)'
          result.params.push(match.id)
        } else result.where += ' AND 1=0'
      }
    }
  }
  if (allowed) {
    result.where += allowed.length
      ? ` AND c.${sqlIdentifier(key)} IN (${allowed.map(() => '?').join(',')})`
      : ' AND 1=0'
    result.params.push(...allowed)
  }
  if (filters.sourceIds?.length || filters.sourceQuery?.trim()) {
    const matching = (
      await sources(entry, { text: filters.sourceIds?.length ? undefined : filters.sourceQuery })
    ).filter((x) => sourceMatches(x, filters.sourceQuery ?? '', filters.sourceIds ?? []))
    if (!matching.length) result.where += ' AND 1=0'
    else if (entry.adapter === 'native') {
      result.where += ` AND EXISTS (SELECT 1 FROM entity_sources es JOIN source_records sr ON sr.id=es.source_record_id WHERE sr.library_id IN (${matching.map(() => '?').join(',')}) AND ((es.entity_type='compound' AND es.entity_id=c.id) OR (es.entity_type='spectrum' AND EXISTS(SELECT 1 FROM spectra sp WHERE sp.id=es.entity_id AND sp.compound_id=c.id)) OR (es.entity_type='ms_method' AND EXISTS(SELECT 1 FROM ms_methods mm WHERE mm.id=es.entity_id AND mm.compounds_id=c.id)) OR (es.entity_type='lc_method' AND EXISTS(SELECT 1 FROM lc_methods lm WHERE lm.id=es.entity_id AND lm.compounds_id=c.id))))`
      result.params.push(...matching.map((x) => x.localKey))
    } else if (entry.adapter === 'mapped') {
      result.where +=
        ' AND (' +
        matching
          .map(
            () =>
              `(c.${sqlIdentifier(entry.mapping!.fields.source_name)}=?${entry.mapping!.fields.source_provider ? ' AND c.' + sqlIdentifier(entry.mapping!.fields.source_provider) + ' <=> ?' : ''}${entry.mapping!.fields.source_location ? ' AND c.' + sqlIdentifier(entry.mapping!.fields.source_location) + ' <=> ?' : ''})`
          )
          .join(' OR ') +
        ')'
      for (const item of matching) {
        result.params.push(item.localKey)
        if (entry.mapping!.fields.source_provider) result.params.push(item.provider ?? null)
        if (entry.mapping!.fields.source_location) result.params.push(item.location ?? null)
      }
    }
  }
  return result
}
export async function count(entry: ConnectionDefinition, filters: UnifiedFilters): Promise<number> {
  const f = await filter(entry, filters)
  const rows = await query(entry, `SELECT COUNT(*) AS total ${f.from} ${f.where}`, f.params)
  return Number(rows[0].total)
}
function normalize(entry: ConnectionDefinition, row: any): any {
  if (entry.adapter === 'mapped') {
    const result: any = { id: row[entry.mapping!.key] }
    for (const [target, column] of Object.entries(entry.mapping!.fields))
      result[target] = row[column]
    row = result
  }
  for (const field of ['properties','identifiers']) if (typeof row[field] === 'string') row[field] = JSON.parse(row[field])
  const key = String(row.id)
  let names = row.name
  if (typeof names === 'string') {
    try {
      names = JSON.parse(names)
    } catch {
      names = [{ name: names, area: '' }]
    }
  }
  if (!Array.isArray(names)) names = []
  names = names.map((x) =>
    typeof x === 'string'
      ? { name: x, area: '' }
      : x && typeof x === 'object'
        ? { ...x, name: x.name ?? '' }
        : { name: '', area: '' }
  )
  return {
    ...row,
    id: Number.isSafeInteger(Number(key)) ? Number(key) : 0,
    name: names,
    main_name:
      row.main_name || row.name_zh || row.name_en || names[0]?.name || row.cas || '名称未提供',
    ref: { connectionId: entry.id, key },
    rowKey: refKey({ connectionId: entry.id, key }),
    connectionName: entry.name,
    readOnly: entry.adapter !== 'native' || !entry.writable,
    is_favorite: localFavorite(refKey({ connectionId: entry.id, key }), row.is_favorite),
    sources: [],
    schemaVersion: undefined
  }
}
export async function rows(
  entry: ConnectionDefinition,
  filters: UnifiedFilters,
  offset: number,
  limit: number
): Promise<any[]> {
  const f = await filter(entry, filters)
  const key = entry.adapter === 'mapped' ? entry.mapping!.key : 'id'
  let select = 'c.*'
  if (entry.adapter !== 'mapped') {
    const cols = (await schema(entry)).get('compounds')!
    select = [...cols]
      .filter((x) => x !== 'formula_diagram_base64')
      .map((x) => 'c.' + sqlIdentifier(x))
      .join(',')
  }
  const data = await query(
    entry,
    `SELECT ${select} ${f.from} ${f.where} ORDER BY c.${sqlIdentifier(key)} DESC LIMIT ? OFFSET ?`,
    [...f.params, limit, offset]
  )
  const result = data.map((row) => normalize(entry, row))
  if (entry.adapter !== 'mapped' && result.length) {
    const ids = result.map((x) => x.ref.key)
    const methods = await query(
      entry,
      `SELECT id,compounds_id,q1,q3,dp,ce,polarity FROM ms_methods WHERE compounds_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`,
      ids
    )
    const spectra=(await schema(entry)).has('spectra')?await query(entry,`SELECT DISTINCT compound_id,polarity FROM spectra WHERE compound_id IN (${ids.map(()=>'?').join(',')})`,ids):[]
    for (const row of result) {
      row.ionModes=ionFlags([...methods.filter(m=>String(m.compounds_id)===row.ref.key),...spectra.filter(m=>String(m.compound_id)===row.ref.key)].map(m=>m.polarity))
      const linked = methods.filter((x) => String(x.compounds_id) === row.ref.key).slice(0, 2)
      for (const [i, m] of linked.entries())
        for (const field of ['q1', 'q3', 'dp', 'ce']) row[`mrm${i + 1}_${field}`] = m[field]
    }
  }
  if(entry.adapter==='native'&&result.length){
    const ids=result.map(r=>r.ref.key),slots=ids.map(()=>'?').join(',');const links=[{type:'compound',from:'compounds c',key:'c.id',owner:'c.id'},{type:'spectrum',from:'spectra c',key:'c.id',owner:'c.compound_id'},{type:'ms_method',from:'ms_methods c',key:'c.id',owner:'c.compounds_id'},{type:'lc_method',from:'lc_methods c',key:'c.id',owner:'c.compounds_id'}];
    const sql=links.map(x=>`SELECT ${x.owner} owner,l.*,sr.source_key,sr.batch_id,es.entity_type,es.entity_id FROM ${x.from} JOIN entity_sources es ON es.entity_type='${x.type}' AND es.entity_id=${x.key} JOIN source_records sr ON sr.id=es.source_record_id JOIN spectral_libraries l ON l.id=sr.library_id WHERE ${x.owner} IN (${slots})`).join(' UNION ALL ');const all=await query(entry,sql,links.flatMap(()=>ids));
    for(const row of result){let found=all.filter(x=>String(x.owner)===row.ref.key);if(found.some(x=>!String(x.namespace||'').startsWith('database-record:')))found=found.filter(x=>!String(x.namespace||'').startsWith('database-record:'));row.sources=[...new Map(found.map(({owner,...x})=>{void owner;return[JSON.stringify([x.id,x.source_key,x.entity_type,x.entity_id]),{...x,source_type:x.source_type??'unknown',appliesTo:x.entity_type}]})).values()]}
  }else for(const row of result)row.sources=await recordSources(entry,row.ref.key,row,false)
  return result
}
export async function recordSources(
  entry: ConnectionDefinition,
  key: string,
  row?: any,
  includeRaw = true
): Promise<any[]> {
  if (entry.adapter === 'native') {
    const result = await query(
      entry,
      `SELECT DISTINCT l.*,sr.source_key,sr.batch_id,es.entity_type,es.entity_id${includeRaw ? ',sr.raw' : ''} FROM entity_sources es JOIN source_records sr ON sr.id=es.source_record_id JOIN spectral_libraries l ON l.id=sr.library_id WHERE (es.entity_type='compound' AND es.entity_id=?) OR (es.entity_type='spectrum' AND es.entity_id IN(SELECT id FROM spectra WHERE compound_id=?)) OR (es.entity_type='ms_method' AND es.entity_id IN(SELECT id FROM ms_methods WHERE compounds_id=?)) OR (es.entity_type='lc_method' AND es.entity_id IN(SELECT id FROM lc_methods WHERE compounds_id=?))`,
      [key, key, key, key]
    )
    const visible = result.some((x) => !x.namespace.startsWith('database-record:'))
      ? result.filter((x) => !x.namespace.startsWith('database-record:'))
      : result
    return visible.map((x) => ({
      ...x,
      source_type: x.source_type ?? 'unknown',
      appliesTo: x.entity_type
    }))
  }
  if (entry.adapter === 'mapped' && row?.source_name)
    return [
      {
        name: row.source_name,
        source_type: entry.mapping?.sourceType ?? 'unknown',
        provider: row.source_provider,
        location: row.source_location,
        appliesTo: 'compound'
      }
    ]
  return []
}
export async function detail(ref: RecordRef): Promise<any> {
  const entry = connection(ref.connectionId)
  if (!entry.enabled) throw new Error('连接已停用')
  const status = await inspect(entry)
  const table = entry.adapter === 'mapped' ? entry.mapping!.table : 'compounds',
    key = entry.adapter === 'mapped' ? entry.mapping!.key : 'id'
  const data = await query(
    entry,
    `SELECT * FROM ${sqlIdentifier(table)} WHERE ${sqlIdentifier(key)}=? LIMIT 2`,
    [ref.key]
  )
  if (data.length !== 1) throw new Error('记录不存在或记录键不唯一')
  const compound = normalize(entry, data[0])
  delete compound.formula_diagram_base64
  compound.readOnly = !status.writable
  compound.schemaVersion = status.schemaVersion
  const sourceRows = await recordSources(entry, ref.key, compound)
  const extensions: any = {
    spectra: [],
    profiles: [],
    sources: sourceRows.map((x) => {
      const { raw, ...library } = x
      return {
        source_record: {
          source_key: x.source_key,
          batch_id: x.batch_id,
          raw: typeof raw === 'string' ? JSON.parse(raw) : raw,
          library
        },
        appliesTo: x.appliesTo,
        entityId: String(x.entity_id)
      }
    })
  }
  let methods: any[] = [],
    lcMethods: any[] = [],
    classes: any[] = []
  if (entry.adapter !== 'mapped') {
    methods = await query(entry, 'SELECT * FROM ms_methods WHERE compounds_id=? ORDER BY id', [
      ref.key
    ])
    lcMethods = await query(entry, 'SELECT * FROM lc_methods WHERE compounds_id=? ORDER BY id', [
      ref.key
    ])
    const available = await schema(entry)
    for (const m of lcMethods)
      m.methodsLinks = await query(
        entry,
        `SELECT * FROM lc_methods_items WHERE lc_methods_id=? ORDER BY ${available.get('lc_methods_items')?.has('step_order') ? 'step_order,' : ''} id`,
        [m.id]
      )
    if (available.has('compound_class') && available.has('classes'))
      classes = await query(
        entry,
        'SELECT cl.* FROM classes cl JOIN compound_class cc ON cc.class_id=cl.id WHERE cc.compound_id=?',
        [ref.key]
      )
    if (entry.adapter === 'native') {
      const spectra = await query(entry, 'SELECT * FROM spectra WHERE compound_id=? ORDER BY id', [
        ref.key
      ])
      for (const s of spectra) {
        for (const field of ['peaks', 'conditions', 'collision_energy', 'raw'])
          if (typeof s[field] === 'string') {
            try {
              s[field] = JSON.parse(s[field])
            } catch {
              throw new Error('谱图 JSON 无效')
            }
          }
        s.methodIds = (
          await query(entry, 'SELECT method_id FROM spectrum_method_links WHERE spectrum_id=?', [
            s.id
          ])
        ).map((x) => x.method_id)
      }
      extensions.spectra = spectra
      const profiles = await query(
        entry,
        'SELECT * FROM detection_profiles WHERE compound_id=? ORDER BY id',
        [ref.key]
      )
      for (const p of profiles) if (typeof p.data === 'string') p.data = JSON.parse(p.data)
      extensions.profiles = profiles
    }
  }
  for (const m of methods)
    if (typeof m.conditions === 'string') m.conditions = JSON.parse(m.conditions)
  for (const m of lcMethods) {
    if (typeof m.conditions === 'string') m.conditions = JSON.parse(m.conditions)
    for (const step of m.methodsLinks)
      if (typeof step.components === 'string') step.components = JSON.parse(step.components)
  }
  if ((await schema(entry)).has('taxonomy_categories')) {
    extensions.taxonomyCatalog = await query(entry, 'SELECT namespace,category_code,category_name,axis,parent_code,description,status FROM taxonomy_categories ORDER BY id')
    extensions.classifications = await query(entry, `SELECT tc.namespace,tc.category_code,ct.evidence FROM compound_taxonomy ct JOIN taxonomy_categories tc ON tc.id=ct.category_id WHERE ct.compound_id=?`, [ref.key])
    for (const item of extensions.classifications) if (typeof item.evidence === 'string') item.evidence = JSON.parse(item.evidence)
  }
  extensions.methodLabels = Object.fromEntries(
    methods.map((m) => [m.id, methodLabel(m, extensions.spectra)])
  )
  const modes = [...new Set(methods.map((x) => x.ms_mode ?? ''))]
  return {
    compound,
    methods: modes.map((ms_mode) => ({
      ms_mode,
      methods: methods.filter((x) => (x.ms_mode ?? '') === ms_mode)
    })),
    lcMethods,
    extensions,
    classes
  }
}

export function categoryId(connectionId: string, key: string): number {
  return registryCategoryId(refKey({ connectionId, key }))
}

export async function taxonomyCounts(entry: ConnectionDefinition, catalog: any[]): Promise<Map<string, number>> {
  const pairs: string[] = [], params: any[] = []
  for (const category of catalog) {
    const descendants = descendantCodes(catalog, category.namespace, category.category_code)
    for (const child of catalog.filter(x => x.namespace === category.namespace && descendants.has(x.category_code))) {
      pairs.push('SELECT ? AS node_key,? AS category_id'); params.push(taxonomyKey(category.namespace, category.category_code),child.id)
    }
  }
  if (!pairs.length) return new Map()
  const counts = await query(entry, `SELECT roots.node_key,COUNT(DISTINCT CASE WHEN COALESCE(c.is_delete,0)=0 AND COALESCE(c.is_in_trash,0)=0 THEN c.id END) AS total FROM (${pairs.join(' UNION ALL ')}) roots LEFT JOIN compound_taxonomy ct ON ct.category_id=roots.category_id LEFT JOIN compounds c ON c.id=ct.compound_id GROUP BY roots.node_key`, params)
  return new Map(counts.map(x => [x.node_key,Number(x.total)]))
}
