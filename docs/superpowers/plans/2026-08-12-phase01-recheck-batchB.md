# 阶段 0/1 整改·批次 B：Renderer 信任边界 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 FE-S1-P0-02（dev Renderer URL 回环白名单 + 非法启动报错退出 + 单一策略函数 + 开发 CSP）与 FE-S1-P2-01（IPC mainFrame/URL 来源纵深校验）。

**Architecture:** 新增纯 Node 单一策略模块 `config/trusted-renderer-origin.ts`（回环 + `CYRENE_DEV_RENDERER_ORIGINS` allowlist，被窗口加载/导航/IPC 共用）；`env.ts` 的 `shouldUseViteDevServer` 重构为基于该策略；`main/index.ts` 加启动门禁（untrusted → fatal + return）；`registry.ts` 的 `isTrustedSender` 重构为可测纯守卫（mainFrame + senderFrame.url）；开发 CSP 用 `config/dev-csp.ts` 纯函数 + Vite serve 中间件注入 `frame-ancestors 'none'` 等响应头 + `index.html` meta 收紧。

**Tech Stack:** Electron main（Node）+ electron-vite + TypeScript + vitest（node 环境，`tests/unit/`）。

## Global Constraints

- 决策 B1（用户拍板）：回环（localhost / 127.0.0.0/8 / `[::1]`）+ 可配置附加 allowlist（env `CYRENE_DEV_RENDERER_ORIGINS`，逗号分隔 http origin）。
- 决策 B2（用户拍板）：非法 dev URL **启动报错退出**（`fatal` 后必须 `return`——fatal 的 exit 是异步的，不 return 会继续走到建窗/注册）。
- 决策 B3（推荐）：`frame-ancestors 'none'` 只能经响应头（meta 不支持）→ Vite serve 中间件注入；meta 只放 `frame-src 'none'`/`form-action 'none'`；`connect-src` 不用裸 `ws:`/`wss:` scheme。
- 单一策略函数（`evaluateDevRendererUrl`/`isAppRendererUrl`）为窗口加载/导航/IPC 共用；策略模块**必须 electron-free**（`electron.vite.config.ts` 也要 import 它）。
- `evaluateDevRendererUrl` 对 falsy（undefined/`''`/纯空白）归 `absent`（与 `env.ts` 现 `!u` 一致）。
- IPC URL 校验用 `event.senderFrame.url`（先 frame 身份后 URL 顺序不变）。
- 生产 `cyrene://` header CSP（`protocol/csp.ts`）不动；meta 收紧与 header 取交集不削弱生产。
- `buildDevCsp` 的 ws 源用 `u.hostname`（不含 port）+ `:*` 通配（`ws://localhost:*`），**不是** `u.host`（会产出 `ws://host:5173:*` 非法）。
- 新增测试只落 `tests/unit/`；集成套件（`launchApp` 删 ELECTRON_RENDERER_URL）不受影响。
- 文档仍标「已开发、未联调」；不触碰批次 C/D 项。

---

### Task 1: 单一策略模块 + env 谓词重构（FE-S1-P0-02 核心）

**Files:**
- Create: `apps/desktop/src/main/config/trusted-renderer-origin.ts`
- Modify: `apps/desktop/src/main/config/env.ts`
- Test: `apps/desktop/tests/unit/trusted-renderer-origin.spec.ts`（新）、`apps/desktop/tests/unit/config-env.spec.ts`（更新）

**Interfaces:**
- Produces（T2/T3/T4 消费）:
  - `export function isLoopbackHostname(hostname: string): boolean`
  - `export function normalizeOrigin(url: URL): string`
  - `export function resolveTrustedDevOrigins(env?: Record<string, string | undefined>): ReadonlySet<string>`
  - `export function isTrustedDevUrl(url: URL, trusted: ReadonlySet<string>): boolean`
  - `export function isAppRendererUrl(rawUrl: string, trusted: ReadonlySet<string>): boolean`
  - `export function evaluateDevRendererUrl(raw: string | undefined, env: Record<string, string | undefined>): { status: 'absent' | 'trusted' | 'untrusted'; url?: URL; reason?: string }`
  - `export function getTrustedDevOrigins(): ReadonlySet<string>`（记忆化，读 process.env）
- Consumes: `RENDERER_HOST`（`../protocol/constants`，纯常量无 electron）。

