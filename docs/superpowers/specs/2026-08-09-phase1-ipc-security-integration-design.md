# 阶段 1 块 C：IPC/协议安全集成测试套件 —— 设计

**日期：** 2026-08-10
**状态：** 决策已拍板（块 A spec D-8/9/15/16 + 本批） + 已 code-review（第 4 轮干净）
**关联：** [块 A spec](2026-08-09-phase1-loading-env-design.md)（D-8 集成测试 runner / D-9 CI / D-15 `--mode test` 构建 / D-16 verify 冒烟正式化；§5.5 protocol handler 403/404 分支）、[doc 16 §4 验收门槛](../16-Cyrene-前端实施任务清单与进度跟踪.md#L217)、[doc 08 测试与 Demo 验收](../08-Cyrene-前端测试与Demo验收方案-v0.2.md)

---

## 1. 背景与目标

块 A 建立了安全加载基线 + verify:artifact 冒烟；块 B 落地了凭据存储与日志/审计。**块 C 用 Playwright `_electron` 对真实构建产物做安全集成测试**，把块 A 冒烟（verify:artifact `--smoke`）正式化为可持续的 `test:integration`，并覆盖块 A/B 单测测不到的安全面。目标：

1. **F1 覆盖（块 A 遗留 Important）**：`cyrene://` protocol handler 的拒绝分支（403 路径穿越 / 404 缺失 / 403 symlink 逃逸 / 404 目录无 index.html / 404 非 renderer host / 404 空 host；400 为防御性死代码，见 C-G6）——用恶意 `cyrene://` 请求对真实 handler 实测；
2. **IPC 安全闭环（doc 16 验收门槛）**：Renderer 暴露面恰为白名单 `desktopApi`（无 raw ipcRenderer/任意通道）；白名单通道合法输入可用；**非法参数/超大输入被 Main 拒绝**（SCHEMA_VALIDATION_FAILED 信封）；**来源校验**（非主窗口 webContents 的 invoke 被 `isTrustedSender` 拒绝）；
3. **外部链接受控打开（doc 16 验收门槛）**：`window.open`/`will-navigate` 到外部 → `shell.openExternal` + deny（不导航、不新建窗）；
4. **普通浏览器信任边界正式化**：普通 chromium 加载产物 Renderer → `window.desktopApi === undefined`（块 A 冒烟已证，本块收进套件）；
5. **CI 闭环（D-9）**：`.github/workflows/ci.yml` 加 `test:integration`（xvfb-run + playwright install --with-deps chromium）。

**已拍板决策（本批沿用，勿改）：** Playwright 正式依赖（devDep 已有）；vitest + playwright（复用 `vitest.integration.config.mts`）；`--mode test` 构建产物（近生产形态：未打包、注册 `cyrene://`、`isPackaged=false` 故 devTools 开）；CI 加 `test:integration`（xvfb-run）。

## 2. 范围

| 项 | 内容 |
|---|---|
| 测试套件 | `tests/integration/`：protocol-handler / ipc-security / navigation / trust-boundary 四个 spec + `helpers/app.ts` |
| 被测产物 | `electron-vite build --mode test` → `out/`（`__APP_MODE__='test'`、未打包、`shouldUseViteDevServer=false` → 注册并走 `cyrene://`） |
| 启动隔离 | `XDG_CONFIG_HOME`（Linux）/ `APPDATA`（Windows）env 注入临时目录 → userData 不污染真实配置 |
| 来源校验 | 隐藏第二窗口（同真实 preload）invoke → 被 `isTrustedSender` 拒绝 |
| CI | ci.yml 加 `test:integration`（xvfb-run -a + playwright install --with-deps chromium） |
| 文档 | doc 16 验收门槛 2 项勾选 + changelog；doc 08 测试方案同步 |

**非目标：** 阶段 2+ 的端到端聊天流（Adapter↔Store↔UI）、Playwright `test:e2e`（阶段 3 配置）、Windows/macOS 本机集成验证（Linux CI 跑，平台差异记录）、`cyrene://` handler 之外的块 B 集成（凭据/日志端到端已由块 B 单测覆盖，本块只测经 IPC 的 renderer 可见行为）。

## 3. 决策记录（拍板）

前讨论批次已拍板（块 A spec D-8/D-9/D-15/D-16）+ 本批按推荐执行：

| # | 决策 | 结论 |
|---|---|---|
| C-1 | 测试 runner | **vitest + playwright 库**（复用 `vitest.integration.config.mts`，`tests/integration/**/*.spec.ts`，node env，**testTimeout 提到 60s**——`_electron` 冷启动 8–20s，15s 会在 launch 前杀测试）——Playwright 是 devDep（块 A 已装），零新增 |
| C-2 | 被测产物 | **`--mode test` 构建**（D-15）：`electron-vite build --mode test` → `out/`（`__APP_MODE__='test'`、未打包、`shouldUseViteDevServer=false` → 注册 `cyrene://` 并加载）——近生产形态且 test 模式允许临时 userData/URL 注入 |
| C-3 | 启动注入 | env 级：`XDG_CONFIG_HOME`/`APPDATA` → 临时目录（userData 隔离）+ `CYRENE_TEST_HARNESS=1` + 删除 `ELECTRON_RENDERER_URL`（防劫持到 dev）+ `ELECTRON_RUN_AS_NODE`/`ELECTRON_ENABLE_LOGGING` 清除——**零代码改动**（`installAppIdentity` 依赖 `appData`，env 重定向即隔离） |
| C-4 | F1 覆盖 | **主进程 `net.fetch('cyrene://…')` 实测 handler**（`app.evaluate` 内）——handler 用 `net.fetch` 服务，主进程可直取恶意 URL 断言 403/404/200+CSP（400 为防御性死代码，见 C-G6），不经 renderer |
| C-5 | 来源校验 | **隐藏第二窗口 + 真实 preload**（`app.evaluate` 建 BrowserWindow，sandbox/contextIsolation 同主窗）→ 其中 `window.desktopApi.getAppInfo()` 因 `sender !== mainWindow.webContents` 被拒（`isTrustedSender`）→ preload 抛 `[UNKNOWN] 拒绝` |
| C-6 | 外部链接 | **主进程 monkeypatch `shell.openExternal`** 记录调用 + renderer 触发 `window.open('https://…')`/`location` 导航 → 断言 openExternal 被调 + 无新窗/未导航 |
| C-7 | 普通浏览器 | 复用块 A 冒烟形态：chromium 加载产物 Renderer（本地 http server 服务 `out/renderer`）→ `window.desktopApi === undefined` |
| C-8 | CI | ci.yml 加 `test:integration` 步骤：`xvfb-run -a` 前缀 + `playwright install --with-deps chromium`（D-9）；Linux-only，Windows/macOS 记录为平台差异 |
| C-9 | 测试前置 | `test:integration` 脚本 = `electron-vite build --mode test && vitest run --config vitest.integration.config.mts`（构建在脚本内，CI/本地一致） |

**实施中新增决策**：按目标指令追加到 §10 与最终报告。

## 4. 目标结构

```text
apps/desktop/
├── tests/integration/
│   ├── helpers/
│   │   └── app.ts            # launchApp()/launchPlainBrowser()/临时 userData/清理
│   ├── protocol-handler.spec.ts   # F1:cyrene:// 恶意请求 403/404/200+CSP(400 死代码见 C-G6)
│   ├── ipc-security.spec.ts       # API 面/合法通道/超大输入/非法参数/来源校验
│   ├── navigation.spec.ts         # 外部链接 openExternal + deny
│   ├── trust-boundary.spec.ts     # 普通浏览器 desktopApi undefined
│   └── README.md                  # 运行方式、平台差异、失败排障
├── vitest.integration.config.mts  # 已有(include tests/integration/**)
├── scripts/verify-artifact.cjs    # 不变(冒烟保留;块 C 正式化为 test:integration)
└── package.json                   # test:integration = build --mode test && vitest run
.github/workflows/ci.yml           # + test:integration 步骤(xvfb-run -a)
```

## 5. 关键实现

### 5.1 launchApp() 启动助手（tests/integration/helpers/app.ts）

```typescript
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface LaunchedApp { app: ElectronApplication; page: Page; userData: string }

/** 用 --mode test 构建产物(out/)启动 app：临时 userData + harness 标记 + 清残留 dev env */
export async function launchApp(): Promise<LaunchedApp> {
  const root = join(__dirname, '../../..') // apps/desktop
  const electronPath = process.platform === 'win32'
    ? join(root, 'node_modules/electron/dist/electron.exe')
    : join(root, 'node_modules/electron/dist/electron')
  const userData = mkdtempSync(join(tmpdir(), 'cy-int-ud-'))
  // 平台隔离键：Linux appData=XDG_CONFIG_HOME、Windows=%APPDATA%、macOS=$HOME（Electron app.getPath('appData') 行为）
  const appDataKey = process.platform === 'win32' ? 'APPDATA' : process.platform === 'darwin' ? 'HOME' : 'XDG_CONFIG_HOME'
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    [appDataKey]: userData,             // appData→userData 隔离(join(appData,'Cyrene'))
    CYRENE_TEST_HARNESS: '1',           // 放行 =0 随机端口(Playwright 控制通道)
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_ENABLE_LOGGING: '',
    ELECTRON_RENDERER_URL: ''
  }
  delete env['ELECTRON_RUN_AS_NODE']; delete env['ELECTRON_ENABLE_LOGGING']; delete env['ELECTRON_RENDERER_URL']
  const app = await _electron.launch({ executablePath: electronPath, args: [root], cwd: root, env, timeout: 30000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  try { await launched.app.close() } catch { /* 已退出 */ }
  try { rmSync(launched.userData, { recursive: true, force: true }) } catch { /* 清理尽力 */ }
}
```

- **产物前置**：`test:integration` 脚本先 `electron-vite build --mode test`（out/ 存在，`__APP_MODE__='test'`）。
- **launch 骨架**复用 verify-artifact `--smoke`（`electronPath + args:[root]`），差异只在 env 注入临时 userData。
- **Windows**：`XDG_CONFIG_HOME` 不生效——`process.platform === 'win32'` 分支用 `APPDATA`（`app.getPath('appData')` = `%APPDATA%`，`join(appData,'Cyrene')` 为 userData 基）。macOS 用 `HOME` 子目录（或记录为待验证平台差异）。

### 5.2 protocol-handler.spec.ts（块 A F1 覆盖）

主进程 `net.fetch` 直取恶意 URL（`app.evaluate` 内，走真实 `protocol.handle`），断言状态码与 CSP：

| 用例 | 请求 | 期望 |
|---|---|---|
| 正常加载 | `cyrene://renderer/index.html` | 200 + `Content-Security-Policy` 头含 `default-src 'none'` 严格值 |
| 非 renderer host | `cyrene://evil-host/` | 404 |
| 空 host（畸形 URL） | `cyrene://` | 404（`new URL` 不抛错→host=''≠renderer→404；**400 分支是防御性死代码，`net.fetch` 无法触发**——记录为已知限制，或后续把 URL 解析段抽纯函数单测） |
| 路径穿越 | `cyrene://renderer/..%2f..%2fetc/passwd` | 403（`..%2f` 经 URL 解析后 pathname 保留，decode 出现 `..` 段 → `resolveRendererPath` 拒） |
| 孤立 `%` | `cyrene://renderer/%` | 403（decode 抛错 → resolveRendererPath 拒，非 400） |
| 缺失文件 | `cyrene://renderer/nonexistent.js` | 404（realpath 失败） |
| 目录无 index | `cyrene://renderer/empty-dir/`（out/renderer 下无 index.html 的空目录） | 404 |
| symlink 逃逸（文件） | 测试先在 `out/renderer/` 下建 symlink→外部文件，请求该路径 | 403（realpath 逃逸） |
| symlink 逃逸（目录内 index.html） | 测试在 `out/renderer/dir/` 下建 `index.html`→外部文件，请求 `cyrene://renderer/dir/` | 403（handler 目录分支对 join 的 index.html 二次 realpath 包含性） |

```typescript
// 单次 launch 复用（每个 net.fetch 无状态；冷启动贵，避免 7 次 launch）
let launched: LaunchedApp
beforeAll(async () => { launched = await launchApp() })
afterAll(async () => { await closeApp(launched) })

it('协议 handler：路径穿越 → 403（F1）', async () => {
  const status = await launched.app.evaluate(async ({ net }) => {
    const r = await net.fetch('cyrene://renderer/..%2f..%2fetc%2fpasswd')
    return r.status
  })
  expect(status).toBe(403)
})
```

- **symlink 逃逸前置**：beforeAll 在 `out/renderer/escape-link` 建 `symlinkSync` → 外部临时文件（指向 out/renderer 之外），并在 `out/renderer/escape-dir/` 建目录后放 `index.html` symlink → 外部文件；afterAll 一并移除（不修改源码产物之外的结构）。
- **CSP 断言**：响应头含 `Content-Security-Policy` 且值含 `default-src 'none'`、`frame-src 'none'`（严格值，与块 A `buildRendererCsp()` 一致）。
- 目录无 index 用例：beforeAll 在 `out/renderer/empty-dir/` 建空目录（产物本身无），afterAll 清理。

### 5.3 ipc-security.spec.ts（IPC 安全闭环）

**套件级单 launch 复用**（避免每个 `it` 遗留 Electron 进程）：beforeAll `launchApp()` + afterAll `closeApp(app)`；各用例经套件级 `page`/`app` 交互。来源校验用例（隐藏窗）在套件内独立建窗销毁。
```typescript
let app: ElectronApplication // LaunchedApp 是 {app,page,userData} 整体；destructure 赋值给 app 的是 ElectronApplication（typecheck 会强制此标注）
let page: Page
let userData: string
beforeAll(async () => { ({ app, page, userData } = await launchApp()) })
afterAll(async () => { await closeApp({ app, page, userData }) })
```
（`import type { ElectronApplication, Page } from 'playwright'`）

**Renderer API 面（信任边界）**：
```typescript
it('desktopApi 只暴露白名单方法（无 raw ipcRenderer/任意通道）', async () => {
  const surface = await page.evaluate(() => ({
    keys: Object.keys(window.desktopApi ?? {}).sort(),
    hasIpc: !!(window as any).ipcRenderer,
    hasRequire: typeof (window as any).require,
    hasProcess: typeof (window as any).process
  }))
  expect(surface.keys).toEqual(['clearBackendToken', 'getAppInfo', 'getCredentialStatus', 'setBackendToken'])
  expect(surface.hasIpc).toBe(false)
  expect(surface.hasRequire).toBe('undefined')
  expect(surface.hasProcess).toBe('undefined')
})
```

**合法通道可用 + 非法参数/超大输入拒绝（真实 IPC 全链路）**：
```typescript
it('setBackendToken 超大输入 → SCHEMA_VALIDATION_FAILED（不落盘）', async () => {
  const err = await page.evaluate(async () => {
    try { await window.desktopApi.setBackendToken('x'.repeat(4097)); return null }
    catch (e: any) { return e.message }
  })
  expect(err).toContain('SCHEMA_VALIDATION_FAILED')
})
it('凭据往返按 safeStorage 可用性分支断言（available 路 vs basic_text 不可用路）', async () => {
  const flow = await page.evaluate(async () => {
    const initial = await window.desktopApi.getCredentialStatus()
    if (initial === 'unavailable') {
      // 不可用路（CI 无钥匙串 → basic_text）：set 拒存抛错；clear 不需钥匙串仍可移除，响应 status 短路 unavailable
      let setErr: string | null = null
      try { await window.desktopApi.setBackendToken('sk-test-token') } catch (e: any) { setErr = e.message }
      const afterClear = await window.desktopApi.clearBackendToken()
      return { initial, setErr, afterClear }
    }
    // 可用路（empty/available——有钥匙串的新临时 userData 初始为 empty）：set → available → clear → empty
    const s1 = await window.desktopApi.setBackendToken('sk-test-token')
    const s2 = await window.desktopApi.getCredentialStatus()
    const s3 = await window.desktopApi.clearBackendToken()
    return { initial, s1, s2, s3 }
  })
  if (flow.initial === 'unavailable') {
    expect(flow.setErr).toContain('CREDENTIAL_UNAVAILABLE') // safeStorage 不可用 → 拒存，绝不静默明文降级
    expect(flow.afterClear).toBe('unavailable') // clear 后 getStatus 短路 unavailable
  } else {
    expect(flow.s1).toBe('available')
    expect(flow.s2).toBe('available')
    expect(flow.s3).toBe('empty')
  }
})
```
- **非法参数**：`setBackendToken('')`（空串）→ `SCHEMA_VALIDATION_FAILED`（`value.min(1)`）；`setBackendToken('x'.repeat(4097))` → `SCHEMA_VALIDATION_FAILED`（`value.max(4096)`）——非法/超大输入经真实 IPC 全链路被 Main 拒绝。
- **来源校验（C-5）**：
```typescript
it('非主窗口 webContents invoke → 被 isTrustedSender 拒绝', async () => {
  const res = await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
    const hidden = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await hidden.loadURL('about:blank')
    try {
      const outcome = await hidden.webContents.executeJavaScript(`window.desktopApi.getAppInfo()`)
      return { ok: true, outcome }
    } catch (e: unknown) { return { ok: false, err: String(e) } }
    finally { hidden.destroy() }
  }, join(__dirname, '../../out/preload/index.js'))
  expect(res.ok).toBe(false)      // 非主窗 → isTrustedSender 拒绝
  expect(res.err).toContain('拒绝')
})
```
  ——同真实 preload、同 sandbox/contextIsolation；仅 sender 非主窗口 → 被 registry `isTrustedSender` 拒（`{ok:false,error:{code:'UNKNOWN',message:'拒绝'}}` → preload 抛 `[UNKNOWN] 拒绝`）。
- **基本凭据状态**：`getCredentialStatus()` 初始返回 `empty`（临时 userData 全新，safeStorage 可用时；basic_text 下为 `unavailable`）——与块 B 4 态一致。

### 5.4 navigation.spec.ts（外部链接受控打开）

```typescript
it('window.open 外部链接 → shell.openExternal + 不新建窗', async () => {
  const { app, page, userData } = await launchApp()
  try {
    // 主进程内初始化 __ext + monkeypatch（须返回 Promise——will-navigate 分支对 openExternal 调 .catch）
    await app.evaluate(({ shell }) => {
      ;(globalThis as { __ext?: string[] }).__ext = []
      ;(shell as any).openExternal = (u: string): Promise<void> => { (globalThis as { __ext: string[] }).__ext.push(u); return Promise.resolve() }
    })
    const winCount0 = app.windows().length
    await page.evaluate(() => { window.open('https://example.com') })
    await page.waitForTimeout(300)
    const ext = await app.evaluate(() => (globalThis as { __ext: string[] }).__ext)
    const winCount1 = app.windows().length
    expect(ext).toContain('https://example.com')
    expect(winCount1).toBe(winCount0) // deny：不新建窗
  } finally { await closeApp({ app, page, userData }) }
})
```
- **will-navigate 外部**：`page.evaluate(() => { location.href = 'https://example.com/page' })` → 不导航（`classifyNavigation` deny + `shell.openExternal`）——断言 `page.url()` 仍为 `cyrene://…` 且 openExternal 被调。
- **deny 后主窗不受影响**：以上两例后 `getAppInfo()` 仍可用。
- **monkeypatch 恢复**：closeApp 关窗即进程退出，无需显式恢复；若套件内多例共享 app 需在 afterEach 还原 `shell.openExternal` 原函数。

### 5.5 trust-boundary.spec.ts（普通浏览器正式化）

复用块 A 冒烟形态：本地 http server 服务 `out/renderer`，普通 chromium 加载：
```typescript
it('普通浏览器加载产物 Renderer → desktopApi undefined', async () => {
  const server = http.createServer((req, res) => { /* 静态服务 out/renderer */ })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}/index.html`
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(url)
  const hasApi = await page.evaluate(() => typeof (window as any).desktopApi)
  expect(hasApi).toBe('undefined') // 无 preload → 无 desktopApi
  await browser.close(); server.close()
})
```
（`import type { AddressInfo } from 'node:net'`；静态服务实现复用块 A smoke 逻辑，提取进 `helpers/app.ts` 的 `serveRenderer()`。）

### 5.6 CI（.github/workflows/ci.yml）

`check` job 追加：
```yaml
      - name: Install Playwright (integration)
        run: pnpm --filter @cyrene/desktop exec playwright install --with-deps chromium
        # --with-deps:apt 补 libnss3/libatk 等系统库(否则 chromium.launch 硬失败);若 runner 有 AppArmor userns 限制,chromium 启动加 --no-sandbox(实施期验证)

      - name: Integration tests (xvfb)
        run: xvfb-run -a pnpm test:integration
