import { ipcMain } from 'electron'
import { prisma } from '../database'
import {
  readTemplate,
  validateRows,
  validationSummary,
  prepareSpectrumRows,
  writePreparedSpectrumRows,
  type SpectrumImportRow
} from '../services/legacySpectra'
export function registerSpectrumImportIPC(): void {
  ipcMain.handle('spectrum-import:parse', async (_, path: string, compoundId?: number) => {
    try {
      if (!/\.xlsx?$/i.test(path)) throw new Error('请选择 Excel 谱图模板')
      const rows = await validateRows(
        readTemplate(path).map((row) => ({
          ...row,
          compoundId: row.compoundId ?? compoundId ?? null
        }))
      )
      return { success: true, rows, summary: validationSummary(rows) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
  ipcMain.handle('spectrum-import:validate', async (_, input: SpectrumImportRow[]) => {
    try {
      const rows = await validateRows(input)
      return { success: true, rows, summary: validationSummary(rows) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
  ipcMain.handle('spectrum-import:save', async (_, input: SpectrumImportRow[]) => {
    try {
      const rows = await prepareSpectrumRows(input)
      const saved = await prisma.$transaction((tx) => writePreparedSpectrumRows(tx, rows))
      return { success: true, imported: rows.length, ...saved }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
