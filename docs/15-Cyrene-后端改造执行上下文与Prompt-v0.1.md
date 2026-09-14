# Cyrene 后端改造执行上下文与 Prompt

**文档状态：** 已归档
**最后核验：** 2026-08-29
**适用阶段：** 阶段 0～2 的后端执行历史
**权威范围：** 早期后端改造 Prompt；不得直接用于当前后端
**原目标仓库：** Cyrene / Elysia Agent 后端
**原基线 Commit：** `94c0b8f514b2a8dafaa403b243992f23bd4a0b0e`
**原配套任务清单：** `14-Cyrene-后端配合改造任务清单-v0.1.md`
**初始文档日期：** 2026-08-04

---

## 使用方式

把本文和《Cyrene 后端配合改造任务清单》一起交给能够访问后端仓库的代码模型。让模型在后端仓库根目录工作。本文以下内容可直接作为执行 Prompt。

---

## 可直接执行的 Prompt

你是 Cyrene Agent 后端的实现负责人。请在当前后端仓库中，依据随附的《Cyrene 后端配合改造任务清单》完成面向 Electron 前端的后端改造。

你的目标不是重写后端，而是在保留现有成熟能力的基础上建立：

1. 可安全远程连接的业务接口；
2. 有稳定 ID、分段、完成、失败和幂等语义的聊天协议；
3. 产品级多会话、历史、搜索和资源接口；
4. Backend/Desktop/Local Worker 分离的统一工具系统；
5. LLM/STT/TTS Profile 的安全配置、测试和切换；
6. 普通录音、实时语音、输入法转写三种不混淆的语音链路；
7. 图片、视频、音频、文件和表情资源闭环；
8. 可生成给 Electron 使用的正式契约、真实样例和测试证据。

## 一、项目背景

Cyrene Desktop 是 Electron + Vue 3 + TypeScript 的个人 AI 桌面客户端。主界面接近 QQ：导航、会话列表、聊天区和右侧 Live2D 角色栏。角色栏打开时扩展布局，不能覆盖聊天。

前端核心能力包括：

- 一次 AI 回复包含多个按句流式分段；
- 同一回复中区分 Inner Voice 和 Public Reply，并保持真实全局顺序；
- 回复级/会话级 Token、实际模型和心情；
- 图片、视频、音频、文件、表情和链接；
- 历史懒加载、搜索、按日期查询和统一聊天历史查看器；
- LLM/STT/TTS 模型接入、测试、切换和自定义 Profile；
- 普通录音输入、实时语音会话、按住说话转文字；
- Live2D 模型切换、状态、TTS 口型和安全降级；
- Backend、Desktop、可选 Local Worker 工具；
- 沙盒、路径/域名黑名单、审批历史和范围授权。

后端是远程 Python 服务。Electron Main 负责网络、凭据和本地能力；Renderer 不直接持有后端 Token、模型密钥、本地绝对路径或通用系统 API。

## 二、当前后端事实基线（2026-08-09 基线快照）

在修改前必须重新核对以下交接结论；它们来自基线 Commit 的静态扫描，不得替代真实代码：

- aiohttp 单进程同时提供 HTTP、`/ws` WebSocket 和 Debug SSE；
- 当前 WS/业务 REST/上传匿名，无内建 TLS；`SERVER_AUTH_TOKEN` 只保护管理和 Debug；
- 当前只有单活动会话；会话列表/详情/删除只存在 Debug 端点；
- 当前用户消息无 ACK，流式回复无父消息 ID/response ID/generation ID；
- 句子以 `message content:""` 间接分界，完成主要靠 `state:"idle"`；
- 部分生成错误以 `❌` 文本 delta 表示；
- Inner Voice 是 `command=inner_voice`；Public Reply 是 `delta/message`；
- Token 是 Provider 返回的真实统计；心情通过 `expression`；
- TTS 使用 `audio/audio_end`，音频块带 `stream_id/seq`；
- 有 12 个服务器进程内工具和 HITL 审批；
- `read_file/write_file` 只访问服务器沙盒；
- 不存在 Desktop Runtime 和 Local Worker Runtime；
- Provider 系统支持 LLM/STT/TTS 元数据、测试、切换和 custom 条目；custom 密钥只引用后端环境变量；
- 当前 STT 是 PCM + VAD 后自动提交，无按住说话草稿模式和实时字幕协议；
- 当前只有图片上传完整打通；
- 存在 `frontend_contract/` 和 `contract.generated.ts` 生成流程。

如果代码与以上描述不同，以当前代码为准，并先更新事实报告再实施。

