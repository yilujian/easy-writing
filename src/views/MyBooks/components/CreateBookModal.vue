<template>
  <EwModal v-model:visible="visibleProxy" title="新建作品" width="min(920px, calc(100vw - 32px))" :close-on-click-modal="true" @close="close">
    <!-- 内容滚动区 -->
    <div class="content-wrapper">

      <!-- 左侧：封面区 (保持竖版书封比例) -->
      <div class="cover-section">
        <label class="upload-label group">
          <input type="file" class="hidden-input" accept="image/*" @change="handleFileChange">
          <!-- 如果有图片显示图片，没有显示上传框 -->
          <div v-if="coverUrl" class="preview-box">
            <img :src="coverUrl" alt="封面" class="cover-img" />
            <div class="hover-mask"><i class="fa-solid fa-pen"></i></div>
          </div>
          <div v-else class="upload-box">
            <i class="fa-solid fa-plus upload-icon"></i>
            <span class="upload-text">上传封面</span>
            <span class="upload-hint">建议 600x900</span>
          </div>
        </label>
        <div class="ai-draw-btn-wrapper">
          <button class="ai-draw-btn" type="button" @click="openAiCover">
            <i class="fa-solid fa-wand-magic-sparkles"></i> AI 智能绘图
          </button>
        </div>
      </div>

      <!-- 右侧：表单区 -->
      <div class="form-section">

        <!-- 1. 书名 -->
        <div class="form-item">
          <label class="form-label">书名</label>
          <div class="input-wrapper">
            <input type="text" v-model="form.title" class="ink-input-underline title-input" placeholder="请输入作品名称">
            <i class="fa-solid fa-pen-nib input-icon"></i>
          </div>
        </div>

        <!-- 2. 首发平台 -->
        <div class="form-item">
          <label class="form-label">首发平台</label>
          <div class="radio-group">
            <div class="radio-wrapper" v-for="pf in platforms" :key="pf.value">
              <input type="radio" v-model="form.platform" :value="pf.value" :id="`pf-${pf.value}`" class="hidden-radio">
              <label :for="`pf-${pf.value}`" class="radio-label">
                <span class="dot" :class="pf.colorClass"></span> {{ pf.label }}
              </label>
            </div>
          </div>
        </div>

        <!-- 3. 作品视角 (新增) -->
        <div class="form-item">
          <label class="form-label">作品视角</label>
          <div class="radio-group">
            <div class="radio-wrapper">
              <input type="radio" v-model="form.perspective" value="第一人称" id="p-first" class="hidden-radio">
              <label for="p-first" class="radio-label">
                第一人称
              </label>
            </div>
            <div class="radio-wrapper">
              <input type="radio" v-model="form.perspective" value="第三人称" id="p-third" class="hidden-radio">
              <label for="p-third" class="radio-label">
                第三人称
              </label>
            </div>
          </div>
        </div>

        <!-- 4. 目标读者 (新增) -->
        <div class="form-item">
          <label class="form-label">目标读者</label>
          <div class="radio-group">
            <div class="radio-wrapper">
              <input type="radio" v-model="form.audience" value="male" id="aud-male" class="hidden-radio">
              <label for="aud-male" class="radio-label">
                <span class="dot blue"></span> 男频
              </label>
            </div>
            <div class="radio-wrapper">
              <input type="radio" v-model="form.audience" value="female" id="aud-female" class="hidden-radio">
              <label for="aud-female" class="radio-label">
                <span class="dot pink"></span> 女频
              </label>
            </div>
            <div class="radio-wrapper">
              <input type="radio" v-model="form.audience" value="pub" id="aud-pub" class="hidden-radio">
              <label for="aud-pub" class="radio-label">
                <span class="dot green"></span> 出版/全频
              </label>
            </div>
          </div>
        </div>

        <!-- 5. 分类 (独立一行) -->
        <div class="form-item">
          <label class="form-label">分类</label>
          <div class="select-wrapper">
            <el-select
