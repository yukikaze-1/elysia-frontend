# 阶段 1 块 A：安全加载与环境基线 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 建立 dev/test/prod 三环境配置与生产安全默认，把打包版 Renderer 从 `file://` 迁移到 `cyrene://` 受限自定义协议并落地严格 CSP，产出 electron-builder 未分发包与 `verify:artifact` 验证。

**Architecture:** 纯函数（config/env、config/debug-switches、protocol/path、protocol/csp、protocol/mime）先行并单测；Electron 绑定（scheme 特权注册、protocol.handle、装配、主窗口）接线后用 typecheck/build + Playwright `_electron` 冒烟验证。`__APP_MODE__` 由 electron-vite `define` 烘焙进 main，生产安全默认由运行时 `isPackaged` 强制。

**Tech Stack:** electron-vite 5 · Electron 43 · TypeScript 5.9 · Vitest 4 · playwright 1.6x · electron-builder

## Global Constraints

- 依据 spec：`docs/superpowers/specs/2026-08-09-phase1-loading-env-design.md`（任务代码须与之一致）
- scheme 恒为 `cyrene`，host 恒为 `renderer`；特权 `{standard, secure, supportFetchAPI, stream: true, corsEnabled: false, bypassCSP: false}`
- 安全不变量：`devToolsAllowed = !isPackaged`（不读 env、与构建 mode 无关）；`__APP_MODE__` 缺失/未知一律归 `production`
- CSP：prod 由协议响应头注入严格版，与 index.html 保留的宽松 meta **AND 取交集**（严格头胜出，meta 不剥离——供 dev/preview http 场景兜底）；AND 耦合记为已知限制
- 加载/协议注册谓词：纯「有无 `ELECTRON_RENDERER_URL`」（`usingDevServer`，不掺 mode）——有则 Vite http + 不注册 cyrene handler；无则 `cyrene://renderer/index.html` + 注册 handler
- 打包（isPackaged）检测到 `--remote-debugging-port`/`--inspect`（非 `=0`）、裸开关、`--inspect-brk`/`--inspect-node`/`--inspect-brk-node`/`--inspect-wait`/`--inspect-wait-node`/`--remote-debugging-fd` → failStart 拒绝（main() 顶部同步）；`--remote-debugging-port=0`/`--inspect=0`/`--remote-debugging-pipe` 仅 `CYRENE_TEST_HARNESS=1` 测试 harness 放行（Playwright 控制通道，未来可能切 pipe）
- **诚实限制（brk/wait 引导期暂停）**：`--inspect-brk`/`--inspect-wait`（argv 或 NODE_OPTIONS）在 Node 引导期、任何应用 JS（含门）执行前暂停主进程——进程内门无法先于暂停拦截该变体；门对非 brk/wait 开关（`--inspect`、`--remote-debugging-port` 等，不暂停、main() 先跑）有效。brk/wait 的拦截依赖阶段 8 Electron Fuses（记录 G-7）
- 打包时 `Menu.setApplicationMenu(null)`
- Node ≥22、pnpm 11；测试命令 `pnpm --filter @cyrene/desktop test`；命令在 `apps/desktop/` 下执行
- 不引入非必要依赖；新 devDependencies 仅 `playwright` 与 `electron-builder`
- 禁止把消息正文/Token/路径明文写入日志（本块无日志模块，只保持约定）

---

### Task 1: 环境配置纯函数（config/env.ts）

**Files:**
- Create: `apps/desktop/src/main/protocol/constants.ts`（纯常量，env.ts 依赖；先行创建避免 Task 1 编译失败）
- Create: `apps/desktop/src/main/config/env.ts`
- Test: `apps/desktop/tests/unit/config-env.spec.ts`

**Interfaces:**
- Produces: `AppMode` / `LogLevel` / `AppConfig` 类型；`normalizeAppMode(raw: string | undefined): AppMode`；`resolveAppConfig(mode: AppMode, isPackaged: boolean, env?: Record<string, string | undefined>): AppConfig`；`shouldUseViteDevServer(isPackaged: boolean, env?: Record<string, string | undefined>): boolean`
- 后续 Task 6 的 `config/index.ts` 使用 `normalizeAppMode` + `resolveAppConfig` + `shouldUseViteDevServer`

- [ ] **Step 1: 创建 protocol/constants.ts（纯常量，无 electron——config/env 与 scheme/navigation 共用，杜绝字面量漂移）**

```typescript
// apps/desktop/src/main/protocol/constants.ts
export const PROTOCOL_SCHEME = 'cyrene' as const
export const RENDERER_HOST = 'renderer' as const
```

- [ ] **Step 2: 写失败测试**

```typescript
// apps/desktop/tests/unit/config-env.spec.ts
import { describe, expect, it } from 'vitest'
import { normalizeAppMode, resolveAppConfig, shouldUseViteDevServer } from '../../src/main/config/env'

describe('normalizeAppMode', () => {
  it('development/test 原样保留', () => {
    expect(normalizeAppMode('development')).toBe('development')
    expect(normalizeAppMode('test')).toBe('test')
  })
  it('未知/缺失一律归 production（fail-safe）', () => {
    expect(normalizeAppMode('production')).toBe('production')
    expect(normalizeAppMode('staging')).toBe('production')
    expect(normalizeAppMode(undefined)).toBe('production')
  })
})

describe('resolveAppConfig', () => {
  it('devToolsAllowed = !isPackaged（打包恒 false，与 mode 无关）', () => {
    expect(resolveAppConfig('development', false).devToolsAllowed).toBe(true)
    expect(resolveAppConfig('test', false).devToolsAllowed).toBe(true)
    expect(resolveAppConfig('production', false).devToolsAllowed).toBe(true) // 未打包仍允许（开发便利）
    expect(resolveAppConfig('production', true).devToolsAllowed).toBe(false)
    expect(resolveAppConfig('development', true).devToolsAllowed).toBe(false) // --mode development 的 packaged 产物也恒关
  })
  it('env 无法把 devToolsAllowed 翻成 true（打包时）', () => {
    expect(resolveAppConfig('development', true, { CYRENE_DEVTOOLS: 'true' }).devToolsAllowed).toBe(false)
  })
  it('logLevel：打包恒 info，不读 env（任何 mode，含 --mode test packaged）', () => {
    expect(resolveAppConfig('production', true, { CYRENE_LOG_LEVEL: 'debug' }).logLevel).toBe('info')
    expect(resolveAppConfig('test', true, { CYRENE_LOG_LEVEL: 'debug' }).logLevel).toBe('info')
  })
  it('logLevel：非打包默认随 mode（prod=info，dev/test=debug），合法 env 可覆盖', () => {
    expect(resolveAppConfig('development', false).logLevel).toBe('debug')
    expect(resolveAppConfig('test', false, { CYRENE_LOG_LEVEL: 'warn' }).logLevel).toBe('warn')
    expect(resolveAppConfig('production', false, { CYRENE_LOG_LEVEL: 'warn' }).logLevel).toBe('warn')
  })
  it('logLevel：非法 env 值回退 mode 默认（无守卫类型强转）', () => {
    expect(resolveAppConfig('test', false, { CYRENE_LOG_LEVEL: 'garbage' }).logLevel).toBe('debug')
    expect(resolveAppConfig('production', false, { CYRENE_LOG_LEVEL: 'garbage' }).logLevel).toBe('info')
  })
  it('协议常量固定 cyrene/renderer', () => {
    const c = resolveAppConfig('production', true)
    expect(c.protocolName).toBe('cyrene')
    expect(c.rendererHost).toBe('renderer')
  })
})

describe('shouldUseViteDevServer', () => {
  it('未打包 + 有 ELECTRON_RENDERER_URL → true（electron-vite dev，含 --mode test）', () => {
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(true)
  })
  it('打包恒 false（残留 dev env 不能把打包产物劫持到 http/无严格 CSP）', () => {
    expect(shouldUseViteDevServer(true, { ELECTRON_RENDERER_URL: 'http://localhost:5173' })).toBe(false)
  })
  it('无 ELECTRON_RENDERER_URL → false（test/production 构建、--mode development 直启）', () => {
    expect(shouldUseViteDevServer(false, {})).toBe(false)
  })
  it('畸形/非 http 残留 env → false（走 cyrene://，不白窗不劫持）', () => {
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'http://' })).toBe(false)
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'not-a-url' })).toBe(false)
    expect(shouldUseViteDevServer(false, { ELECTRON_RENDERER_URL: 'file:///x' })).toBe(false)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm exec vitest run --config vitest.config.mts tests/unit/config-env.spec.ts`
Expected: FAIL（模块不存在 / 函数未导出）

- [ ] **Step 4: 实现**

```typescript
// apps/desktop/src/main/config/env.ts
import { PROTOCOL_SCHEME, RENDERER_HOST } from '../protocol/constants' // 纯常量，与 scheme.ts 同源，杜绝字面量双处漂移

export type AppMode = 'development' | 'test' | 'production'
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

export interface AppConfig {
  mode: AppMode
  logLevel: LogLevel
  devToolsAllowed: boolean
  protocolName: typeof PROTOCOL_SCHEME
  rendererHost: typeof RENDERER_HOST
}

export function normalizeAppMode(raw: string | undefined): AppMode {
  return raw === 'development' || raw === 'test' ? raw : 'production'
}

export function resolveAppConfig(
  mode: AppMode,
  isPackaged: boolean,
  env: Record<string, string | undefined> = {}
): AppConfig {
  // 安全不变量：打包即生产安全默认——与构建 mode / env 无关
  const devToolsAllowed = !isPackaged
  const rawLevel = env['CYRENE_LOG_LEVEL']
  const defaultLevel: LogLevel = mode === 'production' ? 'info' : 'debug'
  const logLevel: LogLevel =
    isPackaged ? 'info' : rawLevel && (LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevel) : defaultLevel
  return { mode, logLevel, devToolsAllowed, protocolName: PROTOCOL_SCHEME, rendererHost: RENDERER_HOST } // 用常量，非字面量
}

// 加载/协议注册统一谓词：纯「有无合法 Vite dev server」= 未打包 && ELECTRON_RENDERER_URL 是可解析的 http(s) URL。
// 打包恒 false——残留 dev env 不能把打包产物劫持到 http（跳过 cyrene handler + 严格 CSP）。
// 畸形/非 http 残留 env → false（走 cyrene://，不白窗）；electron-vite dev（含 --mode test）恒设合法 URL → true。
export function shouldUseViteDevServer(
  isPackaged: boolean,
  env: Record<string, string | undefined> = {}
): boolean {
  const u = env['ELECTRON_RENDERER_URL']
  if (!u || isPackaged) return false
  try {
    const parsed = new URL(u)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm exec vitest run --config vitest.config.mts tests/unit/config-env.spec.ts`
