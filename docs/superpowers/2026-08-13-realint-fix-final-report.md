# Cyrene 首次真实联调整改：最终报告（state/typing 兼容帧 + 单写者口径）

**日期：** 2026-08-13
**依据：** `docs/review/2026-08-13-Windows-Electron-首次真实联调前端问题清单.md`（FE-INT-P1-01 / FE-INT-RISK-01）
**HEAD：** main（spec 0b4c136、plan 5388e91、实现 c5819a9、T2 17eba75+e0ed80f、文档同步 2b560ae、最终 review 修复 726775e）
**验证基线：** **510 单测（46 files）+ 23 集成（6 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` + `check:contract`(13/13 + 字段级 63 帧) 全绿
**状态：** 两项全部落地并经 SDD 全分支最终 review（opus）PASS + 第三方验收 agent **2/2 达成**；仍标「已开发、未联调」（B-01 正式验收未通过——首次真实联调已执行 2026-08-13，P1/RISK 修复完成，真实后端复跑诊断项为 B-01 验证项）

---

## 1. 批次概览

首次真实联调（Windows Electron + Ubuntu 后端）完成，前端主链无新阻断缺陷，但确认了一个 P1 诊断问题（FE-INT-P1-01：后端合法 `state`/`typing` 帧被当未知帧 → 持续 `RAW_FRAME_INVALID`）与一个范围风险（FE-INT-RISK-01：第二客户端同会话因果顺序）。本批走完整 SDD 流程（spec→code-review 2 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review 逐任务闭环→全分支最终 review→验收 agent）：

```text
FE-INT-P1-01 state/typing 兼容帧 ─▶ FE-INT-RISK-01 单写者口径
   (strict schema + no-op + fail-closed + 指纹/manifest/contract 同步)   (文档化,不写多客户端代码)
