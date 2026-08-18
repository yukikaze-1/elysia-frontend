# 阶段 5（Live2D）批次 C（代码批次）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现批次 C 代码批次——TTS 音量口型数据源、性能四值降帧 + GPU 重建一次、后端 `live2d.directive` 冻结契约全链路、批次 A/B deferred 防御收口，产出文档/决策记录/联调清单（三态=已开发、未联调）。

**Architecture:** 在批次 A/B 之上扩展：C1 口部写出从 no-motion 分支提升为 updateAnimation 通用步骤（B3 动作后写覆盖），新建 `mouth-level.ts` 纯函数 + `tts-mouth-source.ts`（MediaElementSource→Analyser）；C2 新建 `perf.ts` `FrameBudget`（tick 内原子降帧）+ `reset(modelId?)` GPU 重建一次 + `setVisibility` 接线；C3 冻结扁平 `live2d.directive` wire 帧（raw-schemas `.strict()` → FrameMapper → BackendEventSchema 镜像 → live2dStore.handleDirective → stateSource.pushDirective，建议强度≤1 仲裁）；收口承接批次 A/B deferred。

**Tech Stack:** Vue 3 + TypeScript + Vite（renderer）、Electron（Main/Preload）、Pinia、zod、Vitest、Playwright `_electron`（xvfb/SwiftShader）、Node 22.23.0（`source ~/.nvm/nvm.sh && nvm use 22.23.0` 前缀所有 pnpm 命令）。

**Spec:** `docs/superpowers/specs/2026-08-18-phase5-live2d-batchc-closure-design.md`（binding authority，本 plan 从 spec 论证）

## Global Constraints

- **三态纪律**：Mock/本地驱动工作只标「已开发、未联调」，不标「已完成」；真实 Windows Electron 联调由开发者事后凭联调清单执行。
- **信任边界**：renderer 不可信——只消费 cyrene:// 已校验资源；参数 Id 字符串；动作/表情/指令一律白名单（controller 本地副本 + adapter assert + Main resolveModelFile 三层）；**不新增 IPC 通道**（C3 走既有 `chat:event` push + preload `parseBackendEvent`）。
- **契约纪律**：所有 wire 变更须同步四件套 + 文档：① raw 帧类型（`protocol-v2/raw-types.ts`）② raw-schemas（`.strict()`）③ `FrameMapper.mapFrame` ④ `shared/contracts/events.ts`（BackendEvent 联合）+ `shared/schemas/events.ts`（BackendEventSchema 镜像）——缺一不可；doc02 §19 映射表无条件记录。
- **`live2d.directive` 冻结契约**：扁平帧 `{type:'live2d.directive', expression?, motion?, state?, priority?(0-3), durationMs?}`；`DirectiveState` 七值 `idle|listening|thinking|speaking|happy|sad|surprised`（**剔除 error**）；`.strict()` 未知字段整帧拒 + 脱敏日志（拒帧走 Main 既有 `parseRawFrame` 失败路径的脱敏日志，不新增）。
- **建议强度仲裁**：`pushDirective` 比较基准 = `clampedStrength(≤1) ≥ 当前机器优先级` 才 push；指令**永不覆盖** client 2/3 级现实态；状态自然优先级只决定表现。
- **口部门**：lipSync 只门控 C1/B4 参数级电口；B3 动作口部不受门；口部写出通用步骤替换 controller.ts:430-432 旧 M5 门块（不叠加双写）；`lipSync`/`autoMotions` 关 → 电口写 0。
- **durationMs**：`min(durationMs, MOTION_MAX_MS=15000)`。
- 所有 doc 编辑用中文；三态与计数同步 README/CLAUDE/doc05/10/11/16。
- 全程 `nvm use 22.23.0`；`pnpm -F @cyrene/desktop <script>`（或 repo 根 `pnpm <script>`）。
- **测试 API 约定**（本仓库实测）：`parseRawFrame`/`parseBackendEvent` 均返回 `{success: true, data} | {success: false, error}`（**不返回帧本体、不为 null**），断言一律 `.success` + `.data`；controller 单测用 `live2d-controller.spec.ts` 的 `makeHarness()`/`stubHandle(adapter, {params, motions, expressions})`/`h.getHandle()`，param 写断言走 `handle.setParam.mock.calls`（无 `paramWrites` 数组）；store 单测文件是 `live2d.spec.ts`（非 `live2d.store.spec.ts`）；事件 envelope 字段是 `eventId/sequence/timestamp`（非 `occurredAt`）。

---

### Task 1: C3 契约层（wire 四件套 + shared contract）

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-types.ts`（`RawLive2DDirective` 类型 + RawFrame 联合增员）
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`（`RawLive2DDirectiveSchema` + 判别联合成员）
- Modify: `apps/desktop/src/main/transport/protocol-v2/frame-mapper.ts`（`mapFrame` 分支 + `mapDirective`）
- Modify: `apps/desktop/src/shared/contracts/events.ts`（`Live2DDirectiveEvent` 扁平 + `BackendEvent` 联合增员）
- Modify: `apps/desktop/src/shared/schemas/events.ts`（`BackendEventSchema` 增 `Live2DDirectiveEventSchema`）
- Test: `apps/desktop/tests/unit/raw-schemas.spec.ts`、`apps/desktop/tests/unit/schemas.spec.ts`、`apps/desktop/tests/unit/frame-mapper.spec.ts`（跟随现有文件扩用例）

**Interfaces:**
- Consumes: 现有 `parseRawFrame`（raw-schemas.ts:330-338，返回 `{success,data}|{success:false,error}`）、`FrameMapper.mapFrame(frame): BackendEvent | null`（frame-mapper.ts:42）、`BackendEventSchema`（schemas/events.ts:173-195）、`parseBackendEvent`（schemas/events.ts:197-205，返回 `{success,data}`）、envelope 外壳 helper `this.envelope()`（frame-mapper.ts:102-105）。
- Produces:
  - `DirectiveState = 'idle'|'listening'|'thinking'|'speaking'|'happy'|'sad'|'surprised'`（七值，`raw-types.ts` + `events.ts` 各一）
  - `interface RawLive2DDirective { type: 'live2d.directive'; expression?: string; motion?: string; state?: DirectiveState; priority?: 0|1|2|3; durationMs?: number }`（并入 `RawFrame` 联合）
  - `interface Live2DDirectiveEvent extends BackendEventEnvelope { event: 'live2d.directive'; expression?: string; motion?: string; state?: DirectiveState; priority?: 0|1|2|3; durationMs?: number }`（扁平，并入 `BackendEvent` 联合）
  - `BackendEventSchema` 新增成员（`parseBackendEvent` 收得该事件）

- [ ] **Step 1: 写失败测试——raw-schemas 识别 `live2d.directive` 合法帧 / 拒非法 / 镜像收得 / FrameMapper 映射**

