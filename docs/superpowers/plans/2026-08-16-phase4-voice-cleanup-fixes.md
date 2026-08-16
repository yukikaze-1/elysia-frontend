# 阶段4 真实联调整改：普通录音异常清理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复阶段4 真实联调暴露的普通录音异常/空结果清理问题——P0-01 采集失败残留后端会话、P1-01 空录音删除伪错误、P1-02 转写等待期误报未识别。

**Architecture:** 前端按配套后端 `voice.discard` 语义修订（可取消任意未提交阶段 + 幂等成功，BE-S4-RUN-P0-01）为唯一取消原语：`voiceStore.discardRecord` 收敛为保留 recordingId 至取消帧发送完成的 helper；新增 `record.awaitingTranscript` 等待态（「正在识别…」仅真实 45s timeout 后翻「未识别」）；`voice.error` 在 recording 态丢弃（防旧会话污染）；MockBackend discard 建模冻结契约边界 + transcript 延迟 env；real-backend 有状态协议桩测试含契约漂移 canary。

**Tech Stack:** Electron + Vue 3 + TS + Pinia + zod + Vitest + Playwright `_electron`（pnpm workspace @cyrene/desktop）。

**Spec:** [docs/superpowers/specs/2026-08-16-phase4-voice-cleanup-fixes-design.md](../specs/2026-08-16-phase4-voice-cleanup-fixes-design.md)（binding authority；本计划从 spec 论证，执行者两篇同读）

## Global Constraints

- **决策表 R-S4-01~07**（spec §5.0）是硬约束：discardRecord 保留 id 至发送完成；无版本门控 stop fallback；mock discard 建模冻结契约；awaitingTranscript 状态机；`CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` Main 侧 env（无 renderer env 桥）；`voice.error` 仅 recording 态丢弃；空录音 45s 等待可接受。
- **不得**：扩大 connectionStore 错误抑制列表；把 `voiceStopRecord` 当取消替身；改动 realtime/dictation 的 capture 失败取消路径（`cancelRealtime`/`cancelDictation`）；新增 IPC 通道；改 `TRANSCRIPT_WAIT_MS = 45000`。
- **wire 不变**：`voice.discard{recordingId}` 无 ACK、send-only；本批不新增字段。
- 门禁：`typecheck` / `lint` / `test`（单测）/ `test:integration`（Electron）/ `build` / `check:contract` 全绿。
- 文档保持中文；阶段 4 新功能维持「已开发、未联调」三态，直至配套后端修复 SHA 复验后才可标「完整真实联调通过」。
- 真实联调 binding authority：`docs/review/2026-08-16-阶段4真实联调前端整改清单.md`（FE-S4-RUN-P0-01/P1-01/P1-02）+ 配套后端 `docs/review/2026-08-16-阶段4真实联调后端整改清单.md`。

## 文件结构

| 文件 | 责任 | 变更 |
|---|---|---|
| `apps/desktop/src/renderer/src/stores/voice.store.ts` | 录音取消收敛 helper、awaitingTranscript、error 门控、clearTransientErrors | T1/T2 |
| `apps/desktop/src/renderer/src/components/CyVoicePending.vue` | 错误/字幕叠加、等待/未识别互斥四槽渲染 | T1 |
| `apps/desktop/src/renderer/src/components/CyVoicePane.vue` | 卸载契约（guard 决定 discard、clearTransientErrors 无条件） | T2 |
| `apps/desktop/src/main/transport/mock-backend.ts` | discardVoice 五态建模 + transcriptDelayMs + env parse | T3 |
| `apps/desktop/src/main/index.ts` | `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` env 接线 | T3 |
| `apps/desktop/tests/unit/voice.store.spec.ts` | 等待态/门控/取消 helper 单测 | T1/T2 |
| `apps/desktop/tests/unit/cy-voice-pane.spec.ts` | 渲染/卸载/mic-test 单测 | T1/T2 |
| `apps/desktop/tests/unit/mock-backend-voice.spec.ts` | mock discard 五态 + env parse 单测 | T3 |
| `apps/desktop/tests/unit/real-backend-voice.spec.ts` | 有状态协议桩测试（冻结契约 + 漂移 canary） | T4 |
| `apps/desktop/tests/integration/electron-voice.spec.ts` | 集成：等待态/采集失败免重连/mic 失败退出 | T5 |
| docs 02/11/13/16 + 决策记录 | 文档同步 | T6 |

