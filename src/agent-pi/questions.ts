import type {
  PiEvent,
  PiQuestionAnswer,
  PiQuestionOption,
  PiQuestionSpec,
  PiQuestionStep,
  PiStepAnswer
} from '@/types/agent-pi'

/** 两类交互卡；已保存的分步问题只保留回放文字，不恢复分步交互。 */
const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

function optionsOf(raw: unknown): PiQuestionOption[] {
  return (Array.isArray(raw) ? raw : []).flatMap((item: unknown, index: number) => {
    if (typeof item === 'string') return item.trim() ? [{ id: `o${index + 1}`, title: item.trim() }] : []
    if (item && typeof item === 'object') {
      const option = item as Record<string, unknown>
      const title = text(option.title || option.label)
      if (!title) return []
      const raw = option.input === true ? {} : option.input && typeof option.input === 'object' ? (option.input as Record<string, unknown>) : null
      const input = raw
        ? {
            ...(text(raw.label) ? { label: text(raw.label) } : {}),
            ...(text(raw.placeholder) ? { placeholder: text(raw.placeholder) } : {})
          }
        : null
      return [
        {
          id: text(option.id) || `o${index + 1}`,
          title,
          ...(text(option.description) ? { description: text(option.description) } : {}),
          ...(input ? { input } : {})
        }
      ]
    }
    return []
  })
}
/** 一问一问地问：每一问有自己的选项和自由回答；旧的 fields 表单也折算成分步。 */
function stepsOf(raw: Record<string, unknown>): PiQuestionStep[] {
  const list = Array.isArray(raw.steps) ? raw.steps : Array.isArray(raw.fields) ? raw.fields : []
  return list.flatMap((item: unknown, index: number) => {
    if (!item || typeof item !== 'object') return []
    const step = item as Record<string, unknown>
    const question = text(step.question || step.label)
    if (!question) return []
    return [
      {
        key: text(step.key) || `s${index + 1}`,
        question,
        ...(text(step.description) ? { description: text(step.description) } : {}),
        options: step.input === true ? [] : optionsOf(step.options),
        multiple: step.multiple === true,
        allowFreeText: step.input === true || (step.allowFreeText === undefined ? true : step.allowFreeText === true),
        ...(text(step.placeholder) ? { placeholder: text(step.placeholder) } : {})
      }
    ]
  })
}

export function normalizeQuestionSpec(args: Record<string, unknown> | undefined): PiQuestionSpec {
  const raw = args || {}
  let options = optionsOf(raw.options)
  const steps = stepsOf(raw)
  const kind: PiQuestionSpec['kind'] = raw.kind === 'confirm' ? 'confirm' : 'choice'
  if (kind === 'confirm' && !options.length)
    options = [
      { id: 'yes', title: '确认' },
      { id: 'no', title: '取消' }
    ]
  const cardType = raw.card && typeof raw.card === 'object' ? (raw.card as { type?: unknown }).type : null
  const card =
    cardType === 'breakdown-plan'
      ? (raw.card as PiQuestionSpec['card'])
      : cardType === 'batch-plan'
        ? {
            type: 'batch-plan' as const,
            title: text((raw.card as Record<string, unknown>).title),
            scope: text((raw.card as Record<string, unknown>).scope),
            goals: (Array.isArray((raw.card as Record<string, unknown>).goals)
              ? ((raw.card as Record<string, unknown>).goals as unknown[])
              : []
            )
              .map(text)
              .filter(Boolean),
            model: text((raw.card as Record<string, unknown>).model)
          }
      : cardType === 'cover-brief'
        ? {
            type: 'cover-brief' as const,
            summary: text((raw.card as Record<string, unknown>).summary),
            prompt: text((raw.card as Record<string, unknown>).prompt),
            style: text((raw.card as Record<string, unknown>).style),
            size: text((raw.card as Record<string, unknown>).size),
            model: text((raw.card as Record<string, unknown>).model)
          }
        : cardType === 'skill-script'
        ? {
            type: 'skill-script' as const,
            skill: text((raw.card as Record<string, unknown>).skill),
            script: text((raw.card as Record<string, unknown>).script),
            args: (Array.isArray((raw.card as Record<string, unknown>).args)
              ? ((raw.card as Record<string, unknown>).args as unknown[])
              : []
            ).map(text),
            reason: text((raw.card as Record<string, unknown>).reason)
          }
        : null
  return {
    kind,
    ...(kind === 'choice' && raw.afterAnswer === 'pause' ? { afterAnswer: 'pause' as const } : {}),
    ...(Array.isArray(raw.proposals) ? { proposals: raw.proposals.filter(p => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.content === 'string') } : {}),
    question: text(raw.question) || '请你决定',
    ...(text(raw.description) ? { description: text(raw.description) } : {}),
    options,
    multiple: raw.multiple === true || raw.kind === 'multi',
    historySteps: steps,
    allowFreeText:
      raw.allowFreeText === undefined
        ? kind === 'choice'
        : raw.allowFreeText === true,
    card,
    ...(text(raw.defaultOptionId) ? { defaultOptionId: text(raw.defaultOptionId) } : {}),
    ...(text(raw.placeholder) ? { placeholder: text(raw.placeholder) } : {}),
    ...(raw.multiline === true ? { multiline: true } : {})
  }
}

