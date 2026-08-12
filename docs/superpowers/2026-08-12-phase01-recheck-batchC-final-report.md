# Cyrene 阶段 0/1 整改·批次 C 最终报告：审计与持续门禁

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 C（FE-S1-P1-01 / FE-S1-P1-04）
**HEAD：** main（spec 0693c4d、plan f167dc4、实现 b6ac3b8..42db523 共 4 commits、最终 review 修复 e0f1392、文档同步 08578b5）
**验证基线：** **493 单测（45 files）+ 23 集成（6 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` + `check:contract`(11/11) + `pnpm package` + `verify:artifact -- --smoke` 全绿
**状态：** 两项全部落地并经 SDD 全分支最终 review（opus）PASS + 第三方验收 agent **2/2 达成**；仍标「已开发、未联调」（CI 两新 job 需 push 触发 GHA 验证；真 Windows Token 冒烟留 B-01/后续）

---

## 1. 批次概览

批次 A（跨平台文件与退出地基）、批次 B（Renderer 信任边界，P0-02 关闭）已落地（483 单测 + 22 集成 + package + verify:artifact 全绿）。批次 C 处理整改清单 §8 第三批——审计与持续门禁，走完整 SDD 流程（spec→code-review 2 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review 逐任务闭环→全分支最终 review→验收 agent）：

```text
FE-S1-P1-01 审计业务接线 ─▶ FE-S1-P1-04 CI 持续门禁
   (safeAudit fail-open + 凭据/连接生命周期)   (artifact + windows job + POSIX 平台守卫)
