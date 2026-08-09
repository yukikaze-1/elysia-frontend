# 阶段 1 块 A：安全加载与环境基线 —— 设计

**日期：** 2026-08-09
**状态：** 已呈现设计 / 决策已拍板（批次 1-4，见 §3） / 待 code-review
**关联：** [doc 07 §4 Electron 基线](../07-Cyrene-Electron前端安全设计-v0.2.md#L64)、[doc 07 §5 CSP](../07-Cyrene-Electron前端安全设计-v0.2.md#L88)、[doc 09 §3/§4/§5 环境与构建](../09-Cyrene-前端构建打包与发布设计-v0.2.md#L37)、[doc 16 §4 阶段 1](../16-Cyrene-前端实施任务清单与进度跟踪.md#L191)、块 A 前置 spec [2026-08-08-phase1-foundation-design.md](2026-08-08-phase1-foundation-design.md)

---

## 1. 背景与目标

阶段 1 第一块（地基）已落地：9 子目录、App 身份/userData 七目录、具名 zod 校验 IPC 骨架、主窗口导航/单实例加固。块 A 在其之上补齐**安全加载与环境基线**：把「打包版 Renderer 依赖 `file://`」与「只有 Phase 0 基础 meta CSP」这两处短板，升级为受限自定义协议 + 严格 CSP + 生产安全默认，并建立 dev/test/prod 环境配置与最小打包/产物验证流程。

目标：

1. 建立 **dev/test/prod 三环境配置**（构建时 `__APP_MODE__` 注入），生产安全默认硬编码、env 无法覆盖；
2. 打包版 Renderer 经 **`cyrene://` 受限自定义协议**加载（只读服务渲染根，fail-closed），替代任意 `file://` 路径映射；
3. 落地**严格 CSP**（无 `unsafe-eval`、`frame-src 'none'` 收口 G-6 iframe 缺口、`style-src 'self'`），prod 经协议响应头注入，dev 保留 meta 宽松版；
4. 生产构建**恒关 DevTools**、**远程调试端口启动即拒绝**；
5. 最小打包：electron-builder `dir` 未分发包 + `verify:artifact` 产物检查。

## 2. 范围

| 项 | 内容 |
|---|---|
| 环境配置 | `src/main/config/`：`env.ts`（纯函数 `resolveAppConfig`）+ `index.ts`（`getAppConfig`）；electron.vite.config 函数式注入 `__APP_MODE__` |
| 自定义协议 | `src/main/protocol/`：`scheme.ts`（特权注册，ready 前）+ `handler.ts`（`protocol.handle` 只读服务渲染根）+ `path.ts`（纯函数路径解析）+ `csp.ts`（`buildRendererCsp`） |
| 加载迁移 | 打包版 `loadFile(file://)` → `loadURL('cyrene://renderer/index.html')`；`will-navigate` prod 分支改 scheme+host 判定 |
| 生产安全默认 | packaged 检测 `--remote-debugging-port` → failStart 拒绝；prod `devToolsAllowed=false` 且 env 无法覆盖 |
| 最小打包 | electron-builder `dir` 未分发包 + `verify:artifact`（静态检查 + Playwright 启动冒烟） |
| dev 便利 | dev 模式 F12 切换 DevTools（`before-input-event`，仅 `devToolsAllowed` 时注册） |

**非目标（后续块/阶段）：** 附件/媒体经自定义协议服务（阶段 3）、Forge 全量安装包与 asar/Fuses（阶段 8）、公开事件订阅/取消函数（阶段 2）、凭据存储与日志审计（块 B）、集成测试套件（块 C）。

## 3. 决策记录（拍板）

用户批次 1-4 已拍板（含推荐采纳项）：

| # | 决策 | 结论 |
|---|---|---|
| D-1 | 块分组 | 3 组 specs：A 安全加载与环境 / B 主进程受信服务 / C 阶段1安全收口；顺序 A→B→C |
| D-2 | 协议迁移 | **本次迁移** Renderer 到 `cyrene://`（dev 仍走 Vite http） |
| D-3 | 环境划分 | dev / test / prod；staging 留阶段 2（B-01 未到位） |
| D-4 | 最小打包 | electron-builder `dir` 未分发包 + `verify:artifact`；Forge 全量留阶段 8 |
| D-5 | 远程调试端口 | packaged 检测 `--remote-debugging-port` → **启动即拒绝**（failStart + exit） |
| D-6 | CSP 交付 | **prod = protocol 响应头注入严格 CSP，与 index.html 保留的宽松 meta AND 取交集**（严格头胜出，meta 不剥离——**真实用途是 dev（electron-vite dev）http 场景的 CSP**；`pnpm start` preview 不设 `ELECTRON_RENDERER_URL` → 走 cyrene:// 严格头）；AND 耦合（改 dev meta 会静默改变 prod 有效策略）记为已知限制 G-9 |
| D-7 | 诊断导出 | 本次不做（阶段 7 安全收敛统一做） |
| D-8 | 集成测试 runner | vitest + playwright 库（块 C 落地，复用现有 `vitest.integration.config.mts`） |
| D-9 | CI 集成测试 | 块 C 加 `test:integration`（xvfb-run + playwright install）；本地也跑 |
| D-10 | Playwright 依赖 | 块 A 起正式加 devDependency（`verify:artifact` 启动冒烟即用；块 C 复用） |
| D-11 | 协议命名/特权 | scheme `cyrene` + host `renderer`；特权 `standard/secure/supportFetchAPI/stream`，`corsEnabled:false`，`bypassCSP:false` |
| D-12 | mode 注入 | electron-vite `define` 烘焙 `__APP_MODE__`；运行时 `typeof` 守卫，**缺失/未知一律归 `production`**（不信任 NODE_ENV env，防 env 翻转 mode） |
| D-13 | dev DevTools | dev F12 可切换（`before-input-event`），不自动弹；**打包（isPackaged）恒关且无任何路径**——移除默认应用菜单（`Menu.setApplicationMenu(null)`，否则隐藏菜单栏下的 View→Toggle Developer Tools 加速键仍可用） |
| D-14 | 打包细节 | `appId=com.cyrene.desktop`、`productName=Cyrene`、`files:[out/**,package.json]`、`asar:false`（阶段 8 再评估） |
| D-15 | 集成测试产物 | 块 C 跑 `--mode test` 构建（近生产形态 + 允许临时 userData/URL 注入） |
| D-16 | verify 冒烟 | 块 A `verify:artifact` = 静态检查 + Playwright 启动冒烟（复用 smoke-electron 骨架）；块 C 正式化为 test:integration |
| D-17 | 加载判定谓词 | **`shouldUseViteDevServer(isPackaged, env) = Boolean(env['ELECTRON_RENDERER_URL']) && !isPackaged`**——dev（electron-vite dev，含 --mode test）走 Vite http；**打包恒 cyrene://（残留 dev env 无法劫持）**；test/production 构建与 --mode development 直启（无 dev server）均走 `cyrene://`。**诚实边界**：未打包直启（`electron out/main`，非打包）若 shell 残留 `ELECTRON_RENDERER_URL` 会被劫持到 http/死地址——仅 dev/test 形态，verify 冒烟已 `delete env`；谓词与协议注册同源，verify:artifact 的 out/ 回退冒烟也成立 |
| D-18 | 远程调试门位置与语义 | **main() 顶部同步扫 `process.argv`**（先于 installAppIdentity / whenReady）——Chromium 的 CDP 端口在 whenReady 前已绑定，门必须在浏览器进程初始化前生效；打包时拒绝 `--remote-debugging-port`/`--inspect`（非 `=0`）、裸开关、`--inspect-brk`/`--inspect-node`/`--inspect-brk-node`/`--remote-debugging-fd`（恒拒）；**`--remote-debugging-port=0`/`--inspect=0`/`--remote-debugging-pipe` 仅测试 harness（`CYRENE_TEST_HARNESS=1`）放行**（Playwright 打包冒烟控制通道；未来 Playwright 可能切 pipe） |

**实施中新增决策**按目标指令「按推荐执行并记录」，统一追加到 §10 与最终报告。

## 4. 目标结构

```text
apps/desktop/src/main/
├── config/
│   ├── env.ts            # AppMode / AppConfig / resolveAppConfig（纯函数，不 import electron）
│   └── index.ts          # getAppConfig()：typeof 守卫 __APP_MODE__ + app.isPackaged + process.env
├── protocol/
│   ├── scheme.ts         # PROTOCOL_SCHEME/RENDERER_HOST 常量 + registerCyreneScheme()（ready 前）
│   ├── path.ts           # resolveRendererPath(rendererRoot, pathname) 纯函数（解码/穿越/包含性）
│   ├── csp.ts            # buildRendererCsp() 纯函数
│   ├── handler.ts        # registerCyreneProtocolHandler(rendererRoot)：net.fetch + realpath + CSP 头
│   └── README.md
├── env.d.ts              # declare const __APP_MODE__: string（main 侧）
├── index.ts              # 装配：scheme → 身份 → 单实例 → whenReady（安全断言→目录→IPC→协议→窗口）
└── windows/main-window.ts# prod loadURL cyrene://renderer/index.html + will-navigate 更新 + dev F12
apps/desktop/
├── electron-builder.yml  # dir 未分发包
├── scripts/verify-artifact.cjs  # 产物检查
└── package.json          # package / verify:artifact 脚本落地；playwright/electron-builder devDep
```

## 5. 关键实现

### 5.1 环境配置（config/env.ts + index.ts）

```typescript
export type AppMode = 'development' | 'test' | 'production'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

export interface AppConfig {
  mode: AppMode
  logLevel: LogLevel
  devToolsAllowed: boolean
  protocolName: 'cyrene'
  rendererHost: 'renderer'
}

export function resolveAppConfig(
  mode: AppMode,
  isPackaged: boolean,
  env: Record<string, string | undefined> = {}
): AppConfig {
  // 安全不变量：打包即生产安全默认——devToolsAllowed 只取决于运行时 isPackaged，
  // 与构建 mode 无关（--mode test/development 的 packaged 产物同样恒关 DevTools），且不读 env。
  const devToolsAllowed = !isPackaged
  // logLevel：打包恒 info（不读 env，任何 mode）；非打包默认随 mode（prod=info，dev/test=debug），
  // env 覆盖须经白名单校验（非法值回退 mode 默认）。
  const rawLevel = env['CYRENE_LOG_LEVEL']
  const defaultLevel: LogLevel = mode === 'production' ? 'info' : 'debug'
  const logLevel: LogLevel =
    isPackaged ? 'info' : rawLevel && (LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevel) : defaultLevel
  return { mode, logLevel, devToolsAllowed, protocolName: 'cyrene', rendererHost: 'renderer' }
}
```

- **安全不变量**：`devToolsAllowed = !isPackaged`（打包恒 false，**与构建 mode 无关**，堵住 `--mode test` packaged 产物开 DevTools 的口子）；`logLevel` 仅非打包允许 env 覆盖且须白名单校验（非法值回退 mode 默认，不做无守卫类型强转）。
- **`index.ts`**：
  ```typescript
  // __APP_MODE__ 全局声明在 src/main/env.d.ts（tsconfig.node.json 的 src/main/**/* 覆盖），此处不重复 declare
  import { app } from 'electron'
  import { normalizeAppMode, resolveAppConfig, shouldUseViteDevServer } from './env'
  import type { AppConfig } from './env'

  export { shouldUseViteDevServer } // 主装配/主窗口共用「有无 Vite dev server」谓词

  export function getAppConfig(): AppConfig {
    // 不信任 process.env.NODE_ENV：缺失/未知 __APP_MODE__ 一律归 production（fail-safe），防 env 翻转
    const raw = typeof __APP_MODE__ !== 'undefined' ? __APP_MODE__ : 'production'
    const mode: AppMode = raw === 'development' || raw === 'test' ? raw : 'production'
    return resolveAppConfig(mode, app.isPackaged, process.env)
  }
  ```
- **electron.vite.config.ts**（对象 → 函数式；**不剥离 CSP meta**——prod 由响应头 AND 收紧，见 D-6/G-9）：
  ```typescript
  export default defineConfig(({ mode }) => ({
    main: {
      plugins: [externalizeDepsPlugin()],
      define: { __APP_MODE__: JSON.stringify(mode) }, // CJS main 文本替换，可靠
      resolve: { alias: { '@shared': resolve('src/shared') } }
    },
    preload: { /* 不变 */ },
    renderer: {
      plugins: [vue()], // 保留 index.html 的宽松 meta（dev/preview http 兜底）
      resolve: { /* 不变 */ }
    }
  }))
  ```
  electron-vite 5 `defineConfig` 支持函数式（`ElectronViteConfigFnObject`），`dev` 默认 mode=development、`build` 默认 production、`build --mode test` 为 test。
- **typecheck**：`src/main/env.d.ts` 加 `declare const __APP_MODE__: string`。

### 5.2 cyrene:// 自定义协议（protocol/）

**scheme.ts（必须在 app ready 前调用，main() 顶部）：**

```typescript
export const PROTOCOL_SCHEME = 'cyrene'
export const RENDERER_HOST = 'renderer'
export function registerCyreneScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PROTOCOL_SCHEME, privileges: {
      standard: true, secure: true, supportFetchAPI: true, stream: true,
      corsEnabled: false, bypassCSP: false
    } }
  ])
}
```

- `standard:true` 使 `cyrene://renderer/index.html` 的 host/pathname 标准解析、相对资源正确解析；`secure:true` 视为安全来源（混合内容判定）；`bypassCSP:false` 默认，**不绕过 CSP**。

**path.ts（纯函数，无 electron/fs，可单测）：**

```typescript
// 返回渲染根内绝对路径；非法（穿越/绝对路径/NUL/双重解码）→ null
export function resolveRendererPath(rendererRoot: string, pathname: string): string | null {
  let rel: string
  try { rel = decodeURIComponent(pathname) } catch { return null } // 孤立 % → 拒绝
  if (rel.includes('\0')) return null                                  // NUL 显式拒绝（不进 fs 层，纯函数即保证）
  // 拒绝含 '..' 段（先按 / 分段）——双重解码（%2e%2e）经 decode 后同样被此拒
  const segs = rel.split('/')
  if (segs.some((s) => s === '..')) return null
  const candidate = path.resolve(rendererRoot, '.' + rel) // 前置 '.' → 相对；空 pathname → 渲染根
  // 包含性：首段恰为 '..' 才算越界（字符串 startsWith('..') 会误杀根内 '..hidden' 等合法条目）
  const relToRoot = path.relative(rendererRoot, candidate)
  const first = relToRoot.split(path.sep)[0]
  if (first === '..' || path.isAbsolute(relToRoot)) return null
  return candidate
}
```

- 说明：空 pathname（`/`）→ 返回 rendererRoot 本身（非拒绝），由 handler 的「目录 → index.html」处理；`..` 段、绝对路径、NUL、畸形百分比均显式拒绝。
- 纯函数不含 realpath（fs 绑定），realpath 复核放 handler（含 symlink 逃逸）。

**handler.ts（whenReady 内注册 `protocol.handle`）：**

```typescript
export async function registerCyreneProtocolHandler(rendererRoot: string): Promise<void> {
  const realRoot = await realpath(rendererRoot) // 注册时解析一次（渲染根固定），不在每个请求重算
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const rootLower = lower(realRoot)
  const rootPrefix = rootLower + path.sep
  protocol.handle(PROTOCOL_SCHEME, async (request) => {
    let url: URL
    try { url = new URL(request.url) } catch { return new Response('Bad Request', { status: 400 }) }
    if (url.host !== RENDERER_HOST) return new Response('Not Found', { status: 404 })
    const candidate = resolveRendererPath(rendererRoot, url.pathname)
    if (!candidate) return new Response('Forbidden', { status: 403 })
    // realpath 包含性（symlink 逃逸防线，复用第一块纪律）：仅对请求路径一次 realpath
    let realCand: string
    try { realCand = await realpath(candidate) } catch { return new Response('Not Found', { status: 404 }) }
    const inside = lower(realCand) === rootLower || lower(realCand).startsWith(rootPrefix)
    if (!inside) return new Response('Forbidden', { status: 403 })
    // 目录 → index.html：对 join 出的 index.html 再做 realpath + 包含性（防目录内 index.html 为 symlink 逃逸）
    let target = realCand
    const st = await stat(target).catch(() => null)
    if (st && st.isDirectory()) {
      const idxPath = path.join(realCand, 'index.html')
      let realIdx: string | null
      try {
        realIdx = await realpath(idxPath)
      } catch {
        return new Response('Not Found', { status: 404 }) // 目录内无 index.html → 资源缺失（404），非越权（403）
      }
      if (!(lower(realIdx) === rootLower || lower(realIdx).startsWith(rootPrefix))) {
        return new Response('Forbidden', { status: 403 }) // symlink 逃逸 → 403
      }
      target = realIdx
    }
    // net.fetch 返回 + 注入严格 CSP 头
    try {
      const res = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(res.headers)
      const mime = mimeOf(target)
      if (mime) headers.set('Content-Type', mime) // 仅扩展名 map 命中才覆盖；未命中保留 net.fetch 的推断
      headers.set('Content-Security-Policy', buildRendererCsp())
      return new Response(res.body, { status: res.status, headers })
    } catch { return new Response('Not Found', { status: 404 }) }
  })
}
```

- **mimeOf**：返回 `string | null`，按扩展名映射（html/js/css/svg/png/ico/woff2/json/map → 对应 MIME；map 未命中 → `null`）。handler 仅当 `mimeOf` 命中才覆盖 Content-Type，未命中保留 `net.fetch` 对 file:// 的 MIME 推断（如未来 `.webp/.avif/.ttf` 资产），绝不无条件覆盖。
- 任何异常路径都返回结构化 Response，绝不裸抛（fail-closed）。
- **诚实边界**：realpath 窗口（realpath 调用后到 net.fetch 之间）极小；渲染根是构建产物目录（打包内只读），planted symlink 概率低；与第一块 §10 G-3 同口径。

**csp.ts：**

```typescript
export function buildRendererCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:", // Vite 默认内联 <4KB 字体为 data: URI，须放行否则字体静默失效
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}
```

- **`frame-src 'none'`**：收口第一块 G-6（同窗口 iframe 的 `event.sender` 就是主 webContents）——若 iframe 完全无法创建，该缺口闭合；
- 无 `unsafe-eval`、无 `unsafe-inline`；`style-src 'self'`（renderer 无 `:style` 绑定，实测确认）；`img-src` 去掉现 meta 的 `blob:`、`connect-src` 去掉 `ws:`（阶段 2 流式走 Main 代理，renderer 不直连后端）。

### 5.3 主窗口与加载迁移（windows/main-window.ts）

- **加载/协议注册统一谓词 = `shouldUseViteDevServer(isPackaged, env)`**（`= Boolean(env['ELECTRON_RENDERER_URL']) && !isPackaged`——**打包恒 false，残留 dev env 不能把打包产物劫持到 http/跳过严格 CSP**）：
  ```typescript
  if (shouldUseViteDevServer(app.isPackaged, process.env)) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']) // electron-vite dev（含 --mode test）：Vite HMR
  } else {
    win.loadURL(`${PROTOCOL_SCHEME}://${RENDERER_HOST}/index.html`) // 无 dev server（test/production 构建、--mode development 直启、打包）：cyrene://
  }
  ```
  谓词与协议注册谓词同源（`!shouldUseViteDevServer` 时注册 handler）→ verify:artifact 的 out/ 直启（未打包、无 dev server）与 --mode test 构建都走 `cyrene://`。
