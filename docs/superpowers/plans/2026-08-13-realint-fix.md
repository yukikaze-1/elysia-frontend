# 首次真实联调整改：state/typing 兼容帧 + 单写者口径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 FE-INT-P1-01（后端合法 `state`/`typing` 帧被当未知帧 → 持续 `RAW_FRAME_INVALID` 噪声），把两帧建模为「已知但有意忽略的兼容帧」并同步指纹/manifest/fixtures/check:contract；FE-INT-RISK-01 按「单写者约束」文档化（R2，不写多客户端代码）。

**Architecture:** `raw-types.ts` 加 `RawState`/`RawTyping` 并加入 `RawFrame` 联合；`raw-schemas.ts` 加 strict schema 并加入 `RawFrameSchema`；`real-backend.ts` handleFrame 加显式 `case 'state'/'typing'` no-op（契约识别 + 有意忽略，不落 mapper）；`check-backend-contract.mjs` 白名单 11→13；指纹变化 → 11 份 manifest `schemaHash` 同步 + 新增 `state-typing` fixture 组（handoff trace 真实帧，verified:false）。RISK-01 写入 README/CLAUDE.md/docs16。

**Tech Stack:** Electron main（Node）+ TypeScript + zod v4 + vitest（node 环境）。

## Global Constraints

- R1（用户拍板）：state/typing 建模为「已知但有意忽略的兼容帧」——**strict schema**（未知字段仍拒）、显式 no-op、**未知帧仍 fail-closed `RAW_FRAME_INVALID`**（不把 schema 改成 passthrough）。
- `state: z.string()` **不加 min(1)**（后端 `StateMessage.state` 裸 str 无约束，空串契约合法；min(1) 会重新引入本批要消除的假告警）。
- `RawState`/`RawTyping` 注释「契约识别 + 有意忽略，renderer 暂不消费，勿误删（FE-INT-P1-01）」。
- `handleFrame` 加 `case 'state'`/`case 'typing'` → return（文档化意图；即使误落 mapper，`mapFrame` 对未知 type 返回 null 不误映射）。
- 指纹变化后 11 份 manifest `schemaHash` 更新为新指纹；`verified`/`backendCommit` **保持现状**（4 份 verified:true+beeba577、7 份 verified:false+"unverified"）——不能提升、不能伪造。
- `state-typing.jsonl` 只含**合法**帧；manifest `verified:false` + `backendCommit:"unverified"`（handoff trace 快照帧，非本次联调冻结）。
- check:contract 白名单 11→13，输出 `13/13 type`。
- RISK-01：单写者约束文档化，**不实现多客户端因果链**、不做「低级别诊断/提示来自其他客户端」（否决记录）、**不纳入 B-01 阻断门禁**。
- 后端 `message_id=""`：前端非空校验不动，四种不可接受改法全部拒绝。
- 新增测试只落 `tests/unit/`；文档语言中文；保留「已开发、未联调」。

---

### Task 1: state/typing 兼容帧完整落地（schemas + no-op + 白名单 + fixtures + manifest 同步）

