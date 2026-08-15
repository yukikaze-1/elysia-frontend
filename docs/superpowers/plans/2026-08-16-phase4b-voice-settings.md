# P4-B（语音输入 + TTS 自动朗读 + 设置持久化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron Renderer 落地语音链路：普通录音「点击录音→停止→字幕→确认发送」、实时语音会话（连续音频 + 后端 VAD + 背压）、输入法转写「按住说话→final 写草稿」（独立 STT Profile 选择）、TTS 自动朗读（D3，设置可关）；补齐 settingsStore + Main 设置持久化 + 设置中心「语音」子页 + 麦克风权限放行。

**Architecture:** 三层边界不变。麦克风采集在 Renderer（getUserMedia + AudioWorklet → PCM 16k/s16le chunk）→ 单向 `voice:audio-chunk` IPC（`registerOneWayHandler` 可信发送者守卫）→ Main `adapter.sendAudioBytes` → WS BINARY。控制帧走 invoke；`voice_session.ack` 背压窗口暂停/恢复采集。TTS：real-backend 收 `audio_start/audio/audio_end/audio_cancelled` 帧，Main 解码缓冲 → 注入 `getTtsMedia` sink 写 MediaService `tts-live` → emit `audio.session.*`（envelope 经 mapper `stampEvent` 单一计数器）；Renderer `CyTtsPlayer`（隐藏 `<audio>`）播放，`autoReadReply` 播放门。语音族错误经 `voice.error` 事件到 voiceStore，connectionStore 横幅抑制。设置持久化 Main `dirs.config/settings.json`（atomicWrite + zod）。

**Tech Stack:** Electron + Vue 3 + TypeScript + Pinia + zod（运行时 schema）+ Vitest（单测）+ Playwright `_electron`（集成）。

**Spec:** [2026-08-16-phase4b-voice-settings-design.md](../specs/2026-08-16-phase4b-voice-settings-design.md)（plan 从 spec 论证；执行者两者都读）

## Global Constraints

- **信任边界**：Renderer 永不连接后端/持 token/见原始帧；TTS 二进制不跨 IPC（只传 `cyrene://renderer/__cyrene-media/tts-live/{id}` URL）；麦克风样本仅经 `voice:audio-chunk` 送 Main→后端，内存态。
- **单向 IPC 守卫（D-P18）**：`voice:audio-chunk` 经 `registerOneWayHandler`（复用 `isTrustedSender`）；payload zod `{ bytes: Uint8Array }`，`bytes.byteLength ≤ 1MiB` 超限丢弃+warn。仓库零裸 `ipcMain.on`。
- **envelope 单一计数器（F-5）**：所有新 BackendEvent（含 transport 构造的 `audio.session.*`/`voice.error`）经 mapper `stampEvent` 打 `eventId: ${connectionId}:${sequence}`；不得自建计数器。
- **schema 镜像（F-2）**：`shared/schemas/events.ts` `BackendEventSchema` 必须同步新增 13 事件（各含 `eventId`+`sequence` 必填），否则 preload 丢弃。
- **控制帧先于采集（D-P19）**：record/realtime/dictation 均先 `api.voiceStart*` await 成功再 `PcmCapture.start`。
- **语音族错误路由（D-P15）**：`VOICE_ERROR_CODES`（`STT_UNAVAILABLE`/`STT_PROFILE_NOT_FOUND`/`VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`/`VOICE_RECORDING_NOT_FOUND`/`DICTATION_NOT_FOUND`/`PLAYBACK_NOT_FOUND`）→ real-backend 额外 emit `voice.error`（保留 onError 日志/审计）；connectionStore 不展示连接横幅。
- **wire pause/resume 预留不用**（D-P3）：不敷设 adapter/IPC/UI；背压用本地 `PcmCapture.pause()`。
- **音频不落盘、不入消息**；`inner_voice`/转写不记日志。
- **DataCloneError 纪律**：跨 IPC 的 bytes 显式 `Uint8Array` 拷贝，绝不用 reactive 代理。
- **TDD 纪律（Minor 25）**：每个任务内测试与实现同批完成；关键行为（D-P19 控制帧先于采集、背压窗口边界、`stampEvent` 单调、语音族错误路由）**先写失败断言再实现**，禁止事后补测。测试文件一律落 `tests/unit/**`（vitest include glob），`src/` 下 spec 不执行。
- 测试纪律：1003 单测（88 files）/ 55 集成（13 files）基础上全绿；typecheck/lint/build 全绿；文档中文。真实 Windows Electron（REAL 模式）是验收方；本批 Mock 驱动标「已开发、未联调」。

---

## 文件结构

| 文件 | 职责 | Task |
|---|---|---|
| `src/shared/contracts/voice.ts`（新） | 语音命令/设置领域类型（spec §5.1） | 1 |
| `src/shared/contracts/events.ts` | 13 个新 BackendEvent（spec §5.2） | 1 |
| `src/shared/contracts/ipc.ts` | voice:/audio:/settings: 通道 | 1 |
| `src/shared/contracts/backend.ts` | 删旧 voice 桩类型 | 1 |
| `src/shared/schemas/events.ts` | BackendEventSchema 判别联合 +13 | 1 |
| `src/shared/schemas/ipc-response.ts` | settings/voice 出参 schema | 1 |
| `src/main/ipc/channels.ts` | voice/settings 入参 schema | 9 |
| `src/main/transport/protocol-v2/raw-types.ts` | server 13 + client 11 语音帧 | 2 |
| `src/main/transport/protocol-v2/raw-schemas.ts` | 对应 raw schema + RAW_FRAME_TYPES | 2 |
| `src/main/transport/protocol-v2/frame-mapper.ts` | 语音帧→BackendEvent + `stampEvent` | 2 |
| `src/main/transport/backend-adapter.ts` | 语音方法接口重写 | 3 |
| `src/main/transport/real-backend.ts` | 语音控制帧 + sendAudioBytes + 错误路由 + TTS 播放 | 4+5 |
| `src/main/attachments/media-service.ts` | `tts-live` 路由 + putTtsAudio | 6 |
| `src/main/transport/mock-backend.ts` | 语音/TTS 模拟 | 7 |
| `src/main/settings/settings-service.ts`（新） | 设置持久化 | 8 |
| `src/main/voice/voice-handlers.ts`（新） | voice/settings IPC handler | 9 |
| `src/main/ipc/registry.ts` | `registerOneWayHandler` | 9 |
| `src/main/ipc/handlers.ts` + `src/main/index.ts` | 装配 + 权限处理器 + mediaBridge | 9 |
| `src/preload/desktop-api.ts` + `index.d.ts` + `renderer/src/stores/desktop-api.types.ts` | 暴露 voice/settings 方法 | 9 |
| `src/renderer/src/voice/voice-capture.ts` + `pcm-worklet.js`（新） | 麦克风采集 | 10 |
| `src/renderer/src/stores/settings.store.ts`（新） | 设置 store（voice/dictation） | 11 |
| `src/renderer/src/stores/message.store.ts` | `voice_session.turn` + `sendVoiceCommit` | 11 |
| `src/renderer/src/stores/voice.store.ts`（新） | 语音会话编排 | 12 |
| `src/renderer/src/stores/connection.store.ts` + `conversation.store.ts` + `bootstrap.ts` | 横幅抑制 + 守卫 + 接线/reset | 13 |
| `src/renderer/src/components/`（CyVoicePending/CyRealtimeBar/CyDictationHint/CyTtsPlayer/CyVoicePane/CyChatInput） | 语音 UI | 14 |
| `docs/02/03/06/07/08/10/11/12/13/16` + `README` + `CLAUDE.md` + 决策记录 | 文档同步 | 16 |

---

### Task 1: 领域契约 + zod schema 镜像

**Files:**
- Create: `apps/desktop/src/shared/contracts/voice.ts`
- Modify: `apps/desktop/src/shared/contracts/events.ts`、`apps/desktop/src/shared/contracts/ipc.ts`、`apps/desktop/src/shared/contracts/backend.ts`、`apps/desktop/src/shared/schemas/events.ts`、`apps/desktop/src/shared/schemas/ipc-response.ts`
- Test: `tests/unit/schemas.spec.ts`（扩展现有）+ `tests/unit/voice-contracts.spec.ts`（新）——**vitest include glob 仅 `tests/unit/**`，`src/` 下 spec 永不执行（Critical-1 修复）**

**Interfaces:**
- Consumes: spec §5.1（voice.ts 类型）、§5.2（events）、§5.3（IPC 通道）
- Produces: `VoiceSettings`/`DictationSettings`/`SettingsState`/`SettingsPatch`、13 个 BackendEvent 成员、**14 个 IPC 通道常量**、schema 镜像——Task 2-12 全部消费

- [ ] **Step 1: 创建 `shared/contracts/voice.ts`**（spec §5.1 全量类型）

