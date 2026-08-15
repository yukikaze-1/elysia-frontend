# Cyrene 阶段4 批次B（P4-B）设计：语音输入 + TTS 自动朗读 + 设置持久化

- **日期：** 2026-08-16（Asia/Shanghai）
- **状态：** 设计定稿（待评审）
- **上一批：** [2026-08-15-phase4a-model-services-settings-design.md](./2026-08-15-phase4a-model-services-settings-design.md)（P4-A，Mock 驱动全量验证）
- **前端基线：** `main@c6194fe`；后端对照 `elysia-agent main@556117a`（protocol `2.0`）
- **相关文档：** docs 02（通信协议 §12 三种语音与 TTS 播放 / §13.1 音频传输 / §19 对齐表）、docs 06（Store 划分）、docs 11（设置中心 §2.3 麦克风 / §2.6 转写 STT / §3 语音输入）、docs 12（§9.5 阶段 4）、docs 13（统一口径）、docs 16（§7 阶段 4）
- **决策输入：** 用户敲定 D1（阶段 4 分两块，P4-B = 语音）/ D3（TTS 自动朗读归 P4-B，设置可关）/ D4（backend 为主）；P4-A 决策记录 §5/§6 的 park 项（DataCloneError 修复、baseUrl、pre-save test）已随 P4-A final review 修复，P4-B 真实联调需复验。

## 1. 背景与目标

P4-A 已闭环模型服务 Profile 管理与 TTS 试听。P4-B 落地语音链路：**普通录音输入、实时语音会话、输入法转写、TTS 自动朗读（D3）**，并补齐 **settingsStore / 设置持久化基础设施**（D-A10 原委派项）与设置中心「语音」子页（doc 11 §2.3/§2.6/§3）。

**本批目标：** 在真实 Windows Electron（REAL 模式）上，普通录音「点击录音→停止→字幕→确认发送」闭环；实时语音会话「启动→连续音频→后端 VAD 自动轮次→停止」闭环（含背压）；输入法转写「按住说话→松开→final 写草稿」闭环（独立 STT Profile 选择）；AI 回复 TTS 自动朗读（设置可关）；语音设置持久化（重开保留）。全部 Mock 驱动标「已开发、未联调」，真实联调为验收方。

## 2. 范围（做 vs 不做）

### 做

1. **领域契约扩展**（[shared/contracts/voice.ts](apps/desktop/src/shared/contracts/voice.ts) 新 + [shared/contracts/events.ts](apps/desktop/src/shared/contracts/events.ts) + [shared/contracts/ipc.ts](apps/desktop/src/shared/contracts/ipc.ts) + **shared/schemas/events.ts + ipc-response.ts zod 镜像同步**）：三种语音命令（record/realtime/dictation start·stop·commit·discard·pause·resume·cancel）、`AudioChunkInput`（二进制上行）、`AudioCancelInput`、`SettingsState`/`SettingsPatch`（voice + dictation）；BackendEvent 新成员（`voice.transcript` / `voice_session.started|partial|turn|ack|ended` / `dictation.partial|final|cancelled` / `audio.session.started|ready|cancelled` / `voice.error`）。**schema 镜像必须同步**（preload `parseBackendEvent` 走 `BackendEventSchema` 判别联合，未镜像的新事件在 preload 边界被当非法载荷丢弃——整个语音功能静默失效；每个 `BackendEventEnvelope` 均需 `eventId`+`sequence`，schema 层为必填）。
2. **BackendAdapter 真实实现**（[real-backend.ts](apps/desktop/src/main/transport/real-backend.ts)）：替换旧 `startVoiceInput/stopVoiceInput/startDictation/stopDictation` `notImplemented` 桩为真实 WS 三模式命令；新增 `commitVoice`（await ack）、`discardVoice`、`sendAudioBytes`（BINARY 上行）、`audioCancel`；`WebSocketLike.send` 扩展 `string | Uint8Array`；**TTS 播放处理**——`audio_start`/`audio`/`audio_end`/`audio_cancelled` 帧经 Main 缓冲 + 注入的 `getTtsMedia` sink 写 MediaService，emit `audio.session.*` 领域事件。
3. **Mock 扩展**（[mock-backend.ts](apps/desktop/src/main/transport/mock-backend.ts)）：三模式语音模拟（start/stop/commit/discard/cancel + emit `voice.transcript`/`voice_session.*`/`dictation.*`）；`sendAudioBytes` 记录；TTS 模拟（TTS 激活时 generation 完成后 emit `audio.session.*`，URL 占位）。
4. **IPC + Preload + schema**：新增 `voice:*` / `audio:cancel` / `settings:load` / `settings:save` 通道；`voice:audio-chunk` 走单向 `ipcMain.on`（fire-and-forget，不 invoke），**经 registry 新增 `registerOneWayHandler`（复用 `isTrustedSender` 可信发送者守卫 + zod 校验 chunk 载荷，`bytes.length ≤ MAX_CHUNK_BYTES`=1MiB）**——现有仓库零裸 `ipcMain.on`，所有通道经 `registerHandler` 包可信发送者守卫，单向通道不得绕过（D-P18）；Preload `desktopApi` 对应方法 + zod 校验。
5. **Main 设置持久化**（[Main/settings/settings-service.ts](apps/desktop/src/main/settings/) 新）：**落 `dirs.config` 受管目录 + 注入 `safeRoot` + 复用 `atomicWriteFile`（tmp+rename）**（既有持久化纪律：SessionStore→appCache、凭据→dirs.config），`userData/settings.json` 原子写 + zod 校验 + 版本化 + 损坏隔离；`settings:load/save` handler。
6. **MediaService `tts-live` 媒体路由**（[attachments/media-service.ts](apps/desktop/src/main/attachments/media-service.ts)）：`MediaRouteType` 增 `'tts-live'`；`parseMediaPath`/`stream()` 对应分支；`putTtsAudio(id, bytes, mime, {ttlMs})` 缓存（TTL 5min，惰性清理参照 `putTtsPreview`）。
7. **Main 麦克风权限**（app 装配处）：`setPermissionCheckHandler` + `setPermissionRequestHandler` 仅放行 `media`（audio，deny camera/video）且仅受信 renderer origin（prod `cyrene://renderer` / dev `http://localhost:*`）。
8. **Renderer 音频采集**（[renderer/src/voice/voice-capture.ts](apps/desktop/src/renderer/src/voice/) 新）：`getUserMedia`（16k mono，EC/NS/AGC）→ AudioContext(16000) → AudioWorklet 处理器（Float32→Int16）→ chunk 聚合（20ms=640B）→ 回调；ScriptProcessorNode 降级；PCM 转换抽纯函数。
9. **`voiceStore`**（[renderer/src/stores/voice.store.ts](apps/desktop/src/renderer/src/stores/) 新）：三模式会话编排、字幕状态、背压窗口、TTS 播放状态（D3 播放门）、麦克风错误；独立订阅 `onChatEvent`；**消费 `voice.error` 语音族错误**。
10. **`settingsStore`**（[renderer/src/stores/settings.store.ts](apps/desktop/src/renderer/src/stores/) 新）：voice/dictation 本地设置；启动 hydrate + 变更持久化（500ms 防抖）。
11. **`connectionStore` 语音族错误横幅抑制**：`setError` 对语音族错误码（`VOICE_ERROR_CODES` 常量）不展示全局连接错误横幅（语音错误经 `voice.error` 在语音 UI 展示，D-P15）。
12. **`messageStore` 扩展**：`applyEvent` 增 `voice_session.turn` 分支（后端预分配 messageId 的 user 消息装配）+ `sendVoiceCommit(recordingId, text)`（乐观消息 + api.voiceCommit + migrate，复用 send 路径）。
13. **UI**：CyChatInput 增语音三入口（普通录音按钮 / 实时会话按钮 / 输入法转写按住键）+ 待发送语音输入条（字幕/试听/重录/删除/发送）+ 实时会话状态条 + 转写字幕浮层 + **后端 STT 首次操作一次性同意**；CySettingsView 增「语音」子页（[CyVoicePane.vue](apps/desktop/src/renderer/src/components/) 新：启用开关 / 自动朗读 / 显示字幕 / 麦克风设备 / 测试麦克风 / 转写 STT Profile 选择 / 转写插入位置）。
14. **文档同步**：doc 02 §13.1 内容重写 + §12 语音状态 + §19 对齐表 + doc 03/06/07/08/10/11/12/13/16 + README/CLAUDE + 本批决策记录。