---

### Task 1: voiceStore 等待态（P1-02）+ error 门控（R-S4-06）+ CyVoicePending 渲染

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/voice.store.ts`（record ref :47；clearRecordState :95-102；handleEvent voice.transcript :122-129 / voice.error :195-201；stopRecord :307-321）
- Modify: `apps/desktop/src/renderer/src/components/CyVoicePending.vue`（template :37-43；style 补 `cy-vp-waiting`）
- Test: `apps/desktop/tests/unit/voice.store.spec.ts`、`apps/desktop/tests/unit/cy-voice-pane.spec.ts`

**Interfaces:**
- Consumes: 既有 `record.transcript`/`error`/`TRANSCRIPT_WAIT_MS`/`api`；无新外部依赖
- Produces: `record.awaitingTranscript: boolean`（store 字段，T2 discardRecord/clearRecordState 与 T5 集成消费）；`CyVoicePending` 四槽渲染

- [ ] **Step 1: `record` ref 增 `awaitingTranscript`**（[voice.store.ts:47](apps/desktop/src/renderer/src/stores/voice.store.ts#L47)）：`{ elapsedMs, audioBuffer, transcript?, awaitingTranscript: boolean }`；`clearRecordState()`（:95-102）复位为 `{ elapsedMs: 0, audioBuffer: null, awaitingTranscript: false }`。
- [ ] **Step 2: `stopRecord()` 置等待态 + timer 翻转**（:307-321）：控制帧成功后 `mode='record_pending'` + `record.value.awaitingTranscript = true`；timer 回调改 `caption=''` + `record.value.awaitingTranscript = false`（**唯一可观察翻转**——transcript 本就 undefined，不再重复赋空）。
- [ ] **Step 3: `handleEvent('voice.transcript')` 清等待态**（:122-129）：匹配 recordingId 时 `clearTranscriptTimer()` + `record.value.transcript = e.text` + `record.value.awaitingTranscript = false`。
- [ ] **Step 4: `handleEvent('voice.error')` 门控（R-S4-06）**（:195-201）：`PLAYBACK_NOT_FOUND` 忽略后，`if (mode.value === 'recording') return`（recording 态丢弃）；`error` 置位；`mode==='record_pending'` 时 `clearTranscriptTimer()` **+ `record.value.awaitingTranscript = false`**。
- [ ] **Step 5: `CyVoicePending.vue` 四槽渲染**（template :37-43）：改**叠加语义**（spec §5.3 逐字）——`errorText` 独立 `v-if`、`hasTranscript` 独立 `v-if`、`正在识别…` 为 `v-else-if="!errorText && awaitingTranscript"`、`未识别，请重试` 为 `v-else-if="!errorText"`；`awaitingTranscript` 从 `voiceStore.record.awaitingTranscript` 读；style 增 `.cy-vp-waiting`（muted，与 `.cy-vp-empty` 区分，无 spinner）。
- [ ] **Step 6: 写测试（voice.store.spec.ts）**：
  - stop 后 `awaitingTranscript=true` + `mode='record_pending'`；`vi.advanceTimersByTimeAsync(TRANSCRIPT_WAIT_MS)` 后 `awaitingTranscript=false`（未识别翻转）；
  - 慢字幕第 30s 到达（advance 30000 后注入匹配 recordingId 的 `voice.transcript`）→ `transcript` 置位 + `awaiting=false` + timer 清除（再 advance 45s 不被清空）；
  - 等待中收到 STT `voice.error` → `error` 置位 + `awaiting=false` + timer 清除；
  - **门控**：`mode==='recording'`（startRecord 成功未 stop）注入 `voice.error` → `error` 不置位；stop 后（record_pending）注入 → `error` 置位 + `awaiting=false`；
  - 等待中 `discardRecord` → `clearRecordState`（awaiting 复位 + timer 清）；`reset` 同断言；
  - 既有用例修正：`45s 兜底判未识别`（:271-281）补 `awaitingTranscript` 翻转断言；:664-681 voice.error 用例补 `awaiting=false` 断言（mode 为 record_pending 时）。
- [ ] **Step 7: 写测试（cy-voice-pane.spec.ts）**：`record_pending + awaitingTranscript=true + 无 error/transcript` → 渲染「正在识别…」+ 不渲染「未识别，请重试」+ 确认发送禁用；既有 :242/:268/:279/:292 用例不回归（错误/字幕并存、showCaptions 不门控字幕）。
- [ ] **Step 8: 运行** `pnpm -F @cyrene/desktop test`（voice.store.spec / cy-voice-pane.spec）+ `typecheck` 绿。
- [ ] **Step 9: Commit** `fix(阶段4真实联调): record 等待态「正在识别」+ voice.error recording 态门控`

---

### Task 2: 录音取消收敛 helper（P0-01）+ CyVoicePane 卸载契约

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/voice.store.ts`（startRecord catch :281-289；discardRecord :336-340；reset 侧 `clearTransientErrors`）
- Modify: `apps/desktop/src/renderer/src/components/CyVoicePane.vue`（onBeforeUnmount :128-137）
- Test: `apps/desktop/tests/unit/voice.store.spec.ts`、`apps/desktop/tests/unit/cy-voice-pane.spec.ts`

