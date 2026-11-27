import { defineConfig } from 'prisma/config'
import { validateDatabaseTarget } from './src/shared/databaseTarget'
const configuredUrl = process.env.MASSPECLIB2_DATABASE_URL
const offlineCommand =
  process.argv.includes('generate') ||
  (process.argv.includes('diff') &&
    process.argv.includes('--from-empty') &&
    process.argv.includes('--to-schema'))
if (!configuredUrl && !offlineCommand)
  throw new Error('数据库命令需要显式设置指向新库的 MASSPECLIB2_DATABASE_URL')
if (configuredUrl) {
  const url = new URL(configuredUrl)
  if (url.protocol !== 'mysql:') throw new Error('MASSPECLIB2_DATABASE_URL 必须使用 MySQL')
  validateDatabaseTarget(decodeURIComponent(url.pathname.slice(1)))
}
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: configuredUrl ?? 'mysql://offline@127.0.0.1:1/mspec_lib2' }
})