- **`will-navigate` 分支**改为 `classifyNavigation(targetUrl, devUrl, usingDevServer): 'app' | 'external' | 'deny'`（devUrl/usingDevServer 由建窗时解析一次传入，不在每次导航重算；usingDevServer = `shouldUseViteDevServer`）：
  ```typescript
  // http/https：
  //   usingDevServer 同源 → @fs/@vite 前缀 = deny（不开外部浏览器，恢复地基行为）；其余 = app
  //   非 usingDevServer 或跨源 → external（系统浏览器）
  // !usingDevServer 时 cyrene://renderer/* → app（路径包含性已由 protocol handler 强制）
  // file: 与其余 → deny（fail-closed）
  ```
  外部 http/https 仍 `shell.openExternal`（.catch 吞拒绝，fail-closed）；其余 deny。**file: 在非 dev server 不再放行**。
- **DevTools**（`devToolsAllowed` = `!isPackaged` 时注册，打包不注册 → 无 F12 路径）：`webPreferences.devTools: config.devToolsAllowed`（BrowserWindow 层封死，Electron 安全检查清单项）+ F12 handler 仅 `devToolsAllowed` 时注册：
  ```typescript
  webPreferences: { ..., devTools: config.devToolsAllowed }
  if (config.devToolsAllowed) {
    win.webContents.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }
  ```
  **同时打包时移除默认应用菜单**（`autoHideMenuBar` 不会禁用菜单加速键，Ctrl+Shift+I 仍可开 DevTools）：
  ```typescript
  if (!config.devToolsAllowed) Menu.setApplicationMenu(null) // 打包：无菜单 → 无 DevTools 加速键
  ```

