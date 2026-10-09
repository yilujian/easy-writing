import type { MigrationProgress } from '@/storage/desktop-migration'
import './migration-screen.css'

/** This screen must not load application stores before the migration gate has completed. */
export function createMigrationScreen(root: HTMLElement, retry = () => window.location.reload()) {
  const screen = document.createElement('main')
  screen.className = 'migration-screen'
  screen.innerHTML = `
    <section class="migration-panel" aria-labelledby="migration-title">
      <div class="migration-brand"><img src="/logo.png" alt="" width="32" height="32"><span>易创</span></div>
      <header class="migration-heading">
        <h1 id="migration-title">正在准备工作台</h1>
        <p class="migration-description">检查本地数据，让创作继续。</p>
      </header>
      <div class="migration-progress-heading">
        <span class="migration-stage"><span class="migration-status-dot" aria-hidden="true"></span><span class="migration-stage-label">检查本地数据</span></span>
        <span class="migration-percent" aria-hidden="true">0%</span>
      </div>
      <div class="migration-track" role="progressbar" aria-label="本地数据处理进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="migration-fill"></div>
      </div>
      <div class="migration-current" role="status" aria-live="polite" aria-atomic="true">
        <p class="migration-message">正在检查本地数据…</p>
        <p class="migration-detail">请稍候，完成后将自动进入工作台。</p>
      </div>
      <section class="migration-history" aria-labelledby="migration-history-title" hidden>
        <div class="migration-history-heading"><h2 id="migration-history-title">处理详情</h2><span>按实际处理步骤更新</span></div>
        <ol class="migration-log" aria-label="已处理步骤"></ol>
      </section>
      <div class="migration-error" role="alert" hidden>
        <p class="migration-error-title">具体错误</p>
        <p class="migration-error-message"></p>
      </div>
      <footer class="migration-footer">
        <p class="migration-safety">旧数据会保留，不会自动删除。</p>
        <button class="migration-retry" type="button" hidden>重新尝试</button>
      </footer>
    </section>`
  root.replaceChildren(screen)
  const find = <T extends HTMLElement>(selector: string) => screen.querySelector<T>(selector)!
  const title = find('h1')
  const description = find('.migration-description')
  const stage = find('.migration-stage-label')
  const percent = find('.migration-percent')
  const track = find('.migration-track')
  const fill = find('.migration-fill')
  const message = find('.migration-message')
  const detail = find('.migration-detail')
  const history = find('.migration-history')
  const log = find<HTMLOListElement>('.migration-log')
  const retryButton = find<HTMLButtonElement>('.migration-retry')
  let progress = 0
  let requiresMigration = false
  let phase: MigrationProgress['phase'] = 'checking'
  retryButton.addEventListener('click', retry)

  return {
    update(event: MigrationProgress) {
      phase = event.phase
      requiresMigration ||= event.mode === 'migration'
      title.textContent = requiresMigration ? '正在整理你的创作数据' : '正在准备工作台'
      description.textContent = requiresMigration
        ? '正在升级本地存储，完成后将自动进入工作台。'
        : '检查本地数据，让创作继续。'
      if (event.phase === 'ready') {
        title.textContent = requiresMigration ? '数据迁移完成' : '工作台已就绪'
        description.textContent = '正在打开易创，请稍候。'
      }
      screen.dataset.state = event.phase === 'ready' ? 'complete' : 'working'
      const next = event.total > 0 ? Math.floor((event.completed / event.total) * 100) : 0
      progress = Math.max(progress, Math.min(100, next))
      percent.textContent = `${progress}%`
      track.setAttribute('aria-valuenow', String(progress))
      track.setAttribute('aria-valuetext', `${progress}%，${event.message}`)
      fill.style.transform = `scaleX(${progress / 100})`
      stage.textContent = {
        checking: '检查本地数据',
        backup: '保留原始数据',
        migrating: '迁移创作资料',
        verifying: '校验迁移结果',
        finishing: '加载本地设置',
        ready: '已完成'
      }[event.phase]
      message.textContent = event.message
      detail.textContent = event.detail
      if (event.log) {
        history.hidden = false
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24
        const row = document.createElement('li')
        const mark = document.createElement('span')
        mark.className = 'migration-log-check'
        mark.textContent = '✓'
        mark.setAttribute('aria-hidden', 'true')
        const text = document.createElement('span')
        text.textContent = event.log
        row.append(mark, text)
        log.append(row)
        if (nearBottom) log.scrollTop = log.scrollHeight
      }
    },
    fail(error: unknown) {
      screen.dataset.state = 'error'
      const openingFailure = phase === 'ready'
      title.textContent = openingFailure ? '暂时无法打开工作台' : '暂时无法完成数据准备'
      description.textContent = openingFailure
        ? '本地数据已就绪，但应用界面未能加载。'
        : '处理已暂停，原有数据仍然保留。'
      stage.textContent = openingFailure ? '应用加载失败' : '处理已暂停'
      message.textContent = openingFailure
        ? '请重试加载应用。'
        : `停在：${(message.textContent || '准备本地数据').replace(/[…。]+$/, '')}`
      detail.textContent = '请查看下方具体信息，处理后可以重新尝试。'
      track.setAttribute('aria-valuetext', `${progress}%，处理已暂停`)
      find('.migration-error').hidden = false
      find('.migration-error-message').textContent = error instanceof Error ? error.message : String(error)
      retryButton.hidden = false
    }
  }
}
