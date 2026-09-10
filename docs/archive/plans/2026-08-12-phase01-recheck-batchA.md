# 阶段 0/1 整改·批次 A：跨平台文件与退出地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复阶段 0/1 复核清单批次 A 四项——Windows 安全文件首建/ENOENT 保留（FE-S1-P0-01）、非普通文件拒绝 + `O_NONBLOCK`（FE-S1-P1-02）、`EMPTY_FILE` 工厂化（FE-S1-P2-02）、凭据 drain + 有序退出 + fatal 路径（FE-S1-P1-03）。

**Architecture:** 将 `safe-open.ts` 的平台差异抽成可注入 `SafeOpenPlatform`（posix/windows 两常量 + 默认），统一 post-open `fd.stat().isFile()` 不变量；`credential-store.ts` 加 `close()`（置 closed → await queue → 清缓存）与 platform 注入；`shutdown.ts` 从 `{closeAll, quit}` 重构为 `{steps[], quit, onTimeout, onError}` 有序退出 + 超时标记经同步 audit 落盘，并新增可测 `createFatalShutdown`；`main/index.ts` 按 凭据→adapter→diagnostics 装配。

**Tech Stack:** Electron main（Node）+ TypeScript + vitest（node 环境，`tests/unit/`）。

## Global Constraints

- 决策 A1（用户拍板）：safe-open 平台差异抽成**可注入平台层**；真实 Windows CI 归批次 C。
- 决策 A2（推荐）：非普通文件全拒（`fd.stat().isFile()` 必须过）、POSIX 全部打开追加 `O_NONBLOCK`、drain/退出超时用命名常量 `SHUTDOWN_TIMEOUT_MS = 1500`。
- 错误码新增 `CREDENTIAL_STORE_CLOSED`（**不是** `STORE_CLOSED`，避开 CLAUDE.md「Pinia store」术语歧义）。
- `pre-open lstat` 的 `existing+ENOENT` 必须**原样抛原始 errno**（保留 `code:'ENOENT'`），不得包成 `SafeOpenError`——`CredentialStore.readFile` 据此判「文件不存在」。
- 超时标记必须落盘：`onTimeout` 写**同步 audit**（`auditor.audit`，sync:true 逐行 fsync）+ `logger.warn`；硬超时下后续 step 可被跳过，异步日志 batch 可能丢失。
- `fatal` 路径 `closeAll` 挂起也要 1.5s 兜底后无条件 `exit(1)`。
- 现有测试全部保持通过；新增测试只落在 `tests/unit/`（node 环境，`vitest.config.mts` include `tests/unit/**`）。
- 文档仍标「已开发、未联调」；不触碰批次 B/C/D 项（Renderer 信任边界、审计接线、Windows CI、Mock、Node engines、占位命令、fixtures）。
- FIFO 用 `child_process.spawnSync('mkfifo', [path])` 创建；Unix socket 用 `net.createServer().listen(path)`。

---

### Task 1: safe-open 平台层 + 普通文件不变量（FE-S1-P0-01 + FE-S1-P1-02）

**Files:**
- Modify: `apps/desktop/src/main/persistence/safe-open.ts`（整体重构）
- Test: `apps/desktop/tests/unit/safe-open.spec.ts`（新增 describe 块）

**Interfaces:**
- Produces（T3 消费 `SafeOpenPlatform`/`defaultSafeOpenPlatform`）:
  - `export interface SafeOpenPlatform { readonly kind: 'posix' | 'windows'; readonly createFlags: number; readonly existingReadFlags: number; readonly existingWriteFlags: number; readonly preOpenLstat: boolean; readonly checkModeMask: boolean }`
  - `export const posixPlatform: SafeOpenPlatform`、`export const windowsPlatform: SafeOpenPlatform`、`export function defaultSafeOpenPlatform(): SafeOpenPlatform`
  - `openSafeFile(filePath: string, opts: SafeOpenOptions, platform: SafeOpenPlatform = defaultSafeOpenPlatform()): Promise<SafeOpenResult>`（新增第三可选参）
- Consumes: 无（首个任务）。

- [ ] **Step 1: 写失败测试**——`tests/unit/safe-open.spec.ts` 顶部 `import { openSafeFile, SafeOpenConflictError } from '../../src/main/persistence/safe-open'` 改为**合并追加 `windowsPlatform`**（勿重复 import）；再新增两行 import（`spawnSync`/`createServer`），然后在文件末尾追加 `describe('openSafeFile（非普通文件拒绝 / 平台注入）')`：