**Interfaces:**
- Consumes: Task 1 `record.awaitingTranscript`（clearRecordState 复位）；既有 `api.voiceDiscard`
- Produces: `discardRecord()`（收敛 helper，T5 集成断言对象）、`clearTransientErrors()`（T2 卸载消费）

- [ ] **Step 1: `discardRecord()` 收敛为取消原语（spec §5.1 逐字）**（:336-340 重写）：
```ts
async function discardRecord(): Promise<void> {
  if (!activeRecordingId) return
  await capture?.stop()
  capture = null
  captureReady.value = false
  try {
    await api.voiceDiscard({ recordingId: activeRecordingId })   // id 保留至发送 resolve/reject
  } catch (e) {
    console.warn('[voice] discard 发送失败，本地录音态已清理（连接 reset 收口）', e)  // 不静默
  }
  clearRecordState()   // 清 record/caption/mode/timers/activeRecordingId（awaitingTranscript 由 Task 1 复位）
}
```
- [ ] **Step 2: `startRecord` capture 失败路径改走 helper（spec §5.1）**（:281-289）：catch 内**移除** `activeRecordingId = undefined` 与 `mode.value = 'idle'`（:286-287 删），保留 `micError.value = parsePublicError(...)` + `capture = null` + `captureReady.value = false`，然后 `await discardRecord()`；return。控制帧失败路径（:266-272，`voiceStartRecord` reject）**不改**（无 activeRecordingId 残留，spec 断言）。
- [ ] **Step 3: 新增 `clearTransientErrors()`**：清 `micError`/`error`/`notice` 三字段；导出供卸载消费。
- [ ] **Step 4: `CyVoicePane.vue` onBeforeUnmount 契约（spec §5.1 卸载契约）**（:128-137）：保持外层 guard `micTesting.value || micTestDuration.value !== undefined`；guard 内 `mode==='recording' || mode==='record_pending'` → `void voiceStore.discardRecord()`（替代 `reset()`）；`consentPending` → 仍 `dismissConsent`；**无条件** `voiceStore.clearTransientErrors()`（清测试麦克风失败残留在 idle 的 micError，防聊天页 composer banner 误展示；不触采集/录音）。
- [ ] **Step 5: 写测试（voice.store.spec.ts，P0-01 §3.4）**：
  - capture 失败 → `micError` 置位 + `voiceDiscard` 以**同一 recordingId**（startRecord 用的那个）调用 + discard resolve 后 `mode='idle'`/`record` 清（order：`mockApi.voiceDiscard` 已调用后再断言清态）；
  - capture 失败 + `voiceDiscard.mockRejectedValue(...)`（断线）→ 无未处理拒绝、本地态清、`micError` 保留；
  - record_pending 删除 + `voiceDiscard` reject → 清态 + 不 throw；
  - **污染闭环（R-S4-06 门控验证）**：record→discard→start 新录音→`mode==='recording'` 注入旧会话 `voice.error`→stop→transcript 到达→`error` 仍 undefined + 待发送条显示新字幕；
  - 既有 `micError` 用例（:327-336）补同一 recordingId + order 断言（`voiceDiscard` 调用先于 `mode` 清）。
