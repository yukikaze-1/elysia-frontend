# 阶段 0/1 整改·批次 C：审计与持续门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FE-S1-P1-01（凭据 + 连接生命周期接入审计，fail-open）+ FE-S1-P1-04（CI 增 Linux artifact job + Windows 构建级 job）。

**Architecture:** 新增共享 `src/main/diagnostics/safe-audit.ts`（`safeAudit(audit, event)`：每个调用点局部 fail-open，兜注入实现同步抛错——单测可注入抛错 auditor 验证操作不翻转）；`main/index.ts` 装配处建审计包装（ts 统一注入 + `.catch` 记 `audit:write-failed`）；`credentials/index.ts` set/clear/status-change、`chat-service.ts` connect/disconnect、`backend-error-handlers.ts` onError 经 safeAudit 记录事件；集成测试经 IPC 后轮询读真实 `audit/` 文件；CI 增 artifact（package + verify:artifact --smoke + SHA）与 windows（typecheck/lint/unit/build，构建级）job，POSIX 专属单测（safe-open/atomic-write/credential-store/file-writer/user-data-dirs）加平台守卫。

**Tech Stack:** Electron main（Node）+ TypeScript + vitest（unit node 环境 + integration electron）+ GitHub Actions。

## Global Constraints

- 决策 C1（用户拍板）：fail-open——操作成功不假报「保存失败」；审计失败只记 `audit:write-failed` 日志。
- 决策 C2（用户拍板）：审计扩展到连接生命周期（connect/disconnect/错误）。
- 决策 C3（用户拍板）：Windows CI 构建级（install/typecheck/unit/build，不启动 Electron）。
- 审计包装 `audit(event)` 接收 `Omit<AuditEvent, 'ts'>`，**ts 由包装统一注入**（AuditEvent.ts 必填，DRY）；`.catch` 兜 auditor.audit 的 rejection（记 `audit:write-failed`）；**必须定义在 main() 内**（createDiagnostics 后、buildBackendErrorHandlers 前，依赖局部 sanitize）。
- **`safeAudit` 共享帮手**：`src/main/diagnostics/safe-audit.ts`——`safeAudit(audit: ((e) => void) | undefined, event)` 内 try/catch 兜审计回调同步抛错（含注入实现），使 fail-open 在每个调用点 by-construction 成立（单测可注入抛错 auditor 验证操作不翻转）；credentials/chat/backend-error 调用点统一用 `safeAudit(opts.audit, {...})`（而非裸 `audit?.()`）。
- 审计事件 summary 只放 key 名/result/errorCode/backendCode/retryable，**绝不写 Token/完整 query/聊天正文**（auditor 层 redact 兜底）。
- `connection:connect failed` 的 code 归一化非 CyreneError（`err instanceof Error ? (err as { code?: string }).code ?? String(err.message) : String(err)`）。
- endpoint:set 既有审计改走统一 `audit` 包装；shutdown:timed-out 审计保持原样（超时兜底专用）。
- 集成测试读 `<userData>/Cyrene/audit/audit-YYYY-MM-DD.jsonl` 须**轮询**（fire-and-forget 竞态，`expect.poll` 带 timeout 5000/interval 200）。
- CI：artifact job `rm -rf out dist && pnpm --filter @cyrene/desktop package`（package 内含 build）；windows job 跑 typecheck/lint/test/build（不需 electron 二进制）；两 job 各上传 `app-sha*.txt`（`git rev-parse HEAD`）。
- safe-open.spec POSIX 守卫：原 `describe('openSafeFile')` → `describe.skipIf(win32)`；FIFO/socket//dev/null/fallback-FIFO 例 → `it.skipIf(win32)`；windowsPlatform 组 create 例的 0600 断言加 `if (process.platform !== 'win32')`（Windows mode 报 0666）。
- 现有测试全部保持通过；文档仍标「已开发、未联调」；不触碰批次 D 项。

---

### Task 1: 审计 fail-open 包装 + 凭据生命周期审计（FE-S1-P1-01 凭据部分）

**Files:**
- Create: `apps/desktop/src/main/diagnostics/safe-audit.ts`
- Modify: `apps/desktop/src/main/credentials/index.ts`
- Modify: `apps/desktop/src/main/ipc/handlers.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/unit/credentials-ipc.spec.ts`

