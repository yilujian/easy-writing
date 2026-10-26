# 听书功能开发计划（草案）

> 状态：已实现（系统朗读 + 云端朗读 + 设置页 + 音色试听；角色多音色、音频导出仍属后续项），待 Windows/macOS 原生 WebView 实机验收  
> 产品决定：不做全局悬浮迷你播放器。整本连续播放只在独立听书页；写作台只在状态栏就地朗读当前章（读完即停），换章或离开写作台/听书页都暂停并落盘位置（2026-10-26）。  
> 更新日期：2026-10-26  
> 实现记录：本机已完成 TypeScript 类型检查、ESLint、生产构建、完整本地回归（12 个文件 76 项，含听书 47 项、桌面迁移/备份/Agent 恢复 29 项）、主题对比度检查，并在 Chrome 中验证播放/暂停/自动下一章/断点续听/云端 TTS/缓存/设置页；写作页就地朗读另做保存后刷新与切章取消的回归。Rust/uv 与原生打包环境见 `docs/handoff-2026-10-26.md`，本轮未执行安装包验收。  
> 适用范围：桌面端优先，浏览器开发模式可用  
> 建议排期：MVP 4 周；含云端朗读 6–7 周（1 名熟悉 Vue/Tauri 的前端 + 兼职测试）

## 1. 结论摘要

先做一个**不依赖云端、打开就能听**的 MVP：

1. 从「我的作品」进入独立听书页，按卷/章连续播放自己的作品；
2. 当前句高亮、自动滚动、点击句子跳转，支持上一句/下一句、上一章/下一章；
3. 记住每本书的收听位置，退出重进、重启应用后继续；
4. 语速、音色、音量、自动下一章、睡眠定时可调并持久化；
5. 朗读引擎做成可替换接口，首版使用系统自带语音（Web Speech API），第二阶段再接 BYOK 云端 TTS。

这样做的原因：系统语音零成本、离线可用、无需用户配置，适合作为默认能力；云端 TTS 音质更好，但涉及 API Key、网络、费用和正文外发，放在 MVP 验证通过之后。

**最大技术风险**是 Tauri 各平台 WebView 对 `speechSynthesis` 的支持不一致，尤其是 Linux WebKitGTK 和没有安装中文语音包的 Windows。因此第一阶段先做 2–3 天技术验证（P0），验证不通过就调整方案，不直接进入正式开发。

## 2. 背景与目标

### 2.1 为什么现在做

- 作者写完一章后，用耳朵听一遍比盯着屏幕更容易发现重复用词、节奏拖沓和对话不自然；
- 网文作者长时间伏案，听书可以把校稿、回顾前文从屏幕前解放出来；
- 作品、章节、正文都已经在本地库中，不需要额外的内容生产链路；
- 现有应用只有打字音效，没有长文本朗读能力，听书是写作之外最自然的延伸。

### 2.2 目标

- **可听**：任意有正文的章节都能从书架直接开始听，连续播放不中断；
- **可续**：记住“哪本书、哪一章、哪一句”，恢复到一句话以内；
- **可控**：语速、音色、音量、定时、自动下一章都能调，且下次打开仍生效；
- **可降级**：没有系统语音、没有配置云端模型、章节为空、网络失败时，都有明确提示和下一步动作；
- **本地优先**：默认不联网、不上传正文；云端朗读必须由用户显式配置并知晓正文会发给服务商。

### 2.3 成功标准（以验收代替埋点）

本地优先产品不引入行为统计，用以下可验证标准衡量：

- 从书架到开始播放 ≤ 2 次点击；
- 连续播放 30 分钟无重叠、无卡死、无静音；
- 退出听书页/重启应用后，恢复位置误差 ≤ 1 句；
- 3,000 字章节从点击到出声 ≤ 1.5 秒（系统引擎，不含首次加载语音列表）；
- 10 万字、500 章的作品，章节列表打开 ≤ 300ms，切章 ≤ 500ms；
- `pnpm check`、`pnpm test`、`pnpm build` 通过，Windows/macOS 实机验收通过。

## 3. 范围

### 3.1 MVP（必须做）

- 独立听书页 `/listen/:bookId`；
- 本地作品按卷/章顺序播放；
- 播放、暂停、上一句、下一句、上一章、下一章、进度拖动；
- 当前句高亮 + 自动滚动 + 点击句子跳转；
- 音色、语速、音量、自动下一章、章节间隔、基础睡眠定时（15/30/45/60 分钟）；
- 收听位置记忆、最近收听的书；
- 空章、无语音、播放异常的处理；
- 写作页就地朗读当前章（不跳页；状态栏胶囊给播放/暂停、结束、语速与朗读设置，读完本章自动收起）；
- 设置中心「听书与朗读」页；
- 基础键盘操作与窄窗口适配。

### 3.2 第二阶段（P2，体验完善）

- 章节列表已听标记、全书进度；
- 睡眠定时增强（本章结束、淡出暂停、剩余时间）；
- 媒体键/系统媒体面板（Media Session，能力允许时）；
- 听书时自动降低/关闭打字音效；
- 更完整的无障碍与减少动态效果适配。

### 3.3 第三阶段（P3，云端朗读）

- 模型管理新增「听书朗读」分组与 `audio` 场景；
- OpenAI 兼容 `/audio/speech` 适配器；
- 音色预设、试听、连接测试；
- 分段预取、音频缓存、缓存清理；
- 隐私提示与费用提示。

### 3.4 明确不做（本计划外）

- 导出 MP3/整本音频；
- 多角色配音、对白识别、角色声线；
- 逐字高亮（依赖引擎边界事件，首版按句）；
- 语音克隆、声音复刻；
- 听书时长统计/排行榜；
- 移动端原生后台播放；
- 把音频缓存打进整包备份。

## 4. 用户场景