```ts
export interface AudioInputDescriptor { codec: 'pcm_s16le'; sampleRate: 16000; channels: 1 }
export type VoiceInputMode = 'record' | 'realtime' | 'dictation'
export interface VoiceRecordStartInput { recordingId: string }
export interface VoiceRecordStopInput { recordingId: string }
export interface VoiceCommitInput {
  recordingId: string; text: string; conversationId: string
  clientRequestId: string; clientMessageId: string
}
export interface VoiceDiscardInput { recordingId: string }
export interface RealtimeVoiceStartInput { sessionId: string; conversationId?: string }
export interface RealtimeVoiceControlInput { sessionId: string }
export interface DictationStartInput { clientRequestId: string; sttProfileId?: string }
export interface DictationStopInput { clientRequestId: string }
export interface AudioChunkInput { bytes: Uint8Array }
export interface AudioCancelInput { streamId: number }
export interface VoiceSettings {
  enabled: boolean; realtimeEnabled: boolean; autoReadReply: boolean
  showCaptions: boolean; consentBackendStt: boolean; micDeviceId?: string
}
export interface DictationSettings { sttProfileId?: string; insertMode: 'append' | 'replace_selection' }
export interface SettingsState { version: 1; voice: VoiceSettings; dictation: DictationSettings }
export type SettingsPatch = Partial<{ voice: Partial<VoiceSettings>; dictation: Partial<DictationSettings> }>
export const VOICE_ERROR_CODES = [
  'STT_UNAVAILABLE', 'STT_PROFILE_NOT_FOUND', 'VOICE_SESSION_CONFLICT', 'VOICE_SESSION_NOT_FOUND',
  'VOICE_RECORDING_TOO_LONG', 'VOICE_RECORDING_NOT_FOUND', 'DICTATION_NOT_FOUND', 'PLAYBACK_NOT_FOUND'
] as const
```

- [ ] **Step 2: `contracts/events.ts` 增 13 事件**（spec §5.2 逐字）——`VoiceTranscriptEvent`/`VoiceSessionStartedEvent`/`VoiceSessionPartialEvent`/`VoiceSessionTurnEvent`/`VoiceSessionAckEvent`/`VoiceSessionEndedEvent`/`DictationPartialEvent`/`DictationFinalEvent`/`DictationCancelledEvent`/`AudioSessionStartedEvent`/`AudioSessionReadyEvent`/`AudioSessionCancelledEvent`/`VoiceErrorEvent`，全部 `extends BackendEventEnvelope`，加入 `BackendEvent` 判别联合。
- [ ] **Step 3: `contracts/ipc.ts` 增 14 通道**（spec §5.3：`voiceStartRecord`/`voiceStopRecord`/`voiceCommit`/`voiceDiscard`/`voiceStartRealtime`/`voiceStopRealtime`/`voiceCancelRealtime`/`voiceStartDictation`/`voiceStopDictation`/`voiceCancelDictation`/`voiceAudioChunk`/`audioCancel`/`settingsLoad`/`settingsSave`——**14 个，非 13**，Minor 10 修复）。
- [ ] **Step 4: `contracts/backend.ts` 旧语音桩类型暂留**（`VoiceInputSession`/`StartVoiceInputInput`/`StopVoiceInputInput`/`DictationSession`/`StartDictationInput`/`StopDictationInput`）——**删除归 Task 3**（Task 1 删会立即 break `backend-adapter.ts`/`mock-backend.ts`/`real-backend.ts` 的 typecheck，P4-A 同款连锁；Task 3 同 commit 重写接口 + 删旧类型）。

> **连锁（BackendEvent union 扩展）**：`message.store.spec.ts` 等对 `BackendEvent` 做对象字面量 excess-property 或 switch exhaustive 的测试可能报新类型错误——如出现，为受影响 fixture 补 `event` 字段/改用合法构造（P4-A 同款连锁）。保持本任务结束时 `pnpm test` 该相关 spec 绿。

- [ ] **Step 5: `shared/schemas/events.ts` 镜像 +13**：`BackendEventSchema` 判别联合增 13 个 zod 对象（`event` 判别 + 字段 + `eventId`/`sequence` 必填 `z.string()`/`z.number().int()`），导出新 schema。`dictation.final`/`dictation.cancelled` 的 `clientRequestId` 必填；`voice_session.ended.reason` 枚举四值；`audio.session.ready.format` 枚举 `wav|mp3` 可选。
- [ ] **Step 6: `shared/schemas/ipc-response.ts` 增 `SettingsStateSchema`**（镜像 §5.1，含默认值导出 `DEFAULT_SETTINGS`：`enabled:true/realtimeEnabled:false/autoReadReply:true/showCaptions:true/consentBackendStt:false/insertMode:'append'`）+ `SettingsPatchSchema`。
- [ ] **Step 7: 写 schema 测试**：`tests/unit/schemas.spec.ts` 增 `BackendEventSchema` 镜像断言——13 新事件各一个合法样例 parse 通过；**缺 `eventId` 与缺 `sequence` 均拒绝**（Minor 15：spec 要求两者都必填）；`voice_session.ended.reason` 非法值拒绝。`tests/unit/voice-contracts.spec.ts`（新）：`SettingsStateSchema.parse(DEFAULT_SETTINGS)` 通过、patch merge 后 parse 通过。
- [ ] **Step 8: 运行** `pnpm -F @cyrene/desktop test`（相关 spec）——新测试绿、既有绿（union 连锁已修）。
- [ ] **Step 9: Commit** `feat(阶段4批B): 语音/设置领域契约 + zod schema 镜像（13 事件）`

---