### 不做

- **不做 TTS 流式播放器**（边收边播）：后端默认非流式合成（`sampleRate/durationMs` 合成完成后才有），P4-B 用整段缓冲播放匹配；流式播放器列为后续增强。
- **不做音频落盘 / 语音消息附件**（批次 7 BE-070 才做）：`音频不落盘、不入消息`；试听仅 Renderer 内存 AudioBuffer。**「是否保留录音」设置项不在本批**（音频不落盘，该设置随保存/附件功能后续引入；本批不设死字段）。
- **不做实时会话 wire `pause`/`resume` 上行**：`voice_session.pause/resume` 帧契约确认存在，但 P4-B 实时 UI 只暴露 stop/cancel，背压由本地 `PcmCapture.pause()` 控制（D-P3）；wire pause/resume 预留，不在本批消费。
- **不做前端 VAD**：实时会话 VAD 由后端执行（`voice_session.partial/turn` 已按段返回）；前端只负责送 PCM 与展示。
- **不做唤醒词 / `wake_toggle`**：归阶段 5/后续。
- **不做 Live2D 嘴部联动**：归阶段 5。
- **不做 `set_service` 前端开关 UI**：TTS/STT 服务启停仍由模型服务页（P4-A）管理；`autoReadReply` 仅本地播放门（D-P1），不联动 `set_service('tts')`。
- **不做转写「插入到光标位置」**（doc 11 §2.6 语言/插入位置设置的子集）：P4-B 做「追加草稿末尾 / 替换选区」（`dictationInsertMode` 两值），光标级插入列为后续。

## 3. 契约基础（后端 `556117a` wire，P4-B 消费面）

### 3.1 三种语音模式（WS v2，doc 02 §12 / protocol-v2 §12）

音频输入固定格式：`{codec: 'pcm_s16le', sampleRate: 16000, channels: 1}`（唯一支持；不符 → `error{CONTRACT_VALIDATION}`，不建会话）。start 帧可带 `audio` descriptor（缺省按默认）。BINARY PCM 帧 `MAX_CHUNK_BYTES` = 1 MiB；**网络 chunk 无需 640B 对齐**（后端跨 chunk 重组 640B/20ms VAD 帧）。

- **普通录音（BE-060）**：`voice.record.start{recordingId(rec_)}` → BINARY PCM ×N（全段缓冲，不 VAD）→ `voice.record.stop{recordingId}` → `voice.transcript{recordingId, text, emotion?}`（PENDING 字幕）→ `voice.commit{recordingId, text, clientRequestId, clientMessageId?, conversationId?}`（幂等，text=确认文本）→ `user_message.ack` + generation.*；`voice.discard{recordingId}` 丢弃。空转写不发 `voice.transcript`；`< 640B` 视为空转写；录音 >600s → `error{VOICE_RECORDING_TOO_LONG}`；stop 时 STT 已关 → `error{STT_UNAVAILABLE}`。
- **实时语音（BE-061）**：`voice_session.start{sessionId(vs_), conversationId?}` → `voice_session.started{sessionId, conversationId?}` → BINARY PCM ×N（后端 VAD 分段）→ `voice_session.partial{sessionId, turnId, segmentIndex, text}`（字幕）→ `voice_session.turn{sessionId, turnId, messageId, conversationId?, text}`（自动提交触发 generation；多轮只响应最后一轮为预期）→ pause/resume/stop/cancel → `voice_session.ended{sessionId, reason(stopped|cancelled|timeout|stt_disabled)}`；`voice_session.ack{sessionId, seq}`（~1s 背压，seq=服务端已收 BINARY 帧序数）；300s 无音频 → `ended{timeout}`。
- **输入法转写（BE-062）**：`dictation.start{clientRequestId, sttProfileId?}` → BINARY PCM ×N（VAD 分段）→ `dictation.partial{text}`（累积字幕）→ `dictation.stop{clientRequestId}` → `dictation.final{clientRequestId, text}`（**只回文字、零消息副作用**）→ 前端写草稿；`dictation.cancel` → `dictation.cancelled`。`sttProfileId` = `<provider>/<model>`，缺省用全局活动 STT，会话内快照不改全局（D-8 已确认）；profile 不存在 / runtime=desktop/local → `error{STT_PROFILE_NOT_FOUND}`。
- 错误信封：`voice.commit` 违规 → `user_message.ack{rejected}`；**`voice.record.start/stop/discard`** 与 `voice_session.*`/`dictation.*`/`audio.cancel` 违规 → `error{code}`（`voice.discard` 是独立消息类型，含于错误信封）。已有活动会话再 start → `VOICE_SESSION_CONFLICT`；`agent.stt` 未启用 → `STT_UNAVAILABLE`；未知 sessionId/recordingId → `VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_NOT_FOUND`。

### 3.2 TTS 播放控制（BE-063）

```
server → audio_start{stream_id, format('wav'|'mp3'), sampleRate?, durationMs?}（句开始，Phase 2 放行后、首 chunk 前）
server → audio{stream_id, seq, data(base64), is_final}（×N，chunk 转发；**is_final 恒 false，终止由 audio_end 判定，不得依赖**）
server → audio_end{stream_id, format?}（字节已全部下发 ≠ 播完；format 契约可缺省、缺省 wav；完成由前端本地 onended 判定）
client → audio.cancel{stream_id}（全局播放操作；未知/已结束 → error{PLAYBACK_NOT_FOUND} 良性可忽略）
server → audio_cancelled{stream_id}（audio.cancel / TTS 中断时发，前端清理孤儿 chunk）
```

`stream_id` = playback ID（全链路统一）。TTS 默认只朗读 Public Reply，不把 Inner Voice 发给 TTS Provider（后端行为，前端不干预）。

### 3.3 设置持久化（本地，非后端契约）

P4-B 本地设置（voice/dictation）是**前端自有持久化**（backend 无对应端点），存 Main `dirs.config/settings.json`（受管目录，D-P6）。结构见 §5.1。

## 4. 现状（前端代码证据）

- [real-backend.ts](apps/desktop/src/main/transport/real-backend.ts)：`startVoiceInput/stopVoiceInput/startDictation/stopDictation` 仍为 `notImplemented` 桩（:895-898）；`WebSocketLike.send` 仅 `string`（:52）；WS `on('message')` 仅处理文本帧 JSON（:404-407），无二进制分支；TTS `audio_*` 帧未被 handleFrame 消费。
- [mock-backend.ts](apps/desktop/src/main/transport/mock-backend.ts)：同名桩返回 `{sessionId:'mock-voice-1'}` 占位；无语音事件模拟；`emit(event)` 经 handler 回调（:482）。
- [backend.ts](apps/desktop/src/shared/contracts/backend.ts:131-153)：旧 `VoiceInputSession{sessionId}` / `StartVoiceInputInput{conversationId}` / `DictationSession` 契约——与 v2 三模式（recordingId/voice_session sessionId/dictation clientRequestId）不匹配，P4-B 重写。
- 无 settingsStore、无音频工具（无 AudioContext/Worklet）、无麦克风权限处理器（[permissions/README.md](apps/desktop/src/main/permissions/) 为空占位）。
- [bootstrap.ts](apps/desktop/src/renderer/src/bootstrap.ts)：`api.onChatEvent((e) => stores.message.applyEvent(e))` 单一事件订阅——P4-B 增 voiceStore 并行订阅。
- [index.ts](apps/desktop/src/main/index.ts:140-206)：adapter → connConfig → uploadSvc → mediaSvc → registerHandlers 装配序；`chatBridge` 晚绑定模式（:135-139）可复用注入 `getTtsMedia`。
- 协议注册 [scheme.ts](apps/desktop/src/main/protocol/scheme.ts)：`standard+secure`（getUserMedia 可用）；CSP [csp.ts](apps/desktop/src/main/protocol/csp.ts) 现为 `media-src 'self'`（`cyrene://renderer` 同源即 `'self'`，已覆盖 TTS `<audio>`；AudioWorklet 模块同源 `script-src 'self'` 放行）。

