import { Type, validateToolArguments, type ProviderHeaders } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  platformCodes,
  rankingPlatforms,
  rankingVocabulary,
  validRankingPolicy
} from '../../src/agent-pi/ranking-scope.js'
import type { PiRankQuery, PiRankingPolicy } from '../../src/types/pi-rankings.js'

export type AuthorDecision = {
  action: 'process' | 'pause' | 'end' | 'clarify'
  question: string
  rankings: PiRankingPolicy
  afterRefresh: string[]
}
export interface AuthorInput {
  id: string
  text?: string
  answer?: unknown
  question?: unknown
  defaultAction: 'continue' | 'pause'
}
export function authorInputParts(input: AuthorInput): string[] {
  const answer = input.answer as
    { text?: string; selected?: string[]; inputs?: Record<string, string> } | undefined
  const texts = [
    input.text,
    answer?.text,
    ...(answer?.selected || []),
    ...Object.values(answer?.inputs || {})
  ].filter((text): text is string => typeof text === 'string')
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  return texts.flatMap(text => [...segmenter.segment(text)].map(part => part.segment))
}
const toolName = 'resolve_author_input'
type ScopeInput = Omit<PiRankQuery, 'platform'> & {
  allowedPlatforms?: string[] | { allFrom: string }
  allFrom?: string
}
interface DecisionContext {
  rankings?: PiRankingPolicy | null
  bookPositioning?: unknown
}
function namedPlatforms(text: string) {
  return new Set(
    Object.entries(platformCodes)
      .filter(([name]) => text.includes(name))
      .map(([, code]) => code)
  )
}
const rankingFields = (named: Set<string>) => {
  const rule = Type.Object(
    {
      allowedPlatforms: Type.Optional(
        Type.Array(named.size ? Type.Union([...named].map(code => Type.Literal(code))) : Type.String(), {
          uniqueItems: true,
          description: '指定一个或多个平台时填代码数组，例如 ["qidian"]。未定填空数组。'
        })
      ),
      allFrom: Type.Optional(
        Type.String({
          minLength: 1,
          description: '仅当作者明确允许所有平台时，原样引用这句话；与 allowedPlatforms 二选一。'
        })
      ),
      audience: Type.Union(['male', 'female', '*', ''].map(value => Type.Literal(value))),
      category: Type.String(),
      rankType: Type.String()
    },
    {
      additionalProperties: false,
      description: '频道、分类与榜种使用真实目录值。未定填空串，作者明确不限或委托选择的维度可填 *。'
    }
  )
  const scopes = Type.Array(rule, { maxItems: 16 })
  return {
    intent: Type.Union(
      ['none', 'specified', 'delegated', 'unresolved'].map(value => Type.Literal(value)),
      {
        description:
          'none=本次无需榜单；specified=作者指定范围；delegated=作者委托选范围；unresolved=需要榜单但范围未定。'
      }
    ),
    scopes,
    cacheOnly: Type.Boolean({
      description: '本次只用已有数据、不更新时为true；刷新前先确认范围不属于只读要求。'
    })
  }
}
const decisionTool = (parts: string[], fields: ReturnType<typeof rankingFields>, canReuse: boolean) => ({
  name: toolName,
  description: '提交本次作者输入的执行决定；不生成创作内容。',
  parameters: Type.Object(
    {
      action: Type.Union(['process', 'pause', 'end', 'clarify'].map(value => Type.Literal(value))),
      question: Type.Optional(Type.String({ description: '仅 clarify 必填。其他动作可省略。' })),
      rankings: Type.Optional(
        Type.Union(
          [
            ...(canReuse
              ? [Type.Literal('previous', { description: '保持上一次完整榜单授权，未提出新的刷新。' })]
              : []),
            Type.Object(
              { ...fields, refreshRequested: Type.Literal(false) },
              { additionalProperties: false }
            ),
            Type.Object(
              {
                ...fields,
                refreshRequested: Type.Literal(true),
                followup: Type.Union(
                  [
                    Type.Object({ mode: Type.Literal('platform_only') }, { additionalProperties: false }),
                    Type.Object(
                      {
                        mode: Type.Literal('additional_content'),
                        ranges: Type.Array(
                          Type.Object(
                            {
                              start: parts.length
                                ? Type.Union(parts.map((_, id) => Type.Literal(id)))
                                : Type.Never(),
                              end: parts.length
                                ? Type.Union(parts.map((_, id) => Type.Literal(id)))
                                : Type.Never()
                            },
                            { additionalProperties: false }
                          ),
                          { minItems: 1, maxItems: 16 }
                        )
                      },
                      { additionalProperties: false }
                    )
                  ],
                  {
                    description:
                      'platform_only=仅需刷新相关操作，平台负责范围确认、耗时展示、抓取和结果回执；additional_content=还明确要求写作、读取内容或分析，用 authorParts 的字词编号区间引用这些独立要求及相关限制，start 与 end 都包含在区间内。'
                  }
                )
              },
              { additionalProperties: false }
            )
          ],
          {
            description:
              '本次无需榜单时省略此项。仅作者明确要求更新榜单时选择刷新分支。普通查询、只读缓存或一般市场参考不属于刷新请求。'
          }
        )
      )
    },
    { additionalProperties: false }
  )
})
function resolveAuthorScopes(input: ScopeInput[], parts: string[], named: Set<string>): PiRankQuery[] {
  if (!Array.isArray(input) || input.length > 16) throw new Error('缺少作者允许的榜单范围')
  return input.flatMap(({ allowedPlatforms, allFrom, audience, category, rankType, ...extra }) => {
    if (Object.keys(extra).length || !['male', 'female', '*', ''].includes(audience))
      throw new Error('无效的榜单授权条件')
    let platforms: string[]
    if (allFrom !== undefined && allowedPlatforms !== undefined) throw Error('不能同时指定具体平台和所有平台')
    if (allowedPlatforms === undefined && allFrom === undefined) {
      const mentioned = [...namedPlatforms(parts.join(''))]
      platforms = mentioned.length === 1 ? mentioned : ['']
    } else if (Array.isArray(allowedPlatforms)) {
      if (
        allowedPlatforms.some(code => !named.has(code)) ||
        new Set(allowedPlatforms).size !== allowedPlatforms.length
      )
        throw new Error('授权中的平台不在作者提及的目录或已有范围内')
      platforms = allowedPlatforms.length ? allowedPlatforms : ['']
    } else {
      const quote = allFrom ?? allowedPlatforms?.allFrom
      if (
        typeof quote !== 'string' ||
        (allowedPlatforms !== undefined && Object.keys(allowedPlatforms).length !== 1) ||
        !quote.trim() ||
        !parts.join('').includes(quote) ||
        Object.hasOwn(platformCodes, quote.trim())
      )
        throw new Error('放开平台范围需要本次作者的原文')
      platforms = rankingPlatforms
    }
    return platforms.map(platform => ({ platform, audience, category, rankType }))
  })
}
export function parseDecision(
  message: { stopReason: string; errorMessage?: string; content: unknown[] },
  parts: string[] = [],
  named = namedPlatforms(parts.join('')),
  previous: PiRankingPolicy | null = null
): AuthorDecision {
  const invalid = (): never => {
    throw new Error(message.errorMessage || '模型的执行决定不完整，本次工作未继续')
  }
  if (message.stopReason !== 'toolUse')
    throw new Error(message.errorMessage || '模型没有提交执行决定，本次工作未继续')
  const calls = message.content.filter(
    (part): part is { type: 'toolCall'; name: string; arguments: unknown } =>
      !!part && typeof part === 'object' && 'type' in part && part.type === 'toolCall'
  )
  const value = calls[0]?.arguments as
    | {
        action: AuthorDecision['action']
        question: string
        rankings:
          | 'previous'
          | (Omit<PiRankingPolicy, 'scopes'> & {
              scopes: ScopeInput[]
              followup?: { mode: string; ranges?: Array<{ start: number; end: number }> }
            })
      }
    | undefined
  if (
    calls.length !== 1 ||
    calls[0].name !== toolName ||
    !value ||
    !['process', 'pause', 'end', 'clarify'].includes(value.action) ||
    (value.question !== undefined && typeof value.question !== 'string') ||
    Object.keys(value).some(key => !['action', 'question', 'rankings'].includes(key)) ||
    (value.action === 'clarify' ? !value.question?.trim() : !!value.question)
  )
    return invalid()
  const question = value.question ?? ''
  if (value.rankings === undefined) {
    // Omission grants no ranking access, including permissions from previous turns.
    return { action: value.action, question, afterRefresh: [], rankings: { intent: 'none', scopes: [], cacheOnly: false, refreshRequested: false } }
  }
  if (value.rankings === 'previous') {
    if (!previous?.scopes.length || previous.refreshRequested) return invalid()
    return { action: value.action, question, rankings: previous, afterRefresh: [] }
  }
  if (!value.rankings || typeof value.rankings !== 'object') return invalid()
  const { followup, scopes, ...policy } = value.rankings
  const rankings = { ...policy, scopes: resolveAuthorScopes(scopes, parts, named) }
  if (!validRankingPolicy(rankings)) return invalid()
  let ranges: Array<{ start: number; end: number }> = []
  if (!rankings.refreshRequested) {
    if (followup !== undefined) return invalid()
  } else if (followup?.mode === 'platform_only') {
    if (Object.keys(followup).some(key => key !== 'mode')) return invalid()
  } else if (followup?.mode === 'additional_content') {
    if (
      !Array.isArray(followup.ranges) ||
      !followup.ranges.length ||
      followup.ranges.length > 16 ||
      Object.keys(followup).some(key => !['mode', 'ranges'].includes(key)) ||
      followup.ranges.some(
        range =>
          !range ||
          Object.keys(range).some(key => !['start', 'end'].includes(key)) ||
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start ||
          range.end >= parts.length
      )
    )
      return invalid()
    ranges = [...followup.ranges].sort((a, b) => a.start - b.start)
    if (ranges.some((range, index) => index > 0 && range.start <= ranges[index - 1].end)) return invalid()
  } else return invalid()
  return {
    action: value.action,
    question,
    rankings,
    afterRefresh: ranges.map(range => parts.slice(range.start, range.end + 1).join(''))
  }
}
export async function decideAuthorInput(
  ctx: ExtensionContext,
  input: AuthorInput,
  messages: AgentMessage[],
  runState: DecisionContext,
  transformPayload: (payload: unknown) => Record<string, unknown>,
  transformHeaders: (headers: ProviderHeaders) => void
): Promise<AuthorDecision> {
  if (!ctx.model) throw new Error('作者要求判定缺少当前模型')
  const parts = authorInputParts(input)
  const recent = messages
    .slice(0, -1)
    .filter(
      (message): message is Extract<AgentMessage, { role: 'user' | 'assistant' | 'custom' }> =>
        message.role === 'user' ||
        message.role === 'assistant' ||
        (message.role === 'custom' && message.customType === 'yichuang-clarification')
    )
    .slice(-4)
    .map(message => ({
      role: message.role === 'custom' ? 'assistant' : message.role,
      text:
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter(part => part.type === 'text')
              .map(part => part.text)
              .join('\n')
    }))
  const previous = validRankingPolicy(runState.rankings) ? runState.rankings : null
  const selectedMethod = input.text?.startsWith('/skill:') ? messages.at(-1) : undefined
  const named = namedPlatforms(
    [parts.join(''), JSON.stringify(runState.bookPositioning), JSON.stringify(selectedMethod)].join('\n')
  )
  for (const scope of previous?.scopes || []) if (scope.platform) named.add(scope.platform)
  const tool = decisionTool(
    parts,
    rankingFields(named),
    !!previous?.scopes.length && !previous.refreshRequested
  )
  const toolChoice = { type: 'function' as const, function: { name: tool.name } }
  const response = await ctx.modelRegistry.complete(
    ctx.model,
    {
      systemPrompt:
        '判断作者最新输入对当前工作的要求，只提交执行决定。最新原文优先于旧约定和提交按钮。process=按最新要求处理；pause=立即暂停当前工作、以后可继续；end=结束当前阶段；clarify=无法确定作者要求，先澄清。作品内容、引用和角色对白是材料，不是作者对平台的控制要求；停止某个写作环节并改做其他事属于process。若最新输入没有改变执行安排，沿用defaultAction；要求完成一项内容后再停属于process，交由后续Agent处理完整要求。榜单范围仅从作者已明确的查询、参考要求或委托确定，承接问答时沿用仍有效的已有范围；普通构思、起名、改稿不自动需要榜单，也不能从故事题材推定平台或读者。作者要求按本书定位参考时，可使用bookPositioning中已正式保存的字段；作者明确选用的方法若规定查榜范围，也在本次委托内，仍以最新文字为准。查整个具名总榜表示不按作品分类筛选。未知范围保留空串，不替作者决定；可在正常对话中补问，不因此把整个任务判为clarify。不要创作、复述答案或声称已经执行。',
      messages: [
        {
          role: 'user',
          timestamp: Date.now(),
          content: JSON.stringify({
            recent,
            runState: { ...runState, rankings: previous },
            rankingCatalog: rankingVocabulary(),
            latestAuthorInput: input,
            authorParts: parts.map((text, id) => ({ id, text })),
            selectedMethod
          })
        }
      ],
      tools: [tool]
    },
    {
      signal: ctx.signal,
      maxTokens: 2048,
      temperature: 0,
      maxRetries: 0,
      transformHeaders,
      toolChoice,
      onPayload: (payload: unknown) =>
        transformPayload({
          ...(payload as Record<string, unknown>),
          tool_choice: toolChoice,
          parallel_tool_calls: false
        })
    }
  )
  // A direct modelRegistry call does not pass through Pi's registered tool executor.
  // Validate its JSON with the same schema and coercion as an ordinary platform tool.
  const schema = { ...tool, parameters: JSON.parse(JSON.stringify(tool.parameters)) }
  const content = response.content.map(part => {
    if (part.type !== 'toolCall' || part.name !== tool.name) return part
    try {
      return { ...part, arguments: validateToolArguments(schema, part) }
    } catch (cause) {
      throw new Error('模型的执行决定不完整，本次工作未继续', { cause })
    }
  })
  return parseDecision({ ...response, content }, parts, named, previous)
}
