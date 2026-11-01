<template>
  <EwModal
    v-model:visible="visibleProxy"
    title="画师"
    width="980px"
    :close-on-click-modal="true"
    custom-class="artist-modal"
    @close="handleClose"
  >
    <div class="artist-body">
      <div class="artist-tabs" role="tablist" aria-label="画师主选项卡">
        <div class="tabs-group">
          <div
            class="tab-item"
            role="tab"
            :aria-selected="mainTab === 'create'"
            tabindex="0"
            :class="{ active: mainTab === 'create' }"
            @click="mainTab = 'create'"
            @keydown="onTabKeydown($event, () => (mainTab = 'create'))"
          >
            创作中心
          </div>
          <div
            class="tab-item"
            role="tab"
            :aria-selected="mainTab === 'history'"
            tabindex="0"
            :class="{ active: mainTab === 'history' }"
            @click="mainTab = 'history'"
            @keydown="onTabKeydown($event, () => (mainTab = 'history'))"
          >
            历史图库
          </div>
        </div>
      </div>

      <div v-if="mainTab === 'create'" class="create-wrap">
        <div class="sub-tabs" role="tablist" aria-label="创作中心子选项卡">
          <div class="tabs-group tabs-group--compact">
            <div
              class="tab-item"
              role="tab"
              :aria-selected="createTab === 'character'"
              tabindex="0"
              :class="{ active: createTab === 'character' }"
              @click="createTab = 'character'"
              @keydown="onTabKeydown($event, () => (createTab = 'character'))"
            >
              角色立绘
            </div>
            <div
              class="tab-item"
              role="tab"
              :aria-selected="createTab === 'world'"
              tabindex="0"
              :class="{ active: createTab === 'world' }"
              @click="createTab = 'world'"
              @keydown="onTabKeydown($event, () => (createTab = 'world'))"
            >
              创世神
            </div>
          </div>
        </div>

        <div class="create-grid">
          <div class="left-panel fusion-card">
            <div class="panel-title">
              <i class="fa-regular fa-pen-to-square"></i>
              <span>{{ createTab === 'character' ? '角色立绘' : '创世神' }}</span>
            </div>

            <div class="form-grid model-row">
              <div class="form-item full">
                <label>图片模型</label>
                <ModelChip v-model="imageModelOverride" group-code="image_generation" />
              </div>
            </div>

            <template v-if="createTab === 'character'">
              <div class="form-grid">
                <div class="form-item full">
                  <label>角色名（可选）</label>
                  <input class="ink-input" v-model="characterForm.name" placeholder="例如：林清禾" />
                </div>
                <div class="form-item full">
                  <label>人设描述</label>
                  <textarea
                    class="ink-textarea"
                    v-model="characterForm.prompt"
                    placeholder="外貌、服饰、气质、时代背景、动作、镜头等"
                  ></textarea>
                </div>
                <div class="form-item full">
                  <label>不希望出现（可选）</label>
                  <textarea
                    class="ink-textarea"
                    v-model="characterForm.negativePrompt"
                    placeholder="例如：低清晰度、畸形手、文字水印等"
                  ></textarea>
                </div>
              </div>

              <div class="form-actions">
                <button class="ink-btn ink-btn-outline" type="button" @click="fillCharacterExample" :disabled="generating">
                  示例
                </button>
                <button
                  class="ink-btn ink-btn-primary"
                  type="button"
                  :disabled="generating || !characterForm.prompt.trim()"
                  @click="handleGenerateCharacter"
                >
                  <i v-if="generating" class="fa-solid fa-spinner fa-spin"></i>
                  立即生成
                </button>
              </div>
              <div class="small-tip">生成后会自动保存到历史图库。</div>
            </template>

            <template v-else>
              <div class="form-grid">
                <div class="form-item full">
                  <label>文字描述</label>
                  <textarea
                    class="ink-textarea"
                    v-model="worldForm.prompt"
                    placeholder="例如：两大陆之间由群岛相连，北部雪山，南部沙漠，主城靠海..."
                  ></textarea>
                </div>

                <div class="form-item full">
                  <label>选择风格</label>
                  <div class="style-grid">
                    <button
                      v-for="opt in styleOptions"
                      :key="opt.value"
                      type="button"
                      class="style-card"
                      :class="{ active: worldForm.style === opt.value }"
                      @click="worldForm.style = opt.value"
                    >
                      <div class="style-name">{{ opt.label }}</div>
                      <div class="style-desc">{{ opt.desc }}</div>
                    </button>
                  </div>
                </div>
              </div>

              <div class="form-actions">
                <button class="ink-btn ink-btn-outline" type="button" @click="fillWorldExample" :disabled="generating">
                  示例
                </button>
                <button
                  class="ink-btn ink-btn-primary"
                  type="button"
                  :disabled="generating || !worldForm.prompt.trim()"
                  @click="handleGenerateWorld"
                >
                  <i v-if="generating" class="fa-solid fa-spinner fa-spin"></i>
                  立即生成
                </button>
              </div>
              <div class="small-tip">生成后会自动保存到历史图库。</div>
            </template>
          </div>

          <div class="right-panel fusion-card">
            <div class="panel-title">
              <i class="fa-regular fa-image"></i>
              <span>预览</span>
            </div>
            <div class="preview-box">
              <div v-if="previewUrl && !previewBroken" class="preview-image-wrap">
                <!-- 破图兜底：加载失败转占位提示，避免浏览器直出英文 alt -->
                <img class="preview-image" :src="previewUrl" alt="生成图预览" @error="previewBroken = true" />
              </div>
              <div v-else-if="previewUrl" class="preview-empty">
                <i class="fa-regular fa-image"></i>
                <div class="empty-title">图片加载失败</div>
                <div class="empty-desc">图片可能已过期，请重新生成</div>
              </div>
              <div v-else class="preview-empty">
                <i class="fa-regular fa-images"></i>
                <div class="empty-title">暂无预览</div>
                <div class="empty-desc">在左侧填写描述后生成</div>
              </div>
            </div>

            <div class="preview-actions">
              <button
                class="ink-btn ink-btn-outline"
                type="button"
                :disabled="!previewUrl || downloadingKey !== null"
                @click="downloadPreview"
              >
                <i v-if="downloadingKey === 'preview'" class="fa-solid fa-spinner fa-spin"></i>
                下载图片
              </button>
              <button class="ink-btn ink-btn-ghost" type="button" :disabled="!previewUrl" @click="clearPreview">
                清空预览
              </button>
            </div>

            <div class="history-shortcut">
              <div class="shortcut-text">
                <div class="t1">历史图库</div>
                <div class="t2">已保存 {{ historyTotal || historyList.length }} 张</div>
              </div>
              <button class="ink-btn ink-btn-accent" type="button" @click="mainTab = 'history'">打开</button>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="history-wrap">
        <div class="history-header fusion-card">
          <div class="history-title">
            <div class="t1">历史图库</div>
            <div class="t2">展示当前账号生成的图片记录</div>
          </div>
          <div class="history-actions">
            <button class="ink-btn ink-btn-outline" type="button" @click="exportHistoryJson" :disabled="!historyList.length">
              导出记录
            </button>
            <button class="ink-btn ink-btn-ghost" type="button" @click="clearHistory" :disabled="!historyList.length">
              清空历史
            </button>
          </div>
        </div>

        <div v-if="!historyList.length" class="history-empty fusion-card">
          <i class="fa-regular fa-images"></i>
          <div class="empty-title">还没有历史图片</div>
          <div class="empty-desc">去创作中心生成第一张作品吧</div>
          <button class="ink-btn ink-btn-primary" type="button" @click="mainTab = 'create'">去创作</button>
        </div>

        <div v-else class="history-grid">
          <div class="history-item fusion-card" v-for="item in historyList" :key="item.id">
            <div class="thumb" @click="openPreview(item.imageUrl || '')">
              <!-- 破图兜底：加载失败转占位文案，避免浏览器直出英文 alt -->
              <img v-if="item.imageUrl && !brokenThumbs[item.id]" :src="item.imageUrl" alt="生成图预览" @error="brokenThumbs[item.id] = true" />
              <div v-else class="thumb-empty">{{ item.imageUrl ? '图片已失效' : '暂无图片' }}</div>
            </div>
            <div class="meta">
              <div class="meta-title">{{ getItemTitle(item) }}</div>
              <div class="meta-sub">
                <span>{{ formatDateTimeOrNow(item.createTime) }}</span>
                <span class="dot">·</span>
                <span>{{ sceneLabel(item.scene) }}</span>
                <template v-if="item.style">
                  <span class="dot">·</span>
                  <span>{{ getStyleLabel(item.style) }}</span>
                </template>
              </div>
              <div v-if="item.prompt" class="meta-prompt">{{ item.prompt }}</div>
              <div v-if="item.status === 0 && item.errorMsg" class="meta-error">{{ item.errorMsg }}</div>
            </div>
            <div class="item-actions">
              <button
                class="ink-btn ink-btn-outline"
                type="button"
                :disabled="generating || !item.prompt"
                @click="regenerateHistory(item)"
              >
                <i v-if="regeneratingId === item.id" class="fa-solid fa-spinner fa-spin"></i>
                重新生成
              </button>
              <button
                class="ink-btn ink-btn-outline"
                type="button"
                :disabled="!item.imageUrl || downloadingKey !== null"
                @click="downloadUrl(item.imageUrl || '', getDownloadName(item), item.id)"
              >
                <i v-if="downloadingKey === item.id" class="fa-solid fa-spinner fa-spin"></i>
                下载
              </button>
              <button class="ink-btn ink-btn-ghost" type="button" @click="removeHistory(item.id)">删除</button>
            </div>
          </div>
        </div>
        <div class="history-more" v-if="historyList.length < historyTotal">
          <button class="ink-btn ink-btn-outline" type="button" :disabled="historyLoading" @click="loadHistory(false)">
            <i v-if="historyLoading" class="fa-solid fa-spinner fa-spin"></i>
            加载更多
          </button>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="footer-actions">
        <button class="ink-btn ink-btn-outline" type="button" @click="visibleProxy = false">关闭</button>
      </div>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import EwModal from '@/components/EwModal/index.vue'
