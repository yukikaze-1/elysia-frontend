# Cyrene 二次真实联调整改：Renderer 水合 + replay 身份防御 + 取消码统一设计

**日期：** 2026-08-13
**依据：** `docs/review/2026-08-13-Windows-Electron-二次真实联调前端整改清单.md`（FE-INT2-P0-01 / FE-INT2-P1-01 / FE-INT2-P1-02）
**审查对象基线：** `main@db6d127`（首次联调整改落地后 HEAD）
**范围：** Electron 阶段 2 Renderer bootstrap 水合编排、WS replay 身份契约防御、取消终态统一
**目的：** 关闭二次真实联调确认的三个前端问题：Renderer reload 后不恢复 Main 连接状态（P0，阻断 B-01 封口）；replay 缺身份时 fallback 主键碰撞+重复（P1/跨层）；取消码 `CANCELLED` 与真实契约 `GENERATION_CANCELLED` 不一致（P1）。本批完成后仍标「已开发、未联调」（B-01 正式验收未通过）。
**决策：** 本批决策由我按推荐定案（用户拍板「全修，按你推荐的来」，记录进文档并在最终报告提出）——D1（P0-01 竞态守卫=启动代次守卫，前端侧，不动 ConnectionState 契约）、D2（P1-01 防御=严格契约收紧 + 移除共享 fallback，不造随机 ID）、D3（P1-02 正式码=GENERATION_CANCELLED + legacy helper + 取消终态统一，fixture 更新为真实码但保持 verified:false）。
**文档状态：** v3 定稿（经 code-review 两轮闭环：事实核验 2 提案缺陷 + 覆盖 2 部分缺口 + 设计 2 typecheck 级缺陷（DesktopApiLike 类型路径/onChatError 缺失、TS 类型未同步收紧）+ 3 验收补强 + 复核 7/7 + 1 措辞精度（指纹不下探嵌套元素）全整合）

---

## 1. 背景与目标

二次真实联调（Windows Electron + Ubuntu 后端，backend@88ee650）确认文本/工具/手动取消 happy path 已工作，但三个前端问题需修复后才能把 B-01 标记「已真实联调」：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-INT2-P0-01 | P0 | Renderer reload 后不水合 Main 当前连接状态（界面显示未连接/无会话，须手工断开重连） | 统一 `applyChatState` 编排 + 启动 snapshot 水合 + 启动代次竞态守卫（D1） |
| FE-INT2-P1-01 | P1/跨层 | replay 缺 `message_id/timestamp` 时共享 fallback `${convId}:replay` 主键碰撞 + 与 REST 正式消息重复 | 严格契约收紧（D2）：schema 要求身份、无身份会话帧按协议错误处理、移除共享 fallback、不造随机 ID |
| FE-INT2-P1-02 | P1 | 取消只识别 `CANCELLED`，真实契约用 `GENERATION_CANCELLED` | 正式码 + legacy helper + 取消终态统一 + fixture 更新（D3） |

**非前端修（记录）：** 后端 WS replay 的 tool item 漏发 `message_id/timestamp`（后端配套清单主修）；前端防御不替代后端正式 ID。

**完成标准**（对照清单 §4.4/§5.5/§6.4）：
- Renderer 启动时先注册订阅再 `getConnectionState()` snapshot，经统一 `applyChatState` 应用；reload 后自动恢复 connected/活动会话/历史，无需手工断开重连；
- snapshot 与实时 push 竞态由启动代次守卫处理（迟到 snapshot 不覆盖新状态）；snapshot 失败进公开错误但不清凭据/不制造断开；
- reload 不创建第二条 WS、不更换 Main connectionId；普通首次启动与用户主动连接路径无回归；
- bootstrap 编排有可自动执行单测（非孤立 `refreshState()`）；
- RawSessionMessageItem 对持久化 user/assistant/tool 要求非空 `message_id/timestamp`；无身份会话帧按协议错误处理（安全诊断、不进 store），REST 首屏恢复；移除 `${convId}:replay` 共享主键；不造随机 ID；
- `GENERATION_CANCELLED` 为正式取消码（helper 兼容 legacy `CANCELLED`）；取消终态统一为 interrupted、不设 lastError、保留 partial、迟到 delta/completed/failed 不复活不降级；`chat-cancelled.jsonl` 更新为真实码；
- 非取消错误（GENERATION_TIMEOUT 等）仍 failed + 公开错误；
- fixture 覆盖真实后端 tool replay 形状（含正式 ID）；
- typecheck、lint、510+ 单测、23+ 集成、build、check:contract(13/13) 全绿；
- 文档仍标记「已开发、未联调」（B-01 正式验收未通过）。