Expected: PASS（12 项）

- [ ] **Step 6: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/protocol/constants.ts src/main/config/env.ts tests/unit/config-env.spec.ts && git commit -m "feat(阶段1块A): protocol/constants 纯常量 + config/env 纯函数（AppMode/AppConfig/安全不变量）"
```

---

### Task 2: 调试开关检测纯函数（config/debug-switches.ts）

**Files:**
- Create: `apps/desktop/src/main/config/debug-switches.ts`
- Test: `apps/desktop/tests/unit/config-debug-switches.spec.ts`

**Interfaces:**
- Produces: `FORBIDDEN_DEBUG_SWITCHES`（常量，9 个：`remote-debugging-port`/`remote-debugging-pipe`/`remote-debugging-fd`/`inspect`/`inspect-brk`/`inspect-node`/`inspect-brk-node`/`inspect-wait`/`inspect-wait-node`）；`hasForbiddenDebugSwitch(argv: readonly string[], getSwitch: (name: string) => { present: boolean; value: string }, allowRandomPort?: boolean): boolean`；`hasForbiddenNodeOptions(nodeOptions: string | undefined): boolean`（NODE_OPTIONS 纯 env 通道：`--inspect` 系）
- 后续 Task 8 的 `main/index.ts` 使用它们（`process.argv` + `app.commandLine` 查询 `{present,value}`，第三个参 `allowRandomPort = process.env['CYRENE_TEST_HARNESS'] === '1'`；`hasForbiddenNodeOptions(process.env['NODE_OPTIONS'])`）

- [ ] **Step 1: 写失败测试**

```typescript
// apps/desktop/tests/unit/config-debug-switches.spec.ts
import { describe, expect, it } from 'vitest'
import { hasForbiddenDebugSwitch, hasForbiddenNodeOptions } from '../../src/main/config/debug-switches'

const none = (): { present: boolean; value: string } => ({ present: false, value: '' })
// 模拟 commandLine：present=开关已注入；value=getSwitchValue（''=裸开关/未注入）
const sw = (name: string, value: string): { present: boolean; value: string } => ({ present: true, value })

describe('hasForbiddenDebugSwitch', () => {
  it('无调试开关 → false', () => {
    expect(hasForbiddenDebugSwitch(['/usr/bin/electron', '.'], none)).toBe(false)
  })
  it('显式端口 --remote-debugging-port=9222 → true（默认与 harness 都拒绝）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=9222'], none)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=9222'], none, true)).toBe(true)
  })
  it('裸 --remote-debugging-port（默认 9222）→ true', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port'], none)).toBe(true)
  })
  it('默认（生产）拒绝 --remote-debugging-port=0（doc 07 任何构建不得开放调试端口）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=0'], none)).toBe(true)
  })
  it('测试 harness（allowRandomPort=true）放行 =0 随机端口', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-port=0'], none, true)).toBe(false)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect=0'], none, true)).toBe(false)
  })
  it('--inspect-brk / --inspect-node / --inspect-brk-node / --inspect-wait / --inspect-wait-node / --remote-debugging-fd → 恒 true（harness 也不放行）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-brk=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-node=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-brk-node=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-wait=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--inspect-wait-node=9229'], none, true)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-fd=3'], none, true)).toBe(true)
  })
  it('--remote-debugging-pipe：生产拒，harness 放行（未来 Playwright 可能切 pipe 通道）', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-pipe'], none)).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '--remote-debugging-pipe'], none, true)).toBe(false)
  })
  it('commandLine 注入：value=9222 拒；value=0 仅 harness 放行', () => {
    expect(hasForbiddenDebugSwitch(['electron', '.'], (n) => (n === 'remote-debugging-port' ? sw(n, '9222') : none()))).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '.'], (n) => (n === 'remote-debugging-port' ? sw(n, '0') : none()))).toBe(true)
    expect(hasForbiddenDebugSwitch(['electron', '.'], (n) => (n === 'remote-debugging-port' ? sw(n, '0') : none()), true)).toBe(false)
  })
  it('-- 分隔符后为应用参数，非 Chromium 开关 → 不误杀', () => {
    expect(hasForbiddenDebugSwitch(['electron', '--', '--inspect=9229'], none)).toBe(false)
  })
})

