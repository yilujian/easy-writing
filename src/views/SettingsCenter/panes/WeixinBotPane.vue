<template>
  <section class="settings-pane weixin-bot-pane">
    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-brands fa-weixin"></i>
        <strong>微信绑定</strong>
      </div>

      <p v-if="!desktopSupported" class="hint-line">微信助手只在桌面客户端可用。</p>

      <template v-else-if="status?.bound">
        <div class="bot-status-row">
          <span class="status-pill" :class="`is-${status.state}`">{{ stateLabel }}</span>
          <small>绑定于 {{ formatLocaleDateTime(status.boundAtMs, '-') }}</small>
          <small>最近收到消息：{{ formatLocaleDateTime(status.lastMessageAtMs, '暂无') }}</small>
          <small>主动推送：{{ status.pushAvailable ? '可用' : '收到一条消息后可用' }}</small>
          <small>协议版本 {{ status.protocolVersion }}</small>
        </div>
        <p v-if="status.lastError" class="error-line">{{ status.lastError }}</p>
        <p class="hint-line">
          微信联系人里的「ClawBot」就是易创助手。电脑开着、易创运行时才会回复；易创没开时发的消息会在下次启动后补收。
        </p>
        <div class="action-row">
          <button class="ink-btn ink-btn-outline" type="button" :disabled="busy" @click="reconnect">
            <i class="fa-solid fa-rotate"></i> 重新连接
          </button>
          <button v-if="status.state === 'stale_token'" class="ink-btn ink-btn-primary" type="button" :disabled="busy" @click="startLogin">
            <i class="fa-solid fa-qrcode"></i> 重新扫码
          </button>
          <button class="ink-btn ink-btn-outline" type="button" :disabled="busy" @click="unbind">
            <i class="fa-solid fa-link-slash"></i> 解除绑定
          </button>
        </div>
        <div v-if="login.active" class="qr-box">
          <img v-if="login.qrDataUrl" :src="login.qrDataUrl" alt="微信扫码绑定二维码" />
          <p class="qr-status">{{ login.message || '请用微信扫码' }}</p>
        </div>
      </template>

      <template v-else>
        <p class="hint-line">
          先在微信「我 → 设置 → 插件」里开启「微信 ClawBot」，再点下方按钮扫码绑定。
          绑定后微信联系人里会出现 ClawBot，跟它聊天就是在跟易创对话。
        </p>
        <div v-if="login.active" class="qr-box">
          <img v-if="login.qrDataUrl" :src="login.qrDataUrl" alt="微信扫码绑定二维码" />
          <p class="qr-status">{{ login.message || '请用微信扫码' }}</p>
          <div v-if="login.status === 'need_verifycode'" class="verify-row">
            <input
              v-model="login.verifyCode"
              class="ink-input-underline verify-input"
              type="text"
              placeholder="输入微信里显示的验证码"
              maxlength="12"
              @keyup.enter="submitVerifyCode"
            />
            <button class="ink-btn ink-btn-primary ink-btn-sm" type="button" @click="submitVerifyCode">提交</button>
          </div>
        </div>
        <div class="action-row">
          <template v-if="!login.active">
            <button class="ink-btn ink-btn-primary" type="button" :disabled="login.loading" @click="startLogin">
              <i v-if="login.loading" class="fa-solid fa-spinner fa-spin"></i>
              <i v-else class="fa-solid fa-qrcode"></i>
              开始绑定
            </button>
          </template>
          <template v-else>
            <button class="ink-btn ink-btn-outline" type="button" :disabled="login.loading" @click="startLogin">
              <i class="fa-solid fa-rotate-right"></i> 刷新二维码
            </button>
            <button class="ink-btn ink-btn-outline" type="button" @click="cancelLogin">取消</button>
          </template>
        </div>
        <p v-if="login.error" class="error-line">{{ login.error }}</p>
      </template>
    </section>

    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-solid fa-robot"></i>
        <strong>回答模型</strong>
      </div>
      <div class="model-line">
        <span>回答使用的模型</span>
        <strong>{{ modelLabel }}</strong>
        <button type="button" class="mini-outline-btn" @click="goModels">修改默认模型</button>
      </div>
    </section>

    <section v-if="desktopSupported" class="settings-card">
      <div class="settings-card-title log-title">
        <i class="fa-regular fa-comments"></i>
        <strong>对话记录</strong>
        <small v-if="logEntries.length" class="log-count">{{ logEntries.length }} 条</small>
        <span class="log-actions">
          <button type="button" class="mini-outline-btn" :disabled="logLoading" @click="loadLog">
            <i class="fa-solid fa-rotate-right" :class="{ 'fa-spin': logLoading }"></i> 刷新
          </button>
          <button type="button" class="mini-outline-btn" :disabled="!logEntries.length" @click="copyLog">
            <i class="fa-regular fa-copy"></i> 复制为文本
          </button>
          <button type="button" class="mini-outline-btn" @click="openLogDir">
            <i class="fa-regular fa-folder-open"></i> 打开日志文件夹
          </button>
          <button type="button" class="mini-outline-btn is-danger" :disabled="!logEntries.length" @click="clearLog">
            <i class="fa-regular fa-trash-can"></i> 清空
          </button>
        </span>
      </div>
      <p v-if="logError" class="error-line">{{ logError }}</p>
      <p v-else-if="!logEntries.length" class="hint-line">还没有记录</p>
      <ul v-else class="log-list">
        <li
          v-for="entry in visibleLog"
          :key="entry.id"
          class="log-item"
          :class="[`is-${entry.direction}`, { 'is-error': !entry.ok, 'is-open': expandedId === entry.id }]"
        >
          <button type="button" class="log-row" :aria-expanded="expandedId === entry.id" @click="toggleEntry(entry)">
            <span class="log-time">{{ formatLocaleDateTime(entry.at, '-') }}</span>
            <span class="log-dir">{{ directionLabel(entry) }}</span>
            <span class="log-route">{{ routeLabel(entry) }}</span>
            <span class="log-text">{{ entry.text || '（空）' }}</span>
            <span class="log-meta">
              <small v-if="entry.model">{{ entry.model }}</small>
              <small v-if="entry.steps?.length">{{ entry.steps.length }} 步</small>
              <small v-if="entry.durationMs">{{ formatMs(entry.durationMs) }}</small>
              <small v-if="!entry.ok" class="log-fail">失败</small>
              <i class="fa-solid fa-chevron-down log-chevron" aria-hidden="true"></i>
            </span>
          </button>
          <div v-if="expandedId === entry.id" class="log-detail">
            <pre class="log-full">{{ entry.text || '（空）' }}</pre>
            <p v-if="entry.error" class="error-line">{{ entry.error }}</p>
            <p v-if="entry.note" class="log-note">{{ entry.note }}</p>
            <ol v-if="entry.steps?.length" class="log-steps">
              <li v-for="(step, index) in entry.steps" :key="index" :class="{ 'is-error': step.status === 'error' }">
                <span>{{ step.label || step.tool }}</span>
                <small>{{ step.tool }} · {{ formatMs(step.durationMs) }} · {{ step.chars }} 字</small>
                <small v-if="step.error" class="log-fail">{{ step.error }}</small>
              </li>
            </ol>
          </div>
        </li>
      </ul>
      <div v-if="logEntries.length > visibleCount" class="action-row log-more">
        <button class="ink-btn ink-btn-outline" type="button" @click="visibleCount += LOG_PAGE">
          再看 {{ Math.min(LOG_PAGE, logEntries.length - visibleCount) }} 条
        </button>
      </div>
    </section>

    <section class="settings-card">
      <div class="settings-card-title">
        <i class="fa-regular fa-comment-dots"></i>
        <strong>在微信里怎么用</strong>
      </div>
      <pre class="help-text">{{ helpText }}</pre>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { inkConfirm } from '@/utils/ink-confirm'