import type {
  AiImageHistoryItem,
  AiImageScene,
  AiWorldStyle
} from '@/types/ai-image'
// 开源版：生图与记录全走本地（BYOK 图片模型直连 + IndexedDB 记录）
import {
  clearLocalAiImages as clearAiImagesApi,
  deleteLocalAiImages as deleteAiImagesApi,
  generateLocalAiImage as generateAiImageApi,
  getLocalAiImageHistory as getAiImageHistoryApi,
} from '@/storage/local-ai-images'
import { showApiError } from '@/utils/api-error'
import ModelChip from '@/components/ModelChip.vue'
import { formatDateTimeOrNow } from '@/utils/format'
import { saveBlobFile } from '@/utils/download'
import { fetchImageBlob } from '@/utils/image-proxy'

type ArtistMainTab = 'create' | 'history'
type ArtistCreateTab = 'character' | 'world'

const props = defineProps<{
  visible: boolean
  bookId?: string | number
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const visibleProxy = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val)
})

const onTabKeydown = (e: KeyboardEvent, action: () => void) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    action()
  }
}

const mainTab = ref<ArtistMainTab>('create')
const createTab = ref<ArtistCreateTab>('character')
const generating = ref(false)
const regeneratingId = ref<number | null>(null)

const styleOptions: Array<{ value: AiWorldStyle; label: string; desc: string }> = [
  { value: 'parchment', label: '古风羊皮纸', desc: '更柔和的纸张质感' },
  { value: 'satellite', label: '写实卫星图', desc: '更强调地貌与边界' },
  { value: 'lineart', label: '黑白线稿', desc: '更适合二次标注' },
  { value: 'rpg', label: 'RPG 游戏风', desc: '更有地图 UI 氛围' }
]

