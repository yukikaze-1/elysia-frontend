# Cyrene 阶段4 真实联调整改设计：普通录音异常清理（FE-S4-RUN-P0-01 / P1-01 / P1-02）

**日期：** 2026-08-16
**依据：** 真实联调 review [阶段4真实联调前端整改清单](../../review/2026-08-16-阶段4真实联调前端整改清单.md)（binding authority）+ 配套 [后端整改清单](../../../../elysia-agent/docs/review/2026-08-16-阶段4真实联调后端整改清单.md)（跨仓契约冻结目标）
**前端基线：** `main@37a78e3`（P4-B 验收后 HEAD）
**后端对照：** `/home/yomu/elysia-agent` `main@fc5b45e`（protocol 2.0）

## 1. 背景与目标

阶段 4（Profile / TTS / 三种语音）已在真实 Windows Electron + Ubuntu 后端（REAL 模式）完成主链联调：实体麦克风采集、SenseVoice 字幕、dictation、realtime、TTS 自动朗读均通过。剩余问题全部集中在**普通录音的异常/空结果清理**，三处：

| 编号 | 优先级 | 一句话 |
|---|---|---:|
| FE-S4-RUN-P0-01 | P0 | 采集启动失败后前端立即回 idle 并假定 fire-and-forget `voiceDiscard()` 已取消后端会话——后端实际拒绝 RECORDING 态 discard，下一次 start 被 `VOICE_SESSION_CONFLICT` 拒（必须补 stop 或重连） |
| FE-S4-RUN-P1-01 | P1 | Mock/测试把 discard 建模为同步成功，未覆盖空录音后服务端已 IDLE 的异步 `VOICE_RECORDING_NOT_FOUND`——正常删除被协议记为错误（`voice.error`/`onChatError` 噪声），测试无法发现真实契约漂移 |
| FE-S4-RUN-P1-02 | P1 | stop 后字幕仍在转写时立即展示「未识别，请重试」，45s timer 无可观察等待状态——慢转写被误报，与 D-P17「等待终态」不符 |

**目标：** 与配套后端 `voice.discard` 语义修订（BE-S4-RUN-P0-01，可取消任意未提交阶段 + 幂等成功）联动，前端收敛录音取消 helper、补真实异步错误处理与有状态协议桩测试、增加「正在识别…」等待态。完成后阶段 4 标「完整真实联调通过」候选（需配套后端 SHA 复验）。

## 2. 范围（做 vs 不做）

### 做

- `voiceStore` 录音取消收敛为单一 helper（保留 recordingId 到取消帧发送成功后再清本地态；发送失败不静默）；`startRecord` 采集失败路径改走该 helper；
- `record.awaitingTranscript` 等待态 + `CyVoicePending` 四态渲染（错误 > 字幕 > 正在识别 > 未识别）；
- `voice.error` 消费门控（`mode !== 'recording'` 才消费）——防旧会话迟到错误污染新录音展示（P1-01 §4.3.6）；
- `MockBackend.discardVoice` 建模冻结契约边界（match 清 / mismatch 拒绝不误清 / realtime·dictation 拒绝不动 / IDLE 幂等成功）+ `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` env（集成可观察等待态）；
- real-backend 有状态协议桩测试（冻结契约序列 + 契约漂移 canary）;
- 单测/集成测试补充与既有用例修正；
- 文档同步（doc 02 / 11 / 13 / 16 + 决策记录）。

### 不做

- **不改 `real-backend.discardVoice` wire**（send-only 无 discard ACK；冻结契约保证 record discard 幂等成功，本地 activeVoice 清位后无失配窗口）；
- **不做版本门控 stop fallback**（不把 `voiceStopRecord` 当取消替身；stop 语义=请求转写，采集失败不应触发 STT；依赖后端修订为唯一取消原语）；
- **不扩大 connectionStore 错误抑制列表**（P1-01 §4.3.8：错误应在配套后端修复后从源头消失）；
- **不改 realtime/dictation 的 capture 失败取消路径**（`cancelRealtime`/`cancelDictation` 语义正确，不得回归，review §3.3.7）；
- 不动 `TRANSCRIPT_WAIT_MS = 45000`（D-P17）；
- 不做 renderer env 桥（45s timeout 翻转由单测 fake timers 覆盖，集成只验等待态不闪烁）；
- 不处理「聊天录音时进入设置页」的既存录音残留问题（范围外，记录于 §10）。

