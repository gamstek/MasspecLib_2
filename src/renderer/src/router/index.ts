import { createRouter, createWebHashHistory } from 'vue-router'
import routes from './routes'

// Electron 桌面应用强烈推荐使用 hash 模式！（避免打包后路径问题）
const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
