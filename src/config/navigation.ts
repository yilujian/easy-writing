import type { FeatureKey } from '@/stores/app-config'
import type { MenuId } from '@/types/ui-preferences'

interface NavigationItem {
  id: MenuId
  label: string
  icon: string
  path?: string
  featureKey?: FeatureKey
}

/** 设置中心与侧边栏共用菜单定义，名称、图标和顺序保持一致。 */
export const navigationGroups: Array<{ title: string; items: NavigationItem[] }> = [
  {
    title: '创作',
    items: [
      { id: 'home', label: '首页', icon: 'fa-solid fa-house', path: '/novel' },
      { id: 'books', label: '我的作品', icon: 'fa-solid fa-book', path: '/myBooks' },
      {
        id: 'workflowBook',
        label: '工作流建书',
        icon: 'fa-solid fa-diagram-project',
        path: '/workflowBook',
        featureKey: 'workflowBook'
      },
      {
        id: 'writeStatistics',
        label: '码字统计',
        icon: 'fa-solid fa-chart-line',
        path: '/writeStatistics',
        featureKey: 'writeStatistics'
      }
    ]
  },
  {
    title: '资料与工具',
    items: [
      {
        id: 'novelRank',
        label: '榜单风向',
        icon: 'fa-solid fa-arrow-trend-up',
        path: '/novelRank',
        featureKey: 'novelRank'
      },
      {
        id: 'breakdown',
        label: '竞品拆书',
        icon: 'fa-solid fa-file-invoice',
        path: '/bookBreakdown',
        featureKey: 'breakdown'
      },
      {
        id: 'inspiration',
        label: '灵感素材',
        icon: 'fa-regular fa-lightbulb',
        path: '/inspiration',
        featureKey: 'inspiration'
      }
    ]
  },
  {
    title: 'AI 工具',
    items: [
      {
        id: 'byokModels',
        label: '模型管理',
        icon: 'fa-solid fa-cube',
        path: '/aiModels',
        featureKey: 'byokModels'
      },
      { id: 'prompts', label: '提示词', icon: 'fa-regular fa-file-lines', path: '/prompts' }
    ]
  },
  {
    title: '其他',
    items: [
      { id: 'feedback', label: '反馈', icon: 'fa-regular fa-message', path: '/feedback' },
      { id: 'updates', label: '检查更新', icon: 'fa-solid fa-rotate' }
    ]
  }
]
