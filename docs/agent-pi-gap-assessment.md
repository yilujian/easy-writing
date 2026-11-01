# Agent Pi 现状与差距评估

评估日期：2026-10-21。对应[首阶段开发计划](agent-pi-development-plan.md)的 G1，范围是已有作品的读资料、写新章或改稿、预览编辑及确认保存。

后续 G2 已完成，架构选择见 [架构评审](agent-pi-architecture-review.md)。本文保留 G1 当时的实现、缺陷与验证记录，未代表问题已修复。

后续第一批已处理 D01–D04，第二批已处理 D05–D07 并补齐公共目录迟到更新保护，第三批已完成 N1 新章节候选与确认创建，第四批已完成 N3 主窗口关闭/菜单退出协调，第一阶段连续收尾已补恢复维护边界、真实模型/长上下文验证及 N4 可重复验证入口，并完成 J5/J7/J8 对应的本轮核对，详见 [实现进展](../agent-pi/README.md)。现行回归包括 tests/agent-pi-lifecycle.test.ts、tests/agent-pi-adoption*.test.ts、tests/pi-catalog-concurrency.test.ts 及 src-tauri/src/pi*_tests.rs。下方 G1 诊断保留当时错误行为的断言，不作为修复后的验收用例。

**结论：保留完整 Pi 和现有独立接入方向；重点调整运行控制、取消传播、草稿界面回读与正式保存的一致性；新增确认后建章能力及相关恢复保障。当前证据不支持整体重写底座，也不支持直接进入完整业务验收。**

本次没有修改业务代码。下文区分源码事实、隔离复现结果和待桌面实测内容；G1 完成不代表架构评审或功能验收完成。

## 1. 基线与实际调用链

- HEAD 为 d806378ba088e937f04ba33a7d597dfd9883e402，工作区存在此前的修改和未跟踪文件。对 638 个代码、配置及相关测试文件记录内容哈希，本轮核对无变化。
- 上游锁定 Pi 1.3.0、提交 48c8f322844087ff6cd80885f093ad44557647d1。使用前序任务保留的源码压缩包，确认 SHA256 与锁文件一致；比较 coding-agent/src、agent/src、ai/src 及根依赖清单/锁文件，共 471 个原档案文件，无差异。此比较不覆盖新增生成数据、全部依赖或构建输出。
- 当前是固定完整源码加易创扩展；未发现上述范围内有 Pi 核心改写。上游缓存被 Git 忽略，未来修改核心时需保存可追踪补丁或分支，不能只改缓存。

实际调用关系：

    界面控制：AgentPi 页面 → Pinia 工作区 → Tauri PiHost → Pi 原生 RPC
    工具执行：Pi 扩展 → 本机 HTTP → PiHost → 主窗口事件 → 工作区监听 → 平台工具 → 平台存储
    正式采用：作者确认 → 工作区 adopt → applyPiDraft → 历史 / 正文 / 目录元数据 / 草稿回执

正式采用没有再次经过模型。桌面平台工具通过现有存储适配访问 SQLite；本轮诊断使用 fake IndexedDB，不能作为真实桌面数据库验收。

Pi 直接执行链没有引入旧 Agent 的执行器、任务调度或 Python 运行时。但应用关闭仍由共享 App.vue 调旧 Agent 的 prepare_close 协调；当前 Pi 只在应用 Exit 时调用 stop_all，不能宣称全部生命周期已独立完成。

## 2. 明确保留的部分

“保留”表示沿用实现与职责，不代表所有异常情形已验收。

| 编号 | 保留内容 | 依据与边界 |
| --- | --- | --- |
| K1 | 完整 Pi 运行时、原生 RPC、会话 JSONL、扩展与 Skill 机制 | 上游源码基线核对无相关核心改写；真实 Pi 加模拟模型冒烟通过。沿用上游循环、取消与会话能力。 |
| K2 | 独立菜单、路由、Pi 进程及配置/会话目录 | navigation.ts:20、router/index.ts:36、pi_host.rs:58–64,386–408。保持与旧 Agent 分开，不迁入旧编排。 |
| K3 | 应用级 Pinia 会话和事件接收机制 | use-pi-workspace.ts:13,180–207、index.vue:332–336。隔离组件测试证实卸载页面后仍能接收事件，重进没有重复监听或关闭进程。R9 已有基础，无需从零实现后台任务系统。 |
| K4 | 平台书库、目录、正文、参考资料接口及模型配置来源 | platform-tools.ts:1–8,29–64、pi_host.rs:154–190。Pi 选择使用专属偏好键；平台模型本身仅声明 OpenAI compatible 协议，不把缺少其他原生协议误算为本阶段缺陷。 |
| K5 | 候选稿与作者确认分离，采用不重新生成正文 | platform-tools.ts:119–165、use-pi-workspace.ts:319–329。已有 6 项工具测试覆盖基本候选、人工修改保护、重复采用等行为。 |
| K6 | 既有存储版本比较、正文格式转换、历史能力和维护锁 | SQLite 正文使用条件 UPDATE 比较版本；维护锁保护数据恢复期间的写入。单条正文更新的原子性不能扩大为整次采用的原子性。 |

