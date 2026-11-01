<template>
  <EwModal
    v-model:visible="visibleProxy"
    title="导入字体"
    width="520px"
    custom-class="font-import-modal"
    :close-on-click-modal="false"
    :show-close="!importing"
  >
    <div class="font-import-form" @keydown.esc.stop.prevent="close">
      <div class="font-field">
        <span class="font-field-label">字体文件</span>
        <input ref="fileInput" type="file" accept=".ttf,.otf" hidden @change="handleFile" />
        <div class="font-file-picker">
          <i class="fa-solid fa-file-arrow-up" aria-hidden="true"></i>
          <div class="font-file-info">
            <span :title="file?.name">{{ file?.name || '未选择字体文件' }}</span>
            <small v-if="file">{{ (file.size / 1024 / 1024).toFixed(2) }} MB</small>
          </div>
          <button class="ink-btn ink-btn-outline" type="button" :disabled="importing" @click="fileInput?.click()">
            {{ file ? '重新选择' : '选择文件' }}
          </button>
        </div>
      </div>

      <div class="font-field">
        <label for="font-import-name" class="font-field-label">字体名称</label>
        <el-input
          id="font-import-name"
          v-model="name"
          :maxlength="40"
          show-word-limit
          placeholder="选择文件后自动填入，也可自行填写"
          :disabled="importing"
          @input="error = ''"
          @keydown.enter.prevent="confirmImport"
        />
        <p class="font-field-hint">显示在字体列表中的名称，可自行修改。</p>
      </div>

      <div class="font-import-tips">
        <div><i class="fa-solid fa-circle-info" aria-hidden="true"></i><strong>导入提示</strong></div>
        <ul>
          <li>支持 TTF、OTF 格式，单个文件不超过 50 MB。</li>
          <li>字体保存在本机，重启后仍可使用，无需安装到系统。</li>
          <li>重复导入同一文件可更新名称，不会增加重复字体。</li>
        </ul>
      </div>
      <p v-if="error" class="font-import-error" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <button class="ink-btn ink-btn-outline" type="button" :disabled="importing" @click="close">取消</button>
      <button class="ink-btn ink-btn-primary" type="button" :disabled="!file || !name.trim() || importing" @click="confirmImport">
        <i v-if="importing" class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
        {{ importing ? '正在导入…' : '确认导入' }}
      </button>
    </template>
  </EwModal>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import EwModal from '@/components/EwModal/index.vue'
import { importFontFile } from '@/composables/use-imported-fonts'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ 'update:visible': [visible: boolean]; imported: [family: string] }>()
const fileInput = ref<HTMLInputElement>()
const file = shallowRef<File>()
const name = ref('')
const error = ref('')
const importing = ref(false)
const visibleProxy = computed({
  get: () => props.visible,
  set: (value: boolean) => { if (!importing.value) emit('update:visible', value) },
})
const defaultName = (filename: string) => filename.replace(/\.(ttf|otf)$/i, '').trim().slice(0, 40)
const close = () => { visibleProxy.value = false }

const handleFile = (event: Event) => {
  const input = event.target as HTMLInputElement
  const selected = input.files?.[0]
  input.value = ''
  if (!selected || importing.value) return
  if (!/\.(ttf|otf)$/i.test(selected.name) || !selected.size || selected.size > 50 * 1024 * 1024) {
    error.value = '请选择有效的 TTF 或 OTF 字体文件，大小须在 50 MB 以内'
    return
  }
  if (!name.value.trim() || name.value === defaultName(file.value?.name || '')) name.value = defaultName(selected.name)
  file.value = selected
  error.value = ''
}

const confirmImport = async () => {
  if (!file.value || !name.value.trim() || importing.value) return
  importing.value = true
  error.value = ''
  try {
    const result = await importFontFile(file.value, name.value)
    emit('imported', result.font.value)
    emit('update:visible', false)
    if (result.renamed) ElMessage.success('字体名称已更新')
    else if (result.duplicate) ElMessage.info('该字体已导入')
    else ElMessage.success('字体已导入')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '字体导入失败，请重试'
  } finally {
    importing.value = false
  }
}
</script>

<style scoped lang="scss">
.font-import-form { display: grid; gap: 20px; }
.font-field { display: grid; gap: 9px; }
.font-field-label { color: var(--ink-main); font-size: calc(14px * var(--ui-font-scale, 1)); font-weight: 600; }
.font-file-picker {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px dashed var(--input-border);
  border-radius: 8px;
  background: var(--input-bg);
  color: var(--ink-sec);

  > i { font-size: calc(22px * var(--ui-font-scale, 1)); }
  button { flex-shrink: 0; }
}
.font-file-info {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 4px;
  font-size: calc(13px * var(--ui-font-scale, 1));

  span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
}
.font-field-hint { margin: 0; font-size: calc(12px * var(--ui-font-scale, 1)); color: var(--ink-sec); }
.font-import-tips {
  border-top: 1px solid var(--ui-border);
  padding-top: 16px;
  color: var(--ink-sec);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.8;

  > div { display: flex; gap: 7px; align-items: center; color: var(--ink-main); }
  ul { margin: 7px 0 0; padding-left: 18px; }
}
.font-import-error { margin: 0; color: var(--state-danger); font-size: calc(13px * var(--ui-font-scale, 1)); }
</style>
