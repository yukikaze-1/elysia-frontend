# Cyrene 阶段 0/1 整改·批次 B：Renderer 信任边界设计

**日期：** 2026-08-12
**依据：** `docs/review/2026-08-11-阶段0与阶段1首次联调前复核整改清单.md` 批次 B（FE-S1-P0-02 / FE-S1-P2-01）
**审查对象基线：** `main@6a2474b`（阶段 0/1 整改批次 A 落地后 HEAD）
**范围：** Electron 阶段 1 Renderer 信任边界（dev Renderer URL 回环白名单 + 开发 CSP + IPC 来源纵深校验）
**目的：** 关闭首次真实联调前的最后一个 P0 阻断项——未打包启动时任意 `http(s)` `ELECTRON_RENDERER_URL` 被授予完整 Preload API 的凭据外传链；并把「受信 Renderer URL」收敛为 Main 单一策略函数，窗口加载/导航/IPC 来源共用。本批完成后仍标「已开发、未联调」。
**决策：** 本批决策已定案——B1（回环 + 可配置附加 allowlist）与 B2（非法 dev URL 启动报错退出）为用户拍板；B3（`frame-ancestors 'none'` 用 Vite 中间件注入响应头，meta 只放 frame-src/form-action，HMR ws 只放行回环 origin）为推荐。
**文档状态：** v3 定稿（经 code-review 两轮闭环：事实核验 1 锚点 + 覆盖 1 缺口 + 设计 4 缺陷 + 合规 6/6 + 复核 7/7 修复 + 2 微调（win 接口字段/空串用例）全整合）

---

## 1. 背景与目标

批次 A 已关闭「跨平台文件与退出地基」四项（460 单测 + 22 集成 + check:contract 11/11，第三方验收 4/4）。批次 B 处理整改清单 §8 推荐顺序的第二批——Renderer 信任边界，含**首次真实联调前必须修的最后一个 P0**（FE-S1-P0-02）：

| ID | 优先级 | 问题 | 本批目标 |
|---|---|---|---|
| FE-S1-P0-02 | P0 | 任意未打包 `ELECTRON_RENDERER_URL` 被授予完整 Preload API | dev URL 只允许回环 + 可配置 allowlist（B1）；非法 URL **启动报错退出**（B2）；受信策略收敛为 Main 单一函数 |
| FE-S1-P2-01 | P2 | IPC 来源只比较 WebContents，不校验 mainFrame/当前 URL | `isTrustedSender` 校验 mainFrame + 当前 URL（cyrene://renderer 或受信 dev Origin） |

**完成标准**（对照 review §4.2/§7.1）：
- `ELECTRON_RENDERER_URL` 只接受回环（localhost / 127.0.0.0/8 / `[::1]`）+ `CYRENE_DEV_RENDERER_ORIGINS` 附加白名单的 `http:` 地址；拒绝远程 host、userinfo、fragment；非法则**启动报错退出**（B2）；
- 「受信 Renderer URL」为 Main 单一策略函数，窗口加载 / 导航 / IPC 来源校验三处共用；
- IPC 至少校验 `sender === mainWindow.webContents`、`senderFrame === mainFrame`、main frame 当前 URL 符合 `cyrene://renderer` 或受信 dev Origin；
- 开发态 meta CSP 补 `frame-src 'none'`、`form-action 'none'`；`connect-src` 不再用裸 `ws:`/`wss:` scheme，只放行回环 ws Origin；`frame-ancestors 'none'` 经 **Vite 中间件注入响应头**（meta 不支持该指令，B3）；附加白名单 origin 的 ws 由同一中间件动态注入；
- 生产响应头仍保持更严格策略（cyrene:// header CSP 不变）；
- 与已修 FE-P0-01（Endpoint/Token Origin 绑定）联合：不受信页面不能让 Main 向任意地址携带 Token；
- typecheck、lint、460+ 单测、22+ 集成测试、build 全绿；`check:contract` 不回归；
- 文档仍标记「已开发、未联调」。

## 2. 范围（本批 vs 后续）

**本批做：** FE-S1-P0-02（dev URL 回环白名单 + 启动报错退出 + 单一策略函数 + 开发 CSP）、FE-S1-P2-01（IPC mainFrame/URL 校验）。

