import type { JsonRecord } from './json.js'

export interface NovelRankPlatform {
  code: string;
  name: string;
  baseUrl?: string;
}

export interface NovelRankSource {
  id: number;
  rankType: string;
  title?: string | null;
  url: string;
  categoryId?: number | null;
  categoryName?: string | null;
  categoryCode?: string | null;
  gender?: string | null;
  scope?: "all" | "category" | null;
  metricName?: string | null;
  metricMode?: "value" | "none" | null;
}

export interface NovelRankSnapshot {
  id: number;
  sourceId: number;
  statDate: string;
  cutoffText?: string | null;
  pageTitle?: string | null;
  itemCount: number;
  meta?: JsonRecord;
}

export interface NovelRankItem {
  rankNo: number;
  rankChange: number;
  bookTitle: string;
  bookId?: string | null;
  intro?: string | null;
  authorName?: string | null;
  statusText?: string | null;
  metricName?: string | null;
  metricValue?: number | null;
  metricText?: string | null;
  readingCount: number;
  readingText?: string | null;
  prevRankNo?: number | null;
  rankChangeDelta?: number | null;
  prevMetricValue?: number | null;
  metricDelta?: number | null;
  coverUrl?: string | null;
  bookUrl: string;
  lastChapterTitle?: string | null;
  lastChapterUrl?: string | null;
  lastUpdateTimeText?: string | null;
  categoryName?: string | null;
  categoryMainName?: string | null;
  categorySubName?: string | null;
}

export interface NovelRankCategoryOption {
  id: number;
  code: string;
  name: string;
}

export interface NovelRankTrendItem {
  date: string;
  bookCount: number;
  metricSum: number;
  metricAvg: number;
}

export interface NovelRankCategoryDistributionResult {
  statDate: string | null;
  total?: number;
  list: Array<{
    categoryId: number | null;
    categoryCode: string | null;
    categoryName: string;
    count: number;
    ratio: number;
  }>;
}

export interface NovelRankTagTrendSeries {
  date: string;
  count: number;
}

export interface NovelRankTagTrendItem {
  tag: string;
  series: NovelRankTagTrendSeries[];
}

export interface NovelRankTagTrendResult {
  startDate: string;
  endDate: string;
  days: number;
  list: NovelRankTagTrendItem[];
}

export interface NovelRankChangeItem {
  bookId?: string | null;
  bookTitle: string;
  rankNo: number;
  rankChange: number;
  metricValue: number;
  metricText?: string | null;
}

export interface NovelRankChangeResult {
  statDate: string | null;
  compareDate: string | null;
  list: NovelRankChangeItem[];
}

export interface NovelRankCompetitorSeriesItem {
  date: string;
  rankNo: number | null;
  metricValue: number | null;
  metricText?: string | null;
}

export interface NovelRankCompetitorItem {
  bookId: string;
  bookTitle: string;
  series: NovelRankCompetitorSeriesItem[];
}

export interface NovelRankCompetitorResult {
  startDate: string;
  endDate: string;
  days: number;
  list: NovelRankCompetitorItem[];
}

export interface NovelRankAuthorTrendResult {
  startDate: string;
  endDate: string;
  days: number;
  list: NovelRankTrendItem[];
}

export interface NovelRankHomePreference {
  siteCode: string;
  rankType?: string | null;
  gender?: string | null;
  sourceId?: number | null;
  categoryCode?: string | null;
  categoryName?: string | null;
}
