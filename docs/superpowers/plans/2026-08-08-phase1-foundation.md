# 阶段 1 第一块：安全骨架地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/desktop/src/main` 落地 doc 01 §5 的 9 子目录结构、确立应用身份与 userData 七目录、建立具名 Schema 校验 IPC 骨架，全部可测试、`typecheck`/`lint`/`test`/`build` 全绿。

**Architecture:** 主进程按职责拆 9 子目录（app/windows/ipc/transport/persistence/credentials/diagnostics/tools/permissions），`index.ts` 保留薄入口做 `main()` 装配（installAppIdentity → 单实例锁 → whenReady → 目录 → IPC → 窗口）。IPC 走「通道常量（shared）+ zod schema（main/ipc/channels）+ 纯 executor（main/ipc/executor）+ Electron 绑定（main/ipc/registry）+ isTrustedSender 主窗口 WebContents 锚点」。userData 目录创建为纯函数 `ensureUserDataDirs`（不 import electron，vitest 可测），带 symlink/realpath 逃逸防护与 POSIX 0700。

**Tech Stack:** electron-vite 5 / Electron 43 / TypeScript 5.6 / Vue 3 / zod 4 / vitest 4 / pnpm（workspace `apps/*`，`allowBuilds` 已配 electron/esbuild/vue-demi）。**测试工具链：前端 JS 走 pnpm（vitest/vue-tsc/eslint）；conda Elysia 为后端 Python 环境，本批不适用（spec P-6 记录在案）。**

## Global Constraints

从 spec `docs/superpowers/specs/2026-08-08-phase1-foundation-design.md` 提取，逐字照抄：

- 主进程入口 `src/main/index.ts` 保留薄入口，**零 electron.vite.config 改动**（spec P-2）。
- `src/main/` 拆 9 子目录：`app/ windows/ ipc/ transport/ persistence/ credentials/ diagnostics/ tools/ permissions/`；空目录（credentials/tools/permissions）用 **README 占位**说明用途与填充阶段（spec P-1）。
- `fixtures/` 保留在 `src/main/fixtures/`（transport 经相对路径 `../fixtures/` 引用 mock 夹具，**不得移动**）。
- 应用身份：`app.setName('Cyrene')` + `app.setPath('userData', join(app.getPath('appData'), 'Cyrene'))`，**必须在 `whenReady` 前**；`setAppUserModelId('com.cyrene.desktop')` 留在 `whenReady` 内（spec §5.1）。
- userData 下 7 目录：`config/ app-cache/ logs/ audit/ temp/ models/ sandbox/`（**app-cache 而非 cache**，spec P-8）；POSIX 0700，Windows 依赖用户级隔离不宣称 0700。
- IPC：通道常量放 `src/shared/contracts/ipc.ts`（仅常量 + 类型，**无 Electron/zod 依赖**）；schema 放 `main/ipc/channels.ts`；`shared/contracts/index.ts` barrel 须 `export * from './ipc'`（spec P-7）。
- 错误信封：`IpcResult<T> = { ok:true; data:T } | { ok:false; error:{code:string;message:string} }`；错误码复用 `CyreneErrorCode`（`SCHEMA_VALIDATION_FAILED`/`UNKNOWN`），**不新增码**。
- Preload 不暴露原始 `ipcRenderer`；`window.desktopApi` 全局声明保持；错误码经 `[CODE] message` 前缀（contextBridge 丢自定义属性）。
- `desktopApi.getAppInfo()` 的 `version` 用 `app.getVersion()`（dev 加载项目 package.json 返回 0.1.0）。
- Renderer 安全基线：`sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true`；`will-navigate` 三分流（自身 URL 放行 / 外部 http(s) openExternal / 其余 preventDefault）；`setWindowOpenHandler` 只拦新窗口。
- 单实例锁在 `installAppIdentity()` 之后、`whenReady` 之前；拿不到锁 `app.exit(0)`；pre-ready `quit()` 可能 no-op。
- 已知限制（spec §10 G-1~G-11）**记录在案、不阻塞实施**，实现时按其处理（尤其 Windows 无 O_NOFOLLOW、safeRoot 仅 Linux/macOS 用 fd 锚点）。

---

## 文件结构

```
apps/desktop/src/
├── main/
│   ├── index.ts              # 改：main() 装配（薄入口）
│   ├── app/
│   │   ├── lifecycle.ts      # 建：installAppIdentity() → { baseCreated }
│   │   └── app-info.ts       # 建：getAppInfo() → AppInfo
│   ├── windows/
│   │   └── main-window.ts    # 建：createMainWindow()（自 index.ts 迁出逻辑 + 加固）
│   ├── ipc/
│   │   ├── channels.ts       # 建：appInfoSchema（zod）
│   │   ├── executor.ts       # 建：createIpcHandler（纯）
│   │   ├── registry.ts       # 建：registerHandler/setMainWindow/getMainWindow/isTrustedSender
│   │   └── handlers.ts       # 建：registerHandlers()
│   ├── transport/            # 已有：backend-adapter + mock-backend（不动）
│   ├── fixtures/             # 已有：streaming-reply.jsonl（不动）
│   ├── persistence/
│   │   └── user-data-dirs.ts # 建：ensureUserDataDirs(base, {baseCreated})（纯）
│   ├── credentials/          # 建：README 占位
│   ├── diagnostics/
│   │   ├── sanitize.ts       # 建：sanitizePublicMessage（纯）
│   │   └── README.md         # 建：logger/audit 后续块
│   ├── tools/                # 建：README 占位
│   └── permissions/          # 建：README 占位
├── preload/
│   ├── desktop-api.ts        # 改：真实 IPC 封装
│   ├── index.ts              # 保持（已 contextBridge.exposeInMainWorld）
│   └── index.d.ts            # 保持
├── shared/contracts/
│   ├── ipc.ts                # 建：IpcChannels/IpcChannelName/IpcErrorBody/IpcResult
│   └── index.ts              # 改：+ export * from './ipc'
└── tests/unit/
    ├── user-data-dirs.spec.ts # 建
    ├── ipc-executor.spec.ts   # 建
    └── sanitize.spec.ts       # 建
```

---

## Task 1: 目录重组与空目录占位

**Files:**
- Create: `apps/desktop/src/main/app/README.md`（或直接放后续任务文件，此处仅保证目录存在）
- Create: `apps/desktop/src/main/windows/README.md`、`ipc/README.md`、`persistence/README.md`、`credentials/README.md`、`diagnostics/README.md`、`tools/README.md`、`permissions/README.md`

**Interfaces:**
- Consumes: 无（纯结构）
- Produces: 9 子目录骨架；credentials/tools/permissions 三个空目录 README 说明用途与填充阶段；fixtures 仍在原处

- [ ] **Step 1: 建目录与 README 占位**

```bash
mkdir -p apps/desktop/src/main/{app,windows,ipc,persistence,credentials,diagnostics,tools,permissions}
```

为 9 个目录各写一份简短 README（占位说明）。示例（tools/README.md）：