```ts
import { spawnSync } from 'child_process'
import { createServer } from 'net'
// 顶部既有 import 行改为：import { openSafeFile, SafeOpenConflictError, windowsPlatform } from '../../src/main/persistence/safe-open'

describe('openSafeFile（非普通文件拒绝 / 平台注入）', () => {
  it('0600 FIFO existing+read 立即拒绝不阻塞', async () => {
    const p = join(root, 'sub', 'fifo.log')
    spawnSync('mkfifo', [p])
    chmodSync(p, 0o600)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot })).rejects.toThrow()
  })
  it('0600 FIFO existing+append 立即拒绝不阻塞', async () => {
    const p = join(root, 'sub', 'fifo2.log')
    spawnSync('mkfifo', [p])
    chmodSync(p, 0o600)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('Unix socket 立即拒绝', async () => {
    const p = join(root, 'sub', 'sock.sock')
    await new Promise<void>((resolve, reject) => {
      const srv = createServer()
      srv.on('error', reject)
      srv.listen(p, () => { srv.close(); resolve() })
    })
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot })).rejects.toThrow()
  })
  it('目录立即拒绝（open 成功但 isFile false）', async () => {
    await expect(openSafeFile(join(root, 'sub'), { mode: 'existing', purpose: 'read', safeRoot })).rejects.toThrow()
  })
  it('/dev/null（char device）立即拒绝', async () => {
    await expect(openSafeFile('/dev/null', { mode: 'existing', purpose: 'read', safeRoot: '/dev' })).rejects.toThrow()
  })
  it('create 遇既有 FIFO → fallback 重开 existing → 拒绝不阻塞', async () => {
    const p = join(root, 'sub', 'fifo3.log')
    spawnSync('mkfifo', [p])
    chmodSync(p, 0o600)
    await expect(openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('windowsPlatform 注入：create+ENOENT 成功首建', async () => {
    const p = join(root, 'sub', 'win-new.log')
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot }, windowsPlatform)
    expect(r.created).toBe(true)
    expect((await r.fd.stat()).isFile()).toBe(true)
    await r.fd.close()
  })
  it('windowsPlatform 注入：existing+ENOENT 原样抛 ENOENT', async () => {
    const p = join(root, 'sub', 'win-missing.log')
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot }, windowsPlatform))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('windowsPlatform 注入：symlink 被 lstat 拒', async () => {
    const p = join(root, 'sub', 'win-link.log')
    const target = join(root, 'outside.log')
    writeFileSync(target, 'x', { mode: 0o600 })
    symlinkSync(target, p)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot }, windowsPlatform)).rejects.toThrow()
  })
  it('windowsPlatform 注入：目录被 isFile 拒', async () => {
    await expect(openSafeFile(join(root, 'sub'), { mode: 'existing', purpose: 'read', safeRoot }, windowsPlatform)).rejects.toThrow()
  })
  it('windowsPlatform 注入：create 遇既有文件 fallback 返回 created:false', async () => {
    const p = join(root, 'sub', 'win-exists.log')
    writeFileSync(p, 'x', { mode: 0o600 })
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot }, windowsPlatform)
    expect(r.created).toBe(false)
    await r.fd.close()
  })
})
```

（`mkdtempSync`/`writeFileSync`/`chmodSync`/`symlinkSync`/`join`/`root`/`safeRoot` 沿用文件顶部现有定义。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/safe-open.spec.ts`
Expected: 任务失败——FIFO 3 例在现状 POSIX 打开下无 `O_NONBLOCK` 阻塞，挂至 vitest 默认 5s 测试超时（`Error: Test timed out in 5000ms`）；windowsPlatform 注入例在 vitest（不 typecheck）运行期为 `undefined`、行为与 posix 一致而假绿——**真红信号来自 FIFO 阻塞**，windows 例属双平台均成立的弱断言（判别性验证在重构后全绿阶段）。

- [ ] **Step 3: 重构实现 `safe-open.ts`**——删除 `isPosix` 模块常量，新增平台层与统一算法：

```ts
import { constants } from 'fs'
import { lstat, open, realpath } from 'fs/promises'
import { relative } from 'path'
import type { FileHandle } from 'fs/promises'

export class SafeOpenError extends Error {
  constructor(message: string) { super(message); this.name = 'SafeOpenError' }
}
export class SafeOpenConflictError extends SafeOpenError {}

export interface SafeOpenOptions {
  mode: 'create' | 'existing'
  purpose: 'append' | 'read'
  safeRoot: string
  onConflict?: 'fallback' | 'error'
}
export interface SafeOpenResult { fd: FileHandle; created: boolean }

