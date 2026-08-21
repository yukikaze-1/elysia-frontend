# Cyrene 前端文档交叉 Review 与修订记录

**文档版本：** v0.1  
**文档状态：** Review 完成 / 已修订已知内部问题  
**适用范围：** Cyrene Desktop Demo 上位需求与前端 00～12 号文档  
**Review 日期：** 2026-08-04  
**Review 类型：** 需求覆盖、跨文档一致性、可实施性、安全边界与验收闭环

---

## 1. Review 结论

本轮共审查 15 份既有 Markdown 文档，并对发现的问题直接完成修订。修订后没有发现仍未标注的内部口径冲突；文档集可以进入产品确认和后端协议对齐，但尚不能跳过阶段 0 直接认定为“可开工基线”。真实后端事件、模型配置所有权、语音轮次、平台范围及 Live2D 许可等外部输入仍需确认。

本轮不是只做文字润色。已处理的问题包括：

- 用户明确的语音产品语义曾被混淆；
- 输入法转写曾被错误设计成第四类模型服务；
- 工具名称、调用 ID、Runtime 和审批边界存在多套口径；
- 两份实施计划曾使用不同的阶段含义；
- 历史懒加载缺少可执行的分页签名和来源消息上下文查询；
- Assistant 正文可能出现双份事实来源，Inner Voice/Public Reply 的交错顺序也不够严格；
- 自定义模型 Endpoint、路径、命令和开发者模式的安全边界不完整；
- Live2D 右侧扩展布局、双模型验收和发布许可要求没有完全闭环。

## 2. Review 范围

### 2.1 上位文档

1. `Cyrene-Desktop-Demo-产品需求文档-v0.2.md`；
2. `Cyrene-Agent-工具执行系统补充需求.md`。

### 2.2 前端文档

1. 00 文档索引；
2. 01 Electron 总体架构；
3. 02 前后端通信协议与前端数据结构；
4. 03 UI 与交互；
5. 04 Desktop 工具与权限；
6. 05 Live2D 接入；
7. 06 状态管理与本地存储；
8. 07 Electron 安全；
9. 08 测试与 Demo 验收；
10. 09 构建、打包与发布；
11. 10 实施路线与任务拆分；
12. 11 设置中心；
13. 12 开发启动清单与分阶段计划。

## 3. 审查标准

| 维度 | 通过标准 |
|---|---|
| 需求覆盖 | 用户补充的聊天、历史、媒体、语音、模型、Live2D、权限和设置需求均有实现与验收落点 |
| 单一事实来源 | 相同概念在产品、协议、状态、UI、测试和计划中只有一套稳定语义 |
| 可实施性 | 数据结构、状态机、分页、取消、失败和恢复可以直接转化为工程任务 |
| 安全边界 | Renderer、Main、Backend、Desktop 和 Local Worker 的权限不可互相借用 |
| 可验收性 | 每项 P0 能力有可观察结果、失败路径和阶段门槛 |
| 外部依赖 | 未掌握的真实后端、平台和许可信息明确标为待对齐，不伪装成既定事实 |

## 4. 发现与修复记录

| ID | 等级 | 原问题 | 已完成修复 | 状态 |
|---|---|---|---|---|
| R-01 | P0 | 普通/实时 STT 与“按住说话转文字”被写成同一种文字输入 | 普通录音和实时会话归为直接语音；字幕不写草稿；只有输入法转写把最终文字写入草稿，且不自动发送 | 已修复 |
| R-02 | P0 | 输入法转写曾被当成第四类模型服务 | 模型服务固定为 LLM、STT、TTS 三类；输入法转写通过 `dictationSttProfileId` 选择兼容 STT Profile | 已修复 |
| R-03 | P0 | 模型执行位置和工具 Runtime 容易混用 | 分离 `ModelExecutionLocation` 与 `ToolRuntime`；模型调用本身不进入工具状态机 | 已修复 |
| R-04 | P0 | Desktop 工具存在短名、全名及多种调用 ID | P0 统一为四个带命名空间的工具 ID；工具统一 `callId/call_id`，生成继续使用独立请求 ID | 已修复 |
| R-05 | P0 | 补充需求可能把命令执行默认扩大到 P0 | `desktop.command.run` 改为需单独确认的可选能力；未确认时不注册，设置仍可查看和撤销历史授权模板 | 已修复 |
| R-06 | P0 | Backend 工具审批可能被误写成本地授权 | 增加 `approvalAuthority`；Backend 审批不得创建或复用 Desktop/Local Worker 本地 Grant | 已修复 |
| R-07 | P0 | 10、12 两份计划阶段编号含义不一致 | 两份文档及主需求统一为阶段 0～8，共 9 个阶段，并统一进入条件与验收门槛 | 已修复 |
| R-08 | P0 | 后端原始协议若直达 Renderer，会造成凭据和协议耦合 | Main 持有传输、凭据和原始事件；`BackendAdapter` 归一化后才通过 Preload 的具名 API 交给 Renderer | 已修复 |
| R-09 | P0 | 历史加载只有概念，没有完整分页和来源跳转结构 | 增加 `GetConversationQuery`、`MessagePage`、`MessageContextQuery`、`ChatHistoryQuery/Page`、稳定排序和快照语义 | 已修复 |
| R-10 | P0 | 一条 AI 回复可能因按句流式被拆成多条消息 | 统一以 `responseId/messageId` 归并父回复，以 `segmentIndex` 排全局顺序，以 `deltaSequence` 合并分段 | 已修复 |
| R-11 | P0 | Assistant 正文同时写入 `content` 和分段，可能双渲染、双搜索 | `assistantSegments` 成为 Assistant 可见正文唯一事实来源；Adapter 入 Store 前一次性归一化 | 已修复 |
| R-12 | P0 | Inner Voice/Public Reply 的类型与交错展示约束不够强 | 分段和流式开始事件改为可判别联合类型；P0 Inner Voice 只接受文本/Markdown；两通道按真实全局时间线展示 | 已修复 |
| R-13 | P1 | 父完成先到、增量缺口和迟到事件的处理不明确 | 增加 `completing` 恢复状态；补传后完成，无法补齐则明确标记回复可能不完整 | 已修复 |
| R-14 | P1 | 消息 Token 和会话 Token 可能重复累计或被误当上下文窗口 | 区分本次 `usage` 与累计 `conversationUsage`，记录数据来源，按唯一 generation 去重，禁止字符估算冒充真实 Token | 已修复 |
| R-15 | P1 | 统一历史查看器缺少自然日时区和完整资源分类 | 增加本地日期 + IANA 时区、半开日区间、游标快照，并拆分图片/视频、表情、文件、音频和链接分类 | 已修复 |
| R-16 | P0 | 自定义模型 Endpoint 会形成 SSRF、密钥转发和重定向风险 | 远程默认 HTTPS；显式本机 Provider 才允许回环 HTTP；校验 DNS、实际连接、特殊地址、重定向、Header 和域名黑名单 | 已修复 |
| R-17 | P0 | 文件路径策略未覆盖 Windows 特殊路径和链接绕过 | 增加 UNC、设备命名空间、ADS、大小写、符号链接、连接点、重解析点与真实路径检查 | 已修复 |
| R-18 | P0 | 受控命令仍可能受 PATH、Shell 或可执行文件替换影响 | 使用绝对可执行路径、无 Shell 参数数组、哈希/签名校验；文件变化后撤销既有授权 | 已修复 |
| R-19 | P1 | 开发者模式曾暗示 DevTools 也能完全脱敏 | 明确应用日志/诊断必须脱敏，但 DevTools 天然可见当前 DOM、Renderer 内存和临时表单；开启前警告，已保存凭据仍不可读回 | 已修复 |
| R-20 | P1 | 拖拽文件依赖旧 `File.path` 的风险 | 采用 Preload 中的 `webUtils.getPathForFile(file)`，立即交给 Main 转为不透明句柄；拖拽不自动上传或发送 | 已修复 |
| R-21 | P1 | “三栏式”与右侧 Live2D 扩展后实际结构矛盾 | 统一称“四区布局”或“导航 + 三个内容栏”；角色栏作为右侧布局列，禁止覆盖聊天 | 已修复 |
| R-22 | P1 | Live2D 目标要求切换，但验收只要求一个模型 | 验收改为至少两个合法模型；补充清单哈希、路径逃逸检查、失败回退和资源许可 | 已修复 |
| R-23 | P1 | Live2D 发布许可被过度简化 | 明确 AI/Chatbot/Expandable Application 可能需要官方分类确认、审核或出版许可，无法确认时不发布对应产物 | 已修复 |
| R-24 | P1 | 多媒体只列类型，缺少格式兼容和失败降级 | 把 MIME/编码兼容矩阵列为开工输入，要求不支持格式给出下载或外部打开等安全降级 | 已修复 |