- [ ] **Step 1: 写失败测试**——`tests/unit/trusted-renderer-origin.spec.ts`（新文件）：

```ts
// tests/unit/trusted-renderer-origin.spec.ts
import { describe, expect, it } from 'vitest'
import {
  isLoopbackHostname, resolveTrustedDevOrigins, evaluateDevRendererUrl, isAppRendererUrl
} from '../../src/main/config/trusted-renderer-origin'

describe('isLoopbackHostname', () => {
  it('回环 true：localhost / 127.x / [::1]', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.8.9.10')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
  })
  it('非回环 false', () => {
    expect(isLoopbackHostname('192.168.1.10')).toBe(false)
    expect(isLoopbackHostname('example.com')).toBe(false)
    expect(isLoopbackHostname('10.0.0.1')).toBe(false)
  })
})

describe('resolveTrustedDevOrigins', () => {
  it('无 env → 仅回环 http 三 origin', () => {
    const s = resolveTrustedDevOrigins({})
    expect(s.has('http://localhost')).toBe(true)
    expect(s.has('http://127.0.0.1')).toBe(true)
    expect(s.has('http://[::1]')).toBe(true)
    expect(s.has('http://192.168.1.5')).toBe(false)
  })
  it('allowlist 附加 http origin；https/userinfo/fragment/畸形条目跳过', () => {
    const s = resolveTrustedDevOrigins({
      CYRENE_DEV_RENDERER_ORIGINS: 'http://192.168.1.5:5173, https://evil.example, http://user:pass@x:1, http://y:2/#frag, not-a-url'
    })
    expect(s.has('http://192.168.1.5:5173')).toBe(true)
    expect(s.has('https://evil.example')).toBe(false)
    expect(s.has('http://x:1')).toBe(false)
    expect(s.has('http://y:2')).toBe(false)
  })
  it('空白条目忽略', () => {
    const s = resolveTrustedDevOrigins({ CYRENE_DEV_RENDERER_ORIGINS: ' , , http://10.0.0.2:5173 ' })
    expect(s.has('http://10.0.0.2:5173')).toBe(true)
  })
})

describe('evaluateDevRendererUrl', () => {
  it('falsy/空白 → absent', () => {
    expect(evaluateDevRendererUrl(undefined, {}).status).toBe('absent')
    expect(evaluateDevRendererUrl('', {}).status).toBe('absent')
    expect(evaluateDevRendererUrl('   ', {}).status).toBe('absent')
  })
  it('回环 → trusted', () => {
    expect(evaluateDevRendererUrl('http://localhost:5173', {}).status).toBe('trusted')
    expect(evaluateDevRendererUrl('http://127.0.0.1:5173', {}).status).toBe('trusted')
    expect(evaluateDevRendererUrl('http://[::1]:5173', {}).status).toBe('trusted')
  })
  it('https/局域网无 allowlist/userinfo/fragment/畸形 → untrusted', () => {
    expect(evaluateDevRendererUrl('https://example.test/', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('http://192.168.1.5:5173', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('http://user:pass@localhost:5173', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('http://localhost:5173/#frag', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('not-a-url', {}).status).toBe('untrusted')
    expect(evaluateDevRendererUrl('file:///x', {}).status).toBe('untrusted')
  })
  it('局域网 + allowlist → trusted；untrusted 带 reason', () => {
    const r = evaluateDevRendererUrl('http://192.168.1.5:5173', { CYRENE_DEV_RENDERER_ORIGINS: 'http://192.168.1.5:5173' })
    expect(r.status).toBe('trusted')
    expect(evaluateDevRendererUrl('https://example.test/', {}).reason).toContain('http')
  })
})

describe('isAppRendererUrl', () => {
  const trusted = resolveTrustedDevOrigins({})
  it('cyrene://renderer → true；错误 cyrene host → false', () => {
    expect(isAppRendererUrl('cyrene://renderer/index.html', trusted)).toBe(true)
    expect(isAppRendererUrl('cyrene://evil/index.html', trusted)).toBe(false)
  })
  it('受信 http → true；异源/畸形 → false', () => {
    expect(isAppRendererUrl('http://localhost:5173/', trusted)).toBe(true)
    expect(isAppRendererUrl('http://evil.example/', trusted)).toBe(false)
    expect(isAppRendererUrl('not a url', trusted)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/trusted-renderer-origin.spec.ts`