clearable placeholder="请选择分类" v-model="form.category" class="ink-select"
              popper-class="ink-select-popper">
              <el-option v-for="item in categories" :key="item" :label="item" :value="item" />
            </el-select>
          </div>
        </div>

        <div class="form-item">
          <label class="form-label">作品分组</label>
          <div class="select-wrapper">
            <el-select
clearable placeholder="未分组" v-model="form.groupId" class="ink-select"
              popper-class="ink-select-popper">
              <el-option label="未分组" value="" />
              <el-option v-for="item in bookGroups" :key="item.id" :label="item.title" :value="String(item.id)" />
            </el-select>
          </div>
        </div>

        <!-- 6. 标签 (独立一行) -->
        <div class="form-item">
          <label class="form-label">标签</label>
          <div class="tags-input-wrapper">
            <span v-for="(tag, index) in form.tags" :key="index" class="tag-item animate-fade-in">
              {{ tag }}
              <i class="fa-solid fa-xmark tag-close" @click="removeTag(index)"></i>
            </span>
            <input
type="text" v-model="tagInput" @keydown.enter.prevent="addTag" @keydown.delete="handleBackspace"
              class="ink-input-underline tag-input" placeholder="+ 添加标签 (回车)">
          </div>
        </div>

        <!-- 7. 简介 -->
        <div class="form-item intro-item">
          <div class="intro-header">
            <label class="form-label">作品简介</label>
            <!-- AI 辅助按钮组 (放在标题栏) -->
            <div class="ai-toolbar">
              <button
class="text-btn" :class="{ loading: introGenerateLoading }" :disabled="introGenerateLoading"
                title="根据书名和标签自动生成" @click="handleIntroGenerate">
                <i :class="['fa-solid', introGenerateLoading ? 'fa-spinner fa-spin' : 'fa-rotate-right']"></i>
                {{ introGenerateLoading ? '生成中...' : '生成' }}
              </button>
              <button
class="ai-btn-glow" :class="{ loading: introPolishLoading }" :disabled="introPolishLoading"
                @click="handleIntroPolish">
                <i :class="['fa-solid', introPolishLoading ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles']"></i>
                {{ introPolishLoading ? '润色中...' : 'AI 润色' }}
              </button>
              <button
v-if="canUndoIntroPolish" class="text-btn undo-btn" type="button" title="恢复 AI 润色前内容"
                @click="handleIntroUndo">
                <i class="fa-solid fa-rotate-left"></i>
                撤销
              </button>
            </div>
          </div>

          <div class="textarea-wrapper">
            <textarea
v-model="form.intro" class="intro-textarea" rows="7" maxlength="500"
              placeholder="请输入作品简介，精彩的简介能吸引更多读者..."></textarea>
            <span class="char-count">{{ introCount }}/500</span>
          </div>
        </div>

      </div>
    </div>

    <!-- 底部按钮 -->
    <template #footer>
      <button class="ink-btn ink-btn-outline" :disabled="submitLoading" @click="close">取消</button>
      <button class="ink-btn ink-btn-primary" :disabled="submitLoading" @click="submit">
        <i :class="['fa-solid', submitLoading ? 'fa-spinner fa-spin' : 'fa-feather-pointed']"></i>
        {{ submitLoading ? '处理中...' : '落笔' }}
      </button>
    </template>

    <AICreateCover v-model:visible="aiCoverVisible" :book-title="form.title" @apply="handleAiCoverApply" />
  </EwModal>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, PropType, onBeforeUnmount } from 'vue';
import EwModal from '@/components/EwModal/index.vue';
import AICreateCover from '@/views/Home/components/AICreateCover.vue';
import { Book, BookGroup } from '@/types';
import { ElMessage } from 'element-plus';
import { BOOK_CATEGORIES } from '@/utils/constants';
// 开源版：简介生成/润色走本地 BYOK 直连
import { requestLocalChatCompletion, NO_MODEL_MESSAGE } from '@/utils/local-ai-client';
import { buildBookIntroMessages } from '@/config/ai-prompts'
import { promptTemperature } from '@/storage/local-prompts';
import { useAiModelStore } from '@/stores/ai-model';
import { getLocalLibraryStorage } from '@/storage/local-library';