### 5.4 主入口装配（main/index.ts）

顺序（第一块基础上插入）：

1. **远程调试门（main() 最前，同步）** —— Chromium 的 CDP 端口在 whenReady 前已绑定，门必须在浏览器进程初始化前生效；**返回 boolean，main() 检测后 return，不落到 scheme/身份副作用**：
   ```typescript
   function rejectDebugSwitches(): boolean {
     const getSwitch = (n) => ({ present: app.commandLine.hasSwitch(n), value: app.commandLine.getSwitchValue(n) })
     const allowRandomPort = process.env['CYRENE_TEST_HARNESS'] === '1' // 仅 verify:artifact 冒烟显式注入
     if (app.isPackaged && hasForbiddenDebugSwitch(process.argv, getSwitch, allowRandomPort)) {
       failStart('远程调试/调试开关在发布构建中被禁用'); return true
     }
     if (app.isPackaged && hasForbiddenNodeOptions(process.env['NODE_OPTIONS'])) {
       failStart('NODE_OPTIONS 含调试开关在发布构建中被禁用'); return true // 纯 env 通道：argv/commandLine 均不含
     }
     return false
   }
   // main(): if (rejectDebugSwitches()) return
   ```
   `hasForbiddenDebugSwitch`（纯函数，见 plan Task 2）：**恒拒 `--remote-debugging-pipe`（非 harness）/`--inspect-brk`/`--inspect-node`/`--inspect-brk-node`/`--remote-debugging-fd`；裸开关/显式端口恒拒；`=0` 随机端口默认也拒（doc 07「任何构建都不得开放远程调试端口」），仅测试 harness env 标记（`CYRENE_TEST_HARNESS=1`，verify:artifact 冒烟注入）放行**——Playwright `_electron` 控制通道注入 `--inspect=0`/`--remote-debugging-port=0`，打包冒烟需此通道。argv 扫描遇 `--` 分隔符停止（其后是应用参数）。`hasForbiddenNodeOptions` 另查 `NODE_OPTIONS=--inspect` 系纯 env 通道。`process.argv` 同步扫描先于 `installAppIdentity`/`whenReady`。