| 编号 | 场景 | 流程 | 价值 |
| --- | --- | --- | --- |
| S1 | 连续听自己的书 | 书架 → 作品菜单「听书」→ 从上次位置继续 → 自动下一章 | 通勤、做家务时回顾全文 |
| S2 | 睡前听 | 设置 30 分钟定时 → 播放 → 到时淡出暂停 | 不打断入睡，也不丢位置 |
| S3 | 校稿 | 写作页 →「听这章」→ 看高亮逐句听 → 发现别扭处 → 回写作修改 | 用听觉发现视觉遗漏 |
| S4 | 跳读 | 打开章节目录 → 点某一章 → 从该章开头播放 | 快速检查某段剧情 |
| S5 | 换设备/重装 | 从备份恢复后，听书偏好保留；位置允许丢失或回到章首 | 不因功能引入迁移负担 |

## 5. 现状盘点与约束

### 5.1 可复用的基础

| 能力 | 现有实现 | 对听书的用处 |
| --- | --- | --- |
| 书籍/卷/章 | `src/storage/local-library.ts`、`local-library-types.ts` | `getLocalBookDetail`、`getLocalBookTree` 取书名、封面、章节顺序 |
| 正文 | `getWritingStorage().getChapterByIdentity(LOCAL_USER_ID, bookId, chapterId)` | 取 `textContent`，按 `\n` 分段 |
| 本地身份 | `LOCAL_USER_ID = 'guest'` | 草稿键固定为 guest，不需要登录 |
| 键值设置 | `src/storage/app-settings.ts` | 存偏好、位置、诊断日志；桌面端统一进 SQLite，网页端进 localStorage |
| 全量备份 | `src/storage/full-backup.ts` | `ew-` 前缀设置会自动进备份，无需新增备份格式 |
| AI BYOK | `src/utils/local-ai-client.ts`、`src/storage/local-ai-models.ts` | P3 云端 TTS 复用密钥管理、代理请求和错误处理 |
| 主题/弹窗/按钮 | `src/styles`、`EwModal`、`ink-btn` | 听书页沿用宣纸白、墨色、赭红，不另起视觉体系 |
| 测试 | Vitest，`tests/**/*.test.ts`（仓库本地保留，不上传） | 分句、队列、进度、引擎适配的单元测试 |

### 5.2 约束

- **平台 WebView 不一致**：Windows 是 WebView2（Chromium），macOS 是 WKWebView，Linux 是 WebKitGTK；`speechSynthesis` 在 Linux 上可能不存在或没有中文音色。
- **CSP 限制**：`media-src` 只允许 `'self' blob:`，云端音频不能直接把远程 URL 塞给 `<audio>`，必须先经 Tauri HTTP 插件取回字节，再转 Blob URL。
- **自动播放限制**：浏览器/WebView 要求用户手势后才能出声；进入页面不能自动播放，必须由“开始听书/继续听”按钮触发。
- **长句稳定性**：部分平台对超长 utterance 有截断或 `onend` 不触发的问题，必须按句切分并加看门狗。
- **不能阻塞写作**：听书页是独立路由，不加载 TipTap 编辑器；从写作页进入前先走既有 `ensureWritingPersisted`。
- **不新增数据库表**：MVP 的位置/偏好放 `appSettings`，避免动 SQLite schema、迁移和备份恢复；P3 音频缓存单独设计，且不进备份。

## 6. 朗读方案选型

| 方案 | 音质 | 离线 | 成本 | 平台覆盖 | 主要风险 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 系统语音（Web Speech API） | 中；Windows/macOS 中文音色可用，Linux 取决于 speech-dispatcher | 是 | 0 | Windows/macOS 较好，Linux 不稳 | 音色依赖系统、边界事件不可靠、长句截断 | **MVP 默认** |
| 云端 BYOK（OpenAI 兼容 `/audio/speech`） | 高，取决于供应商和音色 | 否 | 用户按字符自付 | 全平台 | 需配置 Key、正文外发、延迟/限流、浏览器 CORS | **P3 增加** |
| Edge TTS 非官方接口 | 高 | 否 | 0 | 全平台 | 非公开接口，可能失效；条款与稳定性风险 | **不采用** |
| 本地神经 TTS（Piper/ONNX 等） | 中高 | 是 | 0 | 需按平台打包 | 模型 100MB+、推理性能、安装包体积 | 观察，暂不排期 |
| Rust 原生 TTS（SAPI/AVSpeech/SPI） | 中 | 是 | 0 | 需三端分别实现 | 开发量大，语音列表/暂停语义另做一套 | 仅当 P0 系统语音不可用时评估 |

**决策**：MVP 用系统语音，但所有调用都经过 `TtsEngine` 接口；P3 增加云端引擎，不改播放器和页面。若 P0 发现 Windows 上系统语音不可用或中文音色普遍缺失，则把云端引擎提前到 MVP，并相应增加约 1 周。

## 7. 产品设计

### 7.1 信息架构与入口

```
我的作品 ──作品菜单「听书」──────────> /listen/:bookId
写作页 ──底部状态栏「听书」──就地朗读当前章（不跳页）
首页「继续听」──────────────────────> /listen/:bookId

听书页 ──> 章节目录抽屉 / 音色与语速面板 / 睡眠定时
设置中心 ──> 听书与朗读
```

- **我的作品**：作品卡片右上角更多菜单新增「听书」，放在「编辑作品」之后、`导出作品`之前；没有章节的作品置灰或提示先写一章。
- **写作页**：底部状态栏（`WritingEditor` 的 `.status-right`）放一个朗读胶囊：喇叭按钮负责开始/暂停/继续，旁边依次是「结束」「语速」「朗读设置」。点击先 `snapshotLocalDraft` 把编辑器正文落盘，随后在本页就地朗读当前章，不跳路由；会话按「本章」作用域运行，读完本章自动结束并收起控制，不会顺着自动下一章读下去。点语速按钮循环档位；齿轮打开只含「听书与朗读」一页的聚焦弹窗（隐藏左侧全量导航），也不跳页；聚焦弹窗里改动即时生效，点「确定」保留、点「取消」或直接关闭则还原打开时的设置。换章或离开写作台自动暂停并保存位置。
- **首页**：P2 增加「继续听」卡片，读 `lastBookId` 与位置；没有记录时不显示。
- **设置中心**：新增 `listening` 分区「听书与朗读」，放在「写作体验」之后；改动即时生效，不走底部保存草稿。

