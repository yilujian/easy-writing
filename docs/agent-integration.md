# 真实项目、会话与后台接入

> 历史记录：旧 Agent 前端板块已于 2026-10-29 删除，当前对话入口仅保留 Agent(Pi版本)。下文的旧页面、会话 Store 和自动任务入口不再可用；仍被拆书、工作流、微信通知及备份使用的公共底层继续保留。

> 同日移除向量模型分组、向量请求、后台补建与语义检索代码；下文有关向量层的描述仅为历史记录。当前正文及记忆检索使用本机关键词／全文索引，Pi 不依赖向量模型。

## 当前保存与批量边界（2026-09-29）

- `agent_submission` 是 Agent 正文保存与界面应用的共同检查入口。保存时检查当前文本与当前规则，缺失或过期的报告不能放行；旧 `text` 保存参数同样受检查。撤销仍走已有正文版本与历史保护。
- `skip_gate` 仅表示请求作者确认，不能授权写入。宿主生成的确认绑定任务、成果版本、正文指纹、原文版本与当前问题；只有提交对应选项才有效。自由文字、否定句、未作答、上一任务的同意或旧稿确认都不能放行。
- 批量步骤区分执行中、待修订、待审阅、已完成。缺稿、半稿、过期报告、阻断和直接写入模式下未保存，均不能完成；审阅频率不绕过这些条件。恢复使用原批次与章节线程，失败可重试，重复回执不重复累加用量。
- 同批次前章候选以临时上下文参与后章生成，不进入正式正文或状态索引；依赖绑定成果版本，前章改动后阻止旧后章保存。必要候选超过预算时明确停止，不能删掉前文继续生成。正式前文的状态索引须与当前正文匹配。
- 写作器只保留职责、作者优先级和输出格式；具体人称、段长、情绪、反转和收尾由选定方法与规则集决定。短篇不再强制三次反转，拍子允许单拍和不设置钩子。作者原话由宿主投递，避免模型漏填要求。
- 效果面板的改动比例改为字符差异，统计新增、删除和替换；替换按两侧较长片段计，分母为两稿较长的字符数。它不等同于人工耗时或创作质量。

本次新增验证覆盖实际宿主与 SQLite 的多章候选/直接写入流程、质量确认、跨进程检查点、来源变化与预算拒绝。真实模型长篇效果、原生桌面全流程和 Windows 仍需独立验收。下文较早的进度与测试数量属于历史记录。


2026-09-26。依据根目录《网文Agent功能文档》《网文Agent开源方案调研与技术建议》接入真实数据与执行后台。本文件记录本次接入边界，不替代完整功能目标。

最新验收（2026-09-27）：28 项 Python 契约/纠错测试、66 项 Rust 回归、196 项前端/存储测试通过。已在 Mac 原生验证应用完成草案编辑、轻量开书、打开原编辑器及完整退出后重启回读。此前的原生窗口阻塞已不再影响本次流程；本文保留的 2026-09-26 限制属于当时验收记录。调研依据、当前建书边界和详细结果见 [开书流程与工具契约整改](agent-book-start-and-tool-contracts.md)。

## 已接入

2026-09-28 修复（七猫传输与失效作品关联）：七猫 JSON 榜单请求走专用原生通道，仅对 `www.qimao.com/qimaoapi/api/rank/book-list` 启用旧式折行响应头兼容，保留 TLS 校验，禁止重定向扩散兼容范围。请求由窗口资源管理，前端取消或关闭资源会中断后台传输，仍复用原分页解析和快照库。自动作品上下文会过滤已删除或不存在的作品；历史项目关联保留，显式作品读写仍校验有效性。记忆整理失败只提示重新核对，不再声称发生了作品保存。

2026-09-27 补充：榜单获取改为共享领域服务 `src/services/rank-service.ts`。`list_rank_sources` 从现有源配置发现完整榜单目录（包含无快照的源），返回分类、抓取开关与快照状态；`get_rank` 接收契约定义的 `latest / cached / historical` 时效要求。`latest` 复用现有抓取适配、30 分钟频控和快照库；历史请求精确匹配日期，本地请求禁止联网。`rank_trends` 比较历史快照，旧 `query_rank` 保留只读兼容。不建立第二套爬虫或榜单主库，不按用户话术匹配关键词。

榜单页“抓取本榜”和 Agent 共用 `getRank`。Agent worker 通过 `agent_rank_bridge` 将类型化请求交给应用级 `rank-executor`，不依赖榜单路由。执行器在应用挂载前注册，来源限本地主窗口；请求有编号、客户端代次、超时、取消与成功回执。重新加载时旧请求明确失败，迟到结果不再进入 Agent。HTTP 抓取传递取消信号；隐藏抓取窗口取消后丢弃结果，由原生抓取的超时生命周期关闭窗口。取消后不写入新快照。

结果返回 `acquisition / freshnessSatisfied / refresh / snapshot`，区分实际刷新、近期缓存、历史数据、刷新关闭及失败附旧快照。抓取时间与平台统计截止信息分开，空解析不覆盖旧数据。同源刷新在服务内串行并复核频控，页面和 Agent 并发不会重复抓取。系统提示词中原先强制“先查缓存、让作者去页面刷新”的榜单专用流程已删除；Skill 只描述选题分析方法，工具契约与服务承担执行逻辑。

2026-09-28 补充：`get_rank_collection` 接收平台、榜型和可选频道/分类范围。省略时效默认获取最新可用数据；目录 `collections` 给出不受分页影响的范围、频道与数量，不将首页浏览偏好作为查询范围。省略频道或分类时遍历当前配置中的全部匹配来源，不使用浏览偏好、缓存数量或目录分页裁剪范围。展示 `limit` 限制汇总总条数，`perCategoryLimit` 限制分类预览条数，均不裁剪采集范围，完整采集快照继续存入原榜单库；单榜详情仍由 `get_rank` 读取。范围查询的 `latest` 表示当天数据：当天已抓过的来源直接复用，不按单榜的 30 分钟频控重抓。需要隐藏窗口渲染的来源（番茄多页、起点）一次只抓一个，纯接口来源两条并行；每次真正联网后停顿 1.2–2 秒再取下一个来源。单源失败继续其他来源，取消后不再调度后续分类。工具选择由模型依据类型化能力进行，未新增榜单专用系统提示、关键词路由或固定回答模板。

范围结果包括逐分类来源、采集方式、时间、条目数以及成功/失败/未处理覆盖情况；只有全部来源满足时效要求才标记完整。汇总使用完整已采集快照，不以预览前三名代替统计；同指标、同快照日、同平台统计截止信息才跨类比较，缺少截止信息时保留单类。按书籍标识去重，重复观测值取较大可见值排序且保留各分类原始值，不相加。结果明确是已采集条目的指标排序，不是官方全站总榜；配置源覆盖完整也不代表抓到了站点所有分页。失败附旧数据不参与最新汇总。

集合任务通过受主窗口约束的进度回传更新界面完成数。单个来源的最坏耗时按起点 5 页 × 窗口 60 秒上限再加余量计为 420 秒：单榜以此为总时限，集合以此为两次进度之间的最长间隔，总时长超过 1 小时终止。宿主在榜单工具真正开始执行时写入当前工具，模型一次发出多个工具调用时界面也显示实际在跑的那个。重复、倒退、不同总量的进度不延长等待；刷新执行器、停止会话或过期结果均沿用现有取消与回执机制。

2026-09-28 修正（规模与证据）：

- 快照按键前缀读取。新增 `desktop_store_keys`（只返回标识，可按前缀过滤），桌面端 `getAllKeys` 不再把整个命名空间的内容读出来；Rust 侧 `agent_store::list` 在 SQL 里按前缀过滤，`query_rank` 目录只在 SQLite 中取元数据，不载入条目。格式不完整的快照跳过并以 `skippedSnapshots` 计数，不再让所有查询失败。
- 范围采集中需要联网的来源超过 10 个时，先返回 `confirmation_required`（数量、已是当天数据的来源数、预计分钟），不发出任何请求。确认由工具自己发起，不经模型：宿主生成确认编号、问题和三个固定选项（0 只用本地快照〔默认选中〕、1 联网抓取、2 取消），记在 `ew-agent-operations` 的 `rank-confirm:{会话}`；`get_rank_collection` 用 LangGraph 中断把它交给作者，等待事件带着编号写到选项消息上。作者作答后工具从头执行，宿主从会话记录读作者点选：只有选中项为 1 且其后作者消息正是该选项文字（界面点选时两者一致）才向执行器传 `networkApproved`；选 0 时宿主把本次请求改为 `cached`，选 2 返回 `declined`；打字回复（包括“同意”“取消”）或未作答就恢复一律返回 `not_confirmed` 并附作者原话，模型再次调用会重新弹出确认。同意在 30 分钟内对同一范围有效，其他结论只用一次。
- 交给模型的数据变小：目录每个榜单只给快照份数、首末日期；单榜结果附最近 14 个日期；`query_rank` 每个榜单最多列 14 个日期并给出总份数。单榜条目去掉封面、章节链接等展示字段，简介截到 80 字；完整条目仍在快照库，榜单页不受影响。
- 选题卡：`save_selection_cards` 把 1–5 张 `SelectionCard` 存为会话成果（`kind: selection`），不建书。证据分两类且契约上互斥：`data` 只能填榜单编号、快照日期和书名，没有写文字或数字的位置；`judgment` 写模型的归纳、比较、统计与题材判断。宿主不解析模型的句子：数据证据的展示文字由宿主从快照读出生成（榜单标题、快照日期、每本书的名次与指标，不指定书名时为整份快照及条目数），界面标“已核对”；快照或书名在本地找不到时标“待核实”；判断证据原样展示并标“判断”。这样“已核对”的内容只来自快照，模型写错的数字只可能出现在“判断”里，不会被当成核对结果。成果面板以卡片展示，“按这个方向开书”把指令填入输入框，由作者确认后发送。`topic-selection` 技能改为用该工具保存。
- Agent 等其他入口抓到新快照时，榜单页若正在看同一范围的最新数据会自动刷新（连续到达的快照合并为一次）。

验证边界：已覆盖共享服务、执行器协议、Rust 请求隔离和真实模型对三类时效要求的工具选择。真实模型意图评测的领域数据为测试夹具，不作为外网站点抓取证明；桌面端实际联网抓取验收仍需解锁 Mac 后完成。

主模型调用工具时的过程说明只显示为工具状态，不再与正式回答拼接；章节生成仍走独立的 `draft` 流式事件。每次模型调用在框架提示装配后补充中文表达约束，保留作品原文和必要专名。开发构建优先使用虚拟环境中的当前 worker 源码，正式构建仍使用包内冻结后台。

启动警告处理：`run_prepared` 收窄到模块内；契约类型枚举限定为测试使用；索引进程异常时调用 `release` 释放已领取事件；起草前实际调用规则集 `verify`，规则过期时要求重新解析。

| 功能 | 实际行为 |
|---|---|
| 项目 | 只保存项目名称，作为会话组织空间；后续可关联已有作品，名称与书名独立 |
| 会话 | 持久化消息、引用、输入草稿、模型选择、等待问题与任务状态；重命名和软删除 |
| 后台 | Tauri 管理 Python 子进程；复用 Deep Agents / LangGraph，不自建模型执行循环 |
| 模型 | 原生端从统一设置读取所选 BYOK 模型；密钥仅通过私有 stdin 传给执行进程，不进入命令参数或检查点 |
| 对话 | 真实流式回复、工具状态、动态选项、中止和恢复；运行中的补充要求进入持久队列，在下一次模型调用前处理 |
| 书籍工具 | 准备开书草案，由作者采用具体版本后建立作品；列目录、读取正文/人物/设定、大纲、有效记忆、保存候选，明确本轮写入目标后修改作品；无需先有项目 |
| 成果 | 报告/方案/章节候选可保存和编辑；章节候选可以应用、撤销，使用原文版本检查并保留历史 |
| 记忆与技能 | 自动整理有来源版本的作品摘要和作者决定，区分有效、待定、否决、过期与归档；支持人工管理，Skills 按需加载 |
| 备份 | 项目/会话、检查点、回执加入既有备份清单；恢复期间禁止后台写入 |

## 开书与资料保存接入（2026-09-26）

2026-09-27 调整：以下“直接建书”的验证记录属于旧实现。当前模型使用 `prepare_book_plan` 保存可编辑草案，作者确认采用具体版本后才建立作品；现在也可在对话明确授权采用该版本（2026-10-06）。暂定书名和轻量构思均可使用，不要求完整大纲；试写稿可独立保存。采用后等待下一条创作指令，不自动写首章。详见 [开书流程调研与工具契约整改](agent-book-start-and-tool-contracts.md)。

已新增卷/章节创建、卷目录读取、人物/大纲/世界设定的逐条候选与正式保存，以及会话成果列表/最新版本读取工具。建书返回实际首卷和首章编号，后续沿用；新增目录带稳定操作编号，重试不重复创建。

资料候选使用结构化字段，在现有成果面板编辑。正式保存写入原 `ew-local-reference/book-reference`，不另建正文或资料主库。只变更指定条目，保留其他人物、关系、时间线等内容；资料变更前后值写入现有操作回执，章节修改继续写入 `chapter_versions`。资料候选的应用状态、正式记录和回执在同一事务中提交。

前端资料整包提交增加数据库原值比较，阻止 Agent 在读取后更新的数据被旧整包覆盖。人物、设定和大纲编辑入口另带字段基线，仅提交作者实际改动的字段；同字段冲突保留当前稿并报错。未新增数据库或启动迁移。

成果编辑带 revision；采用方案前模型读取最新成果。成果面板等待保存成功才提示，失败保留候选；已保存的成果可打开作品，章节成果可定位对应章节。章节成果应用已将正文、历史、回执和成果状态合并为一个事务。

本轮已通过 192 项前端/存储测试、54 项 Rust 测试。源码和冻结后台均用真实模型在独立会话完成“建书、保存人物/大纲/世界设定、写入第一章并回读”，核对首章未重复创建、正文版本与编辑器历史均落盘。浏览器用真实成果组件验证编辑后保存、失败时保留稿件与状态；此处桌面接口使用隔离测试适配。类型检查、ESLint、前端构建和 Mac 验证包构建通过。原生应用已能启动进程，但系统辅助功能返回 AXError.cannotComplete / timeoutReached，未完成原生窗口点击及重启回读验收。

## 保存规则

### 作品记忆与跨会话接续（2026-09-26）

- 记忆继续使用 `ew-agent/records` 的 `memory:` 记录。正式正文、资料仍只有平台主库一份；记忆保存摘要、来源标识/指纹、原文摘录、状态、版本及替代关系。
- 每轮在框架保存输入检查点后整理作者决定，正常完成后整理相关正式章节和资料。当前来源分批读取，长来源只总结可见片段并标记部分覆盖；整理失败提示记忆未完成，不把已成功保存的作品报成失败。成功的空提取也留回执，避免反复将普通操作请求送去整理。
- 自动采用/否决必须对应本会话的作者原话和连续摘录。候选只进入待定；否决单独作为约束传给模型。旧决定被替代后归档；较早会话延迟返回的决定不能重新激活旧方案。作者长期偏好仍需人工确认，自动提取不扩散到其他作品。
- 新会话可根据单一作品引用或明确选择的作品加载有效记忆、近期任务、章节进度及同作品成果。上下文归属与正文写入权限分开，不要求建立项目。新会话按现有作品状态接续，不自动启动另一会话的执行进程。
- 每次模型调用前重新核对来源，临时上下文不反复追加到框架检查点。原编辑器或 Agent 改了章节/资料后，旧摘要在下一次读取时转为待更新，不参与有效事实；重新整理后旧版本归档。手工修订和删除的同版本摘要不会自动复活。
- 保存正文时还校验生成期间的来源章节、资料和作者决定。变化时保留可见章节候选，正式正文不覆盖。章节候选保留来源上下文，避免之后直接应用已过期的方案。
- 记忆页新增待定、已否决、待更新、已归档筛选及来源查看；手动确认旧摘要前也校验来源。备份合并会映射上下文作品、来源和替代关系，仍不重放旧二进制检查点。

验证：193 项前端/存储测试、61 项 Rust 测试通过；源码与冻结后台均完成真实模型跨会话测试，覆盖否决旧设定、独立新会话回读第一章、续写第二章和自动摘要。冻结后台的开书与中断/换进程恢复回归也通过。续写验收同时检查实际读取版本与关键情节要素，允许自然指代，不强制逐字复述原词。浏览器用真实记忆组件和隔离接口验证筛选、否决、确认与来源查看。Mac 验证包构建通过；本轮原生窗口验收因 Mac 锁屏未完成，需解锁后继续。

### 基础保存约定

2026-09-26 调整：新对话默认独立保存，projectId 为 null；引用书籍或上传附件不创建项目。会话菜单支持移入项目或移回独立会话，项目菜单支持新建对话、重命名及关联已有作品。创建项目不建书，项目名称不改变书名；已有数据不做批量重写。未结束任务完成后才能改变归属或相关项目的作品关联。

2026-09-28 补充：项目菜单增加“删除项目”（`delete_project`）。项目软删除，备份仍保留记录；其中的对话移到独立会话，成果、检查点与写入目标保持原身份，关联作品和作品记忆不受影响。项目内有未结束的对话（运行中、暂停、等待回答、失败待恢复）或未结束的批量连载时拒绝删除。侧栏项目行以文件夹开合图标表示展开状态，“更多”按钮在鼠标悬浮、键盘聚焦或菜单打开时显示，触屏设备始终显示。

每轮新指令重置上轮写入目标。模型按作者明确修改要求调用 `select_write_target`；只有引用不具备写入权限。旧版待恢复任务保留原授权对象。明确建书后，新书进入当前会话引用，所属项目名称和关联均保持原样。

2026-10-16 补充（任务延续）：上一段“每轮重置写入目标”已改为按任务算。任务是作者交代的一件事，会话上记 `taskId` 与本任务包含的轮次 `taskRunIds`（`agent_task::runs / author_messages / instruction`）。普通输入框消息、选方向、答卡、“继续”、拆书完成后的续跑都接着当前任务；批量的每一步、自动任务的每次运行各开一件新事；模型判断作者换了另一件事时调用 `begin_new_task`（不按措辞猜）；记忆整理轮不属于任何任务。同一任务里：写入目标、作者选定的技能一直有效；`taskInstruction` 只记发起这件事的那条消息，作者要求按任务内全部作者消息累积（宿主代发的拆书续跑提示不算）；原话核对（`author_said_any`）、资料读取快照（`material-read`）、任务结果（`task_outcome`）都按任务的轮次算。规则集指纹不再包含作者原话，作者补一句话不会让拍子和候选作废；起草时规则集真有变化（作者规则、画像、技能、本书要求），`agent_ruleset::current` 按原方法当场换成新版并在候选上记 `rulesetRefreshedFrom`，不再返回 `stale_ruleset` 让模型重存拍子；写作依据的 `authorTask` 取起草那一刻本任务的全部原话。采用开书草案后新书直接成为写入目标，去掉了“采用那一轮禁止写入”（`next_instruction_required`）。上一轮停下时收件箱里没送达的补充，在下一条消息前按原顺序一并交给模型。输入框发新消息时待答卡片仍作废、不算答复也不授权，但不再另起一件事。