const props = defineProps({
  visible: { type: Boolean, default: false },
  bookData: { type: Object as PropType<Book | null>, default: null },
  bookGroups: { type: Array as PropType<BookGroup[]>, default: () => [] }
});

const emit = defineEmits<{
  'update:visible': [value: boolean]
  close: []
  success: [book?: Book]
}>();

const visibleProxy = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val)
});

// --- Data ---
const form = reactive({
  id: undefined as number | undefined,
  title: '',
  platform: '起点中文网',
  perspective: '第三人称', // 第一人称 | 第三人称（中文值，直接进 AI 提示词）
  audience: 'male',     // male | female | pub
  category: '',
  groupId: '',
  tags: ['系统', '腹黑'] as string[],
  intro: '',
  coverUrl: ''
});

const coverUrl = ref(''); // 用于存储封面预览图URL
const coverPreviewObjectUrl = ref<string | null>(null);
const aiCoverVisible = ref(false);
const tagInput = ref('');
const introGenerateLoading = ref(false);
const introPolishLoading = ref(false);
const submitLoading = ref(false);
const introGenerateController = ref<AbortController | null>(null);
const introPolishController = ref<AbortController | null>(null);
const introUndoSnapshot = ref<{ originalIntro: string } | null>(null);
const canUndoIntroPolish = computed(() => !!introUndoSnapshot.value && !introPolishLoading.value);
const localLibrary = getLocalLibraryStorage();
const aiModelStore = useAiModelStore();

// --- Watch ---
watch(() => props.visible, (val) => {
  introUndoSnapshot.value = null;
  if (val) {
    if (props.bookData) {
      // 编辑模式
      form.id = props.bookData.id;
      form.title = props.bookData.title;
      form.platform = normalizeBookPlatform(props.bookData.platform);
      form.perspective = normalizeBookPerspective(props.bookData.perspective);
      form.audience = props.bookData.audience || 'male';
      form.category = props.bookData.category || '';
      form.groupId = props.bookData.groupId ? String(props.bookData.groupId) : '';
      form.tags = props.bookData.tags ? [...props.bookData.tags] : [];
      form.intro = props.bookData.intro || '';
      form.coverUrl = props.bookData.coverUrl || '';
      coverUrl.value = props.bookData.coverUrl || '';
    } else {
      // 新增模式 - 重置表单
      form.id = undefined;
      form.title = '';
      form.platform = '起点中文网';
      form.perspective = '第三人称';
      form.audience = 'male';
      form.category = '';
      form.groupId = '';
      form.tags = ['系统', '腹黑'];
      form.intro = '';
      form.coverUrl = '';
      coverUrl.value = '';
    }
  }
});

// --- Constants ---
// value 用平台全名：与工作流建书、平台包装规范、策略包的存储制式一致；
// 旧数据存的短名（起点/番茄…）由 normalizeBookPlatform 归一后自然升级为全名。
const platforms = [
  { value: '起点中文网', label: '起点', colorClass: 'red' },
  { value: '番茄小说', label: '番茄', colorClass: 'orange' },
  { value: '晋江文学城', label: '晋江', colorClass: 'green' },
  { value: '七猫小说', label: '七猫', colorClass: 'yellow' },
  { value: '飞卢小说', label: '飞卢', colorClass: 'blue' },
  { value: '长佩文学', label: '长佩', colorClass: 'pink' },
  { value: '知乎盐选', label: '盐选', colorClass: 'blue' },
  { value: '其他', label: '其他', colorClass: 'gray' },
];

const normalizeBookPlatform = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '起点中文网';
  const hit = platforms.find(
    pf => pf.value === raw || raw.includes(pf.label) || pf.value.includes(raw)
  );
  return hit ? hit.value : '其他';
};