**本批不做**：
- 真实 Windows CI / Linux packaged artifact job（批次 C FE-S1-P1-04）；
- 审计业务接线（批次 C FE-S1-P1-01）；
- Mock 隔离 / Node engines / 占位命令 / 阶段 0 真实性（批次 D）；
- 打包态的 CSP 或导航改动（生产 `cyrene://` header CSP 已严格，本批不触碰）；
- `preload/desktop-api.ts` 面改动（IPC 来源校验纯 Main 侧）。

## 3. 现状与技术约束

### 3.1 现状（问题点证据）

| 位置 | 现状 | 问题 |
|---|---|---|
| `src/main/config/env.ts:37-49` | `shouldUseViteDevServer` 接受任意可解析 `http:`/`https:` URL | 远程 host / 局域网 IP / userinfo URL 全被信任（FE-S1-P0-02） |
| `src/main/windows/main-window.ts:17-26` | `devUrl` 直接 `new URL(process.env.ELECTRON_RENDERER_URL)`，畸形则 fallback undefined | 与加载谓词各判一次，未走单一策略 |
| `src/main/ipc/registry.ts:11-15` | `isTrustedSender` 只查 `sender === mainWindow.webContents` + `senderFrame` 存在 | 不校验 mainFrame、不校验当前 URL（FE-S1-P2-01） |
| `src/renderer/index.html:7-10` | meta CSP `connect-src 'self' ws: wss:`、无 `frame-src/form-action/frame-ancestors` | 允许任意 WebSocket Origin；iframe 防线缺失（开发态） |
| `electron.vite.config.ts:17-20` | renderer 无 CSP 中间件 | `frame-ancestors 'none'` 无法经 meta 表达（B3） |
| `src/main/protocol/csp.ts` | 生产 header CSP 已严格（`connect-src 'self'`、`frame-src/frame-ancestors/form-action 'none'`） | 本批不动 |

### 3.2 技术约束

- **`frame-ancestors` 只能经响应头**：HTML meta CSP 不支持 `frame-ancestors` 指令——必须用 Vite 开发服务器中间件注入 `Content-Security-Policy` 响应头（B3）。
- **CSP AND 语义**：meta + 响应头并存取**交集**。生产 `cyrene://` header CSP（`connect-src 'self'`）与 meta 的 `ws://localhost:*` 取交 → 生产仍只允许 cyrene: 自身，meta 收紧不削弱生产（已验证 `protocol/csp.ts:1-15`）。
- **Vite HMR WebSocket 默认同源**：页面 `http://localhost:5173` → HMR `ws://localhost:5173`；meta `connect-src ws://localhost:*` 即可覆盖。附加白名单（LAN IP）的 HMR ws 由中间件 header CSP 动态加入。
- **单一策略函数必须 electron-free**：`electron.vite.config.ts`（Node 上下文）也要 import 它构建 CSP——策略模块不得 import electron。
- **`new URL().hostname` 对 IPv6 返回 `[::1]`**（含方括号），回环判定 `hostname === '[::1]' || hostname === 'localhost' || /^127\./.test(hostname)`。
- **集成测试 harness**（`tests/integration/helpers/app.ts`）`launchApp` 已 `delete env['ELECTRON_RENDERER_URL']` → 跑 cyrene:// 路径，不受本批影响；`pnpm dev` 的 `http://localhost:5173` 是回环 → 继续可用。

## 4. 设计

### 4.1 单一策略模块 `src/main/config/trusted-renderer-origin.ts`（决策 B1/B2）

纯 Node（无 electron import），导出：

```ts
/** 回环 hostname：localhost / 127.0.0.0/8 / [::1] */
export function isLoopbackHostname(hostname: string): boolean

/** 规范化 origin：`${protocol}//${host}`（无 path/userinfo/fragment） */
export function normalizeOrigin(url: URL): string

/**
 * 可信 dev Origin 集合：回环 http 恒允许 + env `CYRENE_DEV_RENDERER_ORIGINS`
 * （逗号分隔的 http origin，每条须无 userinfo/fragment，非法条目跳过）——B1。
 */
export function resolveTrustedDevOrigins(env: Record<string, string | undefined> = {}): ReadonlySet<string>

