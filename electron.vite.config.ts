import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

const candidateOut = process.env.MASSPEC_BUILD_OUT
const candidateBuild = (name: string) => candidateOut ? { outDir: resolve(candidateOut, name) } : {}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      ...candidateBuild('main'),
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'offline-delivery-worker': resolve('src/main/offline-delivery-worker.ts'),
          'analysis-worker': resolve('src/main/analysis/worker.ts'),
          'audit-worker': resolve('src/main/audit/worker.ts')
        }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: candidateBuild('preload') },
  renderer: {
    build: candidateBuild('renderer'),
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [
      vue(),
      AutoImport({
        imports: ['vue', 'vue-router'],
        resolvers: [ElementPlusResolver()],
        dts: candidateOut ? false : 'src/renderer/auto-imports.d.ts'
      }),
      Components({ resolvers: [ElementPlusResolver()], dts: candidateOut ? false : 'src/renderer/components.d.ts' })
    ]
  }
})