```ts
import { describe, expect, it } from 'vitest'
import { parseRawFrame } from '../src/main/transport/protocol-v2/raw-schemas'
import { parseBackendEvent } from '../src/shared/schemas/events'
import { FrameMapper } from '../src/main/transport/protocol-v2/frame-mapper'

describe('live2d.directive wire 契约（Task 1）', () => {
  it('合法扁平帧经 parseRawFrame 通过；非法 state / .strict() 未知字段整帧拒', () => {
    const ok = parseRawFrame({ type: 'live2d.directive', state: 'happy', expression: 'expressions/F01.exp3.json', priority: 1 })
    expect(ok.success).toBe(true)
    if (ok.success) { expect(ok.data.type).toBe('live2d.directive'); expect(ok.data.state).toBe('happy') }
    expect(parseRawFrame({ type: 'live2d.directive', state: 'working' as never }).success).toBe(false)
    expect(parseRawFrame({ type: 'live2d.directive', state: 'happy', unknown_field: 1 }).success).toBe(false)
    expect(parseRawFrame({ type: 'live2d.directive', priority: 5 }).success).toBe(false) // priority 越界 0-3
  })
  it('BackendEventSchema 镜像收得该事件（envelope 用 eventId/sequence/timestamp）', () => {
    const ev = { event: 'live2d.directive' as const, state: 'happy' as const, sequence: 1, eventId: 'e1', timestamp: '2026-08-18T00:00:00Z' }
    const r = parseBackendEvent(ev)
    expect(r.success).toBe(true)
    if (r.success) { expect(r.data.event).toBe('live2d.directive'); expect(r.data.state).toBe('happy') }
  })
  it('FrameMapper.mapFrame 把 raw 帧映射为 Live2DDirectiveEvent', () => {
    const m = new FrameMapper()
    const ev = m.mapFrame({ type: 'live2d.directive', motion: 'motions/idle.motion3.json', durationMs: 8000 })
    expect(ev).not.toBeNull()
    if (ev) { expect(ev.event).toBe('live2d.directive'); if (ev.event === 'live2d.directive') expect(ev.motion).toBe('motions/idle.motion3.json') }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `source ~/.nvm/nvm.sh && nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- --run <测试文件>`
Expected: FAIL——`parseRawFrame` 不识别 `live2d.directive`（`.success === false`）、`parseBackendEvent` 丢弃该事件、`FrameMapper` 未处理该 type（返回 null）。

- [ ] **Step 3: 实现契约四件套**

`raw-types.ts`：定义 `DirectiveState` 七值联合 + `RawLive2DDirective`（见 Interfaces），并入 `RawFrame` 联合（raw-types.ts:326 起）。
`raw-schemas.ts`：`const RawLive2DDirectiveSchema = z.object({ type: z.literal('live2d.directive'), expression: z.string().optional(), motion: z.string().optional(), state: z.enum(['idle','listening','thinking','speaking','happy','sad','surprised']).optional(), priority: z.number().int().min(0).max(3).optional(), durationMs: z.number().int().min(0).max(30000).optional() }).strict()`；并入 `RawFrameSchema` 判别联合（未知字段由 `.strict()` 整帧拒）。
`frame-mapper.ts`：`mapFrame` switch 增 `case 'live2d.directive': return this.mapDirective(frame)`；`mapDirective` 用 **`this.envelope()`**（frame-mapper.ts:102-105，eventId=`${connectionId}:${sequence}`，对齐相邻 mapXxx）组装 `Live2DDirectiveEvent`（扁平字段，undefined 不写键）。
`contracts/events.ts`：定义扁平 `Live2DDirectiveEvent`（见 Interfaces）+ 并入 `BackendEvent` 联合。
`schemas/events.ts`：增 `Live2DDirectiveEventSchema`（z.object：`event: z.literal('live2d.directive')` + 七值 state enum + 各可选字段 + `.strict()`），并入 `BackendEventSchema` 判别联合（schemas/events.ts:173-195）。
（`contracts/backend.ts` **不改**——raw 帧类型归 `protocol-v2/raw-types.ts`，非该文件。）

- [ ] **Step 4: 运行测试确认通过**

Run: 同上。Expected: PASS。

- [ ] **Step 5: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`。Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/raw-types.ts apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts apps/desktop/src/main/transport/protocol-v2/frame-mapper.ts apps/desktop/src/shared/contracts/events.ts apps/desktop/src/shared/schemas/events.ts <测试文件>
git commit -m "feat(阶段5批次C): C3 wire 契约——live2d.directive 扁平帧四件套（raw-schema .strict / FrameMapper / BackendEvent + schema 镜像）"
```

---

### Task 2: C1 TTS 音量口型（mouth source + 包络纯函数 + 口部写出通用化）

**Files:**
- Create: `apps/desktop/src/renderer/src/live2d/mouth-level.ts`（纯函数 `computeMouthLevel`）
- Create: `apps/desktop/src/renderer/src/live2d/tts-mouth-source.ts`（`MouthLevelSource` + `createTtsMouthSource` + 可注入工厂）
- Modify: `apps/desktop/src/renderer/src/stores/voice.store.ts`（`ttsAudioEl` ref + 导出）
- Modify: `apps/desktop/src/renderer/src/components/CyTtsPlayer.vue`（`onMounted/onUnmounted` 设/清 `ttsAudioEl`）
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`（口部写出通用化：updateAnimation 内对全部 ready 模型写 `ParamMouthOpenY`，**替换** b4Params 内口部写（controller.ts:456-460）+ 旧 M5 门块（controller.ts:430-432）；lipSync/autoMotions 关 → 写 0）
- Modify: `apps/desktop/src/renderer/src/stores/live2d.store.ts`（持 `TtsMouthSource` + `setMouthSourceFactory` 注入点 + watch `[tts.playing, ttsAudioEl]` + tick 采样 + `mockMouthLevel` 合成源选择）
- Modify: `apps/desktop/src/main/chat/chat-service.ts`（`getRuntimeInfo()` 装配 `mockMouthLevel`）+ `apps/desktop/src/main/index.ts`（读 `CYRENE_MOCK_MOUTH_LEVEL` env 传参）+ `apps/desktop/src/shared/schemas/ipc-response.ts`（`RuntimeInfoSchema` 增 `mockMouthLevel?`）+ `apps/desktop/src/preload/desktop-api.ts`（类型随 schema）
- Test: `apps/desktop/tests/unit/mouth-level.spec.ts`、`apps/desktop/tests/unit/live2d-controller.spec.ts`（口部写出）、`apps/desktop/tests/unit/live2d.spec.ts`（采样接线 + setMouthSourceFactory）、集成 `apps/desktop/tests/integration/electron-live2d.spec.ts`

**Interfaces:**
- Consumes: `voiceStore.tts.playing`/`tts.url`（voice.store.ts:50,183-190）、`controller.setMouthLevel(level)`（controller.ts:306）、`controller.tick()`（live2d.store.ts:241）、`api.getRuntimeInfo()`（desktop-api.ts:208）、`RuntimeInfoSchema`（ipc-response.ts:36，`{mode,packaged}` 增 `mockMouthLevel?`）、`live2d.spec.ts` 的 `setLive2dControllerFactory`/`makeFakeAdapter` 先例。
- Produces:
  - `computeMouthLevel(rms: number, prevLevel: number, opts?: {noiseFloor?: number; attackMs?: number; releaseMs?: number; dtMs?: number}): number`——**硬门限语义**：`rms < noiseFloor` 直接返回 `0`（doc 05 §10「噪声门限」），否则一阶平滑（rise 用 attackMs / fall 用 releaseMs）。
  - `interface MouthLevelSource { attach(el: HTMLAudioElement): void; detach(): void; sample(): number; dispose(): void }` + `createTtsMouthSource(analyserFactory?): MouthLevelSource`
  - `voiceStore.ttsAudioEl: Ref<HTMLAudioElement|null>`
  - `live2dStore.setMouthSourceFactory(fn: () => MouthLevelSource): void`（对齐 controllerFactory 先例）
  - controller 口部写出：updateAnimation 内通用步骤（lipSync∧autoMotions ? mouthLevel : 0 → ParamMouthOpenY，存在性判定）
  - `mockMouthLevel: 'step'|'sine'|undefined`（源自 `api.getRuntimeInfo()`）

