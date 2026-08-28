# Cyrene 后端配合改造任务清单

**文档状态：** 已归档
**最后核验：** 2026-08-29
**适用阶段：** 阶段 0～2 的后端交接历史
**权威范围：** 后端早期改造任务和交接基线；当前后端契约不以本文为准
**原基线 Commit：** `94c0b8f514b2a8dafaa403b243992f23bd4a0b0e`
**原交接包 SHA-256：** `059142ECFCD3CD9A207149B5576B4A995C2F132425836C87488BF10C0679D3CA`
**初始文档日期：** 2026-08-04

---

## 1. 文档目的

本文把 Electron 前端完整 Demo 所需的后端配合项整理为可实施任务。它不是要求推翻现有后端；优先在保留现有 WebSocket、REST、工具框架和模型注册表的基础上增加稳定契约、产品级接口和客户端 Runtime 桥。

前端可以先基于当前协议开发安全壳、Mock、单会话聊天和兼容 Adapter，但以下缺口会阻塞完整产品：

- 远程后端的业务接口和 WebSocket 目前匿名且无内建 TLS；
- 当前只有单活动会话，没有产品级多会话、会话内历史、搜索和来源定位；
- 流式回复没有父回复 ID、消息确认、客户端幂等、明确完成事件和结构化生成错误；
- 当前没有 Desktop Runtime，服务器沙盒文件工具不能代表用户电脑；
- 用户从 Electron 添加自定义模型时，密钥无法安全保存并用于后续切换；
- 当前 STT 自动提交，不符合普通录音、实时语音、输入法转写三种独立语义；
- 当前只完整支持图片，视频、音频、普通文件、表情资源和统一历史查看器没有服务端闭环。

## 2. 已确认的后端现状

基于交接包的静态代码扫描，当前后端已有：

- aiohttp HTTP、WebSocket 主通道和 Debug SSE；
- 文本及图片消息；
- `delta`、句子边界、Inner Voice、心情、Token、TTS 音频、工具状态等事件；
- LLM/STT/TTS Provider 列表、自定义 Provider 元数据、测试、切换和服务开关；
- 12 个服务器进程内工具和 HITL 审批；
- 服务器沙盒内的 `read_file`、`write_file`；
- 单活动会话回放、Mongo 消息归档和 `_id` 游标分页；
- VAD 驱动的 PCM STT 自动提交和流式 TTS；
- Pydantic 前端契约及 TypeScript 生成器。

这些结论来自静态扫描，实施前仍需由后端在基线 Commit 上运行契约检查、快速测试和一次真实协议抓取。

## 3. 不可混淆的语义

### 3.1 Backend 工具不等于 Desktop 工具

现有 `read_file`、`write_file` 访问的是后端服务器上的 `data/sandbox/{session_id}`。它们属于 **Backend Runtime**，不能映射成：

- `desktop.file.read`；
- `desktop.file.write`。

Desktop Runtime 指 Electron 所在的用户电脑。它必须采用“后端请求客户端执行 → 客户端本地校验和审批 → 客户端执行 → 回传结果”的协议。后端永远不能把服务器路径当作用户电脑路径。

### 3.2 模型执行位置不等于工具 Runtime

LLM、STT、TTS Profile 的执行位置使用独立概念：Backend、本机模型适配层或 Local Worker。只有模型产生工具调用时，才进入 Backend/Desktop/Local Worker 工具状态机。

### 3.3 三种语音场景必须独立

1. **普通录音输入：** 用户录音，停止后进入待发送状态；确认后才形成语音输入。STT 字幕不修改文字草稿。
2. **实时语音会话：** 用户明确开启持续会话，支持 partial/final 字幕、VAD/断句和语音轮次。字幕不修改文字草稿。
3. **输入法转写：** 按住说话，松开后只返回最终文字并写入前端草稿；不创建消息、不触发 Agent、不自动发送。