describe('hasForbiddenNodeOptions', () => {
  it('无 NODE_OPTIONS / 不含调试 → false', () => {
    expect(hasForbiddenNodeOptions(undefined)).toBe(false)
    expect(hasForbiddenNodeOptions('--max-old-space-size=4096')).toBe(false)
  })
  it('NODE_OPTIONS=--inspect 系（inspect/inspect-brk/inspect-node/inspect-brk-node/inspect-wait）→ true（单 env 即开 Node inspector）', () => {
    expect(hasForbiddenNodeOptions('--inspect=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--inspect-brk=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--inspect-node=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--max-old-space-size=4096 --inspect-brk-node=9229')).toBe(true)
    expect(hasForbiddenNodeOptions('--inspect-wait=9229')).toBe(true)
  })
  it('--inspect-port 单独（不开 inspector，仅配合 --inspect 用）→ false；路径含子串 → false', () => {
    expect(hasForbiddenNodeOptions('--inspect-port=0')).toBe(false)
    expect(hasForbiddenNodeOptions('--require /opt/tools/--inspect-helper.js')).toBe(false)
    expect(hasForbiddenNodeOptions('--max-old-space-size=4096')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm exec vitest run --config vitest.config.mts tests/unit/config-debug-switches.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// apps/desktop/src/main/config/debug-switches.ts
export const FORBIDDEN_DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-fd',
  'inspect',
  'inspect-brk',
  'inspect-node',
  'inspect-brk-node',
  'inspect-wait', // Node 22：固定端口开 inspector 并等待（同 brk 危害）
  'inspect-wait-node'
] as const

// 允许 =0 的开关：Playwright _electron 控制通道注入 --inspect=0 / --remote-debugging-port=0（随机端口）。
// 默认（allowRandomPort=false）连 =0 也拒绝——doc 07「任何构建都不得开放远程调试端口」；
// 仅测试 harness（verify:artifact 冒烟显式设 CYRENE_TEST_HARNESS=1）放行 =0 随机端口。
const RANDOM_PORT_ONLY = new Set(['remote-debugging-port', 'inspect'])

// getSwitch(name)：commandLine 查询（{ present: hasSwitch(name), value: getSwitchValue(name) }）
export function hasForbiddenDebugSwitch(
  argv: readonly string[],
  getSwitch: (name: string) => { present: boolean; value: string },
  allowRandomPort = false
): boolean {
  const forbidden = (name: string, value: string | null): boolean => {
    // 注：空格分隔形式（`--remote-debugging-port 0`）在 argv 扫描中 value=null 判为裸开关 → 保守拒绝（harness 也不放行）。
    // Playwright 注入的是 `=0` 等号形式（已验证）；空格形式不属测试 harness 场景。
    // brk/wait 变体与 fd 通道恒拒绝（Playwright 不注入）
    if (name === 'inspect-brk' || name === 'inspect-node' || name === 'inspect-brk-node' || name === 'inspect-wait' || name === 'inspect-wait-node' || name === 'remote-debugging-fd') return true
    if (name === 'remote-debugging-pipe') return !allowRandomPort // pipe 仅 harness 放行（未来 Playwright 可能切 pipe 通道）
    if (RANDOM_PORT_ONLY.has(name)) {
      if (value === '0') return !allowRandomPort // =0 仅测试 harness 放行
      return true // 裸开关（null）与显式端口都拒绝
    }
    return false
  }
  // 1) argv 同步扫描；遇 `--` 分隔符停止——其后 token 属应用参数，非 Chromium 开关
  for (const a of argv) {
    if (a === '--') break
    if (!a.startsWith('--')) continue
    const body = a.slice(2)
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    const value = eq >= 0 ? body.slice(eq + 1) : null
    if (forbidden(name, value)) return true
  }
  // 2) commandLine 兜底（argv 不含但开关已注入）
  for (const name of FORBIDDEN_DEBUG_SWITCHES) {
    const s = getSwitch(name)
    if (s.present && forbidden(name, s.value === '' ? null : s.value)) return true
  }
  return false
}

// NODE_OPTIONS 纯 env 通道：Electron main 是 Node，NODE_OPTIONS=--inspect 即可开 inspector，
// 而 argv/commandLine 均不含它——门必须单独查。打包下含 inspect 系一律拒绝。
// 正则锚定选项边界（^ 或空白后跟 --inspect...，后随 =值/空白/结尾），避免误伤路径/参数中的 `--inspect` 子串；
// 匹配 --inspect/--inspect-brk/--inspect-node/--inspect-brk-node（--inspect-port 单独不开 inspector，不匹配）。
// 诚实限制：`--inspect-brk` 会在 Node 引导期、任何应用 JS（含本门）运行前暂停——进程内无法拦截，
// 属固有限制（记录 spec G-7；阶段 8 Electron Fuses 评估关闭 Node inspector 通道）。
export function hasForbiddenNodeOptions(nodeOptions: string | undefined): boolean {
  if (!nodeOptions) return false
  return /(^|\s)--inspect(?:-brk|-node|-brk-node|-wait|-wait-node)?(?=\s|=|$)/.test(nodeOptions)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上命令
Expected: PASS（12 项）

- [ ] **Step 5: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/config/debug-switches.ts tests/unit/config-debug-switches.spec.ts && git commit -m "feat(阶段1块A): config/debug-switches 四类调试开关检测纯函数"
```

---

### Task 3: 协议路径解析纯函数（protocol/path.ts）

**Files:**
- Create: `apps/desktop/src/main/protocol/path.ts`
- Test: `apps/desktop/tests/unit/protocol-path.spec.ts`

**Interfaces:**
- Produces: `resolveRendererPath(rendererRoot: string, pathname: string): string | null`（解码一次 → NUL/`..` 段拒绝 → `'.'+rel` 归一根相对 + relative() 首段边界 → 返回渲染根内绝对路径；空 pathname 返回 rendererRoot 本身）
- 后续 Task 7 的 `protocol/handler.ts` 使用它

- [ ] **Step 1: 写失败测试**

```typescript
// apps/desktop/tests/unit/protocol-path.spec.ts
import { describe, expect, it } from 'vitest'
import { resolveRendererPath } from '../../src/main/protocol/path'

const ROOT = '/opt/cyrene/renderer'

describe('resolveRendererPath', () => {
  it('合法相对路径 → 渲染根内绝对路径', () => {
    expect(resolveRendererPath(ROOT, '/index.html')).toBe('/opt/cyrene/renderer/index.html')
    expect(resolveRendererPath(ROOT, '/assets/app.js')).toBe('/opt/cyrene/renderer/assets/app.js')
  })
  it('空 pathname（/）→ 渲染根本身（目录由 handler 映射 index.html）', () => {
    expect(resolveRendererPath(ROOT, '/')).toBe(ROOT)
    expect(resolveRendererPath(ROOT, '')).toBe(ROOT)
  })
  it('含 .. 段 → null', () => {
    expect(resolveRendererPath(ROOT, '/../etc/passwd')).toBeNull()
    expect(resolveRendererPath(ROOT, '/assets/../../etc/passwd')).toBeNull()
  })
  it('双重解码 %2e%2e → null（decode 后成 .. 段）', () => {
    expect(resolveRendererPath(ROOT, '/%2e%2e/etc/passwd')).toBeNull()
  })
  it('NUL 字节 → null', () => {
    expect(resolveRendererPath(ROOT, '/a%00b')).toBeNull()
  })
  it('孤立 % → null（decodeURIComponent 抛）', () => {
    expect(resolveRendererPath(ROOT, '/a%')).toBeNull()
  })
  it('任何 .. 段即使留在根内也拒绝（保守，不做路径归一放行）', () => {
    expect(resolveRendererPath(ROOT, '/assets/../index.html')).toBeNull()
  })
  it('containment 契约：候选恒经 relative() 判定，结构性免疫字符串前缀陷阱', () => {
    // '.' 前置 + relative()：/.. 段被显式拒；深路径仍限根内。
    // 字符串前缀包含（startsWith(root)）会误放行 renderer2 兄弟目录——本实现用 relative() 边界，
    // 该陷阱无可触发的 API 输入（从根只能向下），故用契约测试锚定语义，防未来重构改回字符串前缀比较。
    expect(resolveRendererPath(ROOT, '/deep/nested/asset.js')).toBe('/opt/cyrene/renderer/deep/nested/asset.js')
    expect(resolveRendererPath(ROOT, '/a/../../b')).toBeNull()
  })
  it('根内 .. 前缀条目（如 ..hidden）不被误杀', () => {
    expect(resolveRendererPath(ROOT, '/..hidden/asset.js')).toBe('/opt/cyrene/renderer/..hidden/asset.js')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm exec vitest run --config vitest.config.mts tests/unit/protocol-path.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// apps/desktop/src/main/protocol/path.ts
import { isAbsolute, relative, resolve, sep } from 'path'

// 返回渲染根内绝对路径；非法（穿越/NUL/畸形百分比/双重解码）→ null。
// 注：URL pathname 恒以 '/' 开头，经 `'.' + rel` 归一为根相对（非"拒绝绝对路径"——
// '/' 前缀本就语义是根相对，真实越界由下面的 relative() 首段边界兜住）。
export function resolveRendererPath(rendererRoot: string, pathname: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null // 孤立 % → 拒绝
  }
  if (rel.includes('\0')) return null // NUL 显式拒绝（不进 fs 层）
  const segs = rel.split('/')
  if (segs.some((s) => s === '..')) return null // 双重解码（%2e%2e）decode 后同样被此拒
  const candidate = resolve(rendererRoot, '.' + rel) // 前置 '.' → 相对；空 pathname → 渲染根
  const relToRoot = relative(rendererRoot, candidate)
  // 首段恰为 '..' 才算越界（字符串 startsWith('..') 会误杀根内 '..hidden' 等合法条目）
  const first = relToRoot.split(sep)[0]
  if (first === '..' || isAbsolute(relToRoot)) return null
  return candidate
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上命令
Expected: PASS（9 项）

- [ ] **Step 5: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/protocol/path.ts tests/unit/protocol-path.spec.ts && git commit -m "feat(阶段1块A): protocol/path 渲染根路径解析纯函数（穿越/NUL/双重解码拒绝）"
```

---

### Task 4: CSP 纯函数（protocol/csp.ts）

**Files:**
- Create: `apps/desktop/src/main/protocol/csp.ts`
- Test: `apps/desktop/tests/unit/protocol-csp.spec.ts`

**Interfaces:**
- Produces: `buildRendererCsp(): string`
- 后续 Task 7 的 `protocol/handler.ts` 在响应头注入它

- [ ] **Step 1: 写失败测试**

```typescript
// apps/desktop/tests/unit/protocol-csp.spec.ts
import { describe, expect, it } from 'vitest'
import { buildRendererCsp } from '../../src/main/protocol/csp'

describe('buildRendererCsp', () => {
  const csp = buildRendererCsp()
  it('含 frame-src 无来源（收口 iframe G-6）', () => {
    expect(csp).toContain("frame-src 'none'")
  })
  it('不含 unsafe-eval / unsafe-inline', () => {
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('unsafe-inline')
  })
  it('脚本仅 self', () => {
    expect(csp).toContain("script-src 'self'")
  })
  it('default-src none + object-src none', () => {
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("object-src 'none'")
  })
  it('connect-src 仅 self（renderer 不直连后端）', () => {
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('ws:')
  })
  it('font-src 含 data:（Vite 内联字体放行）', () => {
    expect(csp).toContain("font-src 'self' data:")
  })
  it('prod 有效策略锚定（meta ∩ 响应头 AND）：meta 的 blob:/ws:/unsafe-inline 在严格头中被剔除', () => {
    // 响应头与保留的宽松 meta 取交集 = 严格头（blob:/ws:/unsafe-inline 均被剔除）。
    // 阶段 3 若需 blob: 图片预览，须在此显式放行（改响应头 + 本测试），勿静默。
    expect(csp).not.toContain('blob:')
    expect(csp).not.toContain('ws:')
    expect(csp).not.toContain('unsafe-inline')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm exec vitest run --config vitest.config.mts tests/unit/protocol-csp.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// apps/desktop/src/main/protocol/csp.ts
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

- [ ] **Step 4: 运行测试确认通过**

Run: 同上命令
Expected: PASS（7 项）

- [ ] **Step 5: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/protocol/csp.ts tests/unit/protocol-csp.spec.ts && git commit -m "feat(阶段1块A): protocol/csp 严格 CSP 纯函数（无 unsafe-eval、frame-src none）"
```

---

### Task 5: MIME 映射纯函数（protocol/mime.ts）

**Files:**
- Create: `apps/desktop/src/main/protocol/mime.ts`
- Test: `apps/desktop/tests/unit/protocol-mime.spec.ts`

**Interfaces:**
- Produces: `mimeOf(p: string): string | null`（扩展名 map 命中返回 MIME；未命中返回 null）
- 后续 Task 7 的 `protocol/handler.ts` 使用它（仅命中才覆盖 Content-Type）

- [ ] **Step 1: 写失败测试**

```typescript
// apps/desktop/tests/unit/protocol-mime.spec.ts
import { describe, expect, it } from 'vitest'
import { mimeOf } from '../../src/main/protocol/mime'

describe('mimeOf', () => {
  it('常见扩展名命中', () => {
    expect(mimeOf('/assets/index.html')).toContain('text/html')
    expect(mimeOf('/assets/app-abc123.js')).toContain('javascript')
    expect(mimeOf('/assets/style.css')).toContain('text/css')
    expect(mimeOf('/assets/logo.svg')).toContain('image/svg')
  })
  it('大小写不敏感', () => {
    expect(mimeOf('/assets/APP.JS')).toContain('javascript')
  })
  it('未命中 → null（保留 net.fetch 推断，不无条件覆盖）', () => {
    expect(mimeOf('/assets/data.bin')).toBeNull()
    expect(mimeOf('/assets/noext')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm exec vitest run --config vitest.config.mts tests/unit/protocol-mime.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// apps/desktop/src/main/protocol/mime.ts
const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json'
}

export function mimeOf(p: string): string | null {
  const idx = p.lastIndexOf('.')
  if (idx < 0) return null
  return MIME_MAP[p.slice(idx).toLowerCase()] ?? null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上命令
Expected: PASS（3 项）

- [ ] **Step 5: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/protocol/mime.ts tests/unit/protocol-mime.spec.ts && git commit -m "feat(阶段1块A): protocol/mime 扩展名 MIME 映射（未命中返回 null）"
```

---

### Task 6: 构建接线（electron.vite.config 函数式 + env.d.ts + config/index.ts）

**Files:**
- Modify: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main/env.d.ts`
- Create: `apps/desktop/src/main/config/index.ts`

**Interfaces:**
- Consumes: `normalizeAppMode` / `resolveAppConfig`（Task 1）
- Produces: `getAppConfig(): AppConfig`（读 `__APP_MODE__` + `app.isPackaged` + `process.env`）
- 后续 Task 8/9 使用 `getAppConfig()`

- [ ] **Step 1: 实现 electron.vite.config.ts（函数式 + define）**

```typescript
// apps/desktop/electron.vite.config.ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __APP_MODE__: JSON.stringify(mode) }, // CJS main 文本替换，可靠
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [vue()],
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') } }
  }
}))
```
> **CSP 交付（保留 meta + 响应头 AND，不剥离）**：index.html 保留 Phase 0 宽松 meta（含 `style-src 'unsafe-inline'`、`ws:`、`blob:`），**真实用途是 dev（electron-vite dev）http 场景的 CSP**；prod 与 `pnpm start`（electron-vite preview 不设 `ELECTRON_RENDERER_URL` → 走 cyrene://）都由 protocol 响应头严格 CSP 覆盖，两者 AND 取交集 → 严格头胜出（meta 残留不会放宽 prod）。**AND 耦合（改 dev meta 会静默改变 prod 有效策略）记为已知限制**（spec §10 G-9），不剥离——dev http 需要 meta，剥离会令 dev 零 CSP。

- [ ] **Step 2: 创建 src/main/env.d.ts**

```typescript
// apps/desktop/src/main/env.d.ts
declare const __APP_MODE__: string // electron.vite.config 的 define 注入
```

- [ ] **Step 3: 创建 src/main/config/index.ts**

```typescript
// apps/desktop/src/main/config/index.ts
import { app } from 'electron'
import { normalizeAppMode, resolveAppConfig, shouldUseViteDevServer } from './env'
import type { AppConfig } from './env'

// __APP_MODE__ 全局声明在 src/main/env.d.ts（tsconfig.node.json 的 src/main/**/* 覆盖），此处不再重复 declare

export { shouldUseViteDevServer } // 主装配/主窗口共用「有无 Vite dev server」谓词

export function getAppConfig(): AppConfig {
  // 不信任 process.env.NODE_ENV：缺失/未知 __APP_MODE__ 一律归 production（fail-safe）
  const raw = typeof __APP_MODE__ !== 'undefined' ? __APP_MODE__ : 'production'
  return resolveAppConfig(normalizeAppMode(raw), app.isPackaged, process.env)
}
```

- [ ] **Step 4: typecheck 验证**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck`
Expected: PASS（`__APP_MODE__` 声明生效、函数式 config 类型正确）

- [ ] **Step 5: 构建验证（prod + 确认 index.html 保留 CSP meta 且无 unsafe-eval）**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm build && grep -c "Content-Security-Policy" out/renderer/index.html`
Expected: build PASS；grep 输出 1（prod 产物保留宽松 meta——供 preview http 兜底，严格 CSP 由 cyrene:// 响应头 AND 收紧）；`grep -c "unsafe-eval" out/renderer/index.html` 输出 0

- [ ] **Step 6: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add electron.vite.config.ts src/main/env.d.ts src/main/config/index.ts && git commit -m "feat(阶段1块A): __APP_MODE__ 烘焙 + getAppConfig + shouldUseViteDevServer（CSP meta 保留，prod 响应头 AND 收紧）"
```

---

### Task 7: 协议注册（protocol/scheme.ts + handler.ts）

**Files:**
- Create: `apps/desktop/src/main/protocol/scheme.ts`（constants.ts 已在 Task 1 创建）
- Create: `apps/desktop/src/main/protocol/handler.ts`
- Create: `apps/desktop/src/main/protocol/README.md`

**Interfaces:**
- Consumes: `resolveRendererPath`（Task 3）、`buildRendererCsp`（Task 4）、`mimeOf`（Task 5）
- Produces: `PROTOCOL_SCHEME = 'cyrene'` / `RENDERER_HOST = 'renderer'`；`registerCyreneScheme(): void`（app ready 前调用）；`registerCyreneProtocolHandler(rendererRoot: string): Promise<void>`（whenReady 内 await 调用，注册时 realpath 渲染根一次）

- [ ] **Step 1: 创建 src/main/protocol/scheme.ts（constants.ts 已在 Task 1 创建）**

```typescript
// apps/desktop/src/main/protocol/scheme.ts
import { protocol } from 'electron'
import { PROTOCOL_SCHEME } from './constants'

export { PROTOCOL_SCHEME, RENDERER_HOST } from './constants' // 从 constants 再导出，保持既有引用路径

// 必须在 app ready 前调用（main() 最前）
export function registerCyreneScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false,
        bypassCSP: false
      }
    }
  ])
}
```

- [ ] **Step 2: 创建 src/main/protocol/handler.ts**

```typescript
// apps/desktop/src/main/protocol/handler.ts
import { net, protocol } from 'electron'
import { realpath, stat } from 'fs/promises'
import { join, sep } from 'path'
import { pathToFileURL } from 'url'
import { PROTOCOL_SCHEME, RENDERER_HOST } from './scheme'
import { resolveRendererPath } from './path'
import { buildRendererCsp } from './csp'
import { mimeOf } from './mime'

const RENDERER_CSP = buildRendererCsp() // 模块级常量：全进程 CSP 头值恒定，不在每个请求重建

export async function registerCyreneProtocolHandler(rendererRoot: string): Promise<void> {
  const realRoot = await realpath(rendererRoot) // 注册时解析一次（渲染根固定），不在每个请求重算
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const rootLower = lower(realRoot)
  const rootPrefix = rootLower + sep
  protocol.handle(PROTOCOL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
    if (url.host !== RENDERER_HOST) return new Response('Not Found', { status: 404 })
    const candidate = resolveRendererPath(rendererRoot, url.pathname)
    if (!candidate) return new Response('Forbidden', { status: 403 })
    // realpath 包含性（symlink 逃逸防线）：仅对请求路径做一次 realpath
    let realCand: string
    try {
      realCand = await realpath(candidate)
    } catch {
      return new Response('Not Found', { status: 404 })
    }
    const inside = lower(realCand) === rootLower || lower(realCand).startsWith(rootPrefix)
    if (!inside) return new Response('Forbidden', { status: 403 })
    // 目录 → index.html：对 join 出的 index.html 再做 realpath + 包含性（防目录内 index.html 为 symlink 逃逸）
    let target = realCand
    const st = await stat(target).catch(() => null)
    if (st && st.isDirectory()) {
      const idxPath = join(realCand, 'index.html')
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
    try {
      const res = await net.fetch(pathToFileURL(target).toString())
      const headers = new Headers(res.headers)
      const mime = mimeOf(target)
      if (mime) headers.set('Content-Type', mime)
      headers.set('Content-Security-Policy', RENDERER_CSP)
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
```

- [ ] **Step 3: 创建 src/main/protocol/README.md**

```markdown
# protocol — cyrene:// 受限自定义协议

- `scheme.ts`：`registerCyreneScheme()` 特权注册，必须在 app ready 前调用；
- `path.ts`：`resolveRendererPath` 纯函数（解码/穿越/NUL/双重解码拒绝）；
- `csp.ts`：`buildRendererCsp` 严格 CSP（无 unsafe-eval、frame-src none）；
- `mime.ts`：`mimeOf` 扩展名 MIME 映射（未命中返回 null）；
- `handler.ts`：`registerCyreneProtocolHandler` 只读服务渲染根，fail-closed；
- 附件/媒体协议服务延到阶段 3；仅服务渲染根，不映射任意磁盘。
```

- [ ] **Step 4: typecheck + build 验证**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck && cd apps/desktop && pnpm build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/protocol/scheme.ts src/main/protocol/handler.ts src/main/protocol/README.md && git commit -m "feat(阶段1块A): cyrene:// 特权注册 + protocol.handle 只读服务渲染根"
```

---

### Task 8: 主进程装配（main/index.ts）

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `hasForbiddenDebugSwitch`（Task 2）、`registerCyreneScheme`/`registerCyreneProtocolHandler`（Task 7）、`getAppConfig`（Task 6）
- 保持既有 `installAppIdentity`/`expectedUserDataBase`/`ensureUserDataDirs`/`registerHandlers`/`ensureMainWindow`/`focusOrDefer`/`markAppStarted`/`failStart` 不变

- [ ] **Step 1: 改造 main/index.ts（完整文件）**

```typescript
// apps/desktop/src/main/index.ts
import { app, dialog, Menu } from 'electron'
import { join } from 'path'
import { installAppIdentity, expectedUserDataBase } from './app/lifecycle'
import { ensureUserDataDirs, UserDataDirError } from './persistence/user-data-dirs'
import { registerHandlers } from './ipc/handlers'
import { ensureMainWindow, focusOrDefer, markAppStarted } from './windows/main-window'
import { hasForbiddenDebugSwitch, hasForbiddenNodeOptions } from './config/debug-switches'
import { getAppConfig, shouldUseViteDevServer } from './config'
import { registerCyreneScheme, registerCyreneProtocolHandler } from './protocol'

function failStart(message: string): void {
  dialog.showErrorBox('Cyrene 无法启动', message)
  app.exit(1)
}

// 打包：移除 DevTools 加速键。macOS 用最小菜单保留 Cmd+Q/Cmd+C/V（appMenu/editMenu/windowMenu 不含 View→DevTools）；
// 其余平台 null 即可。
function applyProductionMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }
}

// main() 最前：Chromium 的 CDP 端口在 whenReady 前已绑定，门必须同步生效。
// 命中即 failStart + 返回 true，main() 检测后停止后续执行（不落到 scheme/身份副作用）。
function rejectForbiddenDebugSwitches(): boolean {
  const getSwitch = (n: string): { present: boolean; value: string } => ({
    present: app.commandLine.hasSwitch(n),
    value: app.commandLine.getSwitchValue(n)
  })
  // 仅测试 harness（verify:artifact 冒烟显式设 CYRENE_TEST_HARNESS=1）放行 =0 随机端口；生产默认严格拒绝
  const allowRandomPort = process.env['CYRENE_TEST_HARNESS'] === '1'
  if (app.isPackaged && hasForbiddenDebugSwitch(process.argv, getSwitch, allowRandomPort)) {
    failStart('远程调试/调试开关在发布构建中被禁用')
    return true
  }
  // NODE_OPTIONS 纯 env 通道（argv/commandLine 均不含它）：Electron main 是 Node，单 env 即开 inspector
  if (app.isPackaged && hasForbiddenNodeOptions(process.env['NODE_OPTIONS'])) {
    failStart('NODE_OPTIONS 含调试开关在发布构建中被禁用')
    return true
  }
  return false
}

async function main(): Promise<void> {
  if (rejectForbiddenDebugSwitches()) return
  registerCyreneScheme() // app ready 前

  let ident
  try {
    ident = installAppIdentity()
  } catch (e) {
    failStart(e instanceof Error ? e.message : '未知错误')
    return
  }
  const { baseCreated, setPathOk } = ident

  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }
  app.on('second-instance', () => focusOrDefer())

  await app.whenReady()

  try {
    app.setAppUserModelId('com.cyrene.desktop')
    if (!setPathOk) {
      failStart(`userData 目录不可用：${expectedUserDataBase()}（请检查是否为普通文件或符号链接）`)
      return
    }
    // 防御纵深断言（地基同款）：setPath 后实际 userData 必须等于预期路径，防未来重构/身份顺序变化漂移
    if (app.getPath('userData') !== expectedUserDataBase()) {
      failStart(`userData 路径异常：${app.getPath('userData')}（预期 ${expectedUserDataBase()}）`)
      return
    }
    const config = getAppConfig()
    if (!config.devToolsAllowed) applyProductionMenu() // 打包：无 View→DevTools 加速键（mac 保 Cmd+Q/C/V）
    await ensureUserDataDirs(expectedUserDataBase(), { baseCreated })
    registerHandlers()
    // 协议 handler 在「无 Vite dev server」场景注册（shouldUseViteDevServer = 未打包 && 有 ELECTRON_RENDERER_URL）：
    // dev（electron-vite dev，含 --mode test）→ 走 http 且不产出 out/renderer → 不注册；
    // 其余（打包、test/production 构建、--mode development 直启）→ shouldUseViteDevServer=false → 必须注册，
    // 否则 loadURL 落 cyrene:// 而 handler 缺失 → 404 空白窗。
    if (!shouldUseViteDevServer(app.isPackaged, process.env)) {
      await registerCyreneProtocolHandler(join(__dirname, '../renderer'))
    }
    markAppStarted()
    ensureMainWindow()
  } catch (e) {
    failStart(e instanceof UserDataDirError ? e.message : `启动失败：${e instanceof Error ? e.message : '未知错误'}`)
  }

  app.on('activate', () => focusOrDefer())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

void main().catch((e) => {
  dialog.showErrorBox('Cyrene 无法启动', e instanceof Error ? e.message : '未知错误')
  app.exit(1)
})
```

- [ ] **Step 2: 创建 src/main/protocol/index.ts（barrel）**

```typescript
// apps/desktop/src/main/protocol/index.ts
export { PROTOCOL_SCHEME, RENDERER_HOST, registerCyreneScheme } from './scheme'
export { registerCyreneProtocolHandler } from './handler'
```

- [ ] **Step 3: typecheck + build 验证**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck && cd apps/desktop && pnpm build`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/index.ts src/main/protocol/index.ts && git commit -m "feat(阶段1块A): 主进程装配（远程调试门/特权注册/菜单移除/协议接线）"
```

---

### Task 9: 主窗口改造 + 导航判定纯函数（windows/navigation.ts + main-window.ts）

**Files:**
- Create: `apps/desktop/src/main/windows/navigation.ts`（纯函数：`sameOrigin` + `classifyNavigation`，无 electron import）
- Create: `apps/desktop/tests/unit/navigation.spec.ts`
- Modify: `apps/desktop/src/main/windows/main-window.ts`（import classifyNavigation，删除本地定义）

**Interfaces:**
- Consumes: `getAppConfig`/`shouldUseViteDevServer`（Task 6）、`RENDERER_HOST`（Task 7 protocol/constants）
- Produces: `classifyNavigation(targetUrl: string, devOrigin: URL | undefined, usingDevServer: boolean): 'app' | 'external' | 'deny'`；`sameOrigin(a: URL, b: URL): boolean`
- 保持 `ensureMainWindow`/`focusOrDefer`/`markAppStarted`/`setMainWindow`/`getMainWindow` 对外签名不变

- [ ] **Step 1: 创建 src/main/windows/navigation.ts（安全关键纯函数，可单测；冒烟不触发 will-navigate，必须有单测覆盖）**

```typescript
// apps/desktop/src/main/windows/navigation.ts
import { RENDERER_HOST } from '../protocol/constants'

export function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host
}

// 'app' → 应用自身导航；'external' → 系统浏览器；其余 deny（fail-closed）
// devOrigin / usingDevServer 由 createMainWindow 解析一次传入（启动后恒定，不在每次导航重算）。
// usingDevServer = shouldUseViteDevServer（未打包 && 有 ELECTRON_RENDERER_URL）：无 dev server（test/production 构建、
// --mode development 直启、打包）都是 cyrene:// 形态——导航谓词与加载谓词同源，避免直启加载 cyrene:// 但导航被 deny。
// 已知怪癖：dev 下以 127.0.0.1 别名访问同一 Vite 服务（localhost）会被判 external 走系统浏览器（host 含端口比较），dev 独有、可接受。
export function classifyNavigation(
  targetUrl: string,
  devOrigin: URL | undefined,
  usingDevServer: boolean
): 'app' | 'external' | 'deny' {
  try {
    const url = new URL(targetUrl)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (usingDevServer && devOrigin && sameOrigin(url, devOrigin)) {
        // dev 同源：@fs/@vite 文件代理前缀拒绝（先解码 pathname，防 %40fs 编码绕过；不开外部浏览器）
        let decodedPath = url.pathname
        try { decodedPath = decodeURIComponent(url.pathname) } catch { /* 畸形编码按原样 */ }
        return decodedPath.startsWith('/@fs/') || decodedPath.startsWith('/@vite/') ? 'deny' : 'app'
      }
      return 'external'
    }
    if (!usingDevServer && url.protocol === 'cyrene:' && url.host === RENDERER_HOST) {
      return 'app' // 路径包含性已由 protocol handler 强制（handler 对越界 403）
    }
    return 'deny'
  } catch {
    return 'deny'
  }
}
```

- [ ] **Step 2: 创建 tests/unit/navigation.spec.ts（导航门单测——冒烟不触发 will-navigate，这是唯一验证）**

```typescript
// apps/desktop/tests/unit/navigation.spec.ts
import { describe, expect, it } from 'vitest'
import { classifyNavigation, sameOrigin } from '../../src/main/windows/navigation'

const dev = new URL('http://localhost:5173')

describe('sameOrigin', () => {
  it('protocol+host（含端口）相等 → true', () => {
    expect(sameOrigin(new URL('http://localhost:5173/x'), dev)).toBe(true)
  })
  it('端口不同 → false', () => {
    expect(sameOrigin(new URL('http://localhost:5174/x'), dev)).toBe(false)
  })
})

describe('classifyNavigation', () => {
  it('非 dev server：cyrene://renderer/* → app', () => {
    expect(classifyNavigation('cyrene://renderer/index.html', undefined, false)).toBe('app')
    expect(classifyNavigation('cyrene://renderer/assets/app.js', undefined, false)).toBe('app')
  })
  it('非 dev server：cyrene 但 host 错 → deny', () => {
    expect(classifyNavigation('cyrene://evil/index.html', undefined, false)).toBe('deny')
  })
  it('非 dev server：file:/其他 → deny（file: 不再放行）', () => {
    expect(classifyNavigation('file:///etc/passwd', undefined, false)).toBe('deny')
    expect(classifyNavigation('javascript:alert(1)', undefined, false)).toBe('deny')
  })
  it('非 dev server：外部 http/https → external', () => {
    expect(classifyNavigation('https://example.com/x', undefined, false)).toBe('external')
  })
  it('dev server 同源非 @fs/@vite → app', () => {
    expect(classifyNavigation('http://localhost:5173/src/App.vue', dev, true)).toBe('app')
  })
  it('dev server 同源 @fs/@vite 前缀 → deny（不开外部浏览器）；%40fs 编码绕过也 deny', () => {
    expect(classifyNavigation('http://localhost:5173/@fs/home/user/secret', dev, true)).toBe('deny')
    expect(classifyNavigation('http://localhost:5173/@vite/client', dev, true)).toBe('deny')
    expect(classifyNavigation('http://localhost:5173/%40fs/home/user/secret', dev, true)).toBe('deny')
  })
  it('dev server 跨源 http → external', () => {
    expect(classifyNavigation('http://localhost:5174/x', dev, true)).toBe('external')
  })
  it('畸形 URL → deny（fail-closed）', () => {
    expect(classifyNavigation('not a url', dev, true)).toBe('deny')
  })
})
```

- [ ] **Step 3: 运行导航单测确认通过**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm exec vitest run --config vitest.config.mts tests/unit/navigation.spec.ts`
Expected: PASS（10 项）

- [ ] **Step 4: 改造 main-window.ts（导入 classifyNavigation，删除本地 sameOrigin/classifyNavigation 定义）**

```typescript
// apps/desktop/src/main/windows/main-window.ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { getMainWindow, setMainWindow } from '../ipc/registry'
import { getAppConfig, shouldUseViteDevServer } from '../config'
import { PROTOCOL_SCHEME, RENDERER_HOST } from '../protocol'
import { classifyNavigation } from './navigation'

let pendingFocus = false
let appStarted = false
function setPendingFocus(): void { pendingFocus = true }
function consumePendingFocus(): boolean { const p = pendingFocus; pendingFocus = false; return p }
export function markAppStarted(): void { appStarted = true }

export function createMainWindow(): void {
  const config = getAppConfig()
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  // 加载/导航统一谓词（shouldUseViteDevServer = 未打包 && 有 dev server）：
  // dev（electron-vite dev，含 --mode test）→ http；打包恒 cyrene://（残留 dev env 无法劫持）；
  // 无 dev server（test/production 构建、--mode development 直启）→ cyrene://。
  const usingDevServer = shouldUseViteDevServer(app.isPackaged, process.env)
  // devOrigin 仅在 usingDevServer 下解析，且 try/catch——打包/残留畸形 ELECTRON_RENDERER_URL 不崩建窗（导航门 deny 兜底）
  let devOrigin: URL | undefined
  if (usingDevServer && devUrl) {
    try { devOrigin = new URL(devUrl) } catch { devOrigin = undefined }
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 736,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#181e29',
    title: 'Cyrene',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: config.devToolsAllowed // BrowserWindow 层封死 DevTools：打包恒 false（Electron 安全检查清单项）
    }
  })
  setMainWindow(win)

  let shown = false
  const showOnce = (): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    win.show()
  }
  win.on('ready-to-show', () => { showOnce() })
  win.on('closed', () => { if (getMainWindow() === win) setMainWindow(null) })
  const t = setTimeout(showOnce, 5000)
  win.on('ready-to-show', () => clearTimeout(t))
  win.on('closed', () => clearTimeout(t))

  win.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http:') || details.url.startsWith('https:')) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault() // 默认 deny
    const kind = classifyNavigation(url, devOrigin, usingDevServer)
    if (kind === 'app') { win.loadURL(url).catch(() => { /* fail-closed */ }); return }
    if (kind === 'external') { shell.openExternal(url).catch(() => { /* 系统浏览器拒绝时吞掉，fail-closed */ }); return }
    // deny（preventDefault 已调）
  })

  if (config.devToolsAllowed) {
    win.webContents.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools()
    })
  }

  if (usingDevServer && devUrl) {
    win.loadURL(devUrl).catch((err) => { console.error('[main] dev server 加载失败', err) })
  } else {
    // 打包/直启 cyrene://：失败必须留诊断（handler 缺失→404 空白窗，本块无日志模块先 console.error，块 B 建 logger 后换）
    win.loadURL(`${PROTOCOL_SCHEME}://${RENDERER_HOST}/index.html`).catch((err) => { console.error('[main] cyrene:// 渲染器加载失败', err) })
  }
}

export function ensureMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    createMainWindow()
    if (consumePendingFocus()) { const w = getMainWindow(); if (w) { if (w.isMinimized()) w.restore(); if (!w.isVisible()) w.show(); w.focus() } }
    return
  }
}

export function focusOrDefer(): void {
  const win = getMainWindow()
  if (!win) {
    if (app.isReady() && appStarted) { createMainWindow(); raiseWindow(); return }
    setPendingFocus()
    return
  }
  if (win.isDestroyed()) { createMainWindow(); raiseWindow(); return }
  raiseWindow()
}

function raiseWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}
```

- [ ] **Step 5: typecheck + build 验证**

Run: `cd /home/yomu/elysia-frontend && pnpm typecheck && cd apps/desktop && pnpm build`
Expected: PASS（`fileURLToPath`/`realpath` import 已移除；`sep` 不再使用；classifyNavigation 已从 main-window 移除）

- [ ] **Step 6: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add src/main/windows/navigation.ts src/main/windows/main-window.ts tests/unit/navigation.spec.ts && git commit -m "feat(阶段1块A): 主窗口 cyrene:// 加载 + will-navigate 导航门（navigation 纯函数 + 单测）+ dev F12"
```

---

### Task 10: 打包与产物验证（electron-builder + verify-artifact）

> 决策记录：spec §5.5「复用 smoke-electron.cjs 启动骨架」——该脚本位于 `.playwright-mcp/`（gitignored、一次性冒烟用途），不可被 `scripts/verify-artifact.cjs` require。本任务**内联其已验证模式**（`delete ELECTRON_RUN_AS_NODE` / `ELECTRON_ENABLE_LOGGING`、`_electron.launch` 参数、`args:[cwd]`），保持单一实现；后续块 C 将 smoke 正式化为 test:integration 时再统一。回写 spec §10 G-8。

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/scripts/verify-artifact.cjs`
- Modify: `apps/desktop/package.json`（devDeps + 脚本 + author）
- Modify: 仓库根 `package.json`（`package` 转发到子包）

**Interfaces:**
- Produces: `pnpm package`（electron-vite build && electron-builder --dir）、`pnpm verify:artifact`（静态检查 + 可选 Playwright 冒烟）

- [ ] **Step 1: 添加 devDependencies 并补 author**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && pnpm add -D playwright electron-builder
# 信任边界检查（§8.6 普通浏览器）需要 chromium 二进制；幂等（已装则秒过）。若失败记录 docs/17 并跳过该项检查。
pnpm exec playwright install chromium
```

同时在 `apps/desktop/package.json` 顶层加（electron-builder linux 需要 author）：
```json
"author": "Cyrene",
"description": "Cyrene 桌面客户端(Electron + Vue 3 + TypeScript + electron-vite)"
```
（description 已存在则不动；author 新增）

- [ ] **Step 2: 创建 electron-builder.yml**

```yaml
# apps/desktop/electron-builder.yml —— 阶段 1 最小未分发包（Forge 全量安装包留阶段 8）
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

- [ ] **Step 3: 更新 package.json 脚本（apps/desktop 与仓库根）**

apps/desktop/package.json：
```json
"package": "electron-vite build && electron-builder --dir",
"verify:artifact": "node scripts/verify-artifact.cjs"
```
仓库根 /home/yomu/elysia-frontend/package.json（把 `package` 从 `build` 转发改为转发到子包 `package`，否则根入口 `pnpm package` 只刷 out/ 不产 dist/）：
```json
"package": "pnpm --filter @cyrene/desktop package",
"verify:artifact": "pnpm --filter @cyrene/desktop verify:artifact"
```

- [ ] **Step 4: 创建 scripts/verify-artifact.cjs**

```javascript
// apps/desktop/scripts/verify-artifact.cjs
// 静态检查 out/ 产物；--smoke 或存在 DISPLAY 时加 Playwright _electron 启动冒烟。
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const out = path.join(root, 'out')
let failed = false
const ok = (m) => console.log(`✓ ${m}`)
const fail = (m) => { console.error(`✗ ${m}`); failed = true }

// 1. 三件产物存在
for (const rel of ['main/index.js', 'preload/index.js', 'renderer/index.html']) {
  const p = path.join(out, rel)
  if (fs.existsSync(p)) ok(`out/${rel} 存在`) else fail(`out/${rel} 缺失`)
}
// 2. index.html 保留 CSP meta（dev http 兜底）且无 unsafe-eval；prod/preview 走 cyrene:// 严格响应头 AND 收紧
const htmlPath = path.join(out, 'renderer/index.html')
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8')
  if (/unsafe-eval/i.test(html)) fail('index.html 含 unsafe-eval')
  else ok('index.html 无 unsafe-eval')
  if (/Content-Security-Policy/i.test(html)) ok('index.html 保留 CSP meta（dev http 兜底，prod 由响应头 AND 收紧）')
  else fail('index.html 缺失 CSP meta（dev http 场景将零 CSP）')
}
// 3. 秘密模式扫描（best-effort）
const secretPatterns = [
  // AGENT_ACCESS_TOKEN 仅当赋值形态（`= 值`/`: 值`）命中——引用（process.env.AGENT_ACCESS_TOKEN / env['AGENT_ACCESS_TOKEN']）不算秘密
  /(^|[^A-Za-z0-9_.'"`])AGENT_ACCESS_TOKEN\s*[=:]\s*["']?[^\s"'`,;]+/,
  /(^|[\\/])\.env([\\/.]|$)/, // 文件名边界：.env / .env.local 段；不误报 process.env.NODE_ENV 的 .env 访问
  /Bearer\s+[A-Za-z0-9_.~+/=-]{20,}/
]
function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files // out/ 缺失时后续 existsSync 检查已 fail，这里不裸抛 ENOENT
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, files)
    else files.push(p)
  }
  return files
}
const textExt = ['.js', '.html', '.css', '.json', '.cjs', '.mjs', '.map'] // .map sourcemap 带完整 sourcesContent，须同扫
let secretHit = false
let scanned = 0
for (const f of walk(out)) {
  if (!textExt.includes(path.extname(f))) continue
  scanned++
  const content = fs.readFileSync(f, 'utf8')
  for (const re of secretPatterns) {
    if (re.test(content)) { fail(`out/ 命中秘密模式 ${re}（文件 ${path.relative(out, f)}）`); secretHit = true }
  }
}
if (secretHit) { /* fail 已置 */ }
else if (scanned > 0) ok('out/ 无 .env/Token/Bearer 模式')
else console.warn('（out/ 无文本文件可扫描——三件产物检查已 fail，不打印 PASS）')
// 4. version 可读
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (pkg.version) ok(`version=${pkg.version}`) else fail('package.json 无 version')

// 优先用未分发包（真实打包形态，能抓到 electron-builder 打包错误）；否则回退 out/（未打包直启）。
// electron-builder 产物含 .chrome-sandbox / chrome_crashpad_handler 等 helper，须按 productName 候选名挑选真实应用二进制；
// 平台感知：linux→dist/linux-unpacked、win32→dist/win-unpacked、darwin→dist/mac/…/MacOS。
// 返回 { exe, foundPackagedDir }：有打包目录但找不到候选二进制 → foundPackagedDir=true 且 exe=null（判失败，防打包命名变化被静默掩盖）。
function findPackagedExecutable(root) {
  const p = process.platform
  const targets = []
  if (p === 'linux') targets.push({ dir: path.join(root, 'dist/linux-unpacked'), names: ['Cyrene', 'cyrene'] })
  if (p === 'win32') targets.push({ dir: path.join(root, 'dist/win-unpacked'), names: ['Cyrene.exe', 'cyrene.exe'] })
  if (p === 'darwin') {
    // electron-builder 按 arch 输出 dist/mac / mac-arm64 / mac-universal；Apple Silicon 用 arm64
    for (const d of ['mac', 'mac-arm64', 'mac-universal']) {
      targets.push({ dir: path.join(root, 'dist', d, 'Cyrene.app', 'Contents', 'MacOS'), names: ['Cyrene', 'cyrene'] })
    }
  }
  let anyDirExisted = false
  for (const t of targets) {
    if (!fs.existsSync(t.dir)) continue
    anyDirExisted = true
    for (const n of t.names) {
      const exe = path.join(t.dir, n)
      if (fs.existsSync(exe) && fs.statSync(exe).isFile()) return { exe, foundPackagedDir: true }
    }
    // 不提前 return：darwin 可能 dist/mac 为空而 mac-arm64 有产物，继续遍历
  }
  // 有打包目录但全无候选 → 打包命名变化/残缺（真问题，交由调用方 fail）；无目录 → 回退 out/
  return { exe: null, foundPackagedDir: anyDirExisted }
}

async function smoke() {
  // 在 try 外解析（catch 分支要引用 packagedExe 打诊断提示；块级 const 在 catch 不可见会 ReferenceError）
  const { exe: packagedExe, foundPackagedDir } = findPackagedExecutable(root)
  if (foundPackagedDir && !packagedExe) {
    fail('存在未分发包目录但找不到应用二进制（Cyrene/cyrene）——打包命名变化或产物残缺，不静默回退 out/（Step 5 应已 rm -rf dist）')
  }
  try {
    const { _electron } = require('playwright')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_ENABLE_LOGGING
    delete env.ELECTRON_RENDERER_URL // 残留 dev env 会把 out/ 回退冒烟劫持到 http；冒烟必须测 cyrene:// 路径
    delete env.NODE_OPTIONS // 开发者 shell 残留的 --inspect* 会误触发打包调试门；冒烟测的是产物不是 shell 环境
    env.CYRENE_TEST_HARNESS = '1' // 显式标记测试 harness：让调试门放行 Playwright 注入的 --remote-debugging-port=0/--inspect=0（生产默认拒绝）
    let app
    if (packagedExe) {
      console.log(`（冒烟目标：未分发包打包产物 ${path.relative(root, packagedExe)}）`)
      app = await _electron.launch({ executablePath: packagedExe, args: [], cwd: root, env, timeout: 30000 })
    } else {
      console.log('（冒烟目标：out/ 未打包直启——未找到未分发包产物）')
      // ELECTRON_RUN_AS_NODE 下 require('electron') 返回 cli 函数而非路径（本仓沙箱注入该 env，docs/17 P-2）；
      // 用 electron 包内 path.txt 解析真实二进制路径（跨平台，不受 env 影响）。
      const electronDir = path.dirname(require.resolve('electron/package.json'))
      const binRel = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim()
      const electronPath = path.join(electronDir, binRel)
      app = await _electron.launch({ executablePath: electronPath, args: [root], cwd: root, env, timeout: 30000 })
    }
    try {
      // 在 firstWindow 前挂 app 级 console 监听——首载阶段的 CSP 拒绝错误也能捕获
      const cspErrors = []
      app.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) cspErrors.push(msg.text())
      })
      const win = await app.firstWindow()
      win.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|Refused to/i.test(msg.text())) cspErrors.push(msg.text())
      })
      await win.waitForFunction(() => typeof window.desktopApi !== 'undefined', null, { timeout: 15000 })
      const proto = await win.evaluate(() => window.location.protocol)
      if (proto === 'cyrene:') ok('window.location.protocol === cyrene:')
      else fail(`协议非 cyrene:（实际 ${proto}）`)
      // reload 确定性复现一次完整页载：监听挂载可能错过最早加载窗口，reload 让严格 CSP 的违规必然被捕获
      await win.reload()
      await win.waitForFunction(() => typeof window.desktopApi !== 'undefined', null, { timeout: 15000 })
      // Vue 挂载断言：preload/协议不依赖 bundle，必须确认 #app 真实渲染，防白屏假绿
      let rendered = false
      try {
        await win.waitForFunction(() => {
          const el = document.querySelector('#app')
          return el && el.childElementCount > 0 && (el.textContent || '').trim().length > 0
        }, null, { timeout: 15000 })
        rendered = true
      } catch { rendered = false }
      if (rendered) ok('Vue #app 已挂载渲染（非白屏）')
      else fail('Vue #app 未挂载（白屏）——renderer bundle 可能未执行（MIME/加载错误）')
      // computed-style 检查：捕获「CSS 未应用（如 style-src 拦截内联样式）」——App.vue 根是 #app 子节点 `.cy-app`（display:grid），
      // #app 挂载点自身只有 height:100%/margin:0（无 grid 规则），须查 `.cy-app`
      const computedDisplay = await win.evaluate(() => {
        const el = document.querySelector('#app .cy-app')
        return el ? getComputedStyle(el).display : '（.cy-app 不存在）'
      })
      if (computedDisplay === 'grid') ok('#app .cy-app computed display=grid（tokens.css/样式已应用）')
      else fail(`#app .cy-app computed display=${computedDisplay}（样式可能被 CSP style-src 拦截或 CSS 未加载）`)
      await win.waitForTimeout(1500)
      if (cspErrors.length === 0) ok('无 CSP console 报错（best-effort）')
      else fail(`CSP 报错 ${cspErrors.length} 条：${cspErrors[0]}`)
      // 确定性 CSP 断言（非时序）：页内 fetch cyrene://renderer/index.html 读响应头，验证严格 CSP 确实被服务
      const cspHeader = await win.evaluate(async () => {
        try {
          const res = await fetch('cyrene://renderer/index.html')
          return res.headers.get('content-security-policy') || ''
        } catch { return '' }
      })
      if (cspHeader.includes("frame-src 'none'") && !/unsafe-eval/.test(cspHeader) && !/unsafe-inline/.test(cspHeader)) {
        ok('cyrene:// 响应头携带严格 CSP（frame-src none / 无 unsafe-eval/inline）')
      } else {
        fail(`cyrene:// 响应头缺严格 CSP（实际：${cspHeader.slice(0, 120)}）`)
      }
      const info = await win.evaluate(() => window.desktopApi.getAppInfo())
      // installAppIdentity 已 app.setName('Cyrene')，打包/未打包 app.getName() 均返回 'Cyrene'（第一块冒烟已验证）
      if (info && info.name === 'Cyrene' && info.version === pkg.version && info.platform === process.platform) ok(`getAppInfo=${JSON.stringify(info)}`)
      else fail(`getAppInfo 异常：${JSON.stringify(info)}`)
      // 普通浏览器信任边界（spec §8.6）：desktopApi 只存在于 Electron preload。
      // 用本地 http 静态服务加载产物（file:// 下 Vite 绝对基址 /assets/... 无法加载，会让 bundle 不执行而假通过）
      try {
        const { chromium } = require('playwright')
        const http = require('http')
        const rendererDir = path.join(root, 'out', 'renderer')
        const server = http.createServer((req, res) => {
          let urlPath
          try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]) } catch { res.writeHead(400); res.end(); return }
          const safe = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
          const file = path.resolve(rendererDir, safe)
          const bad = (file !== rendererDir && !file.startsWith(rendererDir + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()
          if (bad) { res.writeHead(404); res.end(); return } // 越界/缺失/目录（空路径落 rendererDir 自身）→ 404，不 readFileSync 目录
          // 值与 Task 5 protocol/mime.ts 的 MIME_MAP 逐字符一致（CJS 脚本无法 import TS，此为第二副本，扩展时两边同步）
          const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
          res.end(fs.readFileSync(file))
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const port = server.address().port
        try {
          const browser = await chromium.launch()
          try {
            const page = await browser.newPage()
            await page.goto(`http://127.0.0.1:${port}/index.html`)
            // 安全属性断言（核心，独立于渲染）：desktopApi 只存在于 Electron preload
            const hasApi = await page.evaluate(() => typeof window.desktopApi !== 'undefined')
            if (hasApi) fail('普通浏览器暴露 desktopApi（信任边界被破坏！）')
            else ok('普通浏览器 desktopApi undefined（信任边界）')
            // bundle 执行确认（informational，不判 fail）：渲染失败不否定上述安全属性；
            // 若未来 renderer boot 在普通浏览器解引用 desktopApi（启动即抛、#app 不挂载），此处仅提示不误判
            const rendered = await page.evaluate(() => {
              const el = document.querySelector('#app')
              return !!el && el.childElementCount > 0
            })
            if (rendered) console.log('  （bundle 已执行：#app 渲染）')
            else console.warn('  （bundle 未渲染——不影响 desktopApi 断言，但建议人工确认 bundle 可在普通浏览器加载）')
          } finally {
            await browser.close()
          }
        } finally {
          server.close()
        }
      } catch (e) {
        // 仅「chromium 二进制不可用」跳过；其他失败（goto/evaluate/静态服务）判失败，防 §8.6 假通过
        const m = e && e.message ? String(e.message) : String(e)
        if (/Executable doesn't exist|browserType\.launch|browser binaries|Please run npx playwright install|Running as root without --no-sandbox|SUID sandbox helper|chrome-sandbox/.test(m)) {
          console.warn('（跳过普通浏览器信任边界检查：chromium 二进制不可用或沙箱受限——块 C 集成测试再强化）')
        } else {
          fail(`普通浏览器信任边界检查失败：${m}`)
        }
      }
      // 截图写到仓库根 .playwright-mcp/（vision MCP 读取根；apps/desktop 下的同名目录会被 gitignore 但 vision 找不到）
      const shotDir = path.join(root, '..', '..', '.playwright-mcp')
      fs.mkdirSync(shotDir, { recursive: true })
      await win.screenshot({ path: path.join(shotDir, 'cyrene-cyrene-proto.png') })
      ok(`截图 ${path.join(shotDir, 'cyrene-cyrene-proto.png')}`)
      // 负路径（仅打包形态）：带禁止开关（无 harness）→ 调试门应 failStart 退出（验证拒绝路径接线 E2E，
      // 而不只是单测覆盖纯函数）。out/ 未打包 isPackaged=false 不触发门，此处只在 packagedExe 时测。
      if (packagedExe) {
        const negEnv = { ...env }
        delete negEnv.CYRENE_TEST_HARNESS
        let negRejected = false
        try {
          const negApp = await _electron.launch({ executablePath: packagedExe, args: ['--remote-debugging-port=9222'], env: negEnv, timeout: 15000 })
          try {
            const negWin = await negApp.firstWindow({ timeout: 5000 }).catch(() => null)
            if (negWin) { /* 拿到窗口 = 门没生效 */ } else { negRejected = true }
          } finally { await negApp.close().catch(() => {}) }
        } catch {
          negRejected = true // failStart 退出 → launch/firstWindow 失败
        }
        if (negRejected) ok('调试门拒绝路径生效（打包 + --remote-debugging-port=9222 → failStart 退出）')
        else fail('调试门未生效：打包带 --remote-debugging-port=9222 仍启动出窗口')
      }
    } finally {
      await app.close()
    }
  } catch (e) {
    const m = e && e.message ? String(e.message) : String(e)
    fail(`启动冒烟失败：${m}`)
    if (packagedExe) {
      console.error('  提示：若为超时/立即退出，可能是单实例锁冲突（你在跑 pnpm dev / 真实 Cyrene？或上一次冒烟未正常关闭），或调试门与 Playwright 注入开关冲突（确认 CYRENE_TEST_HARNESS=1 已注入、Playwright 注入形态为 --remote-debugging-port=0/--inspect=0）')
    }
  }
}