- [ ] **Step 1: 写失败测试——mouth-level 纯函数（硬门限 + 攻放不对称 + 收敛）**

```ts
import { describe, expect, it } from 'vitest'
import { computeMouthLevel } from '../src/renderer/src/live2d/mouth-level'

describe('computeMouthLevel（C1 包络纯函数，硬门限语义）', () => {
  it('噪声门限：rms 低于 floor 直接归 0（硬门）', () => {
    expect(computeMouthLevel(0.005, 0.5, { noiseFloor: 0.02, dtMs: 16 })).toBe(0)
  })
  it('attack 快：单帧升幅 < 满幅且明显；多帧逼近 1', () => {
    const one = computeMouthLevel(1, 0, { dtMs: 16, attackMs: 50 })
    expect(one).toBeGreaterThan(0.2)
    expect(one).toBeLessThan(0.5) // 50ms attack 单帧 16ms 不可能满幅
    let l = 0
    for (let i = 0; i < 6; i++) l = computeMouthLevel(1, l, { dtMs: 16, attackMs: 50 })
    expect(l).toBeGreaterThan(0.8)
  })
  it('release 慢：单帧降幅小；多帧归零（rms 取 ==floor 使平滑可观测，硬门限下 rms<floor 直接归 0）', () => {
    const one = computeMouthLevel(0.02, 1, { dtMs: 16, releaseMs: 250 }) // 0.02==floor → 走平滑分支
    expect(one).toBeGreaterThan(0.85) // 0.937
    let l = 1
    for (let i = 0; i < 60; i++) l = computeMouthLevel(0.02, l, { dtMs: 16, releaseMs: 250 })
    expect(l).toBeLessThan(0.05) // ≈0.039
  })
  it('[0,1] 边界钳制', () => {
    expect(computeMouthLevel(2, 0.5, { dtMs: 16 })).toBeLessThanOrEqual(1)
    expect(computeMouthLevel(-1, 0.5, { dtMs: 16 })).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test -- --run <mouth-level.spec.ts>`。Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `mouth-level.ts`**

硬门限：`if (rms < noiseFloor) return 0`（`noiseFloor` 缺省 0.02）；`target = clamp01(rms)`；`alpha = dtMs / (target > prevLevel ? attackMs : releaseMs)`（缺省 attackMs 50 / releaseMs 250 / dtMs 16）；`next = prevLevel + (target - prevLevel) * Math.min(1, alpha)`；返回 `clamp01(next)`。**单测数学自洽**：`(1,0,{dtMs:16,attackMs:50})` = 0+1×0.32 = 0.32（>0.2 且 <0.5），6 帧 ≈ 0.901（>0.8）；`(0.02,1,{dtMs:16,releaseMs:250})` = 1+(0.02-1)×0.064 = 0.937（>0.85，rms==floor 走平滑），60 帧 ≈ 0.02+0.98×0.936^60 ≈ 0.039（<0.05）；`(0.005,...)` rms<floor → 硬门直接 0。

- [ ] **Step 4: 运行确认通过**

Run: 同上。Expected: PASS。

- [ ] **Step 5: 实现 `tts-mouth-source.ts` + RuntimeInfo 桥**

`tts-mouth-source.ts`：`createTtsMouthSource(analyserFactory?)`——内部持 `AudioContext`（懒建）、`AnalyserNode`、prevLevel；`attach(el)`：`ctx = new AudioContext(); const src = ctx.createMediaElementSource(el); analyser = ctx.createAnalyser(); analyser.fftSize = 256; src.connect(analyser).connect(ctx.destination); void ctx.resume()`（每元素仅一次，重复 attach 幂等）；`sample()`：`getFloatTimeDomainData(buf)` → `rms = sqrt(mean(buf^2))` → `computeMouthLevel(rms, prevLevel)`；`detach()`：断开 + `ctx.suspend()` + prevLevel=0；`dispose()`：`ctx.close()`。`analyserFactory` 注入点返回 `{ analyser, context }`（集成假源）。
RuntimeInfo 桥：`ipc-response.ts` `RuntimeInfoSchema` 增 `mockMouthLevel: z.enum(['step','sine']).optional()`；`main/index.ts` 读 `CYRENE_MOCK_MOUTH_LEVEL` env（parser 复用 mock env 模式，undefined/非法 → undefined）→ 传 `chat-service.getRuntimeInfo()` 装配 `mockMouthLevel`（仅 mock 模式填充）；`desktop-api.ts` 类型随 schema。

- [ ] **Step 6: voiceStore + CyTtsPlayer 接线**

`voice.store.ts`：`export const ttsAudioEl = ref<HTMLAudioElement | null>(null)`。`CyTtsPlayer.vue`：`onMounted(() => { voiceStore.ttsAudioEl.value = audioRef.value ?? null })`、`onUnmounted(() => { voiceStore.ttsAudioEl.value = null })`。

- [ ] **Step 7: controller 口部写出通用化 + 写失败测试（用现有 harness）**

`controller.ts` `updateAnimation`：anim 参数写后新增通用口部步骤——`if (this.paramIds.has(PARAM_MOUTH_OPEN_Y)) handle.setParam(PARAM_MOUTH_OPEN_Y, mouthLevelTarget(this.lipSync && this.autoMotions ? this.mouthLevel : 0, this.paramIds))`；**移除** b4Params 内口部写（controller.ts:456-460）与旧 M5 门块（controller.ts:430-432）。测试（`live2d-controller.spec.ts`，用现有 `makeHarness`/`stubHandle`/`getHandle`）：
```ts
it('口部写出对所有 ready 模型生效（有动作 fake 也写）；lipSync 关 → 电口写 0', async () => {
  const h = makeHarness()
  stubHandle(h.adapter, { params: ['ParamMouthOpenY'], motions: ['motions/idle.motion3.json'], expressions: [] })
  await h.ctrl.init(fakeCanvas) // whitelist/cacheModelFacts 在 switchModel 后填充；fakeCanvas 用现有 spec 夹具
  const handle = h.getHandle()
  h.ctrl.setState('speaking'); h.ctrl.setMouthLevel(0.8)
  h.ctrl.tick()
  const mouthWrites = handle.setParam.mock.calls.filter((c) => c[0] === 'ParamMouthOpenY')
  expect(mouthWrites.length).toBeGreaterThan(0) // 有动作模型电口也被写
  h.ctrl.setLipSync(false); h.ctrl.tick()
  const last = handle.setParam.mock.calls.filter((c) => c[0] === 'ParamMouthOpenY').at(-1)
  expect(last?.[1]).toBe(0) // lipSync 关 → 电口写 0 清态
})
it('B3 动作后写覆盖电口：tick 后口部最终值 = 动作值（adapter.update 覆写）', async () => {
  const h = makeHarness()
  stubHandle(h.adapter, { params: ['ParamMouthOpenY'], motions: ['motions/idle.motion3.json'], expressions: [] })
  await h.ctrl.init(fakeCanvas)
  const handle = h.getHandle()
  // 模拟 motion manager 后写：adapter.update 时把 ParamMouthOpenY 覆写为动作值 0.5
  vi.spyOn(h.adapter, 'update').mockImplementation(() => { handle.setParam('ParamMouthOpenY', 0.5) })
  h.ctrl.setState('speaking'); h.ctrl.setMouthLevel(0.8)
  h.ctrl.tick()
  const last = handle.setParam.mock.calls.filter((c) => c[0] === 'ParamMouthOpenY').at(-1)
  expect(last?.[1]).toBe(0.5) // 动作值赢（updateAnimation 口部写 → adapter.update 覆写顺序钉死）
})
```
（若现有 fake adapter 的 `update` 不可 spy（非 vi.fn），实现时给 fake adapter 增 `update` 为 vi.fn 或注入 `onUpdate` 钩子——见 Task 内实现说明；断言目标不变：anim 口部写在 adapter.update 覆写之前、最终值=动作值。）