Expected: 任务失败——模块不存在 → 运行期 import 报错（vitest 不 typecheck）。

- [ ] **Step 3: 实现 `trusted-renderer-origin.ts`**

```ts
// src/main/config/trusted-renderer-origin.ts
// 纯 Node（无 electron import）：electron.vite.config.ts（dev CSP 插件）也要 import 它构建 CSP。
// 「受信 Renderer URL」单一策略函数——窗口加载（main-window）/ 导航（navigation 经 devOrigin）/ IPC 来源（registry）共用。
import { RENDERER_HOST } from '../protocol/constants'

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname)
}

export function normalizeOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`
}

const ALLOWLIST_ENV_KEY = 'CYRENE_DEV_RENDERER_ORIGINS'

/** 可信 dev Origin 集合：回环 http 恒允许 + allowlist（http、无 userinfo/fragment；非法条目跳过） */
export function resolveTrustedDevOrigins(env: Record<string, string | undefined> = {}): ReadonlySet<string> {
  const trusted = new Set<string>(['http://localhost', 'http://127.0.0.1', 'http://[::1]'])
  const raw = env[ALLOWLIST_ENV_KEY]
  if (!raw) return trusted
  for (const item of raw.split(',')) {
    const trimmed = item.trim()
    if (!trimmed) continue
    try {
      const u = new URL(trimmed)
      if (u.protocol !== 'http:') continue
      if (u.username || u.password || u.hash) continue
      trusted.add(normalizeOrigin(u))
    } catch {
      // 畸形条目跳过（fail-closed 于该条）
    }
  }
  return trusted
}

export function isTrustedDevUrl(url: URL, trusted: ReadonlySet<string>): boolean {
  if (url.protocol !== 'http:') return false
  if (url.username || url.password || url.hash) return false
  // 回环 hostname 恒放行任意端口；allowlist 保持精确 origin（含端口）语义
  return isLoopbackHostname(url.hostname) || trusted.has(normalizeOrigin(url))
}

export function isAppRendererUrl(rawUrl: string, trusted: ReadonlySet<string>): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'cyrene:' && url.host === RENDERER_HOST) return true
    return isTrustedDevUrl(url, trusted)
  } catch {
    return false
  }
}

/** 启动评估（B2）：falsy/空白 = absent（无 dev server）；非法 = untrusted（启动报错退出） */
export function evaluateDevRendererUrl(
  raw: string | undefined,
  env: Record<string, string | undefined>
): { status: 'absent' | 'trusted' | 'untrusted'; url?: URL; reason?: string } {
  if (!raw || !raw.trim()) return { status: 'absent' }
  let url: URL
  try { url = new URL(raw) } catch { return { status: 'untrusted', reason: '无法解析为 URL' } }
  if (url.protocol !== 'http:') return { status: 'untrusted', reason: `协议必须是 http:（收到 ${url.protocol}）` }
  if (url.username || url.password) return { status: 'untrusted', reason: '不允许 userinfo' }
  if (url.hash) return { status: 'untrusted', reason: '不允许 fragment' }
  const trusted = resolveTrustedDevOrigins(env)
  // 回环 hostname 恒放行任意端口（URL.hostname 含端口则 normalizeOrigin 不匹配无端口基础集合，须短路）；
  // allowlist 精确匹配（条目带端口 normalize 入集合）
  if (!isLoopbackHostname(url.hostname) && !trusted.has(normalizeOrigin(url))) {
    return { status: 'untrusted', reason: `host ${url.host} 不在回环或 ${ALLOWLIST_ENV_KEY} 白名单` }
  }
  return { status: 'trusted', url }
}

/** 记忆化运行时集合（env 恒定）：registry IPC 校验与 dev CSP 插件共用 */
let cachedTrusted: ReadonlySet<string> | null = null
export function getTrustedDevOrigins(): ReadonlySet<string> {
  if (!cachedTrusted) cachedTrusted = resolveTrustedDevOrigins(process.env)
  return cachedTrusted
}
```

**`env.ts` 重构**：`shouldUseViteDevServer` 改为基于单一策略（删旧 body，保留签名与 AppConfig）：

```ts
import { evaluateDevRendererUrl } from './trusted-renderer-origin'

