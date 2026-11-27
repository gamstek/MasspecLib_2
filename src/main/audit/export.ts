import {ionModeLabel} from '../../shared/ionMode.mjs'
import {needsFileDiscovery} from '../../shared/fileRecordTransfer'
import {administratorLoggedIn} from '../delivery'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import {
  validateExportSelection,
  csvCell,
  COMPOUND_EXPORT_FIELDS,
  EXPORT_CONTENTS
} from '../../shared/exportFields'
import type { RecordRef } from '../../shared/federation'
import { ready } from './repository'
import { catalogList, indexed, checkDetail } from './catalog'
import { connections } from '../federation/registry'
import { detail, rows, count, inspect } from '../federation/adapters'
import { auditDetail } from './service'
export async function exportReport(info: any): Promise<any> {
  if (!['json', 'csv', 'xlsx'].includes(info.format) || typeof info.filePath !== 'string')
    throw new Error('导出格式或路径无效')
  const selection = validateExportSelection(info.selection),
    refs: RecordRef[] = []
  if (
    selection.contents.some((x) => ['chromatograms', 'checks'].includes(x)) &&
    (!ready() ||
      !(await indexed(
        connections().filter(
          (x) =>
            x.enabled &&
            (!info.filters?.connectionIds?.length || info.filters.connectionIds.includes(x.id))
        )
      )))
  )
    throw new Error('请先完成数据库自动检查索引，再导出色谱和检查记录')
  if (info.selectionOnly) {
    if (!Array.isArray(info.refs) || !info.refs.length) throw new Error('请先勾选记录')
    refs.push(...info.refs)
  } else if (needsFileDiscovery(info.filters?.connectionIds,administratorLoggedIn()) && (await (await import('../services/fileLibrary')).fileConnections()).some(e=>!info.filters?.connectionIds?.length||info.filters.connectionIds.includes(e.id))){for(let page=1;;page++){const result=await(await import('../federation/service')).federatedList({...info.filters,page,pageSize:200});if(!result.complete)throw Error('数据源读取不完整，请恢复后重试');if(result.total>10000)throw Error('最多导出10000条，请缩小范围');refs.push(...result.list.map((r:any)=>r.ref));if(refs.length>=result.total)break}} else if (ready() && (await indexed(connections().filter((x) => x.enabled)))) {
    for (let page = 1; ; page++) {
      const result = await catalogList({ ...info.filters, page, pageSize: 200 })
      if (!result.complete) throw new Error('来源索引存在读取错误，请先重新检查')
      if (result.total > 10000) throw new Error('最多导出10000条，请缩小筛选范围')
      refs.push(...result.list.map((x) => x.ref))
      if (refs.length >= result.total) break
    }
  } else {
    for (const entry of connections().filter(
      (x) =>
        x.enabled &&
        (!info.filters?.connectionIds?.length || info.filters.connectionIds.includes(x.id))
    )) {
      await inspect(entry)
      const total = await count(entry, info.filters ?? {})
      if (refs.length + total > 10000) throw new Error('最多导出10000条')
      for (let offset = 0; offset < total; offset += 200)
        refs.push(...(await rows(entry, info.filters ?? {}, offset, 200)).map((x) => x.ref))
    }
  }
  if (refs.length > 10000) throw new Error('最多导出10000条')
  const output: any[] = []
  for (const ref of refs) {
    const data = String(ref.connectionId).startsWith('file:') ? await (await import('../services/fileLibrary')).fileDetail(ref,selection.contents.includes('spectra')) : ready() ? await auditDetail(ref, info.filters ?? {}) : await detail(ref)
    const record: any = { record_ref: ref }
    for (const field of selection.fields) record[field] = field==='ion_mode'?ionModeLabel({ms:(data.methods||[]).flatMap(g=>g.methods||[]),spectra:data.extensions?.spectra||[]}):data.compound[field] ?? null
    for (const content of selection.contents) {
      if (content === 'methods') record.methods = data.methods
      else if (content === 'lcMethods') record.lcMethods = data.lcMethods
      else if (content === 'sources')
        record.sources = data.extensions.sources.map((item) => ({
          appliesTo: item.appliesTo,
          entityId: item.entityId,
          source_record: {
            source_key: item.source_record.source_key,
            library: item.source_record.library
          }
        }))
      else if (content === 'classifications')
        record.classifications = data.extensions.classifications
      else if (content === 'spectra')
        record.spectra = data.extensions.spectra.map(({ raw, ...item }) => {
          void raw
          return item
        })
      else if (content === 'chromatograms')
        record.chromatograms = (data.audit?.assets ?? [])
          .filter((x) => x.kind !== 'spectrum')
          .map(({ check, checkId, ...asset }) => {
            void check
            void checkId
            return asset
          })
      else if (content === 'checks') {
        record.checks = []
        for (const asset of data.audit?.assets ?? [])
          if (asset.checkId) {
            const ck = await checkDetail(asset.checkId)
            record.checks.push({
              id: ck.id,
              engine_version: ck.engine_version,
              rule_version: ck.rule_version,
              data: ck.data,
              reviews: ck.reviews
            })
          }
      }
    }
    output.push(record)
  }
  const keys = ['record_ref', ...selection.fields, ...selection.contents]
  const labels = new Map<string, string>([...COMPOUND_EXPORT_FIELDS, ...EXPORT_CONTENTS])
  if (info.format === 'json')
    writeFileSync(
      info.filePath,
      JSON.stringify(
        {
          format: 'MasspecLib2-selected-report',
          version: 1,
          exportedAt: new Date().toISOString(),
          selection,
          records: output
        },
        null,
        2
      ),
      'utf8'
    )
  else if (info.format === 'csv')
    writeFileSync(
      info.filePath,
      '\ufeff' +
        [
          keys.map((k) => csvCell(labels.get(k) ?? '记录标识')).join(','),
          ...output.map((row) => keys.map((k) => csvCell(row[k])).join(','))
        ].join('\r\n'),
      'utf8'
    )
  else {
    const data = [
      keys.map((k) => labels.get(k) ?? '记录标识'),
      ...output.map((row) =>
        keys.map((k) => {
          const v = row[k]
          const text = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v
          if (typeof text === 'string' && text.length > 32767)
            throw new Error('色谱或谱图内容超过Excel单元格长度，请改用JSON格式')
          return text
        })
      )
    ]
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), '化合物')
    XLSX.writeFile(book, info.filePath)
  }
  return {
    success: true,
    exported: output.length,
    message: `已按选择导出${output.length}个化合物。字段报告用于查看；完整迁移请使用数据包。`
  }
}
export async function exportCheckReport(info: any): Promise<any> {
  const { RESULT_EXPORT_FIELDS } = await import('../../shared/exportFields')
  const { checkRows } = await import('./catalog')
  const allowed = new Map<string, string>(RESULT_EXPORT_FIELDS)
  if (
    !['json', 'csv', 'xlsx'].includes(info.format) ||
    typeof info.filePath !== 'string' ||
    !Array.isArray(info.fields) ||
    !info.fields.length ||
    info.fields.some((k) => !allowed.has(k))
  )
    throw new Error('请选择有效的结果导出字段和格式')
  const fields = [...new Set(info.fields)] as string[],
    records: any[] = []
  for (let page = 1; ; page++) {
    const response = await checkRows({ ...info.filters, page, pageSize: 100 })
    if (response.total > 10000) throw new Error('最多导出10000条检查记录，请缩小筛选范围')
    for (const row of response.rows) {
      const detail = await checkDetail(row.id),
        result = detail.data,
        asset = detail.evidence
      const values = {
        sample: result.sample,
        compound: result.compound,
        sources: asset.sources,
        method: asset.methodName,
        batch: asset.batchName,
        peak: result.peak.state,
        flags: result.peak.flags,
        limit: result.limit.state,
        measuredValue: asset.row?.measurement,
        limitValue: asset.row?.limit,
        ratio: result.ratio.state,
        observedRatio: result.ratioChecks ?? result.ratio.value,
        review: detail.reviews,
        checkedAt: detail.created_at,
        engineVersion: detail.engine_version,
        ruleVersion: detail.rule_version,
        traces: {
          trace: asset.row?.trace,
          qualifierTrace: asset.row?.qualifierTrace,
          qualifiers: asset.row?.qualifiers
        }
      }
      records.push({
        check_id: row.id,
        ...Object.fromEntries(fields.map((k) => [k, values[k] ?? null]))
      })
    }
    if (records.length >= response.total) break
  }
  const keys = ['check_id', ...fields],
    labels = keys.map((k) => allowed.get(k) ?? '检查记录标识')
  if (info.format === 'json')
    writeFileSync(
      info.filePath,
      JSON.stringify(
        {
          format: 'MasspecLib2-check-selected-report',
          exportedAt: new Date().toISOString(),
          fields,
          records
        },
        null,
        2
      ),
      'utf8'
    )
  else if (info.format === 'csv')
    writeFileSync(
      info.filePath,
      '\ufeff' +
        [
          labels.map(csvCell).join(','),
          ...records.map((row) => keys.map((k) => csvCell(row[k])).join(','))
        ].join('\r\n'),
      'utf8'
    )
  else {
    const data = [
      labels,
      ...records.map((row) =>
        keys.map((k) => {
          const v = row[k],
            text = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v
          if (typeof text === 'string' && text.length > 32767)
            throw new Error('内容超过Excel单元格长度，请改用JSON格式')
          return text
        })
      )
    ]
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), '检查结果')
    XLSX.writeFile(book, info.filePath)
  }
  return { success: true, total: records.length }
}