// 视角统一存中文（book.perspective 会原样拼进 AI 提示词，英文枚举会污染中文 prompt）
const normalizeBookPerspective = (value?: string) => {
  const raw = String(value || '').trim();
  if (raw === 'first' || raw.includes('第一')) return '第一人称';
  return '第三人称';
};

const categories = BOOK_CATEGORIES;

// --- Methods ---

// Tag Handling
const addTag = () => {
  const val = tagInput.value.trim();
  if (val && !form.tags.includes(val)) {
    form.tags.push(val);
  }
  tagInput.value = '';
};

const removeTag = (index: number) => {
  form.tags.splice(index, 1);
};

const handleBackspace = () => {
  if (tagInput.value === '' && form.tags.length > 0) {
    form.tags.pop();
  }
};

const openAiCover = () => {
  aiCoverVisible.value = true;
};

const handleAiCoverApply = (payload: { coverUrl: string }) => {
  const nextUrl = payload?.coverUrl || '';
  if (!nextUrl) return;
  if (coverPreviewObjectUrl.value) {
    URL.revokeObjectURL(coverPreviewObjectUrl.value);
    coverPreviewObjectUrl.value = null;
  }
  form.coverUrl = nextUrl;
  coverUrl.value = nextUrl;
};

// File Handling
const readFileAsDataUrl = (file: File) => {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
};

const handleFileChange = async (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (!target.files || !target.files[0]) return;
  const file = target.files[0];

  if (coverPreviewObjectUrl.value) {
    URL.revokeObjectURL(coverPreviewObjectUrl.value);
    coverPreviewObjectUrl.value = null;
  }

  coverPreviewObjectUrl.value = URL.createObjectURL(file);
  coverUrl.value = coverPreviewObjectUrl.value;

  // 开源版没有图床：封面读成 data URL 直接存书籍记录
  try {
    form.coverUrl = await readFileAsDataUrl(file);
    coverUrl.value = form.coverUrl;
  } catch (error) {
    console.error('读取本地封面失败:', error);
    ElMessage.error('读取封面失败');
  } finally {
    target.value = '';
  }
};

const close = () => {
  if (submitLoading.value) return;
  aiCoverVisible.value = false;
  introUndoSnapshot.value = null;
  emit('update:visible', false);
  emit('close');
};

const buildSubmitPayload = (): Partial<Book> => ({
  id: form.id,
  title: form.title.trim(),
  platform: form.platform,
  perspective: form.perspective,
  audience: form.audience,
  category: form.category,
  groupId: form.groupId || null,
  tags: [...form.tags],
  intro: form.intro,
  coverUrl: form.coverUrl,
});

const submit = async () => {
  if (submitLoading.value) return;
  if (!form.title.trim()) {
    ElMessage.warning('请输入作品名称');
    return;
  }

  submitLoading.value = true;
  try {
    // 本地持久化只能写入普通对象，不能把 Vue 响应式 Proxy 交给 IndexedDB。
    const data = buildSubmitPayload();
    if (data.id) {
      await localLibrary.updateLocalBook(data as Book & { id: number });
      ElMessage.success('修改成功');
      emit('success');
    } else {
      const createdBook = await localLibrary.createLocalBook(data);
      ElMessage.success('创建成功');
      emit('success', createdBook);
    }
    introUndoSnapshot.value = null;
    close();
  } catch (error) {
    console.error('Submit failed:', error);
    ElMessage.error(String(error?.message || (form.id ? '修改失败，请稍后重试' : '创建失败，请稍后重试')));
  } finally {
    submitLoading.value = false;
  }
};

// Computed
const introCount = computed(() => form.intro.length);

const audienceLabelMap: Record<string, string> = {
  male: '男频',
  female: '女频',
  pub: '出版/全频'
};

const buildSummaryInfo = () => {
  return {
    书名: form.title || '未命名作品',
    平台: form.platform,
    // form.perspective 全链路存中文（radio value / normalizeBookPerspective 都是中文）
    叙事人称: form.perspective || '第三人称',
    读者群: audienceLabelMap[form.audience] || '全频读者',
    题材: form.category,
    标签: form.tags.length ? form.tags.join('、') : '无标签'
  };
};