```

**流程执行：** spec 经 code-review 2 轮闭环（事实核验 2 差异 + 覆盖 3 缺口 + 合规 2 硬伤（wrapper 可选链 / 集成测试须轮询）+ 设计 1 缺陷（wrapper 不兜同步抛错）+ 3 一致性注记 + 复核 8/8，全整合 v3）；plan 经 code-review 2 轮闭环（可执行性实测 2 硬缺陷（connect TS2367 / Windows 4 处未守卫）+ 覆盖 1 实质缺口（fail-open 测试缺失）+ 设计 1 缺陷（fail-open 需 safeAudit）+ 复核 6 例实跑全绿，全整合 v2）；subagent 5 任务全部 TDD 实施 + task review 逐任务闭环（T1-T4 各 Spec ✅/Quality ✅）；SDD 全分支最终 review（opus）PASS，无 Critical/Important，4 项新 Minor 中 1 项收口（onTimeout 审计走统一包装）、3 项留档。

## 2. 交付详情

### 2.1 FE-S1-P1-01：审计业务接线（决策 C1/C2）

| 项 | 内容 |
|---|---|
| safeAudit | 新增 `diagnostics/safe-audit.ts`：`safeAudit(audit, event)` 每个调用点局部 fail-open（undefined 早退 + try/catch 兜注入实现同步抛错）——单层 by-construction，操作结果不被审计失败翻转 |
| 统一包装 | `main/index.ts` 装配处 `audit(event)`（Omit<AuditEvent,'ts'> → ts 统一注入 + `.catch` 记 `audit:write-failed` + `diagnostics?.` 可选链防 TS18048）；endpoint:set 与 onTimeout(shutdown:timed-out) 均改走该包装 |
| 凭据审计 | `credentials/index.ts`：set/clear 成功 → `credential:set/clear success`、失败 → `failed code=<code>` + rethrow（不吞错）；status-change（before≠after）经 `maybeLogStatusChange` 独立 try/catch 隔离；summary 只含 key 名/result/code，不写 Token |
| 连接审计（C2） | `chat-service.ts` connect 成功（real/mock 分支写死 mode，防 TS2367）/失败（code 归一化非 CyreneError）+ disconnect；`backend-error-handlers.ts` onError → `connection:error`（白名单 code/backendCode/retryable）；均经 safeAudit |
| 装配注入 | `handlers.ts`/`index.ts` 把 `audit` 透传到 registerCredentialsHandlers + createChatService + buildBackendErrorHandlers |
| fail-open 单测 | credentials-ipc 2 例：audit 抛错 → set 仍 ok:true；set 失败且 audit 抛错 → 原 CREDENTIAL_UNAVAILABLE 保留（真验证不翻转） |
| 集成证据 | `tests/integration/audit-lifecycle.spec.ts`：真实 Electron 经 IPC set/clear 后**轮询**实读 `<userData>/Cyrene/audit/audit-YYYY-MM-DD.jsonl` 断言 `credential:set`/`credential:clear` 行（safeStorage 分支化）——真实应用级审计证据 |

### 2.2 FE-S1-P1-04：CI 持续门禁（决策 C3）

| 项 | 内容 |
|---|---|
| artifact job | `.github/workflows/ci.yml` 新增：clean `rm -rf out dist` + `pnpm --filter @cyrene/desktop package`（内含 build）+ `git rev-parse HEAD > app-sha.txt` 上传 + `xvfb-run verify:artifact -- --smoke`——打包态安全冒烟持续化（P0-02 验收 A6） |
| windows job | 新增：`pnpm typecheck && pnpm lint && pnpm test && pnpm build`（构建级 C3，不启动 Electron；unit 是 node 环境 + build 是打包器，均不需 electron 二进制）+ `app-sha-win.txt` 上传 |
| POSIX 守卫 | safe-open（原 describe `describe.skipIf(win32)` + 5 例 `it.skipIf` + windowsPlatform create 0600 断言平台守卫）+ 扩散 atomic-write/credential-store/file-writer（0600 断言）+ user-data-dirs（chmod 权限例 skipIf）——消除 Windows CI 假红/假绿；评审全仓扫描零遗漏 |
| SHA 证据 | artifact/windows 两 job 各上传 `app-sha*.txt`（`git rev-parse HEAD`），CI run URL 为证据 |

## 3. 关键决策汇总

批次 C 三项决策已定案：**C1（用户拍板）** fail-open（操作成功不假报失败，审计失败只记日志+标缺失）；**C2（用户拍板）** 审计扩展到连接生命周期（connect/disconnect/错误）；**C3（用户拍板）** Windows CI 构建级（install/typecheck/unit/build + Windows 专属 persistence 测试，不启动 Electron）。

**review 修复轮补充：** 设计轮修复 1 缺陷（fail-open 包装不兜注入实现同步抛错 → safeAudit 帮手 + 外层 try/catch）+ 2 硬伤（wrapper `diagnostics?.` 可选链防 TS18048、集成测试须轮询断言防 flaky）+ 3 一致性注记（ts 统一注入、`safeAudit` 调用、放置点）；plan 轮修复 2 硬缺陷（connect summary TS2367 → 分支写死 mode；Windows job 4 处未守卫断言 → 平台守卫扩散）+ 1 实质缺口（fail-open 回归测试缺失 → safeAudit + 2 测试）；最终 review 收口 1 项（onTimeout 审计改走统一包装，消 unhandled rejection 风险）。

**实现期偏差（已记录）：** T3 集成测试「Step 2 红未复现」——T1/T2 已先接线，测试首跑即绿，定位为装配验收/回归门禁（清单 P1-01 #4 要求），不依赖先红后绿，报告如实记录。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 4 实现 commit + 1 修复 commit 完整覆盖 spec §4.1-4.5 两项；跨任务链（safeAudit → credentials/chat/backend-error → main 包装 → 集成测试）无缝隙；独立压测 5 处（fail-open 双层、凭据审计 rethrow、连接审计归一化、集成轮询、CI YAML）全过；无 Critical/Important，4 项新 Minor 中 1 项收口、3 项留档。

**门禁实测（控制器复跑）：** typecheck ✅ / lint ✅ / **493 单测（45 files）** ✅ / **23 集成（6 files）** ✅（含 audit-lifecycle 实读 audit/ JSONL；23 = 22 + 1 无 ±1 漂移）/ build ✅ / check:contract 11/11 ✅ / package ✅ / **verify:artifact -- --smoke ✅**（对应 commit e0f1392）。

**第三方验收 agent：2/2 达成。** FE-S1-P1-01 / FE-S1-P1-04 逐条源码核对（文件:行号证据），「必须修改」5+4 项均有实现与测试覆盖，无未达成项。审计真实应用级证据：audit-lifecycle 集成测试经真实 IPC set/clear 后轮询实读 audit/ JSONL 断言 credential 行——非仅单测 mock。四点非阻塞观察：CI 两新 job 需 push 触发 GHA；wire manifest 仍锚定 beeba577（批次 D FE-S0-P1-02）；`diagnostics/README.md` 标题仍含「占位」（批次 D FE-S0-P2-02）；连接前置失败记 failed 为已记录噪音。

## 5. 已知限制（记录，待后续批次/联调）

- **CI artifact/windows job 需 push 触发 GHA 验证**：本机沙箱无 GHA；本机已等价跑通 ubuntu artifact job 内容（package + verify:artifact --smoke）。真 Windows 首跑（windows-latest）与 user-data-dirs.spec symlink 例在权限充足的 runner 上预期过，若有红需 `it.skipIf(win32)` 微调（评审已列入首跑 watch list）。
- **`audit:write-failed` 日志侧未单测**：fail-open 单测覆盖「操作不翻转」半（safeAudit 层）；main 包装为入口闭包不可独立单测，write-failed 日志侧记为已知覆盖缺口。
- **connect 前置检查失败也记 connection:connect failed**（endpoint/token 未设置等）：属连接生命周期，已记录为可接受噪音。
- **真 Windows 上启动 Electron + Token 生命周期冒烟留 B-01/后续**（C3 明确构建级不启动）。
- **wire manifest 锚定后端 SHA** 与 **`diagnostics/README.md` 占位** 等属批次 D（FE-S0-P1-02 / FE-S0-P2-02）。
- **批次后续（阶段 0/1 整改批次 D）**：阶段 0 真实性（FE-S0-P1-01 首次联调范围冻结 / FE-S0-P1-03 Mock 隔离 / FE-S0-P2-01 Node engines / FE-S0-P2-02 占位命令与子 README）。

## 6. 文档同步

- `README.md` / `CLAUDE.md` / `docs/16` 更新到批次 C 落地状态（493 单测 + 23 集成 + 审计接线 + CI artifact/windows job + Windows 仍阻塞），保留「已开发、未联调」。
- `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchC-*` 为设计与实施文档。

---

**批次 C 完成。** 两项整改全部落地并经 SDD 全分支最终 review PASS（493 单测 + 23 集成 + typecheck/lint/build + check:contract 11/11 + package + verify:artifact --smoke 全绿）+ 第三方验收 2/2。审计从「有实现、无生产者」变成「凭据与连接生命周期有真实审计证据」；打包态安全冒烟与 Windows 平台纳入 CI 持续门禁。下一步：阶段 0/1 整改批次 D（阶段 0 真实性）。