- [ ] **Step 8: live2dStore 采样接线 + 写失败测试（用现有 live2d.spec.ts 基建）**

`live2d.store.ts`：新增 `setMouthSourceFactory(fn)`（模块级注入点，对齐 `setLive2dControllerFactory` 先例）；持 `mouthSource`（`createTtsMouthSource()`，或 `mockMouthLevel` 设时用合成 step/sine 源）；store init 时 `const rt = await api.getRuntimeInfo().catch(() => undefined); mockMouthLevel = rt?.mockMouthLevel`（**守卫**——现有 `live2d.spec.ts` 的 `mockApi.getRuntimeInfo` 无实现返回 undefined，未守卫会砸既有 store 用例；同时给 `live2d.spec.ts` mockApi 补 `getRuntimeInfo: vi.fn(async () => ({ mode: 'mock', packaged: false }))`）；watch `[() => voiceStore.tts.playing, () => voiceStore.ttsAudioEl.value]` → playing∧有元素 `attach(el)`、否则 `detach()`；`tick()` 内 `if (attached) controller.setMouthLevel(mouthSource.sample())`。测试（`live2d.spec.ts`，用 `setMouthSourceFactory` 注入确定性 step 源）：`tick` 后 controller 收到递增/递减 mouthLevel；detach 后归 0；`mockMouthLevel='step'` 时选合成源（fake getRuntimeInfo 断言）。

- [ ] **Step 9: 集成测试（CYRENE_MOCK_MOUTH_LEVEL，先激活 TTS Profile）**

`electron-live2d.spec.ts`：`launchL2d(ud, { CYRENE_MOCK_MOUTH_LEVEL: 'step' })` → **先激活 TTS Profile**（`activateModelProfile({service:'tts'...})` 或设置路径，P4-B 先例 `electron-voice.spec.ts`——mock 仅在 `ttsActive` 时发 `audio.session.ready`）→ 发送文本（autoReadReply 开）→ 断言 `setMouthLevel` 被调用且值随 step 序列变化（渲染层测试探针：dev 下暴露 `window.__cyreneTest?.getMouthLevel?.()`，或经 state 导出）→ 停止 → 归 0。真实 Analyser RMS 准确性归联调肉眼验证。

- [ ] **Step 10: typecheck + lint + 单测 + 集成**

Run: `pnpm typecheck && pnpm lint && pnpm test && xvfb-run -a pnpm test:integration`。Expected: 全绿。

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/renderer/src/live2d/mouth-level.ts apps/desktop/src/renderer/src/live2d/tts-mouth-source.ts apps/desktop/src/renderer/src/stores/voice.store.ts apps/desktop/src/renderer/src/components/CyTtsPlayer.vue apps/desktop/src/renderer/src/live2d/controller.ts apps/desktop/src/renderer/src/stores/live2d.store.ts apps/desktop/src/main/chat/chat-service.ts apps/desktop/src/main/index.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/preload/desktop-api.ts <测试文件>
git commit -m "feat(阶段5批次C): C1 TTS 口型——包络纯函数 + MouthLevelSource + 口部写出通用化（替换 M5 门块）+ 采样接线 + mock env 桥"
```

---

### Task 3: C2 性能降级（FrameBudget）+ GPU 重建一次 + 可见性收口

**Files:**
- Create: `apps/desktop/src/renderer/src/live2d/perf.ts`（`FrameBudget`）
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`（`tick()` 插入 FrameBudget 门 + `feedCost`；持 `budget`；`setPerformanceMode` → `budget.setMode`；`reset(modelId?)` 扩展）
- Modify: `apps/desktop/src/renderer/src/stores/live2d.store.ts`（device_lost → 一次 `reset(当前 modelId)` + 重放 settings/CharacterState + rAF 重启；`setVisibility` 接线）
- Modify: `apps/desktop/src/renderer/src/components/CyLive2DPanel.vue`（如需：重建成功后 rAF 重启通知）
- Test: `apps/desktop/tests/unit/perf.spec.ts`、`apps/desktop/tests/unit/live2d-controller.spec.ts`（reset/可见性）、`apps/desktop/tests/unit/live2d.spec.ts`（device_lost 重建 + setVisibility 接线）、集成 `electron-live2d.spec.ts`（四值切换 + contextlost）

**Interfaces:**
- Consumes: `controller.perfMode`（controller.ts:90,256）、`controller.tick()` 现含 `if (this.currentStatus !== 'ready' || !this.visible) return`（controller.ts:207）、`controller.reset()`（controller.ts:226-248）、`controller.emit('device_lost')` 后 `setStatus('fallback')`（controller.ts:216-217）、store 现有 device_lost 镜像（live2d.store.ts:110-112）。
- Produces:
  - `class FrameBudget { constructor(mode: PerformanceMode, now?: number); shouldDraw(now: number): boolean; setMode(mode: PerformanceMode): void; feedCost(costMs: number): void }`——**首帧必画**（首次 `shouldDraw` 恒 true，`lastDrawMs` 构造时初始化为 `now`），EMA 初值 = 首样本。
  - `controller.reset(modelId?: string): Promise<void>`（modelId 有值且 available → 重载之；否则首个可用；失败 → fallback）
  - `live2dStore` 把「布局可见 ∧ enabled」→ `controller.setVisibility(v)`（store 侧接线，消除死面）

- [ ] **Step 1: 写失败测试——FrameBudget 纯逻辑（首帧必画语义，测试与实现自洽）**