```markdown
# tools — Desktop 工具执行器（占位）

阶段 6 填充：Tool Store、四 P0 工具（desktop.file.select/read/write + desktop.screen.capture）
执行、callId 幂等与本地授权。本目录在阶段 1 为空占位。
```

- [ ] **Step 2: 运行 typecheck 确认结构不破坏构建**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop typecheck
```

Expected: PASS（现有代码不受目录新增影响）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main
git commit -m "feat(main): 落地 9 子目录骨架与空目录占位"
```

---

## Task 2: shared/contracts/ipc.ts 通道常量与信封类型 + barrel

**Files:**
- Create: `apps/desktop/src/shared/contracts/ipc.ts`
- Modify: `apps/desktop/src/shared/contracts/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export const IpcChannels = { appGetInfo: 'app:get-info' } as const`
  - `export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels]`
  - `export interface IpcErrorBody { code: string; message: string }`
  - `export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorBody }`

- [ ] **Step 1: 写 ipc.ts（纯类型，无 Electron/zod 依赖）**

```typescript
/** IPC 通道常量：Preload 与 Main 共用，无 Electron 依赖 */
export const IpcChannels = { appGetInfo: 'app:get-info' } as const
export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels]

/** IPC 错误体：只含公开信息，不泄漏堆栈/路径 */
export interface IpcErrorBody {
  code: string
  message: string
}

/** IPC 结果信封：ok:true 带 data；ok:false 带公开错误 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcErrorBody }
```

- [ ] **Step 2: barrel 导出**

`apps/desktop/src/shared/contracts/index.ts` 追加一行：

```typescript
export * from './ipc'
```

- [ ] **Step 3: typecheck 验证（写一个临时类型断言在 executor 单测里测，本任务仅确认编译通过）**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop typecheck
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(shared): IPC 通道常量与结果信封类型 + barrel 导出"
```

---

## Task 3: diagnostics/sanitize.ts —— 公开消息路径脱敏（纯函数）

**Files:**
- Create: `apps/desktop/src/main/diagnostics/sanitize.ts`
- Test: `apps/desktop/tests/unit/sanitize.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export type MessageSanitizer = (message: string) => string`
  - `export function createSanitizePublicMessage(roots: { home: string; userData: string }): MessageSanitizer`
    —— `home`/`userData` **由调用方每次传入**（懒解析；生产 wiring 从 `app.getPath` 取，测试传 fake；不得模块级缓存，spec 要求）
  - 返回的函数处理序：① `file://` 绝对路径 → `<path>` ② userData → `<userData>` ③ home → `~` ④ 其他绝对路径形态 → `<path>`；分隔符不敏感（`\`/`/` 等价），带路径边界（`[\\/]` 或串尾），win32 大小写不敏感，**不改写 message 中非路径内容**。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/desktop/tests/unit/sanitize.spec.ts
import { describe, expect, it } from 'vitest'
import { createSanitizePublicMessage } from '../../src/main/diagnostics/sanitize'

const roots = { home: '/home/alice', userData: '/home/alice/.config/Cyrene' }
const sanitize = createSanitizePublicMessage(roots)

