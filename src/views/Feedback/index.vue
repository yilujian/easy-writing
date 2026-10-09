<template>
  <div class="feedback-page">
    <section class="feedback-card">
      <div class="page-head">
        <p class="eyebrow">反馈中心</p>
        <h1>问题反馈</h1>
        <p class="desc">开源版的反馈统一在 GitHub Issues 跟进。在左侧写好内容，一键复制后到 GitHub 新建 Issue 粘贴即可。</p>
      </div>

      <div class="feedback-layout">
        <div class="submit-panel">
          <div v-if="contextEntries.length" class="context-box">
            <h2>当前上下文</h2>
            <div class="context-grid">
              <div v-for="item in contextEntries" :key="item.label" class="context-item">
                <span class="label">{{ item.label }}</span>
                <span class="value">{{ item.value }}</span>
              </div>
            </div>
          </div>

          <div class="form-grid">
            <label class="field field-full">
              <span>问题标题</span>
              <input
                v-model.trim="form.title"
                type="text"
                class="ink-input"
                maxlength="120"
                placeholder="例如：榜单页未找到作品入口失效"
              />
            </label>

            <label class="field field-full">
              <span>问题描述</span>
              <textarea
                v-model.trim="form.description"
                class="ink-textarea"
                rows="8"
                maxlength="5000"
                placeholder="请尽量写清页面入口、操作步骤、实际结果和期望结果。"
              ></textarea>
            </label>
          </div>

          <div class="preview-box">
            <h2>反馈预览</h2>
            <pre>{{ feedbackPreview }}</pre>
          </div>

          <div class="actions">
            <button class="ink-btn ink-btn-outline" type="button" @click="fillExample">
              填入示例
            </button>
            <button class="ink-btn ink-btn-outline" type="button" @click="copyFeedback">
              复制内容
            </button>
            <button class="ink-btn ink-btn-primary" type="button" @click="submitToGitHub">
              复制并前往 GitHub
            </button>
          </div>
        </div>

        <aside class="guide-panel">
          <div class="guide-head">
            <h2>如何提交</h2>
            <p>三步完成反馈，处理进展在 Issue 里跟进</p>
          </div>

          <ol class="guide-steps">
            <li>在左侧写清问题标题和描述</li>
            <li>点「复制并前往 GitHub」，内容会复制到剪贴板</li>
            <li>在打开的页面新建 Issue，粘贴内容并提交</li>
          </ol>

          <p class="guide-tip">有截图或录屏可以直接拖进 Issue 编辑框，比文字更直观。</p>

          <div class="guide-actions">
            <button class="ink-btn ink-btn-primary" type="button" @click="openNewIssue">
              <i class="fa-brands fa-github"></i>
              新建 Issue
            </button>
            <button class="ink-btn ink-btn-outline" type="button" @click="openIssueList">
              查看已有反馈
            </button>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { openLink } from '@/utils/external-link'
import { GITHUB_ISSUES_URL, GITHUB_NEW_ISSUE_URL } from '@/config/opensource'

const route = useRoute()

const form = reactive({
  title: '',
  description: ''
})

const queryLabelMap: Record<string, string> = {
  platform: '平台',
  siteCode: '站点编码',
  rankType: '榜单类型',
  gender: '男女频',
  category: '分类',
  categoryCode: '分类编码',
  keyword: '搜索词',
  bookName: '作品名',
  title: '页面标题',
  statDate: '日期',
  endDate: '结束日期'
}

const normalizeQueryValue = (value: unknown) => {
  if (Array.isArray(value)) return value.filter(Boolean).join(' / ')
  return String(value ?? '').trim()
}

const contextEntries = computed(() => {
  return Object.entries(route.query)
    .map(([key, value]) => ({
      label: queryLabelMap[key] || key,
      value: normalizeQueryValue(value)
    }))
    .filter((item) => item.value)
})

const feedbackPreview = computed(() => {
  const lines = [
    `问题标题：${form.title || '未填写'}`,
    '问题描述：',
    form.description || '未填写'
  ]

  if (contextEntries.value.length) {
    lines.push('', '上下文信息：')
    contextEntries.value.forEach((item) => {
      lines.push(`- ${item.label}：${item.value}`)
    })
  }

  return lines.join('\n')
})

const fillExample = () => {
  if (!form.title) {
    form.title = '页面功能异常反馈'
  }
  if (!form.description) {
    form.description = '问题页面：\n复现步骤：\n实际结果：\n期望结果：'
  }
}

