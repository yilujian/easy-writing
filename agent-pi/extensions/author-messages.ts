import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'

type Answer = {
  questionId: string
  answeredAt: number
  questionSpec: { kind: string; question: string }
  selected?: string[]
  selectedIds?: string[]
  inputs?: Record<string, string>
  text?: string
  cancelled?: boolean
}
function authorMessage(message: ToolResultMessage): UserMessage | undefined {
  if (message.toolName !== 'ask_author' || message.isError) return
  const answer = message.details as Answer | undefined
  // 只投影宿主确认的普通作者回答，不把任意工具材料或平台执行确认提升为作者指令。
  if (!answer || answer.cancelled || answer.questionSpec?.kind !== 'choice' ||
    typeof answer.questionId !== 'string' || answer.questionId !== message.toolCallId || !Number.isFinite(answer.answeredAt)) return
  const selected = (answer.selected || []).map((title, index) => {
    const input = answer.inputs?.[answer.selectedIds?.[index] || '']
    return input ? `${title}（填写：${input}）` : title
  })
  const parts = selected.length ? [`对“${answer.questionSpec.question}”的选择：${selected.join('、')}`] : []
  if (answer.text) parts.push(answer.text)
  if (!parts.length) return
  return { role: 'user', content: parts.join('\n\n'), timestamp: answer.answeredAt }
}

/** 只改变模型请求的投影；原生会话与界面仍保留一份问答记录。 */
export function withAuthorMessages(messages: AgentMessage[]): AgentMessage[] {
  const projected: AgentMessage[] = []
  let answers: UserMessage[] = []
  for (const message of messages) {
    // 同一批工具回执必须连续，全部回执之后再交作者消息，保持模型工具协议完整。
    if (message.role !== 'toolResult' && answers.length) {
      projected.push(...answers)
      answers = []
    }
    const answer = message.role === 'toolResult' ? authorMessage(message) : undefined
    if (message.role === 'toolResult' && answer) {
      projected.push({ ...message, content: [{ type: 'text', text: '作者已回答此问题。' }], details: undefined })
      answers.push(answer)
    } else projected.push(message)
  }
  projected.push(...answers)
  return projected
}
