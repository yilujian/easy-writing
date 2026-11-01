import type { JsonRecord } from '@/types/json'

export interface WorkflowRun {
  id: number;
  title: string;
  status: string;
  currentStep: string;
  modelCode?: string;
  /** 工作流当前实际生效的具体模型；modelCode 为空时由服务端按运行时规则解析。 */
  effectiveModelCode?: string;
  effectiveModelName?: string;
  modelFollowDefault?: boolean;
  agentId?: string;
  templateCode?: string;
  templateName?: string;
  currentArtifactId?: number | null;
  bookId?: number | null;
  activeTaskId?: number | null;
  draftRevision: number;
  outlineRevision: number;
  config?: JsonRecord | null;
  summary?: JsonRecord | null;
  createTime?: string;
  updateTime?: string;
  artifacts?: WorkflowArtifact[];
  activeTask?: WorkflowTask | null;
  /** 最近一条正文生成任务；当前绑定已解除时用于从作品入口恢复工作流控制面板。 */
  latestBookTask?: WorkflowTask | null;
}

export interface WorkflowArtifact {
  id: number;
  runId: number;
  stepCode?: string;
  artifactType: string;
  version: number;
  modelCode?: string;
  content: JsonRecord;
  contentText?: string;
  createTime?: string;
  updateTime?: string;
}

export type WorkflowRuntimeEffectiveScope = 'next_chapter' | 'next_batch';
export type WorkflowReviewAction = 'accept' | 'rewrite';
export type WorkflowChapterRewriteMode = 'content' | 'plot';

/** 质检确认时随 rewrite 一起回传的用户意见（批次三 3A 用户意见回流）。 */
export interface WorkflowReviewFeedback {
  /** 用户补充的重写要求（选填，≤500 字） */
  feedback?: string;
  /** 同时把补充要求沉淀为写作规则，以后每章都遵守 */
  feedbackToRules?: boolean;
  /** content=只改正文；plot=先生成并确认新章纲。 */
  rewriteMode?: WorkflowChapterRewriteMode;
}

export interface WorkflowRuntimeSettings {
  platform?: string;
  genre?: string;
  narrativeStyle?: string;
  storyPerspective?: string;
  coreSetting?: string;
  storyLine?: string;
  writingStyle?: string;
  /** 用户硬性写作规则：优先级高于系统写作建议（输出格式与内容安全底线除外），下一章起生效 */
  writingRules?: string;
}

export interface WorkflowQualityIssue {
  source: 'rule' | 'critic';
  code: string;
  dimension: string;
  message: string;
  severity: 'high' | 'low';
  blocking: boolean;
  evidence?: string;
  fix?: string;
  paragraphs?: number[];
  /** 命中原句节选（≤3 条）：面板引用块 + 正文标注锚定校验（规则质检必给） */
  quotes?: string[];
  metrics?: Record<string, number>;
}

export interface ChapterCorpusUsage {
  source: 'user_corpus' | 'none';
  styleSampleCount: number;
  sampleIds: number[];
  sceneTypes: string[];
  injectedWordCounts?: number[];
  selectionReasons?: string[];
  generationFitStatuses?: string[];
  retrievalTiers?: string[];
  selectionTrace?: {
    items: Array<{
      sampleId: number;
      sceneType: string;
      decision: 'selected' | 'excluded';
      reason: string;
      generationFitStatus: string;
    }>;
    excludedCounts: Record<string, number>;
    evaluatedCandidateCount: number;
    candidatePoolTruncated: boolean;
  };
  lexiconTermCount: number;
  baselineMatched: boolean;
  /** 历史快照兼容；P1 起固定为 0。 */
  selfCorpusCount?: number;
}

export interface WorkflowOutlineWarning {
  code: 'DUPLICATE_CHAPTER_TITLE';
  chapterId: number;
  chapterNo: number;
  title: string;
  duplicateWith?: number;
  message: string;
}

export interface WorkflowQualityNotice {
  version: number;
  requiresAction: boolean;
  chapterId: number;
  chapterNo: number;
  chapterTitle: string;
  issues: WorkflowQualityIssue[];
  wordCount: number;
  contentVersion: number;
  modelCode?: string;
  runtimeConfigRevision?: number;
  createdAt?: string;
  critic?: {
    status: 'available' | 'partial' | 'unavailable';
    scores?: Record<string, number>;
    error?: string;
  };
  corpusUsage?: ChapterCorpusUsage;
}

