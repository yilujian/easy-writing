import type { UserAiModelSavePayload } from '@/types/user-ai-model'
import type { ModelTestWaitSeconds } from '@/types/model-test'

export const MODEL_TEST_CONNECT_MS = 60_000
export const MODEL_TEST_IDLE_MS = 120_000
export const MODEL_TEST_WAIT_OPTIONS = [120, 300, 600] as const

export function isModelTestWait(value: unknown): value is ModelTestWaitSeconds {
  return value === 120 || value === 300 || value === 600
}

export function modelTestWaitSeconds(
  model: Pick<Partial<UserAiModelSavePayload>, 'provider' | 'baseUrl' | 'testWaitSeconds'>
): ModelTestWaitSeconds {
  if (isModelTestWait(model.testWaitSeconds)) return model.testWaitSeconds
  if (model.provider === 'local') return 300
  try {
    const host = new URL(model.baseUrl || '').hostname
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host))
      return 300
  } catch {
    /* 地址校验由测试入口负责。 */
  }
  return 120
}

/** 只在内存比较配置，既不存储也不返回给界面，避免旧结果覆盖新配置。 */
export function modelTestConfiguration(model: Partial<UserAiModelSavePayload>): string {
  return JSON.stringify([
    model.scene || 'text',
    model.provider || 'custom',
    (model.baseUrl || '').trim(),
    (model.modelCode || '').trim(),
    (model.apiKey || '').trim(),
    model.thinking || 'default',
    model.extraParams || '',
    model.maxOutputTokens || 2048,
    modelTestWaitSeconds(model)
  ])
}
