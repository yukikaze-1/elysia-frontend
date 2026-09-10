# 阶段 1 块 B：主进程受信服务（凭据存储 + 日志/审计）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在块 A 安全基线上落地 Main 侧两个受信服务——凭据存储（Electron `safeStorage` 加密 `config/credentials.json`，Renderer 只经 IPC 见 `credentialStatus`）与日志/审计（手写轻量 JSONL logger + append-only 审计），全程 TDD，零新增运行时依赖。

**Architecture:** 纯函数优先、依赖注入贯穿：`safe-storage`（假 safeStorage 可单测）、`credential-store`（假 fs 临时目录 + 假 safeStorage）、`file-writer`/`logger`/`audit`（注入 sanitize/redact）、IPC 薄接线、装配（`main/index.ts`）只做组合。文件安全复用块 A `userData` 纪律（O_NOFOLLOW + realpath 包含性 + 0600），新增 `persistence/safe-open.ts` 共享文件形态助手，块 A 单测不回归。

**Tech Stack:** Electron 43 + TypeScript + zod 4 + vitest（node env，`tests/unit/**/*.spec.ts`，`@shared` 别名）+ 零新增运行时依赖。

## Global Constraints

（从块 B spec 逐字摘录，所有任务隐式包含本节；实现与评审以本节为唯一口径）

- **凭据载体**：`config/credentials.json`，0600，`version: 1`，每 key 加密块 `{ enc: string; algo: 'safeStorage' }`，`enc = base64(encryptString(plaintext))`；key 白名单当前 `['backend.token']`，`model.*` 通配预留（`isKeyAllowed` 表达，非 zod enum）。
- **credentialStatus 4 值**：`unavailable | locked | empty | available`；`getStatus` 顺序：版本未知→unavailable、safeStorage 不可用→unavailable（**先于 empty**）、整文件 JSON 损坏→unavailable、文件无该 key→empty、单 key base64 非法→unavailable、decrypt 抛错→locked、否则 available。
- **`isSafeStorageUsable`**：`isEncryptionAvailable() && (process.platform !== 'linux' || getSelectedStorageBackend() !== 'basic_text')`——**仅 Linux 分支调用 `getSelectedStorageBackend()`**（Electron 文档标注 Linux-only，Windows/macOS 不调用）。
- **decrypt 前严格 base64 校验**：`/^[A-Za-z0-9+/]*={0,2}$/` 且长度 `%4===0`（Node `Buffer.from(s,'base64')` 宽容，不做严格校验则损坏 blob 会误归 locked）。
- **未知版本**：读拒（getStatus→unavailable）；**set/clear 抛 `UNSUPPORTED_VERSION`**（不覆盖未来格式，显式失败态）。
- **损坏文件**（JSON 解析失败）：set/clear 都写全新文件（整文件重建，可能丢其他键，契约注明）。
- **`atomicWriteFile`**：同目录 temp `open(tmp, O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0o600)` → `fchmod(fd,0o600)` 兜底 → 写 + `fsync(fd)` → `rename` 覆盖 → **POSIX `fsync(dir)`（Windows 跳过，记录平台差异）**；`EEXIST`=陈旧 temp → `unlink` 重试一次（仍 EEXIST → 抛）；**写前父目录 realpath 包含性复核**（`config/` realpath 须落在 safeRoot 内）。
- **串行队列**：`CredentialStore` 内部 promise 链 `.then(op, op)`（**两个参**，任一 op reject 只影响该次），串行化 set/clear（不依赖「单窗口即串行」假设）。
- **key 白名单单一来源**：`shared/contracts/credentials.ts`（纯常量，Preload 可 import）；zod schema `.refine(isKeyAllowed)`、store 注入谓词、preload 固定 key 全派生自它。
- **IPC 形态**：`credentials:get-status`（**0 参，固定查 `backend.token`**）/ `credentials:set`（1 参 `{key,value}`）/ `credentials:clear`（1 参 `{key}`），统一返回 **`{ status, key }`**；value 一次性提交、永不回显；`value: z.string().min(1).max(4096)`。
- **Preload**：`getCredentialStatus(): Promise<CredentialStatus>`、`setBackendToken(token): Promise<CredentialStatus>`、`clearBackendToken(): Promise<CredentialStatus>`——统一解包 `.status` 返回裸 status；**必须判 `{ok:false}` 信封**（`throw new Error('[CODE] message')`），safeStorage 不可用时 Renderer 收到明确错误，不返回 undefined status；key 固定 `BACKEND_TOKEN_KEY`（派生常量，非硬编码字面量）。
- **logger API**：`(code, fields?)`，**无 msg 参数**（结构性禁记：无消息正文/Token 接收通道）；JSONL 行 `{"ts","level","logger","code","fields"}`；级别过滤 `error(0)<warn(1)<info(2)<debug(3)` 阈值。
- **落盘净化**：fields 值先 `sanitizePublicMessage`（路径脱敏）再 `redactSensitiveValues`（**整 token 替换 `[REDACTED]`**：Bearer/JWT/`sk-`/`AKIA`/≥40 字符高熵 base64）；**不宣称单一类型保证**（fields 开放 Record，redact 是兜底）。
- **file-writer**：rotate 模式 `logs/app.log` 5MB×3（**轮转在 flush 排空批次后、检查 size 超限才触发**，不在 append 中途）；daily 模式 `audit/audit-YYYY-MM-DD.jsonl`（dir=audit，文件=`${baseName}-${date}.jsonl`，baseName='audit'，**每次 append 检查日期换日文件**）；`sync` 选项（audit=true 每写 fsync，log=false 批量异步）；文件形态 `create|existing`、`purpose: 'append'|'read'` 走 `openSafeFile`。
- **audit**：append-only、sync 写；**summary 净化在 audit.ts 层**（file-writer 是 dumb append）；**30 天清理唯一归属 audit.ts**，日期解析格式固定 `/audit-(\d{4}-\d{2}-\d{2})\.jsonl$/`（不匹配不删）；清理边界：删除**严格早于** `today - retentionDays` 的文件。
- **before-quit**：`allowQuit` 放行标志（finish 完成后最终 `app.quit()` 不被拦截，否则进程永不退出）+ **每次事件 `preventDefault`**（flushing 期间二次 quit 被拦）+ finish 每个 close 独立 try/catch + 1.5s `Promise.race` 超时 + `finally(quit)` 恒执行。
- **错误码**：`shared/errors` 扩展 `CREDENTIAL_UNAVAILABLE` / `CREDENTIAL_LOCKED` / `UNSUPPORTED_VERSION`。
- **安全写助手**：`persistence/safe-open.ts` 导出 `openSafeFile`（文件形态 create/existing、O_NOFOLLOW + realpath 包含性 + fchmod 0600 首建/既有 write 模式 `(mode&0o600)===0o600 && (mode&0o077)===0` 复核）；**块 A 单测不回归**。
- 验收门槛：`pnpm typecheck && pnpm lint && pnpm test` 全绿；块 A verify:artifact 冒烟不回归；块 A 92 项单测不回归。

---

### Task 1: 凭据契约（shared/contracts/credentials.ts）

**Files:**
- Create: `apps/desktop/src/shared/contracts/credentials.ts`
- Modify: `apps/desktop/src/shared/contracts/index.ts`（加 `export * from './credentials'`）
- Test: `apps/desktop/tests/unit/credentials-contracts.spec.ts`

**Interfaces:**
- Consumes: 无（纯常量，零依赖）
- Produces:
  ```typescript
  export type CredentialStatus = 'unavailable' | 'locked' | 'empty' | 'available'
  export type CredentialKey = 'backend.token'
  export const BACKEND_TOKEN_KEY: CredentialKey = 'backend.token'
  export const CREDENTIAL_KEY_ALLOWLIST: readonly string[] = ['backend.token']
  export function isKeyAllowed(key: string): boolean
  ```
  后续 Task 2（zod `.refine(isKeyAllowed)`）、Task 10（store 注入谓词）、Task 11（preload 固定 key）全部消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/credentials-contracts.spec.ts
import { describe, expect, it } from 'vitest'
import { BACKEND_TOKEN_KEY, CREDENTIAL_KEY_ALLOWLIST, isKeyAllowed } from '../../src/shared/contracts/credentials'