2. `registerCyreneScheme()` —— **app ready 前**（紧随远程调试门之后）；
3. `installAppIdentity()`（身份/userData，不变）；
4. 单实例守卫（不变）；
5. `whenReady` 内按序：
   - `setAppUserModelId`；
   - `setPathOk` 检查（不变）；
   - `const cfg = getAppConfig()`（resolve 后：`if (!cfg.devToolsAllowed) Menu.setApplicationMenu(null)`，供窗口/日志用）；
   - `ensureUserDataDirs`（不变）；
   - `registerHandlers()`（不变）；
   - **`if (!shouldUseViteDevServer(app.isPackaged, process.env)) await registerCyreneProtocolHandler(join(__dirname, '../renderer'))`** —— 协议注册谓词与加载谓词同源（`shouldUseViteDevServer = 未打包 && 有 ELECTRON_RENDERER_URL`）：electron-vite dev（含 `--mode test`）走 http 且不产出 out/renderer，**不注册**；**打包（isPackaged=true → shouldUseViteDevServer 恒 false）必须注册**（残留 dev env 也无法把它翻成 dev server）；test/production 构建、`--mode development` 直启 → 注册，否则 loadURL 落 cyrene:// 而 handler 缺失 → 404 空白窗。建窗前，保证 loadURL 可达；
   - `markAppStarted()` + `ensureMainWindow()`（不变）。