同日补充（停滞与上限的收尾）：同一操作用相同参数拿到相同结果，第 3 次在请求里提醒模型换做法，第 5 次收起工具；同一工具连续失败超过 3 次（`tool_boundary.retry_limit`，回执 `tool_retry_limit`）同样收起工具；本轮规划调用只剩最后一次时也一样。收起工具后模型仍返回的工具调用一律丢弃，这一轮以给作者的说明结束，不再抛异常把整轮判为失败。`runtime_errors` 补上 `ModelCallLimitExceededError` 的真实类名。

本次解耦验证：187 项前端/存储测试、49 项 Rust 测试通过；冻结后台的真实模型独立会话测试通过，覆盖无项目读取、等待选择、换进程恢复、明确目标后写入及历史记录。网页端已检查新建项目弹窗只有名称字段，并且没有自动建书选项。Mac 锁屏仍阻止原生界面的归档、关联等完整操作验收；已有书籍与项目未自动删除或解绑。

正式作品只保存在原有作品表。Agent 的辅助数据使用已有的 `desktop_records`：

- `ew-agent/records`：`project:`、`session:`、`artifact:`、`memory:`、`skill:`。
- `ew-agent-checkpoints/records`：框架检查点、父链和中间写入；二进制值按 SDK 序列化为可保存的文本。
- `ew-agent-operations/records`：稳定操作编号、已完成回执及读取时的原文证据。

原生端以具体命令更新字段，不接受前端用整份旧会话覆盖后台状态。进度快照限频落盘，最终状态与等待问题立即保存；前端以 revision 丢弃迟到的旧快照。

章节保存将版本检查、修改前历史、新正文、目录字数和操作回执放在同一 SQLite 事务中。恢复时沿用工具调用编号，已提交的操作返回原回执，不再次写章。版本冲突不覆盖作者新稿。

框架检查点是执行证据，其中的旧正文不能反向作为正式作品。候选稿从会话实际读取的版本取原文，不将后来的新正文伪装成候选基线。

导入备份的覆盖模式保留原检查点；合并模式为项目/会话换号并更新书籍引用，保留历史消息，但不重放包含旧书籍编号的二进制检查点。该限制在导入会话中明确记录。

## 生命周期

切换页面不停止任务。活动任务期间普通关窗会隐藏窗口，后台继续；完整退出经宿主停止子进程，保留检查点与已提交成果。下次读取工作区时把失去执行进程的 running 状态标为 paused。

进程恢复以检查点和业务回执为边界，不保证恢复网络请求生成到一半的单个字。已完成数据库写入不会因为模型请求需要重试而重复提交。

## 作品状态层契约（2026-09-27，护城河实施方案 A3）

`agent-runtime/contracts.py` 现在同时定义工具参数和作品状态层文档：章节卡 `ChapterCard`（事件带叙述顺序与故事顺序、人物用 `EntityRef` 引用、事实带稳定编号、知情记录）、拍子 `BeatsPlan`、任务规则集 `Ruleset`、质量报告 `QualityReport`（绑定成果版本与文本指纹，问题级别只有 block / suspect / notice）、平台画像 `PlatformProfile`、短篇结构卡 `ShortStoryPlan`、选题卡 `SelectionCard`、引导交互 `AuthorPrompt` / `AuthorAnswer`。人物资料字段新增 `aliases`（别名，供索引解析）与 `voice`（语言指纹）。

`export_contracts.py` 把它们导出到 `tool-contracts.json` 的 `documents` 段，并用 `--ts` 生成 `src/types/canon.ts`；`--check` 同时校验两份产物。Rust 侧 `agent_contract::validate_document / document_issues / document_kinds` 用同一份 Schema 校验，旧契约文件没有 `documents` 段时按空表处理。这些类型最初只是契约；索引器、上下文引擎、质量门已在后续阶段接入（见 A2/A4、A5、A8 小节）。

```bash
cd agent-runtime && uv run python export_contracts.py --ts   # 修改 contracts.py 后
uv run python export_contracts.py --check                     # 构建前
```

### 模型角色（A9）

模型分组新增 `agent_planner / agent_writer / agent_critic / agent_indexer`（`src/types/ai-model.ts` 的 `AI_MODEL_GROUPS`）。回退链：子角色 → `agent_planner` → `text_assist`，前端 `useAiModelStore().ensureGroupModel()` 与宿主 `agent_service::model_config(db, code, role)` 同一规则。作者在 Agent 输入框指定的模型只决定规划角色；`prepare_run` 用 `role_model` 为写作、评审、索引各取自己的默认模型，未设置时跟随规划模型，通过 payload 的 `models` 传给 worker；worker 的记忆整理改用索引角色。模型管理页的默认模型卡改为按分组列表渲染。

### 检查点按线程隔离（B6a）

`checkpoints.py::HostSaver` 每次调用都带 `thread`；宿主键格式：主线程（与会话同名）沿用 `{sid}:{namespace}:{id}`，子线程为 `{sid}|{thread}:{namespace}:{id}`。升级前的检查点无需迁移；子线程键始终以会话编号开头，进程读不到其他会话的检查点。worker 从 payload 的 `thread` 取线程编号，缺省为会话编号，为批量连载的按章子运行做准备。

### 作品状态层与索引器（A2、A4）

`src-tauri/src/agent_canon.rs` 把作者维护的数据（`ew-agent-author/records`：规则、平台画像、作品画像选择、线索人工状态、疑点裁决、文风样本确认、索引暂停）与派生数据（`ew-agent-canon/records`：章节卡、事实、人物状态、线索、疑点、索引进度）分开存放；备份清单两者都有，恢复时只有派生库允许跳过重建。章节卡写入时校验契约、引文必须是正文连续子串、低置信度状态变化移入 `unresolved`，并登记事实、线索、实体索引。`fold_states` 按故事顺序折叠人物状态，伪装事件不折叠，倒叙按实际时间折叠，死后出场与同一时间点的矛盾写成疑点（附两处原文），作者裁决过的同一疑点不再生成。

索引器：`agent_indexer::prepare_batch` 领取事件，目录与资料事件直接完成，章节事件先切块再生成模型任务；`agent_host::run_indexer` 用 `agent_indexer` 角色模型启动 worker 的 `action: "index"`（`agent-runtime/indexer.py`，每章一次有界的结构化提取），写卡经 RPC `canon_put` 回宿主校验；`finish_batch` 按指纹提交、失败释放重试、连续三次失败后不再重试并留在失败列表，最后折叠状态。触发时机：启动 30 秒后、每次会话结束后、`agent_workspace action=index_now`；作者可按作品 `index_control` 暂停。索引过程与结果统一走 `agent-index` 事件（`index_progress` / `index_failed` / `index_book` / `index_finished`）。`schedule_index` 走安静期（20 秒），有待处理事件但都在安静期内时最多再等三个安静期；批量连载每章前调用的 `run_indexer` 不等安静期，已有索引器在跑就等它结束（最多两分钟）。索引进程只允许 `canon_put` 一个协议方法，拿不到会话工具与检查点；一批里一章都没写成时本轮停止领取。没有配置索引模型时不领取事件。

### 上下文引擎（A5）

`src-tauri/src/agent_context.rs::assemble` 按来源与相关性装配固定、相关、邻近、风格和任务五层，不再设置固定层 2500 token 或其他分层硬上限，也不预扣模型容量的固定百分比。容量边界为所选模型上下文减输出预留；`budgetTokens` 只作为可选检索材料的软目标。作者规则、选定技能、核心设定、本章人物资料、明确选定的示例与前章候选完整保留，先去重再按相关性缩减可选历史。必要内容仍装不下时返回分层用量及 `budgetExceeded`，不改动规则或记忆。Rust 负责资料选择及预估，Python `prepare_request` 在发送前计量完整请求（含系统消息、模型输出结构与输出预留）。规则在系统消息中只注入一次，`render_prose` 不重复附带规则集。

### 任务与交付一致性

- 作者原文与创作角色输入分开保存：`agent_task` 绑定原文来源，`TaskProjection` 只对原文连续片段分配创作或执行角色，完整覆盖检查禁止增删改写。写作和评审只使用创作要求；规划仍保有完整作者任务。投影结果按来源指纹缓存，随写作依据保存。
- 资料读取快照由宿主绑定到会话和运行。`save_material` 的模型参数不再要求版本哈希；旧调用仍校验其原始版本。缺少读取和版本不符返回结构化领域错误，真正并发冲突继续保留候选。
- 交付预算从交付阶段开始，每个真实模型请求在 `request_budget` 中计数并在请求前持久化；SDK 与网关不隐藏重试。重入同一交付操作复用剩余预算。读者通读结果绑定正文版本、指纹和写作依据，编辑评审失败只重试失败阶段。格式失败保存可回放诊断。
- 修订以宿主生成的块编号定位。新增确定性阻断项的版本留在拒绝回执中，不替换当前候选；其他自动修订标为待验，只有其自身复评确认改善、事实保留及范围合规后才能采用。预算耗尽、复评失败或中断恢复时撤回待验修订。作者编辑建立新基线，不会被自动恢复覆盖。
- `completed` 表示运行结束。宿主独立从当前成果与报告计算 `taskOutcome`，区分未完成、待作者决定和已交付；生成结束事件及测试进程退出不能代替此结果。生成提交具有独立回执，重复或迟到的提交不能覆盖已完成/已编辑稿件。
- 实跑验证应固定代码、模型和原始输入，复用正式执行入口；任何模型切换、提示追加或代码修改都开始新的测试记录，不能混作一次自主完成的结果。

### 确定性质量门（A8）

`src-tauri/src/agent_quality.rs`：硬阻断只有空稿、字数不到画像下限一半、整段重复、作者自定义敏感词；段长、对白比例、句式、AI 味词与排比、段末升华、章末与开篇钩子是提示；人物表之外的称呼和状态层疑点是 suspect，附原文交作者裁决。各 code 的级别由平台画像 `gate` 决定。报告绑定被检文本的指纹与版本，经契约校验。入口：工具 `check_chapter`（成果或章节；成果版本不符返回 `stale_artifact`，报告写回成果 `reports`）、界面动作 `quality_check`。读者模拟评审（critic）已随写作流水线接入（见 B1–B5 小节的 `check_chapter(with_critic)`）；未配置评审模型时报告里 `critic.status = unavailable`。

### 技能文件（A7）

内置技能 17 个在 `src-tauri/resources/skills/<id>/SKILL.md`（打包为 `skills/` 资源），frontmatter 含 `name / description / kind / replaces / version`；作者覆盖版放提示词目录的 `skills/<id>/SKILL.md`。`agent_skills::sync` 在 `load` 时同步进 `skill:` 记录：作者没在应用内改过说明的跟随文件更新，改过的保留并记下内置最新内容，`reset_skill` 恢复默认；旧的数据库引导技能 `chapter-editor` 被 `chapter-writing` 取代后停用。写作方法技能：`chapter-writing`（长篇）与 `short-story`（短篇）。技能页的“恢复默认”按钮与提示词页分组尚未接入。

### 任务规则集（A10）

`src-tauri/src/agent_ruleset.rs`：作者本轮原话（必须是本轮消息的原文摘录）> 作者规则 > 一个写作方法技能（`kind: method`，`replaces` 缺省为 `chapter-writing`，同目标多个启用时返回 `ruleset_conflict` 让作者二选一）> 平台画像。解析结果带 `rulesetId` 与指纹，持久化在作者命名空间；工具 `resolve_ruleset` 与界面动作 `ruleset_preview` 共用同一解析；`verify` 在规则、画像或技能变化后标记过期。内置技能 `chapter-editor` 升级为默认方法技能。

### 变更事件与检索表（A1）

`src-tauri/src/agent_indexer.rs` 在核心表之后建 `agent_outbox`、九个 `trg_agent_*` 触发器（正文更新/插入、目录插入/更新/删除、卷插入/更新、资料插入/更新）、`chapter_chunks`、`canon_entities`，以及 FTS5 可用时的 `chapter_fts`（trigram）与同步触发器；`desktop_meta` 记录 `fts5-available` 与 `agent-index-schema` 版本。索引器协议：`claim`（安静期 20 秒、按组领取、资料 > 目录 > 正文、释放超过 10 分钟的旧领取）→ `chapter_fingerprint` → `complete`（章节指纹变化即释放本组不标记）。检索：三字以上走 trigram，两字走实体索引 `search_entities` 与 LIKE。模型提取（索引角色按章提取章节卡）与状态折叠（`canon::fold_states`）已接入（A4）。

### 写作流水线（B1–B5，2026-09-27）

- `plan_beats(plan)` / `plan_chapters(plan)`：拍子表与多章规划先经 `beatsPlan` / `chapterBatchPlan` 契约校验，`rulesetId` 必须与当前规则集一致，线索 id 必须存在于状态层，否则 `invalid_thread`；成果 kind 分别为 `beats` 与 `outline`。
- `draft_chapter`：宿主 `draft_begin` 读证据、装配上下文（`purpose: write`）、建 `partial: true` 的章节成果；worker 用 `agent_writer` 流式生成，0.5 秒一批 `draft` 事件，宿主 `apply_event` 更新成果内容并推送 `agent-draft`；`draft_finish` 落最终正文、版本加一、算指纹并跑质量门，报告附在 `artifact.reports`。中断只留部分内容，不会自动保存。
- `check_chapter(with_critic)`：先跑确定性质量门，再用 `agent_critic` 做读者模拟（`critic.py`），`attach_critic` 只接受正文里能找到的引文，评审给出的 block 一律降为 suspect。报告绑定 `reviewedRevision` 与 `reviewedFingerprint`；正文改动后旧报告标记 `stale`，界面上用同口径 sha256 前 16 位比对。
- `revise_spans`：`revise_begin` 按问题的段落序号给出目标段，模型只返回 `SpanRevision`（段落序号 + 新文本），`artifact_replace` 按“非空行即一段”替换，其余段逐字不动，旧报告标过期并重新体检。
- `save_chapter(artifact_id, expected_artifact_revision, skip_gate)`：成果版本不符返回 `stale_artifact`；最新报告有阻断项返回 `gate_blocked`，只有作者本轮原话包含“跳过体检”之类表述时才允许 `skip_gate`。界面上章节成果新增“体检”标签（`AgentQualityReport.vue`）：阻断/疑点/提示分级、引文、改法、定位段落，状态层疑点可直接裁决（写入作者命名空间，下次不再提示）；对比视图段落数一致时可逐段还原。

### 批量连载（B6）

`src-tauri/src/agent_batch.rs`：任务记录在 `ew-agent-operations`，队列取作品目录里连续的章节（1 到 50 章）。宿主 `schedule_batch → run_batch` 每次以 `source: batch` 的用户消息启动一次运行，线程 id 为任务 id 加章节序号，检查点互不串线；一章结束后 `on_session_finished` 记录结果（阻断、疑点数、是否已写入），按审阅策略（每章停 / 每五章停 / 有疑点才停）决定继续或 `waiting`；提问、出错也会 `waiting`。“直接写入”模式由作者在对话框里选择，作为这一批的写入授权，每章仍要过质量门。界面：`AgentBatchPanel.vue` 显示进度与暂停/继续/取消，页头“连载批量”按钮打开创建对话框。

### 去 AI 味与人物口吻（B7）

质量门的高频套话规则按千字计数（A8）。编辑器划词新增“去AI味”与“按人物口吻”两项：前者用 `editor-selection.deai` 提示词只重写选区；后者先选人物，把人物资料的“语言指纹”填进 `editor-selection.voice` 模板，只改该人物的台词与心理。两项提示词都在提示词管理页可改。

### 风格档案（B8）

`src-tauri/src/agent_style.rs`：作者在记忆页确认样本章后（`confirm_samples`），累计正文达到一万字才生成风格档案（句长分布、对白比、高频短语、段落长度）存入 `ew-agent-canon`；`style_lock` 记录作者锁定的要点存入 `ew-agent-author`。上下文引擎的风格层只在有确认样本时注入，样本不足时给出提示而不是用模型猜。

### 影响报告与线索技能（B9）

`agent_canon::impact_report`：章节卡重建后与 `previousCard` 对比，列出状态变化、线索触点、伏笔兑现的差异，并检索后续章节里提到相关实体的段落作为候选清单；报告只是候选，不自动改正文。技能 `continuity-review`、`pacing-diagnosis`、`thread-ledger` 走同一份状态层数据；`de-ai` 技能对应质量门的套话与结构规则。

## 工程入口

- `src/types/agent-creation.ts`：界面与宿主共享的数据契约。
- `src/types/canon.ts`：由 `agent-runtime/export_contracts.py --ts` 生成的作品状态层类型，请勿手改。
- `src/agent/client.ts`：桌面命令和事件适配。
- `src-tauri/src/agent_host.rs`：进程、会话任务互斥、停止、事件和检查点桥接。
- `src-tauri/src/agent_service.rs`：项目、会话和受作品范围约束的工具。
- `src-tauri/src/agent_store.rs`：统一记录服务、章节事务与历史。
- `agent-runtime/worker.py`：SDK 调用和工具声明。
- `agent-runtime/contracts.py` 与 `export_contracts.py`：模型工具字段定义及共享契约导出；构建前检查漂移。
- `agent-runtime/tool_boundary.py` 与 `src-tauri/src/agent_contract.rs`：模型调用前、宿主写入前验证；格式错误交回框架循环进行有限次校正。
- `agent-runtime/tool_policies.py` 与 `src-tauri/src/agent_tool_boundary.rs`：资源类型、允许的成果类型、嵌套引用路径和操作回执归属随共享契约生成。先查精确编号，再解析该类型的存储前缀；只处理声明路径，不改正文。资源缺失、归属不匹配、写作依据失效在执行前返回结构化错误。新增 `_id`/`_ids` 字段或操作编号必须声明策略，否则契约生成失败。
- `agent-runtime/tool_results.py`：直接调用、嵌套调用和本地工具返回共用失败协议，保留候选及恢复指引；读取历史失败成果仍是成功读取。数据库、通信和协议损坏继续作为运行故障，不按文案猜测后自动重试。
- 简单创建操作在共享入口绑定工具名与参数指纹；同编号不同意图不能误用旧回执。正式写入、作者确认、可更新草案等流程由领域事务持有回执，继续核对版本与确认凭据，不套用不可变参数规则。意图记录只存指纹，不增加正文副本。
- `src-tauri/src/agent_book_plan.rs`：草案与采用事务，不把讨论选项当成对未展示内容的采用。
- `agent-runtime/checkpoints.py`：SDK 检查点到平台存储的适配；不重复实现任务调度。