// 加载/协议注册统一谓词：未打包 && ELECTRON_RENDERER_URL 为受信 dev Origin（回环或 allowlist）。
// 打包恒 false；畸形/非 http/远程 host → untrusted → false（且 main() 启动门禁对 untrusted 报错退出）。
export function shouldUseViteDevServer(
  isPackaged: boolean,
  env: Record<string, string | undefined> = {}
): boolean {
  if (isPackaged) return false
  return evaluateDevRendererUrl(env['ELECTRON_RENDERER_URL'], env).status === 'trusted'
}
```

- [ ] **Step 4: 跑测试确认通过 + 更新 `config-env.spec.ts`**

Run: `pnpm -F @cyrene/desktop test tests/unit/trusted-renderer-origin.spec.ts tests/unit/config-env.spec.ts`
先跑：`trusted-renderer-origin.spec` 应全绿。`config-env.spec.ts` 的 `shouldUseViteDevServer` 块既有 4 例仍应通过（localhost 回环 trusted / 打包 false / 无 env absent false / 畸形 untrusted false）——若全过，追加 2 例（语义变化回归）：

```ts
  it('https/远程 host 无 allowlist → false（B1/B2 语义变化）', () => {
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'https://example.test/' })).toBe(false)
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'http://192.168.1.5:5173' })).toBe(false)
  })
  it('allowlist 附加 origin → true', () => {
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'http://192.168.1.5:5173', CYRENE_DEV_RENDERER_ORIGINS: 'http://192.168.1.5:5173' })).toBe(true)
  })
```
再跑：`config-env.spec.ts` 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/config/trusted-renderer-origin.ts apps/desktop/src/main/config/env.ts apps/desktop/tests/unit/trusted-renderer-origin.spec.ts apps/desktop/tests/unit/config-env.spec.ts
git commit -m "fix(阶段0/1批次B T1): dev URL 回环白名单单一策略模块 + shouldUseViteDevServer 重构(P0-02)"
```

---

### Task 2: main 装配消费策略——启动门禁（index.ts）+ 窗口加载（main-window.ts）

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/windows/main-window.ts`

**Interfaces:**
- Consumes: `evaluateDevRendererUrl` / `shouldUseViteDevServer`（T1）、`fatal`（批次 A `createFatalShutdown`）
- Produces: 无（装配）

- [ ] **Step 1: 改装配**

`main/index.ts`：
- import 追加：`import { evaluateDevRendererUrl } from './config/trusted-renderer-origin'`；
- 在 `createDiagnostics`（:104）之后、`registerHandlers` 之前的装配区加启动门禁（**须在 `requestSingleInstanceLock` 之后**——只有持锁主实例评估，第二实例在 lock 处已 exit(0)；**`fatal` 后必须 `return`**——fatal exit 异步）：

```ts
    if (!app.isPackaged) {
      const devEval = evaluateDevRendererUrl(process.env['ELECTRON_RENDERER_URL'], process.env)
      if (devEval.status === 'untrusted') {
        fatal(`ELECTRON_RENDERER_URL 指向不受信地址：${devEval.reason}（仅允许回环或 CYRENE_DEV_RENDERER_ORIGINS 白名单 http 地址）`)
        return
      }
    }
```

`windows/main-window.ts`：
- import 追加：`import { evaluateDevRendererUrl } from '../config/trusted-renderer-origin'`；
- 替换 `devOrigin` 解析（:21-26）为单一策略（复用 `devUrl` 字符串避免两处读 env）：

```ts
  const usingDevServer = shouldUseViteDevServer(app.isPackaged, process.env)
  const devEval = evaluateDevRendererUrl(devUrl, process.env)
  const devOrigin = usingDevServer && devEval.status === 'trusted' ? devEval.url : undefined
```
- loadURL 分支（:78-83）改 `devOrigin.toString()`（URL.toString 只补尾斜杠，Vite 对根等价；classifyNavigation 只比 protocol+host，不受影响），守卫保持 `usingDevServer && devOrigin`：

```ts
  if (usingDevServer && devOrigin) {
    win.loadURL(devOrigin.toString()).catch((err) => { loadErrorSink?.(err) })
  } else {
    win.loadURL(`${PROTOCOL_SCHEME}://${RENDERER_HOST}/index.html`).catch((err) => { loadErrorSink?.(err) })
  }