### 5.5 最小打包与产物验证

- **devDep**：新增 `playwright`（块 A 起）、`electron-builder`。
- **electron-builder.yml**：
  ```yaml
  appId: com.cyrene.desktop
  productName: Cyrene
  directories:
    output: dist
  files:
    - out/**
    - package.json
  asar: false
  linux:
    target: dir
    category: Utility
  ```
  `files` 白名单外，electron-builder 自动包含运行时依赖（vue/pinia/zod —— `externalizeDepsPlugin` 外部化，main 运行时 require）。
- **package.json 脚本**：
  - `"package": "electron-vite build && electron-builder --dir"`;
  - `"verify:artifact": "node scripts/verify-artifact.cjs"`。
- **scripts/verify-artifact.cjs**：
  - 静态：`out/main|preload|renderer` 三件存在；`out/renderer/index.html` 无 `unsafe-eval` 且**保留 CSP meta**（D-6：dev http 场景兜底，prod 由响应头 AND 收紧，不剥离）；对 `out/` 全量 grep 无 `.env`、`AGENT_ACCESS_TOKEN`、`Bearer ` 模式（best-effort，非完整扫描器）；`package.json` version 可读；
  - 启动冒烟（`--smoke` 显式触发；Linux 需 DISPLAY 或 WAYLAND_DISPLAY，win32/darwin 原生显示）：Playwright `_electron` 启动 `dist/*-unpacked/`（或 `out/` 回退——加载谓词为 `shouldUseViteDevServer`，未打包直启无 dev server 亦走 `cyrene://`），断言协议 `cyrene:`、cyrene:// 响应头严格 CSP、无 CSP 报错、Vue #app 挂载、getAppInfo、普通浏览器 `desktopApi` undefined。脚本复用 `.playwright-mcp/smoke-electron.cjs` 的启动骨架（`delete ELECTRON_RUN_AS_NODE`、`args:[cwd]`、`CYRENE_TEST_HARNESS=1`）。无 `--smoke` 时仅静态检查。

