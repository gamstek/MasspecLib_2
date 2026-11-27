// Network teardown is best effort; saved-login removal remains mandatory.
export async function cleanupStep(task, label, timeoutMs=2000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(task).then(()=>null,error=>({label,error:String(error)})),
      new Promise(resolve=>{timer=setTimeout(()=>resolve({label,error:'清理超时'}),timeoutMs)})
    ])
  } finally {clearTimeout(timer)}
}
export async function disconnectSharedResources(actions, timeoutMs=2000) {
  actions.stopBackground()
  actions.clearSavedLogin()
  const warnings=[]
  const pending=await cleanupStep(actions.waitForSync,'等待同步结束',timeoutMs);if(pending)warnings.push(pending)
  const results=await Promise.all([cleanupStep(actions.closeAudit,'关闭检查连接',timeoutMs),cleanupStep(actions.closePools,'关闭数据库连接',timeoutMs)])
  warnings.push(...results.filter(Boolean))
  const tunnel=await cleanupStep(actions.closeTunnel,'关闭SSH通道',timeoutMs);if(tunnel)warnings.push(tunnel)
  actions.clearProfile();actions.publishDisconnected()
  return warnings
}