```
- `xvfb-run -a`：Linux CI 无显示器，Electron 启动需 X（块 A 冒烟已证实）。
- `playwright install --with-deps chromium`：`_electron` 用已装 electron 二进制，普通浏览器信任边界测试需 chromium（--with-deps 补系统库，防 chromium.launch 硬失败）。
- `test:integration` 脚本 = `electron-vite build --mode test && vitest run --config vitest.integration.config.mts`（构建在脚本内）。

### 5.7 package.json + vitest.integration.config.mts

```json
"test:integration": "electron-vite build --mode test && vitest run --config vitest.integration.config.mts"
```
（替换现有 `vitest run --config vitest.integration.config.mts`）

**vitest.integration.config.mts 更新**（`testTimeout` 现为 15000，须改）：
```typescript
test: {
  include: ['tests/integration/**/*.spec.ts'],
  environment: 'node',
  testTimeout: 60000,      // Electron 冷启动 8–20s（§3 C-1）
  hookTimeout: 60000,      // beforeAll 里 launchApp 冷启动（默认 10000 会在启动前中止）
  fileParallelism: false   // 4 个 spec 串行跑，避免同时拉起多个 Electron/Chromium 资源争抢
}
```

## 6. 错误处理与安全

- 测试自身安全：临时 userData 每套件 mkdtemp + 清理（`rmSync force`）；symlink 逃逸用例只建在 `out/renderer`（产物目录），afterAll 移除；不触碰真实 userData/凭据。
- 启动失败 fail 而非假绿：`launchApp` 超时 30s；`app.evaluate` 抛错 → vitest fail（不吞）。
- 平台差异显式记录：Windows `XDG_CONFIG_HOME` 不生效 → 用 `APPDATA`（实现里 `process.platform` 分支）；macOS 待验证记录 §10。basic_text 环境（无钥匙串的 Linux）下凭据往返用例走不可用路（set 抛 `CREDENTIAL_UNAVAILABLE`、clear 短路 `unavailable`），有 GNOME 钥匙串走可用路（`available→empty`）——用例按初始状态探测分支断言（§5.3），不依赖环境。
- 不修改应用代码：本块零 src/ 改动（除非来源校验暴露真实缺陷）。

## 7. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 集成（本块） | vitest.integration + playwright `_electron`/chromium | 协议 handler 4 类拒绝分支（F1）、IPC API 面/超大输入/来源校验、外部链接受控、普通浏览器信任边界 |
| 单测（既有） | vitest node env | 块 A 92 + 块 B 182 项不回归（`pnpm test`） |
| 冒烟（既有） | verify-artifact --smoke | 保留（块 C 正式化后 test:integration 承担同类职责，verify 冒烟仍用于打包产物） |

**验证命令**：`pnpm test`（不回归）、`pnpm test:integration`（本块）、`pnpm typecheck`、`pnpm lint`、`pnpm build`。

## 8. 验收标准

1. `tests/integration/` 四套件 + helpers 落地；`test:integration` = build --mode test + vitest run；本机跑通（有 DISPLAY 或 xvfb）；
2. **F1 闭环**：protocol-handler.spec 覆盖 403(穿越)/403(文件逃逸)/403(目录内 index.html 逃逸)/404(缺失)/404(目录无 index)/404(非 host)/404(空 host)/200+CSP 全部分支，真实 handler 实测（400 为防御性死代码，不测，见 C-G6）；
3. **doc 16 验收门槛**：「非白名单通道、非法参数与超大输入被 Main 拒绝」与「外部链接通过受控接口打开」勾选——IPC 面/超大输入/来源校验 + navigation 用例满足；
4. **信任边界**：普通浏览器 `desktopApi` undefined 用例在套件内；
5. **CI**：ci.yml 含 test:integration(xvfb-run + playwright install --with-deps chromium)，main push/PR 触发；
6. 既有 182 单测 + typecheck + lint 不回归；块 A verify:artifact 冒烟仍过。

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| CI Linux 无钥匙串 → safeStorage basic_text，凭据往返期望不符 | 凭据往返用例按初始状态探测分支断言（§5.3：unavailable 路 / empty·available 路）并记录平台差异；来源校验/超大输入不依赖钥匙串 |
| `_electron` 启动慢/不稳定 | testTimeout 提到 60s、launch 30s（§3 C-1 口径一致）；helpers 统一 timeout；失败信息含 stdout/stderr |
| symlink 用例污染产物 | 只在 `out/renderer` 建临时 symlink/空目录，afterAll 移除；`rm -rf out` 后自愈 |
| `window.open` 触发浏览器弹窗策略 | `setWindowOpenHandler` 已 deny + openExternal（块 A）；断言无新窗即可 |
| Windows/macOS 平台差异（XDG_CONFIG_HOME/APPDATA） | helpers 平台分支 + §10 记录；CI 仅 Linux 跑 |

## 10. 已知限制与接受项

| # | 限制 | 影响/处理 |
|---|---|---|
| C-G1 | 非白名单通道「无 handler」拒绝路径不可直接测（sandbox 下 renderer 无 raw ipcRenderer） | 以「API 面恰为白名单 + 无任意 invoke 表面」断言替代（结构保证）；来源校验用例测 isTrustedSender 真实拒绝路径 |
| C-G2 | `isTrustedSender` 依赖隐藏窗 executeJavaScript 触发真实 preload | 隐藏窗用真实 out/preload/index.js + 同 sandbox/contextIsolation；属防御纵深验证 |
| C-G3 | macOS 用 `HOME` 重定向（§5.1 已实现） | CI 仅 Linux；macOS 真机验证待后续，记录 |
| C-G4 | `window.open`/`location` 外部链接测试依赖 shell.openExternal monkeypatch | 每例独立 launch + closeApp 关进程即退出，无需显式恢复（§5.4）；若套件内多例共享 app 需 afterEach 还原原函数 |
| C-G5 | 集成测试跑 `--mode test` 构建（非打包） | 与 verify:artifact 打包冒烟互补；打包形态由 verify:artifact 覆盖 |
| C-G6 | protocol handler 的 400 分支是防御性死代码（`new URL` 对 `cyrene://` 等畸形不抛错，空 host 落 404；`net.fetch` 无法触发 400） | 集成套件不测 400（404 覆盖）；如后续要测 400，需把 handler 的 URL 解析段抽纯函数单测——记录待后续 |

**实施中新增决策/限制**：按目标指令追加至本节并回写最终报告。