### 7.2 听书页布局

```
┌──────────────────────────────────────────────────────────────┐
│ ← 返回     《书名》 · 第 12 章 标题          [去写作] [设置] │
├───────────────┬──────────────────────────────────────────────┤
│ 章节目录       │  正文阅读区                                   │
│ 第一卷         │  当前句以浅赭色底高亮，自动滚到视口 40% 处     │
│  第 1 章 ✓    │  点击任意句子 = 从该句开始播放                 │
│  第 2 章 ●    │  字号可调，行宽不超过 38 个汉字                │
│  第 3 章      │                                               │
├───────────────┴──────────────────────────────────────────────┤
│ 上一章  上一句  ▶/⏸  下一句  下一章   进度━━━━━  1.0x  定时  │
└──────────────────────────────────────────────────────────────┘
```

- 桌面宽屏：左侧目录可折叠，右侧正文；窄屏：目录变抽屉，底部控制栏分两行。
- 视觉沿用现有主题变量（`--ink-main`、`--ink-sec`、`--ink-accent`、`--bg-main`），背景使用当前皮肤图 + 纸纹，不新增插画或仪表盘卡片。
- 正文使用适合长读的字体（优先 `lxgw-wenkai` / 系统衬线），字号跟随用户在听书页的独立调节，不影响写作页排版。
- 当前句高亮用背景色 + 左侧短竖线，避免整段变色的“字幕感”；`prefers-reduced-motion` 下取消平滑滚动。

### 7.3 播放控制语义

| 操作 | 行为 |
| --- | --- |
| 播放/暂停 | 从当前句继续；暂停时保存位置 |
| 上一句 | 当前句播放不足 3 秒时回上一句，否则回到本句开头（与音乐播放器一致） |
| 下一句 | 立即切到下一句；本章最后一句则进入下一章 |
| 上一章/下一章 | 直接切章，默认从目标章章首开始；章末自动进入下一章时同样从章首开始 |
| 拖动进度 | 按章节内句子索引定位；拖动时暂停，松手后从目标句开始 |
| 点击句子 | 从该句开始播放；若正在播放，先取消当前语音再切 |
| 自动下一章 | 本章最后一句结束后，间隔 0.8 秒（可设 0/0.8/2 秒）自动加载下一章 |
| 全书结束 | 显示“全书听完”，提供“重听第一章/回到书架”，不自动循环 |

### 7.4 状态与提示

| 状态 | 界面 | 用户可做什么 |
| --- | --- | --- |
| 首次进入 | 显示书名、上次位置、“继续听”主按钮 | 继续 / 从头 / 选章 |
| 加载章节 | 正文区骨架，控制栏禁用 | 等待，可取消 |
| 播放中 | 当前句高亮，播放按钮变暂停 | 暂停、跳句、切章、调设置 |
| 暂停 | 保持高亮，显示“已暂停 · 第 X 句” | 继续、跳句 |
| 缓冲（云端） | 播放按钮转圈，显示“正在准备语音…” | 等待、取消、切句 |
| 空章 | “这一章还没有正文，写完再来听吧。” | 下一章 / 回目录 |
| 无系统语音 | “系统里没有可用的中文语音。可以安装系统语音包，或配置云端朗读。” | 打开系统设置说明 / 去配置云端 |
| 云端未配置 | “还没有配置云端朗读模型。” | 去模型管理 |
| 播放失败 | 行内错误条 + 重试；连续 3 次失败自动暂停 | 重试 / 跳过本句 / 切章 |
| 全书听完 | 完成态插画（简洁墨色）+ 统计（共 N 章） | 重听 / 回书架 |

错误文案要具体到下一步，不显示“未知错误”。例如：

- 401：“API Key 无效，请到「模型管理」检查。”
- 404：“该服务不支持 /audio/speech，或模型名/地址填错。”
- 429：“请求过于频繁或额度不足，请稍后再试。”
- 网络失败：“无法连接朗读服务。桌面版可绕过浏览器跨域限制。”

### 7.5 键盘与无障碍

- `Space` 播放/暂停；`←/→` 上一句/下一句；`Shift+↑/↓` 音量 ±5%；`Esc` 依次关闭设置抽屉、退出专注模式，再离开听书页（离开即暂停并落盘位置）。
- 焦点在输入框、按钮、抽屉内时不劫持快捷键；正文句子上用 `↑/↓/Home/End` 在句子之间移动焦点。
- 进度条用原生 `<input type="range">`（自带 slider 语义）并补 `aria-label`、`aria-valuenow` 与可读的“第 X 句，共 Y 句，章节进度 N%”。
- 章节切换用 `aria-live="polite"` 播报一次，不要每句都播报。
- 所有图标按钮有 `aria-label` 和可见焦点；触控目标 ≥ 40×40。
- 支持 200% 缩放、360px 窄窗口、减少动态效果。

## 8. 技术设计

### 8.1 分层

```
┌────────────────────────────────────────────┐
│ ListenView（展示与交互）                   │
├────────────────────────────────────────────┤
│ useListeningStore（Pinia：会话、队列、进度）│
├────────────────────────────────────────────┤
│ PlaybackController（代际令牌、预取、错误）  │
├──────────────────┬─────────────────────────┤
│ SystemSpeechEngine│ CloudSpeechEngine(P3)  │
├──────────────────┴─────────────────────────┤
│ ChapterScriptBuilder（清洗 → 分句 → 偏移）  │
├────────────────────────────────────────────┤
│ 本地书库 + 正文草稿 + appSettings           │
└────────────────────────────────────────────┘
```

原则：

- **播放状态不放在组件里**。组件只读 store、发动作；这样页面切换和设置页共用同一份播放状态，不需要重写播放逻辑。
- **一次只有一个引擎实例、一个在播句子**。所有异步操作带 `generation` 令牌，切章/暂停/退出时递增；旧请求返回后直接丢弃，避免“上一句还在读，下一句又响起来”。
- **页面不直接碰存储**。章节加载、进度读写都走 `src/listening/` 下的适配层，便于测试和替换。

