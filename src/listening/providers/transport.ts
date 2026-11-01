import { isTauriRuntime } from '@/storage/writing-storage'

/** 语音服务独立传输，不读取大模型配置、密钥或调用账本。 */
export const resolveSpeechFetch = async (): Promise<typeof window.fetch> => {
  if (!isTauriRuntime()) return window.fetch.bind(window)
  const { fetch } = await import('@tauri-apps/plugin-http')
  return (input, init) => fetch(input, {
    ...init,
    headers: { Origin: '', ...Object.fromEntries(new Headers(init?.headers).entries()) },
  })
}