模型服务仍然只有 LLM、STT、TTS 三类。输入法转写只选择一个兼容 STT Profile，不是第四类模型。

## 4. 优先级说明

| 优先级 | 含义 |
|---|---|
| P0-开工 | 在冻结真实联调契约前完成 |
| P0-聊天 | 在完整核心聊天验收前完成 |
| P0-历史 | 在 QQ 式会话、历史和资源功能验收前完成 |
| P0-模型语音 | 在设置中心和语音链路验收前完成 |
| P0-工具 | 在 Desktop 本地工具 Demo 验收前完成 |
| P1 | 不阻塞第一轮纵向闭环，但应在发布候选前评估 |

## 5. 任务总表

| ID | 优先级 | 任务 | 当前状态 | 目标结果 |
|---|---|---|---|---|
| BE-001 | P0-开工 | 契约基线与真实事件验证 | 只有静态推导样例 | 真实抓包、生成契约和测试结果可复现 |
| BE-010 | P0-开工 | 远程认证和传输安全 | WS、业务 REST、上传匿名；明文 HTTP/WS | 远程连接必须认证，生产使用 HTTPS/WSS |
| BE-020 | P0-开工 | 协议版本与能力协商 | 无运行时版本 | 客户端能判断兼容性和可用能力 |
| BE-021 | P0-聊天 | 用户消息确认、稳定 ID 与幂等 | 无 ACK、无客户端请求 ID | 重试不重复，消息能稳定定位 |
| BE-022 | P0-聊天 | 结构化流式回复事件 | 靠状态和空消息推断 | 父回复、分段、增量和完成具有明确标识 |
| BE-023 | P0-聊天 | 结构化完成、失败和取消 | 完成=`idle`，部分错误为 `❌` 文本 | 前端不解析文案判断协议状态 |
| BE-024 | P0-聊天 | 重连恢复语义 | 只回放会话和 pending 审批 | 明确恢复、终止和不可恢复边界 |
| BE-030 | P0-历史 | 产品级多会话 API | 单活动会话，Debug API 不可作为产品 API | 创建、列表、切换、重命名、删除及隔离 |
| BE-031 | P0-历史 | 会话内历史、上下文和搜索 | 全局归档分页，缺少上下文/日期/会话搜索 | 稳定游标、来源定位和组合查询 |
| BE-032 | P0-历史 | 会话资源索引 | 无独立资源索引 | 图片/视频/音频/表情/文件/链接可分页并跳回消息 |
| BE-040 | P0-工具 | Runtime 感知的 Tool Registry | 所有工具在服务器进程执行 | 工具声明明确 Backend/Desktop/Local Worker |
| BE-041 | P0-工具 | Desktop 工具请求/结果桥 | 不存在 | Agent 可安全请求 Electron 执行四个 P0 工具 |
| BE-042 | P0-工具 | 结构化审批与本地授权边界 | Backend 审批参数是截断字符串 | 审批主体、参数摘要、Runtime 和风险可验证 |
| BE-043 | P0-工具 | 工具幂等、取消和重连 | 仅 pending 审批可重播 | `callId` 不重复产生副作用 |
| BE-050 | P0-模型语音 | 模型 Profile 与密钥所有权 | Profile 可配，密钥只引用服务器环境变量 | Electron 可完成安全的添加、测试、切换和删除 |
| BE-051 | P0-模型语音 | TTS 声音列表和试听 | 无接口 | 设置页可列出、试听并选择声音 |
| BE-060 | P0-模型语音 | 普通录音输入协议 | 当前 VAD 后自动提交 | 用户确认后才提交语音输入 |
| BE-061 | P0-模型语音 | 实时语音会话协议 | 无 Session、字幕和背压 | 有序音频块、partial/final、轮次和取消 |
| BE-062 | P0-模型语音 | 输入法转写协议 | 无独立场景 | 最终文字返回但绝不创建消息或触发 Agent |
| BE-063 | P1 | TTS 播放控制增强 | 有流式音频，取消结束不完全结构化 | 明确 playback ID、完成、取消和格式；口型可由前端振幅估算 |
| BE-070 | P0-历史 | 通用附件和媒体链路 | 仅图片完整可用 | 视频、音频、文件、表情资源可安全上传和引用 |
| BE-071 | P1 | 缩略图、Range 和资源清理 | 无 | 大资源可播放，孤儿附件可清理 |
| BE-080 | P0-开工 | 统一错误目录 | 多种错误形状 | 稳定错误码、可重试标志和关联 ID |
| BE-081 | P1 | 健康、版本和可观察性 | 有健康检查，无协议版本 | 可追踪版本、事件和失败且不泄漏敏感数据 |