```

- [ ] **Step 2: 验证编译与既有套件**

Run: `pnpm -F @cyrene/desktop typecheck` 与 `pnpm -F @cyrene/desktop build`
Expected: 全绿（门禁逻辑已由 T1 的 `evaluateDevRendererUrl` 单测覆盖；main-window 走同一策略；装配经 typecheck/build 与后续 T5 集成套件验证）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/windows/main-window.ts
git commit -m "fix(阶段0/1批次B T2): 启动门禁(untrusted fatal+return) + 窗口加载走单一策略(P0-02)"
```

---

### Task 3: IPC 来源纵深校验（FE-S1-P2-01）

**Files:**
- Modify: `apps/desktop/src/main/ipc/registry.ts`
- Test: `apps/desktop/tests/unit/registry-trust.spec.ts`（新）

**Interfaces:**
- Consumes: `getTrustedDevOrigins` / `isAppRendererUrl`（T1）
- Produces: `export function isTrustedSenderFor(win, event, trusted): boolean`（可测纯守卫）

- [ ] **Step 1: 写失败测试**——`tests/unit/registry-trust.spec.ts`（新）：

```ts
// tests/unit/registry-trust.spec.ts
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { handle: vi.fn() } })) // registry 顶层 import electron
import { isTrustedSenderFor } from '../../src/main/ipc/registry'
import { resolveTrustedDevOrigins } from '../../src/main/config/trusted-renderer-origin'

const trusted = resolveTrustedDevOrigins({})
const frame = (url: string) => ({ url })
function makeWin(mainFrame: { url: string }, destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { mainFrame } }
}

describe('isTrustedSenderFor', () => {
  it('全匹配 + cyrene://renderer → true', () => {
    const mf = frame('cyrene://renderer/index.html')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(true)
  })
  it('全匹配 + 受信 http dev origin → true', () => {
    const mf = frame('http://localhost:5173/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(true)
  })
  it('win null / destroyed → false', () => {
    const mf = frame('cyrene://renderer/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(null, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(false)
    const dead = makeWin(mf, true)
    expect(isTrustedSenderFor(dead, { sender: dead.webContents, senderFrame: mf }, trusted)).toBe(false)
  })
  it('sender 不匹配 → false', () => {
    const mf = frame('cyrene://renderer/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: 'other-wc', senderFrame: mf }, trusted)).toBe(false)
  })
  it('senderFrame 缺失 / ≠ mainFrame → false', () => {
    const mf = frame('cyrene://renderer/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: null }, trusted)).toBe(false)
    const sub = frame('cyrene://renderer/')
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: sub }, trusted)).toBe(false) // sub !== mainFrame
  })
  it('senderFrame.url 不受信 → false（错误 cyrene host / 远程 http）', () => {
    const mf = frame('http://evil.example/')
    const win = makeWin(mf)
    expect(isTrustedSenderFor(win, { sender: win.webContents, senderFrame: mf }, trusted)).toBe(false)
    const mf2 = frame('cyrene://evil/')
    const win2 = makeWin(mf2)
    expect(isTrustedSenderFor(win2, { sender: win2.webContents, senderFrame: mf2 }, trusted)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/registry-trust.spec.ts`
Expected: 任务失败——`isTrustedSenderFor` 不存在 → 运行期 TypeError。

- [ ] **Step 3: 实现 `registry.ts`**

```ts
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannelName, IpcResult } from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { getTrustedDevOrigins, isAppRendererUrl } from '../config/trusted-renderer-origin'

let mainWindow: BrowserWindow | null = null
const registered = new Set<IpcChannelName>()

export function setMainWindow(win: BrowserWindow | null): void { mainWindow = win }
export function getMainWindow(): BrowserWindow | null { return mainWindow }

/** 可测纯守卫（P2-01）：win null/销毁、sender 不匹配、senderFrame 非 mainFrame、发送 frame URL 不受信 → 拒绝 */
export function isTrustedSenderFor(
  win: { isDestroyed(): boolean; webContents: { mainFrame: unknown } } | null,
  event: { sender: unknown; senderFrame: { url: string } | null },
  trusted: ReadonlySet<string>
): boolean {
  if (!win || win.isDestroyed()) return false
  if (!event.senderFrame) return false
  if (event.sender !== win.webContents) return false
  if (event.senderFrame !== win.webContents.mainFrame) return false
  return isAppRendererUrl(event.senderFrame.url, trusted)
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return isTrustedSenderFor(mainWindow, event, getTrustedDevOrigins())
}
```
（`registerHandler` 其余部分不变。）

