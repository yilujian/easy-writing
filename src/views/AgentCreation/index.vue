<template>
  <div
    class="ac-workspace"
    :class="{
      'sidebar-collapsed': !sidebarOpen,
      'mobile-sidebar-open': sidebarOpen,
      'has-document': view === 'chat' && (store.openedArtifact || store.openedBreakdown),
      'document-expanded': documentExpanded
    }"
  >
    <button
      v-if="sidebarOpen"
      class="ac-sidebar-backdrop"
      aria-label="收起导航"
      @click="sidebarOpen = false"
    ></button>
    <aside
      class="ac-sidebar"
      aria-label="Agent 创作导航"
      :inert="!sidebarOpen ? true : undefined"
      :aria-hidden="!sidebarOpen"
    >
      <div class="ac-brand">
        <img src="/logo.png" alt="易创" /><span>易创</span
        ><button class="ac-icon-button" aria-label="收起侧栏" @click="sidebarOpen = false">
          <i class="fa-solid fa-angles-left" aria-hidden="true"></i>
        </button>
      </div>
      <router-link class="ac-back" to="/novel"
        ><i class="fa-solid fa-arrow-left" aria-hidden="true"></i><span>返回工作台</span></router-link
      >
      <button class="ac-new-chat ac-button ink-btn ink-btn-primary" @click="newChat()">
        <i class="fa-solid fa-plus" aria-hidden="true"></i><span>新对话</span>
      </button>
      <nav class="ac-main-navigation">
        <button @click="searchVisible = true">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span>搜索会话</span
          ><kbd>⌘ K</kbd></button
        ><router-link
          to="/agent-creation/memory"
          :class="{ active: view === 'memory' }"
          @click="closeOnNarrow"
          ><i class="fa-regular fa-bookmark" aria-hidden="true"></i><span>记忆</span></router-link
        ><router-link
          to="/agent-creation/skills"
          :class="{ active: view === 'skills' }"
          @click="closeOnNarrow"
          ><i class="fa-solid fa-puzzle-piece" aria-hidden="true"></i><span>Skills</span></router-link
        ><router-link
          to="/agent-creation/automation"
          :class="{ active: view === 'automation' }"
          @click="closeOnNarrow"
          ><i class="fa-regular fa-clock" aria-hidden="true"></i><span>自动任务</span></router-link
        >
      </nav>
      <section
        v-if="independentConversations.length"
        class="ac-independent-conversations"
        aria-label="独立会话"
      >
        <div class="ac-projects-heading"><span>对话</span></div>
        <div class="ac-project-conversations">
          <button
            v-for="conversation in independentConversations"
            :key="conversation.id"
            :class="{ active: view === 'chat' && store.activeId === conversation.id }"
            :title="conversation.title"
            aria-haspopup="menu"
            aria-keyshortcuts="Shift+F10"
            @click="selectConversation(conversation.id)"
            @mousedown.right.prevent
            @contextmenu.prevent.stop="openConversationMenu($event, conversation.id)"
            @keydown="onConversationKeydown($event, conversation.id)"
          >
            <i
              :class="
                conversation.status === 'running'
                  ? 'fa-solid fa-circle-notch fa-spin'
                  : 'fa-regular fa-message'
              "
              aria-hidden="true"
            ></i>
            <span>{{ conversation.title }}</span>
            <small v-if="conversation.legacy" class="ac-legacy-tag">旧版妙笔</small>
            <small v-else-if="conversation.bookDeleted" class="ac-legacy-tag">作品已删除</small>
            <small v-else-if="conversation.channel?.kind === 'weixin'" class="ac-legacy-tag">微信</small>
            <i
              v-if="conversation.pinnedAt"
              class="fa-solid fa-thumbtack ac-pinned-indicator"
              aria-label="已置顶"
            ></i>
          </button>
        </div>
      </section>
      <div class="ac-projects-heading">
        <span>项目</span
        ><button class="ac-icon-button" title="新建项目" aria-label="新建项目" @click="projectVisible = true">
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
        </button>
      </div>
      <div class="ac-projects-scroll">
        <div v-for="project in store.projects" :key="project.id" class="ac-project">
          <div class="ac-project-heading-row" :class="{ 'is-menu-open': projectMenuId === project.id }">
            <button
              class="ac-project-toggle"
              :aria-expanded="expandedProjects.includes(project.id)"
              @click="toggleProject(project.id)"
            >
              <i
                :class="expandedProjects.includes(project.id) ? 'fa-regular fa-folder-open' : 'fa-regular fa-folder'"
                aria-hidden="true"
              ></i
              ><span>{{ project.title }}</span>
            </button>
            <el-dropdown
              class="ac-project-more"
              trigger="click"
              popper-class="ac-conversation-menu"
              @visible-change="(visible: boolean) => (projectMenuId = visible ? project.id : null)"
              @command="(command: string) => onProjectMore(project.id, command)"
            >
              <button class="ac-icon-button" :aria-label="`管理项目 ${project.title}`">
                <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
              </button>
              <template #dropdown
                ><el-dropdown-menu>
                  <el-dropdown-item command="new">新建对话</el-dropdown-item>
                  <el-dropdown-item command="rename">重命名项目</el-dropdown-item>
                  <el-dropdown-item command="link">关联作品</el-dropdown-item>
                  <el-dropdown-item command="delete" divided class="ac-menu-danger">删除项目</el-dropdown-item>
                </el-dropdown-menu></template
              >
            </el-dropdown>
          </div>
          <div v-if="expandedProjects.includes(project.id)" class="ac-project-conversations">
            <button
              v-for="conversation in conversationsFor(project.id)"
              :key="conversation.id"
              :class="{ active: view === 'chat' && store.activeId === conversation.id }"
              :title="conversation.title"
              aria-haspopup="menu"
              aria-keyshortcuts="Shift+F10"
              @click="selectConversation(conversation.id)"
              @mousedown.right.prevent
              @contextmenu.prevent.stop="openConversationMenu($event, conversation.id)"
              @keydown="onConversationKeydown($event, conversation.id)"
            >
              <i
                :class="
                  conversation.status === 'running'
                    ? 'fa-solid fa-circle-notch fa-spin'
                    : conversation.status === 'paused'
                      ? 'fa-regular fa-circle-pause'
                      : 'fa-regular fa-file-lines'
                "
                aria-hidden="true"
              ></i
              ><span>{{ conversation.title }}</span>
              <small v-if="conversation.legacy" class="ac-legacy-tag">旧版妙笔</small>
              <small v-else-if="conversation.bookDeleted" class="ac-legacy-tag">作品已删除</small>
              <small v-else-if="conversation.channel?.kind === 'weixin'" class="ac-legacy-tag">微信</small>
              <i
                v-if="conversation.pinnedAt"
                class="fa-solid fa-thumbtack ac-pinned-indicator"
                aria-label="已置顶"
              ></i></button
            ><button
              v-if="!conversationsFor(project.id).length"
              class="ac-project-new"
              @click="newChat(project.id)"
            >
              <i class="fa-solid fa-plus" aria-hidden="true"></i><span>新建对话</span>
            </button>
          </div>
        </div>
      </div>
      <div class="ac-sidebar-bottom">
        <button @click="settingsVisible = true">
          <i class="fa-solid fa-gear" aria-hidden="true"></i><span>设置</span>
        </button>
      </div>
    </aside>
    <el-dropdown
      ref="conversationMenu"
      trigger="contextmenu"
      virtual-triggering
      :virtual-ref="conversationMenuAnchor"
      :show-arrow="false"
      :show-timeout="0"
      :hide-timeout="0"
      :persistent="false"
      :popper-options="{ strategy: 'fixed' }"
      placement="bottom-start"
      popper-class="ac-conversation-menu"
      @visible-change="conversationMenuVisible = $event"
      @command="(command: string) => onConversationMore(conversationMenuId, command)"
    >
      <template #dropdown>
        <el-dropdown-menu v-if="contextConversation" @contextmenu.prevent>
          <el-dropdown-item command="pin">{{
            contextConversation.pinnedAt ? '取消置顶' : '置顶对话'
          }}</el-dropdown-item>
          <el-dropdown-item command="rename">重命名对话</el-dropdown-item>
          <el-dropdown-item command="move" :disabled="contextConversation.status !== 'completed'"
            >移动到项目</el-dropdown-item
          >
          <el-dropdown-item
            command="forget"
            divided
            :disabled="contextConversation.status === 'running'"
            :title="contextConversation.status === 'running' ? '请先停止当前任务' : undefined"
            >忘掉这次会话</el-dropdown-item
          >
          <el-dropdown-item
            command="delete"
            class="ac-menu-danger"
            :disabled="contextConversation.status === 'running'"
            :title="contextConversation.status === 'running' ? '请先停止当前任务' : undefined"
            >删除对话</el-dropdown-item
          >
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <div class="ac-main">
      <header class="ac-header">
        <div class="ac-header-title">
          <button
            v-if="!sidebarOpen"
            class="ac-icon-button"
            aria-label="展开侧栏"
            @click="sidebarOpen = true"
          >
            <i class="fa-solid fa-bars" aria-hidden="true"></i>
          </button>
          <h1>{{ pageTitle }}</h1>
        </div>
        <div class="ac-header-actions">
          <button
            v-if="view === 'chat'"
            class="ac-tool-button"
            aria-label="批量写作"
            :disabled="!!store.activeJob"
            :title="store.activeJob ? '本会话已有批量任务' : '连载按章节连续写，短篇按选题逐篇写'"
            @click="openBatch"
          >
            <i class="fa-solid fa-layer-group" aria-hidden="true"></i><span>批量写作</span></button
          ><button class="ac-tool-button" aria-label="作品资料" @click="resourcesVisible = true">
            <i class="fa-regular fa-file-lines" aria-hidden="true"></i><span>作品资料</span></button
          ><el-dropdown trigger="click" popper-class="ac-conversation-menu" @command="onMore"
            ><button class="ac-icon-button" aria-label="更多操作">
              <i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button
            ><template #dropdown
              ><el-dropdown-menu
                ><el-dropdown-item command="pin" :disabled="!store.active">{{
                  store.active?.pinnedAt ? '取消置顶' : '置顶对话'
                }}</el-dropdown-item
                ><el-dropdown-item command="rename" :disabled="!store.active">重命名对话</el-dropdown-item
                ><el-dropdown-item
                  command="forget"
                  :disabled="!store.active || store.active.status === 'running'"
                  >忘掉这次会话</el-dropdown-item
                ><el-dropdown-item
                  command="delete"
                  class="ac-menu-danger"
                  :disabled="!store.active || store.active.status === 'running'"
                  >删除对话</el-dropdown-item
                ><el-dropdown-item
                  command="move"
                  :disabled="!store.active || store.active.status !== 'completed'"
                  >移动到项目</el-dropdown-item
                ><el-dropdown-item command="about" divided>关于 Agent</el-dropdown-item></el-dropdown-menu
              ></template
            ></el-dropdown
          >
        </div>
      </header>
      <div v-if="view === 'chat'" class="ac-chat-workspace">
        <section class="ac-conversation-pane" :class="{ 'is-welcome': !store.active }" aria-label="创作对话">
          <template v-if="!store.active"
            ><div class="ac-welcome-content">
              <div class="ac-welcome-title">
                <h2>今天，想写点什么？</h2>
                <p v-if="store.loading" role="status">正在加载项目与会话…</p>
                <p v-else-if="store.error" role="alert">{{ store.error }}</p>
                <p>从一个想法开始，也可以继续你的作品。</p>
              </div>
              <AgentComposer ref="composer" @sent="onSent" @create-skill="startSkillCreation" />
              <div class="ac-starters">
                <button
                  v-for="item in starters"
                  :key="item.scenario"
                  @click="startFrom(item.scenario, item.prompt)"
                >
                  <i :class="item.icon" aria-hidden="true"></i>{{ item.label }}
                </button>
              </div>
              <button
                v-if="recentConversation"
                class="ac-resume-last"
                @click="selectConversation(recentConversation.id)"
              >
                <i class="fa-regular fa-clock" aria-hidden="true"></i
                ><span>继续上次：{{ recentConversation.title }}</span
                ><i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
              </button></div
          ></template>
          <template v-else
            ><AgentConversation @continue="focusComposer" />
            <AgentBatchPanel v-if="store.activeJob" />
            <div v-if="store.active.legacy" class="ac-composer-dock ac-legacy-dock">
              <span>旧版妙笔的对话记录，只能查看。</span>
              <button type="button" class="ac-legacy-new" @click="store.newConversation(store.active.projectId || undefined)">开新对话</button>
            </div>
            <div v-else class="ac-composer-dock">
              <AgentComposer ref="composer" :compact="!!(store.openedArtifact || store.openedBreakdown)" @sent="onSent" @create-skill="startSkillCreation" /></div
          ></template>
        </section>
        <AgentDocument
          v-if="store.openedArtifact"
          :expanded="documentExpanded"
          @expand="documentExpanded = !documentExpanded"
        />
        <AgentBreakdownDocument v-else-if="store.openedBreakdown" :expanded="documentExpanded" @expand="documentExpanded = !documentExpanded" />
      </div>
      <AgentMemoryView v-else-if="view === 'memory'" />
      <AgentAutomationPanel v-else-if="view === 'automation'" />
      <AgentSkillsView v-else @use="useSelectedSkill" @create="startSkillCreation" />
    </div>

    <EwModal
      v-model:visible="searchVisible"
      title="搜索会话"
      width="560px"
      custom-class="ac-dialog ac-search-dialog"
      @opened="sessionSearch?.focus()"
      manage-focus
      ><label class="ac-search"
        ><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i
        ><input
          ref="sessionSearch"
          v-model="searchQuery"
          placeholder="搜索会话标题或内容"
          aria-label="搜索会话内容"
      /></label>
      <div class="ac-session-results">
        <button
          v-for="conversation in searchResults"
          :key="conversation.id"
          @click="selectSearchResult(conversation.id)"
        >
          <i class="fa-regular fa-message" aria-hidden="true"></i
          ><span
            ><strong>{{ conversation.title }}</strong
            ><small>{{ projectTitle(conversation.projectId) }}</small></span
          ><i class="fa-solid fa-arrow-up-right-from-square ac-tiny" aria-hidden="true"></i>
        </button>
        <p v-if="!searchResults.length" class="ac-small-empty">没有找到相关会话，试试其他关键词。</p>
      </div></EwModal
    >
    <EwModal
      v-model:visible="projectVisible"
      title="新建项目"
      width="460px"
      custom-class="ac-dialog"
      :close-on-click-modal="false"
      manage-focus
      ><form id="agent-project-form" class="ac-form" @submit.prevent="createProject">
        <label
          >项目名称<input
            class="ink-input"
            v-model="projectName"
            required
            maxlength="60"
            placeholder="例如：都市高武开篇研究"
        /></label>
        <p class="ac-muted">用于整理相关对话与资料，不会创建书籍。</p>
      </form>
      <template #footer>
        <button type="button" class="ac-button ink-btn ink-btn-outline" @click="projectVisible = false">
          取消</button
        ><button type="submit" form="agent-project-form" class="ac-button ink-btn ink-btn-primary">
          创建项目
        </button>
      </template></EwModal
    >
    <EwModal v-model:visible="batchVisible" title="批量写作" width="520px" custom-class="ac-dialog" manage-focus>
      <form id="agent-batch-form" class="ac-form ac-batch-form" @submit.prevent="submitBatch">
        <div class="ac-segmented" role="tablist" aria-label="批量类型">
          <button
            type="button"
            role="tab"
            :aria-selected="batchKind === 'serial'"
            :class="{ active: batchKind === 'serial' }"
            @click="batchKind = 'serial'"
          >
            连载章节</button
          ><button
            type="button"
            role="tab"
            :aria-selected="batchKind === 'short'"
            :class="{ active: batchKind === 'short' }"
            @click="batchKind = 'short'"
          >
            批量短篇
          </button>
        </div>
        <template v-if="batchKind === 'short'">
          <p class="ac-muted">每个选题写成一篇短篇，稿子保存在对话里。</p>
          <label
            >选题（一行一个，最多 20 个）
            <textarea
              v-model="batchTopics"
              class="ink-input ac-batch-topics"
              rows="6"
              placeholder="例：婆婆把我的婚房过户给小姑子，我在房产证上发现了第三个名字"
            ></textarea>
          </label>
          <div class="ac-batch-row">
            <label
              >平台
              <el-select v-model="batchProfile" class="ink-select" popper-class="ink-select-popper">
                <el-option label="知乎盐选短篇" value="zhihu" />
                <el-option label="公众号短篇" value="gongzhonghao" />
              </el-select>
            </label>
            <label
              >何时停下来等你
              <el-select v-model="batchPolicy" class="ink-select" popper-class="ink-select-popper">
                <el-option label="有疑点才停" value="onIssue" />
                <el-option label="每五篇停一次" value="every5" />
                <el-option label="每篇都停" value="each" />
              </el-select>
            </label>
          </div>
        </template>
        <template v-else>
        <p class="ac-muted">
          作品：{{ resourceBook?.title || '尚未引用作品' }}。按顺序逐章写正文，每章写完核对；有程序核出的问题（正文为空、整段重复、与参考书重合）不会写入。
        </p>
        <div class="ac-batch-row">
          <label
            >从第几章开始
            <input v-model.number="batchStart" class="ink-input" type="number" min="1" :max="batchChapters.length" />
          </label>
          <label
            >连续写几章
            <input v-model.number="batchCount" class="ink-input" type="number" min="1" max="50" />
          </label>
        </div>
        <div class="ac-batch-chapters" role="group" aria-label="将要写的章节">
          <label v-for="chapter in batchSelection" :key="chapter.id"
            ><i class="fa-regular fa-file-lines" aria-hidden="true"></i>{{ chapter.title }}</label
          >
          <p v-if="!resourceBook" class="ac-muted">先在对话里引用一本作品，才能按章节连载。</p>
          <p v-else-if="!batchSelection.length" class="ac-muted">该范围内没有章节，请先在作品里建好空章节。</p>
        </div>
        <div class="ac-batch-row">
          <label
            >何时停下来等你
            <el-select v-model="batchPolicy" class="ink-select" popper-class="ink-select-popper">
              <el-option label="有疑点才停" value="onIssue" />
              <el-option label="每五章停一次" value="every5" />
              <el-option label="每章都停" value="each" />
            </el-select>
          </label>
          <label
            >结果处理
            <el-select v-model="batchMode" class="ink-select" popper-class="ink-select-popper">
              <el-option label="只出稿子，我来保存" value="candidate" />
              <el-option label="体检通过就直接写入" value="write" />
            </el-select>
          </label>
        </div>
        <p v-if="batchMode === 'write'" class="ac-muted">
          直接写入只在章节原本为空或版本未变时生效；有阻断或疑点的章节会停下来等你处理。
        </p>
        </template>
      </form>
      <template #footer
        ><button class="ac-button ink-btn ink-btn-outline" @click="batchVisible = false">取消</button>
        <button
          class="ac-button ink-btn ink-btn-primary"
          form="agent-batch-form"
          type="submit"
          :disabled="batchSaving || (batchKind === 'short' ? !topicList.length : !batchSelection.length)"
        >
          开始批量
        </button></template
      >
    </EwModal>
    <EwModal
      v-model:visible="organizationVisible"
      :title="organizationMode === 'move' ? '移动到项目' : '关联作品'"
      width="460px"
      custom-class="ac-dialog"
      manage-focus
    >
      <form id="agent-organization-form" class="ac-form" @submit.prevent="saveOrganization">
        <label
          >{{ organizationMode === 'move' ? '所属项目' : '关联作品' }}
          <el-select
            v-model="organizationSelection"
            class="ink-select"
            popper-class="ink-select-popper"
            :aria-label="organizationMode === 'move' ? '选择所属项目' : '选择关联作品'"
          >
            <el-option
              :label="organizationMode === 'move' ? '不归入项目（独立会话）' : '不关联作品'"
              value=""
            />
            <template v-if="organizationMode === 'move'">
              <el-option
                v-for="project in store.projects"
                :key="project.id"
                :label="project.title"
                :value="project.id"
              />
            </template>
            <template v-else
              ><el-option
                v-for="book in store.availableReferences.filter(r => r.kind === 'book')"
                :key="book.id"
                :label="book.title"
                :value="book.bookId"
            /></template>
          </el-select>
        </label>
        <p class="ac-muted">
          {{
            organizationMode === 'move'
              ? '只改变会话归属，保留原有消息、资料和成果。'
              : '引用已有作品，不新建书籍，也不改变书名。'
          }}
        </p>
      </form>
      <template #footer
        ><button class="ac-button ink-btn ink-btn-outline" @click="organizationVisible = false">取消</button>
        <button
          class="ac-button ink-btn ink-btn-primary"
          form="agent-organization-form"
          type="submit"
          :disabled="organizationSaving"
        >
          保存
        </button></template
      >
    </EwModal>
    <EwModal
      v-model:visible="settingsVisible"
      title="Agent 设置"
      width="460px"
      custom-class="ac-dialog"
      manage-focus
      ><div class="ac-form">
        <label for="agent-send-mode"
          >发送消息
          <el-select
            id="agent-send-mode"
            v-model="store.enterToSend"
            class="ink-select"
            popper-class="ink-select-popper"
            aria-label="发送消息"
          >
            <el-option label="Enter 发送，Shift + Enter 换行" :value="true" />
            <el-option label="Ctrl / ⌘ + Enter 发送" :value="false" />
          </el-select>
        </label>
        <div class="ac-settings-note">
          <strong>本地 Agent</strong>
          <p>
            项目和会话保存在本机，使用模型管理中配置的文本模型。已授权的章节修改会写入真实书籍并保留历史。
          </p>
          <p>切换页面不影响任务；完整退出后可继续已保存的任务。技能里的 Python 脚本在本机以你的用户权限运行，第三方脚本安装前会给你过目。</p>
        </div>
      </div>
      <template #footer
        ><button class="ac-button ink-btn ink-btn-primary" @click="settingsVisible = false">
          完成
        </button></template
      ></EwModal
    >
    <el-drawer
      v-model="resourcesVisible"
      title="作品资料"
      size="360px"
      :append-to-body="false"
      :show-close="false"
      modal-class="ac-resource-overlay"
      class="ac-resource-drawer"
    >
      <template #header="{ close, titleId, titleClass }">
        <h2 :id="titleId" :class="titleClass">作品资料</h2>
        <button class="ac-icon-button" type="button" aria-label="关闭作品资料" @click="close">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </template>
      <div class="ac-resources">
        <p class="ac-resource-book">
          {{ resourceBook?.title || '尚未引用作品' }}
        </p>
        <button v-for="item in resourceItems" :key="item.title" @click="openResource(item.kind)">
          <i :class="item.icon" aria-hidden="true"></i
          ><span
            ><strong>{{ item.title }}</strong
            ><small>{{ item.description }}</small></span
          ><i class="fa-solid fa-chevron-right ac-tiny" aria-hidden="true"></i>
        </button></div
    ></el-drawer>
  </div>