开发准备：`pnpm setup:agent`。桌面构建使用 `pnpm tauri build --target <目标三元组>`，构建钩子读取 `TAURI_ENV_TARGET_TRIPLE`，分别冻结所需架构的 Agent 再构建前端。Mac 通用包使用 `--target universal-apple-darwin`，会包含 `agent/aarch64-apple-darwin/` 和 `agent/x86_64-apple-darwin/` 两套运行时。Apple Silicon 构建 Intel 运行时需要 Rosetta；Windows 在 Windows 构建。任何原生依赖架构不匹配都会失败，不生成不完整的 staging。

开发模式优先使用 `agent-runtime/.venv`；发布版按宿主架构选择包内运行时。普通用户无需安装开发用 Python。Intel Mac 单独锁定 cryptography 48.0.1，其他平台使用 50.0.2；上游从 49 起停止支持 Intel Mac，依据：[官方变更记录](https://cryptography.io/en/50.0.2/changelog/)。

## 发布候选 1.2.0（2026-10-05）

- 技能首次运行在对话中确认，可以直接查看完整文件；授权绑定当前文件指纹，变化后重新确认。停止会话会终止脚本进程组。
- `uninstall_skill` 提供受限的技能卸载，宿主核对作者点选，移出技能文件与专用依赖环境并保留恢复副本；不提供任意文件删除工具。卸载中断依据数据库回执恢复文件。
- 提示词备份包含完整技能包，恢复日志使用相同文件范围。合并导入统一重映射 Agent 身份与引用，脚本授权和未提交许可不跨备份继承。
- 启动准备未完成时后台索引不运行。失败页可打开恢复目录、选择迁移前副本；恢复前保留当前数据库和 WAL。
- 测试文件按项目约定只保留本地。`pnpm check` 执行类型、源码 lint、工具契约和 Rust 编译检查；`pnpm check:local` 运行本地完整回归，缺文件明确失败。Rust 本地用例使用 `--features local-tests`。
- 本次回归：前端 319 项、Rust 203 项、Python 132 项通过；真实模型用例未执行。两个 Mac 架构的冻结运行时通过本地模拟接口的真实进程冒烟，Intel 在 Rosetta 下运行。恢复入口与文件预览已做浏览器交互验证。
- 尚不代表正式上线验收：Windows、Intel 实机、真实旧版安装包升级/回退、真实模型完整创作流程及签名公证仍需分别验收。未发布到 Release 或更新服务。

## 此前阶段的验证记录（不代表当前发布验收）

- TypeScript 与存储回归 187 项通过。
- 49 项 Rust 常规测试与真实框架跨进程测试通过；另有显式启用的真实模型用例，常规测试不会消费模型额度。
- 使用现有默认 `deepseek-v4-flash`，分别测试源码 worker 和冻结 worker：真实读取、等待选择、新进程恢复、写入章节、回读、历史记录和检查点不含 API Key，均通过。
- 类型检查、源码 ESLint、前端构建及 Mac 验证包构建通过。
- Mac 仍锁屏，原生页面操作、关窗/完整退出交互和重启后的界面验收尚未完成。后台结果不能代替这部分验收。

```bash
pnpm exec vitest run --config verification/storage-sync/vitest.config.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib
pnpm exec vue-tsc --noEmit
pnpm exec eslint src --ext .ts,.vue
```

## 完整功能文档中仍待后续接入的部分

拆书报告成果（Agent 拆书第一期见文末）、人物关系/时间线等高级资料编辑工具、角色知情范围/剧情时间与分支、第三方 Python Skill 安装执行与沙箱、正式质量评测、引导式选择/输入框（A11）尚未完成。榜单目录、按时效获取、范围采集、两日期比较与选题卡已接入；桌面真实联网抓取尚待验收，不能用夹具或模型工具选择测试替代。当前后台会明确说明其他没有接入的工具，不生成虚假成功结果。

Windows、其他模型供应商和正式分发签名未在本轮验收。没有提交 Git 或发布应用。


## 对话与写作交付修复（2026-10-06）

- 文字中的待答选择通过结构化转换进入既有引导卡；多个独立问题使用分步卡。来源仍是本轮作者指令和助手提出的选项，不额外生成问题。
- 开书草案支持明确自然语言授权采用，仍保留版本保护。无法唯一确定采用意图时只在当前对话确认；否定或讨论不会建立作品。
- 记忆提取按作者/资料来源限制类型，并用片段编号引用原文，修复资料被当成作者决定、模型抄改引文导致保存失败的问题。失败显示处理阶段、来源数量、尝试次数和安全原因，可单独重试；成功的来源不会随其他来源一起重复提取。
- 新章只显示“正文、体检”，修订已有正文才显示“原文、修改后、对比、体检”。报告明确区分基础规则与读者评审，失败不包装成通过。
- 自动语言修订采用带来源引文的段落范围，支持合并连续问题段、去掉重复或无用分隔；越界、重叠和删除整章会被拒绝。修订后再次评审，仍有问题就保留在报告中。

本轮本地回归：前端 319、Rust 210、Python 153 项通过；类型、lint 和契约检查通过。DeepSeek flash 真实调用验证了明确采用、否定、仅选设定、模糊继续、引用命令五种情形及分步选择卡；截图章节的隔离副本完成评审、语言修订和复评；临时数据库副本中的作者决定与大纲记忆均完成了真实模型整理。原作品未被测试写入，复评仍有具体建议，不能将流程通过解释为文学质量保证。测试文件继续仅保留本地。

## Agent 拆书第一期（2026-10-06）

拆书在 Agent 里自成闭环，不依赖拆书工作台：

- **导入不等于拆书，也不弹窗**：输入框拖入或添加 TXT。`src/agent/reference-book.ts` 自动识别编码（UTF-8 / GBK / UTF-16）并分章：书头信息与目录页不算章节，正文里重复的章名照常跳过，认“正文 第X章”“楔子 / 番外”“Chapter N”，每卷重新编号不再把后几卷并进一章，超长章按段落拆成续章，没有章节标题就按约 5000 字分段。像一本书的长文本（超过 1.2 万字且识别到章节，或超过 30 万字）直接按章存进参考书库：宿主 `breakdown_import` 在一个事务里写入（格式与拆书工作台一致）并建好正文检索（本地切块，不调模型），同一份文本按 SHA-256 复用；其余作为一份资料。存放期间输入框显示“正在存放”，存完自动引用到对话。拆不拆、拆多少、是不是作者自己的书稿，都由作者在对话里说，Agent 需要确认时用引导卡在对话里问；交给模型的参考书引用带章数、已拆章数、分章提示和用法说明。
- **参考书不拆也能读**：`list_chapters`（一次最多 300 章，`from_chapter` / `to_chapter` 翻页）、`read_chapter` 读原文，`search_book` 搜原文。这几个读工具用 `allowed_source`，接受本会话引用的参考书；写作类工具仍用 `allowed_book`，参考书进不去。拆书技能改为“先读，必要时才拆”：只有要看几十上百章的节奏、钩子、伏笔统计时才 `start_breakdown`。
- **拆书任务**：`src-tauri/src/agent_breakdown_job.rs`，每本参考书一条任务记录（区间、状态、用量），进度按章节卡与 outbox 现算。作者在导入卡或进度卡上开始、暂停、继续、取消；模型用 `start_breakdown` 发起，章数超过 10 章时由宿主生成确认卡（预估 token 与耗时），按作者点选执行。
- **独立索引通道**：`agent_indexer::Lane`。参考书事件走 `__reference_indexer__` 通道，一轮 4 章、拆到没有事件为止，与作者作品的索引并行，作者自己的书不排在参考书后面；暂停的书在领取时跳过；作者暂停或取消时停掉当前进程，没写成的章节放回队列、不计失败。模型整轮失败或没有可用模型时任务标为失败并暂停，等作者点继续，不在后台把每章的三次机会耗掉。应用退出后下次启动接着拆。
- **参考书模式的章节卡**：沿用 `ChapterCard` 结构（节奏对比与案例检索不用改），提取规则精简（不记人物状态与知情范围、事实最多 5 条），宿主不再带已登记事实，线索只带最近 40 条，也不做人物状态折叠。
- **防借人物**：参考书人物按名字进实体索引，人名单 = 项目记录里的人名 + 章节卡里至少两章出现的人名（只拆了一两章时一次也算），常见称谓不算，不再依赖拆书工作台的人物关系。
- **交给模型的数据**：画像与节奏对比的逐章曲线超过 40 章时按区间汇总，避免几百章的书撑爆上下文。
- **本地资料**：不再把正文塞进引用。`material_put` 存一份（上限 30 万字，整本书走参考书导入），引用只带编号；不超过 1.2 万字整篇给模型，更长只给开头并用 `read_material` 按段读；同一份资料只在第一次引用的那一轮给正文，消息记录里不再复制正文。
- **界面**：`AgentBreakdownPanel.vue` 在对话里显示当前引用的参考书的拆书进度（已拆章数、已用 token、预计剩余时间、失败章节），拆完后可一键让 Agent 继续分析。欢迎页“拆解参考书”入口在没有参考书时直接打开文件选择。

本轮本地回归：前端 334 项、Rust 拆书与索引相关测试全部通过，类型与 lint 通过（同期进行中的写作链路改动另行回归）。拆书的真实模型评测（`test_breakdown_live.py`）已按新工具更新，需配置 `EW_AGENT_LIVE_MODEL` 后单独运行。第二期：拆完后自动生成可编辑的拆书报告成果、Agent 收到拆完通知后自动接着回答。


## 正文质量与阅读反馈

正文质量流程沿用用户配置的 writer/critic 角色，不绑定供应商，不按标点数量或 AI 检测率判定合格。

- `BeatsPlan` 可携带人物目的、视角/知情边界、场景变化、阅读期待，以及 `read_style_profile` 返回的表达示例编号。旧计划缺少这些可选字段仍可读取。
- `agent_writing_basis` 将本次文风、示例、计划与资料来源固定到候选元数据。生成、编辑评审、修订复用同一份依据；前文、资料、计划或采用的样本变化后，旧依据不能继续交付或写回。正式正文和版本历史仍只有原作品库一份主数据。
- `critic` 先执行只看正文与已公开前情的 `ReaderReadout`，由宿主按段落编号补入原文，再执行掌握任务约束的编辑核对。读者阶段不接收章纲、隐藏设定、词频线索或表达示例。
- 编辑报告区分阅读影响、返工范围与需要保留的效果。自动修订必须预留完整复评预算；越界、退步或未见实质改善时恢复改前稿，资源耗尽和处理停滞如实记录。
- 内置原创表达示例位于 `src-tauri/resources/prose-examples.json`，仅供 Agent 按任务明确选择，不默认注入；作者确认的样本可按场景选择。统计指标不自动成为作者规则。
- `agent_feedback` 保存具有来源版本的完整改稿对照。来源未知的后续正文变化不冒充人工修改；`propose_writing_preference` 只能依据当前有效对照提出本书待确认建议，不能自动生效或自动生成禁词。
- 稿件对照中的“更自然 / 更想读下去”通过 `record_reading_choice` 保存明确作者选择，并绑定候选版本与指纹。与采用率、模型模拟评价分开记录，未收集的人工耗时和盲读结果不推算。

本地质量验收使用原创场景、连续章节、正常正文保留与失败/回退案例。模型模拟读者的反馈不能代替人工审定，也不能证明所有自定义模型都有同样效果。

## Agent 拆书第二期：拆书报告与拆完自动续答（2026-10-07）

- **章节卡提取报错修复**：deepseek-v4-flash 在章节卡最后的可选字段 `storyTime` 上会写出 `"storyTime"::` 后结束，还会在中文里用未转义的英文双引号加强调，结构化结果解析失败（“ChapterCard 结构化结果无法解析（结束原因：tool_calls）”）。`structured_output.py` 在模型正常结束时做有限修复：转义正文里的英文双引号（结束引号后只能跟 `, } ] :`，对合法 JSON 不做改动）、去掉末尾只有键名的空字段，修好的结果照常过契约校验；被长度截断、值写了一半的不修。参考书章节卡不再要求 `storyTime`（`indexer.ReferenceChapterCard`）。参考书通道里整轮都只是格式问题时先继续下一轮，连续两轮才停下，提示改为说明原因与可选做法。用本机配置的 deepseek-v4-flash 重放验证：参考书与作者作品的章节卡都能正常提取。
- **拆书报告**：模型工具 `write_breakdown_report`。宿主 `breakdown_report_data` 按区间准备已拆章节的章节卡摘要（每段最多 40 章或约 1.6 万字）、覆盖情况（没拆的章节）、节奏统计、伏笔与文风数据；`breakdown_report.py` 逐段归纳（最多 4 路并行）再合并成全书结论（阶段划分、开篇、主角怎么立住、节奏与爽点、伏笔、可以学的写法、写法配方、说明），每条标章号，格式问题自动重试一次。宿主 `save_breakdown_report` 保存为 `breakdown_report` 成果（可编辑的 Markdown 附结构化内容），配方带参考书人名会被拒绝；最新一份的阶段与技巧进入书级画像，不再依赖拆书工作台。报告字段都必填、长度上限放宽，避免模型写得稍长就判失败。实测 4 章数据一份报告约 1.2–1.9 万 token。
- **拆完自动续答**：Agent 发起的拆书任务默认 `autoContinue`；参考书通道拆完时宿主在发起的会话里替作者发一轮（消息标记 `source: breakdown`，界面显示“拆书完成，自动接着分析”）。会话正在跑别的任务、在等作者回答或已暂停时不打扰，进度卡上留“让 Agent 继续分析”。确认卡问题里写明拆完会接着分析；进度卡上可以点“不用自动接着”（`breakdown_control: auto_off`）。

本轮本地回归：前端 338、Rust 235、Python 204 项通过，类型、lint 与契约检查通过。拆书报告与修复后的章节卡提取都用本机配置的真实模型验证过；`test_breakdown_live.py` 新增“要完整结论时写报告成果”评测，需配置 `EW_AGENT_LIVE_MODEL` 后运行。

## 并入主干工作区（2026-10-12）

Agent 分支（`feature/agent-creation`，worktree `easy-writing-agent`）一个月的工作全部未提交，git 层面没有可合并的提交，因此按文件搬进主干 `easy-writing` 的工作区，由作者自行决定提交；分支与其目录保留，不删。搬家前主干源码已打包备份到仓库上一级目录 `easy-writing-backup-2026-10-12.tar.gz`。

搬法：

- 只有分支有的 174 个文件直接拷入：`agent-runtime/`、`src/agent/`、`src/views/AgentCreation/`、`src-tauri/src/agent_*.rs` 与 `prompt_files.rs`、`startup_recovery.rs`、`src-tauri/resources/skills/`、打包与检查脚本、两份 Agent 文档。
- 两边都改过的已跟踪文件以分叉点 `f1c18b0` 为基线做三方合并：18 个只有分支改过的直接取分支版，21 个自动合并干净，32 个手工解冲突。手工解法的原则是主干的存储升级（统一存储、旧数据模式、恢复重启）为准，Agent 的能力叠加上去。
- 16 个两边都"新建"的文件（`desktop_storage.rs`、`storage_migration.rs`、`full-backup-idb.ts`、`desktop-records.ts`、`bootstrap.ts` 等）分支副本比主干旧，不能三方合并；以主干版本为准，只搬 Agent 相关改动：索引器建表钩子、`desktop_store_keys` 命令与 `keys_at`、恢复时的技能记录整理（`skill_ids`）、`compare_record_at`、未知表检查放行 `agent_outbox / chapter_chunks / canon_entities / chapter_fts*`、启动时 `startup_recovery::recover_at`、备份清单里五个 Agent 命名空间与合并换号规则、启动时安装榜单执行器与 `agent-book-changed` 监听。
- 模型分组合成一张表：`AI_MODEL_GROUPS` 同时含主干的 `embedding / background / weixin` 与分支的四个 Agent 角色，回退链写在表里；模型管理页沿用主干的槽位界面，Agent 四个角色进"进阶"组，空选项按回退链显示"跟随 X"。`useAiModelStore` 同时提供主干的 `effectiveModelCode` 与分支的 `ensureGroupModel / selectedModelCode / modelsFor`。
- 打字补全同时带主干的人物与备忘上下文和 Agent 的 `contextBlocks`；工作流写作同时带"作者备忘"与"作品状态（来自记忆索引）"。两处接缝的归一是全平台方案第 5 步的事，这里只保证共存。
- 测试文件按约定不进 git，从分支目录手工拷入；两边都有的 13 个测试以主干为准并补入分支新增的用例；`node:sqlite` 的 `run()` 结果映射成 `rowsAffected` 以匹配真实插件。

没有搬的：

- 分支的迁移失败恢复界面（`migration-screen.ts` 的快照列表与恢复按钮）。主干已有自己的旧数据重试流程，Rust 侧 `desktop_startup_recovery` 命令保留、未接界面。
- `experiments/agent-runtime/`（478MB，早期探针，无引用）。
- `agent_rank_bridge` 之外的旧 `query_rank / rank_trends` 路径照旧，真实榜单用例未按工具桥更新（见下）。

本次回归（主干工作区）：

- 类型检查、ESLint（0 错误）、契约一致性检查、Vite 构建通过。
- 前端 581 通过、1 跳过；Rust 270 通过、9 个真模型用例按需运行；Python 离线 222 通过、54 跳过。
- 真模型（DeepSeek flash，Key 取自开发库模型设置，不经日志）：
  - Python 54 个真模型用例 42 通过、12 失败，失败全部是模型行为与用例预期不符（先问问卷而不先给方向、调用 `list_writing_profiles` 而不是 `plan_short_story`、结构化输出多次不合格触发 `ToolCorrectionLimit`、简介未经 `save_book_intro` 落成候选等），Python 代码与分支逐字节相同，属评测与技能待调，不是搬家引入。
  - Rust 9 个：`agent_live_model_read_wait_resume_save`、七猫真实接口、规则集回放（`EW_RULESET_REPLAY_DIR=verification/ruleset-recovery-20261007`）通过；`creates_book_materials_and_first_chapter` 与 `memory_rejection_and_new_session_continuation` 失败在 `waiting == true`，模型选择了向作者提问；榜单真实用例失败在"工具尚未接入"，该用例写于只有 `query_rank` 的时期，分支后来把榜单目录与按时效获取改经前端工具桥，无界面测试里桥不存在，用例需要重写；参考书浏览器夹具、记忆重试快照、交付快照三个用例需要当时的隔离快照，本机没有。
- 冻结运行时沿用分支 10 月 5 日的二进制（两架构）；源码已比它新，需要打包时重新冻结。

## 模型网关与轨迹账本（2026-10-12，全平台方案第 2 步）

**模型网关**（`src-tauri/src/model_gateway.rs`、`model_gateway_providers.rs`）：只监听 127.0.0.1、端口随机、口令随机的 OpenAI 兼容端点，应用启动时随数据目录起一个（`model_gateway::endpoint(root)`，测试夹具各起各的）。worker 的载荷里模型只剩引用：`{id, name, modelCode, provider, thinking, maxContext, maxOutputTokens, gateway:{baseUrl, token}}`，没有 Key、供应商地址和额外参数（`model_gateway::worker_model`）。worker 把 `model` 填成模型记录编号、`api_key` 填网关口令，`X-EW-Scene` 头带角色场景码（`agent_planner / agent_writer / agent_critic / agent_indexer`）；每个角色各一个模型实例，同一模型也分开建，账本才能按角色分。

网关做的事：按编号从模型设置取供应商配置；按供应商差异表改写请求（思考参数、DeepSeek 开启思考时 `required` 降为 `auto`、OpenAI 官方的 `max_completion_tokens` 与推理模型不传温度、非流式最少 2048 输出、千问非流式关思考、额外参数最后合并但其中的输出上限不生效，输出上限只由 worker 的上下文预算决定）；连接失败、429、5xx 在未开始回传前重试两次（0.5 秒、1.5 秒退避）；连接 60 秒、分片间空闲 90 秒超时；流式逐字节透传，旁路累计正文、工具调用与用量；供应商失败翻译成中文并保留原始状态码（`{"error":{"message","type","code"}}`，HTTP 状态与上游一致）。差异表与 `src/utils/local-ai-client.ts` 的那份内容一致，直接场景本期仍用 TS 那份直连；它们改走网关时只需把模型地址指向网关。

**轨迹账本**（`src-tauri/src/ai_trace.rs`）：网关每次调用写一条进前端已有的"AI 调用记录"账本（`ew-local-ai-records/records`，同一记录形状：`scene / sceneLabel / modelCode（模型记录编号） / modelName / status / input / output / inputTokens / outputTokens / duration / errorMsg / createTime`，负数 id 与前端同一取值空间，各留 2000 字，只留最近 1000 条）。AI 调用记录页不改就能看到 Agent 四个角色的调用；运行、工具调用、审批、投递的记录后续并入同一账本。

**Python 侧**：`worker.make_model(config, role)` 只认带 `gateway` 的配置，直连配置直接报错；供应商分支与额外参数校验删除。评测夹具 `tests/live_harness.direct_model / direct_role_models / make_live_model` 在没有宿主的测试进程里直连供应商（不复制差异表，按模型默认思考模式跑）；评测用例的脚本模型改在 `live_harness.make_live_model` 打桩。

**验证**：`model_gateway_tests.rs` 用假上游验证差异表改写、流式透传、错误翻译、重试、落账与载荷不含凭据（8 项）；Rust 278、Python 222、前端 581 通过；真实模型用例 `agent_live_model_read_wait_resume_save` 经网关跑通（DeepSeek flash，19.6 秒：读取、等待选择、新进程恢复、明确写入目标、章节版本 0→1；检查点里没有 Key）。

**未做**：回退链（等模型分组表有界面）、`/v1/embeddings`、直接场景改走网关、按运行汇总的账本视图。

## 事件汇、常驻 worker、错误日志、收件箱（2026-10-13，全平台方案第 3 步）

**事件汇**（`src-tauri/src/agent_events.rs`）：宿主发事件只经 `agent_events::emit(app, name, payload)`；它先给进程内订阅者（`subscribe`，句柄丢弃即退订；将来微信适配器、测试在这里接），再转给窗口。`publish` 用于无窗口场景。`agent_host / agent_batch / agent_rank_bridge` 里原来的 `app.emit` 全部改走这里；榜单桥面向主窗口的 `emit_to` 保持原样。

**常驻 worker**（`src-tauri/src/agent_worker_pool.rs`）：Agent 进程按会话常驻。`acquire(key, log_dir, command)` 取池里活着的进程或新起一个；`run_turn` 写一行载荷、读事件直到本轮的 `done / failed`，RPC 行交回调处理并写回；`release` 放回池里，空闲 10 分钟由回收线程收掉；`discard / kill / kill_all` 用于崩溃、作者停止与应用退出（退出不留孤儿进程）。`agent_host::execute` 改为调池：本轮结束进程留着等下一轮，不再每条消息起一个进程；索引器仍一次一进程。

**错误日志**：worker 与索引器的标准错误输出逐行写进数据目录 `logs/agent-worker.log`（带时间、会话键、进程号；超过 5MB 轮转为 `.log.1`），每个进程最近 30 行留在内存。没等到结束事件进程就断时，错误信息是"Agent 进程中断，可从已保存的检查点继续。后台最后的输出：…"，不再只有一句"进程中断"。worker 自己没有 Key（经网关），日志里不会出现凭据。

**Python 侧**：`worker.main()` 改成一行一轮的常驻循环：`run_once(payload)` 跑一轮，异常只结束这一轮（发 `failed` 事件），`reset_runtime()` 清进程内状态后等下一轮；读到 EOF 退出；索引任务仍一次一进程。评测夹具 `live_worker` 收到 `done / failed` 即停，关输入让进程收尾。

**收件箱**：会话运行中再来的消息不再被拒绝：`agent_host::start` 碰到"已有任务"时把消息进 `pendingInputs`（与界面的 `queue_message` 同一条路），worker 在下一个落点经 `steering` 读到；本轮结束时收件箱里还有剩余（状态 `paused`）且不是作者主动停止的，宿主自动以 `continue` 续跑，不等作者再点。作者主动停止的仍停在 `paused`。

**验证**：`agent_events_tests.rs`（订阅、退订、多订阅者）、`agent_worker_pool_tests.rs`（同一进程多轮与 RPC 应答、failed 不杀进程、崩溃带出错误输出并落日志、停止与空闲回收），用 `agent-runtime/tests/fixture_resident_worker.py` 当假 worker。 本轮回归：Rust 284 通过（含新增 6 项）、Python 222 通过；真实模型用例 `agent_live_model_read_wait_resume_save` 经常驻协议与网关通过（DeepSeek flash，18.5 秒）。

## 一份作品真相：状态层吸收主干事实表与本书备忘（2026-10-13，全平台方案第 4 步）

**原则**：书里的情况与作者的规矩只有一份。派生数据在作品状态层（章节卡、线索账本、折叠状态），作者数据在作者区（规则、确认/否决标记）与作品记忆（决定、偏好）。主干的 `ai_facts / ai_fact_index / ai_chunks / ai_chunks_fts / ai_chapter_index / ai_embeddings` 表与 `ai_facts.rs / ai_index.rs` 模块、前端自己的事实抽取（`src/ai/facts/`）退役。

**统一视图**（`src-tauri/src/agent_story.rs`，经 `canon_query` 的 `story / notes / search` 视图读）：
- `story`：把章节卡里的状态变化（字段 relation 记为关系）、事件、事实和线索账本（开放=伏笔、已回收=回收、已放弃=否决）摊成一张记录表，每条有稳定键（`state:章:人物:字段:顺序`、`event:章:事件`、`fact:章:事实`、`thread:线索`）、章节与目录顺序、主体/谓语/宾语/原文引文/置信度，附作者标记；另给目录顺序、统计与索引进度。
- 作者标记 `canon_mark`（`agent_canon::set_mark`，作者区 `mark:书:键`）：否决的状态变化在 `fold_states` 里跳过，折叠结果立即不含它；否决的线索按"作者否决"标为已放弃，恢复时只撤我们打的这条标记。
- `notes`：作者规则（规则集的 `rule:book:*`，类别默认"结构"）+ 作品记忆里 `kind=decision、scope=book、status=active` 的记录，类别"作者偏好"显示为偏好、其余为决定；`add_note / delete_note` 对应落规则或记忆。偏好等第 8 步作者层记忆建好后再挪。
- `search`：状态层全文索引（三字以上 FTS、短词 LIKE），命中按目录顺序、段落顺序给出，可限定截至某章。

**迁移与退役**（`agent_story::retire_legacy_ai`，每次连接时若旧表还在就做一次）：`ai_facts` 里作者确认过的事实搬进作品记忆（决定，类别"作者确认的事实"，带引文），作品已删除的跳过；然后删旧表与 `ai-index-schema` 标记，作者区记 `legacy-ai-retired`。前端旧命名空间里的本书备忘在首次打开该书时经 `import_legacy_notes` 迁一次（作者区记 `legacy-notes-imported:书`）。开发库在本步代码进入运行中的开发版时已完成退役：已确认事实 0 条，无需迁移；自动抽取的旧事实由索引器按章节卡重建。

**前端只换数据源**：`src/storage/ai-facts.ts`、`ai-notes.ts`、`ai-index.ts` 改为读宿主的门面，函数名不变，妙笔、补全、工作流生文、起稿核对、微信工具一处不改。`aiFactsSetStatus` 多了作品编号参数，记录 id 改为字符串键；`aiFactsRebuild / aiFactsSetAuto / aiFactsStop` 驱动索引器（`index_rebuild` 支持按章作废重提、`index_control` 暂停、停止索引任务）。故事状态页沿用原界面，进度改读索引进度，"重新整理本章 / 整理未处理的章 / 停止 / 停笔后自动整理"改成驱动索引器，订阅 `agent-canon-changed` 自动刷新。正文保存不再由前端触发索引（outbox 触发器负责）；`aiIndexBook`（妙笔、微信检索前的追赶）改为把没有章节卡的旧章交给索引器补，索引器需要一个文本模型，每章会调用一次索引角色的模型提取章节卡。`src/ai/index/embeddings.ts` 留作占位：主干的向量层没有调用方真正启用，语义检索返回不可用，调用方只用关键词结果；等索引角色经网关补向量时作为检索第四层接入。

**验证**：`agent_story_tests.rs`（视图记录与标记驱动折叠和线索、备忘三类往返与旧备忘导入、旧表退役迁移、检索按目录序与截至章）；前端 `tests/ai-facts.test.ts`、`tests/ai-notes.test.ts` 改成对门面（筛选、截至章、标记与整理命令、缓存、旧备忘只迁一次、备忘文本预算）。Rust 283、前端 580、Python 222 通过；类型检查、ESLint 通过。

## 微信成为 Agent 的一个通道：通道档案与微信适配器（2026-10-13，全平台方案第 5 步前半）

**原则**：Agent 板块、妙笔、微信是同一套会话的三个视图。微信不再有自己的一套工具循环、工具清单、登记确认与提示词，而是一条"通道"：向宿主声明自己能显示什么（纯文本、单条 1800 字、不流式、引导卡渲染成编号）、能发什么（文件、图片）、默认审批（写操作一律确认卡，决策 D4）。

**通道档案**（`src-tauri/src/agent_channel.rs`）：`profile(kind)` 给 `desktop / weixin` 两类默认值；`normalize` 校验入口传来的档案（可只给类型名，也可带覆盖字段 label / maxChars / maxOptions / canSendFile / canSendImage / approval，其余字段按类型固定，未知类型拒绝）；`of_session` 读会话里的档案，旧会话按桌面处理。`create_session / update_session` 接受 `channel`；`agent_host::prepare_run` 把档案放进载荷的 `channel`；worker 的 `channel_rules(profile)` 据此在系统提示末尾加通道段（纯文本不写 Markdown、单条字数、选项上限、文件/图片能力、写操作必经确认卡）。微信会话键固定：`create_session {requestId:'weixin:main', channel:'weixin'}`，同键复用同一会话；`/清空` 把 `app-settings/ew-weixin-agent-session-epoch` 加一，下一条消息开新会话。宿主新增只读动作 `get_session {id}`、`get_artifact {id}`（`agent_service.rs`；`src/agent/client.ts` 的只读列表）。

**微信适配器**（`src/ai/channels/weixin/channel.ts` 重写）：保留收消息队列、泵、回复、发媒体、输入状态、日志、命令；核心从"自己跑 runAssistant 工具循环"换成"把消息交给宿主会话、等本轮结束、把宿主的话与卡片翻译成微信文本"：
- 普通消息 → `run {inputKind:'message'}`，带当前作品引用与微信模型（`ensureGroupModel('weixin')`）。
- 宿主出引导卡 / 确认卡（会话状态 `choice`、消息 `kind:'choice'` 且 `status:'pending'`）→ `renderCard` 渲染成编号文本：单选"回复编号选择"，多选"可回复多个编号"，确认卡"回复 1 确认，回复 2 ……；也可以直接回复「确认」或「取消」"，分步卡按步编号、可不答的步标出。作者下一条消息经 `parseCardAnswer` 解析（编号、多编号、确认/取消词、默认项配合"好"、允许自由回答时文字即答案；编号越界或格式不对只提示并重发卡片，不交回宿主）→ `run {inputKind:'answer', messageId, answer, choiceId}`。
- 等待：`waitForSettled` 轮询 `get_session`（`agent-session` 事件唤醒，10 分钟超时，`paused` 且有 `pendingInputs` 视为仍在跑）。
- 本轮结束：这一轮的 assistant 消息按 maxChars 切条发出，失败说原因；章节 / 短篇 / 草稿成果经 `get_artifact` 取出，先发开头预览再发 `.txt` 文件（遵守设置里的"允许发文件/图"），对比卡成果作为文件发出。
- 命令不经宿主：`/帮助 /作品 /作品 N /状态 /清空`；`/作品 N` 同时 `update_session` 改会话引用。

**退役**：`src/ai/channels/weixin/guard.ts`（微信侧写权限守卫）、`src/ai/tools/weixin-pending-tools.ts`（登记确认）及两份测试；写操作确认改由宿主的确认卡承担。`weixin-tools.ts` 等微信专用工具集、`weixin / weixin-writer` 提示词文件在后半（工具桥泛化与对等工具）随之退役，设置页"执行开关"届时改成通道审批。

**验证**：`agent_channel_tests.rs`（档案默认与覆盖校验；会话携带档案与稳定键、载荷携带、get_session / get_artifact）、`agent-runtime/tests/test_channel_rules.py`、`tests/weixin-channel.test.ts` 重写（命令直答、普通消息进宿主、引导卡编号往返、确认卡"确认 / 取消"与越界提示、失败告知、章节预览加文件、/清空换键、卡片渲染与作答解析）。Rust 285、前端 558（删去守卫与登记确认的旧测试）、Python 225；类型检查、ESLint、契约检查通过。待在真微信核对：写一章、改规矩、新建作品、删章四条流程，写操作必须先出现确认卡。

## 工具桥泛化与对等工具：微信能做的事由同一个 Agent 做（2026-10-13，全平台方案第 5 步后半之一）

**对照结论**：老微信工具集里，榜单读取 / 趋势 / 抓取（`list_rank_sources / get_rank / get_rank_collection / query_rank / rank_trends`，抓取就是 `get_rank` 的 latest）、新建作品（开书草案与采用）、候选书名（`save_name_candidates`）、新建卷章、大纲增改（`save_material` 的 outline）、续写改稿（`draft_chapter / polish_draft / save_chapter`）在 Agent 里已有对等工具，不重复加。真正补的是三类：作品管理、只能在网页层做的事、审批门。

**网页桥**（`src-tauri/src/agent_webview_bridge.rs`，从榜单桥抽出）：宿主把只能在应用网页层完成的调用发给主窗口的执行器（事件 `agent-webview-request / agent-webview-cancel`，命令 `webview_executor_ready / complete / progress`），等它按同一编号回传；只接受本地主窗口注册与回传，旧执行器、任务停止后的迟到结果拒绝；进度只认总数不变且前进的更新。`agent_rank_bridge.rs` 只留榜单自己的规则（大范围联网前的作者确认、同范围沿用、成功结果回执），传输交给网页桥。经网页桥执行的新工具：`list_inspirations / add_inspiration`（灵感便签存在前端设置缓存里，宿主直接写会和前端缓存打架）、`writing_stats`（码字统计同理）、`send_chapter_file`（宿主按目录与正文拼好 txt，网页层编码后发到微信对话）、`send_rank_chart`（网页层按本机快照算标签趋势、echarts 画图、发图）。发文件、发图两个工具只给声明了 `canSendFile / canSendImage` 的入口（worker 的 `tools_for_channel`），宿主再核一次通道能力。前端 `src/agent/webview-executor.ts` 替代 `rank-executor.ts`，`weixin-chart.ts` 搬到 `src/agent/rank-chart.ts`，base64 与文件名处理在 `src/agent/media.ts`；微信适配器导出 `sendWeixinMedia`，把 Agent 中途要发的文件、图片发到正在处理的那条消息所在的对话。

**作品管理**（`src-tauri/src/agent_library.rs`）：`list_books`（书架未删除作品，最近编辑在前，可按书名 / 分类筛）、`open_book`（把一本书带进对话：加入会话引用、作为上下文作品；只是打开，不授予写权限，工具契约里它的 `book_id` 是 `library_book` 资源，不要求已在会话范围内）、`update_volume / update_chapter / update_book`（改卷名简介、章名章纲、书名简介分类标签；属于正式写入，要先 `select_write_target`）、`delete_volume / delete_chapter / delete_book`（与书架同一种软删除：`deletedAt` 列与 payload 同步，卷连同卷内章节，书的字数章数按未删除章节重算，前端字数缓存一并失效；删书后会话不再引用它、不再当上下文与写入目标）。写操作按操作编号留回执，重复调用返回同一结果、参数不同拒绝。宿主执行闭包在 `updated / deleted` 时也发 `agent-book-changed`，书架与写作台照旧刷新。微信适配器每轮结束后按会话引用同步本地"当前作品"：新带进来的书成为当前作品，当前书被删出引用就换成剩下的或清空。

**审批门**（`src-tauri/src/agent_approval.rs`，决策 D4）：三条删除在任何入口都先问作者；`approval=always` 的入口（微信）对作品数据的写入（`save_chapter / create_volume / create_chapter / apply_creation_artifact / save_material(draft=false) / update_* / add_inspiration / book_plan_adopt_begin`）也先问。确认卡由宿主生成，问题写明真实对象与后果（"删除《异能账本》第3章《夜袭》（1200 字，进回收站，桌面端可恢复）？"），作者点选由宿主按选项标题核对：点"确认"放行（同一操作 30 分钟内重试不再问），点"取消"返回 `declined`（不是工具错误，模型据此停手），打字回别的返回 `not_confirmed` 并带原话；旧卡没作答就被新消息顶掉时换新卡重问。worker 侧 `confirmed_call` 统一处理：宿主返回 `confirmation_required` 就 `interrupt` 暂停，作者点选后工具从头再跑、第一次调用即按点选结果放行或拒绝；系统提示与通道段都告诉模型"平台会自动弹确认卡，你不用先问一遍"。资料候选（draft）不是写入，不问。

**契约**：`tool_policies.py` 新增 `TOOL_RESOURCES`（按工具覆盖字段的资源类型）与作品管理 / 通道工具的回执归属（domain）；Rust 边界新增 `library_book` 资源（任何未删除的作品，找不到时建议 `list_books`）。`tool-contracts.json` 与 `src/types/canon.ts` 重新生成。

**验证**：`agent_library_tests.rs`（列作品与打开、改卷章与作品信息、重复操作编号、软删除与统计重算、删书后会话清理）、`agent_approval_tests.rs`（微信入口建卷先问后做、旧卡未答换新卡、同编号回执、资料候选不问而正式保存问；桌面入口建卷直做而删除先问、取消与打字都不放行且取消只作用一次；规则表）、`agent_webview_bridge` 单元（执行器重载与迟到回传、进度校验、文件名与字数）、`agent_rank_bridge` 单元；Python `test_channel_tools.py`（确认包装暂停重跑、旧式 choices 兜底、按通道过滤发文件发图工具、新工具按契约名调宿主、通道段文案）；前端 `tests/webview-executor.test.ts`（榜单三件、取消与旧执行器、失败形状、发章节文件编码与去处、趋势图有图无图、灵感与统计）、`tests/weixin-channel.test.ts`（当前作品跟着会话引用换与清空、打字等于选项标题即点选）。Rust 291、前端 562、Python 230；类型检查、ESLint、契约检查通过。真实模型（DeepSeek flash，24.5 秒）：微信通道会话里说"把第1章删掉"，模型直接调 `delete_chapter`，宿主弹确认卡（这一轮停在 `choice`，章还在），按微信适配器的作答形状点"确认"后恢复，章进回收站，模型回复"第1章已删除（移入回收站，桌面端可以恢复）"。

## 微信旧工具循环退役（2026-10-13，全平台方案第 5 步收尾）

**删除**：`src/ai/tools/weixin-tools.ts`（榜单 / 作品 / 灵感 / 候选书名工具与微信工具汇总）、`weixin-library-tools.ts`（卷章与资料增删改 + 确认后的执行器）、`weixin-writer-tools.ts`（续写 / 改稿两段确认）、`weixin-media-tools.ts`（发章节文件）及四份测试；`src/config/ai-prompts.ts` 里微信助手的两段组装器（人设 / 查阅规则 / 灵感方法 + 续写 / 改稿）；提示词组 `weixin`、`weixin-writer`（`src/config/prompts/defaults-weixin.ts` 与注册表项、`legacy-defaults.ts` 里这两组的旧版指纹）。这些能力现在全部由同一个 Agent 的工具承担（见上一节）。用户目录 `Documents/易创提示词/` 里已生成的「微信助手」「微信助手·续写改稿」两个 md 文件不再被读取、不会被删（装载器只认注册表里的组），设置中心的提示词库里也不再出现。

**保留并收窄**：`src/storage/local-weixin-bot.ts` 只剩偏好（全部开启，通道层只看 allowMediaSend / allowProactivePush）、会话（作者在微信里选的"当前作品"与旧版对话记忆字段）、通知队列；待确认操作、了结记录、本轮工具结果等类型与函数随旧工具循环一起退役。`src/ai/channels/weixin/notify.ts`、`WeixinBotPane.vue` 不受影响；设置页本来就没有"执行开关"界面，无需改。`tests/weixin-prompt-upgrade.test.ts` 改为 `tests/prompt-default-upgrade.test.ts`：只验证两组已退役与通用的"默认值已更新"行为。

**顺带发现（未动）**：`miaobi.plotAdvisor` 现行默认文本的指纹仍登记在旧版指纹表里（`legacy-defaults.ts`），按规则本应只登记改前的指纹；现状下未改过的该段会被"升级"成同一段文字，无害，但如果以后再改这段默认值、忘了登记，这个重复会掩盖问题。

**验证**：类型检查、ESLint 通过；前端 523 通过、1 跳过（删去四组旧工具测试与微信提示词升级测试共 40 项）；Rust 291、Python 230 不受本节影响；源码与测试里不再有对已删模块的引用。

## 微信回复慢的排查与两处修复（2026-10-13）

**现象**：微信里发"你好"34.9 秒才回，第二句 54.9 秒。微信通道日志里收发都是即时的，时间全在 Agent 这一轮；模型调用账本给出分解：首条消息先拉起 Python 后台（约 6 秒，之后常驻），每次规划调用输入约 3 万 token、耗时 23 到 25 秒，每轮还夹一次失败的记忆整理（HTTP 400）。三个原因：微信回答模型是 deepseek-v4-pro 且开了思考（每次先推理）；每次调用都带全部 83 个工具的定义（参数定义约 6.9 万字符、说明 1.3 万字符）；索引角色没单独配置时跟着规划模型用了思考型模型，结构化提取指定函数名的 `tool_choice` 被 DeepSeek 思考模式拒绝，记忆一条都没存下来（会话里 `memoryWarning` 已标"部分记忆整理失败"，微信端看不到）。

**修复一·网关**（`model_gateway_providers.rs::adapt_request`）：不支持强制工具调用的供应商（DeepSeek 开思考）上，`tool_choice` 的两种"必须调用"写法（字符串 `required`、指定函数的对象）都降成 `auto`，与前端 `local-ai-client.ts` 的规则对齐；`none` 与不思考、其他供应商原样下发。单元测试 `deepseek_thinking_downgrades_every_forced_tool_choice_to_auto`。

**修复二·角色回退链**（`agent_service::model_config / support_model`，`agent_host::prepare_run`，前端 `AI_MODEL_GROUPS`）：写作仍跟规划模型（正文质量一致）；评审与索引调用多、要结构化输出，没单独配置时改为先跟写作助手（`text_assist`），再没有才跟规划偏好、最后跟本轮规划模型。作者在输入框指定的模型仍只决定规划角色。独立运行的索引器（章节卡）走同一条链。测试 `agent_writer_follows_the_planner_while_critic_and_indexer_prefer_text_assist`。

**验证**：Rust 292 通过；前端类型检查与模型分组测试通过。真实模型：把思考型 deepseek-v4-pro 作为唯一模型跑微信删章确认流，记忆整理不再报错（`memoryWarning` 为空），全程 25.4 秒。

**未做（已告知作者）**：微信回答模型本身仍是思考型，单次 20 多秒要靠作者换成 flash；每次调用带 3 万 token 工具定义的问题要按领域分批披露工具，另行排期。

## 工具分组披露：每次模型调用只带用得上的工具（2026-10-13）

**问题**：工具有 84 个，参数定义加说明约 8.3 万字符，每次模型调用都整本带上（约 3 万 token），慢且贵，与模型是否思考无关。

**做法**（`agent-runtime/toolsets.py`）：工具分成常用组（问作者、读作品、看成果、带书进对话、打开工具组等 18 个）与八个领域组：榜单与选题 rank、开书与资料 plan、写作与改稿 write、卷章与作品信息 catalog、故事状态与规矩 story、拆书与仿书 breakdown、技能管理 skills、灵感与统计 notes。`ToolsetMiddleware` 在每次模型调用前把工具清单裁成"常用组 + 框架自带 + 已打开的组"，工具节点仍登记全部工具；`open_toolset(domains)` 由模型自己调用，打开状态存在会话状态 `toolsets` 里（只增不减，随检查点跨轮保留），返回里按本次入口能力列出该组工具与一句话说明。系统提示加"工具分组"一节列出组名与一句话，模型据此决定先开哪组；分组是静态表，不按作者措辞猜。`open_toolset` 只在进程内起作用，不进宿主契约（`worker.LOCAL_TOOLS`）。

**效果**：只带常用组 18 个工具、1.3 万字符；常用加写作 33 个、3.6 万字符；常用加写作加卷章 41 个、4.1 万字符；对比全部 84 个、8.3 万字符。真实模型：微信删章确认流（模型先开 catalog 组再删）从 24.5 秒降到 10.6 秒；读取、等待选择、恢复、保存正文的流程 25.3 秒通过。

**验证**：`agent-runtime/tests/test_toolsets.py`（分组表覆盖全部工具且不重叠、可见工具规则、打开工具按入口列清单、假模型走通"先开组再调用"并跨轮保留）；Python 234 通过；契约检查、前端类型检查通过。`AgentConversation.vue` 补了新工具的执行中文案。`AGENT_GUIDE.md` 记了新增工具必须归组的规则。

## 妙笔成为 Agent 的编辑器侧视图（2026-10-13，全平台方案第 7 步）

**原则**：妙笔不再是第二个大脑。旧面板 `AiChatPanel.vue`（1525 行）自带会话存储、提示词拼装与 TS 工具循环（12 个只读工具）；现在它只是 Agent 板块那条作品会话在编辑器侧的视图，渲染与输入复用板块的同一套组件。

**会话**：按书取或建，键 `book:<bookId>`（作者点"新对话"时加编号 `book:<bookId>:<n>`，旧会话留在 Agent 板块里），标题《书名》，引用带这本书；通道档案 `{kind: desktop, label: 妙笔, approval: always}`，所以作品写入在面板内一律先出确认卡（决策 D3），系统提示的通道段只加这一句。当前章作为 `chapter` 引用随作者换章而换（`useMiaobiSession.syncAnchor`）；编辑器"添加到妙笔"的选区从 `ai-chat` 选区队列变成 `selection` 引用，正文随引用带给宿主。

**面板**（`src/views/Writing/components/MiaobiPanel.vue` + `composables/useMiaobiSession.ts`）：头部（新对话、展开、关闭）；对话、输入框、引导卡与确认卡、成果面板（采用与撤销）都是 `AgentCreation/components` 里的 `AgentConversation / AgentComposer / AgentDocument / AgentPromptCard`，绑定同一个 `useAgentWorkspace` 仓库（新增 `openBookSession`，已就绪时不重读工作区）；空态给四个快捷问题。窄侧栏下用变量把内容最小宽度归零、成果面板占满；`.miaobi-panel` 加进板块样式的变量作用域。正文写入后宿主发 `agent-book-changed`，编辑器照旧刷新。

**退役**：`AiChatPanel.vue`；TS 工具循环 `src/ai/runtime/loop.ts`、`runtime/tools.ts`、`src/ai/tools/book-tools.ts`、`fact-tools.ts` 及四份测试与评估集夹具（`tests/ai-eval.test.ts`、`ai-book-tools*.test.ts`、`ai-tool-loop.test.ts`、`fixtures/ai-eval-cases.json`）；`ai-prompts.ts` 的 `buildMiaobiMessages`；提示词组 `miaobi`（人设、查阅规则、四个顾问模式）。`local-ai-client.ts` 的 tools 支持保留给直接场景。`src/ai/` 里剩下的 `verify/consistency.ts`（续写与工作流写章的校验）、`memory/style.ts`（续写文风范例）、`book/chapters.ts`（故事状态页）属于直接场景，按 D8 不动。

**没迁的**：旧妙笔的对话记录（`local-ai-chat.ts`，数据与测试都保留）不迁进宿主会话、也不显示；四个"顾问模式"不再保留为提示词开关，改用输入框 `$` 选技能（卡文救援、节奏诊断、连续性审查、新书期包装等已覆盖这些场景）——两条都是我定的，待作者拍板。用户目录里的「妙笔对话」md 文件不再读取也不删。

**验证**：`tests/miaobi-session.test.ts`（按书取或建、通道档案、当前章锚点随换章而换与清空、选区进引用并清空队列、新对话换键且旧会话还在、换书换会话）；`tests/prompt-default-upgrade.test.ts`、`local-prompts.test.ts` 改用其他组；前端 489 通过、1 跳过；Python 235（通道段新增桌面入口确认一句）；类型检查、ESLint 通过；Rust 不变。真实模型：作品会话里要求"直接写并保存到正文"，宿主先弹确认卡（正文版本仍为 0），点"确认"后版本 0→1，两轮 62 秒。

**待作者在开发版核对**：写作台右栏"妙笔"打开后能看到对话与输入框；让它写一章并保存，面板里应先出确认卡；成果面板里"采用 / 撤销"生效且编辑器刷新；换章后引用随之变化；Agent 板块里能看到同一条《书名》会话。

### 旧版妙笔的对话记录（2026-10-13，作者定：照常显示、只读、提问时提示开新对话）

旧记录存在前端记录库 `ew-local-ai-chat`（`local-ai-chat.ts`，数据与测试保留，不删）。`src/agent/legacy-chats.ts` 把它们搬进宿主会话：每本书只搬一次（设置项 `ew-miaobi-legacy-imported:<bookId>`），宿主 `import_legacy_chats` 按旧对话编号去重（`session:miaobi-legacy:<旧编号>`），空对话和空白消息丢掉，`ai` 映射成 `assistant`，保留原来的时间，会话带 `legacy: "miaobi"` 标记、引用这本书。查阅步骤与依据不搬（新会话没有对应形态）。触发点：进 Agent 板块时后台把书架上每本书搬一遍，打开妙笔面板时先搬当前这本。

**只读**：宿主 `prepare_run` 对带 `legacy` 的会话拒绝运行（"旧版妙笔的对话记录，只能查看；要接着聊请开新对话"）；Agent 板块侧栏标"旧版妙笔"，输入框位置换成一句提示加"开新对话"；妙笔面板头部多了"这本书的对话"列表（作品会话与旧版记录，最近的在前），切到旧记录时同样只读并给"开新对话"。

**2026-10-14 作者定**：旧版记录只在妙笔面板「这本书的对话」里列出；Agent 板块的侧栏、搜索会话、最近任务都不收带 `legacy` 的会话（`index.vue` 的 `boardConversations`）。记录仍在会话库里，妙笔面板照常能看。

**验证**：Rust `agent_library_tests::legacy_miaobi_chats_become_read_only_sessions_once`（只搬一次、空对话不搬、角色映射、时间保留、运行被拒）；前端 `tests/legacy-chats.test.ts`（整段交给宿主、按书记标记、宿主报错不记标记、全书架循环单本失败不影响其他书）、`tests/miaobi-session.test.ts`（打开时搬当前书）。Rust 293、前端 492、Python 235；类型检查、ESLint 通过。

## 记忆补课：作者层、溯源与遗忘、进索引、会话压缩、工作备注（2026-10-13，全平台方案第 8 步）

借 OpenClaw 的记忆模型把宿主记忆补齐成五块，全部落在 Rust 宿主与 Python 运行时，不加新进程。

**8a 作者层记忆。** 记忆多了 `scope`（book / author）。作者在对话里说的"以后所有书都…"由记忆整理记成 `scope=author`、类别"作者偏好"、`bookId` 为空的记录，只能来自作者原话（`record_book_memory(scope="author")` 要求 `source_ref.type=author`）；作者层记录对每本书的上下文固定层都生效（`agent_context` 的"作者偏好（对所有作品生效）"块，来源类型 `author-memory`），作品备忘页每本书都显示。旧的书级"作者偏好"记忆在 `retire_legacy_ai` 之后由 `agent_story::migrate_preferences_to_author_scope` 挪到作者层，只挪一次、不留标记文件（挪完就没有可挪的了）。记忆页多了"作者偏好"页签，每条显示记录时间、来自入口、是否已被取代。

**8b 会话溯源与遗忘。** 每条记忆带 `channel`（desktop / weixin）与 `observedAt`（作者说这句话的时间，不是整理时间）。会话菜单新增"忘掉这次会话"（`forget_session`）：归档这次会话派生的记忆（`forgottenAt`，离开索引）、删它的检查点与短期回执（读取、工具意图、审批、技能同意、修订范围等前缀）、清掉未完成状态；对话记录与成果保留；运行中的会话先停再忘。

**8c 记忆进索引。** `agent_indexer` 加 `memory_chunks` 表与 `memory_fts`（trigram），`SCHEMA_VERSION` 升到 2 时回填；所有写记忆的地方统一走 `agent_memory::store`（落库 + 同步索引）。作品搜索（`search_book` 工具、`agent_story::search_view`）结果多一项 `memories`，覆盖本书与作者层；查询不足 3 个字时退到 LIKE。

**8d 请求上下文与作品记忆（`agent-runtime/compaction.py`，2026-10-16 更新）。** 排除框架默认压缩器，按 `工具筛选 → 实时上下文与协议装配 → 容量检查/历史整理 → 模型请求` 顺序安装 `TaskContextMiddleware`。判断使用实际发送的系统提示、已打开的工具定义与消息，容量边界为所选规划模型上下文减输出预留，取消固定 70% 触发线和 20% 保留比例。整理后保留量根据必要指令、工具和摘要输出预留计算；当前作者任务原文及所选技能的真实编号由宿主每轮附带。必要指令本身装不下时明确停止，不能反复压缩来掩盖配置问题。

`read_skill` 返回完整技能正文与资源目录，蒸馏证据等附件通过 `read_skill_resource` 按需分页读取；模型可见路径统一使用虚拟资源命名空间，不暴露无法通过 Agent 文件系统读取的宿主目录。摘要生成与作品记忆提取解耦，不再每次压缩都运行全量记忆整理。资料/章节摘要的 `scope` 明确限定为 `book`，只有真实作者来源可以产生 `author` 范围的偏好。

原始消息保留在检查点，并先归档到 `/conversation_history/<id>.md`。归档失败、摘要模型失败、空摘要、输出截断或摘要输入超限均保留原状态并明确返回可恢复错误，不丢弃最早消息去强凑摘要。成功使用的摘要按稳定来源标识记录诊断计数，检查点重载不重复计数；正常整理不在对话区持续显示“早期对话已压缩”。测试覆盖大技能证据的首轮调用、筛选前后工具一致性、失败状态恢复和记忆来源权限。

**8e 每日工作备注（`src-tauri/src/agent_journal.rs`）。** 每天做了什么不靠模型写日记，由平台已有事实推出：码字统计（前端 `app-settings/ew-local-write-stats`，按书）、对话（各会话当天的作者消息与回复数、入口）、成果（当天保存的）、章节改动（`chapter_versions` 当天的快照按章计数，用 `json_extract` 只取标题不读正文）；日期按本机时区。模型只能记"工作备注"：新工具 `work_note`（作者交代的待办、约定好下次要做的事，一次一条，不记设定与偏好），记在 `journal:<日期>:<编号>`，带会话、入口、作品，同一会话同一操作编号只记一次；作者可在记忆页"工作备注"页签删。最近三天的备注随记忆上下文（`journal` 字段，最多 12 条）给模型。服务动作 `journal_days / journal_day / journal_delete`；工具归"灵感、统计与工作备注"组，`tool_policies` 登记为宿主回执。测试 `agent_journal_tests.rs`（备注落今天、带会话与入口、按操作编号去重、进上下文、可删；一天由四类事实推出、按书过滤、日期列表计数）；真模型 `agent_live_work_note_is_recorded_from_author_instruction`（作者说"帮我记个备注：明天先改第三章开头"→ 记成当天备注，6.5 秒）。

验收：Rust 299、Python 239、前端 492，`vue-tsc`、eslint、`check:contracts` 通过；真模型四条（作者层记忆、整理质量、压缩后续答、工作备注）通过。

历史决策中的固定压缩比例及持续提示已由上述请求容量与诊断机制替代；`work_note` 不出确认卡（微信也不出）；工作日志只推导不让模型写总结；这一步没做向量召回（全文索引够用，向量层留到索引角色经网关补）。

## 微信确认卡与候选过期：问之前先核对，覆盖要说清（2026-10-13）

**现象**：微信里作者对"修改成你那版"回了「确认」，助手又发了一张一模一样的确认卡。记录核对：第一次确认后 `save_chapter` 因"候选基于正文版本 0、正文现在版本 1"失败，模型换个版本号重试，又触发一张新卡；而旧规则要求"候选版本 = 模型报的版本 = 本会话读到的版本"，正文改过之后没有任何版本号能同时满足，这条路是死路。另外微信端渲染卡片时只读 `choice.question`，宿主把问题记在 `text` / `prompt` 里，作者在微信里看到的卡没有问题文字。

**改法**（`agent_service.rs` / `agent_approval.rs` / `channel.ts`）：
- `chapter_save_basis` 把保存依据的核对抽成一处，审批门之前先跑：成果 revision 不对（`stale_artifact`）、模型报的版本不是最近一次 `read_chapter` 读到的或读后正文又变了（`stale_read`，恢复工具 `read_chapter`）都直接返回工具错误，不发一张注定失败的确认卡；同一操作编号的重放先取回执。
- "候选基于的版本比正文现在的旧"不再是错误而是事实（`overwritesEdits`）交给审批门：任何入口都先问，问题写明"这一章在候选生成后改过（现在约 N 字），写入会覆盖这些改动，原正文会留一份快照"；作者点确认后按正文现在的版本写入，候选的 `original` 换成被覆盖的那一版（撤销回到它），快照照常进 `chapter_versions`。
- 微信端 `cardView` 把 `choice`（状态、选项、默认项）与 `text` / `prompt`（问题、能否打字、分步、对比成果）合成完整的一张卡再渲染与解析；测试桩改成宿主的真实写法。
- worker 的 `save_chapter` 说明改为：`expected_version` 用最近一次读到的版本，候选比正文旧时平台会向作者确认覆盖，不要自行换版本号重试。

**验证**：`agent_approval_tests.rs` 新增两项（候选过期：先报 `stale_read`、重读后任何入口都发带"覆盖"的卡、确认后写入并留快照与原文；注定失败的保存不发卡）、`tests/weixin-channel.test.ts` 确认卡文本以问题开头。Rust 301、前端 492、Python 239；真实模型 `agent_live_model_read_wait_resume_save` 通过。

## 调度器：自动任务、助理巡检、事件规则、投递队列（2026-10-13，全平台方案第 9 步）

**任务**（`src-tauri/src/agent_scheduler.rs`，记录在 `ew-agent-automation/records`）：`task:<id>` 带时间表（每天 / 每周 / 每隔若干分钟 / 一次，按本机时区，`next_run_at` 纯函数）、载荷类型（`agent` 隔离回合、`heartbeat` 巡检、`command` 宿主命令）、投递目标（微信 / 桌面 / 不投递）、运行态（下一次、上次结果、连续失败数、停用原因）与估算用量。后台线程随应用起（`lib.rs` setup → `agent_scheduler::start`），每半分钟看一次到点的任务，按预定时间先后串行跑；`run:<taskId>:<startedAt>` 留最近 30 条运行记录。
- **隔离会话**：Agent 任务在 `create_session {requestId:"job:<id>"}` 的会话里跑（`agent_host::run_unattended` = 占会话 + `prepare_run` + `run_prepared`），载荷带 `automation` 标记，作者消息 `source:"automation"`；worker 的 `automation_rules` 提示段告诉模型这是无人值守、不提问、最终回复就是投递内容。回复文本按通道投递；停在问题上（`choice`）算 `waiting`，投递的是"任务停在一个问题上，到会话里回答"。
- **失败语义**（D14）：每次运行有墙钟上限（默认 10 分钟，看门狗线程 `stop` 会话）；连续 3 次失败自动停用并投递停用通知；错过的时间点合并成一次补跑（`missed_slots` 记进运行记录，不回放）；一次性任务跑完即停用；同一任务在跑时不起第二个（进程内运行集合）。
- **由 Agent 自建**：工具 `list_automations / create_automation / delete_automation`（契约 `AutomationSchedule`；`notes` 工具组）。建立与删除在任何入口都经审批门（D13）：建立前先 `preflight`（时间表不合法报错、同名或同内容的任务返回 `duplicate_task`，不发卡），确认卡写明"每天 08:00 运行，结果发到微信；每次约 15.0 千 token，每周约 7 次（约 105.0 千 token/周）"——按发起会话每轮回复的平均用量估，没有参考时按一次普通回合 30k 估。
- **助理巡检**（`agent_heartbeat.rs`，内置任务 `heartbeat`，每小时、活跃时段 8–23 点、默认桌面提醒）：伏笔到期（最近 7 天有改动的书里，`open` 线索埋下后超过 15 章没推进也没回收）、今日码字达标（手写 + AI ≥ 目标，一天一次）、榜单快照过期（最新一份距今 ≥ 3 天）、停笔整理记忆（最近一次正文改动在 30 分钟到 4 小时前 → `schedule_index`，同一停笔点只做一次）。每条告警带键，24 小时内不重复；没事静默。
- **事件规则**（`rule:<event>`，默认启用、可改通道）：批量连载跑完 / 中断汇报、拆书完成通知（订阅 `agent_events` 的 `agent-batch` / `agent-breakdown`）、码字达标通知与停笔整理记忆（由巡检执行）。
- **投递队列**（`agent_delivery_queue.rs`，吸收前端 `notify.ts` 的补发队列）：所有要送到作者面前的内容先存成 `delivery:<id>`（通道、文字、键、来源、尝试次数），再发：微信经 `weixin_bot::push_text`（不要求窗口；没有会话令牌或发失败留队，拿到新令牌时 `flush_soon` 补发，补发带「补发通知」前缀，推送记进微信对话记录账本）；桌面发 `agent-notice` 事件，界面显示后 `delivery_ack`。同键待发只留最新、刚送出的同键十分钟内不再送、三天没送出去的丢弃。前端 `notifyWeixin` 改为 `automation_notify` 交给宿主；微信适配器收到消息后 `delivery_flush`；`local-weixin-bot.ts` 的通知队列删除。
- **自动任务页**（`src/views/AgentCreation/components/AgentAutomationPanel.vue`，路由 `/agent-creation/automation`）：任务（时间表、投递通道、启用、下次 / 上次、立即运行、运行记录、删除）、事件规则开关与通道、投递记录与重试；`agent-automation` 事件驱动刷新；桌面通知用 `ElNotification`（事件到达或启动时补取 `delivery_pending`）。

**验证**：`agent_scheduler_tests.rs`（时间表与补跑合并；建任务先问、卡上有频率与估算、同编号回执、查重、停用 / 启用、删除经确认、规则默认值；投递队列去重、失败留队、补发前缀、回执、账本；巡检静默、达标与快照过期各说一次、规则关闭不查、伏笔到期、停笔整理一次）；Python `test_automation_tools.py`（确认包装、时间表契约、工具组与无人值守提示段）；前端 `tests/weixin-notify.test.ts` 改为交宿主。Rust 305、Python 242、前端 490；类型检查、ESLint、契约检查通过。真实模型：`agent_live_automation_turn_reports_without_asking`（DeepSeek flash，4.9 秒）——带 `automation` 标记的一轮不发卡、状态 completed、作者消息 `source:"automation"`，回复「《测试作品书名》目前只有 1 章，标题就是「第1章」，还没有写正文。」

## 六个挂着的问题（2026-10-14）

1. **评审"修订评估"填残整份作废** → `structured_output.invoke_structured(..., drop_fields)`：这次调用用不上的顶层块在校验前去掉。`critic.review` 初评（没有前稿）时丢 `revisionAssessment`，其余字段照常按契约校验；复评时它是回退依据，仍严格校验（填残照旧报错重试）。宿主 `attach_critic` 本就按可选读取。测试 `test_structured_output`（填残 / 填 null 的初评通过、复评报错）。
2. **成果面板"采用"遇候选过期报版本冲突** → `agent_service::apply_basis` 给出事实（候选基于的版本比正文现在的旧、现在多少字）；`apply_artifact_with(..., overwrite)`：不带 overwrite 的过期采用被拒并说明，带 overwrite 按正文现版本写入并把候选 original 换成被覆盖的那版（撤销回到它）。面板：`apply_artifact_basis` → inkConfirm「采用并覆盖」→ `apply_artifact {overwrite:true}`；模型工具 `apply_creation_artifact` 经同一事实走审批门（任何入口先问，卡上写明覆盖）。测试 `agent_approval_tests`。
3. **旧版提示词指纹表登记了现行默认值** → 42 段现行默认值的指纹从 `legacy-defaults.ts` 删除（67 → 25），表里只留真正换掉的文本；`tests/prompt-default-upgrade` 加守卫：现行默认值的指纹一个都不在表里。妙笔那段随第 7 步删除已不存在。
4. **启动跑三次完整性检查、迁移暂存残留 42MB** → `storage_migration::check_health`：`PRAGMA quick_check` 一个进程对同一个库只跑一次（启动链路三处各调一次 `inspect_at`），恢复备份 / 迁移提交 / 补全凭据后 `forget_health` 重新检查；`prune_stage_at`：迁移完成后暂存表只留回执 notes 里记着的被跳过行，其余删除并 VACUUM，`desktop_storage_ready` 后在后台跑一次。测试 `storage_migration::tests::health_check_runs_once_per_process_and_stage_is_pruned_after_commit`。
5. **向量检索层占位** → `src-tauri/src/agent_vectors.rs`：作者在模型管理里配了向量模型（分组 embedding，OpenAI 兼容 `/embeddings`）才生效；索引版本 3 加 `chapter_vectors / memory_vectors`（f32 小端字节，按切块编号），索引器每轮结束 `fill_missing` 补缺（每轮最多 400 块，切块重建清孤儿，换模型全部重算，调用记进 AI 调用记录 scene=embedding）；`search_chunks / search_memories` 变成"全文命中 + 按意思找到的"倒数排名融合（命中带 `via: fts/semantic/both`），向量接口出错退回全文；`canon_query view=search mode=semantic` 只按意思排序，供前端 `searchBookByMeaning`（文风范例）用，没有向量模型返回 unavailable。没有向量模型时一切照旧。测试 `agent_vectors_tests`（假向量：余弦、融合、补缺、按意思找、记忆、重建与换模型）。本机开发库没有向量模型，真实供应商未验证。
6. **微信四条流程的真机核对**：仍需作者在真微信上走。

Rust 309、Python 243、前端 491；类型检查、ESLint 通过。

## 自动任务页改版与"助理巡检"拆成事件提醒（2026-10-14，作者定）

对照 OpenClaw：它的心跳是"Agent 按作者写的清单每隔一段时间看一遍"（调模型、花钱），固定的周期检查文档建议做成独立任务。我们原来的"助理巡检"是四项写死在代码里的检查披着任务外衣，作者看不出它在查什么也改不了。改法：
- 内置任务 `task:heartbeat` 取消（启动与列表时 `retire_heartbeat_task` 清掉，已提醒过的键搬进设置）；任务列表只剩作者建的。
- 四项检查成为"事件提醒"里的规则（`EVENT_RULES` 共 6 条）：伏笔超过 {chapters} 章没推进（3–100，默认 15）、今日码字达标、榜单超过 {days} 天没更新（1–30，默认 3）、停笔 {minutes} 分钟后整理记忆（10–240，默认 30），加上原有的批量结束、拆书完成。每条可开关、改数字、选送达方式；`rule_update` 校验范围；旧记录缺的参数按默认值补。
- 总设置 `settings`（`automation_settings / automation_settings_update`）：提醒时段 `activeHours`（默认 8–23）与周期检查状态；检查由调度器每半分钟的 tick 调 `run_checks(app, false)`，每小时真正跑一次、只在时段内；"现在检查一次"（`automation_check_now`）不看时段。告警按各自规则的送达方式进投递队列。`agent_heartbeat::run(db, rules, state, now)` 按规则与参数查数据。
- 页面（`AgentAutomationPanel.vue`）换成板块统一骨架：页头、任务卡片（开关、下拉、小号描边按钮）、事件提醒列表（说明文字里内嵌数字格）、"通知"一节（原"投递"，标题下一句说明；"不投递"改"不通知"）。

验证：`agent_scheduler_tests`（旧任务清理与状态搬迁、规则参数与范围、总设置、周期检查按规则与参数静默 / 提醒一次 / 关闭 / 调阈值）；Rust 311；类型检查、ESLint 通过。

## 2026-10-14 旧代码清理（Agent 模块）

- 退役两个自称"旧兼容接口"的模型工具：`query_rank`（本地快照只读）与 `create_book`（直接建书）。本地快照由 `get_rank` 的 `cached / historical` 与 `list_rank_sources` 覆盖；建书只经 `prepare_book_plan → adopt_book_plan`。Rust 侧同步删除 `agent_rank::query / summarize / LISTED_DATES`、宿主的两个工具分支与写工具预检名单项；Python 侧删除工具定义、`TOOLSETS`、`DOMAIN_OPERATIONS` 与系统提示里的提及；契约文件重新生成。
- 宿主不再为"升级前未保存 activeThreadId 的批量任务"重算线程身份（`agent_host::prepare_run` 的 resume 分支、`resume_batch` 的空值兜底）；批量会话的线程身份以开始时保存的为准。保留 `scopeVersion` 为空的兼容分支：开发库里仍有一个这样的旧会话。
- 测试专用函数加 `#[cfg(test)]`：`agent_service::apply_artifact_checked`、`agent_worker_pool::idle_count`、`storage_migration::health_checks_run`；删除无调用的 `agent_breakdown::results`（统一走 `results_in_range`，`to=0` 到末章）。
- 微信本地状态（`src/storage/local-weixin-bot.ts`）只剩"当前作品"：删除早已全部写死为开启的八个权限开关及其在通道里的判断（`allowMediaSend / allowProactivePush` 永远为真，报错文案指向不存在的设置项）、旧版对话记忆 `history` 与 `clearWeixinHistory`；通知结果去掉永远到不了的 `disabled`。
- 未动：`src/storage/ai-facts.ts / ai-notes.ts / ai-index.ts / local-ai-chat.ts` 的未引用导出属于写作台与旧运行时，不在 Agent 模块内；一次性迁移（`import_legacy_chats / import_legacy_notes / retire_legacy_ai / agent_skill_files::migrate`、`legacy-chats.ts`）保留；`tool_results.legacy_write_result` 只是命名，行为仍在用。

## 2026-10-14 效果页签下线、对话里出封面

- "记忆"页的"效果"页签（`AgentEvalPanel.vue`）与 `eval_report` 命令删除；`agent_eval::report` 保留，继续供方法包导出的 `methodStats` 与各稿并排的阅读评价（`record_reading_choice`）使用。样本多了再决定是否重新露出。
- 新工具 `generate_cover(artifact_id)`：按已保存的封面方案出一张竖版封面（768×1152，不排书名），任何入口都先弹确认卡（决策 D13：卡上写明图片模型、张数、尺寸、按张计费）。走网页桥：宿主 `agent_packaging::cover_job` 先预检（方案存在且为封面方案、作品可访问、`image_model` 能从模型设置里解析出"图像生成"分组选定或排在最前的启用图片模型），不通过不发卡；确认后网页层 `src/agent/cover-image.ts` 调本地图片模型（密钥只在网页层读）、裁成封面比例、`attach_cover` 挂到方案、写进作品封面；微信入口再把 PNG 发到对话。成图不回传宿主（网页桥结果 2 MB 上限），只回结论。出图预算 300 秒。
- 技能 `launch-packaging` 的封面一节写明两条出图路径；没提出图不调用。

验证：Rust 315（新增 `cover_generation_asks_on_every_channel_and_the_card_names_the_model_and_the_book`）、Python 246（`test_cover_tool.py`）、前端 501（`agent-cover-image.test.ts`）；类型检查、ESLint、契约核对通过。

## 2026-10-14 微信消息回执与状态里的模型名

- 现象：作者发 `/帮助` 没回音，`weixin-bot.log` 与会话日志里都没有这条消息进来的记录；随后 `/状态` 正常，但"使用模型"是本地模型编号。
- 收消息链路补回执：Rust 侧 `InboundMessage.message_id` 改为字符串（微信消息编号超过 JS 安全整数，数字会丢精度，回执对不上）；`Runtime.accept / attach / ack`：网页层在线就直接发事件并记入 `unacked`，网页层把消息记进日志后调 `weixin_bot_ack`；页面重载（开发版热更新、刷新）后再次 `weixin_bot_attach` 时先补发没回执的，再给攒着的。网页层按消息编号去重（最近 200 条），补发的同一条不处理两次。
- 宿主侧技术日志：`weixin_bot::trace` 往同一个 `logs/weixin-bot.log` 追加 `host-inbound`（每条收到的消息：编号、类型、字数、直接发还是先攒）与 `host-attach`（补发了哪些）；网页层的日志缓冲 3 秒才落盘，页面重载时会丢，宿主这几行不会。网页层另加 `pagehide` 时尽量冲刷缓冲。
- `/状态` 的"使用模型"改为显示模型名（`getLocalAiModelDisplayName`），取不到名字才退回编号。
- 没能确认 `/帮助` 那条丢在哪一段：当时没有宿主侧日志。今天开发版的页面因改动热更新重载了多次（`channel-start` 连着出现），消息若恰好在重载窗口到达，旧逻辑会把它发给已经不在的页面且游标已前移。下次再发生，看 `host-inbound` 有没有这条就能定位。

验证：Rust 317（`messages_wait_for_the_page_and_unacked_ones_are_replayed_after_a_reload`、`message_ids_stay_strings_because_wechat_ids_exceed_js_safe_integers`）、前端微信通道 22 条；类型检查、ESLint 通过。待作者在真微信核对：重载开发版期间发一条，重载完成后应补收到并有回复；`/状态` 显示模型名。

## 2026-10-15 微信消息排队不动的真因：异步命令里的同步等待

- 现象：`/帮助` 正常回复后，紧接着的 `/作品` 没有任何反应。宿主日志有 `host-inbound`（消息到了桌面端、已发给网页层），网页层却没有 `inbound`，说明消息进了接收队列但没被处理。
- 原因：网页层每处理完一条消息，接着 `await agentCommand('delivery_flush')` 让宿主补发通知。`agent_workspace` 是异步 tauri 命令，跑在 tokio 工作线程上；`agent_delivery_queue::flush` 里用 `tauri::async_runtime::block_on` 同步等，tokio 在工作线程里遇到 `block_on` 会 panic，命令的 future 中断、永远不回应，网页层那个 `await` 挂住，接收队列的 pump 停在那里，后面的消息只排队不处理。此前没撞上，是因为 `flush` 开头的 `try_lock` 失败时直接返回，恰好绕过了阻塞等待。
- 修法：新增 `blocking::run`：在运行时工作线程里先 `block_in_place` 再等，普通线程照旧用全局运行时；Agent 模块里的同步等待（投递队列、调度器、网页桥、榜单桥、批量、宿主）全部换成它，`tokio` 显式加 `rt / rt-multi-thread`。单测 `blocking::tests` 同时证明旧写法在工作线程里 panic、新写法在普通线程 / block_on 内 / 工作线程 / 阻塞线程池四种位置都能拿到结果。网页层的接收 pump 不再等补发通知的结果（fire-and-forget），补发慢了或坏了都拖不住下一条消息。

验证：Rust 318（`blocking::tests` 证实工作线程里的旧写法 panic）、微信通道前端 15 条；ESLint 通过。待作者在真微信核对：连发两条命令都应有回复。

## 2026-10-15 妙笔会话改为用到才建；删书后的对话去留

- 现象：进过写作台的书，Agent 板块"对话"列表里都多出一条空的《书名》对话。原因是右侧面板记住上次打开的是妙笔，每次进写作台面板一展开就按 `book:<id>` 建会话，不管作者有没有说话。
- 妙笔会话改为用到才建：`use-agent-workspace.prepareBookSession` 只记下"要建成什么样"（键、标题《书名》、通道妙笔 + 写操作先确认）并把作品引用放进待建会话的引用；作者第一次发消息时 `ensureSession` 按它建。这本书已有妙笔建的作品会话就直接选中最近一条；"新对话"换会话键后同样等第一条消息。面板关掉或在板块里点"新对话"时清掉这份预备（`clearSessionBlueprint`），板块里的新对话不会被建成作品会话。当前章锚点与选段引用在没有会话时记在待建引用里，建会话时一并带上。
- 删书后的对话：书进回收站，对话保留，`workspace` 读取时给引用了不在库里的作品的会话标 `bookDeleted`，列表里显示"作品已删除"，能看、不能再往那本书里写。回收站"彻底删除"走 `purgeLocalBookCompletely → book_purged`：这本书的妙笔会话软删除（与"删除会话"同口径），只是引用过它的对话摘掉引用、清掉写入目标，标记随之消失。
- 开发库里这本书之前留下的 4 条空妙笔会话已按同样口径标为删除。

验证：Rust 319（`deleted_books_are_flagged_on_their_conversations_and_purging_removes_miaobi_sessions`）、前端 519（`miaobi-session.test.ts` 重写为用到才建）；类型检查、ESLint 通过。待作者核对：进写作台不再产生空对话；删书进回收站后对话带"作品已删除"标；彻底删除后妙笔会话消失。

## 书籍与作者文风蒸馏（2026-10-15）

- 内置 `novel-distillation` 使用已有原文读取、拆书、报告成果和 `prepare_skill`，按任务分析单本作品或跨作品文风。阶段报告记录已读范围与待补内容，最终候选经原有成果编辑器保存；不增加独立写作服务或原文主库。
- 技能新增 `kind: style`。`resolve_ruleset.style_skill_id` 单次选择文风，省略时采用本轮技能选择器指定的文风或作品绑定，空字符串明确停用。`configure_book_writing.style_skill_id` 按作者原话保存／解除作品绑定。文风独立于主方法选择，启用多个文风不会自动混合，也不会导致写作方法冲突。
- 选定文风的当前文件内容与版本进入规则集快照，沿用既有正文生成、短篇生成、编辑评审和修订输入。写作依据同时绑定文风与作品选择；技能修改、停用或绑定变化后，旧候选不能继续交付。盲读仍只接收正文和公开前情。
- 技能包的 `references/` 文本文件支持候选保存、编辑、导入导出，并在运行时作为虚拟文件按需读取；不复制到数据库正文，也不默认塞进写作模型。生成必须使用的写法写在技能正文，出处、覆盖范围与分析记录放参考文件。
- 现有“拆书”“仿书”“技能创建与修改”技能已衔接这一流程。文风提取的语义判断由现有模型完成，没有固定作者、场景配额或词频合格线。

## 持久化蒸馏与用户范围选择

`prepare_distillation` 只建立范围选择卡，不进行模型调用。作者可选择全书或按导入目录位置指定起止章节，界面显示所选章数和字数；确认后才开始。无需先拆书，不按已有章节卡数量截断范围。

`agent_distillation` 复用 `agent_outbox` 的领取、租约恢复与提交机制，使用独立任务类型，避免与作者索引、参考书拆解相互消费事件。原文仍从参考书库按版本读取；长章按模型容量分段，所有源字符都有对应持久节点。分析、归纳、回查和技能整理各自落库，只有当前层全部完成才进入下一层。归纳分组由实际输入大小决定，不使用固定章数。中断后复用已完成节点；恢复备份时可从持久节点重建队列。

章节分析保存有原文依据的观察。宿主校验连续引文及位置，归纳只能继承输入已有的证据编号。最终结论逐条回查原文，再编译为现有 `kind=style` 技能候选；覆盖元数据和证据文件由宿主生成，不使用模型自报覆盖率。`read_distillation` 可分页读节点及按证据编号回查原文。失败、暂停与取消保留分析记录，原文改变时阻止旧版本继续交付。

使用既有 Agent 索引模型及模型网关，用量随任务保存，包含已返回用量的失败尝试。未进行新场景试写和人工评价时不声称文学效果已验证。本次验证使用隔离的小样本与模拟模型，不运行用户上传的整本小说。

拆书画像的文风统计同时修正为明确的 `styleCoverage`：统计范围与已索引章节对应，并声明这是程序统计，不代表本轮模型阅读或报告范围。

## 2026-10-15 主干漏了"存储已就绪"信号；附件改为一次性

- 蒸馏任务卡在 0/20 的根因：宿主的后台调度（索引巡检、参考书拆书、参考书检索、蒸馏、自动任务定时器）都先看 `AgentHost.storage_ready`，这个开关只在前端调 `desktop_storage_ready` 时打开。Agent 分支的 `src/storage/desktop-migration.ts` 在 `ready()` 里调了，主干的同一文件（10-09 的存储改动版本）没有，于是主干里这些后台线程启动即返回、无任何报错。已在主干补回这一行。参考书拆书的章节处理停在 10-07 也是同一原因。
- 输入框上方的引用卡片是会话引用，发完消息不会自己撤下。改为：一轮任务做完（`apply_event` 的 done 且状态为 completed）时 `agent_host::settle_references` 把非作品、未标 `pinned` 的引用撤下；作品引用总是保留，妙笔的当前章锚点标 `pinned: true`。模型提问中途（choice / paused）不撤。消息上的引用快照不受影响。

验证：Rust 330（`attachments_leave_the_session_when_a_turn_completes_but_books_and_pinned_anchors_stay`）、前端妙笔会话 4 条；类型检查、ESLint 通过。开发版重启后 48 秒内蒸馏任务已领走 4 个节点、Python 工作进程已起，证实开关补上即恢复。
- 补充：撤下的书与参考书记进会话的 `readSources`（最多 50 条）。`allowed_book` 只读、`allowed_source` 与工具参数的引用范围检查（`agent_tool_boundary::scoped_book`）对这些来源仍放行，写入仍要本任务的写入目标；`session_reference_names` 的人名泄漏检查也算上它们；`book_purged` 时从名单里去掉。界面上附件发完即撤，模型在后面几轮还能读它们没读过的章节，不用再 @ 一次。

## 2026-10-15 榜单过期提醒合并；桌面通知限量、自动消失

- 现象：定时器一跑起来，"榜单超过 N 天没更新"规则一个榜单发一条，35 条桌面通知叠在一起，且不会自动消失。
- `agent_heartbeat::stale_ranks` 改为一次检查只出一条：N 个榜单过期、最旧的日期与榜名；只有一个过期时保留原来的单榜措辞。去重键 `rank_stale:<最旧日期>`，一天一次，刷新后日期变了才再提。
- 桌面通知（`use-agent-workspace.showNotice`）：同时最多 3 条，10 秒自动消失；多出来的合成一条"另有 N 条提醒，在自动任务页的通知里查看"，每来一条就替换上一条汇总。每条照旧回执，自动任务页的通知列表保留全文。
- 开发库里已发出的 35 条 rank_stale 记录已清掉（备份在 scratchpad）。

验证：Rust 331（`stale_ranks_are_reported_as_one_notice_however_many_sources_are_stale`）、前端新增 `agent-notices.test.ts`；类型检查、ESLint 通过。

## 2026-10-15 结构化输出：模型"没作答"的三道防线

- 现象：蒸馏任务某个片段报"DistillationLeaf 结构化结果格式不完整（结束原因：tool_calls）"，任务停为待重试。网关账本显示当天 21 次索引调用里 3 次 deepseek flash 返回的函数参数是 `{"observation_placeholder">⏎<｜｜DSML｜｜: "pending"}` 这类东西（三四十个 token）：供应商自己的函数调用标记漏进了参数，根本不是 JSON，也不是截断。直连同一章复现两次都正常，是概率性的。
- `structured_output.invoke_structured`：`degenerate_tool_call` 只认空调用和带 `DSML / <parameter / _placeholder / <｜` 标记的非 JSON 参数（写到一半的 JSON 仍走原来的修复与报错）。这类情况原样重发，最多 3 次；仍不行改让模型在正文里直接写 JSON（`_json_fallback`，带 JSON Schema 的系统说明，不绑函数），`extract_json_object` 去围栏取最外层对象；再失败才报 `transient_output`。几次的用量合并写回最终 raw 的 usage_metadata，调用方记账不变。拆书索引、评审同样受益。
- `distillation.process`：`transient_output` 也重试，但不追加"上一份结果未通过校验"的提示（没有上一份结果可纠）。
- `agent_distillation`：一个片段失败只记在片段上，任务继续跑其余片段；`settle_failures` 在没有待处理 / 处理中的片段时才把任务停为待重试并带上第一个失败原因。卡片在运行中显示"N 个片段失败，其余跑完后可继续"。

验证：Python 259（新增 4 条：原样重发并合并用量、三次后改要正文 JSON、正文也不行才报 transient、写到一半的 JSON 不算抽风）、Rust 331（`restored_queue_and_failed_attempts_keep_coverage_and_usage_honest` 改为片段失败不拖停任务）；ESLint、类型检查通过。待作者：在蒸馏卡上点"继续"，失败片段应重排并跑完。

## 2026-10-15 蒸馏片段自动重试几次；失败说明改成人话

- 现象：片段失败（如"结构化结果不符合契约：observations.1"）后要作者点"继续"，次数多了很烦；错误原文是给开发看的。
- worker `distillation.process` 把错误码与供应商的可重试标记一起交给宿主（`distillation_finish` 的 `code / retryable`）。
- 宿主 `agent_distillation::fail`：错误码在 `RETRYABLE_CODES`（没写合格、没作答、引文对不上）或供应商标了可重试（超时、限流）且片段跑的次数未到 `MAX_NODE_ATTEMPTS`（3）时，片段放回待处理、队列行留着，本轮租约释放后下次再领，每次都是全新上下文；次数用完才记为失败并把队列行结掉。"章节原文已变化"不重试。`control resume` 把失败片段的次数归零并重新入队；`recover` 只补 pending / running 的队列行。
- 给作者看的文案由 `friendly_error` 生成（"模型这一段的分析没写合格，已自动试了 3 次都没过，点「继续」再试；反复出现可换一个更稳的模型做索引"），技术细节留在片段的 `detail`，不再出现在卡片上。

验证：Rust 332（新增 `unqualified_results_are_retried_a_few_times_with_a_fresh_context_before_the_author_is_asked`）、Python 259；待作者：蒸馏卡上点"继续"，失败片段应自动再跑最多 3 次后才停，卡片上的错误是人话。

## 蒸馏归纳容量与重试修正

观察列表不再使用固定 24 条上限；输入仍按配置的模型容量分组，单条内容与证据仍受契约校验。归纳触及输入或输出容量时，宿主把未完成节点拆成引用上游观察区间的子任务，复用原队列和存储；分段结果按原顺序保留，单条不可再分的内容明确报错，不静默截断。无法继续合并的已归纳分段保留层级后逐条核验。

蒸馏每个领取单元只发起一次模型请求，结构化输出的内部重发与 JSON 退路不会在该请求内另算一轮。宿主持久记录实际请求数、用量、字段/约束/实际大小，并在后续领取时传回具体纠错信息；同类错误重复后提前停止，其他错误受统一预算约束。普通 Agent 的结构化输出重试行为保持原样。

旧任务版本和已完成节点保持兼容，作者点“继续”只重新领取失败节点；已完成的分段、原文版本和证据可以复用。验证使用模拟模型和隔离数据库，不触发用户真实任务。

## 蒸馏数据输出与原文定位边界

结构化数据输出由宿主供应商适配层声明通道，经 `worker_model` 传给共享 `invoke_structured`。DeepSeek 使用其公开支持的 `response_format: json_object`，直接解析 JSON 正文，再执行本地契约校验；Agent 真实工具调用仍使用原工具通道。JSON 通道与普通文本退路会保持选择，字段错误不会把后续请求切回失败的函数调用通道。显式请求预算通过请求头传到网关，关闭该请求的隐式网络重试。

逐章分析输入包含宿主按当前原文生成的 `passages`（编号、字符位置、原文）。观察只返回 `sourceIds`，宿主按编号保存原文位置，回查时按版本从原书取回引文，模型不再重抄引文或计算偏移，节点也不复制原文。归纳和原文回查仍使用持久证据编号；旧的完成节点无需重做，未完成节点恢复后采用新输入。重复文本、中文引号、空行及 Unicode 字符的定位不依赖字符串首次匹配。观察和证据列表均不设固定条数配额，仍受模型容量与来源范围校验约束。

失败节点保留最近一次响应诊断及具体字段错误，面板仅展示可读原因，便于离线重放而无需重新请求模型。已通过隔离库、原模型网关与实际 Python worker 对两个此前失败片段的单批验证；未运行用户全书任务。该真实调用测试默认忽略，须明确启用且从 stdin 提供配置与样本，不把凭据写入命令行或测试日志。

## 蒸馏交互交接与结果规范化

原生范围卡拥有范围选择这一决策。工具通过本地元数据声明交互交接，中间件把它与并行的规划问答分开，成功返回范围卡后结束本轮规划；失败回执仍允许模型修正。宿主按会话、运行编号及任务卡关联清理旧版本多发的待答卡，不伪造作者答案，也不跳过带确认令牌的授权。开始范围任务时同步会话，旧记录加载时可恢复一致状态。

输入框引用存于 `draftReferences`，宿主接收消息时在同一事务内撤下已发送附件，不再等待规划回合或问答结束。`references`、消息引用和 `readSources` 继续供 Agent 读取来源；平台作品、固定锚点和本次未发送的新附件保留。草稿保存携带最近已知作者消息编号，延迟到达的旧保存不能重新挂回已发送附件。

蒸馏输出属于非权威分析文档。Python 和宿主均按相同文档 Schema 投影已声明字段，忽略额外旁注，再严格校验必填字段、类型、枚举与证据。此策略仅用于蒸馏派生结果，不放宽工具写入参数或作者授权。恢复任务时，可将保存的失败响应重新投影、校验并通过原提交边界保存；不补造缺失内容、不重算已有用量。

已用实际十章任务的数据快照完成恢复、最终技能生成与成果落库验证；三份仅含额外字段的失败回查直接复用。已验证同源候选通过来源版本、范围、原用量和任务状态检查后恢复到原任务，不再次调用模型。浏览器验证覆盖发送附件撤下、单一范围卡、历史重复问答隐藏、原消息引用保留及成果打开；技能仍为待作者确认的候选。

## 蒸馏技能保存与仿书复用

数据库成果编号可含命名空间分隔符，技能目录编号必须可跨平台使用。采用候选时，合法的既有目标编号保持不变；其他成果编号通过稳定摘要映射为目录编号，沿用原有文件保存、版本检查与重复采用保护，不放宽目录校验。

参考书画像的 `distillationStyles` 按任务、成果和已安装技能的真实编号关联，返回覆盖范围及候选、已安装、已停用状态。仿书技能读取实际保存的文风后，将 `style_skill_id` 传入既有写作规则集；未保存候选不能冒充可用技能，局部蒸馏不能标为全书文风。

验证：前端 525 条、宿主 345 条通过。页面覆盖等待问答时撤下附件、刷新后不回挂、问答继续填写；实际「低谷逆袭的公开落差叙事」候选经原生采用入口保存成功，两份参考文件逐项回读一致，同源画像返回其真实技能编号与第 1–10 章范围。本次未调用模型。

## 2026-10-17 写作效果重构：范例续写、三选一、编辑只查事实、蒸馏出文风档案

方案见根目录《易创Agent写作效果重构方案》。这次改的是"模型拿到什么"，不是提示词措辞：写作模型不再看规则集全文、方法技能、平台画像、文风技能正文和任何词表、数字，只拿作者要求与硬事实、几段原文范例、紧挨着的前文原文、这个场景的要点。

- 场景续写（`plan_scenes` 替代 `plan_beats`）：一章两到四个场景，`draft_begin` 按场景挑范例（绑定的文风档案优先，其次作者确认样本），`draft_chapter` 逐场景续写，每个场景一次写出三份候选（分隔行拆分，不够两份时单独补写），读者模型正反两种顺序各排一次名次合计选一份（`critic.rank_candidates`，契约 `CandidateRanking`），`draft_scene` 把候选、排序、选中记在候选上。
- 编辑评审（`critic.review`）只查事实连续性、设定冲突、偏离场景要点、字数，不打分；`CriticReview` 去掉 scores / revisionAssessment / readerResponse / preservedStrengths。交付改为一次评审、一次定向修订、不复评；`artifact_replace` 把上一版编辑结论带到新版本（`critic.revisedIssueIds`），不再留 `pendingRevision`。
- 体检 `agent_quality` 删掉 AI 味词表、转折词、结尾总结词、"道："人名扫描、对白占比与句长关卡、短篇反转关键词；只留结构核对、状态疑点、与参考书逐字重合（`overlap.reference`，连续 12 字，默认阻断、保存前出确认卡、可定向修订）。文风指纹 15 项（`agent_style::style_fingerprint`）与基线偏移（`styleDrift`）只在界面显示。
- 规则集：`writer_text` 是写作与修订、编辑拿到的那份（作者原话、作者规则、本书文风要求）；`expand` 是规划视图，文风档案在这里显示写法卡与叙事模式。
- 网关按角色补采样参数（`sampling_defaults`：评审与索引 0.2；写作角色不下发、用供应商默认——回放集证明 deepseek-v4-flash 在 1.5 会写成碎句乱码；调用方显式值、模型记录的 `sampling` 字段、额外参数依次优先）。
- 蒸馏（协议版本 2）：leaf 标出有辨识度的段落（kind / why / sourceIds），summary 对着范例原文归纳写法卡（每条指向范例）与叙事模式，verify 一次核验全部写法卡，宿主程序编档：`kind: style` 技能 + `references/examples.json`（范例库、指纹、写法卡、叙事模式、来源章节）。旧文风技能保留，但没有范例文件时写作模型拿不到范例，重新蒸馏即可（调用次数约等于片段数加三次）。
- 没做：写作盲测页、作者改稿回流（对子与差异对齐）、旧文风技能一键转档案、个人微调；短篇写作仍走原来的整篇一次生成。

验证：Python 298、Rust 366、前端 526、类型检查通过；真模型回放见根目录方案第〇节。

## 2026-10-18：工具、写作依据与交付一致性修复

本节替代 10 月 17 日关于“修订后不复评”“所有场景固定三选一”的描述。

- 工具错误由共享策略与 `tool_results.failure_of` 统一解释；正常无结果、无效参数、历史错误和执行失败不再混用。旧检查点也使用这一边界。榜型按真实目录校验。
- 写作依据保存实际使用的核心设定、人物资料、前文、场景及范例。修订使用角色所需的输入，不把整份内部规则与元数据重新塞回写作模型。
- 默认每场景一份候选；显式比较时才生成多份。场景和待排序候选持久化，续跑复用；不完整输出、无效排序不能冒充已完成。
- 语义检查覆盖事实及具体阅读障碍，不恢复词表、句长占比或文学打分。一次修订后必须核验变化；未解决的问题不得直接移除。待验稿不能写入正文。
- 旧文风技能按原文证据生成派生档案，核对出处，保留原技能文件。范例也进入已有章节和短篇的写作依据；缺少可用范例时明确失败，不假定应用成功。
- 作者输入先按创作要求、平台操作做逐字分段，再提取长期记忆。来源版本化重建会退休旧的操作性派生记忆，避免“保存这一版”使候选过期；真实设定变更仍触发冲突保护。
- 已写入正文的状态由实际提交结果判定，不因自己的写入改变原始章节版本而误报未完成。新修订候选绑定本轮作者要求。

验证使用 macOS 开发版原生界面和已有模型配置（deepseek flash），从“我现在要开一本新书。”开始，正常答卡、选方向、命名并给出能力规则，完成《遗声》首章生成、一次修订与核验、正文保存和编辑器历史写入。随后仅用普通润色请求调用原有文风技能；恢复 98 段证据范例，本次实际使用 5 段，输出独立候选，正式正文保持版本 1。

没有直接修改生成文本、候选状态或评审结论。真实验收曾发现保存上下文误判，并据此修复后通过同一会话重试成功。模型仍存在内容漏判和总结夸大；流程验收不构成真人感或文学质量达标的证明。

## 2026-10-18 下午：直接交稿——作者只看对话、正文、撤销

方案见根目录《易创Agent直接交稿方案-2026-10-18》（Codex 同日修订版）。本节落实其第一、二阶段：后台处理与保存边界、交互收口。整章一次生成、写作模型更换、范例来源筛选属于第三阶段，按方案第五节先做人工盲读比较，本次没有改默认。

- **交付策略**（`prose_delivery.py`）：编辑核对一次 → 有原文依据的问题定向修订至多一次 → 核验三件事（原问题解决、事实保留、范围正确）。核验不过恢复改前稿照常交付（`restore` 步记进 history）；没改成的编辑意见留在报告里，不再把稿子标成 needs_attention 让作者接手。只有程序核实的阻断把稿子留在草稿。`stalled` 状态删除；宿主 `completion_report` 不再因"仍有可修问题 / 问题未定位"拒绝 ready。
- **自动保存**：`draft_chapter`、`polish_draft`、`revise_spans` 交付完成后由 worker 调 `save_chapter(automatic=true)`，写入授权（`select_write_target`）、版本核对（`chapter_save_basis`）、体检门、通道确认都还在宿主同一条路径上；`automatic` 只让宿主少写不让它多写：要发确认卡的情况（微信、覆盖生成期间的改动）返回 `confirmation_required` 工具错误，worker 带回 `saved=false, state=draft, saveOutcome`，作者要求写入时规划模型再用 `save_chapter` 正常发卡。`delivery_begin` 返回 `book_id / chapter_id / expected_version / applied` 供这一步使用。短篇与试写没有章节，始终留在对话里。
- **编辑**（`critic.py`）：删掉读者排序（`rank_candidates`、`CandidateRanking`）与"字数偏短/偏长"判断；输入里 `wordCount` 由程序实测（`agent_text.word_count`，与宿主同口径），编辑只在实测与目标相差很大时查遗漏或重复。审美意见（不够自然、不够爽、节奏）明确不列为问题。核验时 `revisionCheck.instruction` 带作者原话，编辑据此判断"原要求是否做到"。
- **程序字数**（`agent_quality::rule_issues`）：以作者要求或起草目标（`targetWords`）为准，"约 N 字"轻微偏差只出提示；阻断线取画像下限与目标里较小者的一半，作者要的短章不被画像卡住。
- **写作提示**（`worker._scene_prompt`）：每个场景只写一稿；本章目标与章末落点只在"本章安排"里出现一次，场景表标出已写 / 现写 / 待写，落点只在最后一场写到——针对首章回放里"线索复述三遍、四次开场"的现象。多候选、分隔行拆分、读者两轮排序与 `draft_scene` 的候选字段一并删除；`draft_scene` 只记每场写完后的正文供中断续跑。
- **作者定位改稿**：`revise_spans(paragraphs | quotes, instruction)`，宿主 `revise_begin` 按段落序号或唯一命中的原文片段冻结目标段（`quote_not_found / quote_ambiguous / instruction_required`），`artifact_replace` 把作者要求记进 `pendingRevision.before.instruction`；公开工具改完接着走交付核验与自动保存。内部定向修订为 `_revise_spans`。
- **交互**：正文类成果（章节、短篇、试写）在对话里直接显示（`AgentProseMessage.vue`：正文、状态"已存为新版本 / 未写入作品 / 正在写…"、撤销或保存、编辑），消息本身不带"成果已保存，可展开查看"；等待时只显示"正在写稿… / 正在核对与修改… / 正在读资料…"这类话，不念工具名。成果面板（`AgentDocument.vue`）对正文只留编辑框、字数、撤销 / 保存 / 放弃；原文 / 修改后 / 对比 / 体检 / 各稿并排页签、交付状态块、指纹表、阻断横幅删除，`AgentDeliveryStatus.vue`、`AgentQualityReport.vue`、`AgentVariantCompare.vue` 与对应测试删除。宿主生成的稿子标题不再带"候选"。
- **技能与提示词**：chapter-writing v10、de-ai v6、chapter-check v5、short-story v7；系统提示词"硬规则"写明作者要求写某章就是要求写入（先 select_write_target，交付后自动存新版本，"先看看"则留在对话），"和作者说话"写明正文已在对话里、回复一句话不复述不自评不列菜单。
- **回放脚本**（`tests/replay_scenes_live.py`）不再用读者模型做盲比：产出 `blind/<场景>.md`（旧式 / 新式 / 原文打乱为 A/B/C）与 `blind/key.json` 供人盲读，统计只留指纹偏移与逐字重合。

- **契约导出**（`export_contracts.py`）：`InjectedToolArg` 参数（`resolve_ruleset.author_instruction`、`save_chapter.automatic`）统一进原生契约、不进模型契约，不再逐个特判；宿主校验内部调用时据此放行。

验证：Python 305 通过、56 跳过（`test_compaction` 一例在改动前的备份上同样失败，与本次无关）；Rust `agent_` 系列 289 通过，新增 `automatic_save_after_delivery_writes_without_a_card_and_never_overwrites_author_edits`（目标未定被拦、确定后直接写入且无确认卡、待验稿不能写入、生成期间作者改过就退回 `stale_read` / `confirmation_required` 不覆盖、按原文片段定位修订与歧义拒绝）；前端类型检查、ESLint、契约检查通过，`agent-prose-message` 等 4 个前端测试文件通过。未做真模型完整流程验收；本节所有改动只说明流程与交付方式，不构成真人感改善的证据。

### 2026-10-18 傍晚补充：作者的决定不从过往作品推断

真跑"我要开一本新书，给我一点建议"时，规划模型读了作品列表后替作者定了方向，并把推断当事实讲（"前两类数据表现更好"，而 `list_books` 只返回分类、标签、字数、章数、简介、更新时间，没有成绩数据），最后说"想先跟你确认一下"却没有发卡。根子是原则缺一条：系统提示词与开书定位技能都鼓励"有已知信息就先给建议"，没有界定哪些事是作者的决定、不能用推断代替。改法只在原则层与技能层，宿主与工具不动：

- 系统提示词"先理解，再动手"改为先分清作者的决定与可假设的细节：新书的类型、平台与读者、主角想要什么，章节写入目标，推翻已有设定的改动，这些作者没说就用引导卡问，不从过往作品或偏好记忆推断替作者定；过往作品只用来给选项和说明取舍。其余细节仍是"先交付并说明假设、不发问卷"。
- 开书定位技能 v7："怎么推进"第一步核对三项作者的决定，缺的用 `ask_author` 的分步问答卡一次问完（选项可取自过往作品分类与选题卡，允许跳过），三项定下后细节不再逐项问；明确平台没有作品成绩与读者反应数据，不说哪类"数据更好"、作者"更想写哪类"；"容易出的问题"加了这一条。技能文件在 Agent 页加载时同步，重新打开 Agent 页即生效。
- 没发卡是规划模型（deepseek flash）的工具调用能力问题，提示词与技能改完也不保证它发卡；建议换规划模型用同一句话再跑。没有加"看到'确认一下'就补卡"之类的规则。

验证：Python 相关子集 25 通过；Rust `agent_skill` 系列 22 通过。改前文件备份在 `easy-writing-direct-delivery-backup-20261018-151039/before-opening-positioning-v7/`。

### 2026-10-18 晚：开书流程的决策点都用卡问，建书缺书名交回模型

真跑"可以采纳，继续下一步"时，草案书名为空（技能让留空），采用走到建书那一步才被宿主以内部错误拒绝，运行失败出现"继续任务"；点继续后没有作者新消息，又发了一张书名为《》的确认卡，点采用再次失败，形成死循环。另外选题时模型自行用了本地榜单快照，没问作者要不要参考、要不要抓最新。改动：

- **宿主**（`agent_book_adoption::begin`）：模型能自行纠正的前置条件改为结构化失败交回模型，不再中断运行：`working_title_required`（Precondition，details 带 planId/revision）、`plan_revision_stale`（Conflict）、`plan_not_found`（Reference，成果缺失与类型不符已由工具边界先退回）。授权凭据类错误（作者原话、回执、展示版本）仍是硬错误；建书那一步的书名检查保留。新增测试 `adoption_without_a_working_title_is_returned_to_the_model_not_the_author`。
- **系统提示词**："作者的决定"加书名（出备选请作者挑或自拟）；"当前任务完成就结束回复"后加"开书、拆书这类多步流程里的下一步按技能在阶段边界用一张卡问；流程之外不列菜单、不自动启动下一阶段问答"，与"交稿只说一句话"不再冲突。
- **选题技能 v7**：起点一张分步卡问写给谁、发在哪里、想写什么，并带"榜单参考：不参考 / 用本地快照（写明快照日期）/ 抓最新（联网几分钟）"；作者没选抓最新就不联网，选了联网前工具仍再确认一次。
- **开书定位技能 v8**：书名在草案阶段留空、由作者在"定书名"一步定，不由模型填暂定名；作者确认草案后出一张"下一步"卡（定书名 / 写简介 / 先到这），已有书名的草案直接采用建书；选定书名后用 prepare_book_plan 回填草案再 adopt_book_plan 建书；"先到这"之后不再问。
- **新书期包装技能 v4**：书名定下后的落地方式（开书流程回填草案再采用；已建作品用 update_book）。
- **契约**：`BookPlan.workingTitle` 说明改为"草案阶段可留空；采用建立作品前必须有，由作者在备选里定或自拟后写入"，`prepare_book_plan` / `adopt_book_plan` 说明同步；`tool-contracts.json`、`canon.ts` 已重新导出。

验证：Rust `agent_` 系列 290 通过；Python 305 通过、56 跳过；`pnpm check:contracts` 无漂移。改前文件备份在 `easy-writing-direct-delivery-backup-20261018-151039/before-opening-flow-cards/`。未做真模型验收；发卡仍取决于规划模型的工具调用能力。

### 2026-10-19 上午：书名候选直接列成选项；草案回填版本冲突交回模型

真跑开书流程（都市高武 → 起点卡 → 草案 → “下一步”卡选定书名）发现两处：

1. 模型保存书名候选后，用 `compare` 并排对比卡指向这一份候选名单成果；宿主按对比卡规则给没写选项的卡生成“采用「书名取名候选」”唯一选项，作者挑不了具体书名，要再“继续”一步模型才出真正的选择卡。
   - 契约：`AuthorPrompt.artifactIds` 改为 `min_length=2`（compare 并排 2–4 份成果），工具边界用 `invalid_arguments` 退回只指一份成果的对比卡；宿主 `agent_prompt::normalize` 对这种卡不再生成“采用”单选项（契约不合法退回只能打字的卡）。
   - 说明：`ask_author`、`save_name_candidates` 文档写明“一份成果里的候选让作者挑用 choice，options 直接列候选名”；新书期包装 v5“让作者挑”、开书定位 v9“定书名”同步。
2. 作者在面板改过草案（版本 0→1），模型拿旧版本号回填书名，`agent_book_plan::save` 以硬错误“草案已被作者修改”中断整次运行、会话转失败。
   - 改为结构化失败：版本不符 `plan_revision_stale`（details 带当前 revision，recoveryTool read_artifact）；已采用的草案 `plan_not_editable`（改书名用 update_book）。类型或会话不符仍是硬错误（工具边界已先挡）。
   - `prepare_book_plan` 说明与开书定位 v9“容易出的问题”写明回填前 read_artifact 取当前版本。

验证：Rust `agent_` 291 通过（新增 `editing_a_book_plan_on_a_stale_revision_is_returned_to_the_model_not_fatal`，扩展引导卡规范化测试）；Python 306 通过、56 跳过、1 例预先排除（新增 `test_a_compare_card_needs_at_least_two_artifacts`）；`pnpm check:contracts` 无漂移。改前备份：`../easy-writing-direct-delivery-backup-20261018-151039/before-name-choice-card/`。未做真模型验收。

### 2026-10-19：接通八步开书并完成原生平台验证

- 补齐 `AgentBookPlanProgress`、准备面板传参、建书按钮与自动保存回执。作者修改后先清除旧建书资格，采用宿主返回的新进度；保存过程中的旧回执不能覆盖新编辑。旧准备表在读取时重新计算进度，无需改写历史记录。主角姓名、目标与人物表字段同步编辑。
- 保留八步流程技能、作者决定与模型建议的区分，以及建书时写入人物、设定、作品简介和第一卷简介的实现。补齐界面文案和工具契约，修正新增测试缺少运行状态的问题，增加编辑、版本交错与旧记录读取回归。
- 原生开发版使用平台现有 `deepseek flash`，从普通开书输入、方向选择、主角决定、开头选择、定名到点击“建好这本书”，建立《我在旧城补封印》；随后只发送“先写第一章给我看看。”，首章自动保存为版本 1。实查 3 个人物、4 条设定、简介和第一卷简介均已写入，重启后可恢复并打开正式正文。
- 真实运行暴露记忆摘要问题：同一正式来源能拆成多条、合并后超出 1200 字；改为每份来源唯一且必答的摘要字段（无内容需明确返回 null），不截断或丢弃后续内容。同时将 nullable 字段的笼统 `anyOf` 错误展开为具体字段、上限和实际长度。修复后仅通过界面重试记忆整理，剩余来源已完成；首轮正文与正式正文逐字一致，没有重生成或手工改稿。
- 验证：前端类型与 lint、契约检查通过；前端 536 通过、1 跳过；Rust 376 通过、18 忽略；Python 310 通过、56 跳过。原生页面未见框架错误，控制台仅有 Vite 连接消息。上述验证证明流程与保存可用，不作为真人感质量证明。

本轮源码和开发库备份、首轮结果及最终核对记录位于 `../easy-writing-book-launch-repair-20261019-104909/`。现有作品未改动；测试会话、新书和首章保留供检查。

### 2026-10-19：概念调整记录（以下流程放宽已撤销）

更正：下面曾将概念修正扩大为流程变更，现已对照修改前备份恢复八步顺序、榜单三选一、主角与人称确认、开篇选择以及建书前的决定完整性检查。仅保留准确术语、概念分离、来源区分和既有数据兼容；不再默认第三人称或仅凭书名放行建书。

- 八阶段统一为题材定位、故事构思、人物设定、世界观设定、剧情大纲、开篇章纲、书名与简介、创建作品。整体文档称“开书方案”；系统提示、工具说明、五份相关技能、契约与界面同步。阶段表示内容进度，不再规定每步必须提问。
- 已选故事及版本快照附在方案上，补充方案时继承未改字段；新任务不继承旧任务的故事选择。人物目标、动机、长期目标分开；故事卖点作为方案说明，不再强制选择；姓名、目标、开篇可待定。创建仍检查书名、授权与版本。
- 人称移入可折叠的写作偏好，值限定为第一或第三人称，视角和故事基调单列。新书未指定时暂用第三人称并标为 AI 建议，已有作品沿用设置。旧版混合叙述说明原文保留，不把不明确的旧设定强行归入某个人称。
- 文风要求需要作者原话依据；无依据的新模型设置保留为可调整的 `styleSuggestions`，不升级为作者要求。旧作品原有设置保持兼容。
- 实测中记忆批处理被一份超长摘要连带阻断：现在独立校验来源，合格摘要正常保存，只重试失败来源。大纲摘要上限由宿主按原文长度的一半计算，最低 1200、最高 4000 字；其他来源维持 1200 字，总记忆上下文预算不变。生成、持久化和编辑使用同一限制，源指纹、引文与权限检查保留，不裁剪结果。
- 原生开发版使用平台现有 deepseek flash，以同一正常输入验证。最终会话只经过“请求故事方案 → 选择完整故事 → 明确创建”三次创作输入，未出现额外问答卡，建成《焚骨追凶》，保留未定事项；人称、视角和基调分开保存，平台文风建议未写成作者要求。后台恢复未修改故事及资料；最终大纲摘要 1729 字，宿主上限 1994 字，记忆处理完成。

验证：前端类型、lint、契约及开发构建通过；前端 537 通过、1 跳过；Rust 379 通过、18 忽略；Python 315 通过、56 跳过。上下文压缩统计统一排除实时资料注入，避免把请求附加数据误计为“压缩后对话增加”。

源码与数据库备份、首次失败案例、恢复记录及最终核对结果位于 `../easy-writing-concept-flow-20261019-140209/`。已有作品与正文未改变；未发布正式版本，未做 Windows 真机验证。模型自然语言仍可能有不严谨表述，流程验证不代表作品质量已获证明。