## 5. 修订后的统一口径

### 5.1 AI 回复

- 一次后端 AI 回复只建立一条 Assistant 父消息；
- 多个句子、Inner Voice、Public Reply 和 Public Reply 多媒体都是该父消息下的有序分段；
- 相邻同通道分段可以视觉合并，但不得移动跨通道分段的位置；
- Inner Voice 缺失时不显示空区域，默认 TTS 只朗读 Public Reply；
- 消息 Token、实际模型和心情在父回复完成时统一落位。

### 5.2 语音和模型

- 模型服务只有 LLM、STT、TTS 三种 Profile；
- 普通录音停止后进入待发送音频，不自动发送；
- 实时语音会话的 partial/final 只是字幕，不修改文字输入框；
- 输入法转写是独立使用场景，最终文字只进入当前会话草稿；
- 输入法转写可选择不同 STT Profile，但不复制 Provider、测试或凭据系统。

### 5.3 工具和权限

- Tool Registry 统一覆盖 Backend、Desktop、Local Worker；
- Desktop P0 仅为 `desktop.file.select`、`desktop.file.read`、`desktop.file.write`、`desktop.screen.capture`；
- 本地副作用按 `callId` 幂等，权限、参数摘要、工具版本和 Runtime 必须绑定；
- Backend Runtime 的公开状态可在客户端展示，但不等于服务端完整审计；
- 任何 Runtime 都不能通过后端声明绕过客户端本地安全策略。

### 5.4 历史和资源

- 当前会话向上懒加载与统一聊天历史查看器使用不透明游标；
- 查看器支持当前/全部会话、关键词、本地日期、分类组合查询；
- 图片/视频、表情、文件、音频和链接（后端六分类）都保存来源消息引用；
- 搜索或资源结果必须能加载消息上下文并跳回来源位置。

### 5.5 安全和进程边界

- Renderer 不持有后端/模型凭据、原始协议、本地绝对路径或通用系统能力；
- Preload 只暴露具名、窄参数、运行时校验的 API；
- Main 负责传输、凭据、路径、权限、工具执行和日志；
- 自定义 Endpoint、外部链接、文件路径、命令模板和 Live2D 资源均按不可信输入处理；
- 开发者模式不降低应用日志脱敏、凭据不可读回和远程调试关闭要求。

## 6. 仍需外部确认的项目

以下项目不是文档内部错误，不能在没有真实资料时由前端文档替后端或产品决定：

1. 现有后端的认证、流式传输、心跳、续传、取消和错误结构；
2. 一份包含 Inner Voice、多句 Public Reply、Token、模型和心情的真实脱敏事件记录；
3. 会话历史、消息上下文、资源索引和统一历史查询的现有接口能力；
4. LLM/STT/TTS Profile 的配置来源、凭据所有权、自定义 CRUD、测试和激活接口；
5. 普通录音、实时语音的格式、VAD、断句、轮次提交和延迟目标；
6. 输入法转写首版开放 Backend、本机和 Local Worker 中的哪些执行位置；
7. `desktop.command.run` 与 Local Worker 是否进入 Demo；
8. Windows/Ubuntu 的主验收版本、Wayland 范围、安装包和发布渠道；
9. 两个可合法开发与分发的 Live2D 模型，以及 SDK/Core 的适用许可结论；
10. 图片、视频和音频的 MIME、编码、大小和降级矩阵；
11. Inner Voice 默认展开策略和是否按会话记忆。

这些项目已经集中列入 12 号文档的启动清单，未满足 P0 条目时应显示为阶段阻塞，不应静默采用临时假设。

## 7. 自动回归结果

本轮修订完成后对包含本记录在内的 16 份 Markdown 文档执行结构回归：

| 检查项 | 结果 |
|---|---:|
| UTF-8 替换字符 | 0 |
| 未闭合代码围栏 | 0 |
| 同文档重复标题 | 0 |
| 失效相对 Markdown 链接 | 0 |
| Markdown 表格列数异常 | 0 |
| 已废弃工具短名和旧输入法 Profile 字段 | 0 |
| 10、12 与主需求阶段编号差异 | 0 |

自动检查不能替代产品、后端、实机和安全测试。真实协议字段、CSP、IPC、路径处理、音视频编码、Live2D GPU 行为及安装包仍需在对应阶段验证。

## 8. 官方资料核对

本轮涉及 Electron 和 Live2D 的时效性规则，按 2026-08-04 可访问的官方资料核对：

