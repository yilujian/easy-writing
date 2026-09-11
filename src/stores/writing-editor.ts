
import { defineStore } from "pinia";
import piniaPersistConfig from "@/stores/helper/persist";
import type { TypingSound } from "@/config/typing-sounds";

export type ChapterSaveState =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'success'
  | 'error'
  | 'local_saved'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'offline'
  | 'local_only'
  | 'conflict';

export const WRITING_SIDEBAR_MIN_WIDTH = 280;
export const WRITING_SIDEBAR_MAX_WIDTH = 600;
export const WRITING_RIGHT_PANEL_MIN_WIDTH = 360;
export const WRITING_RIGHT_PANEL_MAX_WIDTH = 800;
export const WRITING_MOBILE_PREVIEW_MIN_WIDTH = 320;
export const WRITING_MOBILE_PREVIEW_MAX_WIDTH = 430;
export const WRITING_MOBILE_PREVIEW_DEFAULT_WIDTH = 375;
export type MobilePreviewScreenType = 'notch' | 'island' | 'hole';
export type WritingScrollSource = 'editor' | 'preview' | null;

const clampSidebarWidth = (value: number) =>
  Math.max(WRITING_SIDEBAR_MIN_WIDTH, Math.min(WRITING_SIDEBAR_MAX_WIDTH, Number(value) || 256));
const clampRightPanelWidth = (value: number) =>
  Math.max(WRITING_RIGHT_PANEL_MIN_WIDTH, Math.min(WRITING_RIGHT_PANEL_MAX_WIDTH, Number(value) || 384));
const clampMobilePreviewWidth = (value: number) =>
  Math.max(WRITING_MOBILE_PREVIEW_MIN_WIDTH, Math.min(WRITING_MOBILE_PREVIEW_MAX_WIDTH, Number(value) || WRITING_MOBILE_PREVIEW_DEFAULT_WIDTH));
const clampWritingScrollRatio = (value: number) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const ENTITY_HIGHLIGHT_DISMISS_STORAGE_KEY = 'ew-writing-entity-highlight-dismissed';

const readDismissedEntityHighlightKeys = (): Record<string, string[]> => {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(ENTITY_HIGHLIGHT_DISMISS_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([bookId, keys]) => [
        bookId,
        Array.isArray(keys) ? keys.map(item => String(item).trim()).filter(Boolean) : []
      ])
    );
  } catch {
    return {};
  }
};

const writeDismissedEntityHighlightKeys = (value: Record<string, string[]>) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ENTITY_HIGHLIGHT_DISMISS_STORAGE_KEY, JSON.stringify(value));
};

export interface WritingEditorState {
  // --- 编辑器偏好 ---
  fontFamily: string; // 字体库
  fontBold: boolean; // 是否加粗
  fontColor: string | undefined; // 字体颜色，允许为空，为空时跟随主题
  fontSize: number; // 字体大小
  fontLineHeight: number; // 行高
  contentWidth: number; // 内容宽度，百分比
  isParagraphGap: boolean; // 是否段间空一行
  rulerStyle: 'none' | 'solid' | 'dashed'; // 分割线样式
  alignMode: 'left' | 'center' | 'justify'; // 正文对齐方式
  entityHighlightEnabled: boolean; // 是否显示角色设定高亮
  quickPolishToolbarEnabled: boolean; // 选中文本后是否显示快捷润色工具条
  dismissedEntityHighlightKeysByBook: Record<string, string[]>; // 每本书已隐藏的高亮词

  // --- 侧边栏 ---
  sidebarWidth: number; // 侧边栏宽度

  // --- 右侧面板 ---
  rightPanelWidth: number; // 右侧面板总宽度 (不含工具栏)
  rightPanelActiveTool: string | null; // 当前展开的右侧工具
  outlineTreeWidth: number; // 大纲树宽度
  characterTreeWidth: number; // 角色树宽度
  settingTreeWidth: number; // 设定树宽度

  // --- 章节状态 ---
  activeChapterId: number | null;
  activeChapterTitle: string;
  activeChapterSummary: string;
  activeChapterTextContent: string;
  chapterWordCount: number;
  localSessionWords: number;
  localSessionBaseWordCount: number;
  localSessionBaseTextWordCount: number;
  isChapterSaving: boolean;
  chapterSaveState: ChapterSaveState;
  chapterSaveMessage: string;

