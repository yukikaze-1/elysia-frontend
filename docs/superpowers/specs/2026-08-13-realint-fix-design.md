# Cyrene 首次真实联调整改：state/typing 兼容帧 + 单写者口径设计

**日期：** 2026-08-13
**依据：** `docs/review/2026-08-13-Windows-Electron-首次真实联调前端问题清单.md`（FE-INT-P1-01 / FE-INT-RISK-01）
**审查对象基线：** `main@0236a97`（首次联调封口修复落地后 HEAD）
**范围：** Electron 阶段 2 WS v2 raw 契约扩展（state/typing 兼容帧）+ 首次联调口径文档化
**目的：** 消除真实联调发现的唯一前端 P1——合法 `state`/`typing` 帧被严格 raw schema 记为 `RAW_FRAME_INVALID` 的诊断噪声；并把 FE-INT-RISK-01 按「单活动桌面客户端/单写者」约束口径冻结（用户拍板：按推荐，不写多客户端支持代码）。本批完成后仍标「已开发、未联调」。
**决策：** 本批决策已定案——R1（state/typing 建模为「已知但有意忽略的兼容帧」）与 R2（RISK-01 按单写者约束文档化，不实现多客户端因果链）均按推荐执行，用户拍板「全修，按你推荐的来」。
**文档状态：** v3 定稿（经 code-review 两轮闭环：事实核验 3 差异 + 覆盖 4 口径缺口 + 设计 3 修正 + 复核 7/8 + 1 矛盾统一（§3.2/§6 夹具口径）全整合）

---

## 1. 背景与目标

首次真实联调（Windows Electron + Ubuntu 后端，拓扑见清单 §头部）已完成。前端主链无新阻断缺陷（endpoint/凭据/握手/连接/流式/取消/重连/结构化错误全过），但确认了一个 P1 诊断问题与一个范围风险：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-INT-P1-01 | P1 | 后端合法 `state`/`typing` 帧被前端严格 raw schema 当未知帧 → 持续 `RAW_FRAME_INVALID` | 建模为「已知但有意忽略的兼容帧」：strict schema + 显式 no-op + 未知帧仍 fail-closed + 指纹/manifest/fixtures/check:contract 同步 |
| FE-INT-RISK-01 | P2/风险 | 第二 WS 客户端同会话的因果顺序风险（单 Electron 未复现） | **单写者约束文档化**（R2，用户拍板），不实现多客户端因果链 |

**非前端修（记录，不做）：** 后端旧 `default` 会话 REST 历史 `message_id=""` 工具消息阻断——前端非空校验正确，**禁止放宽**（byId 主键/去重/replay 合并职责）；按后端配套报告修数据。

**完成标准**（对照清单 §3.3/§3.4/§6）：
- `parseRawFrame({type:'state', state:'thinking'})` 与 `parseRawFrame({type:'typing', typing:true})` 通过；
- `state` 缺字段、`typing` 用字符串等畸形载荷仍失败；
- `RealBackend` 收到合法两帧不 emit generation 事件、不报 protocol warning、不断连；
- 未知 `type` 仍报告 `RAW_FRAME_INVALID`（fail-closed，不把 schema 改成 passthrough）；
- `rawSchemasFingerprint()` 变化 → 11 份 fixture manifest `schemaHash` 同步；新增 state/typing wire fixture（verified:false，非伪造后端提交）；
- `check:contract` 的 `WS_V2_FRAME_TYPES` 白名单 11 → 13，字段级深比较纳入 state/typing；
- RISK-01 单写者约束写入文档（README/CLAUDE.md/docs16）；
- typecheck、lint、505+ 单测、23+ 集成、build、check:contract(13/13 type + 字段级) 全绿；
- 对真实后端复跑文本生成、诊断不再出现 state/typing 引起的 `RAW_FRAME_INVALID`（记录为 B-01 复跑验证项，本批 headless 不可实跑）；
- 文档仍标记「已开发、未联调」。

## 2. 范围（本批 vs 后续）

**本批做：** FE-INT-P1-01（state/typing 兼容帧：raw-types/raw-schemas/handleFrame/check 白名单/指纹/manifest/fixtures/单测）、FE-INT-RISK-01（单写者约束文档化）。