export type WorkflowQualityReview = WorkflowQualityNotice;

export interface WorkflowTaskPayload extends JsonRecord {
  qualityReview?: WorkflowQualityReview | null;
  qualitySuggestions?: WorkflowQualityNotice | null;
  outlineWarnings?: WorkflowOutlineWarning[];
}

export interface WorkflowTask {
  id: number;
  runId: number;
  bookId?: number | null;
  bizType: string;
  status: string;
  progress: number;
  generatedWords?: number;
  totalGeneratedWords?: number;
  currentChapterId?: number | null;
  currentChapterTitle?: string;
  chapterNo?: number;
  sceneNo?: number;
  jobId?: string | null;
  checkpointId?: number | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorReference?: string;
  modelCode?: string;
  modelName?: string;
  canReview?: boolean;
  lastAiRecordId?: number | null;
  requestedAction?: string | null;
  lastHeartbeatTime?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  interruptedReason?: string | null;
  targetChapterWords?: number;
  totalChapters?: number;
  finishedChapters?: number;
  chapterPlanningMode?: 'fixed' | 'dynamic';
  canPause?: boolean;
  canResume?: boolean;
  canCancel?: boolean;
  remainingChapters?: number;
  payload?: WorkflowTaskPayload;
  checkpoint?: JsonRecord | null;
}

export type WorkflowDisplayStatus =
  | 'draft'
  | 'generating'
  | 'paused'
  | 'attention'
  | 'completed'
  | 'canceled';

export type WorkflowAvailableAction =
  | 'openBook'
  | 'editSettings'
  | 'pause'
  | 'resume'
  | 'review'
  | 'cancel'
  | 'delete';

export interface WorkflowHistoryStats {
  all: number;
  generating: number;
  paused: number;
  attention: number;
  completed: number;
  canceled: number;
}

export interface WorkflowHistoryRecord {
  runId: number;
  title: string;
  /** 内部兼容状态；页面展示与操作必须使用 displayStatus/availableActions。 */
  status: string;
  displayStatus: WorkflowDisplayStatus;
  availableActions: WorkflowAvailableAction[];
  currentStep: string;
  modelCode?: string;
  /** 空 modelCode=跟随默认；此字段为默认实际落到的模型（服务端按运行时同链路解析） */
  effectiveModelCode?: string;
  modelFollowDefault?: boolean;
  agentId?: string;
  bookId?: number | null;
  bookTitle?: string;
  activeTask?: WorkflowTask | null;
  /** 最新步骤生成（灵感/大纲/设定）；失败状态用于恢复操作与展示原因 */
  stepTask?: {
    id: number;
    step: string;
    status: string;
    requestedAction?: string | null;
    errorMessage?: string | null;
  } | null;
  progress: number;
  generatedWords: number;
  totalChapters: number;
  finishedChapters: number;
  chapterPlanningMode?: 'fixed' | 'dynamic';
  errorMessage?: string;
  createTime?: string;
  updateTime?: string;
}

export interface WorkflowHistoryQuery {
  page?: number;
  size?: number;
  status?: string;
  keyword?: string;
  hasBook?: string;
}

export interface WorkflowHistoryPageResult {
  list: WorkflowHistoryRecord[];
  pagination: {
    page: number;
    size: number;
    total: number;
  };
  stats: WorkflowHistoryStats;
}

export interface WorkflowGenerateBookConflict {
  conflict: true;
  message: string;
  activeTask: WorkflowTask & {
    title?: string;
    bookTitle?: string;
  };
}

export type WorkflowGenerateBookResult = WorkflowTask | WorkflowGenerateBookConflict;

export interface WorkflowRealtimeEvent {
  type:
    | 'progress'
    | 'token'
    | 'scene-start'
    | 'scene-done'
    | 'hook-warn'
    | 'stage'
    | 'paused'
    | 'error'
    | 'done'
    | 'quality-review'
    | 'review-resolved'
    | 'recovering';
  runId: number;
  taskId?: number;
  payload?: JsonRecord;
  at: number;
}

export interface WorkflowPlatformResource {
  code: string;
  name: string;
  desc: string;
  icon: string;
}

export interface WorkflowPlatformCategoryResource {
  id: number;
  code: string;
  name: string;
  gender: 'male' | 'female';
}

export interface WorkflowAssistResource {
  code: string;
  title: string;
  desc: string;
  icon: string;
}

