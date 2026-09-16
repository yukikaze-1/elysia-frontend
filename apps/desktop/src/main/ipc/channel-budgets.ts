// apps/desktop/src/main/ipc/channel-budgets.ts
// IPC 通道的**大小预算声明表**（P1-1，2026-09-11）。
//
// 背景（评审核实）：doc 07 §6.3 把「单条 IPC 消息 ≤ `MAX_IPC_MESSAGE_BYTES`（4 MiB）」声明为**全局不变量**，
// 但实现里它只在 `session-store` 一处真正执行（`registry.ts:39-43` 只校验 arity，不查大小）。
// 于是「单一收口」实际是**路由点而非策略点**：谁能守住这条不变量，取决于每个 handler 作者是否记得
// 自己加校验——`ipc-limit.spec.ts:59-61` 又只断言常量值本身，所以漏掉也无人发现。
//
// 报告给了两条路：给 `registerHandler` 加运行时 `maxBytes`（每次 invoke 做结构化遍历，有 O(size) 成本、
// 热通道需门控），或先用**零运行时成本**的「枚举 + 断言声明」测试式方案。本文件走后者：
// 把「我这条通道的规模上界是多少、由谁守」写成**可枚举、可断言**的声明，
// 于是「忘了声明/声明得比全局不变量还大」会变成红灯，而不是一个无人知晓的缺口。
//
// 两类声明（刻意区分，因为它们的安全含义不同）：
//   · 'bytes'  —— 该通道有**显式字节预算**，并注明执行点（常量引用真实来源，防与实现漂移）；
//   · 'schema' —— 无独立字节预算，但入参已被**字段级 schema 上界**约束（D7A-13 值表），
//                 即体积由字段 max 之和隐式封顶。这不是"没管"，而是"另一套围栏"。
//
// 维护规则：**新增通道必须在此登记**（`tests/unit/ipc-budget-declaration.spec.ts` 会枚举实际注册的
// 通道并逐个核对）。没有第三条路——这正是让缺口可见的机制本身。
import { MAX_IPC_MESSAGE_BYTES } from '@shared/contracts'
import { MAX_AUDIO_CHUNK_BYTES } from '../voice/voice-handlers'

export type ChannelBudget =
  /**
   * 显式字节预算。`measure` 指明**谁来度量**，这不是实现细节而是安全边界：
   *   · 'json'    —— 载荷是 JSON 结构，路由点可用 `JSON.stringify` 度量（实测 4 MiB ≈ 5 ms）；
   *   · 'handler' —— 载荷含**二进制**（如音频分块），路由点**必须不度量**：
   *                  实测 1 MiB `Uint8Array` 经 `JSON.stringify` 需 **114 ms** 且字符串膨胀 **10.9×**。
   *                  此类由 handler 用 O(1) 的 `byteLength` 自行判断。
   */
  | { kind: 'bytes'; maxBytes: number; enforcedAt: string; measure: 'json' | 'handler' }
  /** 入参由字段级 schema 上界约束（D7A-13 值表），无独立字节预算 */
  | { kind: 'schema'; note: string }
  /** 无入参/出参极小（z.undefined() 等），不存在规模问题 */
  | { kind: 'none' }

const bytes = (maxBytes: number, enforcedAt: string): ChannelBudget => ({ kind: 'bytes', maxBytes, enforcedAt, measure: 'json' })
/** 二进制载荷：预算由 handler 以 O(1) 判断，路由点不得 stringify */
const bytesBinary = (maxBytes: number, enforcedAt: string): ChannelBudget => ({ kind: 'bytes', maxBytes, enforcedAt, measure: 'handler' })
const schemaBounded = (note: string): ChannelBudget => ({ kind: 'schema', note })
const NONE: ChannelBudget = { kind: 'none' }

/**
 * 通道 → 预算声明。键是 `IpcChannels` 的**值**（通道名字符串），与注册面同域。
 * 未登记的通道会被门禁用例点名——这是本表存在的全部意义。
 */
