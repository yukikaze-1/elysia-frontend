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
- 图片/视频、绘画资源、表情、文件、音频和链接都保存来源消息引用；
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
11. Live2D 默认展开状态、宽度、聊天最小宽度和极窄窗口阈值；
12. Inner Voice 默认展开策略和是否按会话记忆。

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

- **E-07 / 02 §19 D-8**：输入法转写专用 STT Profile——后端 `dictation.start` 无独立 STT 字段，用当前活动 STT；待后端决策是否加字段或前端切活动 STT；
- **F-06~F-09**：沙盒目录/路径/域名黑名单、授权级别、受控命令模板、Diff/覆盖策略——产品与安全决策，不因后端契约自动关闭；
- **G-01~G-03/G-05/G-06**：Live2D SDK 许可、合法模型、表情/动作白名单、口型驱动、降级策略；
- **H 组**：主验收平台、Windows 10/Ubuntu/Wayland 范围、打包签名与发布渠道、演示脚本等产品决策；
- **B-01/B-07**：真实测试环境地址与数据保留策略（需实际部署，交接包不含）。

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