/** URL 是否受信 dev Origin：http: 且无 userinfo/hash 且 origin 在集合内 */
export function isTrustedDevUrl(url: URL, trusted: ReadonlySet<string>): boolean

/** 当前 Renderer 页面 URL 是否受信：cyrene://renderer/* 或受信 dev http Origin（窗口加载/导航/IPC 共用） */
export function isAppRendererUrl(rawUrl: string, trusted: ReadonlySet<string>): boolean

/** 启动评估（B2）：absent=无 env（走 cyrene://）；trusted=合法；untrusted=非法（须启动报错退出） */
export function evaluateDevRendererUrl(
  raw: string | undefined,
  env: Record<string, string | undefined>
): { status: 'absent' | 'trusted' | 'untrusted'; url?: URL; reason?: string }
```

- `evaluateDevRendererUrl`：`raw` 为 falsy（`undefined`/`''`/纯空白，与 `env.ts` 现 `!u` 语义一致）→ `absent`；`new URL(raw)` 失败、协议非 `http:`、含 username/password/hash、或 host 非回环且不在 allowlist → `untrusted`（`reason` 说明具体拒绝项）；否则 `trusted`。
- `isAppRendererUrl`：`cyrene://renderer`（host 精确，路径不限）或 `isTrustedDevUrl` 为真。

### 4.2 env.ts 谓词与启动门禁（B2）

- `env.ts` 的 `shouldUseViteDevServer(isPackaged, env)` 重构：`!isPackaged && evaluateDevRendererUrl(env['ELECTRON_RENDERER_URL'], env).status === 'trusted'`。语义变化：`https:` / 局域网 IP（无 allowlist）现在返回 `false`（原先 true）。
- `main/index.ts` 在 `createDiagnostics`（:104）之后、`ensureMainWindow`（:178）之前的装配区新增启动门禁（须在 `requestSingleInstanceLock` 之后——只有持锁主实例评估；**`fatal` 后必须 `return`**，`fatal` 的 exit 是异步的，不 return 会继续走到注册 handler/建窗，违反 B2 语义）：

```ts
if (!app.isPackaged) {
  const devEval = evaluateDevRendererUrl(process.env['ELECTRON_RENDERER_URL'], process.env)
  if (devEval.status === 'untrusted') {
    fatal(`ELECTRON_RENDERER_URL 指向不受信地址：${devEval.reason}（仅允许回环或 CYRENE_DEV_RENDERER_ORIGINS 白名单 http 地址）`)
    return
  }
}
```
- 打包恒忽略 env（`shouldUseViteDevServer` 已判 `isPackaged` → false；门禁 `!app.isPackaged` 不触发）——保持「打包恒 cyrene://」不变量。

### 4.3 main-window 走单一策略

- `createMainWindow` 的 `devOrigin` 计算改为：`usingDevServer`（`shouldUseViteDevServer`）为真时，从 `evaluateDevRendererUrl(...).url` 取（已受信）；不再独立 `new URL` fallback。`loadURL(devUrl)` 分支不变。

### 4.4 IPC 来源纵深校验（FE-S1-P2-01）

- `registry.ts` 重构 `isTrustedSender` 为可测纯函数 + 运行时接线：

```ts
/** 可测纯守卫：win 为 null/销毁 → false；sender/senderFrame 匹配 + 发送 frame 当前 URL 受信 */
export function isTrustedSenderFor(
  win: { isDestroyed(): boolean; webContents: { mainFrame: unknown } } | null,
  event: { sender: unknown; senderFrame: { url: string } | null },
  trusted: ReadonlySet<string>
): boolean
```
- 运行时 `isTrustedSender(event)` = `isTrustedSenderFor(mainWindow, event, getTrustedDevOrigins())`，其中：
  - `!mainWindow || mainWindow.isDestroyed()` → false；
  - `event.sender !== mainWindow.webContents` → false；
  - `!event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame` → false（**P2-01 新增 mainFrame 校验**）；
  - `isAppRendererUrl(event.senderFrame.url, trusted)` → false 时拒绝（**P2-01 新增：取发送 frame 自身 URL**，先 frame 身份后 URL，顺序不变——`event.senderFrame.url` 是「当前 URL」最精确表达，不依赖 `webContents.getURL()` 的 last-committed 语义）。