## 3. 契约基础（后端 `fc5b45e` → 冻结目标）

### 3.1 现状 wire（`fc5b45e`，P4-B 已实现面）

- 普通录音：`voice.record.start{recordingId}` → BINARY PCM ×N → `voice.record.stop{recordingId}` → `voice.transcript{recordingId,text,emotion?}` → `voice.commit{...}` → `user_message.ack`+generation.*；`voice.discard{recordingId}` 丢弃；
- 错误信封：`voice.record.start/stop/discard` 违规 → `error{code}`；
- 现契约（将修订）：RECORDING 态 discard → `CONTRACT_VALIDATION: 录音中，先 stop 再 discard`；后端已自动回 IDLE 后迟到 discard → `VOICE_RECORDING_NOT_FOUND`；
- 后端自动回 IDLE 不发 transcript 的情形：总 PCM `<640B`；STT 返回空串/纯空白；STT 关闭/超时/异常。

### 3.2 冻结目标（BE-S4-RUN-P0-01，后端修订后）

`voice.discard{recordingId}` 统一定义为「不转写、不提交、不生成用户消息的取消操作」：

| 后端当前状态 | recordingId | 目标行为 |
|---|---|---|
| RECORDING | 匹配当前录音 | 立即清 PCM 回 IDLE；成功，不要求先 stop |
| RECORDING/TRANSCRIBING | 匹配当前录音 | 取消在途 STT、清态回 IDLE；成功 |
| RECORDING/PENDING | 匹配当前录音 | 丢弃字幕/情绪/events 回 IDLE；成功 |
| IDLE | 任意迟到/重复 discard | **幂等成功**，不发 `VOICE_RECORDING_NOT_FOUND` |
| 存在另一条普通录音 | recordingId 不匹配 | 拒绝，绝不能取消当前录音 |
| realtime/dictation 活跃 | 任意 recordingId | 保持当前会话不变，返回明确错误；不得误清其它模式 |

约束：discard 成功不调 STT、不发 transcript、不触发 generation；在途 STT 取消且迟到 task 不复活 PENDING；**无 discard ACK**（保持 send-only wire）；连接关闭既有清理保留；不通过前端先 stop 规避（stop=请求转写）。

wire schema 无新增字段（`voice.discard` 状态机语义修订）。

### 3.3 前端依赖面

- P0-01 的「start(A) → discard(A) → start(B) 无需重连」只在后端修订落地方可验证；前端代码按冻结契约开发，最终复跑用配套后端修复 SHA。
- realtime/dictation 不受影响（`voice_session.cancel`/`dictation.cancel` 语义不变）。

## 4. 现状（前端代码证据，3 findings 定位）

### 4.1 P0-01 采集启动失败残留后端会话

