import type { RouteRecordRaw } from 'vue-router'
import { CompoundSpecial } from '../enum'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: `/${CompoundSpecial.All}` },
  { path: '/analysis', name: 'AnalysisResults', component: () => import('../views/AnalysisResults.vue') },
  { path: '/detail', name: 'Detail', component: () => import('../views/Detail.vue') },
  { path: '/:id(-?\\d+)', name: 'MainList', component: () => import('../views/MainList.vue') },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('../views/NotFound.vue') }
]
export default routes