## 5. 设计

### 5.0 决策表（本批 Rulings，D-P1~D-P20）

| 编号 | 决策 | 理由 |
|---|---|---|
| D-P1 | TTS 自动朗读开关 `autoReadReply` = **本地播放门**（关 → 丢弃 `audio.session.ready` 不播放）；不联动 `set_service('tts')` | 本地偏好与后端服务状态解耦；P4-A 已管 TTS 激活；后端契约无「静音」上行 |
| D-P2 | 试听 = AudioContext 本地回放采集的 AudioBuffer（不走 blob URL，免改 CSP `media-src`）；音频不落盘 | CSP 无 blob:；音频只在录音会话内存态 |
| D-P3 | 实时会话完整实现（AudioWorklet 连续采集 + `voice_session.ack` 背压窗口）；**wire `pause`/`resume` 预留不用**（背压用本地 `PcmCapture.pause()`） | D1 承诺完整三种语音；背压语义本地可控 |
| D-P4 | 转写插入位置 `dictationInsertMode` ∈ `append`（追加末尾）/ `replace_selection`（有选区替换）；不做光标级 | doc 11 §2.6 子集；光标级后续 |
| D-P5 | 会话切换守卫：语音会话活跃（`mode≠idle`）→ 禁止切换/新建会话（提示先结束） | doc 11 §3.2「切换会话前提示处理当前语音会话」 |
| D-P6 | 设置存储：Main `dirs.config/settings.json` + 注入 `safeRoot` + 复用 `atomicWriteFile`（tmp+rename）+ zod + 版本化 + 损坏隔离 | 既有持久化纪律（SessionStore→appCache、凭据→dirs.config）；Main 是持久化边界 |
| D-P7 | 麦克风权限：`setPermissionCheck/RequestHandler` 仅放行 `media`（audio，deny camera/video），仅受信 renderer origin | 语音输入必需；安全收紧默认拒绝 |
| D-P8 | TTS 播放 = 整段缓冲（`audio_start`→`audio_end` 收齐后播），`<audio>` cyrene:// URL，`onended` 判定完成，**`onerror` 清态**（mock 404 也走 onerror） | 后端默认非流式合成；onerror 防播放态卡死 |
| D-P9 | TTS 二进制不落 Renderer：Main 解码 base64 → MediaService `tts-live` → URL | 与 P4-A `tts-preview` 边界一致；二进制不跨 IPC |
| D-P10 | 事件分发：voiceStore 独立订阅 `onChatEvent`；messageStore 处理 `voice_session.turn`（消息归属）+ `sendVoiceCommit` | 消息所有权集中 messageStore；语音会话状态集中 voiceStore |
| D-P11 | 单活动语音会话互斥（record/realtime/dictation 三选一）；adapter 维护 active 槽，二进制仅活动会话放行 | 与后端单活动会话（`VOICE_SESSION_CONFLICT`）一致；防 legacy 路径 |
| D-P12 | 实时背压窗口 `MAX_UNACKED_FRAMES=200`（≈4s @ 50帧/s，含 1s ack 周期余量）；超限暂停采集、ack 恢复；**5s 无 ack 兜底恢复** | 防无 ack 时永久暂停 |
| D-P13 | mock TTS 占位 URL（`tts-live/mock-silent`，<audio> 404）；真实发声仅随 real 联调 | mock 无 MediaService；集成测试断言状态而非声音 |
| D-P14 | `dictationSttProfileId` = **本地设置**（settingsStore.dictation.sttProfileId），非 `ActiveModelSelection` 数据源；缺省 → `dictation.start` 不带 → 后端全局活动 STT | 转写独立选择是本地偏好；`server_info.services` 无 dictation 键 |
| D-P15 | 语音族错误路由：real-backend 对语音族错误码 emit `voice.error` BackendEvent（**同时**走既有 onError 日志/审计）；connectionStore 对 `VOICE_ERROR_CODES` 不展示连接横幅 | 语音错误是会话级可预期错误，不是连接级；日志/审计不丢 |
| D-P16 | 后端 STT 首次操作一次性同意：`voice.consentBackendStt`（默认 false）→ 首个 backend-STT 语音操作（record/realtime/dictation）前弹「音频将发送至后端识别（本机不保留）」确认，接受后持久化不再提示 | doc 02 §13.3「若执行位置为后端，开始前必须明确提示音频将离开设备」 |
| D-P17 | 录音字幕终态：等 `voice.transcript` 或 `voice.error`（后端 STT 超时/失败恒发 `error{STT_UNAVAILABLE}`）；45s 兜底判「未识别」（仅丢弃/重录，不 commit） | 后端 STT 窗口 30s（`STT_TIMEOUT`）；固定 10s 会误判慢转写 |
| D-P18 | 单向 IPC `voice:audio-chunk` 经 registry 新增 `registerOneWayHandler`（复用 `isTrustedSender` + zod 校验载荷 `bytes.length ≤ 1MiB`） | 仓库零裸 `ipcMain.on`；单向通道不得绕过可信发送者纵深 |
| D-P19 | 语音 start 控制帧**先于**采集启动（record/realtime/dictation 均先 `api.voiceStart*` await 成功再 `PcmCapture.start`） | 防采集 chunk 早于后端会话建立被 `sendAudioBytes` 丢弃（后端无会话丢弃 BINARY） |
| D-P20 | 转写 STT 下拉过滤 `type==='stt' && enabled && executionLocation==='backend'`；删除被转写引用的 STT Profile → 自动清空 `dictation.sttProfileId`（回退全局 STT）+ toast | doc 11 §2.6「删除前先选替代或关闭」；desktop/local profile 会 `STT_PROFILE_NOT_FOUND`；回退即替代 |

## 5.1 领域契约（[shared/contracts/voice.ts](apps/desktop/src/shared/contracts/voice.ts) 新）

