# Cyrene 阶段 0/1 整改·批次 B 最终报告：Renderer 信任边界

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 B（FE-S1-P0-02 / FE-S1-P2-01）
**HEAD：** main（spec 220c81a、plan 39715ad、实现 a0251a0..cfbed52 共 6 commits、最终 review 修复 04aab0a+d8a107c、文档同步 a827475）
**验证基线：** **483 单测（45 files）+ 22 集成（5 files）** + `pnpm typecheck` + `pnpm lint` + `pnpm build` + `check:contract`(11/11) + `pnpm package` + `verify:artifact -- --smoke` 全绿
**状态：** 两项全部落地并经 SDD 全分支最终 review（opus）PASS + 第三方验收 agent **2/2 达成**；**P0-02 关闭**（首次真实联调前最后 P0）；仍标「已开发、未联调」（`pnpm dev` 回环启动冒烟 headless 未实跑，记 B-01 联调首日验证项）

---

## 1. 批次概览

批次 A 关闭「跨平台文件与退出地基」四项后，批次 B 处理整改清单 §8 第二批——Renderer 信任边界，含首次真实联调前必须修的**最后 P0**（FE-S1-P0-02）。走完整 SDD 流程（spec→code-review 2 轮闭环→plan→code-review 2 轮闭环→subagent 逐任务实施→task review 逐任务闭环→全分支最终 review→验收 agent）：

```text
FE-S1-P0-02 dev URL 回环白名单 ─▶ FE-S1-P2-01 IPC 来源纵深
   (单一策略函数 + 启动报错退出 + 开发 CSP)   (mainFrame + senderFrame.url 校验)
```

**流程执行：** spec 经 code-review 2 轮闭环（事实核验 1 锚点 + 覆盖 1 缺口 + 设计 4 缺陷（fatal 缺 return / 空字符串边界 / senderFrame.url 语义 / LAN HMR 角落）+ 合规 6/6 + 复核 7/7 + 2 微调，全整合 v3）；plan 经 code-review 2 轮闭环（可执行性实测 1 致命缺陷（T1 回环端口不匹配）+ 覆盖 10/10 + 设计 1 严重（同根因）+ 复核 60/60 实跑验证，全整合 v2）；subagent 5 任务全部 TDD 实施 + task review 逐任务闭环（T1-T4 各 Spec ✅/Quality ✅）；SDD 全分支最终 review（opus）PASS，无 Critical/Important，1 项新 Minor 留档。

## 2. 交付详情

### 2.1 FE-S1-P0-02：dev Renderer URL 信任范围（决策 B1/B2/B3）

| 项 | 内容 |
|---|---|
| 单一策略模块 | 新增 `config/trusted-renderer-origin.ts`（electron-free，Vite 配置可复用）：`isLoopbackHostname`（localhost / `[::1]` / IPv4 127.0.0.0/8 四段点分）、`normalizeOrigin`（`protocol://host` 含端口）、`resolveTrustedDevOrigins`（回环恒允许 + `CYRENE_DEV_RENDERER_ORIGINS` allowlist，http 仅、无 userinfo/fragment、非法条目跳过）、`isTrustedDevUrl`（回环短路任意端口 + allowlist 精确 origin）、`isAppRendererUrl`（cyrene://renderer 精确 host + 拒 userinfo + 受信 dev origin）、`evaluateDevRendererUrl`（absent/trusted/untrusted 三态 + reason）、`getTrustedDevOrigins`（记忆化） |
| env 谓词 | `shouldUseViteDevServer` 重构为 `!isPackaged && evaluateDevRendererUrl(...).status === 'trusted'`；语义变化（https/局域网无 allowlist → false） |
| 启动门禁（B2） | `main/index.ts` 在 `requestSingleInstanceLock` 之后、建窗前：`!app.isPackaged` → untrusted → `fatal(reason)` + **`return`**（fatal exit 异步，不 return 会继续建窗） |
| 单一来源 | `main-window.ts` 的 `devOrigin` 仅从 `evaluateDevRendererUrl(...).url` 取；窗口加载 / 导航（`classifyNavigation` 同 devOrigin）/ IPC（`isAppRendererUrl`）三处共用 |
| 开发 CSP（B3） | 新增 `config/dev-csp.ts` `buildDevCsp`（`frame-ancestors`/`frame-src`/`form-action 'none'` + connect-src 逐受信 origin 的 `ws://<hostname>:*`/`wss://<hostname>:*` + 保留 `style-src 'unsafe-inline'`）；`electron.vite.config.ts` `apply:'serve'` 中间件注入响应头；`index.html` meta 收紧（`connect-src 'self' ws://localhost:* ws://127.0.0.1:*` 去裸 ws:/wss: + `frame-src/form-action 'none'`） |
| 生产隔离 | `protocol/csp.ts` 零改动；header `connect-src 'self'` ∩ meta → 仍 cyrene only |