const characterForm = reactive({
  name: '',
  prompt: '',
  negativePrompt: ''
})

const worldForm = reactive<{
  prompt: string
  style: AiWorldStyle
}>({
  prompt: '',
  style: 'parchment'
})

const previewUrl = ref<string>('')
// 预览大图破图标记：加载失败（链接过期/CSP 拦截）时转占位提示
const previewBroken = ref(false)
// 下载互斥标记：'preview' 表示预览图，数字为历史记录 id；非空时按钮禁用防重复
const downloadingKey = ref<'preview' | number | null>(null)
const historyList = ref<AiImageHistoryItem[]>([])
// 历史缩略图破图标记：加载失败的条目转占位文案（图片链接可能过期失效）
const brokenThumbs = reactive<Record<string | number, boolean>>({})

const historyLoading = ref(false)
const historyPage = ref(1)
const historySize = ref(20)
const historyTotal = ref(0)

const numericBookId = computed(() => {
  const n = Number(props.bookId)
  // 本地书 id 是负数，非零即有效
  return Number.isFinite(n) && n !== 0 ? n : undefined
})
// 本弹窗临时覆盖模型：空值 = 跟随「AI 模型」页的全局默认；选择不回写全局
const imageModelOverride = ref('')

const loadHistory = async (reset = true) => {
  if (historyLoading.value) return
  historyLoading.value = true
  try {
    const nextPage = reset ? 1 : historyPage.value + 1
    const { data } = await getAiImageHistoryApi({
      bookId: numericBookId.value,
      page: nextPage,
      size: historySize.value
    })
    historyTotal.value = Number(data?.pagination?.total || 0)
    historyPage.value = Number(data?.pagination?.page || nextPage)
    if (reset) historyList.value = data?.list || []
    else historyList.value = [...historyList.value, ...(data?.list || [])]
  } catch (e) {
    console.error('load ai image history failed', e)
    // ElMessage.error('加载失败')
  } finally {
    historyLoading.value = false
  }
}

