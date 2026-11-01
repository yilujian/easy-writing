import { requestLocalChatCompletion } from '@/utils/local-ai-client'
import { piMessageText, stripAttachmentMarker } from '@/agent-pi/conversation'
import type { PiMessage } from '@/types/agent-pi'

export const TITLE_MAX_CHARS = 16

/** 首轮结束后用作者和助手各一段开头起名；没有助手回复就不起。 */
export function titleMaterial(messages: PiMessage[]) {
  const user = messages.find(m => m.role === 'user')
  const assistant = [...messages].reverse().find(m => m.role === 'assistant' && piMessageText(m).trim())
  if (!user || !assistant) return null
  const question = stripAttachmentMarker(piMessageText(user)).trim()
  if (!question) return null
  return { user: question.slice(0, 600), assistant: piMessageText(assistant).trim().slice(0, 600) }
}

/** 只取第一行，去掉模型常加的前缀、引号和句末标点。 */
export function normalizeTitle(raw: string) {
  const line =
    raw
      .split('\n')
      .map(s => s.trim())
      .find(Boolean) || ''
  return line
    .replace(/^(标题|对话名称|名称|题目)[:：]\s*/, '')
    .replace(/^[「"'《“‘[【]+|[」"'》”’\]】。．.!！?？]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX_CHARS)
}

export async function generateSessionTitle(modelCode: string, messages: PiMessage[], signal?: AbortSignal) {
  const material = titleMaterial(messages)
  if (!material) return ''
  const raw = await requestLocalChatCompletion({
    modelCode,
    scene: 'agent_pi_title',
    sceneLabel: 'Agent 对话起名',
    maxTokens: 32,
    temperature: 0.3,
    timeoutMs: 30000,
    signal,
    messages: [
      {
        role: 'system',
        content: `为下面这段对话起一个不超过 ${TITLE_MAX_CHARS} 个字的中文标题，概括作者在做的事。只输出标题本身，不加引号、标点或说明。`
      },
      { role: 'user', content: `作者：${material.user}\n\n助手：${material.assistant}` }
    ]
  })
  return normalizeTitle(raw)
}