```ts
/** 音频输入描述（wire 唯一支持 pcm_s16le/16000/1；缺省按默认处理）。本批 start 帧不带此字段（采集即默认格式），仅供契约文档 */
export interface AudioInputDescriptor { codec: 'pcm_s16le'; sampleRate: 16000; channels: 1 }

export type VoiceInputMode = 'record' | 'realtime' | 'dictation'

// —— 普通录音 ——
export interface VoiceRecordStartInput { recordingId: string }          // wire voice.record.start 仅 {recordingId, audio?}（无 conversationId；会话归属在 commit）
export interface VoiceRecordStopInput { recordingId: string }
export interface VoiceCommitInput {
  recordingId: string; text: string; conversationId: string
  clientRequestId: string; clientMessageId: string
}
export interface VoiceDiscardInput { recordingId: string }

// —— 实时语音会话 ——
export interface RealtimeVoiceStartInput { sessionId: string; conversationId?: string }
export interface RealtimeVoiceControlInput { sessionId: string }

// —— 输入法转写 ——
export interface DictationStartInput { clientRequestId: string; sttProfileId?: string }
export interface DictationStopInput { clientRequestId: string }

// —— 二进制上行（单向 send，非 invoke） ——
export interface AudioChunkInput { bytes: Uint8Array }

// —— TTS 播放控制 ——
export interface AudioCancelInput { streamId: number }

// —— 本地设置 ——
export interface VoiceSettings {
  enabled: boolean           // 语音输入总开关：普通录音 + 输入法转写入口（doc 11 §3.3 启用语音输入）
  realtimeEnabled: boolean   // 实时语音会话子开关（独立于 enabled，独立启停）
  autoReadReply: boolean     // TTS 自动朗读 AI 回复（D3；本地播放门 D-P1）
  showCaptions: boolean      // 显示直接语音字幕
  consentBackendStt: boolean // 后端 STT 首次操作一次性同意已接受（D-P16；默认 false → 首个 backend-STT 操作前弹确认）
  micDeviceId?: string       // 麦克风设备（缺省默认设备）
}
export interface DictationSettings {
  sttProfileId?: string      // 独立 STT Profile（<provider>/<model>；缺省 → dictation.start 不带 → 全局活动 STT，D-P14）
  insertMode: 'append' | 'replace_selection'  // final 插入位置（D-P4）
}
export interface SettingsState {
  version: 1
  voice: VoiceSettings
  dictation: DictationSettings
}
export type SettingsPatch = Partial<{ voice: Partial<VoiceSettings>; dictation: Partial<DictationSettings> }>
```

### 5.2 BackendEvent 新成员（[events.ts](apps/desktop/src/shared/contracts/events.ts)）

```ts
export interface VoiceTranscriptEvent extends BackendEventEnvelope { event: 'voice.transcript'; recordingId: string; text: string; emotion?: string }
export interface VoiceSessionStartedEvent extends BackendEventEnvelope { event: 'voice_session.started'; sessionId: string; conversationId?: string }
export interface VoiceSessionPartialEvent extends BackendEventEnvelope { event: 'voice_session.partial'; sessionId: string; turnId: number; segmentIndex: number; text: string }
export interface VoiceSessionTurnEvent extends BackendEventEnvelope { event: 'voice_session.turn'; sessionId: string; turnId: number; messageId: string; conversationId?: string; text: string }
export interface VoiceSessionAckEvent extends BackendEventEnvelope { event: 'voice_session.ack'; sessionId: string; seq: number }
export interface VoiceSessionEndedEvent extends BackendEventEnvelope { event: 'voice_session.ended'; sessionId: string; reason: 'stopped' | 'cancelled' | 'timeout' | 'stt_disabled' }
export interface DictationPartialEvent extends BackendEventEnvelope { event: 'dictation.partial'; text: string }
export interface DictationFinalEvent extends BackendEventEnvelope { event: 'dictation.final'; clientRequestId: string; text: string }
export interface DictationCancelledEvent extends BackendEventEnvelope { event: 'dictation.cancelled'; clientRequestId: string }
export interface AudioSessionStartedEvent extends BackendEventEnvelope { event: 'audio.session.started'; streamId: number; format?: 'wav' | 'mp3' }
export interface AudioSessionReadyEvent extends BackendEventEnvelope { event: 'audio.session.ready'; streamId: number; url: string; durationMs?: number; format?: 'wav' | 'mp3' }
export interface AudioSessionCancelledEvent extends BackendEventEnvelope { event: 'audio.session.cancelled'; streamId: number }
export interface VoiceErrorEvent extends BackendEventEnvelope { event: 'voice.error'; code: string; message?: string }
```

`audio`/`audio_end` 原始帧**不进 BackendEvent**（Main 内解码缓冲，D-P9）；`voice_session.ack` 进事件流（voiceStore 背压消费）；**`voice.error` 承载语音族错误**（D-P15：real-backend 对语音族错误码额外 emit，connectionStore 横幅抑制）。事件统一经既有 `chat:event` push 通道送达 Renderer，无需新 PushChannels。

**schema 镜像（F-2 修复）**：`shared/schemas/events.ts` 的 `BackendEventSchema` 判别联合必须同步新增上述 **13 个事件**（各含 `eventId`+`sequence` 必填）；否则 preload `parseBackendEvent` 丢弃 → 语音功能静默失效。

### 5.3 IPC 通道与 Preload

```ts
// ipc.ts 新增
voiceStartRecord: 'voice:start-record',
voiceStopRecord: 'voice:stop-record',
voiceCommit: 'voice:commit',
voiceDiscard: 'voice:discard',
voiceStartRealtime: 'voice:start-realtime',
voiceStopRealtime: 'voice:stop-realtime',
voiceCancelRealtime: 'voice:cancel-realtime',
voiceStartDictation: 'voice:start-dictation',
voiceStopDictation: 'voice:stop-dictation',
voiceCancelDictation: 'voice:cancel-dictation',
voiceAudioChunk: 'voice:audio-chunk',      // 单向 send（ipcMain.on，不 invoke）
audioCancel: 'audio:cancel',
settingsLoad: 'settings:load',
settingsSave: 'settings:save',
```

Preload `desktopApi` 对应方法：voice 控制帧走 `ipcRenderer.invoke`（返回 `IpcResult`）；`voiceSendAudio(bytes)` 走 `ipcRenderer.send(IpcChannels.voiceAudioChunk, { bytes })`（一次性 `Uint8Array` 拷贝，防 DataCloneError——P4-A 教训）；`settingsLoad/settingsSave` 走 invoke。入参/出参 zod 校验（既有 `createIpcHandler` 双层校验模式）。`voiceCommit` 返回 `ClientRequestRef`（await ack）。

**单向通道守卫（D-P18）**：registry 新增 `registerOneWayHandler(channel, schema, handler, arity?)`——`ipcMain.on` 回调内复用 `isTrustedSender`（`senderFrame===mainFrame` + 受信 URL 校验，FE-S1-P2-01），zod 校验 `voice:audio-chunk` 载荷（`{ bytes: Uint8Array }`，`bytes.byteLength ≤ 1MiB` = 后端 `MAX_CHUNK_BYTES`，超限丢弃 + warn），然后转发 `adapter.sendAudioBytes(bytes)`；fire-and-forget 无响应。**仓库零裸 `ipcMain.on`，单向通道不得绕过可信发送者纵深**（ipc-security.spec 白名单同步）。

### 5.4 BackendAdapter 接口变更（[backend-adapter.ts](apps/desktop/src/main/transport/backend-adapter.ts)）

替换旧四桩为：

```ts
startRecordVoice(input: VoiceRecordStartInput): Promise<{ recordingId: string }>
stopRecordVoice(input: VoiceRecordStopInput): Promise<void>
commitVoice(input: VoiceCommitInput): Promise<ClientRequestRef>   // send voice.commit，await user_message.ack（幂等，按 clientRequestId）
discardVoice(input: VoiceDiscardInput): Promise<void>
startRealtimeVoice(input: RealtimeVoiceStartInput): Promise<{ sessionId: string }>
stopRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void>
cancelRealtimeVoice(input: RealtimeVoiceControlInput): Promise<void>
startDictation(input: DictationStartInput): Promise<{ clientRequestId: string }>
stopDictation(input: DictationStopInput): Promise<void>
cancelDictation(input: DictationStopInput): Promise<void>
sendAudioBytes(bytes: Uint8Array): void         // 同步 fire-and-forget（唯一同步方法，deliberate：无 await 语义）；guard `status==='connected' && this.ws && activeVoice`，否则丢弃 + warn（防 legacy 路径 / 断连后 throw）
audioCancel(input: AudioCancelInput): Promise<void>
```