## 6. 错误处理与安全

- 协议 handler 任何异常 → 结构化 Response（400/403/404），不裸抛、不外泄真实路径到 Renderer；
- 远程调试/调试开关：packaged 在 main() 顶部同步拒绝（CDP/pipe/inspect 四类），不静默忽略，先于浏览器进程初始化；
- DevTools：打包恒关且无任何路径（无菜单 `Menu.setApplicationMenu(null)`、无 F12 handler、不调 `openDevTools`）；
- CSP：prod 响应头严格版与保留的宽松 meta **AND 取交集**（严格头胜出，meta 残留不会放宽 prod；meta 供 dev/preview http 兜底）；AND 耦合为已知限制 G-9；
- `__APP_MODE__` 未知/缺失 → 归 `production`（安全优先，宁可保守），不信任 NODE_ENV env；
- `devToolsAllowed` 只取决于运行时 `isPackaged`，与构建 mode / env 无关（打包即生产安全默认）。
- **renderer 两处 `v-html`（导航图标 + 流式演示段）**：为阶段 0 静态演示内容（本地常量），非外部输入；严格 CSP `script-src 'self'`（无 unsafe-inline）已阻挡内联事件属性执行（`v-html` 插入的 `<script>` 本就不执行）；阶段 2/3 换 Markdown 净化渲染时移除。记录为已知限制。

