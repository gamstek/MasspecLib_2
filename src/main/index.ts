import { app, shell, BrowserWindow, dialog, ipcMain, screen, Tray, Menu, nativeImage } from 'electron'
import { join, extname } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {createWindowIcon} from '../shared/windowIcon.mjs'
import { readFile, copyFile, mkdir } from 'fs/promises'
import {
  checkDatabaseConnection,
  initializeDatabase,
  type DatabaseConnectionCheckResult
} from './databaseInitialization'
import { loadDatabaseConfig, setDatabaseConfigDirectory } from './databaseConfig'
import { CONFIG_FILE } from '../shared/databaseTarget'
import { installScopedIPC } from './federation/ipcScope'
import { registerFederationIPC } from './federation/service'
import { registerAuditIPC, startAudit, stopAudit } from './audit/service'
import { registerAnalysisIPC } from './analysis/ipc'
import { initializeSharedState } from './federation/registry'
import { connectDefaultSharedServer, registerSharedServerIPC, startSharedServer, stopSharedServer, disconnectSharedServer } from './sharedServer'
import { administratorLoggedIn, deliveryProfile, registerDeliveryIPC, restoreDeliverySession, deliveryPackaging, logoutDelivery } from './delivery'
installScopedIPC(ipcMain)

const delivery = deliveryProfile()
const instance=delivery?.edition==='admin'&&/^[a-z0-9-]{1,64}$/.test(delivery.instanceId||'')?'-'+delivery.instanceId:''
const deliveryIdentity = delivery ? 'MasspecLib2-' + delivery.edition + (delivery.tenantId ? '-' + delivery.tenantId : '') + instance : 'MasspecLib2'
app.setName(deliveryIdentity)
app.setPath('userData', join(app.getPath('appData'), deliveryIdentity))
setDatabaseConfigDirectory(app.getPath('userData'))

let mainWindow: BrowserWindow | null
let tray: Tray | null=null
function restoreWindow():void { if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus()} }
function minimizeToTray():void {
  if(!tray){
    const candidate=new Tray(createWindowIcon(nativeImage).resize({width:16,height:16}))
    try {candidate.setToolTip('MasspecLib2');candidate.on('click',restoreWindow);candidate.on('double-click',restoreWindow);candidate.setContextMenu(Menu.buildFromTemplate([{label:'打开数据库',click:restoreWindow},{type:'separator'},{label:'退出软件',click:()=>{void requestApplicationExit(true)}}]));tray=candidate}
    catch(error){candidate.destroy();throw error}
  }
  mainWindow?.hide()
}
if(app.requestSingleInstanceLock&& !app.requestSingleInstanceLock())app.exit(0)
app.on('second-instance',restoreWindow)
let exitApproved = false, exitDialogOpen = false
async function requestApplicationExit(forceExit=false): Promise<void> {
  if (exitApproved || exitDialogOpen) return
  exitDialogOpen = true
  try {
    if(!forceExit){
      const choice=await dialog.showMessageBox(mainWindow!,{type:'question',title:'关闭软件',message:'请选择关闭方式',detail:'最小化到托盘：保留当前登录和页面，点击托盘图标恢复。退出软件：结束运行，下次启动需要重新登录。',buttons:['最小化到托盘','退出软件','取消'],defaultId:0,cancelId:2,noLink:true})
      if(choice.response===0){minimizeToTray();return}if(choice.response!==1)return
    }
    if(deliveryPackaging()){
      const choice=await dialog.showMessageBox(mainWindow!,{type:'warning',title:'安装包正在生成',message:'现在关闭会中断本机打包，是否仍要关闭？',buttons:['否','是'],defaultId:0,cancelId:0})
      if(choice.response!==1)return
    }
    if(mainWindow&&!mainWindow.webContents.isDestroyed()){
      const allowed=await mainWindow.webContents.executeJavaScript('window.masspecConfirmClose ? window.masspecConfirmClose() : true').catch(()=>true)
      if(!allowed)return
    }
    await logoutDelivery()
    if(delivery?.edition!=='customer')await disconnectSharedServer().catch(error=>console.warn('退出时服务器连接已不可用',String(error)))
    tray?.destroy();tray=null
    exitApproved = true
    app.quit()
  } catch (error) { dialog.showErrorBox('暂时无法关闭', String(error)) }
  finally { exitDialogOpen = false }
}

type DatabaseConnectionFailure = Extract<DatabaseConnectionCheckResult, { ok: false }>