/** 平台差异抽象（决策 A1）：Windows 语义可注入，Linux 单测覆盖两条分支 */
export interface SafeOpenPlatform {
  readonly kind: 'posix' | 'windows'
  readonly createFlags: number        // O_CREAT|O_EXCL|O_WRONLY（posix 追加 O_NOFOLLOW）
  readonly existingReadFlags: number  // O_RDONLY（posix 追加 O_NOFOLLOW|O_NONBLOCK）
  readonly existingWriteFlags: number // O_WRONLY|O_APPEND（posix 追加 O_NOFOLLOW|O_NONBLOCK）
  readonly preOpenLstat: boolean      // windows：open 前 lstat 拒 symlink（无 O_NOFOLLOW）
  readonly checkModeMask: boolean     // posix：existing 校验权限位；windows 跳过（NTFS 合成）
}

export const posixPlatform: SafeOpenPlatform = {
  kind: 'posix',
  createFlags: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
  existingReadFlags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  existingWriteFlags: constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  preOpenLstat: false,
  checkModeMask: true
}

export const windowsPlatform: SafeOpenPlatform = {
  kind: 'windows',
  createFlags: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  existingReadFlags: constants.O_RDONLY,
  existingWriteFlags: constants.O_WRONLY | constants.O_APPEND,
  preOpenLstat: true,
  checkModeMask: false
}

export function defaultSafeOpenPlatform(): SafeOpenPlatform {
  return process.platform === 'win32' ? windowsPlatform : posixPlatform
}

async function assertContained(filePath: string, safeRoot: string): Promise<void> {
  const real = await realpath(filePath).catch(() => { throw new SafeOpenError(`${filePath} 无法解析真实路径`) })
  const rel = relative(safeRoot, real)
  if (rel.startsWith('..') || rel.includes('..')) throw new SafeOpenError(`${filePath} 逃逸安全根`)
}

/** pre-open lstat（windows）：ENOENT 按模式分流、symlink 拒、其他转安全错误 */
async function preOpenCheck(filePath: string, mode: SafeOpenOptions['mode']): Promise<void> {
  let st
  try {
    st = await lstat(filePath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      if (mode === 'create') return // create+ENOENT：放行进入 O_CREAT|O_EXCL
      throw e // existing+ENOENT：原样抛原始 errno（不得包 SafeOpenError，readFile 据此判「文件不存在」）
    }
    throw new SafeOpenError(`${filePath} 无法检查`)
  }
  if (st.isSymbolicLink()) throw new SafeOpenError(`${filePath} 为符号链接`)
}