```

**流程执行：** spec 经 code-review 2 轮闭环（事实核验 3 差异 + 覆盖 4 口径缺口 + 设计 3 修正 + 复核 7/8 + 1 矛盾统一，全整合 v3）；plan 经 code-review 2 轮闭环（可执行性实测 T1 全流程 64/64 + 覆盖 10/10 + 设计 8 点，全整合 v2）；subagent 3 任务全部 TDD 实施 + task review 逐任务闭环（T1 Spec ✅/Quality ✅、T2 Spec ✅/Quality 修正后 ✅）；SDD 全分支最终 review（opus）PASS，无 Critical/Important，3 项 Minor 全部修复。

## 2. 交付详情

### 2.1 FE-INT-P1-01：state/typing 兼容帧（决策 R1）

| 项 | 内容 |
|---|---|
| raw types | `raw-types.ts` 新增 `RawState {type:'state', state:string}` / `RawTyping {type:'typing', typing:boolean}` 并加入 `RawFrame` 联合（13 成员）；注释「契约识别 + 有意忽略，勿误删」 |
| strict schema | `raw-schemas.ts` 新增 `RawStateSchema`/`RawTypingSchema`（`.strict()`，`state: z.string()` **无 min(1)**——后端契约裸 str 空串合法）+ 加入 `RawFrameSchema`；畸形同帧（缺字段/类型错/未知键）仍失败 |
| handleFrame | `real-backend.ts` switch 加 `case 'state'`/`case 'typing'` → return（不落 mapper；即使误落 mapper 也返回 null）；合法帧不 emit、不 warn、不断连 |
| fail-closed 保留 | 未知 `type` / 畸形帧仍 `RAW_FRAME_INVALID`（不把 schema 改 passthrough） |
| check:contract | `WS_V2_FRAME_TYPES` 白名单 11→13，state/typing 从 phase3+ warn 移入字段级深比较；输出 **13/13 type + 字段级 63 帧** |
| 指纹/manifest/fixtures | `rawSchemasFingerprint()` 变化 → **12 份 manifest** `schemaHash` 同步（11 既有 + 新增 state-typing，`verified`/`backendCommit` 保持 4 verified:true+beeba577 + 8 verified:false+unverified，未提升未伪造）；`state-typing.jsonl` 取自 **handoff trace 真实帧**（state 四值 + typing true/false，只合法帧）入 `NEW_FIXTURES` |
| 真实后端复跑 | 「诊断不再出现 state/typing 引起的 RAW_FRAME_INVALID」记录为 B-01 复跑验证项（headless 不可实跑，不冒充） |

### 2.2 FE-INT-RISK-01：单写者约束文档化（决策 R2）

| 项 | 内容 |
|---|---|
| 单写者约束 | README「真实模式联调」+ CLAUDE「Current status」+ docs/16 已知限制三处：**单活动桌面客户端/单写者**，同会话多客户端写入不在当前产品范围；其他客户端对活动会话的写入保留现状到达序渲染，不保证跨客户端因果顺序 |
| 否决记录 | 「低级别诊断」与「提示来自其他客户端」两选项均否决（单写者下跨客户端 generation 属罕见异常，额外诊断/提示引入 renderer 逻辑与文案成本，不改变「不保证因果顺序」事实） |
| 门禁排除 | 明确「不纳入首次单客户端 B-01 阻断门禁」（RISK-01 为 P2/风险，仅文档化） |
| 不做 | 不实现多客户端因果链（message.store 排序/合并零改动）；§4.4 复现矩阵留未来支持时的先决 |
| 诚实口径 | 「B-01 正式验收未通过，首次真实联调已执行（2026-08-13，确认 P1/RISK 问题并修复）」替代「真实联调未进行」——四份文档一致；仍标「已开发、未联调」 |

### 2.3 非前端修记录

- 后端旧 `default` 会话 `message_id=""` 工具消息：前端 `RestMessageSchema.message_id` 非空校验**保持不动**（四种不可接受改法——放宽空串/随机生成 ID/fallback key/丢坏消息假装成功——全部拒绝）；按后端配套报告修复新写入并迁移历史数据。

## 3. 关键决策汇总

本批两项决策已定案（用户拍板「全修，按你推荐的来」）：**R1** state/typing 建模为「已知但有意忽略的兼容帧」（strict schema + 显式 no-op + 未知帧仍 fail-closed + 指纹/manifest/fixtures/check:contract 同步）；**R2** FE-INT-RISK-01 按单写者约束文档化，不实现多客户端因果链。

**review 修复轮补充：** spec 轮修复 3 差异（`state: z.string()` 去 min(1) 契约原样、check:contract 13/13 计数、fixture 用真实 trace 帧）+ 4 口径缺口（不纳入 B-01 门禁、否决理由、message_id 四种改法补全、新工具调用/重连回放）；plan 轮修复（ProtocolWarning import、node 一行算指纹规避 zod 变体非确定、T2 否决理由+测试数字、T3 已知限制记录）；最终 review 修 3 Minor（白名单 11 型注释、新增组 7→8 文案）。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 4 实现 commit 完整覆盖 spec §4.1-4.7；独立压测 6 点（schema/handleFrame/manifest 12 份精确/check 13/13/fixture 真实/RISK-01 口径）全过；无 Critical/Important，3 项 Minor 全部修复。

**门禁实测（控制器复跑）：** typecheck ✅ / lint ✅ / **510 单测（46 files）** ✅ / **23 集成（6 files）** ✅（xvfb）/ build ✅ / check:contract **13/13 type + 字段级 63 帧** ✅。

**第三方验收 agent：2/2 达成。** FE-INT-P1-01（§3.3 六条 + §3.4 七条）与 FE-INT-RISK-01（§4.3）逐条源码核对（文件:行号证据），§6 修复后门禁（message_id 保持、check:contract 13/13、诚实口径）全过，无未达成项。一点非阻塞观察：spec 散文「19 条真实帧」与 trace 实际 31 条计数略有出入，但去重后 6 种形状与 fixture 逐条一致，fixture 正确。

## 5. 已知限制（记录，待后续）

- **真实后端复跑不可本批执行**：headless 无真实后端/凭据；「诊断不再出现 RAW_FRAME_INVALID」为 B-01 复跑验证项。
- **state/typing 无 renderer 消费**：契约识别 + 有意忽略；映射独立状态域/UI（FSM 状态/输入指示）留阶段 3+；`state` 为裸 str（未来消费时需产品语义约束）。
- **单写者约束**：多客户端同会话因果顺序不在当前范围；若未来支持，先走清单 §4.4 复现矩阵 + 前后端因果链设计（§4.3 三选一）。
- **后端 `message_id=""` 阻断**：前端保持非空校验；按后端报告修复后 Electron 可开旧 default、执行新工具调用并在重连后稳定回放（后端依赖）。
- **wire fixture state-typing 为 handoff trace 快照帧**：`verified:false` + `unverified`，非本次联调冻结 trace（联调捕获的真实帧未随清单提供原始 JSONL）。
- **B-01 正式验收未通过**：首次真实联调已执行（2026-08-13）确认 P1/RISK 并修复，但 B-01 联调门禁（≥3 真实 raw frame 过 parseRawFrame + mapper + parseBackendEvent 断言 + manifest 回填真实 SHA）待真实后端环境到位后执行。

## 6. 文档同步

- `README.md` / `CLAUDE.md` / `docs/16` 更新到 realint 批次落地状态（510 单测 + 23 集成 + check:contract 13/13 + 单写者约束 + B-01 正式验收未通过/首次联调已执行口径），保留「已开发、未联调」。
- `docs/superpowers/specs|plans/2026-08-13-realint-fix-*` 为设计与实施文档。

---

**首次真实联调整改完成。** 两项（FE-INT-P1-01 state/typing 兼容帧 + FE-INT-RISK-01 单写者口径）全部落地并经 SDD 全分支最终 review PASS（510 单测 + 23 集成 + check:contract 13/13 全绿）+ 第三方验收 2/2。唯一前端 P1 诊断噪声已消除；下一步：B-01 真实后端联调门禁（真实后端环境到位后）+ 阶段 3 完整聊天/历史/多媒体。