## 7. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单测 | vitest（node env） | `config/env.spec.ts`：`resolveAppConfig` 三 mode；**`devToolsAllowed = !isPackaged`（isPackaged=true 恒 false，与 mode 无关）且 env 无法覆盖**；logLevel 打包恒 info/非打包可 env 覆盖且**非法值回退 mode 默认**；`shouldUseViteDevServer`；`config/debug-switches.spec.ts`：argv/commandLine 开关矩阵 + `hasForbiddenNodeOptions`（NODE_OPTIONS 纯 env 通道）；`windows/navigation.spec.ts`：`classifyNavigation`/`sameOrigin`（will-navigate 门，冒烟不触发故必须有单测）；`protocol/csp.spec.ts`：含 `frame-src 'none'`、无 `unsafe-eval`、无 `unsafe-inline`、`font-src` 含 `data:`、prod 有效策略锚定；`protocol/path.spec.ts`：`resolveRendererPath` 合法通过 / `..` 段拒绝 / **NUL 拒绝** / 双重解码 `%2e%2e` 拒绝 / 孤立 `%` 拒绝 / 根内 `..` 保守拒绝 / 根内 `..hidden` 不误杀 / **containment 契约** |
| 静态 | `vue-tsc`/`eslint` | 全仓类型与 lint（`__APP_MODE__` declare、函数式 config；`isPackaged` 已被使用，无 TS6133） |
| 构建 | `electron-vite build` | prod 产物（**index.html 保留 CSP meta** 且无 unsafe-eval）；`--mode test` 产物（块 C 用） |
| 打包 | `electron-builder --dir` | `dist/linux-unpacked/` 生成 |
| 冒烟 | Playwright `_electron` | `verify:artifact`：协议 `cyrene:`、CSP 无报错、getAppInfo、信任边界 |

## 8. 验收标准

1. `src/main/config/` + `protocol/` 结构符合 §4；`env.d.ts` 声明存在；
2. `resolveAppConfig` 单测覆盖：三 mode、`devToolsAllowed = !isPackaged`（打包恒 false，env/mode 均无法覆盖）、logLevel 规则与非法值回退；
3. `buildRendererCsp` 单测覆盖：`frame-src 'none'`、无 `unsafe-eval`、无 `unsafe-inline`；
4. `resolveRendererPath` 单测覆盖：合法、`..` 段、NUL、双重解码、孤立 `%`、根内 `..` 保守拒绝、根内 `..hidden` 不误杀、containment 契约（`relative()` 首段边界锚定——字符串前缀陷阱结构性免疫，无可触发输入，用契约测试锚定防未来重构）；
5. 打包版启动后 `window.location.protocol === 'cyrene:'`；CSP 无 console 报错；四栏 UI 正常渲染；`getAppInfo` 返回 `{Cyrene, 0.1.0, linux}`（Playwright 冒烟 + vision MCP 确认）；
6. 普通浏览器访问 `window.desktopApi` 为 undefined（信任边界不回归）；
7. 打包安全默认：`devToolsAllowed=false` 且 `Menu.setApplicationMenu(null)`（无 DevTools 加速键）；main() 顶部同步拒绝 `--remote-debugging-port`/`--inspect`/`--inspect-brk`/`--remote-debugging-pipe`（`rejectDebugSwitches` 抽纯函数可单测）；
8. dev 模式：F12 可切换 DevTools、`pnpm dev` 启动正常；
9. `pnpm package` 产出 `dist/linux-unpacked/`；`pnpm verify:artifact` 静态（index.html 保留 CSP meta 且无 unsafe-eval）+ 冒烟（含普通浏览器 `desktopApi` undefined 信任边界）通过；
10. 既有单测（sanitize/user-data-dirs/ipc-executor 等 39 项）不回归。

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| electron-builder 首次运行需网络（app-builder-bin/fuses） | 本地若受阻：`package` 退化为 `electron-vite build` + 说明；阶段 8 正式配置时再处理 |
| `net.fetch(file://)` MIME 不确定 | `mimeOf` map 命中才覆盖；未命中保留 net.fetch 推断（不无条件覆盖） |
| 严格 CSP 破坏现有 UI（动态样式/内联事件） | 已确认无 `:style` 绑定；若冒烟发现 style 报错，最小放宽为 `style-src-attr 'unsafe-inline'`（记录实测） |
| electron-vite `define` 对 CJS main 不生效 | `typeof __APP_MODE__` 守卫 + 归 production（fail-safe，不信任 NODE_ENV）；冒烟验证协议加载即证明生效 |
| electron-builder `files` 白名单漏打包运行时依赖 | 冒烟从 `dist/linux-unpacked/` 启动验证（不只看 out/） |
| `will-navigate` 对 cyrene:// 放行过宽 | scheme+host 门 + handler 已强制包含性（纵深）；无 `<base>` 篡改面 |
| 默认应用菜单加速键残留开 DevTools | `!devToolsAllowed` 时 `Menu.setApplicationMenu(null)`（打包移除菜单，含自动构建的默认菜单） |

