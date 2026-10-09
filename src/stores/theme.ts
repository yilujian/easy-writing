import { appSettings } from '@/storage/app-settings'
import { defineStore } from 'pinia'
import { clearCustomSkinImage, loadCustomSkinImage, saveCustomSkinImage } from '@/storage/local-skin'
import { ref, watch } from 'vue'
// 皮肤背景图打包进本地资源（原先指向已失效的第三方 CDN，导致全站破图与大量失败请求）
import bg1 from '@/assets/images/bg/bg1.jpg'
import bg2 from '@/assets/images/bg/bg2.jpg'
import bg3 from '@/assets/images/bg/bg3.jpg'
import bg4 from '@/assets/images/bg/bg4.jpg'
import bg5 from '@/assets/images/bg/bg5.jpg'
import bg6 from '@/assets/images/bg/bg6.jpg'
import bg7 from '@/assets/images/bg/bg7.jpg'
import bg8 from '@/assets/images/bg/bg8.jpg'

// 皮肤定义
export interface Skin {
  name: string
  img: string
  style: string
}

// 皮肤组定义
export interface SkinGroup {
  name: string
  icon: string
  skins: Skin[]
}

// 主题类型定义
export interface ThemeConfig {
  value: string
  label: string
  icon: string
  colors: {
    main: string      // 主要文字颜色
    secondary: string // 次要文字颜色
    accent: string    // 强调色
    bg: string        // 背景色
  }
  filter: string          // 图片滤镜效果
  opacity: number         // 图片透明度
}

// 主题配置
const themeConfigs: Record<string, ThemeConfig> = {
  new: {
    value: 'new',
    label: '无界通透版',
    icon: 'fa-solid fa-droplet',
    colors: {
      main: '#241F1B',
      secondary: '#655E56',
      accent: '#7A3028',
      bg: '#F2F0EA'
    },
    filter: 'grayscale(100%) contrast(110%)',
    opacity: 0.12
  },
  yellow: {
    value: 'yellow',
    label: '古韵信笺版',
    icon: 'fa-solid fa-scroll',
    colors: {
      main: '#34271F',
      secondary: '#6B5849',
      accent: '#8B4A2F',
      bg: '#E9DFCC'
    },
    filter: 'sepia(0.6) saturate(0.8) contrast(0.95) brightness(1.05)',
    opacity: 0.15
  },
  green: {
    value: 'green',
    label: '森系护眼版',
    icon: 'fa-solid fa-leaf',
    colors: {
      main: '#263028',
      secondary: '#59645A',
      accent: '#52634F',
      bg: '#E5E6DB'
    },
    filter: 'sepia(0.3) hue-rotate(80deg) saturate(0.5) contrast(0.95)',
    opacity: 0.12
  },
  dark: {
    value: 'dark',
    label: '暗夜水墨版',
    icon: 'fa-solid fa-moon',
    colors: {
      main: '#ECE7DC',
      secondary: '#BCB5A8',
      accent: '#9F472F',
      bg: '#171714'
    },
    filter: 'grayscale(100%) brightness(60%) contrast(130%)',
    opacity: 0.2
  }
}

// 所有可用皮肤（背景图）
const skinGroups: SkinGroup[] = [
  {
    name: '古韵东方',
    icon: 'fa-solid fa-mountain-sun',
    skins: [
      { name: '水墨云烟', img: bg1, style: '' },
      { name: '竹影清风', img: bg2, style: 'filter: sepia(0.3);' },
      { name: '千里江山', img: bg3, style: 'filter: hue-rotate(180deg) saturate(0.5);' },
      { name: '龙腾墨海', img: bg4, style: 'filter: grayscale(1);' },
      { name: '龙战于林', img: bg5, style: 'filter: grayscale(1);' }
    ]
  },
  {
    name: '幻想次元',
    icon: 'fa-solid fa-rocket',
    skins: [
      { name: '决战都市', img: bg6, style: '' },
      { name: '落樱拔刀', img: bg7, style: '' },
      { name: '魔丸', img: bg8, style: '' }
    ]
  }
]

// 创建皮肤映射表，方便查找
const skinMap = new Map<string, Skin>()
skinGroups.forEach(group => {
  group.skins.forEach(skin => {
    skinMap.set(skin.name, skin)
  })
})

// 默认皮肤
const DEFAULT_SKIN = skinGroups[0].skins[0]

const STORAGE_KEY = 'ew-theme'
const SKIN_STORAGE_KEY = 'ew-skin'
const CUSTOM_SKIN_URL_KEY = 'ew-custom-skin-url'
const CUSTOM_SKIN_NAME = '__custom__'