### 2.2 FE-S1-P2-01：IPC 来源纵深

| 项 | 内容 |
|---|---|
| 可测纯守卫 | `registry.ts` 新增 `isTrustedSenderFor(win, event, trusted)`：win null/destroyed → senderFrame 缺失 → sender !== webContents → senderFrame !== mainFrame → `isAppRendererUrl(event.senderFrame.url)`（先 frame 身份后 URL，顺序不变） |
| 运行时接线 | `isTrustedSender = isTrustedSenderFor(mainWindow, event, getTrustedDevOrigins())` |
| URL 语义 | 取 `event.senderFrame.url`（发送 frame 当前 URL），比 `webContents.getURL()` last-committed 更精确 |
| 回归覆盖 | 隐藏第二窗口（集成 cross-window 拒绝）/ subframe（单测 `sub !== mainFrame`）/ 错误 cyrene host / 远程 dev origin / 导航后旧 frame（身份 + 当前 URL 双校验） |

## 3. 关键决策汇总

批次 B 三项决策已定案：**B1（用户拍板）** 回环 + `CYRENE_DEV_RENDERER_ORIGINS` 附加 allowlist；**B2（用户拍板）** 非法 dev URL 启动报错退出（fatal + return）；**B3（推荐）** `frame-ancestors 'none'` 经 Vite 中间件注入响应头（meta 不支持该指令），meta 只放 frame-src/form-action，HMR ws 只放行回环 origin。

**review 修复轮补充：** 设计轮修复 4 缺陷（门禁 fatal 后缺 return、空字符串 env 边界不一致、URL 校验改 senderFrame.url、LAN + 自定义 HMR port 角落入限制）；plan 轮修复 1 致命缺陷（回环端口不匹配——`normalizeOrigin` 含端口但基础集合无端口条目 → 全部回环 URL 判 untrusted，用 `isLoopbackHostname` 短路修复并激活死代码）；最终 review 修复 2 处安全收紧（`isLoopbackHostname` 的 `/^127\./` 前缀误判 `127.0.0.1.evil.example` 域名 → 改四段点分；`isAppRendererUrl` cyrene 分支拒 userinfo）+ 1 处运行回归（verify:artifact smoke 报 Chromium 拒 `connect-src ws://[::1]:*` invalid source → 去掉 IPv6 显式源，同源 ws 由 `'self'` 覆盖，实跑确认）。

**实现期偏差（已记录）：** T3 的 `isTrustedSender` 收紧破坏批次 C 既有 `chat-handlers.spec.ts` 5 个「真实接线」用例（伪造 sender 替身不满足新守卫）——最小夹具更新（`senderFrame === mainFrame` + 受信 URL）恢复 10/10，评审确认该夹具更忠实于真实 Electron 身份契约，偏差可接受。

## 4. 验收