**Files:**
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-types.ts`
- Modify: `apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts`
- Modify: `apps/desktop/src/main/transport/real-backend.ts`
- Modify: `apps/desktop/scripts/check-backend-contract.mjs`
- Modify: `apps/desktop/src/main/fixtures/wire-v2/*.manifest.json`（11 份 `schemaHash` 同步）
- Create: `apps/desktop/src/main/fixtures/wire-v2/state-typing.jsonl` + `state-typing.manifest.json`
- Test: `apps/desktop/tests/unit/raw-schemas.spec.ts`、`apps/desktop/tests/unit/real-backend.spec.ts`、`apps/desktop/tests/unit/wire-fixtures.spec.ts`

**Interfaces:**
- Produces（T2 不消费，仅文档）：`RawState { type:'state'; state: string }`、`RawTyping { type:'typing'; typing: boolean }` 加入 `RawFrame`；`RAW_FRAME_TYPES` 13 型；`rawSchemasFingerprint()` 新指纹。
- Consumes: 无（首个任务）。

- [ ] **Step 1: 写失败测试**——`tests/unit/raw-schemas.spec.ts` 追加 describe + 更新 `RAW_FRAME_TYPES` 断言 + 指纹敏感性：

```ts
describe('state/typing 兼容帧（FE-INT-P1-01）', () => {
  it('parseRawFrame 合法 state/typing 通过', () => {
    expect(parseRawFrame({ type: 'state', state: 'thinking' }).success).toBe(true)
    expect(parseRawFrame({ type: 'state', state: 'idle' }).success).toBe(true)
    expect(parseRawFrame({ type: 'typing', typing: true }).success).toBe(true)
    expect(parseRawFrame({ type: 'typing', typing: false }).success).toBe(true)
    expect(parseRawFrame({ type: 'state', state: '' }).success).toBe(true) // 契约允许空串,勿设 min(1)
  })
  it('畸形载荷仍失败（strict + 类型/缺失）', () => {
    expect(parseRawFrame({ type: 'state' }).success).toBe(false) // 缺 state
    expect(parseRawFrame({ type: 'typing', typing: 'yes' }).success).toBe(false) // 类型错
    expect(parseRawFrame({ type: 'state', state: 'idle', extra: 1 }).success).toBe(false) // strict 拒未知键
    expect(parseRawFrame({ type: 'unknown_frame' }).success).toBe(false) // 未知 type fail-closed
  })
})
```
更新既有 `RAW_FRAME_TYPES` 断言（约 :172-177）为 13 型：
```ts
    expect([...RAW_FRAME_TYPES].sort()).toEqual([
      'error', 'expression', 'generation.completed', 'generation.delta',
      'generation.failed', 'generation.segment.completed', 'generation.segment.started',
      'generation.started', 'server_info', 'session', 'state', 'typing', 'user_message.ack'
    ])
```
追加指纹敏感性（与既有 N6 样本同款模式）：
```ts
  it('加入 state/typing 成员 → 指纹变化（FE-INT-P1-01 敏感性）', () => {
    const a = rawSchemasFingerprintFor(z.discriminatedUnion('type', [z.object({ type: z.literal('x') })]))
    const b = rawSchemasFingerprintFor(z.discriminatedUnion('type', [z.object({ type: z.literal('x') }), z.object({ type: z.literal('state'), state: z.string() })]))
    expect(a).not.toBe(b)
  })
```

`tests/unit/real-backend.spec.ts` 追加（沿用 `makeBackend`/`wss`/connect 夹具；`BackendEvent` 已 import；**补一行 `import type { ProtocolWarning } from '@shared/contracts/protocol'`**）：

```ts
it('state/typing 帧不 emit、不 warn、不断连（FE-INT-P1-01）', async () => {
  const warnings: ProtocolWarning[] = []
  const b = new RealBackend({ now: () => Date.now(), onProtocolWarning: (w) => warnings.push(w) })
  await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
  const events: BackendEvent[] = []
  const unsub = b.subscribe((e) => events.push(e))
  const send = (payload: unknown) => { wss.clients.forEach((c) => c.send(JSON.stringify(payload))) }
  send({ type: 'state', state: 'thinking' })
  send({ type: 'typing', typing: true })
  await new Promise((r) => setTimeout(r, 50))
  expect(events).toEqual([]) // 不 emit
  expect(warnings).toEqual([]) // 不 warn
  expect(b.getConnectionState().status).toBe('connected') // 不断连
  unsub()
  await b.disconnect()
})
it('未知 type 帧仍 RAW_FRAME_INVALID warn（fail-closed）', async () => {
  const warnings: ProtocolWarning[] = []
  const b = new RealBackend({ now: () => Date.now(), onProtocolWarning: (w) => warnings.push(w) })
  await b.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'sk-test' })
  wss.clients.forEach((c) => c.send(JSON.stringify({ type: 'totally_unknown' })))
  await new Promise((r) => setTimeout(r, 50))
  expect(warnings.map((w) => w.code)).toEqual(['RAW_FRAME_INVALID'])
  await b.disconnect()
})
```

`tests/unit/wire-fixtures.spec.ts`：`NEW_FIXTURES` 数组加 `'state-typing.jsonl'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/raw-schemas.spec.ts tests/unit/real-backend.spec.ts tests/unit/wire-fixtures.spec.ts`
Expected: 任务失败——state/typing parse 用例红（schema 无这两型）；`RAW_FRAME_TYPES` 13 断言红（当前 11）；wire-fixtures `schemaHash` 门禁红（`fp` 新指纹 ≠ manifest 旧指纹）。

- [ ] **Step 3: 实现**

`raw-types.ts` 追加并加入 `RawFrame` 联合：
```ts
/** FSM 状态变更（FE-INT-P1-01：契约识别 + 有意忽略，renderer 暂不消费） */
export interface RawState { type: 'state'; state: string }
/** 输入状态变更（同上） */
export interface RawTyping { type: 'typing'; typing: boolean }
```

`raw-schemas.ts` 追加 strict schema 并加入 `RawFrameSchema` 联合：
```ts
/** 契约识别 + 有意忽略：FSM 状态变更（renderer 暂不消费，勿误删——FE-INT-P1-01） */
const RawStateSchema = z.object({
  type: z.literal('state'),
  state: z.string() // 契约原样：后端 StateMessage.state 是裸 str、无 min 约束（空串契约合法）；strict 仍拒未知键
}).strict()
/** 契约识别 + 有意忽略：输入状态变更 */
const RawTypingSchema = z.object({
  type: z.literal('typing'),
  typing: z.boolean()
}).strict()
```
（`RawFrameSchema` union 在 `RawUserAckSchema` 后、`RawErrorMessageSchema` 前加两个成员。）

`real-backend.ts` handleFrame switch（`case 'expression'` 之后）：
```ts
      case 'state': return // FE-INT-P1-01:FSM 状态契约识别,renderer 暂不消费(有意忽略,勿误删)
      case 'typing': return // FE-INT-P1-01:输入状态契约识别,renderer 暂不消费(有意忽略,勿误删)