const ensureTitleReady = () => {
  if (!form.title.trim()) {
    ElMessage.warning('请先填写书名');
    return false;
  }
  return true;
};

const handleIntroGenerate = async () => {
  const modelCode = await aiModelStore.ensureTextModel();
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE);
    return;
  }
  if (!ensureTitleReady()) return;
  // 不再暗中默认"玄幻"：分类直接决定简介的写法风格，必须由作者明确选择
  if (!form.category) {
    ElMessage.warning('请先选择作品分类，AI 会按分类和平台风格生成简介');
    return;
  }
  if (introGenerateLoading.value) {
    ElMessage.warning('AI 正在生成中，请稍候...');
    return;
  }
  if (introGenerateController.value) {
    introGenerateController.value.abort();
  }
  const controller = new AbortController();
  introGenerateController.value = controller;
  introGenerateLoading.value = true;
  try {
    const data = await requestLocalChatCompletion({
      scene: 'book_intro',
      sceneLabel: '书籍简介',
      modelCode,
      temperature: promptTemperature('book-intro', 'generateTask'),
      messages: buildBookIntroMessages({ mode: 'generate', info: buildSummaryInfo() }),
      signal: controller.signal
    });
    const text = (data || '').trim();
    if (!text) {
      throw new Error('AI 暂无返回内容');
    }
    introUndoSnapshot.value = null;
    form.intro = text;
    ElMessage.success('AI 已生成作品简介');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error('AI简介生成失败:', error);
    ElMessage.error(String(error?.message || '生成失败，请稍后重试'));
  } finally {
    if (introGenerateController.value === controller) {
      introGenerateController.value = null;
    }
    introGenerateLoading.value = false;
  }
};

const handleIntroPolish = async () => {
  const modelCode = await aiModelStore.ensureTextModel();
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE);
    return;
  }
  const content = form.intro.trim();
  if (!content) {
    ElMessage.warning('请先输入需要润色的简介内容');
    return;
  }
  if (introPolishLoading.value) {
    ElMessage.warning('AI 正在润色中，请稍候...');
    return;
  }
  if (introPolishController.value) {
    introPolishController.value.abort();
  }
  const controller = new AbortController();
  introPolishController.value = controller;
  introPolishLoading.value = true;
  try {
    const data = await requestLocalChatCompletion({
      scene: 'book_intro',
      sceneLabel: '书籍简介',
      modelCode,
      temperature: promptTemperature('book-intro', 'polishTask'),
      messages: buildBookIntroMessages({ mode: 'polish', info: buildSummaryInfo(), current: content }),
      signal: controller.signal
    });
    const text = (data || '').trim();
    if (!text) {
      throw new Error('AI 暂无返回内容');
    }
    introUndoSnapshot.value = { originalIntro: form.intro };
    form.intro = text;
    ElMessage.success('AI 已完成润色');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error('AI简介润色失败:', error);
    ElMessage.error(String(error?.message || '润色失败，请稍后重试'));
  } finally {
    if (introPolishController.value === controller) {
      introPolishController.value = null;
    }
    introPolishLoading.value = false;
  }
};

const handleIntroUndo = () => {
  const snapshot = introUndoSnapshot.value;
  if (!snapshot) return;
  form.intro = snapshot.originalIntro;
  introUndoSnapshot.value = null;
  ElMessage.success('已撤销本次润色');
};

onBeforeUnmount(() => {
  introGenerateController.value?.abort();
  introPolishController.value?.abort();
  introUndoSnapshot.value = null;
  if (coverPreviewObjectUrl.value) {
    URL.revokeObjectURL(coverPreviewObjectUrl.value);
    coverPreviewObjectUrl.value = null;
  }
});

</script>

<style scoped lang="scss">
/* --- 使用 CSS 变量替代固定颜色 --- */

