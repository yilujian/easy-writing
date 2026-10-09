import { defineConfig, ConfigEnv, UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

// 纯本地应用：没有接口地址/代理/环境区分，不读任何 .env 文件。
// 端口约定：web 开发 6789（package.json dev 脚本传参）、桌面 dev UI 4414（tauri 配置引用）。
const WEB_DEV_PORT = 6789

// https://vitejs.dev/config/
export default defineConfig(({ command }: ConfigEnv): UserConfig => {
  return {
    clearScreen: false,
    plugins: [
      vue(),
      AutoImport({
        resolvers: [ElementPlusResolver()],
        imports: ['vue', 'vue-router', 'pinia'],
        // dts 是开发期类型文件，构建期不重写（共享盘上并发回写会 EIO 打断打包）
        dts: command === 'serve' ? 'src/auto-imports.d.ts' : false,
      }),
      Components({
        resolvers: [ElementPlusResolver({
          importStyle: 'sass',
        })],
        dts: command === 'serve' ? 'src/components.d.ts' : false,
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: `@use "@/styles/element-theme.scss" as *; @use "@/styles/container-breakpoints.scss" as *;`,
          api: 'modern-compiler', // 使用现代 Sass API，消除弃用警告
        },
      },
    },
    server: {
      port: WEB_DEV_PORT,
      strictPort: Boolean(process.env.TAURI_ENV_PLATFORM),
      host: process.env.TAURI_DEV_HOST || false,
      cors: true,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
    },
    // 生产构建剔除调试日志（保留 console.error/warn 便于线上问题定位）；dev serve 与 debug 构建不剔除
    esbuild:
      command === 'build' && !process.env.TAURI_ENV_DEBUG
        ? { pure: ['console.log', 'console.info', 'console.debug'], drop: ['debugger'] }
        : {},
    build: {
      target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
      minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
      sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
      rollupOptions: {
        output: {
          // 三个体积大户单独分包：降低主包体积、提升缓存命中（库版本不变则 chunk 不变）
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('element-plus') || id.includes('@element-plus')) return 'element-plus';
            if (id.includes('echarts') || id.includes('zrender')) return 'echarts';
            if (id.includes('@tiptap') || id.includes('prosemirror')) return 'tiptap';
            // 注意：不要给 @vue-flow/@vueuse/d3 做强制分组——与入口链共享依赖时会
            // 造成入口↔分组块循环初始化，生产启动直接 TDZ 白屏（2026-08-30 实测）。
            return undefined;
          },
        },
      },
    },
  }
})