```ts
import { describe, expect, it } from 'vitest'
import { FrameBudget } from '../src/renderer/src/live2d/perf'

describe('FrameBudget（C2 四值降帧；首帧必画，lastDrawMs 初值=构造 now）', () => {
  it('quality 恒 draw', () => {
    const b = new FrameBudget('quality', 0)
    expect(b.shouldDraw(0)).toBe(true)
    expect(b.shouldDraw(16)).toBe(true)
  })
  it('low_power 30fps 封顶：首帧必画，之后 ≥33ms 才 draw', () => {
    const b = new FrameBudget('low_power', 0)
    expect(b.shouldDraw(0)).toBe(true)   // 首帧
    expect(b.shouldDraw(20)).toBe(false) // 距首帧 20ms < 33
    expect(b.shouldDraw(40)).toBe(true)  // ≥33ms
  })
  it('balanced 按 cost 在 60/30 间切（首帧后按目标间隔）', () => {
    const b = new FrameBudget('balanced', 0)
    expect(b.shouldDraw(0)).toBe(true)   // 首帧
    b.feedCost(12)                        // 高耗时 → 30fps
    expect(b.shouldDraw(20)).toBe(false)  // 距首帧 20ms < 33
    b.feedCost(3); b.feedCost(3); b.feedCost(3) // 低耗时 → 60fps
    expect(b.shouldDraw(50)).toBe(true)   // 距首帧 50ms ≥ 16.67
  })
  it('auto 迟滞升降档 + setMode 热切换', () => {
    const b = new FrameBudget('auto', 0)
    expect(b.shouldDraw(0)).toBe(true)
    for (let i = 0; i < 12; i++) b.feedCost(20) // 持续高耗时 → 降 30fps
    expect(b.shouldDraw(30)).toBe(false)
    b.setMode('quality')
    expect(b.shouldDraw(30)).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm -F @cyrene/desktop test -- --run <perf.spec.ts>`。Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `perf.ts`（首帧语义钉死）**

`FrameBudget`：构造存 `mode`、`lastDrawMs = now`（构造时刻）、`emaCost = 0`、`first = true`、`autoTarget = 60`、`slowStreak/fastStreak = 0`。`shouldDraw(now)`：`if (first) { first = false; return true }`；按 mode 定目标间隔——quality→`true`；low_power→`now - lastDrawMs >= 33.33`；balanced→`target = emaCost < 8 ? 16.67 : 33.33`，`now - lastDrawMs >= target`；auto→按 streak 迟滞升降 `autoTarget`（`emaCost > 16` 连续 ≥12 帧 → 30；`emaCost < 8` 连续 ≥12 帧 → 60；初 60），`target = autoTarget===60 ? 16.67 : 33.33`；命中 draw 时更新 `lastDrawMs = now`。`feedCost(c)`：`emaCost = emaCost === 0 ? c : emaCost * 0.8 + c * 0.2`（EMA 初值 = 首样本）。`setMode(m)`：重置 `autoTarget=60`、streaks、`first=true`。

- [ ] **Step 4: 运行确认通过**

Run: 同上。Expected: PASS。

- [ ] **Step 5: controller 消费 + store setVisibility 接线 + 写失败测试**

`controller.ts`：持 `budget = new FrameBudget(this.perfMode)`；`tick()`：`if (this.currentStatus !== 'ready' || !this.visible) return`（**已存在**，controller.ts:207，不改）→ 其后插入 `const now = performance.now(); if (!this.budget.shouldDraw(now)) return`（skip 帧：不 updateAnimation、不 adapter.update，不产生 draw）→ `const t0 = performance.now(); this.updateAnimation(now); this.adapter.update(); this.budget.feedCost(performance.now() - t0)`。`setPerformanceMode(m)`：`this.perfMode = m; this.budget?.setMode(m)`。
`live2d.store.ts`：watcher 将「布局可见 ∧ enabled」→ `controller.setVisibility(v)`（init + 布局/设置变化时）。测试（**红优先**——controller 级 `!visible` 门已存在（controller.ts:207），真正的「红」是 store 未接线）：`store` 布局不可见 → 断言 fake controller 收到 `setVisibility(false)`（vi.fn 调用记录）且其 tick 无 update/draw；可见恢复 → `setVisibility(true)`。**skip 帧仍执行视线 lerp 注记**：Panel loop 的 `applyLookTween` 独立于 controller.tick（CyLive2DPanel.vue:197-203），skip 帧仍执行——不改 Panel，加注释留档（D5C-03）。

- [ ] **Step 6: `reset(modelId?)` 扩展 + device_lost 一次重建 + 写失败测试（rebuildGuard finally 复位）**

`controller.reset(modelId?)`：`unload()` → `adapter.initialize(canvas)`（失败→`fallback`）→ `list()` → 目标 = `modelId` 且 available ? modelId : 首个 available → 无 available → `fallback`；`switchModel(目标)`。
`live2d.store.ts` device_lost：`if (rebuildGuard) { 镜像 fallback; return }` → `rebuildGuard = true` → `try { await controller.reset(controller.modelId); status='ready'; 重放 settings（autoMotions/lipSync/performanceMode/scale/offset/lookTarget，复用 init 重放点 live2d.store.ts:159-162）; 恢复当前 CharacterState（stateSource 重组合）; 通知 Panel 重启 rAF（status→ready 触发 active watcher） } finally { rebuildGuard = false }`（**finally 复位——满足 spec「非永久」，与 reset 内部 switchModel 无关**）。测试（`live2d.spec.ts`，fake adapter 计数）：device_lost → reset 被调一次 + 重放 settings/lookTarget；重建 await 中再 device_lost → 不二次触发；重建失败 → fallback；成功后新 device_lost → 再次重建（guard 已复位）。**随重建核查批次 A Task5 P3 半初始化**：adapter.initialize 抛错时已建 context/handle 须释放（try/finally），补测试断言无泄漏。

- [ ] **Step 7: 集成测试（四值切换 + contextlost）**

`electron-live2d.spec.ts`：`setPerformanceMode('low_power')` → 渲染不崩 + 设置持久化；`dispatchEvent(new Event('webglcontextlost'))` → 断言一次重建（status 回 ready 或 fallback，不崩；SwiftShader 以「不崩 + 状态机合法」为准）。

- [ ] **Step 8: typecheck + lint + 单测 + 集成**