describe('credentials contracts', () => {
  it('allowlist 当前仅 backend.token', () => {
    expect(CREDENTIAL_KEY_ALLOWLIST).toEqual(['backend.token'])
  })
  it('BACKEND_TOKEN_KEY 在 allowlist 内', () => {
    expect(isKeyAllowed(BACKEND_TOKEN_KEY)).toBe(true)
  })
  it('任意非白名单 key 拒绝', () => {
    expect(isKeyAllowed('backend.token2')).toBe(false)
    expect(isKeyAllowed('')).toBe(false)
    expect(isKeyAllowed('model.llm.openai')).toBe(false) // model.* 预留未激活
  })
  it('model.* 通配语义在 allowlist 结构上可表达（预留，未激活）', () => {
    expect(isKeyAllowed('model.llm.openai')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/credentials-contracts.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/shared/contracts/credentials.ts
/** 凭据可用状态：Renderer 只经 IPC 见这 4 值，绝不明文回读 */
export type CredentialStatus = 'unavailable' | 'locked' | 'empty' | 'available'

export type CredentialKey = 'backend.token' // 未来: 'model.llm.*' 等

/** 当前唯一 key */
export const BACKEND_TOKEN_KEY: CredentialKey = 'backend.token'

/** key 白名单单一来源（zod .refine / store 谓词 / preload 固定 key 全派生自它） */
export const CREDENTIAL_KEY_ALLOWLIST: readonly string[] = ['backend.token']

/**
 * 白名单谓词：字面量精确匹配，或 `prefix.*` 通配（当前 allowlist 无通配项，
 * model.* 语义由本函数结构预留——未来加 'model.*' 进 allowlist 即激活，无需改调用方）。
 */
export function isKeyAllowed(key: string): boolean {
  return CREDENTIAL_KEY_ALLOWLIST.some((pattern) => {
    if (pattern.endsWith('.*')) return key.startsWith(pattern.slice(0, -1))
    return key === pattern
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（4 项）

- [ ] **Step 5: 更新 index.ts 导出并跑全量单测**

Modify `src/shared/contracts/index.ts`：在 `export * from './tool'` 后加 `export * from './credentials'`。
Run: `pnpm --filter @cyrene/desktop test`
Expected: 全绿（92+4=96）

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/shared/contracts/credentials.ts apps/desktop/src/shared/contracts/index.ts apps/desktop/tests/unit/credentials-contracts.spec.ts
git commit -m "feat(阶段1块B): credentials 契约——credentialStatus 4 值 + key 白名单单一来源"
```

---

### Task 2: 凭据 IPC 通道常量 + zod schema

**Files:**
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`（+3 通道常量）
- Modify: `apps/desktop/src/main/ipc/channels.ts`（+3 zod schema）
- Test: `apps/desktop/tests/unit/credentials-channels.spec.ts`

**Interfaces:**
- Consumes: Task 1 `isKeyAllowed`、现有 `IpcChannels` 常量
- Produces:
  ```typescript
  // shared/contracts/ipc.ts 追加
  credentialsGetStatus: 'credentials:get-status'
  credentialsSet: 'credentials:set'
  credentialsClear: 'credentials:clear'
  // main/ipc/channels.ts 追加
  export const credentialStatusSchema: z.ZodType<{ status: CredentialStatus; key: string }>
  export const credentialsSetSchema: z.ZodType<{ key: string; value: string }>
  export const credentialsClearSchema: z.ZodType<{ key: string }>
  ```
  后续 Task 11 的 handler 消费这些 schema 与通道常量。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/credentials-channels.spec.ts
import { describe, expect, it } from 'vitest'
import { IpcChannels } from '../../src/shared/contracts'
import { credentialsSetSchema, credentialsClearSchema, credentialStatusSchema } from '../../src/main/ipc/channels'

describe('credentials channels', () => {
  it('通道常量已注册', () => {
    expect(IpcChannels.credentialsGetStatus).toBe('credentials:get-status')
    expect(IpcChannels.credentialsSet).toBe('credentials:set')
    expect(IpcChannels.credentialsClear).toBe('credentials:clear')
  })
  it('set schema：合法 key+value 通过', () => {
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: 'sk-x' }).success).toBe(true)
  })
  it('set schema：非白名单 key 拒绝（allowlist 单一来源）', () => {
    expect(credentialsSetSchema.safeParse({ key: 'evil.key', value: 'x' }).success).toBe(false)
  })
  it('set schema：空 value / 超长 value 拒绝', () => {
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: '' }).success).toBe(false)
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: 'x'.repeat(4097) }).success).toBe(false)
    expect(credentialsSetSchema.safeParse({ key: 'backend.token', value: 'x'.repeat(4096) }).success).toBe(true)
  })
  it('clear schema：合法 key 通过、非法拒绝', () => {
    expect(credentialsClearSchema.safeParse({ key: 'backend.token' }).success).toBe(true)
    expect(credentialsClearSchema.safeParse({ key: 'nope' }).success).toBe(false)
  })
  it('status schema：4 值合法、非法值拒绝、key refine', () => {
    for (const s of ['unavailable', 'locked', 'empty', 'available'] as const) {
      expect(credentialStatusSchema.safeParse({ status: s, key: 'backend.token' }).success).toBe(true)
    }
    expect(credentialStatusSchema.safeParse({ status: 'weird', key: 'backend.token' }).success).toBe(false)
    expect(credentialStatusSchema.safeParse({ status: 'empty', key: 'bad.key' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/credentials-channels.spec.ts`
Expected: FAIL（通道常量与 schema 不存在）

- [ ] **Step 3: 实现**

```typescript
// src/shared/contracts/ipc.ts 追加（IpcChannels 常量对象内）
credentialsGetStatus: 'credentials:get-status',
credentialsSet: 'credentials:set',
credentialsClear: 'credentials:clear'
```
```typescript
// src/main/ipc/channels.ts 追加
import { isKeyAllowed } from '@shared/contracts'
import type { CredentialStatus } from '@shared/contracts'

export const credentialStatusSchema = z.object({
  status: z.enum(['unavailable', 'locked', 'empty', 'available']),
  key: z.string().refine(isKeyAllowed)
})
export const credentialsSetSchema = z.object({
  key: z.string().refine(isKeyAllowed),
  value: z.string().min(1).max(4096)
})
export const credentialsClearSchema = z.object({
  key: z.string().refine(isKeyAllowed)
})
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（6 项）

- [ ] **Step 5: 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/main/ipc/channels.ts apps/desktop/tests/unit/credentials-channels.spec.ts
git commit -m "feat(阶段1块B): credentials IPC 通道常量 + zod schema（key 白名单 refine）"
```

---

### Task 3: safeStorage 封装（credentials/safe-storage.ts）

**Files:**
- Create: `apps/desktop/src/main/credentials/safe-storage.ts`
- Test: `apps/desktop/tests/unit/safe-storage.spec.ts`

**Interfaces:**
- Consumes: 无（Electron `SafeStorage` 类型 + `process.platform`）
- Produces:
  ```typescript
  export type SafeStorageLike = Pick<SafeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'>
  export function isValidBase64(s: string): boolean
  export function isSafeStorageUsable(safe: SafeStorageLike): boolean
  export function encryptCredential(safe: SafeStorageLike, plaintext: string): Buffer
  export function decryptCredential(safe: SafeStorageLike, encrypted: Buffer): string
  ```
  后续 Task 10 `CredentialStore` 消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/safe-storage.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { decryptCredential, encryptCredential, isSafeStorageUsable, isValidBase64 } from '../../src/main/credentials/safe-storage'
import { CyreneErrorCode } from '../../src/shared/errors'

function fakeSafe(over: Partial<Record<string, unknown>> = {}): any {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
    ...over
  }
}

describe('isValidBase64', () => {
  it('合法 base64 通过', () => {
    expect(isValidBase64('AQID')).toBe(true)
    expect(isValidBase64('AQIDBA==')).toBe(true)
  })
  it('非法字符 / 长度 %4 拒绝', () => {
    expect(isValidBase64('AQI*')).toBe(false)   // 非法字符
    expect(isValidBase64('AQI')).toBe(false)     // 长度非 4 倍数
    expect(isValidBase64('AQ===')).toBe(false)   // 多个 pad
  })
})

describe('isSafeStorageUsable', () => {
  it('isEncryptionAvailable=false → 不可用', () => {
    expect(isSafeStorageUsable(fakeSafe({ isEncryptionAvailable: () => false }))).toBe(false)
  })
  it('linux + basic_text → 不可用（明文降级拒存）', () => {
    expect(isSafeStorageUsable(fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }))).toBe(false)
  })
  it('linux + gnome_libsecret → 可用', () => {
    expect(isSafeStorageUsable(fakeSafe({ getSelectedStorageBackend: () => 'gnome_libsecret' }))).toBe(true)
  })
  it('非 linux 不调用 getSelectedStorageBackend（未提供该方法的 fake 不崩）', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const safe: any = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('x'), decryptString: () => 'x' }
      expect(isSafeStorageUsable(safe)).toBe(true) // 不访问 getSelectedStorageBackend
    } finally { Object.defineProperty(process, 'platform', { value: orig }) }
  })
})

describe('encrypt/decrypt', () => {
  it('往返一致', () => {
    const safe = fakeSafe()
    const enc = encryptCredential(safe, 'secret-token')
    expect(decryptCredential(safe, enc)).toBe('secret-token')
  })
  it('decryptString 抛错 → 抛 CREDENTIAL_LOCKED', () => {
    const safe = fakeSafe({ decryptString: () => { throw new Error('keyring locked') } })
    try { decryptCredential(safe, Buffer.from('AQID')); expect.unreachable() }
    catch (e: any) { expect(e.code).toBe(CyreneErrorCode.CREDENTIAL_LOCKED) }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/safe-storage.spec.ts`
Expected: FAIL（模块不存在；CyreneErrorCode 尚无新码——见 Step 3b）

- [ ] **Step 3: 实现**

```typescript
// src/main/credentials/safe-storage.ts
import { type SafeStorage } from 'electron'
import { CyreneError, CyreneErrorCode } from '@shared/errors'

export type SafeStorageLike = Pick<SafeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'>

/** 严格 base64 校验：Node Buffer.from(s,'base64') 宽容（非法字符不抛、截断可解），不做严格校验损坏 blob 会误归 locked */
export function isValidBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0
}

/**
 * safeStorage 可用性：isEncryptionAvailable() 且（仅 Linux）非 basic_text 后端。
 * basic_text 是硬编码 key 的弱加密明文降级，按 doc16 §4.0「不可用即拒存」视为不可用。
 * Windows/macOS 不调用 getSelectedStorageBackend()（Electron 标注 Linux-only，非 Linux 行为未定义）。
 */
export function isSafeStorageUsable(safe: SafeStorageLike): boolean {
  if (!safe.isEncryptionAvailable()) return false
  if (process.platform === 'linux') return safe.getSelectedStorageBackend() !== 'basic_text'
  return true
}

export function encryptCredential(safe: SafeStorageLike, plaintext: string): Buffer {
  return safe.encryptString(plaintext)
}

/** 解密失败（keyring 锁/解密失败）→ 抛 CREDENTIAL_LOCKED（状态归 locked，不重试） */
export function decryptCredential(safe: SafeStorageLike, encrypted: Buffer): string {
  try {
    return safe.decryptString(encrypted)
  } catch {
    throw new CyreneError(CyreneErrorCode.CREDENTIAL_LOCKED, '系统钥匙串锁定或解密失败')
  }
}
```

**Step 3b:** 扩展 `src/shared/errors/index.ts` 的 `CyreneErrorCode` 枚举（在 `GENERATION_CONFLICT` 后加三项）：
```typescript
CREDENTIAL_UNAVAILABLE = 'CREDENTIAL_UNAVAILABLE',
CREDENTIAL_LOCKED = 'CREDENTIAL_LOCKED',
UNSUPPORTED_VERSION = 'UNSUPPORTED_VERSION'
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（8 项：isValidBase64 2 + isSafeStorageUsable 4 + encrypt/decrypt 2）

- [ ] **Step 5: 全量单测 + typecheck + 提交**

Run: `pnpm --filter @cyrene/desktop typecheck && pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/credentials/safe-storage.ts apps/desktop/src/shared/errors/index.ts apps/desktop/tests/unit/safe-storage.spec.ts
git commit -m "feat(阶段1块B): safeStorage 封装——可用性判定(Linux basic_text 拒)/严格 base64/加密解密 LOCKED 检测"
```

---

### Task 4: 共享安全文件助手（persistence/safe-open.ts）

**Files:**
- Create: `apps/desktop/src/main/persistence/safe-open.ts`
- Test: `apps/desktop/tests/unit/safe-open.spec.ts`
- 验证: 块 A `user-data-dirs.spec.ts` 不回归

**Interfaces:**
- Consumes: 地基 spec §5.2 step 5 文件形态纪律（O_NOFOLLOW + realpath 包含性 + fchmod 0600 + create/existing 模式）
- Produces:
  ```typescript
  export class SafeOpenError extends Error {}
  export class SafeOpenConflictError extends SafeOpenError {} // create 模式 EEXIST（onConflict:'error'）
  export interface SafeOpenOptions {
    mode: 'create' | 'existing'
    purpose: 'append' | 'read'
    safeRoot: string          // realpath 锚点（调用方提供）
    onConflict?: 'fallback' | 'error' // create 遇 EEXIST：fallback=重开 existing（默认），error=抛 SafeOpenConflictError
  }
  export interface SafeOpenResult { fd: FileHandle; created: boolean }
  export async function openSafeFile(filePath: string, opts: SafeOpenOptions): Promise<SafeOpenResult>
  ```
  后续 Task 5（atomic-write，onConflict:'error'）、Task 6（file-writer，fallback）消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/safe-open.spec.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openSafeFile, SafeOpenConflictError } from '../../src/main/persistence/safe-open'

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cy-safe-open-'))
  mkdirSync(join(root, 'sub'), { recursive: true })
  return root
}
const root = makeDir()
const safeRoot = root // 测试锚点 = 临时根

describe('openSafeFile', () => {
  it('create 模式：新文件 0600 首建（fchmod 修正 umask）', async () => {
    const p = join(root, 'sub', 'app.log')
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })
    expect(r.created).toBe(true)
    const st = await r.fd.stat()
    expect(st.mode & 0o777).toBe(0o600)
    await r.fd.close()
  })
  it('create 模式遇既有文件 → fallback 重开 existing（mode 复核）', async () => {
    const p = join(root, 'sub', 'exists.log')
    writeFileSync(p, 'x', { mode: 0o600 })
    const r = await openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })
    expect(r.created).toBe(false)
    await r.fd.close()
  })
  it('create 模式 onConflict:error 遇既有文件 → 抛 SafeOpenConflictError', async () => {
    const p = join(root, 'sub', 'conflict.log')
    writeFileSync(p, 'x', { mode: 0o600 })
    await expect(openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot, onConflict: 'error' })).rejects.toBeInstanceOf(SafeOpenConflictError)
  })
  it('existing 模式：既有文件 group/other 位 → 拒绝（write 模式 0600 复核）', async () => {
    const p = join(root, 'sub', 'loose.log')
    writeFileSync(p, 'x')
    chmodSync(p, 0o644) // writeFileSync mode 受 umask 掩码，chmod 固定权限后再断言
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow(/权限|mode/i)
  })
  it('existing 模式：0400 只读文件 append → 拒绝（write 需 owner 读+写）', async () => {
    const p = join(root, 'sub', 'ro.log')
    writeFileSync(p, 'x')
    chmodSync(p, 0o400)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('read 模式：0400 只读文件通过（read 复核 0400）', async () => {
    const p = join(root, 'sub', 'ro2.log')
    writeFileSync(p, 'x')
    chmodSync(p, 0o400)
    const r = await openSafeFile(p, { mode: 'existing', purpose: 'read', safeRoot })
    expect(r.created).toBe(false)
    await r.fd.close()
  })
  it('symlink 文件 → 拒绝（O_NOFOLLOW）', async () => {
    const p = join(root, 'sub', 'link.log')
    const target = join(root, 'outside.log')
    writeFileSync(target, 'x', { mode: 0o600 })
    symlinkSync(target, p)
    await expect(openSafeFile(p, { mode: 'existing', purpose: 'append', safeRoot })).rejects.toThrow()
  })
  it('realpath 逃逸 safeRoot → 拒绝', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cy-outside-'))
    const p = join(root, 'sub', 'escape.log')
    symlinkSync(join(outside, 'f'), p) // 悬空 symlink → realpath 解析到 outside
    await expect(openSafeFile(p, { mode: 'create', purpose: 'append', safeRoot })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/safe-open.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/persistence/safe-open.ts
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

const isPosix = process.platform !== 'win32'

async function assertContained(filePath: string, safeRoot: string): Promise<void> {
  const real = await realpath(filePath).catch(() => { throw new SafeOpenError(`${filePath} 无法解析真实路径`) })
  const rel = relative(safeRoot, real)
  if (rel.startsWith('..') || rel.includes('..')) throw new SafeOpenError(`${filePath} 逃逸安全根`)
}

/**
 * 文件形态安全打开（地基 spec §5.2 step 5）：
 * create+append = O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW + fchmod 0600（首建）；
 * existing+append 复核 (mode&0o600)===0o600 && (mode&0o077)===0；existing+read 复核 (mode&0o400)===0o400。
 * 打开后 realpath 包含性复核。POSIX 用 O_NOFOLLOW 拦最后一段；Windows 无该常量 → lstat 拒 symlink + realpath。
 */
export async function openSafeFile(filePath: string, opts: SafeOpenOptions): Promise<SafeOpenResult> {
  const onConflict = opts.onConflict ?? 'fallback'
  if (isPosix) {
    const flags = opts.mode === 'create'
      ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW
      : opts.purpose === 'read'
        ? constants.O_RDONLY | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
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
            fd = await open(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
          } else throw new SafeOpenError(`${filePath} 打开失败（可能是符号链接）`)
        }
      } else {
        fd = await open(filePath, flags)
      }
    } catch (e: unknown) {
      if (e instanceof SafeOpenError) throw e
      if (opts.mode === 'existing' && (e as NodeJS.ErrnoException).code === 'ENOENT') throw e // 保留 ENOENT：调用方（credential-store readFile）据此判「文件不存在」
      throw new SafeOpenError(`${filePath} 打开失败`)
    }
    try {
      if (created) await fd.chmod(0o600) // 兜底修正 umask（open mode 参数已被掩，fchmod 直接到 inode）
      else {
        const st = await fd.stat()
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
  // Windows：无 O_NOFOLLOW——lstat 拒 symlink + open + realpath 包含性（不校验 mode，NTFS 合成值）
  const st = await lstat(filePath).catch(() => { throw new SafeOpenError(`${filePath} 无法检查`) })
  if (st.isSymbolicLink()) throw new SafeOpenError(`${filePath} 为符号链接`)
  const flags = opts.mode === 'create'
    ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    : opts.purpose === 'read' ? constants.O_RDONLY : constants.O_WRONLY | constants.O_APPEND
  let created = false
  let fd: FileHandle
  try {
    if (opts.mode === 'create') {
      try { fd = await open(filePath, flags, 0o600); created = true }
      catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          if (onConflict === 'error') throw new SafeOpenConflictError(`${filePath} 已存在`)
          fd = await open(filePath, opts.purpose === 'read' ? constants.O_RDONLY : constants.O_WRONLY | constants.O_APPEND)
        } else throw new SafeOpenError(`${filePath} 打开失败`)
      }
    } else fd = await open(filePath, flags)
  } catch (e: unknown) {
    if (e instanceof SafeOpenError) throw e
    if (opts.mode === 'existing' && (e as NodeJS.ErrnoException).code === 'ENOENT') throw e // 保留 ENOENT（同 POSIX 分支）
    throw new SafeOpenError(`${filePath} 打开失败`)
  }
  try { await assertContained(filePath, opts.safeRoot); return { fd, created } }
  catch (e: unknown) { await fd.close().catch(() => {}); throw e }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（8 项；权限用例用 chmodSync 固定 mode 不受 umask 掩码；Windows 上 mode 断言跳过——该 spec 按 POSIX 设计）

- [ ] **Step 5: 块 A user-data-dirs 回归 + 全量单测**

Run: `pnpm --filter @cyrene/desktop test`（含既有 `user-data-dirs.spec.ts`）
Expected: 全绿（块 A 92 项 + 块 B 已累积，约 120；目录形态断言不回归）

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/main/persistence/safe-open.ts apps/desktop/tests/unit/safe-open.spec.ts
git commit -m "feat(阶段1块B): 共享安全文件助手 openSafeFile（create/existing + 文件形态 0600/0400 + O_NOFOLLOW + realpath 包含性）"
```

---

### Task 5: 凭据原子写（credentials/atomic-write.ts）

**Files:**
- Create: `apps/desktop/src/main/credentials/atomic-write.ts`
- Test: `apps/desktop/tests/unit/atomic-write.spec.ts`

**Interfaces:**
- Consumes: Task 4 `openSafeFile` / `SafeOpenConflictError`、`realpath` / `rename` / `unlink`
- Produces:
  ```typescript
  export async function atomicWriteFile(filePath: string, data: string, opts: { safeRoot: string }): Promise<void>
  ```
  后续 Task 10 `CredentialStore` 消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/atomic-write.spec.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWriteFile } from '../../src/main/credentials/atomic-write'
import { SafeOpenConflictError } from '../../src/main/persistence/safe-open'

function makeDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cy-atomic-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  return root
}

describe('atomicWriteFile', () => {
  it('写新文件：内容正确且 0600', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    await atomicWriteFile(p, '{"version":1}', { safeRoot: root })
    expect(readFileSync(p, 'utf8')).toBe('{"version":1}')
    expect((await import('fs')).statSync(p).mode & 0o777).toBe(0o600)
  })
  it('覆盖既有文件（rename 原子，无 .tmp 残留）', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    writeFileSync(p, 'old', { mode: 0o600 })
    await atomicWriteFile(p, 'new', { safeRoot: root })
    expect(readFileSync(p, 'utf8')).toBe('new')
    expect(existsSync(join(root, 'config', 'credentials.json.tmp'))).toBe(false)
  })
  it('陈旧 temp（EEXIST）→ unlink 重试成功', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    writeFileSync(join(root, 'config', 'credentials.json.tmp'), 'stale', { mode: 0o600 })
    await atomicWriteFile(p, 'fresh', { safeRoot: root })
    expect(readFileSync(p, 'utf8')).toBe('fresh')
    expect(existsSync(join(root, 'config', 'credentials.json.tmp'))).toBe(false)
  })
  it('陈旧 temp 仍 EEXIST（tmp 为目录，unlink 失败）→ 抛 SafeOpenConflictError（上抛不静默）', async () => {
    const root = makeDir()
    const p = join(root, 'config', 'credentials.json')
    mkdirSync(join(root, 'config', 'credentials.json.tmp')) // tmp 是目录：unlink EISDIR 被吞，重试仍 EEXIST → 上抛
    await expect(atomicWriteFile(p, 'x', { safeRoot: root })).rejects.toBeInstanceOf(SafeOpenConflictError)
  })
  it('父目录逃逸 safeRoot → 拒绝', async () => {
    const root = makeDir()
    const outside = mkdtempSync(join(tmpdir(), 'cy-atomic-out-'))
    const p = join(outside, 'credentials.json')
    await expect(atomicWriteFile(p, 'x', { safeRoot: root })).rejects.toThrow(/逃逸|安全根/i)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/atomic-write.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/credentials/atomic-write.ts
import { constants } from 'fs'
import { realpath, rename, unlink } from 'fs/promises'
import { basename, dirname, join, relative } from 'path'
import { openSafeFile, SafeOpenConflictError } from '../persistence/safe-open'

const isPosix = process.platform !== 'win32'

async function assertParentContained(filePath: string, safeRoot: string): Promise<string> {
  const dir = dirname(filePath)
  const real = await realpath(dir).catch(() => { throw new Error('父目录无法解析') })
  const rel = relative(safeRoot, real)
  if (rel.startsWith('..') || rel.includes('..')) throw new Error(`父目录逃逸安全根（${real}）`)
  return real
}

/**
 * 原子替换写（多 key 凭据文件整文件改写，崩溃/中断不截断）：
 * 同目录 temp O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW 0o600 → fchmod 兜底 → 写 + fsync(fd) → rename 覆盖
 * → POSIX fsync(dir)（Windows 跳过，记录平台差异）。写前父目录 realpath 包含性复核。
 * EEXIST = 陈旧 temp（单实例无并发写者）→ unlink 重试一次（仍 EEXIST → 抛），不留永久砖。
 */
export async function atomicWriteFile(filePath: string, data: string, opts: { safeRoot: string }): Promise<void> {
  await assertParentContained(filePath, opts.safeRoot)
  const dir = dirname(filePath)
  const tmp = join(dir, `${basename(filePath)}.tmp`)

  const writeTemp = async (): Promise<void> => {
    const { fd } = await openSafeFile(tmp, { mode: 'create', purpose: 'append', safeRoot: opts.safeRoot, onConflict: 'error' })
    try {
      await fd.writeFile(data, 'utf8')
      await fd.sync()
    } finally {
      await fd.close()
    }
  }

  try {
    await writeTemp()
  } catch (e: unknown) {
    if (e instanceof SafeOpenConflictError) {
      await unlink(tmp).catch(() => {}) // 陈旧 temp：unlink 重试一次
      await writeTemp()
    } else throw e
  }

  await rename(tmp, filePath)

  if (isPosix) {
    const dirFd = await import('fs/promises').then((m) => m.open(dir, constants.O_RDONLY | constants.O_DIRECTORY))
    try { await dirFd.sync() } finally { await dirFd.close() }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（5 项：写新/覆盖/陈旧 temp 恢复/仍 EEXIST 抛/父目录逃逸）

- [ ] **Step 5: 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/credentials/atomic-write.ts apps/desktop/tests/unit/atomic-write.spec.ts
git commit -m "feat(阶段1块B): 凭据原子写 atomicWriteFile（temp+fsync+rename+父目录包含性+陈旧 temp 恢复）"
```

---

### Task 6: 共享文件写器（diagnostics/file-writer.ts）

**Files:**
- Create: `apps/desktop/src/main/diagnostics/file-writer.ts`
- Test: `apps/desktop/tests/unit/file-writer.spec.ts`

**Interfaces:**
- Consumes: Task 4 `openSafeFile`；`realpath` / `readdir` / `rename` / `unlink` / `stat`
- Produces:
  ```typescript
  export interface FileWriterOptions {
    dir: string
    baseName: string
    mode: 'rotate' | 'daily'
    maxSizeBytes?: number
    maxFiles?: number
    retentionDays?: number
    sync?: boolean
  }
  export interface FileWriter { append(line: string): Promise<void>; flush(): Promise<void>; close(): Promise<void> }
  export function createFileWriter(opts: FileWriterOptions): FileWriter
  // 纯函数（可单测）
  export function rotateTargets(current: string, maxFiles: number): { moves: Array<{ from: string; to: string }>; drop: string | null }
  export function todayKey(date: Date): string
  export function dailyPath(dir: string, baseName: string, date: Date): string
  ```
  后续 Task 8 logger（rotate）、Task 9 audit（daily+sync）、Task 12 装配消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/file-writer.spec.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFileWriter, dailyPath, rotateTargets, todayKey } from '../../src/main/diagnostics/file-writer'

describe('rotateTargets 纯函数', () => {
  it('3 份轮转：app.log→.1、.1→.2、丢 .2', () => {
    expect(rotateTargets('app.log', 3)).toEqual({
      moves: [{ from: 'app.log.1', to: 'app.log.2' }, { from: 'app.log', to: 'app.log.1' }],
      drop: 'app.log.2'
    })
  })
  it('maxFiles=1：无备份、不丢', () => {
    expect(rotateTargets('app.log', 1)).toEqual({ moves: [], drop: null })
  })
})

describe('todayKey / dailyPath', () => {
  it('本地日期 YYYY-MM-DD', () => {
    expect(todayKey(new Date(2026, 7, 10))).toBe('2026-08-10') // 注意 Date 月份 0 基
  })
  it('daily 文件名 = audit-YYYY-MM-DD.jsonl', () => {
    expect(dailyPath('/audit', 'audit', new Date(2026, 7, 10))).toBe('/audit/audit-2026-08-10.jsonl')
  })
})

describe('createFileWriter 集成', () => {
  it('rotate：写行落 app.log 且 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-'))
    const w = createFileWriter({ dir, baseName: 'app', mode: 'rotate', sync: true })
    await w.append('{"a":1}')
    await w.close()
    const p = join(dir, 'app.log')
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}\n')
    expect((await import('fs')).statSync(p).mode & 0o777).toBe(0o600)
  })
  it('daily：换日开新文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-d-'))
    const w = createFileWriter({ dir, baseName: 'audit', mode: 'daily', sync: true })
    await w.append('day1')
    await w.close()
    const today = todayKey(new Date())
    expect(existsSync(join(dir, `audit-${today}.jsonl`))).toBe(true)
  })
  it('rotate：超 maxSizeBytes 轮转（app.log → .1 → .2，删最旧）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-r-'))
    const w = createFileWriter({ dir, baseName: 'app', mode: 'rotate', maxSizeBytes: 10, maxFiles: 3, sync: true })
    for (let i = 0; i < 3; i++) await w.append('x'.repeat(10)) // 触发轮转
    await w.close()
    expect(existsSync(join(dir, 'app.log'))).toBe(true)
    expect(existsSync(join(dir, 'app.log.1'))).toBe(true)
  })
  it('异步批量：flush 后排空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-fw-b-'))
    const w = createFileWriter({ dir, baseName: 'app', mode: 'rotate', sync: false })
    await w.append('line1')
    await w.flush()
    await w.close()
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe('line1\n')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/file-writer.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/diagnostics/file-writer.ts
import { realpath, rename, unlink } from 'fs/promises'
import { join } from 'path'
import type { FileHandle } from 'fs/promises'
import { openSafeFile } from '../persistence/safe-open'

export interface FileWriterOptions {
  dir: string
  baseName: string
  mode: 'rotate' | 'daily'
  maxSizeBytes?: number
  maxFiles?: number
  retentionDays?: number
  sync?: boolean
}
export interface FileWriter {
  append(line: string): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

export function rotateTargets(current: string, maxFiles: number): { moves: Array<{ from: string; to: string }>; drop: string | null } {
  const moves: Array<{ from: string; to: string }> = []
  const drop = maxFiles > 1 ? `${current}.${maxFiles - 1}` : null
  for (let i = maxFiles - 1; i >= 2; i--) moves.push({ from: `${current}.${i - 1}`, to: `${current}.${i}` })
  if (maxFiles > 1) moves.push({ from: current, to: `${current}.1` })
  return { moves, drop }
}

/** 本地日期 YYYY-MM-DD（Date 月份 0 基） */
export function todayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function dailyPath(dir: string, baseName: string, date: Date): string {
  return join(dir, `${baseName}-${todayKey(date)}.jsonl`)
}

export function createFileWriter(opts: FileWriterOptions): FileWriter {
  const sync = opts.sync ?? false
  let fd: FileHandle | null = null
  let safeRoot: string | null = null
  let closed = false
  let daily = todayKey(new Date())
  let batch: string[] = []
  let flushing: Promise<void> = Promise.resolve()

  const targetPath = (): string =>
    opts.mode === 'rotate' ? join(opts.dir, `${opts.baseName}.log`) : dailyPath(opts.dir, opts.baseName, new Date())

  async function ensureOpen(): Promise<FileHandle> {
    if (fd) return fd
    if (!safeRoot) safeRoot = await realpath(opts.dir)
    const r = await openSafeFile(targetPath(), { mode: 'create', purpose: 'append', safeRoot, onConflict: 'fallback' })
    fd = r.fd
    return fd
  }

  const maybeRotate = async (): Promise<void> => {
    if (opts.mode !== 'rotate' || !fd || !opts.maxSizeBytes) return
    const st = await fd.stat()
    if (st.size <= opts.maxSizeBytes) return
    const current = join(opts.dir, `${opts.baseName}.log`)
    const { moves, drop } = rotateTargets(current, opts.maxFiles ?? 3)
    await fd.close()
    fd = null
    if (drop) await unlink(drop).catch(() => {})
    for (const m of moves) await rename(m.from, m.to).catch(() => {})
    // 轮转后立即重开新 app.log——当前文件恒存在（否则最后一次 append 触发轮转后 app.log 缺失，测试/后续 append 都受影响）
    fd = (await openSafeFile(current, { mode: 'create', purpose: 'append', safeRoot: safeRoot as string, onConflict: 'fallback' })).fd
  }

  const drain = async (): Promise<void> => {
    if (batch.length === 0) return
    const lines = batch
    batch = []
    const f = await ensureOpen()
    await f.writeFile(lines.join('\n') + '\n', 'utf8')
    if (sync) await f.sync()
    await maybeRotate()
  }

  const flushOnce = async (): Promise<void> => { await drain(); if (fd) await fd.sync() }

  return {
    async append(line: string): Promise<void> {
      if (opts.mode === 'daily') {
        const now = todayKey(new Date())
        if (now !== daily) {
          daily = now
          if (fd) { const f = fd; fd = null; await f.close().catch(() => {}) }
        }
      }
      if (sync) {
        const f = await ensureOpen()
        await f.writeFile(line + '\n', 'utf8')
        await f.sync()
        await maybeRotate()
        return
      }
      batch.push(line)
      return
    },
    async flush(): Promise<void> {
      // 串行化并发 flush（轮转/换日不得与在途写交错）
      flushing = flushing.then(flushOnce, flushOnce)
      await flushing
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await this.flush()
      if (fd) { const f = fd; fd = null; await f.close().catch(() => {}) }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（8 项）

- [ ] **Step 5: 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/diagnostics/file-writer.ts apps/desktop/tests/unit/file-writer.spec.ts
git commit -m "feat(阶段1块B): 共享文件写器 createFileWriter（rotate 5MB×3 flush 边界轮转 / daily 换日 / sync 选项）"
```

---

### Task 7: 敏感值脱敏（diagnostics/redact.ts）

**Files:**
- Create: `apps/desktop/src/main/diagnostics/redact.ts`
- Test: `apps/desktop/tests/unit/redact.spec.ts`

**Interfaces:**
- Consumes: 无（纯正则）
- Produces:
  ```typescript
  export function redactSensitiveValues(text: string): string
  ```
  后续 Task 8 logger、Task 9 audit 消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/redact.spec.ts
import { describe, expect, it } from 'vitest'
import { redactSensitiveValues } from '../../src/main/diagnostics/redact'

describe('redactSensitiveValues', () => {
  it('Bearer token → Bearer [REDACTED]（保留 scheme 词）', () => {
    expect(redactSensitiveValues('auth: Bearer abc.def-ghi_123XYZ')).toBe('auth: Bearer [REDACTED]')
  })
  it('JWT（eyJ 三段）→ [REDACTED]', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.aGVsbG8td29ybGQtZGF0YQ'
    expect(redactSensitiveValues(`token=${jwt}`)).toBe('token=[REDACTED]')
  })
  it('sk- / AKIA 前缀 → [REDACTED]', () => {
    expect(redactSensitiveValues('key=sk-abc123DEF456ghi789')).toBe('key=[REDACTED]')
    expect(redactSensitiveValues('key=AKIAIOSFODNN7EXAMPLE')).toBe('key=[REDACTED]')
  })
  it('≥40 高熵 base64 长串 → [REDACTED]', () => {
    const long = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5'
    expect(redactSensitiveValues(`v=${long}`)).toBe('v=[REDACTED]')
  })
  it('普通文本不误伤', () => {
    expect(redactSensitiveValues('hello world, 你好')).toBe('hello world, 你好')
    expect(redactSensitiveValues('版本号 v1.2.3 已发布')).toBe('版本号 v1.2.3 已发布')
  })
  it('短 token（<40）无前缀标记 → 保留（无法可靠判定，不误伤）', () => {
    expect(redactSensitiveValues('x=shorttoken')).toBe('x=shorttoken')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/redact.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/diagnostics/redact.ts
/**
 * 整 token 替换 [REDACTED]（替换型掩码，非 presence grep）：
 * 顺序关键——Bearer 先于 ≥40 长串（否则 Bearer token 先被长串规则命中）；短/无标记不误伤。
 */
const RULES: Array<{ re: RegExp; replacement: string }> = [
  { re: /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replacement: '[REDACTED]' },
  { re: /\b(?:sk-[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED]' },
  { re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g, replacement: '[REDACTED]' }
]

export function redactSensitiveValues(text: string): string {
  let out = text
  for (const { re, replacement } of RULES) out = out.replace(re, replacement)
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（6 项）

- [ ] **Step 5: 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/diagnostics/redact.ts apps/desktop/tests/unit/redact.spec.ts
git commit -m "feat(阶段1块B): 敏感值脱敏 redactSensitiveValues（Bearer/JWT/sk-/AKIA/≥40 高熵 base64 整替换）"
```

---

### Task 8: JSONL 日志（diagnostics/logger.ts）

**Files:**
- Create: `apps/desktop/src/main/diagnostics/logger.ts`
- Test: `apps/desktop/tests/unit/logger.spec.ts`

**Interfaces:**
- Consumes: Task 6 `FileWriter`、Task 7 `redactSensitiveValues`、现有 `MessageSanitizer`
- Produces:
  ```typescript
  export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
  export type LogFields = Record<string, string | number | boolean>
  export interface LogEvent { ts: string; level: LogLevel; logger: string; code: string; fields?: LogFields }
  export interface Logger {
    error(code: string, fields?: LogFields): void
    warn(code: string, fields?: LogFields): void
    info(code: string, fields?: LogFields): void
    debug(code: string, fields?: LogFields): void
    flush(): Promise<void>
    close(): Promise<void>
  }
  export function createLogger(module: string, opts: { level: LogLevel; writer: FileWriter; sanitize: MessageSanitizer }): Logger
  export function severityOf(level: LogLevel): number
  export function formatLogEvent(ev: LogEvent): string
  ```
  后续 Task 12 装配消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/logger.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createLogger, formatLogEvent, severityOf } from '../../src/main/diagnostics/logger'
import type { FileWriter } from '../../src/main/diagnostics/file-writer'

function fakeWriter(): { writer: FileWriter; lines: string[] } {
  const lines: string[] = []
  const writer: FileWriter = {
    append: vi.fn(async (l: string) => { lines.push(l) }),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  }
  return { writer, lines }
}
const noopSanitize = (m: string): string => m

describe('severityOf / 级别过滤', () => {
  it('error<warn<info<debug', () => {
    expect(severityOf('error')).toBeLessThan(severityOf('warn'))
    expect(severityOf('warn')).toBeLessThan(severityOf('info'))
    expect(severityOf('info')).toBeLessThan(severityOf('debug'))
  })
  it('threshold=info 时 debug 被滤、info 及以上写入', () => {
    const { writer, lines } = fakeWriter()
    const log = createLogger('main', { level: 'info', writer, sanitize: noopSanitize })
    log.debug('dbg')
    log.info('inf')
    log.warn('wrn')
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['info', 'warn'])
  })
})

describe('formatLogEvent / JSONL 结构', () => {
  it('JSONL 行含 ts/level/logger/code/fields', () => {
    const ev = { ts: 't', level: 'info' as const, logger: 'main', code: 'app:started', fields: { n: 1 } }
    const parsed = JSON.parse(formatLogEvent(ev))
    expect(parsed).toMatchObject({ ts: 't', level: 'info', logger: 'main', code: 'app:started', fields: { n: 1 } })
  })
  it('无 msg 字段（结构性禁记：消息正文无入口）', () => {
    const { writer } = fakeWriter()
    const log = createLogger('main', { level: 'debug', writer, sanitize: noopSanitize })
    log.info('some:code', { path: '/x' })
    const arg = (writer.append as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const parsed = JSON.parse(arg)
    expect(parsed.msg).toBeUndefined()
  })
})

describe('fields 净化', () => {
  it('路径经 sanitize、token 经 redact 后落盘', () => {
    const { writer, lines } = fakeWriter()
    const sanitize = (m: string): string => m.replace(/\/home\/alice/g, '~')
    const log = createLogger('main', { level: 'info', writer, sanitize })
    log.info('conn:failed', { path: '/home/alice/x', token: 'Bearer abc.def-ghi_123XYZ' })
    const parsed = JSON.parse(lines[0])
    expect(parsed.fields.path).toBe('~/x')
    expect(parsed.fields.token).toBe('Bearer [REDACTED]')
  })
})

describe('类型层禁记（编译期）', () => {
  it('logger 方法无 msg 自由文本参数', () => {
    const { writer } = fakeWriter()
    const log = createLogger('main', { level: 'debug', writer, sanitize: noopSanitize })
    // @ts-expect-error —— 无 msg 参数（结构性禁记：不接收消息正文）
    log.info('code', undefined, '这是消息正文，不允许')
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/logger.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/diagnostics/logger.ts
import type { MessageSanitizer } from './sanitize'
import type { FileWriter } from './file-writer'
import { redactSensitiveValues } from './redact'

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFields = Record<string, string | number | boolean>
export interface LogEvent {
  ts: string
  level: LogLevel
  logger: string
  code: string
  fields?: LogFields
}
export interface Logger {
  error(code: string, fields?: LogFields): void
  warn(code: string, fields?: LogFields): void
  info(code: string, fields?: LogFields): void
  debug(code: string, fields?: LogFields): void
  flush(): Promise<void>
  close(): Promise<void>
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
export function severityOf(level: LogLevel): number { return LOG_LEVEL_ORDER[level] }

export function formatLogEvent(ev: LogEvent): string { return JSON.stringify(ev) }

/**
 * JSONL logger。API = (code, fields?)，无 msg 参数——结构性禁记（无消息正文/Token 接收通道）。
 * fields 落盘前 sanitizePublicMessage（路径）+ redactSensitiveValues（秘密形态）双净化。
 * 写失败 fail-closed：吞掉不阻塞主流程。
 */
export function createLogger(module: string, opts: { level: LogLevel; writer: FileWriter; sanitize: MessageSanitizer }): Logger {
  const threshold = LOG_LEVEL_ORDER[opts.level]
  const log = (level: LogLevel, code: string, fields?: LogFields): void => {
    if (LOG_LEVEL_ORDER[level] > threshold) return
    const safe: LogFields = {}
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === 'string') safe[k] = redactSensitiveValues(opts.sanitize(v))
        else safe[k] = v
      }
    }
    const line = formatLogEvent({ ts: new Date().toISOString(), level, logger: module, code, fields: safe })
    void opts.writer.append(line).catch(() => { /* fail-closed */ })
  }
  return {
    error: (c, f) => log('error', c, f),
    warn: (c, f) => log('warn', c, f),
    info: (c, f) => log('info', c, f),
    debug: (c, f) => log('debug', c, f),
    flush: () => opts.writer.flush(),
    close: () => opts.writer.close()
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/logger.spec.ts`
Expected: PASS（6 项）

- [ ] **Step 5: typecheck（@ts-expect-error 由 tsc 验证）+ 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop typecheck && pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/diagnostics/logger.ts apps/desktop/tests/unit/logger.spec.ts
git commit -m "feat(阶段1块B): JSONL logger（无 msg 参数结构性禁记 + 级别过滤 + 落盘双净化 + fail-closed）"
```

---

### Task 9: 审计（diagnostics/audit.ts）

**Files:**
- Create: `apps/desktop/src/main/diagnostics/audit.ts`
- Test: `apps/desktop/tests/unit/audit.spec.ts`

**Interfaces:**
- Consumes: Task 6 `FileWriter`、Task 7 `redactSensitiveValues`、`MessageSanitizer`
- Produces:
  ```typescript
  export interface AuditEvent { ts: string; type: string; runtime?: string; toolId?: string; callId?: string; status?: string; durationMs?: number; summary?: string }
  export interface Auditor { audit(event: AuditEvent): Promise<void>; close(): Promise<void> }
  export function createAuditor(writer: FileWriter, opts: { sanitize: MessageSanitizer; retentionDays: number; dir: string }): Auditor
  export function auditFilesToDelete(files: readonly string[], retentionDays: number, today: Date): string[]
  ```
  后续 Task 12 装配消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/audit.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createAuditor, auditFilesToDelete } from '../../src/main/diagnostics/audit'
import type { FileWriter } from '../../src/main/diagnostics/file-writer'

function fakeWriter(): { writer: FileWriter; lines: string[] } {
  const lines: string[] = []
  return { writer: { append: vi.fn(async (l: string) => { lines.push(l) }), flush: vi.fn(async () => {}), close: vi.fn(async () => {}) }, lines }
}

describe('auditFilesToDelete（30 天清理纯函数）', () => {
  it('只删严格早于 today-retentionDays 的 audit-*.jsonl，不匹配不删', () => {
    const today = new Date(2026, 7, 10) // 2026-08-10
    const files = [
      'audit-2026-07-10.jsonl', // < cutoff(07-11) → 删
      'audit-2026-07-11.jsonl', // == cutoff → 保留
      'audit-2026-08-01.jsonl', // 近期 → 保留
      'notes.txt',              // 不匹配 → 不删
      'audit-bad-date.jsonl'    // 不匹配 → 不删
    ]
    expect(auditFilesToDelete(files, 30, today)).toEqual(['audit-2026-07-10.jsonl'])
  })
})

describe('createAuditor', () => {
  it('audit 事件 JSONL 落盘（summary 净化：路径+token 脱敏）', async () => {
    const { writer, lines } = fakeWriter()
    const sanitize = (m: string): string => m.replace(/\/home\/alice/g, '~')
    const a = createAuditor(writer, { sanitize, retentionDays: 30, dir: '/audit' })
    await a.audit({ ts: 't', type: 'tool:run', summary: 'read /home/alice/x with Bearer abc.def-ghi_123XYZ' })
    const parsed = JSON.parse(lines[0])
    expect(parsed.type).toBe('tool:run')
    expect(parsed.summary).toBe('read ~/x with Bearer [REDACTED]')
  })
  it('append-only：字段原样传递（file-writer 是 dumb append，净化只在此层）', async () => {
    const { writer, lines } = fakeWriter()
    const a = createAuditor(writer, { sanitize: (m) => m, retentionDays: 30, dir: '/audit' })
    await a.audit({ ts: 't', type: 'credential:set', toolId: 'tid', callId: 'cid', status: 'ok', durationMs: 12 })
    const parsed = JSON.parse(lines[0])
    expect(parsed.toolId).toBe('tid')
    expect(parsed.callId).toBe('cid')
    expect(parsed.durationMs).toBe(12)
  })
  it('close 委托 writer.close', async () => {
    const { writer } = fakeWriter()
    const a = createAuditor(writer, { sanitize: (m) => m, retentionDays: 30, dir: '/audit' })
    await a.close()
    expect(writer.close).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/audit.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/diagnostics/audit.ts
import { readdir, unlink } from 'fs/promises'
import { join } from 'path'
import type { FileWriter } from './file-writer'
import type { MessageSanitizer } from './sanitize'
import { redactSensitiveValues } from './redact'

export interface AuditEvent {
  ts: string
  type: string
  runtime?: string
  toolId?: string
  callId?: string
  status?: string
  durationMs?: number
  summary?: string
}
export interface Auditor { audit(event: AuditEvent): Promise<void>; close(): Promise<void> }

/** 日期解析格式固定（与 daily 文件名规范一致）：不匹配的文件永不删除 */
const AUDIT_DATE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export function auditFilesToDelete(files: readonly string[], retentionDays: number, today: Date): string[] {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - retentionDays)
  return files.filter((name) => {
    const m = AUDIT_DATE_RE.exec(name)
    if (!m) return false
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return d < cutoff // 严格早于 today-retentionDays → 删
  })
}

/** append-only 审计：summary 净化在此层（file-writer 是 dumb append）；启动清理 30 天前文件唯一归属此层 */
export function createAuditor(writer: FileWriter, opts: { sanitize: MessageSanitizer; retentionDays: number; dir: string }): Auditor {
  void (async () => {
    try {
      const names = await readdir(opts.dir)
      const toDelete = auditFilesToDelete(names, opts.retentionDays, new Date())
      await Promise.all(toDelete.map((n) => unlink(join(opts.dir, n)).catch(() => {})))
    } catch { /* 启动清理失败记录日志不阻塞 */ }
  })()
  return {
    async audit(event: AuditEvent): Promise<void> {
      const clean: AuditEvent = { ...event }
      if (event.summary !== undefined) clean.summary = redactSensitiveValues(opts.sanitize(event.summary))
      await writer.append(JSON.stringify(clean))
    },
    close: () => writer.close()
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（4 项）

- [ ] **Step 5: 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/diagnostics/audit.ts apps/desktop/tests/unit/audit.spec.ts
git commit -m "feat(阶段1块B): 审计 createAuditor（append-only + summary 层净化 + 30 天清理纯函数归属）"
```

---

### Task 10: 凭据库（credentials/credential-store.ts）

**Files:**
- Create: `apps/desktop/src/main/credentials/credential-store.ts`
- Test: `apps/desktop/tests/unit/credential-store.spec.ts`

**Interfaces:**
- Consumes: Task 1 `isKeyAllowed`、Task 3 `safe-storage`（`isSafeStorageUsable`/`encryptCredential`/`decryptCredential`/`isValidBase64`/`SafeStorageLike`）、Task 5 `atomicWriteFile`、`shared/errors` 扩展码
- Produces:
  ```typescript
  export interface CredentialFileSchemaV1 { version: 1; keys: Record<string, { enc: string; algo: 'safeStorage' }> }
  export class CredentialStore {
    constructor(filePath: string, safe: SafeStorageLike, isKeyAllowed: (key: string) => boolean, safeRoot: string)
    getStatus(key: string): Promise<CredentialStatus>
    setCredential(key: string, plaintext: string): Promise<void>
    getCredential(key: string): Promise<string | null>
    clearCredential(key: string): Promise<void>
  }
  ```
  后续 Task 11 IPC handler、Task 12 装配消费。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/credential-store.spec.ts
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CredentialStore } from '../../src/main/credentials/credential-store'
import { CyreneErrorCode } from '../../src/shared/errors'
import { isKeyAllowed } from '../../src/shared/contracts'

/** 假 safeStorage：enc:前缀往返；decrypt 可注入失败 */
function fakeSafe(over: Partial<Record<string, unknown>> = {}): any {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
    ...over
  }
}
function makeStore(over: { file?: string; safe?: any; safeRoot?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cy-creds-'))
  return new CredentialStore(over.file ?? join(root, 'credentials.json'), over.safe ?? fakeSafe(), isKeyAllowed, over.safeRoot ?? root)
}

describe('getStatus', () => {
  it('文件缺失 → empty', async () => {
    expect(await makeStore().getStatus('backend.token')).toBe('empty')
  })
  it('safeStorage 不可用 → unavailable（先于 empty：basic_text 新机返回 unavailable 而非 empty）', async () => {
    const store = makeStore({ safe: fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }) })
    expect(await store.getStatus('backend.token')).toBe('unavailable')
  })
  it('版本未知 → unavailable（读拒）', async () => {
    const s = makeStore()
    writeFileSync((s as any).filePath, JSON.stringify({ version: 99, keys: { 'backend.token': { enc: 'eA==', algo: 'safeStorage' } } }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('JSON 损坏 → unavailable（clear/set 可重建）', async () => {
    const s = makeStore()
    writeFileSync((s as any).filePath, '{oops', { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('base64 非法 → unavailable（非 locked）', async () => {
    const s = makeStore()
    writeFileSync((s as any).filePath, JSON.stringify({ version: 1, keys: { 'backend.token': { enc: 'AQI*', algo: 'safeStorage' } } }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('unavailable')
  })
  it('decrypt 抛错 → locked（keyring 锁）', async () => {
    const safe = fakeSafe({ decryptString: () => { throw new Error('locked') } })
    const s = makeStore({ safe })
    writeFileSync((s as any).filePath, JSON.stringify({ version: 1, keys: { 'backend.token': { enc: 'eA==', algo: 'safeStorage' } } }), { mode: 0o600 })
    expect(await s.getStatus('backend.token')).toBe('locked')
  })
  it('可读 → available', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'sk-secret')
    expect(await s.getStatus('backend.token')).toBe('available')
  })
})

describe('setCredential', () => {
  it('set 后文件 0600 + version:1 + 每 key 加密块', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'tok')
    const raw = JSON.parse(readFileSync((s as any).filePath, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.keys['backend.token'].algo).toBe('safeStorage')
    expect(raw.keys['backend.token'].enc).toBe(Buffer.from('enc:tok').toString('base64'))
    expect((await import('fs')).statSync((s as any).filePath).mode & 0o777).toBe(0o600)
  })
  it('safeStorage 不可用 → 抛 CREDENTIAL_UNAVAILABLE 且不落盘明文', async () => {
    const s = makeStore({ safe: fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }) })
    await expect(s.setCredential('backend.token', 'plaintext')).rejects.toMatchObject({ code: CyreneErrorCode.CREDENTIAL_UNAVAILABLE })
    const { existsSync } = await import('fs')
    expect(existsSync((s as any).filePath)).toBe(false)
  })
  it('非白名单 key → 抛 INVALID_INPUT', async () => {
    await expect(makeStore().setCredential('evil.key', 'x')).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
  })
  it('版本未知 → 抛 UNSUPPORTED_VERSION（写路径拒绝，不覆盖未来格式）', async () => {
    const s = makeStore()
    writeFileSync((s as any).filePath, JSON.stringify({ version: 2, keys: {} }), { mode: 0o600 })
    await expect(s.setCredential('backend.token', 'x')).rejects.toMatchObject({ code: CyreneErrorCode.UNSUPPORTED_VERSION })
  })
  it('损坏文件 → 写全新文件（整文件重建，只含本 key）', async () => {
    const s = makeStore()
    writeFileSync((s as any).filePath, '{corrupt', { mode: 0o600 })
    await s.setCredential('backend.token', 'fresh')
    const raw = JSON.parse(readFileSync((s as any).filePath, 'utf8'))
    expect(raw.keys['backend.token']).toBeTruthy()
  })
  it('重叠 set 串行化不丢更新（队列）', async () => {
    const s = makeStore()
    await Promise.all([
      s.setCredential('backend.token', 'a'),
      s.setCredential('backend.token', 'b')
    ])
    expect(await s.getCredential('backend.token')).toBe('b')
  })
})

describe('getCredential / clearCredential', () => {
  it('getCredential 返回明文（仅 Main 内部）', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'tok')
    expect(await s.getCredential('backend.token')).toBe('tok')
  })
  it('解密失败清缓存 → 后续 getCredential 返回 null（不返回陈旧明文）', async () => {
    let fail = false
    const safe = fakeSafe({ decryptString: (b: Buffer) => { if (fail) throw new Error('locked'); return b.toString().replace(/^enc:/, '') } })
    const s = makeStore({ safe })
    await s.setCredential('backend.token', 'tok')
    fail = true
    expect(await s.getStatus('backend.token')).toBe('locked') // getStatus 解密失败 → 清缓存 + locked
    expect(await s.getCredential('backend.token')).toBe(null) // 缓存已清，重解密失败 → null
  })
  it('clear 移除 key、清缓存', async () => {
    const s = makeStore()
    await s.setCredential('backend.token', 'tok')
    await s.clearCredential('backend.token')
    expect(await s.getStatus('backend.token')).toBe('empty')
    expect(await s.getCredential('backend.token')).toBe(null)
  })
  it('clear 遇损坏文件 → 写全新空文件（整文件重建）', async () => {
    const s = makeStore()
    writeFileSync((s as any).filePath, '{corrupt', { mode: 0o600 })
    await s.clearCredential('backend.token')
    const raw = JSON.parse(readFileSync((s as any).filePath, 'utf8'))
    expect(raw).toEqual({ version: 1, keys: {} })
  })
  it('clear 遇版本未知 → 抛 UNSUPPORTED_VERSION', async () => {
    const s = makeStore()
    writeFileSync((s as any).filePath, JSON.stringify({ version: 3, keys: {} }), { mode: 0o600 })
    await expect(s.clearCredential('backend.token')).rejects.toMatchObject({ code: CyreneErrorCode.UNSUPPORTED_VERSION })
  })
  it('safeStorage 不可用但文件可解析 → clear 仍可移除（不需解密）', async () => {
    const s = makeStore({ safe: fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }) })
    writeFileSync((s as any).filePath, JSON.stringify({ version: 1, keys: { 'backend.token': { enc: 'eA==', algo: 'safeStorage' } } }), { mode: 0o600 })
    await s.clearCredential('backend.token')
    const raw = JSON.parse(readFileSync((s as any).filePath, 'utf8'))
    expect(raw.keys['backend.token']).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/credential-store.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/credentials/credential-store.ts
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import { atomicWriteFile } from './atomic-write'
import { decryptCredential, encryptCredential, isSafeStorageUsable, isValidBase64, type SafeStorageLike } from './safe-storage'

export const CREDENTIAL_FILE_VERSION = 1 as const
export interface CredentialFileSchemaV1 {
  version: typeof CREDENTIAL_FILE_VERSION
  keys: Record<string, { enc: string; algo: 'safeStorage' }>
}

const EMPTY_FILE: CredentialFileSchemaV1 = { version: 1, keys: {} }

export class CredentialStore {
  private queue: Promise<unknown> = Promise.resolve()
  private cache = new Map<string, string>()

  constructor(
    private readonly filePath: string,
    private readonly safe: SafeStorageLike,
    private readonly isKeyAllowed: (key: string) => boolean,
    private readonly safeRoot: string
  ) {}

  /** 串行队列：.then(op, op) 两个参——任一 op reject 只影响该次，不毒化后续 op */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => {})
    return run
  }

  private async readFile(): Promise<CredentialFileSchemaV1 | null> {
    const { openSafeFile } = await import('../persistence/safe-open')
    let fd
    try {
      const r = await openSafeFile(this.filePath, { mode: 'existing', purpose: 'read', safeRoot: this.safeRoot })
      fd = r.fd
      const text = await fd.readFile('utf8')
      return JSON.parse(text) as CredentialFileSchemaV1
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e // JSON 解析失败 / 权限 / 逃逸 → 调用方按损坏或不可用处理
    } finally {
      await fd?.close().catch(() => {})
    }
  }

  async getStatus(key: string): Promise<'unavailable' | 'locked' | 'empty' | 'available'> {
    if (!this.isKeyAllowed(key)) return 'unavailable' // fail-closed（IPC zod 已拦，store 防御兜底）
    let file: CredentialFileSchemaV1 | null
    try { file = await this.readFile() } catch { return 'unavailable' } // JSON 损坏 / 权限
    if (file && file.version !== CREDENTIAL_FILE_VERSION) return 'unavailable' // 版本未知：读拒
    if (!isSafeStorageUsable(this.safe)) return 'unavailable' // 先于 empty
    if (!file) return 'empty'
    const block = file.keys[key]
    if (!block) return 'empty'
    if (!isValidBase64(block.enc)) return 'unavailable' // 损坏 blob 不误归 locked
    try {
      const plaintext = decryptCredential(this.safe, Buffer.from(block.enc, 'base64'))
      this.cache.set(key, plaintext)
      return 'available'
    } catch {
      this.cache.delete(key) // 解密失败即清缓存
      return 'locked'
    }
  }

  async setCredential(key: string, plaintext: string): Promise<void> {
    if (!this.isKeyAllowed(key)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'key 不在白名单')
    await this.enqueue(async () => {
      if (!isSafeStorageUsable(this.safe)) throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '系统钥匙串不可用')
      let file: CredentialFileSchemaV1
      try { file = (await this.readFile()) ?? EMPTY_FILE } catch { file = EMPTY_FILE } // 损坏 → 整文件重建
      if (file.version !== CREDENTIAL_FILE_VERSION) throw new CyreneError(CyreneErrorCode.UNSUPPORTED_VERSION, '凭据文件版本不受支持')
      const enc = encryptCredential(this.safe, plaintext).toString('base64')
      file.keys[key] = { enc, algo: 'safeStorage' }
      await atomicWriteFile(this.filePath, JSON.stringify(file, null, 2), { safeRoot: this.safeRoot })
      this.cache.set(key, plaintext)
    })
  }

  async getCredential(key: string): Promise<string | null> {
    if (!this.isKeyAllowed(key)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'key 不在白名单')
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    if ((await this.getStatus(key)) === 'available') return this.cache.get(key) ?? null
    return null // unavailable/locked/empty → 无明文可给
  }

  async clearCredential(key: string): Promise<void> {
    if (!this.isKeyAllowed(key)) throw new CyreneError(CyreneErrorCode.INVALID_INPUT, 'key 不在白名单')
    await this.enqueue(async () => {
      let file: CredentialFileSchemaV1
      try { file = (await this.readFile()) ?? EMPTY_FILE } catch { file = EMPTY_FILE } // 损坏 → 整文件重建（丢其他键，契约注明）
      if (file.version !== CREDENTIAL_FILE_VERSION) throw new CyreneError(CyreneErrorCode.UNSUPPORTED_VERSION, '凭据文件版本不受支持')
      delete file.keys[key]
      await atomicWriteFile(this.filePath, JSON.stringify(file, null, 2), { safeRoot: this.safeRoot })
      this.cache.delete(key)
    })
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同上
Expected: PASS（19 项）

- [ ] **Step 5: 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/credentials/credential-store.ts apps/desktop/tests/unit/credential-store.spec.ts
git commit -m "feat(阶段1块B): CredentialStore——getStatus 4 态顺序/未知版本拒读写/损坏重建/串行队列/解密失败清缓存"
```

---

### Task 11: 凭据 IPC 接线 + preload

**Files:**
- Create: `apps/desktop/src/main/credentials/index.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`（+3 方法 + 信封守卫）
- Modify: `apps/desktop/src/preload/index.d.ts`（Window.desktopApi 类型扩展）
- Test: `apps/desktop/tests/unit/credentials-ipc.spec.ts`
  （`handlers.ts` 接线在 Task 12 做——避免 Task 11 改动 `registerHandlers` 签名而 main/index.ts 尚未传依赖导致 typecheck 断裂）

**Interfaces:**
- Consumes: Task 1 `BACKEND_TOKEN_KEY`/`isKeyAllowed`、Task 2 通道常量 + schema、Task 10 `CredentialStore`、现有 `createIpcHandler`/`registerHandler`/`IpcResult`
- Produces:
  ```typescript
  // main/credentials/index.ts
  export function createCredentialsExecutors(store, opts: { logger; sanitize }): { getStatus; set; clear } // 纯工厂（可单测）
  export function registerCredentialsHandlers(store: CredentialStore, opts: { logger: Logger; sanitize: MessageSanitizer }): void
  // preload desktopApi 新增
  getCredentialStatus(): Promise<CredentialStatus>
  setBackendToken(token: string): Promise<CredentialStatus>
  clearBackendToken(): Promise<CredentialStatus>
  ```
  后续 Task 12 装配调用 `registerCredentialsHandlers`（经 `createCredentialsExecutors`）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/credentials-ipc.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createCredentialsExecutors } from '../../src/main/credentials'
import { CyreneError, CyreneErrorCode } from '../../src/shared/errors'
import { BACKEND_TOKEN_KEY } from '../../src/shared/contracts'

const noopSanitize = (m: string): string => m
const fakeLogger: any = { info: vi.fn() }
function makeExecutors(store: any) {
  return createCredentialsExecutors(store, { logger: fakeLogger, sanitize: noopSanitize })
}

describe('createCredentialsExecutors', () => {
  it('get-status 固定查 BACKEND_TOKEN_KEY（0 参）', async () => {
    const store: any = { getStatus: vi.fn(async () => 'empty') }
    const res = await makeExecutors(store).getStatus(undefined)
    expect(res).toEqual({ ok: true, data: { status: 'empty', key: 'backend.token' } })
    expect(store.getStatus).toHaveBeenCalledWith('backend.token')
  })
  it('set 成功 → 响应 {status,key}（value 不回显）', async () => {
    const store: any = { getStatus: vi.fn(async () => 'available'), setCredential: vi.fn(async () => {}) }
    const res = await makeExecutors(store).set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toEqual({ ok: true, data: { status: 'available', key: 'backend.token' } })
    expect(store.setCredential).toHaveBeenCalledWith('backend.token', 'sk-x')
  })
  it('set 抛 CREDENTIAL_UNAVAILABLE → 信封 ok:false（preload 据此抛错而非 undefined status）', async () => {
    const store: any = {
      getStatus: vi.fn(async () => 'unavailable'),
      setCredential: vi.fn(async () => { throw new CyreneError(CyreneErrorCode.CREDENTIAL_UNAVAILABLE, '钥匙串不可用') })
    }
    const res = await makeExecutors(store).set({ key: BACKEND_TOKEN_KEY, value: 'sk-x' })
    expect(res).toMatchObject({ ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE' } })
  })
  it('非法 key → SCHEMA_VALIDATION_FAILED（allowlist refine 拦）', async () => {
    const res = await makeExecutors({}).clear({ key: 'evil' })
    expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  })
  it('clear 成功 → 响应 {status,key}', async () => {
    const store: any = { getStatus: vi.fn(async () => 'empty'), clearCredential: vi.fn(async () => {}) }
    const res = await makeExecutors(store).clear({ key: BACKEND_TOKEN_KEY })
    expect(res).toEqual({ ok: true, data: { status: 'empty', key: 'backend.token' } })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/credentials-ipc.spec.ts`
Expected: FAIL（`main/credentials` 模块不存在——本任务纯工厂是测试目标，红阶段真实）

- [ ] **Step 3: 实现**

```typescript
// src/main/credentials/index.ts
import { z } from 'zod'
import { IpcChannels, BACKEND_TOKEN_KEY, type IpcResult } from '@shared/contracts'
import type { CredentialStatus } from '@shared/contracts'
import type { Logger } from '../diagnostics/logger'
import type { MessageSanitizer } from '../diagnostics/sanitize'
import { createIpcHandler } from '../ipc/executor'
import { registerHandler } from '../ipc/registry'
import { credentialStatusSchema, credentialsClearSchema, credentialsSetSchema } from '../ipc/channels'
import type { CredentialStore } from './credential-store'

type CredentialExecutor = (raw: unknown) => Promise<IpcResult<{ status: CredentialStatus; key: string }>>

/** 凭据生命周期元数据（无秘密值）写入日志：status 变化才记；before 须在变更前捕获 */
async function maybeLogStatusChange(logger: Logger, store: CredentialStore, key: string, before: string): Promise<void> {
  try {
    const after = await store.getStatus(key)
    if (before !== after) logger.info('credential:status-change', { key, from: before, to: after })
  } catch { /* 元数据日志失败不阻断 */ }
}

/** 纯工厂（可单测）：三个通道的 executor，不触碰 electron registry */
export function createCredentialsExecutors(store: CredentialStore, opts: { logger: Logger; sanitize: MessageSanitizer }): {
  getStatus: CredentialExecutor
  set: CredentialExecutor
  clear: CredentialExecutor
} {
  return {
    getStatus: createIpcHandler(z.undefined(), credentialStatusSchema,
      async () => { const key = BACKEND_TOKEN_KEY; return { status: await store.getStatus(key), key } },
      { sanitize: opts.sanitize }),
    set: createIpcHandler(credentialsSetSchema, credentialStatusSchema,
      async (req) => {
        const before = await store.getStatus(req.key)
        await store.setCredential(req.key, req.value)
        await maybeLogStatusChange(opts.logger, store, req.key, before)
        return { status: await store.getStatus(req.key), key: req.key }
      },
      { sanitize: opts.sanitize }),
    clear: createIpcHandler(credentialsClearSchema, credentialStatusSchema,
      async (req) => {
        const before = await store.getStatus(req.key)
        await store.clearCredential(req.key)
        await maybeLogStatusChange(opts.logger, store, req.key, before)
        return { status: await store.getStatus(req.key), key: req.key }
      },
      { sanitize: opts.sanitize })
  }
}

export function registerCredentialsHandlers(store: CredentialStore, opts: { logger: Logger; sanitize: MessageSanitizer }): void {
  const h = createCredentialsExecutors(store, opts)
  registerHandler(IpcChannels.credentialsGetStatus, h.getStatus, 0)
  registerHandler(IpcChannels.credentialsSet, h.set, 1)
  registerHandler(IpcChannels.credentialsClear, h.clear, 1)
}
```
```

修改 `src/preload/desktop-api.ts`——追加三方法（统一解包 `.status`，信封守卫）：
```typescript
import { BACKEND_TOKEN_KEY, IpcChannels, type CredentialStatus, type IpcChannelName, type IpcResult } from '@shared/contracts'

async function invokeWithArgs<T>(channel: IpcChannelName, payload?: unknown): Promise<IpcResult<T>> {
  try {
    return (await (payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload))) as IpcResult<T>
  } catch { throw new Error('[IPC_ERROR] IPC 调用失败') }
}

const STATUS_ENUM = ['unavailable', 'locked', 'empty', 'available'] as const
function isCredentialStatus(v: unknown): v is CredentialStatus {
  return typeof v === 'string' && (STATUS_ENUM as readonly string[]).includes(v)
}

interface CredentialStatusResponse { status: CredentialStatus; key: string }

function unwrapStatus(res: IpcResult<CredentialStatusResponse>): CredentialStatus {
  if (res && typeof res === 'object' && res.ok === true &&
      res.data && typeof res.data === 'object' && isCredentialStatus(res.data.status)) return res.data.status
  if (res && typeof res === 'object' && res.ok === false &&
      res.error && typeof res.error.code === 'string' && typeof res.error.message === 'string') {
    throw new Error(`[${res.error.code}] ${res.error.message}`)
  }
  throw new Error('[IPC_ERROR] IPC 返回格式异常')
}

export const desktopApi = {
  getAppInfo, // 原实现保持（对象内同名简写，见上方既有代码）
  getCredentialStatus: async (): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsGetStatus)),
  setBackendToken: async (token: string): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsSet, { key: BACKEND_TOKEN_KEY, value: token })),
  clearBackendToken: async (): Promise<CredentialStatus> =>
    unwrapStatus(await invokeWithArgs<CredentialStatusResponse>(IpcChannels.credentialsClear, { key: BACKEND_TOKEN_KEY }))
}
```

修改 `src/preload/index.d.ts`：
```typescript
import type { AppInfo, CredentialStatus } from '@shared/contracts'
declare global {
  interface Window {
    desktopApi: {
      getAppInfo(): Promise<AppInfo>
      getCredentialStatus(): Promise<CredentialStatus>
      setBackendToken(token: string): Promise<CredentialStatus>
      clearBackendToken(): Promise<CredentialStatus>
    }
  }
}
export {}
```

- [ ] **Step 4: 运行测试确认通过 + typecheck**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/credentials-ipc.spec.ts && pnpm --filter @cyrene/desktop typecheck`
Expected: PASS（5 项）+ typecheck 干净

- [ ] **Step 5: 全量单测 + 提交**

Run: `pnpm --filter @cyrene/desktop test` 全绿后：
```bash
git add apps/desktop/src/main/credentials/index.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/index.d.ts apps/desktop/tests/unit/credentials-ipc.spec.ts
git commit -m "feat(阶段1块B): 凭据 IPC 接线 + preload（get-status/set/clear 统一 {status,key} + 信封守卫 + key 固定派生常量）"
```

---

### Task 12: 装配（main/index.ts + 生命周期）

**Files:**
- Create: `apps/desktop/src/main/diagnostics/index.ts`（`createDiagnostics` 工厂）
- Create: `apps/desktop/src/main/shutdown.ts`（`createShutdownHandler` 可测工厂）
- Modify: `apps/desktop/src/main/index.ts`（接线：diagnostics + store + handlers + before-quit + 生命周期日志）
- Modify: `apps/desktop/src/main/ipc/handlers.ts`（`registerHandlers` 改收 deps + 注册凭据通道）
- Modify: `apps/desktop/src/main/windows/main-window.ts`（console.error → logger）
- Test: `apps/desktop/tests/unit/shutdown.spec.ts`

**Interfaces:**
- Consumes: Task 6 `createFileWriter`、Task 8 `createLogger`/`LogLevel`、Task 9 `createAuditor`、Task 10 `CredentialStore`、Task 11 `registerCredentialsHandlers`、现有 `ensureUserDataDirs`/`expectedUserDataBase`/`getAppConfig`/`registerHandlers`/`createSanitizePublicMessage`/`installAppIdentity`
- Produces:
  ```typescript
  // main/diagnostics/index.ts
  export interface Diagnostics { logger: Logger; auditor: Auditor; closeAll(): Promise<void> }
  export function createDiagnostics(dirs: { logs: string; audit: string }, opts: { logLevel: LogLevel; retentionDays: number; sanitize: MessageSanitizer }): Diagnostics
  // main/shutdown.ts
  export interface ShutdownDeps { closeAll(): Promise<void>; quit(): void; timeoutMs?: number }
  export function createShutdownHandler(deps: ShutdownDeps): (e: { preventDefault(): void }) => void
  ```

- [ ] **Step 1: 写失败测试（shutdown handler）**

```typescript
// tests/unit/shutdown.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createShutdownHandler } from '../../src/main/shutdown'

function makeDeps(over: Partial<{ closeAll: () => Promise<void>; quit: () => void; timeoutMs: number }> = {}) {
  return {
    closeAll: over.closeAll ?? vi.fn(async () => {}),
    quit: over.quit ?? vi.fn(),
    timeoutMs: over.timeoutMs
  }
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
  it('flushing 期间二次事件：preventDefault 但不重复 flush（防二次 quit 绕过 finish）', async () => {
    let resolveClose: () => void = () => {}
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>((r) => { resolveClose = r })) })
    const h = createShutdownHandler(deps)
    h(ev()); h(ev()) // 第二次在 flush 中
    expect(deps.closeAll).toHaveBeenCalledTimes(1)
    resolveClose()
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalledTimes(1))
  })
  it('flush 完成后最终 quit 的事件：不再 preventDefault（allowQuit 放行，防挂死）', async () => {
    const deps = makeDeps()
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
    const e2 = ev()
    h(e2) // 模拟 quit 触发的二次 before-quit
    expect(e2.preventDefault).not.toHaveBeenCalled()
  })
  it('closeAll 抛错仍 quit（finally 恒执行）', async () => {
    const deps = makeDeps({ closeAll: vi.fn(async () => { throw new Error('disk full') }) })
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled())
  })
  it('closeAll 挂起 → 超时后仍 quit（1.5s race）', async () => {
    const deps = makeDeps({ closeAll: vi.fn(() => new Promise<void>(() => {})), timeoutMs: 20 })
    const h = createShutdownHandler(deps)
    h(ev())
    await vi.waitFor(() => expect(deps.quit).toHaveBeenCalled(), { timeout: 200 })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/shutdown.spec.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// src/main/shutdown.ts
export interface ShutdownDeps {
  closeAll(): Promise<void>
  quit(): void
  timeoutMs?: number
}

/**
 * before-quit flush 处理器（可测工厂）：
 * allowQuit 放行标志——finish 完成后最终 app.quit() 不再被 preventDefault 拦截（否则进程永不退出）；
 * 每次事件 preventDefault（flushing 期间二次 quit 被拦，防绕过 finish）；
 * finish 每步独立 try/catch；1.5s race 超时只「放弃等待」不「与在途写竞速」；finally(quit) 恒执行。
 */
export function createShutdownHandler(deps: ShutdownDeps): (e: { preventDefault(): void }) => void {
  let flushing = false
  let allowQuit = false
  return (e) => {
    if (allowQuit) return // 最终 quit 放行
    e.preventDefault()
    if (flushing) return
    flushing = true
    const finish = async (): Promise<void> => {
      try { await deps.closeAll() } catch { /* 不阻断 */ }
    }
    const quit = (): void => { allowQuit = true; deps.quit() }
    void Promise.race([finish(), new Promise((r) => setTimeout(r, deps.timeoutMs ?? 1500))])
      .catch(() => {})
      .finally(quit)
  }
}
```

```typescript
// src/main/diagnostics/index.ts
import { createFileWriter } from './file-writer'
import { createLogger, type LogLevel, type Logger } from './logger'
import { createAuditor, type Auditor } from './audit'
import type { MessageSanitizer } from './sanitize'

export interface Diagnostics { logger: Logger; auditor: Auditor; closeAll(): Promise<void> }

/** 装配：rotate 日志（5MB×3 异步批量）+ daily 审计（sync 写）+ 30 天清理；closeAll 串行关闭 */
export function createDiagnostics(dirs: { logs: string; audit: string }, opts: {
  logLevel: LogLevel
  retentionDays: number
  sanitize: MessageSanitizer
}): Diagnostics {
  const logWriter = createFileWriter({ dir: dirs.logs, baseName: 'app', mode: 'rotate', maxSizeBytes: 5 * 1024 * 1024, maxFiles: 3, sync: false })
  const auditWriter = createFileWriter({ dir: dirs.audit, baseName: 'audit', mode: 'daily', retentionDays: opts.retentionDays, sync: true })
  const logger = createLogger('main', { level: opts.logLevel, writer: logWriter, sanitize: opts.sanitize })
  const auditor = createAuditor(auditWriter, { sanitize: opts.sanitize, retentionDays: opts.retentionDays, dir: dirs.audit })
  return {
    logger,
    auditor,
    closeAll: async () => {
      try { await logger.close() } catch { /* 不阻断 */ }
      try { await auditor.close() } catch { /* 不阻断 */ }
    }
  }
}
```

修改 `src/main/index.ts`——**替换** try 块内既有区段（现有 line 80 已有 `const config = getAppConfig()`、line 82 已有 `await ensureUserDataDirs(...)`、line 83 已有 0 参 `registerHandlers()`、line 88-90 协议注册、line 91-92 `markAppStarted(); ensureMainWindow()`），**不新增重复声明**：
- **imports 追加**：`realpath`（from 'fs/promises'）、`safeStorage`（electron）、`createDiagnostics`（from './diagnostics'）、`createShutdownHandler`（from './shutdown'）、`CredentialStore`（from './credentials/credential-store'）、`isKeyAllowed`（from '@shared/contracts'）、`createSanitizePublicMessage`（from './diagnostics/sanitize'）
- **替换区段**（从旧 `const config = getAppConfig()` 起到旧 `ensureMainWindow()` 止）：
```typescript
    const config = getAppConfig()
    if (!config.devToolsAllowed) applyProductionMenu() // 打包：无 View→DevTools 加速键（mac 保 Cmd+Q/C/V）
    const dirs = await ensureUserDataDirs(expectedUserDataBase(), { baseCreated })
    const sanitize = createSanitizePublicMessage({ home: app.getPath('home'), userData: expectedUserDataBase() })
    const safeRoot = await realpath(expectedUserDataBase())
    const diagnostics = createDiagnostics({ logs: dirs.logs, audit: dirs.audit }, { logLevel: config.logLevel, retentionDays: 30, sanitize })
    const store = new CredentialStore(join(dirs.config, 'credentials.json'), safeStorage, isKeyAllowed, safeRoot)
    registerHandlers({ credentials: store, logger: diagnostics.logger })
    app.on('before-quit', createShutdownHandler({ closeAll: diagnostics.closeAll, quit: () => app.quit() }))
    diagnostics.logger.info('app:user-data-ready', { baseCreated, config: dirs.config, logs: dirs.logs, audit: dirs.audit })
    if (!shouldUseViteDevServer(app.isPackaged, process.env)) {
      await registerCyreneProtocolHandler(join(__dirname, '../renderer'))
      diagnostics.logger.info('protocol:registered')
    }
    diagnostics.logger.info('app:started', { mode: config.mode, packaged: app.isPackaged })
    markAppStarted()
    ensureMainWindow((err) => diagnostics.logger.error('window:load-failed', { message: sanitize(err instanceof Error ? err.message : String(err)) }))
```
- 注：`config.logLevel` 块 A `AppConfig` 已含（其 `LogLevel` 与 logger.ts 同构，结构可赋值）。`safeRoot = await realpath(...)` 为普通 realpath（弱于块 A fd 锚点）——spec §5.2 措辞即 realpath 包含性，接受并记录为实施新增决策。

修改 `src/main/ipc/handlers.ts`——`registerHandlers` 收凭据与 logger 依赖，注册凭据通道：
```typescript
import { registerCredentialsHandlers } from '../credentials'
import type { CredentialStore } from '../credentials/credential-store'
import type { Logger } from '../diagnostics/logger'

export function registerHandlers(deps: { credentials: CredentialStore; logger: Logger }): void {
  const sanitize = createSanitizePublicMessage({
    home: app.getPath('home'),
    userData: app.getPath('userData') // installAppIdentity 已 setPath('userData')——此处精确取，勿用字面量推导（单一事实来源）
  })
  registerHandler(IpcChannels.appGetInfo, createIpcHandler(z.undefined(), appInfoSchema, () => getAppInfo(), { sanitize }), 0)
  registerCredentialsHandlers(deps.credentials, { logger: deps.logger, sanitize })
}
```

修改 `src/main/windows/main-window.ts`：`createMainWindow` 增加可选参数 `loadErrorSink?: (err: unknown) => void`，两处 `console.error` 替换为 `loadErrorSink?.(err)`（块 A 注释「块 B 建 logger 后换」兑现）；`ensureMainWindow` 透传该参数（`ensureMainWindow(loadErrorSink?)`），`focusOrDefer`/`second-instance` 场景不传（无 sink 时维持原 console.error 不崩）。

- [ ] **Step 4: 运行测试确认通过 + typecheck + 全量单测**

Run: `pnpm --filter @cyrene/desktop test -- --run --reporter=verbose tests/unit/shutdown.spec.ts && pnpm --filter @cyrene/desktop typecheck && pnpm --filter @cyrene/desktop test`
Expected: shutdown 5 项 PASS；typecheck 干净；全量单测全绿（约 130+ 项）

- [ ] **Step 5: 全量验证（含块 A 回归）**

Run: `pnpm --filter @cyrene/desktop lint && pnpm --filter @cyrene/desktop build`
Expected: lint 无告警；build 产出 main/preload/renderer 三产物。
**备注（实施新增决策，需记录到 spec §10 与最终报告）：** `config.logLevel` 块 A 已含，无需补字段；`safeRoot = realpath(...)` 为普通 realpath（弱于块 A fd 锚点），spec §5.2 措辞即 realpath 包含性，接受。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/main/diagnostics/index.ts apps/desktop/src/main/shutdown.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/src/main/windows/main-window.ts apps/desktop/tests/unit/shutdown.spec.ts
git commit -m "feat(阶段1块B): 装配——diagnostics 工厂 + before-quit flush(allowQuit 防挂死) + 生命周期日志 + handlers 接线 + main-window 加载失败接 logger"
```

---

## 自审清单（Self-Review）

- [ ] **Spec 覆盖**：§5.1 safe-storage（Task 3）、§5.2 credential-store（Task 10）、§5.3 IPC（Task 2/11）、§5.4 file-writer（Task 6）、§5.5 logger（Task 8）、§5.6 audit（Task 9）、§5.7 装配（Task 12）、shared/contracts/credentials（Task 1）、persistence 安全助手（Task 4）、atomicWriteFile（Task 5）、redact（Task 7）、errors 扩展（Task 3b/10）——全部有任务。
- [ ] **验收#2 写路径未知版本**：Task 10 测试含 set/clear 对未知版本抛 UNSUPPORTED_VERSION。
- [ ] **验收#5 读不回 value**：Task 11 preload 只解包 `.status`，无明文读取 API。
- [ ] **验收#6 结构性禁记**：Task 8 `@ts-expect-error` + 无 msg 字段断言。
- [ ] **验收#8 块 A 不回归**：Task 4 Step 5、Task 12 Step 5 显式跑块 A 测试。
- [ ] **占位符扫描**：所有代码步骤均给出实际实现；无 TBD/TODO。
- [ ] **类型一致性**：`createFileWriter`/`Logger`/`Auditor`/`CredentialStore` 签名跨任务一致（Task 6→8→9→12；Task 10→11→12）；`safe-open` 的 `onConflict` 被 Task 5/6 分别以 `'error'`/`'fallback'` 消费。
- [ ] **B-5 单一来源**：isKeyAllowed 只在 shared/contracts/credentials.ts 定义，zod/store/preload 全派生。
- [ ] **接受项（记录为实施新增决策）**：`safeRoot = realpath(...)` 为普通 realpath（弱于块 A fd 锚点，spec §5.2 措辞即 realpath 包含性）；`LogLevel` 在 config/env.ts 与 logger.ts 双定义（同构、结构可赋值）——块 B 文档收尾回写 spec §10 与最终报告。