  // --- 打字特效 ---
  typingSound: TypingSound; // 打字音效
  typingEffect: 'none' | 'splash' | 'ripple' | 'mist' | 'fire' | 'cheer'; // 打字特效
  selfDestructMode: 'off' | '10s' | '20s' | '1m' | '5m'; // 自爆模式
  mobilePreviewWidth: number; // 移动端预览宽度
  mobilePreviewScreenType: MobilePreviewScreenType; // 移动端预览屏幕形态
  writingScrollRatio: number; // 正文与预览同步滚动比例
  writingScrollSource: WritingScrollSource; // 当前滚动来源
}

export const useWritingEditorStore = defineStore({
  id: 'ew-writing-editor',
  state: (): WritingEditorState => ({
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Arial, PingFang SC, Microsoft YaHei',
    fontBold: false,
    fontColor: undefined, // 允许为空，为空时跟随主题
    fontSize: 16,
    fontLineHeight: 1.8,
    contentWidth: 60,
    isParagraphGap: true,
    rulerStyle: 'none',
    alignMode: 'left',
    entityHighlightEnabled: true,
    quickPolishToolbarEnabled: true,
    dismissedEntityHighlightKeysByBook: readDismissedEntityHighlightKeys(),
    sidebarWidth: 280,
    rightPanelWidth: 384, // 默认宽度 (432 - 48)
    rightPanelActiveTool: null,
    outlineTreeWidth: 160, // 默认树宽度
    characterTreeWidth: 160, // 默认角色树宽度
    settingTreeWidth: 160,
    activeChapterId: null,
    activeChapterTitle: '',
    activeChapterSummary: '',
    activeChapterTextContent: '',
    chapterWordCount: 0,
    localSessionWords: 0,
    localSessionBaseWordCount: 0,
    localSessionBaseTextWordCount: 0,
    isChapterSaving: false,
    chapterSaveState: 'idle',
    chapterSaveMessage: '',
    typingSound: 'typewriter', // 默认打字机音效
    typingEffect: 'ripple', // 默认涟漪特效
    selfDestructMode: 'off', // 默认关闭自爆模式
    mobilePreviewWidth: WRITING_MOBILE_PREVIEW_DEFAULT_WIDTH,
    mobilePreviewScreenType: 'notch',
    writingScrollRatio: 0,
    writingScrollSource: null,
  }),
  getters: {
    activeFontColor(state): string {
      return state.fontColor ? state.fontColor : 'var(--ink-main)';
    }
  },
  actions: {
    setFontFamily(val: string) { this.fontFamily = val; },
    setFontBold(val: boolean) { this.fontBold = val; },
    setFontColor(val?: string | null) { this.fontColor = val || undefined; },
    setFontSize(val: number) { this.fontSize = val; },
    setFontLineHeight(val: number) { this.fontLineHeight = val; },
    setContentWidth(val: number) { this.contentWidth = val; },
    setIsParagraphGap(val: boolean) { this.isParagraphGap = val; },
    setRulerStyle(val: 'none' | 'solid' | 'dashed') { this.rulerStyle = val; },
    setAlignMode(val: 'left' | 'center' | 'justify') { this.alignMode = val; },
    setEntityHighlightEnabled(val: boolean) { this.entityHighlightEnabled = val; },
    setQuickPolishToolbarEnabled(val: boolean) { this.quickPolishToolbarEnabled = val; },
    dismissEntityHighlight(bookId: string | number | undefined, key: string) {
      const bookKey = String(bookId || 'global');
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) return;
      const current = this.dismissedEntityHighlightKeysByBook[bookKey] || [];
      if (current.includes(normalizedKey)) return;
      this.dismissedEntityHighlightKeysByBook = {
        ...this.dismissedEntityHighlightKeysByBook,
        [bookKey]: [...current, normalizedKey]
      };
      writeDismissedEntityHighlightKeys(this.dismissedEntityHighlightKeysByBook);
    },
    resetDismissedEntityHighlights(bookId?: string | number) {
      if (!bookId) {
        this.dismissedEntityHighlightKeysByBook = {};
        writeDismissedEntityHighlightKeys(this.dismissedEntityHighlightKeysByBook);
        return;
      }
      const next = { ...this.dismissedEntityHighlightKeysByBook };
      delete next[String(bookId)];
      this.dismissedEntityHighlightKeysByBook = next;
      writeDismissedEntityHighlightKeys(this.dismissedEntityHighlightKeysByBook);
    },
    getDismissedEntityHighlightCount(bookId?: string | number) {
      if (!bookId) {
        return Object.values(this.dismissedEntityHighlightKeysByBook).reduce((sum, list) => sum + list.length, 0);
      }
      return this.dismissedEntityHighlightKeysByBook[String(bookId)]?.length || 0;
    },
    setSidebarWidth(val: number) { this.sidebarWidth = clampSidebarWidth(val); },
    setRightPanelWidth(val: number) { this.rightPanelWidth = clampRightPanelWidth(val); },
    setRightPanelActiveTool(val: string | null) { this.rightPanelActiveTool = val; },
    setOutlineTreeWidth(val: number) { this.outlineTreeWidth = val; },
    setCharacterTreeWidth(val: number) { this.characterTreeWidth = val; },
    setSettingTreeWidth(val: number) { this.settingTreeWidth = val; },
    setTypingSound(val: TypingSound) { this.typingSound = val; },
    setTypingEffect(val: 'none' | 'splash' | 'ripple' | 'mist' | 'fire' | 'cheer') { this.typingEffect = val; },
    setSelfDestructMode(val: 'off' | '10s' | '20s' | '1m' | '5m') { this.selfDestructMode = val; },
    setMobilePreviewWidth(val: number) { this.mobilePreviewWidth = clampMobilePreviewWidth(val); },
    setMobilePreviewScreenType(val: MobilePreviewScreenType) { this.mobilePreviewScreenType = val; },
    setWritingScrollRatio(val: number, source: WritingScrollSource) {
      this.writingScrollRatio = clampWritingScrollRatio(val);
      this.writingScrollSource = source;
    },
    setActiveChapter(payload?: { id: number; title: string; summary?: string | null }) {
      if (payload) {
        this.activeChapterId = payload.id;
        this.activeChapterTitle = payload.title;
        this.activeChapterSummary = String(payload.summary || '');
        this.activeChapterTextContent = '';
        this.localSessionWords = 0;
        this.localSessionBaseTextWordCount = 0;
      this.localSessionBaseWordCount = 0;
        this.setWritingScrollRatio(0, null);
      } else {
        this.activeChapterId = null;
        this.activeChapterTitle = '';
        this.activeChapterSummary = '';
        this.activeChapterTextContent = '';
        this.localSessionWords = 0;
        this.localSessionBaseTextWordCount = 0;
      this.localSessionBaseWordCount = 0;
        this.setWritingScrollRatio(0, null);
      }
    },
    setChapterTitle(val: string) { this.activeChapterTitle = val; },
    setActiveChapterSummary(val: string) { this.activeChapterSummary = val; },
    setActiveChapterTextContent(val: string) { this.activeChapterTextContent = val; },
    setChapterWordCount(val: number) { this.chapterWordCount = val; },
    resetLocalSessionWords(baseWordCount = 0, baseTextWordCount = 0) {
      this.localSessionBaseTextWordCount = baseTextWordCount;
      this.localSessionBaseWordCount = Math.max(0, Math.trunc(Number(baseWordCount) || 0));
      this.localSessionWords = 0;
    },
    syncLocalSessionWords(currentWordCount: number) {
      // 本地模式以进入章节时的字数为基准，避免把历史正文算进本次码字。
      this.localSessionWords = Math.max(0, Math.trunc(Number(currentWordCount) || 0) - this.localSessionBaseWordCount);
    },
    setChapterSaving(val: boolean) { this.isChapterSaving = val; },
    setChapterSaveState(state: ChapterSaveState, message = '') {
      this.chapterSaveState = state;
      this.chapterSaveMessage = message;
    },
    resetToDefaultPreferences() {
      this.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Noto Sans, Arial, PingFang SC, Microsoft YaHei';
      this.fontBold = false;
      this.fontColor = undefined;
      this.fontSize = 16;
      this.fontLineHeight = 1.8;
      this.contentWidth = 60;
      this.isParagraphGap = true;
      this.rulerStyle = 'none';
      this.alignMode = 'left';
      this.entityHighlightEnabled = true;
      this.quickPolishToolbarEnabled = true;
      this.typingSound = 'typewriter';
      this.typingEffect = 'ripple';
      this.selfDestructMode = 'off';
      this.mobilePreviewWidth = WRITING_MOBILE_PREVIEW_DEFAULT_WIDTH;
      this.mobilePreviewScreenType = 'notch';
    },
    initWritingEditor() {
      // this.resetToDefaultPreferences();
    }
  },
  persist: piniaPersistConfig('ew-writing-editor', ['fontFamily', 'fontBold', 'fontColor', 'fontSize', 'fontLineHeight', 'contentWidth', 'isParagraphGap', 'rulerStyle', 'alignMode', 'entityHighlightEnabled', 'quickPolishToolbarEnabled', 'sidebarWidth', 'rightPanelWidth', 'rightPanelActiveTool', 'outlineTreeWidth', 'characterTreeWidth', 'settingTreeWidth', 'typingSound', 'typingEffect', 'selfDestructMode', 'mobilePreviewWidth', 'mobilePreviewScreenType'])
})