**Interfaces:**
- Produces（T2 消费 `audit` 包装）: `main/index.ts` 的 `const audit = (event: Omit<AuditEvent, 'ts'>): void`（fail-open 包装）；`registerHandlers` deps 增 `audit`。
- Consumes: `AuditEvent`（`../diagnostics/audit`）。

- [ ] **Step 1: 写失败测试**——`credentials-ipc.spec.ts` 追加 `describe('审计（FE-S1-P1-01）')`，并让 `makeExecutors` 支持注入 audit：

```ts
function makeExecutorsWithAudit(store: unknown, audit = vi.fn()) {
  return { executors: createCredentialsExecutors(store as CredentialStore, { logger: fakeLogger, sanitize: noopSanitize, audit }), audit }
}

describe('审计（FE-S1-P1-01）', () => {
  it('set 成功 → audit credential:set success', async () => {
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const { executors, audit } = makeExecutorsWithAudit(store)
    await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:set', status: 'success' }))
  })
  it('set 失败 → audit credential:set failed + 原错误仍返回（不吞错）', async () => {
    const store = {
      getStatus: vi.fn(async () => 'unavailable'),
      setCredential: vi.fn(async () => { throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '钥匙串不可用') })
    }
    const { executors, audit } = makeExecutorsWithAudit(store)
    const res = await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:set', status: 'failed', summary: expect.stringContaining('CREDENTIAL_UNAVAILABLE') }))
    expect(res).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE' } })
  })
  it('set 后 status 变化 → audit credential:status-change', async () => {
    const store = { getStatus: vi.fn(async () => 'available').mockResolvedValueOnce('empty'), setCredential: vi.fn(async () => {}) }
    const { executors, audit } = makeExecutorsWithAudit(store)
    await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:status-change', summary: expect.stringContaining('from=empty') }))
  })
  it('clear 成功 → audit credential:clear success', async () => {
    const store = { getStatus: vi.fn(async () => 'empty'), clearCredential: vi.fn(async () => {}) }
    const { executors, audit } = makeExecutorsWithAudit(store)
    await executors.clear({ key: BACKEND_TOKEN_KEY })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'credential:clear', status: 'success' }))
  })
  it('audit 抛错 → set 仍 ok:true（fail-open 不翻转操作结果）', async () => {
    const store = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const { executors } = makeExecutorsWithAudit(store, vi.fn(() => { throw new Error('audit boom') }))
    const res = await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toEqual({ ok: true, data: { status: 'available', key: 'backend.token' } })
  })
  it('set 失败且 audit 抛错 → 仍返回原错误（audit 不替换错误）', async () => {
    const store = {
      getStatus: vi.fn(async () => 'unavailable'),
      setCredential: vi.fn(async () => { throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '钥匙串不可用') })
    }
    const { executors } = makeExecutorsWithAudit(store, vi.fn(() => { throw new Error('audit boom') }))
    const res = await executors.set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE' } })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/credentials-ipc.spec.ts`
Expected: 任务失败——`audit` 未被调用（现状 set/clear 只 logger.info），4 个新例红。

- [ ] **Step 3: 实现**

**新建 `src/main/diagnostics/safe-audit.ts`**（每个调用点局部 fail-open，兜注入实现同步抛错）：

```ts
// src/main/diagnostics/safe-audit.ts
import type { AuditEvent } from './audit'
/** fail-open（C1）：audit 回调（含注入实现同步抛错）失败不传播——调用方操作结果不受影响 */
export function safeAudit(audit: ((event: Omit<AuditEvent, 'ts'>) => void) | undefined, event: Omit<AuditEvent, 'ts'>): void {
  if (!audit) return
  try { audit(event) } catch { /* fail-open：审计失败不改变操作结果 */ }
}
```

`credentials/index.ts`：
- import 追加 `import { safeAudit } from '../diagnostics/safe-audit'`；
- `createCredentialsExecutors` opts 增 `audit?: (event: Omit<AuditEvent, 'ts'>) => void`；
- `maybeLogStatusChange` 改签名收 opts（含 audit）并在既有 try/catch 内同时做 logger.info + `safeAudit(opts.audit, { type: 'credential:status-change', summary: 'key=${key} from=${before} to=${after}' })`（隔离天然保留）；
- `set` executor 包 try/catch：成功路径（现有 body 内）在 `logger.info` 后加 `safeAudit(opts.audit, { type: 'credential:set', status: 'success', summary: 'key=${req.key}' })`，`maybeLogStatusChange` 改传 `opts`；catch 里 `safeAudit(opts.audit, { type: 'credential:set', status: 'failed', summary: 'key=${req.key} code=${(e as { code?: string }).code ?? 'UNKNOWN'}' })` + `throw e`；
- `clear` executor 同构（`credential:clear`）；
- `registerCredentialsHandlers(store, opts, connConfig?)` 透传 `opts.audit`。