- [voice.store.ts:281-289](apps/desktop/src/renderer/src/stores/voice.store.ts#L281-L289)：`capture.start()` catch 内**先**清 `activeRecordingId`/`mode='idle'`（:286-287）**再** `try { await api.voiceDiscard({ recordingId }) } catch {}`（:288）——本地状态在取消帧完成前丢失，且 discard 失败被静默吞掉；
- [real-backend.ts:1052-1056](apps/desktop/src/main/transport/real-backend.ts#L1052-L1056)：`discardVoice` fire-and-forget——`ws.send()` 后无条件清 `activeVoice` 并 resolve，Promise 成功只代表「已发送」不代表「后端接受」；
- [voice.store.spec.ts:96](apps/desktop/tests/unit/voice.store.spec.ts#L96) `voiceDiscard.mockResolvedValue(undefined)` + [:327-336](apps/desktop/tests/unit/voice.store.spec.ts#L327-L336) 只断言 `voiceDiscard` 被调用——「已发送」与「服务端已取消」混为一谈；
- 错误码链路：[real-backend.ts:372](apps/desktop/src/main/transport/real-backend.ts#L372) `CONTRACT_VALIDATION && activeVoice` 才路由 `voice.error`，但 `discardVoice` 已同步清 `activeVoice` → 该错误只走 `onChatError`，用户只见本地 micError，不知后端仍 RECORDING。

### 4.2 P1-01 空录音清理的真实异步错误不可见

- [mock-backend.ts:485-487](apps/desktop/src/main/transport/mock-backend.ts#L485-L487)：`discardVoice` 无条件清 active、不模拟 `VOICE_RECORDING_NOT_FOUND`；
- [mock-backend.ts:458-465](apps/desktop/src/main/transport/mock-backend.ts#L458-L465)：空 transcript 不发事件，`activeVoice` 立即清——Mock 看不到「后端异步错误 + 本地已清」的漂移；
- `VOICE_ERROR_CODES` 含 `VOICE_RECORDING_NOT_FOUND`（[voice.ts:56-59](apps/desktop/src/shared/contracts/voice.ts#L56-L59)）→ real-backend 会 emit `voice.error` + `onChatError`，连接横幅被抑制 → 表现为无意义日志/审计噪声（不卡死）。

### 4.3 P1-02 转写等待期误报未识别

- [voice.store.ts:307-321](apps/desktop/src/renderer/src/stores/voice.store.ts#L307-L321)：`stopRecord` 置 `record_pending` 后，45s timer 到期只清 `caption`/`transcript`（本就为空）——timer 到期前后无可观察变化；
- [CyVoicePending.vue:40-43](apps/desktop/src/renderer/src/components/CyVoicePending.vue#L40-L43)：`v-else-if="!errorText"` 在无 transcript 且无 error 时恒渲染「未识别，请重试」→ 整个转写窗口期误报。

## 5. 设计

### 5.0 决策表（本批 Rulings，R-S4-01~R-S4-08）

| # | 决策 | 理由 |
|---|---|---|
| R-S4-01 | 录音取消收敛单一 helper `discardRecord()`：停采集 → **await** `api.voiceDiscard` → 清态；`startRecord` 采集失败路径改走 helper，不再提前清 recordingId | 本地状态只在取消帧发送 resolve/reject 后清理（不提前丢唯一关联 ID，review §3.3.2）；发送失败=断线，后端会话随连接关闭清理，本地清态收敛于连接 reset（R-B12 不冲突） |
| R-S4-02 | **不做版本门控 stop fallback**；后端 discard 语义修订（BE-S4-RUN-P0-01）为唯一取消原语 | 两端同仓同发，冻结契约即目标；stop=请求转写，采集失败不应触发 STT（review §3.3.5「不得成为长期双发顺序」）；契约漂移由协议桩 canary 测试发现 |
| R-S4-03 | `MockBackend.discardVoice` 建模冻结契约边界：match→清 / 另一录音 mismatch→拒绝不误清 / realtime·dictation→拒绝不动 / IDLE→幂等成功；错误码对齐配套后端实际返回 | Mock 不再「无条件成功且无后端语义」（P1-01 §4.3.3）；测试可发现契约漂移 |
| R-S4-04 | 新增 `record.awaitingTranscript` 等待态：stop 后置 true；transcript/error/45s timeout/discard/commit/reset 清；`CyVoicePending` 渲染优先级 错误 > 字幕 > 正在识别 > 未识别 | 「正在识别…」只在真实 timeout 且无 transcript/error 后切换「未识别，请重试」（review §5.2） |
| R-S4-05 | Electron 集成观察等待态用 Main 侧 mock env `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS`（mock `stopRecordVoice` 延迟 emit transcript）；45s timeout 翻转由单测 fake timers 覆盖，**不做 renderer env 桥** | 复用 `CYRENE_MOCK_VOICE_TRANSCRIPT` env 桥先例（Main 侧，零新 IPC 面）；集成只验「等待中不闪烁错误终态」（review §5.3 末条） |
| R-S4-06 | `voice.error` 消费门控 `mode !== 'recording'`：recording 态丢弃（无 UI 消费者 + 防旧会话迟到错误污染 record_pending 展示），其余态照常消费 | 「重录后旧录音迟到错误不得污染新录音字幕/按钮」（P1-01 §4.3.6）；idle/record_pending/realtime/dictating 既有消费不变（不破坏现测） |
| R-S4-07 | 空/过短/空转写录音停后需等满 45s 才显示「未识别」（后端自动 IDLE 无 transcript/error 信号，前端无法区分「静音」与「慢 STT」）；等待期试听/删除/重录可用、确认发送禁用 | D-P17「等待终态」的必然结果；45s 内可操作退出，误报慢转写代价更大 |

### 5.1 voiceStore 录音取消收敛 helper（P0-01）

`voice.store.ts` 中 `discardRecord()` 改造为唯一取消原语（幂等、可重复调用）：

```ts
async function discardRecord(): Promise<void> {
  if (!activeRecordingId) return
  await capture?.stop()                 // 防御：recording 态卸载/收尾时停止采集（idempotent）
  capture = null
  captureReady.value = false
  try {
    await api.voiceDiscard({ recordingId: activeRecordingId })   // 保留 id 到发送 resolve/reject
  } catch (e) {
    // R-S4-01：发送失败（断线）→ 后端会话随连接关闭清理；本地清态收敛于连接 reset；不静默——留痕
    console.warn('[voice] discard 发送失败，本地录音态已清理（连接 reset 收口）', e)
  }
  clearRecordState()                    // 清 record/caption/mode/timers/activeRecordingId
}
```

调用点（全部收敛到该 helper）：

| 调用场景 | 现状 | 改后 |
|---|---|---|
| `startRecord` capture 失败 | [voice.store.ts:281-289](apps/desktop/src/renderer/src/stores/voice.store.ts#L281-L289) 内联 discard、提前清 id | 置 `micError`/`capture=null`/`captureReady=false` 后 `await discardRecord()`（保留 `activeRecordingId` 到发送完成）；错误码 `NOT_ALLOWED` 等展示语义不变 |
| 待发送删除 / 重录 | `discardRecord()`（[voice.store.ts:336-340](apps/desktop/src/renderer/src/stores/voice.store.ts#L336-L340)） | 同 helper（顺序已正确，补发送失败处理） |
| 设置页测试麦克风收尾 | `finishMicTest` → `stopRecord` + `discardRecord` | 不变（已走 helper） |
| CyVoicePane 卸载 | [CyVoicePane.vue:130-135](apps/desktop/src/renderer/src/components/CyVoicePane.vue#L130-L135) → `reset()` | guard（本页发起过 mic 测试）内 `mode` recording/record_pending → `discardRecord()`；`clearTransientErrors()` 无条件执行（详见下方契约） |

> **卸载契约（修正 onTestMic 失败路径）**：`onTestMic` 失败时 `micTesting=false`、`mode` 保持 `idle`（[CyVoicePane.vue:108-112](apps/desktop/src/renderer/src/components/CyVoicePane.vue#L108-L112)），故 `mode recording/record_pending` 的 discard 分支在该路径**不会触发**——若只按 mode 清错，测试麦克风失败残留在 idle 的 `micError` 会带到聊天页 composer banner（`micError && mode==='idle'`）误展示。实现：
> 1. 保持既有外层 guard（`micTesting.value || micTestDuration.value !== undefined`）——**仅**本页发起的 mic 测试在卸载时才 discard（不误杀聊天页进行的录音，§10 范围外残留不动）；
> 2. guard 内 `mode==='recording' || mode==='record_pending'` → `void discardRecord()`（连接中卸载仍清理后端会话）；
> 3. **无条件** `clearTransientErrors()`（store 新增，清 `micError`/`error`/`notice` 三字段，仅错误字段、不触采集/录音）——覆盖 mode-idle 失败残差；聊天页来源的错误字段属 transient（下次 start* 即清，review-Important 语义），离开设置页清除可接受。

约束：

- **`startRecord` catch 不再提前清 `activeRecordingId`/`mode`**（[voice.store.ts:286-287](apps/desktop/src/renderer/src/stores/voice.store.ts#L286-L287) 移除，交由 helper 统一清理）；
- helper 对「取消帧发送失败」不静默：`console.warn` 留痕 + 本地清态（断线场景连接 reset 收敛）；不新增 UI 噪声（用户已有 micError 或删除意图可见）；
- `micError`/`error` 在 discard 后保留（`clearRecordState` 不碰二者）——capture 失败的 micError 仍由 CyChatInput composer banner 展示（P4-B final-review round2）；
- **清态不竞争**：discard 发送在**单事件循环内 resolve**（mock 同步 / real send-only），`clearRecordState` 在用户 macrotask 可插入前即执行——无「清态覆盖新录音」窗口（注意：capture 失败路径 mode 从未置 recording、仍为 idle，不依赖 `guardStart` 作为重入保护）；
- realtime/dictation capture 失败取消路径（[voice.store.ts:382-389](apps/desktop/src/renderer/src/stores/voice.store.ts#L382-L389)、[:442-449](apps/desktop/src/renderer/src/stores/voice.store.ts#L442-L449)）**不改**（review §3.3.7）。

### 5.2 record.awaitingTranscript 等待态（P1-02）

- `record` ref 增 `awaitingTranscript: boolean`（初始 false）；`clearRecordState()` 复位 `{ elapsedMs: 0, audioBuffer: null, awaitingTranscript: false }`；
- `stopRecord()`（[voice.store.ts:307-321](apps/desktop/src/renderer/src/stores/voice.store.ts#L307-L321)）：控制帧成功后 `mode='record_pending'` + `record.value.awaitingTranscript = true` + 重臂 45s timer；
- timer 回调（45s）：`caption=''`；`record.value.awaitingTranscript = false`（transcript 本就 undefined）——**唯一的可观察翻转**；
- 状态转换（`handleEvent`/action）：

| 触发 | 动作 |
|---|---|
| `voice.transcript`（[voice.store.ts:122-129](apps/desktop/src/renderer/src/stores/voice.store.ts#L122-L129)）| 清 timer + `transcript=e.text` + `awaitingTranscript=false` |
| `voice.error`（[voice.store.ts:195-201](apps/desktop/src/renderer/src/stores/voice.store.ts#L195-L201)）| 若 `mode==='record_pending'`：清 timer + `awaitingTranscript=false`（`error` 照常置位）|
| 45s timeout | `awaitingTranscript=false` |
| `discardRecord`/`commitRecord`/`reset` | `clearRecordState` 复位（含清 timer）|

- 迟到 transcript 门控保持（[voice.store.ts:123](apps/desktop/src/renderer/src/stores/voice.store.ts#L123) `e.recordingId !== activeRecordingId → return`）；迟到 `voice.error` 由 R-S4-06 门控兜底。

### 5.3 CyVoicePending 渲染（P1-02）

[CyVoicePending.vue:37-43](apps/desktop/src/renderer/src/components/CyVoicePending.vue#L37-L43) 模板改为**错误与字幕叠加、等待/未识别互斥**的槽位（保持既有「错误与字幕并存」语义，cy-voice-pane.spec.ts:279「错误与字幕并存，确认发送仍可用」与 :292「确认发送内容必须可见」不回归）：

```html
<span v-if="errorText" class="cy-vp-error" role="alert">{{ errorText }}</span>        <!-- 独立槽，与字幕并存 -->
<span v-if="hasTranscript" class="cy-vp-text">{{ transcript }}</span>                <!-- 独立槽，与错误并存 -->
<span v-else-if="!errorText && awaitingTranscript" class="cy-vp-waiting" role="status">正在识别…</span>
<span v-else-if="!errorText" class="cy-vp-empty">未识别，请重试</span>
```

- 优先级：`error` 与 `transcript` 相互独立可并存；`正在识别…`/`未识别` 仅在无字幕时出现、且被 `!errorText` 门控（有错误时不渲染模糊判词）；
- `awaitingTranscript` 从 `voiceStore.record.awaitingTranscript` 读取；
- 「确认发送」禁用条件不变（`!hasTranscript || committing`）；「试听/重录/删除」等待期可用（R-S4-07）；
- 新样式 `cy-vp-waiting`（muted，与 `cy-vp-empty` 区分；不引入 spinner，保持轻量）。

### 5.4 voice.error 消费门控（R-S4-06）

[voice.store.ts:195-201](apps/desktop/src/renderer/src/stores/voice.store.ts#L195-L201) `handleEvent('voice.error')` 增门控：

```ts
case 'voice.error': {
  if (e.code === 'PLAYBACK_NOT_FOUND') return                       // 既有良性忽略
  if (mode.value === 'recording') return                            // R-S4-06：recording 态丢弃（无 UI 消费者 + 防旧会话迟到错误污染）
  error.value = parsePublicError(`[${e.code}] ${e.message ?? ''}`)
  if (mode.value === 'record_pending') { clearTranscriptTimer(); record.value.awaitingTranscript = false }
  return
}
```

- `idle`/`record_pending`/`realtime`/`dictating` 消费不变（既有用例 [voice.store.spec.ts:350-358](apps/desktop/tests/unit/voice.store.spec.ts#L350-L358)、[:664-681](apps/desktop/tests/unit/voice.store.spec.ts#L664-L681) 均通过）；
- 污染场景闭环：旧录音删除 → 重录（`startRecord` 已清 `error`）→ 旧会话迟到 `voice.error` 在 recording 态被丢弃 → stop 后 `record_pending` 只显示新 transcript。

### 5.5 MockBackend discard 建模（P1-01）

[mock-backend.ts:485-487](apps/desktop/src/main/transport/mock-backend.ts#L485-L487) 重写 `discardVoice`：

```ts
async discardVoice(input: VoiceDiscardInput): Promise<void> {
  const active = this.activeVoice
  if (active?.kind === 'record') {
    if (active.key !== input.recordingId) throw new CyreneError(CyreneErrorCode.VOICE_RECORDING_NOT_FOUND, '无此活动录音')  // mismatch 拒绝，不误清
    this.activeVoice = undefined                                                                                          // match 清
    return
  }
  if (active) throw new CyreneError(CyreneErrorCode.VOICE_SESSION_CONFLICT, '已有活动语音会话')  // realtime/dictation 拒绝不动
  // 无活动会话（IDLE / 已自动重置）→ 幂等成功，不发 VOICE_RECORDING_NOT_FOUND（冻结契约）
}
```

- 错误码以配套后端修复后实际返回为准（实现时对齐；mock 与 real-backend 协议桩共用同一码表）；
- 同步对齐 [real-backend.ts:1052-1056](apps/desktop/src/main/transport/real-backend.ts#L1052-L1056) 的本地行为不变（wire send-only）；
- 新增 `parseMockVoiceTranscriptDelayEnv(value)`（[mock-backend.ts:104](apps/desktop/src/main/transport/mock-backend.ts#L104) 旁）：`undefined → undefined`，否则 `Number(value)` 钳制 `[0, 30000]`；`MockBackendOptions.transcriptDelayMs` 缺省 0；`stopRecordVoice` 控制帧 invoke **立即 resolve**（与 real send-only 语义一致），非空 transcript 的 emit **fire-and-forget** 延迟 `setTimeout(transcriptDelayMs)`（定时器 tracked、`dispose()` 清理），`activeVoice` 同步清（停被接受即清，不随延迟 emit 顺延）——**R-S4-08 ruling（Task 5 修正）：本 spec 原示例「`stopRecordVoice` 非空 transcript 时 `await sleep(transcriptDelayMs)` 再 emit」在 invoke resolve 前等待，与真实后端 stop send-only/快返回语义不符，且「正在识别…」等待态不可观察；fire-and-forget 使等待态在 delay 窗口内可观察、transcript 到达后无闪烁**（[mock-backend.ts:479-497](apps/desktop/src/main/transport/mock-backend.ts#L479-L497)）；仅 `CYRENE_BACKEND=mock` 时经 [index.ts:139](apps/desktop/src/main/index.ts#L139) 接线（`!== undefined` 才注入）。

### 5.6 real-backend 协议桩测试（P0-01 / P1-01）

`real-backend-voice.spec.ts` 的 `FakeWs`（[real-backend-voice.spec.ts:23-41](apps/desktop/tests/unit/real-backend-voice.spec.ts#L23-L41)）扩展为**有状态虚拟后端**（RECORDING/TRANSCRIBING/PENDING/IDLE × record/realtime/dictation），start/stop/discard 按冻结契约接受或按配置模拟旧契约错误帧，并记录 `onError`/`voice.error` 通道：

| 用例 | 断言 |
|---|---|
| start(A) → discard(A) → start(B) | 三帧 wire 顺序 [start,discard,start]；全程无 `CONTRACT_VALIDATION`/`VOICE_SESSION_CONFLICT` error/voice.error |
| empty → stop → discard | 幂等成功，无 error 帧（`onChatError` 空 + 无 `voice.error`）|
| discard → discard | 幂等成功，无 error 帧 |
| realtime 活跃 + discard | 返回明确错误；realtime 会话不受影响 |
| mismatch recordingId + 另一录音活跃 | 返回明确错误；原录音不被误清 |
| **漂移 canary**：桩配置为旧契约（RECORDING 态 discard 拒 `CONTRACT_VALIDATION`）| 驱动 start→capture 失败→discard → 测试能发现「本地 active registry 已清 vs 服务端仍持会话」（断言收到 CONTRACT_VALIDATION 错误帧 + 下一次 start 触发 VOICE_SESSION_CONFLICT），**不**只断言 `voiceDiscard` 被调用 |

## 6. 错误处理与安全

- 取消帧发送失败：本地清态 + `console.warn` 留痕（R-S4-01），不冒充成功、不抛未处理拒绝；连接 reset（[bootstrap.ts:39](apps/desktop/src/renderer/src/bootstrap.ts#L39)）统一收口；
- 不扩大 `VOICE_ERROR_CODES` / connectionStore 抑制（P1-01 §4.3.8）；
- `voice.error` 门控只收窄 recording 态消费，不改变 D-P15 路由与日志/审计（real-backend 侧不变）；
- 无新增 IPC 通道（`CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` 走 Main 侧 mock 装配，非 renderer 面）；
- 麦克风权限/单向 IPC 守卫等安全边界不变。

## 7. 测试计划

### 7.1 单元测试（Vitest）

`voice.store.spec.ts`：

- **P0-01**：capture 失败 → `micError` 置位 + `voiceDiscard` 以**同一 recordingId** 调用 + discard resolve 后 `mode='idle'`（order 断言）+ 状态清（record/caption/elapsedMs）；
- **P0-01**：capture 失败 + `voiceDiscard` reject（断线）→ 无未处理拒绝、本地态清、`micError` 保留；
- **P0-01**：删除（record_pending）时 `voiceDiscard` reject → 清态 + 不 throw；
- **P1-02**：stop → `awaitingTranscript=true`；45s fake timers 后 `awaitingTranscript=false`（未识别翻转）；0~44.999s 期间 `false` 不触发；
- **P1-02**：慢字幕第 30s 到达 → `transcript` 置位 + `awaiting=false` + timer 清除（45s 后不被清空）；
- **P1-02**：等待中收到 STT error → `error` 置位 + `awaiting=false` + timer 清除；
- **P1-02**：等待中删除 → `clearRecordState`（timer 清 + awaiting 复位 + id 清）；重录同断言；
- **R-S4-06**：recording 态收到 `voice.error` → 丢弃（`error` 不置位）；stop 后收到 → 消费（`error` 置位 + `awaiting=false`）；
- **污染闭环**：record→discard→start 新录音→recording 态注入旧会话 `voice.error`→stop→transcript 到达→`error` 仍 undefined；
- 既有用例修正：`45s 兜底判未识别`（:271-281）补 `awaitingTranscript` 翻转断言；`micError`（:327-336）补同一 recordingId + order 断言。

`real-backend-voice.spec.ts`：见 §5.6 全部用例。

`mock-backend-voice.spec.ts`：`discardVoice` match/mismatch/idle/realtime/dictation 五态 + `parseMockVoiceTranscriptDelayEnv` 解析（undefined/0/负数钳 0/超上限钳 30000）。

`cy-voice-pane.spec.ts`（onBeforeUnmount + mic-test 收尾，P0-01 §3.4 末两条 / P1-01 §4.3 #7）：

- 卸载：guard（本页 mic 测试）+ `mode recording`/`record_pending` → `discardRecord` 发送 + `micError`/`error`/`notice` 清空；
- 卸载：**mode-idle 测试麦克风失败残差**（`onTestMic` 失败 → `micTesting=false`、`mode` 保持 idle）→ 无 discard、`clearTransientErrors` 清空（聊天页 composer banner 不残留）；
- 卸载：`consentPending` → 仍 `dismissConsent`（不误发 discard）；无 mic 测试痕迹 → 不 discard（聊天页录音不受影响，§10 残留不动）；
- mic-test `stop → replay → discard`：STT 非空（字幕+试听+丢弃）、STT 空结果（不发 transcript → awaiting → 丢弃）、**discard 与 STT 完成竞态**（单测：stop 后**不派发** transcript 直接 discard → 迟到 transcript 被 recordingId gate 忽略、无待发送条残留、无错误；集成用 `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` 同语义复现）。

`voice-capture.spec.ts`：无新用例（采集失败路径由 store 层覆盖）。

### 7.2 集成测试（Electron，`electron-voice.spec.ts`）

- **更新用例 2（未识别）**：`CYRENE_MOCK_VOICE_TRANSCRIPT=""` → 停后显示「正在识别…」（非「未识别，请重试」）+ 确认发送禁用 → 删除 → 待发送条消失、普通录音按钮恢复、连接保持；
- **新用例（等待态不闪烁）**：`CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS=1500` → 停后断言「正在识别…」可见 → 短窗内断言「未识别，请重试」不出现 → transcript 到达后断言字幕显示（无闪烁）→ 确认发送可用；
- **新用例（采集失败免重连重开三语音，P0-01 §3.4）**：`page.evaluate` 覆写 `navigator.mediaDevices.getUserMedia` 为 reject（`NotAllowedError`，真实权限拒绝同路径）→ 点普通录音 → composer micError banner + 按钮恢复（mode idle）→ **恢复** getUserMedia（保存原函数后还原）→ 同一连接上普通录音成功、实时成功、转写成功（三模式各自无需重连）；
- **新用例（设置页 mic 失败退出后聊天可立即语音，P0-01 §3.4 末条）**：stub getUserMedia reject → 设置页「测试麦克风」→ micTestError 展示 → 退出设置 → 聊天页无残留 banner（clearTransientErrors）→ 恢复 stub → 普通录音按钮可立即启动；
- 既有用例（录音闭环/实时/转写/TTS/持久化/守卫/断线/consent/deleteProfile）回归不变量：**实体麦克风链路由 REAL 联调负责，集成仅 Mock 态**。

## 8. 验收清单

对齐 review §7「前端完成定义」：

- [ ] FE-S4-RUN-P0-01：`capture.start` 失败后不重连即可再次开始任一语音模式（record/realtime/dictation）；
- [ ] FE-S4-RUN-P1-01：空/过短/空转写删除与重录不产生 `VOICE_RECORDING_NOT_FOUND`/`CONTRACT_VALIDATION`（mock + 协议桩双通道断言干净）；
- [ ] FE-S4-RUN-P1-02：正常 STT 等待期显示「正在识别…」，仅真实 45s timeout 后显示「未识别，请重试」；
- [ ] 测试明确区分「控制帧已发送」与「后端状态已完成」（无 `mockResolvedValue` 冒充服务端清理；漂移 canary 证明 harness 敏感）；
- [ ] 重录后旧会话迟到错误不污染新录音字幕/按钮（R-S4-06 门控 + 测试）；
- [ ] `typecheck`/`lint`/`test`（单测）/`test:integration`（Electron）/`build`/`check:contract` 全绿；
- [ ] 用配套后端修复 SHA 在 Windows Electron 复验：权限拒绝/采集初始化失败、空录音删除、空录音重录、实体麦克风正常录音；
- [ ] 复验通过 → 阶段 4 标「完整真实联调通过」。

## 9. 文档同步清单

- **doc 02 §13.1**（普通录音）：`voice.discard` 语义更新为「可取消任意未提交阶段 + 幂等成功」，删除「RECORDING 态先 stop 再 discard」「IDLE 迟到 discard → NOT_FOUND」口径；
- **doc 02 §14**（错误码目录）：`VOICE_RECORDING_NOT_FOUND` 补注「IDLE 迟到 discard 幂等成功，不再产生」；
- **doc 11 §3**（待发送条/语音子页）：停后「正在识别…」等待态 + 45s 兜底「未识别，请重试」+ 等待期操作可用；
- **doc 13 §13**：增量 Review——阶段 4 真实联调整改同步（trigger：语音语义/协议变更）；
- **决策记录**（`docs/review/2026-08-16-阶段4批次B-决策记录.md`）：新增「真实联调整改」段，落 R-S4-01~R-S4-08 + 跨仓依赖（BE-S4-RUN-P0-01）；
- **doc 16 §7/§8**：阶段 4 真实联调整改落地状态（整改后仍待配套后端复验）；
- **check:contract**：配套后端更新 `frontend_contract` 中 discard 相关样例（backend review §3.5「contract/golden trace 增加 start 后直接 discard 和重复 discard 样例」）后，前端 `check:contract` 复跑对齐；本批不新增 wire 字段，无需改前端 schema 镜像；
- 结构回归（表格列数/代码围栏/重复标题/失效相对链接）随提交检查。

## 10. 风险与边界

- **跨仓时序**：P0 的最终复验依赖后端修订（BE-S4-RUN-P0-01）。前端代码按冻结契约开发；若后端修复延误，前端不单独合入 P0（复验无法通过），但 P1-01/P1-02 的 mock/等待态部分可先行落地；
- **漂移 canary 是测试能力不是生产兜底**：前端无法在无 discard ACK 下区分「已接受」与「已拒绝」；契约漂移靠测试暴露，生产依赖后端修订后的稳定语义；
- **空录音 45s 等待**（R-S4-07）：后端自动 IDLE 无信号，等待为 D-P17 必然结果；等待期有试听/删除/重录出口；
- **范围外既存问题**：聊天页录音进行中进入设置页（composer 卸载）的录音残留——P4-B 既存行为，本批不改，随真实联调观察；
- **`console.warn` 仅 renderer 诊断**：不落日志/审计（转写/内语音敏感面纪律不变）。