## 2. 范围（本批 vs 后续）

**本批做：** FE-INT2-P0-01（bootstrap 水合编排 + snapshot + 竞态守卫 + 单测）、FE-INT2-P1-01（replay 身份契约防御：schema 收紧/移除 fallback/协议错误处理/fixture）、FE-INT2-P1-02（取消码统一 + 取消终态 + fixture 更新）。

**本批不做**：
- 后端 WS replay tool item 字段修复（后端配套清单负责；前端防御不替代）；
- Renderer 正式工具卡片 UI（工具结果当前落空 assistant 风格行——阶段 3 UI 项，不在本批）；
- 多客户端同会话支持（首次联调已定单写者口径）；
- 阶段 3 完整聊天/历史/多媒体。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/renderer/src/main.ts:16-32` | 只注册 onChatEvent/onChatState/onChatReplay/onChatError，未读 Main 当前状态 | reload 后新 Pinia 默认 disconnected，Main 已发的 connected push 不重放（FE-INT2-P0-01） |
| `src/renderer/src/stores/connection.store.ts:45-47` | `refreshState()` 只 `state.value = await api.getConnectionState()` | 不执行 onChatState 回调的 message/conversation 编排（§4.2） |
| `src/renderer/src/main.ts:22-29` | onChatState 回调内联编排（setState + handleConnectionStateChange + onConnected + onActiveConversationAppeared） | 与启动 snapshot 无统一消费函数（§4.3 #1） |
| `src/main/transport/protocol-v2/rest-mapper.ts:49` | `messageId: src.message_id ?? \`${convId}:${src.timestamp ?? 'replay'}\`` | message_id 与 timestamp 都缺 → 同会话所有此类消息共享 `${convId}:replay`，byId 碰撞 + 与 REST 重复（FE-INT2-P1-01） |
| `src/main/transport/protocol-v2/raw-schemas.ts:27-45` | `RawSessionMessageItemSchema` 的 `message_id`/`timestamp` 均为 `.optional()` | 无身份 item 被接受（§5.4 #1 要求非空） |
| `src/renderer/src/stores/message.store.ts:92-93` | `failAssistant` 只识别 `CANCELLED`，且无条件写 `lastError` | 真实码 `GENERATION_CANCELLED` 被当普通失败 → failed + 错误横幅（FE-INT2-P1-02） |
| `src/main/fixtures/wire-v2/chat-cancelled.jsonl` | 用 `"code":"CANCELLED"`（非真实 wire） | Mock/fixture 无法发现码不一致（§6.1） |

### 3.2 技术约束