> **2026-09-14 标注（C-15-1，同 doc 14 §5 一类）：** 上列是 **2026-08-09 交接基线快照**，其中「不存在 Desktop Runtime 和 Local Worker Runtime」「当前 STT 是 PCM + VAD 后自动提交，无按住说话草稿模式和实时字幕协议」「当前用户消息无 ACK，流式回复无父消息 ID/response ID/generation ID」「只有单活动会话」等多条**已被后续后端改造与前端阶段 2/4/6 取代**（含输入法转写独立 `sttProfileId`：后端 `556117a`，见 doc 02 §19 D-8 与 doc 18 §15.2 标注）。原文按归档纪律保留不改；当前后端契约与状态**不以本文为准**（doc 16 §3、doc 02 §19）。**注意：并非每条都已闭环**——doc 14 §5 `BE-032`（会话资源索引）仍为未闭环缺口。

## 三、必须纠正的错误口径

### 1. 不得把服务器沙盒工具标成 Desktop

现有 `read_file/write_file` 属于 Backend Runtime。禁止把它们重命名或映射成 `desktop.file.read/write`。Desktop 工具必须由 Electron Main 在用户电脑执行。

### 2. 不得让后端直接操作用户电脑

后端只能发送结构化、已注册的 Desktop 工具请求。Electron 负责本地路径解析、黑名单、沙盒、权限、审批、执行和审计。

### 3. 不得把输入法转写设计成第四类模型

模型类型只有 LLM、STT、TTS。输入法转写只是选择一个 STT Profile 的独立使用场景。

### 4. 不得依赖 Debug API 充当产品 API

Debug 路由、权限和数据语义可以复用内部 Service/Repository，但需要正式产品端点、契约和权限。

### 5. 不得把兼容启发式当成正式协议

旧前端可以继续根据 `idle`、空 `message` 和本地状态拼回复；新协议必须提供稳定 ID 和明确终态。

## 四、默认产品决策

除非仓库或用户提供更新决策，按以下默认值实施：

1. 产品需要远程后端，不把“仅 localhost 使用”当最终答案；
2. Demo 是个人单用户，但支持多个聊天会话；
3. 保留旧 v1 协议的兼容窗口，新增稳定 v2 语义，避免一次性破坏现有 Vue 前端；
4. 时间戳统一使用带时区的 UTC ISO 8601；
5. Electron Main 持有认证凭据并连接后端；Renderer 只接收公开领域事件；
6. Demo Desktop 工具为 `desktop.file.select/read/write/screen.capture`；
7. `desktop.command.run` 默认不注册；
8. 现有 Python 工具全部视为 Backend Runtime；
9. Local Worker 是可选能力，不阻塞首个 Demo；
10. 普通录音停止后等待确认；实时语音字幕不写文字草稿；输入法转写只写草稿；
11. TTS 默认只朗读 Public Reply；口型可由 Electron 对播放音频做振幅估算，不要求后端先实现 viseme；
12. 自定义模型 Endpoint 远程默认 HTTPS；本机 HTTP 只属于明确的本机模型执行位置；
13. 所有副作用工具都按 `callId` 幂等；
14. 不在 URL 查询参数、普通日志、错误或诊断包中放 Token、API Key、聊天正文、Inner Voice、语音内容或本地路径。

## 五、实施纪律

- 首先完整读取仓库 `AGENTS.md`、README、架构、测试和贡献说明；
- 检查分支、Commit 和工作区状态，保留用户已有修改；
- 先建立计划，再按批次实施；同一时间只推进一个批次；
- 不运行生产请求、真实付费模型调用、数据库破坏操作或不可恢复迁移；
- 需要迁移时先提供向前、向后兼容和回滚方案；
- 不使用 `git reset --hard`、不覆盖用户改动；
- 保留现有 v1 事件，使用版本或能力标志逐步切换；
- Schema、实现、生成 TypeScript、测试和文档必须同一次变更提交；
- 不只修改手写 JSON 示例而忽略真正 Pydantic 契约；
- 不只写接口外壳；每项完成必须沿注册入口、Handler、Service、Repository、序列化和测试闭环；
- 不伪造抓包、测试结果或实现状态；
- 不把本 Prompt 中的建议字段名视为不可更改。语义必须满足，实际命名可以适配现有风格，但要提供映射。

## 六、实施顺序

### 批次 0：重新建立事实基线

1. 核对交接包的所有代码证据；
2. 运行契约漂移检查和安全的快速测试；
3. 生成当前 `contract.generated.ts`；
4. 在本地测试配置中抓取真实 WS 事件；
5. 确认时间戳到底是 UTC 还是本地时间；
6. 修正 Backend/Desktop Runtime 映射；
7. 形成 `docs/electron-backend-baseline.md`。

门槛：没有互相矛盾的事实；真实样例能被 JSONL 解析；测试结果可复现。

### 批次 1：认证、版本和统一错误

实施：

