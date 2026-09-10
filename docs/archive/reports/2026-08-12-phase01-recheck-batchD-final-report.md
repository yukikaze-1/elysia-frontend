# Cyrene 阶段 0/1 整改·批次 D 最终报告：阶段 0 真实性

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 D（FE-S0-P1-01 / FE-S0-P1-03 / FE-S0-P2-01 / FE-S0-P2-02）
**HEAD：** main（spec 59a4be9、plan 9fc7d07、实现 fc77eaa..baa5f93 + 口径冻结 234774c 共 4 commits、最终 review 修复 b1f2c0d+27565a7、文档同步 298160b）
**验证基线：** **501 单测（46 files）+ 23 集成（6 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` + `check:contract`(11/11) + `pnpm package` + `verify:artifact -- --smoke` 全绿 + 占位命令非零退出 + predev 版本检查 exit 0
**状态：** 四项全部落地并经 SDD 全分支最终 review（opus）PASS + 第三方验收 agent **4/4 达成**；仍标「已开发、未联调」（阶段 0 标「带已知豁免提前开发」；真实后端 B-01 联调 + 真 Windows Token 冒烟 + H-01/H-07 拍板为唯一剩余外部依赖）

---

## 1. 批次概览

批次 A/B/C 已落地（P0-02 关闭、审计接线、CI 持续门禁）。批次 D 处理整改清单 §8 最后一批——阶段 0 真实性，走完整 SDD 流程（spec→code-review 2 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review 逐任务闭环→全分支最终 review→验收 agent）：

```text
FE-S0-P1-01 首次联调口径冻结 ─▶ FE-S0-P1-03 Mock 隔离与真实性 ─▶ FE-S0-P2-01 Node 约束 ─▶ FE-S0-P2-02 占位命令/子 README/状态表
   (三态+13 项范围+Windows 未通过)   (每实例状态+CRUD+唯一 ID+取消)   (engines+版本检查)   (非零退出+真实化+同步)