export const IPC_CHANNEL_BUDGETS: Readonly<Record<string, ChannelBudget>> = {
  // —— 有显式字节预算（执行点已核对） ——
  'chat:cache-messages': bytes(MAX_IPC_MESSAGE_BYTES, 'session-store.cacheMessages 整批字节预算'),
  'chat:hydrate-persistence': bytes(MAX_IPC_MESSAGE_BYTES, 'session-store.hydrate 出参装箱降级'),
  'chat:persist-session': bytes(MAX_IPC_MESSAGE_BYTES, 'session-store 草稿 100KB/条 + 条目数/字节裁剪'),
  'voice:audio-chunk': bytesBinary(MAX_AUDIO_CHUNK_BYTES, 'voice-handlers 运行期上限（单向二进制通道：路由点不度量，见 measure 说明）'),
  'tool:decide': schemaBounded('desktop.file.write 内容上限由 tool-limits.MAX_WRITE_CONTENT_BYTES 守'),
  'tool:pick-source': schemaBounded('desktop.file.read 目标文件上限由 tool-limits.FILE_READ_MAX_BYTES 守'),
  // S4（2026-09-15）：此通道**含二进制**（`bytes: Uint8Array`）⇒ 按本文件 §measure 的口径必须走 handler 度量，
  // 路由点不得 JSON.stringify（实测 1 MiB 二进制 stringify 需 114 ms、膨胀 10.9×）。执行点是 O(1) 的 `byteLength`：
  // schema 层 refine + upload-service 的 kind 级复核。上界只能取**全局不变量** 4 MiB——通道预算比全局更宽
  // 会被 `ipc-budget-declaration.spec.ts` 判红，而那正是「不得声明做不到的事」这条纪律。区别在于：
  //   · `bytes` 分支（粘贴型）：载荷真的过 IPC ⇒ 受 4 MiB 约束（拖入/选择型走 fileRef，不受此限）；
  //   · `fileRef` 分支：载荷为空（Main 按 token 自读盘），单文件上限仍按 kind（10/20/50 MiB）在 handler 复核。
  // 修复前此行声明 2 MiB（`MAX_WRITE_CONTENT_BYTES`）却完全不执行，实现又只信对端自报的 `size`。
  'attachments:upload': bytesBinary(MAX_IPC_MESSAGE_BYTES, '仅 bytes 分支（粘贴）受 4 MiB 全局不变量约束；fileRef 分支载荷为空，按 kind 在 handler 复核真实字节数'),

  // —— 字段级 schema 上界（D7A-13 值表） ——
  'chat:send': schemaBounded('正文 ≤64KiB、附件 ≤10 条、贴图 1 个（channels.ts D7A-13）'),
  'chat:query-history': schemaBounded('query ≤512B、limit ≤100、cursor 有界'),
  'chat:get-messages': schemaBounded('conversationId + 可选游标/limit'),
  'chat:get-message-context': schemaBounded('messageId + before/after 可选'),
  'chat:set-endpoint': schemaBounded('serverUrl ≤4096'),
  'chat:rename': schemaBounded('title ≤200'),
  'credentials:set': schemaBounded('key 白名单 + value ≤4096'),
  'credentials:clear': schemaBounded('key 白名单'),
  'credentials:get-status': schemaBounded('key 白名单（凭据状态查询，无秘密值出参）'),
  'models:save-profile': schemaBounded('apiKey ≤8192、models ≤50、无回显'),
  'models:test-profile': schemaBounded('apiKey ≤8192、名称/模型 ≤200'),
  'settings:save': schemaBounded('SettingsPatchSchema 字段级上界'),
  'voice:commit': schemaBounded('转写文本 ≤10KiB'),
  'voice:start-realtime': schemaBounded('sessionId/conversationId 短字符串'),
  'voice:start-dictation': schemaBounded('clientRequestId/sttProfileId 短字符串'),
  'live2d:read-model-file': schemaBounded('modelId ≤128、relPath ≤1024，且经闸门 containment+integrity'),
  'character-drafts:save': schemaBounded('PersistedCharacterDraft 字段级上界'),
  'characters:create': schemaBounded('CharacterDraftSchema 字段级上界'),
  'characters:update': schemaBounded('同上 + expectedRevision'),
  'characters:preview': schemaBounded('draft + userMessage 短字符串'),

  // —— 无载荷 / 固定极小入参 ——
  'app:get-info': NONE,
  'app:open-external': schemaBounded('url ≤2048 且协议白名单（persistence-handlers）'),
  'app:persist-flush-done': NONE,
  'chat:connect': NONE,
  'chat:disconnect': NONE,
  'chat:get-state': NONE,
  'chat:get-endpoint': NONE,
  'chat:get-runtime-info': NONE,
  'chat:list-conversations': schemaBounded('cursor + limit 可选'),
  'chat:list-stickers': NONE,
  'chat:activate': schemaBounded('conversationId'),
  'chat:create': schemaBounded('CreateConversationInputSchema'),
  'chat:cancel': schemaBounded('generationId'),
  'chat:delete': schemaBounded('conversationId'),
  'attachments:validate': schemaBounded('≤10 个 descriptor'),
  'attachments:cancel': schemaBounded('uploadId'),
  'attachments:check': schemaBounded('attachmentId'),
  // S5-B2（2026-09-15）：fileRef 铸造通道——入参是 preload 解析出的本机路径（≤4096），
  // 出参是不可猜 token。本通道不承载用户数据，故按字段级上界声明。
  'attachments:register-file-ref': schemaBounded('path ≤4096（preload 铸造点；出参为 Main 签发的 token）'),
  'voice:start-record': schemaBounded('recordingId'),
  'voice:stop-record': schemaBounded('recordingId'),
  'voice:discard': schemaBounded('recordingId'),
  'voice:stop-realtime': schemaBounded('sessionId'),
  'voice:cancel-realtime': schemaBounded('sessionId'),
  'voice:stop-dictation': schemaBounded('clientRequestId'),
  'voice:cancel-dictation': schemaBounded('clientRequestId'),
  'audio:cancel': schemaBounded('streamId'),
  'settings:load': NONE,
  'models:list-profiles': schemaBounded('type 可选枚举'),
  'models:delete-profile': schemaBounded('service 枚举 + name ≤200'),
  'models:activate-profile': schemaBounded('profileId ≤512'),
  'models:get-active-selection': NONE,
  'tts:list-voices': NONE,
  'tts:preview': schemaBounded('voiceId ≤200'),
  'tts:set-voice': schemaBounded('voice ≤200'),
  'live2d:list-models': NONE,
  'tool:cancel': schemaBounded('callId'),
  'tool:list': schemaBounded('空对象 strict；出参受 4 MiB 全局不变量约束——审批上下文（diff/capture）由 tool-limits.HYDRATION_CONTEXT_BUDGET_BYTES 预算保证，记录数上限 20'),
  'tool:confirm-upload': schemaBounded('callId'),
  'tool:grant-directory': schemaBounded('callId + ttlMs 白名单'),
  'tool:grants': schemaBounded('空对象 strict'),
  'tool:grant-revoke': schemaBounded('id'),
  'tool:history': schemaBounded('limit/days 有界'),
  'diagnostics:state': NONE,
  'diagnostics:dev-mode-set': schemaBounded('enabled: boolean'),
  'diagnostics:open-log-dir': NONE,
  'diagnostics:clear-logs': NONE,
  'diagnostics:export': NONE,
  'diagnostics:last-crash': NONE,
  'profile:get-me': NONE,
  'profile:update-me': schemaBounded('CharacterUpdateMeRequestSchema 字段级上界'),
  'characters:list': schemaBounded('limit/cursor 可选'),
  'characters:get': schemaBounded('characterId'),
  'characters:clone': schemaBounded('characterId + 可选 displayName'),
  'characters:archive': schemaBounded('characterId + expectedRevision'),
  'characters:rollback': schemaBounded('characterId + expectedRevision + targetRevision'),
  'characters:validate': schemaBounded('draft'),
  'characters:list-revisions': schemaBounded('characterId + 分页'),
  'character-instances:get-state': schemaBounded('characterInstanceId'),
  'character-instances:reset-evolution': schemaBounded('instanceId + expectedStateVersion'),
  'character-drafts:list': NONE,
  'character-drafts:get': schemaBounded('key'),
  'character-drafts:delete': schemaBounded('key'),
}

/** 全局不变量：任何通道声明的字节预算都不得超过它（导出供门禁用例断言） */
export const GLOBAL_IPC_INVARIANT_BYTES = MAX_IPC_MESSAGE_BYTES

/** 诊断用：各类声明的数量（便于快速看出"未声明"是否在增长） */
export function summarizeChannelBudgets(): { bytes: number; schema: number; none: number } {
  const values = Object.values(IPC_CHANNEL_BUDGETS)
  return {
    bytes: values.filter((b) => b.kind === 'bytes').length,
    schema: values.filter((b) => b.kind === 'schema').length,
    none: values.filter((b) => b.kind === 'none').length
  }
}