## 6. P0-开工任务详情

### BE-001 契约基线与真实事件验证

后端需要在基线 Commit 上提供：

1. `frontend/src/types/contract.generated.ts`；
2. `frontend_contract/` 的契约源；
3. `python -m frontend_contract --check` 的成功输出；
4. WS、Provider、工具审批相关快速测试的成功输出；
5. 一份真实、脱敏的 WebSocket JSONL：建连 → 用户消息 → Inner Voice → 至少三句 Public Reply → Token/模型/心情 → 完成；
6. 一份取消和一份工具审批的真实脱敏记录；
7. 确认时间戳统一为 UTC ISO 8601。交接包对“UTC/本地时间”存在互相矛盾的描述，应以代码和测试为准；
8. 修正交接资料中 Backend 沙盒工具被误标为 Desktop 工具的问题。

验收：样例逐行可解析；真实抓包和契约快照一致；已知 wire 偏差要么修复，要么进入兼容清单和测试。

### BE-010 远程认证和传输安全

产品已确定后端可以远程部署，因此开发默认匿名只能用于本机受控环境。

最低要求：

- `/ws`、业务 `/api/*`、上传和受保护资源都需要认证；
- Electron Main 持有凭据，Renderer 不接触明文；
- 凭据放在 `Authorization` Header 或等价的安全握手机制中，不放 URL 查询参数；
- 生产使用 HTTPS/WSS；后端可由反向代理终止 TLS，但部署文档必须明确；
- 跨 Origin 重定向不得转发凭据；
- 上传 URL 不能永久匿名公开，可使用受保护下载或短期签名 URL；
- 绑定非回环地址且未启用认证时应拒绝启动或输出显著阻塞告警；
- 限制请求大小、速率、并发连接和认证失败重试；
- 自定义 Provider 测试中可能包含 API Key，绝不能通过明文 HTTP、匿名接口或普通日志传输；
- Debug 和管理 Token 不应被误当作产品用户认证，二者权限域分开。

Demo 推荐：单用户访问 Token + HTTPS/WSS，暂不引入复杂多租户登录。实现需保留后续轮换和撤销能力。

验收：匿名 WS、业务 REST、上传和资源读取均被拒绝；有效身份可完整聊天；日志不包含 Token；TLS/反向代理部署有可重复测试。

### BE-020 协议版本与能力协商

建议在 `capabilities` 或连接首帧提供：

```json
{
  "protocol_version": "2.0",
  "server_version": "<version>",
  "features": {
    "structured_generation": true,
    "multi_conversation": true,
    "desktop_runtime": true,
    "dictation": true
  }
}
```

旧客户端协议如需保留，应明确兼容窗口。不要让客户端通过字段是否存在来猜服务器版本。

## 7. P0-聊天任务详情

### BE-021 用户消息确认、稳定 ID 与幂等

客户端发送至少携带：

- `clientRequestId`：一次命令或生成请求；
- `clientMessageId`：用户消息的本地稳定 ID；
- `conversationId`；
- 内容和附件引用。

服务端确认返回：

- 正式 `messageId`；
- 原 `clientRequestId/clientMessageId`；
- 接收时间和状态。

相同 `clientRequestId` 重试不得创建第二条消息或第二次生成。相同 ID 但负载摘要不同必须返回协议错误。