Run: `pnpm typecheck && pnpm lint && pnpm test && xvfb-run -a pnpm test:integration`。Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/live2d/perf.ts apps/desktop/src/renderer/src/live2d/controller.ts apps/desktop/src/renderer/src/stores/live2d.store.ts apps/desktop/src/renderer/src/components/CyLive2DPanel.vue <测试文件>
git commit -m "feat(阶段5批次C): C2 性能降级——FrameBudget 四值降帧 + GPU 重建一次（reset(modelId?) finally 复位 + 重放）+ setVisibility 接线"
```

---

### Task 4: C3 指令消费（mock/real 桩 + store + state-source + controller 接口）

> **依赖 Task 1 契约**（`Live2DDirectiveEvent`/`BackendEventSchema` 镜像）——若 Task 1 返工，本 task 接口面同步变。

**Files:**
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（`parseMockDirectiveEnv` + scheduleReplay 发射）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（`live2d.directive` 解析分支——default 静默已盖形状不符，不需运行时 canary）
- Modify: `apps/desktop/src/main/index.ts`（env → mock-backend 传参）
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`（`setExpression`/`playMotion` 返回 boolean + `playMotion(file, priority, durationMs?)`）
- Modify: `apps/desktop/src/renderer/src/live2d/state-source.ts`（`pushDirective`：注入 `getCurrentPriority` getter + 建议强度仲裁 + `clearMoodTimer`（既有函数名）+ 丢弃语义）
- Modify: `apps/desktop/src/renderer/src/stores/live2d.store.ts`（`handleDirective` + 事件接线 + 脱敏日志 + 指令>emotion 时序）
- Test: `apps/desktop/tests/unit/live2d-controller.spec.ts`、`apps/desktop/tests/unit/live2d-state-source.spec.ts`、`apps/desktop/tests/unit/live2d.spec.ts`、集成 `electron-live2d.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `Live2DDirectiveEvent`；`stateMachine.priority` getter（state-machine.ts:111-113）；`pushRecomposed()`（state-source.ts:97-111）；mock env parser 模式（mock-backend.ts:92-136）+ generation.completed 注入点（mock-backend.ts:670-678）；`makeHarness`/`stubHandle`（live2d-controller.spec.ts:51-114）。
- Produces:
  - `controller.setExpression(file: string): boolean`（白名单命中执行返回 true；未命中 false）
  - `controller.playMotion(file: string, priority: number, durationMs?: number): boolean`（durationMs 生效时以 `min(durationMs, MOTION_MAX_MS)` 为超时；未命中/被仲裁丢弃 false）
  - `live2dStateSource` 支持 `{ getCurrentPriority: () => number }` 注入；`pushDirective(state: CharacterState, strength: number, durationMs?: number): void`
  - `live2dStore.handleDirective(event: Live2DDirectiveEvent): void`
  - `parseMockDirectiveEnv(value: string | undefined): Omit<RawLive2DDirective,'type'> | undefined`（复用 Task 1 的 `RawLive2DDirective`）

- [ ] **Step 1: controller 接口改造 + 写失败测试（真实断言）**

`controller.ts`：
- `setExpression(file)`：`if (!handle || !this.expressionWhitelist.has(file)) return false; this.handle.startExpression(...); return true`。
- `playMotion(file, priority, durationMs?)`：现签名（controller.ts:341）扩第三参；白名单未命中 → return false；命中按现仲裁（priority<cur → return false）→ `startMotion`；**durationMs 覆盖超时**：`durationMs !== undefined` 时以 `min(durationMs, MOTION_MAX_MS)` 为 `setTimeout(stopMotion, ...)`，否则沿用 MOTION_MAX_MS。
测试（`live2d-controller.spec.ts`，现有 harness）：
```ts
it('setExpression/playMotion 返回白名单命中 boolean；playMotion durationMs 以 15s 封顶', async () => {
  const h = makeHarness()
  stubHandle(h.adapter, { params: [], motions: ['motions/idle.motion3.json'], expressions: ['expressions/F01.exp3.json'] })
  await h.ctrl.init(fakeCanvas) // whitelist 仅在 switchModel 后 cacheModelFacts 填充
  expect(h.ctrl.playMotion('motions/not-in-whitelist.motion3.json', 1)).toBe(false)
  const spy = vi.spyOn(globalThis, 'setTimeout')
  expect(h.ctrl.playMotion('motions/idle.motion3.json', 1, 30000)).toBe(true)
  expect(spy.mock.calls.some((c) => c[1] === 15000)).toBe(true) // min(30000, 15000) 封顶
  spy.mockClear()
  expect(h.ctrl.playMotion('motions/idle.motion3.json', 1, 5000)).toBe(true)
  expect(spy.mock.calls.some((c) => c[1] === 5000)).toBe(true) // durationMs 透传（<15s 不改写）
  expect(h.ctrl.setExpression('expressions/not-in-whitelist.exp3.json')).toBe(false)
  expect(h.ctrl.setExpression('expressions/F01.exp3.json')).toBe(true)
})
```

- [ ] **Step 2: 运行确认失败 → 实现 → 确认通过**

Run: `pnpm -F @cyrene/desktop test -- --run <live2d-controller.spec.ts>`。

- [ ] **Step 3: state-source `pushDirective` + 写失败测试（真实 client 态路径 + 注入优先级）**

`state-source.ts`：`createLive2dStateSource` 选项增 `getCurrentPriority?: () => number`（缺省读自身 `currentState` 优先级镜像——镜像在**所有**机器优先级变化时同步，含 client setState/processEvent 与指令 push；生产接线由 live2dStore 把真实优先级 getter 注入）。`pushDirective(state, strength, durationMs?)`：`strength = clamp01?≤1`（越界钳 1）；**入口守卫**：`strength ≥ (getCurrentPriority?.() ?? currentPriorityMirror)` 才置入 `directiveOverride = {state, until: now+durationMs}`，否则丢弃（只记最新）；置入前 **`clearMoodTimer()` + `clearErrorTimer()`**（**用既有真实函数名**，state-source.ts:84；防旧 timer 提前 `pushRecomposed` 打断指令瞬态）；重组合；到 `durationMs`（缺省沿用对应态 N1 超时）→ `pushRecomposed()` 回业务态；`directiveOverride` 在 client 2/3 级 watch 重组合时自然被覆盖（重组合优先取 client 现实态）。测试（`live2d-state-source.spec.ts`，用现有 `makeSources` + `vi.useFakeTimers` 先例）：
```ts
it('pushDirective 建议强度仲裁：speaking(2) 时 happy(1) 不覆盖；idle(0) 时 happy(1) push', () => {
  const pushes: string[] = []
  const priority = ref(0) // 模拟机器当前优先级（getCurrentPriority 注入）
  const s = makeSources()
  const src = createLive2dStateSource({ ...s.input, getCurrentPriority: () => priority.value }, (p) => pushes.push(p))
  priority.value = 2
  src.pushDirective('happy', 1, 500)
  expect(pushes).not.toContain('happy')
  priority.value = 0
  src.pushDirective('happy', 1, 500)
  expect(pushes).toContain('happy')
})
it('client 2/3 级现实态经 watch 重组合覆盖指令瞬态（真实组合路径）', () => {
  const speaking = ref(false)
  const pushes: string[] = []
  const s = makeSources()
  const src = createLive2dStateSource(
    { ...s.input, isSpeaking: () => speaking.value, getCurrentPriority: () => (speaking.value ? 2 : 0) },
    (p) => pushes.push(p)
  )
  src.pushDirective('happy', 1, 2000)
  expect(pushes).toContain('happy')
  speaking.value = true // client 进入 speaking → watch 重组合覆盖指令瞬态
  expect(pushes.at(-1)).toBe('speaking')
})
it('pushDirective 超时回业务态 + 清既有 emotion timer（fake timers）', () => {
  vi.useFakeTimers()
  const pushes: string[] = []
  const s = makeSources()
  const src = createLive2dStateSource({ ...s.input, getCurrentPriority: () => 0 }, (p) => pushes.push(p))
  src.pushDirective('happy', 1, 2000)
  expect(pushes).toContain('happy')
  vi.advanceTimersByTime(2100)
  expect(pushes.at(-1)).toBe('idle') // 超时回组合业务态
  vi.useRealTimers()
})
```
（`makeSources()` 返回 `{conn, gen, speak, emo, input}`，**必须展开 `s.input`**（sources getter 对象），override 用 `{ ...s.input, isSpeaking, getCurrentPriority }`；勿直接展开 `makeSources()` 本体。）

- [ ] **Step 4: 运行确认失败 → 实现 → 确认通过**

Run: `pnpm -F @cyrene/desktop test -- --run <live2d-state-source.spec.ts>`。

- [ ] **Step 5: mock env + 发射 + Main 传参 + real 桩**

`mock-backend.ts`：`parseMockDirectiveEnv(value)`——undefined/空 → undefined；否则 `JSON.parse`（失败 → undefined，缺省不发射）→ 校验 `{state 七值 / priority 0-3 / durationMs 0-30000 / expression、motion string}`（不符 → undefined）。`scheduleReplay` generation.completed 后追加一帧 `live2d.directive`（对齐 emotion 注入点 mock-backend.ts:670-678）。`main/index.ts`：`parseMockDirectiveEnv(process.env.CYRENE_MOCK_DIRECTIVE)` → mock-backend 构造参。
`real-backend.ts`：`mapFrame` 增 `live2d.directive` 分支后（Task 1），real 侧该 type 经既有分发到达——**形状不符走 default 静默**（real-backend 既有 default→null 忽略）；**漂移 canary 放单测级**（复用 `real-backend-voice.spec.ts` 协议桩模式：配旧契约桩断言 `live2d.directive` 帧按冻结契约解析或丢弃），非生产运行时机制。

- [ ] **Step 6: live2dStore.handleDirective + 事件接线 + 脱敏日志 + 指令>emotion + 写失败测试**

`live2d.store.ts`：`handleDirective(event)`——① 校验：state ∈ 七值（越界丢弃）；priority clamp ≤1；durationMs ∈ [0,30000]（越界 clamp）；② `state` → `stateSource.pushDirective(state, clampedPriority, durationMs)`；③ **指令>emotion 时序**：指令携带 `expression` 时优先 `controller.setExpression(file)`（返回 boolean），**并抑制同帧情绪态→表情自动映射**（live2dStore 置 `directiveExpressionActive=true`，stateSource/表情发射在指令瞬态存活期间不重发 emotion 表情；**`directiveExpressionActive` 在指令瞬态超时（stateSource `pushDirective` 超时回调）或 client 2/3 级 watch 重组合覆盖时清除**；指令 expression 空则不抑制）；`!ok` → 脱敏 warn（`console.warn('[live2d] directive expression 未命中白名单', { modelId, code: 'directive_miss' })`，不记 payload 原文）；④ `motion` → `playMotion(file, clampedPriority, durationMs)` 同；⑤ 全部无效 → 忽略 + 脱敏 warn。**事件接线**：live2dStore 注册 `Live2DDirectiveEvent` handler（对齐 messageStore.applyEvent 分发路径，事件经 preload `parseBackendEvent` 到达）。测试（`live2d.spec.ts`）：happy 指令 → pushDirective 被调（spy）；expression 白名单未命中 → warn 含 modelId 不含 payload；state='error' → 丢弃；priority=2 → clamp 1；**generation.completed emotion + 同帧 directive expression → 最终生效表达式 = 指令的**（指令>emotion 断言）。

- [ ] **Step 7: 集成测试（CYRENE_MOCK_DIRECTIVE）**

`electron-live2d.spec.ts`：`launchL2d(ud, { CYRENE_MOCK_DIRECTIVE: '{"state":"happy","expression":"expressions/F01.exp3.json","priority":1}' })` → 驱动 generation.completed → 断言情绪态/表情被消费（store 状态 + 画布非空）；注入非白名单 expression 或 `state:'working'` → 不崩 + 走脱敏路径（doc 05 §16）。

- [ ] **Step 8: typecheck + lint + 单测 + 集成 + check:contract**

Run: `pnpm typecheck && pnpm lint && pnpm test && xvfb-run -a pnpm test:integration && pnpm -F @cyrene/desktop check:contract`。Expected: 全绿（check:contract 前端超集不报错；**若 `frontend_contract` 夹具提示需同步则一并处理**）。

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/live2d/controller.ts apps/desktop/src/renderer/src/live2d/state-source.ts apps/desktop/src/renderer/src/stores/live2d.store.ts <测试文件>
git commit -m "feat(阶段5批次C): C3 指令消费——controller boolean/第三参 + pushDirective 建议强度仲裁 + handleDirective 校验/脱敏/指令>emotion + mock/real 桩"
```