- [ ] **Step 4: 跑测试确认通过 + 集成不回归**

Run: `pnpm -F @cyrene/desktop test tests/unit/registry-trust.spec.ts`
Expected: 全绿。随后 `pnpm -F @cyrene/desktop test:integration`（`tests/integration/ipc-security.spec.ts` 的「非主窗口 invoke 拒绝」在 cyrene:// 下走 isTrustedSenderFor 应仍通过——需 xvfb，见 T5 门禁）。**注**：按 spec §6，subframe 的 mainFrame 判别由本单测覆盖（`--mode test` cyrene:// 下 `frame-src 'none'` 已挡 iframe，无法在集成里构造非 mainFrame invoke 场景），集成仅保留既有 cross-window 例。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/ipc/registry.ts apps/desktop/tests/unit/registry-trust.spec.ts
git commit -m "fix(阶段0/1批次B T3): IPC 来源纵深——mainFrame+senderFrame.url 校验(P2-01)"
```

---

### Task 4: 开发 CSP——buildDevCsp + Vite 中间件 + meta 收紧（B3）

**Files:**
- Create: `apps/desktop/src/main/config/dev-csp.ts`
- Modify: `apps/desktop/electron.vite.config.ts`
- Modify: `apps/desktop/src/renderer/index.html`
- Test: `apps/desktop/tests/unit/dev-csp.spec.ts`（新）

**Interfaces:**
- Consumes: `getTrustedDevOrigins`（T1）
- Produces: `export function buildDevCsp(trusted: ReadonlySet<string>): string`

- [ ] **Step 1: 写失败测试**——`tests/unit/dev-csp.spec.ts`（新）：

```ts
// tests/unit/dev-csp.spec.ts
import { describe, expect, it } from 'vitest'
import { buildDevCsp } from '../../src/main/config/dev-csp'
import { resolveTrustedDevOrigins } from '../../src/main/config/trusted-renderer-origin'

