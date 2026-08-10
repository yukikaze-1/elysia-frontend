# 阶段 1 块 C：IPC/协议安全集成测试套件 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Playwright `_electron` 对真实 `--mode test` 构建产物做安全集成测试——覆盖 protocol handler 拒绝分支（块 A F1）、IPC 安全闭环（API 面/超大输入/来源校验）、外部链接受控打开、普通浏览器信任边界，并把 `test:integration` 收进 CI（xvfb-run）。

**Architecture:** `tests/integration/helpers/app.ts` 提供 `launchApp()`（临时 userData 隔离 + harness 标记）/`closeApp()`/`serveRenderer()`；四个 spec 各自 beforeAll/afterAll 单 launch 复用；主进程经 `app.evaluate` 直取 `cyrene://`（`net.fetch`）与 monkeypatch `shell.openExternal`；全部依赖块 A/B 既有实现，零 src/ 改动。

**Tech Stack:** vitest（integration config）+ playwright（`_electron`/`chromium`）+ electron-vite（`--mode test` 构建）+ 零新增依赖。

## Global Constraints

（从块 C spec 逐字摘录；所有任务隐式包含本节）

- **被测产物**：`electron-vite build --mode test` → `out/`（`__APP_MODE__='test'`、未打包、`shouldUseViteDevServer=false` → 注册并走 `cyrene://`）。
- **test:integration 脚本** = `electron-vite build --mode test && vitest run --config vitest.integration.config.mts`。
- **vitest.integration.config.mts**：`testTimeout: 60000`、`hookTimeout: 60000`（beforeAll launchApp 冷启动）、`fileParallelism: false`（避免多 Electron 并发争抢）。
- **启动隔离**：`XDG_CONFIG_HOME`（Linux）/ `APPDATA`（Windows）/ `HOME`（macOS）env 注入临时 userData；`CYRENE_TEST_HARNESS=1`；删除 `ELECTRON_RUN_AS_NODE`/`ELECTRON_ENABLE_LOGGING`/`ELECTRON_RENDERER_URL`；launch timeout 30s。
- **launchApp 骨架**：`_electron.launch({ executablePath: electronPath, args: [root], cwd: root, env, timeout: 30000 })`；electronPath 平台感知（win32→electron.exe）。
- **F1 用例表**（真实 handler 实测，`app.evaluate` 内 `net.fetch`）：正常 index.html→200+CSP（含 `default-src 'none'`）；非 renderer host→404；空 host `cyrene://`→404（400 为防御性死代码，不测，见 C-G6）；`..%2f` 穿越→403；孤立 `%`→403；缺失文件→404；空目录无 index→404；文件 symlink 逃逸→403；目录内 index.html symlink 逃逸→403。
- **symlink 前置**：beforeAll 在 `out/renderer/` 下建 escape-link（symlink→外部文件）与 empty-dir（空目录）、escape-dir/index.html（symlink→外部文件），afterAll 移除。
- **IPC 安全**：desktopApi 恰暴露 `['clearBackendToken','getAppInfo','getCredentialStatus','setBackendToken']`（无 ipcRenderer/require/process）；`setBackendToken('x'.repeat(4097))`/`('')` → `SCHEMA_VALIDATION_FAILED`；凭据往返按初始状态分支断言（`initial==='unavailable'` 走不可用路 setErr 含 `CREDENTIAL_UNAVAILABLE` + afterClear=`unavailable`；else 走可用路 `available→available→empty`）。
- **来源校验**：套件级 `app` 内建隐藏 BrowserWindow（真实 `out/preload/index.js` + sandbox/contextIsolation）→ `window.desktopApi.getAppInfo()` 被拒（`res.err` 含「拒绝」）。
- **外部链接**：`app.evaluate` 内 `globalThis.__ext=[]` + `shell.openExternal=(u)=>{__ext.push(u); return Promise.resolve()}`（返回 Promise——will-navigate 分支对 openExternal 调 `.catch`）→ renderer `window.open('https://example.com')`/`location.href` → `__ext` 含 URL + 不新建窗/不导航；每例独立 launch（closeApp 关进程即退出，无需显式恢复）。
- **信任边界**：`serveRenderer()` http 服务 `out/renderer` → chromium 加载 → `window.desktopApi` undefined。
- **CI**：ci.yml `check` job 追加 `playwright install --with-deps chromium` + `xvfb-run -a pnpm test:integration`。
- 验收门槛：`pnpm test:integration` 本机跑通（DISPLAY 或 xvfb）；既有 182 单测 + typecheck + lint 不回归；块 A verify:artifact 冒烟仍过；doc 16 验收门槛 2 项勾选。