// 换图后重置破图标记，让新地址重新尝试加载
watch(previewUrl, () => {
  previewBroken.value = false
})

watch(
  () => props.visible,
  async (v) => {
    if (!v) return
    mainTab.value = 'create'
    createTab.value = 'character'
    previewUrl.value = ''
    await loadHistory(true)
    await nextTick()
  }
)

const handleClose = () => {
  generating.value = false
}

const clearPreview = () => {
  previewUrl.value = ''
}

const safeFilename = (name: string) => String(name || 'image').replace(/[\\/:*?"<>|]/g, '_')

// 桌面端禁用 a[download] 下载：跨域 URL 上 download 属性被忽略，退化成顶级导航把主 webview 导航走导致应用卸载。
// 统一改为：代理/直取 blob → saveBlobFile（Tauri 走保存对话框 + write_export_file，网页走 a[download] objectURL）。
const downloadUrl = async (url: string, filename: string, key: 'preview' | number) => {
  if (!url || downloadingKey.value !== null) return
  downloadingKey.value = key
  try {
    const blob = await fetchImageBlob(url)
    const saved = await saveBlobFile(blob, safeFilename(filename))
    if (saved) {
      ElMessage.success('下载成功')
    }
  } catch (e) {
    console.error('download failed', e)
    ElMessage.error('下载失败，图片可能已过期')
  } finally {
    downloadingKey.value = null
  }
}

const downloadPreview = async () => {
  if (!previewUrl.value) return
  const suffix = createTab.value === 'world' ? getStyleLabel(worldForm.style) || 'world' : 'character'
  const filename = `作品-${suffix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.png`
  await downloadUrl(previewUrl.value, filename, 'preview')
}

const openPreview = (url: string) => {
  previewUrl.value = url
  mainTab.value = 'create'
}

const exportHistoryJson = async () => {
  try {
    // mac WKWebView 对 a[download] 不可靠，统一走 saveBlobFile
    const blob = new Blob([JSON.stringify(historyList.value, null, 2)], { type: 'application/json' })
    const filename = `画师-历史图库-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`
    const saved = await saveBlobFile(blob, filename)
    if (saved) {
      ElMessage.success('导出成功')
    }
  } catch (e) {
    console.error('export history failed', e)
    ElMessage.error('导出失败')
  }
}

const sceneLabel = (scene: string) => {
  if (scene === 'character') return '角色立绘'
  if (scene === 'world') return '创世神'
  return scene || ''
}

const getStyleLabel = (style?: string) => styleOptions.find((x) => x.value === style)?.label || style || ''

const getItemTitle = (item: AiImageHistoryItem) => (item.title || '').trim() || sceneLabel(item.scene)

const getDownloadName = (item: AiImageHistoryItem) => {
  const title = safeFilename(getItemTitle(item) || 'image')
  const style = getStyleLabel(item.style).trim()
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return style ? safeFilename(`${title}-${style}-${date}.png`) : safeFilename(`${title}-${date}.png`)
}

const clearHistory = async () => {
  try {
    await inkConfirm('清空后历史图库中的所有图片记录都将删除，确定继续吗？', '清空历史确认', {
      type: 'warning',
      confirmButtonText: '确认清空',
      cancelButtonText: '取消',
      confirmButtonClass: 'danger-confirm-btn',
      closeOnClickModal: false
    })
    await clearAiImagesApi({ bookId: numericBookId.value })
    await loadHistory(true)
    ElMessage.success('已清空历史')
  } catch (e) {
    if (e === 'cancel' || e === 'close') return
    console.error('clear history failed', e)
    showApiError(e, '清空失败')
  }
}

const removeHistory = async (id: number) => {
  try {
    await inkConfirm('删除后该图片记录不可恢复，确定删除吗？', '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'danger-confirm-btn',
      closeOnClickModal: false
    })
    await deleteAiImagesApi({ ids: [Number(id)] })
    historyList.value = historyList.value.filter((x) => Number(x.id) !== Number(id))
    historyTotal.value = Math.max(historyTotal.value - 1, 0)
    ElMessage.success('已删除')
  } catch (e) {
    if (e === 'cancel' || e === 'close') return
    console.error('delete history failed', e)
    showApiError(e, '删除失败')
  }
}

const fillCharacterExample = () => {
  characterForm.name = characterForm.name || '林清禾'
  characterForm.prompt =
    characterForm.prompt ||
    '一位温柔克制的青年书生，黑发束冠，衣袍素雅，手持折扇，站在雨巷的青石路上，水墨淡雅风，半身立绘，柔光'
  characterForm.negativePrompt = characterForm.negativePrompt || '低清晰度、畸形手、文字水印、过曝'
}

const fillWorldExample = () => {
  worldForm.prompt =
    worldForm.prompt ||
    '大陆呈弯月形，东侧沿海主城，北部雪山与冰原，南部沙漠与古遗迹，中部河网纵横，西侧群岛散落；标注主要地貌与城邦位置'
}

const showGenerateError = (error: unknown, fallback: string) => {
  showApiError(error, fallback)
}

const handleGenerateCharacter = async () => {
  if (!characterForm.prompt.trim()) return
  generating.value = true
  try {
    const title = characterForm.name?.trim() ? `角色立绘：${characterForm.name.trim()}` : '角色立绘'
    const { data } = await generateAiImageApi({
      scene: 'character',
      title,
      prompt: characterForm.prompt.trim(),
      negativePrompt: characterForm.negativePrompt.trim() || undefined,
      bookId: numericBookId.value,
      // 仅在弹窗临时选了模型时显式携带；空值由服务端按「全局默认 → 平台默认」解析
      model: imageModelOverride.value || undefined
    })
    previewUrl.value = data?.imageUrl || ''
    await loadHistory(true)
    ElMessage.success('已生成')
  } catch (e) {
    console.error('generate character failed', e)
    showGenerateError(e, '生成失败')
  } finally {
    generating.value = false
  }
}

const regenerateHistory = async (item: AiImageHistoryItem) => {
  const prompt = (item.prompt || '').trim()
  if (!prompt) {
    ElMessage.warning('该记录缺少提示词，无法重新生成')
    return
  }
  if (generating.value) return
  generating.value = true
  regeneratingId.value = item.id
  try {
    const scene = item.scene === 'world' || item.scene === 'cover' ? item.scene : 'character'
    const { data } = await generateAiImageApi({
      scene: scene as AiImageScene,
      title: item.title || undefined,
      prompt,
      negativePrompt: item.negativePrompt?.trim() || undefined,
      style: item.style || undefined,
      bookId: numericBookId.value,
      // 重新生成与新生成同口径：仅临时覆盖时显式携带
      model: imageModelOverride.value || undefined
    })
    previewUrl.value = data?.imageUrl || ''
    await loadHistory(true)
    ElMessage.success('已重新生成')
  } catch (e) {
    console.error('regenerate image failed', e)
    showGenerateError(e, '重新生成失败')
  } finally {
    generating.value = false
    regeneratingId.value = null
  }
}

const handleGenerateWorld = async () => {
  if (!worldForm.prompt.trim()) return
  generating.value = true
  try {
    const title = '创世神：世界纲地图'
    const { data } = await generateAiImageApi({
      scene: 'world',
      title,
      prompt: worldForm.prompt.trim(),
      style: worldForm.style,
      bookId: numericBookId.value
    })
    previewUrl.value = data?.imageUrl || ''
    await loadHistory(true)
    ElMessage.success('已生成')
  } catch (e) {
    console.error('generate world failed', e)
    showGenerateError(e, '世界地图生成失败')
  } finally {
    generating.value = false
  }
}
</script>

<style scoped lang="scss">
.artist-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 2px 0;
}