;(async () => {
  const wantSmoke = process.argv.includes('--smoke')
  if (wantSmoke) {
    // Linux 需 DISPLAY 或 WAYLAND_DISPLAY（X/Wayland 均可）；win32/darwin 有原生显示
    const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    if (needsDisplay) {
      fail('请求了 --smoke 但 Linux 无 DISPLAY/WAYLAND_DISPLAY，无法执行启动冒烟')
    } else {
      console.log('—— 启动冒烟（Playwright _electron）——')
      await smoke()
    }
  } else {
    console.log('（仅静态检查：未传 --smoke。启动冒烟用 `pnpm verify:artifact -- --smoke`）')
  }
  if (failed) { console.error('verify:artifact 失败'); process.exit(1) }
  console.log('verify:artifact 通过')
})()
```

- [ ] **Step 5: 运行静态验证（先清 dist 防残留——此时冒烟走 out/ 未打包直启）**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && rm -rf dist && pnpm build && pnpm verify:artifact -- --smoke`
Expected: 静态全 ✓ + 冒烟（out/ 未打包）全 ✓：`window.location.protocol === 'cyrene:'`、无 CSP 报错、`getAppInfo={Cyrene,0.1.0,<当前平台>}`；`--smoke` 无 DISPLAY 时判失败（不假绿）