`getActiveModelSelection()` 返回的 `ActiveModelSelection` 保留 `dictationSttProfileId` 字段，但 **P4-B 不作为激活选择数据源**——dictation STT 独立选择是**本地设置**（D-P14，见 §5.9/§5.12）。

### 5.5 Real-backend 实现

- **`WebSocketLike.send(data: string | Uint8Array)`**；ws 连接建立时 `ws.binaryType` 无需设（仅上行）。
- **单活动语音会话注册表**：`activeVoice: { kind: VoiceInputMode; key: string } | undefined`。`start*` 若已有活动会话 → 抛 `VOICE_SESSION_CONFLICT`（与后端一致）；`stop/cancel/discard/ended` 清除。`sendAudioBytes` guard `status==='connected' && this.ws && activeVoice` 才 `ws.send(bytes)`，否则丢弃 + `this.warn('VOICE_BINARY_NO_SESSION'|'VOICE_BINARY_NOT_CONNECTED', ...)`。
- **控制帧**：各 start/stop/commit/discard/cancel 构造 v2 wire JSON 发送（wire `voice_session.pause/resume` 预留不用，D-P3）。`voice.record.start` 仅带 `{recordingId}`（无 conversationId，D-P19/契约）；会话归属只在 `voice.commit.conversationId`。`commitVoice` 复用既有 `pendingAck` 机制（clientRequestId 关联，`ackTimeoutMs`）；`clientMessageId` 透传。
- **语音族错误路由（D-P15）**：`handleErrorFrame` 检查 `code` ∈ `VOICE_ERROR_CODES`（共享常量：`STT_UNAVAILABLE`/`STT_PROFILE_NOT_FOUND`/`VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`/`VOICE_RECORDING_NOT_FOUND`/`DICTATION_NOT_FOUND`/`PLAYBACK_NOT_FOUND`）→ **额外** emit `VoiceErrorEvent{code, message}`（经 mapper `stampEvent` 打 envelope）；既有 `onError` 路径**保留**（日志/审计不丢）。非语音族错误行为不变。`PLAYBACK_NOT_FOUND` 前端忽略（良性）。
- **TTS 播放（D-P8/D-P9）**：
  - options 增 `getTtsMedia?: () => TtsMediaSink | undefined`（晚绑定，index.ts 用 `mediaBridge` 容器注入，复用 chatBridge 模式）；`TtsMediaSink = { putTtsAudio(id: string, bytes: Uint8Array, mime?: string): { url: string } }`。
  - **envelope 单一单调计数器（F-5 修复）**：`FrameMapper` 增公开 `stampEvent<T>(partial: Omit<T,'eventId'|'sequence'>): T`（用其私有单调计数打 `eventId: ${connectionId}:${sequence}`），避免 transport 自建计数器与 mapper 碰撞/乱序。
  - `handleFrame` 增分支：`audio_start` → `mapper.mapFrame`（→ `AudioSessionStartedEvent{streamId, format}`）+ `this.ttsBuffers.set(stream_id, { chunks: [], format, durationMs })`；`audio` → base64 decode → append；`audio_end` → concat → mime 由 `format` 派生（`wav→'audio/wav'`、`mp3→'audio/mpeg'`）→ `getTtsMedia()?.putTtsAudio(uuid, bytes, mime)` → `mapper.stampEvent({ event:'audio.session.ready', streamId, url, durationMs, format })` → emit（无 sink → warn + 丢弃）；`audio_cancelled` → `mapper.mapFrame`（→ `AudioSessionCancelledEvent{streamId}`）+ 清 buffer。新 `audio_start` 到达即 supersede 旧 stream（清掉旧缓冲——后端中断语义）。
- **二进制接收**：`ws.on('message', (arg, isBinary))`——arg 为 `Buffer` 时 `this.warn('UNEXPECTED_BINARY', ...)` 忽略（后端不下发二进制，TTS 是 base64 JSON）。

### 5.6 Mock-backend 实现（D-P13）

- 语音模拟：`startRecordVoice` 记录 active record → `stopRecordVoice` emit `VoiceTranscriptEvent{recordingId, text: '这是一段测试录音的转写文本'}`（可注入 `options.voiceTranscriptText` 覆盖/置空测「未识别」）→ `commitVoice` emit `user_message.ack`（复用既有 ack 模拟）+ 触发既有 generation 模拟 → `discardVoice` 清态。`startRealtimeVoice` emit `VoiceSessionStartedEvent`；首个 `sendAudioBytes` 后延时 emit `VoiceSessionPartialEvent`+`VoiceSessionTurnEvent`；`stopRealtimeVoice` emit `VoiceSessionEndedEvent{reason:'stopped'}`。`startDictation` emit `DictationPartialEvent`（每次二进制累积文本）；`stopDictation` emit `DictationFinalEvent{text}`；`cancelDictation` emit `DictationCancelledEvent`。`sendAudioBytes` 记录 `this.receivedAudioChunks`（测试断言帧数与字节）。
- **envelope 单调（F-10 修复）**：mock 自有单调计数器（或复用 generation 模拟的 stamp 逻辑）为全部语音事件打 `eventId`/`sequence`，与既有 replay 事件交错仍保持 sequence 递增（`mock-replay.spec` 断言序列升序）。
- **语音错误 emit**：mock 支持注入错误（如 `options.voiceError?: {code, message}`）→ start/stop 时 emit `VoiceErrorEvent`（测错误路由）。
- TTS 模拟：**`ttsActive` 由 `activeSelection.ttsProfileId` 派生**（无独立标志，避免状态漂移）；generation completed 时若 `ttsActive` → emit `AudioSessionStartedEvent{streamId: 1, format:'wav'}` + `AudioSessionReadyEvent{streamId:1, url:'cyrene://renderer/__cyrene-media/tts-live/mock-silent'}`（占位 URL，实际 <audio> 404 触发 onerror——mock 局限，真实发声随 real；D-P8 onerror 清态由 store 处理）。`audioCancel` emit `AudioSessionCancelledEvent`。
- 既有 generation/ack 测试不受影响：TTS 事件仅在 `ttsActive` 时触发（默认关）。

### 5.7 Main 设置持久化（[settings/settings-service.ts](apps/desktop/src/main/settings/) 新）

- `SettingsService`：`load(): Promise<SettingsState>`（缺失 → 默认；损坏 → 备份 `.corrupt` + 回默认，fail-open）；`save(patch): Promise<SettingsState>`（merge + zod 校验 + 原子写 + 版本化）；**路径 `join(dirs.config, 'settings.json')`（受管目录）+ 注入 `safeRoot` + 复用 `atomicWriteFile`（tmp+rename）**——既有持久化纪律（D-P6，对照 SessionStore/credentials），不手写 tmp+rename。
- **默认值（M-7 修复）**：`enabled=true`、`realtimeEnabled=false`、`autoReadReply=true`（仅 TTS Profile 激活时有帧，默认开不突兀）、`showCaptions=true`、`consentBackendStt=false`、`micDeviceId=undefined`、`dictation.sttProfileId=undefined`、`dictation.insertMode='append'`。
- IPC handler：`settings:load` → `SettingsState`；`settings:save` → 校验 `SettingsPatch` → merge → 持久化 → 返回新状态。注册于 `registerHandlers`（deps 增 `settings`）。

### 5.8 Renderer 音频采集（[renderer/src/voice/](apps/desktop/src/renderer/src/voice/)）