```

`scripts/check-backend-contract.mjs` `WS_V2_FRAME_TYPES` 加两型（注释更新 11→13）：
```js
  'generation.segment.completed', 'generation.completed', 'generation.failed',
  'state', 'typing' // FE-INT-P1-01:11 型 → 13 型,state/typing 兼容帧纳入字段级深比较
```

`src/main/fixtures/wire-v2/state-typing.jsonl`：读 `/home/yomu/elysia-agent/docs/archive/frontend-handoff-v2/traces/ws-v2-*.jsonl`，提取去重后的真实 state/typing 帧（state 值 idle/thinking/interrupted/speaking 各一、typing true/false），每行一条合法 JSON（只含合法帧）。

`src/main/fixtures/wire-v2/state-typing.manifest.json`：
```json
{ "backendCommit": "unverified", "protocol": "2", "serverProtocolVersion": "2.0", "schemaHash": "<新指纹>", "verified": false, "scenario": "state-typing" }
```

**manifest schemaHash 同步**：schema 改完后**用 node 直接计算新指纹**（比从 vitest 失败输出复制更稳——避免陈旧 `node_modules/.vite` 缓存下 zod 经 `@zod/source` 条件加载 TS 源变体导致指纹偶发非确定）：

```bash
node -e "import('./apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts').then(m => console.log(m.rawSchemasFingerprint()))"
```

把输出指纹替换进 11 份既有 manifest + 新 `state-typing.manifest.json` 的 `"schemaHash"`（**只改 schemaHash 字段，不动 verified/backendCommit**）；随后必须复跑 Step 4 门禁确认（若仍红，清 `node_modules/.vite` 缓存重算一次再判）。**合成帧回退**：若后端 trace 目录不可读（未挂载），可退化为等价合成帧，但须在 manifest 注释/报告说明出处。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/raw-schemas.spec.ts tests/unit/real-backend.spec.ts tests/unit/wire-fixtures.spec.ts` 与 `pnpm -F @cyrene/desktop check:contract`
Expected: 三 spec 全绿（state/typing parse / no-op / fixtures 三层门禁含新组）；check:contract 输出 `13/13 type`（白名单覆盖 state/typing）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/transport/protocol-v2/raw-types.ts apps/desktop/src/main/transport/protocol-v2/raw-schemas.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/scripts/check-backend-contract.mjs apps/desktop/src/main/fixtures/wire-v2/ apps/desktop/tests/unit/raw-schemas.spec.ts apps/desktop/tests/unit/real-backend.spec.ts apps/desktop/tests/unit/wire-fixtures.spec.ts
git commit -m "fix(首次真实联调整改 T1): state/typing 兼容帧(strict+no-op+白名单11→13+指纹/manifest/fixture 同步)"
```

---

### Task 2: RISK-01 单写者约束文档化（R2）

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`

**Interfaces:**
- Consumes: spec §4.5 内容。
- Produces: 无（文档）。

- [ ] **Step 1: 写文档**——三处按 spec §4.5 落文案：