---

### Task 1: 测试助手（tests/integration/helpers/app.ts）

**Files:**
- Create: `apps/desktop/tests/integration/helpers/app.ts`
- Test: `apps/desktop/tests/integration/helpers/app.spec.ts`（轻量自测：launchApp 能启动并返回主窗）

**Interfaces:**
- Consumes: 块 A/B 既有构建产物（`out/`）；Playwright `_electron`/`chromium`
- Produces:
  ```typescript
  export interface LaunchedApp { app: ElectronApplication; page: Page; userData: string }
  export async function launchApp(): Promise<LaunchedApp>
  export async function closeApp(launched: LaunchedApp): Promise<void>
  export async function serveRenderer(): Promise<{ url: string; close(): Promise<void> }>
  ```
  后续 Task 3-6 全部消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/integration/helpers/app.spec.ts
import { describe, expect, it } from 'vitest'
import { closeApp, launchApp } from './app'

describe('launchApp 助手', () => {
  it('能以 --mode test 产物启动并返回主窗（临时 userData 隔离）', async () => {
    const launched = await launchApp()
    try {
      const info = await launched.page.evaluate(() => window.desktopApi.getAppInfo())
      expect(info.name).toBe('Cyrene')
      expect(launched.page.url()).toMatch(/^cyrene:\/\//)
    } finally { await closeApp(launched) }
  })
})
```
（前置：`out/` 已由 `test:integration` 脚本先 build --mode test）

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/desktop && electron-vite build --mode test && npx vitest run --config vitest.integration.config.mts tests/integration/helpers/app.spec.ts`
Expected: FAIL（helpers/app.ts 不存在）

- [ ] **Step 3: 实现**

```typescript
// tests/integration/helpers/app.ts
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { createServer } from 'node:http'
import { tmpdir } from 'os'
import { join, extname, resolve, sep } from 'path'
import { type AddressInfo } from 'node:net'

export interface LaunchedApp { app: ElectronApplication; page: Page; userData: string }

const ROOT = join(__dirname, '../../..')        // apps/desktop（helpers → integration → tests → apps/desktop）
const RENDERER_OUT = join(ROOT, 'out/renderer') // apps/desktop/out/renderer
const PRELOAD_OUT = join(ROOT, 'out/preload/index.js')

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json'
}

/** 用 --mode test 构建产物(out/)启动 app：临时 userData + harness 标记 + 清残留 dev env */
export async function launchApp(): Promise<LaunchedApp> {
  const electronPath = process.platform === 'win32'
    ? join(ROOT, 'node_modules/electron/dist/electron.exe')
    : join(ROOT, 'node_modules/electron/dist/electron')
  const userData = mkdtempSync(join(tmpdir(), 'cy-int-ud-'))
  const appDataKey = process.platform === 'win32' ? 'APPDATA' : process.platform === 'darwin' ? 'HOME' : 'XDG_CONFIG_HOME'
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    [appDataKey]: userData,        // appData→userData 隔离(join(appData,'Cyrene'))
    CYRENE_TEST_HARNESS: '1'
  }
  delete env['ELECTRON_RUN_AS_NODE']; delete env['ELECTRON_ENABLE_LOGGING']; delete env['ELECTRON_RENDERER_URL']; delete env['NODE_OPTIONS']
  const app = await _electron.launch({ executablePath: electronPath, args: [ROOT], cwd: ROOT, env, timeout: 30000 })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  try { await launched.app.close() } catch { /* 已退出 */ }
  try { rmSync(launched.userData, { recursive: true, force: true }) } catch { /* 清理尽力 */ }
}

/** 静态服务 out/renderer（信任边界测试用；普通浏览器无 preload → desktopApi undefined） */
export async function serveRenderer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? '/index.html').split('?')[0])
    const file = resolve(RENDERER_OUT, '.' + (pathname === '/' ? '/index.html' : pathname))
    // resolve + 前缀边界防穿越（verify-artifact 同款纪律）
    if (!file.startsWith(RENDERER_OUT + sep) && file !== RENDERER_OUT) { res.writeHead(404); res.end(); return }
    if (!existsSync(file)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/index.html`, close: () => new Promise((r) => server.close(() => r())) }
}