/* --- Transitions --- */
.animate-fade-in {
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

/* --- Layout --- */

.content-wrapper {
  display: flex;
  gap: 2.5rem;
  min-width: 0;
}

/* Left: Cover */
.cover-section {
  width: 160px;
  flex-shrink: 0;

  .upload-label {
    display: block;
    cursor: pointer;
  }

  .hidden-input {
    display: none;
  }

  // 封面框：虚线边框 -> 悬停变色
  .upload-box,
  .preview-box {
    width: 100%;
    aspect-ratio: 2/3;
    border-radius: 4px;
    position: relative;
    overflow: hidden;
    transition: all 0.3s;
  }

  .upload-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--ink-sec);
    background-image: url("data:image/svg+xml,%3csvg width='100%25' height='100%25' xmlns='http://www.w3.org/2000/svg'%3e%3crect width='100%25' height='100%25' fill='none' rx='4' ry='4' stroke='%23A8A29EFF' stroke-width='1' stroke-dasharray='6%2c 4' stroke-dashoffset='0' stroke-linecap='square'/%3e%3c/svg%3e");
  }

  .upload-label:hover .upload-box {
    background-color: rgba(180, 83, 9, 0.03);
    color: var(--ink-accent);
    background-image: url("data:image/svg+xml,%3csvg width='100%25' height='100%25' xmlns='http://www.w3.org/2000/svg'%3e%3crect width='100%25' height='100%25' fill='none' rx='4' ry='4' stroke='%23b45309' stroke-width='1' stroke-dasharray='6%2c 4' stroke-dashoffset='0' stroke-linecap='square'/%3e%3c/svg%3e");
  }

  .preview-box {
    .cover-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .hover-mask {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--on-inverse);
      opacity: 0;
      transition: opacity 0.2s;
    }

    &:hover .hover-mask {
      opacity: 1;
    }

    .uploading-mask {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--on-inverse);
      font-size: calc(12px * var(--ui-font-scale, 1));
      pointer-events: none;
    }
  }

  .upload-text {
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-family: "Noto Serif SC", serif;
    margin-top: 4px;
  }

  .upload-hint {
    font-size: calc(10px * var(--ui-font-scale, 1));
    color: var(--ink-sec);
    transform: scale(0.9);
    margin-top: 2px;
  }

  .ai-draw-btn-wrapper {
    margin-top: 12px;
    text-align: center;
  }

  .ai-draw-btn {
    font-size: calc(10px * var(--ui-font-scale, 1));
    color: var(--ink-accent);
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 100%;
    opacity: 0.8;
    transition: opacity 0.2s;

    &:hover {
      opacity: 1;
      text-decoration: underline;
    }
  }
}

/* Right: Form Fields */
.form-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.form-item {
  position: relative;
}

.form-label {
  display: block;
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 700;
  color: var(--ink-sec);
  margin-bottom: 4px;
}

/* 通用输入框样式已移至 ink.scss (.ink-input-underline) */

/* 标题特殊样式 */
.title-input {
  font-size: calc(18px * var(--ui-font-scale, 1));
  font-weight: 700;
}

.input-wrapper {
  position: relative;
}