- **`PcmCapture`**（`voice-capture.ts`）：`start(options: { onChunk(bytes: Uint8Array): void; onStop?(audioBuffer: AudioBuffer): void; deviceId? }): Promise<void>` / `pause()` / `resume()` / `stop()`。`getUserMedia({audio: {deviceId?, channelCount:1, sampleRate:16000, echoCancellation:true, noiseSuppression:true, autoGainControl:true}})` → `AudioContext({sampleRate:16000})` → `AudioWorklet.addModule(moduleUrl)` → `MediaStreamAudioSourceNode` → worklet 处理器（Float32→Int16，20ms=640B 聚合，postMessage 给主线程）→ onChunk。**AudioWorklet 加载失败 → ScriptProcessorNode 降级**（同处理器逻辑）。PCM 转换抽纯函数 `floatToPcm16(f32: Float32Array): Int16Array`（可单测）。
- **module 打包**：worklet 处理器文件以 Vite asset 输出（`new URL('./pcm-worklet.js', import.meta.url).href`），cyrene://renderer 同源加载（`script-src 'self'` 放行，D-P7 不改 CSP）。
- **安全**：采集仅 Renderer；`PcmCapture` 不触达文件系统/凭据/后端路径；音频样本仅经 `voice:audio-chunk` 送 Main→后端，内存态。

### 5.9 voiceStore（[renderer/src/stores/voice.store.ts](apps/desktop/src/renderer/src/stores/) 新）

State（doc 06 §3.x voiceStore）：
- `mode: 'idle' | 'recording' | 'record_pending' | 'realtime' | 'dictating'`
- `caption: string`（record/partial/dictation 字幕，仅展示；**绝不写入草稿**——除 dictation.final 专用路径）
- `record: { elapsedMs: number; audioBuffer: AudioBuffer | null; transcript?: string }`
- `realtime: { sessionId?: string; caption: string; turnCount: number; unacked: number; lastAckedSeq: number }`
- `dictation: { caption: string }`
- `tts: { playingStreamId?: number; url?: string; playing: boolean; durationMs?: number }`
- `micError?: PublicError`；`error?: PublicError`；`captureReady: boolean`

Actions：
- `init()`（bootstrap 调用）：`api.onChatEvent` 订阅 → `handleEvent` 路由；设置装载经 `settingsStore.hydrate()`（本 store 不重复持有）。
- `handleEvent(e)`：`voice.transcript` → record.transcript；`voice_session.*` → realtime 状态（started/partial/turn/ack/ended 清态）；`dictation.partial/final/cancelled` → caption / final 写草稿（draftStore，见 §5.10）/ 清态；`audio.session.*` → TTS 播放（D-P8/D-P1 门）；`voice.error` → `error` 置位（`PLAYBACK_NOT_FOUND` 忽略，良性）。
- **统一守卫（I-5 修复）**：三个 start 均 guard `mode==='idle' && connected`；`startRecord`/`startDictation` 另 guard `settings.voice.enabled`，`startRealtime` 另 guard `settings.voice.realtimeEnabled`；`record_pending` 期间新 start 亦被 `mode≠idle` 拦截（须先丢弃/重录/确认）。
- **consent（D-P16）**：任一语音操作若 STT 执行位置为 backend（`settingsStore.voice.consentBackendStt` 为 false）→ 先弹「音频将发送至后端识别（本机不保留）」确认；接受 → 置位 + 继续，拒绝 → 中止。
- 录音（**D-P19 顺序：控制帧先于采集**）：`startRecord()`（guard → consent → gen `rec_<uuid>` → **`api.voiceStartRecord`（await 成功）→ `PcmCapture.start`** → mode=recording + 计时）→ `stopRecord()`（`PcmCapture.stop` → `api.voiceStopRecord` → mode=record_pending，**等 `voice.transcript` 或 `voice.error`（后端 STT 超时/失败恒发 `error{STT_UNAVAILABLE}`），45s 兜底判「未识别」（D-P17）**——此时仅允许丢弃/重录，`commitRecord` 门禁 `caption 非空`；**600s 硬上限（与后端一致），300s 时 toast 提示接近上限**）→ `replayRecord()`（AudioContext 播本地 buffer）→ `discardRecord()`（`api.voiceDiscard`）→ `commitRecord()`（`messageStore.sendVoiceCommit(recordingId, caption)` 成功后清态）。
- 实时（D-P19 同序）：`startRealtime()`（guard → consent → gen `vs_<uuid>` → `api.voiceStartRealtime` → `PcmCapture.start`；chunk 送 `api.voiceSendAudio` + `unacked++`；`unacked - lastAckedSeq > MAX_UNACKED_FRAMES(200) → PcmCapture.pause()`，ack 恢复；**5s 无 ack 兜底恢复**）→ `stopRealtime()`/`cancelRealtime()`（wire pause/resume 预留不用，D-P3）。
- 转写（D-P19 同序）：`startDictation()`（pointerdown，guard → consent → gen `req_<uuid>` → **`api.voiceStartDictation({ clientRequestId, sttProfileId: settingsStore.dictation.sttProfileId }`（M-4：缺省 undefined → 后端全局活动 STT）→ `PcmCapture.start`）→ `stopDictation()`（pointerup）→ `api.voiceStopDictation` → final 写草稿（insertMode 见 §5.10）；`cancelDictation()`（上滑取消）→ `api.voiceCancelDictation`。
- TTS（D-P8）：`onAudioStarted(streamId)` → 新句打断旧播放（若有）→ 记 `playingStreamId`；`onAudioReady(streamId, url)` → `settings.voice.autoReadReply` 为真 → 经 `CyTtsPlayer`（隐藏 `<audio>`，宿主 CyChatView）播放，**`onended` 与 `onerror` 均清态**（mock 404 → onerror，防 `playing` 卡死）；为假 → 丢弃（不播、不置 playing）。`stopTtsPlayback()` → `api.audioCancel({streamId})` + 本地停 + 清态。
- 清理：`reset()`（断线/会话切换 → `PcmCapture.stop` + 取消语音会话 + 清态；经 `connection`/`conversation` 守卫触发）。

背压常量 `MAX_UNACKED_FRAMES = 200`（≈4s @ 50帧/s，含 1s ack 周期余量）+ `ACK_STALL_MS = 5000`（无 ack 兜底恢复，D-P12）。

### 5.10 settingsStore（[renderer/src/stores/settings.store.ts](apps/desktop/src/renderer/src/stores/) 新）

- State：`voice`/`dictation`（`SettingsState`）、`loaded`、`saveError`。
- Actions：`hydrate()`（`api.settingsLoad` → state；失败 fail-open 用默认）；`setVoice(patch)` / `setDictation(patch)`（本地改 + **500ms 防抖**持久化 `api.settingsSave`，`saveError` 置位失败；`saved` 供 UI 展示）；`applyDictationInsert(text)`（D-P4：`insertMode='append'` → draftStore 追加草稿末尾；`'replace_selection'` 且草稿区有选区 → 替换选区；无选区回退追加）。
- 启动接线：bootstrap 在 `hydratePersistence` 后并行 `settingsStore.hydrate()`（不阻塞会话激活）。

### 5.11 messageStore 扩展

- `applyEvent` 增分支：`case 'voice_session.turn'` → 若 `event.conversationId ?? useConversationStore().currentId` 匹配当前会话 → `upsertMessage({ messageId: event.messageId, conversationId, role: 'user', status: 'acknowledged', content: event.text, createdAt: nowIso() })`（后端预分配 messageId，非乐观；后续 generation.* 正常装配）。
- `async sendVoiceCommit(recordingId: string, text: string): Promise<boolean>`：镜像 `send()`——乐观 user 消息（`clientRequestId = crypto.randomUUID()`，`key = local-${clientRequestId}`，content=text）→ `api.voiceCommit({ recordingId, text, conversationId, clientRequestId, clientMessageId: clientRequestId })` → 有 `serverMessageId` 则 migrateKey → `status='acknowledged'` + push cache → 返回 true；失败 → `status='failed'` + lastError → 返回 false。

### 5.12 UI（doc 03/11 §3）

