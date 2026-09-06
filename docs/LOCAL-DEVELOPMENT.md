# 从 easy-writing 学习一个本地 AI 写作工作台

## 1. 先理解它的分层

| 层 | 文件入口 | 作用 |
| --- | --- | --- |
| 应用入口 | src/main.ts、src/App.vue | Pinia、路由、主题、提示词初始化、保存与备份调度 |
| 页面导航 | src/router/index.ts、src/layouts | 书架、写作台、模型管理、工作流、素材等功能组织 |
| 书架与导入导出 | src/views/MyBooks、src/storage/local-library.ts | 作品、卷、章节元数据，TXT / JSON 转换 |
| 正文编辑 | src/views/Writing/components/WritingEditor.vue | TipTap 编辑器、保存、AI 编辑等交互 |
| 存储接口 | src/storage/writing-storage.ts、local-library-types.ts | 定义正文及作品目录读写契约 |
| 浏览器存储 | indexeddb-writing-storage.ts、indexeddb-local-library.ts | 正文、版本、目录等存入 IndexedDB |
| 桌面存储 | sqlite-writing-storage.ts、sqlite-local-library.ts | 同一套上层接口，底层换成本机 SQLite |
| 参考资料 | src/storage/local-reference*.ts | 大纲、角色、关系、世界设定、时间线、故事线与导入 ID 重映射 |
| AI 配置 | src/storage/local-ai-models.ts | BYOK 模型定义、私有密钥、各场景默认模型 |
| AI 请求 | src/utils/local-ai-client.ts | OpenAI 兼容请求、思考参数适配、流式解析、调用统计 |
| 工作流 | src/utils/local-workflow-*.ts、src/views/WorkflowBook | 灵感到大纲、设定、建书、章节生成与断点控制 |
| 桌面能力 | src-tauri | 原生窗口、文件、数据库、爬虫等 Rust / Tauri 能力 |

原项目的关键设计是“业务使用存储接口，接口根据运行环境选择后端”。浏览器和 Tauri 共享大部分 Vue 工作台，不需要维护两套写作逻辑。

## 2. 一次写作保存经过哪里

1. 书架创建作品以及卷 / 章目录，拿到稳定的作品和章节 ID。
2. WritingEditor 从 WritingStorage 读取章节，交给 TipTap 编辑。
3. 正文变动经原项目的自动保存、写入验证和日志机制进入本地存储，字数同步回目录。
4. 导出通过 buildLocalExportPayload 读取真实的持久化正文，不仅导出目录上的字数和标题。
5. 参考资料通过 exportLocalBookReference 随作品 JSON 一起保存。

这次把原本嵌在 exportLocalBook 中的取数逻辑提炼为 getLocalBookExportPayload。手动导出与硬盘快照共用同一入口，减少两份实现出现正文或设定遗漏的风险。

## 3. 一次 AI 调用经过哪里

模型管理保存提供商、Base URL、模型名、密钥和采样参数。具体写作场景组装提示词后，经 local-ai-client 生成兼容请求。

- Tauri：保留原生 HTTP 插件。
- 使用本地启动器的浏览器：localCompanionFetch 把请求交给同源 Node 服务，再由本机发往模型。
- 普通 Vite 预览：保留原来的浏览器直连行为。

Node 转发器保留响应状态码及响应流，原有流式解析器仍然处理模型输出，不需要逐个重写续写、对话、工作流等调用方。AbortSignal 传到浏览器代理请求；响应连接关闭时服务端中止上游请求。

## 4. 新增文件与职责

| 文件 | 职责 |
| --- | --- |
| local/server.mjs | 无运行时第三方依赖的本地静态服务器、模型转发、快照接口、保留策略 |
| src/utils/local-companion.ts | 本地服务发现、会话令牌、前端请求、作品快照与 5 分钟调度 |
| src/views/LocalCenter/index.vue | 状态、快照列表、文件下载、选择作品恢复 |
| start-windows.bat / start-macos.command / start-linux.sh | 从应用所在目录启动，避免工作目录变化导致路径错乱 |
| local/server.test.mjs | HTTP 服务真实请求测试；AI 上游为可控模拟服务 |
| tests/local-books.test.ts | fake-indexeddb 验证真实存储层的导出和恢复 |

## 5. 本地接口约定

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| /api/local/status | GET | 服务识别、当前会话令牌、目录、快照列表 |
| /api/local/backups | POST | 校验作品快照后写盘，相邻相同内容去重 |
| /api/local/backups/:id | GET | 读取白名单文件名匹配的快照 |
| /api/local/ai | POST | 转发用户配置的 HTTP(S) 模型请求 |

所有接口受固定 Host / Origin 校验约束，写入、读取备份和代理请求还需要随机会话令牌。只绑定 127.0.0.1，不开放公网；代理不会携带浏览器 Cookie，模型鉴权按请求传递，不记录日志；拒绝重定向，避免认证头随跳转发给其他地址。

快照经过单队列写入，使用临时文件 + 重命名；确认新快照文件完成后删除超过 30 份的旧文件。API 限制快照 100 MB、代理请求 25 MB。异常返回可见错误，不把失败伪装成成功。

## 6. 恢复策略及边界

当前恢复沿用上游 JSON 导入器，为作品和参考实体分配新 ID，重映射章节引用，保持原稿不变。它是“恢复可继续写作的作品副本”，不是恢复工作台全部状态。原导入器会将正文作为文本恢复，不恢复富文本排版、空卷和工作流断点等全部元信息。

如果未来做数据库级恢复，应该另外定义有版本号的迁移格式、跨库事务策略、恢复前快照和失败回滚，不能直接用覆盖 localStorage 来代替。

## 7. 开发验证

```sh
pnpm build
node --test local/server.test.mjs
pnpm test
```

构建会输出原项目的大型编辑器、图表与 UI 组件分包。大小提示不是构建失败。需要验收真实 AI 时，在本机配置模型，再分别测试连接、流式对话、取消、续写与工作流；模拟转发测试不能替代具体模型能力验收。

建议学习顺序：先跑通“建书 → 保存 → 关闭再打开 → 导出恢复”；再顺着一个 AI 续写请求阅读代码；最后读工作流引擎。这样每一层都能对应到具体操作。