const copyToClipboard = async () => {
  await navigator.clipboard.writeText(feedbackPreview.value)
}

const copyFeedback = async () => {
  try {
    await copyToClipboard()
    ElMessage.success('反馈内容已复制')
  } catch (error) {
    console.error('复制反馈内容失败:', error)
    ElMessage.error('复制失败，请手动复制页面内容')
  }
}

const submitToGitHub = async () => {
  if (!form.title) {
    ElMessage.warning('请输入问题标题')
    return
  }
  if (!form.description) {
    ElMessage.warning('请输入问题描述')
    return
  }

  try {
    await copyToClipboard()
    ElMessage.success('内容已复制，请在 GitHub 页面粘贴')
  } catch (error) {
    console.error('复制反馈内容失败:', error)
    ElMessage.warning('自动复制失败，请回来点「复制内容」后再粘贴')
  }
  await openLink(GITHUB_NEW_ISSUE_URL)
}

const openNewIssue = () => {
  void openLink(GITHUB_NEW_ISSUE_URL)
}

const openIssueList = () => {
  void openLink(GITHUB_ISSUES_URL)
}
</script>

<style scoped lang="scss">
.feedback-page {
  padding: 24px 0 40px;
}

.feedback-card {
  max-width: 1180px;
  margin: 0 auto;
  padding: 32px;
  border: 1px solid var(--ui-border);
  border-radius: 16px;
  background: var(--ui-glass-bg);
  box-shadow: var(--ui-shadow);
}

.page-head {
  margin-bottom: 24px;

  .eyebrow {
    margin: 0 0 8px;
    font-size: 12px;
    letter-spacing: 0.12em;
    color: var(--ink-accent);
  }

  h1 {
    margin: 0 0 12px;
    font-size: 32px;
    color: var(--ink-main);
    font-family: var(--font-serif);
  }

  .desc {
    margin: 0;
    line-height: 1.75;
    color: var(--ink-sec);
  }
}

.feedback-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 24px;
  align-items: start;
}

.submit-panel,
.guide-panel,
.context-box,
.preview-box {
  border: 1px solid var(--ui-border);
  border-radius: 14px;
  background: var(--bg-card);
}

.submit-panel {
  padding: 20px;
}

.context-box,
.preview-box {
  margin-bottom: 24px;
  padding: 20px;

  h2 {
    margin: 0 0 14px;
    font-size: 18px;
    color: var(--ink-main);
  }
}

.context-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.context-item {
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ui-glass-bg);
  border: 1px solid var(--ui-border);

  .label {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--ink-sec);
  }

  .value {
    display: block;
    font-size: 14px;
    color: var(--ink-main);
    line-height: 1.6;
    word-break: break-word;
  }
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin-bottom: 24px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;

  span {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink-main);
  }
}

.field-full {
  grid-column: 1 / -1;
}

.ink-textarea {
  width: 100%;
  min-height: 180px;
  padding: 14px 16px;
  border: 1px solid var(--input-border);
  border-radius: 12px;
  background: transparent;
  color: var(--ink-main);
  font-size: 14px;
  line-height: 1.7;
  resize: vertical;
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.ink-textarea:focus {
  border-color: var(--input-focus-border);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink-main) 12%, transparent);
}

.preview-box pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink-sec);
  font-family: "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.guide-panel {
  padding: 20px;
  position: sticky;
  top: 20px;
}

.guide-head {
  margin-bottom: 16px;

  h2 {
    margin: 0 0 6px;
    font-size: 20px;
    color: var(--ink-main);
  }

  p {
    margin: 0;
    font-size: 13px;
    color: var(--ink-sec);
  }
}

.guide-steps {
  margin: 0 0 16px;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--ink-main);
  font-size: 14px;
  line-height: 1.7;
}

.guide-tip {
  margin: 0 0 20px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px dashed var(--ui-border);
  color: var(--ink-sec);
  font-size: 13px;
  line-height: 1.7;
}

.guide-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .ink-btn {
    width: 100%;
  }

  i {
    margin-right: 6px;
  }
}

@include content-max(800px) {
  .feedback-layout {
    grid-template-columns: 1fr;
  }

  .guide-panel {
    position: static;
  }
}

@media (max-width: 768px) {
  .feedback-card {
    padding: 24px 18px;
    border-radius: 12px;
  }

  .page-head h1 {
    font-size: 28px;
  }

  .submit-panel,
  .guide-panel {
    padding: 16px;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .actions {
    justify-content: stretch;
  }

  .actions .ink-btn {
    width: 100%;
  }
}
</style>