`handlers.ts`：
- `registerHandlers(deps)` 增 `audit?: (event: Omit<AuditEvent, 'ts'>) => void`；透传 `registerCredentialsHandlers(deps.credentials, { logger, sanitize, audit: deps.audit }, deps.connectionConfig)`。

`index.ts`：
- import 追加 `import type { AuditEvent } from './diagnostics/audit'`；
- 在 `createDiagnostics`（:105）之后、`buildBackendErrorHandlers`（:131）之前建包装：

```ts
    /** 审计 fail-open（C1）：fire-and-forget；外层 try/catch 兜注入实现同步抛错；ts 统一注入；可选链防 TS18048 */
    const audit = (event: Omit<AuditEvent, 'ts'>): void => {
      try {
        void diagnostics?.auditor?.audit({ ts: new Date().toISOString(), ...event }).catch((err) =>
          diagnostics?.logger.error('audit:write-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) })
        )
      } catch { /* fail-open 恒成立 */ }
    }
```
- endpoint:set 回调（:157）改 `(e) => { audit({ type: 'endpoint:set', summary: e.origin }) }`；
- `registerHandlers({ credentials: store, logger: diagnostics.logger, chat: chatSvc, connectionConfig: connConfig, audit })`。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm -F @cyrene/desktop test tests/unit/credentials-ipc.spec.ts` 与 `pnpm -F @cyrene/desktop typecheck`
Expected: 既有 + 新增（6 例总新增：4 审计 + 2 fail-open）全绿；typecheck 无 TS18048（包装用 `diagnostics?.`）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/diagnostics/safe-audit.ts apps/desktop/src/main/credentials/index.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/credentials-ipc.spec.ts
git commit -m "fix(阶段0/1批次C T1): safeAudit fail-open 帮手 + 凭据生命周期审计(credential set/clear/status-change)"
```

---

### Task 2: 连接生命周期审计（C2）

**Files:**
- Modify: `apps/desktop/src/main/chat/chat-service.ts`
- Modify: `apps/desktop/src/main/chat/backend-error-handlers.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/unit/chat-service.spec.ts`、`apps/desktop/tests/unit/backend-error-handlers.spec.ts`

**Interfaces:**
- Consumes: `audit` 包装（T1）
- Produces: `ChatServiceDeps.audit?`、`BackendErrorHandlerDeps.audit?`

- [ ] **Step 1: 写失败测试**

`chat-service.spec.ts` 追加：
```ts
  it('connect 成功 → audit connection:connect connected', async () => {
    const { deps } = makeDeps({ audit: vi.fn() })
    const svc = createChatService(deps)
    await svc.connect()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection:connect', status: 'connected', summary: 'mode=mock' }))
    svc.dispose()
  })
  it('connect 失败 → audit connection:connect failed + rethrow', async () => {
    const { deps } = makeDeps({ requireToken: true, audit: vi.fn() })
    const svc = createChatService(deps)
    await expect(svc.connect()).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection:connect', status: 'failed' }))
  })
  it('disconnect → audit connection:disconnect', async () => {
    const { deps } = makeDeps({ audit: vi.fn() })
    const svc = createChatService(deps)
    await svc.disconnect()
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection:disconnect', summary: 'mode=mock' }))
    svc.dispose()
  })
```
（`makeDeps` 的 `...overrides` 已把 `audit` 并入 deps；`deps.audit` 即 vi.fn。）