.input-icon {
  position: absolute;
  right: 0;
  bottom: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  pointer-events: none;
  transition: color 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Radio Groups (平台/视角/受众) */
.radio-group {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.radio-wrapper {
  position: relative;
}

.hidden-radio {
  display: none;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--input-border);
  font-size: calc(12px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  background: var(--btn-outline-bg);

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  // Dot Colors
  .dot.red {
    background-color: var(--state-danger);
  }

  .dot.orange {
    background-color: var(--state-warning);
  }

  .dot.gray {
    background-color: var(--ink-sec);
  }

  .dot.blue {
    background-color: var(--state-info);
  }

  .dot.pink {
    background-color: #db2777;
  }

  .dot.green {
    background-color: var(--state-success);
  }

  .dot.yellow {
    background-color: #fcd34d;
  }

  &:hover {
    border-color: var(--ink-main);
    background: var(--btn-outline-hover-bg);
    transform: translateY(-1px);
  }
}

// Checked State: 印章风格
.hidden-radio:checked+.radio-label {
  background-color: var(--btn-primary-bg);
  color: var(--btn-primary-color);
  border-color: var(--btn-primary-bg);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
}

// /* Select */
// .select-wrapper {
//   position: relative;
// }

// .select-input {
//   appearance: none;
//   cursor: pointer;
//   padding-right: 20px;
//   font-weight: 500;
// }

// .select-arrow {
//   position: absolute;
//   right: 0;
//   top: 8px;
//   font-size: calc(12px * var(--ui-font-scale, 1));
//   color: var(--ink-muted);
//   pointer-events: none;
// }

/* Tags */
.tags-input-wrapper {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
  min-height: 35px;
  border-bottom: 1px solid var(--input-border);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  &:focus-within {
    border-bottom-color: var(--input-focus-border);
    border-bottom-width: 2px;
  }

  .tag-item {
    background-color: var(--tag-bg);
    color: var(--tag-color);
    font-size: calc(10px * var(--ui-font-scale, 1));
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--tag-border);
    display: flex;
    align-items: center;
    gap: 4px;
    transition: all 0.2s;

    &:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .tag-close {
      cursor: pointer;
      transition: color 0.2s;

      &:hover {
        color: var(--state-danger);
        transform: scale(1.2);
      }
    }
  }

  .tag-input {
    flex: 1;
    min-width: 50px;
    background: transparent;
    border: none;
    outline: none;
    font-size: calc(13px * var(--ui-font-scale, 1));
    color: var(--ink-main);

    &::placeholder {
      color: var(--ink-sec);
      font-size: calc(12px * var(--ui-font-scale, 1));
    }
  }
}


/* Intro Section (Full Width Bottom) */
.intro-item {
  margin-top: 0.5rem;
}

.intro-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 6px;
}

.ai-toolbar {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.text-btn {
  font-size: calc(10px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 72px;
  justify-content: center;

  &:hover {
    color: var(--ink-main);
    background: var(--overlay-hover);
  }

  &.loading {
    cursor: wait;
    opacity: 0.7;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}

.theme-dark .text-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}

.ai-btn-glow {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 99px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 700;
  color: #78350f;
  background: linear-gradient(135deg, #fff 0%, #fffbeb 100%);
  border: 1px solid #fcd34d;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  transition: all 0.2s;
  position: relative;
  overflow: hidden;
  min-width: 100px;
  justify-content: center;

  &::after {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: linear-gradient(to bottom right, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.8) 50%, rgba(255, 255, 255, 0) 100%);
    transform: rotate(45deg);
    animation: shine 3s infinite;
  }

  i {
    color: var(--state-warning);
  }

  &:hover {
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    transform: translateY(-1px);
  }

  &.loading {
    cursor: wait;
    opacity: 0.85;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }
}

@keyframes shine {
  0% {
    transform: translateX(-100%) rotate(45deg);
  }

  100% {
    transform: translateX(100%) rotate(45deg);
  }
}

.textarea-wrapper {
  position: relative;
}

.intro-textarea {
  width: 100%;
  min-height: 150px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  padding: 12px 12px 34px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  color: var(--ink-main);
  resize: vertical;
  line-height: 1.6;
  outline: none;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  &:focus {
    border-color: var(--input-focus-border);
    background: var(--input-focus-bg);
    box-shadow: 0 0 0 2px var(--selection-bg-color);
    transform: translateY(-1px);
  }

  &:hover:not(:focus) {
    border-color: var(--input-focus-border);
  }
}

.char-count {
  position: absolute;
  bottom: 8px;
  right: 12px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  color: var(--ink-sec);
  pointer-events: none;
}

@media (max-width: 720px) {
  .content-wrapper {
    flex-direction: column;
    gap: 1.5rem;
  }

  .cover-section {
    width: min(180px, 60vw);
    align-self: center;
  }
}
</style>