- 保护 WS、业务 REST、上传和资源；
- 为 Electron Main 支持安全认证握手；
- 增加协议版本和 Feature Capability；
- 定义稳定公开错误码；
- 增加请求大小、速率和认证失败保护；
- 提供 HTTPS/WSS 反向代理部署说明；
- 防止 Provider 测试密钥经过匿名明文连接。

推荐 Demo 方案：单用户访问 Token，HTTP 使用 `Authorization: Bearer`，WS 由 Electron Main 在握手 Header 中携带；不得使用 query token。生产必须 HTTPS/WSS。

门槛：匿名访问被拒绝；有效身份能完整聊天；日志扫描无凭据。

### 批次 2：结构化聊天 v2

至少实现这些语义：

```text
user_message.ack
generation.started
generation.segment.started
generation.delta
generation.segment.completed
generation.completed
generation.failed
```

稳定 ID：

```text
clientRequestId
clientMessageId
conversationId
messageId
generationId
responseId
segmentId
segmentIndex
deltaSequence
```

要求：

- 用户消息按 `clientRequestId` 幂等；
- 一次回复的多句和两个通道只形成一条父消息；
- Inner Voice/Public Reply 可交错并有全局顺序；
- 分段完成不等于父完成；
- 父完成返回 Token、实际模型和心情；
- 错误结构化，不解析 `❌` 文案；
- 取消和迟到增量有明确处理；
- v1 事件在兼容窗口内仍可发送，或由服务器按协商版本选择。

门槛：同一回复三句不会被客户端误建成三条父消息；重试不会重复创建消息。

### 批次 3：多会话、历史、搜索和资源

实现正式产品 API：

- 创建、列表、获取、重命名、删除会话；
- 会话上下文隔离；
- 按会话分页历史；
- 根据消息 ID 获取前后上下文；
- 当前/全部会话搜索；
- 关键词、本地日期 + IANA 时区、分类组合查询；
- 图片/视频、表情、文件、音频、链接资源索引；
- 搜索和资源结果跳回来源消息；
- 删除语义、附件联动和 TTL/GC。

门槛：两个会话并行使用不会串上下文、串 Token 或串工具结果；分页稳定不重不漏。

### 批次 4：统一 Tool Runtime 和 Desktop 桥

给 Tool Definition 增加 Runtime、风险、审批主体、Schema 和版本。现有工具标为 Backend。

增加客户端工具通道：

```text
backend → Electron: desktop tool request
Electron → backend: accepted/rejected/running/result/error/cancelled
```

P0 工具：

```text
desktop.file.select
desktop.file.read
desktop.file.write
desktop.screen.capture
```

约束：

- 后端不解释或执行 Electron 返回的任意代码；
- 请求使用结构化参数；
- 客户端决定本地权限；
- Backend 审批不能生成本地授权；
- 相同 `callId` 不重复产生副作用；
- 离线、过期、取消和重连状态可查询；
- 不注册 `desktop.command.run`。

门槛：四个工具在 Windows 测试客户端完成请求、审批、执行、结果回传；服务器沙盒 read/write 仍显示为 Backend。

### 批次 5：模型 Profile 和凭据

保持 LLM/STT/TTS 三类，完善：

- 列表、新增、同名更新、测试、激活、删除；
- Provider、模型、服务地址、能力、执行位置；
- 凭据只写不可读；
- `credentialConfigured` 状态；
- 当前选择和本条回复实际模型区分；
- TTS 声音列表和固定文本试听；
- Profile 被引用时的删除约束；
- 自定义 Endpoint 的 SSRF、DNS、重定向和 Header 安全。

如果选择继续“密钥仅由运维环境变量提供”，必须在 API 和文档中明确，Electron 不得出现虚假的“保存 API Key 成功”。需要用户在设置页输入密钥时，新增安全 Secret Store。

门槛：三类 Profile 均能安全新增、测试、切换；普通查询永远不能读回密钥。

### 批次 6：三种语音

实现三套独立 Session/命令：

1. 普通录音：停止后待确认，commit 才进入 Agent；
2. 实时语音：音频序号、背压、partial/final、VAD、轮次、暂停/取消；
3. 输入法转写：只返回文字，不创建消息、不调用 Agent。

同时规范 TTS playback ID、音频块序号、格式、取消和完成。Inner Voice 不进入 TTS。

门槛：三种模式分别自动化测试；取消任何一种都不会误发消息。

### 批次 7：通用媒体和发布收敛

实现：

- 图片、视频、音频、文件上传；
- 稳定 Attachment ID；
- 鉴权下载或短签名 URL；
- MIME/编码/大小矩阵；
- 视频/音频 Range；
- 缩略图；
- 来源消息关联；
- 删除和孤儿 GC；
- 版本、升级和兼容说明。