**本批不做**：
- 多客户端同会话支持（R2 明确不支持；若未来产品要支持，需前后端共同设计因果链——后端 generation.started 前广播 user committed / generation 携带 user 引用 / 会话级单调 sequence，清单 §4.3）；
- 后端 `message_id=""` 修复（后端配套报告负责；前端保持非空校验）；
- state/typing 的 renderer 消费（映射独立状态域/UI 展示）——本轮「契约识别 + 有意忽略」，留阶段 3+；
- phase3+ 帧（voice/dictation/tool 等）仍在 check:contract warn 白名单，不在本批 WS v2 子集内。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `raw-schemas.ts:182-194` | `RawFrameSchema` discriminatedUnion 只含 11 类帧 | 无 `state`/`typing` → 合法帧被拒（FE-INT-P1-01） |
| `raw-types.ts:160-163` | `RawFrame` 联合 11 成员 | 同缺 |
| `real-backend.ts:142-164` | `handleFrame` 对 parse 失败统一 `warn('RAW_FRAME_INVALID', ...)`（:144 JSON 解析失败 / :145 帧校验失败两种文案） | state/typing 进不去 switch，持续假告警 |
| `scripts/check-backend-contract.mjs:22-27` | `WS_V2_FRAME_TYPES` 白名单 11 型 | state/typing 归入 phase3+ warn 滞后计数，未纳入字段级检查 |
| `src/main/fixtures/wire-v2/*.manifest.json` | 11 份 manifest `schemaHash` 锚定当前 11 型指纹 | 指纹变化后必须同步 |
| 后端契约 `ws_message.py:475-507` | `StateMessage {type:'state', state:str}`、`TypingMessage {type:'typing', typing:bool}`（已核对） | 是正式 wire 契约帧，非随机未知帧 |

### 3.2 技术约束

- **strict schema**：state/typing 与既有帧同用 `.strict()`——未知字段不被无声接受；字段类型错误（如 typing 用字符串）仍失败。
- **判别 type 冲突**：`state`/`typing` 是新 type 字面量，不与既有 11 类冲突；discriminatedUnion 直接扩展。
- **指纹变化**：`rawSchemasFingerprint()` 对 union 结构求 sha256（`raw-schemas.ts:231-246`），加 2 型 → 指纹必变 → 11 份 manifest `schemaHash` 必须更新为新指纹（`verified`/`backendCommit` 不变——加帧不使既有 fixture 失效，不能把 verified:false 提升、不能伪造后端 commit）。
- **`RAW_FRAME_INVALID` 语义保留**：未知 type / 畸形帧仍走该告警；state/typing 只是从「未知」变「已知但忽略」，不消除告警通道本身。
- **handleFrame no-op 位置**：在 switch 加显式 `case 'state'`/`case 'typing'` → return（不落到 default → mapper，避免误映射成 generation 事件）；注释「契约识别 + 有意忽略，renderer 暂不消费，勿误删」。
- **check:contract 白名单 11 → 13**：加 `'state', 'typing'` → 后端契约扫描时从 phase3+ warn 移到字段级深比较（后端契约源若生成含 state/typing 的 ws-v2-*.jsonl，则逐帧 parseRawFrame + 深比较）。
- **wire fixture 新增**：`state-typing.jsonl` 只含**合法**帧（畸形帧会挂「每行过 raw schema」门禁，畸形失败由 raw-schemas.spec 单测覆盖）；manifest `verified:false` + `backendCommit:"unverified"`（取 **handoff trace 快照帧**——`frontend-handoff-v2` 冻结快照非本次联调冻结，故不伪造后端提交；联调捕获的真实 state/typing 帧未随清单提供原始 JSONL）。
- **验收「对真实后端复跑」**：headless 环境不可连真实后端 → 记录为 B-01 复跑验证项，不冒充已完成。

## 4. 设计

### 4.1 raw types + schemas（R1 核心）

`raw-types.ts` 新增并加入 `RawFrame` 联合：

```ts
/** FSM 状态变更（FE-INT-P1-01：契约识别 + 有意忽略，renderer 暂不消费） */
export interface RawState { type: 'state'; state: string }
/** 输入状态变更（同上） */
export interface RawTyping { type: 'typing'; typing: boolean }
```