`backend-error-handlers.spec.ts` 追加：
```ts
  it('onError → audit connection:error（含 backendCode/retryable，summary 无原始 details）', () => {
    const logger = makeLogger()
    const audit = vi.fn()
    const h = buildBackendErrorHandlers({ logger, sanitize: noopSanitize, send: vi.fn(), mode: 'real', getBuild: () => ({}), audit })
    h.onError(new CyreneError(CyreneErrorCode.BACKEND_REJECTED, '队列满', { backendCode: 'QUEUE_FULL', retryable: true }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection:error', summary: expect.stringContaining('BACKEND_REJECTED') }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining('QUEUE_FULL') }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining('retryable') }))
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-service.spec.ts tests/unit/backend-error-handlers.spec.ts`
Expected: 任务失败——audit 未被调用，3+1 个新例红。

- [ ] **Step 3: 实现**

`chat-service.ts`：
- import 追加 `import { safeAudit } from '../diagnostics/safe-audit'`；`ChatServiceDeps` 增 `audit?: (event: Omit<AuditEvent, 'ts'>) => void`；
- `connect()` 包整体 try/catch，real/mock 两分支各在 `pushState` 后、`return` 前加 `safeAudit(deps.audit, { type: 'connection:connect', status: 'connected', summary: 'mode=real' })` / `'mode=mock'`（**写死分支值**——`deps.requireToken` 在分支内被收窄，`!== false ? 'real' : 'mock'` 触发 TS2367）；catch 里 `safeAudit(deps.audit, { type: 'connection:connect', status: 'failed', summary: 'code=${e instanceof Error ? (e as { code?: string }).code ?? String(e.message) : String(e)}' })` + `throw e`；
- `disconnect()`：`await adapter.disconnect(); pushState(...)` 后加 `safeAudit(deps.audit, { type: 'connection:disconnect', summary: 'mode=${deps.requireToken !== false ? 'real' : 'mock'}' })`（disconnect 内无收窄，表达式可保留）。

`backend-error-handlers.ts`：
- import 追加 `import { safeAudit } from '../diagnostics/safe-audit'`；`BackendErrorHandlerDeps` 增 `audit?: (event: Omit<AuditEvent, 'ts'>) => void`；
- `onError` 内 `deps.send(...)` 后加：`safeAudit(deps.audit, { type: 'connection:error', summary: 'code=${err.code}' + (pub.backendCode ? ' backend=${pub.backendCode}' : '') + (pub.retryable ? ' retryable' : '') })`。

`index.ts`：
- `buildBackendErrorHandlers({ ..., audit })`、`createChatService({ adapter, send, getToken, requireToken, connectionConfig, packaged, audit })`。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm -F @cyrene/desktop test tests/unit/chat-service.spec.ts tests/unit/backend-error-handlers.spec.ts` 与 `pnpm -F @cyrene/desktop typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/chat/chat-service.ts apps/desktop/src/main/chat/backend-error-handlers.ts apps/desktop/src/main/index.ts apps/desktop/tests/unit/chat-service.spec.ts apps/desktop/tests/unit/backend-error-handlers.spec.ts
git commit -m "fix(阶段0/1批次C T2): 连接生命周期审计(connection connect/disconnect/error)"
```

---

### Task 3: 审计应用装配集成测试（FE-S1-P1-01 必须修改 #4）

**Files:**
- Create: `apps/desktop/tests/integration/audit-lifecycle.spec.ts`

**Interfaces:**
- Consumes: T1/T2 装配（审计写盘）

- [ ] **Step 1: 写测试**

```ts
// tests/integration/audit-lifecycle.spec.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ElectronApplication, Page } from 'playwright'
import { launchApp, closeApp } from './helpers/app'

let app: ElectronApplication
let page: Page
let userData: string
beforeAll(async () => { ({ app, page, userData } = await launchApp()) })
afterAll(async () => { await closeApp({ app, page, userData }) })

const auditFile = (): string => {
  const now = new Date()
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return join(userData, 'Cyrene', 'audit', `audit-${key}.jsonl`)
}

