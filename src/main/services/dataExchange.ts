import { ensureTaxonomyCatalog, saveClassifications, exportClassifications, exportCatalog } from './taxonomy'
import type { TaxonomyCategory } from '../../shared/taxonomy'
import { lcTemperature } from '../../shared/lcTemperature'
import { retentionConditions } from '../../shared/lcRetention'
import { normalizeAcquisition } from '../../shared/acquisitionParameters.mjs'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile, writeFile, stat } from 'fs/promises'
import { randomUUID, createHash } from 'crypto'
import { prisma } from '../database'
import { filteredCompoundIds } from './compoundList'
import { Prisma } from '../../generated/prisma/client'
import {
  decodePackage,
  encodePackage,
  contentHash,
  hasEntityProvenance,
  type CompoundGroup,
  type DataPackage
} from '../../shared/dataPackage'

function select(record: Record<string, any>, fields: string[]): Record<string, any> {
  return Object.fromEntries(
    fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]])
  )
}
const compoundFields = [
  'main_name',
  'name_zh',
  'name_en',
  'name',
  'cas',
  'formula',
  'molecular_mass',
  'monoisotopic_mass',
  'formula_diagram_base64',
  'identifiers',
  'properties'
]
const methodFields = [
  'ms_mode',
  'transition_role',
  'q1',
  'q3',
  'ce',
  'dp',
  'cxp',
  'polarity',
  'ion_source',
  'scan_mode',
  'cad_value',
  'cad_type',
  'mass_spectrum_base64',
  'adduct',
  'ce_unit',
  'energy_type',
  'conditions'
]
const lcFields = [
  'lc_mode',
  'chromatographic_column_mode',
  'column_type',
  'column_length_mm',
  'column_inner_diameter_mm',
  'column_particle_size_um',
  'column_temperature_c',
  'elution_mode',
  'program_text',
  'retention_time',
  'phase_A',
  'phase_B',
  'retention_time_unit',
  'conditions'
]
const itemFields = [
  'time',
  'percentage_A',
  'percentage_B',
  'flow_rate',
  'time_unit',
  'flow_rate_unit',
  'components',
  'step_order'
]
const spectrumFields = [
  'kind',
  'peaks',
  'image_base64',
  'image_mime',
  'spectrum_type',
  'polarity',
  'adduct',
  'precursor_mz',
  'collision_energy',
  'conditions',
  'nature',
  'raw'
]
const profileFields = ['title', 'matrix', 'verification_status', 'data']
function dbValues(data: Record<string, any>): Record<string, any> {
  for (const field of [
    'name',
    'identifiers',
    'properties',
    'conditions',
    'peaks',
    'collision_energy',
    'raw',
    'data',
    'components'
  ]) {
    if (data[field] === null) data[field] = Prisma.DbNull
  }
  return data
}
function numbers(data: Record<string, any>, fields: string[]): Record<string, any> {
  for (const field of fields)
    if (data[field] !== undefined && data[field] !== null) data[field] = Number(data[field])
  return dbValues(data)
}
async function readPackage(path: string): Promise<{ data: DataPackage; hash: string }> {
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error('文件超过 64 MiB，请分包')
  const raw = await readFile(path)
  return { data: decodePackage(raw), hash: createHash('sha256').update(raw).digest('hex') }
}
async function decision(client: any, group: CompoundGroup): Promise<'new' | 'skip' | 'conflict'> {
  const library = await client.spectral_libraries.findUnique({
    where: { namespace: group.source.namespace }
  })
  if (!library) return 'new'
  const records = await client.source_records.findMany({
    where: { library_id: library.id, source_key: group.source.key }
  })
  if (
    records.some(
      (record: any) =>
        record.decision !== 'undone' &&
        record.decision !== 'evidence' &&
        record.content_hash === contentHash(group)
    )
  )
    return 'skip'
  return records.some(
    (record: any) => record.decision !== 'undone' && record.decision !== 'evidence'
  )
    ? 'conflict'
    : 'new'
}
export async function previewDataPackage(path: string): Promise<any> {
  const { data, hash } = await readPackage(path)
  const rows: any[] = []
  for (const [index, group] of data.groups.entries()) {
    const action = await decision(prisma, group)
    const candidates =
      action === 'new' && (group.compound.cas || group.compound.main_name)
        ? await prisma.compounds.findMany({
            where: {
              is_delete: false,
              OR: [
                ...(group.compound.cas ? [{ cas: group.compound.cas }] : []),
                ...(group.compound.main_name ? [{ main_name: group.compound.main_name }] : [])
              ]
            },
            select: { id: true, main_name: true, cas: true },
            take: 10
          })
        : []
    rows.push({
      index,
      name: group.compound.main_name ?? group.compound.cas ?? group.compound.formula,
      source: group.source,
      action,
      candidates
    })
  }
  return {
    hash,
    total: rows.length,
    rows,
    packageId: data.packageId,
    newCount: rows.filter((row) => row.action === 'new').length,
    skipped: rows.filter((row) => row.action === 'skip').length,
    conflicts: rows.filter((row) => row.action === 'conflict' || row.candidates.length).length
  }
}
async function insertGroup(tx: any, group: CompoundGroup, batchId: number, catalog: TaxonomyCategory[]): Promise<number> {
  await ensureTaxonomyCatalog(tx, catalog)
  const now = new Date()
  const compound = await tx.compounds.create({
    data: {
      ...numbers(select(group.compound, compoundFields), ['molecular_mass', 'monoisotopic_mass']),
      is_favorite: Boolean(group.compound.is_favorite),
      is_in_trash: Boolean(group.compound.is_in_trash),
      is_delete: false,
      create_time: now,
      update_time: now
    }
  })
  const library = await tx.spectral_libraries.upsert({
    where: { namespace: group.source.namespace },
    update: { namespace: group.source.namespace },
    create: {
      namespace: group.source.namespace,
      name: group.source.name ?? group.source.namespace,
      version: group.source.version,
      provider: group.source.provider,
      license: group.source.license,
      source_type: group.source.sourceType ?? 'unknown',
      location: group.source.location
    }
  })
  await tx.$queryRawUnsafe('SELECT id FROM spectral_libraries WHERE id = ? FOR UPDATE', library.id)
  const lockedRecords = await tx.$queryRawUnsafe(
    'SELECT content_hash, decision FROM source_records WHERE library_id = ? AND source_key = ? FOR UPDATE',
    library.id,
    group.source.key
  )
  if (
    lockedRecords.some(
      (record: any) =>
        record.decision !== 'undone' &&
        record.decision !== 'evidence' &&
        record.content_hash === contentHash(group)
    )
  )
    throw new Error('SOURCE_ALREADY_IMPORTED')
  if (
    lockedRecords.some(
      (record: any) => record.decision !== 'undone' && record.decision !== 'evidence'
    )
  )
    throw new Error('SOURCE_REVISION_CONFLICT')
  const source = await tx.source_records.upsert({
    where: {
      library_id_source_key_content_hash: {
        library_id: library.id,
        source_key: group.source.key,
        content_hash: contentHash(group)
      }
    },
    update: { decision: 'created', batch_id: batchId },
    create: {
      library_id: library.id,
      source_key: group.source.key,
      content_hash: contentHash(group),
      raw: group,
      decision: 'created',
      batch_id: batchId
    }
  })
  const link = async (type: string, id: number): Promise<void> => {
    await tx.entity_sources.create({
      data: { source_record_id: source.id, entity_type: type, entity_id: id }
    })
  }
  await link('compound', compound.id)
  await saveClassifications(tx, compound.id, (group.classifications ?? []).map(x => ({ ...x, evidence: x.evidence ?? [] })))
  for (const category of group.classes ?? []) {
    let existing = await tx.classes.findFirst({
      where: { class_name: category.class_name, is_custom: Boolean(category.is_custom) }
    })
    if (!existing)
      existing = await tx.classes.create({
        data: {
          class_name: category.class_name,
          is_custom: Boolean(category.is_custom),
          create_time: now,
          update_time: now
        }
      })
    await tx.compound_class.upsert({
      where: { compound_id_class_id: { compound_id: compound.id, class_id: existing.id } },
      update: {},
      create: {
        compound_id: compound.id,
        class_id: existing.id,
        create_time: now,
        update_time: now
      }
    })
  }
  const entityIds = new Map<string, number>([['compound:', compound.id]])
  const methods = new Map<string, number>()
  for (const input of group.methods ?? []) {
    const acquisition = normalizeAcquisition(input)
    const method = await tx.ms_methods.create({
      data: {
        ...numbers(select(input, methodFields), ['q1', 'q3', 'ce', 'dp', 'cxp', 'cad_value']),
        conditions: Object.keys(acquisition).length ? acquisition : Prisma.DbNull,
        cad_value: input.cad_value ?? acquisition.collision_gas_pressure?.value ?? null,
        cad_type: input.cad_type ?? acquisition.collision_gas_pressure?.unit ?? acquisition.collision_gas_level ?? null,
        compounds_id: compound.id,
        create_time: now,
        update_time: now
      }
    })
    if (input.localId) {
      methods.set(input.localId, method.id)
      entityIds.set('ms_method:' + input.localId, method.id)
    }
    if (!hasEntityProvenance(group, 'ms_method', input.localId))
      await link('ms_method', method.id)
  }
  for (const input of group.lcMethods ?? []) {
    const temperature = lcTemperature(input)
    temperature.conditions = retentionConditions(input, temperature.conditions, new Set(methods.keys()), methods)
    const method = await tx.lc_methods.create({
      data: {
        ...numbers(select(input, lcFields), ['retention_time']),
        column_temperature_c: temperature.column_temperature_c,
        conditions: temperature.conditions === null ? Prisma.DbNull : temperature.conditions,
        compounds_id: compound.id,
        create_time: now,
        update_time: now
      }
    })
    if (input.localId) entityIds.set('lc_method:' + input.localId, method.id)
    if (!hasEntityProvenance(group, 'lc_method', input.localId))
      await link('lc_method', method.id)
    for (const [index, step] of (input.items ?? input.methodsLinks ?? []).entries()) {
      await tx.lc_methods_items.create({
        data: {
          ...numbers(select(step, itemFields), ['time', 'flow_rate']),
          step_order: step.step_order ?? index,
          lc_methods_id: method.id,
          create_time: now,
          update_time: now
        }
      })
    }
  }
  for (const input of group.spectra ?? []) {
    const spectrum = await tx.spectra.create({
      data: { ...dbValues(select(input, spectrumFields)), compound_id: compound.id }
    })
    if (input.localId) entityIds.set('spectrum:' + input.localId, spectrum.id)
    if (!hasEntityProvenance(group, 'spectrum', input.localId))
      await link('spectrum', spectrum.id)
    for (const key of input.methodLocalIds ?? []) {
      await tx.spectrum_method_links.create({
        data: { spectrum_id: spectrum.id, method_id: methods.get(key) }
      })
    }
  }
  for (const input of group.profiles ?? []) {
    const profile = await tx.detection_profiles.create({
      data: { ...dbValues(select(input, profileFields)), compound_id: compound.id }
    })
    if (input.localId) entityIds.set('detection_profile:' + input.localId, profile.id)
    await link('detection_profile', profile.id)
  }
  // Original evidence is linked to the corresponding newly created entity. It is
  // separate from the exchange package identity used for idempotency and undo.
  for (const evidence of group.provenance ?? []) {
    const record = evidence.source_record,
      origin = record?.library
    if (!origin?.namespace || !origin?.name || typeof origin.namespace !== 'string') continue
    if (origin.namespace.startsWith('database-record:')) continue
    const type = evidence.appliesTo ?? evidence.entity_type ?? 'compound'
    const target =
      type === 'compound'
        ? compound.id
        : entityIds.get(type + ':' + String(evidence.entityId ?? evidence.entity_id ?? ''))
    if (!target) continue // Older packages retain unmatched evidence in raw, without inventing associations.
    const evidenceLibrary = await tx.spectral_libraries.upsert({
      where: { namespace: origin.namespace },
      update: {},
      create: {
        namespace: origin.namespace,
        name: origin.name,
        provider: origin.provider,
        location: origin.location,
        version: origin.version,
        license: origin.license,
        source_type: origin.source_type ?? 'unknown'
      }
    })
    const raw = { original: record.raw ?? evidence, importedWithSourceRecord: source.id }
    const evidenceRecord = await tx.source_records.upsert({
      where: {
        library_id_source_key_content_hash: {
          library_id: evidenceLibrary.id,
          source_key: String(record.source_key ?? group.source.key),
          content_hash: contentHash(raw)
        }
      },
      update: { decision: 'evidence', batch_id: batchId },
      create: {
        library_id: evidenceLibrary.id,
        source_key: String(record.source_key ?? group.source.key),
        content_hash: contentHash(raw),
        raw,
        decision: 'evidence',
        batch_id: batchId
      }
    })
    await tx.entity_sources.upsert({
      where: {
        source_record_id_entity_type_entity_id: {
          entity_type: type,
          entity_id: target,
          source_record_id: evidenceRecord.id
        }
      },
      update: {},
      create: { entity_type: type, entity_id: target, source_record_id: evidenceRecord.id }
    })
  }
  return compound.id
}
let importing = false
export async function importDataPackage(path: string, expectedHash?: string): Promise<any> {
  if (importing) throw new Error('另一个导入正在执行')
  importing = true
  try {
    const { data, hash } = await readPackage(path)
    if (expectedHash && hash !== expectedHash) throw new Error('预览后文件发生变化，请重新预览')
    const batch = await prisma.import_batches.upsert({
      where: { package_id_content_hash: { package_id: data.packageId, content_hash: hash } },
      update: { status: 'running' },
      create: {
        package_id: data.packageId,
        content_hash: hash,
        mapping_version: data.mappingVersion,
        status: 'running'
      }
    })
    const report: any = {
      batchId: batch.id,
      total: data.groups.length,
      imported: 0,
      skipped: 0,
      conflicts: [],
      errors: []
    }
    for (const [index, group] of data.groups.entries()) {
      try {
        const outcome = await prisma.$transaction(
          async (tx) => {
            const action = await decision(tx, group)
            let id: number | null = null
            if (action === 'new') id = await insertGroup(tx, group, batch.id, data.taxonomyCatalog ?? [])
            const nextReport = structuredClone(report)
            if (action === 'new') nextReport.imported++
            else if (action === 'skip') nextReport.skipped++
            else
              nextReport.conflicts.push({
                index,
                source: group.source,
                reason: '同来源键存在不同内容，未覆盖；请核对修订'
              })
            await tx.import_batches.update({
              where: { id: batch.id },
              data: { cursor: index + 1, report: nextReport }
            })
            return { action, id, nextReport }
          },
          { timeout: 30000 }
        )
        Object.assign(report, outcome.nextReport)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'SOURCE_ALREADY_IMPORTED') report.skipped++
        else if (message === 'SOURCE_REVISION_CONFLICT')
          report.conflicts.push({ index, source: group.source, reason: message })
        else report.errors.push({ index, source: group.source, error: message })
        await prisma.import_batches.update({
          where: { id: batch.id },
          data: { cursor: index + 1, report }
        })
      }
    }
    await prisma.import_batches.update({
      where: { id: batch.id },
      data: {
        status:
          report.errors.length || report.conflicts.length ? 'completed-with-issues' : 'completed',
        report
      }
    })
    return { success: report.errors.length === 0 && report.conflicts.length === 0, ...report }
  } finally {
    importing = false
  }
}
export async function exportDataPackage(
  path: string,
  ids?: number[],
  filters: any = {}
): Promise<any> {
  const data = await prisma.$transaction(
    async (tx) => {
      const metadata = await tx.app_metadata.findUniqueOrThrow({ where: { id: 1 } })
      const selectedIds = ids ?? (await filteredCompoundIds(filters, tx))
      const compounds = await tx.compounds.findMany({
        where: { is_delete: false, id: { in: selectedIds } },
        orderBy: { id: 'asc' }
      })
      const groups: CompoundGroup[] = []
      for (const compound of compounds) {
        const categoryIds = await tx.compound_class.findMany({
          where: { compound_id: compound.id }
        })
        const classes = await tx.classes.findMany({
          where: { id: { in: categoryIds.map((item) => item.class_id) } }
        })
        const methods = await tx.ms_methods.findMany({
          where: { compounds_id: compound.id },
          orderBy: { id: 'asc' }
        })
        const lcMethods = await tx.lc_methods.findMany({
          where: { compounds_id: compound.id },
          include: { methodsLinks: { orderBy: [{ step_order: 'asc' }, { id: 'asc' }] } },
          orderBy: { id: 'asc' }
        })
        const spectra = await tx.spectra.findMany({
          where: { compound_id: compound.id },
          include: { methods: true },
          orderBy: { id: 'asc' }
        })
        const profiles = await tx.detection_profiles.findMany({
          where: { compound_id: compound.id }
        })
        const links = await tx.entity_sources.findMany({
          where: { entity_type: 'compound', entity_id: compound.id },
          include: { source_record: { include: { library: true } } }
        })
        groups.push({
          source: {
            namespace: `masspeclib2:${metadata.instance_id}`,
            key: String(compound.id),
            name: 'MasspecLib2 导出'
          },
          compound: {
            ...select(compound, compoundFields),
            is_favorite: compound.is_favorite,
            is_in_trash: compound.is_in_trash
          },
          classifications: await exportClassifications(tx, compound.id),
          classes: classes.map((item) => ({
            class_name: item.class_name,
            is_custom: item.is_custom
          })),
          methods: methods.map((item) => ({
            ...select(item, methodFields),
            conditions: normalizeAcquisition(item),
            localId: String(item.id)
          })),
          lcMethods: lcMethods.map((item) => ({
            ...select(item, lcFields),
            items: item.methodsLinks.map((step) => select(step, itemFields))
          })),
          spectra: spectra.map((item) => ({
            ...select(item, spectrumFields),
            precursor_mz: item.precursor_mz?.toString() ?? null,
            methodLocalIds: item.methods.map((method) => String(method.method_id))
          })),
          profiles: profiles.map((item) => select(item, profileFields)),
          provenance: links.map((item) => ({
            sourceKey: item.source_record.source_key,
            contentHash: item.source_record.content_hash,
            library: item.source_record.library,
            raw: item.source_record.raw
          }))
        })
      }
      return {
        formatVersion: 2,
        schemaVersion: 2,
        packageId: randomUUID(),
        mappingVersion: 'masspeclib2-v2',
        taxonomyCatalog: await exportCatalog(tx),
        groups
      } as DataPackage
    },
    { timeout: 60000, isolationLevel: 'RepeatableRead' }
  )
  const bytes = encodePackage(data)
  await writeFile(path, bytes)
  return {
    success: true,
    count: data.groups.length,
    filePath: path,
    message: `已导出 ${data.groups.length} 个化合物及关联数据`
  }
}

