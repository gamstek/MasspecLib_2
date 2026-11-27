import { saveClassifications } from './taxonomy'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '../database'
import { Prisma } from '../../generated/prisma/client'
import { prepareSpectrumRows, writePreparedSpectrumRows } from './legacySpectra'
import { lcTemperature } from '../../shared/lcTemperature'
import { retentionConditions } from '../../shared/lcRetention'
import { normalizeAcquisition } from '../../shared/acquisitionParameters.mjs'

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const result = Number(value)
  if (!Number.isFinite(result)) throw new Error('方法参数必须是有效数值或空值')
  return result
}
export async function savedSqlPublication(id: string): Promise<any> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('发布编号无效')
  await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS masspec_publications (operation_id VARCHAR(36) PRIMARY KEY, result_json LONGTEXT NOT NULL)')
  const rows: any = await prisma.$queryRawUnsafe('SELECT result_json FROM masspec_publications WHERE operation_id = ?', id)
  return rows.length ? JSON.parse(rows[0].result_json) : null
}
export async function saveCompoundDetails(info: any): Promise<any> {
  try {
    if (info.publicationId) { const saved = await savedSqlPublication(info.publicationId); if (saved) return saved }
    const id = info.compound.id
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(info.compound.revision))
      throw new Error('化合物 ID 或修订号无效，请重新打开详情')
    const preparedSpectra = info.pendingSpectrumImports?.length
      ? await prepareSpectrumRows(info.pendingSpectrumImports)
      : []
    const result = await prisma.$transaction(
      async (tx) => {
        const changed = await tx.compounds.updateMany({
          where: { id, revision: info.compound.revision },
          data: {
            main_name: info.compound.main_name,
            name_zh: info.compound.name_zh ?? null,
            name_en: info.compound.name_en ?? null,
            cas: info.compound.cas,
            formula: info.compound.formula,
            name: info.compound.name === null ? Prisma.DbNull : info.compound.name,
            molecular_mass: optionalNumber(info.compound.molecular_mass),
            monoisotopic_mass: optionalNumber(info.compound.monoisotopic_mass),
            ...(info.formulaDiagramBase64
              ? { formula_diagram_base64: info.formulaDiagramBase64 }
              : {}),
            revision: { increment: 1 }
          }
        })
        if (changed.count !== 1) throw new Error('数据已被其他操作修改，请重新打开详情并比较修改')
        const classIds = [...new Set<number>([...info.classIdList, ...info.customClassIdList])]
        await tx.compound_class.deleteMany({ where: { compound_id: id } })
        if (classIds.length)
          await tx.compound_class.createMany({
            data: classIds.map((classId) => ({
              compound_id: id,
              class_id: classId,
              create_time: new Date(),
              update_time: new Date()
            }))
          })
        for (const methodId of info.deletedMsMethodIds ?? []) {
          const existing = await tx.ms_methods.findFirst({
            where: { id: methodId, compounds_id: id }
          })
          if (!existing) throw new Error('待删除质谱方法不属于当前化合物')
          await tx.spectrum_method_links.deleteMany({ where: { method_id: methodId } })
          await tx.entity_sources.deleteMany({
            where: { entity_type: 'ms_method', entity_id: methodId }
          })
          await tx.ms_methods.delete({ where: { id: methodId } })
        }
        for (const methodId of info.deletedLcMethodIds ?? []) {
          const existing = await tx.lc_methods.findFirst({
            where: { id: methodId, compounds_id: id }
          })
          if (!existing) throw new Error('待删除液相方法不属于当前化合物')
          await tx.lc_methods_items.deleteMany({ where: { lc_methods_id: methodId } })
          await tx.entity_sources.deleteMany({
            where: { entity_type: 'lc_method', entity_id: methodId }
          })
          await tx.lc_methods.delete({ where: { id: methodId } })
        }
        for (const input of info.compoundLcMethodList) {
          const temperature = lcTemperature(input)
          const savedMethods = await tx.ms_methods.findMany({ where: { compounds_id: id }, select: { id: true } })
          temperature.conditions = retentionConditions(input, temperature.conditions, new Set(savedMethods.map(m => String(m.id))))
          const { id: methodId, methodsLinks } = input
          const data = {
            compounds_id: id,
            lc_mode: input.lc_mode,
            chromatographic_column_mode: input.chromatographic_column_mode,
            retention_time: optionalNumber(input.retention_time),
            column_type: input.column_type ?? null,
            column_length_mm: optionalNumber(input.column_length_mm),
            column_inner_diameter_mm: optionalNumber(input.column_inner_diameter_mm),
            column_particle_size_um: optionalNumber(input.column_particle_size_um),
            column_temperature_c: temperature.column_temperature_c,
            elution_mode: input.elution_mode ?? null,
            program_text: input.program_text ?? null,
            phase_A: input.phase_A,
            phase_B: input.phase_B,
            retention_time_unit: input.retention_time_unit,
            conditions: temperature.conditions === null ? Prisma.DbNull : temperature.conditions
          }
          if (
            methodId &&
            !(await tx.lc_methods.findFirst({ where: { id: methodId, compounds_id: id } }))
          )
            throw new Error('液相方法归属不符')
          const method = methodId
            ? await tx.lc_methods.update({
                where: { id: methodId },
                data: { ...data, revision: { increment: 1 } }
              })
            : await tx.lc_methods.create({
                data: { ...data, create_time: new Date(), update_time: new Date() }
              })
          await tx.lc_methods_items.deleteMany({ where: { lc_methods_id: method.id } })
          for (const [index, step] of (methodsLinks ?? []).entries())
            await tx.lc_methods_items.create({
              data: {
                lc_methods_id: method.id,
                time: optionalNumber(step.time),
                flow_rate: optionalNumber(step.flow_rate),
                percentage_A: step.percentage_A ?? null,
                percentage_B: step.percentage_B ?? null,
                step_order: index,
                time_unit: step.time_unit,
                flow_rate_unit: step.flow_rate_unit,
                components: step.components === null ? Prisma.DbNull : step.components,
                create_time: new Date(),
                update_time: new Date()
              }
            })
        }
        for (const group of info.compoundMsMethodList)
          for (const input of group.methods) {
            const acquisition = normalizeAcquisition(input)
            const data = {
              compounds_id: id,
              ms_mode: input.id ? input.ms_mode : input.ms_mode || group.ms_mode,
              q1: optionalNumber(input.q1),
              q3: optionalNumber(input.q3),
              ce: optionalNumber(input.ce),
              dp: optionalNumber(input.dp),
              cxp: optionalNumber(input.cxp),
              polarity: input.polarity ?? null,
              ion_source: input.ion_source ?? null,
              scan_mode: input.scan_mode ?? null,
              cad_value: optionalNumber(input.cad_value ?? acquisition.collision_gas_pressure?.value),
              cad_type: input.cad_type ?? acquisition.collision_gas_pressure?.unit ?? acquisition.collision_gas_level ?? null,
              mass_spectrum_base64: input.mass_spectrum_base64 ?? null,
              transition_role: input.transition_role ?? null,
              adduct: input.adduct,
              ce_unit: input.ce_unit,
              energy_type: input.energy_type,
              conditions: Object.keys(acquisition).length ? acquisition : Prisma.DbNull
            }
            if (
              input.id &&
              !(await tx.ms_methods.findFirst({ where: { id: input.id, compounds_id: id } }))
            )
              throw new Error('质谱方法归属不符')
            if (input.id)
              await tx.ms_methods.update({
                where: { id: input.id },
                data: { ...data, revision: { increment: 1 } }
              })
            else
              await tx.ms_methods.create({
                data: { ...data, create_time: new Date(), update_time: new Date() }
              })
          }
        if (info.extensions?.classifications !== undefined) await saveClassifications(tx, id, info.extensions.classifications)
        if (info.extensions) {
          for (const profile of info.extensions.profiles ?? []) {
            const { id: profileId, revision, title, matrix, verification_status } = profile
            const updated = await tx.detection_profiles.updateMany({
              where: { id: profileId, compound_id: id, revision },
              data: { title, matrix, verification_status, revision: { increment: 1 } }
            })
            if (updated.count !== 1) throw new Error('检测档案已修改或归属不符')
          }
          for (const spectrum of info.extensions.spectra ?? []) {
            const updated = await tx.spectra.updateMany({
              where: { id: spectrum.id, compound_id: id, revision: spectrum.revision },
              data: {
                adduct: spectrum.adduct,
                polarity: spectrum.polarity,
                nature: spectrum.nature,
                spectrum_type: spectrum.spectrum_type,
                revision: { increment: 1 }
              }
            })
            if (updated.count !== 1) throw new Error('谱图已修改或归属不符')
          }
        }
        const spectrumResult = preparedSpectra.length
          ? await writePreparedSpectrumRows(tx, preparedSpectra)
          : null
        const response = {
          success: true,
          message: '更新成功',
          compoundId: id,
          revision: info.compound.revision + 1,
          spectrumResult
        }
        if (info.publicationId) await tx.$executeRawUnsafe('INSERT INTO masspec_publications (operation_id, result_json) VALUES (?, ?)', info.publicationId, JSON.stringify(response))
        return response
      },
      { timeout: 30000 }
    )
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
export async function getCompoundExtensions(compoundId: number): Promise<any> {
  if (!Number.isSafeInteger(compoundId) || compoundId <= 0) throw new Error('化合物 ID 无效')
  const [spectra, profiles, sources] = await Promise.all([
    prisma.spectra.findMany({ where: { compound_id: compoundId }, orderBy: { id: 'asc' } }),
    prisma.detection_profiles.findMany({
      where: { compound_id: compoundId },
      orderBy: { id: 'asc' }
    }),
    prisma.entity_sources.findMany({
      where: { entity_type: 'compound', entity_id: compoundId },
      include: { source_record: { include: { library: true } } }
    })
  ])
  return {
    spectra: spectra.map((spectrum) => ({
      ...spectrum,
      precursor_mz: spectrum.precursor_mz?.toString() ?? null
    })),
    profiles,
    sources
  }
}
