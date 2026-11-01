import { isTauriRuntime } from '@/storage'
import type { PiEvent, PiToolRequest } from '@/types/agent-pi'
export async function piCommand<T>(action: string, args: object = {}): Promise<T> {
  if (!isTauriRuntime()) throw new Error('请在桌面应用中使用 Agent')
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<T>('pi_workspace', { action, args })
  } catch (cause) {
    // Rust 的 Err(String) 到这里是字符串；统一成 Error，调用方按 message 判断才接得住
    throw cause instanceof Error ? cause : new Error(typeof cause === 'string' ? cause : JSON.stringify(cause))
  }
}
export async function listenPi(
  onEvent: (instanceId: string, record: PiEvent) => void,
  onTool: (request: PiToolRequest) => void,
  onCancel: (instanceId: string, ids: string[]) => void = () => {}
) {
  const { listen } = await import('@tauri-apps/api/event')
  const stops = await Promise.all([
    listen<{ instanceId: string; record: PiEvent }>('pi-event', e =>
      onEvent(e.payload.instanceId, e.payload.record)
    ),
    listen<PiToolRequest>('pi-tool-request', e => onTool(e.payload)),
    listen<{ instanceId: string; ids: string[] }>('pi-tools-cancelled', e =>
      onCancel(e.payload.instanceId, e.payload.ids)
    )
  ])
  return () => stops.forEach(stop => stop())
}