export const useThemeStore = defineStore('theme', () => {
  // 当前主题
  const currentTheme = ref<string>('new')

  // 获取当前主题配置
  const themeConfig = ref<ThemeConfig>(themeConfigs['new'])

  // 所有主题列表
  const themes = Object.values(themeConfigs)

  // 当前皮肤
  const currentSkin = ref<string>(DEFAULT_SKIN.name)

  // 当前皮肤对象
  const currentSkinObj = ref<Skin>(DEFAULT_SKIN)

  // 初始化：从 localStorage 加载主题和皮肤
  const initTheme = () => {
    // 加载主题
    const savedTheme = appSettings.getItem(STORAGE_KEY)
    if (savedTheme && themeConfigs[savedTheme]) {
      currentTheme.value = savedTheme
      themeConfig.value = themeConfigs[savedTheme]
    }

    // 加载皮肤
    const savedSkin = appSettings.getItem(SKIN_STORAGE_KEY)
    // 旧版本把服务端图片 URL 存在 localStorage，服务端已下线，见到就清
    appSettings.removeItem(CUSTOM_SKIN_URL_KEY)
    if (savedSkin === CUSTOM_SKIN_NAME) {
      // 自定义背景异步取回。没有记录（旧版本残留）才回落默认皮肤并写回设置；
      // 读取失败（附件缺失、存储暂时不可用）只在本次会话用默认图，不改写用户的选择
      void loadCustomSkinImage()
        .then(dataUrl => {
          if (!dataUrl) {
            currentSkin.value = DEFAULT_SKIN.name
            currentSkinObj.value = DEFAULT_SKIN
            appSettings.setItem(SKIN_STORAGE_KEY, DEFAULT_SKIN.name)
            return
          }
          currentSkin.value = CUSTOM_SKIN_NAME
          currentSkinObj.value = {
            name: '自定义背景',
            img: dataUrl,
            style: ''
          }
        })
        .catch(error => {
          console.warn('自定义背景读取失败，本次使用默认背景，设置未改动', error)
          currentSkin.value = CUSTOM_SKIN_NAME
          currentSkinObj.value = DEFAULT_SKIN
        })
    } else if (savedSkin && skinMap.has(savedSkin)) {
      currentSkin.value = savedSkin
      currentSkinObj.value = skinMap.get(savedSkin)!
    }

    applyTheme()
  }

  // 切换主题
  const switchTheme = (theme: string) => {
    if (!themeConfigs[theme]) {
      console.warn(`Theme "${theme}" not found, using default theme`)
      return
    }

    currentTheme.value = theme
    themeConfig.value = themeConfigs[theme]

    // 保存到本地存储
    appSettings.setItem(STORAGE_KEY, theme)

    // 应用主题
    applyTheme()
  }

  // 切换皮肤（背景图）
  const switchSkin = (skinName: string) => {
    const skin = skinMap.get(skinName)
    if (!skin) {
      console.warn(`Skin "${skinName}" not found, using default skin`)
      return
    }

    currentSkin.value = skinName
    currentSkinObj.value = skin
    appSettings.removeItem(CUSTOM_SKIN_URL_KEY)
    void clearCustomSkinImage()

    // 保存到本地存储
    appSettings.setItem(SKIN_STORAGE_KEY, skinName)

    // 应用皮肤
    applySkin()
  }

  // 先把图片落盘，成功了才改指针；否则会留下"指向自定义背景但没有图"的设置
  const setCustomSkin = async (dataUrl: string) => {
    const value = String(dataUrl || '').trim()
    if (!value) return
    await saveCustomSkinImage(value)
    currentSkin.value = CUSTOM_SKIN_NAME
    currentSkinObj.value = {
      name: '自定义背景',
      img: value,
      style: ''
    }
    appSettings.setItem(SKIN_STORAGE_KEY, CUSTOM_SKIN_NAME)
    applySkin()
  }

  // 应用主题到 document
  const applyTheme = () => {
    const config = themeConfig.value

    // 移除所有主题类
    document.documentElement.classList.remove('theme-new', 'theme-yellow', 'theme-green', 'theme-dark')

    // 添加当前主题类
    document.documentElement.classList.add(`theme-${config.value}`)

    // 颜色变量统一由 themes.scss 的主题类提供；这里只下发背景图滤镜参数。
    // （历史版本曾把四个颜色内联写在根元素上，会压过主题类定义，已移除。）
    document.documentElement.style.setProperty('--theme-bg-filter', config.filter)
    document.documentElement.style.setProperty('--theme-bg-opacity', config.opacity.toString())
  }

  // 应用皮肤（背景图通过 Vue 响应式绑定自动更新，无需手动操作）
  const applySkin = () => {
    // 背景图已通过 currentSkinObj.img 响应式绑定到模板
    // 此方法保留以便将来扩展其他皮肤相关功能
  }

  // 监听主题变化
  watch(currentTheme, () => {
    applyTheme()
  })

  // 监听皮肤变化
  watch(currentSkin, () => {
    applySkin()
  })

  return {
    currentTheme,
    themeConfig,
    themes,
    themeConfigs,
    switchTheme,
    initTheme,
    // 皮肤相关
    currentSkin,
    currentSkinObj,
    skinGroups,
    switchSkin,
    setCustomSkin
  }
})