- [ ] **Step 6: 运行 package（未分发包）并复跑 verify（冒烟切到打包产物）**

Run: `cd /home/yomu/elysia-frontend/apps/desktop && pnpm package && pnpm verify:artifact -- --smoke`
Expected: `dist/linux-unpacked/` 生成；verify 冒烟日志出现「冒烟目标：未分发包打包产物」且协议 `cyrene:`、无 CSP 报错、Vue 挂载、getAppInfo 正常——**用真实打包产物验证，能抓到 electron-builder 打包错误（node_modules 拷贝/入口/目录布局）**
> 注 1：受限/容器环境若打包冒烟报 SUID sandbox helper 错（`--no-sandbox` 相关），此为环境限制非产品缺陷——记录到 `docs/17`（P-* 风格）并按容器限制处理；协议/CSP 已由 out/ 冒烟验证。
> 注 2：无头 Linux（无 DISPLAY/WAYLAND）`--smoke` 会判失败——本机 dev 环境有 DISPLAY:0 可跑；CI 无头环境由块 C 用 xvfb-run 覆盖。

- [ ] **Step 7: 提交**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && git add electron-builder.yml scripts/verify-artifact.cjs package.json && git commit -m "feat(阶段1块A): electron-builder dir 未分发包 + verify:artifact 产物检查"
```

---

### Task 11: 全量验证 + 冒烟收口

**Files:**
- 无新代码（验证既有 1-10 不回归）

- [ ] **Step 1: 全量 typecheck/lint/test**

```bash
cd /home/yomu/elysia-frontend && pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全部 PASS（既有 39 项 + 新增 53 项（12+12+9+7+3+10 navigation）= 92 项左右）