</template>

<script setup lang="ts">
import EwModal from '@/components/EwModal/index.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { DropdownInstance } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import type { AgentScenario, AgentView } from '@/types/agent-creation'
import { useAgentWorkspace } from './use-agent-workspace'
import { compareConversations } from './conversation-order'
import AgentComposer from './components/AgentComposer.vue'
import AgentConversation from './components/AgentConversation.vue'
import AgentDocument from './components/AgentDocument.vue'
import AgentBatchPanel from './components/AgentBatchPanel.vue'
import AgentMemoryView from './components/AgentMemoryView.vue'
import AgentAutomationPanel from './components/AgentAutomationPanel.vue'
import AgentBreakdownDocument from './components/AgentBreakdownDocument.vue'
import AgentSkillsView from './components/AgentSkillsView.vue'
import './style.scss'

const store = useAgentWorkspace()
const route = useRoute()
const router = useRouter()
const view = computed(() => (route.meta.agentView || 'chat') as AgentView)
const pageTitle = computed(() =>
  view.value === 'memory'
    ? '记忆'
    : view.value === 'skills'
      ? 'Skills'
      : view.value === 'automation'
      ? '自动任务'
      : store.active?.title ||
        (store.projectId
          ? `新对话 · ${store.projects.find(p => p.id === store.projectId)?.title || '项目'}`
          : '新对话')
)
const sidebarOpen = ref(window.innerWidth > 900)
const expandedProjects = ref<string[]>([])
// 菜单打开期间保持“更多”按钮可见，鼠标移进弹出菜单时不消失
const projectMenuId = ref<string | null>(null)
const documentExpanded = ref(false)
const composer = ref<InstanceType<typeof AgentComposer>>()
const searchVisible = ref(false)
const sessionSearch = ref<HTMLInputElement>()
const searchQuery = ref('')
const projectVisible = ref(false)
const projectName = ref('')
const organizationVisible = ref(false)
const organizationMode = ref<'move' | 'link'>('move')
const organizationId = ref('')
const organizationSelection = ref('')
const organizationSaving = ref(false)
let projectRequestId = crypto.randomUUID()
const settingsVisible = ref(false)
const batchVisible = ref(false)
const batchStart = ref(1)
const batchCount = ref(5)
const batchPolicy = ref<'each' | 'every5' | 'onIssue'>('onIssue')
const batchMode = ref<'candidate' | 'write'>('candidate')
const batchSaving = ref(false)
const batchKind = ref<'serial' | 'short'>('serial')
const batchTopics = ref('')
const batchProfile = ref('zhihu')
const topicList = computed(() =>
  batchTopics.value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 20)
)
const resourcesVisible = ref(false)
const conversationMenu = ref<DropdownInstance>()
const conversationMenuId = ref('')
const conversationMenuVisible = ref(false)
const conversationMenuAnchor = shallowRef<{
  getBoundingClientRect: () => DOMRect
  contextElement: HTMLElement
}>()
const contextConversation = computed(() =>
  store.conversations.find(item => item.id === conversationMenuId.value)
)
// 旧版妙笔的记录属于某本书，只在妙笔面板"这本书的对话"里列出；Agent 板块的侧栏、搜索、最近任务都不收它（2026-10-14 作者定）
const boardConversations = computed(() => store.conversations.filter(item => !item.legacy))
const recentConversation = computed(
  () => boardConversations.value.find(item => item.status === 'paused') || boardConversations.value[0]
)
const searchResults = computed(() =>
  boardConversations.value.filter(item =>
    `${item.title} ${item.messages.map(message => message.text).join(' ')}`.includes(searchQuery.value.trim())
  )
)
const sidebarConversations = computed(() => [...boardConversations.value].sort(compareConversations))
const independentConversations = computed(() => sidebarConversations.value.filter(item => !item.projectId))
const conversationsFor = (projectId: string) =>
  sidebarConversations.value.filter(item => item.projectId === projectId)