- **reload 不重启 Main**：Renderer reload 时 Main 的 adapter 连接、connectionId、后端活动会话原样保留（清单 §4.1 实测 `getConnectionState() → connected + activeConversationId`）。bootstrap 只需水合新 Renderer 的 Pinia 状态。
- **启动代次守卫（D1）**：`ConnectionState` 无 sequence，不在 Main 加版本（避免改共享契约/preload/schemas）。前端用「订阅后是否收到过 push」的 epoch 守卫：启动时捕获注册订阅后的 `stateEpoch`，snapshot 返回时若 `stateEpoch` 已变（期间收到更新 push）则丢弃迟到 snapshot。
- **replay 身份契约（D2）**：`RawSessionMessageItemSchema` 收紧后，无身份 item 会使整个 session 帧 parse 失败 → replay 按协议错误丢弃（安全诊断），**REST 首屏 `getMessages` 是恢复链的主源**（`conversationStore.onActiveConversationAppeared → activate → getMessages`），replay 丢失不阻断恢复。这正是「无身份项不进 store、不共享 key、不造 ID」的实现——整帧拒绝而非逐条降级，避免伪身份与重复。
- **取消码（D3）**：`GENERATION_CANCELLED` 是后端 `frontend_contract/errors.py` 正式稳定码；helper `isCancellationCode(code)` 同时识别 `GENERATION_CANCELLED` 与 legacy `CANCELLED`；取消终态不设 `lastError`（用户主动取消不应展示「发送失败」）。
- **fixture 更新不动 schemaHash**：`chat-cancelled.jsonl` 只改 code 字符串（generation.failed schema 接受任意 code）→ raw schema 未变 → `schemaHash` 不变；manifest 保持 `verified:false` + `backendCommit:"unverified"`（fixture 为按真实 wire 值构造，非逐字捕获；清单 §6.3 #4「若用真实帧替换才据实更新」不适用）。
- **replay fixture 覆盖工具形状**：新增/更新 fixture 使 session replay 含带正式 `msg_*` ID 的 tool item（§5.5「不能只覆盖 user/assistant」）。

## 4. 设计

### 4.1 FE-INT2-P0-01：Renderer bootstrap 水合编排（决策 D1）

**新增 `src/renderer/src/bootstrap.ts`**（可单测模块，依赖注入）：

```ts
// src/renderer/src/bootstrap.ts
// P0-01:Renderer 启动水合编排——push 与启动 snapshot 用同一 applyChatState 消费;
// 启动代次守卫(epoch)防迟到 snapshot 覆盖已收到的新 push(D1,不改 ConnectionState 契约)。
import type { ConnectionState } from '@shared/contracts'
import type { PublicError } from './utils/public-error'
import type { DesktopApiLike } from './stores/desktop-api.types' // 窄接口（非 preload DesktopApi）——桌面存储只消费窄面

export interface BootstrapStores {
  connection: { setState(s: ConnectionState): void; setError(e: PublicError): void }
  message: { applyEvent(e: unknown): void; handleConnectionStateChange(s: ConnectionState): void; loadReplay(conversationId: string, messages: unknown[]): void }
  conversation: { onConnected(connectionId?: string): Promise<void>; onActiveConversationAppeared(activeId: string): Promise<void> }
}

export function createRendererBootstrap(api: DesktopApiLike, stores: BootstrapStores): { register(): void } {
  let stateEpoch = 0
  const applyChatState = (s: ConnectionState): void => {
    stores.connection.setState(s)
    stores.message.handleConnectionStateChange(s)
    if (s.status === 'connected') {
      void stores.conversation.onConnected(s.connectionId)
      if (s.activeConversationId) void stores.conversation.onActiveConversationAppeared(s.activeConversationId)
    }
  }
  const register = (): void => {
    api.onChatEvent((e) => stores.message.applyEvent(e))
    api.onChatState((s) => { stateEpoch++; applyChatState(s) })
    api.onChatReplay(({ conversationId, messages }) => stores.message.loadReplay(conversationId, messages))
    api.onChatError((err) => stores.connection.setError(err))
    // 启动 snapshot 水合：先注册订阅（epoch 从 0 起），再拉当前状态；epoch 变化即期间收到 push → 丢弃迟到 snapshot
    const captured = stateEpoch
    void api.getConnectionState().then((snapshot) => {
      if (stateEpoch === captured) applyChatState(snapshot)
    }).catch((e) => {
      stores.connection.setError(e instanceof Error ? { code: 'UNKNOWN', message: e.message } : { code: 'UNKNOWN', message: String(e) })
      // snapshot 失败进公开错误/诊断路径，不清凭据、不制造断开（清单 §4.3 #4）
    })
  }
  return { register }
}
```
**前置类型修复**：`DesktopApiLike`（`desktop-api.types.ts`）当前**无 `onChatError`**——需为其补 `onChatError(handler: (err: PublicError) => void): () => void`（`window.desktopApi` 全量类型已含 onChatError，结构化可赋值；与 store 只消费窄接口的既有架构一致）。

