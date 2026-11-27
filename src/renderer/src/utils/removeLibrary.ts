import { ElMessageBox } from 'element-plus'
import { invokeIPC } from './ipcInvoke'

export async function setSharedLibraryRemoved(key: string, title: string, removed: boolean): Promise<void> {
  if (removed) {
    await ElMessageBox.confirm(
      '从所有管理员的工作台移除「' + title + '」？源数据和已生成的交付保留。',
      '移除数据库',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' }
    )
  }
  await invokeIPC('delivery:call', 'POST', '/admin/workspace/library-visibility', { key, removed })
}