const projectTitle = (id: string | null) => store.projects.find(item => item.id === id)?.title || '独立会话'
const resourceBook = computed(() => {
  const related = store.projects.find(p => p.id === (store.active?.projectId || store.projectId))
  const bookId =
    store.active?.targetBookId ||
    store.references.find(r => ['book', 'volume', 'chapter', 'entity', 'selection'].includes(r.kind))?.bookId ||
    related?.bookId
  return store.availableReferences.find(r => r.kind === 'book' && r.bookId === bookId)
})
// 宿主按目录顺序给出章节引用，批量队列按这个顺序取连续区间
const batchChapters = computed(() =>
  resourceBook.value
    ? store.availableReferences.filter(r => r.kind === 'chapter' && r.bookId === resourceBook.value?.bookId)
    : []
)
const batchSelection = computed(() => {
  const start = Math.max(1, Math.floor(batchStart.value || 1)) - 1
  const count = Math.min(50, Math.max(1, Math.floor(batchCount.value || 1)))
  return batchChapters.value.slice(start, start + count)
})
function openBatch() {
  // 没有引用作品时只能批量写短篇
  if (!resourceBook.value) batchKind.value = 'short'
  batchVisible.value = true
}
async function submitBatch() {
  if (batchSaving.value) return
  if (batchKind.value === 'short') {
    if (!topicList.value.length) return
    batchSaving.value = true
    try {
      await store.createBatch({
        mode: 'short',
        topics: topicList.value,
        profileId: batchProfile.value,
        reviewPolicy: batchPolicy.value
      })
      batchVisible.value = false
      batchTopics.value = ''
      ElMessage.success('批量短篇已开始，进度显示在对话下方')
    } catch (error) {
      ElMessage.error(String(error))
    } finally {
      batchSaving.value = false
    }
    return
  }
  if (!resourceBook.value || !batchSelection.value.length) return
  batchSaving.value = true
  try {
    await store.createBatch({
      bookId: resourceBook.value.bookId,
      chapters: batchSelection.value.map(chapter => ({ chapterId: chapter.chapterId! })),
      reviewPolicy: batchPolicy.value,
      mode: batchMode.value
    })
    batchVisible.value = false
    ElMessage.success('批量任务已开始，进度显示在对话下方')
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    batchSaving.value = false
  }
}
const starters: Array<{ label: string; icon: string; scenario: AgentScenario; prompt: string }> = [
  {
    label: '开一本新书',
    icon: 'fa-regular fa-file-lines',
    scenario: 'create',
    prompt: '我想构思一本都市异能小说，先给我几个故事方向。'
  },
  {
    label: '续写与修改',
    icon: 'fa-solid fa-pen',
    scenario: 'rewrite',
    prompt: '帮我优化这本书的开篇，保留原有剧情和人物关系。'
  },
  {
    label: '拆解参考书',
    icon: 'fa-solid fa-book-open',
    scenario: 'breakdown',
    prompt: '拆解这本参考书的开篇，重点看人物怎么立住、冲突怎么起、节奏怎么走。'
  },
  {
    label: '查看榜单',
    icon: 'fa-solid fa-chart-simple',
    scenario: 'rank',
    prompt: '结合榜单和参考作品，帮我整理几个题材方向。'
  }
]
const resourceItems = [
  {
    title: '人物与关系',
    description: '当前作品的人物与关系资料',
    icon: 'fa-regular fa-user',
    kind: 'memory'
  },
  { title: '作品大纲', description: '当前作品大纲与规划', icon: 'fa-regular fa-file-lines', kind: 'outline' },
  { title: '章节正文', description: '查看与编辑章节预览', icon: 'fa-solid fa-book-open', kind: 'chapter' },
  { title: '作品记忆', description: '事实、来源与创作决定', icon: 'fa-regular fa-bookmark', kind: 'memory' }
]