export async function openSafeFile(filePath: string, opts: SafeOpenOptions, platform: SafeOpenPlatform = defaultSafeOpenPlatform()): Promise<SafeOpenResult> {
  const onConflict = opts.onConflict ?? 'fallback'
  if (platform.preOpenLstat) await preOpenCheck(filePath, opts.mode)
  const flags = opts.mode === 'create'
    ? platform.createFlags
    : opts.purpose === 'read' ? platform.existingReadFlags : platform.existingWriteFlags
  let fd: FileHandle
  let created = false
  try {
    if (opts.mode === 'create') {
      try {
        fd = await open(filePath, flags, 0o600)
        created = true
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          if (onConflict === 'error') throw new SafeOpenConflictError(`${filePath} 已存在`)
          fd = await open(filePath, opts.purpose === 'read' ? platform.existingReadFlags : platform.existingWriteFlags)
        } else throw new SafeOpenError(`${filePath} 打开失败（可能是符号链接）`)
      }
    } else {
      fd = await open(filePath, flags)
    }
  } catch (e: unknown) {
    if (e instanceof SafeOpenError) throw e
    if (opts.mode === 'existing' && (e as NodeJS.ErrnoException).code === 'ENOENT') throw e // 保留 ENOENT
    throw new SafeOpenError(`${filePath} 打开失败`)
  }
  try {
    const st = await fd.stat()
    if (!st.isFile()) throw new SafeOpenError(`${filePath} 非普通文件`) // 统一不变量：拒 FIFO/socket/目录/device
    if (created) await fd.chmod(0o600) // 兜底修正 umask
    else if (platform.checkModeMask) {
      const mask = opts.purpose === 'read' ? 0o400 : 0o600
      if ((st.mode & mask) !== mask || (st.mode & 0o077) !== 0) {
        throw new SafeOpenError(`${filePath} 权限不正确（需 ${opts.purpose === 'read' ? '0400' : '0600'}，无 group/other 位）`)
      }
    }
    await assertContained(filePath, opts.safeRoot)
    return { fd, created }
  } catch (e: unknown) {
    await fd.close().catch(() => {})
    throw e
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/safe-open.spec.ts`
Expected: 全部通过（既有 9 例 + 新增 11 例）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/persistence/safe-open.ts apps/desktop/tests/unit/safe-open.spec.ts
git commit -m "fix(阶段0/1批次A T1): safe-open 平台层+普通文件不变量(P0-01 Windows ENOENT/P1-02 FIFO)"
```

---

### Task 2: `EMPTY_FILE` 工厂化（FE-S1-P2-02）

**Files:**
- Modify: `apps/desktop/src/main/credentials/credential-store.ts`
- Test: `apps/desktop/tests/unit/credential-store.spec.ts`

**Interfaces:**
- Produces: `export function createEmptyFile(): CredentialFileSchemaV1`（删除模块级 `const EMPTY_FILE`）
- Consumes: 无。

- [ ] **Step 1: 写失败测试**——`credential-store.spec.ts` 追加 `describe('EMPTY_FILE 工厂', ...)`：

```ts
import { createEmptyFile } from '../../src/main/credentials/credential-store'

describe('EMPTY_FILE 工厂', () => {
  it('createEmptyFile 每次返回全新对象', () => {
    const a = createEmptyFile()
    const b = createEmptyFile()
    expect(a).not.toBe(b)
    a.keys['backend.token'] = { enc: 'x', algo: 'safeStorage' }
    expect(b.keys).toEqual({})
  })
  it('多 key 损坏重建互不污染（自定义 allowlist）', async () => {
    const allow = (k: string) => k === 'backend.token' || k.startsWith('model.')
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-mk-'))
    const file = join(root, 'credentials.json')
    const storeA = new CredentialStore(file, fakeSafe(), allow, root)
    const storeB = new CredentialStore(file, fakeSafe(), allow, root)
    await storeA.setCredential('backend.token', 'a')
    await storeA.setCredential('model.llm.key', 'llm')
    writeFileSync(file, '{corrupt', { mode: 0o600 })
    await storeB.setCredential('model.stt.key', 'stt')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.keys['model.stt.key']).toBeTruthy()
    expect(raw.keys['backend.token']).toBeUndefined()
    expect(raw.keys['model.llm.key']).toBeUndefined()
  })
  it('两个 Store 单 key 损坏重建回归守卫', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-2s-'))
    const file = join(root, 'credentials.json')
    const storeA = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    const storeB = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    await storeA.setCredential('backend.token', 'a')
    writeFileSync(file, '{corrupt', { mode: 0o600 })
    await storeB.setCredential('backend.token', 'b')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.keys['backend.token'].enc).toBe(Buffer.from('enc:b').toString('base64'))
  })
  it('两个 Store 单 key 损坏重建回归守卫（clear 变体）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-cl-'))
    const file = join(root, 'credentials.json')
    const storeA = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    const storeB = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    await storeA.setCredential('backend.token', 'a')
    writeFileSync(file, '{corrupt', { mode: 0o600 })
    await storeB.clearCredential('backend.token')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw).toEqual({ version: 1, keys: {} })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/credential-store.spec.ts`
Expected: 任务失败——`createEmptyFile` 缺失在 vitest 运行期抛 `TypeError`（vitest 不 typecheck，非编译错）；多 key 例在现状单例上带旧 key 回写而断言红。

- [ ] **Step 3: 实现工厂**

```ts
/** 工厂化（整改 FE-S1-P2-02）：每次全新对象，损坏重建不污染模块单例/其他 Store */
export function createEmptyFile(): CredentialFileSchemaV1 { return { version: 1, keys: {} } }
```
删除 `const EMPTY_FILE: CredentialFileSchemaV1 = { version: 1, keys: {} }`；`setCredential`/`clearCredential` 两处 `?? EMPTY_FILE` 改 `?? createEmptyFile()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/credential-store.spec.ts`
Expected: 既有 + 新增全部通过。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/credentials/credential-store.ts apps/desktop/tests/unit/credential-store.spec.ts
git commit -m "fix(阶段0/1批次A T2): EMPTY_FILE 工厂化(P2-02 多key损坏重建不污染)"
```

---

### Task 3: CredentialStore platform 注入 + close/drain（FE-S1-P1-03 store + P0-01 e2e）

**Files:**
- Modify: `apps/desktop/src/main/credentials/credential-store.ts`
- Modify: `apps/desktop/src/shared/errors/index.ts`
- Test: `apps/desktop/tests/unit/credential-store.spec.ts`

**Interfaces:**
- Consumes: `SafeOpenPlatform` / `defaultSafeOpenPlatform`（T1）
- Produces:
  - `CredentialStore` 构造第 5 参 `platform?: SafeOpenPlatform`
  - `close(): Promise<void>`（幂等）
  - `CyreneErrorCode.CREDENTIAL_STORE_CLOSED`

- [ ] **Step 1: 写失败测试**——`credential-store.spec.ts` 追加 `describe('close / drain + platform 注入', ...)`：

```ts
import { windowsPlatform } from '../../src/main/persistence/safe-open'

describe('close / drain + platform 注入', () => {
  it('close 后 setCredential 抛 CREDENTIAL_STORE_CLOSED', async () => {
    const s = makeStore()
    await s.close()
    await expect(s.setCredential('backend.token', 'x')).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_STORE_CLOSED })
  })
  it('close 等待在途写完成后返回且重启可读', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-drain-'))
    const file = join(root, 'credentials.json')
    const s = new CredentialStore(file, fakeSafe(), isKeyAllowed, root)
    const p = s.setCredential('backend.token', 'tok') // 已接纳入队
    await s.close() // 等待落盘
    await p
    const s2 = new CredentialStore(file, fakeSafe(), isKeyAllowed, root) // 同文件新实例
    expect(await s2.getCredential('backend.token')).toBe('tok')
  })
  it('close 清缓存 → close 后 getCredential 为 null', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'tok')
    await s.close()
    expect(await s.getCredential('backend.token')).toBe(null)
  })
  it('close 幂等（二次调用同一 promise）', async () => {
    const s = makeStore()
    const c1 = s.close()
    const c2 = s.close()
    expect(c1).toBe(c2)
    await c1
  })
  it('windowsPlatform 注入端到端：干净文件 getStatus empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-win-'))
    const s = new CredentialStore(join(root, 'credentials.json'), fakeSafe(), isKeyAllowed, root, windowsPlatform)
    expect(await s.getStatus('backend.token')).toBe('empty')
  })
  it('windowsPlatform 注入端到端：set 后新 Store 实例可读回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cy-creds-win2-'))
    const file = join(root, 'credentials.json')
    const s = new CredentialStore(file, fakeSafe(), isKeyAllowed, root, windowsPlatform)
    await s.setCredential('backend.token', 'tok')
    const s2 = new CredentialStore(file, fakeSafe(), isKeyAllowed, root, windowsPlatform)
    expect(await s2.getCredential('backend.token')).toBe('tok')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/credential-store.spec.ts`
Expected: 任务失败——`close`/`CREDENTIAL_STORE_CLOSED` 缺失在 vitest 运行期抛 `TypeError`（vitest 不 typecheck，非编译错）。

- [ ] **Step 3: 实现**——`shared/errors/index.ts` 枚举加：

```ts
  UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION',
  CREDENTIAL_STORE_CLOSED = 'CREDENTIAL_STORE_CLOSED',
