# Cyrene 阶段 2 真实联调整改·批次 C 最终报告：边界与联调门禁

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段2真实联调前端整改清单.md` 批次 C（FE-P2-02 / FE-P2-03 / FE-P2-04）
**HEAD：** main（spec 596d39a、plan ff1dfdf、实现 b224935..885f355 共 7 commits、T8 文档 8a85272 + 修复 43dafe9）
**验证基线：** **433 单测（42 files）+ 22 集成（5 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` + `check:contract`(11/11) 全绿
**状态：** 三项全部落地并经 SDD 全分支最终 review（opus）PASS；仍标「已开发、未联调」（B-01 到位后进入真实联调）

---

## 1. 批次概览

批次 A/B 解决连接入口、编排与运行时健壮性后，批次 C 处理联调前最后的边界与门禁：IPC/response/replay 运行时校验、夹具跨仓库门禁、文档漂移。第三方 review 指出三类问题，按整改清单批次 C 全部处理，走完整 SDD 流程（spec→code-review 3 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review→全分支最终 review）：

```text
FE-P2-02 IPC/response/replay 运行时 Schema ─▶ FE-P2-03 夹具跨仓库门禁 ─▶ FE-P2-04 文档漂移同步
   (Main/Preload 双层校验 + 单条丢弃)          (补 7 场景 + schemaHash 门禁 + 跨仓库脚本)      (README/CLAUDE.md/docs16)
```

**流程执行：** spec 经 code-review 3 轮（事实核验 3 + 整改覆盖 5 + 设计一致性 12 + 复查 7 新问题 N1–N7），27 findings 全整合（v3，含 zod v4 契约与领域契约核验）；plan 经 code-review 2 轮（可执行性审查 11 + 接口核验 F1–F3），14 findings 全整合（v2）；subagent 9 任务全部 TDD 实施 + task review 逐任务闭环；SDD 全分支最终 review（opus）PASS，无 Critical/Important，6 项 Minor 按 triage 记录。

## 2. 交付详情

### 2.1 FE-P2-02：IPC/response/replay 运行时 Schema

| 项 | 内容 |
|---|---|
| 共享 Schema | 新增 `shared/schemas/ipc-response.ts`：`ConnectionState/BackendSession/ClientRequestRef/ActivateConversationResult/RuntimeInfo/EndpointResponse/AssistantSegment/Message/Conversation/Page<T>/MessagePage/ReplayPayload` 12 个，**严格镜像 `contracts` 类型**（Message.content 可选、assistantSegments 用 text?/completed、tool 用 MessageToolInfoSchema、Conversation 无 unread、usage 复用 TokenUsageSchema） |
| Main 双层 | `createIpcHandler` options 扩展 `{ sanitize, channel, logger? }`；responseSchema 失败 → `SCHEMA_VALIDATION_FAILED` + 字段摘要（3 条 path:message）+ `logger?.error('ipc:response-invalid')`（脱敏不记 data 全文）；chat-handlers 14 命令全部弃 `z.unknown()` 传对应 schema（chatSetEndpoint 必填 `z.object({endpoint:z.string()})`，void 命令 `z.undefined()`） |
| Preload 防御 | `unwrap<T>(res, schema)` 校验 data；`isConnectionState` 升级 ConnectionStateSchema 纯守卫；畸形信封兜底 |
| replay 策略 | `filterReplayMessages` 逐条 `MessageSchema.safeParse`，非法 `cyrene:replay:drop-invalid-message` 丢弃（**E2 用户拍板：逐条丢弃不整批拒**），回调收到过滤结果 |

### 2.2 FE-P2-03：夹具跨仓库门禁

| 项 | 内容 |
|---|---|
| 补场景 | 新增 7 组 jsonl + manifest：rejected-ack-empty-messageid（空 messageId+QUEUE_FULL）、rejected-ack-storage-unavailable（retryable）、server-info-full（features/services/build_sha/connectionId）、chat-replay-nonempty（assistant 无 content 带 assistantSegments）、chat-cancelled、chat-reconnect-replay、chat-no-delta-public-reply；全部过 `parseRawFrame` + replay 交叉校验 |
| manifest 门禁 | manifest 扩展 `schemaHash`（= `rawSchemasFingerprint()`，union `_def` 推导 type 集合 + 字段名 + `_def.type` + 枚举/字面量成员）+ `verified` + `scenario`；新增 7 组 `verified:false`+`backendCommit:"unverified"`，既有 4 组 `verified:true`+beeba577；schema 变更 → 指纹变 → 门禁红（联调前禁止漂移） |
| 跨仓库脚本 | `scripts/check-backend-contract.mjs`（`check:contract`）：读后端 `frontend_contract/contract.schema.json`（退化 `ws_message.py` Literal），比对**当前 WS v2 帧子集**（11 型），phase3+ 帧 warn 白名单，type<3 报错，后端缺失 exit 0（CI 不硬依赖）；实测「WS v2 帧覆盖 11/11 + phase3+ 27 warn」 |
| B-01 门禁 | README/CLAUDE.md 记录 B-01 联调门禁：联调首日抓 ≥3 条真实 raw frame（server_info/session/ack/generation）过 parseRawFrame + mapper + parseBackendEvent 断言全过 |

### 2.3 FE-P2-04：文档漂移同步