### BE-022 结构化流式回复

前端领域至少需要以下稳定语义，实际事件名可以不同，但必须由契约和 Adapter 明确映射：

```text
generation.started
generation.segment.started
generation.delta
generation.segment.completed
generation.completed
generation.failed
```

关键字段：

- `generationId`；
- `messageId`；
- `responseId`；
- `segmentId`；
- `segmentIndex`；
- `deltaSequence`；
- `channel: inner_voice | public_reply | status`；
- `kind: text | markdown | image | video | audio | file | sticker | link`。

约束：

- 一次 AI 回复的所有句子共享同一 `responseId/messageId`；
- 每个句子或多媒体分段拥有独立 `segmentId`；
- `segment.completed` 不能结束父回复；
- Inner Voice 和 Public Reply 可以交错，但按全局 `segmentIndex` 排序；
- P0 Inner Voice 只允许文本/Markdown；
- Assistant 可见正文只有一个事实来源，不能把相同内容同时写入普通正文和分段；
- 当前 `message content:""` 可以在兼容层继续作为旧句子边界，但 v2 客户端不应依赖空消息推断。

### BE-023 完成、失败、取消和统计

父完成事件至少包含：

- `finishReason`；
- 本次回复 `usage`；
- 会话累计 `conversationUsage`；
- 实际模型；
- 心情；
- 完成通道和完整性状态。

错误必须结构化：错误码、公开消息、是否可重试、关联 ID。禁止要求前端解析 `❌` 文本前缀判断失败。

取消后必须明确终止对应 generation 和 TTS playback；迟到增量要么被服务端丢弃，要么携带足够 ID 供前端拒绝。

### BE-024 重连恢复

定义：

- 最新事件游标或 generation 状态查询；
- 正在生成的回复是续传、标记中断还是重新获取完整消息；
- pending 用户消息和工具调用如何查询；
- 终态事件是否可以安全重放；
- 客户端不得在不确定服务端是否已接收时自动重发副作用操作。

## 8. P0-历史任务详情

### BE-030 产品级多会话 API

不能直接把 Debug 接口作为产品 API。至少需要：

- 列出会话：游标、页大小、搜索词、稳定排序；
- 创建会话；
- 获取会话和第一页消息；
- 切换或为每次消息指定 `conversationId`；
- 重命名；
- 删除并定义消息、资源、记忆和附件的联动；
- 会话之间的上下文、Token、工具和模型状态隔离。

Demo 为单用户，但仍需要多个聊天会话。前端本地模拟多会话不能替代后端上下文隔离。

### BE-031 历史、上下文与搜索

至少提供：

- 按会话获取消息页；
- 不透明游标、稳定排序键、`hasMore` 和可选快照 ID；
- 根据 `messageId` 获取目标前后上下文；
- 当前会话和全部会话搜索；
- 关键词、本地自然日 + IANA 时区、分类组合过滤；
- 搜索结果返回 `conversationId/messageId/responseId/segmentId`；
- 服务端按 `[dayStart, nextDayStart)` 解释自然日，避免 UTC 跨日错误。

当前 `/api/messages` 的全库 `_id` 游标可以保留为兼容接口，但不能作为产品级会话历史的唯一接口。

### BE-032 资源索引

资源分类至少包括：图片/视频、表情、文件、音频、链接。每项返回来源消息 ID、时间、缩略图或下载引用；分页和权限与会话一致。

## 9. P0-工具任务详情

### BE-040 Runtime 感知的 Tool Registry

工具定义增加或可派生：

```text
runtime: backend | desktop | local_worker
riskLevel: safe | medium | high
permissionRequired: boolean
approvalAuthority: backend | client
inputSchema / outputSchema
version
```

现有 12 个 Python 工具默认是 Backend Runtime。现有服务器沙盒 `read_file/write_file` 继续作为 Backend 工具，禁止伪装成 Desktop。

### BE-041 Desktop 工具桥