```

**流程执行：** spec 经 code-review 2 轮闭环（事实核验 2 差异 + 覆盖 4 缺口 + 设计 8 修正（idFactory 唯一/并发单活跃代/cancel 静默/import.meta 锚定等）+ 合规 1 不合规（主 README preload 占位）+ 复核 14/14，全整合 v3）；plan 经 code-review 2 轮闭环（可执行性实测 4 硬缺陷（as unknown as 双转 / cancel 假红 / collectTwo 泄漏 / 根 check:node 叙事）+ 覆盖 6 缺口（并发发送测试等）+ 复核 12/12，全整合 v2）；subagent 5 任务全部 TDD 实施 + task review 逐任务闭环（T1-T4 各 Spec ✅/Quality ✅）；SDD 全分支最终 review（opus）PASS，无 Critical/Important，1 项新 Minor 收口（docs16 H-07 补入仍缺输入）。

## 2. 交付详情

### 2.1 FE-S0-P1-01：首次联调口径冻结（D1）

| 项 | 内容 |
|---|---|
| 三态状态 | README/CLAUDE/docs16 统一「已开发 / 已验证 / 已真实联调」三态（同一状态源 README「真实模式联调」）；阶段 0 标「带已知豁免提前开发」；docs16 两态规则段改三态 |
| 首次联调范围 | 冻结为 **Linux 本机文本聊天最小闭环**（13 项用例：启动/设置 Token/连接/列会话/激活新建/发送/ACK/双通道流式/completed/取消/断线重连/错误展示/日志定位）；后端 SHA/URL/认证方式/`SERVE_CHAT`（保持 0，`/` 404 ≠ Electron API 不可用）留 B-01 填 |
| Windows | 显式「阶段 1 未通过项」（真机运行证据未到，构建级 CI 不替代冒烟） |
| 外部依赖 | B-01/H-01/H-07/G-01/G-02/H-04 为阶段通过门禁输入 |
| CI 同源 | CI 各 job `node-version-file: .nvmrc` + `engineStrict: true` 与 engines 一致 |
| 启动说明 | README 真实联调启动说明：Real/Mock 装配 + Endpoint/Token 流程 + B-01 门禁（≥3 条真实 raw frame） |

### 2.2 FE-S0-P1-03：MockBackend 隔离与真实性（D2 全量）

| 项 | 内容 |
|---|---|
| 每实例状态 | 删模块级 `MOCK_CONVERSATIONS`，`createMockConversations()` 工厂（与旧默认两会话一致，conv-1001 首位）；每实例 `conversations` |
| 一致 CRUD | create push / rename 改 title+updatedAt / delete splice+清 active / activate 校验存在+设 active / list 每项拷贝；get/delete/activate 找不到抛 INVALID_INPUT |
| 唯一 ID | 每次 send 注入唯一 `eventId`/`generationId`/`messageId`/`responseId`/`segmentId`（segmentId map 同段共享）+ `conversationId` 用 send 目标；默认 idFactory = 计数器+时间前缀（禁裸 Date.now） |
| 可注入 | `idFactory?`/`now?`（测试确定性） |
| 单 gen 取消 | `generationTimers` Map 按 gen 追踪；`cancelGeneration` 未知 no-op + 静默（不补发终态，schema 无 cancelled 类型） |
| 测试 | 两次发送 ID 唯一 / 并发两代 completed / 两实例隔离 / 完整 CRUD / 单 gen 取消（30-40-400 计时）/ 注入 clock+ID 共 6 例 |

### 2.3 FE-S0-P2-01：Node 约束（D3）

| 项 | 内容 |
|---|---|
| engines | 根与 desktop `engines.node` 改 `>=22.23.0 <23`（与 .nvmrc 22.23.0 一致，Node 23/24 拒绝） |
| 版本检查 | `check-node-version.mjs`（`import.meta.url` 锚定读 package.json engines，semver 比较，不匹配 exit 1）+ `node-version-ok.mjs` 纯函数（2 例单测） |
| hooks | `predev`/`prebuild`/`pretest` 调版本检查（pnpm 11.20 默认执行 pre/post，pre 非零 fail-fast 拦截）；根 `check:node` 复用桌面脚本 |
| semver | 显式 devDependency（^7.8.5） |

### 2.4 FE-S0-P2-02：占位命令 + 子 README + 状态表（D4）

| 项 | 内容 |
|---|---|
| 占位命令 | `test:e2e`/`make` 改 `echo 未实现 && exit 1`（非零退出防假绿，CI 不调这两条） |
| 子 README | credentials（safeStorage/0600/白名单/4 值 status/origin 绑定/drain）+ diagnostics（rotate 日志/append-only 审计/双净化/有序关闭）真实化（无「占位」） |
| 主 README | 目录树 preload 改「具名窄 desktopApi」；命令表 test:e2e/make 补非零语义 |
| 状态表 | README/CLAUDE/docs16 数字同步（501/46 + 23/6）+ 批次 D 落地行 |

## 3. 关键决策汇总

批次 D 四项决策已定案：**D1（用户拍板）** 落文档口径（首次联调=Linux 本机文本闭环 + 三态状态）；**D2（用户拍板）** Mock 清单全量；**D3（用户拍板）** engines `>=22.23.0 <23` + 启动前版本检查脚本非零退出；**D4（用户拍板）** 占位命令改明确非零退出+「未实现」消息。

**review 修复轮补充：** 设计轮修复 8 处（默认 idFactory 必须唯一禁裸 Date.now、渲染单活跃代并发不端到端渲染、cancel 静默不补发（schema 无 cancelled）、版本脚本 import.meta 锚定+semver devDep、pnpm 11.20 默认跑 pre/post hooks 等）+ 1 合规不合规（主 README preload 占位）；plan 轮修复 4 硬缺陷（`fresh as unknown as BackendEvent` 双转、cancel 测试假红（30-40-400 计时）、collectTwo 定时器泄漏、根 check:node 叙事）+ 6 覆盖缺口（并发发送测试等）；最终 review 收口 1 项（docs16 H-07 补入仍缺输入）。

**实现期偏差（已记录）：** T1 集成测试红为 headless 环境问题（electron.launch 无显示服务，git stash 复现基线同红，非回归）；T4 三态与历史批次「已开发、未联调」两态并存（语义桥接，docs16 L437 把两态降为「已开发」态的一等标签）。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 6 commit 完整覆盖 spec §4.1-4.5 四项；跨任务链（Mock v2 → Node 约束 → 占位命令/子 README → 口径冻结）无缝隙；独立压测 5 处（Mock 状态/ID 注入/取消、版本脚本锚定、占位命令、口径一致性、文档数字）全过；无 Critical/Important，1 项新 Minor 收口。

**门禁实测（控制器复跑）：** typecheck ✅ / lint ✅ / **501 单测（46 files）** ✅ / **23 集成（6 files）** ✅ / build ✅ / check:contract 11/11 ✅ / package ✅ / verify:artifact -- --smoke ✅ / **占位命令 test:e2e、make 均 exit 1** ✅ / predev + check-node-version 均 exit 0 ✅。

**第三方验收 agent：4/4 达成。** FE-S0-P1-01 / FE-S0-P1-03 / FE-S0-P2-01 / FE-S0-P2-02 逐条源码核对（文件:行号证据），四项「必须修改」与「验收测试」均有实现与测试覆盖，无未达成项。两点非阻塞观察：H-01 是「待拍板」非「已选择」（D1 受控延后，如实挂起）；Live2D 豁免靠「文本闭环」范围隐式体现（缺一行逐字声明）。

## 5. 已知限制（记录，待后续批次/联调）

- **渲染侧单活跃代守卫**：并发 send 端到端渲染不保证两代都 completed（既有行为非本批引入）；Mock 流本身两代独立回放可两代皆 completed。
- **Mock 的 conversationId 由 send 输入决定**：目标会话不存在于 mock 列表仍回放（不校验），记录为可接受简化。
- **版本检查 hook 覆盖 predev/prebuild/pretest**（非 test:integration/package——`pnpm package` 内部 build 不被 prebuild 拦截，`test:integration` 无 pretest）；当前 CI 用 .nvmrc 22.23.0 本就通过。
- **占位命令非零退出**：CI 不含这两条命令（人工复跑验收），文档注明「未实现、勿纳入 CI 门禁」。
- **根 check:node 复用桌面脚本**：校验 apps/desktop engines，依赖两处同值叙事。
- **H-01/H-07/B-01 未到**：阶段 0「已验证」仍待主验收平台拍板 + 真实联调；本批只冻结口径。FE-S0-P1-02（wire fixture 最终 SHA）仍待 B-01（schemaHash/verified 门禁已落，`verified:false` 占位待更新）。
- **批次后续**：阶段 3 完整聊天/历史/多媒体；真实后端 B-01 联调（含 B-01 门禁：≥3 条真实 raw frame）；真 Windows Token 冒烟。

## 6. 文档同步

- `README.md` / `CLAUDE.md` / `docs/16` 更新到批次 D 落地状态（501 单测 + 23 集成 + Mock 可信 + Node 约束 + 占位命令非零退出 + 三态口径），保留「已开发、未联调」。
- `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchD-*` 为设计与实施文档。

---

**批次 D 完成。** 四项整改全部落地并经 SDD 全分支最终 review PASS（501 单测 + 23 集成 + typecheck/lint/build + check:contract 11/11 + package + verify:artifact --smoke + 占位命令非零退出 全绿）+ 第三方验收 4/4。阶段 0 从「工程主体基本具备、门槛未闭合」推进到「口径冻结 + Mock 可信 + 工程约束真实」。**阶段 0/1 整改四批次（A/B/C/D）全部完成**；唯一剩余外部依赖 = 真实后端 B-01 联调 + 真 Windows Token 冒烟 + H-01/H-07 拍板。