**SDD 全分支最终 review（opus）：PASS。** 6 实现 commit + 2 修复 commit 完整覆盖 spec §4.1-4.5 两项；跨任务接口链（单一策略 → 门禁/窗口 → IPC → CSP）无缝隙；独立压测 5 处（策略函数回环/allowlist、门禁时序、IPC 四条件、CSP 交集与生产隔离、devOrigin 单一来源）全过；无 Critical/Important，1 项新 Minor（dev frame URL 的 hash 不对称——当前无 hash 导航不破坏，留档）。

**门禁实测（控制器复跑）：** typecheck ✅ / lint ✅ / **483 单测（45 files）** ✅ / **22 集成（5 files）** ✅（headless 需 xvfb-run）/ build ✅ / check:contract 11/11 ✅ / package ✅ / **verify:artifact -- --smoke ✅**（修复 IPv6 源后「无 CSP console 报错」通过）。

**第三方验收 agent：2/2 达成。** FE-S1-P0-02 / FE-S1-P2-01 逐条源码核对（文件:行号证据），「必须修改」5 项（P0-02）与「回归场景」5 项（P2-01）均有实现与测试覆盖，无未达成项。不受信 Renderer 故障注入复测：`evaluateDevRendererUrl` 单测矩阵全绿（absent/回环 trusted/https/局域网/userinfo/fragment/畸形 untrusted + allowlist trusted）；启动门禁 fatal 分支经源码核对（headless 不实跑 Electron 启动，记 B-01 联调首日冒烟）。两点非阻塞观察：集成测试裸跑需 xvfb（环境性）；`evaluateDevRendererUrl` 返回 URL 含 path 时 loadURL 会加载该 path（与批次前行为一致，非回归）。

## 5. 已知限制（记录，待后续批次/联调）

- **`pnpm dev` 回环启动冒烟 + HMR 放行 headless 未实跑**：xvfb 仅覆盖打包/集成路径；记录为 B-01 联调首日或本机 `pnpm dev` 冒烟验证项，不冒充已完成。
- **受信 dev 页被 XSS 仍持有完整 desktopApi（纵深非根治）**：本批 CSP + IPC 来源校验只防御「不受信 origin」；受信页内 XSS 仍可调用 desktopApi（受权限弹窗与审计兜底），与 FE-P0-01 origin 绑定并列为残留防线。
- **LAN allowlist + 自定义 HMR port 时 HMR 可能失效**：meta `connect-src 'self'` 只覆盖同源（同 host+port）ws；异 port 场景热更新断、页面可跑；默认同 port 不受影响。
- **dev frame URL 的 hash 不对称**：`isTrustedDevUrl` 拒 hash 而 cyrene 分支允许；当前无 hash 导航（无 vue-router），不破坏；若未来引入 hash 导航，dev 下 IPC 会静默拒绝——引入前需记录。
- **allowlist 非法条目静默跳过 + 带 path 条目归一放宽至整 origin**：fail-closed 于该条/该 origin 内，无越权。
- **`getTrustedDevOrigins` 记忆化**：Vite 配置进程与 Electron main 各持一份，均读同一 env，dev 下一致。
- **批次后续（阶段 0/1 整改批次 C/D）**：审计接线 + Linux packaged/Windows CI（FE-S1-P1-01/P1-04）、阶段 0 真实性（FE-S0-P1-01/P1-03/P2-01/P2-02）。

## 6. 文档同步

- `README.md` / `CLAUDE.md` / `docs/16` 更新到批次 B 落地状态（483 单测 + 22 集成 + P0-02 关闭 + `CYRENE_DEV_RENDERER_ORIGINS` 用法 + Windows 仍阻塞），保留「已开发、未联调」。
- `docs/superpowers/specs|plans/2026-08-12-phase01-recheck-batchB-*` 为设计与实施文档。

---

**批次 B 完成。** 两项整改全部落地并经 SDD 全分支最终 review PASS（483 单测 + 22 集成 + typecheck/lint/build + check:contract 11/11 + package + verify:artifact --smoke 全绿）+ 第三方验收 2/2。**首次真实联调前最后 P0（FE-S1-P0-02）已关闭**；下一步：阶段 0/1 整改批次 C（审计与持续门禁）。