Demo P0：

- `desktop.file.select`；
- `desktop.file.read`；
- `desktop.file.write`；
- `desktop.screen.capture`。

`desktop.command.run` 不属于默认 P0，未单独确认时不得注册。

推荐流程：

```text
Agent 选择 Desktop 工具
→ 后端创建 callId 并向目标客户端发送结构化请求
→ Electron Main 校验工具、路径、黑名单、沙盒和权限
→ 用户审批
→ Electron 执行
→ Electron 回传结构化结果或附件引用
→ 后端把结果交还 Agent
```

请求至少包含：`callId`、工具 ID、版本、Runtime、参数、原因、风险、审批主体、过期时间、目标连接/设备。结果至少包含状态、公开输出、错误、附件引用、执行摘要和参数哈希。

### BE-042 审批边界

- Backend 工具审批不能创建 Desktop 本地授权；
- Desktop/Local Worker 的 `approvalAuthority` 必须为 `client`；
- 当前 `str(params)[:200]` 只能作为兼容显示摘要，不能作为客户端安全决策的权威参数；
- 客户端只接受已注册工具和版本；
- 后端不得发送任意 JavaScript、Python、Shell、PowerShell 或 Bash 字符串要求执行。

### BE-043 幂等与恢复

相同 `callId` 不得重复弹窗、写文件、截图或上传。相同 ID 的工具、Runtime、版本或参数摘要变化时拒绝。重连后可以查询调用状态和重传结果，但不能自动重做已经产生副作用的操作。

## 10. P0-模型与语音任务详情

### BE-050 模型 Profile 和密钥

支持 LLM、STT、TTS 三类 Profile：列表、新增、同名更新、测试、激活、删除和能力字段。

当前 `api_key_env` 模式适合服务器运维预配置，但不能完成“用户在 Electron 设置页添加带密钥的自定义模型”。后端需要明确选择并实现：

1. **推荐：服务器安全保存。** Electron 一次性提交密钥，后端写入受控 Secret Store，只返回 `credentialConfigured=true`，永不读回；或
2. **明确限制为运维预配置。** 前端只显示环境变量缺失状态，不能声称用户已经完成自定义模型配置；需要本机执行的 Profile 由 Electron Main/Local Worker 独立管理。

自定义 Endpoint 必须防 SSRF：远程默认 HTTPS；重新解析 DNS 和重定向；拒绝云元数据、链路本地和未授权私网；敏感 Header 不跨 Origin；Header 使用允许名单；测试只使用固定最小样例。

### BE-051 TTS 声音

提供可用声音列表、当前声音、能力、语言和试听。试听使用固定短文本，不读取真实聊天。删除或切换失败时保留原选择。

### BE-060 普通录音输入

增加显式录音会话或一次性上传/提交：录音停止后不触发 Agent，客户端确认 `commit` 后才进入语音消息/Agent 流程。可返回字幕，但字幕不等同于文字消息。

### BE-061 实时语音会话

定义 Session ID、音频格式、块序号、最大未确认块、背压、partial/final 字幕、VAD、轮次提交、暂停、恢复、取消和最终块。字幕只用于会话显示。

### BE-062 输入法转写

提供只做 STT 的接口或会话：

- 选择兼容 STT Profile；
- 接受按下/松开/取消或一次性音频；
- 返回 partial（可选）和 final；
- final 只返回文字；
- 不写服务器聊天历史；
- 不创建 UserInputData；
- 不触发 Agent；
- 不自动发送；
- 取消或失败后清理临时音频。

## 11. P0-媒体任务详情

通用上传至少支持图片、视频、音频和文件，表情可使用稳定资源 ID。要求：

- 上传前校验数量、大小、MIME 和编码；
- 返回稳定附件 ID，而不是只返回永久匿名 URL；
- 下载鉴权或短期签名 URL；
- 视频/音频支持 Range；
- 资源和来源消息关联；
- 删除消息/会话后的引用计数或垃圾清理；
- 不支持的媒体提供结构化错误；
- 明确第一版 MIME/编码矩阵。