**`main.ts` 重构**：
```ts
if (window.desktopApi) {
  setDesktopApi(window.desktopApi)
  createRendererBootstrap(window.desktopApi, {
    connection: useConnectionStore(),
    message: useMessageStore(),
    conversation: useConversationStore()
  }).register()
}
```
（`setDesktopApi` 先注入 `api` 单例；`window.desktopApi` 类型即 `DesktopApi`。）

**竞态守卫语义**（§4.3 #3）：订阅注册在 snapshot 请求之前 → `captured=stateEpoch` 捕获注册后基线；期间收到 push → epoch++ → snapshot 返回时不相等 → 丢弃（push 已应用更新状态）；未收到 push → snapshot 即最新 → 应用。**首次普通启动**（Main disconnected）snapshot=disconnected → applyChatState 走 disconnected 分支，不制造假 connected（§4.4）。

**验收测试（`tests/unit/renderer-bootstrap.spec.ts` 新，依赖注入 fake api/stores）：**
- connected snapshot → applyChatState 调用 setState + handleConnectionStateChange + onConnected + onActiveConversationAppeared（编排完整，非孤立 refreshState）；
- disconnected snapshot → 不触发 onConnected、不制造假 connected；
- snapshot 等待期间收到 push → 迟到 snapshot 丢弃（epoch 守卫）；未收到 → snapshot 应用；
- snapshot 拒绝 → setError 收到公开错误、不调用 disconnect；
- 订阅回调注册正确（onChatEvent/onChatState/onChatReplay/onChatError 都被调用）。

### 4.2 FE-INT2-P1-01：replay 身份契约防御（决策 D2）

**schema 收紧**（`raw-schemas.ts` `RawSessionMessageItemSchema`）：`message_id` 与 `timestamp` 改必填：
```ts
const RawSessionMessageItemSchema = z.object({
  role: z.string().min(1),
  message_id: z.string().min(1),     // D2:持久化消息要求非空身份(§5.4 #1)
  timestamp: z.string().min(1),
  ...
}).strict()
```
- 收紧后，无身份的 tool item 使 session 帧 parse 失败 → `handleFrame` 记 `RAW_FRAME_INVALID`（协议错误）→ replay 不进 store（§5.4 #2「无身份项按协议错误处理并记录不含正文的安全诊断」）。**含正文安全诊断**：`handleSession` 在帧校验失败处已走通用 `RAW_FRAME_INVALID`（不含正文），无需额外泄漏。
- **TS 类型同步收紧**（否则 typecheck 红）：`raw-types.ts` 的 `RawSessionMessageItem`（`message_id`/`timestamp` 改 `string` 必填）与 `rest-mapper.ts` 的 `MessageSource`（`message_id: string`）——收紧 zod 只约束运行时，手写 TS 接口须同步；`rest-mapper.ts:49` 改 `messageId: src.message_id` 后类型为 `string`，赋给 `Message.messageId: string` 通过。
- **schemaHash 不因必填性变化**：`rawSchemasFingerprintFor` 的 `fieldSig` 只读 `_def.type/values/value/entries`，`optional()` → `min(1)` 指纹不变 → 12 份 manifest `schemaHash` 无需重算（实测确认）。此为既有指纹机制局限（必填性不敏感），记录于 §6。
- **REST 首屏恢复**：replay 丢弃后，`onActiveConversationAppeared → activate → getMessages` 拉 REST 首屏（含正式 `msg_*` ID 的 tool item）→ 恢复链完整（§5.5「replay 与 REST 以相同 ID 到达，store 最终只有一条」）。