- [ ] **Step 2: 构建 + verify:artifact 冒烟**

```bash
cd /home/yomu/elysia-frontend/apps/desktop && pnpm build && pnpm verify:artifact -- --smoke
```

Expected: 静态全 ✓ + 冒烟全 ✓（协议 cyrene:、无 CSP 报错、getAppInfo）

- [ ] **Step 3: 视觉确认（vision MCP）**

- 冒烟已内置截图（Task 10 smoke 写 `.playwright-mcp/cyrene-cyrene-proto.png`），直接读取分析，无需再加截图；
- 用 `mimo-vision` 的 `analyze_image` 分析截图：四栏布局（导航/会话/聊天/Live2D）正常渲染、无空白/报错覆盖。
- **经验教训**（先读 `docs/17` §9/§12）：截图写 `.playwright-mcp/`；Wayland 下不要用 x11grab；用完关掉启动的服务。

- [ ] **Step 4: 提交（如有验证补丁）**

```bash
cd /home/yomu/elysia-frontend && git add -A && git commit -m "test(阶段1块A): 全量验证 + 冒烟收口"
```

---

### Task 12: 文档同步（CLAUDE.md 文档维护要求）

**Files:**
- Modify: `docs/07-Cyrene-Electron前端安全设计-v0.2.md`（§4/§5：自定义协议 + CSP AND + 远程调试门口径）
- Modify: `docs/09-Cyrene-前端构建打包与发布设计-v0.2.md`（§3/§4/§5：dev/test/prod 环境落地 + package/verify:artifact 命令语义）
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（阶段 1 §4 任务③④与验收门槛「生产恒关/远程调试恒关」勾选 + 变更记录）
- Modify: `docs/17-Cyrene-前端开发环境与依赖安装记录.md`（如有新坑：electron-builder 首次打包、Playwright 打包冒烟 `=0` 通道、verify:artifact）
- Modify: `README.md`（当前状态：块 A 落地说明）
- Modify: `docs/01-Cyrene-Electron-前端总体架构设计-v0.2.md`（加载模型：file:// → cyrene:// 受限协议）
- Modify: `docs/10-Cyrene-前端实施路线与任务拆分-v0.2.md`（阶段 1 范围回写，若含加载/环境描述）
- Modify: `docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md`（追加本次增量 Review 记录——CLAUDE.md 要求安全策略/协议变化重跑交叉 Review）
- Modify: `docs/superpowers/specs/2026-08-09-phase1-loading-env-design.md`（实施中新增决策回写 §10，若有）
- 注：doc 02 为前后端协议（cyrene:// 是前端内部加载协议，不涉后端 wire 契约），如无字段映射变化可不改；若有交叉引用提及则顺手校对

