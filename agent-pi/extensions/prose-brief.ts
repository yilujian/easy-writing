import { Type } from '@earendil-works/pi-ai'

const id = (description: string) => Type.Optional(Type.String({ minLength: 1, description }))
/** 本章章纲：只写发生什么。口吻、文风只引用作者原话，不在这里出现。 */
export const chapterPlanSchema = Type.Object(
  {
    summary: Type.String({
      minLength: 1,
      maxLength: 400,
      description: '本章发生什么、冲突与结果、章末停在哪，80 到 200 字。只写事件，不写口吻和文风。'
    }),
    beats: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
        maxItems: 8,
        description: '按顺序的 3 到 8 拍，每拍一个具体场景动作'
      })
    )
  },
  {
    additionalProperties: false,
    description:
      '本章计划。目标章在目录里已有章纲时可省略，平台以已有章纲为准；没有章纲时按卷纲、前文和作者原话拟定，平台会存进本章大纲，作者可改。'
  }
)
export const proseBriefSchema = Type.Object(
  {
    chapterId: id('对正式章节写作或改稿时填写'),
    volumeId: id('在已有卷末追加新章时填写'),
    draftId: id('修订待采用的候选时填写'),
    standalone: Type.Optional(
      Type.Union([Type.Literal('short_story'), Type.Literal('text')], {
        description: '无存储目标时，独立短篇选 short_story，粘贴改稿选 text'
      })
    ),
    title: Type.Optional(Type.String({ description: '新章或独立短篇的标题' })),
    plan: Type.Optional(chapterPlanSchema),
    facts: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 250 }), {
        maxItems: 12,
        description: '本章要用到的既有事实或前文细节，一条一句。改稿时不填。'
      })
    ),
    selection: id('只改原章的一部分时逐字引用这段原文'),
    original: id('粘贴改稿时逐字引用作者提供的底稿'),
    skillName: id('仅在作者明确点名一个现有写作技能时，引用作者提到的技能名。口吻要求直接引用作者原话。'),
    quotes: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { description: '仍有效的历史作者要求，逐字引用' })
    ),
    terms: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
    chapterNos: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 8 })),
    outlineIds: Type.Optional(Type.Array(Type.Integer()))
  },
  { additionalProperties: false }
)

export function proseMode(args: Record<string, unknown>) {
  if ([args.chapterId, args.volumeId, args.draftId, args.standalone].filter(Boolean).length !== 1)
    throw Error('请选择一个交付目标：正式章节、卷末新章、已有候选，或独立文本类型')
  return args.chapterId
    ? 'chapter'
    : args.volumeId
      ? 'new_chapter'
      : args.draftId
        ? 'revise'
        : String(args.standalone)
}
