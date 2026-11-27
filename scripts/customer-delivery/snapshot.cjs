const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { fields, fail, text, normalizePolicy, pick, json, points, raster, hash } = require('./policy.cjs')
const { acquisitionFields, acquisitionView, lcFlowRate } = require('../../src/shared/acquisitionParameters.mjs')
const { projectClassification } = require('../../src/shared/deliveryClassification.mjs')
const { classificationPlan, classificationWhere } = require('../../src/shared/classification.mjs')
const ident = name => { if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail('数据库结构标识无效'); return '`' + name + '`' }
function clean(row, selected) {
  const out = pick(row, selected)
  if (selected.some(k => Object.hasOwn(acquisitionFields, k))) { const parameters = acquisitionView(row); for (const k of selected) if (Object.hasOwn(acquisitionFields, k)) out[k] = parameters[k] ?? null }
  for (const k of ['formula_diagram_base64', 'image_base64', 'mass_spectrum_base64']) if (Object.hasOwn(out, k)) out[k] = raster(row[k], row.image_mime)
  if (selected.includes('column_temperature_text')) { const conditions = json(row.conditions); const text = conditions?.column_temperature_text ?? (typeof conditions?.column_temperature_raw === 'string' && !Number.isFinite(Number(conditions.column_temperature_raw)) ? conditions.column_temperature_raw : null); out.column_temperature_text = typeof text === 'string' ? text.slice(0, 255) : null }
  if (selected.includes('retention_time_unit') && row.retention_time != null && !row.retention_time_unit) { out.retention_time_unit = 'min'; out.retention_time_unit_source = 'default' }
  if (selected.includes('peaks')) out.peaks = points(row.peaks, 'mz')
  if (selected.includes('points')) out.points = points(row.points, 'time')
  if (selected.includes('collision_energy')) {
    const v = json(row.collision_energy)
    out.collision_energy = v && typeof v === 'object' ? pick(v, ['value', 'unit', 'type', 'min', 'max']) : typeof v === 'number' ? v : null
  }
  return out
}
// Free-form raw/properties/conditions/import paths are intentionally never copied.
function measurement(value) { const v = json(value); return v && typeof v === 'object' ? pick(v, ['value', 'unit', 'modifier', 'loq']) : null }
function limit(value) { const v = json(value); return v && typeof v === 'object' ? pick(v, ['value', 'unit', 'source', 'matrix']) : null }
function ratio(value) { const v = json(value); return v && typeof v === 'object' ? pick(v, ['required', 'quantifierArea', 'qualifierArea', 'reference', 'tolerancePct', 'toleranceMode', 'toleranceAbsolute', 'referenceSource']) : null }
function retentionTimes(value, recordId, allowedMethods) {
  const conditions = json(value) || {}
  const rows = conditions.retention_times ?? (Array.isArray(conditions.retention_time_candidates_min) ? conditions.retention_time_candidates_min.map((value, i) => ({ value, unit: 'min', peak_label: `保留时间${i + 1}（峰归属待确认）` })) : undefined)
  if (rows == null) return []
  if (!Array.isArray(rows)) fail('原始库的多保留时间记录结构无效')
  return rows.map((r, i) => {
    if (!r || r.value === null || (typeof r.value === 'string' && !r.value.trim()) || !['number', 'string'].includes(typeof r.value) || !Number.isFinite(Number(r.value)) || Number(r.value) < 0 || !['s', 'min'].includes(r.unit || 'min') || (r.methodLocalIds != null && !Array.isArray(r.methodLocalIds))) fail('原始库的保留时间记录缺少有效数值或单位')
    return { id: hash(recordId + ':peak:' + i).slice(0, 24), value: Number(r.value), unit: r.unit || 'min', unit_source: !r.unit || r.unit_source === 'default' ? 'default' : 'explicit', peak_label: typeof r.peak_label === 'string' ? r.peak_label.slice(0, 255) : '', methodIds: [...new Set((r.methodLocalIds || []).map(String).filter(id => allowedMethods.has(Number(id))))].map(id => hash(recordId + ':ms:' + id).slice(0, 24)) }
  })
}
class SnapshotBuilder {
  constructor(connect, directory, engine) { this.connect = connect; this.directory = directory; this.engine = engine; fs.mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  async libraries() {
    const c = await this.connect()
    try { const [rows] = await c.query('SELECT id,database_name,title,schema_version,compound_count,published_at FROM mspec_lib2_catalog.libraries ORDER BY published_at,id'); return rows }
    finally { await c.end() }
  }
  async source(c, id) {
    const [rows] = await c.query('SELECT id,database_name,title,schema_version FROM mspec_lib2_catalog.libraries WHERE id=?', [id])
    if (rows.length !== 1 || !/^mspec_lib2_shared_[a-f0-9]{20}$/.test(rows[0].database_name) || Number(rows[0].schema_version) !== 4) fail('请选择已导入的结构4数据库')
    return rows[0]
  }
  selection(input) {
    const keyword = String(input.keyword ?? '').trim()
    if (keyword.length > 200) fail('筛选文字过长')
    const ids = input.compoundIds ?? []
    if (!Array.isArray(ids) || ids.length > 20000 || ids.some(x => !Number.isSafeInteger(Number(x)) || Number(x) < 1)) fail('化合物编号列表无效')
    if (input.onlySelected && !ids.length) fail('请先勾选化合物')
    const classes = input.classIds ?? []
    if (!Array.isArray(classes) || classes.length > 1000 || classes.some(x => !Number.isSafeInteger(Number(x)) || Number(x) < 1)) fail('分类选择无效')
    let where = 'COALESCE(c.is_delete,0)=0 AND COALESCE(c.is_in_trash,0)=0', params = []
    if (keyword) { where += ' AND (c.main_name LIKE ? OR c.name_zh LIKE ? OR c.name_en LIKE ? OR c.cas LIKE ? OR c.formula LIKE ?)'; params.push(...Array(5).fill('%' + keyword + '%')) }
    if (input.onlySelected) { where += ` AND c.id IN (${ids.map(() => '?').join(',')})`; params.push(...ids.map(Number)) }
    if (classes.length) { where += ` AND EXISTS(SELECT 1 FROM compound_class cc WHERE cc.compound_id=c.id AND cc.class_id IN (${classes.map(() => '?').join(',')}))`; params.push(...classes.map(Number)) }
    return { where, params }
  }
  async classifiedSelection(input, source, state) {
    const f = this.selection(input)
    if (input.categoryKey) {
      if (!this.classificationProvider) fail('分类服务尚未就绪')
      state ||= await this.classificationProvider.state()
      const library = state.libraries.find(l => l.database_name === source.database_name)
      if (!library) fail('数据库尚未登记到分类管理')
      const part = classificationWhere(classificationPlan(state, library, state.catalog, input.categoryKey))
      f.where += ' AND (' + part.where + ')'; f.params.push(...part.params)
    }
    return f
  }
  async candidates(input) {
    const c = await this.connect()
    try {
      const source = await this.source(c, input.libraryId); await c.query('USE ' + ident(source.database_name))
      const f = await this.classifiedSelection(input, source), page = Math.max(1, Math.min(1000000, Math.trunc(Number(input.page) || 1)))
      const [n] = await c.query('SELECT COUNT(*) total FROM compounds c WHERE ' + f.where, f.params)
      const [rows] = await c.query('SELECT c.id,c.main_name,c.name_zh,c.name_en,c.cas,c.formula FROM compounds c WHERE ' + f.where + ' ORDER BY c.id LIMIT 50 OFFSET ?', [...f.params, (page - 1) * 50])
      const [classes] = await c.query('SELECT id,class_name FROM classes ORDER BY class_name')
      const state = this.classificationProvider ? await this.classificationProvider.state() : null
      return { total: Number(n[0].total), rows, classes, page, categories: state?.catalog || [] }
    } finally { await c.end() }
  }
  async build(input, progress = () => {}) {
    const policy = normalizePolicy(input.policy), title = text(input.title, '交付名称'), version = text(input.version, '版本', 64)
    if (!Array.isArray(input.selections) || !input.selections.length || input.selections.length > 100) fail('请选择1–100个原始库')
    if (new Set(input.selections.map(s => s.libraryId)).size !== input.selections.length) fail('原始库重复，请合并筛选条件')
    let maxMethods=0
    const id = crypto.randomUUID(), tmp = path.join(this.directory, '.building-' + id), target = path.join(this.directory, id)
    fs.mkdirSync(tmp, { mode: 0o700 }); const index = [], origins = [], contents = { compounds: 0, ms: 0, lc: 0, spectra: 0, chromatograms: 0, experiments: 0 }
    const state = this.classificationProvider && (policy.fields.classification?.some(k => ['categories','source_labels'].includes(k)) || input.selections.some(s => s.categoryKey)) ? await this.classificationProvider.state() : null
    const c = await this.connect()
    try {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      for (const selection of input.selections) {
        const source = await this.source(c, selection.libraryId), f = await this.classifiedSelection(selection, source, state), sourceKey = hash(id + ':library:' + selection.libraryId).slice(0, 24)
        const displayName = text(selection.displayName || source.title, '数据库显示名称')
        if (origins.some(o => o.displayName === displayName)) fail('数据库显示名称重复，请为每个交付库设置不同名称')
        await c.query('USE ' + ident(source.database_name))
        const [meta] = await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [source.database_name])
        const tables = new Set(meta.map(x => x.TABLE_NAME))
        const related = async (table, column, value) => { if (!tables.has(table)) return []; const [rows] = await c.query(`SELECT * FROM ${ident(table)} WHERE ${ident(column)}=? ORDER BY id`, [value]); return rows }
        let cursor = 0, sourceCount = 0
        while (true) {
          const [compounds] = await c.query('SELECT c.* FROM compounds c WHERE ' + f.where + ' AND c.id>? ORDER BY c.id LIMIT 200', [...f.params, cursor])
          if (!compounds.length) break
          const classifications = state && policy.fields.classification?.some(k => ['categories','source_labels'].includes(k)) ? await this.classificationProvider.snapshotRows(c, source, compounds.map(r => r.id), state) : new Map()
          for (const row of compounds) {
            cursor = Number(row.id); const recordId = hash(id + ':' + source.id + ':' + row.id).slice(0, 32)
            const compound = clean(row, policy.fields.compound)
            compound.main_name = compound.main_name || '名称未提供'
            const record = { id: recordId, stableId: hash('mysql:' + source.id + ':' + row.id), sourceKey, sourceTitle: displayName, compound, ms: [], lc: [], spectra: [], chromatograms: [], experiments: [], sources: [], checks: [] }
            const classification = projectClassification(classifications.get(String(row.id)), policy.fields.classification,{subdivide:policy.features.classificationSubdivide,sourceLabelDepth:policy.classification?.sourceLabelDepth,navigationDepth:policy.classification?.navigationDepth,tagDepth:policy.classification?.tagDepth})
            if (classification) record.classification = classification
            const methodRows = policy.features.spectra ? await related('ms_methods', 'compounds_id', row.id) : []
            const methodIds = new Set(methodRows.map(m => Number(m.id)))
            record.ms = methodRows.map(m => ({ id: hash(recordId + ':ms:' + m.id).slice(0, 24), ...clean(m, policy.fields.ms) }))
            if (policy.features.spectra) {
              const rows = await related('spectra', 'compound_id', row.id)
              for (const s of rows) {
                const [links] = await c.query('SELECT method_id FROM spectrum_method_links WHERE spectrum_id=?', [s.id])
                record.spectra.push({ id: hash(recordId + ':sp:' + s.id).slice(0, 24), ...clean(s, policy.fields.spectrum), methodIds: links.filter(l => methodIds.has(Number(l.method_id))).map(l => hash(recordId + ':ms:' + l.method_id).slice(0, 24)) })
              }
            }
            if (policy.features.lc) for (const m of await related('lc_methods', 'compounds_id', row.id)) {
              const out = { id: hash(recordId + ':lc:' + m.id).slice(0, 24), ...clean(m, policy.fields.lc.filter(k => k !== 'gradient')) }
              if (policy.fields.lc.includes('flow_rate')) out.flow_rate = lcFlowRate({ ...m, items: await related('lc_methods_items', 'lc_methods_id', m.id) })
              if (policy.fields.lc.includes('retention_times')) out.retention_times = retentionTimes(m.conditions, recordId, methodIds)
              if (policy.fields.lc.includes('gradient')) out.gradient = (await related('lc_methods_items', 'lc_methods_id', m.id)).map(x => clean(x, ['step_order', 'time', 'time_unit', 'percentage_A', 'percentage_B', 'flow_rate', 'flow_rate_unit']))
              const parsedLiquid = require('./liquid-normalization.cjs').normalizeLiquid({ ...m, gradient: out.gradient })
              for (const key of ['phase_A','phase_B','column_type','column_length_mm','column_inner_diameter_mm','column_particle_size_um','gradient','elution_mode']) if (policy.fields.lc.includes(key) && parsedLiquid[key] !== undefined) out[key] = parsedLiquid[key]
              record.lc.push(out)
            }
            if (policy.features.chromatograms) for (const t of await related('chromatogram_traces', 'compound_id', row.id)) {
              const out = { id: hash(recordId + ':ch:' + t.id).slice(0, 24), ...clean(t, policy.fields.chromatogram) }
              record.chromatograms.push(out)
              if (policy.features.checks) {
                if (t.status !== 'completed') { record.checks.push({ id: out.id, type: 'chromatogram', incomplete: true, issue: '记录尚未完成，不参与正式检查' }); continue }
                const trace = { timeUnit: out.time_unit, points: out.points ?? [] }
                if (trace.points.length && ['s', 'min'].includes(trace.timeUnit)) {
                  try {
                    const p = this.engine.normalizeDetectionPackage({ formatVersion: 1, batchName: '交付检查', methodName: '交付曲线', ruleVersion: '默认规则', results: [{ id: out.id, sample: '交付记录', compound: compound.main_name, trace }] })
                    const result = this.engine.analyseRow(p.results[0]); record.checks.push({ id: out.id, type: 'chromatogram', engineVersion: this.engine.ENGINE_VERSION, ...pick(result, ['abnormal', 'incomplete']), peak: result.peak, ratio: result.ratio, limit: result.limit, labels: result.labels })
                  } catch { record.checks.push({ id: out.id, type: 'chromatogram', incomplete: true, issue: '曲线格式或时间单位不符合检查要求' }) }
                } else record.checks.push({ id: out.id, type: 'chromatogram', incomplete: true, issue: '数据不足：图片或缺少明确单位的曲线不能进行峰形检查' })
              }
            }
            if (policy.features.experiments) for (const e of await related('experiment_results', 'compound_id', row.id)) {
              const out = { id: hash(recordId + ':ex:' + e.id).slice(0, 24), ...clean(e, policy.fields.experiment.filter(k => !['measurement', 'ratio', 'limit'].includes(k))) }, data = json(e.data) ?? {}
              const rawRow = data.result ?? data.row ?? (Array.isArray(data.results) && data.results.length === 1 ? data.results[0] : data)
              if (policy.fields.experiment.includes('measurement')) out.measurement = measurement(rawRow.measurement)
              if (policy.fields.experiment.includes('limit')) out.limit = limit(rawRow.limit)
              if (policy.fields.experiment.includes('ratio')) out.ratio = ratio(rawRow.ratio)
              record.experiments.push(out)
              if (policy.features.checks) {
                if (e.status !== 'completed') record.checks.push({ id: out.id, type: 'experiment', incomplete: true, issue: '记录尚未完成，不参与正式检查' })
                else if (e.record_type === 'reference') record.checks.push({ id: out.id, type: 'experiment', incomplete: true, issue: '参考记录不作为样品测定检查' })
                else try {
                  const p = this.engine.normalizeDetectionPackage({ formatVersion: 1, batchName: '交付检查', methodName: '交付测定', ruleVersion: '交付规则', results: [{ id: out.id, sample: '交付记录', compound: compound.main_name, measurement: out.measurement ?? undefined, limit: out.limit ?? undefined, ratio: out.ratio ?? undefined }] })
                  const result = this.engine.analyseRow(p.results[0]); record.checks.push({ id: out.id, type: 'experiment', engineVersion: this.engine.ENGINE_VERSION, abnormal: result.abnormal, incomplete: result.incomplete, ratio: result.ratio, limit: result.limit, labels: result.labels })
                } catch { record.checks.push({ id: out.id, type: 'experiment', incomplete: true, issue: '数据不足：测定数据或规则不完整' }) }
              }
            }
            if (policy.fields.source.length) {
              const [sources] = await c.query("SELECT DISTINCT l.* FROM entity_sources es JOIN source_records sr ON sr.id=es.source_record_id JOIN spectral_libraries l ON l.id=sr.library_id WHERE es.entity_type='compound' AND es.entity_id=?", [row.id])
              record.sources = sources.map(s => clean(s, policy.fields.source))
            }
            for (const k of ['ms', 'lc', 'spectra', 'chromatograms', 'experiments']) contents[k] += record[k].length
            maxMethods=Math.max(maxMethods,record.ms.length);const file = JSON.stringify(record); fs.writeFileSync(path.join(tmp, recordId + '.json'), file, { mode: 0o600 })
            index.push({ id: recordId, ...(record.classification ? {classification:record.classification} : {}), sourceKey, sourceTitle: record.sourceTitle, compound: Object.fromEntries(Object.entries(compound).filter(([k]) => !k.endsWith('base64'))), sha256: hash(file), abnormal: record.checks.some(x => x.abnormal), incomplete: record.checks.some(x => x.incomplete) })
            sourceCount++; contents.compounds++; progress(contents.compounds)
          }
          await new Promise(resolve => setImmediate(resolve))
        }
        origins.push({ sourceKey, libraryId: source.id, displayName, count: sourceCount, selection: { categoryKey: selection.categoryKey || '', keyword: selection.keyword || '', classIds: selection.classIds || [], onlySelected: !!selection.onlySelected, compoundIds: selection.onlySelected ? selection.compoundIds : [] } })
      }
      if (!index.length) fail('所选条件没有可交付的化合物')
      await c.commit()
      const manifest = { layout:{maxMethods},id, title, version, createdAt: new Date().toISOString(), policy, fieldLabels: Object.fromEntries(Object.entries(policy.fields).map(([group, keys]) => [group, Object.fromEntries(keys.map(k => [k, fields[group][k]]))])), sources: origins.map(o => ({ sourceKey: o.sourceKey, displayName: o.displayName, count: o.count })), contents, total: index.length, indexHash: hash(JSON.stringify(index)) }
      fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify(index), { mode: 0o600 }); fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
      fs.renameSync(tmp, target)
      return { ...manifest, origins }
    } catch (e) { await c.rollback().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); throw e }
    finally { await c.end() }
  }
  index(release) {
    const content = fs.readFileSync(path.join(this.directory, release.snapshotId || release.id, 'index.json'), 'utf8')
    if (hash(content) !== release.indexHash) fail('交付清单校验失败，请联系管理员', 500)
    return JSON.parse(content)
  }
  record(release, id, verifiedEntry) {
    if (!/^[a-f0-9]{32}$/.test(String(id))) fail('记录不存在', 404)
    const entry = verifiedEntry || this.index(release).find(r => r.id === id)
    if (!entry || entry.id !== id) fail('记录不存在', 404)
    const content = fs.readFileSync(path.join(this.directory, release.snapshotId || release.id, id + '.json'), 'utf8')
    if (hash(content) !== entry.sha256) fail('交付记录校验失败，请联系管理员', 500)
    return JSON.parse(content)
  }
}
module.exports = { SnapshotBuilder, clean, measurement, limit, ratio }