- [ ] **Step 6: 写测试（cy-voice-pane.spec.ts，spec §7.1）**：
  - 卸载：guard 真 + `mode recording/record_pending` → `discardRecord` 被调（spy）+ `micError`/`error`/`notice` 清；
  - **mode-idle 测试麦克风失败残差**：`micTesting` 已 false + `mode` 保持 idle + `micError` 置位 → 卸载：无 discard、`clearTransientErrors` 生效（`micError` 清）；
  - 卸载：`consentPending` → `dismissConsent`（不误发 discard）；无 mic 测试痕迹 → 不 discard（聊天页录音不受影响）；
  - mic-test `stop → replay → discard`：STT 非空（字幕+试听+丢弃）、STT 空结果（不发 transcript → awaiting → 丢弃）、**竞态**（stop 后不派发 transcript 直接 discard → 迟到 transcript 被 recordingId gate 忽略、无残留、无错误）。
- [ ] **Step 7: 运行** `pnpm -F @cyrene/desktop test`（voice.store.spec / cy-voice-pane.spec）+ `typecheck` + `lint` 绿。
- [ ] **Step 8: Commit** `fix(阶段4真实联调): 录音取消收敛 discardRecord + 卸载契约 + clearTransientErrors`

---

### Task 3: MockBackend discard 建模（P1-01）+ transcript 延迟 env（R-S4-05）

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（parseMockVoiceTranscriptEnv 旁 :104；MockBackendOptions :108；constructor :229-232；stopRecordVoice :458-465；discardVoice :485-487）
- Modify: `apps/desktop/src/main/index.ts`（:139 mock 装配）
- Test: `apps/desktop/tests/unit/mock-backend-voice.spec.ts`

**Interfaces:**
- Consumes: `CyreneError`/`CyreneErrorCode`（`@shared/errors`）；既有 `parseMockVoiceTranscriptEnv`
- Produces: `MockBackendOptions.transcriptDelayMs?: number`、`parseMockVoiceTranscriptDelayEnv(value)`（T5 集成用 `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS` env）