.artist-tabs,
.sub-tabs {
  display: flex;
  align-items: center;
  padding: 0 2px;
}

.artist-tabs {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
}

.sub-tabs {
  margin-top: 6px;
}

.tabs-group {
  display: inline-flex;
  align-items: center;
  gap: 16px;
}

.tabs-group--compact {
  gap: 12px;
}

.tab-item {
  user-select: none;
  cursor: pointer;
  border-radius: 10px;
  padding: 8px 4px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 700;
  color: var(--ink-sec);
  transition: all 0.2s ease;
  position: relative;

  &:hover {
    color: var(--ink-main);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--selection-bg-color);
  }

  &.active {
    color: var(--ink-main);
  }

  &::after {
    content: '';
    position: absolute;
    left: 2px;
    right: 2px;
    bottom: 0;
    height: 2px;
    border-radius: 999px;
    background: transparent;
    transition: background 0.2s ease;
  }

  &.active::after {
    background: var(--ink-accent);
  }
}

.tabs-group--compact .tab-item {
  padding: 8px 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.create-grid {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  gap: 12px;
  margin-top: 12px;
}

.left-panel,
.right-panel {
  border-radius: 16px;
  padding: 16px 16px 12px;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  color: var(--ink-main);
  margin-bottom: 10px;

  i {
    color: var(--ink-accent);
  }
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;

  .form-item {
    display: flex;
    flex-direction: column;
    gap: 6px;

    &.full {
      grid-column: 1 / -1;
    }

    label {
      font-size: calc(12px * var(--ui-font-scale, 1));
      color: var(--ink-sec);
    }
  }
}

.form-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.small-tip {
  margin-top: 10px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
}

.style-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.style-card {
  border: 1px solid var(--ui-border);
  background: var(--ui-glass-bg);
  border-radius: 14px;
  padding: 12px 12px 10px;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    background: var(--ui-glass-bg-hover);
    border-color: var(--ui-border-hover);
  }

  &.active {
    border-color: var(--ink-accent);
  }
}