### Task 2: raw 帧 + frame-mapper（stampEvent）+ 连锁门禁

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-types.ts`、`raw-schemas.ts`、`frame-mapper.ts`
- Modify（连锁门禁）: `tests/unit/raw-schemas.spec.ts`、`tests/unit/wire-fixtures.spec.ts`、`scripts/check-backend-contract.mjs`、`apps/desktop/src/main/fixtures/wire-v2/*.manifest.json`
- Test: `tests/unit/raw-schemas.spec.ts`、`tests/unit/wire-fixtures.spec.ts`、`tests/unit/frame-mapper.spec.ts`

**Interfaces:**
- Consumes: Task 1 events；后端契约（ws_message.py 各帧字段）
- Produces: `RawFrame` 联合含 13 server + 11 client 语音帧；`RAW_FRAME_TYPES`；`FrameMapper.stampEvent<T>(partial)`（公开，共享计数器）——Task 4/5 用

- [ ] **Step 1: `raw-types.ts` 增 server 帧**（字段逐字对齐 ws_message.py）：`RawVoiceTranscript`、`RawVoiceSessionStarted`、`RawVoiceSessionPartial`、`RawVoiceSessionTurn`、`RawVoiceSessionAck`、`RawVoiceSessionEnded`（reason 四值）、`RawDictationPartial`、`RawDictationFinal`、`RawDictationCancelled`、`RawAudioStart`（`stream_id`、`format`、`sampleRate?`、`durationMs?`）、`RawAudioChunk`（`stream_id`、`seq`、`data`(base64)、`is_final`）、`RawAudioEnd`（`stream_id`、`format?`）、`RawAudioCancelled`（`stream_id`）。
- [ ] **Step 2: `raw-types.ts` 增 client 帧并新建 `RawClientFrame` 联合**（仓库当前无此类型，需创建，M1 修复）：`RawVoiceRecordStart`（`recordingId`）、`RawVoiceRecordStop`、`RawVoiceCommit`（`recordingId`/`text`/`clientRequestId`/`clientMessageId?`/`conversationId?`）、`RawVoiceDiscard`、`RawVoiceSessionStart`、`RawVoiceSessionStop`、`RawVoiceSessionCancel`、`RawDictationStart`（`clientRequestId`/`sttProfileId?`）、`RawDictationStop`、`RawDictationCancel`、`RawAudioCancel`（`stream_id`）——client 帧**不进 `RawFrameSchema`**（`RAW_FRAME_TYPES` 只派生自 server 帧）。
- [ ] **Step 3: `raw-schemas.ts` 对应 zod**：`stream_id`/`seq` 为 `z.number().int()`；`data` 为 `z.string()`；server 帧入 `RawFrameSchema` 判别联合；**`RAW_FRAME_TYPES` 更新为 15+13=28**（只含 server 帧；client 帧单独 schema 不计数）。
- [ ] **Step 4: `frame-mapper.ts` 映射 server 语音帧 → BackendEvent**（`voice.transcript`/`voice_session.*`/`dictation.*`/`audio_start`→`AudioSessionStartedEvent`/`audio_cancelled`→`AudioSessionCancelledEvent`）；**`audio`/`audio_end` 返回 null**（transport 消费，不进 mapper）。
- [ ] **Step 5: `frame-mapper.ts` 增公开 `stampEvent<T extends BackendEvent>(partial: Omit<T, 'eventId' | 'sequence'>): T`**——用既有私有单调计数器打 `eventId: ${connectionId}:${sequence}` + `sequence`，`return { ...this.envelope(), ...partial } as T`（TS 需 `as T` 收窄，M2 修复），返回完整事件（供 transport 构造 `audio.session.ready`/`voice.error`）。既有 `mapFrame` 内部改用同一计数器实现，保证不碰撞。
- [ ] **Step 6: 连锁门禁同步**：`raw-schemas.spec.ts` 硬编码类型列表更新为 15+N；`wire-fixtures.spec.ts` 断言 `schemaHash === rawSchemasFingerprint()` → **重生成全部 `wire-v2/*.manifest.json`**（`schemaHash` 重新计算 `rawSchemasFingerprint()`，P4-A 同款：直接算 hash 写回）；`check-backend-contract.mjs` 的 `WS_V2_FRAME_TYPES` 增 13 server 帧（由「只 warn」转 hard-check），更新顶部注释。
- [ ] **Step 7: 写测试**：raw-schemas——13 server + 关键 client 帧各一个合法 fixture parse 通过 + 缺字段拒绝；frame-mapper——各 server 帧映射正确 + `audio`/`audio_end` 返回 null + **`stampEvent` 与 `mapFrame` 交错 sequence 严格递增**；`RAW_FRAME_TYPES` 计数断言。
- [ ] **Step 8: 运行** `pnpm -F @cyrene/desktop test` 相关 spec + `pnpm -F @cyrene/desktop check:contract`——全绿。
- [ ] **Step 9: Commit** `feat(阶段4批B): 语音 raw 帧 + frame-mapper stampEvent + 门禁同步`

---

### Task 3: BackendAdapter 语音接口重写

**Files:**
- Modify: `apps/desktop/src/main/transport/backend-adapter.ts`、`apps/desktop/src/main/transport/mock-backend.ts`、`apps/desktop/src/main/transport/real-backend.ts`
- Test: `tests/unit/backend-adapter.spec.ts`（若存在接口断言）

**Interfaces:**
- Consumes: Task 1 类型（VoiceCommitInput 等）
- Produces: 新语音方法签名（Task 4-7 实现）

- [ ] **Step 1: 重写 `backend-adapter.ts`** 接口——删旧四桩，增（逐字 spec §5.4）：`startRecordVoice`/`stopRecordVoice`/`commitVoice`/`discardVoice`/`startRealtimeVoice`/`stopRealtimeVoice`/`cancelRealtimeVoice`/`startDictation`/`stopDictation`/`cancelDictation`/`sendAudioBytes(bytes: Uint8Array): void`/`audioCancel`。**同 commit 删 `contracts/backend.ts` 旧语音桩类型**（`VoiceInputSession`/`StartVoiceInputInput`/`StopVoiceInputInput`/`DictationSession`/`StartDictationInput`/`StopDictationInput`；`ToolResult` 保留）——避免 Task 1 删类型致 typecheck 红（I1 修复）。
- [ ] **Step 2: `mock-backend.ts`/`real-backend.ts` 旧桩删除**：先删 `startVoiceInput`/`stopVoiceInput`/`startDictation`/`stopDictation` 旧实现（新实现 Task 4/7 补，中间态 `notImplemented` 抛错保持编译绿）。
- [ ] **Step 3: 运行** `pnpm -F @cyrene/desktop typecheck`——接口两侧签名一致。
- [ ] **Step 4: Commit** `refactor(阶段4批B): BackendAdapter 语音接口重写（删旧桩）`

---

### Task 4: real-backend 语音控制帧 + sendAudioBytes + 语音族错误路由

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts`、`apps/desktop/src/main/transport/protocol-v2/frame-mapper.ts`（仅调用）
- Test: `tests/unit/real-backend-voice.spec.ts`（新，fake ws）

**Interfaces:**
- Consumes: Task 1（输入类型/VOICE_ERROR_CODES）、Task 2（RawFrame/stampEvent）、Task 3（接口）
- Produces: `sendAudioBytes` 双 guard、`commitVoice` pendingAck、`voice.error` emit——Task 5/9 用

- [ ] **Step 1: `WebSocketLike` 接口 `send` 扩为 `string | Uint8Array`**；`RealBackendOptions` 增 `voiceAckTimeoutMs?`（默认 15000）。
- [ ] **Step 2: 单活动语音会话注册表**：`private activeVoice?: { kind: VoiceInputMode; key: string }`。`start*` 前 `if (this.activeVoice) throw new Error('已有活动语音会话进行中')`（本地抛错防重入——不依赖 `CyreneErrorCode` 枚举，真实冲突由后端 `error{VOICE_SESSION_CONFLICT}` 帧经 `voice.error` 兜底）；成功后置位；`stop/cancel/discard/ended` 清位。
- [ ] **Step 3: 控制帧方法**（均先 `const ws = this.requireWs()`——既有 `requireWs()` 抛 `NOT_CONNECTED`，随后 `ws.send(JSON.stringify(...))`；`ws` 为可变属性 TS 不窄化故用局部 const）：
  - `startRecordVoice({recordingId})` → `{ type:'voice.record.start', recordingId }`；置 active。
  - `stopRecordVoice({recordingId})` → `{ type:'voice.record.stop', recordingId }`；清 active（TRANSCRIBING 窗口仍等 transcript）。
  - `commitVoice(input)` → `{ type:'voice.commit', recordingId, text, clientRequestId, clientMessageId, conversationId }`；**复用既有 `pendingAck` 机制**（按 `clientRequestId` 关联 `user_message.ack`，await 后返回 `ClientRequestRef`；`ackTimeoutMs` 超时 reject）。
  - `discardVoice({recordingId})` → `{ type:'voice.discard', recordingId }`；清 active。
  - `startRealtimeVoice({sessionId, conversationId})` → `{ type:'voice_session.start', sessionId, conversationId }`；置 active。
  - `stopRealtimeVoice`/`cancelRealtimeVoice({sessionId})` → `{ type:'voice_session.stop'|'voice_session.cancel', sessionId }`；清 active（ended 事件到达时清）。
  - `startDictation({clientRequestId, sttProfileId})` → `{ type:'dictation.start', clientRequestId, ...(sttProfileId ? { sttProfileId } : {}) }`；置 active。
  - `stopDictation`/`cancelDictation({clientRequestId})` → `{ type:'dictation.stop'|'dictation.cancel', clientRequestId }`；清 active。
  - `audioCancel({streamId})` → `{ type:'audio.cancel', stream_id: streamId }`。
- [ ] **Step 4: `sendAudioBytes(bytes)`**（同步 void）：`if (this.state.status !== 'connected' || !this.ws) { this.warn('VOICE_BINARY_NOT_CONNECTED', ...); return }`；`if (!this.activeVoice) { this.warn('VOICE_BINARY_NO_SESSION', ...); return }`；`this.ws.send(bytes)`。
- [ ] **Step 5: 语音族错误路由（D-P15）**：`handleErrorFrame(frame)` 中若 `VOICE_ERROR_CODES.includes(frame.code)` **或（`frame.code==='CONTRACT_VALIDATION' && this.activeVoice`）**（Minor 9 修复：CONTRACT_VALIDATION 不入 `VOICE_ERROR_CODES`——避免非语音 CONTRACT 也抑制连接横幅；但语音会话活跃时的 CONTRACT 违规 emit `voice.error`）→ `this.emit(this.mapper.stampEvent({ event: 'voice.error', code: frame.code, ...(frame.message ? { message: frame.message } : {}) }))`；**随后仍走既有 `this.options.onError` 路径**（日志/审计不丢）。非语音族不变。
- [ ] **Step 6: ws 二进制接收忽略**：`ws.on('message', (arg, isBinary))`——`Buffer.isBuffer(arg)` → `this.warn('UNEXPECTED_BINARY', ...)`；否则原 `handleFrame(String(arg))`。
- [ ] **Step 7: 写测试**（fake ws 捕获 sent frames 数组）：
  - 各控制帧发送 JSON 断言（含 `voice.record.start` **无 conversationId**、`dictation.start` 无 sttProfileId 时不带键、**`voice_session.start` 带 conversationId 键（传入时）**）。
  - **单活动会话注册表（Important-2）**：`startRecordVoice` 两次 → 第二次抛「已有活动语音会话」；`stopRecordVoice` 后再次 start 成功；未 start 时 `sendAudioBytes` 丢弃。
  - `commitVoice` await ack：fake 收到 commit 后回 `user_message.ack{clientRequestId, serverMessageId}` → resolve ref；不匹配 clientRequestId 的 ack 不结算。
  - `sendAudioBytes`：connected+active 时 ws 收到 `Uint8Array`；无 active 丢弃 warn；断连丢弃 warn 不 throw。
  - 错误路由：fake 发 `error{code:'VOICE_SESSION_CONFLICT'}` → emit `voice.error`；`error{code:'UNKNOWN'}` → 不 emit voice.error、onError 照常；**`error{code:'CONTRACT_VALIDATION'}` 且有 activeVoice → emit voice.error、无 activeVoice → 不 emit**（Minor 9）。
  - 二进制接收：fake 发 Buffer → warn 不崩。
- [ ] **Step 8: 运行** `pnpm -F @cyrene/desktop test` real-backend-voice.spec + 既有 real-backend spec 绿。
- [ ] **Step 9: Commit** `feat(阶段4批B): real-backend 语音控制帧 + sendAudioBytes 守卫 + voice.error 路由`

---

### Task 5: real-backend TTS 播放处理（audio_* 帧 + getTtsMedia sink）

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts`、`apps/desktop/src/main/transport/backend-adapter.ts`（`RealBackendOptions` 类型在 real-backend.ts 内）
- Test: `tests/unit/real-backend-tts.spec.ts`（新，fake ws + fake sink）

**Interfaces:**
- Consumes: Task 2 `stampEvent`、Task 4 handleFrame 基建
- Produces: `RealBackendOptions.getTtsMedia?`、`audio.session.started/ready/cancelled` 事件——Task 6/9 装配用

- [ ] **Step 1: options 增 `getTtsMedia?: () => TtsMediaSink | undefined`**；`export type TtsMediaSink = { putTtsAudio(id: string, bytes: Uint8Array, mime?: string): { url: string } }`。
- [ ] **Step 2: TTS 缓冲状态**：`private ttsBuffers = new Map<number, { chunks: Uint8Array[]; bytes: number; format: 'wav' | 'mp3'; durationMs?: number }>()`。
- [ ] **Step 3: `handleFrame` 增分支**（`case 'audio_start'`/`'audio'`/`'audio_end'`/`'audio_cancelled'`）。**`import { randomUUID } from 'node:crypto'`**（M9 修复：非全局）：
  - `audio_start`：`this.ttsBuffers.set(frame.stream_id, { chunks: [], bytes: 0, format: frame.format, ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}) })`（**M6 修复：`durationMs` 从 `audio_start` 帧拷贝**）；`emit(this.mapper.mapFrame(frame)!)`（→ `AudioSessionStartedEvent`）。新 stream 到来时若旧 stream 仍在缓冲 → `this.ttsBuffers.delete(旧)`（supersede）。
  - `audio`：base64 decode（`Buffer.from(frame.data, 'base64')`）→ append 到 `chunks`，`bytes += len`。
  - `audio_end`：`const b = this.ttsBuffers.get(frame.stream_id)`；无 → warn 返回。`const mime = b.format === 'mp3' ? 'audio/mpeg' : 'audio/wav'`；`const sink = this.options.getTtsMedia?.()`；无 sink → `warn('TTS_MEDIA_SINK_MISSING')` + delete + 返回。`const { url } = sink.putTtsAudio(`tts-${randomUUID()}`, concat(chunks), mime)`；`this.emit(this.mapper.stampEvent({ event: 'audio.session.ready', streamId: frame.stream_id, url, ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}), format: b.format }))`；`this.ttsBuffers.delete(frame.stream_id)`。
  - `audio_cancelled`：`this.ttsBuffers.delete(frame.stream_id)`；`emit(this.mapper.mapFrame(frame)!)`（→ `AudioSessionCancelledEvent`）。
- [ ] **Step 4: 写测试**：fake ws 推 `audio_start{stream_id:1, format:'wav'}` + `audio{data: base64(wav bytes)}` + `audio_end` → fake sink 收到 bytes + mime `'audio/wav'` + emit `audio.session.ready{streamId:1, url, format:'wav'}`（envelope eventId/sequence 与 mapFrame 交错单调）；**字节 round-trip 断言（Important-3）：fake sink 收到的 bytes 解码后与原推入 bytes 逐字节相等；两个 `audio` 帧按序拼接**；**`durationMs` 透传（`audio_start.durationMs` 设 → ready 带 durationMs；未设 → 键缺省）**；`format:'mp3'` → mime `'audio/mpeg'`；`audio_cancelled` → 清 buffer + emit cancelled；新 `audio_start` supersede 旧 buffer；无 sink → warn + 无 ready。
- [ ] **Step 5: 运行** `pnpm -F @cyrene/desktop test` real-backend-tts.spec + 既有绿。
- [ ] **Step 6: Commit** `feat(阶段4批B): real-backend TTS 播放帧处理 + getTtsMedia sink`

---

### Task 6: MediaService tts-live 路由

**Files:**
- Modify: `apps/desktop/src/main/attachments/media-service.ts`
- Test: `tests/unit/media-service.spec.ts`

**Interfaces:**
- Consumes: 既有 `putTtsPreview`/`streamTtsPreview` 模式
- Produces: `MediaRouteType` 含 `'tts-live'`、`putTtsAudio(id, bytes, mime, opts)`、`stream()` tts-live 分支——Task 9 装配 `getTtsMedia` 用

- [ ] **Step 1: `MediaRouteType` 增 `'tts-live'`**；`parseMediaPath` 白名单同步。
- [ ] **Step 2: `putTtsAudio(id, bytes, mime?, opts?: { ttlMs?: number }): { url: string }`**：镜像 `putTtsPreview` 的内存 Map 缓存，`ttlMs` 缺省 300000（5min）；惰性清理（put 时 sweep 过期项）；**返回 `{ url: \`cyrene://renderer${MEDIA_PATH_PREFIX}tts-live/${id}\` }`**（M5 修复：`putTtsPreview` 返回 void，但 `TtsMediaSink` 契约要求 `{ url }`——URL 构造参照 `model-handlers.ts` 的 tts-preview 组装）。
- [ ] **Step 3: `stream()` 增 `tts-live` 分支**：镜像 `streamTtsPreview`——缓存命中 → 200 `mime` + `Cache-Control: no-store`；缺失 → 404。
- [ ] **Step 4: 写测试**：putTtsAudio 后 stream tts-live 返回字节/mime + **`Cache-Control: no-store`（Minor 17）**；缺失 404（含 mock 占位 `tts-live/mock-silent`）；TTL 过期后 404；`parseMediaPath('tts-live')` 接受、`attachment` 不受影响。
- [ ] **Step 5: 运行** `pnpm -F @cyrene/desktop test` media-service.spec 绿。
- [ ] **Step 6: Commit** `feat(阶段4批B): MediaService tts-live 媒体路由`

---

### Task 7: mock-backend 语音 + TTS 模拟

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`
- Test: `tests/unit/mock-backend-voice.spec.ts`（新）、既有 `mock-backend-model-services.spec.ts` 保持绿

**Interfaces:**
- Consumes: Task 1 类型/事件、Task 3 接口
- Produces: 语音/TTS 模拟 + `receivedAudioChunks` + envelope 单调——Task 9 IPC 测试 + Task 12/14/15 集成用

- [ ] **Step 1: 语音状态**：`private activeVoice?: { kind: VoiceInputMode; key: string }`；`public receivedAudioChunks: number = 0`；**envelope 计数器强制复用既有 generation 模拟的 stamp 逻辑（单一共享计数器，Minor 11 修复——独立 `voiceSeq` 会与 replay 事件交错非单调，`mock-replay.spec` 断言全局升序）**。
- [ ] **Step 2: `sendAudioBytes(_bytes)`**：`this.receivedAudioChunks++`；若 `activeVoice` 存在且 `kind==='realtime'` → 首次 chunk 后 `setTimeout` 依次 emit `voice_session.partial` + `voice_session.turn`（`messageId: msg_<uuid>`、`text: '实时语音轮次文本'`、`conversationId` 取会话）。
- [ ] **Step 3: 三模式方法**：
  - `startRecordVoice({recordingId})` → active={record, key}; `stopRecordVoice` → `options.voiceTranscriptText`（缺省 `'这是一段测试录音的转写文本'`；显式空串测「未识别」）非空时 emit `voice.transcript{recordingId, text}`；`commitVoice` → 复用既有 ack 模拟（emit `user_message.ack{clientRequestId, serverMessageId}`）+ 触发既有 generation 模拟（同文本发送路径）；`discardVoice` → 清 active。
  - `startRealtimeVoice({sessionId, conversationId})` → active={realtime}; emit `voice_session.started{sessionId, conversationId}`；`stopRealtimeVoice` → emit `voice_session.ended{reason:'stopped'}` + 清 active；`cancelRealtimeVoice` → `ended{reason:'cancelled'}`。
  - `startDictation({clientRequestId})` → active={dictation}; `stopDictation` → emit `dictation.final{clientRequestId, text:'这是听写文本'}` + 清 active；`cancelDictation` → emit `dictation.cancelled{clientRequestId}`。
  - 选项注入 `options.voiceError?: { code: string; message?: string }` → 各 start 时 emit `voice.error`。
- [ ] **Step 4: TTS 模拟**：`get ttsActive(): boolean` → `!!this.activeSelection.ttsProfileId`（**无独立标志**，D-P13）；generation completed 逻辑中若 `ttsActive` → 追加 emit `audio.session.started{streamId:1, format:'wav'}` + `audio.session.ready{streamId:1, url:'cyrene://renderer/__cyrene-media/tts-live/mock-silent', format:'wav'}`；`audioCancel` → emit `audio.session.cancelled`。
- [ ] **Step 5: envelope 单调**：全部语音事件经**共享 generation 计数器**打 `eventId`/`sequence`，与既有 replay 事件交错仍递增。
- [ ] **Step 6: 写测试**：record stop→transcript→commit→ack；realtime started→(binary)→partial→turn→ended；dictation partial→final/cancelled；`receivedAudioChunks` 计数；voiceError 注入 emit；**envelope 交错单调（Important-4）：generation 事件 + voice 事件交错 → `sequence` 严格递增**；**空转写（`options.voiceTranscriptText=''`）→ stop 不 emit transcript（Minor 18）**；TTS 仅 `ttsActive` 时触发（`mock-backend-model-services.spec` 只激活 LLM → 无 audio 事件，既有测试不受影响）。
- [ ] **Step 7: 运行** `pnpm -F @cyrene/desktop test` mock-backend-voice.spec + 既有 mock spec 全绿。
- [ ] **Step 8: Commit** `feat(阶段4批B): mock-backend 语音/TTS 模拟`

---

### Task 8: Main SettingsService + 设置 IPC

**Files:**
- Create: `apps/desktop/src/main/settings/settings-service.ts`
- Modify: `apps/desktop/src/main/ipc/handlers.ts`、`apps/desktop/src/main/index.ts`（deps）
- Test: `tests/unit/settings-service.spec.ts`（新，tmpdir）

**Interfaces:**
- Consumes: Task 1 `SettingsState`/`DEFAULT_SETTINGS`/`SettingsPatch`、既有 `atomicWriteFile`/`openSafeFile`
- Produces: `SettingsService.load/save`、`registerSettingsHandlers`——Task 9 注册用

- [ ] **Step 1: `settings-service.ts`**：构造 `{ dir: string; safeRoot: string; logger: Logger }`；`load()`——文件缺失→`DEFAULT_SETTINGS`；存在→`openSafeFile` + JSON parse + `SettingsStateSchema.safeParse`；失败→备份为 `settings.json.corrupt` + 回默认（fail-open）；`save(patch)`——merge（`{ ...state, ...patch, voice: {...state.voice, ...patch.voice}, dictation: {...} }`）+ `SettingsStateSchema.parse` + **`atomicWriteFile(path, JSON.stringify(newState), { safeRoot: this.safeRoot })`**（I2 修复：`atomicWriteFile` 第三参 `opts.safeRoot` 必填，复用不手写 tmp+rename）。
- [ ] **Step 2: `registerSettingsHandlers(deps: { settings: SettingsService; sanitize; logger })`**：`settings:load` → `SettingsState`；`settings:save` → 校验 `SettingsPatchSchema` → `settings.save(patch)` → 返回新 state。
- [ ] **Step 3: `handlers.ts` 装配**：deps 增 `settings: { svc: SettingsService }`，`registerSettingsHandlers` 注册。
- [ ] **Step 4: 写测试**：load 缺失→默认；save merge 保留未触及字段；损坏文件→备份 + 默认；**版本不匹配（`version` 非 1）→ zod 拒绝或回默认（Minor 19）**；zod 拒绝非法 patch；原子写产物可读。
- [ ] **Step 5: 运行** `pnpm -F @cyrene/desktop test` settings-service.spec 绿。
- [ ] **Step 6: Commit** `feat(阶段4批B): Main 设置持久化 SettingsService`

---

### Task 9: IPC voice handlers + registerOneWayHandler + Preload + 麦克风权限 + 装配

**Files:**
- Create: `apps/desktop/src/main/voice/voice-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/registry.ts`（`registerOneWayHandler`）、`apps/desktop/src/main/ipc/channels.ts`（voice/settings requestSchema）、`apps/desktop/src/main/ipc/handlers.ts`、`apps/desktop/src/main/index.ts`（装配 + mediaBridge + 权限处理器）、`apps/desktop/src/preload/desktop-api.ts`、`apps/desktop/src/preload/index.d.ts`、`apps/desktop/src/renderer/src/stores/desktop-api.types.ts`、`apps/desktop/src/main/windows/main-window.ts`（session 权限）
- Test: `tests/unit/voice-handlers.spec.ts`（新）、`tests/integration/ipc-security.spec.ts`（白名单）、`tests/integration/ipc-voice.spec.ts`（新）

**Interfaces:**
- Consumes: Task 1 通道/类型、Task 3 接口、Task 4/5 real 实现、Task 6 MediaService、Task 8 SettingsService
- Produces: `desktopApi` voice/settings 方法、`registerOneWayHandler`、`getTtsMedia` 装配、麦克风权限——Task 10-14 消费

- [ ] **Step 1: `registry.ts` 增 `registerOneWayHandler(channel, schema, handler)`**：`ipcMain.on(channel, (event, payload) => { if (!isTrustedSender(event)) return; const parsed = schema.safeParse(payload); if (!parsed.success) { warn; return } handler(parsed.data) })`——`isTrustedSender` 复用既有（senderFrame===mainFrame + 受信 URL）。
- [ ] **Step 2: `channels.ts` 增 voice/settings requestSchema**：各 `voice:start-record` 等输入 zod（`recordingId`/`sessionId`/`clientRequestId` 为 `z.string().min(1)`，`sttProfileId` optional，`streamId` 为 `z.number().int()`，`bytes` 为 `z.instanceof(Uint8Array)`）；`settings:save` 用 `SettingsPatchSchema`。
- [ ] **Step 3: `voice-handlers.ts`**：`registerVoiceHandlers(deps: { adapter: BackendAdapter; media: MediaService; sanitize; logger })`——各控制帧 invoke handler（`createIpcHandler` 双层校验）；`voice:commit` → `adapter.commitVoice` → `ClientRequestRefSchema`；**`voice:audio-chunk` 经 `registerOneWayHandler`**（schema `{ bytes: z.instanceof(Uint8Array) }` + 运行期 `bytes.byteLength ≤ 1MiB` 校验）→ `adapter.sendAudioBytes(bytes)`；`audio:cancel` → `adapter.audioCancel`。
- [ ] **Step 4: `index.ts` 装配**：`const mediaBridge: { media: MediaService | undefined } = { media: undefined }`（**在 adapter 构造前声明**）；`new RealBackend({ ..., getTtsMedia: () => mediaBridge.media ? { putTtsAudio: (id, bytes, mime) => mediaBridge.media!.putTtsAudio(id, bytes, mime) } : undefined })`；`mediaBridge.media = mediaSvc`（mediaSvc 创建后）。`registerHandlers` deps 增 `settings: { svc }`、`voice: { adapter, media: mediaSvc }`。`new SettingsService({ dir: dirs.config, safeRoot, logger })`。
- [ ] **Step 5: 麦克风权限**（`main-window.ts` 或 index.ts，session 创建处）：`session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => { if (permission !== 'media') return false; if (details.mediaType === 'video') return false; return isAppRendererUrl(origin) })`；`setPermissionRequestHandler((wc, permission, cb, details) => { cb(permission === 'media' && details.mediaType !== 'video' && isAppRendererUrl(details.requestingUrl)) })`。`isAppRendererUrl` 直接复用 `trusted-renderer-origin.ts` 既有导出（`cyrene://renderer` host=`renderer` 已接受；dev localhost 受信，M4 修复——不新建 `isTrustedRendererOrigin`）。
- [ ] **Step 6: Preload `desktop-api.ts` + `index.d.ts` + `desktop-api.types.ts`**：新增 `voiceStartRecord/voiceStopRecord/voiceCommit/voiceDiscard/voiceStartRealtime/voiceStopRealtime/voiceCancelRealtime/voiceStartDictation/voiceStopDictation/voiceCancelDictation/audioCancel/settingsLoad/settingsSave`（invoke）+ `voiceSendAudio(bytes: Uint8Array)`（`ipcRenderer.send(IpcChannels.voiceAudioChunk, { bytes })`，显式 `new Uint8Array(bytes)` 拷贝防 DataCloneError）。
- [ ] **Step 7: `ipc-security.spec.ts` 白名单计数更新（42 → 42+14=56）**——Task 9 Step 6 增 14 个 desktopApi 键（13 invoke + `voiceSendAudio`，M3 修复）。
- [ ] **Step 8: 写测试**：voice-handlers——各控制帧 handler 转发 adapter（mock adapter 记录调用）；`voice:audio-chunk` 非受信 sender 拒收 / 超 1MiB 丢弃 / 合法 bytes 转发 `sendAudioBytes`；settings load/save 全链路。集成 `ipc-voice.spec.ts`——mock adapter 装配下 IPC → adapter 调用断言。**权限处理器（Important-5）**：`permission!=='media'` → false、`details.mediaType==='video'` → false、非受信 origin → false、audio+受信 origin → true（抽纯函数测）。**`voiceSendAudio` 拷贝（Important-6）**：preload 传入的 bytes 是 fresh copy（非同一引用）；reactive 代理输入不抛 DataCloneError。
- [ ] **Step 9: 运行** `pnpm -F @cyrene/desktop test` 相关 + typecheck + `pnpm -F @cyrene/desktop lint`。
- [ ] **Step 10: Commit** `feat(阶段4批B): voice/settings IPC + 单向守卫 + Preload + 麦克风权限 + 装配`

---

### Task 10: Renderer 音频采集（PcmCapture + worklet）

**Files:**
- Create: `apps/desktop/src/renderer/src/voice/voice-capture.ts`、`apps/desktop/src/renderer/src/voice/pcm-worklet.js`（含 `.d.ts` 或 `// @ts-expect-error` 声明）
- Test: `tests/unit/voice-capture.spec.ts`（新，纯函数 + mock getUserMedia/AudioContext）

**Interfaces:**
- Consumes: 无（独立模块）
- Produces: `PcmCapture`（start/pause/resume/stop）、`floatToPcm16(f32): Int16Array`——Task 12 用

- [ ] **Step 1: 纯函数 `floatToPcm16(f32: Float32Array): Int16Array`**（`pcm.ts` 或同文件导出）：每样本 `Math.max(-1, Math.min(1, v))` → `Math.round(v * 32767)` → Int16 LE。
- [ ] **Step 2: `pcm-worklet.js`**（AudioWorkletProcessor）：`process(inputs)`——单声道 Float32 → `floatToPcm16` → 累加 Int16 缓冲到 20ms（640 样本）→ `port.postMessage(chunk)`；`sampleRate` 取 context 16000。
- [ ] **Step 3: `voice-capture.ts` `class PcmCapture`**：
  - `start({ onChunk, onStop?, deviceId? }): Promise<void>`——`navigator.mediaDevices.getUserMedia({ audio: { deviceId, channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })` → `new AudioContext({ sampleRate: 16000 })` → **`audioContext.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href)`** → `source = createMediaStreamSource` → `source.connect(workletNode)` → `workletNode.port.onmessage = (e) => onChunk(new Uint8Array(e.data))`。**addModule 失败 → ScriptProcessorNode 降级**（`onaudioprocess` 同 `floatToPcm16` 聚合逻辑）。保留 `mediaStream`/`audioContext`/`chunks`（Float32 累积供 `onStop` AudioBuffer）。
  - `pause()`：`audioContext.suspend()`；`resume()`：`audioContext.resume()`；`stop()`：断节点 + `audioContext.close()` + 轨道停 + `onStop?.(audioBuffer)`（`audioContext.createBuffer(1, samples, 16000)` 复制累积样本）。
- [ ] **Step 4: 写测试**：`floatToPcm16` 边界（±1.0 截断、0、负值）；`PcmCapture` 用注入的 fake `navigator.mediaDevices`/`AudioContext`/`AudioWorklet` 断言 chunk 聚合与 stop 产物（mock `getUserMedia` 返回 fake stream）；**addModule reject → ScriptProcessorNode 降级路径 + chunk 仍送达（Important-7）**；**getUserMedia reject → `start()` reject（voiceStore 层转 micError）**。
- [ ] **Step 5: 运行** `pnpm -F @cyrene/desktop test` voice-capture.spec 绿 + typecheck。
- [ ] **Step 6: Commit** `feat(阶段4批B): Renderer 麦克风采集 PcmCapture + PCM 转换`

---

### Task 11: settingsStore + messageStore 语音扩展（voiceStore 依赖先建）

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/settings.store.ts`
- Modify: `apps/desktop/src/renderer/src/stores/message.store.ts`
- Test: `tests/unit/settings.store.spec.ts`（新）、`tests/unit/message.store.spec.ts`

**Interfaces:**
- Consumes: Task 1 `SettingsState`/`DEFAULT_SETTINGS`/`SettingsPatch`/`VOICE_ERROR_CODES`、Task 9 desktopApi（settingsLoad/settingsSave/voiceCommit）、既有 draftStore
- Produces: `useSettingsStore`（voice/dictation + `applyDictationInsert(text, selection?)` + `insertDictationText` 纯函数）、messageStore `voice_session.turn` + `sendVoiceCommit`——**Task 12 voiceStore 静态 import 依赖**（Critical-1 修复：voiceStore 需先建本 task 文件）

- [ ] **Step 1: `settings.store.ts`**（spec §5.10）：state `voice`/`dictation`（缺省 `DEFAULT_SETTINGS`）/`loaded`/`saveError`；`hydrate()` → `api.settingsLoad()` → 成功覆盖 state + `loaded=true`，失败 fail-open；`setVoice(patch)`/`setDictation(patch)` → 本地改 + **500ms 防抖** `api.settingsSave(patch)`（`saveError` 置位失败）；**`applyDictationInsert(text, selection?: { start: number; end: number })`**（D-P4）——纯函数 `insertDictationText(draft, text, mode, selection?)`（`append` 或无选区 → `draft + text`；`replace_selection` 有选区 → 替换区间）→ `useDraftStore().saveDraft(currentId, 新文本)`。`insertDictationText` 导出供单测。
- [ ] **Step 2: `message.store.ts`**：`applyEvent` 增 `case 'voice_session.turn'`——`const conv = event.conversationId ?? useConversationStore().currentId`；`conv === currentId` 时 `upsertMessage({ messageId: event.messageId, conversationId: conv, role: 'user', status: 'acknowledged', content: event.text, createdAt: nowIso() })`；不匹配 `guardDropEvent`。增 `async sendVoiceCommit(recordingId, text): Promise<boolean>`（镜像 `send()`：乐观 key `local-${clientRequestId}` + `api.voiceCommit` + migrateKey + `status='acknowledged'` + push cache；失败 → `failed` + lastError → false）。
- [ ] **Step 3: 写测试**：settings store——hydrate/merge/500ms 防抖持久化（fake timers）/fail-open；`insertDictationText` append/replace_selection/无选区回退；message store——`voice_session.turn` 插入 user 消息 + 归属不匹配丢弃；`sendVoiceCommit` 乐观+migrate+失败保留草稿语义。
- [ ] **Step 4: 运行** `pnpm -F @cyrene/desktop test` 相关 spec 全绿 + typecheck。
- [ ] **Step 5: Commit** `feat(阶段4批B): settingsStore + messageStore 语音扩展（turn/commit）`

---

### Task 12: voiceStore

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/voice.store.ts`
- Test: `tests/unit/voice.store.spec.ts`（新，setDesktopApi mock + fake PcmCapture）

**Interfaces:**
- Consumes: Task 1 类型/事件、Task 9 desktopApi、Task 10 PcmCapture、**Task 11 settingsStore/messageStore（静态 import 先序，Critical-1 修复）**
- Produces: voiceStore state/actions（spec §5.9 全量）——Task 14 UI 消费

- [ ] **Step 1: state**（spec §5.9）：`mode: 'idle'|'recording'|'record_pending'|'realtime'|'dictating'`、`caption`、`record: { elapsedMs, audioBuffer, transcript? }`、`realtime: { sessionId?, caption, turnCount, unacked, lastAckedSeq }`、`dictation: { caption, finalText?: string }`、`tts: { playingStreamId?, url?, playing, durationMs? }`、`micError?`/`error?`、`captureReady`、`consentPending: boolean`、`pendingAction: (() => Promise<void>) | null`。
- [ ] **Step 2: 常量**：`MAX_UNACKED_FRAMES = 200`、`ACK_STALL_MS = 5000`、`TRANSCRIPT_WAIT_MS = 45000`、`RECORD_HARD_CAP_MS = 600000`、`RECORD_WARN_MS = 300000`。
- [ ] **Step 3: `init()` + `handleEvent(e)`**（spec §5.9 逐项）：
  - `voice.transcript` → `record.transcript`/`caption` + `mode` 保持 record_pending + 清 transcript 等待 timer。
  - `voice_session.started` → realtime.sessionId + `mode='realtime'`；`partial` → realtime.caption；`turn` → realtime.turnCount++（消息插入由 messageStore 处理，本 store 不重复）；`ack` → realtime.lastAckedSeq = seq + `if (unacked - seq <= MAX_UNACKED_FRAMES) capture?.resume()`；`ended` → 清 realtime + 停采集 + `mode='idle'`。
  - `dictation.partial` → dictation.caption；**`final` → `dictation.finalText = text`（不直接插入——选区在组件，Task 14 消费后调 `clearDictationFinal()`）**；`cancelled` → 清态。
  - `audio.session.started` → 若 tts.playing 且不同 streamId → 停当前播放；`playingStreamId = streamId`。
  - `audio.session.ready` → `useSettingsStore().voice.autoReadReply` 为真 → `tts.url = url`/`playing = true`（触发 CyTtsPlayer 播放，Task 14）；为假 → 忽略。
  - `audio.session.cancelled` → 清 tts 态。
  - `voice.error` → `code === 'PLAYBACK_NOT_FOUND'` → 忽略；否则 `error = parsePublicError(...)`（record_pending/realtime/dictating 时展示到对应 UI）。
- [ ] **Step 4: 统一守卫（D-P11）**：`guardStart()`——`mode==='idle' && useConnectionStore().state.status === 'connected'`（I3 修复：connectionStore 暴露 `state`，不是 `status`）。**consent 机制（D-P16）**：state 增 `consentPending: boolean`、`pendingAction: (() => Promise<void>) | null`；`requireConsent(action)`——`settings.voice.consentBackendStt` 为 true → 直接执行 action；false → `consentPending=true; pendingAction=() => this[action]()` + 返回。`confirmConsent()`（Task 14 对话框同意回调）→ `await settingsStore.setVoice({ consentBackendStt: true })` + `consentPending=false` + `pendingAction?.()` + 置 null；`dismissConsent()` → 清 pending。
- [ ] **Step 5: 三模式 actions**（**D-P19：控制帧先于采集**；spec §5.9 逐字；各 start 首行 `if (!guardStart()) return`，随后 `requireConsent(() => startRecord())` 包裹——未同意则挂起待 UI 确认）：
  - `startRecord()`：`recordingId = 'rec_' + crypto.randomUUID()` → **`await api.voiceStartRecord({ recordingId })` → `capture = new PcmCapture(); await capture.start({ onChunk: (b) => api.voiceSendAudio(b), onStop: (ab) => record.audioBuffer = ab, deviceId: settings.micDeviceId })`**（**`capture.start` 包 try/catch——getUserMedia/AudioContext 拒绝 → `micError = parsePublicError(...)` + `mode` 回 idle + 取消后端会话，Important-3 修复**）→ mode='recording' + `record.elapsedMs` 计时（`setInterval`；≥600s 自动 stop + toast；≥300s toast 提示）。
  - `stopRecord()`：清计时 → `capture.stop()` → `api.voiceStopRecord({ recordingId })` → mode='record_pending' + 启 45s transcript 等待 timer（到时无 transcript/error → `caption=''` + `record.transcript=undefined`，仅丢弃/重录）。
  - `replayRecord()`：`record.audioBuffer` 存在 → `new AudioContext()` + `BufferSource` 播放（本地，不走 blob URL）。
  - `discardRecord()`：`api.voiceDiscard({ recordingId })` → 清态。
  - `commitRecord()`：`record.transcript?.trim()` 非空 → `useMessageStore().sendVoiceCommit(recordingId, record.transcript)` 成功后清态。
  - `startRealtime()`：guard 含 `settings.voice.realtimeEnabled` → `sessionId = 'vs_' + crypto.randomUUID()` → `await api.voiceStartRealtime({ sessionId, conversationId: current })` → `capture.start({ onChunk: (b) => { api.voiceSendAudio(b); realtime.unacked++; if (realtime.unacked - realtime.lastAckedSeq > MAX_UNACKED_FRAMES) capture?.pause() } })`（同 micError try/catch）→ mode='realtime'；**ack-stall 定时器（Important-10 修复）：startRealtime 内 arm `setTimeout(..., ACK_STALL_MS)` → 无 ack 时 `capture.resume()`（兜底）；每次收到 `voice_session.ack` 或 `ended` 时 clear 并重新 arm**。
  - `stopRealtime()`/`cancelRealtime()`：`capture.stop()` → `api.voiceStopRealtime/CancelRealtime({ sessionId })`（ended 事件清态）。
  - `startDictation()`：guard 含 `settings.voice.enabled` → `clientRequestId = 'req_' + crypto.randomUUID()` → `await api.voiceStartDictation({ clientRequestId, ...(settings.dictation.sttProfileId ? { sttProfileId } : {}) })` → `capture.start`（同 micError try/catch）→ mode='dictating'。
  - `stopDictation()`/`cancelDictation()`：`capture.stop()` → `api.voiceStopDictation/CancelDictation({ clientRequestId })`。
  - `clearDictationFinal()`：`dictation.finalText = undefined` + 清态（组件插入后调用）。
- [ ] **Step 6: TTS 播放控制**：`onTtsPlaybackEnded()`/`onTtsPlaybackError()`（Task 14 CyTtsPlayer 回调）→ 清 `tts` 态；`stopTtsPlayback()` → 有 streamId → `api.audioCancel({ streamId })` + 清态。
- [ ] **Step 7: `reset()`**（断线/会话切换）→ `capture?.stop()` + 清所有语音态 + 停 TTS——**触发经 Task 13 bootstrap `handleConnectionStateChange` 接线**。
- [ ] **Step 8: 写测试**（setDesktopApi fake + fake PcmCapture 注入）：record 全流程（start 先于采集断言——`api.voiceStartRecord` 在 `capture.start` 前；transcript→commit→sendVoiceCommit 调用；无 transcript → commit 门禁 false；discard）；realtime（started/partial/turn/ack 背压 pause/resume/**窗口边界——unacked-lastAcked 恰 200 仍运行、201 暂停、ack 恢复（Minor 21）**/**5s ack-stall 定时器触发 resume（fake timers）**/ended 清态；统一守卫）；dictation（sttProfileId 透传、final→`dictation.finalText` 置位 + `clearDictationFinal()` 清态、cancel）；**micError**（fake `capture.start` reject → micError 置位 + 模式回 idle + 后端会话取消）；TTS（autoReadReply on→ready 置 playing、off→忽略、started 打断、cancelled/onerror 清态）；`voice.error` → error 置位（PLAYBACK_NOT_FOUND 忽略）；consent 首次拦截 + confirm 重发 + dismiss；reset 清理。
- [ ] **Step 9: 运行** `pnpm -F @cyrene/desktop test` voice.store.spec 绿 + typecheck。
- [ ] **Step 10: Commit** `feat(阶段4批B): voiceStore 语音会话编排`