- [ ] **Step 1: 按上述文档逐份更新**

- doc 07 §4 补充：Renderer 经 `cyrene://` 受限协议加载（替代 `file://`）、远程调试门（拒绝显式端口/裸开关/pipe（非 harness）；`=0` 与 pipe 仅测试 harness `CYRENE_TEST_HARNESS=1` 放行）；
- doc 07 §5 补充：CSP 保留 index.html meta + 协议响应头严格版 **AND 取交集**（dev http 靠 meta 兜底；prod/preview 走 cyrene:// 严格头，meta 不剥离）；`frame-src 'none'`；
- doc 09 §5 命令语义：`package`=未分发包（electron-builder --dir）、`verify:artifact`=产物检查；
- docs/16 §4：勾选「建立开发/测试/生产配置与最小打包流程」「落地 CSP、受限自定义协议替代 file://」，验收门槛「生产配置默认关闭开发者模式与 DevTools，远程调试端口始终关闭」升 `[x]`，变更记录加行；
- 变更保持中文，与 docs/ 一致。

- [ ] **Step 2: 提交**

```bash
cd /home/yomu/elysia-frontend && git add docs/ README.md && git commit -m "docs(阶段1块A): 安全加载与环境基线文档同步"
```

---

## Self-Review 对照（spec → 任务）