- `getTrustedDevOrigins()` = `resolveTrustedDevOrigins(process.env)` 的记忆化单例（env 运行时恒定）；registry 从 `../config/trusted-renderer-origin` import。

### 4.5 开发 CSP（B3）

- **新增 `src/main/config/dev-csp.ts`**（纯函数，electron-free）：

```ts
/** 开发 CSP 值：meta 基线 + frame-ancestors 'none' + connect-src 只放行受信 origin 的 ws/wss */
export function buildDevCsp(trusted: ReadonlySet<string>): string
```
  组成：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://<host>:* wss://<host>:*（每受信 origin）; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'; frame-ancestors 'none'`。
- **`electron.vite.config.ts`** renderer 段加 `apply: 'serve'` 的 `devCspPlugin()`：`configureServer(server)` → `server.middlewares.use((_req, res, next) => { res.setHeader('Content-Security-Policy', buildDevCsp(getTrustedDevOrigins())); next() })`。回环 + 附加白名单 origin 的 ws 全由同一函数动态生成。
- **`src/renderer/index.html`** meta CSP 收紧：`connect-src 'self' ws: wss:` → `connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*`；追加 `frame-src 'none'; form-action 'none'`（`frame-ancestors` 留给响应头）。说明：CSP3 的 `'self'` 已覆盖**同源 ws/wss**（含 allowlist LAN 默认同 port 的 HMR），显式回环 `ws://<host>:*` 为双保险；LAN + 自定义 HMR port 的角落见 §6。生产与 header CSP 取交集 → 不削弱生产（§3.2）。

### 4.6 与 FE-P0-01 联合（已在批次 A 落地，本批验证）

- 阶段 2 批次 A 已实现 Endpoint/Token Origin 绑定（origin 变更自动清 token）。本批 IPC 来源校验 + URL 白名单使「不受信 Renderer 指挥 Main 外传 Token」的两条前置（任意 dev URL 受信、IPC 不校验来源）都被封堵。联合验收见 §5。

**验收测试**：
- 单元（`tests/unit/trusted-renderer-origin.spec.ts` 新）：`isLoopbackHostname`（localhost/127.x/[::1] true，192.168.x/example.com false）；`resolveTrustedDevOrigins`（回环恒有；allowlist 仅 http、无 userinfo/fragment、非法条目跳过）；`evaluateDevRendererUrl`（absent【含 `''`/纯空白 falsy】/ localhost trusted / 127.0.0.1 trusted / `[::1]` trusted / `https://example.test` untrusted / 局域网 IP 无 allowlist untrusted / 带 allowlist trusted / userinfo untrusted / fragment untrusted / 畸形 untrusted）；`isAppRendererUrl`（cyrene://renderer true、cyrene://evil false、受信 http true、异源 false）。
- 单元（`tests/unit/dev-csp.spec.ts` 新）：`buildDevCsp` 含 `frame-ancestors 'none'`/`frame-src 'none'`/`form-action 'none'`；connect-src 含每受信 origin 的 `ws://host:*`/`wss://host:*`；**不含**裸 `ws:`/`wss:` scheme 源。
- 单元（`tests/unit/registry-trust.spec.ts` 新）：`isTrustedSenderFor`——win null / destroyed / sender 不匹配 / senderFrame 缺失或 ≠ mainFrame / senderFrame.url 不受信 → false；全匹配 + cyrene://renderer 或受信 http → true。**注**：`registry.ts` 顶层 import electron，单测需 `vi.mock('electron', ...)`（沿用 `chat-handlers.spec.ts` 先例）。
- 单元（`tests/unit/config-env.spec.ts` 更新）：`shouldUseViteDevServer` 既有 4 例保持；新增 `https://example.test` → false、局域网 IP 无 allowlist → false。
- 集成（`tests/integration/ipc-security.spec.ts` 扩展）：非主窗口 webContents invoke 拒绝（既有）；**新增 subframe invoke 拒绝**（在 `--mode test` cyrene:// 下注入 iframe 的 preload？——若 harness 不易构造，则降级为 `isTrustedSenderFor` 单测覆盖 mainFrame 判别，集成仅保留既有 cross-window 例）。
- 集成/手动（`pnpm dev` 冒烟）：回环 dev URL 正常启动 + HMR ws 放行（本环境 headless 无法开窗，记录为 B-01 联调首日或本机冒烟验证项，不冒充已完成）。