- [ ] **Step 1: `parseMockVoiceTranscriptDelayEnv`**（:104 旁）：`value === undefined → undefined`；否则 `Number(value)` 并 `Math.min(30000, Math.max(0, n))`（非数/NaN → 0）。
- [ ] **Step 2: `MockBackendOptions` 增 `transcriptDelayMs?: number`**（:108）；constructor `this.transcriptDelayMs = options.transcriptDelayMs ?? 0`。
- [ ] **Step 3: `stopRecordVoice` 延迟 emit（R-S4-05）**（:458-465）：非空 transcript 且 `transcriptDelayMs > 0` → `await new Promise(r => setTimeout(r, this.transcriptDelayMs))` 后再 `this.emit(voice.transcript)`；随后清 `activeVoice`（顺序：emit 后清）。
- [ ] **Step 4: `discardVoice` 五态建模（spec §5.5 逐字，R-S4-03）**（:485-487 重写）：
```ts
async discardVoice(input: VoiceDiscardInput): Promise<void> {
  const active = this.activeVoice
  if (active?.kind === 'record') {
    if (active.key !== input.recordingId) throw new CyreneError(CyreneErrorCode.VOICE_RECORDING_NOT_FOUND, '无此活动录音')  // mismatch 拒绝，不误清
    this.activeVoice = undefined   // match 清
    return
  }
  if (active) throw new CyreneError(CyreneErrorCode.VOICE_SESSION_CONFLICT, '已有活动语音会话')  // realtime/dictation 拒绝不动
  // 无活动会话（IDLE / 已自动重置）→ 幂等成功，不发 VOICE_RECORDING_NOT_FOUND
}
```
（错误码实现时若配套后端实际返回不同则对齐，记 Ruling。）
- [ ] **Step 5: `index.ts` env 接线**（:139 后）：`const mockVoiceTranscriptDelay = parseMockVoiceTranscriptDelayEnv(process.env.CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS)`；MockBackend 构造 `...(mockVoiceTranscriptDelay !== undefined ? { transcriptDelayMs: mockVoiceTranscriptDelay } : {})`。
- [ ] **Step 6: 写测试（mock-backend-voice.spec.ts）**：`discardVoice` 五态——match 清、mismatch（另一录音活跃）throw `VOICE_RECORDING_NOT_FOUND` 且原录音不误清、realtime/dictation 活跃 throw `VOICE_SESSION_CONFLICT` 且会话不动、IDLE 幂等成功不抛；`parseMockVoiceTranscriptDelayEnv`（undefined/0/负数钳 0/超上限钳 30000/NaN→0）；`transcriptDelayMs=50` 时 stop 后 transcript 延迟到达（fake timers）；既有 `discardVoice 清 active`（:53）与空 transcript（:44）用例不回归。
- [ ] **Step 7: 运行** `pnpm -F @cyrene/desktop test`（mock-backend-voice.spec）+ `typecheck` + `lint` 绿。
- [ ] **Step 8: Commit** `feat(阶段4真实联调): MockBackend discard 冻结契约建模 + transcript 延迟 env`

---

### Task 4: real-backend 有状态协议桩测试（P0-01/P1-01 协议面）

**Files:**
- Modify: `apps/desktop/tests/unit/real-backend-voice.spec.ts`（FakeWs :23-41 扩展；makeBackend :43-72 复用）

**Interfaces:**
- Consumes: `RealBackend.startRecordVoice/discardVoice/startRealtimeVoice`（既有）；`FakeWs.push`/`sent`
- Produces: 冻结契约 + 漂移 canary 测试证据（T5/T6 引用）

- [ ] **Step 1: FakeWs 扩展为有状态虚拟后端**：增 `voiceSession: { kind: 'record'|'realtime'|'dictation'; key: string } | undefined`、`strictOldContract: boolean`；helper `setVoice(kind, key)`/`clearVoice()`/`rejectControl(code, message)`（`rejectControl` 使**下一次** start/discard 收到时自动 `push(error{code,message})` 并在 strictOldContract 下保留 voiceSession）。
- [ ] **Step 2: 冻结契约用例（spec §5.6）**：
  - `startRecordVoice(A) → discardVoice(A) → startRecordVoice(B)`：断言 `ws.sent` wire 帧序列 `[voice.record.start(rec-A), voice.discard(rec-A), voice.record.start(rec-B)]` 且全程 `events`（含 `voice.error`）与 `errors`（onError）为空（无 CONTRACT_VALIDATION / VOICE_SESSION_CONFLICT）；
  - empty/空转写序列 `<640B → stop → discard`：`stopRecordVoice(A)` 后（服务端自动 IDLE，不清 active 或已清）`discardVoice(A)` → 幂等成功、`errors` 空、`events` 无 `voice.error`；
  - `discard → discard` 重复：两次均成功、无错误帧；
  - realtime 活跃 + `discardVoice`：stub `rejectControl`（`VOICE_SESSION_CONFLICT`）→ `events/errors` 收到该错误、realtime 会话（stub voiceSession）未被误清；
  - mismatch：`startRecordVoice(A)` 后 `discardVoice(rec-X)`（X≠A）→ stub `rejectControl`（`VOICE_RECORDING_NOT_FOUND`）→ 原录音 A 未被误清。