门槛：媒体可以发送、历史加载、分类查看、播放/下载和跳回来源，匿名访问不可取得资源。

## 七、推荐 v2 领域结构

具体 Pydantic 命名可按仓库风格调整，但必须能映射以下结构。

### 事件外壳

```json
{
  "protocolVersion": "2.0",
  "eventId": "evt_...",
  "type": "generation.delta",
  "occurredAt": "2026-08-04T00:00:00.000Z",
  "conversationId": "conv_...",
  "requestId": "req_...",
  "callId": null,
  "payload": {}
}
```

### Assistant 分段

```json
{
  "generationId": "gen_...",
  "messageId": "msg_...",
  "responseId": "resp_...",
  "segmentId": "seg_...",
  "segmentIndex": 2,
  "deltaSequence": 4,
  "channel": "public_reply",
  "kind": "text",
  "delta": "..."
}
```

### Desktop 工具请求

```json
{
  "callId": "call_...",
  "toolName": "desktop.file.read",
  "toolVersion": "1",
  "runtime": "desktop",
  "arguments": {},
  "reason": "用户请求分析所选文件",
  "riskLevel": "medium",
  "permissionRequired": true,
  "approvalAuthority": "client",
  "expiresAt": "2026-08-04T00:01:00.000Z"
}
```

### 公开错误

```json
{
  "code": "GENERATION_PROVIDER_UNAVAILABLE",
  "message": "模型服务暂时不可用",
  "retryable": true,
  "requestId": "req_...",
  "generationId": "gen_..."
}
```

## 八、测试要求

每个批次必须增加：

- Pydantic 契约 Round-trip；
- 生成 TypeScript 漂移检查；
- Handler/Service/Repository 单元和服务测试；
- WebSocket 时序测试；
- 重复、乱序、迟到和取消测试；
- 认证失败和权限边界测试；
- 日志敏感信息扫描；
- 旧 v1 客户端兼容测试；
- 新 v2 真实脱敏 JSONL。

高风险专项：

- 未认证 WS/API/上传；
- 跨会话数据泄漏；
- `clientRequestId/callId` 重放；
- Desktop 工具参数篡改；
- 自定义 Endpoint SSRF、DNS Rebinding 和重定向；
- API Key 回显或日志泄漏；
- 输入法转写误触发 Agent；
- 取消后继续发送音频或文本；
- 上传类型伪造和资源越权读取。

## 九、每批次输出格式

完成一个批次后，输出：

1. 完成的任务 ID；
2. 修改的文件和关键设计；
3. 兼容性影响；
4. 数据库迁移和回滚方式；
5. 实际运行的测试及结果；
6. 新契约和 TS 快照位置；
7. 脱敏真实事件样例；
8. 尚未完成或被阻塞的项目；
9. 下一批次是否具备进入条件。

不要把“代码已写”当作完成。只有契约、实现、测试、样例和文档全部闭环才可标记完成。

## 十、最终交付

最终应生成或更新：

```text
frontend_contract/
frontend/src/types/contract.generated.ts
docs/electron-backend-baseline.md
docs/electron-backend-protocol-v2.md
docs/electron-backend-migration.md
docs/electron-backend-security.md
tests / fixtures / sanitized-traces
frontend-handoff-v2/
```

`frontend-handoff-v2/` 至少包含：

- 新 Commit ID；
- 能力矩阵；
- REST/WS/语音/工具契约；
- 错误目录；
- 真实脱敏 JSONL；
- 测试报告；
- 兼容与升级说明；
- 未完成项。

不得包含 `.env`、密钥、真实聊天、个人路径、数据库、上传原文件或生产日志。

## 十一、开始执行

现在请：

1. 读取仓库说明并确认基线；
2. 阅读配套任务清单；
3. 输出批次 0～7 的实施计划；
4. 立即执行批次 0；
5. 批次 0 通过后再进入批次 1；
6. 若遇到会改变默认产品决策的阻塞，停止对应批次并明确提出，不要静默假设；
7. 在安全且不扩大范围的前提下持续推进其余不受阻塞的工作。

---

## 执行完成后的 Review 要点

把其他模型的结果交回前端前，至少核对：

- 它是否真的运行了测试，而不是只列命令；
- 它是否保留 v1 兼容；
- 它是否把 Backend 沙盒工具正确标为 Backend；
- 它是否让匿名远程访问失效；
- 它是否给每条逻辑回复稳定父 ID 和明确完成事件；
- 它是否实现了真实多会话隔离，而不是前端本地伪装；
- 它是否把输入法转写与 Agent 消息完全隔离；
- 它是否没有注册任意命令执行；
- 它是否提供真实脱敏抓包、生成契约和 Commit ID；
- 它是否没有泄漏任何密钥或个人数据。
