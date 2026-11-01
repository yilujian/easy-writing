import { isTauriRuntime } from '@/storage/writing-storage'
import { trackStorageWrite } from '@/storage/storage-maintenance'

/** 拆书导入、作品检索、工作流和通知共用的原生服务；不再提供旧 Agent 会话 Store 或事件订阅。 */
/** 已由调用方登记整个复合写入时使用，避免恢复维护在分批导入中途插入。 */
export async function invokeWritingCommand<T>(action: string, args: object = {}): Promise<T> {
  if (!isTauriRuntime()) throw new Error('此公共写作能力需要桌面客户端')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>('writing_workspace', { action, args })
}

export async function writingCommand<T>(action: string, args: object = {}): Promise<T> {
  const run = () => invokeWritingCommand<T>(action, args)
  return [
    'prose_sources',
    'prose_examples',
    'prose_example_setting',
    'prose_personal_passages',
    'prose_reference_samples',
    'prose_sample_options',
    'chapter_source',
    'story_memory',
    'story_memory_preview',
    'story_memory_status',
    'activity',
    'stop',
    'context',
    'canon_query',
    'index_status',
    'breakdown_results',
    'breakdown_library',
    'reference_export',
    'reference_publication'
  ].includes(action)
    ? run()
    : trackStorageWrite(run)
}