function getDatabaseDialogOptions(result: DatabaseConnectionFailure): Electron.MessageBoxOptions {
  const retryLabel = result.kind === 'mysql-unavailable' ? '重新检测' : '重试'

  return {
    type: 'error',
    title: '数据库启动检查',
    message: result.message,
    detail: result.detail,
    buttons: [retryLabel, '退出软件'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
}

async function ensureDatabaseServerReady(): Promise<boolean> {
  while (true) {
    const result = await checkDatabaseConnection()

    if (result.ok) {
      console.info(`[database] MySQL 连接检查完成，配置：${result.configPath}`)

      if (!result.databaseExists) {
        await dialog.showMessageBox({
          type: 'info',
          title: '数据库尚未初始化',
          message: `数据库 ${result.database} 尚未创建`,
          detail:
            '请先由管理员创建此空的新库，再进入软件选择初始化 SQL。MasspecLib2 不会创建、删除或覆盖数据库。',
          buttons: ['我知道了'],
          defaultId: 0,
          noLink: true
        })
      }

      return true
    }

    if (result.kind === 'configuration-error') {
      const selected = await dialog.showOpenDialog({
        title: '选择 MasspecLib2 数据库配置文件（请先编辑 .env.masspeclib2.example）',
        properties: ['openFile'],
        filters: [{ name: '数据库配置', extensions: ['env', 'masspeclib2', 'example'] }]
      })
      if (selected.canceled || !selected.filePaths[0]) return false
      const previous = process.env.MASSPECLIB2_DATABASE_CONFIG
      try {
        process.env.MASSPECLIB2_DATABASE_CONFIG = selected.filePaths[0]
        loadDatabaseConfig()
        await mkdir(app.getPath('userData'), { recursive: true })
        await copyFile(selected.filePaths[0], join(app.getPath('userData'), CONFIG_FILE))
        delete process.env.MASSPECLIB2_DATABASE_CONFIG
      } catch (error) {
        if (previous) process.env.MASSPECLIB2_DATABASE_CONFIG = previous
        else delete process.env.MASSPECLIB2_DATABASE_CONFIG
        await dialog.showMessageBox({
          type: 'error',
          message: String(error),
          buttons: ['重新配置']
        })
      }
      continue
    }
    console.error(`[database] ${result.message}\n${result.detail}`)
    const { response } = await dialog.showMessageBox(getDatabaseDialogOptions(result))

    if (response !== 0) {
      return false
    }
  }
}

function registerDatabaseInitializationIPC(): void {
  ipcMain.handle('database:status', () => checkDatabaseConnection())
  ipcMain.handle('database:initialize', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择数据库初始化 SQL 文件',
      properties: ['openFile'],
      filters: [{ name: 'SQL 文件', extensions: ['sql'] }],
      buttonLabel: '选择并继续'
    })

    if (selection.canceled || selection.filePaths.length === 0) {
      return { ok: false, cancelled: true }
    }

    const schemaFilePath = selection.filePaths[0]
    let databaseName: string

    try {
      databaseName = loadDatabaseConfig().config.database
    } catch (error) {
      return {
        ok: false,
        message: 'MasspecLib2 数据库配置不可用',
        detail: error instanceof Error ? error.message : String(error)
      }
    }

    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: '初始化数据库风险确认',
      message: `确认初始化数据库 ${databaseName} 吗？`,
      detail: `此操作将执行所选 SQL 文件，只允许对空的 MasspecLib2 新库装载结构和基础数据。非空库将拒绝初始化。\n\n所选文件：${schemaFilePath}\n\n请确认已经完成数据库备份，再继续操作。`,
      buttons: ['取消', '继续初始化'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })

    if (response !== 1) {
      return { ok: false, cancelled: true }
    }

    return initializeDatabase(schemaFilePath)
  })
}

async function registerBusinessIPC(): Promise<void> {
  const [
    { registerCompoundIPC },
    { registerClassIPC },
    { registerLcMethodsIPC },
    { registerMsMethodsIPC },
    { registerSpectrumImportIPC }
  ] = await Promise.all([
    import('./ipc/compounds'),
    import('./ipc/class'),
    import('./ipc/lcMethods'),
    import('./ipc/msMethods'),
    import('./ipc/spectrumImport')
  ])

  registerCompoundIPC()
  registerClassIPC()
  registerLcMethodsIPC()
  registerMsMethodsIPC()
  registerSpectrumImportIPC()
}

function handleApplicationStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error('应用启动失败：', error)
  dialog.showErrorBox('软件启动失败', message)
  app.quit()
}