import { formatLocaleDateTime } from '@/utils/format'
import { useAiModelStore } from '@/stores/ai-model'
import {
  weixinBotLoginCancel,
  weixinBotLoginPoll,
  weixinBotLoginStart,
  weixinBotLogout,
  weixinBotStart,
  type WeixinLoginStatus,
} from '@/ai/channels/weixin/bridge'
import { refreshWeixinStatus, startWeixinChannel, weixinChannelState } from '@/ai/channels/weixin/channel'
import { WEIXIN_HELP_TEXT } from '@/ai/channels/weixin/commands'
import { openWeixinLogDir } from '@/ai/channels/weixin/logfile'
import {
  clearWeixinLog,
  formatWeixinLogAsText,
  listWeixinLog,
  type WeixinLogEntry,
} from '@/storage/local-weixin-log'
import { useSettingsCenterCtx } from '../settings-context'

/**
 * 微信助手设置分区：扫码绑定、连接状态、回答模型、对话记录。
 * 绑定与开关改动即时生效，不走底部「保存设置」。
 */

const ctx = useSettingsCenterCtx()
const desktopSupported = ctx.desktopSupported
const router = useRouter()
const aiModelStore = useAiModelStore()

const status = computed(() => weixinChannelState.status)
const busy = ref(false)
const helpText = WEIXIN_HELP_TEXT

