import { takeStorageStartupNotice } from '@/storage/storage-mode'
import { appSettings } from '@/storage/app-settings'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { ElLoading, ElMessage } from 'element-plus'
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
import { initImportedFonts, loadImportedFont } from '@/composables/use-imported-fonts'
import { useWritingEditorStore } from '@/stores/writing-editor'
import { installOverflowProbe } from './startup/overflow-probe'
import { installUiTypography } from './startup/ui-typography'
import { isTauriRuntime } from '@/storage/writing-storage'

// main.ts 在桌面迁移、设置加载完成后才动态导入此文件；
// Pinia、主题和 Agent 页面因此共用已就绪的设置缓存，不再直接访问旧 localStorage。
// 清掉旧 SaaS 版本残留的账号持久化，防止陈旧登录态误触云端分支。
appSettings.removeItem('ew-user')

window.addEventListener('ew-settings-save-failed', event => {
  ElMessage.error(`本地设置保存失败，尚未落盘：${(event as CustomEvent<string>).detail}`)
})

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
app.use(router)
const disposeUiTypography = installUiTypography()
import.meta.hot?.dispose(disposeUiTypography)
/** index.html 里的启动占位（两根墨条）在首屏挂载后淡出；迁移页出现时由迁移页自己移除 */
const dismissBootScreen = () => {
  const boot = document.getElementById('ew-boot')
  if (!boot) return
  boot.classList.add('is-done')
  window.setTimeout(() => boot.remove(), 300)
}

// 后台任务可能改动章节；应用级事件通知原编辑器重新核对版本。
if (isTauriRuntime()) {
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<{ bookId: string; chapterId: string; version?: number }>('agent-book-changed', event => {
        window.dispatchEvent(
          new CustomEvent('ew-writing-chapter-content-refresh', {
            detail: {
              bookId: event.payload.bookId,
              chapterId: Number(event.payload.chapterId),
              source: 'agent',
              contentVersion: event.payload.version
            }
          })
        )
        window.dispatchEvent(
          new CustomEvent('ew-local-book-updated', { detail: { bookId: event.payload.bookId } })
        )
      })
    )
    .catch(error => console.error('连接 Agent 作品通知失败', error))
}
// 开发态记录横向溢出，不参与生产环境运行。
if (import.meta.env.DEV) installOverflowProbe(router)

app.use(InkLoading)
// element-plus 组件由 unplugin 按需注入（vite.config 的 Components/AutoImport），
// 全量注册已拆除；v-loading 指令按需登记，中文语言包在 App.vue 的 el-config-provider
app.use(ElLoading)

// 初始化主题系统
const themeStore = useThemeStore()
themeStore.initTheme()

// 提示词库先于挂载装载：AI 组装器同步读取，必须在任何界面可交互前就绪。
void initLocalPrompts().finally(() => {
  app.mount('#app')
  dismissBootScreen()
  const storageNotice = takeStorageStartupNotice()
  if (storageNotice) ElMessage.warning({ message: storageNotice, duration: 8000 })
  // 字体是可选资源，恢复本地字体不能阻塞整个应用启动。
  void initImportedFonts()
    .then(() => loadImportedFont(useWritingEditorStore().fontFamily))
    .catch((error) => {
      console.warn('恢复导入字体失败', error)
      ElMessage.warning('已导入字体暂时无法加载，请重启或重新导入')
    })
})