describe('buildDevCsp', () => {
  it('含 frame-ancestors/frame-src/form-action none', () => {
    const csp = buildDevCsp(resolveTrustedDevOrigins({}))
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("form-action 'none'")
  })
  it('connect-src 含每受信 origin 的 ws/wss 源，不含裸 ws:/wss: scheme', () => {
    const connect = buildDevCsp(resolveTrustedDevOrigins({})).split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toContain('ws://localhost:*')
    expect(connect).toContain('ws://127.0.0.1:*')
    expect(connect).toContain('ws://[::1]:*')
    expect(connect).toContain('wss://localhost:*')
    expect(connect.split(' ')).not.toContain('ws:')
    expect(connect.split(' ')).not.toContain('wss:')
  })
  it('保留 style-src unsafe-inline（Vue SFC dev 样式）', () => {
    expect(buildDevCsp(resolveTrustedDevOrigins({}))).toContain("style-src 'self' 'unsafe-inline'")
  })
  it('allowlist 附加 origin 的 ws 进入 connect-src（hostname 通配端口）', () => {
    const t = resolveTrustedDevOrigins({ CYRENE_DEV_RENDERER_ORIGINS: 'http://192.168.1.5:5173' })
    const connect = buildDevCsp(t).split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connect).toContain('ws://192.168.1.5:*')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/dev-csp.spec.ts`
Expected: 任务失败——`buildDevCsp` 不存在 → 运行期 TypeError。

- [ ] **Step 3: 实现**

`src/main/config/dev-csp.ts`：
```ts
// src/main/config/dev-csp.ts
// 纯函数（electron-free）：electron.vite.config.ts 的 dev CSP 插件与单测共用。
// ws 源用 hostname（不含 port）+ :* 通配——u.host 含 port 会产出 ws://host:5173:* 非法。
export function buildDevCsp(trusted: ReadonlySet<string>): string {
  const wsSources: string[] = []
  for (const origin of trusted) {
    const u = new URL(origin)
    wsSources.push(`ws://${u.hostname}:*`, `wss://${u.hostname}:*`)
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${wsSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}
```

`electron.vite.config.ts`：import + devCspPlugin：
```ts
import type { Plugin } from 'vite'
import { buildDevCsp } from './src/main/config/dev-csp'
import { getTrustedDevOrigins } from './src/main/config/trusted-renderer-origin'

/** 开发 CSP 中间件（B3）：serve 下对全部响应注入 CSP 头——frame-ancestors 只能经响应头（meta 不支持） */
function devCspPlugin(): Plugin {
  return {
    name: 'cyrene:dev-csp',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', buildDevCsp(getTrustedDevOrigins()))
        next()
      })
    }
  }
}
```
renderer 段改：`plugins: [vue(), devCspPlugin()]`。

`src/renderer/index.html` meta 收紧（`connect-src` 去裸 `ws:`/`wss:`，加 `frame-src`/`form-action`）：
```html
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; frame-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'"
```
**注**：header `buildDevCsp` 含 `wss://<host>:*` 源，但 meta 无 wss 源——交集后 dev 下 wss 实际被 meta 裁掉；dev 是明文 http，HMR 走 `ws`（非 wss），`wss` 源不可达，无功能影响（生产 header `connect-src 'self'` ∩ meta → 仍 cyrene only）。此为该字段的双保险语义，见最终报告已知限制。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/dev-csp.spec.ts`
Expected: 全绿。再 `pnpm -F @cyrene/desktop typecheck`（配置 import src 模块可解析）与 `pnpm -F @cyrene/desktop build`（serve 插件在 build 下 apply:'serve' 不生效）应全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/config/dev-csp.ts apps/desktop/electron.vite.config.ts apps/desktop/src/renderer/index.html apps/desktop/tests/unit/dev-csp.spec.ts
git commit -m "fix(阶段0/1批次B T4): 开发 CSP——buildDevCsp+中间件注入 frame-ancestors+meta 收紧(B3)"
```

---

### Task 5: 全量门禁确认（无代码）

- [ ] **Step 1: 跑全部门禁**

Run: `pnpm -F @cyrene/desktop typecheck`、`pnpm -F @cyrene/desktop lint`、`pnpm -F @cyrene/desktop test`、`xvfb-run -a pnpm -F @cyrene/desktop test:integration`、`pnpm -F @cyrene/desktop build`、`pnpm -F @cyrene/desktop check:contract`、`pnpm -F @cyrene/desktop package`、`xvfb-run -a pnpm -F @cyrene/desktop verify:artifact -- --smoke`
Expected: 全部绿；单测 ≥ 460（含本批新增）；集成 22 不回归；check:contract 11/11；package + artifact smoke 通过（P0-02 验收 A6：打包态恒 cyrene:// 不回归）。

- [ ] **Step 2: 确认无代码变更**

Run: `git status --short`
Expected: 无本任务产生的改动；不 commit。

---

## 自审（对照 spec）

- §4.1 单一策略模块（isLoopbackHostname/normalizeOrigin/resolveTrustedDevOrigins/isTrustedDevUrl/isAppRendererUrl/evaluateDevRendererUrl/getTrustedDevOrigins）→ T1；falsy/空白 absent → T1；allowlist 非法条目跳过 → T1。
- §4.2 env.ts 重构 + 启动门禁（fatal+return、untrusted reason）→ T1 + T2；打包恒忽略 env → T1（isPackaged 短路）+ T2（`!app.isPackaged` 门禁）。
- §4.3 main-window 单一策略（devOrigin 从 evaluate 取）→ T2。
- §4.4 isTrustedSenderFor（win null/destroyed、sender、senderFrame=mainFrame、senderFrame.url 受信；顺序不变）→ T3。
- §4.5 buildDevCsp（frame-ancestors/frame-src/form-action none、connect-src ws hostname:*、保留 unsafe-inline）+ 中间件 + meta 收紧 → T4；生产 header 不动 → T4 未触碰 protocol/csp.ts。
- §4.6 验收测试（trusted-renderer-origin 全矩阵含 ''/空白 absent、dev-csp、registry-trust 含 vi.mock、config-env 2 新例）→ T1/T3/T4。
- §5 门禁（含 package + verify:artifact --smoke）→ T5。
- 已知限制（受信页 XSS 残余、LAN 异 port HMR、allowlist 非法条目静默跳过）→ T1/T4 注释 + 最终报告。

> **注**：文档同步（README / CLAUDE.md / docs/16 批次 B 状态 + `CYRENE_DEV_RENDERER_ORIGINS` 用法 + P0-02 关闭）属 SDD 工作流后续步骤，实施完成后由控制器执行并保留「已开发、未联调」。