export { chromium, PRELOAD_OUT, RENDERER_OUT } // trust-boundary/ipc/protocol spec 复用
```

- [ ] **Step 4: 运行确认通过**

Run: 同上
Expected: PASS（1 项；若本机无 DISPLAY，需 `xvfb-run -a` 前缀）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/tests/integration/helpers/app.ts apps/desktop/tests/integration/helpers/app.spec.ts
git commit -m "feat(阶段1块C): 集成测试助手 launchApp/closeApp/serveRenderer（临时 userData 隔离 + 平台分支）"
```

---

### Task 2: vitest.integration.config + test:integration 脚本

**Files:**
- Modify: `apps/desktop/vitest.integration.config.mts`（testTimeout/hookTimeout 60s + fileParallelism false）
- Modify: `apps/desktop/package.json`（test:integration 加 build --mode test 前置）

**Interfaces:**
- Consumes: 无
- Produces: `pnpm test:integration` = build + run（Task 3-6 统一入口）

- [ ] **Step 1: 基线确认（配置无红阶段——测试即产物，被测 app 已就绪）**

Run: `pnpm --filter @cyrene/desktop test:integration 2>&1 | tail -5`
Expected: 脚本当前无 build 前置——若 `out/` 缺失或 `__APP_MODE__` 非 test，app.spec（Task 1）可能失败；确认基线后再改脚本

- [ ] **Step 2: 实现**

`vitest.integration.config.mts`（**仅更新 `test:` 段，保留既有 `resolve.alias`**）：
```typescript
test: {
  include: ['tests/integration/**/*.spec.ts'],
  environment: 'node',
  testTimeout: 60000,   // Electron 冷启动 8–20s
  hookTimeout: 60000,   // beforeAll launchApp 冷启动(默认 10000 会在启动前中止)
  fileParallelism: false
}
```
`package.json`：
```json
"test:integration": "electron-vite build --mode test && vitest run --config vitest.integration.config.mts"
```