---

### Task 13: bootstrap 接线 + connectionStore 横幅抑制 + conversationStore 守卫 + reset 接线

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/connection.store.ts`、`apps/desktop/src/renderer/src/stores/conversation.store.ts`、`apps/desktop/src/renderer/src/bootstrap.ts`
- Test: `tests/unit/connection.store.spec.ts`、`tests/unit/conversation.store.spec.ts`、`tests/unit/renderer-bootstrap.spec.ts`

**Interfaces:**
- Consumes: Task 1 `VOICE_ERROR_CODES`、Task 9 desktopApi、Task 11 settingsStore、Task 12 voiceStore（reset/handleEvent）
- Produces: connectionStore 语音族横幅抑制、conversationStore 切换守卫、bootstrap voice/settings 接线 + 断线 reset——Task 14 UI 消费

- [ ] **Step 1: `connection.store.ts` 横幅抑制（D-P15）**：`setError(e)` 内若 `e.code` ∈ `VOICE_ERROR_CODES` → `return`（不置连接错误态）；其余照旧。
- [ ] **Step 2: `conversation.store.ts` 会话切换守卫（D-P5）**：`activate(id)` 与 `create()` 首行——`useVoiceStore().mode !== 'idle'` → 置 `blockReason = '请先结束当前语音会话'`（UI 提示）+ `return`（不切换）。
- [ ] **Step 3: `bootstrap.ts` 接线**：`BootstrapStores` 增 `voice: { init(): void; reset(): void }`、`settings: { hydrate(): void }`；`register()` 中 `stores.settings.hydrate()`（hydratePersistence 后并行，不阻塞）+ `stores.voice.init()`（内部 `api.onChatEvent((e) => stores.voice.handleEvent(e))`——**独立第二订阅，messageStore 订阅保留**）。**断线 reset（Important-2 修复）**：`applyChatState` 中 `stores.voice.reset()`——连接状态**离开 `connected`**（`s.status !== 'connected'` 且前一状态为 connected，或直接对非 connected 调 reset 幂等）→ 停采集 + 取消语音会话 + 清态 + 停 TTS（`renderer-bootstrap.spec.ts` 既有 mock-store 对象须补 `voice: { init, reset }`/`settings: { hydrate }` 方法，避免 typecheck 破）。
- [ ] **Step 4: 写测试**：connection store——语音族 code 不 setError、非语音族照旧；conversation store——`activate`/`create` 时 voiceStore.mode≠'idle' → blocked + blockReason 置位、idle → 放行；renderer-bootstrap——断开状态 push → voiceStore.reset 被调（spy）。
- [ ] **Step 5: 运行** `pnpm -F @cyrene/desktop test` 相关 spec 全绿 + typecheck。
- [ ] **Step 6: Commit** `feat(阶段4批B): bootstrap 接线 + 连接横幅抑制 + 会话守卫 + 断线 reset`

---

### Task 14: UI 组件（语音三入口 + 待发送条 + 实时条 + 转写浮层 + TTS 播放器 + 语音设置页 + consent）

**Files:**
- Create: `apps/desktop/src/renderer/src/components/CyVoicePending.vue`、`CyRealtimeBar.vue`、`CyDictationHint.vue`、`CyTtsPlayer.vue`、`CyVoicePane.vue`、`CyVoiceConsentDialog.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyChatInput.vue`、`apps/desktop/src/renderer/src/components/CySettingsView.vue`、`apps/desktop/src/renderer/src/components/CyChatView.vue`（宿主 CyTtsPlayer）、`apps/desktop/src/renderer/src/stores/model-service.store.ts`（删除回退 D-P20）
- Test: `tests/unit/cy-chat-input.spec.ts`、`tests/integration/electron-voice.spec.ts`（真实 Electron，Task 15）

**Interfaces:**
- Consumes: Task 12 voiceStore、Task 11 settingsStore/messageStore、Task 13 bootstrap、Task 9 desktopApi
- Produces: 语音 UI 交互（Task 15 集成断言对象）

- [ ] **Step 1: CyChatInput 增三入口**（按钮排布在 attach/sticker 与 textarea 之间，各 `aria-label`）：
  - `🎤 普通录音`（`@click` voiceStore.mode==='recording' ? `stopRecord()` : `startRecord()`；录音中高亮 + 显示 `record.elapsedMs` 格式化时长）。
  - `🔊 实时会话`（`@click` voiceStore.mode==='realtime' ? `stopRealtime()` : `startRealtime()`；入口禁用态 `!settings.voice.realtimeEnabled || !settings.voice.enabled`）。
  - `⌨️ 转写`（`@pointerdown` → `startDictation()`；`@pointerup` → `stopDictation()`；`@pointercancel` → `cancelDictation()`；按住时高亮）。上滑取消：pointermove 检测 `clientY < 起始 - 60` → 置 cancel 标记 → pointerup 走 cancel。
  - **转写 final 插入**：`watch(() => voiceStore.dictation.finalText, (t) => { if (t !== undefined) { const sel = textareaRef.value?.selectionStart !== undefined ? { start: selectionStart, end: selectionEnd } : undefined; settingsStore.applyDictationInsert(t, sel); voiceStore.clearDictationFinal() } })`。
  - 语音活跃时文本发送/附件按钮禁用（`mode!=='idle'`）。
  - **consent（D-P16）**：`watch(() => voiceStore.consentPending, (v) => { if (v) showConsentDialog = true })`；`CyVoiceConsentDialog`「音频将发送至后端识别（本机不保留）」+ `[取消]`（→ `voiceStore.dismissConsent()`）+ `[同意]`（→ `voiceStore.confirmConsent()`）。
- [ ] **Step 2: `CyVoicePending.vue`**（mode==='record_pending' 显示于 textarea 上方）：`转写字幕（或「未识别，请重试」）` + `[试听][重录][删除][确认发送]`；无 transcript → 确认发送禁用。
- [ ] **Step 3: `CyRealtimeBar.vue`**（mode==='realtime' 替换输入区）：聆听状态动画 + `realtime.caption` + 轮次数 + `[停止]`。
- [ ] **Step 4: `CyDictationHint.vue`**（mode==='dictating' 浮层）：`dictation.caption` + 「松开提交 · 上滑取消」提示。
- [ ] **Step 5: `CyTtsPlayer.vue`**（隐藏 `<audio ref>`，宿主 CyChatView，由 voiceStore 驱动）：`watch(() => voiceStore.tts.url, (u) => { if (u) { audio.src = u; audio.play() } })`；`@ended` → `voiceStore.onTtsPlaybackEnded()`；`@error` → `voiceStore.onTtsPlaybackError()`。
- [ ] **Step 6: `CyVoicePane.vue`**（CySettingsView 导航「语音」项已存在（P4-A 占位），只需 body 加 `v-if="activeNav==='voice'"` 挂载 CyVoicePane，M7 修复）：开关绑定 `settingsStore.voice.enabled/realtimeEnabled/autoReadReply/showCaptions`；麦克风设备下拉（`navigator.mediaDevices.enumerateDevices()` 过滤 `kind==='audioinput'`，绑 `micDeviceId`）；「测试麦克风」按钮（录 3s → `voiceStore.replayRecord()` + 时长 + `micError`）；转写 STT Profile 下拉（`modelServiceStore.profiles` 过滤 `type==='stt' && enabled && executionLocation==='backend'`，绑 `dictation.sttProfileId`，含「使用全局活动 STT」空项）；转写插入位置（`dictation.insertMode` 单选）。
- [ ] **Step 7: `model-service.store.ts` 删除回退（D-P20）**：`deleteProfile` 成功后若 `profile.type==='stt' && useSettingsStore().dictation.sttProfileId === \`${profile.provider}/${profile.model}\``（I4 修复：`deleteProfile` 参数是 `Pick<ModelProfile,'type'|'model'|'provider'>`，无 `id`；比较须拼 `<provider>/<model>`）→ `settingsStore.setDictation({ sttProfileId: undefined })` + toast「转写已回退全局 STT」。
- [ ] **Step 8: 写测试**（Minor 24：单测文件为 `tests/unit/cy-chat-input.spec.ts`（新）、`tests/unit/cy-voice-pane.spec.ts`（新）——Vitest 无组件测试先例，用 Vue Test Utils 或轻量挂载；断言目标具体化）：CyChatInput 语音按钮——`realtimeEnabled=false` 时 🔊 按钮 `disabled`、🎤 不 disabled（绑 `voiceStore`/`settingsStore` mock 态）；CyVoicePending——transcript 空时「确认发送」按钮 `disabled` + 显示「未识别，请重试」文本；CyVoicePane——STT 下拉选项集排除 desktop/local_worker profile、开关绑定 `settingsStore.voice.autoReadReply`、测试麦克风点击调 `voiceStore.startRecord`；deleteProfile 删除被转写引用的 STT Profile → `dictation.sttProfileId` 清空 + toast（D-P20，Minor 12）。真实 Electron 集成见 Task 15。
- [ ] **Step 9: 运行** `pnpm -F @cyrene/desktop test` 相关 + typecheck + lint。
- [ ] **Step 10: Commit** `feat(阶段4批B): 语音 UI 组件 + 设置语音子页 + consent`

