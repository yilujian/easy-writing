// Local enhancement modified 2026-09-05; AGPL-3.0-only. See LOCAL-NOTICE.md.
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { ElLoading } from 'element-plus'
// 组件与样式由 unplugin 按需注入；这三类是脚本里程序化调用的，样式手动带上
import 'element-plus/es/components/message/style/index'
import 'element-plus/es/components/message-box/style/index'
// ElNotification 在 App.vue 里是显式 import，不经 unplugin 按需注入，样式得手动引；
// 漏了它，更新提醒会渲染成页尾一个无定位的裸 div，用户根本看不见
import 'element-plus/es/components/notification/style/index'
import 'element-plus/es/components/loading/style/index'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '@/styles/common.scss'
import '@/styles/ink.scss'
import InkLoading from '@/directives/inkLoading'



import App from './App.vue'
import router from './router'
import { useThemeStore } from '@/stores/theme'
import { initLocalPrompts } from '@/storage/local-prompts'
import { startLocalBackupSchedule } from '@/utils/local-companion'

// 清掉旧 SaaS 版本残留的账号持久化，防止陈旧登录态误触云端分支
localStorage.removeItem('ew-user')

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
app.use(router)

app.use(InkLoading)
// element-plus 组件由 unplugin 按需注入（vite.config 的 Components/AutoImport），
// 全量注册已拆除；v-loading 指令按需登记，中文语言包在 App.vue 的 el-config-provider
app.use(ElLoading)

// 初始化主题系统
const themeStore = useThemeStore()
themeStore.initTheme()

// 提示词库先于挂载装载：AI 组装器同步读取，必须在任何界面可交互前就绪
void initLocalPrompts().finally(() => {
  app.mount('#app')
  startLocalBackupSchedule()
})