```
`credential-store.ts`：

```ts
export class CredentialStore {
  private queue: Promise<unknown> = Promise.resolve()
  private cache = new Map<string, string>()
  private closed = false
  private closePromise: Promise<void> | null = null

  constructor(
    private readonly filePath: string,
    private readonly safe: SafeStorageLike,
    private readonly isKeyAllowed: (key: string) => boolean,
    private readonly safeRoot: string,
    private readonly platform?: SafeOpenPlatform
  ) {}

  /** 关闭：拒绝新写 → 等待已接纳操作落盘 → 清明文 cache；幂等 */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true
      await this.queue
      this.cache.clear()
    })()
    return this.closePromise
  }
```
`readFile()` 内 `openSafeFile` 透传平台：
```ts
      const r = await openSafeFile(this.filePath, { mode: 'existing', purpose: 'read', safeRoot: this.safeRoot }, this.platform)
```
`setCredential`/`clearCredential` 顶部（enqueue 前）：
```ts
    if (this.closed) throw new CyreneError(CyreneErrorCode.CREDENTIAL_STORE_CLOSED, '凭据存储已关闭')
```
`getStatus` 顶部：`if (this.closed) return 'unavailable'`；`getCredential` 顶部：`if (this.closed) return null`。
顶部 import 追加：`import type { SafeOpenPlatform } from '../persistence/safe-open'`（`readFile` 内的 `openSafeFile` 动态 import 保留，类型 import 静态）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/credential-store.spec.ts`
Expected: 既有 + 新增全部通过。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/errors/index.ts apps/desktop/src/main/credentials/credential-store.ts apps/desktop/tests/unit/credential-store.spec.ts
git commit -m "fix(阶段0/1批次A T3): CredentialStore close/drain+platform注入(P1-03/P0-01 e2e)"
```

---

### Task 4: shutdown.ts 有序退出 + 超时标记 + fatal 助手（FE-S1-P1-03 shutdown）

**Files:**
- Modify: `apps/desktop/src/main/shutdown.ts`（重构）
- Test: `apps/desktop/tests/unit/shutdown.spec.ts`（适配 + 新增）

**Interfaces:**
- Produces（T5 消费）:
  - `export const SHUTDOWN_TIMEOUT_MS = 1500`
  - `export interface ShutdownStep { name: string; run(): Promise<void> }`
  - `export interface ShutdownDeps { steps: ShutdownStep[]; quit(): void; timeoutMs?: number; onTimeout?(): void; onError?(step: string, err: unknown): void }`
  - `createShutdownHandler(deps: ShutdownDeps): (e: { preventDefault(): void }) => void`
  - `export interface FatalDeps { showError(message: string): void; closeAll?(): Promise<void>; exit(code: number): void; timeoutMs?: number }`
  - `export function createFatalShutdown(deps: FatalDeps): (message: string) => void`
- Consumes: 无。

- [ ] **Step 1: 适配既有 5 例 + 写新增失败测试**——`shutdown.spec.ts` 整体改写：

```ts
import { describe, expect, it, vi } from 'vitest'
import { createShutdownHandler, createFatalShutdown, type ShutdownDeps } from '../../src/main/shutdown'

