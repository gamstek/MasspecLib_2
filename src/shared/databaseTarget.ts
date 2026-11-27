export const PRODUCT = 'MasspecLib2'
export const SCHEMA_VERSION = 4
export const CONFIG_FILE = '.env.masspeclib2'

export function validateDatabaseTarget(name: string): string {
  const value = name.trim()
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value))
    throw new Error('新版数据库名只能包含字母、数字和下划线，且必须以字母开头')
  if (!/^mspec_lib2(?:_[A-Za-z0-9]+)*$/.test(value)) {
    throw new Error('MasspecLib2 只接受 mspec_lib2 或 mspec_lib2_ 开头的新库名称，不能连接原库')
  }
  return value
}

export function validateDatabaseIdentity(
  metadata: { product: string; schema_version: number; state: string } | null
): void {
  if (
    !metadata ||
    metadata.product !== PRODUCT ||
    metadata.schema_version !== SCHEMA_VERSION ||
    metadata.state !== 'ready'
  ) {
    throw new Error(
      '目标库不是已初始化的 MasspecLib2 结构版本 4 数据库（旧版新库请在数据库管理中升级）。请确认新版配置并在空的新库执行初始化。'
    )
  }
}

// Older MasspecLib2 schemas may reach the connection manager for an explicit upgrade.
// Every database write continues to use validateDatabaseIdentity above.
export function validateDatabaseStartupIdentity(
  metadata: { product: string; schema_version: number; state: string } | null
): void {
  if (
    metadata?.product === PRODUCT &&
    [2, 3].includes(Number(metadata.schema_version)) &&
    metadata.state === 'ready'
  ) return
  validateDatabaseIdentity(metadata)
}
