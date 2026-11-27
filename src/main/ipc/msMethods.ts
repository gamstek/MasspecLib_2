import { ipcMain } from 'electron'
import { prisma } from '../database'
export function registerMsMethodsIPC(): void {
  ipcMain.handle('ms-methods:list', async (_, compoundId: number) => {
    const rows = await prisma.ms_methods.findMany({
      where: { compounds_id: compoundId },
      orderBy: { id: 'asc' }
    })
    const grouped = new Map<string, typeof rows>()
    for (const row of rows) {
      const mode = row.ms_mode ?? ''
      grouped.set(mode, [...(grouped.get(mode) ?? []), row])
    }
    return [...grouped].map(([ms_mode, methods]) => ({ ms_mode, methods }))
  })
}
