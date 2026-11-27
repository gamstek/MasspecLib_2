/* eslint-disable @typescript-eslint/no-explicit-any */
import { pool } from '../federation/registry'
import { schema, categoryId } from '../federation/adapters'
import {
  sqlIdentifier,
  sourceKey,
  type ConnectionDefinition,
  type SourceChoice
} from '../../shared/federation'
import {
  applicableChecks,
  normalizeAuditRow,
  objectValue,
  safeImage,
  type AuditAsset
} from '../../shared/audit'
import { hash, classIds } from './repository'
export function sourceChoice(entry: ConnectionDefinition, value: any): SourceChoice {
  return {
    id: sourceKey(
      value.namespace ?? 'mapped:' + entry.id,
      value.name,
      value.provider,
      value.source_type ?? value.sourceType ?? 'unknown',
      value.location
    ),
    name: value.name,
    sourceType: value.source_type ?? value.sourceType ?? 'unknown',
    provider: value.provider ?? undefined,
    location: value.location ?? undefined,
    connectionName: entry.name
  }
}
export async function readPage(
  entry: ConnectionDefinition,
  compounds: any[]
): Promise<{ row: any; classes: number[]; assets: AuditAsset[] }[]> {
  const available = await schema(entry),
    keys = compounds.map((x) => x.ref.key)
  if (!keys.length) return []
  const conn = await (await pool(entry)).getConnection()
  const select = async (text: string, args: any[] = []): Promise<any[]> => {
    const [data] = await conn.query(text, args)
    return data as any[]
  }
  try {
    await conn.beginTransaction()
    const placeholders = keys.map(() => '?').join(',')
    // Inspect size on the server before transferring numeric traces or images.
    // A large compound page is split by the scheduler; one oversized member is
    // reported as incomplete instead of loading an unbounded set into memory.
    const budgets: {
      table: string
      compoundKey: string
      columns: string[]
      status?: string
      completed?: string
    }[] = []
    if (available.has('experiment_results') && !entry.auditMapping)
      budgets.push({
        table: 'experiment_results',
        compoundKey: 'compound_id',
        columns: ['data'],
        status: 'status',
        completed: 'completed'
      })
    if (available.has('chromatogram_traces'))
      budgets.push({
        table: 'chromatogram_traces',
        compoundKey: 'compound_id',
        columns: ['points', 'data', 'image_base64'],
        status: 'status',
        completed: 'completed'
      })
    if (entry.auditMapping) {
      const m = entry.auditMapping
      budgets.push({
        table: m.table,
        compoundKey: m.compoundKey,
        columns: [...new Set(Object.values(m.fields))],
        status: m.fields.status,
        completed: m.completedValue
      })
    }
    let bytes = 0,
      records = 0
    for (const budget of budgets) {
      const lengths =
        budget.columns.map((col) => `COALESCE(OCTET_LENGTH(${sqlIdentifier(col)}),0)`).join('+') ||
        '0'
      const where = budget.status ? ` AND ${sqlIdentifier(budget.status)}=?` : ''
      const size = (
        await select(
          `SELECT COUNT(*) n,COALESCE(SUM(${lengths}),0) bytes FROM ${sqlIdentifier(budget.table)} WHERE ${sqlIdentifier(budget.compoundKey)} IN (${placeholders})${where}`,
          [...keys, ...(budget.status ? [budget.completed] : [])]
        )
      )[0]
      bytes += Number(size.bytes)
      records += Number(size.n)
    }
    if (bytes > 32 * 1024 * 1024 || records > 10000)
      throw Object.assign(
        new Error('当前化合物实验数据超过32MiB或10000条，请按检测批次建立视图并配置字段映射后检查'),
        { code: 'AUDIT_CAPACITY' }
      )
    const libraryRows = available.has('spectral_libraries')
      ? await select('SELECT * FROM spectral_libraries')
      : []
    const libraries = new Map(libraryRows.map((x) => [String(x.id), sourceChoice(entry, x)]))
    const evidence =
      entry.adapter === 'native'
        ? await select(
            `SELECT es.entity_type,es.entity_id,sr.library_id FROM entity_sources es JOIN source_records sr ON sr.id=es.source_record_id WHERE (es.entity_type='compound' AND es.entity_id IN (${placeholders})) OR (es.entity_type='spectrum' AND es.entity_id IN (SELECT id FROM spectra WHERE compound_id IN (${placeholders}))) OR (es.entity_type='experiment_result' AND es.entity_id IN (${placeholders}))`,
            [...keys, ...keys, ...keys]
          )
        : []
    const explicitSources = (type: string, id: any, library?: any): SourceChoice[] => {
      if (library != null) {
        const item = libraries.get(String(library))
        if (!item) throw new Error('数据声明的来源库不存在')
        return [item]
      }
      return [
        ...new Map(
          evidence
            .filter((x) => x.entity_type === type && String(x.entity_id) === String(id))
            .map((x) => libraries.get(String(x.library_id)))
            .filter(Boolean)
            .map((x) => [x!.id, x!])
        ).values()
      ]
    }
    const methods = available.has('ms_methods')
      ? await select(
          `SELECT compounds_id,polarity,${available.get('ms_methods')?.has('adduct') ? 'adduct' : 'NULL AS adduct'} FROM ms_methods WHERE compounds_id IN (${placeholders})`,
          keys
        )
      : []
    const spectra = available.has('spectra')
      ? await select(
          `SELECT id,compound_id,spectrum_type,kind,polarity FROM spectra WHERE compound_id IN (${placeholders})`,
          keys
        )
      : []
    const results =
      available.has('experiment_results') && !entry.auditMapping
        ? await select(
            `SELECT * FROM experiment_results WHERE compound_id IN (${placeholders}) AND status='completed'`,
            keys
          )
        : []
    const traces = available.has('chromatogram_traces')
      ? await select(
          `SELECT * FROM chromatogram_traces WHERE compound_id IN (${placeholders}) AND status='completed'`,
          keys
        )
      : []
    const rules = available.has('experiment_rules')
      ? await select('SELECT * FROM experiment_rules WHERE active=1')
      : []
    const catalog = available.has('taxonomy_categories')
      ? await select('SELECT * FROM taxonomy_categories')
      : []
    const taxonomy = available.has('compound_taxonomy')
      ? await select(
          `SELECT ct.compound_id,tc.namespace,tc.category_code FROM compound_taxonomy ct JOIN taxonomy_categories tc ON tc.id=ct.category_id WHERE compound_id IN (${placeholders})`,
          keys
        )
      : []
    const legacy = available.has('compound_class')
      ? await select(
          `SELECT compound_id,class_id FROM compound_class WHERE compound_id IN (${placeholders})`,
          keys
        )
      : []
    let mapped: any[] = []
    if (entry.auditMapping) {
      const m = entry.auditMapping,
        cols = available.get(m.table)
      for (const col of [m.key, m.compoundKey, ...Object.values(m.fields)])
        if (!cols?.has(col)) throw new Error('检测映射字段不存在：' + col)
      const where = m.fields.status ? ` AND ${sqlIdentifier(m.fields.status)}=?` : ''
      mapped = await select(
        `SELECT * FROM ${sqlIdentifier(m.table)} WHERE ${sqlIdentifier(m.compoundKey)} IN (${placeholders})${where}`,
        [...keys, ...(m.fields.status ? [m.completedValue] : [])]
      )
    }
    const output = compounds.map((compound) => {
      const ref = compound.ref,
        ownSources = (compound.sources ?? []).map((x) => sourceChoice(entry, x)),
        assets: AuditAsset[] = []
      const origin = (type: string, id: any, library?: any): SourceChoice[] => {
        const specific = explicitSources(type, id, library)
        return specific.length ? specific : ownSources.length === 1 ? ownSources : []
      }
      const push = (
        kind: AuditAsset['kind'],
        key: string,
        data: any,
        source: SourceChoice[],
        extra: Partial<AuditAsset> = {}
      ): void => {
        const recordKey = key,
          id = hash([entry.id, ref.key, kind, key]),
          asset: AuditAsset = {
            id,
            ref,
            recordKey,
            kind,
            sources: source,
            methodName: data.method_name || '方法未提供',
            ruleVersion: data.rule_version || '规则未提供',
            batchName: data.batch_name || '来源数据库',
            checks: [],
            fingerprint: '',
            ...extra
          }
        const image = safeImage(data.image_base64 ?? data.image)
        try {
          let value = objectValue(data.data) ?? {}
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('检测data必须为JSON对象')
          if (kind !== 'spectrum') {
            value = {
              ...value,
              id: key.length <= 100 ? key : id,
              compound: compound.main_name || compound.name_en || compound.name_zh || '未命名化合物'
            }
            if (image) asset.image = image
            const matching = rules.filter(
              (r) => r.method_name === asset.methodName && (!r.matrix || r.matrix === value.matrix)
            )
            if (matching.length === 1) {
              const defaults = objectValue(matching[0].data)
              if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults))
                throw new Error('规则内容必须是JSON对象')
              value = {
                ...defaults,
                ...value,
                peakRules: { ...defaults?.peakRules, ...value.peakRules }
              }
              asset.ruleVersion = matching[0].rule_version
            }
            if (matching.length > 1) asset.issue = '存在多条适用规则，请确认唯一规则'
            asset.row = normalizeAuditRow(value, compound.main_name || '未命名化合物')
            asset.checks = applicableChecks(asset.row, asset.image, value.checks)
          }
        } catch (error) {
          asset.issue = error instanceof Error ? error.message : String(error)
          asset.row = {
            id: key.length <= 100 ? key : id,
            sample: '来源记录',
            compound: compound.main_name || '未命名化合物'
          }
          asset.checks = kind === 'chromatogram' ? ['peak'] : ['peak', 'ratio', 'limit']
        }
        asset.fingerprint = hash({ ...asset, fingerprint: undefined })
        assets.push(asset)
      }
      for (const sp of spectra.filter((x) => String(x.compound_id) === ref.key))
        push('spectrum', 'spectra:' + sp.id, {}, origin('spectrum', sp.id), {
          metadata: { kind: sp.kind, spectrumType: sp.spectrum_type }
        })
      for (const item of results.filter((x) => String(x.compound_id) === ref.key)) {
        const rawData = objectValue(item.data)
        const data = {
          ...item,
          data:
            rawData && typeof rawData === 'object' && !Array.isArray(rawData)
              ? { ...rawData }
              : rawData
        }
        if (!data.data || typeof data.data !== 'object' || Array.isArray(data.data)) {
          push(
            'measurement',
            'experiment_results:' + item.id,
            { ...item, data: data.data ?? 'null' },
            origin('experiment_result', item.id, item.source_library_id)
          )
          continue
        }
        const linked = traces.filter(
          (t) =>
            String(t.experiment_result_id) === String(item.id) && String(t.compound_id) === ref.key
        )
        let issue: string | undefined
        const channels = new Set<string>()
        for (const trace of linked) {
          if (
            trace.source_library_id != null &&
            item.source_library_id != null &&
            String(trace.source_library_id) !== String(item.source_library_id)
          ) {
            issue = '关联色谱来源与测定来源不一致'
            continue
          }
          if (trace.method_name && item.method_name && trace.method_name !== item.method_name) {
            issue = '关联色谱方法与测定方法不一致'
            continue
          }
          const role = trace.channel_role || 'quantifier'
          if (channels.has(role)) {
            issue = '同一通道关联了多条曲线，需确认'
            continue
          }
          channels.add(role)
          const value = { timeUnit: trace.time_unit, points: objectValue(trace.points) }
          if (role === 'quantifier') data.data.trace = value
          else if (role === 'qualifier') data.data.qualifierTrace = value
          else {
            issue = '额外定性通道请在data.qualifiers中明确配置参考规则'
          }
        }
        push(
          'measurement',
          'experiment_results:' + item.id,
          data,
          origin('experiment_result', item.id, item.source_library_id)
        )
        if (issue) {
          assets[assets.length - 1].issue = issue
          assets[assets.length - 1].fingerprint = hash(assets[assets.length - 1])
        }
      }
      for (const trace of traces.filter((x) => String(x.compound_id) === ref.key)) {
        const linked =
          trace.experiment_result_id != null
            ? results.find(
                (x) =>
                  String(x.id) === String(trace.experiment_result_id) &&
                  String(x.compound_id) === ref.key
              )
            : undefined
        // A trace linked to an unfinished/missing result is not repurposed as a reference.
        if (trace.experiment_result_id != null && !linked) continue
        const value: any = { ...objectValue(trace.data) }
        if (trace.points != null)
          value.trace = { timeUnit: trace.time_unit, points: objectValue(trace.points) }
        push(
          'chromatogram',
          'chromatogram_traces:' + trace.id,
          { ...trace, data: value },
          origin('chromatogram', trace.id, trace.source_library_id),
          { linkedResult: linked ? 'experiment_results:' + linked.id : undefined }
        )
      }
      for (const item of mapped.filter(
        (x) => String(x[entry.auditMapping!.compoundKey]) === ref.key
      )) {
        const m = entry.auditMapping!,
          fields: any = {}
        for (const [k, v] of Object.entries(m.fields)) fields[k] = item[v]
        let value = fields.data != null ? objectValue(fields.data) : {}
        if (fields.data == null) {
          value = {
            sample: fields.sample,
            compound: fields.compound,
            matrix: fields.matrix,
            expectedRt: fields.expected_rt,
            rtWindow: fields.rt_window,
            trace: objectValue(fields.trace_json),
            qualifierTrace: objectValue(fields.qualifier_trace_json),
            peakRules: objectValue(fields.peak_rules_json)
          }
          if (fields.concentration != null || fields.modifier)
            value.measurement = {
              value: fields.concentration,
              unit: fields.unit,
              modifier: fields.modifier || 'value',
              loq: fields.loq
            }
          if (fields.limit != null)
            value.limit = {
              value: fields.limit,
              unit: fields.limit_unit,
              source: fields.limit_source
            }
          if (
            ['quantifier_area', 'qualifier_area', 'ratio_reference', 'ratio_tolerance_pct'].some(
              (k) => fields[k] != null
            )
          )
            value.ratio = {
              required: ![false, 0, '0', '否'].includes(fields.ratio_required),
              quantifierArea: fields.quantifier_area,
              qualifierArea: fields.qualifier_area,
              reference: fields.ratio_reference,
              tolerancePct: fields.ratio_tolerance_pct,
              referenceSource: fields.ratio_reference_source
            }
        }
        if (fields.checks != null) value.checks = objectValue(fields.checks)
        push(
          'measurement',
          m.table + ':' + item[m.key],
          { ...fields, data: value, image: fields.image },
          origin('experiment_result', item[m.key], fields.source_library_id)
        )
      }
      const allSources = [
        ...new Map(
          [...ownSources, ...assets.flatMap((x) => x.sources)].map((x) => [x.id, x])
        ).values()
      ]
      return {
        row: {
          ...compound,
          sources: allSources,
          polarities: [...methods.filter((x)=>String(x.compounds_id)===ref.key),...spectra.filter((x)=>String(x.compound_id)===ref.key)].map(x=>x.polarity),
          adducts: methods.filter((x) => String(x.compounds_id) === ref.key).map((x) => x.adduct)
        },
        classes: classIds(
          catalog,
          taxonomy.filter((x) => String(x.compound_id) === ref.key),
          legacy
            .filter((x) => String(x.compound_id) === ref.key)
            .map((x) => ({ id: categoryId(entry.id, String(x.class_id)) }))
        ),
        assets
      }
    })
    await conn.commit()
    return output
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}