/** Pi 原生的四种询问（扩展里的 ctx.ui.*）也渲染成同一种卡。 */
export function specFromDialog(event: PiEvent): PiQuestionSpec {
  const title = text(event.title) || '请你决定'
  const message = typeof event.message === 'string' ? event.message.trim() : ''
  const base = { question: title, ...(message ? { description: message } : {}), historySteps: [], multiple: false, card: null }
  if (event.method === 'select')
    return {
      ...base,
      kind: 'choice',
      options: (event.options || []).map((option, index) => ({ id: `o${index + 1}`, title: option })),
      allowFreeText: false
    }
  if (event.method === 'confirm')
    return {
      ...base,
      kind: 'confirm',
      options: [
        { id: 'yes', title: '确认' },
        { id: 'no', title: '取消' }
      ],
      allowFreeText: false
    }
  return {
    ...base,
    kind: 'choice',
    options: [],
    allowFreeText: true,
    ...(text(event.placeholder) ? { placeholder: text(event.placeholder) } : {}),
    ...(event.method === 'editor' ? { multiline: true } : {})
  }
}

/** 选中项的文字：带输入框的选项把填写内容放在括号里，如"指定区间（10-25）"。 */
export const selectedText = (value: { selected: string[]; selectedIds?: string[]; inputs?: Record<string, string> }) =>
  value.selected.map((title, index) => {
    const filled = value.inputs?.[value.selectedIds?.[index] || '']?.trim()
    return filled ? `${title}（${filled}）` : title
  })
const stepText = (value: PiStepAnswer) =>
  value ? [selectedText(value).join('、'), value.text?.trim()].filter(Boolean).join('；') : ''

/** 已答卡片折叠后的那一行。 */
export function answerSummary(answer: PiQuestionAnswer | null | undefined) {
  if (!answer) return '未回答'
  if (answer.cancelled) return '取消了这次选择'
  const parts: string[] = []
  if (answer.steps) {
    const values = Object.values(answer.steps)
    const answered = values.filter(value => stepText(value)).length
    parts.push(`回答了 ${answered} 问`)
    if (values.length - answered) parts.push(`跳过 ${values.length - answered} 问`)
  }
  if (answer.selected?.length) parts.push(`你选了：${selectedText(answer).join('、')}`)
  if (answer.text?.trim())
    parts.push(parts.length ? `补充：${clip(answer.text.trim(), 60)}` : `你说：${clip(answer.text.trim(), 80)}`)
  return parts.join('，') || '已回复'
}

export function normalizeAnswer(answer: Record<string, unknown> | undefined | null): PiQuestionAnswer | null {
  if (!answer || typeof answer !== 'object') return null
  const list = (value: unknown) =>
    Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : []
  const inputsOf = (value: unknown) =>
    value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .map(([key, item]) => [key, text(item)])
            .filter(([, item]) => item)
        )
      : {}
  const steps =
    answer.steps && typeof answer.steps === 'object'
      ? Object.fromEntries(
          Object.entries(answer.steps as Record<string, unknown>).map(([key, value]) => {
            if (!value || typeof value !== 'object') return [key, null]
            const item = value as Record<string, unknown>
            const entry: Exclude<PiStepAnswer, null> = { selected: list(item.selected), selectedIds: list(item.selectedIds) }
            if (text(item.text)) entry.text = text(item.text)
            const inputs = inputsOf(item.inputs)
            if (Object.keys(inputs).length) entry.inputs = inputs
            return [key, entry.selected.length || entry.text ? entry : null]
          })
        )
      : undefined
  const inputs = inputsOf(answer.inputs)
  return {
    selected: list(answer.selected),
    selectedIds: list(answer.selectedIds),
    ...(text(answer.text) ? { text: text(answer.text) } : {}),
    ...(Object.keys(inputs).length ? { inputs } : {}),
    ...(steps && Object.keys(steps).length ? { steps } : {}),
    ...(answer.nextAction === 'pause' || answer.nextAction === 'continue' ? { nextAction: answer.nextAction } : {}),
    ...(answer.cancelled === true ? { cancelled: true } : {})
  }
}
