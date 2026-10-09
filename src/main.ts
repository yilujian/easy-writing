import type { MigrationProgress } from './storage/desktop-migration'
import { initializeDesktopStorage } from './storage/storage-startup'
import { createMigrationScreen } from './startup/migration-screen'

const root = document.getElementById('app')!
let screen: ReturnType<typeof createMigrationScreen> | undefined
let lastProgress: MigrationProgress | undefined
void (async () => {
  try {
    await initializeDesktopStorage(progress => {
      lastProgress = progress
      // 普通启动检查静默完成；确认需要迁移后才创建进度页。
      if (!screen && progress.mode === 'startup') return
      screen ??= createMigrationScreen(root)
      screen.update(progress)
    })
    await import('./bootstrap')
  } catch (error) {
    screen ??= createMigrationScreen(root)
    if (lastProgress) screen.update(lastProgress)
    screen.fail(error)
    console.error('desktop storage initialization failed', error)
  }
})()