## 5. 验收与门禁

**门禁（控制器复跑）：**
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（460+ 单测，含本批新增）、`pnpm test:integration`（22+）、`pnpm build` 全绿；
- `pnpm package` + `xvfb-run -a pnpm verify:artifact -- --smoke` 复跑一次（P0-02 验收 A6「打包态恒 cyrene://，artifact smoke 不回归」——本批改了 main-window/index.html，须确认打包路径无回归）；
- `pnpm -F @cyrene/desktop check:contract` 不回归（11/11）。

**故障注入复测（整改清单 §10 要求）：**
- 不受信 Renderer：`ELECTRON_RENDERER_URL=https://example.test`（或带 userinfo）→ 单测断言 `evaluateDevRendererUrl` untrusted；启动门禁 fatal 分支（`main` 装配）经源码核对（headless 环境不实跑 Electron 启动，记录为 B-01 联调首日或本机冒烟验证）。
- 不受信页面无法让 Main 携带 Token 外传：联合 FE-P0-01（origin 绑定已修）+ IPC 来源校验 + URL 白名单三层，单测覆盖各层，链路线下核对。

**文档标记：** 本批完成仍标「已开发、未联调」；`pnpm dev` 冒烟与真实联调前验证项如实记录。

## 6. 已知限制（记录，待后续批次/联调）

- **dev 启动冒烟 headless 不可做**：回环 dev URL 启动 + HMR 放行需真实显示环境；记录为 B-01 联调首日或本机 `pnpm dev` 冒烟验证项（本环境 headless + xvfb 仅覆盖打包/integration 路径）。
- **附加 allowlist 仅扩展 ELECTRON_RENDERER_URL 可接受集**：导航到 allowlist 内另一 origin 仍判 `external`（离开应用即系统浏览器），符合语义。
- **受信 dev 页被 XSS 仍持有完整 desktopApi（纵深非根治）**：回环/allowlist 页面内的 XSS 始终能调用 desktopApi（可驱动连接/凭据操作，受权限弹窗与审计兜底）；本批 CSP 与 IPC 来源校验只防御「不受信 origin」，对「受信页被攻破」是纵深而非根治——与 FE-P0-01 的 origin 绑定并列为残留防线。
- **LAN allowlist + 自定义 HMR port 时 HMR 可能失效**：meta `connect-src 'self'` 只覆盖同源（同 host+port）ws；若用户 dev URL 用 allowlist LAN IP 且 `server.hmr.port !== server.port`，该 ws 不被 meta 放行（header 动态注入的 `ws://<host>:*` 与 meta 取交集仍拦截）——热更新断、页面可跑。默认同 port 不受影响（'self' 兜底）；如需 LAN + 异 port HMR，须保持 hmr.port = server.port。
- **allowlist 非法条目静默跳过**：`resolveTrustedDevOrigins` 对 userinfo/fragment/非 http 条目跳过（fail-closed 于该条）；不打印告警（启动期无 logger），如需可后续补。
- **allowlist 条目带 path 被 normalizeOrigin 丢弃**：等效放宽到该整 origin（fail-closed 于 origin 内），无越权。
- **`getTrustedDevOrigins` 记忆化**：读 `process.env` 首调缓存；env 运行时恒定，安全。
- **iframe 集成测试受限**：`--mode test` cyrene:// 下 `frame-src 'none'` 已挡 iframe，无法在集成里构造非 mainFrame invoke 场景；mainFrame 判别由 `isTrustedSenderFor` 单测覆盖。
- **批次后续**：审计接线 + Windows CI + packaged job（批次 C）、阶段 0 真实性（批次 D）。

## 7. 文档同步（本批范围）

- 本 spec 落 `docs/superpowers/specs/2026-08-12-phase01-recheck-batchB-design.md`；
- 实施完成后更新 `README.md` / `CLAUDE.md` / `docs/16`（批次 B 落地状态 + 测试数字 + P0-02 关闭 + dev URL 白名单/`CYRENE_DEV_RENDERER_ORIGINS` 用法），保留「已开发、未联调」；
- 最终报告 + 验收按整改清单 §10 逐项回报。