## 12. 统一错误和日志

建议错误结构至少包含：

```json
{
  "code": "STABLE_ERROR_CODE",
  "message": "用户可理解的公开说明",
  "retryable": false,
  "requestId": "...",
  "generationId": "...",
  "callId": "...",
  "details": {}
}
```

`details` 必须公开安全，禁止包含密钥、完整聊天、Inner Voice、文件内容、未脱敏路径或工具敏感参数。日志使用关联 ID，不记录正文。

## 13. 建议实施顺序

| 批次 | 内容 | 进入下一批前的门槛 |
|---:|---|---|
| 0 | BE-001：真实契约、抓包和测试基线 | 事实无矛盾、样例可重放 |
| 1 | BE-010、BE-020、BE-080：认证、版本、错误基线 | 远程匿名访问被拒绝 |
| 2 | BE-021～024：聊天 ID、分段、完成、幂等、恢复 | 前端不靠文本/空消息判断终态 |
| 3 | BE-030～032：多会话、历史、搜索和资源 | 两个会话隔离且结果可定位 |
| 4 | BE-040～043：Runtime 与 Desktop 工具桥 | 四个 Desktop P0 工具完成安全往返 |
| 5 | BE-050～051：模型 Profile、密钥和声音 | 三类 Profile 可安全新增、测试、切换 |
| 6 | BE-060～063：三种语音和 TTS 控制 | 三种模式的数据去向互不混淆 |
| 7 | BE-070～071、BE-081：媒体、清理和发布收敛 | 多媒体、版本和回归通过 |

批次 1、2 是远程真实联调的前置条件。前端可以在此期间开发 Electron 壳、Mock 和兼容 v1 Adapter。

## 14. 总体验收场景

### 场景 A：多句 AI 回复

用户消息获得 ACK；同一 `responseId` 下出现 Inner Voice 和三个 Public Reply 分段；Token、模型和心情在父完成事件落位；重放不会重复内容。

### 场景 B：断线与幂等

发送后断线并使用同一 `clientRequestId` 重试，只存在一条用户消息和一次生成；客户端可确定回复是完成、中断还是需要重新获取。

### 场景 C：多会话历史

创建两个会话，内容和上下文互相隔离；历史向上分页不重不漏；按日期、关键词和资源类别查询后能跳回来源消息。

### 场景 D：Desktop 文件读取

Agent 请求 `desktop.file.select/read`；客户端显示真实 Runtime、原因和范围；用户批准后 Electron 执行并回传；后端服务器沙盒工具不参与；相同 `callId` 重放不重复读取或弹窗。

### 场景 E：Desktop 文件写入

客户端展示 Diff、目标、参数哈希和授权范围；文件外部变化时拒绝覆盖；结果返回 Agent；后端不能通过任意 Shell 绕过。

### 场景 F：语音模式隔离

普通录音等待用户确认；实时语音显示 partial/final 字幕并提交语音轮次；输入法转写只返回草稿文字。三者取消后均不会误发消息。

### 场景 G：远程安全

匿名 HTTP/WS/上传被拒绝；有效身份通过 HTTPS/WSS 完成聊天、媒体和工具；日志、错误和诊断不出现 Token、API Key、语音正文或本地路径。

## 15. 后端完成后需重新交付

1. 新 Commit ID 和变更摘要；
2. 更新后的 `frontend_contract/`；
3. 更新后的 `contract.generated.ts`；
4. 产品级 REST/WS 契约和错误目录；
5. 真实脱敏 JSONL：聊天、取消、重连、Backend 工具、Desktop 工具、三种语音；
6. 自动测试结果；
7. 升级/兼容说明；
8. 未完成项和风险；
9. 不含密钥的本地/远程联调启动说明。

后端无需为了前端偏好的字段名无意义重构，但必须提供上述稳定语义和明确映射。