**移除共享 fallback**（`rest-mapper.ts:49`）：
```ts
messageId: src.message_id, // D2:正式 v2 路径不设 fallback——身份缺失已在 schema 层拒帧;此处不再生成共享 key(§5.4 #3)
```
- 若未来有 legacy 兼容需求，须显式 legacy mapper（tool 用稳定 `tool_call_id` 派生、不造随机 ID、无法唯一则丢弃告警），不在正式 v2 路径做（§5.4 #4）。

**fixture 覆盖**（§5.5「不能只覆盖 user/assistant」）：更新 session replay fixture 使 tool item 带正式 `msg_*` ID + `timestamp`（模拟后端修复后形状）；缺身份畸形帧由 raw-schemas.spec 单测覆盖（parse 失败）。

**验收测试：**
- `raw-schemas.spec.ts`：缺 `message_id`/`timestamp` 的 session item → 帧 parse 失败（`parseRawFrame` fail）；
- `rest-mapper`/replay 单测：带正式 ID 的两条 tool item → 两个不同 `msg_*` ID；不再产出 `${convId}:replay`；
- `message.store` 单测：replay 与 REST 相同 ID 两种到达顺序（replay 先→REST 后、REST 先→replay 后）→ store 只有一条（byId 去重，与顺序无关）；两条不同 `tool_call_id` 不碰撞；
- `wire-fixtures.spec.ts`：更新后 fixture（含 tool item 正式 ID）全过。

### 4.3 FE-INT2-P1-02：取消码统一（决策 D3）

**`message.store.ts`** 新增取消码 helper + 终态统一：
```ts
/** 正式取消码 GENERATION_CANCELLED + legacy CANCELLED 兼容（D3） */
export function isCancellationCode(code: string | undefined): boolean {
  return code === 'GENERATION_CANCELLED' || code === 'CANCELLED'
}
```
`failAssistant` 改为：
```ts
function failAssistant(messageId: string, event: Extract<BackendEvent, { event: 'generation.failed' }>): void {
  const m = ...;
  if (isCancellationCode(event.error.code)) {
    m.status = 'interrupted'           // 取消终态：interrupted
    // 不设 lastError：用户主动取消不展示「发送失败」（§6.3 #3 + §6.2 UX 不一致）
  } else {
    m.status = 'failed'
    lastError.value = { code: event.error.code, message: event.error.message, backendCode: event.error.code, retryable: event.error.retryable }
  }
  activeGenerationId.value = undefined // 清理 active generation（统一）
}
```
- 保留 partial segments（取消不删已收内容）；
- 迟到 delta/completed/failed 已由 `activeGenerationId` 守卫丢弃（现有 P2-5 逻辑，不复活不降级）；
- 非取消错误（GENERATION_TIMEOUT 等）仍 failed + lastError（§6.4 最后一条）。

**fixture 更新**（`chat-cancelled.jsonl`）：`"code":"CANCELLED"` → `"code":"GENERATION_CANCELLED"`；manifest `schemaHash` 不变（schema 未变——generation.failed.code 是 `z.string().min(1)` 任意值）、`verified:false` + `unverified` 保持（按真实 wire 值构造非逐字捕获）。**相关断言同步**：wire-fixtures.spec 的 accumulator 断言（`status === 'failed'`）不区分取消码仍绿；message.store.spec 现有 failed 用例用 `BACKEND_REJECTED`（非取消码）不变；新增 GENERATION_CANCELLED → interrupted + 无 lastError 用例。

