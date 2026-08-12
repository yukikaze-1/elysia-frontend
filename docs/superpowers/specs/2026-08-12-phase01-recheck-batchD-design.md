# Cyrene 阶段 0/1 整改·批次 D：阶段 0 真实性设计

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 D（FE-S0-P1-01 / FE-S0-P1-03 / FE-S0-P2-01 / FE-S0-P2-02）
**审查对象基线：** `main@893240b`（阶段 0/1 整改批次 C 落地后 HEAD）
**范围：** Electron 阶段 0 真实性（首次联调口径冻结 / MockBackend 隔离 / Node 约束 / 占位命令与子 README）
**目的：** 把阶段 0 从「工程主体基本具备、正式门槛未闭合」推进到「口径冻结 + Mock 可信 + 工程约束真实」——为 B-01 真实联调前留下唯一外部依赖（真实后端环境本身）。本批完成后仍标「已开发、未联调」。
**决策：** 本批决策已定案——D1（落文档口径：首次联调=Linux 本机文本闭环 + 三态状态）、D2（Mock 清单全量）、D3（engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出）、D4（占位命令改明确非零退出+「未实现」消息）均为用户拍板。
**文档状态：** v3 定稿（经 code-review 两轮闭环：事实核验 2 差异 + 覆盖 4 缺口 + 设计 8 修正 + 合规 1 不合规 + 复核 14/14 修复 + 2 措辞微调 全整合）

---

## 1. 背景与目标

批次 A/B/C 已落地（493 单测 + 23 集成 + package + verify:artifact 全绿，验收 2/2/2），P0-02 与两个联调前置 P1 已关闭。批次 D 处理整改清单 §8 最后一批——阶段 0 真实性：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-S0-P1-01 | P1 | 阶段 0 门槛与完成声明互相冲突（README 写已完成、docs/16 标进行中、H-01/H-07 未拍板） | 冻结首次联调口径：Linux 本机文本最小闭环 + 三态状态（已开发/已验证/已真实联调），README/docs16/CLAUDE.md 同一状态源（D1） |
| FE-S0-P1-03 | P1 | MockBackend 状态跨实例泄漏、CRUD/多次发送不真实 | 每实例深拷贝会话状态 + 一致 CRUD + 每次 send 注入唯一 ID + 可注入 clock/ID + 可取消单 generation + 并发/多实例测试（D2 全量） |
| FE-S0-P2-01 | P2 | Node 版本「固定」没有由 engines 精确约束 | engines `>=22.23.0 <23` + 启动前版本检查脚本（非零退出，D3） |
| FE-S0-P2-02 | P2 | 占位命令 exit 0 造成假绿；子 README 仍写「占位」 | `test:e2e`/`make` 改明确非零退出 + 未实现消息（D4）；credentials/diagnostics README 更新到真实实现；状态表同步 |

**完成标准**（对照 review §5/§6.3/§6.4/§7.3）：
- 首次联调范围冻结为 **Linux 本机文本聊天最小闭环**（13 项用例：启动 / 设置 Token / 连接 / 列会话 / 激活/新建 / 发送 / ACK / 双通道流式 / completed / 取消 / 断线重连 / 错误展示 / 日志定位）；README/docs16/CLAUDE.md 用统一三态状态（已开发/已验证/已真实联调），阶段 0 标「带已知豁免提前开发」，H-01/H-07 为待拍板输入（不冒充已完成）；
- MockBackend 每实例持有深拷贝会话状态；create/rename/delete/activate/list 形成一致内存模型；每次 send 注入唯一 request/generation/message/response/event ID；提供可注入 clock/ID factory；支持取消单一 generation；增加两次发送/并发发送/两实例隔离/完整 CRUD 单测；
- 根与 desktop package.json engines 改 `>=22.23.0 <23`；启动前版本检查脚本非零退出；
- `test:e2e`/`make` 改明确非零退出 + 「未实现」消息；`credentials/README.md`/`diagnostics/README.md` 更新到真实实现；
- typecheck、lint、493+ 单测、23+ 集成、build、check:contract(11/11) 全绿；CI 五 job（含 artifact/windows）配置保持；
- 文档仍标记「已开发、未联调」；真实后端 B-01 联调与真 Windows Token 冒烟为唯一剩余外部依赖。

## 2. 范围（本批 vs 后续）