| spec 验收标准 | 任务 |
|---|---|
| §8.1 config/protocol 结构 + env.d.ts | Task 1/3/4/5/6/7 |
| §8.2 resolveAppConfig 单测（三 mode、打包恒关、logLevel 规则） | Task 1 |
| §8.3 buildRendererCsp 单测 | Task 4 |
| §8.4 resolveRendererPath 单测（含 NUL/双重解码/前缀陷阱） | Task 3 |
| §8.5 协议 cyrene: + CSP 无报错 + getAppInfo | Task 10/11 |
| §8.6 desktopApi undefined（信任边界） | verify:artifact `--smoke` 内置普通浏览器检查 + Task 11 复跑 |
| §8.7 打包安全默认（devToolsAllowed=false + Menu 移除 + 四类开关拒） | Task 1/2/8 |
| §8.7 NODE_OPTIONS 纯 env 调试通道拒绝 | Task 2/8 |
| §5.3 will-navigate 导航门（安全关键纯函数，冒烟不触发 will-navigate） | Task 9 navigation.spec.ts |
| §8.8 dev F12 + pnpm dev | Task 9 + 冒烟 |
| §8.9 pnpm package + verify:artifact | Task 10 |
| §8.10 既有单测不回归 | Task 11 |

**spec §10 决策**：D-10（playwright devDep）→ Task 10；D-14（electron-builder dir）→ Task 10；D-17（shouldUseViteDevServer 谓词）→ Task 1/8/9；D-18（调试门顶部）→ Task 8。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-08-09-phase1-loading-env.md`。两种执行方式：

1. **Subagent-Driven（推荐）** —— 每个任务派发独立 subagent，任务间 review，快速迭代；
2. **Inline 执行** —— 本会话内用 executing-plans 批量执行，带检查点。

选择哪种？
