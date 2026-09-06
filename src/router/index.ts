// Local enhancement modified 2026-09-05; AGPL-3.0-only. See LOCAL-NOTICE.md.
import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router'
import MainLayout from '@/layouts/MainLayout.vue'
import NProgress from 'nprogress'
import 'nprogress/nprogress.css'

NProgress.configure({
  showSpinner: false, // 禁止显示默认的旋转圆圈
  easing: 'ease',
  speed: 500,
  minimum: 0.1
})

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: MainLayout,
    redirect: '/novel',
    children: [
      {
        path: '/localCenter',
        name: 'LocalCenter',
        component: () => import('@/views/LocalCenter/index.vue'),
        meta: { title: '本地中心' }
      },
      {
        path: '/novel',
        name: 'Home',
        component: () => import('@/views/Home/index.vue'),
        meta: { title: '首页' }
      },
      {
        path: '/home',
        redirect: '/novel'
      },
      {
        path: '/myBooks',
        name: 'MyBooks',
        component: () => import('@/views/MyBooks/index.vue'),
        meta: { title: '我的作品' }
      },
      {
        path: '/feedback',
        name: 'Feedback',
        component: () => import('@/views/Feedback/index.vue'),
        meta: { title: '问题反馈' }
      },
      {
        path: '/workflowBook',
        name: 'WorkflowBook',
        component: () => import('@/views/WorkflowBook/index.vue'),
        meta: { title: '工作流建书' }
      },
      {
        path: '/workflowBook/history',
        name: 'WorkflowBookHistory',
        component: () => import('@/views/WorkflowBook/History.vue'),
        meta: { title: '工作流历史' }
      },
      {
        path: '/prompts',
        name: 'Prompts',
        component: () => import('@/views/Prompts/index.vue'),
        meta: { title: '提示词管理' }
      },
      {
        path: '/writeStatistics',
        name: 'WriteStatistics',
        component: () => import('@/views/WriteStatistics/index.vue'),
        meta: { title: '码字统计' }
      },
      {
        path: '/novelRank',
        name: 'NovelRank',
        component: () => import('@/views/NovelRank/index.vue'),
        meta: { title: '榜单风向' }
      },
      {
        path: '/bookBreakdown',
        name: 'BookBreakdown',
        component: () => import('@/views/BookBreakdown/index.vue'),
        meta: { title: '竞品拆书' }
      },
      {
        path: '/bookBreakdown/workbench',
        name: 'BookBreakdownWorkbench',
        component: () => import('@/views/BookBreakdown/Workbench.vue'),
        meta: { title: '拆解工作台', hideLayout: true }
      },
      {
        path: '/inspiration',
        name: 'Inspiration',
        component: () => import('@/views/Inspiration/index.vue'),
        meta: { title: '灵感素材' }
      },
      {
        path: '/aiModels',
        name: 'AiModelManage',
        component: () => import('@/views/AiModelManage/index.vue'),
        meta: { title: '模型管理' }
      },
      {
        path: '/writing/:bookId',
        name: 'Writing',
        component: () => import('@/views/Writing/index.vue'),
        meta: { title: '写作', hideLayout: true }
      },
      {
        path: '/writing-panel/:bookId/:tool',
        name: 'WritingPanelWindow',
        component: () => import('@/views/Writing/PanelWindow.vue'),
        meta: { title: '参考面板', hideLayout: true }
      }
    ]
  },
  // 未知路径兜底：旧书签或失效链接（如已下线的模板库页）回首页，避免白屏
  {
    path: '/:pathMatch(.*)*',
    redirect: '/novel'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(() => {
  NProgress.start()
})

router.afterEach(() => {
  NProgress.done()
})

export default router