### 8.2 引擎接口

```ts
// src/listening/engine/types.ts
export type TtsEngineId = 'system' | 'openai-speech'

export interface TtsVoice {
  id: string            // 引擎内稳定标识；系统引擎用 voiceURI
  name: string
  lang: string          // 'zh-CN' / 'zh-TW' / 'en-US'
  engine: TtsEngineId
  local: boolean
}

export interface SpeakOptions {
  text: string
  voiceId: string
  rate: number          // 0.5–2.0
  pitch: number         // 0.5–2.0，系统引擎不支持时忽略
  volume: number        // 0–1
  signal: AbortSignal
}

export interface TtsEngine {
  readonly id: TtsEngineId
  isAvailable(): Promise<boolean>
  listVoices(): Promise<TtsVoice[]>
  /** 朗读一段；正常结束 resolve，取消/失败 reject（AbortError 单独识别） */
  speak(options: SpeakOptions): Promise<void>
  pause(): boolean
  resume(): boolean
  stop(): void
}
```

引擎实例在创建时注入当前配置（云端包含 `modelCode`、`voice`、`format` 等），`speak` 只负责“这一句怎么读”。云端引擎额外提供 `prefetch(segment, options)`，系统引擎不实现预取。

### 8.3 系统朗读引擎

- `speechSynthesis` + `SpeechSynthesisUtterance`，逐句 `speak`，不把整章塞进一个 utterance。
- `getVoices()` 首次可能为空：监听 `voiceschanged`，2 秒超时后重试一次；设置页提供“刷新音色”按钮。
- 音色优先 `lang` 以 `zh` 开头，默认挑中文女声（如 Xiaoxiao/Huihui/Tingting/Meijia），没有中文音色时列出全部并给出警告。
- `voiceURI` 作为稳定 id；找不到时按 `name + lang` 回退。
- 看门狗：按“字数 / 语速”估算时长，加 5 秒余量；若既没有 `onend` 也没有 `onerror`，取消并重试一次，仍失败则报错。重试前检查 `speechSynthesis.speaking`，避免真的还在读时叠音。
- 暂停/恢复：优先 `speechSynthesis.pause()/resume()`；若平台不生效（通过 `paused` 状态和计时判断），降级为“取消当前句，恢复时从本句开头重读”，并在界面提示“从本句开头继续”。
- 停止/切句：`cancel()` 后 reject 当前 Promise，所有旧 Promise 由 `generation` 丢弃。
- 不依赖 `onboundary` 做逐字高亮；中文音色的边界事件不可靠，首版按句。

### 8.4 云端朗读引擎（P3）

请求（OpenAI 兼容）：

```http
POST {baseUrl}/audio/speech
Authorization: Bearer {key}
Content-Type: application/json

{
  "model": "gpt-4o-mini-tts",
  "input": "当前句文本",
  "voice": "alloy",
  "response_format": "mp3",
  "speed": 1.0
}
```

实现要点：

- 复用 `local-ai-client.ts` 的请求方式：桌面端走 `@tauri-apps/plugin-http`，网页端走浏览器 `fetch`，错误文案区分 CORS；`resolveAiFetch` 目前是模块内私有函数，需要导出或抽到共享模块后再复用。
- 复用 `getLocalAiModelSecret(modelCode)` 取 Key；Key 不进入 Pinia、不写日志、不进错误信息。
- 响应按 `arrayBuffer()` 读取，校验非空、Content-Type 以 `audio/` 或 `application/octet-stream` 开头，再 `URL.createObjectURL(new Blob(...))` 播放。
- 单个 `<audio>` 元素复用，切句时先 `pause()` 再替换 `src` 并 `revokeObjectURL` 旧地址；语速优先用请求里的 `speed`，若该供应商不支持（适配器标记 `supportsSpeed=false`），再用 `audio.playbackRate` 兜底，避免双重变速。
- 预取后 2 句；最多 2 个并发请求；切章/暂停时 `AbortController.abort()`。
- 429/5xx 退避重试 1 次（500ms），仍失败则展示错误；连续 3 次失败自动暂停，避免刷爆额度。
- 浏览器 CORS：与现有 AI 功能保持一致，提示“该服务商不允许浏览器直连，请使用桌面版”。
- 隐私：设置页和首次启用时明示“使用云端朗读时，章节正文会发送给你配置的模型服务商，并按字符计费”。

### 8.5 文本清洗与分句

`ChapterScriptBuilder` 输入 `textContent`，输出：

```ts
export interface SpeechSegment {
  index: number
  text: string          // 实际交给 TTS 的文本（可含词典替换）
  displayText: string   // 页面展示/高亮用，保持原文
  start: number         // 在清洗后正文中的起始偏移
  end: number
  paragraphIndex: number
  kind: 'title' | 'body'
}

export interface ChapterScript {
  chapterId: number
  title: string
  text: string
  segments: SpeechSegment[]
  textLength: number
  signature: string     // 轻量哈希，用于判断正文是否改动
}
```

处理步骤：

1. 统一换行，去掉 BOM、零宽字符、行尾空白；连续 3 个以上空行压成 2 个；保留段落分隔。
2. 段落优先用 `Intl.Segmenter('zh', { granularity: 'sentence' })` 分句；不可用时用标点正则，并跟踪中英文引号深度，避免在 `“……”` 内部误切。注意项目 `tsconfig` 的 `lib` 是 `ES2020`，使用前需补 `es2022.intl` 类型（或在模块内做类型声明与运行时能力检测）；`Intl.Segmenter` 初切后仍要用规则修正引号内标点和省略号。
3. 合并过短句（< 12 字）到相邻句；超过 120 字的句子在 `，、；：` 处再切，仍超长则硬切 120 字。
4. 去掉纯标点/空白段；段首全角缩进不进入 TTS 文本，但保留在展示文本中。
5. 可选把章节标题作为第 0 句（设置项，默认开启）；若正文开头重复标题，跳过重复。
6. 记录每个 segment 的 `start/end`；合并/切分后用 `indexOf` 在该段内定位，保证偏移单调、可回跳。
7. 3,000 字章节应在 50ms 内完成；超过 2 万字的超长章可分片构建，避免首屏卡顿。