## 10. 已知限制与接受项

| # | 限制 | 影响/处理 |
|---|---|---|
| G-1 | 两处 `v-html`（导航图标/流式演示段）为阶段 0 静态演示内容 | 非外部输入；严格 CSP 已挡内联事件属性；阶段 2/3 换净化渲染时移除 |
| G-2 | 自定义协议仅服务渲染根，附件/媒体延到阶段 3 | handler 届时按受控附件扩展；本次不映射任意磁盘 |
| G-3 | electron-builder 仅 `dir` 未分发包 | Forge 安装包、asar、Fuses 阶段 8 评估 |
| G-4 | `style-src 'self'` 基于当前组件集验证 | 未来组件若用 `:style`，需加 `style-src-attr 'unsafe-inline'`（记录，勿静默放宽） |
| G-5 | verify:artifact 静态检查为 grep 级 best-effort | 非完整秘密扫描器；阶段 7 安全收敛补强 |
| G-6 | realpath 到 net.fetch 之间的极小 TOCTOU 窗口 | 渲染根为打包内只读产物，概率极低；与第一块 G-3 同口径 |
| G-7 | 远程调试/调试开关拒绝**仅限打包（isPackaged）**；非打包（dev/preview/--mode development）接受显式调试开关（用户决策 D-5 限生产）；打包下 `--remote-debugging-port=0`/`--inspect=0`/`--remote-debugging-pipe` 仅测试 harness env 标记（`CYRENE_TEST_HARNESS=1`，verify:artifact 冒烟注入）放行；`NODE_OPTIONS=--inspect` 系另查（纯 env 通道；`--inspect-brk` 在 Node 引导期暂停、进程内无法拦截——**固有限制**，阶段 8 Electron Fuses 评估） | doc 07 §4「任何构建都不得开放远程调试端口」为发布门槛：生产默认连 `=0` 也拒；`=0`/pipe 只对显式测试 harness 开放（Playwright `_electron` 打包冒烟需要）。**威胁模型**：门防「意外固定端口暴露/误留调试开关」；恶意 launcher 已控 env+argv（能设 `CYRENE_TEST_HARNESS=1` 并传 `=0`）在本威胁模型外——其能力等价于直接篡改应用，且需 env+argv **双控**才绕过。**未来风险**：若 Playwright 小版本切到 `--remote-debugging-fd`（现恒拒）注入，打包冒烟被拒，需把 fd 加入 harness 放行白名单并记录。阶段 8 发布验证时按 doc 07 复核非打包排除项 |
| G-8 | verify:artifact 内联 smoke 骨架（未直接 require `.playwright-mcp/smoke-electron.cjs`） | 该脚本 gitignored、一次性用途，不可被 scripts/ 引用；内联其已验证模式（env 删除/启动参数）保持单一实现；块 C 正式化为 test:integration 时统一 |
| G-9 | CSP 保留 meta + 响应头 AND 取交集（改 dev meta 会静默改变 prod 有效策略） | 为保 dev http 场景有 CSP（dev 需 meta；剥离会令 dev 零 CSP）；**有效 prod 策略 = 严格头 ∩ meta**——meta 独有的 blob:/ws:/unsafe-inline **及内联 `style` 属性/Vue `:style` 绑定**在 prod 被剔除（`style-src 'self'` 无 unsafe-inline；Task 4 有锚定测试；阶段 3/5 若需动态样式/blob: 图片预览须显式改头 + 测试，勿静默）；阶段 7 安全收敛可再评估剥离方案 |

**实施中新增决策/限制**：按目标指令追加至本节并回写最终报告。