`raw-schemas.ts` 新增 strict schema 并加入 `RawFrameSchema` 联合：

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

### 4.2 handleFrame 显式 no-op

`real-backend.ts:147-152` 的 switch 在 `case 'expression'` 之后加：

```ts
      case 'state': return // FE-INT-P1-01:FSM 状态契约识别,renderer 暂不消费(有意忽略,勿误删)
      case 'typing': return // FE-INT-P1-01:输入状态契约识别,renderer 暂不消费(有意忽略,勿误删)
```

不落到 default → mapper（即使误落到 mapper，`mapFrame` 对未知 type 也返回 null 不误映射 generation——显式 case 的价值是**文档化意图**「契约识别 + 有意忽略，勿误删」），合法帧不 emit、不 warn、不断连。

### 4.3 check:contract 白名单同步

`scripts/check-backend-contract.mjs:22-27` 的 `WS_V2_FRAME_TYPES` 加 `'state', 'typing'` → 13 型；注释更新「11 型 → 13 型（FE-INT-P1-01 加入 state/typing 兼容帧）」。phase3+ warn 白名单不动。

### 4.4 指纹 / manifest / fixtures 同步

- 加 2 型后 `rawSchemasFingerprint()` 变化 → 11 份 manifest `schemaHash` 更新为新指纹（`verified`/`backendCommit` 保持现状：4 份 verified:true+beeba577、7 份 verified:false+"unverified"）；
- 新增 `src/main/fixtures/wire-v2/state-typing.jsonl`（**真实后端 trace 帧**——取自 `elysia-agent/docs/archive/frontend-handoff-v2/traces/ws-v2-*.jsonl` 中 19 条真实 state/typing 帧的去重形状，如 `{"type":"state","state":"idle"|"thinking"|"interrupted"|"speaking"}`、`{"type":"typing","typing":true|false}`；只含合法帧，畸形帧会挂「每行过 raw schema」门禁，畸形失败由 raw-schemas.spec 单测覆盖）+ `state-typing.manifest.json`（`verified:false`、`backendCommit:"unverified"`、`schemaHash` = 新指纹、`scenario:"state-typing"`）；
- `wire-fixtures.spec.ts` 的 **`NEW_FIXTURES` 数组**加 `'state-typing.jsonl'`（`fixtures` 推导数组自动包含，三层门禁——每行过 schema / schemaHash / verified 分组断言——全覆盖）；若实现用合成帧而非 trace 帧，须在 manifest 注释/报告说明出处。

### 4.5 RISK-01 单写者约束文档化（R2）

- **README**「真实模式联调」小节追加约束：**单活动桌面客户端/单写者**——同会话由多个客户端同时写入不在当前产品范围；其他客户端对当前活动会话的写入（无本地 optimistic user 消息的 generation）保留现状到达序渲染，不保证跨客户端因果顺序；
- **CLAUDE.md**「Current status」补一句：首次联调确认单写者口径（FE-INT-RISK-01 决策），多客户端支持需前后端共同设计因果链（清单 §4.3 三选一），当前不做；
- **docs/16** 变更记录/已知限制追加该口径，并**明确「不纳入首次单客户端 B-01 阻断门禁」**（RISK-01 为 P2/风险，仅文档化）；
- **否决记录**（清单 §4.3 三选一的另两个选项）：「低级别诊断」与「提示来自其他客户端」均不选——原因：单写者约束下跨客户端 generation 属罕见异常，额外诊断/提示会引入 renderer 逻辑与文案成本，且不改变「不保证因果顺序」的事实；如需可后续按产品决定补；
- 若未来产品要支持多客户端，先完成清单 §4.4 复现矩阵再设计因果链（不在本批）。

### 4.6 后端阻断记录（非前端修）

