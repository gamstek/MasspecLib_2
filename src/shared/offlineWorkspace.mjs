import { classificationKey, classificationNavigationEnabled, classificationTree } from './deliveryClassification.mjs'
import { compoundColumnScopes } from './deliveryPresentation.mjs'
import { matchesQuery, methodColumns, queryOptions } from './deliveryQuery.mjs'
import { displayColumns } from './displayLayout.mjs'

export function offlineSummary(record) {
  const { id, stableId, sourceKey, sourceTitle, classification, ms, checks } = record
  const compound = Object.fromEntries(Object.entries(record.compound || {}).filter(([key]) => !key.endsWith('base64')))
  return { id, stableId, sourceKey, sourceTitle, compound, classification,
    abnormal: checks?.some(check => check.abnormal),
    ms: ms?.map(({ q1, q3, polarity }) => ({ q1, q3, polarity })) }
}

export function listProjector(manifest) {
  if (manifest.policy.presentation?.mode !== 'table' && !manifest.policy.presentation?.listFields?.length) return () => undefined
  const keys = new Map()
  for (const { group, key, includePolarity } of displayColumns(manifest)) {
    const name = ({ spectrum: 'spectra', source: 'sources', chromatogram: 'chromatograms', experiment: 'experiments' })[group] || group
    if (group === 'classification' || group === 'compound' && !key.endsWith('base64')) continue
    if (!keys.has(name)) keys.set(name, new Set())
    const fields = keys.get(name)
    fields.add(key)
    if (includePolarity) fields.add('polarity')
    if (group === 'lc' && key === 'retention_time') fields.add('retention_times')
    if (group === 'lc' && ['retention_time', 'retention_time_unit'].includes(key)) fields.add('retention_time_unit')
  }
  if (!keys.size) return () => undefined
  const take = (row, fields) => Object.fromEntries(Object.entries(row || {}).filter(([name]) => fields.has(name)))
  return record => Object.fromEntries([...keys].map(([name, fields]) => [
    name, name === 'compound' ? take(record.compound, fields) : (record[name] || []).map(row => take(row, fields))
  ]))
}

export function legacyManifest(data) {
  return { ...data.manifest,
    compoundDisplay: compoundColumnScopes(data.records, data.manifest.policy.fields.compound),
    methodQueryFields: methodColumns(data.records, data.manifest.policy.fields.ms || []) }
}

export class OfflineWorkspace {
  constructor({ manifest, rows, detail, list, trash }) {
    Object.assign(this, { manifest, loadRows: rows, detail, list, trash, classificationCache: new Map() })
  }
  async index() {
    if (!this.rows) {
      const rows = await this.loadRows()
      this.lookup = new Map(rows.map(row => [row.id, row]))
      this.rows = rows
    }
    return this.rows
  }
  state(row) {
    this.states ??= this.trash.read().records
    return this.states[this.trash.key(row, this.manifest.id)] || 'active'
  }
  async find(id) {
    await this.index()
    const row = this.lookup.get(id)
    if (!row || this.state(row) === 'purged') throw Error('记录不存在')
    return row
  }
  async change(action, ids) {
    if (!Array.isArray(ids) || ids.length > 20000) throw Error('记录操作无效')
    const rows = []
    for (const id of ids) rows.push(await this.find(id))
    this.trash.change(rows, this.manifest.id, ids, action)
    this.states = undefined
    this.lastQuery = undefined
    this.classificationCache.clear()
  }
  async query(input) {
    const query = queryOptions(input), trash = input.trash === true
    const cacheKey = JSON.stringify([trash, query])
    if (this.lastQuery?.cacheKey === cacheKey) return this.lastQuery
    const rows = await this.index()
    const { recordIds, ...criteria } = query
    const ids = recordIds && new Set(recordIds)
    const scope = rows.filter(row => this.state(row) === (trash ? 'trash' : 'active') &&
      (!query.source || (row.sourceKey || row.sourceTitle) === query.source))
    const matches = scope.filter(row => (!ids || ids.has(row.id)) && matchesQuery(row, criteria))
    const scopeKey = JSON.stringify([trash, query.source])
    if (!this.classificationCache.has(scopeKey) && classificationNavigationEnabled(this.manifest.policy)) {
      const catalog = new Map()
      let unclassified = 0
      for (const { classification } of scope) {
        if (!classification?.items?.length) unclassified++
        for (const category of classification?.catalog || []) catalog.set(classificationKey(category), category)
      }
      if (this.classificationCache.size >= 8) this.classificationCache.delete(this.classificationCache.keys().next().value)
      this.classificationCache.set(scopeKey, { catalog: [...catalog.values()], unclassified,
        nodes: classificationTree(scope, { navigationDepth: this.manifest.policy.classification?.navigationDepth }) })
    }
    this.lastQuery = { cacheKey, matches, classification: this.classificationCache.get(scopeKey),
      matchedIds: ids ? matches.map(row => row.id) : undefined }
    return this.lastQuery
  }
  async page(input) {
    const { matches, classification, matchedIds } = await this.query(input)
    const total = matches.length
    const page = Math.max(1, Math.min(Math.floor(Number(input.page) || 1), Math.ceil(total / 50)))
    const rows = []
    for (const row of matches.slice((page - 1) * 50, page * 50)) {
      const { id, sourceKey, sourceTitle, compound, classification } = row
      const extra = await this.list(row)
      rows.push({ id, sourceKey, sourceTitle, classification, ...extra, compound: { ...compound, ...extra?.compound } })
    }
    return { page, rows, total, matchedIds, classification }
  }
}