export interface WorkflowSelectFieldResource {
  key: 'targetWords' | 'chapterTargetWords' | 'protagonist' | 'storyPerspective' | 'audience';
  label: string;
  options: string[];
}

export interface WorkflowCreationDefaults {
  targetWords: string;
  chapterTargetWords: string;
  platform?: string;
  genre?: string;
  protagonist?: string;
  storyPerspective?: string;
  audience?: string;
}

export interface WorkflowResources {
  inspirationDirections: string[];
  inspirationAssistActions: WorkflowAssistResource[];
  platforms: WorkflowPlatformResource[];
  platformCategories: Record<string, WorkflowPlatformCategoryResource[]>;
  genres: string[];
  tags: string[];
  selectFields: WorkflowSelectFieldResource[];
  creationDefaults?: WorkflowCreationDefaults;
}

export type WorkflowStepGenerateStep =
  | 'inspiration'
  | 'outline'
  | 'setting'
  | 'outline_adjust'
  | 'setting_adjust';

export type WorkflowOutlineAdjustScope = 'all' | 'title' | 'storyHook' | 'world' | 'volumes';
export type WorkflowOutlinePreserveKey = 'title' | 'storyHook' | 'worldItems' | 'volumeCount';

export interface WorkflowOutlineAdjustRequest {
  scope: WorkflowOutlineAdjustScope;
  instruction: string;
  preserve: WorkflowOutlinePreserveKey[];
  allowVolumeTitleChange: boolean;
}

export interface WorkflowOutlineAdjustChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface WorkflowOutlineAdjustResult {
  candidateId: number;
  version: number;
  request: WorkflowOutlineAdjustRequest;
  tags: string[];
  changes: WorkflowOutlineAdjustChange[];
  consistency: { passed: boolean; message: string };
  /** 整体重生会覆盖的手改条目数；单字段范围恒为 0 */
  manualEditCount: number;
  outline: JsonRecord;
}

export type WorkflowSettingAdjustScope =
  | 'all'
  | 'worldCards'
  | 'core'
  | 'characters'
  | 'storylines'
  | 'character'
  | 'storyline';
export type WorkflowSettingPreserveKey =
  | 'characterCount'
  | 'protagonist'
  | 'cultivationRealms'
  | 'worldRules';

export interface WorkflowSettingAdjustRequest {
  scope: WorkflowSettingAdjustScope;
  /** 单条目范围下的目标 id；其余范围为空串 */
  targetId: string;
  instruction: string;
  preserve: WorkflowSettingPreserveKey[];
}

export interface WorkflowSettingAdjustChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

export interface WorkflowSettingAdjustResult {
  candidateId: number;
  version: number;
  request: WorkflowSettingAdjustRequest;
  tags: string[];
  changes: WorkflowSettingAdjustChange[];
  /** warnings 是与大纲对不上的软提示，不阻断应用 */
  consistency: { passed: boolean; message: string; warnings: string[] };
  /** 整体重生会覆盖的手改条目数；单范围恒为 0 */
  manualEditCount: number;
  setting: JsonRecord;
}

/** 候选生成阶段进度，由任务轮询带回，不额外开 SSE */
export interface WorkflowOutlineAdjustProgress {
  stage: 'read' | 'preserve' | 'generate' | 'verify';
  percent: number;
}

/** 步骤生成后台任务（灵感/大纲/设定/大纲调整）：提交即返回，服务端执行并持久化终态 */
export interface WorkflowStepTask extends Omit<WorkflowTask, 'payload'> {
  payload?: {
    generationId?: number;
    unitProgress?: { completed: number; total: number; current: string };
    step?: WorkflowStepGenerateStep;
    input?: JsonRecord;
    adjustProgress?: WorkflowOutlineAdjustProgress;
    result?: {
      artifact: WorkflowArtifact;
      content: JsonRecord;
      draftRevision: number;
      outlineRevision: number;
    } & Partial<WorkflowOutlineAdjustResult> &
      Partial<WorkflowSettingAdjustResult>;
  };
}

/** 单章重写提交结果（服务端契约）：任务快照在 task 字段，附重写前留档信息。 */
export type WorkflowChapterRewriteSubmitResult = Partial<WorkflowTask> & {
  taskId?: number;
  task?: Partial<WorkflowTask>;
  preRewriteHistoryId?: number | null;
  preRewriteContentVersion?: number;
};