- **CyChatInput 增三入口**（不与「发送语音消息」共用视觉状态，doc 11 §3）：
  - `🎤 普通录音`：click 开始 / click 停止；录音中按钮高亮 + 时长。
  - `🔊 实时会话`：click 进入实时模式；输入区替换为实时状态条（`CyRealtimeBar.vue`：聆听状态 + 字幕 + 轮次数 + 停止）；实时进行中聊天发送按钮禁用。
  - `⌨️ 转写`：按住说话（pointerdown 开始 / pointerup 提交 / 上滑取消）；`CyDictationHint.vue` 字幕浮层。
  - **待发送语音输入条**（`CyVoicePending.vue`）：录音停止后显示——`转写字幕（或「未识别，请重试」）` + `[试听][重录][删除][确认发送]`。字幕只显示，不写草稿；**无字幕时「确认发送」禁用**（仅丢弃/重录）。
- **CySettingsView**：导航分组增「语音」→ [CyVoicePane.vue](apps/desktop/src/renderer/src/components/)（doc 11 §2.3/§2.6/§3）：
  - 启用语音输入 / 启用实时语音 / TTS 自动朗读（D3）/ 显示直接语音字幕（开关，绑 settingsStore.voice）。
  - 麦克风设备下拉（`navigator.mediaDevices.enumerateDevices()` audioinput）。
  - **测试麦克风**：录 3s → 本地试听 + 时长显示 + 错误显示（权限拒绝/无设备）；转写测试复用 dictation 链路（用户输入时自然验证，不做专用入口）。
  - **转写专用 STT Profile**（doc 11 §2.6）：下拉，数据源 `modelServiceStore.profiles` 过滤 **`type==='stt' && enabled && executionLocation==='backend'`**（D-P20：desktop/local profile 会 `STT_PROFILE_NOT_FOUND`，不列），绑 `settingsStore.dictation.sttProfileId`；「使用全局活动 STT」空选项。
  - 转写插入位置：`追加草稿末尾 / 替换当前选区`（`dictationInsertMode`）。
  - **consent 提示**（D-P16）：首个 backend-STT 语音操作前确认对话框（含「不再提示」持久化 `voice.consentBackendStt`）；于 CyChatInput 语音入口触发。
  - **TTS 播放宿主**：`CyTtsPlayer.vue`（隐藏 `<audio>`，宿主 CyChatView）由 voiceStore 驱动（url/播放/停止/onended·onerror 回调）。
  - **删除回退**（D-P20）：modelServiceStore `deleteProfile` 成功后若 `settingsStore.dictation.sttProfileId === 被删 id` → 自动清空该设置（回退全局活动 STT）+ toast「转写已回退全局 STT」。

### 5.13 会话切换守卫（D-P5）

- conversationStore `activate(id)` / `create()` 前守卫：`voiceStore.mode !== 'idle'` → 提示「请先结束当前语音会话」并中止切换。实时模式同理（doc 11 §3.2）。

### 5.14 Mock TTS 占位 URL 说明（D-P13）

`audio.session.ready.url` 指向 `tts-live/mock-silent` 占位：真实 Electron 集成测试断言 voiceStore 状态（playingStreamId/url）与播放门，实际发声仅在 REAL 联调验证。MediaService `tts-live` 路由对 mock 占位 id 返回 404（不落真实媒体）。

## 6. 错误处理与安全

- **权限**：麦克风拒绝 → `micError`（待发送条/测试麦克风展示「麦克风权限被拒绝」）；Main 权限处理器仅放行 audio（deny camera/video），仅受信 origin——非受信 origin 一律 deny。
- **错误码映射**（REST ProtocolError / WS result 帧 / `error{code}` 三形状沿用 P4-A）：`STT_UNAVAILABLE`/`VOICE_SESSION_CONFLICT`/`VOICE_SESSION_NOT_FOUND`/`VOICE_RECORDING_TOO_LONG`/`VOICE_RECORDING_NOT_FOUND`/`DICTATION_NOT_FOUND`/`STT_PROFILE_NOT_FOUND`/`CONTRACT_VALIDATION` → PublicError 展示（待发送条/实时条/转写浮层）；`PLAYBACK_NOT_FOUND`（audio.cancel 竞态）→ 良性忽略。
- **语音族错误路由（D-P15）**：上述语音族错误码 → real-backend emit `voice.error` → voiceStore `error` 展示；**connectionStore 对 `VOICE_ERROR_CODES` 不展示全局连接横幅**（语音错误是会话级预期错误，非连接级）。
- **音频不落盘、不入消息**：录音 buffer 仅 Renderer 内存（AudioBuffer）；BINARY 上行不触达本地路径；TTS 二进制仅 Main 内存 + MediaService `tts-live` 短期缓存（TTL 5min，惰性清理参照 `putTtsPreview`）。`inner_voice`/转写不记日志（既有敏感面）。
- **DataCloneError（P4-A 教训）**：`voiceSendAudio` 显式构造 `Uint8Array` 拷贝；绝不用 reactive 代理；`PcmCapture` 回调 bytes 为 plain typed array。
- **断线清理**：`disconnect`/连接状态迁移 → voiceStore 停采集 + 取消语音会话 + 清态 + 停 TTS 播放。
- **背压**：实时会话超窗暂停采集（非丢帧），ack 恢复；5s 无 ack 兜底恢复（D-P12）。
- **CSP**：不改——`csp.ts` 现为 `media-src 'self'`，`cyrene://renderer` 同源故 `'self'` 已覆盖 TTS `<audio>`（scheme 为 standard+secure）；AudioWorklet 模块同源 `script-src 'self'` 放行；试听走 AudioContext 不经 blob URL。
- **后端 STT 同意（D-P16）**：backend STT 首次操作前明确提示「音频将发送至后端识别（本机不保留）」（doc 02 §13.3）。

## 7. 测试计划

### 7.1 单元测试（Vitest）

