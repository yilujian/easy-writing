<template>
          <section class="settings-pane">
            <div class="settings-two-col">
              <section class="settings-card">
                <div class="settings-card-title">
                  <i class="fa-solid fa-keyboard"></i>
                  <strong>输入反馈</strong>
                </div>
                <div class="setting-block">
                  <span class="setting-label">打字提示音</span>
                  <div class="option-row four">
                    <button
                      v-for="item in soundOptions"
                      :key="item.value"
                      type="button"
                      class="settings-option-btn"
                      :class="{ active: editorDraft.typingSound === item.value }"
                      @click="editorDraft.typingSound = item.value"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </div>
                <div class="setting-block">
                  <span class="setting-label">视觉反馈</span>
                  <div class="option-row four">
                    <button
                      v-for="item in effectOptions"
                      :key="item.value"
                      type="button"
                      class="settings-option-btn"
                      :class="{ active: editorDraft.typingEffect === item.value }"
                      @click="editorDraft.typingEffect = item.value"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </div>
              </section>

              <section class="settings-card">
                <div class="settings-card-title">
                  <i class="fa-solid fa-bomb"></i>
                  <strong>自爆挑战</strong>
                </div>
                <div class="setting-block">
                  <span class="setting-label">停止打字倒计时</span>
                  <div class="option-row four">
                    <button
                      v-for="item in selfDestructOptions"
                      :key="item.value"
                      type="button"
                      class="settings-option-btn"
                      :class="{ active: editorDraft.selfDestructMode === item.value }"
                      @click="editorDraft.selfDestructMode = item.value"
                    >
                      {{ item.label }}
                    </button>
                  </div>
                </div>
                <p class="hint-line">开启后停止打字超过设定时长会触发警告倒计时，督促持续码字，适合冲字数时使用。</p>
              </section>

              <section class="settings-card">
                <div class="settings-card-title">
                  <i class="fa-solid fa-wand-magic-sparkles"></i>
                  <strong>写作辅助</strong>
                </div>
                <label class="switch-row compact">
                  <span><strong>角色设定高亮</strong><small>正文中高亮角色名与代称</small></span>
                  <el-switch v-model="editorDraft.entityHighlightEnabled" />
                </label>
                <label class="switch-row compact">
                  <span><strong>快捷润色工具条</strong><small>选中正文后显示 AI 润色浮动工具条</small></span>
                  <el-switch v-model="editorDraft.quickPolishToolbarEnabled" />
                </label>
              </section>
              <section class="settings-card">
                <div class="settings-card-title"><i class="fa-solid fa-align-left"></i><strong>字数统计</strong></div>
                <span class="setting-label">默认统计口径</span>
                <div class="option-row two">
                  <button type="button" class="settings-option-btn" :class="{ active: uiDraft.wordCountMode === 'all' }" :aria-pressed="uiDraft.wordCountMode === 'all'" @click="uiDraft.wordCountMode = 'all'">含标点</button>
                  <button type="button" class="settings-option-btn" :class="{ active: uiDraft.wordCountMode === 'text' }" :aria-pressed="uiDraft.wordCountMode === 'text'" @click="uiDraft.wordCountMode = 'text'">不含标点</button>
                </div>
                <p class="hint-line">两种口径均忽略空格与换行；不含标点时仅计汉字、字母和数字。悬浮编辑器底部字数可查看两种结果。</p>
                <p class="hint-line">章节目录、书架与码字统计同步使用此口径。旧码字记录没有不含标点数据时显示「—」。</p>
              </section>
            </div>
          </section>
</template>

<script setup lang="ts">
import { TYPING_SOUND_OPTIONS } from '@/config/typing-sounds'
import type { LocalWritingSettings } from '@/storage'
import type { SettingsOption } from '@/types/settings-center'
import { useSettingsCenterCtx } from '../settings-context'

const ctx = useSettingsCenterCtx()
const { editorDraft, uiDraft } = ctx

const soundOptions: ReadonlyArray<SettingsOption<LocalWritingSettings['typingSound']>> =
  TYPING_SOUND_OPTIONS

const effectOptions: Array<SettingsOption<LocalWritingSettings['typingEffect']>> = [
  { label: '无特效', value: 'none' },
  { label: '挥毫泼墨', value: 'splash' },
  { label: '墨纹涟漪', value: 'ripple' },
  { label: '文字鼓励', value: 'cheer' },
]

const selfDestructOptions: Array<SettingsOption<LocalWritingSettings['selfDestructMode']>> = [
  { label: '关闭', value: 'off' },
  { label: '10 秒', value: '10s' },
  { label: '20 秒', value: '20s' },
  { label: '1 分钟', value: '1m' },
]
</script>