- [ ] **Step 3: 契约漂移 canary（spec §5.6 末行）**：stub 置 `strictOldContract=true`（RECORDING 态 discard 拒 `CONTRACT_VALIDATION`）——驱动 `startRecordVoice(A)` → `discardVoice(A)`（stub **异步延迟** push `CONTRACT_VALIDATION`——`queueMicrotask`/`setTimeout 0`，对齐真实错误帧走网络到达的时序；`discardVoice` 同步体（:1054-1055 send→清 activeVoice）先跑完 → 该帧到达时 `activeVoice` 已清 → 只走 `onError`）→ 断言 `errors` 含 CONTRACT_VALIDATION（**不断言 `events` 为空**——若 push 同步则 handleErrorFrame 会额外 emit `voice.error`，本用例只验证 harness 能捕获失配，load-bearing 断言是 errors 含错误码）；再 `startRecordVoice(B)`（本地 requireNoActiveVoice 放行、wire 发出 start）→ stub 因仍持会话 A push `VOICE_SESSION_CONFLICT` → 断言 `errors/events` 含之。**目的：证明 harness 能发现「本地 active registry 已清 vs 服务端仍持会话」失配**（非生产兜底）。
- [ ] **Step 4: 运行** `pnpm -F @cyrene/desktop test`（real-backend-voice.spec）+ `typecheck` 绿。
- [ ] **Step 5: Commit** `test(阶段4真实联调): real-backend 有状态协议桩——冻结契约 + 漂移 canary`

---

### Task 5: Electron 集成测试（等待态 / 采集失败免重连 / mic 失败退出）

**Files:**
- Modify: `apps/desktop/tests/integration/electron-voice.spec.ts`
- Test: Playwright `_electron` 真实点击（沿用既有纪律：bounding box、无 force、`expect.poll`、launchApp/closeApp userData）

**Interfaces:**
- Consumes: Task 1 等待态 + 门控、Task 2 discardRecord、Task 3 `CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS`/`CYRENE_MOCK_VOICE_TRANSCRIPT` env、既有 `launchVoice()` helper（CONSENT_SETTINGS + FAKE_MEDIA）
- Produces: P0-01 §3.4 集成证据 + P1-02 §5.3 集成证据

- [ ] **Step 1: 更新用例 2（未识别，P1-02）**（:122）：`CYRENE_MOCK_VOICE_TRANSCRIPT=""` → 停后断言「正在识别…」出现（非「未识别，请重试」）+ 确认发送禁用 → 删除 → 待发送条消失、普通录音按钮恢复、连接保持（`expect.poll`，等待态断言用短窗 2s 内不出现「未识别，请重试」）。
- [ ] **Step 2: 新用例（等待态不闪烁）**：`CYRENE_MOCK_VOICE_TRANSCRIPT_DELAY_MS=1500` → 停后「正在识别…」可见 → 短窗内「未识别，请重试」不出现 → transcript 到达后字幕显示（无闪烁）→ 确认发送可用。
- [ ] **Step 3: 新用例（采集失败免重连重开三语音，P0-01 §3.4）**：`page.evaluate` 覆写 `navigator.mediaDevices.getUserMedia` 为 `() => Promise.reject(new DOMException('NotAllowedError','NotAllowedError'))`（先存原函数 `window.__origGUM`）→ 点普通录音 → composer `cy-mic-error-banner`（role=alert）+ 按钮恢复（mode idle）→ 还原 getUserMedia → 同一连接普通录音成功（**断言进入 recording 态**——证明后端已释放，无 VOICE_SESSION_CONFLICT）→ stop → **点击「删除」清理待发送条（discardRecord，断言待发送条消失 + mode 回 idle）** → 实时 start+stop → 转写 start+stop。**关键**：realtime/dictation 的 `guardStart()` 要求 `mode==='idle'`，record_pending 会静默 no-op——record stop 与 realtime start 之间必须完成 discard。实时/转写需 settings 已启用（seed 或 UI 开启，同用例 4 方式）。
- [ ] **Step 4: 新用例（设置页 mic 失败退出后聊天可立即语音，P0-01 §3.4 末条）**：stub getUserMedia reject → 设置页「测试麦克风」→ micTestError 展示 → 退出设置 → 聊天页无残留 composer banner（clearTransientErrors）→ 还原 stub → 普通录音按钮可立即启动。
- [ ] **Step 5: 运行** `pnpm -F @cyrene/desktop test:integration`（electron-voice.spec）全绿；既有 13 用例回归不变量。
- [ ] **Step 6: Commit** `test(阶段4真实联调): Electron 集成——等待态不闪烁 + 采集失败免重连 + mic 失败退出`