Pi 的 RpcClient 使用 Node child_process，不能直接放进 Vue WebView 替换 Tauri 通信。Rust 跨进程桥有必要；复用 Pi 不意味着删除全部桥接代码。[锁定版本 RPC 文档](https://github.com/earendil-works/pi/blob/48c8f322844087ff6cd80885f093ad44557647d1/packages/coding-agent/docs/rpc.md)

## 3. 需要调整的部分

| 编号 | 调整对象 | 证据与差距 | 后续处理边界 |
| --- | --- | --- | --- |
| J1 | 请求超时与运行状态 | D02：已收到 agent_start 后，prompt 回执超时仍把 running 清为 false。D03：clear_queue 超时后不再发送 abort。use-pi-workspace.ts:57–75,243–274。 | 修正未知执行结果处理和取消指令依赖顺序，沿用 Pi 生命周期，不增加模型循环。 |
| J2 | 工具取消的跨层传播 | D04：平台请求开始但未写入时停止，停止返回后仍能落候选。AbortSignal 仅传给 fetch；Rust 取消等待回执，前端执行没有取消标识。yichuang.ts:69–77、pi_host.rs:225–228,302–307、use-pi-workspace.ts:181–194。 | 定义平台操作取消边界、迟到结果和提交确认。复现的是候选写入，不能据此说正式正文被自动修改。 |
| J3 | 返回页面后的草稿初始化 | D01：Store 中候选保留，重新挂载同一草稿时文本框为空；监听只在 id/appliedAt 变化时赋值，缺少首次同步。index.vue:219–222,322–324。 | 修正视图回读及编辑缓存生命周期，保留布局，不重做 UI。 |
| J4 | 正式采用的一致性、版本与目标校验 | D05–D07：历史重复、章名并发覆盖、已移入回收站作品仍可采用，见第 4 节。platform-tools.ts:167–273。 | 保留平台数据格式；整体设计业务提交与恢复，避免逐项加补丁。 |
| J5 | 协议类型和工具定义 | PiEvent 的 type 为任意字符串，data/args 为宽泛对象；工具名散落在扩展、Rust 白名单、启动参数、界面文案中，缺少一致性检查。agent-pi.ts:32–58、yichuang.ts:83–150、pi_host.rs:20–41,402。 | 对照锁定版本的原生类型和工具 Schema，减少手写契约漂移；宿主权限白名单仍有独立职责。 |
| J6 | 会话元数据读取和进程重开 | Rust 自行扫描 JSONL；Pi 有 SessionManager.list，但 RPC 无等价的全会话列表命令，平台还需要作品绑定。当前切会话重开进程，作品和模型通过环境固定。 | G2 比较受控元数据读取与 Pi 侧提供元数据的成本；不能认定现有解析全部冗余，也不能直接启用 switch_session 而忽略作品绑定。 |
| J7 | 构建可重现性及错误诊断 | 源码和 npm 依赖有锁；setup 仍运行含在线目录请求的模型目录生成脚本，未验证全新环境重建。宿主丢弃 stderr，仅报通用退出信息。 | 核对构建输入；保留脱敏、可定位的错误。无需新增监控平台或正式发行流水线。 |
| J8 | 模型与资料规模适配 | 扩展固定文本输入、reasoning:false，另把平台 thinking/extraParams 写入请求；资料当前整包返回。真实供应商、大资料和长历史未验证。 | 确定模型及验收材料后核对必要兼容行为；不把猜测写成供应商故障，不自动新增多协议或向量检索。 |

应避免一项误判：锁定 Pi 版本的 isStreaming 表示完整活动运行，isIdle 的实现就是 !isStreaming && !isCompacting。不能仅看到前端查询这两个字段就断言遗漏重试状态；本轮证实的问题是 J1 的超时分支和 J2 的取消传播。

## 4. 已隔离复现的缺陷

以下是当前源码上的诊断结果。通信模拟、组件 happy-dom 和 fake IndexedDB 用于控制时序；真实 Rust/SQLite 桌面复现留在集成验证阶段。

| 诊断 | 触发方式 | 观察结果 | 对应验收 |
| --- | --- | --- | --- |
| D01 | 打开候选，卸载页面，再带同一 Store 和同一草稿返回 | Store 正文仍在，编辑框为空 | A8、A10 |
| D02 | 运行开始事件已到，命令回执超过 20 秒未返回 | 前端显示不再运行，没有发送停止 | A7、A9 |
| D03 | 点停止时，清空队列命令回执超时 | 只发出 clear_queue，未发出 abort | A7、A9 |
| D04 | 暂停已接收请求的只读前置步骤，完成停止后解除暂停 | 新候选仍写入，当前草稿列表尚未同步 | A7、A8 |
| D05 | 历史已保存，正文保存前注入失败，再重试 | 同一份原文历史出现两条 | A5、A9 |
| D06 | 正文保存完成、目录元数据提交前，模拟作者改章名 | finalizeDraft 覆盖并发修改的章名 | A6、A9 |
| D07 | 生成候选后将作品移入回收站，再采用 | 正文仍被修改；章节分支没有像大纲分支一样检查作品 deletedAt | A1、A6 |

D05/D06 的 SQLite 对应实现也分别写历史、正文、目录和回执；D07 的 SQLite 目录读取也不按书籍 deletedAt 拦截，具有一致的源码风险，但本轮未把 IndexedDB 结果冒充 SQLite 实测。

现有“正文已保存但回执未写完”的内容/版本比对恢复路径应保留其意图。它只覆盖特定中断点，不能替代完整采用的一致性设计或持久化操作身份。

## 5. 需要新增或补齐的能力

| 编号 | 能力 | 当前缺口 | 复用基础 |
| --- | --- | --- | --- |
| N1 | 新章节候选及确认后建章 | PiChapterDraft 强制 chapterId/baseVersion，工具要求先读既有章；没有新章节候选、卷/位置目标及确认建章分支。 | 既有书库目录、createLocalChapter、排序和正文存储接口；不新建作品库。 |
| N2 | 一次采用的完整提交与恢复 | applying Map 只在本进程内防并发；草稿有 appliedAt，但历史/正文/目录/回执不是同一提交。新章不能只串联建章和正文保存。 | SQLite 事务及 compare-write 能力。通用 SQL 事务目前不检查每条更新影响行数，不能认为批量执行便解决业务冲突；G2/G3 决定最小业务入口与操作身份方案。 |
| N3 | Pi 与共享关闭流程协调 | 旧 Agent 的 prepare_close 不计入 Pi，Pi 停止发生在最终 Exit，缺少停止/保存收尾协议。 | 沿用共享关窗和备份流程，补 Pi 协调点；按已确认的“提示后停止并保存再关闭”设计，不改变旧 Agent 规则。 |
| N4 | 可重复的阶段验收与故障用例 | 现有 6 项工具测试未覆盖这 7 项缺陷；原生验证页使用固定端口和临时输出路径。 | 复用本轮诊断夹具、冒烟和现有框架；按原约定保留本地测试，不自行改测试入库政策。 |

N2 是平台写入边界补齐，不是新增 Agent 框架。事务/回执结构尚未定案，本轮未预先决定改表或迁移用户数据。

## 6. 精简候选与暂不处理项

- **样式精简候选明确存在。** AgentPi/style.scss 共 3,887 行，扫描到 267 个 pi- 类名，其中 256 个未在当前 AgentPi 页面源码出现，包括项目分组、资源抽屉、旧成果卡等规则。这是静态筛选，不是可直接删除的规则数。后续只精简确认无引用的样式并做视觉回归，保留现有视觉风格。
- 手写 Pi 通用事件类型、散落工具名和重复模型参数转换是收敛候选；先核对依赖与边界，不能为了减少少量适配引入更重的新宿主。
- 不删除旧 Agent、现有大纲候选、共享存储、妙笔实现或此前未提交修改。没有证据支持整目录清理或重写。
- 全量会话备份、运行中换模型、并发多任务、其他业务工具及正式发布仍按原计划逐项确认。

## 7. 需求覆盖与评审优先级

| 需求 | 当前判断 |
| --- | --- |
| R1 完整 Pi 复用 | 方向与源码基线成立，必要桥接保留；J5–J7 待评审 |
| R2–R3 隔离与原功能保护 | 直接执行链隔离成立；共享关闭边界需协调；真实桌面回归未完成 |
| R4 资料读取 | 基础工具存在；目标校验、资料规模和真实模型选工具行为待补 |
| R5–R7 写/改、确认及数据保护 | 既有章主流程存在；新章缺失；D05–D07 阻止判定写入边界完成 |
| R8 停止与任务边界 | Pi 原生取消冒烟通过；D02–D04 阻止判定整条停止链路完成 |
| R9 切页继续 | Store/监听基本机制成立；D01 使返回后完整展示尚不合格；真实桌面待验证 |
| R10 持久化与恢复 | JSONL 和平台候选存在；退出协议、完整采用恢复待补 |
| R11 保留旧版、暂不发布 | 本轮遵守；未改发布配置或旧功能代码 |

G2 优先评审两条边界：**运行/取消如何到达平台操作**，以及**作者确认如何成为一次可判定结果的业务提交**。随后处理新章节候选、返回页面同步与协议/样式精简。当前不应先叠加更多工具或整套自动化。

## 8. 验证证据与限制

| 检查 | 本轮结果 | 可证明的范围 |
| --- | --- | --- |
| 638 文件哈希基线 | 无代码/配置变化 | 未改动已记录的业务基线 |
| 471 上游文件对比 | 与校验通过的固定源码档案一致 | 已核对范围没有另写或修改 Pi 核心 |
| node agent-pi/scripts/smoke.mjs | 通过 | 真实 Pi + 模拟模型/平台下，候选工具、基础停止与会话落盘可用 |
| pnpm exec vitest run tests/agent-pi-tools.test.ts | 6 项通过 | 既有测试覆盖的正常与部分冲突流程 |
| pnpm --dir agent-pi check | 通过 | 扩展类型检查，不是全项目检查 |
| 本轮隔离诊断 | 8 项断言成立：7 项缺陷复现、1 项切页机制验证 | 诊断绿色代表问题成功复现，不代表 7 项功能合格 |

未执行真实模型、真实桌面 SQLite 全流程、Windows/Linux、全新环境构建及全量回归。未访问用户模型凭据、未修改真实作品、未打包发布。

本地证据保存在被忽略的 verification 目录，不随 Git 自动分发：

- [代码基线](../verification/pi-assessment-20261021/run-8kbwz_pm/baseline.json) · [结果汇总](../verification/pi-assessment-20261021/run-8kbwz_pm/assessment-results.json) · [上游及样式扫描](../verification/pi-assessment-20261021/run-8kbwz_pm/source-audit.json)
- [诊断用例](../verification/pi-assessment-20261021/run-8kbwz_pm/assessment.test.ts) · [诊断日志](../verification/pi-assessment-20261021/run-8kbwz_pm/diagnostics.log)
- [Pi 冒烟日志](../verification/pi-assessment-20261021/run-8kbwz_pm/existing-smoke.log) · [既有工具测试](../verification/pi-assessment-20261021/run-8kbwz_pm/existing-tools.log) · [扩展类型检查](../verification/pi-assessment-20261021/run-8kbwz_pm/extension-types.log)

复现命令：

    pnpm exec vitest run --config verification/pi-assessment-20261021/run-8kbwz_pm/vitest.assessment.config.ts --reporter=verbose

## 9. 产品决策与后续边界

本轮用户已确认：

- **D1：** Pi 任务运行时关闭主窗口，先提示确认，停止任务并完成必要保存后关闭。保留已落盘会话和草稿，彻底退出后不自动续跑；保存收尾不代表自动采用候选到正式正文。
- **D2：** 按作者指令确定已有卷，默认追加卷末；归属不明确先询问，保存前展示目标。

D3 验收平台、真实模型及预算按计划在 G4 确认，本轮评估不需要真实模型调用。其他技术未知点交给 G2/G3 评审或定向验证，不把未经验证的实现路线默认为结论。

本轮只完成 G1；未开始业务代码修改。具体模块拆分、接口及数据结构需在后续架构和契约评审确定。

## 源码入口

- [Pi 宿主](../src-tauri/src/pi_host.rs) · [Pi 扩展](../agent-pi/extensions/yichuang.ts) · [源码构建脚本](../agent-pi/scripts/setup.mjs)
- [工作区 Store](../src/views/AgentPi/use-pi-workspace.ts) · [界面](../src/views/AgentPi/index.vue) · [样式](../src/views/AgentPi/style.scss)
- [平台工具与采用](../src/agent-pi/platform-tools.ts) · [本地类型](../src/types/agent-pi.ts)
- [SQLite 书库](../src/storage/sqlite-local-library.ts) · [SQLite 正文](../src/storage/sqlite-writing-storage.ts) · [桌面存储事务](../src-tauri/src/desktop_storage.rs)
- [主窗口关闭](../src/App.vue) · [应用生命周期](../src-tauri/src/lib.rs) · [旧 Agent 关闭协调](../src-tauri/src/agent_host.rs)
