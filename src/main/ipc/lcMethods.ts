import { ipcMain } from 'electron'
import { prisma } from '../database'

export function registerLcMethodsIPC(): void {
  ipcMain.handle('lc-methods:list', async (_, compoundId: number) => {
    if (!Number.isSafeInteger(compoundId) || compoundId <= 0) throw new Error('无效的化合物 ID')
    const methods = await prisma.lc_methods.findMany({
      where: { compounds_id: compoundId },
      orderBy: { id: 'asc' }
    })
    const items = await prisma.lc_methods_items.findMany({
      where: { lc_methods_id: { in: methods.map((method) => method.id) } },
      orderBy: [{ step_order: 'asc' }, { time: 'asc' }, { id: 'asc' }]
    })
    return methods.map((method) => ({
      ...method,
      methodsLinks: items.filter((item) => item.lc_methods_id === method.id)
    }))
  })
}
