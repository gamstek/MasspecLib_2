export function connectionError(error, stage = 'connect', tunneled = false) {
  const code = String(error?.code || ''), number = Number(error?.errno)
  const prefix = tunneled ? 'SSH已连接；' : ''
  if (stage === 'local') return '服务器已响应，但本地数据库目录同步失败，请重试或联系管理员'
  if (code === 'ER_ACCESS_DENIED_ERROR' || number === 1045) return prefix + '数据库账号验证失败，请联系管理员检查数据库授权'
  if (['ECONNREFUSED','ECONNRESET','EPIPE'].includes(code)) return prefix + '数据库服务未响应，请检查服务器上的数据库服务是否启动'
  if (['ETIMEDOUT','PROTOCOL_SEQUENCE_TIMEOUT','EHOSTUNREACH','ENOTFOUND'].includes(code)) return prefix + '数据库连接超时或地址不可达，请检查网络和服务地址'
  if (stage === 'catalog' || code === 'ER_BAD_DB_ERROR') return prefix + '无法读取数据库目录，请联系管理员检查目录结构与读取权限'
  return prefix + '无法读取共享数据库，请重试或联系管理员检查数据库服务'
}