describe('审计应用装配（FE-S1-P1-01 #4）', () => {
  it('IPC credential set/clear 后 audit/ 出现 credential:set/clear 行', async () => {
    await page.evaluate(async () => {
      const initial = await window.desktopApi.getCredentialStatus()
      try {
        await window.desktopApi.setEndpoint('http://127.0.0.1:8765')
        await window.desktopApi.setBackendToken('sk-test-token')
      } catch { /* safeStorage 不可用分支：审计仍写 credential:set failed */ }
      try { await window.desktopApi.clearBackendToken() } catch { /* 同 */ }
      void initial
    })
    // 轮询（fire-and-forget 竞态）：断言 set 与 clear 行都出现
    await expect.poll(() => { try { return readFileSync(auditFile(), 'utf8') } catch { return '' } }, { timeout: 5000, interval: 200 })
      .toContain('credential:set')
    await expect.poll(() => { try { return readFileSync(auditFile(), 'utf8') } catch { return '' } }, { timeout: 5000, interval: 200 })
      .toContain('credential:clear')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `xvfb-run -a pnpm -F @cyrene/desktop test:integration`（或过滤该文件）
Expected: 新 spec 红（audit 未接线），既有 22 例不回归。

- [ ] **Step 3: 确认 T1/T2 接线后通过**

Run: `xvfb-run -a pnpm -F @cyrene/desktop test:integration`
Expected: 新 spec 绿（audit 文件轮询到 `credential:set` + `credential:clear`）+ 既有 22 例绿。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/integration/audit-lifecycle.spec.ts
git commit -m "test(阶段0/1批次C T3): 审计应用装配集成测试——IPC set/clear 后 audit/ JSONL 轮询断言"
```

---

### Task 4: CI 持续门禁（FE-S1-P1-04）+ safe-open POSIX 守卫

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/desktop/tests/unit/safe-open.spec.ts`

**Interfaces:**
- 无跨任务接口。

- [ ] **Step 1: 改 safe-open.spec.ts 平台守卫**

- 原 `describe('openSafeFile', () => {` → `describe.skipIf(process.platform === 'win32')('openSafeFile', () => {`（9 例 mode 掩码/symlink/逃逸全 POSIX 语义）；
- 新 describe 内 POSIX 原生例改 `it.skipIf(process.platform === 'win32')`：`0600 FIFO existing+read`、`0600 FIFO existing+append`、`Unix socket`、`/dev/null`、`create 遇既有 FIFO fallback`。**守卫理由**：mode 掩码（Windows stat.mode 报 0666）与 symlink/socket（权限/命名管道语义）会红；mkfifo/`/dev/null`（命令/路径缺失→ENOENT）是**假绿**（失去断言意义）——守卫为保留真语义而非只防红；
- windowsPlatform 组 `create+ENOENT 成功首建` 例的 0600 断言加平台守卫：
```ts
    const st = await r.fd.stat()
    expect(st.isFile()).toBe(true)
    if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600) // Windows stat.mode 报 0666，0600 仅 POSIX 有意义
```
- **同类 Windows 守卫扩散到其余 4 个有 mode/权限断言的单测文件**（否则 windows job 首跑即红）：
  - `tests/unit/atomic-write.spec.ts` 的 `statSync(p).mode & 0o777).toBe(0o600)` → `if (process.platform !== 'win32') expect(...)`；
  - `tests/unit/credential-store.spec.ts` 的同款 0600 断言 → 同上；
  - `tests/unit/file-writer.spec.ts` 的同款 0600 断言 → 同上；
  - `tests/unit/user-data-dirs.spec.ts` 的 `chmodSync(base, 0o755)` 后 expect reject 例（权限检查在 `if (isPosix)` 内，Windows 跳过 → 不 reject）→ `it.skipIf(process.platform === 'win32')`。

- [ ] **Step 2: 跑 safe-open 确认 Linux 不回归**

Run: `pnpm -F @cyrene/desktop test tests/unit/safe-open.spec.ts`
Expected: 全绿（Linux 下 skipIf(false)，全部照跑）。

- [ ] **Step 3: 改 ci.yml 增两 job**（追加大文件现有 3 job 之后；YAML 用 block 风格 with）

```yaml
  # 打包态安全冒烟：clean → package（内含 electron-vite build）→ verify:artifact --smoke（P0-02 验收 A6 持续化）
  artifact:
    name: packaged artifact smoke
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.20.0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Cache Electron binary
        uses: actions/cache@v4
        with:
          path: ~/.cache/electron
          key: electron-cache-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: electron-cache-${{ runner.os }}-

      - name: Ensure Electron binary
        run: pnpm --filter @cyrene/desktop ensure:electron

      - name: Install Playwright (artifact smoke)
        run: pnpm --filter @cyrene/desktop exec playwright install --with-deps chromium

      - name: Clean + package (fresh out/dist)
        run: rm -rf out dist && pnpm --filter @cyrene/desktop package

      - name: Record app SHA
        run: git rev-parse HEAD > app-sha.txt

      - name: Upload SHA evidence
        uses: actions/upload-artifact@v4
        with:
          name: app-sha
          path: app-sha.txt

      - name: Artifact smoke (xvfb)
        run: xvfb-run -a pnpm --filter @cyrene/desktop verify:artifact -- --smoke

  # Windows 构建级门禁（C3：不启动 Electron）——unit 是 node 环境 + build 是打包器，均不需 electron 二进制
  windows:
    name: windows build-level
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.20.0

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck + lint + unit + build
        run: pnpm typecheck && pnpm lint && pnpm test && pnpm build

      - name: Record commit SHA (Windows evidence)
        run: git rev-parse HEAD > app-sha-win.txt

      - name: Upload SHA evidence
        uses: actions/upload-artifact@v4
        with:
          name: app-sha-win
          path: app-sha-win.txt
```

- [ ] **Step 4: 验证本机等价内容**

Run: `pnpm -F @cyrene/desktop typecheck`、`pnpm -F @cyrene/desktop lint`、`pnpm -F @cyrene/desktop test tests/unit/safe-open.spec.ts`、`xvfb-run -a pnpm -F @cyrene/desktop verify:artifact -- --smoke`
Expected: 全绿（等价于 ubuntu artifact job 内容；windows job 本体需 push 触发 GHA，本机无法跑）。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml apps/desktop/tests/unit/safe-open.spec.ts apps/desktop/tests/unit/atomic-write.spec.ts apps/desktop/tests/unit/credential-store.spec.ts apps/desktop/tests/unit/file-writer.spec.ts apps/desktop/tests/unit/user-data-dirs.spec.ts
git commit -m "ci(阶段0/1批次C T4): 增 artifact+windows job + POSIX 专属单测平台守卫(FE-S1-P1-04)"
```

---

### Task 5: 全量门禁确认（无代码）

- [ ] **Step 1: 跑全部门禁**

Run: `pnpm -F @cyrene/desktop typecheck`、`pnpm -F @cyrene/desktop lint`、`pnpm -F @cyrene/desktop test`（应 ≥483）、`xvfb-run -a pnpm -F @cyrene/desktop test:integration`（应 ≥22 + 新增 audit-lifecycle）、`pnpm -F @cyrene/desktop build`、`pnpm -F @cyrene/desktop check:contract`（11/11）、`pnpm -F @cyrene/desktop package`、`xvfb-run -a pnpm -F @cyrene/desktop verify:artifact -- --smoke`
Expected: 全部绿。

- [ ] **Step 2: 确认无代码变更**

Run: `git status --short`
Expected: 无本任务产生的改动；不 commit。

---

## 自审（对照 spec）

- §4.1 fail-open 包装（ts 注入 + `diagnostics?.` + 放置点）+ **safeAudit 共享帮手（每调用点局部 fail-open）** → T1 Step 3（新建 safe-audit.ts）。
- §4.2 凭据审计（set/clear success/failed/status-change + status-change 隔离 + 日志 vs 审计用途）→ T1（status-change 隔离由 `maybeLogStatusChange` 既有 try/catch 天然保证）。
- §4.3 连接生命周期（connect 收敛出口审计 + disconnect + error 归一化；real/mock 分支写死 mode 值防 TS2367）→ T2。
- §4.4 CI（artifact job clean+package+smoke+SHA / windows 构建级 job+SHA / POSIX 专属单测守卫：safe-open + atomic-write + credential-store + file-writer + user-data-dirs，含 0600 平台守卫与 mkfifo 假绿理由）→ T4。
- §4.5 验收测试（credentials-ipc 6 例含 2 fail-open / chat-service 3 例 / backend-error 1 例 / 集成轮询 set+clear）→ T1/T2/T3。
- §5 故障注入复测（audit 写失败 fail-open）→ T1 fail-open 2 例（注入抛错 auditor → 操作不翻转 + 原错误保留）。
- §5 门禁（含 package + verify:artifact --smoke）→ T5。
- 已知限制（CI 需 push 验证、Windows symlink 权限、connect 前置失败噪音）→ T4/T5 注释 + 最终报告。

> **注**：文档同步（README / CLAUDE.md / docs/16 批次 C 状态 + CI 新 job 说明）属 SDD 工作流后续步骤，实施完成后由控制器执行并保留「已开发、未联调」。