典型测试用例：`“他说：‘走吧。’”`、省略号 `……`、破折号 `——`、中英混排、数字/单位、无标点长段、空章、只有标题的章、CRLF、全角空格缩进。

### 8.6 播放状态机与队列

```
idle ──openBook──> loading ──ready──> playing ⇄ paused
                      │                 │
                      └──error──> error └──last segment──> ended
```

- `status`：`idle | loading | playing | paused | buffering | ended | error`。
- `chapterIndex` + `segmentIndex` 是唯一播放坐标；任何跳转都先 `stopCurrent()`、递增 `generation`、再 `speak()`。
- 章节队列来自 `getLocalBookTree(bookId)` 展平；卷只用于目录展示，不参与播放。
- 自动下一章最多连续跳过 3 个空章；超过则暂停并提示“后面几章还没有正文”。
- 手动“下一章”不跳过空章，直接显示空章状态。
- 切章后先构建脚本，再恢复位置（如果位置属于该章），否则从章首开始。
- 听书页离开：暂停并保存位置。

### 8.7 位置记忆

```ts
// src/types/listening.ts
export interface ListeningPosition {
  bookId: string
  chapterId: number
  chapterTitle: string
  segmentIndex: number
  charOffset: number       // 清洗后正文偏移
  textLength: number
  signature: string
  snippet: string          // 当前句前 16 字，用于正文改动后重定位
  updatedAt: number
  finished?: boolean
}
```

- 存储键：`ew-listening-positions`，结构 `Record<bookId, ListeningPosition>`。
- 写入时机：每句开始后 2 秒防抖写一次；暂停、切章、页面隐藏、退出应用时立即写并 `flushAppSettings()`。
- 恢复：读记录 → 加载该章 → 校验 `signature`/长度；不一致时用 `snippet` 在该章查找，找不到则从本章开头开始，并提示“正文有改动，已从本章开头继续”。
- 保留策略：180 天未更新或超过 100 本书记录时清理最旧记录；写时顺带 prune，避免无限增长。
- 额外保存 `lastBookId`（单独键或设置字段），供首页“继续听”。

### 8.8 偏好设置

```ts
export interface ListeningSettings {
  engine: 'system' | 'openai-speech'
  voiceId: string
  voiceName: string          // voiceURI 失效时的回退
  rate: number               // 0.5–2.0，默认 1.0
  pitch: number              // 0.5–2.0，默认 1.0
  volume: number             // 0–1，默认 1.0
  autoNextChapter: boolean   // 默认 true
  chapterGapMs: 0 | 800 | 2000 // 默认 800
  sleepTimerDefault: 'off' | '15' | '30' | '45' | '60' | 'chapter' // 默认 off
  readChapterTitle: boolean  // 默认 true
  cloudModelCode: string     // P3
  cloudVoice: string         // P3
  cloudFormat: 'mp3' | 'wav' // P3
}
```

- 存储键：`ew-listening-settings`，读写走 `normalizeListeningSettings()`，越界值 clamp，未知值回落默认。
- 设置页改动即时生效并写盘；播放中的语速/音量变更作用于下一句（系统引擎无法安全改当前 utterance）。
- 切换引擎时保留各自的音色选择（系统用 `voiceId`/`voiceName`，云端用 `cloudVoice`），避免来回切丢配置。

### 8.9 音频缓存（P3）

- 缓存键：`SHA-256(engine|model|voice|format|speed|text)`；文本相同、参数相同才命中。
- 内存 LRU 保留最近 20 段，切章后可立即重播；磁盘缓存默认上限 200MB，LRU 淘汰。
- 存储位置：独立 IndexedDB `ew-listening-audio`（仅缓存，非用户数据），**不加入** `full_backup.ts` 的 `IDB_STORES`；设置中心「存储空间」增加“朗读缓存”占用与清理按钮。
- 若团队要求所有数据统一进 SQLite，则改为 Rust 文件缓存（`app_cache_dir/tts/<hash>.mp3`）并提供 `tts_cache_stat/clear` 命令；不要在 `desktop_store` 里存大音频 Blob，避免数据库膨胀和备份变慢。
- 缓存清理、书籍彻底删除时不要求联动删除（键与书无强关联），但“清空朗读缓存”必须立即释放 Blob URL。

## 9. 数据与存储

| 键/位置 | 内容 | 是否进备份 | 说明 |
| --- | --- | --- | --- |
| `ew-listening-settings` | 朗读偏好 | 是（`ew-` 前缀自动进） | 跨设备恢复后仍可用；音色 id 可能失效，读取时校验 |
| `ew-listening-positions` | 每本书的收听位置 | 是 | 恢复后 bookId 可能重映射，失效记录按“无位置”处理 |
| `ew-listening-diagnostics` | 最近 50 条播放错误 | 否（建议加入 `LOCAL_STORAGE_SKIP`） | 设备本地诊断；只记引擎、错误码、章节 id、文本长度，不记正文/Key |
| `ew-listening-audio`（P3） | 音频 Blob 缓存 | **否** | 可随时清理，不参与备份/恢复 |
| `local_books/local_volumes/local_chapters` | 书籍与目录 | 已有 | 只读，不新增字段 |
| `chapter drafts` | 正文 | 已有 | 只读，不改写 |

MVP **不需要数据库迁移**，也不改 `storage-upgrade.ts`。这是刻意的：听书是只读消费现有正文，进度丢失的代价远小于迁移风险。

## 10. 代码落点