.style-name {
  font-weight: 700;
  color: var(--ink-main);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.style-desc {
  margin-top: 6px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.4;
}

.preview-box {
  border-radius: 14px;
  border: 1px solid var(--ui-border);
  background: var(--panel-bg);
  overflow: hidden;
  height: 320px;
  display: flex;
  align-items: stretch;
  justify-content: center;
}

.preview-image-wrap {
  width: 100%;
  height: 100%;
  display: flex;
}

.preview-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--ink-sec);

  i {
    font-size: calc(18px * var(--ui-font-scale, 1));
  }

  .empty-title {
    font-weight: 700;
    color: var(--ink-main);
  }

  .empty-desc {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }
}

.preview-actions {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.history-shortcut {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--ui-border);
  padding-top: 12px;

  .shortcut-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--ink-sec);

    .t1 {
      font-weight: 700;
      color: var(--ink-main);
    }
    .t2 {
      font-size: calc(12px * var(--ui-font-scale, 1));
    }
  }
}

.history-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 16px;
}

.history-title {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .t1 {
    font-weight: 700;
    color: var(--ink-main);
  }
  .t2 {
    font-size: calc(12px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
  }
}

.history-actions {
  display: inline-flex;
  gap: 10px;
}

.history-empty {
  padding: 26px 16px;
  border-radius: 16px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--ink-sec);

  i {
    font-size: calc(20px * var(--ui-font-scale, 1));
  }

  .empty-title {
    font-weight: 700;
    color: var(--ink-main);
  }

  .empty-desc {
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.history-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  overflow: auto;
  max-height: calc(76vh - 240px);
}

.history-more {
  display: flex;
  justify-content: center;
  padding: 6px 0 2px;
}

.history-item {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 12px;
  padding: 12px;
  border-radius: 16px;
}

.thumb {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  background: var(--panel-bg);
  cursor: pointer;

  img {
    width: 100%;
    height: 120px;
    object-fit: cover;
    display: block;
  }

  .thumb-empty {
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.meta-title {
  font-weight: 700;
  color: var(--ink-main);
}

.meta-sub {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;

  .dot {
    opacity: 0.7;
  }
}

.meta-prompt {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  line-height: 1.5;
  max-height: 54px;
  overflow: hidden;
}

.meta-error {
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--state-danger);
  line-height: 1.4;
  max-height: 40px;
  overflow: hidden;
}

.item-actions {
  grid-column: 2 / 3;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.footer-actions {
  display: flex;
  justify-content: flex-end;
}

:deep(.artist-modal .ew-modal-body) {
  overflow: hidden;
  padding: 10px 16px 14px;
}

:deep(.artist-modal) {
  max-height: 86vh;
}

/* 让输入/编辑框更“像编辑器”，边框更清晰 */
:deep(.artist-modal input.ink-input),
:deep(.artist-modal textarea) {
  border-color: var(--ui-border);
  background: var(--ui-glass-bg);
}

:deep(.artist-modal input.ink-input:focus),
:deep(.artist-modal textarea:focus) {
  border-color: var(--input-focus-border);
}

@media (max-width: 980px) {
  .create-grid {
    grid-template-columns: 1fr;
  }
  .history-grid {
    grid-template-columns: 1fr;
  }
  .history-item {
    grid-template-columns: 120px 1fr;
  }
}
</style>