function makeDeps(over: Partial<ShutdownDeps> & { closeAll?: () => Promise<void> } = {}) {
  const steps = over.steps ?? [{ name: 'all', run: over.closeAll ?? (async () => {}) }]
  return { steps, quit: over.quit ?? vi.fn(), timeoutMs: over.timeoutMs, onTimeout: over.onTimeout, onError: over.onError } as ShutdownDeps
}
const ev = () => ({ preventDefault: vi.fn() })

describe('createShutdownHandler（before-quit）', () => {
  it('首次事件：preventDefault + 触发 flush，完成后 quit', async () => {
    const deps = makeDeps()
    const h = createShutdownHandler(deps)
    const e = ev()
    h(e)
    expect(e.preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
  })
  it('flushing 期间二次事件：preventDefault 但不重复 flush', async () => {
    let resolveClose: () => void = () => {}
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>((r) => { resolveClose = r })) })
    const h = createShutdownHandler(deps)
    h(ev()); h(ev())
    expect(deps.steps[0].run).toHaveBeenCalledTimes(1)
    resolveClose()
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
  })
  it('flush 完成后最终 quit 的事件：不再 preventDefault（allowQuit 放行）', async () => {
    const deps = makeDeps()
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    const e2 = ev()
    h(e2)
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })
  it('step 抛错仍 quit 且 onError 收到 step 名、后续 step 仍执行', async () => {
    const onError = vi.fn()
    const order: string[] = []
    const deps = makeDeps({
      steps: [
        { name: 'bad', run: async () => { throw new Error('boom') } },
        { name: 'good', run: async () => { order.push('good') } }
      ],
      onError
    })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    expect(onError).toHaveBeenCalledWith('bad', expect.any(Error))
    expect(order).toEqual(['good'])
  })
  it('step 挂起 → 超时后仍 quit（race）', async () => {
    const onTimeout = vi.fn()
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>(() => {})), timeoutMs: 20, onTimeout })
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled(), { timeout: 200 })
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })
  it('steps 按序执行', async () => {
    const order: string[] = []
    const deps = makeDeps({ steps: [{ name: 'a', run: async () => { order.push('a') } }, { name: 'b', run: async () => { order.push('b') } }] })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    expect(order).toEqual(['a', 'b'])
  })
  it('慢但完成的 step + 短 timeout → onTimeout 不触发（无残留计时器）、quit 一次', async () => {
    const onTimeout = vi.fn()
    const deps = makeDeps({ steps: [{ name: 'slow', run: async () => { await new Promise((r) => setTimeout(r, 10)) } }], timeoutMs: 20, onTimeout })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    expect(onTimeout).not.toHaveBeenCalled()
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })
  it('step 1 挂起 → onTimeout 触发、quit 一次、step 2 不启动、audit 写入被调用', async () => {
    const audit = vi.fn(async () => {})
    const onTimeout = vi.fn(() => { void audit() })
    const step2 = vi.fn(async () => {})
    const deps = makeDeps({
      steps: [{ name: 'hang', run: () => new Promise<void>(() => {}) }, { name: 'never', run: step2 }],
      timeoutMs: 20,
      onTimeout
    })
    createShutdownHandler(deps)(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled(), { timeout: 200 })
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(step2).not.toHaveBeenCalled()
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })
})