export async function undoImportBatch(batchId: number): Promise<any> {
  if (!Number.isSafeInteger(batchId) || batchId <= 0) throw new Error('批次 ID 无效')
  if (importing) throw new Error('导入执行中，请稍后撤销')
  importing = true
  try {
    const records = await prisma.source_records.findMany({
      where: { batch_id: batchId, decision: { not: 'evidence' } }
    })
    const result: any = { batchId, undone: 0, alreadyUndone: 0, conflicts: [] }
    for (const record of records) {
      if (record.decision === 'undone') {
        result.alreadyUndone++
        continue
      }
      try {
        await prisma.$transaction(
          async (tx) => {
            const links = await tx.entity_sources.findMany({
              where: { source_record_id: record.id }
            })
            const compoundId = links.find((link) => link.entity_type === 'compound')?.entity_id
            if (!compoundId) throw new Error('找不到本批新增化合物，未执行撤销')
            const compound = await tx.compounds.findUniqueOrThrow({ where: { id: compoundId } })
            if (compound.revision !== 1) throw new Error('化合物已被编辑或修改状态')
            const evidenceRecords = await tx.source_records.findMany({
              where: { decision: 'evidence', batch_id: batchId }
            })
            const ownedEvidence = evidenceRecords
              .filter((item: any) => (item.raw as any)?.importedWithSourceRecord === record.id)
              .map((item: any) => item.id)
            for (const link of links) {
              const shared = await tx.entity_sources.count({
                where: {
                  entity_type: link.entity_type,
                  entity_id: link.entity_id,
                  source_record_id: { notIn: [record.id, ...ownedEvidence] }
                }
              })
              if (shared) throw new Error('实体已被其他来源共享')
            }
            const methods = await tx.ms_methods.findMany({ where: { compounds_id: compoundId } })
            const lc = await tx.lc_methods.findMany({ where: { compounds_id: compoundId } })
            const spectra = await tx.spectra.findMany({ where: { compound_id: compoundId } })
            const profiles = await tx.detection_profiles.findMany({
              where: { compound_id: compoundId }
            })
            const collections = [
              ['ms_method', methods],
              ['lc_method', lc],
              ['spectrum', spectra],
              ['detection_profile', profiles]
            ] as const
            for (const [type, items] of collections) {
              const recorded = links.filter((link) => link.entity_type === type)
              if (
                items.length !== recorded.length ||
                items.some(
                  (item) =>
                    item.revision !== 1 || !recorded.some((link) => link.entity_id === item.id)
                )
              ) {
                throw new Error('关联数据已新增、编辑或移除')
              }
            }
            const currentCategories = await tx.compound_class.findMany({
              where: { compound_id: compoundId },
              include: { class: true }
            })
            const original = record.raw as any
            const categoryKeys = (items: any[]): string[] =>
              [
                ...new Set(
                  items.map((item) =>
                    contentHash({ class_name: item.class_name, is_custom: Boolean(item.is_custom) })
                  )
                )
              ].sort()
            if (
              JSON.stringify(categoryKeys(currentCategories.map((item) => item.class))) !==
              JSON.stringify(categoryKeys(original.classes ?? []))
            )
              throw new Error('分类或自定义集合已修改')
            const actualTaxonomy = await exportClassifications(tx, compoundId)
            const sortAssignments = (items: any[]) => items.map(x => ({ namespace: x.namespace, category_code: x.category_code, evidence: x.evidence ?? [] })).sort((a,b) => JSON.stringify([a.namespace,a.category_code]).localeCompare(JSON.stringify([b.namespace,b.category_code])))
            if (contentHash(sortAssignments(actualTaxonomy)) !== contentHash(sortAssignments(original.classifications ?? []))) throw new Error('统一分类或证据已修改')
            const spectrumIds = spectra.map((item) => item.id),
              methodIds = methods.map((item) => item.id)
            const crossLinks = await tx.spectrum_method_links.count({
              where: {
                OR: [
                  { spectrum_id: { in: spectrumIds }, method_id: { notIn: methodIds } },
                  { method_id: { in: methodIds }, spectrum_id: { notIn: spectrumIds } }
                ]
              }
            })
            if (crossLinks) throw new Error('谱图或方法被其他化合物关联')
            await tx.entity_sources.deleteMany({
              where: { source_record_id: { in: [record.id, ...ownedEvidence] } }
            })
            await tx.source_records.deleteMany({ where: { id: { in: ownedEvidence } } })
            await tx.spectrum_method_links.deleteMany({
              where: { spectrum_id: { in: spectrumIds } }
            })
            await tx.spectra.deleteMany({ where: { compound_id: compoundId } })
            await tx.detection_profiles.deleteMany({ where: { compound_id: compoundId } })
            await tx.ms_methods.deleteMany({ where: { compounds_id: compoundId } })
            await tx.lc_methods_items.deleteMany({
              where: { lc_methods_id: { in: lc.map((item) => item.id) } }
            })
            await tx.lc_methods.deleteMany({ where: { compounds_id: compoundId } })
            await tx.compound_taxonomy.deleteMany({ where: { compound_id: compoundId } })
            await tx.compound_class.deleteMany({ where: { compound_id: compoundId } })
            await tx.compounds.delete({ where: { id: compoundId } })
            await tx.source_records.update({
              where: { id: record.id },
              data: { decision: 'undone' }
            })
          },
          { timeout: 30000 }
        )
        result.undone++
      } catch (error) {
        result.conflicts.push({ sourceKey: record.source_key, error: String(error) })
      }
    }
    const batch = await prisma.import_batches.findUniqueOrThrow({ where: { id: batchId } })
    await prisma.import_batches.update({
      where: { id: batchId },
      data: {
        status: result.conflicts.length ? 'undo-with-conflicts' : 'undone',
        report: { ...(batch.report as any), undo: result }
      }
    })
    return result
  } finally {
    importing = false
  }
}