**本批做：** FE-S0-P1-01（口径冻结，D1）、FE-S0-P1-03（Mock 隔离，D2）、FE-S0-P2-01（Node 约束，D3）、FE-S0-P2-02（占位命令 + 子 README + 状态表，D4）。

**本批不做**：
- **FE-S0-P1-02（wire fixture 最终 SHA 冻结）**：需真实后端 B-01 冻结 SHA，本批不触碰（批次 C 已落 schemaHash/verified 门禁，`verified:false` 占位待联调时更新）；
- 真实后端联调本身（B-01 未到）；真 Windows Token 冒烟（C3 构建级已确认留 B-01/后续）；
- Live2D 许可/模型（G-01/G-02）、签名证书（H-04）等外部输入（只记录为阻塞项）；
- 审计/凭据/CI 的进一步扩展（批次 C 已落地）。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/main/transport/mock-backend.ts:49-52` | `MOCK_CONVERSATIONS` 模块级可变数组 | 状态跨实例泄漏；`renameConversation` 直接改模块数组（FE-S0-P1-03） |
| `mock-backend.ts:126-147` | createConversation 返回新对象但不入列表；deleteConversation no-op；activate 不保存 | CRUD 不一致、不可观测 |
| `mock-backend.ts:212-220` | `scheduleReplay` 每次 send 回放同一 fixture，generationId/messageId/responseId/eventId 完全相同 | 连续/并发发送产生 ID 冲突 |
| `mock-backend.ts:157-159` | `cancelGeneration` 调 `clearTimers()` 取消全部回放 | 不能取消单一 generation |
| `mock-backend.ts:126-132` | `createConversation` 用 `Date.now()`/`new Date().toISOString()` 生成 id/updatedAt（无注入） | 测试不确定（FE-S0-P1-03） |
| `package.json`（根 + desktop） | `engines.node = ">=22.0.0"` | Node 23/24 被接受，与 .nvmrc 22.23.0 口径不一致（FE-S0-P2-01） |
| `apps/desktop/package.json` scripts | `test:e2e`/`make` = `echo ... && exit 0` | 假绿（FE-S0-P2-02） |
| `credentials/README.md` / `diagnostics/README.md` | 仍写「空占位」「占位」 | 目录已有完整实现（FE-S0-P2-02） |
| `README.md` / `docs/16` | 阶段状态口径不一（README 曾写已完成、docs/16 曾标进行中；现批次 A/B/C 落地但「已验证」未定义） | 三态状态未建立（FE-S0-P1-01） |

### 3.2 技术约束

- **Mock fixture 事件字段**（`fixtures/domain/streaming-reply.jsonl`，11 行）：`eventId`/`sequence`/`generationId`/`messageId`/`responseId`/`conversationId`/`segmentId`/`segmentIndex`/`deltaSequence` 等（`generation.completed` 含 generationId/responseId、**无 messageId/conversationId**——finalize 走 generation.started 捕获，无需补）。每次 send 需注入的唯一字段：`eventId`、`generationId`、`messageId`、`responseId`、`segmentId`（同段事件共享同一新 segmentId）；`conversationId` 用 send 目标；`sequence` 保持模板顺序。**跨 gen 靠唯一 generationId/eventId 区分**——渲染侧 store 是单活跃代守卫（非多代归组注册表），并发 send 的端到端渲染不保证两代都 completed（见 §6 已知限制）；Mock 流本身（subscribe 层）两代独立回放可两代皆 completed。
- **Conversation 契约**（`shared/contracts/conversation.ts:15-20`）：`{ id, title, updatedAt, preview? }`；`CreateConversationInput = { title? }`；`CancelGenerationInput = { generationId }`；`ActivateConversationResult = { conversationId }`。
- **MockBackend 消费方**：`main/index.ts:135`（装配）+ chat-service.spec / mock-replay.spec / mock-backend-state.spec——改造须保持这些既有调用方兼容（构造签名 `MockBackendOptions` 增可选字段，不破坏）。
- **版本检查脚本**：`apps/desktop/scripts/check-node-version.mjs` 读 `../package.json` 的 `engines.node`（单一来源），用 semver 比较 `process.version`，不匹配非零退出。`semver` 是 pnpm 依赖（可用）。脚本逻辑抽 `nodeVersionOk(version, range)` 纯函数供单测（vitest 可 import `.mjs`？——需 `tests/unit/` 配 node 环境 import 纯函数；若不便，脚本内联 + 用 `node --eval` 冒烟验证）。
- **占位命令**：`test:e2e`/`make` 改 `exit 1`——`pnpm package`/`pnpm test:integration` 等真实命令不受影响；文档注明「未实现，非零退出防假绿」。

## 4. 设计

### 4.1 FE-S0-P1-03：MockBackend 隔离与真实性（D2 全量）

`src/main/transport/mock-backend.ts` 重构：

**构造与实例状态：**
- `MockBackendOptions` 增可选 `idFactory?: () => string`、`now?: () => Date`；**默认 `idFactory` 必须全局唯一**（实例内单调计数器 + 时间前缀，如 `gen-${Date.now()}-${++n}`，或 `crypto.randomUUID()`）——**禁裸 `Date.now()`**（同毫秒碰撞会打爆「两次发送 ID 唯一」断言与渲染去重）；`now` 默认 `() => new Date()`；
- 删模块级 `MOCK_CONVERSATIONS`，改 `createMockConversations(): Conversation[]` 工厂（每次返回全新对象数组，**内容与现模块级完全一致**：conv-1001 首位、同 title/updatedAt/preview——保持 mock-replay「内置 2 条 + conv-1001」断言），构造函数 `this.conversations = createMockConversations()`；
- 新增 `private activeConversationId?: string`、`private generationTimers = new Map<string, ReturnType<typeof setTimeout>[]>()`（按 generationId 追踪定时器）。

**CRUD 一致性：**
- `listConversations`：返回 `{ items: this.conversations.map((c) => ({ ...c })), hasMore: false }`（items 每项新对象，防外部 mutate）；
- `getConversation`：从 `this.conversations` 找；找不到抛 `INVALID_INPUT`；
- `createConversation(input)`：`id = this.idFactory()`，`updatedAt = this.now().toISOString()`，push 进 `this.conversations`，返回；
- `renameConversation(id, title)`：找到则改 `title` + `updatedAt = this.now().toISOString()`，返回拷贝；找不到抛 `INVALID_INPUT`；
- `deleteConversation(id)`：从 `this.conversations` 移除；若为 active 则清 active；
- `activateConversation(id)`：校验存在后设 `this.activeConversationId = id`，返回 `{ conversationId }`。

**每次 send 注入唯一 ID：**
- `sendMessage`：生成 `genId = this.idFactory()`、`msgId = this.idFactory()`、`rspId = this.idFactory()`；遍历模板 fixture，每段 `segmentId` 首次出现生成新值并记录映射（后续同段复用——fixture 的 `seg-iv-1`/`seg-pr-1`/`seg-pr-2` 均先 delta 后 segment.completed，映射覆盖完整）；克隆每事件并重写 `eventId`（新，每事件一次 idFactory）、`generationId→genId`、`messageId→msgId`（若字段存在）、`responseId→rspId`（若存在）、`segmentId→映射新值`（若存在）、`conversationId→send.conversationId`；
- 定时器按 genId 注册进 `generationTimers`。

**可取消单一 generation：**
- `cancelGeneration({ generationId })`：仅清除该 gen 的定时器（从 map 删除）；**未知 genId → no-op**（不清任何定时器）；**静默取消不补发终态事件**（事件 schema 无 `generation.cancelled` 类型，补发会被 parseBackendEvent 拒绝；renderer 的 cancel 已乐观置 interrupted 兜底）；
- `disconnect()`/`dispose()` 仍清全部定时器。

**验收测试**（`tests/unit/mock-replay.spec.ts` 扩展 + `tests/unit/mock-backend-state.spec.ts` 保持）：
- 两次发送：`sendMessage` 两次，收集全部事件，断言两轮的 `generationId`/`eventId` 互不相同（无 ID 冲突）；
- 并发发送：不 await 连续两次 send，等待后断言两个 generation 均 completed 且 ID 唯一；
- 两实例隔离：A 实例 create/rename，B 实例 list 不受影响（各自独立状态）；
- 完整 CRUD：create → list 含 → rename → list title 更新 → activate → delete → list 不含 → delete 不存在抛错；
- 可取消单 generation：send 两个，**先等待目标 gen 的 `generation.started` 捕获注入后的 genId 再 cancel**（ClientRequestRef 只含 clientRequestId、无 genId——客户端只能经 started 事件得知 genId，防测试写 race），断言被取消 gen 无后续事件、另一个正常 complete；未知 genId cancel 为 no-op；
- 可注入 clock/ID：传 `idFactory`/`now`，断言确定性（同 idFactory 两次构造同状态、事件 ID 可预测）；
- 既有测试保持（回放顺序 / schema 校验 / list 内置 / 连接状态回调）。

### 4.2 FE-S0-P2-01：Node engines + 版本检查（D3）

- 根与 `apps/desktop/package.json` 的 `engines.node` 改 `">=22.23.0 <23"`（与 `.nvmrc` 22.23.0 一致，Node 23/24 拒绝）；
- 新增 `apps/desktop/scripts/check-node-version.mjs`：**用 `import.meta.dirname` 锚定**读 `../package.json`（`new URL('../package.json', import.meta.url)`）的 `engines.node`——**禁裸 `../package.json` 相对路径**（pnpm `-F` 下 cwd=apps/desktop 会读到根 package.json，根 `check:node` 在仓库根跑会读仓库外，双二义）；用 semver 比较 `process.version`，匹配则 exit 0，不匹配打印「Node 版本需满足 <range>（当前 vX.Y.Z）」exit 1；
- `semver` 加为 `@cyrene/desktop`（或根）的**显式 devDependency**（现为传递依赖，hoisted 下可解析但契约未显式化）；
- `apps/desktop/package.json` 增 `check:node` script + `predev`/`prebuild`/`pretest` hook 调用它——**pnpm 11.20 默认执行 pre/post scripts**（已实测：`pnpm run dev` 先跑 predev、pre exit 3 会 fail-fast 拦截主脚本），方案生效；可选加 `prepackage` 覆盖 `pnpm package` 路径；
- 根 package.json 也增 `check:node`（读根 engines，同样锚定根 package.json）；
- **CI 版本同源声明**：CI 各 job 用 `actions/setup-node node-version-file: .nvmrc`（22.23.0）+ `engineStrict: true`（install 时 engines 兜底）——与新的 `>=22.23.0 <23` 一致，无需改 CI 配置，文档重申即可。

**验收测试**：`apps/desktop/scripts/check-node-version.mjs` 在当前 Node 22.23.0 下 exit 0；逻辑抽纯函数 `nodeVersionOk`（若可行）供单测（`>=22.23.0 <23` 对 22.23.0 true / 23.0.0 false / 22.22.0 false）；`pnpm -F @cyrene/desktop predev` 非零/零退出验证。

### 4.3 FE-S0-P2-02：占位命令 + 子 README（D4）

- `apps/desktop/package.json`：
  - `"test:e2e": "echo 'E2E(Playwright) 留待阶段 3 配置——本命令未实现，非零退出防假绿' && exit 1"`；
  - `"make": "echo 'Forge 打包留待阶段 8 配置——本命令未实现，非零退出防假绿' && exit 1"`；
- **主 README 目录树 `src/preload/` 占位修正**：README 目录树仍写「具名 DesktopApi 占位(contextBridge)」而 preload 已是真实实现（`desktop-api.ts` + `index.ts` contextBridge）——改为真实描述（「具名窄 `desktopApi`（contextBridge，schema 校验）」）；
- `credentials/README.md`：删除「空占位」，改为真实描述——safeStorage 加密 `credentials.json`（0600/原子写）+ 白名单 key + 4 值 credentialStatus + token-origin 绑定 + close/drain（批次 A）；
- `diagnostics/README.md`：删除「占位」，改为真实描述——rotate 日志（5MB×3 + 定时 flush）+ daily append-only 审计（sync + 30 天清理）+ sanitize/redact 双净化 + 退出有序关闭（批次 A/B/C）。

**验收测试**：`pnpm -F @cyrene/desktop test:e2e` 与 `pnpm make` 非零退出（`echo $?` 非 0）；**credentials/diagnostics 子 README 不再含「占位」**（限子 README；主 README 的 `make`/`assets/live2d/` 合法阶段占位保留——`make` 行已补非零退出语义）；主 README 目录树 preload 不再写「占位」。

### 4.4 FE-S0-P1-01：阶段 0 门禁口径冻结（D1）

文档变更（`README.md` / `CLAUDE.md` / `docs/16`）：
- **三态状态**：引入统一「已开发 / 已验证 / 已真实联调」三态；README/docs16/CLAUDE.md 引用同一状态源；
- **首次联调范围冻结**：`首次联调 = Linux 本机文本聊天最小闭环`——后端 SHA/URL/认证方式/启用开关（`SERVE_CHAT` 保持 0，`/` 404 不等于 Electron API 不可用）留 B-01 填；用例 = 启动/设置 Token/连接/列会话/激活新建/发送/ACK/双通道流式/completed/取消/断线重连/错误展示/日志定位；
- **阶段 0 标「带已知豁免提前开发」**：H-01 主验收平台**待拍板**（未选择）、H-07 成功标准**待冻结**（本批以 13 项用例冻结「首次联调成功标准」，H-07 作为正式门禁输入挂起）、Live2D 许可豁免、**Windows 显式记录为「阶段 1 未通过项」**（真 Windows 运行证据未到，见 §5/§6）——不冒充「已验证」；
- **外部依赖清单**：B-01（真实后端环境+认证）、H-01、H-07、G-01/G-02（Live2D）、H-04（签名证书）为阶段通过门禁输入；
- **README 真实联调启动说明章节**：README 增「真实联调启动说明」——Real/Mock 装配（打包恒 Real、未打包默认 Real、`CYRENE_BACKEND=mock` 显式 Mock）、Endpoint/Profile/Token 设置流程、`SERVE_CHAT=0` 策略（`/` 404 ≠ Electron API 不可用）、B-01 联调门禁（≥3 条真实 raw frame 过 parseRawFrame+mapper+parseBackendEvent）；
- docs/16 阶段标题与 README 状态同步为三态口径。

**验收**：文档三处（README/docs16/CLAUDE.md）状态口径一致；无「阶段 0 已完成」残留（改为「带已知豁免提前开发」）；首次联调范围/用例/外部依赖成文。

## 5. 验收与门禁

**门禁（控制器本机复跑）：**
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（493+ 单测，含 Mock 新增）、`xvfb-run -a pnpm test:integration`（23+）、`pnpm build`、`pnpm -F @cyrene/desktop check:contract`（11/11）、`pnpm package` + `xvfb-run -a verify:artifact -- --smoke` 全绿；
- **人工复跑验收**（非 CI 门禁——CI 不含这两条命令）：`pnpm -F @cyrene/desktop test:e2e` / `pnpm make` 非零退出（`echo $?` 非 0）。

**故障注入复测（整改清单 §10 要求）：**
- Mock 两实例隔离 + 两次/并发发送 ID 唯一 + 单 generation 取消（单测覆盖）；
- `predev` 版本检查非零退出（Node 版本不符时拦截）；
- 占位命令非零退出（不再假绿）。

**文档标记：** 本批完成仍标「已开发、未联调」；阶段 0 标「带已知豁免提前开发」；唯一剩余外部依赖 = B-01 真实后端联调 + 真 Windows Token 冒烟 + H-01/H-07 拍板。

## 6. 已知限制（记录，待后续批次/联调）

- **FE-S0-P1-02（wire fixture 最终 SHA）仍待 B-01**：schemaHash/verified 门禁已落（批次 C），`verified:false` 占位在真实后端冻结后更新。
- **渲染侧单活跃代守卫**：并发 send 的端到端渲染不保证两代都 completed（第二代 started 覆盖 accumulator，第一代迟到事件被 generationId 守卫丢弃）——既有行为非本批引入；Mock 流本身（subscribe 层）两代独立回放可两代皆 completed，并发验收测的是 Mock 流（绕过 store）。
- **Mock 的 conversationId 由 send 输入决定**：若 send 目标会话不存在于 mock 列表，Mock 仍回放（不校验）——记录为可接受简化（真实后端会校验）。
- **`test:e2e`/`make` 非零退出可能被 CI 误当失败**：当前 CI 不跑这两条命令；文档注明「未实现占位，勿纳入门禁」。
- **版本检查 hook 仅覆盖 predev/prebuild/pretest**：`pnpm install` 由 `engineStrict: true` 兜底；`pretypecheck` 未挂（typecheck 由 predev/prebuild 前置覆盖）。
- **H-01/H-07/B-01 未到**：阶段 0「已验证」状态仍待主验收平台拍板 + 真实联调；本批只冻结口径。

## 7. 文档同步（本批范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-12-phase01-recheck-batchD-design.md`；
- 实施完成后更新 `README.md` / `CLAUDE.md` / `docs/16`（批次 D 落地状态 + Mock 可信 + Node 约束 + 占位命令非零退出 + **主 README 目录树 preload 修正 + 命令表核对 + 真实联调启动说明章节** + 三态口径 + 测试数字），保留「已开发、未联调」；
- 最终报告 + 验收按整改清单 §10 逐项回报。