function createWindow(): void {
  const area=screen?.getPrimaryDisplay?.()?.workAreaSize||{width:1280,height:800}
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: Math.min(1280,area.width),
    height: Math.min(800,area.height),
    minWidth: Math.min(1000,area.width),
    minHeight: Math.min(600,area.height),
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon:createWindowIcon(nativeImage) } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('close', event => { if (!exitApproved) { event.preventDefault(); void requestApplicationExit() } })
  const resetNavigation=():void=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('workspace:reset-navigation')}
  mainWindow.on('show',resetNavigation);mainWindow.on('restore',resetNavigation);mainWindow.on('minimize',resetNavigation);mainWindow.on('hide',resetNavigation)
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximized'))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-unmaximized'))
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // mainWindow?.webContents.openDevTools()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.gamstek.masspeclib2')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerDeliveryIPC()
  if (delivery?.edition === 'admin') {
    ipcMain.handle('admin:connect', async (_, approvedFingerprint?: string) => {
      if (!administratorLoggedIn()) throw new Error('请先登录管理员账号')
      return connectDefaultSharedServer(approvedFingerprint)
    })
    ipcMain.handle('admin:logout', async () => {
      await logoutDelivery(); await disconnectSharedServer(); return { success: true }
    })
  }
  const databaseReady =
    !!delivery || initializeSharedState() ||
    existsSync(join(app.getPath('userData'), 'connections.json')) ||
    (await ensureDatabaseServerReady())

  if (!databaseReady) {
    app.quit()
    return
  }

  if (delivery?.edition !== 'customer') {
    initializeSharedState()
    registerDatabaseInitializationIPC()
    registerAnalysisIPC(ipcMain)
    await registerBusinessIPC()
  }

  // IPC 处理：打开文件选择对话框
  ipcMain.handle('dialog:openFile', async (_event, option?: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: option?.properties || ['openFile'], // openFile: 选择文件；openDirectory: 选择文件夹；multiSelections: 多选
      title: option?.title || '选择分子结构图',
      filters: option?.filters || [{ name: '图片', extensions: ['jpg', 'png', 'jpeg'] }],
      buttonLabel: option?.buttonLabel || '选择',
      defaultPath: option?.defaultPath,
      securityScopedBookmarks: option?.securityScopedBookmarks
    })
    if (result.canceled) {
      return null // 用户取消
    }
    return result.filePaths // 返回数组，如 ['/path/to/file.txt']
  })
  // IPC 处理：保存文件选择对话框
  ipcMain.handle('dialog:saveFile', async (_event, option?: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: option?.title || '选择保存文件',
      defaultPath: option?.defaultPath,
      buttonLabel: option?.buttonLabel || '选择',
      filters: option?.filters || [{ name: 'fileName', extensions: ['txt'] }],
      properties: option?.properties || ['dontAddToRecent']
    })
    if (result.canceled) {
      return '' // 用户取消
    }
    return result.filePath // 返回数组，如 ['/path/to/file.txt']
  })
  // 读取文件并返回 base64
  ipcMain.handle('fs:readFileAsBase64', async (_event, filePath: string) => {
    try {
      // 安全检查：可选，限制只能读取用户选择过的路径（防止任意路径读取）
      // 这里简单信任渲染进程传来的路径（因为来自 dialog 选择）
      const buffer = await readFile(filePath)
      const ext = extname(filePath).toLowerCase().slice(1) || 'png' // 默认 png
      const mime =
        {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
          bmp: 'image/bmp'
        }[ext] || 'application/octet-stream'

      const base64 = buffer.toString('base64')
      return `data:${mime};base64,${base64}`
    } catch (err) {
      console.error('读取文件失败:', err)
      return null
    }
  })
  // 监听渲染进程发来的控制指令
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-toggle-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
      mainWindow.webContents.send('window-unmaximized')
    } else {
      mainWindow?.maximize()
      mainWindow?.webContents.send('window-maximized')
    }
  })
  ipcMain.on('window-close', () => mainWindow?.close())

  // 可选：双击标题栏也最大化


  if (delivery?.edition !== 'customer') {
    registerFederationIPC(ipcMain)
    registerAuditIPC(ipcMain)
    registerSharedServerIPC(ipcMain)
  }
  createWindow()
  if (delivery) await restoreDeliverySession()
  if (delivery?.edition !== 'customer') { await startSharedServer(); startAudit() }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}, handleApplicationStartupError)

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

app.on('before-quit', event => {
  if (!exitApproved && mainWindow) { event.preventDefault(); void requestApplicationExit(true); return }
  stopSharedServer()
  void stopAudit()
})