**验收测试（`message.store.spec.ts` 扩展）：**
- `generation.failed{code:GENERATION_CANCELLED}` 直接到达 → interrupted + 无 lastError；
- **failed 在 cancel IPC resolve 前到达**（交错时序）→ 最终仍 interrupted + 无 lastError（码判定与乐观 cancel 前后顺序无关）；
- legacy `CANCELLED` 仍识别（helper 兼容）；
- `GENERATION_TIMEOUT`/provider unavailable → failed + lastError；
- 本地乐观 cancel 先完成、failed 后到 → 状态不变 + 无错误横幅（既有守卫）；
- 已收 partial segments 取消后保留（既有 accumulate 逻辑不删）；
- 迟到 completed 不把 interrupted 改回 completed（既有 P2-5）。

## 5. 验收与门禁

**门禁（控制器复跑）：**
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（510+ 单测，含本批新增）、`xvfb-run -a pnpm test:integration`（23+）、`pnpm build`、`pnpm -F @cyrene/desktop check:contract`（13/13）全绿；
- `pnpm package` + `xvfb-run -a verify:artifact -- --smoke` 不回归（本批动 renderer bootstrap + main，打包路径受牵连，须复跑）。

**B-01 最小复跑项（清单 §8 全 10 项，本批 headless 不可实跑，记录为验证项）：** ①冻结并记录前后端 SHA；②启动连接确认 REAL / protocol 2.0 / 后端版本；③创建会话发纯文本并完成；④调用两次真实工具记录两个 callId/messageId；⑤Renderer reload 界面无需手工操作即恢复 connected/活动会话/历史；⑥断开重连 WS replay 与 REST 对每个工具相同 ID；⑦Pinia 每 callId 一条、无 `<conversationId>:replay`；⑧长生成停止收到 `GENERATION_CANCELLED` 且 UI interrupted 无失败横幅；⑨旧 `default` 历史继续能打开；⑩诊断中无 schema/协议/未处理 Promise 错误。

**故障注入复测（清单 §10）：** reload 后无需手工断开重连（bootstrap 单测覆盖编排）；replay 缺身份不产生共享 key（schema 收紧 + mapper 无 fallback）；取消码不误标 failed（P1-02 单测）。

**文档标记：** 本批完成仍标「已开发、未联调」（B-01 正式验收未通过）；B-01 复跑项如实记录。

## 6. 已知限制（记录，待后续批次/联调）

- **B-01 复跑项 headless 不可本批实跑**：真实 Electron reload 恢复 / replay-REST 去重 / 真实取消捕获等清单 §8 全 10 项，需真实后端环境（Windows/Ubuntu + backend@88ee650 修复后）执行。
- **指纹不下探嵌套元素**：`rawSchemasFingerprintFor` 的 `fieldSig` 对**顶层帧字段**的 optional→必填是敏感的（`_def.type` optional vs string），但本批收紧发生在 `messages` **数组元素 schema 内**——指纹只读顶层字段签名（`messages:array::`），不下探元素 → 指纹不变，12 份 manifest 无需重算（实测确认）。此为既有指纹机制局限（数组元素级变更不被捕获），记录不修。
- **replay 严格契约的过渡期**：schema 收紧后，后端未修复前（tool item 缺身份）session 帧会被整帧拒绝 → replay 丢弃（REST 首屏恢复）。这是 D2 的有意取舍（防伪身份与重复优先于过渡期 replay 保真）；后端修复落地后正常 v2 流不实际走拒绝路径。
- **取消码兼容**：`CANCELLED` legacy 保留于 helper 中；不要求后端改码（§6.3 #5）。
- **工具结果 UI**：正式工具卡片留阶段 3；当前 tool role 落空 assistant 风格行。
- **fixture chat-cancelled 非逐字捕获**：code 更新为真实 wire 值，但 manifest 保持 verified:false（无完整逐字帧）。

## 7. 文档同步（本批范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-13-realint2-fix-design.md`；
- 实施完成后更新 `README.md` / `CLAUDE.md` / `docs/16`（二次联调整改批次落地 + 测试数字），保留「已开发、未联调」；
- 最终报告 + 验收按二次联调清单 §4.4/§5.5/§6.4/§8 逐项回报。
