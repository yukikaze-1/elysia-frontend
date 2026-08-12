# Cyrene 阶段 0/1 整改·批次 A 最终报告：跨平台文件与退出地基

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 A（FE-S1-P0-01 / FE-S1-P1-02 / FE-S1-P2-02 / FE-S1-P1-03）
**HEAD：** main（spec dc30f93、plan ac6ce0c、实现 96625a8..f2de2e1 共 7 commits、最终 review 修复 cbcbc3c、文档同步 7d1cf44）
**验证基线：** **460 单测（42 files）+ 22 集成（5 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` + `check:contract`(11/11) 全绿
**状态：** 四项全部落地并经 SDD 全分支最终 review（opus）PASS + 第三方验收 agent **4/4 达成**；仍标「已开发、未联调」（Windows 真机证据归批次 C）

---

## 1. 批次概览

阶段 0/1 首次联调前复核清单（2026-08-11）留下的未解决项中，两项是首次真实联调前的 P0/P1 阻断项。批次 A 处理清单 §8 推荐顺序的第一批——跨平台文件与退出地基，走完整 SDD 流程（spec→code-review 2 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review 逐任务闭环→全分支最终 review→验收 agent）：

```text
FE-S1-P0-01 Windows 安全文件首建/ENOENT ─▶ FE-S1-P1-02 非普通文件拒绝 ─▶ FE-S1-P2-02 EMPTY_FILE 工厂 ─▶ FE-S1-P1-03 凭据 drain + 有序退出
   (可注入平台层 + 统一 isFile 不变量)            (O_NONBLOCK + fd 复核)         (多 key 损坏重建不污染)        (steps + 超时标记落盘 + fatal)
