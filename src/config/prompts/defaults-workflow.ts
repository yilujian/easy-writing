import type { PromptFileDef } from './types'

/** 工作流建书域的提示词默认值（向导四步 + 逐章自动生文） */
export const WORKFLOW_PROMPT_FILES: PromptFileDef[] = [
  {
    id: 'workflow-wizard',
    name: '建书向导',
    group: '工作流建书',
    description: '向导的灵感 / 大纲 / 设定生成与"按要求调整"',
    slots: [
      {
        key: 'inspirationExpand',
        label: '灵感任务-扩展想法',
        defaultText: '把作者的想法扩展成一段完整的故事灵感。',
      },
      {
        key: 'inspirationRandom',
        label: '灵感任务-随机灵感',
        defaultText: '给出一段新颖的网文故事灵感。',
      },
      {
        key: 'inspirationBody',
        label: '灵感内容要求',
        defaultText: '灵感 200 字以内：一句核心设定 + 主角处境 + 核心冲突 + 爽点方向。',
      },
      {
        key: 'ideaShape',
        label: '输出结构-灵感',
        defaultText: '{"ideaText":"完整的灵感文本"}',
      },
      {
        key: 'outlineShape',
        label: '输出结构-大纲',
        defaultText: [
          '{"titleOptions":[{"id":"t1","name":"书名一"},{"id":"t2","name":"书名二"},{"id":"t3","name":"书名三"}],',
          '"selectedTitleId":"t1","intro":"作品简介120-200字","storyHook":"整本书的核心钩子",',
          '"worldItems":["世界观要点1","要点2","要点3"],',
          '"volumes":[{"id":"v1","title":"卷名","summary":"本卷主线概述","chapterCount":30,"chapterCountMode":"dynamic",',
          '"chapterRange":{"min":24,"max":40},',
          '"stages":[{"id":"v1s1","title":"阶段名","goal":"阶段目标","startState":"起点状态","endState":"终点状态",',
          '"mustHappen":["必须发生的事"],"forbidden":["不允许发生的事"],"allowedNewElements":["允许引入的新元素"]}]}],',
          '"selectedVolumeId":"v1",',
          '"chapters":[{"id":"c1","volumeId":"v1","stageId":"v1s1","chapterNo":1,"title":"章名","summary":"80-150字章纲"}],',
          '"infoItems":[{"label":"题材","value":"……"}],"suggestions":[]}',
        ].join(''),
      },
      {
        key: 'settingShape',
        label: '输出结构-设定',
        defaultText: [
          '{"worldCards":[{"id":"w1","icon":"fa-solid fa-globe","title":"卡片标题","content":"段落内容","tags":["标签"],"bullets":["要点"],"size":"normal"}],',
          '"core":{"cultivation":{"intro":"力量/成长体系概述","realms":[{"name":"境界名","desc":"境界说明"}],"more":"更高层次留白"},',
          '"ability":{"intro":"能力体系概述","innate":{"icon":"fa-solid fa-star","title":"先天","desc":"说明"},',
          '"acquired":{"icon":"fa-solid fa-hammer","title":"后天","desc":"说明"},"dimensions":["能力维度"]},',
          '"mechanics":{"intro":"世界机制概述","items":[{"icon":"fa-solid fa-gears","title":"机制","desc":"说明"}]},',
          '"resources":{"intro":"资源体系概述","items":[{"icon":"fa-solid fa-gem","title":"资源","desc":"说明"}]}},',
          '"characters":[{"id":"p1","name":"姓名","aliases":[],"gender":"男","identity":"身份","background":"背景","keywords":"关键词","motivation":"动机"}],',
          '"storylines":[{"id":"s1","icon":"fa-solid fa-route","title":"线名","desc":"概述","keyEvent":"关键事件"}],',
          '"assistActions":[],"records":[]}',
        ].join(''),
      },
      {
        key: 'outlineTask',
        label: '大纲任务',
        defaultText: [
          '为这本网文生成总纲：3 个候选书名、作品简介、贯穿全书的核心钩子、3-6 条世界观要点、',
          '2-3 卷的分卷规划（每卷 1-2 个阶段，阶段写清目标与起止状态），',
          '并给第一卷开头的 6-10 章写出章名与 80-150 字章纲（chapterNo 从 1 连续编号，volumeId 指向第一卷）。',
        ].join(''),
      },
      {
        key: 'settingTask',
        label: '设定任务',
        defaultText: [
          '基于大纲生成整套设定：4-6 张世界背景卡、完整核心体系（力量体系含 4-8 个境界、能力/机制/资源）、',
          '4-8 个主要角色（含身份/背景/动机）、3-5 条故事线（含关键事件）。图标一律用 FontAwesome 类名。',
        ].join(''),
      },
      {
        key: 'outlineAdjustNote',
        label: '大纲调整规则',
        defaultText: '在"当前大纲"基础上做定向调整：调整范围之外的内容原样保留（包括 id），输出完整大纲 JSON。',
      },
      {
        key: 'outlineAdjustFallback',
        label: '大纲调整默认要求',
        defaultText: '整体重新生成该范围的内容，质量更高、更有记忆点。',
      },
      {
        key: 'settingAdjustNote',
        label: '设定调整规则',
        defaultText: '在"当前设定"基础上做定向调整：调整范围之外的内容原样保留（包括 id），输出完整设定 JSON。图标一律用 FontAwesome 类名。',
      },
      {
        key: 'settingAdjustFallback',
        label: '设定调整默认要求',
        defaultText: '整体重新生成该范围的内容，质量更高、更立体。',
      },
    ],
  },
  {
    id: 'workflow-writer',
    name: '逐章自动生文',
    group: '工作流建书',
    description: '章纲规划、细纲展开、正文流式生成与重写',
    slots: [
      {
        key: 'jsonSystem',
        label: '结构化输出系统设定',
        variables: ['JSON形状', '补充要求'],
        defaultText: [
          '你是网文写作台的创作引擎。只输出一个 JSON 对象，不要任何解释或 Markdown 代码块标记。',
          'JSON 形状：{{JSON形状}}',
          '所有文案用中文。',
          '{{补充要求}}',
        ].join('\n'),
      },
      {
        key: 'planShape',
        label: '输出结构-章纲规划',
        defaultText: '{"chapters":[{"title":"章名（不带第几章前缀）","summary":"80-150字章纲：本章发生什么、冲突与结果、章末钩子"}]}',
      },
      {
        key: 'beatsShape',
        label: '输出结构-细纲',
        defaultText: '{"beats":["第1拍：具体情节（≤80字）","第2拍：……"],"endHook":"章末钩子一句话（≤80字）"}',
      },
      {
        key: 'plotShape',
        label: '输出结构-剧情重写',
        defaultText: '{"title":"新章名（不带第几章前缀）","summary":"80-150字新章纲：本章发生什么、冲突与结果、章末钩子"}',
      },
      {
        key: 'planTask',
        label: '章纲规划任务',
        variables: ['起始章号', '数量'],
        defaultText: '按顺序规划从第 {{起始章号}} 章开始的 {{数量}} 章章纲，与已有章节自然衔接、推进本卷阶段目标。',
      },
      {
        key: 'planNote',
        label: '章纲规划补充',
        defaultText: '每章章纲要具体可写（谁做了什么、遇到什么阻力、结果如何），避免空泛概括；相邻章不重复同类事件。',
      },
      {
        key: 'planFinal',
        label: '收尾段要求',
        defaultText: '这是本卷收尾段：最后一章要完成本卷阶段的终点状态，收束本卷主要冲突。',
      },
      {
        key: 'beatsNote',
        label: '细纲展开补充',
        defaultText: 'beats 数量 5-8 拍，按叙事顺序排列，每拍是一个具体场景动作，不是抽象概括。',
      },
      {
        key: 'beatsTask',
        label: '细纲展开任务',
        defaultText: '把本章章纲展开成可直接照着写的细纲。',
      },
      {
        key: 'contentSystem',
        label: '正文系统设定',
        variables: ['目标字数'],
        defaultTemperature: 0.82,
        defaultText: [
          '你是中文网文长篇作家兼总编，正在按章纲写一章正文。',
          '',
          '【硬性规则】',
          '1. 必须严格遵守素材里给出的写作参数、设定、人物与故事线，任何冲突以这些设定为准；视角与作品视角一致。',
          '2. 必须从当前场景直接接下去写，不能把刚刚发生的事复述一遍，也不要重新介绍人物和设定。',
          '3. 先推进动作、冲突、交易、反转、情绪压力，再补必要描写；避免空泛旁白和流水账。',
          '4. 若章节细纲存在，必须按细纲推进；细纲不完整时可以补，但不得偏离本章目标。',
          '5. 没把握时少写一点，不乱发明新规则；结尾必须留下继续写下去的动力。',
          '6. 只输出正文本身：不要章节标题、不要序号、不要任何说明或总结；不要在结尾写"未完待续"之类的话。',
          '7. 每个自然段单独一行；多用短段落与对话推进节奏。',
          '',
          '【写作原则】展示而非讲述，用动作与细节刻画人物，减少模板化措辞，避免重复上一段的句意。',
          '本章目标字数约 {{目标字数}} 字（允许上下浮动两成），写满剧情自然收在章末钩子上。',
        ].join('\n'),
      },
      {
        key: 'rewriteNote',
        label: '重写要求模板',
        variables: ['要求'],
        defaultText: '【重写要求】{{要求}}\n严格按重写要求调整，其余保持章纲既定剧情。',
      },
      {
        key: 'continueTask',
        label: '断点续写任务',
        defaultText: '从已写部分的中断处无缝续写完本章：不要重复已写内容，不要重启段落，直接接着写。',
      },
      {
        key: 'freshTask',
        label: '从头生成任务',
        defaultText: '按细纲从头写完本章正文。',
      },
      {
        key: 'plotRewriteTask',
        label: '剧情重写任务',
        defaultText: '按用户要求给本章重新设计剧情，产出新的章名与章纲；必须仍能与前后章衔接。',
      },
      {
        key: 'paragraphSystem',
        label: '段落修改系统设定',
        defaultText: [
          '你是网文改稿编辑。只输出修改后的这一段正文，不要解释、不要引号包裹、不要输出上下文段落。',
          '保持人称、时态与叙事风格不变，长度与原段相近。',
        ].join('\n'),
      },
      {
        key: 'paragraphTask',
        label: '段落修改任务',
        defaultText: '针对指出的问题重写"目标段落"。',
      },
    ],
  },
]