---

### Task 6: 文档同步 + 决策记录

**Files:**
- Modify: `docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md`（§13.1 普通录音 / §14 错误码目录）
- Modify: `docs/11-Cyrene-前端设置中心详细设计.md`（§3 待发送条/语音子页）
- Modify: `docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md`（§13 增量 Review）
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（§7/§8）
- Modify: `docs/review/2026-08-16-阶段4批次B-决策记录.md`（新增「真实联调整改」段）
- 顺带：`README.md`/`CLAUDE.md` 仅当计数/状态措辞需要（本批单测/集成计数会变，按实际更新）

**Interfaces:**
- Consumes: T1-T5 落地行为 + 测试计数；配套后端修订
- Produces: 文档口径与实现/测试一致（doc 13 增量 Review 结构回归）

- [ ] **Step 1: doc 02 §13.1（普通录音）**：`voice.discard` 语义改「可取消任意未提交阶段（RECORDING/TRANSCRIBING/PENDING）+ 幂等成功（IDLE/重复）」；删「RECORDING 态先 stop 再 discard」「IDLE 迟到 discard → NOT_FOUND」；标注依赖配套后端修订（BE-S4-RUN-P0-01）。
- [ ] **Step 2: doc 02 §14（错误码目录）**：`VOICE_RECORDING_NOT_FOUND` 补注「IDLE 迟到 discard 幂等成功，不再产生」。
- [ ] **Step 3: doc 11 §3**：停后「正在识别…」等待态 + 45s 兜底「未识别，请重试」+ 等待期试听/删除/重录可用、确认发送禁用；错误与字幕可并存。
- [ ] **Step 4: doc 13 §13**：增量 Review——阶段4 真实联调整改同步（trigger：语音语义/协议变更）；列出变更表 + 定案（R-S4-01~07 摘要）+ 结构回归 0 异常。
- [ ] **Step 5: 决策记录新增「真实联调整改」段**：R-S4-01~R-S4-07 全表 + 跨仓依赖（BE-S4-RUN-P0-01）+ 漂移 canary 定位说明 + 后续（配套后端修复 SHA 复验）。
- [ ] **Step 6: doc 16 §7/§8**：阶段4 真实联调整改落地状态（整改后仍待配套后端复验；三态保持）。
- [ ] **Step 7: 全量门禁**：`typecheck` / `lint` / `test` / `test:integration` / `build` / `check:contract`（配套后端更新 discard 样例后复跑；本批无前端 schema 镜像变更）全绿。
- [ ] **Step 8: 结构回归**：改动的 Markdown 表格列数/代码围栏/重复标题/失效相对链接 0 异常。
- [ ] **Step 9: Commit** `docs(阶段4真实联调): 文档同步——discard 幂等语义 + 等待态 + 决策记录`

---

## 任务顺序依赖

```
Task 1（等待态+门控+渲染） ──► Task 2（取消 helper+卸载，依赖 awaiting 复位）
Task 3（mock 建模+delay env）      （与 1/2 无文件冲突，Main 侧）
Task 4（协议桩测试，test-only）     （可先行，依赖仅既有 real-backend）
Task 5（Electron 集成） ◄── Task 1/2/3 全部（等待态、discard helper、delay env）
Task 6（文档同步） ◄── Task 1-5 落地 + 计数
```

执行序 1→2→3→4→5→6（SDD 串行；1/2 同文件 voice.store.ts 必须按序）。