- [ ] **Step 3: 运行验证**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: 脚本先 build（out/ 更新为 __APP_MODE__='test'）再跑 vitest；Task 1 的 app.spec 通过

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/vitest.integration.config.mts apps/desktop/package.json
git commit -m "chore(阶段1块C): test:integration = build --mode test + vitest run;config testTimeout/hookTimeout 60s + fileParallelism false"
```

---

### Task 3: 协议 handler 集成测试（块 A F1 覆盖）

**Files:**
- Create: `apps/desktop/tests/integration/protocol-handler.spec.ts`

**Interfaces:**
- Consumes: Task 1 `launchApp`/`closeApp`/`LaunchedApp`；块 A handler（`out/` 已构建，真实注册）
- Produces: F1 用例组（spec §5.2 全表）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/integration/protocol-handler.spec.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { symlinkSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
const rendererRoot = join(__dirname, '../../out/renderer') // tests/integration → apps/desktop/out/renderer
const outside = mkdtempSync(join(tmpdir(), 'cy-f1-out-'))
const escapeLink = join(rendererRoot, 'escape-link')
const escapeDirIndex = join(rendererRoot, 'escape-dir', 'index.html')
const emptyDir = join(rendererRoot, 'empty-dir')

beforeAll(async () => {
  mkdirSync(join(rendererRoot, 'escape-dir'), { recursive: true })
  mkdirSync(emptyDir)
  writeFileSync(join(outside, 'secret.txt'), 'secret')           // 先写 target 再建 symlink（Windows 可移植）
  symlinkSync(join(outside, 'secret.txt'), escapeLink)           // 文件级 symlink → 外部
  symlinkSync(join(outside, 'secret.txt'), escapeDirIndex)       // 目录内 index.html → 外部
  launched = await launchApp()
})
afterAll(async () => {
  if (launched) await closeApp(launched) // beforeAll 失败时 launched 未赋值，防二次抛
  rmSync(escapeLink, { force: true }); rmSync(join(rendererRoot, 'escape-dir'), { recursive: true, force: true })
  rmSync(emptyDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
})

const fetchStatus = (url: string): Promise<number> =>
  launched.app.evaluate(async ({ net }, u) => (await net.fetch(u)).status, url)

describe('protocol handler（F1 拒绝分支实测）', () => {
  it('正常 index.html → 200 + 严格 CSP', async () => {
    const res = await launched.app.evaluate(async ({ net }) => {
      const r = await net.fetch('cyrene://renderer/index.html')
      return { status: r.status, csp: r.headers.get('content-security-policy') }
    })
    expect(res.status).toBe(200)
    expect(res.csp).toContain("default-src 'none'")
    expect(res.csp).toContain("frame-src 'none'")
  })
  it('非 renderer host → 404', async () => expect(await fetchStatus('cyrene://evil-host/')).toBe(404))
  it('空 host → 404（400 为防御性死代码不测）', async () => expect(await fetchStatus('cyrene://')).toBe(404))
  it('路径穿越 ..%2f → 403', async () => expect(await fetchStatus('cyrene://renderer/..%2f..%2fetc%2fpasswd')).toBe(403))
  it('孤立 % → 403（decode 抛错）', async () => expect(await fetchStatus('cyrene://renderer/%')).toBe(403))
  it('缺失文件 → 404', async () => expect(await fetchStatus('cyrene://renderer/nonexistent.js')).toBe(404))
  it('空目录无 index.html → 404', async () => expect(await fetchStatus('cyrene://renderer/empty-dir/')).toBe(404))
  it('文件 symlink 逃逸 → 403', async () => expect(await fetchStatus('cyrene://renderer/escape-link')).toBe(403))
  it('目录内 index.html symlink 逃逸 → 403', async () => expect(await fetchStatus('cyrene://renderer/escape-dir/')).toBe(403))
})
```

- [ ] **Step 2: 基线确认（测试即产物，无红阶段——app 已就绪，真验证在 Step 4）**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: 套件命令可执行、Task 1/2 既有用例通过；本文件尚未落盘故 protocol-handler 未跑

- [ ] **Step 3: 实现（文件本身即测试——无额外实现）**

本任务测试即产物；只需确认 spec 文件落盘。若个别用例因实施期事实失败（如 `net.fetch` 空 host 抛而非返 404），就地按 spec §5.2/C-G6 调整（try/catch 兼容两种落点）并记录。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: protocol-handler 9 项 PASS（本机 DISPLAY 或 xvfb）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/tests/integration/protocol-handler.spec.ts
git commit -m "test(阶段1块C): 协议 handler F1 集成测试——403/404/逃逸/200+CSP 真实 handler 实测"
```

---

### Task 4: IPC 安全集成测试

**Files:**
- Create: `apps/desktop/tests/integration/ipc-security.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers；块 B preload/executor/credential-store（真实链路）
- Produces: API 面/超大输入/非法参数/来源校验/凭据往返 5 用例

- [ ] **Step 1: 写失败测试**