**README**「真实模式联调」小节（B-01 联调门禁段后）追加：
```markdown
> **单活动桌面客户端/单写者约束（FE-INT-RISK-01，首次联调确认）：** 同会话由多个客户端同时写入不在当前产品范围。其他客户端对当前活动会话的写入（本端无本地 optimistic user 消息的 generation）保留现状到达序渲染，不保证跨客户端因果顺序。多客户端支持需前后端共同设计因果链（后端 generation.started 前广播 user committed / generation 携带 user 引用 / 会话级单调 sequence），当前不做；「低级别诊断」与「提示来自其他客户端」两选项均否决（单写者下跨客户端 generation 属罕见异常，额外诊断/提示引入 renderer 逻辑与文案成本，且不改变「不保证因果顺序」的事实）；本项不纳入首次单客户端 B-01 阻断门禁。
```

**CLAUDE.md**「Current status」追加一句（含测试数字与 state/typing 落地）：
```markdown
- 首次真实联调（2026-08-13）确认单写者口径（FE-INT-RISK-01 决策）：单活动桌面客户端/单写者，多客户端同会话不支持；后端合法 `state`/`typing` 帧已建模为「已知但有意忽略的兼容帧」（不再 `RAW_FRAME_INVALID`，check:contract 13/13）。512+ 单测（47 files）+ 23 集成 + typecheck/lint/build 全绿。仍标「已开发、未联调」（真实后端复跑诊断项为 B-01 验证项）。
```

**docs/16** 变更记录 + 已知限制追加：单写者约束（同 README 口径，含否决理由）、state/typing 兼容帧落地、`message_id=""` 后端阻断（前端非空校验保持）、明确「不纳入 B-01 阻断门禁」。

- [ ] **Step 2: 验证无代码改动**

Run: `git status --short` → 应只有三份文档改动；不跑测试（纯文档）。

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md "docs/16-Cyrene-前端实施任务清单与进度跟踪.md"
git commit -m "docs(首次真实联调整改 T2): RISK-01 单写者约束文档化(README/CLAUDE/docs16)+state/typing 兼容帧口径"
```

---

### Task 3: 全量门禁确认（无代码）

- [ ] **Step 1: 跑全部门禁**

Run: `pnpm -F @cyrene/desktop typecheck`、`pnpm -F @cyrene/desktop lint`、`pnpm -F @cyrene/desktop test`、`xvfb-run -a pnpm -F @cyrene/desktop test:integration`、`pnpm -F @cyrene/desktop build`、`pnpm -F @cyrene/desktop check:contract`
Expected: 全部绿；单测 ≥ 505（本批新增约 5+，HEAD 基线 512）；集成 23 不回归；check:contract **13/13 type** + 字段级帧通过。

- [ ] **Step 2: 确认无代码变更 + 记录已知限制**

Run: `git status --short`
Expected: 无本任务产生的改动；不 commit。**将以下已知限制记录进控制器最终报告**（本任务不写文件）：① 真实后端复跑诊断项为 B-01 验证项（headless 不可实跑）；② state/typing 无 renderer 消费（契约识别 + 有意忽略，留阶段 3+）；③ 单写者约束（多客户端因果链不做）；④ 后端 `message_id=""` 阻断（前端非空校验保持）；⑤ state-typing fixture 为 handoff trace 快照帧（非本次联调冻结，verified:false）。

---

## 自审（对照 spec）

- §4.1 raw types + strict schema（`state: z.string()` 无 min(1)、注释防误删）→ T1 Step 3。
- §4.2 handleFrame 显式 no-op（文档化意图、不落 mapper）→ T1 Step 3。
- §4.3 check:contract 白名单 11→13 → T1 Step 3。
- §4.4 指纹/manifest/fixtures 同步（11 份 schemaHash 更新、verified 不变、state-typing 组入 NEW_FIXTURES、handoff trace 真实帧）→ T1 Step 3/4。
- §4.5 RISK-01 单写者约束（README/CLAUDE/docs16 + 不纳入 B-01 门禁 + 否决记录）→ T2。
- §4.6 message_id 非空校验保持（本批不改该 schema）→ T1 不触碰 rest-mapper/rest schema。
- §4.7 验收测试（raw-schemas.spec / real-backend.spec / wire-fixtures / check:contract 13/13）→ T1 Step 1/4 + T3。
- 已知限制（真实后端复跑为 B-01 验证项）→ T3 记录。

> **注**：文档状态同步（README/CLAUDE.md/docs16 的批次落地/测试数字）已并入 T2（RISK-01 文档化 + 口径），无额外 docs 步骤；最终报告 + 验收由控制器执行。