---

### Task 5: 收口——批次 A/B deferred 防御加固

**Files:**
- Modify: `apps/desktop/src/main/live2d/model-registry.ts`（M1 `%` 同口径 / M2 `manifest.id===dirname` / M3 integrity 空数组）
- Modify: `apps/desktop/src/shared/contracts/live2d.ts` + `apps/desktop/src/shared/schemas/ipc-response.ts`（M4 `reason` 闭合枚举）
- Modify: `apps/desktop/src/renderer/src/live2d/param-anim.ts` + `controller.ts`（F2 blink 速率调制）
- Modify: `apps/desktop/src/renderer/src/live2d/controller.ts`（F3 expressions 空→B4；Task3 M2-M4 注释）
- Modify: `apps/desktop/src/renderer/src/stores/live2d.store.ts`（Task5 M2 restore 分叉）
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（Task6 M2：`CYRENE_MOCK_*` 四枚 parser 单测——DIRECTIVE/MOUTH_LEVEL 各归其位）
- Modify: `apps/desktop/tests/integration/electron-live2d.spec.ts`（Task6 M3 注释）
- Test: 对应单测文件

**Interfaces:**
- Consumes: 批次 A/B 决策记录 §6/§四 deferred 清单（spec §3.4 逐条）。
- Produces: 各收口项修复后的行为（见下各 Step 断言）。

- [ ] **Step 1: M1 `%` 同口径（放宽）+ 写失败测试**

`model-registry.ts` 现 `resolveModelFile` 对含 `%` 的 relPath 全拒（model-registry.ts:156 `includes('%')`）→ 改为「**仅拒合法 hex 残留**」：`/%(?![0-9A-Fa-f]{2})/.test(relPath)` 才拒（`%25` 放行）；白名单/integrity 匹配用**解码后同一字符串比对**（`decodeURIComponent` 一次，二次解码仍含 `%` 的残留拒）。`live2d-path.ts` parser 不动（已逐段 decode 并拒分隔符/NUL）。测试：`%25`（字面 `%` 文件名）→ 放行；`%2F`、`%252F`、`%zz` → 拒；decode 单测。

- [ ] **Step 2: M2 `manifest.id===dirname` + 写失败测试**

`model-registry.ts` `inspectModelDir` 加载后校验 `manifest.id === basename(dirname)`，不符 → `available=false`（reason 用闭合枚举最贴近码）。测试：manifest.id 与目录名不符 → unavailable。

- [ ] **Step 3: M3 integrity 空数组 + 写失败测试**

`model-registry.ts` `loadIntegrity`（**model-registry.ts:217-236**）：`files` 为空数组 → 视为不完整 → unavailable（空对象 `{}` 已被 integritySchema fail-closed 回归断言）；顺带修「列表 available=true 但 `resolveModelFile` 恒 null」一致性（列表按 loadIntegrity 结果判定）。测试：`files:[]` → unavailable；`{}` → unavailable 回归。

- [ ] **Step 4: M4 `reason` 闭合枚举 + 写失败测试**

`contracts/live2d.ts`：`reason?: string` → `reason?: 'missing_file' | 'size_mismatch' | 'hash_mismatch'`；`ipc-response.ts` schema 同步（`z.enum([...]).optional()`）；`model-registry.ts` 生产端对齐三码。测试：schema 拒绝非三码字符串；消费端类型收窄。

- [ ] **Step 5: F2 blink 速率调制 + 写失败测试**

`param-anim.ts`：blink 调度签名扩 `rate?: number`（缺省 1；thinking/speaking 由 controller 传 >1，间隔 ~1.5-4s）；`controller.updateAnimation` 按当前态传 rate。测试：rate=2 → 眨眼间隔减半（注入时钟断言 blink 触发次数）；idle rate=1 行为不变。