| 范围 | 新增/修改 | 说明 |
| --- | --- | --- |
| 类型 | `src/types/listening.ts` | `SpeechSegment`、`ChapterScript`、`ListeningSettings`、`ListeningPosition`、`ListenStatus` |
| 配置 | `src/config/listening.ts` | 默认值、语速档位、定时档位、错误文案、常量 |
| 文本 | `src/listening/text/chapter-script.ts` | 清洗、分句、合并、偏移、签名 |
| 引擎 | `src/listening/engine/types.ts` | `TtsEngine` 接口 |
| 引擎 | `src/listening/engine/system-speech.ts` | Web Speech 实现 + 看门狗 |
| 引擎 | `src/listening/engine/openai-speech.ts` | P3 云端实现 |
| 引擎 | `src/listening/engine/registry.ts` | 按设置创建/复用引擎，能力检测 |
| 播放 | `src/listening/playback/controller.ts` | 代际令牌、队列推进、预取、错误重试 |
| 章节 | `src/listening/chapter-source.ts` | 书库/草稿读取、展平目录、空章判断 |
| 存储 | `src/storage/listening-settings.ts` | 读写/归一化偏好 |
| 存储 | `src/storage/listening-position.ts` | 位置读写、prune、snippet 重定位 |
| 存储 | `src/storage/listening-diagnostics.ts` | 环形错误日志 |
| Store | `src/stores/listening.ts` | 会话状态、播放动作、设置同步 |
| 页面 | `src/views/Listen/index.vue` | 听书页壳、路由参数、加载态 |
| 组件 | `src/views/Listen/components/ListenPlayer.vue` | 底部控制栏 |
| 组件 | `src/views/Listen/components/ListenTranscript.vue` | 正文、高亮、点击跳句、自动滚动 |
| 组件 | `src/views/Listen/components/ChapterDrawer.vue` | 卷/章目录、已听标记 |
| 组件 | `src/views/Listen/components/VoicePanel.vue` | 音色、语速、音量、试听 |
| 组件 | `src/views/Listen/components/SleepTimer.vue` | 定时档位与剩余时间 |
| 路由 | `src/router/index.ts` | `/listen/:bookId`，`meta: { title: '听书', hideLayout: true }` |
| 书架 | `src/views/MyBooks/index.vue` | 更多菜单「听书」+ `handleListen` |
| 写作 | `src/views/Writing/components/WritingEditor.vue`（底部状态栏） | 耳机按钮 + 就地播放控制，读当前章 |
| 设置 | `src/types/settings-center.ts` | 增加 `'listening'` 分区 id |
| 设置 | `src/views/SettingsCenter/SettingsCenterModal.vue` | 导航项、`sectionMeta`、instant 分区 |
| 设置 | `src/views/SettingsCenter/panes/ListeningPane.vue` | 新设置页 |
| 设置 | `src/views/SettingsCenter/panes/CachePane.vue` | P3 朗读缓存占用与清理 |
| AI 模型 | `src/types/user-ai-model.ts` | P3 增加 `'audio'` scene |
| AI 模型 | `src/types/ai-model.ts` | P3 增加 `audiobook` 分组 |
| AI 模型 | `src/views/Writing/components/AiModelSettingsPane.vue` | P3 音频场景表单、测试、预设 |
| AI 请求 | `src/utils/local-ai-client.ts` | P3 `synthesizeLocalSpeech()` |
| AI 存储 | `src/storage/local-ai-models.ts` | P3 `sceneOfGroup` 映射、音色字段 |
| 测试 | `tests/listening-*.test.ts` | 本地测试，按仓库约定不提交 |

## 11. 分阶段计划

### P0 技术验证（2–3 天）——Go/No-Go

P0 只做可丢弃的原型，不合并产品代码；时间盒到 3 天，到期无论结论如何都先记录再决定下一步。

| 任务 | 产出 |
| --- | --- |
| 三个平台最小页面：`speechSynthesis` 是否存在、`getVoices()` 中文音色列表 | 平台能力矩阵 |
| 5,000 字长文连续朗读、暂停/恢复、切句、`onend` 触发率 | 稳定性结论 |
| Windows 最小化/失焦、macOS 切后台时是否继续 | 后台播放结论 |
| Blob 音频 `new Audio()` 播放 + `media-src blob:` CSP | 云端可行性 |
| `navigator.mediaSession`、`navigator.wakeLock` 是否存在 | P2 能力清单 |
| Tauri HTTP 插件取音频字节的耗时/内存 | 云端延迟预算 |

**通过标准**：Windows 和 macOS 至少各有一个可用中文音色；连续朗读 5 分钟不截断/不叠音；暂停恢复有可用降级。Linux 不作为 MVP 门槛，但必须记录能力并做提示。

未通过时的备选：

1. 云端 TTS 提前进 MVP（+1 周）；
2. Windows 走 Rust SAPI，macOS 走 AVSpeech（+2–3 周，不建议首版）；
3. 仅支持 Windows/macOS，Linux 显示“当前系统暂不支持听书”。

### P1 核心听书（10–11 天）

1. 定义类型、默认设置、存储适配层（1 天）；
2. 文本清洗/分句/偏移 + 单元测试（1.5 天）；
3. 系统引擎 + 看门狗 + 引擎能力检测（1.5 天）；
4. Pinia store + 播放控制器 + 章节加载（2 天）；
5. 听书页：正文高亮、控制栏、目录抽屉、加载/空章/错误态（2 天）；
6. 位置记忆、自动下一章、基础睡眠定时、书架入口、基础设置页（1.5 天）；
7. 自测、修 bug、`pnpm check` + `pnpm test`（1 天）。

**完成定义（DoD）**：

- 可从书架进入并连续听 10 章；
- 暂停/继续/切句/切章不叠音；
- 退出重进恢复到最后一句附近；
- 空章、无语音、正文读取失败都有可操作提示；
- 3,000 字章节首句 ≤ 1.5 秒出声；
- 代码通过类型检查与 Lint，关键逻辑有单测并通过。

### P2 体验完善（5–7 天）

- 睡眠定时增强（本章结束、淡出暂停、剩余时间显示）；
- 写作页入口与“去写作”回跳；
- 章节目录已听标记、全书进度；
- 媒体键/Media Session（能力允许时）；
- 听书时静音打字音效；
- 键盘、焦点、减少动态效果、窄屏；
- P0 记录的 Linux/无语音引导。