- [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)：用于复核沙箱、CSP、导航、外部内容、IPC 来源和自定义协议等基线；
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)：用于复核 Preload/Renderer 隔离及具名 API 原则；
- [Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)：用于复核 Renderer 沙箱边界；
- [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils)：用于替换旧 `File.path` 并限定拖拽文件路径处理位置；
- [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)：用于补充发布包能力收缩检查；
- [Electron Release Timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)：用于避免在文档中长期写死已过支持期的版本；
- [Electron Forge Makers](https://www.electronforge.io/config/makers)：用于复核 Windows/Linux 产物方案需按目标平台实际验证；
- [Live2D SDK Release License](https://www.live2d.com/en/sdk/license/)：用于复核 SDK 发布许可分类；
- [Live2D Expandable Applications](https://www.live2d.com/en/sdk/license/expandable/)：用于复核可切换、可扩展角色应用的单独审查风险；
- [Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/)：用于确认 Electron/Chromium 方向仍需以实际 SDK 版本和资源许可验证。

## 9. 下一次 Review 的触发条件

出现以下任一情况，应重新做交叉 Review，而不是只改一份文档：

- 获取现有后端真实协议并填写 02 的对齐表；
- 确认或改变 Demo P0 范围；
- 命令执行、Local Worker、自动更新或新工具进入范围；
- 修改 Inner Voice、语音或模型服务语义；
- 更换 Electron、Live2D SDK、打包方式或目标平台；
- 安全策略、权限持久化、路径规则或日志内容发生变化；
- 阶段门槛或验收脚本发生变化。

每次变更至少同步检查主需求、相关详细设计、测试方案和 10/12 两份实施计划。

---

## 10. 增量 Review：后端协议对齐（2026-08-08）

**触发条件：** doc 13 §9 第 1 条——「获取现有后端真实协议并填写 02 的对齐表」。

**输入来源（后端只读）：** `elysia-agent/frontend-handoff-v2`（批次 7）——`docs/electron-backend-protocol-v2.md` v0.6（40 错误码）、`frontend_contract/`（ws_message.py 38 个 WS 消息 + rest.py）、`traces/ws-v2-*.jsonl` 真实轨迹。前端侧仅更新文档，未改动后端。

### 10.1 本次修订

| 文档 | 变更 |
|---|---|
| 02 §5 | 握手改写：后端 WS 头 + `session→server_info→expression` 连接帧取代旧 `ClientHello/ServerHello` 域握手；新增前端连接域 `ConnectionState` |
| 02 §4 | 补注：wire 为扁平 JSON，`EventEnvelope` 由 Adapter 盖戳补充 |
| 02 §6 | 补确认映射：`SessionSummary{conversationId,title?,messageCount,updatedAt,active}`，`Conversation` 需增补 `active` |
| 02 §7 | 补确认映射：归档 wire `inner_voice`(字符串)+`content`(parts) 归一化为 `assistantSegments`；`status`/`segmentId` 由 Adapter 推导 |
| 02 §8 | 补确认映射：`V2TextMessage` `content` 为字符串 + `attachments`/`stickerId`；幂等 `clientRequestId` |
| 02 §9 | 修正 `finishReason` 仅 `stop/tool_calls`（取消/错误走 `generation.failed`）；`segment.completed` 必发带 `content`；`responseId` 弃用为 `generationId` |
| 02 §10 | 补确认映射：`tool.request`/`tool.status`；四 P0 工具；`desktop.command.run` 不注册；repo 状态含 `expired/offline` |
| 02 §11 | 补确认映射：`POST /api/uploads` + 签名下载/签发端点 + sticker 公共资源；`AttachmentInfo` wire 字段 |
| 02 §12 | 补确认映射：`expression{expression,intensity}` + `generation.completed.mood` + `live2d_static_image` |
| 02 §13 | 补确认映射：`/api/providers` + Secret Store + `switch_model`/`set_tts_voice`；三种语音 wire（`voice.record*`/`voice_session.*`/`dictation.*`）；TTS `audio_start/audio/audio_end/audio.cancel/audio_cancelled` |
| 02 §14 | 补确认映射：40 码目录 + `ProtocolError` 统一信封；`PublicError.code` 透传后端稳定码 |
| 02 §16 | 修正恢复规则：后端无断点续传，重连经 `session` 回放 + pending/generations 查询 |
| 02 §19/§19.1 | 对齐表 27 项全部填写 + 字段差异桥接表 D-1~D-10（新增） |
| 12 §4 | 输入清单状态注：已由交接包确认契约的项清单 + 仍未提供项 |
| 16 §2/§3 | 输入组状态注；阶段 0 对齐表相关项勾选与变更登记 |

### 10.2 仍未决（不阻塞阶段 0，需外部确认）

- **F-06~F-09**：沙盒目录/路径/域名黑名单、授权级别、受控命令模板、Diff/覆盖策略——产品与安全决策，不因后端契约自动关闭；
- **G-01~G-03/G-05/G-06**：Live2D SDK 许可、合法模型、表情/动作白名单、口型驱动、降级策略；
- **H 组**：主验收平台、Windows 10/Ubuntu/Wayland 范围、打包签名与发布渠道、演示脚本等产品决策；
- **B-07**：数据保留策略（需实际部署，交接包不含）。**B-01 真实测试环境地址已到位**（2026-08-14 真实联调十项复跑通过后，已从待确认清单移除）。

> **已定案（2026-08-14，阶段 3 G1）：** 「Live2D 默认展开状态、宽度、聊天最小宽度和极窄窗口阈值」已从 §6 待确认清单移除——Live2D 右栏**默认显示**、栏宽 340 可调（[300,420]）、最小窗口 **1100×700**、窄窗自动折叠/关闭保护聊天区；断点 1200/736/520/320；布局记忆走 Renderer localStorage（键 `cyrene.layout.v1`，docs/06 §8.5）。

### 10.3 自动回归

对修订后的 02/12/13/16 执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

> 说明：本增量 Review 聚焦「后端真实协议 → 前端文档」对齐，未重跑完整交叉 Review（Live2D 许可、语音产品语义、平台范围等仍待外部输入）；对应阶段（4/5/6/7/8）进入前仍需各自验证。

---

## 11. 增量 Review：阶段 1 块 A 安全加载与环境基线（2026-08-09）

**触发条件：** doc 13 §9——「安全策略、权限持久化、路径规则或日志内容发生变化」「更换 Electron、打包方式或目标平台」（块 A 落地 CSP 交付方式、`cyrene://` 自定义协议、生产安全默认与 electron-builder 最小打包流程，需重跑交叉 Review）。

**Review 对象：** 阶段 1 块 A（安全加载与环境基线）实施后的文档同步——doc 07（§4 加载模型/远程调试门、§5 CSP AND）、doc 09（§3/§5 环境与命令）、doc 16（§4 任务③④与验收门槛）、doc 01（§8.1 加载）、doc 10（§4.1 范围）、doc 17（新增踩坑）。

### 11.1 本次修订

| 文档 | 变更 |
|---|---|
| 07 §4 | 补充已落地基线：`cyrene://` 受限协议替代 `file://` 加载打包 Renderer（dev 走 Vite http，谓词 `shouldUseViteDevServer`）；远程调试门 main() 顶部同步拒绝显式端口/裸开关/pipe（非 harness），`=0` 与 pipe 仅测试 harness `CYRENE_TEST_HARNESS=1` 放行 |
| 07 §5 | 补充已落地 CSP：严格版（无 `unsafe-eval`/`unsafe-inline`、`frame-src 'none'`）经协议响应头注入，与保留的 index.html meta **AND 取交集**（dev http 靠 meta 兜底；meta 不剥离） |
| 09 §3/§5 | 补充 dev/test/prod 环境落地（`__APP_MODE__` 烘焙 + `resolveAppConfig`，未知 mode 归 production）；`package`=未分发包（electron-builder --dir）、`verify:artifact`=产物检查（静态 + `--smoke` 冒烟）语义 |
| 16 §4 | 任务 ③④ 勾选 `[x]`；验收门槛「生产配置默认关闭开发者模式与 DevTools，远程调试端口始终关闭」升 `[x]`；变更记录加行；头部/当前阶段状态更新 |
| 17 §10/§13 | 新增 P-9~P-11（electron-builder 首次打包、打包冒烟 `=0` 通道、verify:artifact 用法）与 §13 产物检查说明 |
| 01 §8.1 | 加载本地 Renderer 注明打包/构建产物经 `cyrene://` 受限协议 |
| 10 §4.1 | 阶段 1 块 A 范围回写（开发/测试/生产配置 + 最小打包 + 自定义协议/CSP 落地） |

### 11.2 一致性核对

- **加载协议**：doc 07 §4 / 01 §8.1 / spec `2026-08-09-phase1-loading-env-design` §5.3 均为「打包恒 `cyrene://`、dev 走 Vite http」同一谓词（`shouldUseViteDevServer`），无冲突；
- **CSP**：doc 07 §5「严格头 ∩ 保留 meta」与 spec D-6/G-9 一致；`frame-src 'none'` 收口第一块 G-6 缺口；
- **远程调试门**：doc 07 §4「任何构建都不得开放远程调试端口」为发布门槛，`=0`/pipe 仅测试 harness 放行——与实现（`hasForbiddenDebugSwitch` + `CYRENE_TEST_HARNESS`）一致；`--inspect-brk` 在 Node 引导期暂停、进程内无法拦截为已知固有限制（spec G-7，阶段 8 Fuses 评估）；
- **环境划分**：doc 09 §3 staging 仍留阶段 2（B-01 未到位），dev/test/prod 已落地——无口径冲突；
- **命令语义**：doc 09 §5 的 `package`/`verify:artifact` 与 README、doc 17 §13 一致（`make`/`test:e2e` 仍为占位）。

### 11.3 仍待后续块验证

- **块 B**：日志模块（当前冒烟/启动错误先 `console.error`，块 B 建 logger 后替换）；凭据存储 safeStorage、审计与诊断导出；
- **块 C**：集成测试套件（`test:integration` 目前因无匹配测试文件失败）；`verify:artifact` 冒烟正式化为 test:integration；
- **跨平台**：Windows 打包/冒烟、macOS 最小菜单（appMenu/editMenu/windowMenu 不含 View→DevTools）待实机验证；
- **代码 Review 遗留**：见 `docs/review/2026-08-09-阶段1A-loading-env-code-review.md` 的 [P1]（调试门负路径冒烟可能被单实例锁混淆假通过）、[P2]（普通浏览器检查跳过正则过宽）、[P3]（路径单测硬编码 POSIX 路径，Windows 会失败）——非本块文档门禁，后续块处理。

### 11.4 自动回归

对修订后的 01/07/09/10/13/16/17 与 README 执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

> 说明：本次为块级增量 Review，聚焦加载/环境/CSP/打包的一致性，未重跑完整交叉 Review（Live2D 许可、语音产品语义、平台范围等仍待外部输入）；对应阶段进入前仍需各自验证。

---

## 12. 增量 Review：阶段 3 落地同步（2026-08-14）

**触发条件：** doc 13 §9——「阶段门槛或验收脚本发生变化」；阶段 3 四组（布局响应式 / 历史聊天体验 / 附件多媒体 / 历史查看器+表情+无障碍）落地，布局、持久化口径与「绘画资源」概念变化。

### 12.1 本次修订

| 文档 | 变更 |
|---|---|
| 16 §6 | 阶段 3 任务全部勾选 + 验收门槛相关项勾选；「绘画资源」提法清理为后端六分类；头部/当前阶段/进度日志同步（894 单测 + 39 集成） |
| 10 §6.1 | 「绘画资源」→「会话媒体（六分类）」；阶段 3 已落地注记 |
| 03 §7.7/§15 | 「绘画资源」→ 后端六分类口径；§3.1 布局数值标注已定案；§3.2 布局记忆指向 localStorage |
| 06 §2/§3/§8.1/§8.5 | `PersistedSettingsV2.layout` 移除/重分类为 Renderer localStorage `cyrene.layout.v1`（新增 §8.5）；store 清单增补 layoutStore/draftStore/cacheStore/attachmentStore/historyViewerStore（§3.13） |
| 12 §4.4/§9.4 | D-01~D-07 标注阶段 3 已落地（`[~]` 已确认 + 实施完成）；阶段 3 完成标记 |
| 13 §6/§10.2 | Live2D 默认展开状态/宽度/聊天最小宽度/极窄阈值从待确认清单移除（阶段 3 已定案） |
| 00/01/08 | 「绘画资源」同概念顺带清扫为后端六分类口径 |
| CLAUDE.md / README | 阶段 3 落地状态 + 三态标记 |

### 12.2 阶段 3 定案记录

- **Live2D 右栏布局（G1）**：默认显示；栏宽 340 可调（[300,420]）；最小窗口 1100×700；断点 1200/736/520/320；窄窗自动折叠/关闭保护聊天区；布局记忆走 Renderer localStorage（`cyrene.layout.v1`）——已从 §6 待确认清单移除。
- **布局/持久化口径**：`PersistedSettingsV2.layout` 不再由 Main 配置承载，重分类为「UI 状态·选择性持久化」（docs/06 §8.5）。
- **「绘画资源」概念清理**：后端资源分类仅六类（图片/视频、表情、文件、音频、链接），PRD 无绘画功能；docs 10/03/16 必改，docs 00/01/08/13 顺带清扫完成。

### 12.3 自动回归

对修订后的 00/01/03/06/08/10/12/13/16 与 README/CLAUDE.md 执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

> 说明：本次为阶段 3 落地的文档同步增量 Review，未重跑完整交叉 Review（Live2D SDK 许可与模型资源、语音产品语义、平台范围等仍待外部输入）；对应阶段进入前仍需各自验证。

## 13. 增量 Review：阶段 4 批次 B 语音落地同步（2026-08-16）

**触发条件：** doc 13 §9——「修改 Inner Voice、语音或模型服务语义」与「修改安全策略或权限模型」；阶段 4 批次 B 落地语音链路（普通录音 / 实时语音会话 / 输入法转写 / TTS 自动朗读）与语音安全策略（麦克风权限处理器、单向语音 IPC 守卫、后端 STT 一次性同意）。

### 13.1 本次修订

| 文档 | 变更 |
|---|---|
| 02 §13.1 | **内容重写**（F-9）：`AudioStreamDescriptor` 收敛为固定 `pcm_s16le/16000/1` `AudioInputDescriptor`（BINARY 上行，1 MiB 上限）；TTS 播放为 base64 JSON 帧（`audio_start/audio/audio_end/audio_cancelled`，`is_final` 恒 false）；**删「不能 Base64 塞入普通事件 JSON」矛盾表述**；背压窗口与原始音频生命周期落文 |
| 02 §13.2/§13.3 | 三种语音状态改「已实现」（阶段 4 批次 B，Mock 驱动，已开发、未联调）；领域类型按 `shared/contracts/voice.ts` 重写（`recordingId`/`sessionId`/`clientRequestId`）；`dictation.start.sttProfileId`、D-P14/D-P16 落文 |
| 02 §13.4 | `audio_end{stream_id, format?}` 补齐（format 缺省 wav；完成由前端本地 `onended` 判定）；领域事件改 `audio.session.*` |
| 02 §19 | 语音行确认：普通录音/实时/转写/TTS wire ↔ 域契约 ↔ Store 消费（`voice.transcript`→voiceStore、`voice_session.turn`→messageStore、`dictation.final`→settingsStore+draftStore、`audio.session.*`→voiceStore）；新增「语音族错误路由」行（`voice.error`，D-P15） |
| 01 §6.1/§6.2 | BackendAdapter/DesktopApi 接口片段同步 P4-B 语音方法集（Task 3 接口重写暴露 §6.1 过时的 Ruling 落文） |
| 03 §8.4/§8.6/§12.3 | 语音三入口 + 待发送条 + 实时条 + 转写浮层 + TTS 播放器 + 语音设置子页 + consent 落地状态 |
| 06 §3.2/§3.7/§3.9/§8.1 | `voiceStore`/`settingsStore` 落地形状；connectionStore 语音族错误横幅抑制（D-P15）；语音设置持久化改走 `settings.json`（SettingsState） |
| 07 §11.1 | Main 麦克风权限处理器（`decideMicrophoneAllow`/`registerMicrophonePermission`）+ 单向语音 IPC 守卫（`registerOneWayHandler`，1 MiB 上限）+ 后端 STT 一次性同意（D-P16） |
| 08 E2E-12 | spec §8 验收清单增补（独立启停 / 待发送条 / consent / 语音错误横幅抑制 / 设置持久化 / 会话守卫 / 断线清理 / deleteProfile 回退） |
| 10 §7 / 11 §2.3/§2.6/§3 / 12 E-05~E-07 / 16 §7 | 阶段 4 批 B 落地状态与进度 |
| README / CLAUDE.md | 阶段 4 批 B 落地 + 测试计数（1245/100 + 70/15） |

### 13.2 阶段 4 批次 B 定案记录（语音语义与安全）

- **语音族错误路由（D-P15）**：语音族错误码经 real-backend 额外 emit `voice.error`（`onError` 日志/审计保留），connectionStore 对 `VOICE_ERROR_CODES` 不展示全局连接错误横幅——语音错误是会话级预期错误，非连接级。
- **后端 STT 一次性同意（D-P16）**：首个 backend-STT 语音操作（record/realtime/dictation）前弹「音频将发送至后端识别（本机不保留）」确认，「不再提示」持久化 `voice.consentBackendStt`，拒绝则中止。
- **录音字幕终态（D-P17）**：普通录音字幕等 `voice.transcript` 或 `voice.error`（后端 STT 超时/失败恒发 `error{STT_UNAVAILABLE}`），45s 兜底判「未识别」（仅丢弃/重录，不 commit）。
- **单向 IPC 守卫（D-P18）**：`voice:audio-chunk` 经 registry `registerOneWayHandler` 复用 `isTrustedSender` + zod 校验载荷（`bytes.byteLength ≤ 1 MiB`）；仓库零裸 `ipcMain.on`，单向通道不得绕过可信发送者纵深。
- **安全口径**：麦克风权限仅 `media`+audio+受信 renderer origin（deny camera/video）；TTS 二进制不跨 IPC（仅 Main 内存 + MediaService `tts-live` 短期缓存）；转写/内语音不入日志（既有敏感面）。

### 13.3 自动回归

对修订后的 01/02/03/06/07/08/10/11/12/13/16 与 README/CLAUDE.md 执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

> 说明：本次为阶段 4 批次 B 落地的文档同步增量 Review，未重跑完整交叉 Review（真实语音联调、Live2D SDK 许可与模型资源等仍待外部输入）；语音链路 Mock 驱动，真实 Windows Electron（REAL）联调为验收方。

## 14. 增量 Review：阶段 4 真实联调整改同步（2026-08-16）

**触发条件：** doc 13 §9——「修改 Inner Voice、语音或模型服务语义」；阶段 4 真实联调整改（普通录音异常清理 FE-S4-RUN-P0-01/P1-01/P1-02）修订 `voice.discard` 语义（配套后端修订 BE-S4-RUN-P0-01）+ 新增录音停止后「正在识别…」等待态 + `voice.error` recording 态消费门控。

### 14.1 本次修订

| 文档 | 变更 |
|---|---|
| 02 §13.2 | 普通录音 `voice.discard` 语义更新：**可取消任意未提交阶段（RECORDING/TRANSCRIBING/PENDING）+ 幂等成功**（IDLE 迟到/重复 discard 亦成功、不发 `VOICE_RECORDING_NOT_FOUND`）；删「RECORDING 态先 stop 再 discard」「IDLE 迟到 discard → NOT_FOUND」口径；标注依赖配套后端修订 BE-S4-RUN-P0-01 |
| 02 §14 | 关键码补 `VOICE_RECORDING_NOT_FOUND` 注：「IDLE 迟到 discard 幂等成功，不再产生」；现保留码含义为「另一普通录音活跃时 mismatch recordingId 拒绝」 |
| 11 §3 | 普通模式补停止后等待态：停后「正在识别…」（`record.awaitingTranscript`）→ 等 `voice.transcript`/`voice.error` 终态 → 仅真实 45s 超时兜底翻转「未识别，请重试」；等待期试听/删除/重录可用、确认发送禁用；错误与字幕可并存 |
| 13 §13 | 未改动（批次 B 历史记录保留，计数仍为 1245/100 + 70/15），本次仅新增 §14 |
| 16 §7 | 阶段 4 真实联调整改落地状态：discard 幂等语义 + 等待态 + voice.error 门控 + mock 冻结契约建模 + 协议桩漂移 canary；测试计数更新（1284 单测（100 files）+ 73 集成（15 files））；整改后仍待配套后端复验（三态保持） |
| 决策记录 | `2026-08-16-阶段4批次B-决策记录.md` 新增「真实联调整改」段（§10）：R-S4-01~R-S4-08 全表 + 跨仓依赖（BE-S4-RUN-P0-01）+ 漂移 canary 定位说明 + 后续（配套后端修复 SHA 复验） |
| README / CLAUDE.md | 测试计数更新（1245/100 + 70/15 → 1284/100 + 73/15）+ 阶段 4 真实联调整改落地注记（REAL 复验仍待下一轮） |

### 14.2 阶段 4 真实联调整改定案记录（R-S4-01~R-S4-08 摘要）

- **取消收敛（R-S4-01）**：录音取消收敛单一 helper `discardRecord()`——停采集 → await `api.voiceDiscard` → 清态；`startRecord` 采集失败路径改走 helper、不再提前清 recordingId；发送失败 `console.warn` 留痕 + 本地清态（连接 reset 收口）。
- **discard 冻结契约（R-S4-02/R-S4-03）**：不做版本门控 stop fallback，配套后端修订 BE-S4-RUN-P0-01 为唯一取消原语；`MockBackend.discardVoice` 建模冻结契约边界（match 清 / mismatch 拒绝不误清 / realtime·dictation 拒绝不动 / IDLE 幂等成功）。
- **等待态（R-S4-04/R-S4-05/R-S4-07）**：`record.awaitingTranscript` 等待态——stop 后置 true，transcript/error/45s timeout/discard/commit/reset 清；`CyVoicePending` 渲染 错误 > 字幕 > 正在识别 > 未识别（错误与字幕可并存）；空/过短/空转写录音需等满 45s 才显示「未识别」，等待期试听/删除/重录可用、确认发送禁用；集成用 Main 侧 mock env `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS`（无 renderer env 桥）。
- **`voice.error` 门控（R-S4-06）**：`mode==='recording'` 丢弃（防旧会话迟到错误污染新录音展示），其余态照常消费；D-P15 路由与日志/审计不变。
- **fire-and-forget 延迟（R-S4-08，Task 5 ruling）**：`MockBackend.stopRecordVoice` 控制帧 invoke 立即 resolve（与 real send-only 语义一致），仅非空 transcript 的 emit fire-and-forget 延迟 `setTimeout`（tracked + `dispose()` 清理），`activeVoice` 同步清；spec §5.5 与 mock-backend JSDoc 已回写。

### 14.3 自动回归

对修订后的 02/11/13/16 与 README/CLAUDE.md、决策记录执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

> 说明：本次为阶段 4 真实联调整改的文档同步增量 Review，未重跑完整交叉 Review（P0 最终复验依赖配套后端修订 BE-S4-RUN-P0-01 的真实 Windows Electron 复跑，下一轮）；阶段 4 新功能（A/B）保持「已开发、未联调」。

## 15. 增量 Review：阶段 6 批次 A 工具契约与领域层同步（2026-08-20）

**触发条件：** doc 13 §9——「真实协议变更」：后端 B-6 批新增 Server→Client `tool.started/tool.completed` 两帧 + `tool.request.sourceCallId` 必填、v2 停发 `action`；前端批次 A 收编 4 帧（+action 兼容建模）并落地领域层（`ToolCallRecord`/归档配对）。

### 15.1 本次修订

| 文档 | 变更 |
|---|---|
| 02 §10 | 领域模型注记：设计期 `ToolCall` 由批次 A 落地为 `ToolCallRecord`（`id = sourceCallId` 权威键、`desktopCallId?` 桥关联、8 态展示 `ToolCallStatus`）；`arguments` 不进领域事件（Main 侧脱敏为 `inputSummary`）；回传收敛为 `ToolStatusCommand`（wire 六态，Main 组装） |
| 02 §17 | 事件处理规则表 tool.request/started/completed/status 四行更新为批次 A 已接入（脱敏 emit/领域事件映射/归档配对数据源；权限/执行/状态机归批次 B） |
| 02 §19 | 对齐表「工具调用字段」行补 `sourceCallId` + 领域类型 `ToolCallRecord`；新增「Backend 工具生命周期」行（`tool.started/completed`，批次 A 已接入）；`action` 退役 + 前端「已知忽略」建模注记 |
| 04 §2/§4/§11 | 三处注记：sourceCallId 权威键 + ID 双轨（D6-03）；展示 8 态与 wire 六态协议态映射（D6A-05）；Backend Runtime 只展示 + 实时数据源（tool.started/completed）+ 归档配对持久权威 |
| 06 §3.5 | toolStore 三来路归一化注记更新：批次 A 已落地契约/事件映射/归档配对（store 本体归批次 B） |
| 12 §9.7 / 16 §9 | 阶段 6 批次 A 已落地（三态=已开发、未联调）；批次 B 仍待 F-06/F-07/F-09/F-10 |
| 16 changelog | 2026-08-20 批次 A 落地行（提交链 + 门禁计数 + 集成取舍 R-A2） |
| 决策记录 | `2026-08-20-阶段6批次A-决策记录.md`（D6A-01~09 + 执行期 Rulings R-A1~R-A4 + review 修复记录 + 门禁基线） |

### 15.2 交叉 Review 结论

- 契约变更（3 新帧 + action 建模）已在 doc 02 §19 无条件记录；`action` 按「已知忽略」兼容帧处理（对齐 FE-INT-P1-01 state/typing 先例），不作为工具状态源；
- 后端 B-6 批 wire 尚未真实端到端联调（批次 A 为代码批，三态=已开发、未联调）——**不触发全量交叉 Review 重跑**，真实联调（批次 C/开发者事后）后再做收口 Review；
- 信任边界无放宽：原始 `arguments`/安全元数据永不进 Renderer（D6-07）、`tool.status` 仅 Main 组装、批次 A 零新增 Preload/IPC 面。

### 15.3 自动回归

对修订后的 02/04/06/12/13/16 与决策记录执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

## 16. 增量 Review：阶段 6 批次 B Main 工具服务/权限/四执行器/UI 同步（2026-08-20）

**触发条件：** doc 13 §9——「修改安全策略或权限模型」与「真实协议变更」：批次 B 落地 Desktop 工具全生命周期（注册表/黑名单/决策链/四执行器/状态发送/审计）、新 IPC 推送面 `tool:event` + 五个 invoke 通道、权限 UI（CyToolApproval）与工具卡片双区渲染、Live2D `waiting_permission` 真实驱动。

### 16.1 本次修订

| 文档 | 变更 |
|---|---|
| 02 §10 | 批次 B 注记：领域模型补 `PublicToolEvent`（`id = sourceCallId` 权威键、`runtime:'desktop'` 收窄、`pathSummary?/dataFlowNote?/diff?/captureSources?/capturePreview?/attachmentCount?` 扩展、无原始参数/安全元数据）；desktop `tool.request` 不再进 renderer 事件管线（handleFrame 显式 case 路由 tool-service）；`tool.status` 发送方 = Main tool-status-sender（缓存组装 + `adapter.submitToolResult`/`uploadToolAttachment`，上传时序 running 后 result 前） |
| 03 §9/§10 | 工具卡片双区渲染落地注记（实时区 CyLiveToolCards ≤3 + 归档区 message.toolCalls 只读；`requested`/`awaiting_permission` 合并「等待授权」）；权限窗落地注记（CyToolApproval 四问/初始焦点拒绝按钮/对等权重/无倒计时/关闭=拒绝/写 Diff+格式元信息条/截图三步） |
| 04 §2/§6/§7.4/§8/§11/§13/§14 | 注册表四工具元数据落地；IPC 面落地（PushChannels.tool:event + IpcChannels 五 invoke + zod 双端）；§6.3 `PublicToolEvent` 形状对齐（callId→id、增扩展字段、runtime 收窄 desktop）；§7.4 决策链 13 步落地 + F-06（仅黑名单零预授权）/F-07（仅一次/拒绝最小闭环）拍板值；§8 四工具实现要求落地（上限/编码/原子写/截图平台 + §8.1 受控句柄 → selected-set TTL 替代语义 B12）；§11 Backend 审批样式按 D6-08 改写（「批准服务器操作」样式退役、backend 全只读，B13）；§13 幂等落地（paramHash canonical 校验/拒绝保持拒绝/重连重发）；§14 审计落地（tool:request-received/decision/executing/status-sent/terminal + cancelSource + AuditEvent 扩展字段） |
| 06 §3.5 | toolStore 三来路归一化落地 + 双区渲染数据源 + D6B-21 同 id 合并（本地裁决优先）+ waitingForApproval/pendingPathSummary 侧信道 + `MessageSchema.toolCalls` 补 `ToolCallRecordSchema` |
| 07 §9/§10 | Desktop 工具安全落地注记（黑名单默认集含 /tmp 与用户敏感面、full realpath 段边界、执行器安全无 child_process、截图 Win+X11/Wayland 降级）；权限 UI 落地（初始焦点拒绝按钮/关闭=拒绝/M-8 残余风险记录） |
| 12 §4/§9.7 | 外部输入清单 F-06/F-07/F-09 拍板关闭（§4.6 勾选 [x] + 拍板值；F-08 保持 `[ ]`——命令模板空态归批次 C）；§9.7 批次 B 状态注记（三态=已开发、未联调，批次 C 前置；进入条件 F-08 待批次 C 关闭） |
| 16 §9 + changelog | F-6-07~18/22/24 任务行勾选/落地状态；2026-08-20 批次 B changelog 行 |
| 决策记录 | `docs/review/2026-08-20-阶段6批次B-决策记录.md`（D6B-01~22 + 预检拍板 F-06/F-07/F-09/F-10 + 推荐定案 D-§7-4/§7-5 + Rulings R-B1~R-B11 + review 修复记录 + 门禁基线 + 批次 C 前置） |

### 16.2 交叉 Review 结论

- **wire 契约不变**：批次 B 不动 raw wire（`RawFrameSchema`/`RawClientFrameSchema` 服务端帧 shape 零变更，`rawSchemasFingerprint()` 不变，check:contract 13 组 manifest 不刷新）；`PublicToolEvent` 为前端领域公开形状（Main 派生、经 `tool:event` 推送），不入 raw/领域事件联合，与批次 A 四件套无冲突；
- **`PublicToolEvent` 领域形状**：`id = sourceCallId` 权威键 + `desktopCallId?` 桥关联 + `runtime:'desktop'` 收窄 + `pathSummary?/dataFlowNote?/diff?/captureSources?/capturePreview?/attachmentCount?` 扩展；无原始 arguments/paramHash/expiresAt/安全元数据（D6-07），`pathSummary` 只进权限窗/卡片不进审计（H-1）——doc 04 §6.3 已按落地形状对齐；
- **F-06~F-10 拍板记录**：F-06（仅黑名单零预授权）、F-07（仅一次/拒绝最小闭环）、F-09（jsdiff 行级 Diff）、F-10（Win+X11 + Wayland 降级）四项预检拍板 + D-§7-4（read 上限/附件回传）+ D-§7-5（action 保留至阶段 8）全部落文（doc 12 §4.6 / 决策记录 §2）；F-08（受控命令模板）保持 `[ ]`，命令模板空态归批次 C；
- 三态 = **已开发、未联调**（真实 Windows Electron 联调归批次 C/开发者事后）——**不触发全量交叉 Review 重跑**，真实联调后再做收口 Review；
- 信任边界无放宽：四执行器只读 Main 编译后注册的 `executeRef`（无 `child_process`）、`desktop.command.run` 确认不注册、IPC 零通用通道（zod 双端 + `isTrustedSender`）、Renderer 仍只收脱敏公开事件；M-8 残余风险（被攻破 renderer 可自动 allow_once/deny）已显式记录，批次 C 评估 Main 侧原生确认对话框。

### 16.3 自动回归

对修订后的 02/03/04/06/07/12/13/16 与决策记录执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

## 17. 增量 Review：阶段 6 批次 C 目录授权 + 设置页授权管理同步（2026-08-21）

**触发条件：** doc 13 §9——「修改安全策略或权限模型」与「阶段门槛或验收脚本发生变化」：批次 C 落地 allow_scoped 目录授权（GrantStore / 决策链 step 8 grant 匹配 / 后端身份绑定 / 有效期 / 撤销）、设置页「安全与权限」子页（授权管理 / 审批历史 / 命令模板空态 F-08 关闭）、settings.tools grants 子树、L-1~L-8 收口与 GET /api/tools/calls/{callId} 前端实现。

### 17.1 本次修订

| 文档 | 变更 |
|---|---|
| 02 §10.3/§16.2 | repo 状态枚举 9 值表述修正（**非前端 8 态展示态超集**——`result→succeeded`/`error→failed` 后端固定翻译，`requested/awaiting_permission/timeout` 本地态无 repo 对应，`expired` 表达 timeout）；GET tools/calls 前端实现注记（real 已实现 + mock 恒 `null` 降级 + reconnect queryStatus 三分支映射 + 联调复核）；`DesktopCallStatusSchema` 经 rest-schemas.ts 自包含导出（V-12，check:contract REST 段 15→16） |
| 03 §9/§10/§12.5 | CyToolApproval 第三入口「允许指定目录」+ TTL select（1h/24h/7d/30d 默认 24h，消费 `GRANT_TTL_OPTIONS_MS` 同一常量，F-10 一致）；写 grant 命中只读 Diff 卡（F-4）；CySecurityPane 三分区布局（授权管理 / 审批历史 / 命令模板空态）——沙盒/黑名单 UI 明确不落地 |
| 04 §7.2/§7.3/§7.4/§8.3/§14 | 授权范围落地（目录授权+有效期+撤销+后端身份绑定 serverUrl origin）；§7.3 「允许指定目录」入口 + 目录选择器 + 黑名单目录不可授权；§7.4 `PermissionGrant` 形状改写对照（字段对照表 + 「参数限制」降级为「目录范围约束」决策记录）+ 授权记录（settings.tools.grants + grant:* 生命周期审计 `grant:created/revoked/expired`）+ 决策链 step 8 grant 匹配（grant 优先于豁免 F-8、黑名单优先、capture 恒确认）；§8.3 补注（grant 命中自动执行 Diff 只读随 tool:event 下发、无确认按钮，F-19）+ 新文件写 TOCTOU 守卫；§14 审批历史查看器落地（audit JSONL 回读 + 过滤/搜索/跳转撤销 F-21）+ AuditEvent 扩展（`permissionGrantId`/`toolName`/`backendIdentity` + `permissionDecision` 增 `allow_scoped`） |
| 06 §3.7/§8.1/§14 | settings.tools grants 子树（`ToolsSettingsSchema.default({grants:[]})` version 1 向后兼容、patch 无默认子 schema IP-1、save merge 不 clobber）+ GrantStore 边界注记（settingsStore 不消费 tools，`tool:grants` 权威刷新源 F-12；settings.json 篡改即全量失守 N-8） |
| 07 §9 | 目录授权安全（后端身份绑定——切换端点 grant 失效 F-2 / `tool:grants` 全路径暴露面 F-7 / backendIdentity（origin）进入 audit JSONL/tool:history 暴露注记 V-4 / 黑名单优先 step 8 / 目录段边界 / 有效期强制（ttl 白名单双校验）/ 历史脱敏 F-5 / settings.json 篡改即全量失守 N-8 / renderer 可撤销 grant 接受档 F-8） |
| 11 §1/§4/§5/§6 | 「安全与权限」子树改写为授权管理（grants）/审批历史/命令模板空态——沙盒/黑名单 UI 明确不落地（D6B-14 常量化注记） |
| 12 §4/§9.7 | **F-08 关闭**（命令模板空态确认，受控命令不进入 Demo，§4.6 勾选 `[x]`）；§9.7 批次 C 状态注记（三态=已开发、未联调，真实联调归开发者批次后） |
| 16 §9 + changelog | F-6 批次 C 状态行 + 任务勾选（授权管理/目录授权/IPC 四通道/L 收口+GET tools/calls）+ 2026-08-21 changelog 行（实测 1847 单测（142 files）+ 111 集成（17 files），最终以 CLAUDE.md 主会话统一为准） |
| 决策记录 | `docs/review/2026-08-20-阶段6批次C-决策记录.md`（D6C-01~13 + 预检拍板 + Rulings + 门禁 + 验收结论） |
| README / CLAUDE.md | 阶段 6 批次 C 落地状态一句话 + 三态标记（已开发、未联调）+ 计数（以主会话最终更新为准） |

### 17.2 交叉 Review 结论

- **wire 契约不变**：批次 C 不改 raw wire（`rawSchemasFingerprint()` 不变 → 13 组 manifest 不刷新）；check:contract 增量仅 REST 段 `DesktopCallStatus` 入 `REST_TARGET_MODELS`（15→16，V-14）；
- **权限模型收敛**：`PermissionGrant` 落地形状（`{id, toolName, scope:{directory}, backendIdentity, expiresAt:number, source, revokeSource?}`）取代设计期 `subject/subjectId/toolNames[]/argumentConstraints?` 形状——「参数限制」降级为「目录范围约束」（grant 不约束 write content 参数），字段对照表入 doc 04 §7.4；决策优先级「有效范围授权」档由决策链 step 8 grant 匹配实现（黑名单 step 5 恒先拒、grant 匹配优先于 selected-set 豁免（双命中 → 审计 allow_scoped）、capture 恒确认、撤销/过期只影响后续匹配 F-13）；
- **后端身份绑定（F-2，HIGH 修复）**：grant 绑定授权时连接指纹（`new URL(serverUrl).origin`），切换端点 → 不匹配 fail-safe 落 prompt（doc 04 §7.2「后端身份」硬性要求本批落实，不留联调待定）；token 变更不失效为已知语义（契约 F-4）；
- **三态 = 已开发、未联调**（真实 Windows Electron 联调 + GET tools/calls 真实链路验证归开发者批次后）——**不触发全量交叉 Review 重跑**，联调通过后做收口 Review；
- **信任边界无放宽**：grant 创建/撤销/匹配全在 Main；`tool:grant-directory` 只送 `{callId, ttlMs}`（目录选择在 Main，黑名单目录不可授权）；`tool:history` 只读脱敏（summary 已 `redactSensitiveValues`，不渲染原始参数）；`grant:created` 审计不含目录绝对路径（F-5，目录仅存 settings.tools.grants 与 `tool:grants`）；renderer 可任意撤销 grant 为已记录接受风险（F-8，M-8 同档，仅骚扰级无权限提升）；settings.json 篡改即全量失守为已记录接受（N-8，防护 = 黑名单 step 5 恒先拒 + strict 枚举只允 read/write + 装载期逐条校验 + corrupt 隔离回默认）。

### 17.3 自动回归

对修订后的 02/03/04/06/07/11/12/13/16 与 README/CLAUDE.md、决策记录执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。

> 说明：本次为阶段 6 批次 C 落地的文档同步增量 Review，未重跑完整交叉 Review（真实 Windows Electron 联调、后端 GET /api/tools/calls 真实链路验证仍待开发者批次后）；批次 C 代码批三态 = 已开发、未联调。

## 18. 增量 Review：阶段 7 批次 A 安全收敛落地同步（2026-08-22）

**触发条件：** doc 13 §9——「修改安全策略或权限模型」与「阶段门槛或验收脚本发生变化」：批次 A 落地 Markdown DOM 级净化（DOMPurify）、IPC 攻击面核对与安全测试集、verify:sensitive 敏感扫描常驻门禁、「开发与诊断」设置页（日志管理/开发者模式/连接诊断/脱敏诊断导出）、Electron Fuses 三项关闭与产物读回验证、`BackendAdapter.subscribe` 多槽语义升级。**同步时机：批次落地后的文档同步轮**（本章节）——全量 cross-review 按 doc 13 §9 延至真实联调后收口（四维 spec review 不替代）。

### 18.1 本次修订

| 文档 | 变更 |
|---|---|
| 01 §6.1 | `BackendAdapter.subscribe` 多槽语义升级注记（单槽 → 多处理器 Set、重复订阅去重、取消函数不变、单处理器异常 try/catch 隔离、real/mock 双实现对齐、adapter 为后端事件唯一数据源、devTap 为并列消费者） |
| 07 §4/§16/§17 | §4 基线句（84）「二次确认并重启后才可启用」→「二次确认后可启用（会话态，重启恢复禁用）」；§4 注记（91）「阶段 8 Fuses 评估」措辞随 7A 提前（fuses 已落地，阶段 8 为产物复核）；§16 标注「阶段 7 批次 A 已核对」；§17 第 17 项口径修订（默认关 + 二次确认开启路径 + 重启恢复禁用；远程调试恒关不变）+ 核对注记（6/15/19/20 补齐、11 为证据缺口） |
| 08 §8 | 测试矩阵补充注记（markdown-xss 集成（真实 Chromium 安全门禁层）/diagnostics-ipc 集成/verify:sensitive 门禁/fuse 读回断言，对应 §8 各面） |
| 11 §8 | 落地注记（四分区实现态、会话态不持久化、二次确认文案、Adapter 映射由事件条目领域名承担、Live2D 帧耗时延 7C、导出二次脱敏） |
| 12 §4.8 | H-09 行（182）「正式确认待产品」→「已确认（默认关+二次确认开关）」——引语归属 doc 16 §2.8:166（一致 N-4） |
| 16 §2.8/§4.0/§4/§10 + changelog | H-09 行升 [x] 并改写行本体（「恒关」→「默认关 + 设置页二次确认开关（会话态）」）；§4.0 决策表开发者模式行修订并注记「2026-08-21 用户拍板修订」（修订 2026-08-08 前置决策）；§4 生产恒关落地项行注记修订；§10 阶段 7 状态注记 + 任务清单勾选/验收门槛标注（7B/7C/7D 归属）；2026-08-22 changelog 行（门禁计数以验收记录为准，主会话回填） |
| 17 / README | verify:sensitive 命令说明（doc 17 新节 + README 命令表）；fuse/打包相关命令注记（verify:artifact 静态读回 + smoke flip-back、electron-builder.yml `electronFuses` 三键） |
| spec §5.1（设计文档） | verify:sensitive 黑名单修正为 8 规则（第 8 条 40+ base64）+ 排除清单同步（third_party/ + vendored live2d 两树 + 扫描器自身自排除 + 类别级 allowlist 仅豁免 base64-long-string 的规则域语义）——Task 7 LOW-2 |
| 决策记录 | `docs/review/2026-08-22-阶段7批次A-决策记录.md`（D7A-01~15 + 用户拍板 + 委托裁决 + review 记录 + 提交链） |
| 安全发布清单核对 | `docs/review/2026-08-22-阶段7批次A-安全发布清单核对.md`（doc 07 §17 20 项逐条证据/状态，第 11/18 项证据缺口 + 影响面） |
| README / CLAUDE.md | 阶段 7 批次 A 状态一句话 + 三态标记（已开发、未联调）；门禁计数以主会话批次收口统一更新为准 |

### 18.2 交叉 Review 结论

- **安全策略变化（需重点说明）**：开发者模式由「生产恒关、无开启路径」（2026-08-08 阶段 1 前置决策）修订为「默认关 + 设置页二次确认开关（会话态，重启恢复禁用）」——用户 2026-08-21 拍板（D7A-04/05）；无 DevTools 菜单旁路（生产菜单无 devtools 角色）、F12 门单一（`config.devToolsAllowed || isDevMode()`）、远程调试恒关不变（rejectForbiddenDebugSwitches 不动）、已保存凭据不可读回不变；「二次确认可被 renderer invoke 直调绕过」为接受档（与 M-8 同档——不新增能力，防误触非防攻击；D7A-04 二道防线说明）。
- **信任边界无放宽**：诊断面全部元数据零正文——协议事件条目仅 `{ts, type, preview}` 白名单（preview 先 redact+sanitize 双净化再截断 ≤200 含尾标、禁 text/正文/arguments）、Store 摘要仅计数/枚举、导出 summary 无正文、导出路径不回传绝对路径（displayDir/displayPath 分别 sanitize/用户自选回显）；诊断导出前逐行二次脱敏（>1MiB 超长行整行丢弃并计数）；rawType 删除（BackendEvent 判别字段为 `event`，real 兼容帧静默消费，无数据源）。
- **行为变更点**：① `BackendAdapter.subscribe` 单槽 → 多处理器 Set（接口语义升级——doc 01 §6.1 已同步；mock 防并列订阅覆盖既有聊天订阅；devTap 回调异常隔离 try/catch + logger.warn）；② Markdown 净化替换（移除 decodeEntities/sanitizeHtml/DANGEROUS_TAGS/NAMED_ENTITIES；img src `data:` 经 DOMPurify DATA_URI_TAGS 保留、任务列表 input 剥离——记录为已知行为）；③ `devTools: true` webPreferences（开关为唯一开启路径；verify:artifact 旧「生产无 DevTools」断言面核实无此断言，变更处全部列出）；④ Fuses 三项关闭（RunAsNode/EnableNodeOptionsEnvironmentVariable/EnableNodeCliInspectArguments=false——`--inspect` 系参数面产物级收口，NODE_OPTIONS 注入面关闭，与 rejectForbiddenDebugSwitches 双保险；OnlyLoadAppFromAsar/EmbeddedAsarIntegrityValidation 保持现状归阶段 8）。
- **已知限制与记录**：happy-dom 非可信消毒 oracle（单元层仅行为记录，安全门禁全归真实 Chromium 集成层）；verify:sensitive 自排除盲区（扫描器三文件恒定盲区，变更须过 review——已注释）；类别级 allowlist 仅豁免 base64-long-string 规则（规则域限定——规则 1-7 不被通用条目弱化）；第三方 vendor（third_party/+vendored live2d 两树）整体排除（必然误报且非本仓代码）；flip-back smoke 副本（产物本体保持 flipped，读回断言证明最终态）。
- **三态 = 已开发、未联调**（真实 Windows Electron 联调归开发者批次后）——**不触发全量交叉 Review 重跑**，联调通过后做收口 Review。
- **门禁**：verify:sensitive 提交树 exit 0（黑名单 8 规则、570 扫/368 排除/1591 放行——以提交树实测为准）+ verify:artifact 静态读回 DISABLE×3 + `--smoke`（xvfb，flip-back 副本）+ check:contract（wire 未变）+ 全量单测/集成；**计数最终值以主会话批次收口（CLAUDE.md）为准**。

### 18.3 自动回归

对修订后的 01/07/08/11/12/13/16/17 与 README、spec §5.1、决策记录、安全发布清单核对执行结构回归（表格列数、代码围栏、重复标题、失效相对链接），结果 0 异常（见提交时检查）。