- 旧 `default` 会话 `message_id=""` 工具消息：前端 `RestMessageSchema.message_id` 非空校验**保持不动**；本批不改该 schema；清单 §5 四种不可接受改法全部拒绝——①放宽为空串、②为每次 REST 响应随机生成 ID、③映射到同一 fallback key、④丢弃坏消息假装整页成功（messageId 承担 byId 主键/去重/replay 合并/稳定排序职责，放宽会变成隐蔽数据覆盖）；
- 该问题按后端配套报告（`elysia-agent/docs/review/2026-08-13-...后端问题清单.md`）修复新写入并稳定迁移历史数据。

### 4.7 验收测试

- 单元（`tests/unit/raw-schemas.spec.ts` 扩展）：`parseRawFrame({type:'state',state:'thinking'})` success；`parseRawFrame({type:'typing',typing:true})` success；`parseRawFrame({type:'state'})`（缺 state）fail；`parseRawFrame({type:'typing',typing:'yes'})`（类型错）fail；`parseRawFrame({type:'state',state:''})` success（契约允许空串，勿设 min(1)）；`parseRawFrame({type:'state',state:'idle',extra:1})` fail（strict 拒未知键）；未知 `{type:'unknown_frame'}` 仍 fail；`RAW_FRAME_TYPES` 含 state/typing 且长度 13；`rawSchemasFingerprint()` 变化（加 2 型后与旧指纹不同）。
- 单元（`tests/unit/real-backend.spec.ts` 扩展）：收到合法 state/typing 帧 → 不 emit 事件、不 warn、不断连（fake ws 注入帧断言回调）；未知 type 帧 → `RAW_FRAME_INVALID` warn。
- 门禁：`wire-fixtures.spec.ts` 全绿（含 state-typing 组 + schemaHash 同步）；`check:contract` 13/13 type（13 型 whitelist 覆盖）+ 字段级帧通过；typecheck/lint/505+ 单测/23+ 集成/build 全绿。
- B-01 复跑（记录为验证项）：真实后端再跑一轮文本生成，诊断不再出现 state/typing 引起的 `RAW_FRAME_INVALID`。

## 5. 验收与门禁

**门禁（控制器复跑）：**
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（505+ 单测）、`xvfb-run -a pnpm test:integration`（23+）、`pnpm build`、`pnpm -F @cyrene/desktop check:contract`（13/13 type + 字段级）全绿；
- `pnpm package` + `xvfb-run -a verify:artifact -- --smoke` 不回归（如本批未触碰打包路径可仅复跑 typecheck/lint/unit/integration/build/contract）。

**故障注入复测（整改清单 §10 / 联调清单 §3.4 要求）：**
- `state`/`typing` 不再产生 `RAW_FRAME_INVALID`（单测覆盖 handleFrame 不 warn）；未知/畸形帧仍 `RAW_FRAME_INVALID`（fail-closed 保留）。

**文档标记：** 本批完成仍标「已开发、未联调」；真实后端复跑诊断项记录为 B-01 验证项（headless 不可实跑）；单写者约束如实标注为产品范围决策。

## 6. 已知限制（记录，待后续）

- **真实后端复跑不可本批执行**：headless 环境无真实后端/凭据；「诊断不再出现 RAW_FRAME_INVALID」为 B-01 复跑验证项。
- **state/typing 无 renderer 消费**：契约识别 + 有意忽略；映射独立状态域/UI 留阶段 3+（若产品需要 FSM 状态/输入指示）。
- **单写者约束**：多客户端同会话因果顺序不在当前范围；若未来支持，先走清单 §4.4 复现矩阵 + 前后端因果链设计（§4.3 三选一）。
- **后端 `message_id=""` 阻断**：前端保持非空校验；按后端报告修复后 Electron 可开旧 `default`、执行新工具调用并在重连后稳定回放（清单 §6 门禁末条，后端依赖）。
- **wire fixture state-typing 为 handoff trace 快照帧**：`verified:false` + `unverified`，非本次联调冻结 trace（联调捕获的真实 state/typing 帧未随清单提供原始 JSONL；实现若用合成帧须在报告说明出处）。

## 7. 文档同步（本批范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-13-realint-fix-design.md`；
- 实施完成后更新 `README.md` / `CLAUDE.md` / `docs/16`（state/typing 兼容帧 + 单写者约束 + 测试数字），保留「已开发、未联调」；
- 最终报告 + 验收按联调清单 §6 逐项回报。