const STATE_LABELS: Record<string, string> = {
  offline: '未连接',
  connecting: '连接中',
  online: '在线',
  stale_token: '登录失效，需重新扫码',
  error: '连接异常，自动重试中',
}
const stateLabel = computed(() => STATE_LABELS[status.value?.state || 'offline'] || status.value?.state || '未知')

// ---------------------------------------------------------------------------
// 对话记录
// ---------------------------------------------------------------------------

const LOG_PAGE = 50
const logEntries = ref<WeixinLogEntry[]>([])
const logLoading = ref(false)
const logError = ref('')
const expandedId = ref<number | null>(null)
const visibleCount = ref(LOG_PAGE)
const visibleLog = computed(() => logEntries.value.slice(0, visibleCount.value))

const loadLog = async () => {
  logLoading.value = true
  try {
    logEntries.value = await listWeixinLog()
    logError.value = ''
  } catch (error) {
    logError.value = `读取对话记录失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    logLoading.value = false
  }
}

// 通道每记一笔就刷新；一条消息会记两三笔，合并到下一帧只刷一次
let logRefreshTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => weixinChannelState.logVersion,
  () => {
    if (logRefreshTimer) clearTimeout(logRefreshTimer)
    logRefreshTimer = setTimeout(() => {
      logRefreshTimer = null
      void loadLog()
    }, 300)
  }
)

const toggleEntry = (entry: WeixinLogEntry) => {
  expandedId.value = expandedId.value === entry.id ? null : entry.id
}

const directionLabel = (entry: WeixinLogEntry) => {
  if (entry.direction === 'in') return '收到'
  if (entry.route === 'push') return '推送'
  return '回复'
}

const ROUTE_LABELS: Record<WeixinLogEntry['route'], string> = {
  command: '命令',
  assistant: '助手',
  confirm: '确认执行',
  cancel: '取消',
  push: '主动推送',
  notice: '补发通知',
  media: '文件',
  rejected: '未处理',
  system: '系统',
}
const KIND_LABELS: Partial<Record<WeixinLogEntry['kind'], string>> = {
  voice: '语音',
  image: '图片',
  file: '文件',
  video: '视频',
  other: '其他',
}
const routeLabel = (entry: WeixinLogEntry) => {
  const kind = KIND_LABELS[entry.kind]
  const route = ROUTE_LABELS[entry.route] || entry.route
  return kind && entry.direction === 'in' ? `${kind} · ${route}` : route
}

const formatMs = (value?: number) => {
  const ms = Number(value || 0)
  if (!ms) return '-'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

const copyLog = async () => {
  try {
    await navigator.clipboard.writeText(formatWeixinLogAsText(logEntries.value))
    ElMessage.success('已复制全部对话记录')
  } catch (error) {
    ElMessage.error(`复制失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const openLogDir = async () => {
  try {
    await openWeixinLogDir()
  } catch (error) {
    ElMessage.error(`打开失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

const clearLog = async () => {
  try {
    await inkConfirm('清空后无法恢复；不影响微信里的对话记忆与技术日志文件。', '清空对话记录', {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await clearWeixinLog()
    expandedId.value = null
    visibleCount.value = LOG_PAGE
    await loadLog()
    ElMessage.success('已清空')
  } catch (error) {
    ElMessage.error(`清空失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// 扫码绑定
// ---------------------------------------------------------------------------

const login = reactive({
  active: false,
  loading: false,
  qrDataUrl: '',
  status: 'wait' as WeixinLoginStatus,
  message: '',
  verifyCode: '',
  /** 作者提交的验证码，轮询时带上一次 */
  submittedCode: '',
  error: '',
})
// 每次重新取码递增，旧的轮询循环看到不一致就退出
let pollToken = 0

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const startLogin = async () => {
  if (login.loading) return
  login.loading = true
  login.error = ''
  try {
    const started = await weixinBotLoginStart()
    // 二维码库只在扫码时才加载，不进设置中心的首屏；深色码白底保证各主题下微信都能扫出来
    const { toDataURL } = await import('qrcode')
    login.qrDataUrl = await toDataURL(started.qrcodeImgContent, {
      width: 220,
      margin: 1,
      color: { dark: '#241F1B', light: '#FFFFFF' },
    })
    login.active = true
    login.status = 'wait'
    login.message = '请用微信扫码并确认'
    login.verifyCode = ''
    login.submittedCode = ''
    void pollLogin(++pollToken)
  } catch (error) {
    login.error = error instanceof Error ? error.message : String(error)
  } finally {
    login.loading = false
  }
}

const pollLogin = async (token: number) => {
  while (login.active && token === pollToken) {
    // 等验证码期间不打扰服务端，作者提交后再继续
    if (login.status === 'need_verifycode' && !login.submittedCode) {
      await sleep(500)
      continue
    }
    const code = login.submittedCode
    login.submittedCode = ''
    try {
      const result = await weixinBotLoginPoll(code || undefined)
      if (token !== pollToken) return
      login.status = result.status
      if (result.message) login.message = result.message
      if (result.status === 'confirmed') {
        login.active = false
        login.qrDataUrl = ''
        ElMessage.success(result.message || '绑定成功')
        await startWeixinChannel()
        await refreshWeixinStatus()
        return
      }
      if (result.status === 'expired' || result.status === 'verify_code_blocked' || result.status === 'binded_redirect') {
        login.qrDataUrl = ''
        if (result.status === 'binded_redirect') login.active = false
        return
      }
    } catch (error) {
      if (token !== pollToken) return
      login.error = error instanceof Error ? error.message : String(error)
      await sleep(2000)
    }
    // 服务端本身是长轮询，这里只做轻微节流
    await sleep(300)
  }
}

const submitVerifyCode = () => {
  const code = login.verifyCode.trim()
  if (!code) {
    ElMessage.warning('请输入验证码')
    return
  }
  login.submittedCode = code
  login.message = '正在校验验证码'
}

const cancelLogin = async () => {
  pollToken += 1
  login.active = false
  login.qrDataUrl = ''
  login.error = ''
  await weixinBotLoginCancel().catch(() => undefined)
}

// ---------------------------------------------------------------------------
// 已绑定后的操作
// ---------------------------------------------------------------------------

const reconnect = async () => {
  busy.value = true
  try {
    weixinChannelState.status = await weixinBotStart()
    await startWeixinChannel()
    ElMessage.success('已重新连接')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

const unbind = async () => {
  try {
    await inkConfirm('解除后微信里的 ClawBot 将不再响应，本机保存的登录凭据会被删除；重新扫码即可再次绑定。', '解除绑定', {
      confirmButtonText: '解除绑定',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  busy.value = true
  try {
    weixinChannelState.status = await weixinBotLogout()
    ElMessage.success('已解除绑定')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

const modelLabel = computed(() => {
  const findName = (code: string) => {
    const model =
      aiModelStore.weixinModels.find(item => item.code === code) || aiModelStore.textModels.find(item => item.code === code)
    return model ? model.name || model.modelCode || code : ''
  }
  if (aiModelStore.weixinModel) return findName(aiModelStore.weixinModel) || aiModelStore.weixinModel
  const fallback = findName(aiModelStore.effectiveTextModel)
  return fallback ? `跟随写作助手 · ${fallback}` : '未配置，请先到「模型管理」添加文本模型'
})

const goModels = async () => {
  ctx.close()
  await router.push('/aiModels')
}

onMounted(async () => {
  if (!desktopSupported) return
  await Promise.all([aiModelStore.loadWeixinModels(), aiModelStore.loadTextModels(), loadLog()])
  await refreshWeixinStatus().catch(error => {
    ElMessage.error(error instanceof Error ? error.message : String(error))
  })
})

onBeforeUnmount(() => {
  // 关掉设置页就停止轮询二维码；服务端那边的二维码自然过期
  pollToken += 1
  login.active = false
  if (logRefreshTimer) clearTimeout(logRefreshTimer)
})
</script>

<style lang="scss">
/* 设置中心样式随批F规矩收敛在弹窗命名空间下（分区被 Teleport 弹窗包裹，scoped 会失联） */
.settings-center-modal .weixin-bot-pane {
  .bot-status-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    margin-top: 12px;
    color: var(--ink-main);

    small {
      color: var(--ink-sec);
      font-size: calc(12px * var(--ui-font-scale, 1));
    }
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--ui-border);
    background: var(--ui-glass-bg);
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    font-weight: 600;

    &::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }

    &.is-online {
      color: var(--state-success);
      border-color: color-mix(in srgb, var(--state-success) 40%, transparent);
    }

    &.is-connecting {
      color: var(--ink-accent);
    }

    &.is-stale_token,
    &.is-error {
      color: var(--state-danger);
      border-color: color-mix(in srgb, var(--state-danger) 40%, transparent);
    }
  }

  .qr-box {
    margin-top: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;

    img {
      width: 220px;
      height: 220px;
      padding: 8px;
      border-radius: 10px;
      background: #fff;
      border: 1px solid var(--ui-border);
      box-shadow: 0 10px 28px color-mix(in srgb, var(--ink-main) 12%, transparent);
    }
  }

  .qr-status {
    margin: 0;
    color: var(--ink-sec);
    font-size: calc(13px * var(--ui-font-scale, 1));
  }

  .verify-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .verify-input {
    width: 200px;
  }

  .model-line {
    margin-top: 14px;
    padding: 12px 14px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    border-radius: 8px;
    color: var(--ink-main);

    > span {
      color: var(--ink-sec);
      font-size: calc(12px * var(--ui-font-scale, 1));
      font-weight: 600;
    }

    > strong {
      flex: 1;
      min-width: 0;
      font-size: calc(13px * var(--ui-font-scale, 1));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .log-title {
    flex-wrap: wrap;

    .log-count {
      color: var(--ink-sec);
      font-size: calc(12px * var(--ui-font-scale, 1));
    }

    .log-actions {
      margin-left: auto;
      display: inline-flex;
      flex-wrap: wrap;
      gap: 8px;

      .mini-outline-btn {
        height: 30px;
        padding: 0 10px;
        font-size: calc(12px * var(--ui-font-scale, 1));

        i {
          margin-right: 2px;
          font-size: calc(11px * var(--ui-font-scale, 1));
        }

        &.is-danger {
          color: var(--state-danger);
        }

        &:disabled {
          color: var(--ink-sec);
          cursor: not-allowed;
          box-shadow: none;
        }
      }
    }
  }

  .log-list {
    margin: 12px 0 0;
    padding: 0;
    list-style: none;
    border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    border-radius: 8px;
    overflow: hidden;
  }

  .log-item {
    & + & {
      border-top: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    }

    // 收到的消息左侧一道细线标色：作者 / 助手一眼分开
    &.is-in .log-row {
      box-shadow: inset 3px 0 0 color-mix(in srgb, var(--ink-accent) 55%, transparent);
    }

    &.is-error .log-row {
      background: color-mix(in srgb, var(--state-danger) 5%, transparent);
      box-shadow: inset 3px 0 0 var(--state-danger);
    }

    &.is-open .log-row {
      background: color-mix(in srgb, var(--ink-accent) 5%, transparent);
    }

    &.is-open .log-chevron {
      transform: rotate(180deg);
    }
  }

  .log-row {
    width: 100%;
    display: grid;
    grid-template-columns: 150px 44px minmax(64px, auto) minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 9px 14px;
    border: 0;
    background: transparent;
    color: var(--ink-main);
    font: inherit;
    font-size: calc(12.5px * var(--ui-font-scale, 1));
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;

    &:hover {
      background: color-mix(in srgb, var(--ink-accent) 4%, transparent);
    }
  }

  .log-time {
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
    white-space: nowrap;
  }

  .log-dir {
    font-weight: 600;
    white-space: nowrap;
  }

  .is-in .log-dir {
    color: var(--ink-accent);
  }

  .log-route {
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--ui-border) 80%, transparent);
    color: var(--ink-sec);
    font-size: calc(11px * var(--ui-font-scale, 1));
    white-space: nowrap;
    justify-self: start;
  }

  .log-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log-meta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--ink-sec);
    font-size: calc(11px * var(--ui-font-scale, 1));
    white-space: nowrap;

    .log-chevron {
      font-size: calc(10px * var(--ui-font-scale, 1));
      transition: transform 0.18s ease;
    }
  }

  .log-fail {
    color: var(--state-danger);
    font-weight: 600;
  }

  .log-detail {
    padding: 0 14px 12px 29px;
    background: color-mix(in srgb, var(--ink-accent) 5%, transparent);

    .error-line {
      margin-top: 8px;
    }
  }

  .log-full {
    margin: 0;
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    background: var(--ui-glass-bg);
    color: var(--ink-main);
    font: inherit;
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }

  .log-note {
    margin: 8px 0 0;
    color: var(--ink-sec);
    font-size: calc(12px * var(--ui-font-scale, 1));
  }

  .log-steps {
    margin: 10px 0 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: calc(12.5px * var(--ui-font-scale, 1));

    li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 8px;

      small {
        color: var(--ink-sec);
        font-size: calc(11px * var(--ui-font-scale, 1));
      }

      &.is-error > span {
        color: var(--state-danger);
      }
    }
  }

  .log-more {
    justify-content: center;
  }

  @media (max-width: 760px) {
    .log-row {
      grid-template-columns: minmax(0, 1fr) auto;
      row-gap: 4px;

      .log-time,
      .log-dir,
      .log-route {
        grid-row: 1;
      }

      .log-time {
        grid-column: 1;
      }

      .log-dir,
      .log-route {
        grid-column: auto;
      }

      .log-text {
        grid-column: 1 / -1;
      }

      .log-meta {
        grid-column: 1 / -1;
        justify-content: flex-end;
      }
    }

    .log-detail {
      padding-left: 14px;
    }
  }

  .help-text {
    margin: 12px 0 0;
    padding: 12px 14px;
    border-radius: 8px;
    background: var(--ui-glass-bg);
    border: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
    color: var(--ink-main);
    font: inherit;
    font-size: calc(13px * var(--ui-font-scale, 1));
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
  }
}
</style>