| 项 | 内容 |
|---|---|
| CLAUDE.md | "What this repository is"（代码已存在/阶段 0-2+批次 A/B/C 落地）、"Commands"（实际脚本 + check:contract 注明无根 shim 用 -F 形式）、"Current status"（批次 A/B/C + 保留「已开发、未联调」+ B-01）更新；测试数字 433+/22+（**G2 用户拍板由前端更新**） |
| README | 状态行「批次 A/B/C 已落地」+ 批次 C 摘要；命令表补 check:contract（-F 形式）；B-01 联调门禁 |
| docs/16 | 头部/阶段视图/变更记录追加批次 C（FE-P2-02/03/04 + 决策 + 门禁数字 + 已知限制）；「已开发、未联调」保留 |

## 3. 关键决策汇总（spec §6）

批次 C 六项决策：**E2/F3/F1/G2 用户拍板**，E1/F4 推荐（记录进文档 + 最终报告提出）：

1. **E2（用户拍板）**：replay 单条消息非法 → **逐条丢弃 + 告警**（不整批拒绝；与批次 B guardDrop 一致，部分数据可用）。
2. **E1（推荐）**：Schema 校验层级 = **Main handler 校验成功响应 + Preload 防御性解析**（双层，整改建议 1/2）。
3. **F1（用户拍板）**：夹具场景 **全部补齐**（整改建议 1-3 全覆盖，前端自造 jsonl 不依赖后端冻结）。
4. **F3（用户拍板）**：跨仓库门禁 = **manifest schemaHash + 本地脚本**（读 `frontend_contract` 交叉检查，CI 不依赖后端路径）。
5. **F4（推荐）**：新增场景 `verified:false` + `backendCommit:"unverified"`；既有 4 组保持 beeba577（整改约束「联调前不更新成未运行过的 SHA」）。
6. **G2（用户拍板）**：CLAUDE.md **由前端更新**（避免新会话被过时描述误导）。

**review 修复轮补充**（spec v3 记录，27 findings 整合）：C1 MessageSchema 严格镜像契约（否则 replay 逐条清空 + getMessages 整页拒绝）、C2 executor 响应校验失败码（原 UNKNOWN 无法暴露 wire 不兼容）、I2 zod v4 泛型、I3 replay 过滤拆两层、I4/I6 指纹从 union `_def` 推导（zod v4 无 toJSON）、I5 replay 交叉校验、N1 executor 作用域扩展、N6 指纹判别 API、N7 setEndpoint 必填 schema 等。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 9 实现 commit + 1 修复 commit 完整覆盖 spec §4.1–4.3 三项 FE；跨任务接口/类型/schema 一致（schema→executor→chat-handlers→preload→replay→fixtures→脚本→文档链条无缝隙）；独立复跑 433 单测 + 22 集成 + typecheck + lint + build + check:contract(11/11) 全绿；无 Critical/Important，6 项 Minor 均不阻塞。

**门禁实测（控制器复跑）：** typecheck ✅ / lint ✅ / **433 单测（42 files）** ✅ / **22 集成（5 files）** ✅ / build ✅ / check:contract 11/11 ✅。

第三方按整改清单批次 C 的验收见 docs/16 变更记录（验收 agent 确认结论）。

## 5. 已知限制（记录，待后续批次/联调）

- **channels.ts 死别名 + 过时注释**（T3 info nit）：`endpointResponseSchema`/`runtimeInfoResponseSchema` 别名无消费方（chat-handlers 改从 @shared/schemas 导入），保留导出；随下批清理。
- **指纹嵌套不敏感**（T5 设计局限）：`rawSchemasFingerprint` 对嵌套 object/record 内部结构变更不敏感（zod v4 object `_def.entries` undefined）；wire-fixtures 直跑 parseRawFrame 兜底，spec §8 已记录边界。
- **跨仓库脚本前端超前 warn 未实现**（spec §4.2.3 声明）：实现只覆盖「后端 type 前端缺 → exit 1」+ phase3+ 滞后计数；前端后续新增非白名单帧 type 时脚本不感知，后续补 diff 计算。
- **executor 摘要含 zod received 值片段**：枚举/标量 mismatch 时 message 含 `received 'xxx'`（短值、协议元数据非聊天正文，风险低）；可与 sanitizer 结合。
- **ipc-response 枚举内联未复用 events.ts**（DRY）：`channel`/`kind` 枚举与 events.ts 的 `SegmentChannelSchema`/`SegmentKindSchema` 双份，有漂移风险；敏感性测试 + replay 交叉校验兜底。
- **chat-reconnect-replay 为单帧**：未实际演练「去重语义」（属 renderer 侧行为，夹具仅演示 wire 形状）。
- **批次后续（阶段 3+）**：附件、搜索、历史查看器、模型/语音、Live2D、工具执行；真实联调（B-01）。

## 6. 文档同步

- `README.md` / `CLAUDE.md` / `docs/16` 更新到批次 C 落地状态（433 单测 + 22 集成 + check:contract + B-01 联调门禁），保留「已开发、未联调」。
- `docs/superpowers/specs|plans/2026-08-12-phase2-realconn-batchC-*` 为设计与实施文档。

---

**批次 C 完成。** 三项整改全部落地并经 SDD 全分支最终 review PASS（433 单测 + 22 集成 + typecheck/lint/build + check:contract 11/11 全绿）。阶段 2 真实联调整改三批次（A/B/C）全部完成，下一步：B-01 真实后端联调（按 README「真实模式联调」小节，含 B-01 联调门禁）。