describe('createSanitizePublicMessage', () => {
  it('userData 先替换再 home（先长后短）', () => {
    expect(sanitize('open /home/alice/.config/Cyrene/logs/x.log')).toBe('open <userData>/logs/x.log')
  })
  it('路径边界：/home/alice2 不被 /home/alice 误替换', () => {
    expect(sanitize('open /home/alice2/x')).toBe('open <path>')
  })
  it('file:// 绝对路径被掩', () => {
    expect(sanitize('load file:///tmp/secret 失败')).toBe('load <path> 失败')
  })
  it('win32 大小写不敏感 + 分隔符归一（盘符带左边界，不误伤 http://）', () => {
    const win = createSanitizePublicMessage({ home: 'C:\\Users\\Alice', userData: 'C:\\Users\\Alice\\AppData\\Roaming\\Cyrene' })
    expect(win('C:\\Users\\Alice\\AppData\\Roaming\\Cyrene\\logs\\a.log')).toBe('<userData>\\logs\\a.log')
    expect(win('curl http://127.0.0.1:8080/api')).toBe('curl http://127.0.0.1:8080/api') // 不误伤 URL
  })
  it('不改写 message 中非路径内容（\\d 不被当路径）', () => {
    expect(sanitize('无法匹配 \\d+ 表达式')).toBe('无法匹配 \\d+ 表达式')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop test -- sanitize
```

Expected: FAIL（`createSanitizePublicMessage` 未定义）。

- [ ] **Step 3: 实现**

```typescript
// apps/desktop/src/main/diagnostics/sanitize.ts
export type MessageSanitizer = (message: string) => string

/** 把根路径转成分隔符不敏感正则（/ 与 \ 等价），供在原始 message 上匹配，不改写 message；
 *  正反两个方向都灵活：根是正斜杠 / 消息是反斜杠（或反之）都能匹配 */
function rootToRegex(root: string): string {
  let out = ''
  for (const ch of root) {
    if (ch === '/' || ch === '\\') out += '[\\\\/]' // 一个分隔符位置可匹配 \ 或 /
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

export function createSanitizePublicMessage(roots: { home: string; userData: string }): MessageSanitizer {
  const userData = roots.userData
  const home = roots.home

  return (message: string): string => {
    let out = message
    // ① file:// 绝对路径（先于根替换，防 file://~/x 残留）
    out = out.replace(/file:\/\/[^\s"'<>]+/g, '<path>')
    // ② userData 根（分隔符不敏感、边界 [\\/] 或串尾、大小写不敏感；无左边界——绝对路径粘在词尾也要掩，防泄漏）
    const userDataRe = new RegExp(`${rootToRegex(userData)}(?=[\\\\/]|$)`, 'i')
    out = out.replace(userDataRe, '<userData>')
    // ③ home 根
    const homeRe = new RegExp(`${rootToRegex(home)}(?=[\\\\/]|$)`, 'i')
    out = out.replace(homeRe, '~')
    // ④ 其他绝对路径形态：先 ≥2 段绝对路径（/home/alice2/x 整体掩为 <path>），后已知系统根单段（/etc /tmp 等）
    //    前置 lookbehind 排除紧跟 <userData>/~/<path> 的续接路径与 URL 的 // 路径段（http://example.com/a/b 不破坏）；
    //    尾部收窄为路径字符（不吞逗号/括号等标点——`open /a/b/c,继续` 掩成 `<path>,继续` 而非吃掉逗号）
    out = out.replace(/(?<![>~/\w:])\/(?:[a-zA-Z0-9._~%+-]+\/)+[a-zA-Z0-9._~%+@-]*/g, '<path>')
    out = out.replace(/(?<![>~\w:/])\/(?:etc|tmp|var|home|usr|opt|srv|mnt|media|bin|dev|proc)(?=[\\/]|$)/g, '<path>')
    out = out.replace(/(?<![\w])(?:[A-Za-z]:[\\/][^\s"'<>]+)/g, '<path>') // 盘符
    out = out.replace(/(?<![\w:])\\[\\][^\\\s"'<>]+[\\][^\s"'<>]+/g, '<path>') // UNC 两反斜杠
    return out
  }
}
```

> 实现说明：②③ 用 `rootToRegex` 把根里的 `/` 转成 `[\\/]`，从而在**原始 message**（含反斜杠）上匹配——不做全局改写；`(?<![>~\w])` 使 ④ 不吞掉已被 ②③ 掩成 `<userData>`/`~` 后的续接路径（`<userData>/logs/x.log` 的 `/logs/x.log` 前是 `>`）。`/home/alice2/x` 因 ③ 的边界 `(?=[\\/]|$)` 不匹配 `/home/alice`（后随 `2`），落入 ④ 掩成 `<path>`。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop test -- sanitize
```

Expected: PASS（**5 个用例**全绿——userData 优先/路径边界/file:///win32/非路径内容）。

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(main): diagnostics/sanitize 公开消息路径脱敏"
```

---

## Task 4: persistence/user-data-dirs.ts —— ensureUserDataDirs（纯函数）

**Files:**
- Create: `apps/desktop/src/main/persistence/user-data-dirs.ts`
- Test: `apps/desktop/tests/unit/user-data-dirs.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `export interface UserDataDirs { config: string; appCache: string; logs: string; audit: string; temp: string; models: string; sandbox: string }`
  - `export class UserDataDirError extends Error {}`
  - `export function ensureUserDataDirs(base: string, options?: { baseCreated?: boolean }): Promise<UserDataDirs>`
    —— 7 个相对路径 `config/ app-cache/ logs/ audit/ temp/ models/ sandbox/`；POSIX 新建 `0o700`；base 与叶子 symlink/realpath 逃逸拒绝；既有目录非 0700（目录 `(mode & 0o700) === 0o700 && (mode & 0o077) === 0`）拒绝；`fd.close()` 用 try/finally；safeRoot 用 `realpath('/proc/self/fd/' + fd)`（Linux/macOS），Windows 用 `realpath(base)`。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/desktop/tests/unit/user-data-dirs.spec.ts
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { describe, expect, it, afterEach } from 'vitest'
import { ensureUserDataDirs, UserDataDirError } from '../../src/main/persistence/user-data-dirs'

const dirs: string[] = []
function tmpBase(): string {
  const d = mkdtempSync(join(tmpdir(), 'cyrene-test-'))
  dirs.push(d)
  return join(d, 'Cyrene')
}
function pathRelativeSafeRoot(safeRoot: string, leaf: string): string {
  return relative(safeRoot, leaf)
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('ensureUserDataDirs', () => {
  it('base 缺失自动创建 7 目录（含 app-cache/sandbox）', async () => {
    const d = await ensureUserDataDirs(tmpBase(), { baseCreated: true })
    expect(d.appCache).toContain('app-cache')
    expect(d.sandbox).toContain('sandbox')
    expect(d.config).toContain('config')
  })
  it('base 为普通文件 → 抛 UserDataDirError', async () => {
    const base = tmpBase()
    writeFileSync(base, 'x')
    await expect(ensureUserDataDirs(base)).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('base 为符号链接 → 抛 UserDataDirError（lstat 非目录否定判定）', async () => {
    const base = tmpBase()
    const target = mkdtempSync(join(tmpdir(), 'cyrene-tgt-'))
    dirs.push(target)
    symlinkSync(target, base)
    await expect(ensureUserDataDirs(base)).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('叶子为符号链接 → 抛 UserDataDirError', async () => {
    const base = tmpBase()
    await ensureUserDataDirs(base, { baseCreated: true })
    const target = mkdtempSync(join(tmpdir(), 'cyrene-tgt2-'))
    dirs.push(target)
    const logs = join(base, 'logs')
    rmSync(logs, { recursive: true, force: true })
    symlinkSync(target, logs)
    await expect(ensureUserDataDirs(base, { baseCreated: true })).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('既有 base/叶子非 0700（group/other 位）→ 拒绝', async () => {
    const base = tmpBase()
    mkdirSync(base, { mode: 0o700 }) // 先建 0700，再显式 chmod 0755——mkdirSync 的 mode 受 umask 掩码，直接 0755 在 restrictive umask 下会变 0700，测试不确定
    chmodSync(base, 0o755)
    await expect(ensureUserDataDirs(base)).rejects.toBeInstanceOf(UserDataDirError)
  })
  it('所有叶子的 realpath 落在 safeRoot 内（包含性真实断言）', async () => {
    const base = tmpBase()
    await ensureUserDataDirs(base, { baseCreated: true })
    const safeRoot = realpathSync(base)
    for (const name of ['config', 'app-cache', 'logs', 'audit', 'temp', 'models', 'sandbox']) {
      const leaf = realpathSync(join(base, name))
      const rel = pathRelativeSafeRoot(safeRoot, leaf)
      expect(rel.startsWith('..')).toBe(false)
    }
  })
  it('base 同前缀兄弟目录（Evil）不在 safeRoot 内——包含性不把 Evil 当自己人', async () => {
    const base = tmpBase()
    const evil = base + 'Evil'
    mkdirSync(evil, { mode: 0o700 })
    dirs.push(evil)
    await ensureUserDataDirs(base, { baseCreated: true })
    const safeRoot = realpathSync(base)
    expect(pathRelativeSafeRoot(safeRoot, realpathSync(evil)).startsWith('..')).toBe(true)
  })
})
```

> 注：`chmodSync`/`mkdtempSync`/`realpathSync` 已含在上方 import（`fs`）；`relative` 从 `path` 导入。实现者按测试跑通为准，不得改动测试断言。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop test -- user-data-dirs
```

Expected: FAIL（`ensureUserDataDirs`/`UserDataDirError` 未定义）。

- [ ] **Step 3: 实现 ensureUserDataDirs**

```typescript
// apps/desktop/src/main/persistence/user-data-dirs.ts
import { constants } from 'fs'
import { mkdirSync } from 'fs'
import { chmod, fchmod, fstat, lstat, mkdir, open, realpath } from 'fs/promises'
import { join, relative } from 'path'

export interface UserDataDirs {
  config: string
  appCache: string
  logs: string
  audit: string
  temp: string
  models: string
  sandbox: string
}

export class UserDataDirError extends Error {
  constructor(message: string) { super(message); this.name = 'UserDataDirError' }
}

const LEAF_NAMES = ['config', 'app-cache', 'logs', 'audit', 'temp', 'models', 'sandbox'] as const

const isPosix = process.platform !== 'win32'
const hasFdAnchor = process.platform === 'linux' || process.platform === 'darwin'

async function assertSafeLeaf(path: string, safeRoot: string): Promise<void> {
  // lstat 否定判定：非目录（含 symlink/FIFO/设备）→ 拒绝
  let st
  let created = false
  try { st = await lstat(path) } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // mkdir EEXIST（lstat 后并发创建）→ 视为既有继续，不判致命（与 base 同纪律）
      await mkdir(path, { mode: 0o700 }).catch(() => { /* EEXIST 忽略，下面 lstat 复核 */ })
      created = true
      st = await lstat(path).catch(() => { throw new UserDataDirError(`无法检查新建子目录 ${path}`) })
    } else throw new UserDataDirError(`无法检查 userData 子目录 ${path}`)
  }
  if (!st.isDirectory()) throw new UserDataDirError(`${path} 不是目录或为符号链接`)
  if (isPosix) {
    // POSIX：O_NOFOLLOW|O_DIRECTORY 原子复核（Windows 无这些常量，flags=NaN 会拒——跳过该步，用 lstat+realpath）
    // 新建叶子先路径 chmod 修正 umask（restrictive umask 下 open(O_RDONLY|O_DIRECTORY) 会 EACCES 被误报为符号链接）——与 base 同款
    if (created) await chmod(path, 0o700).catch(() => {})
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY).catch(() => {
      throw new UserDataDirError(`${path} 打开失败（可能是符号链接）`)
    })
    try {
      const fs = await fstat(fd)
      if (!fs.isDirectory()) throw new UserDataDirError(`${path} 非真实目录`)
      // 完整规则：owner rwx 齐全 + 无 group/other（只查 group/other 位会放行 0300/0400/0600 不可用 mode）
      if (!created && ((fs.mode & 0o700) !== 0o700 || (fs.mode & 0o077) !== 0)) {
        throw new UserDataDirError(`${path} 权限不正确，请执行 chmod 700`)
      }
      const real = await realpath(path)
      const rel = relative(safeRoot, real)
      if (rel.startsWith('..') || rel.includes('..')) throw new UserDataDirError(`${path} 逃逸 userData 根`)
      await fchmod(fd, 0o700) // 新建目录修正 umask；既有已过 0700 检查则幂等
    } finally {
      await fd.close()
    }
  } else {
    const real = await realpath(path)
    const rel = relative(safeRoot, real)
    if (rel.startsWith('..') || rel.includes('..')) throw new UserDataDirError(`${path} 逃逸 userData 根`)
  }
}

export async function ensureUserDataDirs(base: string, options?: { baseCreated?: boolean }): Promise<UserDataDirs> {
  // base：lstat 否定判定 + mkdir（非 recursive 由调用方 installAppIdentity 预建，此处幂等）
  let baseSt
  let localCreated = false
  try { baseSt = await lstat(base) } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      try { mkdirSync(base, { mode: 0o700 }) } catch { throw new UserDataDirError(`无法创建 userData 根 ${base}`) }
      localCreated = true
      baseSt = await lstat(base)
    } else throw new UserDataDirError(`无法检查 userData 根 ${base}`)
  }
  if (!baseSt.isDirectory()) throw new UserDataDirError(`${base} 不是目录或为符号链接`)
  const createdThisRun = options?.baseCreated || localCreated

  // safeRoot：Linux/macOS 用 fd 锚点，Windows 用 realpath(base)
  let safeRoot: string
  if (isPosix && hasFdAnchor) {
    // createdThisRun 且 POSIX：先路径 chmod（刚创建的 base 不会被人换链，安全），避免 0o000 umask 下 open EACCES 使 fchmod 不可达
    if (createdThisRun) await chmod(base, 0o700).catch(() => {})
    const fd = await open(base, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY).catch(() => {
      throw new UserDataDirError(`${base} 打开失败（可能是符号链接）`)
    })
    try {
      const fs = await fstat(fd)
      if (!fs.isDirectory()) throw new UserDataDirError(`${base} 非真实目录`)
      // 完整规则：owner rwx 齐全 + 无 group/other；createdThisRun（本次新建）时跳过，fchmod 修正 umask
      if (!createdThisRun && ((fs.mode & 0o700) !== 0o700 || (fs.mode & 0o077) !== 0)) {
        throw new UserDataDirError(`${base} 权限不正确，请执行 chmod 700`)
      }
      if (isPosix && createdThisRun) await fchmod(fd, 0o700)
      // fd 锚点：Linux /proc/self/fd，macOS /dev/fd；解析失败或解析回 fd 自身（fdescfs 不解析到真实路径）→ 回退 realpath(base)
      const fdPath = process.platform === 'darwin' ? `/dev/fd/${fd.fd}` : `/proc/self/fd/${fd.fd}`
      safeRoot = await realpath(fdPath).then(
        (r) => (r.startsWith('/dev/fd/') || r.startsWith('/proc/self/fd/') ? realpath(base) : r),
        () => realpath(base)
      )
    } finally {
      await fd.close()
    }
  } else {
    safeRoot = await realpath(base)
  }

  const out = {} as UserDataDirs
  for (const name of LEAF_NAMES) {
    const p = join(base, name)
    await assertSafeLeaf(p, safeRoot)
    ;(out as Record<string, string>)[name === 'app-cache' ? 'appCache' : name] = p
  }
  return out
}
```

> 注：`mkdirSync` 从 `fs` 导入（**非 `fs/promises`——后者无 mkdirSync**）；`mkdir`/`open`/`realpath` 从 `fs/promises`。实现者按测试跑通为准；`/proc/self/fd/${fd.fd}` 的 `.fd` 是 FileHandle 的数字 fd。POSIX 上 `options.baseCreated` 时对 base fchmod 修正 umask。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop test -- user-data-dirs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(main): persistence/user-data-dirs 七目录创建与逃逸防护"
```

---

## Task 5: ipc/executor.ts —— createIpcHandler（纯函数）

**Files:**
- Create: `apps/desktop/src/main/ipc/executor.ts`
- Test: `apps/desktop/tests/unit/ipc-executor.spec.ts`

**Interfaces:**
- Consumes: `IpcResult`（shared）、`CyreneError`（`../shared/errors`）、`MessageSanitizer`（`../diagnostics/sanitize`）
- Produces:
  - `export function createIpcHandler<TReq, TRes>(requestSchema: ZodType<TReq>, responseSchema: ZodType<TRes>, fn: (req: TReq) => TRes | Promise<TRes>, options: { sanitize: MessageSanitizer }): (raw: unknown) => Promise<IpcResult<TRes>>`
  - 处理序：raw 入参 `safeParse` 失败 → `{ok:false,error:{code:'SCHEMA_VALIDATION_FAILED',message:'参数校验失败'}}`；`fn` 抛 `CyreneError` → 取 `err.code`+`err.message`（`message.length > 65536` → `<message-too-long>`；否则 `sanitize` 再惰性截断 500 码点）；其余抛错 → `{code:'UNKNOWN',message:'内部错误'}`；响应过 responseSchema 失败 → `UNKNOWN`。

- [ ] **Step 1: 写失败测试**

```typescript
// apps/desktop/tests/unit/ipc-executor.spec.ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createIpcHandler } from '../../src/main/ipc/executor'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'

const sanitize = (m: string): string => m.replace(/\/home\/alice/g, '~')
const noopSanitize = (m: string): string => m

describe('createIpcHandler', () => {
  it('合法入参 → ok:true 带 data', async () => {
    const h = createIpcHandler(z.undefined(), z.object({ name: z.string() }), () => ({ name: 'Cyrene' }), { sanitize: noopSanitize })
    expect(await h(undefined)).toEqual({ ok: true, data: { name: 'Cyrene' } })
  })
  it('非法入参 → SCHEMA_VALIDATION_FAILED', async () => {
    const h = createIpcHandler(z.string(), z.undefined(), () => undefined, { sanitize: noopSanitize })
    expect(await h(42)).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  })
  it('fn 抛 CyreneError → 提取 code + 脱敏 message', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new CyreneError(CyreneErrorCode.NOT_CONNECTED, 'open /home/alice/x 失败') }, { sanitize })
    const res = await h(undefined)
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED', message: 'open ~/x 失败' } })
  })
  it('fn 抛 new Error() → UNKNOWN', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new Error('disk full') }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })
  it('fn 抛 null → UNKNOWN（非对象不崩 catch）', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw null }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })
  it('message 超长 → <message-too-long>（64KB 门在 executor）', async () => {
    const h = createIpcHandler(z.undefined(), z.undefined(), () => { throw new CyreneError(CyreneErrorCode.UNKNOWN, 'x'.repeat(70000)) }, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { message: '<message-too-long>' } })
  })
  it('响应过 responseSchema 失败 → UNKNOWN', async () => {
    const h = createIpcHandler(z.undefined(), z.string(), () => ({ bad: true }) as never, { sanitize: noopSanitize })
    expect(await h(undefined)).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop test -- ipc-executor
```

Expected: FAIL（`createIpcHandler` 未定义）。

- [ ] **Step 3: 实现**

```typescript
// apps/desktop/src/main/ipc/executor.ts
import { type ZodType } from 'zod'
import { type IpcResult } from '@shared/contracts'
import { CyreneError } from '@shared/errors'
import type { MessageSanitizer } from '../diagnostics/sanitize'

function truncateCodepoints(s: string, max: number): string {
  let count = 0
  let out = ''
  for (const ch of s) {
    if (count >= max) break
    out += ch
    count++
  }
  return out
}

export function createIpcHandler<TReq, TRes>(
  requestSchema: ZodType<TReq>,
  responseSchema: ZodType<TRes>,
  fn: (req: TReq) => TRes | Promise<TRes>,
  options: { sanitize: MessageSanitizer }
): (raw: unknown) => Promise<IpcResult<TRes>> {
  return async (raw: unknown): Promise<IpcResult<TRes>> => {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: '参数校验失败' } }
    try {
      const data = await fn(parsed.data)
      const out = responseSchema.safeParse(data)
      if (!out.success) return { ok: false, error: { code: 'UNKNOWN', message: '内部错误' } }
      return { ok: true, data: out.data }
    } catch (e: unknown) {
      if (e instanceof CyreneError && typeof e.code === 'string' && typeof e.message === 'string') {
        const msg = e.message.length > 65536 ? '<message-too-long>' : truncateCodepoints(options.sanitize(e.message), 500)
        return { ok: false, error: { code: e.code, message: msg } }
      }
      return { ok: false, error: { code: 'UNKNOWN', message: '内部错误' } }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop test -- ipc-executor
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(main): ipc/executor 具名 handler 纯函数"
```

---

## Task 6: app/app-info.ts + ipc/channels.ts + ipc/registry.ts + ipc/handlers.ts

**Files:**
- Create: `apps/desktop/src/main/app/app-info.ts`
- Create: `apps/desktop/src/main/ipc/channels.ts`
- Create: `apps/desktop/src/main/ipc/registry.ts`
- Create: `apps/desktop/src/main/ipc/handlers.ts`

**Interfaces:**
- Consumes: `IpcChannels`/`IpcResult`（shared）、`createIpcHandler`（executor）、`AppInfo`（shared/contracts/app.ts）、`sanitizePublicMessage` 工厂
- Produces:
  - `app/app-info.ts`: `export function getAppInfo(): AppInfo`（`{ name: 'Cyrene', version: app.getVersion(), platform: process.platform }`）
  - `ipc/channels.ts`: `export const appInfoSchema = z.object({ name: z.string(), version: z.string(), platform: z.string() })`
  - `ipc/registry.ts`:
    - `export function setMainWindow(win: BrowserWindow | null): void`
    - `export function getMainWindow(): BrowserWindow | null`
    - `export function registerHandler(channel: IpcChannelName, executor: (raw: unknown) => Promise<IpcResult<unknown>>, arity: 0 | 1 = 0): void`
      —— 重复注册抛 `CyreneError(CyreneErrorCode.UNKNOWN, ...)`；内部 `ipcMain.handle`，先 `isTrustedSender`（`mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents`），再 `args.length !== arity` 拒绝
  - `ipc/handlers.ts`: `export function registerHandlers(): void`（注册 `app:get-info`，arity 0，`createIpcHandler(z.undefined(), appInfoSchema, () => getAppInfo(), { sanitize })`）

- [ ] **Step 1: 写四个文件**

`app/app-info.ts`:

```typescript
import { app } from 'electron'
import type { AppInfo } from '@shared/contracts'

export function getAppInfo(): AppInfo {
  return { name: 'Cyrene', version: app.getVersion(), platform: process.platform }
}
```

`ipc/channels.ts`:

```typescript
import { z } from 'zod'

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string()
})
```

`ipc/registry.ts`:

```typescript
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannelName, IpcResult } from '@shared/contracts'
import { CyreneError, CyreneErrorCode } from '@shared/errors'

let mainWindow: BrowserWindow | null = null
const registered = new Set<IpcChannelName>()

export function setMainWindow(win: BrowserWindow | null): void { mainWindow = win }
export function getMainWindow(): BrowserWindow | null { return mainWindow }

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (!event.senderFrame) return false
  return event.sender === mainWindow.webContents
}

export function registerHandler(
  channel: IpcChannelName,
  executor: (raw: unknown) => Promise<IpcResult<unknown>>,
  arity: 0 | 1 = 0
): void {
  if (registered.has(channel)) {
    throw new CyreneError(CyreneErrorCode.UNKNOWN, `重复注册 IPC 通道 ${channel}`)
  }
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) return { ok: false, error: { code: 'UNKNOWN', message: '拒绝' } }
    if (args.length !== arity) return { ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED', message: '参数校验失败' } }
    return executor(args.length > 0 ? args[0] : undefined)
  })
  registered.add(channel) // handle 绑定成功后标记——绑定失败不污染 registered，后续可重试
}
```

`ipc/handlers.ts`:

```typescript
import { z } from 'zod'
import { IpcChannels } from '@shared/contracts'
import { getAppInfo } from '../app/app-info'
import { createSanitizePublicMessage } from '../diagnostics/sanitize'
import { createIpcHandler } from './executor'
import { registerHandler } from './registry'
import { appInfoSchema } from './channels'
import { app } from 'electron'

export function registerHandlers(): void {
  const sanitize = createSanitizePublicMessage({
    home: app.getPath('home'),
    userData: app.getPath('userData') // installAppIdentity 已 setPath('userData')——此处精确取，勿用字面量推导（单一事实来源）
  })
  registerHandler(
    IpcChannels.appGetInfo,
    createIpcHandler(z.undefined(), appInfoSchema, () => getAppInfo(), { sanitize }),
    0
  )
}
```

- [ ] **Step 2: typecheck 验证**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop typecheck
```

Expected: PASS。若 `@shared/errors` 未从 barrel 导出 `CyreneError`/`CyreneErrorCode`，检查 `shared/errors/index.ts` 导出（已有）。

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(main): app-info + ipc 注册表/处理器骨架(app:get-info)"
```

---

## Task 7: app/lifecycle.ts —— installAppIdentity + main/index.ts 装配

**Files:**
- Create: `apps/desktop/src/main/app/lifecycle.ts`
- Modify: `apps/desktop/src/main/index.ts`（重写为 main() 薄入口）

**Interfaces:**
- Consumes: `ensureUserDataDirs`（Task 4）、`registerHandlers`（Task 6）、`setMainWindow`/`getMainWindow`（Task 6）、`createMainWindow`（Task 8，本任务先留占位由 Task 8 填）
- Produces:
  - `export interface AppIdentity { baseCreated: boolean }`
  - `export function installAppIdentity(): AppIdentity`——`mkdirSync(dirname(base), {recursive:true, mode:0o700})` + `mkdirSync(base, {mode:0o700})`（非 recursive；成功 → `baseCreated=true`；`EEXIST` → lstat 判别：目录 → `baseCreated=false`、文件/symlink → `setPathOk=false`）；**appData/base 真创建失败（EACCES/EROFS 等）→ 上抛**（main() failStart 弹框，不吞）；`app.setName('Cyrene')` + `app.setPath('userData', base)`（失败 → `setPathOk=false`，main() 据此早退弹框）
  - `main()` 在 `src/main/index.ts`：`installAppIdentity()` → `requestSingleInstanceLock()`（失败 `app.exit(0)`）→ `app.whenReady()` 内：`setAppUserModelId` → `app.getPath('userData') === expectedBase` 断言 → `ensureUserDataDirs(expectedBase, { baseCreated })` → `registerHandlers()` → `ensureMainWindow()`（Task 8）→ 生命周期

- [ ] **Step 1: 写 lifecycle.ts**

```typescript
// apps/desktop/src/main/app/lifecycle.ts
import { app } from 'electron'
import { lstatSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface AppIdentity {
  baseCreated: boolean
  /** setPath('userData', base) 是否成功——失败（base 破损为文件/symlink）时 main() 据此弹框 */
  setPathOk: boolean
}

export function expectedUserDataBase(): string {
  return join(app.getPath('appData'), 'Cyrene')
}

export function installAppIdentity(): AppIdentity {
  let baseCreated = false
  let setPathOk = true
  const base = expectedUserDataBase()
  // appData 父目录创建失败 = 致命（Electron Chromium init 也会挂）——上抛，main() failStart 统一处理
  try {
    mkdirSync(join(app.getPath('appData')), { recursive: true, mode: 0o700 })
  } catch {
    throw new Error(`无法创建应用数据父目录 ${app.getPath('appData')}`)
  }
  try {
    mkdirSync(base, { mode: 0o700 })
    baseCreated = true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new Error(`无法创建应用数据目录 ${base}`)
    }
    // EEXIST：区分"既有目录"与"破损（文件/symlink）"——文件/symlink 应使 setPathOk=false（main() 据此弹框）
    try {
      const st = lstatSync(base)
      if (!st.isDirectory()) setPathOk = false
    } catch {
      setPathOk = false // lstat 失败（破损）同样视为异常
    }
  }
  app.setName('Cyrene')
  try {
    app.setPath('userData', base)
  } catch {
    // setPath 失败（base 破损为文件/symlink）：标记，main() 据 setPathOk 弹框
    setPathOk = false
  }
  return { baseCreated, setPathOk }
}
```

- [ ] **Step 2: 重写 main/index.ts 为 main() 装配**

```typescript
// apps/desktop/src/main/index.ts
import { app, dialog } from 'electron'
import { installAppIdentity, expectedUserDataBase } from './app/lifecycle'
import { ensureUserDataDirs, UserDataDirError } from './persistence/user-data-dirs'
import { registerHandlers } from './ipc/handlers'
import { createMainWindow, ensureMainWindow, focusOrDefer } from './windows/main-window'
import { getMainWindow } from './ipc/registry'

function failStart(message: string): void {
  dialog.showErrorBox('Cyrene 无法启动', message)
  app.exit(1)
}

async function main(): Promise<void> {
  const { baseCreated } = installAppIdentity()

  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }
  app.on('second-instance', () => focusOrDefer())

  await app.whenReady()

  try {
    app.setAppUserModelId('com.cyrene.desktop')
    const expectedBase = expectedUserDataBase()
    if (app.getPath('userData') !== expectedBase) {
      failStart(`userData 目录异常：${expectedBase} 不可用（若权限不对请执行 chmod 700）`)
      return
    }
    await ensureUserDataDirs(expectedBase, { baseCreated })
    registerHandlers()
    ensureMainWindow()
  } catch (e) {
    if (e instanceof UserDataDirError) {
      failStart(e.message)
    } else {
      failStart(`启动失败：${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  app.on('activate', () => focusOrDefer())
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

main()
```

> 注：本任务 `createMainWindow`/`ensureMainWindow`/`focusOrDefer` 尚不存在——Task 8 创建；在 Task 8 完成前 typecheck 会红，属预期（本任务先提交 lifecycle，Task 8 再接线）。为让中间可提交，可将 `windows/main-window.ts` 的 import 与调用留到 Task 8 一次性完成（把本任务 Step 2 的 index.ts 改写并入 Task 8 的 Step 1，本任务只提交 lifecycle.ts）。

- [ ] **Step 3: 提交 lifecycle.ts（index.ts 改写并入 Task 8）**

```bash
git add apps/desktop/src/main/app/lifecycle.ts
git commit -am "feat(main): app/lifecycle installAppIdentity + 预期 userData 路径"
```

---

## Task 8: windows/main-window.ts + main/index.ts 装配完成

**Files:**
- Create: `apps/desktop/src/main/windows/main-window.ts`
- Modify: `apps/desktop/src/main/index.ts`（Task 7 Step 2 的完整改写）

**Interfaces:**
- Consumes: `setMainWindow`/`getMainWindow`（Task 6）、`installAppIdentity`/`expectedUserDataBase`（Task 7）
- Produces:
  - `export function createMainWindow(): void`——`new BrowserWindow({ width:1200, height:760, minWidth:736, minHeight:560, show:false, autoHideMenuBar:true, backgroundColor:'#181e29', title:'Cyrene', webPreferences:{ preload, sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true } })`；`setMainWindow(win)` 在 new 之后、load 之前；`ready-to-show → show()` + 5s 超时兜底（clearTimeout on ready-to-show/closed + `!win.isDestroyed()`）；`setWindowOpenHandler`（http/https → shell.openExternal + deny）；`will-navigate`（整体 try/catch fail-closed；dev `!app.isPackaged` 同源放行（pathname 拒 `/@fs/`/`/@vite/`）；打包 file: 用 `fileURLToPath`+`realpath`+win32 lowercase+路径边界；外部 http/https → openExternal+preventDefault；其余 preventDefault）；`loadURL`（dev `ELECTRON_RENDERER_URL`）/`loadFile`
  - `export function ensureMainWindow(): void`——`getMainWindow()` null 或已销毁 → `createMainWindow()`；建窗后消费「待聚焦」标志（restore+show+focus）
  - `export function focusOrDefer(): void`——有效 → restore+show+focus；已销毁 → createMainWindow；null → 置「待聚焦」标志
  - `export function pendingFocus: { set(): void; consume(): boolean }`（模块级标志，供 ensureMainWindow 消费）

- [ ] **Step 1: 写 windows/main-window.ts**

```typescript
// apps/desktop/src/main/windows/main-window.ts
import { app, BrowserWindow, shell } from 'electron'
import { join, sep } from 'path'
import { fileURLToPath } from 'url'
import { realpath } from 'fs/promises'
import { getMainWindow, setMainWindow } from '../ipc/registry'

let pendingFocus = false
let appStarted = false
function setPendingFocus(): void { pendingFocus = true }
function consumePendingFocus(): boolean { const p = pendingFocus; pendingFocus = false; return p }
/** main() 在 registerHandlers 后调用——置位前 focusOrDefer 遇 null 只 defer，不抢在建窗前（避免 IPC handler 未注册时窗口已拉起） */
export function markAppStarted(): void { appStarted = true }

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host
}

async function isAppOwnUrl(targetUrl: string, rendererRoot: string): Promise<boolean> {
  try {
    const url = new URL(targetUrl)
    if (!app.isPackaged) {
      // dev：同源 http(s) 且不在 Vite 文件代理前缀
      const dev = process.env['ELECTRON_RENDERER_URL']
      if (dev && sameOrigin(url, new URL(dev)) && !url.pathname.startsWith('/@fs/') && !url.pathname.startsWith('/@vite/')) {
        return true
      }
      return false
    }
    if (url.protocol !== 'file:') return false
    const targetPath = await realpath(fileURLToPath(url))
    const root = await realpath(rendererRoot)
    const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
    // 路径边界：targetPath === root，或以 root + path.sep 开头——join('.') 返回 '.' 不是分隔符，勿用
    return lower(targetPath) === lower(root) || lower(targetPath).startsWith(lower(root) + sep)
  } catch {
    return false // fail-closed
  }
}

export function createMainWindow(): void {
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
      webSecurity: true
    }
  })
  setMainWindow(win) // new 后、load 前立即注入

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
    const root = join(__dirname, '../renderer')
    void isAppOwnUrl(url, root).then((own) => {
      try {
        if (own) { win.loadURL(url).catch(() => { /* 加载失败保持 preventDefault，fail-closed */ }); return }
        // 非自身但与应用同源（dev 的 /@fs/ 等被拦前缀）→ 拒绝，不开外部浏览器
        const dev = process.env['ELECTRON_RENDERER_URL']
        if (dev && !app.isPackaged && sameOrigin(new URL(url), new URL(dev))) return
        if (url.startsWith('http:') || url.startsWith('https:')) { shell.openExternal(url); return }
        // 其余 deny
      } catch {
        // fail-closed：异步分支任何异常都保持 preventDefault（已调），不崩溃
      }
    })
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']).catch(() => { /* fail-closed：加载失败不静默，窗口不显示由 5s 兜底 show 暴露 */ })
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html')).catch(() => { /* fail-closed */ })
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
    // 已完整启动（handler 已注册）→ 重建；启动中途（await ensureUserDataDirs 间隙）→ 置待聚焦，
    // 避免窗口在 registerHandlers 前拉起、首个 getAppInfo() 无 handler 拒绝
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

> 注：`sameOrigin` 用 `host` 而非 `hostname`（含端口）。`will-navigate` 中自身 URL 用 `win.loadURL(url)` 重新加载（放行自身）；`event.preventDefault()` 在异步判断前先调，判断后按结果走。`join('.').charAt(0)` 是 `path.sep` 的取法，实现者可直接 `import { sep } from 'path'` 用之。

- [ ] **Step 2: 改写 main/index.ts（Task 7 Step 2 的完整版）**

```typescript
// apps/desktop/src/main/index.ts
import { app, dialog } from 'electron'
import { installAppIdentity, expectedUserDataBase } from './app/lifecycle'
import { ensureUserDataDirs, UserDataDirError } from './persistence/user-data-dirs'
import { registerHandlers } from './ipc/handlers'
import { ensureMainWindow, focusOrDefer, markAppStarted } from './windows/main-window'

function failStart(message: string): void {
  dialog.showErrorBox('Cyrene 无法启动', message)
  app.exit(1)
}

async function main(): Promise<void> {
  let ident
  try {
    ident = installAppIdentity() // fatal（appData/base 真创建失败）→ failStart 弹框，不静默挂起
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
    // setPath 失败 = base 破损（文件/symlink）——直接弹框，不等 ensureUserDataDirs
    if (!setPathOk) {
      failStart(`userData 目录不可用：${expectedUserDataBase()}（请检查是否为普通文件或符号链接）`)
      return
    }
    await ensureUserDataDirs(expectedUserDataBase(), { baseCreated })
    registerHandlers()
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

- [ ] **Step 3: typecheck 验证**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop typecheck
```

Expected: PASS。若 `will-navigate` 异步分支有 TS 类型问题，把 `isAppOwnUrl` 改为同步 `realpathSync` 简化（实现者按编译通过为准，不得改变 fail-closed 语义）。

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(main): windows/main-window 加固 + main() 装配"
```

---

## Task 9: preload 真实 IPC

**Files:**
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`（若需更新类型）

**Interfaces:**
- Consumes: `IpcChannels`/`IpcResult`/`IpcChannelName`（shared/contracts/ipc.ts）、`AppInfo`（shared/contracts/app.ts）
- Produces: `window.desktopApi.getAppInfo(): Promise<AppInfo>`——`ipcRenderer.invoke` 封装，完整信封守卫（ok:true → data 为对象；ok:false → error{code,message}），错误经 `[CODE] message` 前缀抛出；invoke rejection → `[IPC_ERROR] IPC 调用失败`

- [ ] **Step 1: 改写 desktop-api.ts**

```typescript
// apps/desktop/src/preload/desktop-api.ts
import { ipcRenderer } from 'electron'
import { IpcChannels, type IpcChannelName, type IpcResult } from '@shared/contracts'
import type { AppInfo } from '@shared/contracts'

async function invoke<T>(channel: IpcChannelName): Promise<IpcResult<T>> {
  try {
    return (await ipcRenderer.invoke(channel)) as IpcResult<T>
  } catch {
    throw new Error('[IPC_ERROR] IPC 调用失败')
  }
}

function isAppInfo(v: unknown): v is AppInfo {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as AppInfo).name === 'string' && typeof (v as AppInfo).version === 'string' &&
    typeof (v as AppInfo).platform === 'string'
}

export const desktopApi = {
  getAppInfo: async (): Promise<AppInfo> => {
    const res = await invoke<AppInfo>(IpcChannels.appGetInfo)
    // 完整信封守卫：res 必须先判为对象（非信封值不崩 res.ok）；ok:true 且 data 为 AppInfo；ok:false 带 error{code,message}
    if (res && typeof res === 'object' && res.ok === true && res.data !== undefined && res.data !== null && isAppInfo(res.data)) return res.data
    if (res && typeof res === 'object' && res.ok === false &&
        res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
      throw new Error(`[${res.error.code}] ${res.error.message}`)
    }
    throw new Error('[IPC_ERROR] IPC 返回格式异常')
  }
}

export type DesktopApi = typeof desktopApi
```

- [ ] **Step 2: typecheck 验证（含 renderer web 侧）**

```bash
cd /home/yomu/elysia-frontend && pnpm --filter @cyrene/desktop typecheck
```

Expected: PASS（`index.d.ts` 全局声明与现有 `desktopApi` 形状一致，无需改）。

- [ ] **Step 3: Commit**

```bash
git commit -am "feat(preload): desktopApi 真实 IPC 封装与信封守卫"
```

---

## Task 10: 全量验证 + 文档更新

**Files:**
- Modify: `docs/16-Cyrene-前端实施任务清单与进度跟踪.md`（勾选阶段 1 相关项）
- Modify: `apps/desktop/README.md`（如存在；无则跳过）
- 验证命令

- [ ] **Step 1: 全量验证**

```bash
cd /home/yomu/elysia-frontend && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: 全部 PASS。`pnpm build` 产物 `out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` 正常。

- [ ] **Step 2: 冒烟（本机）**

```bash
cd /home/yomu/elysia-frontend && DISPLAY=:0 pnpm --filter @cyrene/desktop dev
```

Expected: 窗口出现；`~/.config/Cyrene` 下 `config/app-cache/logs/audit/temp/models/sandbox` 七目录创建，权限 0700；Renderer 控制台 `window.desktopApi.getAppInfo()` 返回 `{name:'Cyrene', version:'0.1.0', platform:'linux'}`（由用户在 GUI 确认）。

- [ ] **Step 3: 更新 docs/16**

`docs/16-Cyrene-前端实施任务清单与进度跟踪.md` 阶段 1 §4 勾选完成项（目录结构、App 身份、userData、IPC 骨架），并加变更记录行：

```markdown
| 2026-08-09 | 阶段 1 第一块落地：9 子目录、installAppIdentity + userData 七目录、IPC 骨架（app:get-info） | 已开发、未联调 |
```

- [ ] **Step 4: Commit**

```bash
git commit -am "docs: 阶段 1 第一块勾选与变更记录"
```

---

## 自我 Review（对照 spec）

- **spec §2 范围 3 项**：目录重组（Task 1/8）、App 身份/userData（Task 4/7）、IPC 骨架（Task 2/3/5/6/9）——全部覆盖。
- **spec §8 验收 1-7**：结构符合（Task 1）、userData 名不含 @（Task 7 `expectedUserDataBase`）、ensureUserDataDirs 单测（Task 4）、executor 单测（Task 5）、typecheck/lint/test/build 全绿（Task 10）、Renderer 只经 desktopApi（Task 9）、既有单测不回归（Task 10 全量）。
- **spec §10 已知限制 G-1~G-11**：实现按 G 处理（Windows 无 O_NOFOLLOW——Task 4 用 `isPosix` 分支；safeRoot fd 锚点——Task 4 Linux/macOS；iframe 不区分——Task 6 isTrustedSender 只比 webContents）。
- **占位符扫描**：无 "TBD/TODO/implement later"；所有代码步骤含实际代码。
- **类型一致性**：`createIpcHandler` 签名在 Task 5 定义、Task 6 使用一致；`ensureUserDataDirs(base, { baseCreated })` 在 Task 4 定义、Task 7 使用一致；`registerHandlers`/`ensureMainWindow`/`focusOrDefer` 在 Task 6/8 定义、Task 7 index.ts 使用一致。

> 说明：本块 Electron 绑定部分（Task 6/8/9）以 typecheck/build + 本机冒烟验证（vitest 单测覆盖纯函数：sanitize/ensureUserDataDirs/executor）；GUI 冒烟需用户本机确认。

---

## 已知实施风险（plan 经 7 轮 code-review 后，接受为实施时需注意项）

以下为 plan review 中已确认、但按 spec §10 已知限制口径**接受**的权衡（spec 已记录，plan 实施时按其处理，不阻塞）：

| # | 风险 | 处理 |
|---|---|---|
| R-1 | **`isTrustedSender` 不区分主 frame**——同窗口 iframe 的 `event.sender` 就是主 webContents，能 invoke 全部具名通道（spec G-6 已记录） | 本块仅暴露非敏感 `app:get-info`；iframe 区分 + CSP `frame-src` 在后续块收口 |
| R-2 | **sanitize 词内掩码**：home/userData 根无左边界（防粘词路径泄漏的代价），`build/v1/home/alice` 这类词内路径会被掩成 `build/v1~`（过掩，安全方向，破坏可读性） | 安全优先于可读性（泄漏方向不可接受）；spec G-7 单段 best-effort 相邻 |
| R-3 | **sanitize 启发式**：日期形 `/2026/08/09`、百分比段等可能过掩/漏掩 | ④ 兜底为防御纵深，主保证是 ②③ userData/home 根替换；过掩安全、漏掩单段可接受 |
| R-4 | **Electron 绑定部分（Task 6/8/9）无 vitest 单测** | 以 typecheck/build + 本机冒烟验证；纯函数（sanitize/ensureUserDataDirs/executor）有单测 |
| R-5 | **`focusOrDefer`/`ensureMainWindow` 窗口时序**（ready-to-show/5s 兜底/pendingFocus）依赖 Electron 事件时序 | 按计划实现 + 本机 GUI 冒烟确认；已知限制 G-8~G-10 同类 |

> 接受理由：以上均为安全纵深/启发式/Electron 时序的已知权衡，非本块主路径缺陷；主保证（userData 0700 + symlink 拒绝、IPC 白名单 + zod 校验 + sender 锚点、外部链接走系统浏览器）已实现。**实施时若发现 plan 代码与真实 Electron 行为冲突，以实际运行结果为准并回写本文档。**
