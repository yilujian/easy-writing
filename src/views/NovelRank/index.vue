<template>
  <div class="rank-page">
    <!-- 顶部标题与平台切换 -->
    <div class="page-header">
      <!-- <h2 class="page-title">{{ pageTitle }}</h2> -->

      <!-- 平台选择器：区分“加载中/加载失败/确实为空”，避免链路慢时误报“暂无平台” -->
      <div class="platform-selector">
        <template v-if="platformsLoading">
          <div v-for="i in 3" :key="`platform-skeleton-${i}`" class="platform-tab platform-tab-skeleton"></div>
        </template>
        <div v-else-if="platformsError" class="platform-tab platform-tab-inactive platform-tab-retry" @click="retryPlatforms">
          <i class="fa-solid fa-rotate-right platform-icon"></i>
          加载失败，点击重试
        </div>
        <div v-else-if="!platforms.length" class="platform-tab platform-tab-inactive">
          暂无平台
        </div>
        <div
          v-for="p in platforms"
          :key="p.code"
          :class="['platform-tab', selectedPlatform === p.code ? 'platform-tab-active' : 'platform-tab-inactive']"
          @click="handlePlatformChange(p.code)"
        >
          <i :class="['fa-solid', platformIcon(p.code), 'platform-icon']"></i>
          {{ p.name }}
        </div>
      </div>

      <!-- 本机抓取控制：关闭不发请求 / 手动点抓 / 自动每日补抓（趋势靠快照日积月累） -->
      <div class="crawl-control">
        <div class="crawl-mode-group">
          <button
            v-for="option in crawlModeOptions"
            :key="option.value"
            type="button"
            class="crawl-mode-btn"
            :class="{ active: crawlMode === option.value }"
            :title="option.desc"
            :disabled="crawling && option.value !== 'off'"
            @click="handleCrawlModeChange(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <button
          class="ink-btn ink-btn-primary crawl-now-btn"
          type="button"
          :disabled="crawlButtonDisabled"
          @click="handleCrawlNow"
        >
          <i aria-hidden="true" :class="['fa-solid', crawling ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down']"></i>
          {{ crawlButtonText }}
        </button>
        <span v-if="crawlStatusText" class="crawl-status" role="status">{{ crawlStatusText }}</span>
      </div>
    </div>

    <!-- 筛选控制面板 -->
    <div class="filter-panel fusion-card">
      <!-- 顶部 Tab -->
      <el-tabs v-model="rankType" class="rank-tabs" @tab-change="handleRankTypeChange">
        <el-tab-pane
          v-for="t in rankTypeOptions"
          :key="t.value"
          :label="t.label"
          :name="t.value"
        />
      </el-tabs>
      <div v-if="cutoffText" class="rank-cutoff">{{ cutoffText }}</div>

      <!-- 筛选行 -->
      <div class="filter-rows">
        <!-- 统计日期 -->
        <div class="filter-row">
          <span class="filter-label">统计日期：</span>
          <div class="filter-content">
            <el-date-picker
              v-model="selectedDate"
              type="date"
              placeholder="选择日期"
              size="small"
              format="YYYY/MM/DD"
              class="ink-date-picker"
              popper-class="ink-date-picker-popper"
              :disabled-date="disabledDate"
              @change="dateTouched = true"
            />
          </div>
          <div class="action-btn">
            <el-button
              size="small"
              :class="{ 'home-set-button-active': isCurrentHomePreference }"
              :type="isCurrentHomePreference ? 'success' : undefined"
              :loading="homePreferenceSaving"
              @click="toggleHomePreference"
            >
              <i :class="['fa-solid', isCurrentHomePreference ? 'fa-circle-xmark' : 'fa-thumbtack']"></i>
              {{ isCurrentHomePreference ? '取消首页风向' : '设为首页风向' }}
            </el-button>
            <el-button type="primary" size="small" @click="toggleAnalysis">
              <i class="fa-solid fa-chart-pie"></i>
              {{ analysisVisible ? '收起分析' : '数据分析' }}
            </el-button>
          </div>
        </div>

        <!-- 对比日期 -->
        <div class="filter-row">
          <span class="filter-label">对比日期：</span>
          <div class="filter-content">
            <el-date-picker
              v-model="selectedCompareDate"
              type="date"
              placeholder="默认上一日"
              size="small"
              format="YYYY/MM/DD"
              class="ink-date-picker"
              popper-class="ink-date-picker-popper"
              :disabled-date="disabledDate"
              clearable
            />
          </div>
        </div>

        <!-- 作品状态 -->
        <div class="filter-row">
          <span class="filter-label">类型：</span>
          <div class="filter-content">
            <span :class="['filter-tag', gender === 'male' ? 'filter-tag-active' : '']" @click="handleGenderChange('male')">
              男频
            </span>
            <span :class="['filter-tag', gender === 'female' ? 'filter-tag-active' : '']" @click="handleGenderChange('female')">
              女频
            </span>
          </div>
        </div>

        <!-- 主题分类 -->
        <div class="filter-row">
          <span class="filter-label">主题分类：</span>
          <div class="filter-content tags-content">
            <!-- 来源加载中/失败时不渲染“暂无”文案，避免把网络问题误判成后台未配置 -->
            <template v-if="sourcesLoading">
              <span v-for="i in 4" :key="`category-skeleton-${i}`" class="filter-tag-skeleton"></span>
            </template>
            <template v-else-if="sourcesError">
              <span class="no-data">{{ sourcesError }}</span>
              <button class="ink-btn ink-btn-outline ink-btn-sm" type="button" @click="retrySources">
                <i class="fa-solid fa-rotate-right"></i>
                重试
              </button>
            </template>
            <template v-else>
              <span
                v-for="c in categoryTagOptions"
                :key="c.code"
                :class="['filter-tag', (useDerivedCategories ? String(selectedCategoryCode) === String(c.code) : String(selectedSourceId) === String(c.code)) ? 'filter-tag-active' : '']"
                @click="selectCategoryTag(c.code)"
              >
                {{ c.name }}
              </span>
              <span v-if="!sourcesAll.length" class="no-data">暂无榜单来源，请在后台配置</span>
              <span v-else-if="useDerivedCategories && derivedCategories.length === 0" class="no-data">暂无分类（请先抓取总榜以生成分类）</span>
              <span v-else-if="!useDerivedCategories && !hasCategorySources" class="no-data">该榜单无可选分类</span>
            </template>
          </div>
        </div>

      </div>
    </div>

    <!-- 排行榜详情 -->
    <div ref="rankDetailRef">
      <div class="search-toolbar">
        <div class="search-box">
          <span class="search-label">搜索：</span>
          <el-input
            v-model="searchKeyword"
            placeholder="搜索作者名或作品名"
            class="search-input ink-search-input"
            clearable
            @clear="clearSearch"
            @keyup.enter="applySearch"
          >
            <template #append>
              <el-button type="primary" @click="applySearch">
                <i class="fa-solid fa-magnifying-glass"></i>
              </el-button>
            </template>
          </el-input>
        </div>
        <div class="toolbar-actions">
          <el-link type="primary" :underline="false" class="feedback-link" @click="goToFeedback">
            没找到我的作品，去反馈>>
          </el-link>
          <span class="total-count">共 {{ total }} 本作品</span>
          <button
            class="ink-btn ink-btn-accent ink-btn-sm"
            :disabled="exporting || total === 0"
            @click="exportXlsx"
          >
            <i class="fa-solid fa-file-export"></i>
            导出数据
          </button>
        </div>
      </div>

      <!-- 数据表格 -->
      <div class="data-table-container fusion-card">
        <el-table :data="displayTableData" stripe class="rank-table ink-table" v-loading="loading">
        <el-table-column label="排名" width="110" align="center">
          <template #default="{ row }">
            <div class="rank-cell">
              <i v-if="row.rankNo <= 3" class="fa-solid fa-medal medal-icon" :class="`medal-${row.rankNo}`"></i>
              <span v-else class="rank-number">{{ row.rankNo }}</span>
              <span v-if="isNewRank(row as NovelRankItem)" class="rank-delta-inline new">新上榜</span>
              <span v-else class="rank-delta-inline" :class="deltaClass(row.rankChangeDelta)">
                {{ formatRankDelta(row.rankChangeDelta) }}
              </span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="作品" min-width="320">
          <template #default="{ row }">
            <div class="book-cell">
              <el-image v-if="row.coverUrl" :src="row.coverUrl" fit="cover" class="book-cover">
                <template #error>
                  <div class="book-cover-fallback">{{ coverFallbackText(row as NovelRankItem) }}</div>
                </template>
              </el-image>
              <div class="book-meta">
                <div class="book-title">
                  <button
                    v-if="row.bookUrl"
                    type="button"
                    class="book-title-button"
                    @click.stop="openBook(row as NovelRankItem)"
                  >
                    {{ row.bookTitle }}
                  </button>
                  <span v-else>{{ row.bookTitle }}</span>
                </div>
                <el-tooltip
                  v-if="row.intro"
                  placement="top-start"
                  :show-after="250"
                  popper-class="ink-tooltip"
                >
                  <template #content>
                    <div class="intro-tooltip">{{ row.intro }}</div>
                  </template>
                  <div class="book-intro">{{ row.intro }}</div>
                </el-tooltip>
                <div v-else class="book-intro">-</div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="分类" width="120" align="center">
          <template #default="{ row }">
            <span v-if="getCategoryDisplay(row as NovelRankItem) !== '-'" class="category-tag">{{ getCategoryDisplay(row as NovelRankItem) }}</span>
            <span v-else>-</span>
          </template>
        </el-table-column>

        <el-table-column label="作者" width="120">
          <template #default="{ row }">
            <span class="link-text">{{ row.authorName || '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <span class="level-tag">{{ row.statusText || '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column v-if="showMetric" :label="metricLabel" width="110" align="right">
          <template #default="{ row }">
            <span class="mono-font">{{ formatReading((row as any).metricValue ?? row.readingCount) }}</span>
          </template>
        </el-table-column>

        <el-table-column v-if="showMetric" :label="`${metricLabel}变化`" width="120" align="right">
          <template #default="{ row }">
            <span :class="['metric-delta mono-font', deltaClass(row.metricDelta)]">
              {{ formatMetricDelta(row.metricDelta) }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="最近更新" width="140" align="center">
          <template #default="{ row }">
            <span class="mono-font">{{ row.lastUpdateTimeText || '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="160" align="center" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button size="small" class="track-button" @click.stop="openBook(row as NovelRankItem)">
                查看
              </el-button>
              <el-button size="small" class="compare-button" @click.stop="toggleCompare(row as NovelRankItem)">
                对比
              </el-button>
            </div>
          </template>
        </el-table-column>

        <!-- 加载失败与“真空态”区分：失败给出错误信息与重试入口 -->
        <template #empty>
          <div v-if="loadError" class="rank-table-error">
            <span>{{ loadError }}</span>
            <button class="ink-btn ink-btn-outline ink-btn-sm" type="button" @click="loadLatest">
              <i class="fa-solid fa-rotate-right"></i>
              重试
            </button>
          </div>
          <span v-else>暂无榜单数据</span>
        </template>
      </el-table>

        <div class="rank-card-list" v-loading="loading">
          <article v-for="row in displayTableData" :key="row.bookId || `${row.rankNo}-${row.bookTitle}`" class="rank-mobile-card">
            <div class="rank-mobile-head">
              <div class="rank-cell">
                <i v-if="row.rankNo <= 3" class="fa-solid fa-medal medal-icon" :class="`medal-${row.rankNo}`"></i>
                <span v-else class="rank-number">{{ row.rankNo }}</span>
                <span v-if="isNewRank(row as NovelRankItem)" class="rank-delta-inline new">新上榜</span>
                <span v-else class="rank-delta-inline" :class="deltaClass(row.rankChangeDelta)">
                  {{ formatRankDelta(row.rankChangeDelta) }}
                </span>
              </div>
              <span class="level-tag">{{ row.statusText || '-' }}</span>
            </div>
            <div class="rank-mobile-main">
              <el-image v-if="row.coverUrl" :src="row.coverUrl" fit="cover" class="book-cover">
                <template #error>
                  <div class="book-cover-fallback">{{ coverFallbackText(row) }}</div>
                </template>
              </el-image>
              <div class="book-meta">
                <div class="book-title">
                  <button
                    v-if="row.bookUrl"
                    type="button"
                    class="book-title-button"
                    @click.stop="openBook(row as NovelRankItem)"
                  >
                    {{ row.bookTitle }}
                  </button>
                  <span v-else>{{ row.bookTitle }}</span>
                </div>
                <div class="book-intro">{{ row.intro || '-' }}</div>
              </div>
            </div>
            <div class="rank-mobile-meta">
              <span><b>分类</b>{{ getCategoryDisplay(row) }}</span>
              <span><b>作者</b>{{ row.authorName || '-' }}</span>
              <span v-if="showMetric"><b>{{ metricLabel }}</b>{{ formatReading((row as any).metricValue ?? row.readingCount) }}</span>
              <span v-if="showMetric">
                <b>{{ metricLabel }}变化</b>
                <em :class="['metric-delta', deltaClass(row.metricDelta)]">{{ formatMetricDelta(row.metricDelta) }}</em>
              </span>
              <span><b>最近更新</b>{{ row.lastUpdateTimeText || '-' }}</span>
            </div>
            <div class="rank-mobile-actions">
              <el-button size="small" class="track-button" @click.stop="openBook(row as NovelRankItem)">查看</el-button>
              <el-button size="small" class="compare-button" @click.stop="toggleCompare(row as NovelRankItem)">对比</el-button>
            </div>
          </article>
          <div v-if="!loading && loadError && !displayTableData.length" class="rank-card-empty rank-card-empty--error">
            <span>{{ loadError }}</span>
            <button class="ink-btn ink-btn-outline ink-btn-sm" type="button" @click="loadLatest">
              <i class="fa-solid fa-rotate-right"></i>
              重试
            </button>
          </div>
          <div v-else-if="!loading && !displayTableData.length" class="rank-card-empty">暂无榜单数据</div>
        </div>

        <!-- 分页 -->
        <div class="pagination-wrapper ink-pagination">
          <el-pagination
v-model:current-page="currentPage" v-model:page-size="pageSize" :total="total"
            layout="total, prev, pager, next" background />
        </div>
      </div>
    </div>

    <!-- 数据分析 -->
    <div v-show="analysisVisible" ref="analysisSectionRef" class="analysis-panel">
      <div class="analysis-header">
        <div class="analysis-title">
          <div class="analysis-title-main">数据分析</div>
          <div class="analysis-title-sub">{{ analysisSubtitle }}</div>
          <div v-if="analysisNotice" class="analysis-status-tip">{{ analysisNotice }}</div>
        </div>
        <div class="analysis-actions">
          <el-radio-group v-model="analysisDays" size="small" class="ink-radio-group">
            <el-radio-button :label="7">7天</el-radio-button>
            <el-radio-button :label="15">15天</el-radio-button>
            <el-radio-button :label="30">30天</el-radio-button>
          </el-radio-group>
          <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="analysisLoading" @click="refreshAnalysis">
            <i class="fa-solid fa-rotate-right"></i>
            刷新
          </button>
          <button
            class="ink-btn ink-btn-outline ink-btn-sm"
            :disabled="aiReportLoading"
            title="用你配置的模型解读当前榜单数据（只发送榜单数据，不含写作内容）"
            @click="handleAiReport"
          >
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            {{ aiReportLoading ? '解读中...' : 'AI 解读' }}
          </button>
        </div>
      </div>

      <div v-if="aiReportText" class="ai-report fusion-card">
        <div class="ai-report-header">
          <span>AI 趋势解读</span>
          <button class="ink-btn ink-btn-outline ink-btn-sm" @click="aiReportText = ''">收起</button>
        </div>
        <div class="ai-report-body">{{ aiReportText }}</div>
      </div>


      <div class="analysis-grid">
        <div class="analysis-block fusion-card">
          <div class="analysis-block-header">
            <span>分类占比</span>
            <span class="analysis-hint">Top 10</span>
          </div>
          <div class="analysis-chart-wrap">
            <div ref="categoryChartRef" class="analysis-chart"></div>
            <div v-if="categoryLoading" class="analysis-overlay">加载中...</div>
            <div v-else-if="categoryError" class="analysis-overlay">
              <div class="analysis-state-card">
                <span>{{ categoryError }}</span>
                <button class="ink-btn ink-btn-outline ink-btn-sm" @click="loadCategoryAnalysis">
                  重试
                </button>
              </div>
            </div>
            <div v-else-if="!analysisCategory?.list?.length" class="analysis-empty">暂无分类数据</div>
          </div>
        </div>
        <div class="analysis-block fusion-card">
          <div class="analysis-block-header">
            <span>标签风向</span>
            <span class="analysis-hint">Top {{ analysisTagTopN }}</span>
          </div>
          <div class="analysis-chart-wrap">
            <div ref="tagChartRef" class="analysis-chart"></div>
            <div v-if="tagLoading" class="analysis-overlay">加载中...</div>
            <div v-else-if="tagError" class="analysis-overlay">
              <div class="analysis-state-card">
                <span>{{ tagError }}</span>
                <button class="ink-btn ink-btn-outline ink-btn-sm" @click="loadTagAnalysis">
                  重试
                </button>
              </div>
            </div>
            <div v-else-if="!analysisTagTrends?.list?.length" class="analysis-empty">暂无标签趋势</div>
          </div>
          <div v-if="tagSummaryList.length" class="analysis-chip-list">
            <span v-for="tag in tagSummaryList" :key="tag.tag" class="analysis-chip">
              {{ tag.tag }}
              <em>{{ tag.total }}</em>
            </span>
          </div>
        </div>
      </div>

      <div class="analysis-grid analysis-grid-wide">
        <div class="analysis-block fusion-card">
          <div class="analysis-block-header">
            <span>榜单变化</span>
            <div class="analysis-hint-stack">
              <span>{{ analysisRankChange?.statDate || '-' }} / {{ analysisRankChange?.compareDate || '上期' }}</span>
              <span v-if="rankChangeHint">{{ rankChangeHint }}</span>
            </div>
          </div>
          <div class="analysis-change-list">
            <div v-if="!rankChangeSourceId" class="analysis-empty">当前为综合榜单，请选择主题分类查看变化</div>
            <div v-else-if="rankChangeLoading" class="analysis-overlay">加载中...</div>
            <div v-else-if="rankChangeError" class="analysis-empty analysis-empty-stack">
              <span>{{ rankChangeError }}</span>
              <button class="ink-btn ink-btn-outline ink-btn-sm" @click="loadRankChangeAnalysis">
                重试
              </button>
            </div>
            <div v-else-if="!analysisRankChange?.list?.length" class="analysis-empty">暂无变化数据</div>
            <div v-else>
              <div v-for="item in analysisRankChange.list.slice(0, 10)" :key="item.bookTitle" class="change-item">
                <span class="change-rank">{{ item.rankNo }}</span>
                <span class="change-title">{{ item.bookTitle }}</span>
                <span :class="['change-delta', item.rankChange > 0 ? 'up' : item.rankChange < 0 ? 'down' : 'flat']">
                  {{ item.rankChange > 0 ? `↑${item.rankChange}` : item.rankChange < 0 ? `↓${Math.abs(item.rankChange)}` : '—' }}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div class="analysis-block fusion-card">
          <div class="analysis-block-header">
            <span>竞品对比</span>
            <span class="analysis-hint">从榜单中添加作品进行对比</span>
          </div>
          <div class="analysis-compare-controls">
            <div class="analysis-compare-list">
              <span v-if="!compareList.length" class="analysis-empty-inline">暂无对比对象</span>
              <span v-for="item in compareList" :key="item.bookId" class="compare-chip">
                {{ item.bookTitle }}
                <i class="fa-solid fa-xmark" @click="removeCompare(item.bookId)"></i>
              </span>
            </div>
            <div class="analysis-compare-actions">
              <button class="ink-btn ink-btn-primary ink-btn-sm" :disabled="compareLoading || !compareList.length" @click="loadCompetitorCompare">
                开始对比
              </button>
              <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="!compareList.length" @click="clearCompare">
                清空
              </button>
            </div>
          </div>
          <div class="analysis-chart-wrap">
            <div ref="competitorChartRef" class="analysis-chart"></div>
            <div v-if="compareLoading" class="analysis-overlay">加载中...</div>
            <div v-else-if="compareError" class="analysis-overlay">
              <div class="analysis-state-card">
                <span>{{ compareError }}</span>
                <button class="ink-btn ink-btn-outline ink-btn-sm" :disabled="!compareList.length" @click="loadCompetitorCompare">
                  重试
                </button>
              </div>
            </div>
            <div v-else-if="!analysisCompetitor?.list?.length" class="analysis-empty">暂无竞品趋势</div>
          </div>
        </div>
        <!-- 作者趋势（暂时隐藏） -->
        <!--
        <div class="analysis-block fusion-card">
          <div class="analysis-block-header">
            <span>作者趋势</span>
            <span class="analysis-hint">作者维度热度变化</span>
          </div>
          <div class="analysis-author-form">
            <el-input
              v-model="authorNameInput"
              placeholder="输入作者名"
              class="ink-search-input"
              clearable
              @keyup.enter="loadAuthorTrend"
            >
              <template #append>
                <el-button type="primary" @click="loadAuthorTrend">查询</el-button>
              </template>
            </el-input>
            <button class="ink-btn ink-btn-outline ink-btn-sm" @click="useTopAuthor">
              使用榜首作者
            </button>
          </div>
          <div class="analysis-chart-wrap">
            <div ref="authorChartRef" class="analysis-chart"></div>
            <div v-if="authorLoading" class="analysis-overlay">加载中...</div>
            <div v-else-if="!analysisAuthorTrend?.list?.length" class="analysis-empty">暂无作者趋势</div>
          </div>
        </div>
        -->
      </div>
    </div>

    <button
      v-show="showBackTop"
      class="back-top-btn"
      aria-label="滚动到顶部"
      @click="scrollToTop"
    >
      <i class="fa-solid fa-arrow-up"></i>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import dayjs from 'dayjs'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { echarts, type EChartsInstance, type EChartsOption } from '@/utils/echarts'
import { useRoute, useRouter } from 'vue-router'
import { useNovelRankStore } from '@/stores/novel-rank'
import { extractApiErrorMessage, isCanceledRequest, showApiError } from '@/utils/api-error'
// 开源版：榜单数据全部来自本机爬虫快照（storage/local-rank-store），零服务端请求
import {
  getLocalRankLatest as getNovelRankLatestApi,
  getLocalRankLatestAll as getNovelRankLatestAllApi,
  getLocalRankPlatforms as getNovelRankPlatformsApi,
  getLocalRankSources as getNovelRankSourcesApi,
  getLocalRankCategories as getNovelRankCategoriesApi,
  getLocalRankHomePreference as getNovelRankHomePreferenceApi,
  saveLocalRankHomePreference as saveNovelRankHomePreferenceApi,
  cancelLocalRankHomePreference as cancelNovelRankHomePreferenceApi,
  crawlLocalRankSource,
  maybeAutoCrawlLocalRank,
  getLocalRankSettings,
  saveLocalRankSettings,
  type RankCrawlMode,
} from '@/storage/local-rank-store'
import {
  exportLocalRankCsv,
  getLocalRankCategoryDistribution as getNovelRankAnalysisCategoryDistributionApi,
  getLocalRankTagTrends as getNovelRankAnalysisTagTrendsApi,
  getLocalRankChange as getNovelRankAnalysisRankChangeApi,
  getLocalRankCompetitor as getNovelRankAnalysisCompetitorApi,
  getLocalRankAuthorTrend as getNovelRankAnalysisAuthorTrendApi,
} from '@/storage/local-rank-analysis'
import {
  type NovelRankItem,
  type NovelRankCategoryOption,
  type NovelRankPlatform,
  type NovelRankSnapshot,
  type NovelRankSource,
  type NovelRankCategoryDistributionResult,
  type NovelRankTagTrendResult,
  type NovelRankChangeResult,
  type NovelRankCompetitorResult,
  type NovelRankAuthorTrendResult,
  type NovelRankHomePreference
} from '@/types/novel-rank'
import { saveBlobFile } from '@/utils/download'
import { openLink } from '@/utils/external-link'
import { NO_MODEL_MESSAGE, requestLocalChatCompletion } from '@/utils/local-ai-client'
import { buildRankTrendReportMessages } from '@/config/ai-prompts'
import { useAiModelStore } from '@/stores/ai-model'

const router = useRouter()
const route = useRoute()
const novelRankStore = useNovelRankStore()
const platforms = ref<NovelRankPlatform[]>([])

const selectedPlatform = ref<string>('fanqie')
const rankType = ref<string>('reading')
// 默认显示当天日期
const selectedDate = ref<Date | null>(new Date())
// 对比日期为空时默认使用上一日
const selectedCompareDate = ref<Date | null>(null)
// 默认不按日期筛选（只展示“最新”）；当用户手动改动日期后才启用 statDate 过滤
const dateTouched = ref(false)
const gender = ref<'male' | 'female'>('male')

// 0 表示“全部分类（服务端聚合）”
const selectedSourceId = ref<number | null>(0)
// 起点“只抓总榜再按分类过滤”模式：选择的分类 code（如 chanId21）；空串表示“全部”
const selectedCategoryCode = ref<string>('')
// 后台配置的所有榜单来源（同一平台+频段下可能包含多个榜单类型）
const sourcesAll = ref<NovelRankSource[]>([])
// 平台/来源请求三态：loading 显示骨架、error 显示重试、成功且为空才显示“暂无”
// 初始为 true：首帧渲染发生在 onMounted 发起请求之前，避免闪现“暂无平台”
const platformsLoading = ref(true)
const platformsError = ref('')
const sourcesLoading = ref(true)
const sourcesError = ref('')
// 起点从数据库分类表返回的“可筛选分类”（无需配置分类榜单来源）
const derivedCategories = ref<NovelRankCategoryOption[]>([])
const snapshot = ref<NovelRankSnapshot | null>(null)

const searchKeyword = ref('')
const searchApplied = ref('')
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const exporting = ref(false)
const homePreferenceSaving = ref(false)
const currentHomePreference = ref<NovelRankHomePreference | null>(null)

const tableData = ref<NovelRankItem[]>([])

const analysisVisible = ref(false)
const analysisDays = ref(7)
const analysisLoading = ref(false)
const compareLoading = ref(false)
const authorLoading = ref(false)
const analysisNotice = ref('')
const categoryLoading = ref(false)
const categoryError = ref('')
const tagLoading = ref(false)
const tagError = ref('')
const rankChangeLoading = ref(false)
const rankChangeError = ref('')
const compareError = ref('')
const authorError = ref('')

const analysisCategory = ref<NovelRankCategoryDistributionResult | null>(null)
const analysisTagTrends = ref<NovelRankTagTrendResult | null>(null)
const analysisRankChange = ref<NovelRankChangeResult | null>(null)
const analysisCompetitor = ref<NovelRankCompetitorResult | null>(null)
const analysisAuthorTrend = ref<NovelRankAuthorTrendResult | null>(null)

const analysisTagTopN = 6

const compareList = ref<Array<{ bookId: string; bookTitle: string }>>([])
const authorNameInput = ref('')

const categoryChartRef = ref<HTMLDivElement | null>(null)
const tagChartRef = ref<HTMLDivElement | null>(null)
const competitorChartRef = ref<HTMLDivElement | null>(null)
const authorChartRef = ref<HTMLDivElement | null>(null)
const analysisSectionRef = ref<HTMLDivElement | null>(null)
const rankDetailRef = ref<HTMLDivElement | null>(null)
const showBackTop = ref(false)
const scrollContainerRef = ref<HTMLElement | null>(null)

let categoryChart: EChartsInstance | null = null
let tagChart: EChartsInstance | null = null
let competitorChart: EChartsInstance | null = null
let authorChart: EChartsInstance | null = null
let analysisResizeObserver: ResizeObserver | null = null
let analysisThemeObserver: MutationObserver | null = null
// 平台和频段切换会批量重置筛选项，期间只允许显式入口统一拉取一次。
let sourceScopeRefreshing = false
const pendingRouteFilter = ref<{ sourceId: number | null; categoryCode: string; categoryName: string } | null>(null)

const siteCode = computed(() => selectedPlatform.value)

// 当前筛选条件下“最新可用统计日”（用于限制日期选择器不能选未来/无数据日期）
const maxAvailableStatDate = ref<string | null>(null)

const maxAvailableDate = computed(() => {
  const d = maxAvailableStatDate.value
  if (d) return dayjs(d)
  return dayjs()
})

const disabledDate = (date: Date) => {
  return dayjs(date).isAfter(maxAvailableDate.value, 'day')
}

const selectedCategoryName = computed(() => {
  const id = selectedSourceId.value
  if (!id || id === 0) return null
  const hit = categoryOptions.value.find(c => c.id === id)
  return hit?.name || null
})

const selectedDerivedCategoryName = computed(() => {
  const code = String(selectedCategoryCode.value || '').trim()
  if (!code) return null
  const hit = derivedCategories.value.find(c => String(c.code) === code)
  return hit?.name || null
})

const displayTableData = computed(() => {
  const selectedName = selectedDerivedCategoryName.value || selectedCategoryName.value
  return (tableData.value || []).map(row => ({
    ...row,
    // 单分类榜单接口通常不返回 categoryName，这里用当前选中的分类名补齐展示
    categoryName: row.categoryName || selectedName,
    // 指标字段兜底（不同站点榜单指标不同：在读/月票/热度/等）
    metricValue: row.metricValue ?? row.readingCount ?? null,
    metricText: row.metricText ?? row.readingText ?? null,
    metricName: row.metricName ?? snapshot.value?.meta?.metricName ?? null
  }))
})

const getCategoryDisplay = (row: NovelRankItem) => {
  const main = String(row?.categoryMainName || '').trim()
  const sub = String(row?.categorySubName || '').trim()
  if (main && sub && main !== sub) return `${main}-${sub}`
  if (sub) return sub
  if (main) return main
  const categoryName = String(row?.categoryName || '').trim()
  return categoryName || '-'
}

// 封面加载失败时的占位字符：取书名首字（Array.from 兼容生僻字/表情等代理对）
const coverFallbackText = (row: NovelRankItem) => {
  const title = String(row?.bookTitle || '').trim()
  return title ? Array.from(title)[0] : '书'
}

const statDate = computed(() => {
  if (!dateTouched.value) return undefined
  if (!selectedDate.value) return undefined
  return dayjs(selectedDate.value).format('YYYY-MM-DD')
})

const compareDate = computed(() => {
  if (!selectedCompareDate.value) return undefined
  return dayjs(selectedCompareDate.value).format('YYYY-MM-DD')
})

// const pageTitle = computed(() => snapshot.value?.pageTitle || '全网风向标')
const cutoffText = computed(() => snapshot.value?.cutoffText || '')

const defaultMetricConfig = (site: string, type: string) => {
  const s = String(site || '').trim()
  const t = String(type || '').trim()
  if (s === 'fanqie' && t === 'reading') return { metricName: '在读', metricMode: 'value' as const }
  if (s === 'qidian' && t === 'monthTicket') return { metricName: '月票', metricMode: 'value' as const }
  return { metricName: null, metricMode: 'none' as const }
}

const currentAllSource = computed(() => {
  return sourcesAll.value.find(s => String(s.rankType || '') === String(rankType.value || '') && s.scope === 'all') || null
})

const currentSelectedSource = computed(() => {
  const sid = selectedSourceId.value
  if (!sid || sid === 0) return null
  return sourcesAll.value.find(s => Number(s.id) === Number(sid)) || null
})

const activeSourceForMetric = computed(() => {
  // “全部”在非番茄时优先走站点原生总榜（scope=all 的 source）
  if (selectedSourceId.value === 0 && selectedPlatform.value !== 'fanqie') return currentAllSource.value
  return currentSelectedSource.value
})

const metricMode = computed(() => {
  const metaMode = snapshot.value?.meta?.metricMode
  if (metaMode) return String(metaMode)
  const srcMode = activeSourceForMetric.value?.metricMode
  if (srcMode) return String(srcMode)
  return defaultMetricConfig(siteCode.value, rankType.value).metricMode
})

const metricLabel = computed(() => {
  const metaName = snapshot.value?.meta?.metricName
  if (metaName) return String(metaName)
  const srcName = activeSourceForMetric.value?.metricName
  if (srcName) return String(srcName)
  return defaultMetricConfig(siteCode.value, rankType.value).metricName || '指标'
})

const showMetric = computed(() => {
  return String(metricMode.value) !== 'none' && !!String(metricLabel.value || '').trim()
})

const analysisStatDate = computed(() => {
  if (dateTouched.value && selectedDate.value) return dayjs(selectedDate.value).format('YYYY-MM-DD')
  return snapshot.value?.statDate || undefined
})

const analysisCategoryCode = computed(() => {
  if (!useDerivedCategories.value) return undefined
  return String(selectedCategoryCode.value || '').trim() || undefined
})

const analysisScopedCategoryCode = computed(() => {
  if (analysisCategoryCode.value) return analysisCategoryCode.value
  const sourceCategoryCode = String(currentSelectedSource.value?.categoryCode || '').trim()
  return sourceCategoryCode || undefined
})

const analysisSourceId = computed(() => {
  if (selectedSourceId.value && selectedSourceId.value !== 0) return Number(selectedSourceId.value)
  if (currentAllSource.value?.id) return Number(currentAllSource.value.id)
  return null
})

const rankChangeSource = computed(() => {
  if (analysisSourceId.value) {
    return sourcesAll.value.find(s => Number(s.id) === Number(analysisSourceId.value)) || null
  }
  if (selectedPlatform.value === 'fanqie' && categorySources.value.length > 0) {
    return categorySources.value[0]
  }
  return null
})

const rankChangeSourceId = computed(() => {
  return rankChangeSource.value?.id ? Number(rankChangeSource.value.id) : null
})

const rankChangeHint = computed(() => {
  if (!rankChangeSource.value) return ''
  const name = rankChangeSource.value.categoryName || rankChangeSource.value.title || `来源#${rankChangeSource.value.id}`
  if (!analysisSourceId.value && selectedPlatform.value === 'fanqie') return `默认分类：${name}`
  return name
})

const analysisSubtitle = computed(() => {
  const platformName = platforms.value.find(p => p.code === selectedPlatform.value)?.name || selectedPlatform.value
  const rankLabel = rankTypeOptions.value.find(t => t.value === rankType.value)?.label || rankType.value
  const genderLabel = gender.value === 'female' ? '女频' : '男频'
  const scopeName = selectedSourceId.value === 0
    ? (selectedPlatform.value === 'fanqie' ? '全部分类' : (selectedDerivedCategoryName.value || '全部'))
    : (selectedCategoryName.value || '分类榜单')
  const dateLabel = analysisStatDate.value || '最新'
  return `${platformName} · ${rankLabel} · ${genderLabel} · ${scopeName} · ${dateLabel}`
})

const feedbackQuery = computed(() => {
  const platformName = platforms.value.find(p => p.code === selectedPlatform.value)?.name || selectedPlatform.value
  const rankLabel = rankTypeOptions.value.find(t => t.value === rankType.value)?.label || rankType.value
  const genderLabel = gender.value === 'female' ? '女频' : '男频'
  const categoryName = selectedDerivedCategoryName.value || selectedCategoryName.value || '全部'
  const keyword = String(searchApplied.value || searchKeyword.value || '').trim()
  return Object.fromEntries(
    Object.entries({
      from: 'novelRank',
      platform: selectedPlatform.value,
      platformName,
      rankType: rankType.value,
      rankTypeLabel: rankLabel,
      gender: gender.value,
      genderLabel,
      categoryCode: analysisScopedCategoryCode.value,
      categoryName,
      keyword: keyword || undefined,
      bookTitle: keyword || undefined,
      statDate: analysisStatDate.value,
      compareDate: compareDate.value
    }).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
  )
})

const buildCurrentHomeFilter = (): NovelRankHomePreference => {
  const nativeAllSourceId =
    selectedSourceId.value === 0 && selectedPlatform.value !== 'fanqie'
      ? (currentAllSource.value?.id ? Number(currentAllSource.value.id) : null)
      : null
  const pickedSourceId =
    selectedSourceId.value && selectedSourceId.value !== 0 ? Number(selectedSourceId.value) : nativeAllSourceId
  const categoryCode = useDerivedCategories.value
    ? String(selectedCategoryCode.value || '').trim()
    : String(currentSelectedSource.value?.categoryCode || '').trim()
  return {
    siteCode: selectedPlatform.value,
    rankType: rankType.value,
    gender: gender.value,
    sourceId: pickedSourceId || null,
    categoryCode: categoryCode || null,
    categoryName: selectedDerivedCategoryName.value || selectedCategoryName.value || null
  }
}

// 首页偏好比较必须按真实筛选字段判断，避免同名榜单下男女频互相误判。
const sameHomePreference = (a: NovelRankHomePreference | null, b: NovelRankHomePreference | null) => {
  if (!a || !b) return false
  return String(a.siteCode || '') === String(b.siteCode || '')
    && String(a.rankType || '') === String(b.rankType || '')
    && String(a.gender || '') === String(b.gender || '')
    && Number(a.sourceId || 0) === Number(b.sourceId || 0)
    && String(a.categoryCode || '') === String(b.categoryCode || '')
}

const currentHomeFilter = computed(() => buildCurrentHomeFilter())
const isCurrentHomePreference = computed(() => sameHomePreference(currentHomePreference.value, currentHomeFilter.value))

// ---------- 本机抓取控制（三档：关闭 / 手动 / 自动每日补抓） ----------
const crawlMode = ref<RankCrawlMode>('manual')
const crawling = ref(false)
const crawlStatusText = ref('')
const crawlModeOptions: Array<{ value: RankCrawlMode; label: string; desc: string }> = [
  { value: 'off', label: '关闭', desc: '不发出任何抓取请求，仅查看已有本机数据' },
  { value: 'manual', label: '手动', desc: '点击抓取按钮时才抓取' },
  { value: 'auto', label: '自动', desc: '每天自动补抓最近看过的榜单，趋势与分析随之积累' },
]

// 番茄的“全部”没有单独来源，确认后抓取当前频段和榜单类型下的分类来源。
const crawlTargetSourceId = computed(() => analysisSourceId.value)
const crawlConfirming = ref(false)
let crawlStopRequested = false
let rankPageActive = true
const crawlAllCategories = computed(() =>
  selectedPlatform.value === 'fanqie' && !crawlTargetSourceId.value && categorySources.value.length > 0
)
const crawlButtonDisabled = computed(() =>
  crawlMode.value === 'off' || crawling.value || crawlConfirming.value || sourcesLoading.value || !!sourcesError.value
  || (!crawlTargetSourceId.value && !crawlAllCategories.value)
)
const crawlButtonText = computed(() => {
  if (crawling.value) return '抓取中…'
  if (crawlMode.value === 'off') return '抓取已关闭'
  if (sourcesLoading.value) return '正在加载分类…'
  if (sourcesError.value) return '榜单来源加载失败'
  if (crawlAllCategories.value) return '抓取全部分类'
  const source = currentSelectedSource.value || currentAllSource.value
  return source ? `抓取「${source.categoryName || source.title || '当前榜单'}」` : '暂无可抓取榜单'
})

const loadCrawlSettings = async () => {
  try {
    const settings = await getLocalRankSettings()
    crawlMode.value = settings.mode
    crawlStatusText.value = settings.mode === 'auto' ? settings.lastAutoSummary : ''
  } catch {
    // 设置读取失败保持默认（手动）
  }
}

const handleCrawlModeChange = async (mode: RankCrawlMode) => {
  if (crawling.value && mode !== 'off') return
  if (mode === 'off') crawlStopRequested = true
  crawlMode.value = mode
  await saveLocalRankSettings({ mode })
  if (mode === 'auto') {
    crawlStatusText.value = '自动模式已开启：每天自动补抓最近看过的榜单'
    void maybeAutoCrawlLocalRank().then(loadCrawlSettings)
  } else if (mode === 'off') {
    crawlStatusText.value = crawling.value
      ? '已请求停止，当前分类结束后不再抓取后续分类'
      : '抓取已关闭，仅展示已有本机数据'
  } else {
    crawlStatusText.value = ''
  }
}

const handleCrawlNow = async () => {
  if (crawlButtonDisabled.value) return
  const batch = crawlAllCategories.value
  const targets = batch
    ? [...categorySources.value]
    : sourcesAll.value.filter(source => Number(source.id) === Number(crawlTargetSourceId.value))
  if (!targets.length) return
  const scopeKey = `${selectedPlatform.value}:${gender.value}:${rankType.value}`
  const scopeLabel = `${platforms.value.find(platform => platform.code === selectedPlatform.value)?.name || selectedPlatform.value} · ${gender.value === 'male' ? '男频' : '女频'} · ${rankTypeOptions.value.find(option => option.value === rankType.value)?.label || rankType.value}`

  if (batch) {
    crawlConfirming.value = true
    try {
      await inkConfirm(
        `当前未选择具体分类，是否抓取「${scopeLabel}」的全部 ${targets.length} 个分类？将依次抓取，耗时较长。`,
        '抓取全部分类',
        { confirmButtonText: '确认抓取全部', cancelButtonText: '取消', type: 'warning', closeOnClickModal: false }
      )
    } catch {
      return
    } finally {
      crawlConfirming.value = false
    }
    if (!rankPageActive || crawlButtonDisabled.value || scopeKey !== `${selectedPlatform.value}:${gender.value}:${rankType.value}`) return
  }

  crawling.value = true
  crawlStopRequested = false
  let updated = 0
  let cached = 0
  let processed = 0
  let lastMessage = ''
  const failures: Array<{ name: string; message: string }> = []
  try {
    for (const [index, source] of targets.entries()) {
      if (crawlStopRequested || !rankPageActive) break
      const name = source.categoryName || source.title || '当前榜单'
      crawlStatusText.value = batch
        ? `${scopeLabel}：正在抓取 ${index + 1}/${targets.length} · ${name}`
        : `正在抓取「${name}」…`
      let waitBeforeNext = true
      try {
        const outcome = await crawlLocalRankSource(Number(source.id), { manual: true })
        lastMessage = outcome.message
        if (outcome.crawled) updated += 1
        else if (outcome.snapshotDate) { cached += 1; waitBeforeNext = false }
        else { crawlStopRequested = true; break }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '抓取失败，请稍后重试')
        failures.push({ name, message })
      }
      processed += 1
      // 顺序处理并保留请求间隔；缓存命中不额外等待。
      if (batch && waitBeforeNext && index < targets.length - 1 && !crawlStopRequested && rankPageActive) {
        await new Promise(resolve => setTimeout(resolve, 1200))
      }
    }
    if (!rankPageActive) return
    const stopped = processed < targets.length
    const summary = batch
      ? `${scopeLabel}：${stopped ? '已停止' : '抓取完成'}（${processed}/${targets.length}）：更新 ${updated} 个分类${cached ? `，使用已有数据 ${cached} 个` : ''}${failures.length ? `，失败 ${failures.length} 个（${failures.map(item => item.name).join('、')}）` : ''}`
      : failures[0]?.message || lastMessage
    crawlStatusText.value = summary
    if (updated || cached) {
      await loadLatest()
      await refreshAnalysis()
    }
    if (failures.length) (updated || cached ? ElMessage.warning : ElMessage.error)(summary)
    else if (stopped || !updated) ElMessage.info(summary)
    else ElMessage.success(summary)
  } catch (error) {
    const message = String(error?.message || '抓取失败，请稍后重试')
    if (rankPageActive) {
      crawlStatusText.value = message
      ElMessage.error(message)
    }
  } finally {
    crawling.value = false
  }
}

// ---- AI 趋势解读：把当前榜单/变化/分布数据喂给用户自己的模型，生成大白话报告 ----
const aiModelStore = useAiModelStore()
const aiReportLoading = ref(false)
const aiReportText = ref('')

const buildAiReportLines = () => {
  const rankLines = (tableData.value || []).slice(0, 20).map(item => {
    const delta = item.rankChangeDelta
    const move =
      delta == null ? '' : delta > 0 ? ` / 名次↑${delta}` : delta < 0 ? ` / 名次↓${Math.abs(delta)}` : ' / 名次持平'
    const metric = item.metricText ? ` / ${metricLabel.value || '指标'} ${item.metricText}` : ''
    return `${item.rankNo}. ${item.bookTitle} / ${item.authorName || '佚名'} / ${item.categoryName || '未分类'}${metric}${move}`
  })
  const changeLines = (analysisRankChange.value?.list || []).slice(0, 10).map(item => {
    const change = Number(item.rankChange || 0)
    const arrow = change > 0 ? `↑${change}` : change < 0 ? `↓${Math.abs(change)}` : '—'
    return `${item.bookTitle} ${arrow}（现第${item.rankNo}）`
  })
  const categoryLines = (analysisCategory.value?.list || [])
    .slice(0, 8)
    .map(item => `${item.categoryName} ${(item.ratio * 100).toFixed(0)}%（${item.count} 本）`)
  return { rankLines, changeLines, categoryLines }
}

const handleAiReport = async () => {
  if (aiReportLoading.value) return
  const { rankLines, changeLines, categoryLines } = buildAiReportLines()
  if (!rankLines.length) {
    ElMessage.warning('当前没有榜单数据，先抓取一次再解读')
    return
  }
  const modelCode = await aiModelStore.ensureTextModel()
  if (!modelCode) {
    ElMessage.warning(NO_MODEL_MESSAGE)
    return
  }
  aiReportLoading.value = true
  try {
    const report = await requestLocalChatCompletion({
      scene: 'rank_report',
      sceneLabel: '榜单趋势解读',
      modelCode,
      messages: buildRankTrendReportMessages({
        context: analysisSubtitle.value,
        rankLines,
        changeLines,
        categoryLines,
      }),
    })
    const text = String(report || '').trim()
    if (!text) throw new Error('AI 未返回解读内容')
    aiReportText.value = text
  } catch (error) {
    if (error?.name === 'AbortError') return
    ElMessage.error(String(error?.message || 'AI 解读失败，请稍后重试'))
  } finally {
    aiReportLoading.value = false
  }
}

const loadHomePreference = async () => {
  try {
    const { data } = await getNovelRankHomePreferenceApi()
    currentHomePreference.value = data || null
  } catch (e) {
    if (Number(e?.code) !== 401 && !e?.__handled) showApiError(e, '获取首页风向失败')
  }
}

const recordRecentFilter = () => {
  novelRankStore.setLastFilter(buildCurrentHomeFilter())
}

const saveHomePreference = async () => {
  if (homePreferenceSaving.value) return
  homePreferenceSaving.value = true
  try {
    const payload = buildCurrentHomeFilter()
    const { data } = await saveNovelRankHomePreferenceApi(payload)
    const savedPreference = data || payload
    currentHomePreference.value = savedPreference
    novelRankStore.setLastFilter(savedPreference)
    ElMessage.success('已设为首页风向')
  } catch (e) {
    if (Number(e?.code) !== 401 && !e?.__handled) showApiError(e, '保存首页风向失败')
  } finally {
    homePreferenceSaving.value = false
  }
}

const cancelHomePreference = async () => {
  if (homePreferenceSaving.value) return
  homePreferenceSaving.value = true
  try {
    await cancelNovelRankHomePreferenceApi()
    currentHomePreference.value = null
    ElMessage.success('已取消首页风向')
  } catch (e) {
    if (Number(e?.code) !== 401 && !e?.__handled) showApiError(e, '取消首页风向失败')
  } finally {
    homePreferenceSaving.value = false
  }
}

const toggleHomePreference = async () => {
  if (isCurrentHomePreference.value) {
    await cancelHomePreference()
    return
  }
  await saveHomePreference()
}

const tagSummaryList = computed(() => {
  const list = analysisTagTrends.value?.list || []
  return list
    .map(item => ({
      tag: item.tag,
      total: item.series.reduce((sum, s) => sum + (Number(s.count) || 0), 0)
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, analysisTagTopN)
})

const categorySources = computed(() => {
  return sourcesAll.value.filter(s => String(s.rankType || '') === String(rankType.value || '') && s.scope !== 'all')
})

const useDerivedCategories = computed(() => {
  return (selectedPlatform.value === 'qidian' || selectedPlatform.value === 'qimao') && !!currentAllSource.value && categorySources.value.length === 0
})

const categoryOptions = computed(() => {
  const list = categorySources.value.map(s => ({
    id: s.id,
    name: s.categoryName || s.title || `来源#${s.id}`
  }))
  return [{ id: 0, name: '全部' }, ...list]
})

const categoryTagOptions = computed(() => {
  if (useDerivedCategories.value) {
    const list = derivedCategories.value.map(c => ({ code: c.code, name: c.name }))
    return [{ code: '', name: '全部' }, ...list]
  }
  return categoryOptions.value.map(c => ({ code: String(c.id), name: c.name }))
})

const hasCategorySources = computed(() => categorySources.value.length > 0)

const rankTypeOptions = computed(() => {
  // 榜单类型完全由后台配置：同一个 rankType 下建议统一 title 作为“标签名称”
  const map = new Map<string, string>()
  for (const s of sourcesAll.value) {
    const t = String(s.rankType || '').trim()
    if (!t) continue
    if (!map.has(t)) {
      const label = String(s.title || '').trim() || t
      map.set(t, label)
    }
  }
  const list = Array.from(map.entries()).map(([value, label]) => ({ value, label }))
  // 未配置时兜底一个“榜单”，避免 tabs 空白
  return list.length ? list : [{ value: 'default', label: '榜单' }]
})

const platformIcon = (code: string) => {
  const map: Record<string, string> = {
    fanqie: 'fa-fire',
    qidian: 'fa-book',
    jjwxc: 'fa-leaf',
    qimao: 'fa-cat',
    zongheng: 'fa-book-open'
  }
  return map[code] || 'fa-globe'
}

const formatReading = (n: number) => {
  const num = Number(n) || 0
  if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`
  return String(num)
}

const isNewRank = (row: NovelRankItem) => {
  const compareDate = snapshot.value?.meta?.compareDate
  if (!compareDate) return false
  const prev = row?.prevRankNo
  return !Number.isFinite(prev as number) || (prev as number) <= 0
}

const deltaClass = (delta?: number | null) => {
  if (!Number.isFinite(delta as number)) return 'flat'
  if ((delta as number) > 0) return 'up'
  if ((delta as number) < 0) return 'down'
  return 'flat'
}

const formatRankDelta = (delta?: number | null) => {
  if (!Number.isFinite(delta as number)) return ''
  if ((delta as number) === 0) return ''
  if ((delta as number) > 0) return `↑${delta}`
  return `↓${Math.abs(delta as number)}`
}

const formatMetricDelta = (delta?: number | null) => {
  if (!Number.isFinite(delta as number)) return ''
  if ((delta as number) === 0) return '—'
  const abs = Math.abs(delta as number)
  const text = formatReading(abs)
  return (delta as number) > 0 ? `↑${text}` : `↓${text}`
}

const getBookIdFromItem = (row: NovelRankItem) => {
  const raw = String(row?.bookId || '').trim()
  if (raw) return raw
  const url = String(row.bookUrl || '').trim()
  const m = url.match(/\/(?:page|book|shuku)\/(\d+)/) || url.match(/\/shuku\/(\d+)/)
  return m?.[1] ? String(m[1]) : ''
}

// 首页跳转会带入筛选参数，必须在首次拉取来源前恢复基础状态。
const applyRouteFilter = () => {
  const site = String(route.query.siteCode || '').trim()
  const type = String(route.query.rankType || '').trim()
  const routeGender = String(route.query.gender || '').trim()
  if (site) selectedPlatform.value = site
  if (type) rankType.value = type
  if (routeGender === 'male' || routeGender === 'female') gender.value = routeGender
  const sourceId = Number(route.query.sourceId || 0)
  const categoryCode = String(route.query.categoryCode || '').trim()
  const categoryName = String(route.query.categoryName || '').trim()
  if ((Number.isFinite(sourceId) && sourceId > 0) || categoryCode || categoryName) {
    pendingRouteFilter.value = {
      sourceId: Number.isFinite(sourceId) && sourceId > 0 ? sourceId : null,
      categoryCode,
      categoryName
    }
  }
}

// 网络/超时类错误可自动重试一次；业务错误（服务端明确报错）直接进入失败态
const isTransientNetworkError = (e: { code?: unknown; message?: unknown } | null) => {
  const code = String(e?.code || '')
  if (code === 'ECONNABORTED' || code === 'ERR_NETWORK' || code === 'ETIMEDOUT' || code.includes('TIMEOUT')) return true
  const message = String(e?.message || '')
  return /timeout|Network Error|请求超时|网络错误/i.test(message)
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const loadPlatforms = async () => {
  platformsLoading.value = true
  platformsError.value = ''
  let retried = false
  while (true) {
    try {
      const { data } = await getNovelRankPlatformsApi()
      platforms.value = data || []
      if (platforms.value.length && !platforms.value.some(p => p.code === selectedPlatform.value)) {
        selectedPlatform.value = platforms.value[0].code
      }
      platformsLoading.value = false
      return
    } catch (e) {
      // 主动取消（重复请求/页面切换）：保持静默，由最新一次请求接管状态
      if (isCanceledRequest(e)) return
      if (!retried && isTransientNetworkError(e)) {
        retried = true
        await sleep(2000)
        continue
      }
      platforms.value = []
      platformsError.value = extractApiErrorMessage(e, '获取平台失败')
      platformsLoading.value = false
      if (Number(e?.code) !== 401 && !e?.__handled) showApiError(e, '获取平台失败')
      return
    }
  }
}

// 单次拉取来源（成功路径）：失败态与自动重试统一由 loadSources 处理
const loadSourcesOnce = async () => {
  // 不传 rankType：让“榜单类型 tabs”完全由后台配置决定
  const { data } = await getNovelRankSourcesApi({ siteCode: siteCode.value, gender: gender.value })
  sourcesAll.value = data.list || []
  // rankType 兜底：优先使用后台返回的第一个类型
  if (!sourcesAll.value.some(s => String(s.rankType) === String(rankType.value))) {
    rankType.value = sourcesAll.value[0]?.rankType || 'reading'
  }
  // 默认展示“全部分类”（服务端聚合）
  selectedSourceId.value = 0
  selectedCategoryCode.value = ''

  // 起点/七猫：若没有配置分类来源，则从数据库分类表读取（只抓总榜也可用）
  if (selectedPlatform.value === 'qidian' || selectedPlatform.value === 'qimao') {
    try {
      const { data: cats } = await getNovelRankCategoriesApi({ siteCode: siteCode.value, gender: gender.value, level: 1 })
      derivedCategories.value = Array.isArray(cats) ? cats : []
    } catch {
      derivedCategories.value = []
    }
  } else {
    derivedCategories.value = []
  }

  if (pendingRouteFilter.value) {
    const routeSourceId = Number(pendingRouteFilter.value.sourceId || 0)
    const routeCategoryCode = String(pendingRouteFilter.value.categoryCode || '').trim()
    if (routeSourceId && sourcesAll.value.some(source => Number(source.id) === routeSourceId)) {
      selectedSourceId.value = routeSourceId
    }
    if (routeCategoryCode) {
      selectedCategoryCode.value = routeCategoryCode
      selectedSourceId.value = 0
    }
    pendingRouteFilter.value = null
  }
}

const loadSources = async () => {
  sourcesLoading.value = true
  sourcesError.value = ''
  let retried = false
  while (true) {
    try {
      await loadSourcesOnce()
      sourcesLoading.value = false
      return
    } catch (e) {
      // 主动取消（重复请求/页面切换）：保持静默，由最新一次请求接管状态
      if (isCanceledRequest(e)) return
      if (!retried && isTransientNetworkError(e)) {
        retried = true
        await sleep(2000)
        continue
      }
      sourcesAll.value = []
      selectedSourceId.value = null
      selectedCategoryCode.value = ''
      derivedCategories.value = []
      sourcesError.value = extractApiErrorMessage(e, '获取分类失败')
      sourcesLoading.value = false
      if (Number(e?.code) !== 401 && !e?.__handled) showApiError(e, '获取分类失败')
      return
    }
  }
}

const loadLatest = async () => {
  // 每次请求前清空错误态，避免重试成功后仍残留旧错误。
  loadError.value = ''
  // “全部”：服务端聚合（按在读人数排序）
  if (selectedSourceId.value === 0) {
    // 起点等：若后台配置了站点原生“总榜”（scope=all），则“全部”直接取该来源，避免错误聚合
    const nativeAllSourceId =
      selectedPlatform.value !== 'fanqie' ? (currentAllSource.value?.id ? Number(currentAllSource.value.id) : null) : null
    if (nativeAllSourceId) {
      loading.value = true
      try {
        const { data } = await getNovelRankLatestApi({
          sourceId: nativeAllSourceId,
          statDate: statDate.value,
          compareDate: compareDate.value,
          keyword: searchApplied.value || undefined,
          categoryCode: useDerivedCategories.value ? (selectedCategoryCode.value || undefined) : undefined,
          page: currentPage.value,
          size: pageSize.value
        })
        snapshot.value = data.snapshot
        tableData.value = data.list || []
        total.value = data.total || 0
        recordRecentFilter()
        if (data.snapshot?.statDate) {
          if (!maxAvailableStatDate.value || dayjs(data.snapshot.statDate).isAfter(maxAvailableStatDate.value)) {
            maxAvailableStatDate.value = data.snapshot.statDate
          }
          if (!dateTouched.value && selectedDate.value) {
            const cur = dayjs(selectedDate.value)
            if (cur.isAfter(dayjs(data.snapshot.statDate), 'day')) {
              selectedDate.value = dayjs(data.snapshot.statDate).toDate()
            }
          }
        }
      } catch (e) {
        snapshot.value = null
        tableData.value = []
        total.value = 0
        if (Number(e?.code) !== 401 && e?.code !== 'ERR_CANCELED') {
          loadError.value = extractApiErrorMessage(e, '获取榜单失败')
          if (!e?.__handled) showApiError(e, '获取榜单失败')
        }
      } finally {
        loading.value = false
      }
      return
    }

    loading.value = true
    try {
      const { data } = await getNovelRankLatestAllApi({
        siteCode: siteCode.value,
        rankType: rankType.value,
        gender: gender.value,
        statDate: statDate.value,
        compareDate: compareDate.value,
        keyword: searchApplied.value || undefined,
        page: currentPage.value,
        size: pageSize.value
      })
      snapshot.value = data.snapshot
      tableData.value = data.list || []
      total.value = data.total || 0
      recordRecentFilter()
      if (data.snapshot?.statDate) {
        if (!maxAvailableStatDate.value || dayjs(data.snapshot.statDate).isAfter(maxAvailableStatDate.value)) {
          maxAvailableStatDate.value = data.snapshot.statDate
        }
        // 若“最新可用日期”早于今天，则默认展示“最新可用日期”（但仍不启用过滤）
        if (!dateTouched.value && selectedDate.value) {
          const cur = dayjs(selectedDate.value)
          if (cur.isAfter(dayjs(data.snapshot.statDate), 'day')) {
            selectedDate.value = dayjs(data.snapshot.statDate).toDate()
          }
        }
      }
    } catch (e) {
      snapshot.value = null
      tableData.value = []
      total.value = 0
      if (Number(e?.code) !== 401 && e?.code !== 'ERR_CANCELED') {
        loadError.value = extractApiErrorMessage(e, '获取榜单失败')
        if (!e?.__handled) showApiError(e, '获取榜单失败')
      }
    } finally {
      loading.value = false
    }
    return
  }

  if (!selectedSourceId.value) return
  loading.value = true
  try {
    const { data } = await getNovelRankLatestApi({
      sourceId: selectedSourceId.value,
      statDate: statDate.value,
      compareDate: compareDate.value,
      keyword: searchApplied.value || undefined,
      page: currentPage.value,
      size: pageSize.value
    })
    snapshot.value = data.snapshot
    tableData.value = data.list || []
    total.value = data.total || 0
    recordRecentFilter()
    if (data.snapshot?.statDate) {
      if (!maxAvailableStatDate.value || dayjs(data.snapshot.statDate).isAfter(maxAvailableStatDate.value)) {
        maxAvailableStatDate.value = data.snapshot.statDate
      }
      if (!dateTouched.value && selectedDate.value) {
        const cur = dayjs(selectedDate.value)
        if (cur.isAfter(dayjs(data.snapshot.statDate), 'day')) {
          selectedDate.value = dayjs(data.snapshot.statDate).toDate()
        }
      }
    }
  } catch (e) {
    snapshot.value = null
    tableData.value = []
    total.value = 0
    if (Number(e?.code) !== 401 && e?.code !== 'ERR_CANCELED') {
      loadError.value = extractApiErrorMessage(e, '获取榜单失败')
      if (!e?.__handled) showApiError(e, '获取榜单失败')
    }
  } finally {
    loading.value = false
  }
}

const selectCategoryTag = async (code: string) => {
  if (!useDerivedCategories.value) {
    const id = Number(code)
    selectedSourceId.value = Number.isFinite(id) ? id : 0
    return
  }
  currentPage.value = 1
  selectedSourceId.value = 0
  selectedCategoryCode.value = String(code || '').trim()
  await loadLatest()
}

const applySearch = async () => {
  searchApplied.value = String(searchKeyword.value || '').trim().slice(0, 50)
  currentPage.value = 1
  await loadLatest()
}

const clearSearch = async () => {
  searchKeyword.value = ''
  if (searchApplied.value) {
    searchApplied.value = ''
    currentPage.value = 1
    await loadLatest()
  }
}

const goToFeedback = () => {
  router.push({
    path: '/feedback',
    query: feedbackQuery.value
  })
}

const normalizeAnalysisError = (e: { code?: unknown } | null, fallback: string) => {
  if (Number(e?.code) === 401) return '数据源已下线'
  return extractApiErrorMessage(e, fallback)
}

const syncAnalysisNotice = () => {
  const failedBlocks = [
    categoryError.value ? '分类占比' : '',
    tagError.value ? '标签风向' : '',
    rankChangeError.value ? '榜单变化' : '',
    compareError.value ? '竞品对比' : '',
    authorError.value ? '作者趋势' : ''
  ].filter(Boolean)
  analysisNotice.value = failedBlocks.length ? `部分分析模块加载失败：${failedBlocks.join('、')}，可单独重试。` : ''
}

const openBook = (row: NovelRankItem) => {
  if (row?.bookUrl) void openLink(row.bookUrl, { title: row.bookTitle || '查看书籍' })
}

const exportXlsx = async () => {
  if (exporting.value) return
  exporting.value = true
  try {
    const payload: Parameters<typeof exportLocalRankCsv>[0] = {
      statDate: statDate.value,
      compareDate: compareDate.value,
      keyword: searchApplied.value || undefined
    }
    if (selectedSourceId.value && selectedSourceId.value !== 0) {
      payload.sourceId = selectedSourceId.value
    } else {
      const nativeAllSourceId =
        selectedPlatform.value !== 'fanqie' ? (currentAllSource.value?.id ? Number(currentAllSource.value.id) : null) : null
      if (nativeAllSourceId) {
        payload.sourceId = nativeAllSourceId
        if (useDerivedCategories.value && selectedCategoryCode.value) {
          payload.categoryCode = selectedCategoryCode.value
        }
      } else {
        payload.siteCode = siteCode.value
        payload.rankType = rankType.value
        payload.gender = gender.value
      }
    }

    const blob = await exportLocalRankCsv(payload)
    const date = snapshot.value?.statDate || dayjs().format('YYYY-MM-DD')
    const platformName = platforms.value.find(p => p.code === selectedPlatform.value)?.name || selectedPlatform.value
    const rankTypeLabel = rankTypeOptions.value.find(t => t.value === rankType.value)?.label || rankType.value
    const genderLabel = gender.value === 'female' ? '女频' : '男频'
    const scopeName = selectedSourceId.value === 0
      ? (selectedPlatform.value === 'fanqie' ? '全部分类' : (selectedDerivedCategoryName.value || '全部'))
      : (selectedCategoryName.value || '分类')
    const metricName = showMetric.value ? metricLabel.value : ''
    const safeName = `${platformName}${rankTypeLabel}${genderLabel}${metricName}排行榜_${scopeName}_${date}.csv`
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
    const saved = await saveBlobFile(blob, safeName)
    if (saved) ElMessage.success('导出成功')
  } catch (e) {
    if (Number(e?.code) !== 401 && !e?.__handled) showApiError(e, '导出失败')
  } finally {
    exporting.value = false
  }
}

const getCssVar = (name: string, fallback: string) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}


const buildCategoryOption = () => {
  const list = (analysisCategory.value?.list || []).slice(0, 10).reverse()
  const names = list.map(item => item.categoryName)
  const values = list.map(item => item.count)
  const main = getCssVar('--ink-main', '#241F1B')
  const sec = getCssVar('--ink-sec', '#78716c')
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 12, right: 12, top: 10, bottom: 10, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: { color: sec, fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(28, 25, 23, 0.1)', type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLabel: { color: main, fontSize: 11 }
    },
    series: [
      {
        type: 'bar',
        data: values,
        barWidth: 12,
        itemStyle: {
          borderRadius: 6,
          color: new echarts.graphic.LinearGradient(1, 0, 0, 0, [
            { offset: 0, color: 'rgba(146, 64, 14, 0.85)' },
            { offset: 1, color: 'rgba(146, 64, 14, 0.18)' }
          ])
        }
      }
    ],
    animationDuration: 450,
    animationEasing: 'cubicOut'
  } as EChartsOption
}

const buildTagOption = () => {
  const list = (analysisTagTrends.value?.list || []).slice(0, analysisTagTopN)
  const dates = list[0]?.series?.map(item => item.date.slice(5)) || []
  const colors = ['#7A3028', '#241F1B', '#655E56', '#9A6B2F', '#4C6A52', '#5F6260']
  const sec = getCssVar('--ink-sec', '#78716c')
  return {
    tooltip: { trigger: 'axis' },
    legend: {
      data: list.map(item => item.tag),
      textStyle: { color: sec, fontSize: 10 }
    },
    grid: { left: 12, right: 12, top: 40, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: { color: sec, fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(28, 25, 23, 0.12)' } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: sec, fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(28, 25, 23, 0.1)', type: 'dashed' } }
    },
    series: list.map((item, idx) => ({
      name: item.tag,
      type: 'line',
      data: item.series.map(s => s.count),
      smooth: true,
      symbolSize: 4,
      lineStyle: { width: 2, color: colors[idx % colors.length] },
      itemStyle: { color: colors[idx % colors.length] }
    })),
    animationDuration: 450,
    animationEasing: 'cubicOut'
  } as EChartsOption
}

const buildCompetitorOption = () => {
  const list = analysisCompetitor.value?.list || []
  const dates = list[0]?.series?.map(item => item.date.slice(5)) || []
  const colors = ['#241F1B', '#7A3028', '#9A6B2F', '#4C6A52', '#5F6260']
  const sec = getCssVar('--ink-sec', '#78716c')
  return {
    tooltip: { trigger: 'axis' },
    legend: {
      data: list.map(item => item.bookTitle),
      textStyle: { color: sec, fontSize: 10 }
    },
    grid: { left: 12, right: 12, top: 40, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: { color: sec, fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(28, 25, 23, 0.12)' } }
    },
    yAxis: {
      type: 'value',
      inverse: true,
      minInterval: 1,
      axisLabel: { color: sec, fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(28, 25, 23, 0.1)', type: 'dashed' } }
    },
    series: list.map((item, idx) => ({
      name: item.bookTitle,
      type: 'line',
      data: item.series.map(s => s.rankNo),
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: colors[idx % colors.length] }
    })),
    animationDuration: 450,
    animationEasing: 'cubicOut'
  } as EChartsOption
}

const buildAuthorOption = () => {
  const list = analysisAuthorTrend.value?.list || []
  const x = list.map(item => item.date.slice(5))
  const metric = list.map(item => item.metricSum || 0)
  const sec = getCssVar('--ink-sec', '#78716c')
  const accent = getCssVar('--ink-accent', '#92400e')
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 12, right: 12, top: 12, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: x,
      axisLabel: { color: sec, fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(28, 25, 23, 0.12)' } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: sec, fontSize: 10 },
      splitLine: { lineStyle: { color: 'rgba(28, 25, 23, 0.1)', type: 'dashed' } }
    },
    series: [
      {
        name: metricLabel.value || '指标',
        type: 'line',
        data: metric,
        smooth: true,
        symbolSize: 5,
        lineStyle: { color: accent, width: 2 },
        itemStyle: { color: accent }
      }
    ],
    animationDuration: 450,
    animationEasing: 'cubicOut'
  } as EChartsOption
}

const initAnalysisCharts = async () => {
  await nextTick()
  if (categoryChartRef.value && !categoryChart) {
    categoryChart = echarts.init(categoryChartRef.value, undefined, { renderer: 'canvas' })
  }
  if (tagChartRef.value && !tagChart) {
    tagChart = echarts.init(tagChartRef.value, undefined, { renderer: 'canvas' })
  }
  if (competitorChartRef.value && !competitorChart) {
    competitorChart = echarts.init(competitorChartRef.value, undefined, { renderer: 'canvas' })
  }
  if (authorChartRef.value && !authorChart) {
    authorChart = echarts.init(authorChartRef.value, undefined, { renderer: 'canvas' })
  }

  if (!analysisResizeObserver) {
    analysisResizeObserver = new ResizeObserver(() => {
      categoryChart?.resize()
      tagChart?.resize()
      competitorChart?.resize()
      authorChart?.resize()
    })
    if (categoryChartRef.value) analysisResizeObserver.observe(categoryChartRef.value)
    if (tagChartRef.value) analysisResizeObserver.observe(tagChartRef.value)
    if (competitorChartRef.value) analysisResizeObserver.observe(competitorChartRef.value)
    if (authorChartRef.value) analysisResizeObserver.observe(authorChartRef.value)
  }

  if (!analysisThemeObserver) {
    analysisThemeObserver = new MutationObserver(() => renderAnalysisCharts())
    analysisThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  }
}

const renderAnalysisCharts = async () => {
  if (!analysisVisible.value) return
  await initAnalysisCharts()
  categoryChart?.setOption(buildCategoryOption(), true)
  tagChart?.setOption(buildTagOption(), true)
  competitorChart?.setOption(buildCompetitorOption(), true)
  authorChart?.setOption(buildAuthorOption(), true)
}

const loadCategoryAnalysis = async () => {
  categoryLoading.value = true
  categoryError.value = ''
  try {
    const { data } = await getNovelRankAnalysisCategoryDistributionApi({
      siteCode: siteCode.value,
      rankType: rankType.value,
      gender: gender.value,
      statDate: analysisStatDate.value
    })
    analysisCategory.value = data
  } catch (e) {
    analysisCategory.value = null
    categoryError.value = normalizeAnalysisError(e, '分类占比加载失败')
  } finally {
    categoryLoading.value = false
    syncAnalysisNotice()
    await renderAnalysisCharts()
  }
}

const loadTagAnalysis = async () => {
  tagLoading.value = true
  tagError.value = ''
  try {
    const { data } = await getNovelRankAnalysisTagTrendsApi({
      siteCode: siteCode.value,
      rankType: rankType.value,
      gender: gender.value,
      days: analysisDays.value,
      topN: analysisTagTopN
    })
    analysisTagTrends.value = data
  } catch (e) {
    analysisTagTrends.value = null
    tagError.value = normalizeAnalysisError(e, '标签风向加载失败')
  } finally {
    tagLoading.value = false
    syncAnalysisNotice()
    await renderAnalysisCharts()
  }
}

const loadRankChangeAnalysis = async () => {
  if (!rankChangeSourceId.value) {
    analysisRankChange.value = null
    rankChangeError.value = ''
    rankChangeLoading.value = false
    syncAnalysisNotice()
    return
  }
  rankChangeLoading.value = true
  rankChangeError.value = ''
  try {
    const { data } = await getNovelRankAnalysisRankChangeApi({
      sourceId: rankChangeSourceId.value,
      statDate: analysisStatDate.value
    })
    analysisRankChange.value = data
  } catch (e) {
    analysisRankChange.value = null
    rankChangeError.value = normalizeAnalysisError(e, '榜单变化加载失败')
  } finally {
    rankChangeLoading.value = false
    syncAnalysisNotice()
  }
}

const refreshAnalysis = async () => {
  if (analysisLoading.value || !analysisVisible.value) return
  analysisLoading.value = true
  analysisNotice.value = ''
  try {
    await Promise.all([
      loadCategoryAnalysis(),
      loadTagAnalysis(),
      loadRankChangeAnalysis()
    ])
  } finally {
    analysisLoading.value = false
    syncAnalysisNotice()
  }
}

const toggleAnalysis = async () => {
  analysisVisible.value = !analysisVisible.value
  if (analysisVisible.value) {
    await refreshAnalysis()
    await nextTick()
    analysisSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } else {
    await nextTick()
    rankDetailRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

const getScrollContainer = () => {
  return scrollContainerRef.value || (document.querySelector('.content-wrapper') as HTMLElement | null)
}

const updateBackTopVisible = () => {
  const container = getScrollContainer()
  if (!container) return
  const scrollTop = container.scrollTop
  showBackTop.value = scrollTop >= 260
}

const scrollToTop = () => {
  const container = getScrollContainer()
  if (container) {
    container.scrollTo({ top: 0, behavior: 'smooth' })
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

const toggleCompare = (row: NovelRankItem) => {
  const bookId = getBookIdFromItem(row)
  if (!bookId) {
    ElMessage.warning('该作品缺少ID，无法加入对比')
    return
  }
  if (compareList.value.some(item => item.bookId === bookId)) {
    ElMessage.info('已在对比列表')
    return
  }
  if (compareList.value.length >= 5) {
    ElMessage.warning('最多选择5本作品')
    return
  }
  compareList.value.push({ bookId, bookTitle: row.bookTitle })
  analysisCompetitor.value = null
  compareError.value = ''
  void renderAnalysisCharts()
}

const removeCompare = (bookId: string) => {
  compareList.value = compareList.value.filter(item => item.bookId !== bookId)
  analysisCompetitor.value = null
  compareError.value = ''
  syncAnalysisNotice()
  void renderAnalysisCharts()
}

const clearCompare = () => {
  compareList.value = []
  analysisCompetitor.value = null
  compareError.value = ''
  syncAnalysisNotice()
  renderAnalysisCharts()
}

const loadCompetitorCompare = async () => {
  if (compareLoading.value || !compareList.value.length) return
  compareLoading.value = true
  compareError.value = ''
  try {
    const bookIds = compareList.value.map(item => item.bookId).join(',')
    const { data } = await getNovelRankAnalysisCompetitorApi({
      siteCode: siteCode.value,
      rankType: rankType.value,
      gender: gender.value,
      categoryCode: analysisScopedCategoryCode.value,
      endDate: analysisStatDate.value,
      bookIds,
      days: analysisDays.value
    })
    analysisCompetitor.value = data
    await renderAnalysisCharts()
  } catch (e) {
    analysisCompetitor.value = null
    compareError.value = normalizeAnalysisError(e, '竞品对比加载失败')
  } finally {
    compareLoading.value = false
    syncAnalysisNotice()
  }
}

const loadAuthorTrend = async () => {
  const authorName = String(authorNameInput.value || '').trim()
  if (!authorName) {
    ElMessage.warning('请输入作者名')
    return
  }
  if (authorLoading.value) return
  authorLoading.value = true
  authorError.value = ''
  try {
    const { data } = await getNovelRankAnalysisAuthorTrendApi({
      siteCode: siteCode.value,
      rankType: rankType.value,
      gender: gender.value,
      categoryCode: analysisScopedCategoryCode.value,
      endDate: analysisStatDate.value,
      authorName,
      days: analysisDays.value
    })
    analysisAuthorTrend.value = data
    await renderAnalysisCharts()
  } catch (e) {
    analysisAuthorTrend.value = null
    authorError.value = normalizeAnalysisError(e, '作者趋势加载失败')
  } finally {
    authorLoading.value = false
    syncAnalysisNotice()
  }
}

// 作者趋势面板暂整块注释（老客户端遗留状态，本地算路已通待放开），函数保留
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const useTopAuthor = async () => {
  const name = String(tableData.value[0]?.authorName || '').trim()
  if (!name) {
    ElMessage.warning('榜单暂无作者信息')
    return
  }
  authorNameInput.value = name
  await loadAuthorTrend()
}

const handleRankTypeChange = async () => {
  currentPage.value = 1
  // 来源未变化时不会触发来源 watcher，需要在标签事件里直接刷新。
  const shouldLoadDirectly = selectedSourceId.value === 0
  selectedSourceId.value = 0
  selectedCategoryCode.value = ''
  analysisCompetitor.value = null
  analysisAuthorTrend.value = null
  compareError.value = ''
  authorError.value = ''
  analysisNotice.value = ''
  if (!shouldLoadDirectly) return
  await loadLatest()
  if (analysisVisible.value) await refreshAnalysis()
}

const refreshSourceScope = async () => {
  sourceScopeRefreshing = true
  try {
    currentPage.value = 1
    searchKeyword.value = ''
    searchApplied.value = ''
    dateTouched.value = false
    selectedDate.value = new Date()
    selectedCompareDate.value = null
    maxAvailableStatDate.value = null
    compareList.value = []
    analysisCompetitor.value = null
    analysisAuthorTrend.value = null
    categoryError.value = ''
    tagError.value = ''
    rankChangeError.value = ''
    compareError.value = ''
    authorError.value = ''
    analysisNotice.value = ''
    authorNameInput.value = ''
    await loadSources()
    await loadLatest()
    if (analysisVisible.value) await refreshAnalysis()
    await nextTick()
  } finally {
    sourceScopeRefreshing = false
  }
}

// 平台请求失败后的手动重试：平台恢复后按需补拉来源与榜单
const retryPlatforms = async () => {
  const prevSite = selectedPlatform.value
  await loadPlatforms()
  if (platformsError.value || !platforms.value.length) return
  if (sourcesError.value || !sourcesAll.value.length || prevSite !== selectedPlatform.value) {
    await refreshSourceScope()
  }
}

// 来源请求失败后的手动重试：复用平台/频段切换的统一刷新入口（来源+榜单一起拉）
const retrySources = async () => {
  await refreshSourceScope()
}

const handlePlatformChange = async (code: string) => {
  if (selectedPlatform.value === code) return
  selectedPlatform.value = code
  await refreshSourceScope()
}

const handleGenderChange = async (value: 'male' | 'female') => {
  if (gender.value === value) return
  gender.value = value
  await refreshSourceScope()
}

watch([selectedSourceId, selectedDate, selectedCompareDate], async () => {
  if (sourceScopeRefreshing) return
  currentPage.value = 1
  analysisCompetitor.value = null
  analysisAuthorTrend.value = null
  compareError.value = ''
  authorError.value = ''
  analysisNotice.value = ''
  await loadLatest()
  if (analysisVisible.value) await refreshAnalysis()
})

watch([currentPage, pageSize], async () => {
  await loadLatest()
})

watch(analysisDays, async () => {
  if (analysisVisible.value) {
    await refreshAnalysis()
    if (compareList.value.length) await loadCompetitorCompare()
    if (authorNameInput.value.trim()) await loadAuthorTrend()
  }
})

onMounted(async () => {
  applyRouteFilter()
  void loadCrawlSettings()
  // 自动模式：每天补抓一次最近看过的榜单（静默容错，不阻塞页面）
  void maybeAutoCrawlLocalRank()
  // 平台列表与首页风向互不依赖，并行请求以减少高延迟链路上的串行往返；
  // 来源依赖平台兜底结果（selectedPlatform），榜单又依赖来源，仍保持顺序
  await Promise.all([loadPlatforms(), loadHomePreference()])
  await refreshSourceScope()
  scrollContainerRef.value = getScrollContainer()
  updateBackTopVisible()
  if (scrollContainerRef.value) {
    scrollContainerRef.value.addEventListener('scroll', updateBackTopVisible, { passive: true })
  } else {
    window.addEventListener('scroll', updateBackTopVisible, { passive: true })
  }
})

onBeforeUnmount(() => {
  rankPageActive = false
  crawlStopRequested = true
  analysisResizeObserver?.disconnect()
  analysisThemeObserver?.disconnect()
  categoryChart?.dispose()
  tagChart?.dispose()
  competitorChart?.dispose()
  authorChart?.dispose()
  if (scrollContainerRef.value) {
    scrollContainerRef.value.removeEventListener('scroll', updateBackTopVisible)
  } else {
    window.removeEventListener('scroll', updateBackTopVisible)
  }
})
</script>

<style scoped lang="scss">
.rank-page {
  padding-bottom: 40px;
}

// 本机抓取控制条
.crawl-control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1 1 360px;
  min-width: 0;
}

.crawl-mode-group {
  display: inline-flex;
  flex-shrink: 0;
  padding: 3px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink-main) 6%, transparent);
}

.crawl-mode-btn {
  min-height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  color: var(--ink-sec);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;

  &.active {
    color: var(--ink-main);
    background: var(--surface-0, rgb(255 255 255 / 60%));
    box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
    font-weight: 600;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.crawl-now-btn {
  min-height: 30px;
}

.crawl-status {
  color: var(--ink-sec);
  font-size: 12px;
}

// 骨架占位的呼吸动画（平台/榜单来源加载中）
@keyframes rank-skeleton-pulse {
  0%,
  100% {
    opacity: 0.45;
  }

  50% {
    opacity: 1;
  }
}

.page-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  // justify-content: flex-end;
  margin-bottom: 24px;

  .page-title {
    font-size: 24px;
    font-weight: bold;
    color: var(--ink-main);
    letter-spacing: 1px;
  }
}

.platform-selector {
  display: flex;
  flex-shrink: 0;
  max-width: 100%;
  overflow-x: auto;
  background: var(--toggle-btn-bg);
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--toggle-btn-border);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);

  .platform-tab {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 14px;
    transition: all 0.3s;
    cursor: pointer;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    user-select: none;

    .platform-icon {
      font-size: 14px;
      line-height: 1;
      display: flex;
      align-items: center;
    }
  }

  .platform-tab-active {
    background-color: var(--btn-primary-bg);
    color: var(--btn-primary-color);
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);

    .platform-icon {
      opacity: 1;
      filter: none;

      &.fa-fire {
        color: var(--state-danger);
      }

      &.fa-leaf {
        color: #059669;
      }
    }
  }

  .platform-tab-inactive {
    color: var(--ink-main);

    .platform-icon {
      opacity: 0.7;
      filter: grayscale(100%);
    }

    &:hover {
      background-color: var(--toggle-btn-hover-bg);
      color: var(--ink-accent);
    }
  }

  // 平台加载中的骨架占位
  .platform-tab-skeleton {
    width: 84px;
    height: 28px;
    padding: 0;
    background: var(--overlay-hover);
    cursor: default;
    animation: rank-skeleton-pulse 1.2s ease-in-out infinite;
  }

  // 平台加载失败的重试入口
  .platform-tab-retry {
    color: var(--ink-sec);
    font-size: 13px;
  }
}

.filter-panel {
  padding: 24px;
  margin-bottom: 24px;

  .rank-cutoff {
    font-size: 12px;
    color: var(--ink-sec);
    margin-top: -8px;
    margin-bottom: 12px;
  }

  .rank-tabs {
    :deep(.el-tabs__header) {
      border-bottom: 1px solid var(--divider);
      margin-bottom: 16px;
    }

    :deep(.el-tabs__nav-wrap::after) {
      display: none;
    }

    :deep(.el-tabs__item) {
      font-size: 14px;
      font-weight: bold;
      color: var(--ink-sec);
      padding: 0 0 16px 0;
      margin-right: 32px;
      transition: color 0.3s;

      &:hover {
        color: var(--ink-accent);
      }

      &.is-active {
        color: var(--ink-main);
      }
    }

    :deep(.el-tabs__active-bar) {
      background-color: var(--ink-main);
      height: 2px;
    }
  }

  .filter-rows {
    display: flex;
    flex-direction: column;
    gap: 16px;

    .filter-row {
      display: flex;
      align-items: center;
      font-size: 14px;
      position: relative;

      .filter-label {
        width: 80px;
        color: var(--ink-sec);
        flex-shrink: 0;
        font-size: 14px;
      }

      .filter-content {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 12px;

        &.tags-content {
          flex-wrap: wrap;

          .expand-link {
            font-size: 12px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            color: var(--ink-accent);
            margin-left: 8px;
            cursor: pointer;

            &:hover {
              text-decoration: underline;
            }

            i {
              font-size: 10px;
            }
          }
        }

        .range-buttons {
          display: flex;
          gap: 8px;

          .range-btn {
            font-size: 12px;
            padding: 4px 12px;
            border-radius: 4px;
            border: 1px solid transparent;
            cursor: pointer;
            transition: all 0.3s;
            user-select: none;
          }

          .range-btn-active {
            background: var(--btn-primary-bg);
            color: var(--btn-primary-color);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
          }

          .range-btn-inactive {
            background: var(--btn-ghost-bg);
            color: var(--ink-sec);
            border: 1px solid var(--btn-ghost-border);

            &:hover {
              background: var(--btn-ghost-hover-bg);
              color: var(--ink-main);
              border-color: var(--btn-ghost-hover-border);
            }
          }
        }

        .filter-tag {
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s;
          border: 1px solid transparent;
          user-select: none;

          .tag-count {
            opacity: 0.5;
            font-size: 10px;
            margin-left: 4px;
            transform: scale(0.75);
            display: inline-block;
          }

          &:hover:not(.filter-tag-active) {
            background: var(--btn-ghost-hover-bg);
            color: var(--ink-main);
          }
        }

        .filter-tag-active {
          background: var(--selection-bg-color);
          color: var(--ink-accent);
          border-color: var(--selection-bg-color);
          font-weight: bold;
        }

        // 榜单来源加载中的骨架占位
        .filter-tag-skeleton {
          width: 56px;
          height: 24px;
          border-radius: 4px;
          background: var(--overlay-hover);
          animation: rank-skeleton-pulse 1.2s ease-in-out infinite;
        }


      }

      .action-btn {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;

        :deep(.el-button) {
          background: var(--btn-primary-bg);
          border: none;
          color: var(--btn-primary-color);
          box-shadow: var(--ui-shadow);

          &:hover {
            background: var(--btn-primary-hover-bg);
            color: var(--btn-primary-hover-color);
          }

          i {
            margin-right: 4px;
          }
        }

        :deep(.home-set-button-active) {
          background: var(--state-success-surface);
          color: var(--state-success-on);
          border: 1px solid var(--state-success-border);
          box-shadow: none;

          &:hover {
            background: var(--state-success-surface);
            color: var(--state-success-on);
          }
        }
      }
    }

  }
}

.no-wrap {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.book-cell {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.book-cover {
  width: 54px;
  height: 72px;
  border-radius: 6px;
  flex: 0 0 auto;
  border: 1px solid var(--divider);
  background: var(--overlay-hover);
}

// 封面加载失败：显示书名首字的占位块，替代 el-image 默认的“加载失败”文案
.book-cover-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--overlay-hover);
  color: var(--ink-sec);
  font-size: 20px;
  font-weight: 600;
  user-select: none;
}

.book-meta {
  min-width: 0;
  flex: 1;
}

.book-title {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.2;
  margin-bottom: 6px;
}

.book-title-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.book-title-button:hover {
  color: var(--ink-primary, #a44b0a);
}

.rank-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.rank-delta-inline {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-sec);

  &.new {
    color: var(--ink-accent);
  }

  &.up {
    color: var(--el-color-danger);
  }

  &.down {
    color: var(--ink-positive);
  }
}

.rank-delta,
.metric-delta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  font-weight: 600;
  color: var(--ink-sec);

  &.up {
    color: var(--el-color-danger);
  }

  &.down {
    color: var(--ink-positive);
  }
}

.book-intro {
  font-size: 12px;
  color: var(--ink-sec);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

:global(.ink-tooltip) {
  max-width: 420px;
}

:global(.ink-tooltip .intro-tooltip) {
  white-space: pre-line;
  word-break: break-word;
  line-height: 1.5;
}

.category-tag {
  display: inline-block;
  max-width: 110px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  color: var(--ink-sec);
  background: var(--overlay-hover);
  border: 1px solid var(--divider);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;

  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    max-width: 420px;

    .search-label {
      font-size: 14px;
      font-weight: bold;
      color: var(--ink-main);
      white-space: nowrap;
    }

    .search-input {
      flex: 1;

      :deep(.el-input__wrapper) {
        background: var(--surface-1);
        border: 1px solid var(--divider);
        border-radius: 8px 0 0 8px;
        min-height: 32px;
        padding: 0 10px;
      }

      :deep(.el-input__inner) {
        height: 32px;
        line-height: 32px;
        font-size: 13px;
      }

      :deep(.el-input-group__append) {
        background: rgba(30, 58, 138, 0.9);
        border: none;
        border-radius: 0 8px 8px 0;
        padding: 0;
        box-shadow: 0 2px 4px rgba(30, 58, 138, 0.2);

        .el-button {
          background: transparent;
          border: none;
          color: var(--on-inverse);
          margin: 0;
          padding: 0 14px;
          height: 32px;

          &:hover {
            background: rgba(30, 58, 138, 1);
          }
        }
      }
    }
  }

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;

    .feedback-link {
      color: var(--ink-accent);
      font-size: 12px;
      white-space: nowrap;

      &:hover {
        text-decoration: underline;
      }
    }

    .total-count {
      color: var(--ink-sec);
      white-space: nowrap;
    }
  }
}

.data-table-container {
  overflow: hidden;
}

.rank-card-list {
  display: none;
}

.rank-mobile-card {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-main) 86%, transparent);
}

.rank-mobile-head,
.rank-mobile-main,
.rank-mobile-actions {
  display: flex;
  align-items: center;
}

.rank-mobile-head {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.rank-mobile-main {
  align-items: flex-start;
  gap: 12px;
}

.rank-mobile-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--ink-sec);

  span {
    min-width: 0;
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }

  b {
    color: var(--ink-main);
    font-weight: 700;
    white-space: nowrap;
  }

  em {
    font-style: normal;
  }
}

.rank-mobile-actions {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.rank-card-empty {
  padding: 28px 12px;
  text-align: center;
  color: var(--ink-sec);
}

.rank-card-empty--error,
.rank-table-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 20px 12px;
  color: var(--ink-sec);
  text-align: center;
}

.row-actions {
  display: flex;
  justify-content: center;
  gap: 6px;
}

.track-button,
.compare-button {
  border-radius: 6px;
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid transparent;
}

.compare-button {
  background: var(--btn-ghost-bg);
  border-color: var(--btn-ghost-border);
  color: var(--ink-main);

  &:hover {
    background: var(--btn-ghost-hover-bg);
    border-color: var(--btn-ghost-hover-border);
  }
}

.analysis-panel {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.analysis-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.analysis-title-main {
  font-size: 20px;
  font-weight: 700;
  color: var(--ink-main);
}

.ai-report {
  margin-top: 12px;
  padding: 14px 16px;

  .ai-report-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
    color: var(--ink-main);
    margin-bottom: 8px;
  }

  .ai-report-body {
    white-space: pre-wrap;
    line-height: 1.7;
    color: var(--ink-sec);
    font-size: 14px;
  }
}

.analysis-title-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-sec);
}

.analysis-status-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-accent);
}

.analysis-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}






.analysis-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.analysis-grid-wide {
  grid-template-columns: 1fr 1.4fr;
}

.analysis-block {
  padding: 16px;
  min-height: 320px;
  display: flex;
  flex-direction: column;
}

.analysis-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-main);
  margin-bottom: 12px;
}

.analysis-hint {
  font-size: 12px;
  color: var(--ink-sec);
  font-weight: 400;
}

.analysis-hint-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 12px;
  color: var(--ink-sec);
  font-weight: 400;
}

.analysis-chart-wrap {
  position: relative;
  flex: 1;
  min-height: 220px;
}

.analysis-chart {
  width: 100%;
  height: 240px;
}

.analysis-overlay,
.analysis-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--ink-sec);
  background: var(--surface-1);
  border-radius: 12px;
}

.analysis-state-card,
.analysis-empty-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.analysis-empty-inline {
  font-size: 12px;
  color: var(--ink-sec);
}

.analysis-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.analysis-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--ink-sec);
  background: var(--tag-bg);
  border: 1px solid var(--tag-border);

  em {
    font-style: normal;
    font-weight: 600;
    color: var(--ink-main);
  }
}

.analysis-change-list {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.change-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--divider);
}

.change-rank {
  width: 28px;
  text-align: center;
  font-weight: 700;
  color: var(--ink-main);
}

.change-title {
  flex: 1;
  color: var(--ink-main);
}

.change-delta {
  width: 48px;
  text-align: right;
  font-weight: 600;
  color: var(--ink-sec);

  &.up {
    color: var(--ink-positive);
  }

  &.down {
    color: var(--ink-warning);
  }
}

.analysis-compare-controls {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.analysis-compare-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
}

.compare-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--ink-main);
  background: var(--tag-bg);
  border: 1px solid var(--tag-border);

  i {
    font-size: 10px;
    cursor: pointer;
    color: var(--ink-sec);
  }
}

.analysis-compare-actions {
  display: flex;
  gap: 8px;
}

.analysis-author-form {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;

  .ink-search-input {
    flex: 1;
    min-width: 200px;
  }
}

.back-top-btn {
  position: fixed;
  right: 24px;
  bottom: 32px;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  border: 1px solid var(--btn-ghost-border);
  background: var(--btn-ghost-bg);
  color: var(--ink-main);
  box-shadow: var(--ui-shadow);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  z-index: 30;

  &:hover {
    background: var(--btn-ghost-hover-bg);
    border-color: var(--btn-ghost-hover-border);
    transform: translateY(-2px);
  }
}

@include content-max(920px) {

  .analysis-grid,
  .analysis-grid-wide {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  :global(body.web-runtime .rank-page){
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
  }

  :global(body.web-runtime .page-header){
    margin-bottom: 16px;
  }

  :global(body.web-runtime .platform-selector){
    width: 100%;
    overflow-x: auto;
  }

  :global(body.web-runtime .platform-selector .platform-tab){
    flex: 0 0 auto;
    padding-inline: 14px;
  }

  :global(body.web-runtime .filter-panel){
    padding: 16px;
    margin-bottom: 16px;
  }

  :global(body.web-runtime .filter-panel .filter-rows){
    gap: 12px;
  }

  :global(body.web-runtime .filter-panel .filter-rows .filter-row){
    align-items: stretch;
    flex-direction: column;
    gap: 8px;
  }

  :global(body.web-runtime .filter-panel .filter-rows .filter-row .filter-label){
    width: auto;
  }

  :global(body.web-runtime .filter-panel .filter-rows .filter-row .filter-content){
    width: 100%;
    flex-wrap: wrap;
  }

  :global(body.web-runtime .filter-panel .filter-rows .filter-row .action-btn){
    margin-left: 0;
    flex-wrap: wrap;
  }

  :global(body.web-runtime .search-toolbar){
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
  }

  :global(body.web-runtime .search-toolbar .search-box){
    max-width: none;
    width: 100%;
  }

  :global(body.web-runtime .toolbar-actions){
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px;
  }

  :global(body.web-runtime .rank-table){
    display: none;
  }

  :global(body.web-runtime .rank-card-list){
    display: grid;
    gap: 12px;
  }
}

@media (max-width: 768px) {
}

.rank-offline-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--ink-sec);
  text-align: center;
  padding: 40px 20px;

  i {
    font-size: 40px;
    color: var(--ink-muted, var(--ink-sec));
  }

  h2 {
    margin: 0;
    font-size: 22px;
    color: var(--ink-main);
    font-family: var(--font-serif);
  }

  p {
    margin: 0;
    font-size: 14px;
    line-height: 1.8;
    max-width: 420px;
  }
}
</style>
