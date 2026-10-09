<template>
      <el-popover
placement="bottom" :width="340" trigger="click" popper-class="skin-popover" :show-after="0"
        :offset="12">
        <template #reference>
          <button class="icon-button theme-btn glass-element" style="margin-right: 12px;">
            <i class="fa-solid fa-shirt"></i>
          </button>
        </template>

        <div class="skin-panel">
          <div class="skin-header">
            <span class="title">个性换肤</span>
            <span class="reset-btn" @click="handleResetSkin">恢复默认</span>
          </div>

          <div class="skin-content">
            <div v-for="(group, index) in themeStore.skinGroups" :key="index" class="skin-group">
              <h4 class="group-title">
                <i :class="group.icon"></i> {{ group.name }}
              </h4>
              <div class="skin-grid">
                <div
v-for="skin in group.skins" :key="skin.name" class="skin-card"
                  :class="{ active: themeStore.currentSkin === skin.name }" @click="handleSkinChange(skin.name)">
                  <img :src="skin.img" class="skin-img" :alt="skin.name" :style="skin.style">
                  <div class="skin-label">{{ skin.name }}</div>
                  <div class="check-mark" v-if="themeStore.currentSkin === skin.name">
                    <i class="fa-solid fa-check"></i>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="skin-footer">
            <button class="custom-bg-btn" type="button" @click="triggerCustomBgUpload">
              <i class="fa-solid fa-plus"></i> 自定义背景图
            </button>
            <input ref="customBgInputRef" type="file" accept="image/*" class="hidden-upload" @change="handleCustomBgChange" />
          </div>
        </div>
      </el-popover>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
const customBgInputRef = ref<HTMLInputElement | null>(null)

// 皮肤切换
const handleSkinChange = (skinName: string) => {
  themeStore.switchSkin(skinName)
}

// 恢复默认皮肤
const handleResetSkin = () => {
  const defaultSkin = themeStore.skinGroups[0].skins[0].name
  themeStore.switchSkin(defaultSkin)
}

const triggerCustomBgUpload = () => {
  customBgInputRef.value?.click()
}

// 自定义背景全程本地处理：读成 dataURL 存进本机图库，不经过任何服务器
const CUSTOM_BG_MAX_MB = 10

const readFileAsDataUrl = (file: File) => {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const handleCustomBgChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    if (!file.type.startsWith('image/')) {
      ElMessage.warning('请选择图片文件')
      return
    }
    if (file.size > CUSTOM_BG_MAX_MB * 1024 * 1024) {
      ElMessage.warning(`图片不能超过 ${CUSTOM_BG_MAX_MB}MB`)
      return
    }
    const dataUrl = await readFileAsDataUrl(file)
    if (!dataUrl) {
      ElMessage.error('图片读取失败，请换一张试试')
      return
    }
    await themeStore.setCustomSkin(dataUrl)
    ElMessage.success('自定义背景已应用')
  } catch (error: unknown) {
    console.error('apply custom background failed', error)
    ElMessage.error('背景图片读取或保存失败，请换一张试试')
  } finally {
    input.value = ''
  }
}
</script>

<style scoped lang="scss">
.glass-element {
  background: var(--ui-glass-bg);
  backdrop-filter: blur(12px);
  border: 1px solid var(--ui-border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
  color: var(--ink-sec);
  transition: all 0.3s ease;

  &:hover {
    background: var(--ui-glass-bg-hover);
    border-color: var(--ui-border-hover);
    color: var(--ink-main);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  }
}

.icon-button {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;

  i {
    font-size: 18px;
  }
}

.hidden-upload {
  display: none;
}
</style>

<style>
/* 换肤弹层传送到 body，样式必须全局（面板容器样式在 ink.scss 的 .skin-popover） */
.skin-panel {
    width: 100%;
  }

.skin-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--ui-border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    /* opacity: 0.3; */

    .title {
      font-size: 14px;
      font-weight: bold;
      color: var(--ink-main);
      letter-spacing: 1px;
    }

    .reset-btn {
      font-size: 12px;
      color: var(--ink-sec);
      cursor: pointer;
      transition: color 0.2s;

      &:hover {
        color: var(--ink-accent);
      }
    }
  }

.skin-content {
    max-height: 400px;
    overflow-y: auto;
    padding: 12px;

    /* &::-webkit-scrollbar {
      width: 4px;
    }

    &::-webkit-scrollbar-thumb {
      background: var(--ui-border);
      border-radius: 2px;
      opacity: 0.5;
      transition: opacity 0.3s;

      &:hover {
        opacity: 0.8;
      }
    } */
  }

.skin-group {
    margin-bottom: 16px;

    &:last-child {
      margin-bottom: 0;
    }
  }

.group-title {
    font-size: 12px;
    color: var(--ink-sec);
    margin-bottom: 8px;
    padding-left: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

.skin-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

.skin-card {
    position: relative;
    aspect-ratio: 16/9;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    border: 2px solid transparent;
    transition: all 0.2s;

    &:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }

    &.active {
      border-color: var(--ink-accent);
    }

    .skin-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .skin-label {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent);
      color: white;
      font-size: 12px;
      padding: 16px 8px 4px;
      text-align: center;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    }

    .check-mark {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 16px;
      height: 16px;
      background: var(--ink-accent);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 10px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
  }

.skin-footer {
    padding: 12px;
    border-top: 1px solid var(--ui-border);

    .custom-bg-btn {
      width: 100%;
      min-height: 38px;
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px dashed color-mix(in srgb, var(--ink-accent) 72%, var(--ink-main));
      background: color-mix(in srgb, var(--ink-accent) 12%, var(--bg-main));
      color: color-mix(in srgb, var(--ink-accent) 68%, var(--ink-main));
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);

      i {
        color: var(--ink-accent);
      }

      &:hover {
        border-color: var(--ink-accent);
        color: var(--bg-main);
        background: var(--ink-accent);
        box-shadow: 0 6px 16px color-mix(in srgb, var(--ink-accent) 30%, transparent);
        transform: translateY(-1px);

        i {
          color: var(--bg-main);
        }
      }
    }
  }
</style>