---

### Task 15: 真实 Electron 集成测试

**Files:**
- Modify: `apps/desktop/tests/integration/electron-voice.spec.ts`（新）
- Test: Playwright `_electron` 真实布局/点击

**Interfaces:**
- Consumes: 前 14 task 全部；mock backend（`CYRENE_BACKEND=mock`）
- Produces: 验收证据

- [ ] **Step 1: 用例**（沿用既有真实 Electron 纪律：bounding box、无 force、`expect.poll`）：
  - 录音：点 🎤 → 录音态（按钮高亮/时长）→ 点停止 → `CyVoicePending` 出现字幕 → 点确认发送 → 用户消息出现。
  - 未识别：mock 注入 `voiceTranscriptText=''` 场景（或经 env）→ 停止后「未识别」+ 确认发送禁用 → 删除。
  - 转写：pointerdown 🎤转写 → 浮层出现 → pointerup → `dictation.final` 文本进入草稿（textarea value）。
  - 实时：点 🔊 → `CyRealtimeBar` 出现 → 停止 → 恢复输入区。
  - TTS：设置页开启自动朗读 + mock 激活 TTS Profile → 发送文本 → mock generation 完成后 `audio.session.ready` → `voiceStore.tts.playing` 置位（mock URL 404 → `onerror` → 播放态回落，`expect.poll` 断言回到 idle）。
  - 设置持久化：语音页改 `autoReadReply` → 重启 Electron → 值保留。
  - 语音设置子页布局与点击；会话切换守卫（录音中切会话被拦）。
  - **断线清理**（Important-2 验证）：录音/实时中 disconnect → 采集停止 + 语音态清 + TTS 停。
  - **consent（Important-14）**：默认 `consentBackendStt=false` → 首次点 🎤 弹确认对话框 → 同意继续录音 / 取消中止；勾选「不再提示」持久化 → 重启后不再弹。
  - **deleteProfile 回退**（Minor 12 验证）：删除被转写引用的 STT Profile → 转写下拉回「使用全局活动 STT」+ toast。