**DoD**：离开听书页即暂停并保存位置（不做后台播放）；定时到点淡出暂停；写作页里就地朗读、换章自动停；键盘可完成全部主要操作。

### P3 云端朗读（7–10 天）

1. 模型管理增加 `audio` 场景与「听书朗读」分组（2 天）；
2. `synthesizeLocalSpeech()` + 错误映射 + 连接测试（2 天）；
3. 云端引擎、预取、Blob 播放、并发/取消（2 天）；
4. 音频缓存、上限、清理、CachePane（1.5 天）；
5. 隐私/费用提示、供应商预设、文档（1 天）；
6. 联调与弱网/限流测试（1–2 天）。

**DoD**：配置 OpenAI 兼容 TTS 后可连续朗读；断网/401/429 有明确提示；缓存命中时切回上一句立即出声；Key 不出现在日志和错误文案中。

### P4 后续（不排期）

- 朗读词典（多音字、人名、生僻字替换，仅影响 TTS，不改正文）；
- 角色对白多音色（需对白归属，成本高）；
- 音频导出（章节/整本 MP3，封面与 ID3，需评估编码方案）；
- 逐字/逐词高亮（依赖引擎边界事件）；
- 移动端/Web 端后台播放与锁屏控制；
- 听书与写作联动：播放时高亮编辑器对应句、暂停打字音效、按句定位修改。

### 排期建议

| 周 | 内容 | 里程碑 |
| --- | --- | --- |
| 第 1 周 | P0 + 类型/存储/分句 | 技术可行性结论 |
| 第 2–3 周 | P1 核心听书 | 内测版，书架可听 |
| 第 4 周 | P2 体验完善 | Beta，可连续听、可定时 |
| 第 5–6 周 | P3 云端朗读 | 音质选项，完整设置 |
| 第 7 周 | 回归、实机、发布 | v2.1 发布（建议） |

若只发布系统朗读核心版，第 3 周末可进入内测（P1 完成），第 4 周末 Beta（含 P2）；云端作为后续小版本。

## 12. 测试与验收

### 12.1 单元测试（Vitest）

- `chapter-script`：引号内标点、省略号、破折号、中英混排、数字、无标点长段、CRLF、空章、标题去重、偏移单调、120 字上限、短句合并。
- `listening-position`：prune、100 本上限、signature 漂移、snippet 重定位、坏 JSON 回退。
- `listening-settings`：默认值、clamp、未知音色回退、引擎切换保留各自音色。
- `playback/controller`：上一句/下一句边界、章末进下一章、空章跳过上限、连续错误自动暂停、generation 丢弃旧结果、暂停/恢复不叠音。
- `system-speech`：用 fake `speechSynthesis` 模拟 end/error/cancel/无 end 看门狗；`getVoices` 延迟返回。
- `openai-speech`：请求体字段、URL 拼接、401/404/429 文案、非音频响应、空 buffer、abort。

### 12.2 集成/手动测试

| 维度 | 用例 |
| --- | --- |
| 入口 | 书架菜单、写作页按钮、直接访问 `/listen/:bookId`、无效 bookId |
| 播放 | 连续 30 分钟、100 次快速播放/暂停/切句、章末自动下一章、全书结束 |
| 恢复 | 退出重进、重启应用、切换书籍、正文被 AI 改写后恢复 |
| 异常 | 空章、无正文、无中文音色、音频设备切换、断网、401、429、服务返回 JSON 错误 |
| 平台 | Windows 11 WebView2（中文/英文系统语音）、macOS 14、Ubuntu 24.04、Chrome/Edge 浏览器模式 |
| 规模 | 10 万字/500 章、单章 2 万字、超长无标点段落 |
| 无障碍 | 仅键盘、NVDA/VoiceOver、200% 缩放、减少动态效果、360px 窄窗 |
| 资源 | 播放 30 分钟 CPU/内存、Blob URL 是否泄漏、切章后旧音频是否停止 |

### 12.3 性能目标

- 章节脚本构建：3,000 字 < 100ms；20,000 字 < 500ms；
- 首句出声：系统引擎 < 1.5s，云端 p50 < 2.5s（不含冷启动/网络极差）；
- 切句响应 < 150ms（系统引擎，取消到下一句开始）；
- 内存：单章文本 + 分段 < 5MB；不累积 Blob URL；
- 空闲播放 CPU 不高于 2%，无高频定时器轮询。

### 12.4 发布前检查清单

- [ ] `pnpm check` 通过（类型、Lint、契约、`cargo check`）；
- [ ] `pnpm test` 通过（前端单测；如本地完整验收文件齐全，再跑 `pnpm check:local`）；
- [ ] `pnpm build` 通过；
- [ ] Windows 10/11 实机：安装包启动、系统语音列表、连续 10 章、重启恢复；
- [ ] macOS 实机：同上；
- [ ] 浏览器开发模式：入口可用，云端 CORS 错误文案正确；
- [ ] 无中文语音、无云端配置时，界面有明确引导；
- [ ] 听书过程中关闭应用，不丢正文、不阻塞关窗保存；
- [ ] 日志/错误信息不含 API Key、正文片段；
- [ ] 四套主题对比度检查（`pnpm check:contrast`）；
- [ ] README 功能列表、CHANGELOG、帮助文案更新。