function closeOnNarrow() {
  if (window.innerWidth <= 900) sidebarOpen.value = false
}
function selectSearchResult(id: string) {
  selectConversation(id)
  searchVisible.value = false
}
function toggleProject(id: string) {
  expandedProjects.value = expandedProjects.value.includes(id)
    ? expandedProjects.value.filter(item => item !== id)
    : [...expandedProjects.value, id]
}
async function newChat(projectId?: string) {
  store.newConversation(projectId)
  documentExpanded.value = false
  await router.push('/agent-creation')
  closeOnNarrow()
  focusComposer()
}
async function selectConversation(id: string) {
  store.selectConversation(id)
  documentExpanded.value = false
  await router.push('/agent-creation')
  closeOnNarrow()
}
function focusComposer() {
  nextTick(() => composer.value?.focus())
}
function onSent() {
  if (store.active?.projectId && !expandedProjects.value.includes(store.active.projectId))
    expandedProjects.value.push(store.active.projectId)
}
function startFrom(scenario: AgentScenario, prompt: string) {
  store.nextScenario = scenario
  store.draft = prompt
  focusComposer()
  // 拆书先要有书：还没引用参考书时，接着让作者挑一本或导入一本
  if (scenario === 'breakdown' && !store.references.some(reference => reference.kind === 'breakdown'))
    nextTick(() => composer.value?.chooseReferenceBook())
}
async function startSkillCreation(skillId?: string) {
  const creator = store.skills.find(skill => skill.id === 'skill-creator')
  if (!creator?.enabled) { ElMessage.warning('请先启用“技能创建与修改”技能'); return }
  const target = skillId ? store.skills.find(skill => skill.id === skillId) : null
  store.newConversation()
  store.selectedSkillId = creator.id
  store.draft = target ? `请帮我修改技能「${target.name}」（编号：${target.id}）。我的修改要求：` : '请帮我创建一个技能。我的需求：'
  await router.push('/agent-creation')
  focusComposer()
}
async function useSelectedSkill() {
  await router.push('/agent-creation')
  focusComposer()
}
async function createProject() {
  const title = projectName.value.trim()
  if (!title) return
  try {
    const project = await store.createProject(title, projectRequestId)
    expandedProjects.value.push(project.id)
    projectVisible.value = false
    projectName.value = ''
    projectRequestId = crypto.randomUUID()
    await newChat(project.id)
  } catch (error) {
    ElMessage.error(String(error))
  }
}
async function onProjectMore(id: string, command: string) {
  const project = store.projects.find(p => p.id === id)
  if (!project) return
  if (command === 'new') {
    await newChat(id)
    return
  }
  if (command === 'link') {
    organizationMode.value = 'link'
    organizationId.value = id
    organizationSelection.value = project.bookId || ''
    organizationVisible.value = true
    return
  }
  if (command === 'delete') {
    await deleteProject(project)
    return
  }
  if (command !== 'rename') return
  try {
    const { value } = await ElMessageBox.prompt('项目名称与书名相互独立', '重命名项目', {
      customClass: 'ink-confirm',
      confirmButtonClass: 'ink-confirm-btn',
      inputValue: project.title,
      inputValidator: value => (!!value?.trim() && value.trim().length <= 60) || '请输入 1—60 字的项目名称',
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    })
    await store.updateProject(id, { title: value.trim() })
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  }
}
// 项目软删除，其中的对话移到独立会话；未结束的对话会改变恢复时的上下文，先拦下
async function deleteProject(project: { id: string; title: string }) {
  const conversations = conversationsFor(project.id)
  const unfinished = conversations.filter(item => item.status !== 'completed').length
  if (unfinished) {
    ElMessage.warning(`项目内还有 ${unfinished} 个未结束的对话，请先完成、停止或删除后再删除项目`)
    return
  }
  try {
    await inkConfirm(
      conversations.length
        ? `删除项目「${project.title}」？其中 ${conversations.length} 个对话会移到独立会话，关联作品与记忆保留。`
        : `删除项目「${project.title}」？关联作品与记忆保留。`,
      '删除项目',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
    await store.deleteProject(project.id)
    expandedProjects.value = expandedProjects.value.filter(item => item !== project.id)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  }
}
async function saveOrganization() {
  if (organizationSaving.value) return
  organizationSaving.value = true
  try {
    const value = organizationSelection.value || null
    if (organizationMode.value === 'move') {
      await store.moveConversation(organizationId.value, value)
      if (value && !expandedProjects.value.includes(value)) expandedProjects.value.push(value)
    } else await store.updateProject(organizationId.value, { bookId: value })
    organizationVisible.value = false
  } catch (error) {
    ElMessage.error(String(error))
  } finally {
    organizationSaving.value = false
  }
}
async function onMore(command: string) {
  if (command === 'about') {
    settingsVisible.value = true
    return
  }
  await onConversationMore(store.activeId || '', command)
}
async function openConversationMenu(event: MouseEvent | KeyboardEvent, id: string) {
  closeConversationMenu()
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  const pointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)
  const x = pointer ? event.clientX : bounds.left + 16
  const y = pointer ? event.clientY : bounds.bottom
  conversationMenuId.value = id
  // 共用一个传送到 body 的菜单，避免被侧栏滚动区裁切，也避免为每条会话创建弹层。
  conversationMenuAnchor.value = {
    getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    contextElement: target
  }
  await nextTick()
  conversationMenu.value?.handleOpen()
}
function closeConversationMenu() {
  conversationMenu.value?.handleClose()
}
function onConversationKeydown(event: KeyboardEvent, id: string) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault()
    event.stopPropagation()
    void openConversationMenu(event, id)
  }
}
async function onConversationMore(id: string, command: string) {
  const task = store.conversations.find(item => item.id === id)
  if (!task) return
  if (command === 'move') {
    organizationMode.value = 'move'
    organizationId.value = task.id
    organizationSelection.value = task.projectId || ''
    organizationVisible.value = true
    return
  }
  try {
    if (command === 'pin') {
      await store.pinConversation(task.id, !task.pinnedAt)
    } else if (command === 'rename') {
      const { value } = await ElMessageBox.prompt('为这段创作对话设置一个名称', '重命名对话', {
        customClass: 'ink-confirm',
        confirmButtonClass: 'ink-confirm-btn',
        inputValue: task.title,
        inputValidator: value => !!value?.trim() || '请输入对话名称',
        confirmButtonText: '保存',
        cancelButtonText: '取消'
      })
      await store.renameConversation(task.id, value.trim().slice(0, 60))
    } else if (command === 'forget') {
      await inkConfirm(`忘掉「${task.title}」？这次会话记下的记忆会归档、检查点会清掉，对话记录和成果保留。`, '忘掉这次会话', {
        confirmButtonText: '忘掉',
        cancelButtonText: '取消',
        type: 'warning'
      })
      const outcome = await store.forgetConversation(task.id)
      ElMessage.success(outcome.forgottenMemories ? `已忘掉，归档了 ${outcome.forgottenMemories} 条记忆` : '已忘掉这次会话')
    } else if (command === 'delete') {
      await inkConfirm(`删除对话「${task.title}」？关联作品会保留。`, '删除对话', {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning'
      })
      await store.deleteConversation(task.id)
    }
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(String(error))
  }
}
async function openResource(kind: string) {
  resourcesVisible.value = false
  if (kind === 'memory') {
    await router.push('/agent-creation/memory')
    return
  }
  if (!resourceBook.value) {
    ElMessage.info('请先引用需要查看的作品')
    return
  }
  await router.push('/agent-creation')
  store.openResourceArtifact(kind === 'chapter' ? 'chapter' : 'outline', resourceBook.value.title)
}
function onShortcut(event: KeyboardEvent) {
  if (event.key === 'Escape' && conversationMenuVisible.value) {
    event.preventDefault()
    event.stopImmediatePropagation()
    closeConversationMenu()
    conversationMenuAnchor.value?.contextElement.focus()
    return
  }
  if (document.querySelector('.ew-modal-container[data-managed-focus], .el-message-box')) return
  if (searchVisible.value || projectVisible.value || settingsVisible.value || resourcesVisible.value) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    event.stopImmediatePropagation()
    searchVisible.value = true
  }
  if (event.key === 'Escape' && window.innerWidth <= 900) sidebarOpen.value = false
}
function onResize() {
  closeConversationMenu()
  if (window.innerWidth <= 900) sidebarOpen.value = false
}
watch(
  () => store.openedArtifactId,
  () => {
    documentExpanded.value = false
  }
)
let mounted = false
onMounted(() => {
  mounted = true
  void store.initialize().then(() => {
    if (mounted) expandedProjects.value = store.projects.map(p => p.id)
  })
  document.body.classList.add('agent-workspace-active')
  window.addEventListener('keydown', onShortcut, true)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', closeConversationMenu, true)
})
onBeforeUnmount(() => {
  mounted = false
  void store.flushDrafts().catch(error => ElMessage.error(String(error)))
  document.body.classList.remove('agent-workspace-active')
  window.removeEventListener('keydown', onShortcut, true)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', closeConversationMenu, true)
})
</script>