- [ ] **Step 2: 运行** `pnpm -F @cyrene/desktop test:integration`（Electron 用例）——全绿。
- [ ] **Step 3: Commit** `test(阶段4批B): 真实 Electron 语音集成用例`

---

### Task 16: 文档同步 + 决策记录

**Files:**
- Modify: `docs/01-...v0.2.md`（§6.1 BackendAdapter 接口片段同步新语音方法——Task 3 变更暴露，Ruling）、`docs/02-...v0.2.md`、`docs/03-...v0.2.md`、`docs/06-...v0.2.md`、`docs/07-...v0.2.md`、`docs/08-...v0.2.md`、`docs/10-...v0.2.md`、`docs/11-Cyrene-前端设置中心详细设计.md`、`docs/12-...v0.1.md`、`docs/13-...v0.1.md`、`docs/16-Cyrene-前端实施任务清单与进度跟踪.md`、`README.md`、`CLAUDE.md`
- Create: `docs/review/2026-08-16-阶段4批次B-决策记录.md`
- Test: 无（文档）；跑 `pnpm -F @cyrene/desktop check:contract` 确认绿

**Interfaces:**
- Consumes: 前 15 task 全量（spec §9 文档同步清单）
- Produces: 批次验收文档基础

- [ ] **Step 1: doc 02**：§13.1 内容重写（固定 `pcm_s16le/16000/1` 描述符 + TTS base64 JSON 帧 + 删「不能 Base64 塞入普通事件 JSON」矛盾表述）；§12 三种语音 + §13.2/§13.3 状态改「已实现」；§13.4 TTS 播放 `audio_end{stream_id, format?}` 补齐；§19 对齐表语音行确认。
- [ ] **Step 2: doc 03/06/07/08/10/11/12/13**（spec §9 逐项）：UI 语音入口、Store 划分 + voiceStore/settingsStore、权限处理器 + 单向 IPC 守卫、验收用例、任务拆分进度、设置中心语音页落地、E-06/E-07 完成证据、交叉 review 记录。
- [ ] **Step 3: doc 16**：阶段 4 批 B 进度 + 测试数字；**README/CLAUDE.md**：阶段 4 状态同步（P4-B 落地 + 测试计数）。
- [ ] **Step 4: 决策记录** `2026-08-16-阶段4批次B-决策记录.md`：D-P1~D-P20 全表 + 语音族错误路由/consent/字幕终态/单向守卫等 rationale + park 项（P4-A §5/§6 复验项 DataCloneError/baseUrl/pre-save test）。
- [ ] **Step 5: 全量验证**：`pnpm -F @cyrene/desktop test`（全部单测）+ `test:integration` + `typecheck` + `lint` + `build` + `check:contract`——全绿。
- [ ] **Step 6: Commit** `docs(阶段4 批次B): 文档同步 + 决策记录 + 全量验证`

---

## 任务顺序依赖

`1(契约/schema) → 2(raw/映射) → 3(接口) → 4(real 控制帧) → 5(real TTS) → 6(MediaService) → 7(mock) → 8(Settings) → 9(IPC/Preload/权限/装配) → 10(采集) → 11(settingsStore/messageStore) → 12(voiceStore) → 13(bootstrap/横幅/守卫/reset) → 14(UI) → 15(集成) → 16(文档)`

- Task 4/5/6 可并行（real 控制帧 / real TTS / MediaService 互不依赖，但 5 依赖 2 的 stampEvent、6 独立）；Task 8 可与 4-7 并行。
- **Task 12（voiceStore）静态 import Task 11（settingsStore/messageStore）——必须先序**（Critical-1 修复：本代码库 store 间是静态模块级 import，`useXStore()` 只延迟调用、不延迟 import）；Task 13（bootstrap）依赖 11/12。
- Task 15 依赖全部功能；Task 16 收尾。