```

**流程执行：** spec 经 code-review 2 轮闭环（事实核验 8 条全属实 + 覆盖 7 缺口 + 设计 2 中危缺陷（fatal 无超时兜底 / 超时标记落空）+ 合规 2 建议 + 复核 2 建议级补充，全整合 v3）；plan 经 code-review 2 轮闭环（可执行性实测 2 硬缺陷（T5 TS18048 闭包 / T3 测试 makeStore 二次不同目录）+ 覆盖 1 缺口（T2 clear 变体）+ 设计 8 点全过 + 复核 8/8 修复，全整合 v2）；subagent 6 任务全部 TDD 实施 + task review 逐任务闭环（T1-T5 各 Spec ✅/Quality ✅，无 Critical/Important）；SDD 全分支最终 review（opus）PASS，无 Critical/Important，4 项新 Minor 中 2 项修复、2 项留档。

## 2. 交付详情

### 2.1 FE-S1-P0-01：Windows 安全文件首建 / ENOENT 保留（决策 A1）

| 项 | 内容 |
|---|---|
| 平台层 | `safe-open.ts` 新增 `SafeOpenPlatform`（kind/createFlags/existingReadFlags/existingWriteFlags/preOpenLstat/checkModeMask）+ `posixPlatform`/`windowsPlatform`/`defaultSafeOpenPlatform()`；删除模块级 `isPosix` |
| pre-open lstat | `preOpenCheck`：`create+ENOENT` 放行进入 `O_CREAT|O_EXCL`；`existing+ENOENT` **原样抛原始 errno**（保留 `code:'ENOENT'`，不包 SafeOpenError）→ `CredentialStore.readFile` 判 null → `getStatus()==='empty'`；symlink/junction 拒；其他错误转安全错误 |
| 统一不变量 | open 后一律 `fd.stat()` + `st.isFile()`（Windows/Posix 共用）；`created` → `chmod(0o600)` 兜底 umask |
| 注入测试 | `windowsPlatform` 注入 5 例 + CredentialStore 构造第 5 参 `platform?` 透传端到端（干净文件 empty、set 后新实例可读回）——Linux 单测全量覆盖 Windows 控制流 |

### 2.2 FE-S1-P1-02：非普通文件拒绝（决策 A2）

| 项 | 内容 |
|---|---|
| O_NONBLOCK | POSIX existing 读/写 flags 追加 `O_NONBLOCK`（对普通文件无操作）；FIFO `existing+read` 立即返回、`existing+append` 无 reader 走 ENXIO——均不阻塞 |
| fd 复核 | post-open `st.isFile()` 拒 FIFO/socket/目录/device；`create` 遇 EEXIST fallback 重开 existing 走同一复核 |
| 保留 | `O_NOFOLLOW`、权限位（read 0400 / write 0600 无 group/other）、realpath 包含性复核均保留 |
| 测试 | FIFO read/append、Unix socket、目录、`/dev/null`、create 遇既有 FIFO fallback——5 例全部立即拒绝 |

### 2.3 FE-S1-P2-02：EMPTY_FILE 工厂化

| 项 | 内容 |
|---|---|
| 工厂 | 删模块级可变 `EMPTY_FILE`，新增导出 `createEmptyFile()` 每次返回全新对象；`set/clearCredential` 改 `?? createEmptyFile()` |
| 测试 | `not.toBe` 全新对象 + 自定义 allowlist 多 key（A set backend.token+model.llm.key → 损坏 → B set model.stt.key → 旧 key 不残留）+ 两个 Store set/clear 损坏重建回归守卫 |

### 2.4 FE-S1-P1-03：凭据 drain + 有序退出 + fatal 路径

| 项 | 内容 |
|---|---|
| CredentialStore | `close()` 幂等（共享 closePromise）：置 closed → `await queue`（等待已接纳操作落盘）→ 清明文 cache；新写抛 `CREDENTIAL_STORE_CLOSED`（新增错误码，避开 Pinia store 术语）；getStatus/getCredential 防御返回 |
| shutdown.ts | 重构为 `createShutdownHandler({ steps[], quit, timeoutMs?, onTimeout?, onError? })`：每步独立 try/catch；循环顶 timedOut 检查（超时后不再启动新 step）；`race(runAll, timeout)` → finally `clearTimeout`（无残留计时器）+ `allowQuit` 恰一次 quit；`onTimeout` try/finally 包裹；超时后迟到 reject 不调 onError |
| 超时标记落盘 | `onTimeout` 写**同步 audit**（auditor sync:true 逐行 fsync，即时持久）+ logger.warn；硬超时下异步日志 batch 可能丢失，审计行是唯一持久记录 |
| 统一 fatal | `createFatalShutdown`：diagnostics 已建则 `race(closeAll, 1.5s)` 后无条件 `exit(1)`（closeAll 挂起也有兜底）；`main()` 删除局部 const、模块级 `let diagnostics` 赋值；两处既有闭包改 `diagnostics?.`（TS18048）；failStart 7 处调用点改 fatal；**single-instance `app.exit(0)` 未动** |
| 退出顺序 | before-quit steps = 凭据 → adapter(`disconnect`) → diagnostics(`closeAll`)；`onTimeout`/`onError` 均脱敏 |

## 3. 关键决策汇总

批次 A 两项决策已定案：**A1（用户拍板）** 安全文件平台差异抽成可注入平台层（不依赖真实 Windows CI 先闭环 Linux 侧回归；真实 Windows CI 归批次 C）；**A2（推荐）** 非普通文件全拒 + POSIX `O_NONBLOCK` + drain/退出超时命名常量 `SHUTDOWN_TIMEOUT_MS = 1500`。

**review 修复轮补充：** 设计轮发现并修复 2 中危缺陷——fatal 路径 `closeAll` 挂起无超时兜底（补 `race` 1.5s）、硬超时下超时标记随未 flush 日志丢失（改经同步 audit 落盘）；plan 轮发现并修复 2 硬缺陷——T5 模块级 `diagnostics` 闭包 TS18048（补 `?.`）、T3「重启可读」测试误用 `makeStore()` 两次不同目录（改显式共享 file）；最终 review 补 2 修复——windows create 首建 0600 断言、shutdown catch `timedOut` 守卫。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 9 实现 commit 完整覆盖 spec §4.1-4.3 四项；跨任务接口/语义链（平台层→store 注入→shutdown steps→main 装配）无缝隙；独立源码级核验 5 处压测点（safe-open 错误流 / close 时序 / shutdown race / fatal 闭包 / 装配）全过；无 Critical/Important，4 项新 Minor 中 2 项已修、2 项留档。

**门禁实测（控制器复跑）：** typecheck ✅ / lint ✅ / **460 单测（42 files）** ✅ / **22 集成（5 files）** ✅（headless 需 `xvfb-run -a`，环境限制非回归）/ build ✅ / check:contract 11/11 ✅。

**第三方验收 agent：4/4 达成。** FE-S1-P0-01 / FE-S1-P1-02 / FE-S1-P2-02 / FE-S1-P1-03 逐条源码核对（文件:行号证据），四项「必须修改」与「验收测试」均有实现与测试覆盖，无未达成项。FIFO 故障注入复测（0600 FIFO 置凭据/日志位置）三例单测 340ms 快速通过——不阻塞、不挂死。两点非阻塞观察：无 X display 时集成测试需 xvfb-run（环境性）；`user-data-dirs.ts`/`atomic-write.ts` 各有独立 `isPosix` 常量（批次范围外模块，atomic-write 经 `openSafeFile` 默认平台走统一不变量）。

## 5. 已知限制（记录，待后续批次/联调）

- **Windows 分支仍是注入平台层单测**：真实 Windows CI 归批次 C（FE-S1-P1-04）；本批的 `windowsPlatform` 注入覆盖控制流，不替代真 Windows 运行证据；Windows 联调仍阻塞（整改清单 §9.2）。
- **IPC 不显式注销**：退出时 CredentialStore 关闭即拒新写，chat/其他 handler 由 `adapter.disconnect()` 兜底；不额外做 handler 注销（1.5s 退出窗口内足够）。
- **超时与 step 启动存在 ≤ 定时器精度的竞态窗口**：一个 step 可能恰在超时阈值前启动；影响低，循环顶 `timedOut` 检查兜底。
- **硬超时下 adapter/diagnostics 可能被跳过**：credentials 挂起 >1.5s 时，超时标记经同步 audit 持久、但异步日志 batch 与 `adapter.disconnect()` 可能未执行；诚实记录（整改清单 FE-S1-P1-03 第 3 条）。
- **onTimeout 审计写为 fire-and-forget**：同步写已发出但不 await 再 quit（保持硬超时「立即退出」语义）；in-flight 审计 fs 在 `app.quit()` 下仍持事件循环——真磁盘卡死场景退出可能延迟，属 `app.quit()` 既有语义，后续批次如需绝对硬退出可改超时后 `app.exit()`。
- **Windows 设备形态无 Linux 单测**：统一 `isFile()` 不变量覆盖目录/FIFO/socket；真 Windows 设备边界测试归批次 C。
- **批次后续（阶段 0/1 整改批次 B/C/D）**：Renderer 信任边界（FE-S1-P0-02/P2-01）、审计接线 + Windows CI + packaged job（FE-S1-P1-01/P1-04）、阶段 0 真实性（FE-S0-P1-01/P1-03/P2-01/P2-02）。

## 6. 文档同步

- `README.md` / `CLAUDE.md` / `docs/16` 更新到批次 A 落地状态（460 单测 + 22 集成 + check:contract 11/11 + Windows 联调仍阻塞），保留「已开发、未联调」。
- `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchA-*` 为设计与实施文档。

---

**批次 A 完成。** 四项整改全部落地并经 SDD 全分支最终 review PASS（460 单测 + 22 集成 + typecheck/lint/build + check:contract 11/11 全绿）+ 第三方验收 4/4。两个联调前置 P0/P1 阻断项（Windows 首建、FIFO/device 阻塞）已关闭；下一步：阶段 0/1 整改批次 B（Renderer 信任边界）。
