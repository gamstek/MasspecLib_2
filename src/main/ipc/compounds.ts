import {
  previewDataPackage,
  importDataPackage,
  exportDataPackage,
  undoImportBatch
} from '../services/dataExchange'
import { saveCompoundDetails, getCompoundExtensions } from '../services/compoundDetails'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/no-explicit-any */
// src/main/ipc/compounds.ts
import { ipcMain } from 'electron'
import { prisma } from '../database'
import xlsx from 'xlsx'
import fs from 'fs'
import path from 'path'
import { CompoundSpecial } from '../../renderer/src/enum'
import { listCompounds } from '../services/compoundList'

export function registerCompoundIPC(): void {
  ipcMain.handle('compounds:total-count', async () => {
    // const total = await prisma.compounds.count()  // 统计所有记录（包括已删除的）
    const total = await prisma.compounds.count({
      where: { is_delete: false, is_in_trash: false }
    })
    return { total }
  })
  ipcMain.handle('compound:list', (_, filters) => listCompounds(filters))
  ipcMain.handle('compound:filter-options', () =>
    prisma.spectral_libraries.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, version: true }
    })
  )
  /**
   * 切换化合物收藏状态
   * 前端调用示例：
   * invoke('compound:toggle-favorite', 123)  // 化合物 ID
   * 返回新状态
   */
  ipcMain.handle('compound:toggle-favorite', async (_, compoundId: number) => {
    if (!compoundId || typeof compoundId !== 'number') {
      return { success: false, error: '无效的化合物 ID' }
    }

    try {
      // 先查当前状态
      const compound = await prisma.compounds.findUnique({
        where: { id: compoundId },
        select: { is_favorite: true }
      })
      if (!compound) {
        return { success: false, error: '化合物不存在' }
      }
      // 切换状态
      const newFavorite = !compound.is_favorite
      await prisma.compounds.update({
        where: { id: compoundId },
        data: {
          is_favorite: newFavorite,
          revision: { increment: 1 },
          update_time: new Date()
        }
      })

      return {
        success: true,
        is_favorite: newFavorite ? 1 : 0,
        message: newFavorite ? '已添加到收藏' : '已取消收藏'
      }
    } catch (err: any) {
      console.error('收藏操作失败:', err)
      return { success: false, error: err.message || '操作失败' }
    }
  })
  /**
   * 切换化合物删除状态
   * 前端调用示例：
   * invoke('compound:delete', 123)  // 化合物 ID
   * 返回新状态
   */
  ipcMain.handle('compound:delete', async (_, compoundId: number) => {
    if (!compoundId || typeof compoundId !== 'number') {
      return { success: false, error: '无效的化合物 ID' }
    }
    try {
      // 先查当前状态
      const compound = await prisma.compounds.findUnique({
        where: { id: compoundId },
        select: { is_in_trash: true }
      })
      if (!compound) {
        return { success: false, error: '化合物不存在' }
      }
      // 切换状态
      const newDelete = !compound.is_in_trash
      await prisma.compounds.update({
        where: { id: compoundId },
        data: {
          is_in_trash: newDelete,
          revision: { increment: 1 },
          update_time: new Date()
        }
      })

      return {
        success: true,
        is_in_trash: newDelete ? 1 : 0,
        message: newDelete ? '已删除' : '已取消删除'
      }
    } catch (err: any) {
      console.error('删除操作失败:', err)
      return { success: false, error: err.message || '操作失败' }
    }
  })
  /**
   * Excel 表头 → 数据库字段映射
   * 名称      → name 字段里 json 数组的 name 值（多语言）
   * 英文名    → main_name
   * 分子式    → formula
   * CAS号     → cas
   */
  ipcMain.handle('compounds:import-excel', async (_event, filePath: string) => {
    try {
      const workbook = xlsx.readFile(filePath)
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows: any[] = xlsx.utils.sheet_to_json(sheet, {
        defval: null,
        header: 1,
        blankrows: false
      })
      if (rows.length <= 1) {
        return { success: false, error: 'Excel 文件为空或只有表头' }
      }
      const headerRow = rows[0] as string[] // 表头
      const dataRows = rows.slice(1) // 真实数据
      // 找出各列的索引（防止用户调换列顺序）
      const colIndex = {
        chName: headerRow.indexOf('名称'),
        mainName: headerRow.indexOf('英文名'),
        formula: headerRow.indexOf('分子式'),
        cas: headerRow.indexOf('CAS号')
      }
      const recordsToCreate = dataRows.map((row: any[]) => {
        const chName = colIndex.chName >= 0 ? row[colIndex.chName]?.toString().trim() || null : null
        const mainName =
          colIndex.mainName >= 0 ? row[colIndex.mainName]?.toString().trim() || null : null
        const formula =
          colIndex.formula >= 0 ? row[colIndex.formula]?.toString().trim() || null : null
        const cas = colIndex.cas >= 0 ? row[colIndex.cas]?.toString().trim() || null : null

        // 构造 name Json 数组
        const nameJson: { name: string; area?: string }[] = []
        if (chName) nameJson.push({ name: chName, area: '中国' })

        return {
          name: nameJson.length > 0 ? nameJson : null,
          main_name: mainName || null,
          formula,
          cas,
          is_favorite: false,
          is_in_trash: false,
          is_delete: false,
          create_time: new Date(),
          update_time: new Date(),
          molecular_mass: null,
          monoisotopic_mass: null,
          formula_diagram_base64: ''
        }
      })
      // 批量插入（一次性最多 10000 条，超过会自动分批）
      const result = await prisma.compounds.createMany({
        data: recordsToCreate as any,
        skipDuplicates: true // 如果 cas 重复就跳过（推荐打开）
      })

      return { success: true, inserted: result.count }
    } catch (err: any) {
      console.error('Excel 导入失败', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('compounds:import-svg-structures', async (_event, dirPath: string) => {
    try {
      const files = fs.readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith('.svg'))
      if (files.length === 0) {
        return { success: false, error: 'SVG 文件夹为空' }
      }

      let updated = 0
      let skipped = 0

      for (const file of files) {
        const filePath = path.join(dirPath, file)
        const svgContent = fs.readFileSync(filePath, 'utf-8')

        // 提取文件名（去掉 .svg）
        const fileName = path.basename(file, '.svg').trim()
        // 情况1：文件名是 CAS（最常见的格式：50-03-3）
        const casMatch = fileName.replace(/[^0-9-]/g, '') // 提取纯数字和横杠
        let compound
        if (casMatch && casMatch.match(/^\d{1,7}-\d{2}-\d$/)) {
          compound = await prisma.compounds.findFirst({
            where: { cas: casMatch }
          })
        }
        // 情况2：如果没找到，用 main_name 精确匹配（文件名就是英文名）
        if (!compound) {
          compound = await prisma.compounds.findFirst({
            where: { main_name: fileName }
          })
        }
        if (compound) {
          await prisma.compounds.update({
            where: { id: compound.id },
            data: {
              formula_diagram_base64: svgContent // 直接存 SVG 文本（完美显示！）
            }
          })
          updated++
          console.log(`导入成功: ${file} → ${compound.cas || compound.main_name}`)
        } else {
          skipped++
          console.log(`未匹配: ${file}`)
        }
      }
      return {
        success: true,
        updated,
        skipped,
        total: files.length,
        message: `导入完成！成功 ${updated} 个，跳过 ${skipped} 个`
      }
    } catch (err: any) {
      console.error('SVG 导入失败:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('compound-class:import', async (_event, filePath: string) => {
    try {
      const workbook = xlsx.readFile(filePath)
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows: any[] = xlsx.utils.sheet_to_json(sheet, {
        defval: null,
        header: 1,
        blankrows: false
      })

      // 2. 查询这些分类的 id（大小写不敏感）
      const classes = [
        { id: 8, class_name: '治疗药物' },
        { id: 2, class_name: '兽药' },
        { id: 1, class_name: '农药' },
        { id: 7, class_name: '化工材料' },
        { id: 9, class_name: '食品添加剂' },
        { id: 11, class_name: '塑化剂' },
        { id: 10, class_name: '天然产物' }
      ]
      const classMap = new Map(classes.map((c) => [c.class_name.toLowerCase(), c.id]))

      // 3. 查询所有出现的 CAS/main_name 对应的 compound id
      const casList = rows.map((r) => r[2]?.toString().trim()).filter(Boolean)
      const mainNameList = rows.map((r) => r[0]?.toString().trim()).filter(Boolean)
      const formulaList = rows.map((r) => r[1]?.toString().trim()).filter(Boolean)

      const compounds = await prisma.compounds.findMany({
        where: {
          OR: [
            { cas: { in: casList } },
            { formula: { in: formulaList } },
            { main_name: { in: mainNameList } }
          ]
        },
        select: { id: true, cas: true, main_name: true, formula: true }
      })

      // 建立 compound 的快速查找表（优先 CAS，其次 main_name）
      const casToId = new Map<string, number>()
      const nameToId = new Map<string, number>()
      const formulaToId = new Map<string, number>()

      compounds.forEach((c) => {
        if (c.cas) casToId.set(c.cas.toLowerCase(), c.id)
        if (c.main_name) nameToId.set(c.main_name.toLowerCase(), c.id)
        if (c.formula) formulaToId.set(c.formula.toLowerCase(), c.id)
      })

      // 4. 准备要插入的中间表记录
      const recordsToCreate = rows
        .map((row) => {
          const cas = row[2]?.toString().trim()
          const mainName = row[0]?.toString().trim()
          const formula = row[1]?.toString().trim()
          const className = row[3]?.toString().trim()

          if (!className) return null

          const classId = classMap.get(className.toLowerCase())
          if (!classId) return null

          let compoundId: number | undefined

          if (cas) compoundId = casToId.get(cas.toLowerCase())
          if (!compoundId && mainName) compoundId = nameToId.get(mainName.toLowerCase())
          if (!compoundId && formula) compoundId = formulaToId.get(formula.toLowerCase())

          if (!compoundId) return null

          return {
            compound_id: compoundId,
            create_time: /* @__PURE__ */ new Date(),
            update_time: /* @__PURE__ */ new Date(),
            class_id: classId
          }
        })
        .filter(Boolean)

      // 5. 批量插入（自动跳过已存在的关联）
      const result = await prisma.compound_class.createMany({
        data: recordsToCreate as any,
        skipDuplicates: true // 关键！重复导入不会报错
      })

      return {
        success: true,
        message: `关联导入完成！共插入 ${result.count} 条记录（跳过重复）`
      }
    } catch (err: any) {
      console.error('关联导入失败:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('ms-methods:import-excel', async (_event, filePath: string) => {
    try {
      const workbook = xlsx.readFile(filePath)
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows: any[] = xlsx.utils.sheet_to_json(sheet, {
        defval: null,
        header: 1,
        blankrows: false
      })

      // 1. 提取所有可能的匹配值（去重）
      const casList = rows.map((r) => r[2]?.toString().trim()).filter(Boolean)
      const formulaList = rows.map((r) => r[1]?.toString().trim()).filter(Boolean)
      const mainNameList = rows.map((r) => r[0]?.toString().trim()).filter(Boolean)

      // 2. 查询所有可能的 compounds
      const compounds = await prisma.compounds.findMany({
        where: {
          OR: [
            { cas: { in: casList } },
            { formula: { in: formulaList } },
            { main_name: { in: mainNameList } }
          ]
        },
        select: { id: true, cas: true, formula: true, main_name: true }
      })
      // 建立快速查找表（优先 CAS > 分子式 > main_name）
      const compoundMap = new Map<string, number>() // key: cas | formula | main_name(lowercase) → id
      compounds.forEach((c) => {
        if (c.cas) compoundMap.set(c.cas, c.id)
        if (c.formula) compoundMap.set(c.formula, c.id)
        if (c.main_name) compoundMap.set(c.main_name.toLowerCase(), c.id)
      })
      // 3. 准备要插入的 ms_methods 记录
      const recordsToCreate = rows
        .map((row) => {
          const cas = row[2]?.toString().trim()
          const formula = row[1]?.toString().trim()
          const mainName = row[0]?.toString().trim()
          const q1 = parseFloat(row[3])
          const q3 = parseFloat(row[4])
          const dp = parseFloat(row[5])
          const ce = parseFloat(row[6])
          // 跳过无效数值行
          if (isNaN(q1) && isNaN(q3) && isNaN(dp) && isNaN(ce)) return null
          // 查找 compounds_id
          let compounds_id: number | undefined
          if (cas) compounds_id = compoundMap.get(cas)
          if (!compounds_id && formula) compounds_id = compoundMap.get(formula)
          if (!compounds_id && mainName) compounds_id = compoundMap.get(mainName.toLowerCase())
          if (!compounds_id) return null // 没匹配到化合物，跳过
          return {
            compounds_id,
            q1: isNaN(q1) ? null : q1,
            q3: isNaN(q3) ? null : q3,
            dp: isNaN(dp) ? null : dp,
            ce: isNaN(ce) ? null : ce,
            // 其他字段默认值（可根据需要调整）
            ms_mode: null,
            polarity: 1,
            ion_source: null,
            scan_mode: null,
            cad_value: null,
            cad_type: null,
            mass_spectrum_base64: null,
            create_time: new Date(),
            update_time: new Date()
          }
        })
        .filter(Boolean)

      // 4. 批量插入（自动跳过完全重复的记录）
      const result = await prisma.ms_methods.createMany({
        data: recordsToCreate as any,
        skipDuplicates: true // 基于唯一约束（如果有）或所有字段相同跳过
      })

      return {
        success: true,
        message: `MS 方法导入完成！共插入 ${result.count} 条记录（跳过重复）`,
        matched: recordsToCreate.length,
        totalRows: rows.length
      }
    } catch (err: any) {
      console.error('MS 方法导入失败:', err)
      return { success: false, error: err.message }
    }
  })

  // 新增/编辑化合物（自动处理 calls JSON）
  // 收藏切换
  ipcMain.handle('compound:toggleFavorite', async (_, id: number) => {
    const compound = await prisma.compounds.findUnique({ where: { id } })
    return await prisma.compounds.update({
      where: { id },
      data: { is_favorite: !compound?.is_favorite, revision: { increment: 1 } }
    })
  })

  ipcMain.handle('compound:update', (_, info) => saveCompoundDetails(info))
  ipcMain.handle('compound:extensions', (_, id: number) => getCompoundExtensions(id))
  ipcMain.handle('compound:detail', (_, id: number) =>
    prisma.compounds.findUnique({ where: { id } })
  )

  /**
   * 导出指定 ID 的化合物数据（推荐结构）
   */
  ipcMain.handle('export:compounds', async (_, info) => {
    try {
      if (info.selectionOnly && !info.compoundIds.length)
        throw new Error('请先选择需要导出的化合物')
      return await exportDataPackage(
        info.filePath,
        info.compoundIds.length ? info.compoundIds : undefined,
        {
          ...info,
          favoriteOnly: info.classId === CompoundSpecial.Favorites,
          trashOnly: info.classId === CompoundSpecial.RecycleBin
        }
      )
    } catch (error) {
      return { success: false, message: String(error) }
    }
  })
  ipcMain.handle('import:undo', (_, batchId: number) => undoImportBatch(batchId))
  ipcMain.handle('import:preview', (_, path: string) => previewDataPackage(path))
  ipcMain.handle('import:compounds', (_, path: string, hash?: string) =>
    importDataPackage(path, hash)
  )
}