describe('createFatalShutdown', () => {
  it('无 closeAll → 直接 exit(1)', () => {
    const exit = vi.fn()
    createFatalShutdown({ showError: () => {}, exit })('boom')
    expect(exit).toHaveBeenCalledWith(1)
  })
  it('closeAll 完成 → 完成后 exit(1)', async () => {
    const exit = vi.fn()
    const closeAll = vi.fn(async () => {})
    createFatalShutdown({ showError: () => {}, closeAll, exit })('boom')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  })
  it('closeAll 挂起 → 超时后仍 exit(1)', async () => {
    const exit = vi.fn()
    const closeAll = vi.fn(() => new Promise<void>(() => {}))
    createFatalShutdown({ showError: () => {}, closeAll, exit, timeoutMs: 20 })('boom')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 200 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/shutdown.spec.ts`
Expected: 任务失败——`createFatalShutdown` 缺失在 vitest 运行期抛 `TypeError`；新 makeDeps 无 `closeAll` 而旧实现调 `deps.closeAll()` 抛 `TypeError`，handler 各例几乎全挂；旧实现超时回调无 onTimeout，新 onTimeout 断言红。

- [ ] **Step 3: 实现 `shutdown.ts`**

```ts
export const SHUTDOWN_TIMEOUT_MS = 1500

export interface ShutdownStep { name: string; run(): Promise<void> }
export interface ShutdownDeps {
  steps: ShutdownStep[]
  quit(): void
  timeoutMs?: number // 默认 SHUTDOWN_TIMEOUT_MS
  onTimeout?(): void // 超时标记（main 装配写同步 audit + warn；持久记录）
  onError?(step: string, err: unknown): void
}

/**
 * before-quit 有序 flush（决策 A2 / 整改 FE-S1-P1-03）：
 * 每步独立 try/catch（onError 不阻断后续）；循环顶 timedOut 检查——超时后不再启动新 step；
 * race(runAll, timeout)：runAll 正常完成 → finally clearTimeout（无残留计时器）+ quit；
 * 超时先到 → timedOut=true + onTimeout() → finally quit（即使 step 挂起）；allowQuit 只放行一次 quit。
 */
export function createShutdownHandler(deps: ShutdownDeps): (e: { preventDefault(): void }) => void {
  let flushing = false
  let allowQuit = false
  return (e) => {
    if (allowQuit) return
    e.preventDefault()
    if (flushing) return
    flushing = true
    let timedOut = false
    let resolveTimeout: () => void = () => {}
    const timeoutPromise = new Promise<void>((r) => { resolveTimeout = r })
    const timer = setTimeout(() => {
      timedOut = true
      try { deps.onTimeout?.() } finally { resolveTimeout() } // try/finally：onTimeout 同步抛错也不阻断 quit
    }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS)
    const runAll = async (): Promise<void> => {
      for (const s of deps.steps) {
        if (timedOut) return
        try { await s.run() } catch (err) { deps.onError?.(s.name, err) }
      }
    }
    void Promise.race([runAll(), timeoutPromise])
      .catch(() => {})
      .finally(() => { clearTimeout(timer); allowQuit = true; deps.quit() })
  }
}

export interface FatalDeps {
  showError(message: string): void
  closeAll?(): Promise<void>
  exit(code: number): void
  timeoutMs?: number // 默认 SHUTDOWN_TIMEOUT_MS
}

/** 统一 fatal：closeAll 存在则 race 超时后无条件 exit(1)（防 closeAll 挂起拖死启动失败路径） */
export function createFatalShutdown(deps: FatalDeps): (message: string) => void {
  return (message: string): void => {
    deps.showError(message)
    if (!deps.closeAll) { deps.exit(1); return }
    void Promise.race([deps.closeAll(), new Promise((r) => setTimeout(r, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS))])
      .catch(() => {})
      .finally(() => deps.exit(1))
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -F @cyrene/desktop test tests/unit/shutdown.spec.ts`
Expected: 全部通过（8 + 3）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/shutdown.ts apps/desktop/tests/unit/shutdown.spec.ts
git commit -m "fix(阶段0/1批次A T4): shutdown 有序退出+超时标记+fatal助手(P1-03)"
```

---

### Task 5: main/index.ts 装配（steps + onTimeout 同步审计 + fatal 接线）

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `store.close()`（T3）、`createShutdownHandler`/`createFatalShutdown`/`SHUTDOWN_TIMEOUT_MS`（T4）、`adapter.disconnect()`（既有）、`diagnostics.auditor.audit`（既有）
- Produces: 无（装配）

- [ ] **Step 1: 改装配**——`main/index.ts`：
  - import 追加：`import { createShutdownHandler, createFatalShutdown } from './shutdown'`、`import type { Diagnostics } from './diagnostics'`；
  - 模块级新增 `let diagnostics: Diagnostics | undefined` 与 `const fatal = createFatalShutdown({ showError: (m) => dialog.showErrorBox('Cyrene 无法启动', m), closeAll: () => (diagnostics ? diagnostics.closeAll() : Promise.resolve()), exit: (c) => app.exit(c) })`；
  - **删除 `main()` 内的局部 `const diagnostics = createDiagnostics(...)`，改为模块级赋值 `diagnostics = createDiagnostics(...)`**（若保留局部 const，模块级恒 undefined，fatal 的 closeAll 静默退化为空操作）；
  - **修复既有 diagnostics 闭包的 TS18048**（`let` 窄化不进闭包）——line 143 `(e) => { void diagnostics.auditor.audit(...) }` 改 `diagnostics?.auditor.audit(...)`；line 163 `ensureMainWindow((err) => diagnostics.logger.error(...))` 改 `diagnostics?.logger.error(...)`；
  - 删除原 `failStart`，调用点逐处改 `fatal(...)`：`rejectForbiddenDebugSwitches` 内 2 处（line 53/58）、`installAppIdentity` catch（line 72）、`setPathOk` 拒绝（line 88）、userData 路径断言（line 93）、main() 内 catch（line 165）、顶层 `void main().catch(...)`（line 175）。**勿动 line 78 的 single-instance `app.exit(0)`**（exit 0 非 failStart，不替换）；
  - before-quit 换新装配：

```ts
app.on('before-quit', createShutdownHandler({
  steps: [
    { name: 'credentials', run: () => store.close() },
    { name: 'adapter', run: () => adapter.disconnect() },
    { name: 'diagnostics', run: () => diagnostics?.closeAll() ?? Promise.resolve() }
  ],
  quit: () => app.quit(),
  onTimeout: () => {
    void diagnostics?.auditor.audit({ ts: new Date().toISOString(), type: 'shutdown:timed-out', summary: '退出超时，最后一批写入可能丢失' })
    diagnostics?.logger.warn('shutdown:timed-out', { message: '退出超时，最后一批写入可能丢失' })
  },
  onError: (step, err) => diagnostics?.logger.error('shutdown:step-failed', { step, message: sanitize(err instanceof Error ? err.message : String(err)) })
}))
```

- [ ] **Step 2: 验证编译与既有套件**

Run: `pnpm -F @cyrene/desktop typecheck` 与 `pnpm -F @cyrene/desktop build`
Expected: 全绿（装配逻辑已被 T4 单测覆盖；main 接线经 typecheck/build 与后续 T6 集成套件验证）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "fix(阶段0/1批次A T5): main 装配——凭据→adapter→diagnostics 有序退出 + onTimeout 同步审计 + fatal 接线"
```

---

### Task 6: 全量门禁确认（无代码）

- [ ] **Step 1: 跑全部门禁**

Run: `pnpm -F @cyrene/desktop typecheck`、`pnpm -F @cyrene/desktop lint`、`pnpm -F @cyrene/desktop test`、`pnpm -F @cyrene/desktop test:integration`、`pnpm -F @cyrene/desktop build`、`pnpm -F @cyrene/desktop check:contract`
Expected: 全部绿；单测 ≥ 433（含本批新增约 20+）、集成 22 不回归；`check:contract` 11/11。

- [ ] **Step 2: 确认无代码变更**

Run: `git status --short`
Expected: 仅无改动或仅有本批 T1-T5 已提交；本任务不产生新 commit。

---

## 自审（对照 spec）

- §4.1 统一算法（pre-open / open / post-open isFile+modeMask+containment）→ T1 完整实现；`existing+ENOENT` 原样抛原始 errno → T1 Step 3 `preOpenCheck` 满足。
- §4.1 验收（FIFO/socket/目录//dev/null/fallback-FIFO/windowsPlatform 注入 5 例）→ T1 Step 1 测试全覆盖。
- §4.2 工厂 + 多 key 互不污染 → T2。
- §4.3 CredentialStore（platform 注入、close 三性质、CREDENTIAL_STORE_CLOSED、Windows 端到端 2 例）→ T3。
- §4.3 shutdown（steps 有序、onError 不阻断、timedOut 停新 step、race+clearTimeout、onTimeout 同步审计持久标记）→ T4。
- §4.3 fatal（closeAll 挂起超时兜底 exit）→ T4 `createFatalShutdown` + T5 接线。
- §4.3 main 装配（凭据→adapter→diagnostics、onTimeout 审计+warn、fatal 统一入口）→ T5。
- 已知限制诚实记录 → T1/T4 注释 + 最终报告。

> **注**：文档同步（README / CLAUDE.md / docs/16 批次 A 状态与测试数字）属 SDD 工作流**后续步骤**（不在本 plan 任务内），实施完成后由控制器执行并保留「已开发、未联调」。