- [ ] **Step 6: F3 expressions 空→B4 + Task5 M2 restore 分叉 + 写失败测试**

`controller.ts`：情绪态路由补——`expressionWhitelist.size === 0`（有动作但无表情）→ 情绪态走 B4 参数级近似（不空转表情）。`live2d.store.ts`：「恢复默认」restore 后若 `modelId` 从非 null → null 且当前已加载 ≠ 首个可用 → `switchModel(首个 available)`。测试：expressions 空模型 happy 态 → B4 参数写（笑眼）；restore 默认 → switchModel 首个可用（画布与持久化一致）。

- [ ] **Step 7: Task3 M2-M4 注释 + Task6 M2/M3 + 写失败测试**

`controller.ts`：onEvent `force('idle')` 注释钉死「生产只走 setState（N2），onEvent 为测试/外部命令面」；wobbleT 时钟重读注释；B4「thinking 眨眼加快」注释随 F2 改为名实相符。`mock-backend.ts` parser 四枚补单测（缺省/非法/边界——`CYRENE_MOCK_EMIT_DELAY_MS`/`GENERATION_EMOTION`/`DIRECTIVE` 在 mock-backend、`MOUTH_LEVEL` 在 Main 侧，各归其位）。`electron-live2d.spec.ts` B4 滑块 evaluate 合成事件加注释（headless SwiftShader 合理性）。

- [ ] **Step 8: typecheck + lint + 单测 + 集成（含收口回归集成断言）**

Run: `pnpm typecheck && pnpm lint && pnpm test && xvfb-run -a pnpm test:integration`。Expected: 全绿。**收口回归集成覆盖说明**：restore 分叉（Step 6）与 reason 闭合枚举的 Electron 级断言——在 `electron-live2d.spec.ts` 补「restore 默认 → 画布与持久化 modelId 一致」一条集成断言（若与既有列表用例重叠则注明「由单测 + 既有列表集成覆盖」，spec §5 收口回归行闭环）。

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/live2d/model-registry.ts apps/desktop/src/shared/contracts/live2d.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/renderer/src/live2d/param-anim.ts apps/desktop/src/renderer/src/live2d/controller.ts apps/desktop/src/renderer/src/stores/live2d.store.ts apps/desktop/src/main/transport/mock-backend.ts apps/desktop/tests/integration/electron-live2d.spec.ts <测试文件>
git commit -m "feat(阶段5批次C): 收口——M1-M4 防御加固 + F2 blink 速率 + F3 expressions空→B4 + restore 分叉 + 注释/单测"
```

---

### Task 6: 文档 + 决策记录 + 联调清单

**Files:**
- Modify: `docs/05-Cyrene-Live2D前端接入设计-v0.2.md`（§3 接口注记：reset(modelId?)/pushDirective/playMotion 第三参/setExpression·playMotion 返回 boolean/lipSync 门定案；§18 批次 C 状态表；§15 许可台账记录）
- Modify: `docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md`（§12 `Live2DDirective.state` 七值更正 + 偏离注记；§4 `.strict()` 张力注记；§19 映射表无条件记录 `live2d.directive`）
- Modify: `docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md`（阶段 5 批次 C 状态注记）、`docs/16-Cyrene-前端实施任务清单与进度跟踪.md`、`docs/11-Cyrene-前端设置中心详细设计.md`（如涉及）
- Modify: `README.md`、`CLAUDE.md`（三态与计数）
- Create: `docs/review/2026-08-18-阶段5批次C-决策记录.md`
- Create: `docs/review/2026-08-18-阶段5批次C-联调清单.md`
- Test: 无（文档）；`check:contract` 复跑 + 计数核验

**Interfaces:**
- Consumes: Task 1-5 实际落点（commit 列表、三态、门禁计数）。
- Produces: 决策记录（D5C-01~09 + Rulings + 中途决策 + deferred 汇总 + **doc13 处理结论**）、联调清单（冻结基线 + 定向复验项 + 自动化门禁 + 遗留说明节）。

- [ ] **Step 1: 核对 Task 1-5 落点与门禁计数**

Run: `git log --oneline` + `pnpm test` + `pnpm test:integration`（xvfb）。Expected: 记录实际 commit 列表、单测/集成计数。

- [ ] **Step 2: 文档同步**

doc05 §3 接口注记（§3 现有接口块 + 注记行）；doc05 §18 增批次 C 状态表（三态=已开发未联调、门禁计数、范围=口型/性能/指令/收口/文档）；doc02 §12 七值更正 + 偏离注记（error 剔除理由）；doc02 §4 `.strict()` 张力注记；doc02 §19 映射表 `live2d.directive` 行（raw 帧类型 + 前端事件字段映射）；doc10 状态注记；doc16 任务勾选；README/CLAUDE 三态与计数。

- [ ] **Step 3: 决策记录**

`docs/review/2026-08-18-阶段5批次C-决策记录.md`：D5C-01~09 表 + Rulings（main 分支直接执行、spec 3 轮审查、plan 3 轮审查）+ 执行期中途决策（spec/plan 审查 Critical/Important 修正：C1 口部通用化 / C3 扁平帧+七值+建议强度仲裁+四件套 / env 桥 / error 整帧拒）+ **两条 spec 偏离记录**（① raw 帧类型实落 `protocol-v2/raw-types.ts`（spec D5C-06 ① 写 `shared/contracts/backend.ts` 表述陈旧，以 raw-types.ts 为准）；② real-backend `live2d.directive` 形状不符走 default 静默、漂移 canary 降为单测级（spec §3.3「CANARY」为运行时机制表述，本批按 P4-B 实际先例改为单测级））+ **doc13 处理结论**（C3 冻结新 wire 帧、wire 未真发、不触发全量交叉重跑）+ deferred 汇总（画布分辨率降级 / 系统低电量降级 / 真实 RMS / 许可复核 / 真机项）。

- [ ] **Step 4: 联调清单**

`docs/review/2026-08-18-阶段5批次C-联调清单.md`：冻结基线（前端 commit + 后端 runtime SHA 占位 + Electron 版本占位 + protocol 版本占位）+ 定向复验项（C1 口型肉眼 / C2 四值降帧实测 + GPU-lost 重建 / C3 真实 emotion→情绪→表情 + 未知帧忽略不崩 + 指令防御路径）+ 归真机 deferred（批次 B Task5 M1 视线纵轴、批次 A Task5 P2 Layout 像素、批次 A 大纹理 8192、dev 跨源 fetch、sticky emotion）+ 自动化门禁复跑（typecheck/lint/test/test:integration/build/check:contract）+ 遗留说明节 + 三态升「已真实联调」口径。

- [ ] **Step 5: build + check:contract 复跑**

Run: `pnpm build && pnpm -F @cyrene/desktop check:contract`。Expected: 全绿（前端超集）。

- [ ] **Step 6: Commit**

```bash
git add docs/05-Cyrene-Live2D前端接入设计-v0.2.md docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md README.md CLAUDE.md docs/review/2026-08-18-阶段5批次C-决策记录.md docs/review/2026-08-18-阶段5批次C-联调清单.md
git commit -m "docs(阶段5批次C): 文档同步 + 决策记录 + 联调清单（三态=已开发未联调）"
```