## 13. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
| --- | --- | --- | --- |
| WebView 不支持 `speechSynthesis` 或无中文音色 | 中高 | 功能不可用 | P0 先验证；能力检测 + Linux 提示；云端作为兜底 |
| 长句被截断 / `onend` 不触发 | 中 | 卡住或叠音 | 按句 ≤120 字；看门狗；重试前检查 `speaking` |
| 暂停/恢复在部分平台无效 | 中 | 体验不一致 | 降级为“从本句开头继续”，界面说明 |
| 快速操作导致叠音 | 高（若不防护） | 严重 | 单引擎单实例；`generation` 令牌；统一 `stopCurrent()` |
| 云端延迟高/费用超预期 | 中 | 用户放弃 | 预取、缓存、按句请求、费用提示、429 退避 |
| 正文外发引发隐私顾虑 | 中 | 信任问题 | 默认系统朗读；云端显式配置 + 明确提示；Key 本地 |
| 位置记录与正文改动错位 | 中 | 从错误位置开始 | signature + snippet 重定位；失败回章首并提示 |
| 音频缓存撑大存储/拖慢备份 | 中 | 存储问题 | 缓存独立、限额、LRU、排除备份、可清理 |
| 切后台/锁屏时定时器被节流 | 中 | 章节间隔变长、定时器不准 | 章节推进依赖 `onend` 事件而非链式 `setTimeout`；睡眠定时记录 `endsAt`，在 `visibilitychange` 时按真实时间重算 |
| 听书页与写作页状态冲突 | 低 | 丢稿 | 独立路由；进入前走既有保存守卫；不在听书页加载编辑器 |
| Linux 体验差引发差评 | 中 | 口碑 | 明确标注支持范围；检测到不支持时给出云端方案 |

## 14. 待确认决策

| # | 问题 | 建议 | 影响 |
| --- | --- | --- | --- |
| D1 | 首版是否必须包含云端朗读？ | 否，P3 再加 | 决定 4 周还是 6–7 周 |
| D2 | 首发平台是否包含 Linux？ | Windows/macOS 完整支持，Linux 降级提示 | 决定是否要为 Linux 做原生 TTS |
| D3 | 是否接受 Edge TTS 非官方接口？ | 不采用 | 避免接口失效与合规风险 |
| D4 | 听书页是否允许离开后继续播放？ | 不允许：离开即暂停并保存位置，不做全局悬浮播放器 | 整本连播只在听书页；写作台的状态栏胶囊只朗读当前章，读完即停，界面上不会出现“没有控制却还在朗读” |
| D5 | 听书进度是否进整包备份？ | 进（`ew-` 前缀自动包含） | 换机后可续听；bookId 重映射时按失效处理 |
| D6 | 是否需要朗读词典（多音字/人名）？ | P4，先收集反馈 | 中文网文刚需，但首版可用“改字/同音字”临时绕过 |
| D7 | 是否导出音频？ | 本计划不做 | 涉及编码、版权、存储，单独立项 |

## 15. 发布与回滚

- **灰度方式**：不引入远程开关；入口始终可见，进入听书页后做能力检测，`speechSynthesis` 不可用时给出说明和替代方案（避免用户以为功能消失）。
- **版本**：建议随 v2.1.0 发布，CHANGELOG 标注“听书（Beta，系统朗读）”；云端朗读在后续小版本标注“需自备 TTS 模型”。
- **回滚**：本功能不改数据库 schema、不改正文，回滚只需移除路由/入口；已写入的 `ew-listening-*` 键对旧版本无影响，可保留。
- **反馈**：设置页「听书与朗读」提供“复制诊断信息”（引擎、平台、音色数量、最近错误），不自动上传。
- **文档**：README 增加“听书”条目；设置页内说明系统语音安装方法（Windows：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 语音包；macOS：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音）。

## 16. 附：关键实现片段（示意）

```ts
// 播放控制器：所有异步结果都要过代际令牌
let generation = 0
let controller: AbortController | null = null

async function playSegment(chapterId: number, segmentIndex: number) {
  const token = ++generation
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal

  const script = await loadScript(chapterId)
  if (token !== generation || signal.aborted) return

  const segment = script.segments[segmentIndex]
  if (!segment) return finishChapter()

  setCurrent(segment)
  try {
    await engine.speak({
      text: segment.text,
      voiceId: settings.voiceId,
      rate: settings.rate,
      pitch: settings.pitch,
      volume: settings.volume,
      signal,
    })
    if (token !== generation || signal.aborted) return
    scheduleNext(segmentIndex + 1)
  } catch (error) {
    if (isAbortError(error) || token !== generation) return
    handlePlaybackError(error, segment)
  }
}
```

```ts
// 分句后的合并/切分示意：保证每段不超过 120 字，且偏移可回查
const MAX = 120
const MERGE_BELOW = 12

function normalizeSegments(raw: Array<{ text: string; start: number; end: number }>) {
  const merged: typeof raw = []
  for (const item of raw) {
    const text = item.text.trim()
    if (!text) continue
    const last = merged[merged.length - 1]
    if (last && last.text.length < MERGE_BELOW && last.text.length + text.length <= MAX) {
      last.text += text
      last.end = item.end
    } else {
      merged.push({ text, start: item.start, end: item.end })
    }
  }
  return merged.flatMap(splitLongSegment)
}
```

以上片段只表达约束，不限定最终实现；`splitLongSegment` 需要在 `，、；：` 处优先切分，并保持 `start/end` 指向清洗后正文。

## 17. 参考入口

- 书籍/目录：`src/storage/local-library.ts`、`src/storage/local-library-types.ts`
- 正文草稿：`src/storage/writing-storage.ts`、`src/views/Writing/components/WritingEditor.vue`
- 设置存储：`src/storage/app-settings.ts`、`src/storage/local-writing-position.ts`（位置记忆的写法可参考）
- 全量备份：`src/storage/full-backup.ts`（`IDB_STORES`、`LOCAL_STORAGE_SKIP`）
- 设置中心：`src/views/SettingsCenter/SettingsCenterModal.vue`、`src/types/settings-center.ts`
- BYOK 请求：`src/utils/local-ai-client.ts`、`src/storage/local-ai-models.ts`
- 主题与组件：`src/styles/themes.scss`、`src/components/EwModal`、`src/styles/ink.scss`
- CSP：`src-tauri/tauri.conf.json`（`media-src`、`connect-src`）
- 路由：`src/router/index.ts`
- 书架入口：`src/views/MyBooks/index.vue`
- 写作页底部状态栏：`src/views/Writing/components/WritingEditor.vue` + `writing-editor-statusbar.scss`
- 全局挂载点：`src/App.vue`