- **raw-schemas**：新增帧 schema 校验 fixture；**`RAW_FRAME_TYPES`（[raw-schemas.ts](apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts#L248)）计数更新（15 → 含语音/TTS 帧）+ 既有 hardcoded 门禁同步**：`raw-schemas.spec.ts` 硬编码 15 类型列表、`wire-fixtures.spec.ts` 断言所有 `wire-v2/*.manifest.json` `schemaHash === rawSchemasFingerprint()`（加帧必重生成 manifest）、`check-backend-contract.mjs` 的 `WS_V2_FRAME_TYPES` 白名单（新帧入列后从「只 warn」转 hard-check）。
- **schema 镜像**（F-2）：`BackendEventSchema` 判别联合新增 13 事件 + `eventId`/`sequence` 必填断言；`settings:load/save` 出/入参 schema。
- **frame-mapper**：`voice.transcript`/`voice_session.*`/`dictation.*`/`audio_start`/`audio_cancelled` → 领域事件；`audio`/`audio_end` 不进 mapper（transport 消费）；`stampEvent` 单调性（与 mapFrame 共享计数器不碰撞）。
- **real-backend**：三模式控制帧发送断言（fake ws 捕获 JSON；`voice.record.start` 无 conversationId）；`commitVoice` await ack（正/拒）；`sendAudioBytes` 连接+活动会话双 guard（无会话丢弃 / 断连不 throw）；**语音族错误 `voice.error` emit + 非语音族行为不变**；TTS 缓冲 + `getTtsMedia` sink + `audio.session.*` 事件（含 base64 decode、`audio_end` 组装 + mime 按 format 派生、`audio_cancelled` 清理、新 `audio_start` supersede、`stampEvent` envelope 单调）；二进制接收忽略。
- **mock-backend**：语音模拟事件序列（record stop→transcript→commit→ack；realtime started→partial→turn→ended；dictation partial→final/cancelled）；`receivedAudioChunks` 记录；**envelope 序列交错单调**；错误注入 emit `voice.error`；TTS 模拟仅 `ttsActive` 触发。
- **SettingsService**：默认值/merge/原子写/损坏恢复/zod 拒绝/目录归属。
- **PCM 转换**：`floatToPcm16` 边界（±1.0 截断、0 值、非整帧聚合）。
- **voiceStore**：record 全流程（**start 先于采集**、start→stop→transcript→commit→discard→replay、**字幕等 transcript/voice.error、45s 兜底未识别**、600s 上限/300s 提示、consent 首次确认）；realtime（started/partial/turn/ack 背压窗口暂停恢复/5s ack-stall 兜底/ended 清态、统一守卫）；dictation（partial/final 写草稿 append/replace_selection/cancelled、sttProfileId 透传、consent）；TTS（autoReadReply 门：on→play、off→丢弃；新 started 打断；**onerror 清态**；cancelled 清态）；`voice.error` → error 置位（PLAYBACK_NOT_FOUND 忽略）；会话守卫；断线清理。
- **settingsStore**：hydrate/merge/500ms 防抖/fail-open。
- **connectionStore**：语音族错误码不展示连接横幅（`VOICE_ERROR_CODES`）。
- **messageStore**：`voice_session.turn` 插入 user 消息；`sendVoiceCommit` 乐观+migrate+失败保留草稿语义。
- **权限**：handler 放行 audio/拒 video/拒非受信 origin。

### 7.2 集成测试（Vitest + real adapter fixture / Electron）

- IPC 通道：voice start/stop/commit/audio-chunk 单向、settings load/save 全链路（mock adapter）；**`registerOneWayHandler` 可信发送者守卫（非受信 sender 拒收）+ chunk 载荷 zod（超 1MiB 丢弃）+ `ipc-security.spec.ts` desktopApi 白名单计数更新（42 → 新增 voice/settings 方法）**。
- **真实 Electron**：录音按钮→待发送条→确认发送→消息出现；实时条启停；转写按住→final 进草稿；设置中心语音子页（开关/设备/STT 下拉/测试麦克风布局与点击）；会话切换守卫；**TTS mock URL 404 → onerror → 播放态回落**。沿用既有真实 Electron 布局/点击纪律（bounding box、无 force、`expect.poll`）。

## 8. 验收清单（对齐 doc 11 §10 / doc 16 §7 语音子集）

- [ ] 普通录音输入与实时语音会话可**独立启用/停用**（设置开关生效）。
- [ ] 普通录音停止后只生成**待发送语音输入**（字幕/试听/重录/删除/确认发送），直接语音字幕**不写入文字草稿**。
- [ ] 确认发送 → `voice.commit` → 用户消息 + 流式回复正常。
- [ ] 输入法转写按住→松开 → `dictation.final` **只写草稿**，不创建语音消息、不自动发送；上滑取消 → `dictation.cancelled`。
- [ ] 输入法转写可**独立选择 STT Profile**（`dictationSttProfileId` 本地设置生效，`dictation.start.sttProfileId` 正确透传；缺省用全局活动 STT）。
- [ ] 实时语音会话：启动→连续音频→字幕显示→轮次自动提交触发 generation→停止；背压不丢音频；5s 无 ack 不永久暂停。
- [ ] TTS 自动朗读 AI 回复（D3），设置关闭后不再播放；`audio.cancel` 打断生效；播放中断/URL 失效（onerror）播放态回落。
- [ ] **后端 STT 首次操作前一次性同意提示**（含「不再提示」持久化）；拒绝则中止。
- [ ] **语音错误（如 STT_UNAVAILABLE/VOICE_SESSION_CONFLICT）显示在语音 UI，不显示全局连接错误横幅**。
- [ ] 语音设置**持久化**（重开保留）；损坏文件 fail-open 回默认。
- [ ] 会话切换守卫：语音会话活跃时禁止切换（提示）。
- [ ] 断线/停止时采集与播放清理（无泄漏、无残留状态）。
- [ ] 删除被转写引用的 STT Profile → 转写回退全局活动 STT + 提示。

## 9. 文档同步清单

- **doc 02**：**§13.1 内容重写**（非仅标已实现）——`AudioStreamDescriptor` 收敛为固定 `pcm_s16le/16000/1` 描述符、TTS 音频为 base64 JSON 帧、删「不能 Base64 塞入普通事件 JSON」矛盾表述（F-9 修复）；§12 三种语音 + §13.2/§13.3 状态改「已实现」；**§13.4 TTS 播放 `audio_end{stream_id, format?}` 字段补齐**；§19 对齐表语音行（`voice.record.*`/`voice_session.*`/`dictation.*`/`audio_*` 域契约 ↔ wire 映射）确认；`voice.caption`/`dictation.final` 消费 Store 行更新。
- **doc 03**：UI 语音入口/待发送条/实时条/转写浮层/TTS 播放/语音设置页（UI 可见功能 → PRD/03/08）。
- **doc 06**：Store 划分增 `voiceStore`/`settingsStore`（§3.x）；`connectionStore` 语音族错误横幅抑制说明。
- **doc 07**：Main 麦克风权限处理器 + 单向语音 IPC 守卫（安全策略变更 → 04/07/08）。
- **doc 08**：验收用例同步（本批 §8 清单）。
- **doc 10**：阶段 4 批 B 任务拆分进度。
- **doc 11**：§2.3 测试麦克风、§2.6 转写 STT 选择、§3 语音输入 → 落地状态；转写「光标级插入」「保留录音」标注为后续（P4-B 子集）。
- **doc 12**：E-06（语音输入）/E-07（转写独立 STT）完成证据更新。
- **doc 13**：交叉 review——语音语义 + 安全策略均变更（§9 触发器命中），需重跑。
- **doc 16**：阶段 4 批 B 进度与测试数字。
- **README / CLAUDE.md**：阶段 4 状态同步（P4-B 落地 + 测试计数）。
- **决策记录**：本批 Rulings（D-P1~D-P20）+ 语音族错误路由/consent/字幕终态等决策 + park 项（P4-A §5/§6 复验项）。

## 10. 风险与边界

- **AudioWorklet 加载（Electron 自定义协议）**：同源 asset 预期可加载；失败降级 ScriptProcessorNode；**真实 Electron 上 AudioWorklet-on-custom-protocol 未经实证**，需真实 Electron 集成验证（D-P8 的 onerror/降级为对冲）。
- **麦克风权限（Electron 无默认放行）**：必须加 Main 权限处理器；范围收紧（仅 audio、仅受信 origin）。真实 Windows 设备授权流程需联调验证。
- **BINARY 上行与 `ws` 库**：`ws.send(Uint8Array)` 原生支持；fake ws（测试）需扩展 send 接受 binary。
- **TTS 播放时序**：整段缓冲（非流式）与后端 Phase 2 语义对齐；`onended` 完成判定 + `onerror` 兜底清态；新句 supersede 旧句。
- **语音错误帧依赖**（D-P15）：字幕终态/错误展示依赖 real-backend 对语音族错误码 emit `voice.error` + connectionStore 横幅抑制——两者缺一则语音错误要么丢失要么误当连接错误。
- **consent UX 摩擦**（D-P16）：首个 backend-STT 操作多一步确认；「不再提示」持久化降低重复打扰，但用户可能误点——联调时观察。
- **mock 局限**：TTS 占位 URL 无声 + <audio> 404 触发 onerror（真实发声随 real 联调）；mock 语音转写文本为确定性样例（真实 STT 语义随 real）。
- **P4-A park 项复验**：DataCloneError（voiceSendAudio 同路径）、baseUrl、pre-save test —— 随 P4-B 真实联调一并复验（见 P4-A 决策记录 §5/§6）。