```typescript
// tests/integration/ipc-security.spec.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

let app: ElectronApplication
let page: Page
let userData: string
beforeAll(async () => { ({ app, page, userData } = await launchApp()) })
afterAll(async () => { await closeApp({ app, page, userData }) })

describe('IPC 安全', () => {
  it('desktopApi 只暴露白名单方法（无 raw ipcRenderer/任意通道）', async () => {
    const surface = await page.evaluate(() => ({
      keys: Object.keys((window as any).desktopApi ?? {}).sort(),
      hasIpc: !!(window as any).ipcRenderer,
      hasRequire: typeof (window as any).require,
      hasProcess: typeof (window as any).process
    }))
    expect(surface.keys).toEqual(['clearBackendToken', 'getAppInfo', 'getCredentialStatus', 'setBackendToken'])
    expect(surface.hasIpc).toBe(false)
    expect(surface.hasRequire).toBe('undefined')
    expect(surface.hasProcess).toBe('undefined')
  })
  it('超大输入 → SCHEMA_VALIDATION_FAILED', async () => {
    const err = await page.evaluate(async () => {
      try { await (window as any).desktopApi.setBackendToken('x'.repeat(4097)); return null }
      catch (e: any) { return e.message }
    })
    expect(err).toContain('SCHEMA_VALIDATION_FAILED')
  })
  it('空串 → SCHEMA_VALIDATION_FAILED', async () => {
    const err = await page.evaluate(async () => {
      try { await (window as any).desktopApi.setBackendToken(''); return null }
      catch (e: any) { return e.message }
    })
    expect(err).toContain('SCHEMA_VALIDATION_FAILED')
  })
  it('凭据往返按 safeStorage 可用性分支断言', async () => {
    const flow = await page.evaluate(async () => {
      const initial = await (window as any).desktopApi.getCredentialStatus()
      if (initial === 'unavailable') {
        let setErr: string | null = null
        try { await (window as any).desktopApi.setBackendToken('sk-test-token') } catch (e: any) { setErr = e.message }
        const afterClear = await (window as any).desktopApi.clearBackendToken()
        return { initial, setErr, afterClear }
      }
      const s1 = await (window as any).desktopApi.setBackendToken('sk-test-token')
      const s2 = await (window as any).desktopApi.getCredentialStatus()
      const s3 = await (window as any).desktopApi.clearBackendToken()
      return { initial, s1, s2, s3 }
    })
    if (flow.initial === 'unavailable') {
      expect(flow.setErr).toContain('CREDENTIAL_UNAVAILABLE')
      expect(flow.afterClear).toBe('unavailable')
    } else {
      expect(flow.s1).toBe('available'); expect(flow.s2).toBe('available'); expect(flow.s3).toBe('empty')
    }
  })
  it('非主窗口 webContents invoke → 被 isTrustedSender 拒绝（来源校验）', async () => {
    const res = await app.evaluate(async ({ BrowserWindow }, preloadPath) => {
      const hidden = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await hidden.loadURL('about:blank')
      try {
        const outcome = await hidden.webContents.executeJavaScript('window.desktopApi.getAppInfo()')
        return { ok: true, outcome }
      } catch (e: unknown) { return { ok: false, err: String(e) } }
      finally { hidden.destroy() }
    }, join(__dirname, '../../out/preload/index.js')) // tests/integration → apps/desktop/out/preload/index.js
    expect(res.ok).toBe(false)
    expect(res.err).toContain('拒绝')
  })
})
```

- [ ] **Step 2: 基线确认（测试即产物，无红阶段——app 已就绪，真验证在 Step 4）**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: 套件命令可执行、既有用例通过；本文件未落盘故本套件未跑

- [ ] **Step 3: 实现（测试即产物；无额外实现）**

若来源校验用例的实施期事实与 spec 不符（如 `about:blank` 不加载 preload 或 executeJavaScript 错误文本不含「拒绝」），就地调整（改用 `hidden.loadURL('data:text/html,<html></html>')` 或宽松断言 `/(拒绝|UNKNOWN)/`）并记录到 spec §10。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: ipc-security 5 项 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/tests/integration/ipc-security.spec.ts
git commit -m "test(阶段1块C): IPC 安全集成测试——API 面/超大输入/非法参数/来源校验/凭据往返"
```

---

### Task 5: 外部链接受控集成测试

**Files:**
- Create: `apps/desktop/tests/integration/navigation.spec.ts`

**Interfaces:**
- Consumes: Task 1 helpers；块 A main-window（setWindowOpenHandler/will-navigate）
- Produces: window.open/location 外部链接 → shell.openExternal + deny 2 用例

- [ ] **Step 1: 写失败测试**

```typescript
// tests/integration/navigation.spec.ts
import { describe, expect, it } from 'vitest'
import { launchApp, closeApp } from './helpers/app'

describe('外部链接受控打开', () => {
  it('window.open 外部链接 → shell.openExternal + 不新建窗', async () => {
    const { app, page, userData } = await launchApp()
    try {
      await app.evaluate(({ shell }) => {
        ;(globalThis as { __ext?: string[] }).__ext = []
        ;(shell as any).openExternal = (u: string): Promise<void> => { (globalThis as { __ext: string[] }).__ext.push(u); return Promise.resolve() }
      })
      const winCount0 = app.windows().length
      await page.evaluate(() => { window.open('https://example.com') })
      await expect.poll(async () => app.evaluate(() => (globalThis as { __ext: string[] }).__ext)).toContain('https://example.com')
      expect(app.windows().length).toBe(winCount0)
    } finally { await closeApp({ app, page, userData }) }
  })
  it('location 导航外部 → 不导航 + shell.openExternal', async () => {
    const { app, page, userData } = await launchApp()
    try {
      await app.evaluate(({ shell }) => {
        ;(globalThis as { __ext?: string[] }).__ext = []
        ;(shell as any).openExternal = (u: string): Promise<void> => { (globalThis as { __ext: string[] }).__ext.push(u); return Promise.resolve() }
      })
      await page.evaluate(() => { location.href = 'https://example.com/page' })
      await expect.poll(async () => app.evaluate(() => (globalThis as { __ext: string[] }).__ext)).toContain('https://example.com/page')
      expect(page.url()).toMatch(/^cyrene:\/\//) // deny：仍在本应用
    } finally { await closeApp({ app, page, userData }) }
  })
})
```

- [ ] **Step 2: 基线确认（测试即产物，无红阶段——app 已就绪，真验证在 Step 4）**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: 套件命令可执行、既有用例通过；本文件未落盘故本套件未跑

- [ ] **Step 3: 实现（测试即产物）**

若 `shell.openExternal` 属性不可写（实施期验证项），就地调整（改用 `app.evaluate` 内建一个可观测的替代，或记录为 spec §10 限制）。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: navigation 2 项 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/tests/integration/navigation.spec.ts
git commit -m "test(阶段1块C): 外部链接受控集成测试——window.open/location → shell.openExternal + deny"
```

---

### Task 6: 普通浏览器信任边界集成测试

**Files:**
- Create: `apps/desktop/tests/integration/trust-boundary.spec.ts`

**Interfaces:**
- Consumes: Task 1 `serveRenderer`/`chromium`；`out/renderer` 产物
- Produces: 普通浏览器 desktopApi undefined 1 用例

- [ ] **Step 1: 写失败测试**

```typescript
// tests/integration/trust-boundary.spec.ts
import { describe, expect, it } from 'vitest'
import { serveRenderer, chromium } from './helpers/app'

describe('普通浏览器信任边界', () => {
  it('普通 chromium 加载产物 Renderer → desktopApi undefined', async () => {
    const server = await serveRenderer()
    const browser = await chromium.launch()
    const page = await browser.newPage()
    try {
      await page.goto(server.url)
      expect(await page.evaluate(() => typeof (window as any).desktopApi)).toBe('undefined')
    } finally {
      await browser.close()
      await server.close()
    }
  })
})
```

- [ ] **Step 2: 基线确认（测试即产物，无红阶段——app 已就绪，真验证在 Step 4）**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: 套件命令可执行、既有用例通过；本文件未落盘故本套件未跑

- [ ] **Step 3: 实现（测试即产物）**

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @cyrene/desktop test:integration`
Expected: trust-boundary 1 项 PASS（chromium 已装；CI 用 --with-deps）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/tests/integration/trust-boundary.spec.ts
git commit -m "test(阶段1块C): 普通浏览器信任边界——无 preload 时 desktopApi undefined"
```

---

### Task 7: CI 集成测试 + 文档收口

**Files:**
- Modify: `.github/workflows/ci.yml`（+ playwright install --with-deps chromium + xvfb-run test:integration）
- Modify: `apps/desktop/tests/integration/README.md`（运行方式/平台差异/排障）
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（验收门槛 2 项勾选 + changelog）

**Interfaces:**
- Consumes: Task 2 `test:integration` 脚本；Task 3-6 套件
- Produces: CI 闭环 + doc 16 勾选

- [ ] **Step 1: 实现 CI**

`.github/workflows/ci.yml` `check` job 追加（Lint 之后）：
```yaml
      - name: Install Playwright (integration)
        run: pnpm --filter @cyrene/desktop exec playwright install --with-deps chromium

      - name: Integration tests (xvfb)
        run: xvfb-run -a pnpm test:integration
```

- [ ] **Step 2: 写 README**

`tests/integration/README.md`：运行 `pnpm --filter @cyrene/desktop test:integration`（自动 build --mode test + vitest）；Linux 无显示器用 `xvfb-run -a`；Windows 用 `APPDATA` 隔离、macOS 用 `HOME`（CI 仅 Linux）；失败排障：确认 `out/` 已构建、DISPLAY、playwright install --with-deps。

- [ ] **Step 3: 更新 doc 16**

验收门槛勾选：
```
- [x] 非白名单通道、非法参数与超大输入被 Main 拒绝（块 C 集成测试：desktopApi 面恰为白名单 + setBackendToken 4097/空串 → SCHEMA_VALIDATION_FAILED + 隐藏窗来源校验被拒）——2026-08-10
- [x] 外部链接通过受控接口打开（块 C 集成测试：window.open/location 外部 → shell.openExternal + deny 不导航）——2026-08-10
```
changelog 追加：
```
| 2026-08-10 | **阶段 1 块 C（IPC/协议安全集成测试）落地**：Playwright _electron 集成套件（协议 handler F1 403/404/逃逸/200+CSP、IPC API 面/超大输入/来源校验、外部链接受控、普通浏览器信任边界）+ test:integration(--mode test 构建) + CI xvfb-run | 已开发、未联调 |
```

- [ ] **Step 4: 全量验证 + 提交**

Run: `cd apps/desktop && pnpm test && pnpm typecheck && pnpm lint && pnpm test:integration && pnpm verify:artifact -- --smoke`
Expected: 单测全绿（以实际数为准）+ typecheck + lint + 集成套件全绿；verify:artifact 冒烟仍过（需 DISPLAY/xvfb；若产物缺失或本机无显示器可跳过并记录）

```bash
git add .github/workflows/ci.yml apps/desktop/tests/integration/README.md "docs/16-Cyrene-前端实施任务清单与进度跟踪.md"
git commit -m "chore(阶段1块C): CI test:integration(xvfb-run) + tests/integration README + doc16 验收门槛勾选"
```

---

## 自审清单（Self-Review）

- [ ] **Spec 覆盖**：§5.1 helpers（Task 1）、§5.7 配置/脚本（Task 2）、§5.2 F1（Task 3）、§5.3 IPC（Task 4）、§5.4 navigation（Task 5）、§5.5 trust-boundary（Task 6）、§5.6 CI + doc 16（Task 7）——全部有任务。
- [ ] **验收#2 F1 全分支**：Task 3 覆盖 403(穿越)/403(文件逃逸)/403(目录 index 逃逸)/404(缺失)/404(目录无 index)/404(非 host)/404(空 host)/200+CSP；400 为死代码不测（C-G6）。
- [ ] **验收#3 doc 16**：Task 7 勾选「非白名单通道/非法参数/超大输入被 Main 拒绝」+「外部链接通过受控接口打开」。
- [ ] **验收#5 CI**：Task 7 xvfb-run + --with-deps chromium。
- [ ] **占位符扫描**：所有步骤给实际代码；无 TBD/TODO。
- [ ] **类型一致性**：`launchApp`/`closeApp`/`serveRenderer` 签名跨 Task 1→3-6 一致；`LaunchedApp` 与 `ElectronApplication` 区分正确（Task 4 的 `let app: ElectronApplication`）。
- [ ] **平台差异**：XDG/APPDATA/HOME 分支（Task 1）；basic_text 分支断言（Task 4）；记录 §10。
