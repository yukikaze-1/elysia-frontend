# 阶段 6 批次 B（Main 工具服务/权限/四执行器/UI）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 F-6-07~18 + F-6-22/24：四工具静态注册表 → Main tool-service 全生命周期（幂等/风险/黑名单/授权/状态机/审计）→ 四执行器安全执行 → tool-status-sender 六态回传 + 附件上传 → tool:event 推送 → toolStore 归一化 → CyToolCard/CyToolApproval 双区渲染 + Live2D waiting_permission → mock 改接真实入口 → 门禁全绿（三态=已开发、未联调）。

**Architecture:** Desktop 工具状态单一来源 = Main tool-service（决策链 15 步）；状态经 `tool:event`（PublicToolEvent）推 Renderer；Backend 展示事件（tool.started/completed）仍走 chat:event；归档（Message.toolCalls）为持久权威。Renderer 永不接触原始 arguments/paramHash/路径。

**Tech Stack:** Electron 43.3.0 / Vue 3.5 / TypeScript 5.6 / Pinia 4 / zod 4 / jsdiff（npm `diff` ^9.0.0，本批新增）/ Vitest 4（node + happy-dom）/ Playwright（集成）。

**Spec:** `docs/superpowers/specs/2026-08-20-phase6-tools-batchb-main-exec-ui-design.md`（binding——每个 task 的字段形状/决策编号（D6B-01~22）/错误码以 spec 为权威；本 plan 只给代码骨架与精确签名）

## Global Constraints

- 三态纪律：本批完成标「**已开发、未联调**」，禁止「已完成」断言（spec §8）。
- 永不 push（git push 只由开发者手动）；docs 全中文；check:contract 计数 WS 32/32 + 8 未纳 warn + REST 15/15；**批次 B 不改 raw wire → 不刷新 fixture manifest**（唯一例外：若必须改 `RawFrameSchema`/`RawClientFrameSchema` 服务端帧 shape → 跑 `pnpm -F @cyrene/desktop exec node scripts/refresh-wire-manifests.mjs`）。
- 版本：Node 22.23.0（`.nvmrc`，所有 pnpm 命令前缀 `nvm use` 或直接 `pnpm`）；集成测试 `xvfb-run -a pnpm test:integration`；jsdiff 版本 `"diff": "^9.0.0"`（自带类型，无 @types/diff）。
- IPC 纪律：`registerHandler`/`registerOneWayHandler` + `isTrustedSender` + zod 双端 + `SCHEMA_VALIDATION_FAILED`；零通用 `invoke(channel)`；`tool.status` 只能 Main 组装（D6-07）。
- 安全常量（spec D6B-02/06）：`FILE_READ_MAX_BYTES=2MiB`、`RESULT_INLINE_BYTES=64KiB`、`MAX_WRITE_CONTENT_BYTES=2MiB`、`SELECT_EXEMPT_TTL_MS=10*60*1000`、`MAX_DIFF_LINES=100`、缩略图 data URL ≤64KiB、预览 data URL ≤256KiB——全部常量化（对齐附件限额常量先例 `shared/contracts/attachments.ts:68-70`）。
- 每 task 结束跑该 task 相关的单测 + typecheck；Task 8 跑全门禁。
- review 上限 5 轮；执行偏离记 `docs/review/2026-08-20-阶段6批次B-决策记录.md`（Task 8 建）。

---

### Task 1: 契约与政策层（shared 扩展 + tool-policy + tool-registry）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/tool.ts`
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`
- Create: `apps/desktop/src/main/tools/tool-policy.ts`
- Create: `apps/desktop/src/main/tools/tool-registry.ts`
- Test: `apps/desktop/tests/unit/tool-policy.spec.ts`（新）、`apps/desktop/tests/unit/tool-public-events.spec.ts`（新）、`apps/desktop/tests/unit/contracts-tool.spec.ts`（增）

**Interfaces:**
- Consumes: 既有 `ToolCallRecord`（tool.ts，batch A）、`IpcChannels`/`PushChannels`（ipc.ts）、`MessageSchema`（ipc-response.ts:87-102）、`redactToolArguments`（main/tools/input-summary.ts）
- Produces: `PublicToolEvent`/`DiffLine`（shared，IPC 双端）；`ToolCallRecord.attachmentCount?`；`PushChannels.toolEvent` + 5 个 invoke 通道；`ToolCallRecordSchema`/`PublicToolEventSchema` + `MessageSchema.toolCalls` 挂载；`PATH_BLACKLIST_DEFAULTS`/`isPathBlacklisted`/`normalizeToolPath`/`isDomainAllowed`；`createToolRegistry()`/`RegisteredTool`/`TOOL_NAMES`——后续 task 全部依赖

- [ ] **Step 1: 写失败测试——shared 契约形状（contracts-tool.spec.ts 增）**

```typescript
// tests/unit/contracts-tool.spec.ts 追加 describe('PublicToolEvent / ToolCallRecord.attachmentCount'）
import { describe, expect, it } from 'vitest'
import { PublicToolEvent, ToolCallRecord } from '@shared/contracts/tool'

const MINIMAL_EVENT: PublicToolEvent = {
  id: 'tc_1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop',
  status: 'awaiting_permission', occurredAt: '2026-08-20T00:00:00.000Z',
}
const MINIMAL_RECORD: ToolCallRecord = {
  id: 'tc_1', toolName: 'desktop.file.read', runtime: 'desktop', status: 'completed',
}

it('PublicToolEvent 字段闭合：无 arguments/paramHash/expiresAt/安全元数据键', () => {
  const json = JSON.stringify(MINIMAL_EVENT)
  for (const banned of ['arguments', 'paramHash', 'expiresAt', 'riskLevel', 'permissionRequired', 'approvalAuthority']) {
    expect(json).not.toContain(banned)
  }
})
it('ToolCallRecord 支持可选 attachmentCount', () => {
  const rec: ToolCallRecord = { ...MINIMAL_RECORD, attachmentCount: 2 }
  expect(rec.attachmentCount).toBe(2)
})
it('PublicToolEvent.captureSources 形状闭合', () => {
  const ev: PublicToolEvent = { ...MINIMAL_EVENT, captureSources: [{ sourceId: 's1', sourceName: '屏幕 1', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }
  expect(ev.captureSources?.[0].sourceId).toBe('s1')
})
```

- [ ] **Step 2: 运行测试确认失败（`tsc` 报缺 PublicToolEvent）**——Run: `pnpm -F @cyrene/desktop typecheck`（期望：找不到 PublicToolEvent）

- [ ] **Step 3: 实现 shared 契约扩展**

```typescript
// src/shared/contracts/tool.ts 追加（ToolCallRecord 增 attachmentCount?；保留既有全部字段）
export interface DiffLine { kind: 'added' | 'removed' | 'unchanged'; text: string }

/** 桌面工具公开事件（tool:event 载荷，D6B-09；无 arguments/paramHash/expiresAt/安全元数据，D6-07） */
export interface PublicToolEvent {
  id: string                        // sourceCallId（权威键）
  desktopCallId?: string            // 桥 callId
  toolName: string
  title: string                     // 注册表友好名（Renderer 无注册表）
  runtime: 'desktop'
  status: ToolCallStatus
  reason?: string
  inputSummary?: string             // 脱敏（redactToolArguments 产物）
  pathSummary?: string              // Main 派生路径展示摘要（仅权限窗/卡片；不进审计，H-1）
  resultSummary?: string
  error?: { code?: string; message?: string }
  truncated?: boolean
  durationMs?: number
  startedAt?: string
  finishedAt?: string
  attachmentCount?: number          // 卡片「含 N 个附件」数据源（A10）
  dataFlowNote?: string             // 注册表静态文案（「哪些数据发后端」）
  diff?: { lines: DiffLine[]; added: number; removed: number; truncated: boolean; totalLines: number; formatNote: string; isNewFile: boolean }   // totalLines（A-20/H2：接口与 schema/消费三方一致）
  captureSources?: Array<{ sourceId: string; sourceName: string; thumbnailDataUrl: string }>
  capturePreview?: { sourceId: string; previewDataUrl: string }
  occurredAt: string
}
```

```typescript
// src/shared/contracts/tool.ts —— ToolCallRecord 接口内增
  attachmentCount?: number          // 附件数（A10）
```

- [ ] **Step 4: 实现 IPC 通道扩展（ipc.ts）**

```typescript
// src/shared/contracts/ipc.ts —— PushChannels 增 toolEvent；IpcChannels 增 5 个 invoke（M2 契约：推送入 PushChannels）
export const PushChannels = {
  event: 'chat:event', state: 'chat:state', replay: 'chat:replay', error: 'chat:error',
  toolEvent: 'tool:event',
} as const

export const IpcChannels = {
  // ...既有全部通道...
  toolDecide: 'tool:decide',
  toolCancel: 'tool:cancel',
  toolList: 'tool:list',
  toolPickSource: 'tool:pick-source',
  toolConfirmUpload: 'tool:confirm-upload',
} as const
```

- [ ] **Step 5: 实现 schema（ipc-response.ts）——含 MessageSchema 挂载 + IPC 请求 schema（D6B-10 zod 双端落 shared，A-10）**

```typescript
// src/shared/schemas/ipc-response.ts 追加（镜像 ToolCallRecord/PublicToolEvent；ToolCallRecordSchema 需在 MessageSchema 定义之前）
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  runtime: z.enum(['backend', 'desktop', 'local_worker']),
  status: z.enum(['requested', 'awaiting_permission', 'running', 'completed', 'failed', 'rejected', 'cancelled', 'timeout']),
  desktopCallId: z.string().optional(),
  generationId: z.string().optional(),
  conversationId: z.string().optional(),
  reason: z.string().optional(),
  inputSummary: z.string().optional(),
  outputSummary: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  errorType: z.string().optional(),
  truncated: z.boolean().optional(),
  durationMs: z.number().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  attachmentCount: z.number().int().nonnegative().optional(),
}).strict()

const DiffLineSchema = z.object({ kind: z.enum(['added', 'removed', 'unchanged']), text: z.string() }).strict()
const ToolDiffSchema = z.object({
  lines: z.array(DiffLineSchema), added: z.number(), removed: z.number(),
  truncated: z.boolean(), totalLines: z.number(), formatNote: z.string(), isNewFile: z.boolean(),   // totalLines=A-20（「共 X 行」）
}).strict()
const CaptureSourceSchema = z.object({ sourceId: z.string(), sourceName: z.string(), thumbnailDataUrl: z.string() }).strict()
const CapturePreviewSchema = z.object({ sourceId: z.string(), previewDataUrl: z.string() }).strict()

export const PublicToolEventSchema = z.object({
  id: z.string(), desktopCallId: z.string().optional(), toolName: z.string(), title: z.string(),
  runtime: z.literal('desktop'), status: z.enum(['requested', 'awaiting_permission', 'running', 'completed', 'failed', 'rejected', 'cancelled', 'timeout']),
  reason: z.string().optional(), inputSummary: z.string().optional(), pathSummary: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
  truncated: z.boolean().optional(), durationMs: z.number().optional(),
  startedAt: z.string().optional(), finishedAt: z.string().optional(),
  attachmentCount: z.number().int().nonnegative().optional(),
  dataFlowNote: z.string().optional(),
  diff: ToolDiffSchema.optional(),
  captureSources: z.array(CaptureSourceSchema).optional(),
  capturePreview: CapturePreviewSchema.optional(),
  occurredAt: z.string(),
}).strict()

// IPC 请求 schema（D6B-10「zod 双端」——Renderer 与 Main 共用；A-10）
export const PermissionDecisionSchema = z.object({ callId: z.string(), decision: z.enum(['allow_once', 'deny']) }).strict()
export const ToolCancelSchema = z.object({ callId: z.string() }).strict()
export const ToolPickSourceSchema = z.object({ callId: z.string(), sourceId: z.string() }).strict()
export const ToolConfirmUploadSchema = z.object({ callId: z.string() }).strict()
export const ToolListResponseSchema = z.array(PublicToolEventSchema)

// MessageSchema（既有）增 toolCalls 字段（修复 preload safeParse 剥字段缺陷）：
//   toolCalls: z.array(ToolCallRecordSchema).optional(),
```

- [ ] **Step 6: 写失败测试——tool-policy（新文件 tool-policy.spec.ts）**

```typescript
// tests/unit/tool-policy.spec.ts（node 环境）
import { describe, expect, it } from 'vitest'
import { isPathBlacklisted, normalizeToolPath, PATH_BLACKLIST_DEFAULTS, isDomainAllowed, PolicyError } from '../../src/main/tools/tool-policy'   // PolicyError import（H3）

describe('isPathBlacklisted（段边界匹配）', () => {
  it('/etc 前缀含子目录', () => {
    expect(isPathBlacklisted('/etc/passwd')).toBe(true)
    expect(isPathBlacklisted('/etc/ssl/certs/ca.crt')).toBe(true)
  })
  it('段边界：/var2 不误伤、/var 命中', () => {
    expect(isPathBlacklisted('/var2/x')).toBe(false)
    expect(isPathBlacklisted('/var/log')).toBe(true)
  })
  it('/tmp 入黑名单（D6B-02/M-1）', () => { expect(isPathBlacklisted('/tmp/x')).toBe(true) })
  it('/opt 命中（A5）', () => { expect(isPathBlacklisted('/opt/app')).toBe(true) })
  it('dot-secret 精确项 basename 匹配 .env', () => { expect(isPathBlacklisted('/home/u/proj/.env')).toBe(true) })
  it('.kube/config 路径段精确项（L5）', () => { expect(isPathBlacklisted('/home/u/.kube/config')).toBe(true) })
  it('/home/* 其它用户 home 命中、当前用户 home 不命中', () => {
    expect(isPathBlacklisted('/home/other/secret.txt', PATH_BLACKLIST_DEFAULTS, { currentHome: '/home/me' })).toBe(true)
    expect(isPathBlacklisted('/home/me/secret.txt', PATH_BLACKLIST_DEFAULTS, { currentHome: '/home/me' })).toBe(false)
  })
  it('非黑名单路径放行', () => { expect(isPathBlacklisted('/home/u/proj/notes.md')).toBe(false) })
})
describe('normalizeToolPath（H-3 full realpath；注入 realPath 桩，M7 语义：桩收到的输入是 resolve 后的绝对路径）', () => {
  it('相对路径解析为绝对（桩透传）', () => {
    const r = normalizeToolPath('notes.md', { realPath: (p) => p })
    expect(r.realPath.endsWith('/notes.md')).toBe(true)   // resolve 产物以 basename 结尾
  })
  it('中间组件 symlink 逃逸被拒（H-3）', () => {
    // fake realpath 返回 /etc/passwd（linkdir→/etc）→ 黑名单命中
    const r = normalizeToolPath('/home/me/linkdir/passwd', { realPath: () => '/etc/passwd' })
    expect(isPathBlacklisted(r.realPath)).toBe(true)
  })
  it('逃逸/非法 → PATH_UNSAFE 抛错', () => {
    expect(() => normalizeToolPath('', { realPath: (p) => p })).toThrow(PolicyError)
    expect(() => normalizeToolPath('/parent-only/x', { realPath: (p) => { if (p === '/parent-only') throw new Error('ENOENT'); return p } })).toThrow(PolicyError)
  })
  it('Windows：盘符路径放行、ADS 拒、\\?\ 拒（A-9 平台注入；实现用 path.win32 处理，见 Step 7）', () => {
    expect(normalizeToolPath('C:\\Users\\me\\f.txt', { platform: 'windows', realPath: (p) => p }).realPath).toBe('C:\\Users\\me\\f.txt')
    expect(() => normalizeToolPath('C:\\Users\\me\\f.txt:stream', { platform: 'windows', realPath: (p) => p })).toThrow(PolicyError)
    expect(() => normalizeToolPath('\\\\?\\C:\\x', { platform: 'windows', realPath: (p) => p })).toThrow(PolicyError)
  })
})
describe('isDomainAllowed', () => {
  it('同源放行 / 异源拒', () => {
    expect(isDomainAllowed('https://api.example.com/up', 'https://api.example.com')).toBe(true)
    expect(isDomainAllowed('https://evil.example.com/up', 'https://api.example.com')).toBe(false)
  })
})
```

**实现注意**：`isPathBlacklisted(path, blacklist, opts?: { currentHome?: string })`——`currentHome` 缺省用 `os.homedir()`；home 项在匹配前展开为绝对路径；`/home/*` 排除 currentHome。`normalizeToolPath` 接受注入 `opts.realPath?: (p: string) => string`（缺省 `fs.realpathSync.native`），返回 `{ realPath, exists }`（`exists` 由 stat 判定，缺省 try/catch）。

- [ ] **Step 7: 实现 tool-policy.ts**

```typescript
// src/main/tools/tool-policy.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import os from 'node:os'

export class PolicyError extends Error {
  constructor(public code: 'PATH_UNSAFE', message: string) { super(message) }
}

/** 路径黑名单默认集（D6B-02：realpath 后段边界匹配；exactFile=精确文件项；pathSeg=路径段精确项） */
export interface BlacklistEntry { root: string; exactFile?: boolean; pathSeg?: boolean }
export const PATH_BLACKLIST_DEFAULTS: BlacklistEntry[] = [
  { root: '/etc' }, { root: '/usr' }, { root: '/bin' }, { root: '/sbin' }, { root: '/boot' },
  { root: '/lib' }, { root: '/lib64' }, { root: '/proc' }, { root: '/sys' }, { root: '/dev' },
  { root: '/root' }, { root: '/run' }, { root: '/var' }, { root: '/lost+found' }, { root: '/snap' },
  { root: '/opt' }, { root: '/tmp' },
  { root: '~/.ssh' }, { root: '~/.config' }, { root: '~/.gnupg' }, { root: '~/.password-store' },
  { root: '~/.aws' }, { root: '~/.npm' }, { root: '~/.cache' }, { root: '~/.local' },
  { root: '~/.mozilla' }, { root: '~/.netrc', exactFile: true }, { root: '~/.bash_history', exactFile: true },
  { root: '~/.Xauthority', exactFile: true }, { root: '~/.pki' }, { root: '~/.git-credentials', exactFile: true },
  { root: '.env', exactFile: true }, { root: '.pypirc', exactFile: true }, { root: '.dockercfg', exactFile: true },
  { root: '.kube/config', pathSeg: true },
  // Windows（大小写不敏感由 normalized lower 比较保证；8.3 短名 canonicalize 见 normalizeToolPath）
  { root: 'C:\\Windows' }, { root: 'C:\\Program Files' }, { root: 'C:\\Program Files (x86)' },
  { root: 'C:\\ProgramData' }, { root: 'C:\\System Volume Information' }, { root: 'C:\\$Recycle.Bin' },
  { root: '~/.ssh' }, { root: '~\\AppData' }, { root: '~\\AppData\\Local\\Temp' },
]

const SEP = path.sep

export function isPathBlacklisted(
  normalized: string,
  blacklist: BlacklistEntry[] = PATH_BLACKLIST_DEFAULTS,
  opts: { currentHome?: string } = {},
): boolean {
  const home = opts.currentHome ?? os.homedir()
  const lower = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  for (const entry of blacklist) {
    let root = entry.root
    if (root.startsWith('~')) root = path.join(home, root.slice(1))
    const r = process.platform === 'win32' ? root.toLowerCase() : root
    if (entry.exactFile) {
      if (lower === r || path.basename(lower) === r) return true
      continue
    }
    if (entry.pathSeg) {
      // **/.kube/config 语义：任一路径段序列匹配（L5）
      if (lower === r || lower.endsWith(SEP + r) || lower.includes(SEP + r + SEP)) return true
      continue
    }
    // 段边界前缀（等于 root 或以 root+分隔符开头）
    if (lower === r || lower.startsWith(r + SEP)) return true
  }
  // /home/* 排除当前用户（POSIX）
  if (process.platform !== 'win32') {
    const h = home.replace(/\/+$/, '')
    const m = lower.match(/^\/home\/[^/]+(?:\/|$)/)
    if (m && !(lower === h || lower.startsWith(h + SEP))) return true
  }
  return false
}

export interface NormalizeOpts { platform?: 'posix' | 'windows'; realPath?: (p: string) => string }

/** full realpath（含父链；新建写场景 dirname realpath + basename 拼接，H-3）；Windows 保留名/ADS/\\?\ 拒 */
export function normalizeToolPath(rawPath: string, opts: NormalizeOpts = {}): { realPath: string; exists: boolean } {
  const realPathFn = opts.realPath ?? ((p: string) => fs.realpathSync.native(p))
  const platform = opts.platform ?? (process.platform === 'win32' ? 'windows' : 'posix')
  if (!rawPath || rawPath.length === 0) throw new PolicyError('PATH_UNSAFE', 'empty path')
  if (platform === 'windows') {
    const win = path.win32                                   // A-9/新发现3：POSIX 主机上 path 是 posix——Windows 语义必须用 path.win32（M7）
    const lower = rawPath.toLowerCase()
    if (lower.startsWith('\\\\.\\') || lower.startsWith('\\\\?\\')) throw new PolicyError('PATH_UNSAFE', 'device path')
    if (lower.startsWith('\\\\')) throw new PolicyError('PATH_UNSAFE', 'UNC 网络共享默认拒')
    if (win.basename(rawPath).includes(':')) throw new PolicyError('PATH_UNSAFE', 'ADS path')
    const base = win.basename(rawPath).split('.')[0].toUpperCase()
    if (/^(CON|NUL|PRN|AUX|COM[1-9]|LPT[1-9])$/.test(base)) throw new PolicyError('PATH_UNSAFE', 'reserved name')
  }
  let realPath: string
  try {
    realPath = realPathFn(path.resolve(rawPath))
  } catch {
    // 目标不存在（新建写）：realpath 父目录 + 拼接 basename
    const dir = path.dirname(path.resolve(rawPath))
    try { realPath = path.join(realPathFn(dir), path.basename(path.resolve(rawPath))) }
    catch { throw new PolicyError('PATH_UNSAFE', 'unresolvable parent') }
  }
  return { realPath, exists: fs.existsSync(realPath) }
}

export function isDomainAllowed(url: string, allowedOrigin: string): boolean {
  try { return new URL(url).origin === new URL(allowedOrigin).origin }
  catch { return false }
}
```

- [ ] **Step 8: 实现 tool-registry.ts**

```typescript
// src/main/tools/tool-registry.ts
import { z } from 'zod'
import type { ToolRuntime } from '@shared/contracts/tool'

export type ToolPermissionMode = 'automatic' | 'scoped_or_prompt' | 'always_prompt' | 'prohibited'
export type ToolExecutorName = 'file.select' | 'file.read' | 'file.write' | 'screen.capture'

export interface RegisteredTool {
  name: string; version: string; runtime: 'desktop'
  title: string; description: string; dataFlowNote: string
  localRisk: 'safe' | 'medium' | 'high'
  permissionMode: ToolPermissionMode
  supportedPlatforms: Array<'windows' | 'linux'>
  inputSchema: z.ZodType<unknown>; outputSchema: z.ZodType<unknown>
  executeRef: ToolExecutorName
  defaultTimeoutMs: number
  isPathTool: boolean
}

const TOOL_VERSION = '1.0'

export const TOOL_NAMES = ['desktop.file.select', 'desktop.file.read', 'desktop.file.write', 'desktop.screen.capture'] as const

export function createToolRegistry(): Map<string, RegisteredTool> {
  const r = new Map<string, RegisteredTool>()
  const put = (t: RegisteredTool) => { r.set(t.name, t) }
  put({
    name: 'desktop.file.select', version: TOOL_VERSION, runtime: 'desktop', title: '选择文件',
    description: '打开系统文件选择器，由用户主动选择文件。', localRisk: 'safe', permissionMode: 'automatic',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ title: z.string().optional() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '选择的文件路径、大小与哈希摘要将发送到已连接的后端服务器；文件内容不会自动上传。',
    executeRef: 'file.select', defaultTimeoutMs: 60_000, isPathTool: false,
  })
  put({
    name: 'desktop.file.read', version: TOOL_VERSION, runtime: 'desktop', title: '读取文件',
    description: '读取用户选择或明确授权的 UTF-8 文本文件（≤2 MiB）。', localRisk: 'medium', permissionMode: 'scoped_or_prompt',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '读取的文件内容（≤64 KiB 内联 / 更大经附件上传）将发送到已连接的后端服务器。',
    executeRef: 'file.read', defaultTimeoutMs: 30_000, isPathTool: true,
  })
  put({
    name: 'desktop.file.write', version: TOOL_VERSION, runtime: 'desktop', title: '写入文件',
    description: '写入或覆盖文本文件（写前展示差异，原子替换，冲突保护）。', localRisk: 'high', permissionMode: 'always_prompt',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(),
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '写入内容将覆盖/创建目标文件，文件内容将发送到已连接的后端服务器。',
    executeRef: 'file.write', defaultTimeoutMs: 30_000, isPathTool: true,
  })
  put({
    name: 'desktop.screen.capture', version: TOOL_VERSION, runtime: 'desktop', title: '屏幕截图',
    description: '捕获所选屏幕或窗口（选择 → 预览 → 确认上传）。', localRisk: 'high', permissionMode: 'always_prompt',
    supportedPlatforms: ['windows', 'linux'],
    inputSchema: z.object({ region: z.string().nullish() }).strict(),   // region:null 放行（H1/M-6，后端恒发 {"region":null}）
    outputSchema: z.record(z.string(), z.unknown()),
    dataFlowNote: '所选屏幕/窗口截图将发送到已连接的后端服务器。',
    executeRef: 'screen.capture', defaultTimeoutMs: 120_000, isPathTool: false,
  })
  return r
}
```

- [ ] **Step 9: 实现 PublicToolEvent schema 测试（tool-public-events.spec.ts）**

```typescript
// tests/unit/tool-public-events.spec.ts
import { describe, expect, it } from 'vitest'
import { PublicToolEventSchema, ToolCallRecordSchema } from '../../src/shared/schemas/ipc-response'
import { MessageSchema } from '../../src/shared/schemas/ipc-response'

const VALID = { id: 'tc_1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop', status: 'awaiting_permission', occurredAt: '2026-08-20T00:00:00.000Z' }

describe('PublicToolEventSchema', () => {
  it('合法最小样例通过', () => { expect(PublicToolEventSchema.safeParse(VALID).success).toBe(true) })
  it('status 非法拒', () => { expect(PublicToolEventSchema.safeParse({ ...VALID, status: 'unknown' }).success).toBe(false) })
  it('runtime 非 desktop 拒', () => { expect(PublicToolEventSchema.safeParse({ ...VALID, runtime: 'backend' }).success).toBe(false) })
  it('strict：未知键拒（含 arguments/paramHash/expiresAt）', () => {
    for (const banned of ['arguments', 'paramHash', 'expiresAt', 'riskLevel']) {
      expect(PublicToolEventSchema.safeParse({ ...VALID, [banned]: 1 }).success).toBe(false)
    }
  })
  it('capture/diff/pathSummary/attachmentCount 扩展通过', () => {
    expect(PublicToolEventSchema.safeParse({ ...VALID, pathSummary: '/home/u/notes.md', attachmentCount: 2,
      captureSources: [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }).success).toBe(true)
    expect(PublicToolEventSchema.safeParse({ ...VALID, diff: { lines: [{ kind: 'added', text: 'x' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'UTF-8', isNewFile: false } }).success).toBe(true)   // totalLines 必填（H2）
  })
})
describe('ToolCallRecordSchema + MessageSchema.toolCalls', () => {
  it('MessageSchema.safeParse 保留 toolCalls（preload 剥字段修复）', () => {
    // 合法样例从既有 ipc-response-schema.spec.ts 的 MessageSchema 用例复制（M8——先读该文件取其合法对象形状，替换下面 msg 占位）
    const msg: Record<string, unknown> = { /* 从 ipc-response-schema.spec.ts 复制合法 MessageSchema 样例（含 id/role/status/content 等必填） */ }
    expect(MessageSchema.safeParse({ ...msg, toolCalls: [{ id: 'tc_1', toolName: 'seed.tool.read', runtime: 'backend', status: 'completed' }] }).success).toBe(true)
  })
  it('attachmentCount 合法/非法', () => {
    expect(ToolCallRecordSchema.safeParse({ id: 'a', toolName: 'x', runtime: 'backend', status: 'completed', attachmentCount: 3 }).success).toBe(true)
    expect(ToolCallRecordSchema.safeParse({ id: 'a', toolName: 'x', runtime: 'backend', status: 'completed', attachmentCount: -1 }).success).toBe(false)
  })
})
```
**注意**：`MessageSchema` 合法样例以既有 `ipc-response-schema.spec.ts` 为准（Step 10 前先读该文件确认字段，代码 L2）。

- [ ] **Step 10: 实现 tool-registry.spec.ts（新文件，完整 M1——spec §3.13 要求）**

```typescript
// tests/unit/tool-registry.spec.ts
import { describe, expect, it } from 'vitest'
import { createToolRegistry, TOOL_NAMES } from '../../src/main/tools/tool-registry'

describe('tool-registry', () => {
  it('四工具注册齐全（TOOL_NAMES 全含）', () => {
    const r = createToolRegistry()
    for (const name of TOOL_NAMES) expect(r.has(name)).toBe(true)
    expect(r.size).toBe(4)
  })
  it('未知名 → 无定义', () => { expect(createToolRegistry().has('desktop.command.run')).toBe(false) })
  it('inputSchema strict 拒未知字段 + 缺必填', () => {
    const r = createToolRegistry()
    expect(r.get('desktop.file.read')!.inputSchema.safeParse({ path: '/a', extra: 1 }).success).toBe(false)
    expect(r.get('desktop.file.read')!.inputSchema.safeParse({}).success).toBe(false)
  })
  it('capture inputSchema 放行 region:null（H1/M-6）', () => {
    expect(createToolRegistry().get('desktop.screen.capture')!.inputSchema.safeParse({ region: null }).success).toBe(true)
  })
  it('permissionMode/localRisk 映射闭合（D6B-03）', () => {
    const r = createToolRegistry()
    expect(r.get('desktop.file.select')!.permissionMode).toBe('automatic')
    expect(r.get('desktop.file.read')!.permissionMode).toBe('scoped_or_prompt')
    expect(r.get('desktop.file.write')!.permissionMode).toBe('always_prompt')
    expect(r.get('desktop.screen.capture')!.permissionMode).toBe('always_prompt')
    expect(r.get('desktop.file.select')!.localRisk).toBe('safe')
    expect(r.get('desktop.file.write')!.localRisk).toBe('high')
  })
})
```

- [ ] **Step 11: 跑测试 + typecheck**

Run: `pnpm -F @cyrene/desktop test -- run tests/unit/tool-policy.spec.ts tests/unit/tool-public-events.spec.ts tests/unit/contracts-tool.spec.ts && pnpm -F @cyrene/desktop typecheck`——期望全绿（若既有 contracts-tool.spec 有 ToolCallRecord 常量断言，需同步补 attachmentCount 不破坏——见 Step 1 增补）。

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/shared/contracts/tool.ts apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/main/tools/tool-policy.ts apps/desktop/src/main/tools/tool-registry.ts apps/desktop/tests/unit/tool-policy.spec.ts apps/desktop/tests/unit/tool-registry.spec.ts apps/desktop/tests/unit/tool-public-events.spec.ts apps/desktop/tests/unit/contracts-tool.spec.ts
git commit -m "feat(阶段6批次B Task1): 契约与政策层——PublicToolEvent/ToolCallRecord.attachmentCount/IPC 通道（PushChannels.toolEvent+5 invoke）/schemas（MessageSchema 挂 toolCalls + IPC 请求 schema 双端落 shared + totalLines）+ tool-policy（黑名单默认集/段边界/full realpath/Windows ADS·UNC·保留名）+ tool-registry 四工具 + registry.spec（D6B-02/09/10/22）"
```

---

### Task 2: tool-service 核心（决策链/状态机/幂等/队列/超时/重连/shutdown）

**Files:**
- Create: `apps/desktop/src/main/tools/param-hash.ts`
- Create: `apps/desktop/src/main/tools/tool-service.ts`
- Create: `apps/desktop/src/main/tools/tool-executors.ts`（最小 stub，Step 5——Task 2 import 可解析，M1）
- Create: `apps/desktop/src/main/tools/text-diff.ts`（Step 6，jsdiff 引入，M1）
- Test: `apps/desktop/tests/unit/param-hash.spec.ts`（新）、`apps/desktop/tests/unit/tool-service.spec.ts`（新）、`apps/desktop/tests/unit/text-diff.spec.ts`（新）

**Interfaces:**
- Consumes: Task 1 的 `ToolRegistry`/`isPathBlacklisted`/`normalizeToolPath`/`PolicyError`；`PublicToolEvent`/`ToolCallStatus`/`ToolStatusCommand`/`ToolAttachment`；`redactToolArguments`；`AuditEvent`
- Produces: `canonicalJsonStringify`/`computeParamHash`（param-hash.ts，D6B-22 算法）；`DesktopToolRequest`/`createToolService(deps)`（tool-service.ts）——Task 3~8 全部依赖

- [ ] **Step 1: 写失败测试——param-hash（D6B-22 canonical 算法固定向量）**

```typescript
// tests/unit/param-hash.spec.ts
import { describe, expect, it } from 'vitest'
import { canonicalJsonStringify, computeParamHash } from '../../src/main/tools/param-hash'

describe('canonicalJsonStringify（D6B-22：递归键排序 + 紧凑分隔 + 非 ASCII 不转义）', () => {
  it('键序打乱 → 同产物', () => {
    const a = { b: 1, a: { d: 2, c: 3 } }
    expect(canonicalJsonStringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
  it('非 ASCII 原样（ensure_ascii=false 等价）', () => {
    expect(canonicalJsonStringify({ path: '笔记.md' })).toBe('{"path":"笔记.md"}')
  })
})
describe('computeParamHash（SHA-256 hex，D6B-22 固定向量写死，A-11）', () => {
  it('固定向量与后端 plugin.py canonical 产物一致', () => {
    // 权威向量（执行前用后端 plugin.py 的 canonical_json + sha256 本地确认后写死）：
    expect(computeParamHash({ path: '/tmp/a.txt' })).toBe('<按后端实算填充 64 位 hex>')
    expect(computeParamHash({ b: 1, a: { d: 2, c: 3 } })).toBe('<按后端实算填充 64 位 hex>')
    expect(computeParamHash({ path: '笔记.md' })).toBe('<按后端实算填充 64 位 hex>')
    // 同输入幂等
    expect(computeParamHash({ path: '/tmp/a.txt' })).toBe(computeParamHash({ path: '/tmp/a.txt' }))
  })
})
```

- [ ] **Step 2: 实现 param-hash.ts**

```typescript
// src/main/tools/param-hash.ts
import { createHash } from 'node:crypto'

/** 递归键排序（D6B-22，镜像后端 canonical_json：sort_keys + separators=(',',':') + ensure_ascii=False） */
export function canonicalJsonStringify(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon)
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canon((v as Record<string, unknown>)[k])
      return out
    }
    return v
  }
  return JSON.stringify(canon(value))
}

export function computeParamHash(arguments_: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJsonStringify(arguments_), 'utf8').digest('hex')
}
```

- [ ] **Step 3: 写失败测试——tool-service 决策链核心（tool-service.spec.ts）**

```typescript
// tests/unit/tool-service.spec.ts（node 环境；所有 executor/picker/submit 注入 fake；fixture 目录 beforeEach 创建，H8/新发现5）
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'   // 平台测试用（新发现7）
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createToolService, DesktopToolRequest, ToolServiceError, FILE_READ_MAX_BYTES } from '../../src/main/tools/tool-service'   // ToolServiceError/常量 import（H4）
import { createToolRegistry } from '../../src/main/tools/tool-registry'
import { ToolCallStatus } from '@shared/contracts/tool'

const FIXTURES = '/tmp/cyrene-fixtures'
beforeEach(() => { mkdirSync(FIXTURES, { recursive: true }) })
afterEach(() => { rmSync(FIXTURES, { recursive: true, force: true }) })

function mkReq(over: Partial<DesktopToolRequest> = {}): DesktopToolRequest {
  return { callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read', toolVersion: '1.0',
    runtime: 'desktop', arguments: { path: `${FIXTURES}/notes.md` }, reason: 'read notes', expiresAt: Date.now() + 30_000, ...over }
}
function mkService(over: Record<string, unknown> = {}) {
  const events: any[] = []
  const audit: any[] = []
  const submitStatus = vi.fn().mockResolvedValue(undefined)
  const pushEvent = (ev: any) => events.push(ev)
  const svc = createToolService({
    registry: createToolRegistry(), platform: 'posix', audit: (e: any) => audit.push(e),
    submitStatus, uploadAttachment: vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' }),
    pushEvent, allowRoots: [FIXTURES], ...over,
  })
  return { svc, events, audit, submitStatus }
}

describe('决策链', () => {
  it('未注册工具 → rejected CAPABILITY_UNAVAILABLE（不弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.command.run' }))
    const last = events.at(-1)
    expect(last.status).toBe('rejected'); expect(last.error?.code).toBe('CAPABILITY_UNAVAILABLE')
  })
  it('平台不支持 → 同码拒绝（B3；注入 windows-only 工具，H7）', async () => {
    const registry = createToolRegistry()
    registry.set('desktop.winonly', { name: 'desktop.winonly', version: '1.0', runtime: 'desktop', title: 'w', description: '', dataFlowNote: '', localRisk: 'safe', permissionMode: 'automatic', supportedPlatforms: ['windows'], inputSchema: z.object({}).strict(), outputSchema: z.record(z.string(), z.unknown()), executeRef: 'file.read', defaultTimeoutMs: 1000, isPathTool: false })
    const { svc, events } = mkService({ registry })
    await svc.handleRequest(mkReq({ toolName: 'desktop.winonly', arguments: {} }))
    expect(events.at(-1).error?.code).toBe('CAPABILITY_UNAVAILABLE')
  })
  it('参数 schema 拒（未知键 strict / 缺 path）→ INVALID_ARGUMENTS 不弹窗', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/home/u/a.txt', extra: 1 } }))
    expect(events.at(-1).error?.code).toBe('INVALID_ARGUMENTS')
  })
  it('capture region:null 合法通过（H1/M-6）', async () => {
    const { svc } = mkService()
    await expect(svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: { region: null } }))).resolves.not.toThrow()
  })
  it('paramHash 不一致 → PARAM_HASH_MISMATCH（不弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ paramHash: 'deadbeef'.repeat(8) }))
    expect(events.at(-1).error?.code).toBe('PARAM_HASH_MISMATCH')
  })
  it('黑名单路径命中 → PATH_BLOCKLISTED 不弹窗（压过一切）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/etc/passwd' } }))
    expect(events.at(-1).error?.code).toBe('PATH_BLOCKLISTED')
    expect(events.some(e => e.status === 'awaiting_permission')).toBe(false)
  })
  it('read 未豁免 → awaiting_permission；allowedRoots 内路径不被 /tmp 黑名单误伤（M-1）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ arguments: { path: '/tmp/cyrene-fixtures/a.txt' } }))
    expect(events.at(-1).status).toBe('awaiting_permission')
  })
  it('write 授权前预读 + Diff 随 awaiting 事件下发（L7；fixture 前置，H8）', async () => {
    writeFileSync(`${FIXTURES}/w.txt`, 'old')
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.write', arguments: { path: `${FIXTURES}/w.txt`, content: 'new' } }))
    const ev = events.at(-1)
    expect(ev.status).toBe('awaiting_permission')
    expect(ev.diff).toBeDefined(); expect(ev.diff.isNewFile).toBe(false)
    expect(ev.diff.totalLines).toBeGreaterThan(0)   // totalLines（A-20）
  })
  it('wire accepted 在授权判定前发出（M1）', async () => {
    const { svc, submitStatus } = mkService()
    await svc.handleRequest(mkReq())
    expect(submitStatus).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call_1', status: 'accepted' }))
  })
})
describe('幂等与状态机', () => {
  it('同 callId 参数不一致 → PARAM_MISMATCH', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    await svc.handleRequest(mkReq({ arguments: { path: '/home/u/other.txt' } }))
    expect(events.at(-1).error?.code).toBe('PARAM_MISMATCH')
  })
  it('已拒绝保持拒绝（不重弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    await svc.decide('call_1', 'deny')
    const before = events.length
    await svc.handleRequest(mkReq())   // 同 callId 再来（幂等返回当前状态）
    expect(events.at(-1).status).toBe('rejected')
    expect(events.length).toBe(before + 1)   // 只补一条幂等回显，不二次 awaiting
  })
  it('awaiting 队列 FIFO 一次一个（A8）：两请求只有一个 awaiting 事件，decide 后第二个晋升', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ callId: 'call_1', sourceCallId: 'tc_1' }))
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2' }))
    expect(events.filter(e => e.status === 'awaiting_permission').length).toBe(1)
    await svc.decide('call_1', 'deny')
    expect(events.filter(e => e.status === 'awaiting_permission').length).toBe(2)   // tc_2 晋升
  })
  it('终态后更新忽略（单向前进）', async () => {
    const { svc } = mkService()
    await svc.handleRequest(mkReq())
    await svc.decide('call_1', 'deny')
    await expect(svc.decide('call_1', 'allow_once')).rejects.toMatchObject({ code: 'TOOL_STATE_INVALID' })   // 已 rejected → 抛（H6：无裸调用）
  })
  it('expiresAt 超时 → timeout + wire cancelled（cancelSource timeout）', async () => {
    vi.useFakeTimers()
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq({ expiresAt: Date.now() + 500 }))
    await vi.advanceTimersByTimeAsync(600)
    expect(events.at(-1).status).toBe('timeout')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
    vi.useRealTimers()
  })
  it('decide allow_once → running → 执行成功 → completed + wire result；wire 时序 accepted→running→result（A-7/H5：注入 executorOverride）', async () => {
    const p = `${FIXTURES}/ok.txt`; writeFileSync(p, 'hello')
    const { svc, submitStatus } = mkService({ executorOverride: async () => ({ output: { path: p }, summary: 'ok' }) })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    const order = submitStatus.mock.calls.map(c => c[0].status)
    expect(order).toEqual(['accepted', 'running', 'result'])
  })
  it('decide deny → rejected + wire rejected + 审计 tool:decision deny', async () => {
    const { svc, submitStatus, audit } = mkService()
    await svc.handleRequest(mkReq())
    await svc.decide('call_1', 'deny')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'rejected' }))
    expect(audit.some(e => e.type === 'tool:decision' && e.permissionDecision === 'deny')).toBe(true)
  })
  it('cancel → cancelled + wire cancelled + cancelSource user', async () => {
    const { svc, events, submitStatus } = mkService()
    await svc.handleRequest(mkReq())
    await svc.cancel('call_1')
    expect(events.at(-1).status).toBe('cancelled')
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })
  it('outputSchema 校验失败 → failed + INVALID_OUTPUT（B1/M3：注入 executorOverride 返回非法输出）', async () => {
    const p = `${FIXTURES}/ok.txt`; writeFileSync(p, 'x')
    const { svc, events } = mkService({ executorOverride: async () => ({ output: 42, summary: 'bad' } as never) })   // 非 record → outputSchema 拒
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    const rec = svc.getRecord('call_1')
    expect(rec?.status).toBe('failed'); expect(rec?.error?.code).toBe('INVALID_OUTPUT')
  })
  it('error.message === "" → 归一 undefined（M6/A-16）', async () => {
    const p = '/tmp/cyrene-fixtures/ok.txt'; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'x')
    const { svc, events } = mkService({ executorOverride: async () => { throw new ToolServiceError('X', '') } })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    const rec = svc.getRecord('call_1')
    expect(rec?.error?.message).toBeUndefined()
  })
  it('重连：终态 statusSent=false 重发；非终态不动；selected-set 清空（D6B-20/M-7/H7）', async () => {
    const p = `${FIXTURES}/ok.txt`; writeFileSync(p, 'hello')
    const submitStatus = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)   // 首次发送失败
    const { svc, events } = mkService({ submitStatus, executorOverride: async () => ({ output: { path: p }, summary: 'ok' }) })
    await svc.handleRequest(mkReq({ arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    expect(submitStatus.mock.calls.filter(c => c[0].status === 'result').length).toBe(1)   // 首次 result 发送失败（statusSent=false）
    await svc.reconnect()
    expect(submitStatus.mock.calls.filter(c => c[0].status === 'result').length).toBe(2)   // 重连重发
    // selected-set 清空：先 select 豁免 → reconnect → 豁免失效
  })
  it('shutdown：停止接收 + 未决授权按拒绝（B2）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq())
    svc.shutdown()
    await svc.handleRequest(mkReq({ callId: 'call_9', sourceCallId: 'tc_9' }))
    expect(events.some(e => e.id === 'tc_9' && e.error?.code === 'APP_SHUTTING_DOWN')).toBe(true)
  })
  it('写路径串行锁：同路径两写串行（H7：慢 executorOverride + 交错断言）', async () => {
    const p = `${FIXTURES}/lock.txt`; writeFileSync(p, 'x')
    let running = 0; let maxConcurrent = 0
    const { svc } = mkService({ executorOverride: async () => { running++; maxConcurrent = Math.max(maxConcurrent, running); await new Promise(r => setTimeout(r, 20)); running--; return { output: { path: p }, summary: 'ok' } } })
    await svc.handleRequest(mkReq({ callId: 'call_1', sourceCallId: 'tc_1', arguments: { path: p } }))
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2', arguments: { path: p } }))
    await svc.decide('call_1', 'allow_once')
    await svc.decide('call_2', 'allow_once')
    await new Promise(r => setTimeout(r, 100))
    expect(maxConcurrent).toBe(1)   // 同路径写串行（per-path 锁）
  })
  it('capture Wayland 授权前拒（A-4）：注入 wayland env → CAPTURE_UNAVAILABLE 不弹窗', async () => {
    // mkService 注入 wayland: true → isWaylandSession 经 deps.isWayland 注入判断
    const { svc, events } = mkService({ isWayland: true })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    expect(events.at(-1).error?.code).toBe('CAPTURE_UNAVAILABLE')
    expect(events.some(e => e.status === 'awaiting_permission')).toBe(false)
  })
  it('select 自动执行（safe/automatic 不弹窗）', async () => {
    const { svc, events } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    expect(events.at(-1).status).toBe('completed')   // 无 awaiting 直接执行
  })
  it('审计调用计数：request-received/executing/terminal 各 ≥1', async () => {
    const { svc, audit } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.file.select', arguments: {} }))
    expect(audit.filter(e => e.type === 'tool:request-received').length).toBe(1)
    expect(audit.some(e => e.type === 'tool:executing')).toBe(true)
    expect(audit.some(e => e.type === 'tool:terminal')).toBe(true)
  })
})
```

- [ ] **Step 4: 实现 tool-service.ts（决策链 15 步；核心结构）**

```typescript
// src/main/tools/tool-service.ts
import { computeParamHash } from './param-hash'
import { createToolRegistry, RegisteredTool, ToolExecutorName } from './tool-registry'
import { isPathBlacklisted, normalizeToolPath, PolicyError } from './tool-policy'
import { redactToolArguments } from './input-summary'
import type { PublicToolEvent, ToolAttachment, ToolCallStatus } from '@shared/contracts/tool'
import type { ToolStatusCommand, ToolWireStatus } from '@shared/contracts/backend'
import type { AuditEvent } from '../diagnostics/audit'

export interface DesktopToolRequest {
  callId: string; sourceCallId: string; toolName: string; toolVersion: string
  runtime: 'desktop'; arguments: Record<string, unknown>
  reason?: string; expiresAt: number; paramHash?: string
}
export interface FilePickerOptions { title: string; filters: { name: string; extensions: string[] }[] }
export interface CaptureSourceInfo { sourceId: string; sourceName: string; thumbnailDataUrl: string }
export interface ToolServiceDeps {
  registry: Map<string, RegisteredTool>
  platform: 'posix' | 'windows'
  audit: (ev: AuditEvent) => void
  pickFile?: (opts: FilePickerOptions) => Promise<{ canceled: boolean; path?: string }>
  enumerateSources?: () => Promise<CaptureSourceInfo[]>
  renderPreview?: (sourceId: string) => Promise<{ previewDataUrl: string; bytes: Uint8Array }>   // capture picked 后（Task 4，A-2）
  finalizeUpload?: (callId: string, bytes: Uint8Array) => Promise<void>                          // 上传前钩子（Task 4）
  submitStatus: (cmd: ToolStatusCommand) => Promise<void>
  uploadAttachment: (callId: string, bytes: Uint8Array, mime: string, label?: string) => Promise<ToolAttachment>
  pushEvent: (ev: PublicToolEvent) => void
  selectedExemptTtlMs?: number
  allowRoots?: string[]
  isWayland?: boolean               // 注入（测试用）；缺省 isWaylandSession() env 判定（A-4）
  executorOverride?: (rec: ToolRecord, realPath?: string) => Promise<ExecResult>   // 测试注入（B-1/M12）
  selectedAdd?: (realPath: string) => void   // selected-set 写闭包（A-14：tool-service 注入；executor 可选调用）
}
export interface ToolRecord {
  id: string; desktopCallId?: string; toolName: string; title: string
  status: ToolCallStatus; reason?: string; inputSummary?: string; pathSummary?: string
  resultSummary?: string; error?: { code?: string; message?: string }; truncated?: boolean
  durationMs?: number; startedAt?: string; finishedAt?: string; attachmentCount?: number
  dataFlowNote?: string; diff?: PublicToolEvent['diff']; oldHash?: string           // oldHash=写前哈希依据（A-1/M7）
  captureSources?: PublicToolEvent['captureSources']; capturePreview?: PublicToolEvent['capturePreview']
  expiresAt: number; paramHash?: string; arguments_: Record<string, unknown>; toolVersion: string
  statusSent: boolean; queue: boolean   // queue=在 awaiting 队列中
}
export interface ToolService {
  handleRequest(req: DesktopToolRequest): Promise<void>
  decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void>
  cancel(callId: string): Promise<void>
  listRecent(limit?: number): PublicToolEvent[]
  pickSource(callId: string, sourceId: string): Promise<void>
  confirmUpload(callId: string): Promise<void>
  reconnect(): Promise<void>
  shutdown(): void
  getRecord(callId: string): ToolRecord | undefined
}

export const FILE_READ_MAX_BYTES = 2 * 1024 * 1024
export const RESULT_INLINE_BYTES = 64 * 1024
export const MAX_WRITE_CONTENT_BYTES = 2 * 1024 * 1024
export const SELECT_EXEMPT_TTL_MS = 10 * 60 * 1000
export const TEXT_FILE_FILTERS = { name: '文本文件', extensions: ['txt','md','markdown','json','log','csv','tsv','js','ts','jsx','tsx','py','rb','go','rs','c','h','cpp','hpp','java','kt','swift','css','scss','html','htm','yaml','yml','toml','ini','cfg','conf','xml','svg','sh','bash','env'] }
export const PATH_SUMMARY_MAX = 120

/** 工具服务结构化错误（IPC 层映射为结构化拒绝） */
export class ToolServiceError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
// M10 注记：tool-service ↔ tool-executors 存在值导入互引（createExecutors vs 常量/类型）——当前仅函数体内使用不触发 TDZ；
// 若实现期遇循环 import 告警，把 FILE_READ_MAX_BYTES 等常量下沉到 main/tools/limits.ts（评估后记录取舍）

export function createToolService(deps: ToolServiceDeps): ToolService {
  const records = new Map<string, ToolRecord>()
  const byCallId = new Map<string, string>()              // desktopCallId → sourceCallId（decide/cancel/pick/confirm 索引）
  const selectedSet = new Map<string, number>()      // realPath → selectedAt
  const awaitingQueue: string[] = []                 // FIFO（A8）
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const executors = createExecutors({ ...deps, selectedAdd: (p) => selectedSet.set(p, Date.now()) })   // selected-set 写闭包（A-14）
  const serialLocks = new Map<string, Promise<unknown>>()   // per-path 写串行锁（A-8）
  let shutdownFlag = false

  /** Wayland 会话判定（D6B-05；deps.isWayland 注入优先，缺省 env 判定，A-4） */
  function isWaylandSession(): boolean {
    if (deps.isWayland !== undefined) return deps.isWayland
    const t = process.env.XDG_SESSION_TYPE?.toLowerCase()
    return t === 'wayland' || (!!process.env.WAYLAND_DISPLAY && t !== 'x11')
  }

  function emit(rec: ToolRecord, extra: Partial<PublicToolEvent> = {}): void {
    deps.pushEvent({
      id: rec.id, desktopCallId: rec.desktopCallId, toolName: rec.toolName, title: rec.title,
      runtime: 'desktop', status: rec.status, reason: rec.reason, inputSummary: rec.inputSummary,
      pathSummary: rec.pathSummary, resultSummary: rec.resultSummary, error: rec.error,
      truncated: rec.truncated, durationMs: rec.durationMs, startedAt: rec.startedAt, finishedAt: rec.finishedAt,
      attachmentCount: rec.attachmentCount, dataFlowNote: rec.dataFlowNote, diff: rec.diff,
      captureSources: rec.captureSources, capturePreview: rec.capturePreview, occurredAt: new Date().toISOString(), ...extra,
    })
  }
  function wireSend(rec: ToolRecord, status: ToolWireStatus, extra: Partial<ToolStatusCommand> = {}): void {
    return deps.submitStatus({ callId: rec.desktopCallId!, status, toolName: rec.toolName, toolVersion: rec.toolVersion,
      runtime: 'desktop', paramHash: rec.paramHash ?? computeParamHash(rec.arguments_), ...extra })
      .then(() => { rec.statusSent = true })
      .catch(() => { rec.statusSent = false })
  }
  function toWire(display: ToolCallStatus): ToolWireStatus | null {
    switch (display) {
      case 'running': return 'running'
      case 'completed': return 'result'
      case 'failed': return 'error'
      case 'rejected': return 'rejected'
      case 'cancelled': case 'timeout': return 'cancelled'
      default: return null   // requested/awaiting_permission
    }
  }
  function derivePathSummary(args: Record<string, unknown>): string | undefined {
    if (typeof args.path !== 'string' || !args.path) return undefined
    const p = args.path.replace(/\\/g, '/')
    const seg = p.split('/').filter(Boolean)
    if (seg.length === 0) return p.slice(0, PATH_SUMMARY_MAX)
    const name = seg.at(-1)!
    const parent = seg.length > 1 ? seg.slice(0, -1).join('/') : ''
    return (parent ? `${parent}/` : '') + name   // 父目录+basename（H-1）
  }
  function isExempt(path: string): boolean {
    const t = selectedSet.get(path)
    return t !== undefined && Date.now() - t <= (deps.selectedExemptTtlMs ?? SELECT_EXEMPT_TTL_MS)
  }
  function audit(type: string, rec: ToolRecord, extra: Record<string, unknown> = {}): void {
    deps.audit({ ts: new Date().toISOString(), type, runtime: 'desktop', toolId: rec.id, callId: rec.desktopCallId,
      status: rec.status, summary: rec.inputSummary, ...extra } as unknown as AuditEvent)
  }
  function dequeueNext(): void {
    while (awaitingQueue.length > 0) {
      const id = awaitingQueue.shift()!
      const rec = records.get(id)
      if (!rec || rec.status !== 'awaiting_permission') continue
      emit(rec)
      return
    }
  }
  // desktopCallId → sourceCallId 索引（decide/cancel/pick/confirm 以桥 callId 入参，doc 02 §10.3）
  function idOf(callId: string): string | undefined { return byCallId.get(callId) ?? callId }

  function reject(req: DesktopToolRequest, code: string, message: string): void {
    const rec: ToolRecord = { id: req.sourceCallId, desktopCallId: req.callId, toolName: req.toolName, title: deps.registry.get(req.toolName)?.title ?? req.toolName,
      status: 'rejected', inputSummary: redactToolArguments(req.arguments), expiresAt: req.expiresAt, arguments_: req.arguments,
      toolVersion: req.toolVersion, statusSent: false, queue: false, error: { code, message }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
    records.set(rec.id, rec); byCallId.set(req.callId, rec.id)
    audit('tool:terminal', rec, { errorCode: code })
    emit(rec)
  }
  function terminal(rec: ToolRecord, display: 'failed' | 'timeout' | 'cancelled' | 'rejected', err?: { code?: string; message?: string }, cancelSource: 'user' | 'timeout' | 'backend' = 'user'): void {   // M2：扩 'rejected'（shutdown 用）
    rec.status = display; rec.error = err; rec.finishedAt = new Date().toISOString(); rec.durationMs = durationOf(rec)
    const timer = timers.get(rec.id); if (timer) { clearTimeout(timer); timers.delete(rec.id) }
    const wire = display === 'timeout' ? 'cancelled' : toWire(display) ?? 'error'
    void wireSend(rec, wire, err ? { error: err } : {})
    audit('tool:terminal', rec, { errorCode: err?.code, cancelSource })
    emit(rec)
    promoteQueue(rec.id)
  }
  function expire(rec: ToolRecord): void { terminal(rec, 'timeout', { code: 'TIMEOUT', message: '请求超时' }, 'timeout') }
  function durationOf(rec: ToolRecord): number | undefined {
    return rec.startedAt ? Math.max(0, Date.now() - Date.parse(rec.startedAt)) : undefined
  }
  function promoteQueue(callIdOrId?: string): void {
    const i = awaitingQueue.indexOf(callIdOrId ?? '')   // 队列存 rec.id（sourceCallId）——调用方传 rec.id（L8）
    if (i >= 0) awaitingQueue.splice(i, 1)
    dequeueNext()
  }
  async function decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    if (!rec || rec.status !== 'awaiting_permission') throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 不在等待授权态')
    const timer = timers.get(rec.id); if (timer) { clearTimeout(timer); timers.delete(rec.id) }
    audit('tool:decision', rec, { permissionDecision: decision, riskLevel: deps.registry.get(rec.toolName)?.localRisk })
    if (decision === 'deny') {
      rec.status = 'rejected'; rec.finishedAt = new Date().toISOString()
      await wireSend(rec, 'rejected')
      audit('tool:terminal', rec)
      emit(rec); promoteQueue(rec.id)
      return
    }
    await run(rec, deps.registry.get(rec.toolName)!)
    promoteQueue(rec.id)
  }
  async function cancel(callId: string): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    if (!rec || ['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(rec.status)) throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 已终态')
    terminal(rec, 'cancelled', undefined, 'user')
  }
  /** 断线重连（D6B-11/A-8）：终态且 statusSent=false 重发（附件复用已得 URL，不重传）；selected-set 清空 */
  async function reconnect(): Promise<void> {
    selectedSet.clear()
    for (const rec of records.values()) {
      if (['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(rec.status) && !rec.statusSent) {
        const wire = toWire(rec.status) ?? 'cancelled'
        const attachments = rec.attachmentCount ? undefined : undefined   // 附件 URL 已在 rec 内缓存（终态时已回填）——不重传
        void wireSend(rec, wire)
      }
    }
  }
  /** 应用退出（B2/A-8）：停止接收；未决授权按拒绝 + 审计 cancelSource:'user' */
  function shutdown(): void {
    shutdownFlag = true
    for (const rec of records.values()) {
      if (rec.status === 'awaiting_permission' || rec.status === 'running') {
        if (rec.status === 'awaiting_permission') terminal(rec, 'rejected', { code: 'APP_SHUTTING_DOWN', message: '应用正在退出' }, 'user')
      }
    }
    awaitingQueue.length = 0
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }
  /** 最近公开记录（tool:list，≤limit 条；L2 取舍注记：diff/captureSources/capturePreview 不进 listRecent——tool:list 仅作 hydration 用，capture/diff 交互态由 tool:event 实时推送） */
  function listRecent(limit = 20): PublicToolEvent[] {
    const all = [...records.values()].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    return all.slice(0, limit).map((rec) => ({
      id: rec.id, desktopCallId: rec.desktopCallId, toolName: rec.toolName, title: rec.title, runtime: 'desktop' as const,
      status: rec.status, reason: rec.reason, inputSummary: rec.inputSummary, pathSummary: rec.pathSummary,
      resultSummary: rec.resultSummary, error: rec.error, truncated: rec.truncated, durationMs: rec.durationMs,
      startedAt: rec.startedAt, finishedAt: rec.finishedAt, attachmentCount: rec.attachmentCount, dataFlowNote: rec.dataFlowNote,
      occurredAt: rec.finishedAt ?? rec.startedAt ?? new Date().toISOString(),
    }))
  }
  function getRecord(callId: string): ToolRecord | undefined {
    const id = idOf(callId); return id ? records.get(id) : undefined
  }
  /** per-path 写串行锁（A-8/doc 04 §12）：写执行包进同路径 Promise 链 */
  function withPathLock(realPath: string, fn: () => Promise<void>): Promise<void> {
    const prev = serialLocks.get(realPath) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    serialLocks.set(realPath, next)
    return next
  }
  /** Task 2 顺序 stub（新发现9）：pickSource/confirmUpload 完整实现在 Task 4——本 task 先抛占位（接口可编译） */
  async function pickSourceStub(_callId: string, _sourceId: string): Promise<void> { throw new ToolServiceError('CAPTURE_STATE_INVALID', 'capture 在 Task 4 落地') }
  async function confirmUploadStub(_callId: string): Promise<void> { throw new ToolServiceError('CAPTURE_STATE_INVALID', 'capture 在 Task 4 落地') }
  function realPathOf(rec: ToolRecord): string | undefined {   // L1：由 handleRequest 已 normalize 的路径（决策链缓存）
    return typeof rec.arguments_['path'] === 'string' ? rec.arguments_['path'] : undefined
  }
  function codeOf(e: unknown): string {
    if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') return (e as { code: string }).code
    return 'EXECUTION_FAILED'
  }
  function messageOf(e: unknown): string {
    if (e instanceof Error) return e.message
    return String(e ?? '')
  }
  // ... // pickSource/confirmUpload（Task 4 以真实实现替换 stub）
  return { handleRequest, decide, cancel, listRecent, pickSource: pickSourceStub, confirmUpload: confirmUploadStub, reconnect, shutdown, getRecord }
  async function handleRequest(req: DesktopToolRequest): Promise<void> {
    if (shutdownFlag) { reject(req, 'APP_SHUTTING_DOWN', '应用正在退出'); return }
    // 1 注册表+平台
    const tool = deps.registry.get(req.toolName)
    if (!tool || tool.version !== req.toolVersion) return reject(req, 'CAPABILITY_UNAVAILABLE', '未注册或版本不匹配')
    if (!tool.supportedPlatforms.includes(deps.platform === 'windows' ? 'windows' : 'linux')) return reject(req, 'CAPABILITY_UNAVAILABLE', '平台不支持')
    // 2 参数 schema（strict）
    const parsed = tool.inputSchema.safeParse(req.arguments)
    if (!parsed.success) return reject(req, 'INVALID_ARGUMENTS', '参数不合法')
    // 3 幂等（doc 04 §13）
    const existing = records.get(req.sourceCallId)
    if (existing) {
      if (JSON.stringify(existing.arguments_) !== JSON.stringify(req.arguments)) return reject(req, 'PARAM_MISMATCH', '同 callId 参数不一致')
      emit(existing)   // 返回当前状态不重复弹窗
      return
    }
    // 4 paramHash（D6B-22；real 有值必验；mock 无值 → 本地计算回退）
    const paramHash = req.paramHash ?? computeParamHash(req.arguments)
    if (req.paramHash !== undefined && req.paramHash !== computeParamHash(req.arguments)) return reject(req, 'PARAM_HASH_MISMATCH', '参数哈希不一致')
    // 5 full realpath + 黑名单（isPathTool）
    let realPath: string | undefined
    if (tool.isPathTool) {
      const p = req.arguments['path']
      if (typeof p === 'string') {
        try {
          const r = normalizeToolPath(p, { platform: deps.platform })
          realPath = r.realPath
        } catch (e) { return reject(req, 'PATH_UNSAFE', '路径不安全') }
        const blacklisted = isPathBlacklisted(realPath) && !(deps.allowRoots ?? []).some(root => realPath === root || realPath.startsWith(root + '/'))
        if (blacklisted) return reject(req, 'PATH_BLOCKLISTED', '路径被黑名单拦截')
      }
    }
    // 6 Wayland 门禁（capture 授权前，A1）
    if (req.toolName === 'desktop.screen.capture' && isWaylandSession()) return reject(req, 'CAPTURE_UNAVAILABLE', '当前桌面环境不支持屏幕捕获')
    // 记录创建
    const rec: ToolRecord = { id: req.sourceCallId, desktopCallId: req.callId, toolName: req.toolName, title: tool.title,
      status: 'requested', reason: req.reason, inputSummary: redactToolArguments(req.arguments), pathSummary: derivePathSummary(req.arguments),
      dataFlowNote: tool.dataFlowNote, expiresAt: req.expiresAt, paramHash, arguments_: req.arguments, toolVersion: req.toolVersion,
      statusSent: false, queue: false, startedAt: new Date().toISOString() }
    records.set(rec.id, rec); byCallId.set(req.callId, rec.id)
    audit('tool:request-received', rec)
    // 9 wire accepted（步骤 1~6 通过即发——先于预读与授权判定，spec step 9/M1/A-12 一致性）
    await wireSend(rec, 'accepted')
    // 7 write 授权前预读 + Diff（A2/L7；预读失败（FILE_TOO_LARGE/FILE_IS_BINARY）→ reject，A-15）
    if (req.toolName === 'desktop.file.write' && realPath) {
      try { await preReadForDiff(rec, realPath) }
      catch (e) { terminal(rec, 'failed', { code: codeOf(e), message: messageOf(e) }); return }
    }
    // 8 授权判定（D6B-03）
    const decision = tool.permissionMode === 'automatic' ? 'auto' : (req.toolName === 'desktop.file.read' && realPath && isExempt(realPath) ? 'auto' : 'prompt')
    if (decision === 'auto') { await run(rec, tool) }
    else {
      rec.status = 'awaiting_permission'; awaitingQueue.push(rec.id)
      if (awaitingQueue.length === 1) emit(rec)
      // expiresAt 定时器（超时 → timeout + wire cancelled）
      const remaining = req.expiresAt - Date.now()
      if (remaining > 0) timers.set(rec.id, setTimeout(() => expire(rec), remaining))
    }
  }
  async function run(rec: ToolRecord, tool: RegisteredTool): Promise<void> {
    rec.status = 'running'; rec.startedAt ??= new Date().toISOString()
    audit('tool:executing', rec)
    emit(rec)
    await wireSend(rec, 'running')                    // A-7：执行前发 running（上传时序 M4 前置）
    // 执行超时定时器
    const timeout = setTimeout(() => { if (rec.status === 'running') { terminal(rec, 'timeout', { code: 'TIMEOUT' }) } }, tool.defaultTimeoutMs)
    try {
      const result = deps.executorOverride ? await deps.executorOverride(rec, realPathOf(rec)) : await executors.execute(rec, realPathOf(rec))
      if (rec.status !== 'running') return    // 已终态（取消等）
      // 12 outputSchema 校验（B1）
      const ok = tool.outputSchema.safeParse(result.output)
      if (!ok.success) { terminal(rec, 'failed', { code: 'INVALID_OUTPUT' }); return }
      rec.status = 'completed'; rec.resultSummary = result.summary; rec.attachmentCount = result.attachmentCount
      rec.finishedAt = new Date().toISOString(); rec.durationMs = durationOf(rec)
      // M3/代码 M3：ToolStatusCommand.output 为 string → JSON.stringify
      await wireSend(rec, 'result', { output: JSON.stringify(result.output), attachments: result.attachments })
      audit('tool:terminal', rec)
      emit(rec)
    } catch (e) {
      if (rec.status === 'running') {
        const code = codeOf(e); const rawMessage = messageOf(e)
        terminal(rec, 'failed', { code, message: rawMessage === '' ? undefined : rawMessage })   // A-16/M6：error.message 空串归一 undefined
      }
    } finally { clearTimeout(timeout) }
  }
  // ... terminal/reject/expire/cancel/decide/pickSource/confirmUpload/reconnect/shutdown/listRecent（见 Step 4 下方补齐的 reject/terminal/expire/decide/cancel 完整实现；byCallId 索引随 records 同步）
  return { handleRequest, decide, cancel, listRecent, pickSource, confirmUpload, reconnect, shutdown, getRecord }
}
```
**Task 2 的 `preReadForDiff` 实现**（决策链 step 7，A2/L7；import 需含 `node:fs`/`node:crypto`，代码 L1）：

```typescript
  async function preReadForDiff(rec: ToolRecord, realPath: string): Promise<void> {
    if (!fs.existsSync(realPath)) { rec.diff = { lines: [], added: 0, removed: 0, truncated: false, totalLines: 0, formatNote: '新建文件：UTF-8 无 BOM / LF', isNewFile: true }; return }
    const st = fs.statSync(realPath)
    if (st.size > FILE_READ_MAX_BYTES) throw new ToolExecError('FILE_TOO_LARGE', '目标文件超过 2 MiB 上限')
    const buf = fs.readFileSync(realPath)
    const oldText = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    const d = computeTextDiff(oldText, String(rec.arguments_['content']))
    const fmt = detectTextFormat(oldText)
    const eolNote = fmt.eol === 'crlf' ? 'CRLF' : 'LF'
    rec.diff = { lines: d.lines, added: d.added, removed: d.removed, truncated: d.truncated, totalLines: d.totalLines,
      formatNote: `将按原文件格式写入：UTF-8${fmt.hasBom ? '（带 BOM）' : ' 无 BOM'} / ${eolNote}${fmt.endsWithNewline ? ' / 末尾换行将补齐' : ''}`,
      isNewFile: false }
    rec.oldHash = createHash('sha256').update(buf).digest('hex')   // 写前哈希检查依据（原子替换前复核，A-1）
  }
```
（`preReadForDiff` 抛 `ToolExecError`——Task 2 的 tool-executors stub 定义该类；决策链 handleRequest 中已包 try/catch 转 terminal failed，A-15。）
- [ ] **Step 5: 建 tool-executors.ts 最小 stub（完整 M3/A-15/M1——Task 2 的 import 必须可解析；头部 Files 补本文件与 text-diff.ts，L500-503 同步）**

```typescript
// src/main/tools/tool-executors.ts（Task 2 stub——Task 3 实装）
export class ToolExecError extends Error { constructor(public code: string, message: string) { super(message) } }
export interface ExecResult { output: Record<string, unknown>; summary: string; attachments?: ToolAttachment[]; attachmentCount?: number; captureSession?: boolean }
export function createExecutors(_deps: unknown): { execute(rec: unknown, realPath?: string): Promise<ExecResult> } {
  return { async execute() { throw new ToolExecError('NOT_IMPLEMENTED', 'Task 3 实装') } }
}
```
**说明**：本 task 的 `preReadForDiff`/`reconnect`/`shutdown`/`listRecent`/`getRecord`/`withPathLock`/`isWaylandSession` 已在 Step 4 给出完整实现；text-diff 最小实现并入 Step 6（jsdiff 依赖在此引入，D6B-04/19）；`pickSource/confirmUpload` 本 task 用 stub（Task 4 替换）。

- [ ] **Step 6: 引入 jsdiff + 实现 text-diff.ts（含失败测试先行）**

```bash
pnpm --filter @cyrene/desktop add diff@^9.0.0
```

```typescript
// tests/unit/text-diff.spec.ts
import { describe, expect, it } from 'vitest'
import { computeTextDiff, detectTextFormat, normalizeToFormat } from '../../src/main/tools/text-diff'

describe('computeTextDiff', () => {
  it('行级新增/删除/上下文', () => {
    const d = computeTextDiff('a\nb\n', 'a\nc\n')
    expect(d.lines.filter(l => l.kind === 'added').map(l => l.text)).toContain('c\n')
    expect(d.added).toBe(1); expect(d.removed).toBe(1)
  })
  it('100 行截断（MAX_DIFF_LINES）', () => {
    const old_ = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n')
    const d = computeTextDiff(old_, old_ + '\nx')
    expect(d.truncated).toBe(true)
  })
})
describe('detectTextFormat / normalizeToFormat（D6B-19/L-2 拆行段重拼）', () => {
  it('CRLF 检测与往返无损', () => {
    const fmt = detectTextFormat('a\r\nb\r\n')
    expect(fmt.eol).toBe('crlf'); expect(fmt.endsWithNewline).toBe(true)
    const out = normalizeToFormat('a\nb', fmt)
    expect(out).toBe('a\r\nb\r\n')     // 拆行段重拼，无 \r\r\n
  })
  it('BOM 保留', () => { expect(detectTextFormat('\uFEFFa\n').hasBom).toBe(true) })
})
```

```typescript
// src/main/tools/text-diff.ts
import { diffLines } from 'diff'
export interface DiffLine { kind: 'added' | 'removed' | 'unchanged'; text: string }
export interface TextDiffResult { lines: DiffLine[]; added: number; removed: number; truncated: boolean; totalLines: number }   // totalLines（A-20/H2）
export const MAX_DIFF_LINES = 100
export function computeTextDiff(oldText: string, newText: string): TextDiffResult {
  const parts = diffLines(oldText, newText)
  let added = 0, removed = 0, lines: DiffLine[] = []
  for (const p of parts) {
    const kind = p.added ? 'added' : p.removed ? 'removed' : 'unchanged'
    if (kind !== 'unchanged') { if (p.added) added += p.count ?? 0; else removed += p.count ?? 0 }
    const seg = p.value.split(/(?<=\n)/)
    for (const text of seg) { if (lines.length < MAX_DIFF_LINES) lines.push({ kind, text }) }
  }
  const total = parts.reduce((n, p) => n + (p.count ?? p.value.split('\n').length), 0)
  return { lines, added, removed, truncated: total > MAX_DIFF_LINES, totalLines: total }
}
export interface TextFormat { hasBom: boolean; eol: 'crlf' | 'lf' | 'mixed'; endsWithNewline: boolean }
export function detectTextFormat(text: string): TextFormat {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  const eol: TextFormat['eol'] = crlf > 0 && lf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : 'lf'
  return { hasBom: text.startsWith('\uFEFF'), eol, endsWithNewline: text.endsWith('\n') }
}
export function normalizeToFormat(content: string, fmt: TextFormat): string {
  // 拆行段重拼（L-2）：去 BOM → 统一 LF → 按目标 EOL 重拼 → 末尾换行补齐 → 还原 BOM
  let s = content.startsWith('\uFEFF') ? content.slice(1) : content
  s = s.replace(/\r\n/g, '\n')
  if (fmt.eol === 'crlf') s = s.replace(/\n/g, '\r\n')
  if (fmt.endsWithNewline && !s.endsWith(fmt.eol === 'crlf' ? '\r\n' : '\n')) s += fmt.eol === 'crlf' ? '\r\n' : '\n'
  if (fmt.hasBom) s = '\uFEFF' + s
  return s
}
```

- [ ] **Step 7: 补 text-diff 单测通过 + tool-service.spec 全绿 + typecheck**

Run: `pnpm -F @cyrene/desktop test -- run tests/unit/tool-service.spec.ts tests/unit/param-hash.spec.ts tests/unit/text-diff.spec.ts && pnpm -F @cyrene/desktop typecheck`
**注意**：`tool-service.spec.ts` 的 `mkService` 需支持 `{ isWayland, executorOverride }` 注入选项 + 暴露 `getRecord`（对应 ToolService API）；param-hash 固定向量 hex 在执行前用后端 plugin.py canonical 算法实算填入（A-11）。

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/tools/param-hash.ts apps/desktop/src/main/tools/tool-service.ts apps/desktop/src/main/tools/tool-executors.ts apps/desktop/src/main/tools/text-diff.ts apps/desktop/tests/unit/param-hash.spec.ts apps/desktop/tests/unit/tool-service.spec.ts apps/desktop/tests/unit/text-diff.spec.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(阶段6批次B Task2): tool-service 核心——决策链 15 步（注册表/平台/schema/幂等/paramHash/realpath+黑名单/Wayland 门禁注入/accepted 先于预读/预读+Diff/授权/执行 running→result/outputSchema/状态机/重连/shutdown/串行锁）+ awaiting FIFO 队列 + selected-set 豁免+写闭包 + param-hash canonical（固定向量）+ text-diff（jsdiff ^9.0.0，totalLines）+ executors 最小 stub（ToolExecError）"
```

---

### Task 3: 文本执行器（file.select / file.read / file.write）

**Files:**
- Create: `apps/desktop/src/main/tools/tool-executors.ts`
- Test: `apps/desktop/tests/unit/tool-executors.spec.ts`（新）

**Interfaces:**
- Consumes: Task 2 的 `ToolServiceDeps`/`ToolRecord`/`TEXT_FILE_FILTERS`/`FILE_READ_MAX_BYTES`/`RESULT_INLINE_BYTES`/`MAX_WRITE_CONTENT_BYTES`/`normalizeToolPath`/`PolicyError`/`text-diff` 三函数；`SafeOpenPlatform`（main/persistence/safe-open.ts）；`atomicWriteFile`（credentials/atomic-write.ts）
- Produces: `createExecutors(deps)`（execute(rec, realPath) → { output, summary, attachments?, attachmentCount? }）——Task 4 补 capture；Task 5 接 status-sender

- [ ] **Step 1: 写失败测试——file.select / read / write（tool-executors.spec.ts）**

```typescript
// tests/unit/tool-executors.spec.ts（node；临时目录 mkdtemp；picker/enumerate 注入）
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutors } from '../../src/main/tools/tool-executors'
import type { ToolServiceDeps } from '../../src/main/tools/tool-service'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cyrene-exec-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function mkDeps(over: Partial<ToolServiceDeps> = {}): ToolServiceDeps {
  return {
    platform: 'posix', audit: () => {}, submitStatus: async () => {},
    uploadAttachment: vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' }),
    pushEvent: () => {}, pickFile: async () => ({ canceled: true }), enumerateSources: async () => [], ...over,
  } as ToolServiceDeps
}
function rec(toolName: string, args: Record<string, unknown>) {
  return { id: 'tc_1', desktopCallId: 'call_1', toolName, title: toolName, status: 'running', expiresAt: Date.now() + 30_000,
    arguments_: args, toolVersion: '1.0', statusSent: false, queue: false } as any
}

describe('desktop.file.select', () => {
  it('picker 取消 → {cancelled:true} 非错误', async () => {
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toEqual({ cancelled: true })
  })
  it('选中文件 → 元数据结果', async () => {
    const p = join(tmp, 'a.txt'); writeFileSync(p, 'hello')
    const ex = createExecutors(mkDeps({ allowRoots: [tmp], pickFile: async () => ({ canceled: false, path: p }) }))   // H9：mkdtemp 在 /tmp → allowRoots 注入（select 复核与服务层同口径）
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toMatchObject({ cancelled: false, path: p, name: 'a.txt', size: 5 })
    expect((r.output as any).hash).toMatch(/^[0-9a-f]{64}$/)
  })
  it('黑名单路径命中 → {cancelled:true, reason:PATH_BLOCKLISTED}（M-7/L10）', async () => {
    const ex = createExecutors(mkDeps({ pickFile: async () => ({ canceled: false, path: '/etc/passwd' }) }))
    const r = await ex.execute(rec('desktop.file.select', {}), undefined)
    expect(r.output).toEqual({ cancelled: true, reason: 'PATH_BLOCKLISTED' })
  })
})
describe('desktop.file.read', () => {
  it('读取 UTF-8 文本 → 内联 output + 摘要', async () => {
    const p = join(tmp, 'r.txt'); writeFileSync(p, '你好 world')
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.read', { path: p }), p)
    expect(r.output).toMatchObject({ path: p, size: Buffer.byteLength('你好 world'), charset: 'utf-8' })
    expect((r.output as any).content).toBe('你好 world')
  })
  it('>2MiB → FILE_TOO_LARGE', async () => {
    const p = join(tmp, 'big.txt'); writeFileSync(p, 'x'.repeat(2 * 1024 * 1024 + 1))
    const ex = createExecutors(mkDeps())
    await expect(ex.execute(rec('desktop.file.read', { path: p }), p)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })
  it('二进制（NUL）→ FILE_IS_BINARY', async () => {
    const p = join(tmp, 'bin.dat'); writeFileSync(p, Buffer.from([0, 1, 2, 0, 3]))
    const ex = createExecutors(mkDeps())
    await expect(ex.execute(rec('desktop.file.read', { path: p }), p)).rejects.toMatchObject({ code: 'FILE_IS_BINARY' })
  })
  it('>64KiB → 附件上传 + truncated 摘要（B-2①：summary 含截断注记）', async () => {
    const p = join(tmp, 'big.txt'); writeFileSync(p, 'y'.repeat(70 * 1024))
    const upload = vi.fn().mockResolvedValue({ url: 'mock://a/1', mimeType: 'text/plain' })
    const ex = createExecutors(mkDeps({ uploadAttachment: upload }))
    const r = await ex.execute(rec('desktop.file.read', { path: p }), p)
    expect(upload).toHaveBeenCalled()
    expect(r.attachments?.length).toBe(1)
    expect(r.summary).toContain('已截断')
  })
})
describe('desktop.file.write', () => {
  it('新建文件 → 写入成功（UTF-8 无 BOM LF）', async () => {
    const p = join(tmp, 'new.txt')
    const ex = createExecutors(mkDeps())
    const r = await ex.execute(rec('desktop.file.write', { path: p, content: 'abc\n' }), p)
    expect(readFileSync(p, 'utf8')).toBe('abc\n')
    expect((r.output as any).bytesWritten).toBe(4)
  })
  it('覆盖保留原格式（CRLF + BOM + 末尾换行，D6B-19/L-2）', async () => {
    const p = join(tmp, 'crlf.txt'); writeFileSync(p, '\uFEFFa\r\nb\r\n')
    const ex = createExecutors(mkDeps())
    await ex.execute(rec('desktop.file.write', { path: p, content: 'a\nc' }), p)
    expect(readFileSync(p, 'utf8')).toBe('\uFEFFa\r\nc\r\n')   // BOM 保留 + CRLF 重拼 + 末尾换行补齐
  })
  it('写前哈希冲突 → FILE_CONFLICT（原文件不变；基于授权前预读 hash，A-1）', async () => {
    const p = join(tmp, 'c.txt'); writeFileSync(p, 'v1')
    const ex = createExecutors(mkDeps())
    // 模拟授权前预读：rec.oldHash = 预读时 hash（决策链 step 7 注入）
    const oldHash = createHash('sha256').update('v1').digest('hex')
    const r = rec('desktop.file.write', { path: p, content: 'v2' }); r.oldHash = oldHash
    await ex.execute(r, p)
    writeFileSync(p, 'v3')   // 外部修改
    const r2 = rec('desktop.file.write', { path: p, content: 'v2' }); r2.oldHash = oldHash
    await expect(ex.execute(r2, p)).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    expect(readFileSync(p, 'utf8')).toBe('v3')   // 原文件不变
  })
  it('无 rec.oldHash（未预读）时以当前内容为基准写入（防御路径）', async () => {
    const p = join(tmp, 'd.txt'); writeFileSync(p, 'v1')
    const ex = createExecutors(mkDeps())
    const r = rec('desktop.file.write', { path: p, content: 'v2' })   // 无 oldHash
    await ex.execute(r, p)
    expect(readFileSync(p, 'utf8')).toBe('v2')
  })
  it('content >2MiB → CONTENT_TOO_LARGE', async () => {
    const p = join(tmp, 'big.txt')
    const ex = createExecutors(mkDeps())
    await expect(ex.execute(rec('desktop.file.write', { path: p, content: 'x'.repeat(2 * 1024 * 1024 + 1) }), p))
      .rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' })
  })
})
```

- [ ] **Step 2: 实现 tool-executors.ts（select/read/write；capture 骨架留 Task 4）**

```typescript
// src/main/tools/tool-executors.ts
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { dialog } from 'electron'
import { atomicWriteFile } from '../credentials/atomic-write'      // A-13：原子写复用（fsync + 安全写）
import { computeTextDiff, detectTextFormat, normalizeToFormat } from './text-diff'
import { normalizeToolPath, isPathBlacklisted } from './tool-policy'
import { FILE_READ_MAX_BYTES, MAX_WRITE_CONTENT_BYTES, RESULT_INLINE_BYTES, TEXT_FILE_FILTERS, ToolRecord, ToolServiceDeps } from './tool-service'
import type { ToolAttachment } from '@shared/contracts/tool'       // 新发现7：类型 import 补齐

export interface ExecResult { output: Record<string, unknown>; summary: string; attachments?: ToolAttachment[]; attachmentCount?: number }
export class ToolExecError extends Error { constructor(public code: string, message: string) { super(message) } }

export function createExecutors(deps: ToolServiceDeps): { execute(rec: ToolRecord, realPath?: string): Promise<ExecResult> } {
  async function select(rec: ToolRecord): Promise<ExecResult> {
    const picker = deps.pickFile ?? (async (o) => {
      const r = await dialog.showOpenDialog({ title: o.title, filters: o.filters, properties: ['openFile'] })
      return r.canceled || r.filePaths.length === 0 ? { canceled: true } : { canceled: false, path: r.filePaths[0] }
    })
    const r = await picker({ title: rec.title, filters: [TEXT_FILE_FILTERS] })
    if (r.canceled || !r.path) return { output: { cancelled: true }, summary: '用户取消选择' }
    // 黑名单复核（M-7/L10/H9）：命中 → 伪装取消；allowRoots 与服务层同口径（/tmp 黑名单经注入放宽）
    const norm = normalizeToolPath(r.path, { platform: deps.platform })
    const blacklisted = isPathBlacklisted(norm.realPath) && !(deps.allowRoots ?? []).some(root => norm.realPath === root || norm.realPath.startsWith(root + '/'))
    if (blacklisted) {
      return { output: { cancelled: true, reason: 'PATH_BLOCKLISTED' }, summary: '用户取消选择' }
    }
    const st = fs.statSync(norm.realPath)
    const hash = createHash('sha256').update(fs.readFileSync(norm.realPath)).digest('hex')
    deps.selectedAdd?.(norm.realPath)   // selected-set 回调（A-14：tool-service 注入写闭包；可选防未接线）
    return { output: { cancelled: false, path: norm.realPath, name: path.basename(norm.realPath), size: st.size, mtimeMs: st.mtimeMs, hash }, summary: `已选择 ${path.basename(norm.realPath)}` }
  }
  async function readFile(rec: ToolRecord, realPath?: string): Promise<ExecResult> {
    const p = realPath ?? String(rec.arguments_['path'])
    const st = fs.statSync(p)
    if (st.size > FILE_READ_MAX_BYTES) throw new ToolExecError('FILE_TOO_LARGE', '文件超过 2 MiB 上限')
    const buf = fs.readFileSync(p)
    // TOCTOU：open 后 fstat 复核（安全打开——实际打开由调用方 normalizeToolPath 语义保证；此处 size 复核）
    if (buf.byteLength !== st.size) throw new ToolExecError('FILE_CONFLICT', '文件在读取期间变化')
    if (buf.subarray(0, 8192).includes(0)) throw new ToolExecError('FILE_IS_BINARY', '二进制文件')
    if (buf[0] === 0xff && buf[1] === 0xfe || buf[0] === 0xfe && buf[1] === 0xff) throw new ToolExecError('FILE_IS_BINARY', 'UTF-16 不支持')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) }
    catch { throw new ToolExecError('FILE_IS_BINARY', '非 UTF-8 文本') }
    const hash = createHash('sha256').update(buf).digest('hex')
    const base = { path: p, name: path.basename(p), size: st.size, hash, charset: 'utf-8' }
    if (buf.byteLength <= RESULT_INLINE_BYTES) {
      return { output: { ...base, content: text }, summary: `读取 ${path.basename(p)}（${st.size} 字节）` }
    }
    const attachment = await deps.uploadAttachment(rec.desktopCallId!, buf, 'text/plain', path.basename(p))
    const truncated = text.slice(0, 2000)
    return { output: { ...base, truncated: true }, summary: `读取 ${path.basename(p)}（${st.size} 字节，已截断）\n${truncated}`, attachments: [attachment], attachmentCount: 1 }   // B-2①：summary 含「已截断」
  }
  async function writeFile(rec: ToolRecord, realPath?: string): Promise<ExecResult> {
    const p = realPath ?? String(rec.arguments_['path'])
    const content = String(rec.arguments_['content'])
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_CONTENT_BYTES) throw new ToolExecError('CONTENT_TOO_LARGE', '内容超过 2 MiB 上限')
    const exists = fs.existsSync(p)
    let oldText = ''
    if (exists) {
      const buf = fs.readFileSync(p)
      if (buf.byteLength > FILE_READ_MAX_BYTES) throw new ToolExecError('FILE_TOO_LARGE', '目标文件超过 2 MiB')
      try { oldText = new TextDecoder('utf-8', { fatal: true }).decode(buf) }
      catch { throw new ToolExecError('FILE_IS_BINARY', '目标文件非 UTF-8 文本，拒绝覆盖') }
    }
    const fmt = exists ? detectTextFormat(oldText) : { hasBom: false, eol: 'lf' as const, endsWithNewline: false }
    const normalized = normalizeToFormat(content, fmt)
    // 写前哈希检查（A-1）：基于授权前预读 hash（rec.oldHash）；无预读时以当前内容为基准（防御路径）
    if (exists && rec.oldHash) {
      const nowHash = createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      if (nowHash !== rec.oldHash) throw new ToolExecError('FILE_CONFLICT', '文件已被修改，未覆盖')
    }
    // 原子替换（A-13/完整 L2/H10）：复用 atomicWriteFile——真实签名 (filePath: string, data: string, opts: { safeRoot: string })
    // data 传字符串（非 Buffer）；safeRoot 传目标父目录（内部 realpath + 包含性复核）
    await atomicWriteFile(p, normalized, { safeRoot: dirname(p) })
    const outHash = createHash('sha256').update(normalized).digest('hex')
    const diff = exists ? computeTextDiff(oldText, content) : null
    return { output: { path: p, size: Buffer.byteLength(normalized), hash: outHash, bytesWritten: Buffer.byteLength(normalized) },
      summary: `${exists ? '覆盖' : '新建'} ${path.basename(p)}（Diff：+${diff?.added ?? content.length} -${diff?.removed ?? 0}）` }
  }
  async function capture(rec: ToolRecord): Promise<ExecResult> {
    // Task 4 实装；本 task 抛占位
    throw new ToolExecError('CAPTURE_UNAVAILABLE', 'capture 在 Task 4 落地')
  }
  return {
    async execute(rec, realPath) {
      switch (rec.toolName) {
        case 'desktop.file.select': return select(rec)
        case 'desktop.file.read': return readFile(rec, realPath)
        case 'desktop.file.write': return writeFile(rec, realPath)
        case 'desktop.screen.capture': return capture(rec)
        default: throw new ToolExecError('CAPABILITY_UNAVAILABLE', '未知执行器')
      }
    },
  }
}
// selected-set 回调：ToolServiceDeps 增 selectedAdd?: (realPath: string) => void（Task 6 接线 tool-service 内实现）
```
**注**：`ToolServiceDeps.selectedAdd` 由 Task 2 的 tool-service 在 `createExecutors({ ...deps, selectedAdd: 写闭包 })` 注入（A-14）；**本 task 只消费（`deps.selectedAdd?.()`），不再接线**（M9 修正）。

- [ ] **Step 3: 跑测试 + typecheck**

Run: `pnpm -F @cyrene/desktop test -- run tests/unit/tool-executors.spec.ts && pnpm -F @cyrene/desktop typecheck`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/tools/tool-executors.ts apps/desktop/tests/unit/tool-executors.spec.ts apps/desktop/src/main/tools/tool-service.ts
git commit -m "feat(阶段6批次B Task3): 文本执行器——select（取消非错误+黑名单复核伪装/selected-set 回调）/read（2MiB/64KiB 内联/附件/二进制拒/TOCTOU）/write（Diff+写前哈希 FILE_CONFLICT+随机后缀原子替换+格式保留 normalizeToFormat）"
```

---

### Task 4: capture 执行器 + 子状态机

**Files:**
- Modify: `apps/desktop/src/main/tools/tool-executors.ts`（capture 实装）
- Modify: `apps/desktop/src/main/tools/tool-service.ts`（pickSource/confirmUpload/capture 子状态机推进 + deps 补 enumerateSources 注入 + data URL 上限常量）
- Test: `apps/desktop/tests/unit/tool-executors.spec.ts`（capture 增）、`apps/desktop/tests/unit/tool-service.spec.ts`（capture 子状态机增）

**Interfaces:**
- Consumes: Task 2/3；`desktopCapturer`（electron，Main）；`isWaylandSession`（tool-service 内）
- Produces: capture 三步（awaiting_pick → picked → awaiting_confirm）状态机完整实现；`tool:pick-source`/`tool:confirm-upload` 处理器后端

- [ ] **Step 1: 写失败测试——capture（tool-executors.spec.ts 增 + tool-service.spec.ts 增；含 data URL 上限 A-18）**

```typescript
// tool-executors.spec.ts 增
describe('desktop.screen.capture（枚举面）', () => {
  it('枚举源保留 thumbnailDataUrl（完整 H3：PublicToolEventSchema 要求）', async () => {
    const ex = createExecutors(mkDeps({ enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }))
    const r = await ex.execute(rec('desktop.screen.capture', {}), undefined)
    expect(r.output).toMatchObject({ sources: [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
  })
  it('缩略图 >64KiB 被丢弃并提示（L-5/B5/A-18）', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(70 * 1024)
    const ex = createExecutors(mkDeps({ enumerateSources: async () => [{ sourceId: 'big', sourceName: '大', thumbnailDataUrl: big }, { sourceId: 'ok', sourceName: '小', thumbnailDataUrl: 'data:image/png;base64,AA==' }] }))
    const r = await ex.execute(rec('desktop.screen.capture', {}), undefined)
    expect((r.output as any).sources.map((s: any) => s.sourceId)).toEqual(['ok'])
    expect((r.output as any).dropped).toBe(1)
  })
  it('Wayland 环境拒（防御性复核，A-4）', async () => {
    const ex = createExecutors(mkDeps({ isWayland: true }))
    await expect(ex.execute(rec('desktop.screen.capture', {}), undefined)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' })
  })
})
// tool-service.spec.ts 增（子状态机）
describe('capture 子状态机（D6B-16/M-5/A-2）', () => {
  it('decide allow → 枚举 → awaiting_pick（captureSources 事件）；不直接 completed', async () => {
    const { svc, events } = mkService({ enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    expect(events.some(e => e.captureSources?.length === 1)).toBe(true)
    expect(events.at(-1)?.status).not.toBe('completed')
  })
  it('乱序：confirm-upload 无 preview → CAPTURE_STATE_INVALID', async () => {
    const { svc } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    await expect(svc.confirmUpload('call_1')).rejects.toMatchObject({ code: 'CAPTURE_STATE_INVALID' })
  })
  it('pick 未知 sourceId → 拒', async () => {
    const { svc } = mkService()
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    await expect(svc.pickSource('call_1', 'not-in-snapshot')).rejects.toMatchObject({ code: 'CAPTURE_STATE_INVALID' })
  })
  it('pick → 预览下发 → confirm → completed + wire result（running→result 时序）', async () => {
    const { svc, events, submitStatus } = mkService({
      enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }],
      renderPreview: async () => ({ previewDataUrl: 'data:image/png;base64,AA==', bytes: new Uint8Array([137, 80, 78, 71]) }),
    })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    expect(events.some(e => e.captureSources)).toBe(true)
    await svc.pickSource('call_1', 's1')
    expect(events.at(-1)?.capturePreview).toBeDefined()
    await svc.confirmUpload('call_1')
    expect(events.at(-1)?.status).toBe('completed')
    expect(submitStatus.mock.calls.map(c => c[0].status)).toEqual(['accepted', 'running', 'result'])
    expect(submitStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'result' }))
  })
  it('预览 >256KiB 降级为缩略图（A-18/L-5）', async () => {
    const { svc, events } = mkService({
      enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }],
      renderPreview: async () => ({ previewDataUrl: 'data:image/png;base64,' + 'B'.repeat(300 * 1024), bytes: new Uint8Array(1) }),
    })
    await svc.handleRequest(mkReq({ toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_1', 'allow_once')
    await svc.pickSource('call_1', 's1')
    // 超限 → 降级为缩略图（previewDataUrl 为缩略图值，长度 < 300KiB）→ confirm 可正常通过（L7 修正：降级后 sess.previewDataUrl 已设置，非「仍被拒」）
    expect(events.at(-1)?.capturePreview?.previewDataUrl.length).toBeLessThan(300 * 1024)
  })
})
```

- [ ] **Step 2: 实现 capture 子状态机（tool-service.ts 增 pickSource/confirmUpload + run() capture 分支 + captureSessions；tool-executors capture 实装）**

```typescript
// tool-service.ts 增（createToolService 内）
  interface CaptureSession { sourceId?: string; previewDataUrl?: string; bytes?: Uint8Array; dropped?: number }
  const captureSessions = new Map<string, CaptureSession>()

  // run() 内 capture 分支（A-2 完整代码）——替换原「executors.execute → outputSchema → completed」直接路径：
  //   const result = deps.executorOverride ? await deps.executorOverride(rec, realPathOf(rec)) : await executors.execute(rec, realPathOf(rec))
  //   if (rec.status !== 'running') return
  //   if (rec.toolName === 'desktop.screen.capture' && result.captureSession) {
  //     rec.captureSources = result.output['sources'] as PublicToolEvent['captureSources']
  //     rec.status = 'running'; emit(rec)          // awaiting_pick 态（captureSources 下发）
  //     captureSessions.set(rec.id, { dropped: result.output['dropped'] as number | undefined })
  //     return                                     // 等待 pickSource——不 outputSchema、不 completed
  //   }
  //   const ok = tool.outputSchema.safeParse(result.output)      // （非 capture 路径照旧）
  //   ...

  async function pickSource(callId: string, sourceId: string): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    if (!rec || rec.status !== 'running') throw new ToolServiceError('CAPTURE_STATE_INVALID', '不在 awaiting_pick 态')
    const sess = captureSessions.get(rec.id)
    const known = (rec.captureSources ?? []).some(s => s.sourceId === sourceId)
    if (!sess || !known) throw new ToolServiceError('CAPTURE_STATE_INVALID', 'sourceId 不在枚举快照')
    // picked：全尺寸预览（≤256KiB，超限降级为缩略图，A-18/L-5）
    const render = deps.renderPreview ?? (async (sid) => {
      const { desktopCapturer } = await import('electron')
      const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1920, height: 1080 } })
      const s = srcs.find(x => x.id === sid)
      if (!s) throw new ToolServiceError('CAPTURE_STATE_INVALID', 'sourceId 不存在')
      return { previewDataUrl: s.thumbnail.toDataURL(), bytes: s.thumbnail.toPNG() }
    })
    const { previewDataUrl, bytes } = await render(sourceId)
    sess.sourceId = sourceId; sess.bytes = bytes
    if (previewDataUrl.length > 256 * 1024) {
      // 降级：用缩略图（rec.captureSources 中的）并提示
      const thumb = rec.captureSources?.find(s => s.sourceId === sourceId)?.thumbnailDataUrl
      sess.previewDataUrl = thumb ?? previewDataUrl
    } else { sess.previewDataUrl = previewDataUrl }
    rec.capturePreview = { sourceId, previewDataUrl: sess.previewDataUrl }
    emit(rec)   // picked（preview 下发 → awaiting_confirm）
  }

  async function confirmUpload(callId: string): Promise<void> {
    const id = idOf(callId); const rec = id ? records.get(id) : undefined
    const sess = rec ? captureSessions.get(rec.id) : undefined
    if (!rec || rec.status !== 'running' || !sess?.previewDataUrl) throw new ToolServiceError('CAPTURE_STATE_INVALID', '预览未下发，禁止上传')
    // awaiting_confirm → 上传 → 终态
    const upload = deps.finalizeUpload ?? (async (_cid: string, bytes: Uint8Array) => {})
    await upload(rec.desktopCallId!, sess.bytes!)
    const attachment = await deps.uploadAttachment(rec.desktopCallId!, sess.bytes!, 'image/png', `capture-${rec.desktopCallId}.png`)
    rec.status = 'completed'; rec.resultSummary = `已捕获 ${sess.sourceId}`; rec.attachmentCount = 1
    rec.finishedAt = new Date().toISOString(); rec.durationMs = durationOf(rec)
    await wireSend(rec, 'result', { attachments: [attachment] })
    audit('tool:terminal', rec)
    emit(rec)
    captureSessions.delete(rec.id)   // 终态清理（含取消/超时路径经 terminal() 增删——见下）
  }
  // terminal() 内增：captureSessions.delete(rec.id)（完成/取消/超时清理，doc 04 §8.4）

// tool-executors.ts capture 实装（枚举面；上传由 tool-service 子状态机完成，A-2/完整 H3）
// tool-executors.ts 内（capture 前）定义 isWaylandEnv（L1：env 判定，与 tool-service 同语义、独立实现免循环依赖）：
function isWaylandEnv(): boolean {
  const t = process.env.XDG_SESSION_TYPE?.toLowerCase()
  return t === 'wayland' || (!!process.env.WAYLAND_DISPLAY && t !== 'x11')
}
  async function capture(rec: ToolRecord): Promise<ExecResult> {
    if (deps.isWayland === undefined ? isWaylandEnv() : deps.isWayland) throw new ToolExecError('CAPTURE_UNAVAILABLE', '当前桌面环境不支持屏幕捕获')
    const enumerate = deps.enumerateSources ?? (async () => {
      const { desktopCapturer } = await import('electron')
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 240 } })
      return sources.map(s => ({ sourceId: s.id, sourceName: s.name, thumbnailDataUrl: s.thumbnail.toDataURL() }))
    })
    const all = await enumerate()                                            // M4：单次调用（dropped 从同组计算）
    const sources = all.filter(s => s.thumbnailDataUrl.length <= 64 * 1024)  // 缩略图 ≤64KiB 丢弃（L-5/B5）
    const dropped = all.length - sources.length
    return { output: { sources: sources.map(s => ({ sourceId: s.sourceId, sourceName: s.sourceName, thumbnailDataUrl: s.thumbnailDataUrl })), dropped }, summary: `已枚举 ${sources.length} 个源，等待选择`, captureSession: true }
  }
```
**注**：`isWaylandEnv` 为 tool-executors 内独立判定（复用 tool-service 的 `isWaylandSession` 语义——为免循环依赖，executor 侧用 deps.isWayland 注入优先 + env 兜底；Task 6 的 mock env 桥注入 `CYRENE_MOCK_CAPTURE_SOURCES` 时同时注入 `isWayland:false`（mock 模式不调真实 desktopCapturer，完整 H3④）。`ExecResult` 增 `captureSession?: boolean`。`ToolServiceDeps` 的 `renderPreview/finalizeUpload` 签名见 Task 2 Step 4（完整 H3①）。

- [ ] **Step 3: 补测试全绿 + typecheck**

Run: `pnpm -F @cyrene/desktop test -- run tests/unit/tool-executors.spec.ts tests/unit/tool-service.spec.ts && pnpm -F @cyrene/desktop typecheck`

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/tools/tool-executors.ts apps/desktop/src/main/tools/tool-service.ts apps/desktop/tests/unit/tool-executors.spec.ts apps/desktop/tests/unit/tool-service.spec.ts
git commit -m "feat(阶段6批次B Task4): capture 执行器+子状态机——枚举快照/awaiting_pick→picked→awaiting_confirm 钉死（乱序拒 CAPTURE_STATE_INVALID、sourceId∈快照）+ 预览≤256KiB/缩略图≤64KiB + 上传回填（D6B-16/M-5）"
```

---

### Task 5: tool-status-sender + tool-audit + adapter 附件上传

**Files:**
- Create: `apps/desktop/src/main/tools/tool-status-sender.ts`
- Create: `apps/desktop/src/main/tools/tool-audit.ts`
- Modify: `apps/desktop/src/main/transport/backend-adapter.ts`（`uploadToolAttachment` 接口成员——**BackendAdapter 是 interface 非抽象类**（代码 M2），加成员强制 RealBackend/MockBackend 实现，均已计划）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（`uploadToolAttachment` 实装——本 task 只加方法，handleFrame 接线留 Task 6）
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（`uploadToolAttachment` 实装占位 URL）
- Modify: `apps/desktop/src/main/diagnostics/audit.ts`（AuditEvent 扩展可选字段）
- Modify: `apps/desktop/src/shared/errors/index.ts`（**增 `TOOL_UPLOAD_FAILED` 等本批公开错误码**，代码 H4/完整 M9——spec §3.4 用名 `UPLOAD_FAILED`，统一口径用 `TOOL_UPLOAD_FAILED`）
- Test: `apps/desktop/tests/unit/tool-status-sender.spec.ts`（新）、`apps/desktop/tests/unit/tool-audit.spec.ts`（新）、`apps/desktop/tests/unit/audit.spec.ts`（增：扩展字段可选不破坏既有）

**Interfaces:**
- Consumes: `ToolStatusCommand`/`ToolAttachment`（shared）；`AuditEvent`（diagnostics/audit.ts）；`RawToolStatus`（protocol-v2/raw-types.ts）
- Produces: `createToolStatusSender(deps)`；`auditToolEvent(audit, ev)`；`BackendAdapter.uploadToolAttachment(callId, bytes, mime, label?)` 双实现——Task 6 接线

- [ ] **Step 1: 写失败测试——tool-audit（含 AuditEvent 扩展）**

```typescript
// tests/unit/tool-audit.spec.ts
import { describe, expect, it } from 'vitest'
import { auditToolEvent } from '../../src/main/tools/tool-audit'

describe('auditToolEvent', () => {
  it('字段映射 + 脱敏 summary + riskLevel/permissionDecision/cancelSource 扩展（B4/B6/M-4）', () => {
    const out: any[] = []
    auditToolEvent((e) => out.push(e), { type: 'tool:decision', callId: 'call_1', sourceCallId: 'tc_1', toolName: 'desktop.file.read',
      status: 'awaiting_permission', summary: 'path=<str:8>', riskLevel: 'medium', permissionDecision: 'allow_once' })
    expect(out[0]).toMatchObject({ type: 'tool:decision', toolId: 'tc_1', callId: 'call_1', riskLevel: 'medium', permissionDecision: 'allow_once' })
  })
  it('summary 显式禁止 output 摘要：resultSummary 传参 → 不入 audit（M-4）', () => {
    const out: any[] = []
    auditToolEvent((e) => out.push(e), { type: 'tool:terminal', callId: 'c', status: 'completed',
      summary: '文件内容前 2000 字符……' /* 模拟误传 */ })
    // auditToolEvent 只允许 redactToolArguments 产物/固定元数据——本用例传文件内容 → 函数应拒绝（抛出或忽略该 summary）
    expect(out[0]?.summary).not.toContain('文件内容')
  })
  it('backend 来源完整性注记 + fail-open', () => {
    const out: any[] = []
    auditToolEvent((e) => out.push(e), { type: 'tool:status-sent', callId: 'c', runtime: 'backend', status: 'completed', summary: '客户端公开事件，非后端完整审计' })
    expect(out[0].summary).toContain('客户端公开事件')
  })
})
```

- [ ] **Step 2: 实现 tool-audit.ts + AuditEvent 扩展**

```typescript
// src/main/tools/tool-audit.ts
import type { AuditEvent } from '../diagnostics/audit'

export interface ToolAuditInput {
  type: 'tool:request-received' | 'tool:decision' | 'tool:executing' | 'tool:status-sent' | 'tool:terminal'
  callId: string; sourceCallId?: string; toolName?: string; runtime?: 'desktop' | 'backend'
  status?: string; durationMs?: number; summary?: string
  riskLevel?: 'safe' | 'medium' | 'high'; permissionDecision?: 'allow_once' | 'deny'
  startedAt?: string; errorCode?: string; cancelSource?: 'user' | 'timeout' | 'backend'
}

/** 脱敏工具审计（D6B-18/M-4）：summary 只允许脱敏摘要或固定元数据；
 * 显式拒绝文件内容片段（resultSummary/outputSummary/error.message 不得入 summary） */
export function auditToolEvent(audit: (ev: AuditEvent) => void, input: ToolAuditInput): void {
  let summary: string | undefined = input.summary
  if (summary && !isSafeSummary(summary)) summary = '（已脱敏摘要）'
  audit({ ts: new Date().toISOString(), type: input.type, runtime: input.runtime, toolId: input.sourceCallId,
    callId: input.callId, status: input.status, durationMs: input.durationMs, summary,
    riskLevel: input.riskLevel, permissionDecision: input.permissionDecision, startedAt: input.startedAt,
    errorCode: input.errorCode, cancelSource: input.cancelSource } as unknown as AuditEvent)
}
function isSafeSummary(s: string): boolean {
  // 安全形态：redactToolArguments 产物（<redacted>/<str:N>/类型名/固定元数据）——无原始文件内容特征
  return !s.includes('文件内容') && !s.includes('前 2000 字符') && s.length <= 512
}
```
**注**：`isSafeSummary` 为保守启发式 + 512 上限；调用方纪律（D6B-18 显式禁止 resultSummary 传入）由 Task 6 接线保证——tool-service 的 `audit()` 调用只传 `inputSummary`/固定文案。AuditEvent 扩展：

```typescript
// src/main/diagnostics/audit.ts —— AuditEvent 接口增可选字段
  riskLevel?: 'safe' | 'medium' | 'high'
  permissionDecision?: 'allow_once' | 'deny'
  startedAt?: string
  errorCode?: string
  cancelSource?: 'user' | 'timeout' | 'backend'
```

- [ ] **Step 3: 写失败测试——tool-status-sender**

```typescript
// tests/unit/tool-status-sender.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { createToolStatusSender } from '../../src/main/tools/tool-status-sender'

describe('createToolStatusSender', () => {
  it('发送 + 审计 tool:status-sent', async () => {
    const submit = vi.fn().mockResolvedValue(undefined); const audit: any[] = []
    const s = createToolStatusSender({ adapter: { submitToolResult: submit, uploadToolAttachment: async () => ({ url: 'u', mimeType: 't' }) }, audit: (e) => audit.push(e) })
    await s.send({ callId: 'c1', status: 'result', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'x'.repeat(64) })
    expect(submit).toHaveBeenCalled()
    expect(audit.at(-1)?.type).toBe('tool:status-sent')
  })
  it('发送失败 → 返回 false（statusSent 由调用方置位）', async () => {
    const s = createToolStatusSender({ adapter: { submitToolResult: async () => { throw new Error('offline') }, uploadToolAttachment: async () => ({ url: 'u', mimeType: 't' }) }, audit: () => {} })
    expect(await s.send({ callId: 'c', status: 'result', toolName: 't', toolVersion: '1', runtime: 'desktop', paramHash: 'h' })).toBe(false)
  })
  it('附件先上传后回填（H1 响应仅 url，mimeType 本地回填）', async () => {
    const upload = vi.fn().mockResolvedValue({ url: 'https://api/up/1' })
    const s = createToolStatusSender({ adapter: { submitToolResult: async () => {}, uploadToolAttachment: upload }, audit: () => {} })
    const att = await s.uploadToolAttachment('c1', new Uint8Array([1]), 'image/png', 'a.png')
    expect(upload).toHaveBeenCalledWith('c1', expect.any(Uint8Array), 'image/png', 'a.png')
    expect(att).toEqual({ url: 'https://api/up/1', mimeType: 'image/png', label: 'a.png' })
  })
})
```

- [ ] **Step 4: 实现 tool-status-sender.ts**

```typescript
// src/main/tools/tool-status-sender.ts
import type { ToolAttachment, ToolStatusCommand } from '@shared/contracts/backend'
import type { AuditEvent } from '../diagnostics/audit'
import { auditToolEvent } from './tool-audit'

export interface ToolStatusSenderDeps {
  adapter: { submitToolResult(input: ToolStatusCommand): Promise<void>; uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment> }
  audit: (ev: AuditEvent) => void
}
export interface ToolStatusSender {
  send(command: ToolStatusCommand): Promise<boolean>       // false=发送失败（调用方置 statusSent=false）
  uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment>
}
export function createToolStatusSender(deps: ToolStatusSenderDeps): ToolStatusSender {
  return {
    async send(command) {
      try {
        await deps.adapter.submitToolResult(command)
        auditToolEvent(deps.audit, { type: 'tool:status-sent', callId: command.callId, status: command.status, summary: `已回传 ${command.status}` })
        return true
      } catch { return false }
    },
    async uploadToolAttachment(callId, bytes, mime, label) {
      const up = await deps.adapter.uploadToolAttachment(callId, bytes, mime, label)
      return { url: up.url, mimeType: mime, label }   // H1：响应仅 url，mimeType/label 本地回填
    },
  }
}
```

- [ ] **Step 5: BackendAdapter.uploadToolAttachment 抽象 + real/mock 实现**

```typescript
// backend-adapter.ts 增（BackendAdapter interface 内）
  uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment>
```
```typescript
// real-backend.ts 实装（multipart；X-Client-Connection；响应仅 {url}，H1/M4/L4；字段名：token/serverUrl 为私有字段、connectionId 在 ConnectionState（this.state.connectionId，real-backend.ts:317），M5 修正）
  async uploadToolAttachment(callId: string, bytes: Uint8Array, mime: string, label?: string): Promise<ToolAttachment> {
    if (this.state.status !== 'connected' || !this.state.connectionId) throw new CyreneError(CyreneErrorCode.TOOL_UPLOAD_FAILED, '缺少连接标识')
    const serverUrl = this.serverUrl
    const form = new FormData()
    const ext = mime === 'image/png' ? 'png' : mime === 'text/plain' ? 'txt' : mime.split('/')[1] ?? 'bin'
    form.append('file', new Blob([bytes], { type: mime }), `${label ?? 'attachment'}-${callId}.${ext}`)
    // 走 restFetch 同款纪律（fetchImpl 注入 + AbortController，代码 M2）——既有 restFetch 私有方法复用
    const res = await this.restFetch(`${serverUrl}/api/uploads/desktop/${callId}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'X-Client-Connection': this.state.connectionId }, body: form,
    })
    if (!res.ok) throw new CyreneError(CyreneErrorCode.TOOL_UPLOAD_FAILED, `上传失败 ${res.status}`)
    const data = (await res.json()) as { url: string }
    return { url: data.url, mimeType: mime, label }
  }
```
**注意**：`this.serverUrl`/`this.token`/`this.restFetch` 的真实方法名以 real-backend.ts 为准（执行时核对；`restFetch` 若不存在则用 `this.options.fetchImpl` 包 fetch——task review 说明）。mock-backend.ts 实装：`return { url: 'mock://tool-attachment/' + callId, mimeType: mime, label }`。

- [ ] **Step 6: 跑测试 + typecheck**

Run: `pnpm -F @cyrene/desktop test -- run tests/unit/tool-status-sender.spec.ts tests/unit/tool-audit.spec.ts tests/unit/audit.spec.ts && pnpm -F @cyrene/desktop typecheck`

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/tools/tool-status-sender.ts apps/desktop/src/main/tools/tool-audit.ts apps/desktop/src/main/transport/backend-adapter.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/diagnostics/audit.ts apps/desktop/src/shared/errors/index.ts apps/desktop/tests/unit/tool-status-sender.spec.ts apps/desktop/tests/unit/tool-audit.spec.ts apps/desktop/tests/unit/audit.spec.ts
git commit -m "feat(阶段6批次B Task5): status-sender（六态组装/附件先传后填/失败置位）+ tool-audit（脱敏+扩展字段+cancelSource）+ adapter.uploadToolAttachment（real multipart+X-Client-Connection 响应仅 url / mock 占位）+ CyreneErrorCode TOOL_UPLOAD_FAILED"
```

---

### Task 6: Main 接线（real-backend case / mock 改接 / index 装配 / IPC handlers / preload / R-A3）

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（`case 'tool.request'` + `onToolRequest` setter + `submitToolResult` 实装）
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（`toolRequestSink` + desktop kind 改接 + id 自增 + `submitToolResult` 保持）
- Modify: `apps/desktop/src/main/index.ts`（装配 tool-service + env 桥 + before-quit + registerHandlers deps）
- Create: `apps/desktop/src/main/ipc/tool-handlers.ts`
- Modify: `apps/desktop/src/main/ipc/handlers.ts`（deps 增 tools）
- Modify: `apps/desktop/src/preload/desktop-api.ts`（onToolEvent/toolDecide/toolCancel/toolList/toolPickSource/toolConfirmUpload）
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts`（R-A3：`info.error === ''` 分支）
- Test: `apps/desktop/tests/unit/ipc-tool-handlers.spec.ts`（新）、`apps/desktop/tests/unit/mock-backend-tools.spec.ts`（增）、`apps/desktop/tests/unit/rest-mapper-tools.spec.ts`（增 R-A3 空串用例）

**Interfaces:**
- Consumes: Task 1~5 全部；`registerHandler`/`registerOneWayHandler`/`isTrustedSender`（main/ipc/registry.ts）；`createIpcHandler`（main/ipc/executor.ts）；既有 `PushChannels`/`IpcChannels`；`RuntimeInfo`（不扩展）
- Produces: real 全链路（raw tool.request → tool-service → tool:event）；mock sink 改接（不再直发 chat:event）；IPC 六通道 + preload 具名 API；R-A3 加固

- [ ] **Step 1: 写失败测试——mock 改接（mock-backend-tools.spec.ts 增；判别键用 `event`，代码 M7）**

```typescript
// mock-backend-tools.spec.ts 增
describe('batch B 改接（toolRequestSink）', () => {
  it('desktop kind 不再 emit chat:event；经 sink 交付 DesktopToolRequest（id 自增）', async () => {
    const sink: any[] = []
    const mb = new MockBackend({ toolFlow: { kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: '/tmp/x.txt' } } }, toolRequestSink: (req) => sink.push(req) })
    const events: any[] = []; mb.subscribe((e) => events.push(e))
    mb.connect(); await mb.activateConversation('conv-1001'); await mb.sendMessage({ conversationId: 'conv-1001', text: 'hi', clientRequestId: 'r1' })
    await new Promise(r => setTimeout(r, 50))
    expect(sink.length).toBe(1)
    expect(sink[0]).toMatchObject({ callId: 'call_mock_1', sourceCallId: 'tc_mock_desktop_1', toolName: 'desktop.file.read', runtime: 'desktop' })
    expect(sink[0].paramHash).toBeUndefined()
    expect(events.some(e => e.event === 'tool.request')).toBe(false)   // 不再直发 chat:event（判别键 event，代码 M7）
    // 第二次发射 id 自增（A3）
    await mb.sendMessage({ conversationId: 'conv-1001', text: 'hi2', clientRequestId: 'r2' })
    await new Promise(r => setTimeout(r, 50))
    expect(sink[1].callId).toBe('call_mock_2')
    expect(sink[1].sourceCallId).toBe('tc_mock_desktop_2')
  })
  it('backend kind 发射不变', async () => { /* 既有断言保持 */ })
})
```

- [ ] **Step 2: 实现 mock 改接（mock-backend.ts；toolRequestSink 为构造注入——MockBackend 无 options 字段，代码 H1/完整 H2）**

```typescript
// MockBackendOptions 增：toolRequestSink?: (req: DesktopToolRequest) => void
// MockBackend 类：构造器把 options.toolRequestSink 存入私有字段 private readonly toolRequestSink？（对齐 ttsAudioSink 字段先例）
// MockBackend 类增私有字段：private mockToolSeq = 0
// desktop kind 发射处（原 emit ToolRequestEvent）改为：
  const seq = ++this.mockToolSeq
  this.toolRequestSink?.({
    callId: `call_mock_${seq}`, sourceCallId: `tc_mock_desktop_${seq}`,
    toolName: r.toolName, toolVersion: '1.0', runtime: 'desktop',
    arguments: r.arguments ?? {}, reason: r.reason,
    expiresAt: Date.now() + 30_000,
  })
  // 不再 this.emit(...)（R-A5 改接，D6B-15/A3）
  // 新发现4：submitToolResult 的固定串映射（call_mock_1 → tc_mock_desktop_1）同步改为通用映射——
  //   const m = /^call_mock_(\d+)$/.exec(input.callId); const sourceCallId = m ? `tc_mock_desktop_${m[1]}` : input.callId
  //   （id 自增后 call_mock_2+ 的归档 tool.callId 必须落 sourceCallId，否则归档与骨架配对断裂）
```

- [ ] **Step 3: 写失败测试——R-A3 + 回放断言（rest-mapper-tools.spec.ts 增；空壳转真实断言，spec B-1/A-16/A-17）**

```typescript
it('R-A3：info.error === "" 视为无错误走 success 分支', () => {
  // mkSkeleton() 骨架 + role=tool 结果消息（tool.success=false, error=''）
  const messages = [mkSkeleton('tc_1'), mkResult('tc_1', { success: false, error: '' })]
  const out = pairToolCalls(messages)
  const tc = out[0].toolCalls![0]
  expect(tc.status).toBe('completed')     // 空串 error 不判 failed
  expect(tc.error).toBeUndefined()
})
it('非空 error → failed 保持', () => {
  const messages = [mkSkeleton('tc_2'), mkResult('tc_2', { success: false, error: 'boom' })]
  const tc = pairToolCalls(messages)[0].toolCalls![0]
  expect(tc.status).toBe('failed')
  expect(tc.error?.message).toBe('boom')
})
it('回放路径断言（A-17/L6）：toDomainMessageFromReplay 组装 → pairToolCalls（sessionBuffer tool 帧不回归）', () => {
  // 基于既有回放用例：构造含 assistant tool_calls + role=tool 结果的 replay 数组 → toDomainMessageFromReplay → pairToolCalls → toolCalls 配对成功
})
```

- [ ] **Step 4: 写失败测试——ipc-tool-handlers 五通道（ipc-tool-handlers.spec.ts 新，spec A-5/B-4）**

```typescript
// tests/unit/ipc-tool-handlers.spec.ts（createIpcHandler 直调先例——settings-handlers 同款）
import { describe, expect, it, vi } from 'vitest'
import { registerToolHandlers } from '../../src/main/ipc/tool-handlers'
import { IpcChannels } from '@shared/contracts/ipc'
import { PermissionDecisionSchema, ToolCancelSchema, ToolPickSourceSchema, ToolConfirmUploadSchema, ToolListResponseSchema } from '@shared/schemas/ipc-response'

describe('tool-handlers 五通道（A-5/B-4）', () => {
  it('合法调用转发 tool-service', async () => {
    const tools = { decide: vi.fn(), cancel: vi.fn(), listRecent: vi.fn().mockReturnValue([]), pickSource: vi.fn(), confirmUpload: vi.fn() }
    const registered: any[] = []
    const reg = (ch: string, ex: any, arity: number) => { registered.push({ ch, ex, arity }) }
    registerToolHandlers({ tools: tools as any, sanitize: (x: unknown) => x }, reg)
    expect(registered.map(r => r.ch)).toEqual([IpcChannels.toolDecide, IpcChannels.toolCancel, IpcChannels.toolList, IpcChannels.toolPickSource, IpcChannels.toolConfirmUpload])
    // 合法载荷 → executor 执行 → tools.* 被调
    await registered[0].ex({ callId: 'call_1', decision: 'allow_once' })
    expect(tools.decide).toHaveBeenCalledWith('call_1', 'allow_once')
  })
  it('非法 schema → SCHEMA_VALIDATION_FAILED 结构化错误', async () => {
    // 直接对 createIpcHandler 产物做 safeParse：PermissionDecisionSchema.safeParse({callId:1}) 失败
    expect(PermissionDecisionSchema.safeParse({ callId: 1 }).success).toBe(false)
    expect(ToolCancelSchema.safeParse({}).success).toBe(false)
    expect(ToolPickSourceSchema.safeParse({ callId: 'c' }).success).toBe(false)   // 缺 sourceId
    expect(ToolConfirmUploadSchema.safeParse({ callId: 'c' }).success).toBe(true)
  })
  it('toolList 响应 schema（ToolListResponseSchema）', () => {
    expect(ToolListResponseSchema.safeParse([]).success).toBe(true)
  })
  it('isTrustedSender 拒由 registerHandler 层保证（registry 既有单测覆盖，本批引用不重复）', () => { /* 注记 */ })
})
```
**注**：`registerToolHandlers` 的注册器参数可注入（`registerHandler` 签名 `(channel, executor, arity)`——测试传收集器；真实装配传 registry 的 `registerHandler`）。

- [ ] **Step 5: 实现 R-A3（rest-mapper.ts pairToolCalls）**

```typescript
// pairToolCalls 结果消息消费处（既有实现基础上）：
  if (resultInfo) {
    const error = resultInfo.error  // MessageToolInfo.error: string | undefined
    if (error !== undefined && error !== '') {   // R-A3：空串视为无错误
      skeleton.status = 'failed'
      skeleton.error = { code: undefined, message: error }
    } else { skeleton.status = 'completed' }
    // ...outputSummary/durationMs/finishedAt 照旧
  }
```

- [ ] **Step 6: real-backend 接线（handleFrame case + submitToolResult 实装 + onToolRequest）**

```typescript
// real-backend.ts
  /** 批次 B：tool.request 显式 case——mapper 校验+脱敏产出仍保留（批次 A 单测），但不再 emit，
   * 改路由 tool-service（D6B-08）；arguments/paramHash 只在 Main */
  onToolRequest?: (req: DesktopToolRequest) => void   // 可空 setter（index.ts 装配后注入，避免构造环）
  // handleFrame switch 内（在 default 分支之前）：
  case 'tool.request': {
    const ev = this.mapper?.mapFrame(frame)   // H3：mapToolRequest 为 private——走 mapFrame 公开入口（产物 ToolRequestEvent）
    if (!ev) return
    this.onToolRequest?.({ callId: frame.callId, sourceCallId: frame.sourceCallId, toolName: frame.toolName,
      toolVersion: frame.toolVersion, runtime: 'desktop', arguments: frame.arguments, reason: frame.reason,
      expiresAt: Date.parse(frame.expiresAt), paramHash: frame.paramHash })
    return
  }
  // submitToolResult 实装（ToolStatusCommand → RawToolStatus 帧发送；D-status-runtime runtime 保持 str）
  async submitToolResult(input: ToolStatusCommand): Promise<void> {
    const ws = this.requireWs()
    const frame: RawToolStatus = { type: 'tool.status', callId: input.callId, status: input.status,
      toolName: input.toolName, toolVersion: input.toolVersion, runtime: input.runtime, paramHash: input.paramHash,
      output: input.output, error: input.error, attachments: input.attachments, executionSummary: input.executionSummary }
    ws.send(JSON.stringify(frame))
  }
```
**注意**：`mapToolRequest` 现有签名/产物以批次 A 为准（`frame-mapper.ts`）；`RawToolStatus` 形状以 raw-types.ts:338-350 为准（`attachments` 为 `RawToolAttachment[]`——`ToolAttachment` 与 `RawToolAttachment` 字段差异在接线时做最小映射，task review 说明）。`this.state.serverUrl`/`token`/`connectionId` 字段名以 real-backend 实际为准。

- [ ] **Step 7: IPC handlers + preload（tool-handlers.ts + desktop-api.ts；createIpcHandler 模式，代码 H2/M5）**

```typescript
// src/main/ipc/tool-handlers.ts
import { z } from 'zod'   // M6：z import 补齐
import { registerHandler } from './registry'
import { createIpcHandler } from './executor'
import { IpcChannels } from '@shared/contracts/ipc'
import { PermissionDecisionSchema, ToolCancelSchema, ToolPickSourceSchema, ToolConfirmUploadSchema, ToolListResponseSchema } from '@shared/schemas/ipc-response'
import type { PublicToolEvent } from '@shared/contracts/tool'
import type { ToolService } from '../tools/tool-service'

export function registerToolHandlers(
  deps: { tools: ToolService; sanitize: (value: unknown) => unknown },
  register: typeof registerHandler = registerHandler,
): void {
  register(IpcChannels.toolDecide, createIpcHandler(PermissionDecisionSchema, z.undefined(), async (input) => {
    await deps.tools.decide(input.callId, input.decision)
  }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolCancel, createIpcHandler(ToolCancelSchema, z.undefined(), async (input) => { await deps.tools.cancel(input.callId) }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolList, createIpcHandler(z.object({}).strict(), ToolListResponseSchema, async () => deps.tools.listRecent(20), { sanitize: deps.sanitize }), 0)
  register(IpcChannels.toolPickSource, createIpcHandler(ToolPickSourceSchema, z.undefined(), async (input) => { await deps.tools.pickSource(input.callId, input.sourceId) }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolConfirmUpload, createIpcHandler(ToolConfirmUploadSchema, z.undefined(), async (input) => { await deps.tools.confirmUpload(input.callId) }, { sanitize: deps.sanitize }), 1)
}
```
```typescript
// preload/desktop-api.ts 增（具名窄 API；onToolEvent 返回退订；invokeWithArgs + unwrap 惯例，代码 M5）
  onToolEvent(handler: (ev: PublicToolEvent) => void): () => void {
    const wrapped = (_e: unknown, payload: unknown) => {
      const parsed = PublicToolEventSchema.safeParse(payload)
      if (!parsed.success) { console.warn('[preload] 非法 tool:event 已丢弃'); return }
      handler(parsed.data)
    }
    ipcRenderer.on(PushChannels.toolEvent, wrapped)
    return () => ipcRenderer.removeListener(PushChannels.toolEvent, wrapped)
  },
  async toolDecide(input: { callId: string; decision: 'allow_once' | 'deny' }): Promise<void> {
    unwrap(await invokeWithArgs<void>(IpcChannels.toolDecide, input), z.undefined())
  },
  async toolCancel(callId: string): Promise<void> {
    unwrap(await invokeWithArgs<void>(IpcChannels.toolCancel, { callId }), z.undefined())
  },
  async toolList(): Promise<PublicToolEvent[]> {
    return unwrap(await invokeWithArgs<PublicToolEvent[]>(IpcChannels.toolList, {}), ToolListResponseSchema)
  },
  async toolPickSource(callId: string, sourceId: string): Promise<void> {
    unwrap(await invokeWithArgs<void>(IpcChannels.toolPickSource, { callId, sourceId }), z.undefined())
  },
  async toolConfirmUpload(callId: string): Promise<void> {
    unwrap(await invokeWithArgs<void>(IpcChannels.toolConfirmUpload, { callId }), z.undefined())
  },
```
（`DesktopApi` 类型 + `desktopApi` 对象同步；`PublicToolEventSchema`/`ToolListResponseSchema` 从 shared/schemas/ipc-response 导入；`invokeWithArgs`/`unwrap` 为既有 preload 内部工具，desktop-api.ts:94-96 起。）

- [ ] **Step 8: index.ts 装配 + env 桥 + before-quit（构造注入——MockBackend 无 options 字段；BackendAdapter 接口增 onToolRequest?，代码 H1/完整 H2）**

```typescript
// backend-adapter.ts：BackendAdapter interface 增可选成员（real 专用钩子；mock 不实现——D6B-15）
  onToolRequest?: (req: DesktopToolRequest) => void
```
```typescript
// main/index.ts（adapter 构造之后、registerHandlers 之前）
  // env 桥（mock 模式；capture 数据面补全 thumbnailDataUrl（1×1 PNG data URL，R9）+ isWayland:false（mock 不调真实 desktopCapturer，完整 H3④））
  const toolAllowRoot = parseMockToolAllowRootEnv(process.env.CYRENE_MOCK_TOOL_ALLOW_ROOT)
  const captureSources = parseMockCaptureSourcesEnv(process.env.CYRENE_MOCK_CAPTURE_SOURCES)   // [{sourceId,sourceName}] → 补 thumbnailDataUrl 占位
  const statusSender = createToolStatusSender({ adapter, audit })
  const toolSvc = createToolService({
    registry: createToolRegistry(), platform: process.platform === 'win32' ? 'windows' : 'posix',
    audit, submitStatus: (cmd) => statusSender.send(cmd).then(ok => ok ? undefined : Promise.reject(new Error('send failed'))),
    uploadAttachment: (callId, bytes, mime, label) => statusSender.uploadToolAttachment(callId, bytes, mime, label),
    pushEvent: (ev) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(PushChannels.toolEvent, ev) },
    allowRoots: toolAllowRoot,
    enumerateSources: captureSources ? async () => captureSources.map(s => ({ ...s, thumbnailDataUrl: MOCK_THUMBNAIL_DATA_URL })) : undefined,
    renderPreview: captureSources ? async () => ({ previewDataUrl: MOCK_THUMBNAIL_DATA_URL, bytes: new Uint8Array([137, 80, 78, 71]) }) : undefined,   // H11：mock 模式不调真实 desktopCapturer（固定 PNG 头 bytes 供上传断言，R9）
    isWayland: captureSources ? false : undefined,   // mock 模式不判 Wayland（完整 H3④）
  })
  // mock/real 工具请求入口（构造注入 / 可选 setter——都发生在 adapter 构造之后，无环）
  if (adapter instanceof MockBackend) { /* MockBackendOptions 已含 toolRequestSink——见下构造处 */ }
  else adapter.onToolRequest = (req) => { void toolSvc.handleRequest(req) }
  // 真实装配中 MockBackend 的 toolRequestSink 在 new MockBackend({...}) 时传（index.ts:170 处 options 内加：
  //   toolRequestSink: (req) => { void toolSvc.handleRequest(req) }——但 toolSvc 在 adapter 之后构造 → 用桥对象：
  //   const toolBridge: { svc?: ToolService } = {}；new MockBackend({ ..., toolRequestSink: (req) => { void toolBridge.svc?.handleRequest(req) } })；toolBridge.svc = toolSvc
  // registerHandlers deps 增 tools: { decide/cancel/list/pick/confirm（或直接 toolSvc） } + sanitize
  // 重连触发（A-8）：既有 scheduleReconnect 成功后调用 toolSvc.reconnect()（real-backend 经 onToolRequest 同构的 onReconnected 回调或 index.ts 订阅连接状态变化）
  // Main 侧测试探针（完整 M10：集成测试断言 wire lastToolStatus 需要）：
  if (process.env.CYRENE_TEST_HARNESS === '1') {
    ;(globalThis as any).__cyreneMainProbe = {
      getLastToolStatus: () => (adapter as MockBackend).lastToolStatus ?? null,
      getToolRecords: () => [...toolSvc.listRecent(50)],
    }
  }
  app.on('before-quit', () => toolSvc.shutdown())
```
**注意**：`MOCK_THUMBNAIL_DATA_URL` = `'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='`（1×1 PNG，R9）。`parseMockToolAllowRootEnv`/`parseMockCaptureSourcesEnv` 放 `main/tools/env-bridge.ts`（对齐 parseMock*Env 先例，非法 JSON → undefined）；MockBackend 的 `lastToolStatus` 已存在（mock-backend.ts:323）。

- [ ] **Step 9: 跑测试 + typecheck + 全量单测**

Run: `pnpm -F @cyrene/desktop test && pnpm -F @cyrene/desktop typecheck`（mock-backend-tools.spec 既有断言同步改：desktop kind 不再 emit → 断言 sink；`ipc-tool-handlers.spec.ts` 随本步全量单测覆盖，A-5）

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/main/transport/real-backend.ts apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/transport/backend-adapter.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc/tool-handlers.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/src/main/tools/env-bridge.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/main/transport/protocol-v2/rest-mapper.ts apps/desktop/tests/unit/ipc-tool-handlers.spec.ts apps/desktop/tests/unit/mock-backend-tools.spec.ts apps/desktop/tests/unit/rest-mapper-tools.spec.ts
git commit -m "feat(阶段6批次B Task6): Main 接线——real handleFrame case tool.request→tool-service（mapFrame 公开入口，不再 emit）+ submitToolResult 实装（tool.status 帧）+ BackendAdapter.onToolRequest?；mock toolRequestSink 构造注入（id 自增不再直发 chat:event）；IPC 五通道（createIpcHandler 模式）+ preload invokeWithArgs/unwrap；index 装配（桥对象/允许根 env/capture env 补缩略图/reconnect 触发/__cyreneMainProbe）+before-quit shutdown；R-A3 空串+回放断言"
```

---

### Task 7: Renderer（toolStore + 卡片/权限窗/实时区 + Live2D + bootstrap + 探针）

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/tool.store.ts`
- Create: `apps/desktop/src/renderer/src/components/CyToolCard.vue`
- Create: `apps/desktop/src/renderer/src/components/CyToolApproval.vue`
- Create: `apps/desktop/src/renderer/src/components/CyLiveToolCards.vue`
- Modify: `apps/desktop/src/renderer/src/components/CyMessageBubble.vue`（归档卡片 + tool 角色不渲染空气泡）
- Modify: `apps/desktop/src/renderer/src/components/CyChatView.vue`（CyLiveToolCards + CyToolApproval 挂载）
- Modify: `apps/desktop/src/renderer/src/live2d/state-source.ts`（toolWaiting + compose 规则 + isTransient）
- Modify: `apps/desktop/src/renderer/src/live2d/state-source.ts` 的宿主 `apps/desktop/src/renderer/src/stores/live2d.store.ts`（setupStateSource 注入 getter）
- Modify: `apps/desktop/src/renderer/src/bootstrap.ts`（tool 事件旁路）
- Modify: `apps/desktop/src/renderer/src/main.ts`（`__cyreneTest` 探针增 getToolState/getPermissionPending）
- Test: `apps/desktop/tests/unit/tool.store.spec.ts`（新，happy-dom）、`apps/desktop/tests/unit/live2d-state-source.spec.ts`（增）

**Interfaces:**
- Consumes: Task 1 schemas；preload 六 API；`BackendEvent`（ToolRequestEvent/ToolStartedEvent/ToolCompletedEvent）；`Message.toolCalls`；`live2dStateSource` 既有形状
- Produces: `useToolStore`（三来路归一化/终态单向/D6B-21 合并/waitingForApproval/pendingPathSummary/clearForGeneration 只清终态）；两个组件 + 实时区；Live2D 接线；探针——Task 8 集成测试消费

- [ ] **Step 1: 写失败测试——tool.store（tool.store.spec.ts，happy-dom）**

```typescript
// tests/unit/tool.store.spec.ts（文件头 // @vitest-environment happy-dom）
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useToolStore } from '../../src/renderer/src/stores/tool.store'
import type { PublicToolEvent } from '@shared/contracts/tool'

beforeEach(() => { setActivePinia(createPinia()) })

function mkLocal(status: PublicToolEvent['status'], id = 'tc_1'): PublicToolEvent {
  return { id, toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop', status, occurredAt: '2026-08-20T00:00:00.000Z', attachmentCount: 1 }
}

describe('toolStore 三来路归一化', () => {
  it('tool:event 事件 → 记录 + liveOrder', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('awaiting_permission'))
    expect(s.records['tc_1'].status).toBe('awaiting_permission')
    expect(s.liveOrder).toContain('tc_1'); expect(s.waitingForApproval).toBe(true)
  })
  it('backend 事件 → 只读记录（D6B-21：本地已存在不覆盖；判别键 event，代码 H5）', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('completed'))
    s.applyBackendEvent({ event: 'tool.completed', callId: 'tc_1', toolName: 'desktop.file.read', runtime: 'backend', success: false } as any)
    expect(s.records['tc_1'].status).toBe('completed')   // 本地终态不被 backend 覆盖
  })
  it('backend 事件 → 本地不存在时新建只读记录', () => {
    const s = useToolStore()
    s.applyBackendEvent({ event: 'tool.started', callId: 'tc_b1', toolName: 'search_web', runtime: 'backend', inputSummary: 'q=<str:2>' } as any)
    expect(s.records['tc_b1']).toMatchObject({ runtime: 'backend', status: 'running' })
  })
  it('终态单向：completed 后 running 事件忽略', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('completed')); s.upsertLocal(mkLocal('running'))
    expect(s.records['tc_1'].status).toBe('completed')
  })
  it('generation 清空只清终态（A9）：awaiting_permission 保留', () => {
    const s = useToolStore(); s.upsertLocal(mkLocal('awaiting_permission', 'tc_a')); s.upsertLocal(mkLocal('completed', 'tc_d'))
    s.clearForGeneration()
    expect(s.liveOrder).toContain('tc_a'); expect(s.liveOrder).not.toContain('tc_d')
  })
  it('pendingPathSummary 侧信道（M4）：awaiting 写入、终态清空', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('awaiting_permission'), pathSummary: '/home/u/notes.md' })
    expect(s.pendingPathSummary?.pathSummary).toBe('/home/u/notes.md')
    s.upsertLocal(mkLocal('completed'))
    expect(s.pendingPathSummary).toBeNull()
  })
  it('decide/cancel 调 api（setDesktopApi 注入，代码 H6）', async () => {
    const decide = vi.fn(); const cancel = vi.fn()
    setDesktopApi({ toolDecide: decide, toolCancel: cancel } as unknown as DesktopApiLike)
    const s = useToolStore()
    await s.decide('call_1', 'deny'); await s.cancel('call_1')
    expect(decide).toHaveBeenCalledWith({ callId: 'call_1', decision: 'deny' }); expect(cancel).toHaveBeenCalledWith('call_1')
  })
  it('pendingDiff/pendingDataFlowNote 侧信道（A-3）：await 期间权限窗可取，终态清', () => {
    const s = useToolStore()
    s.upsertLocal({ ...mkLocal('awaiting_permission'), diff: { lines: [{ kind: 'added', text: 'x' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'UTF-8', isNewFile: false }, dataFlowNote: '写入内容将发送到后端' })
    expect(s.pendingDiff?.diff?.added).toBe(1)
    expect(s.pendingDataFlowNote).toContain('发送到后端')
    s.upsertLocal(mkLocal('completed'))
    expect(s.pendingDiff).toBeNull(); expect(s.pendingDataFlowNote).toBeNull()
  })
})
```
**注**：api 注入走既有 `setDesktopApi(mockApi)` 模式（`stores/desktop-api.ts:8`，代码 H6）——`DesktopApiLike` 增 `onToolEvent/toolDecide/toolCancel/toolList/toolPickSource/toolConfirmUpload` 六成员（`stores/desktop-api.types.ts`，L3 修正）；测试文件头 `import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'`（或等价注入点，以既有 store spec 先例为准）。`upsertLocal` 内部做 `records[id] = { ...record }` 归一（PublicToolEvent → ToolCallRecord + attachmentCount + 保留 pathSummary/diff/dataFlowNote 侧信道）。

- [ ] **Step 2: 实现 tool.store.ts**

```typescript
// src/renderer/src/stores/tool.store.ts
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { PublicToolEvent, ToolCallRecord, ToolCallStatus } from '@shared/contracts/tool'
import type { BackendEvent } from '@shared/contracts/events'
import { api } from './desktop-api'   // 既有 api 单例（代码 H6）

const LIVE_LIMIT = 3
const TERMINAL: ToolCallStatus[] = ['completed', 'failed', 'rejected', 'cancelled', 'timeout']
type ToolBackendEvent = Extract<BackendEvent, { event: 'tool.request' | 'tool.started' | 'tool.completed' }>   // 判别键 event（代码 H5）

export const useToolStore = defineStore('tool', () => {
  const records = ref<Record<string, ToolCallRecord>>({})
  const liveOrder = ref<string[]>([])
  const captureState = ref<{ callId: string; sources?: PublicToolEvent['captureSources']; preview?: PublicToolEvent['capturePreview'] } | null>(null)
  const pendingPathSummary = ref<{ callId: string; pathSummary: string } | null>(null)
  const pendingDiff = ref<{ callId: string; diff: NonNullable<PublicToolEvent['diff']> } | null>(null)          // A-3：权限窗写 Diff 数据源
  const pendingDataFlowNote = ref<{ callId: string; dataFlowNote: string } | null>(null)                        // A-3：四问④数据源
  let unsubscribeEvent: (() => void) | undefined

  const waitingForApproval = computed(() => liveOrder.value.some(id => records.value[id]?.status === 'awaiting_permission'))

  function upsertRecord(id: string, rec: ToolCallRecord): void {
    const existing = records.value[id]
    if (existing && TERMINAL.includes(existing.status) && existing.status !== rec.status) return   // 终态单向
    if (existing?.status === 'running' && rec.status === 'awaiting_permission') return            // 不回退
    records.value[id] = rec
    if (!liveOrder.value.includes(id)) liveOrder.value.push(id)
    if (liveOrder.value.length > LIVE_LIMIT) liveOrder.value = liveOrder.value.slice(-LIVE_LIMIT)
  }
  function upsertLocal(ev: PublicToolEvent): void {
    const rec: ToolCallRecord = { id: ev.id, desktopCallId: ev.desktopCallId, toolName: ev.toolName, runtime: 'desktop',
      status: ev.status, reason: ev.reason, inputSummary: ev.inputSummary, outputSummary: ev.resultSummary,
      error: ev.error, truncated: ev.truncated, durationMs: ev.durationMs, startedAt: ev.startedAt, finishedAt: ev.finishedAt,
      attachmentCount: ev.attachmentCount }
    upsertRecord(ev.id, rec)
    if (ev.status === 'awaiting_permission') {
      if (ev.pathSummary) pendingPathSummary.value = { callId: ev.desktopCallId ?? ev.id, pathSummary: ev.pathSummary }
      if (ev.diff) pendingDiff.value = { callId: ev.desktopCallId ?? ev.id, diff: ev.diff }
      if (ev.dataFlowNote) pendingDataFlowNote.value = { callId: ev.desktopCallId ?? ev.id, dataFlowNote: ev.dataFlowNote }
    }
    if (TERMINAL.includes(ev.status)) clearApprovalLocal()
    if (ev.toolName === 'desktop.screen.capture' && ev.status === 'running' && (ev.captureSources || ev.capturePreview)) {
      captureState.value = { callId: ev.desktopCallId ?? ev.id, sources: ev.captureSources, preview: ev.capturePreview }
    }
  }
  function clearApprovalLocal(): void {   // 完整 M11：终态清理侧信道（权限窗关闭/回收）
    pendingPathSummary.value = null; pendingDiff.value = null; pendingDataFlowNote.value = null
    captureState.value = null   // L6：capture 面板终态一并回收
  }
  function applyBackendEvent(ev: ToolBackendEvent): void {
    if (ev.event === 'tool.started') {
      if (records.value[ev.callId]) return   // D6B-21：本地已存在不覆盖
      upsertRecord(ev.callId, { id: ev.callId, toolName: ev.toolName, runtime: ev.runtime, status: 'running', inputSummary: ev.inputSummary, generationId: ev.generationId, conversationId: ev.conversationId })
    } else if (ev.event === 'tool.completed') {
      if (records.value[ev.callId]) return
      upsertRecord(ev.callId, { id: ev.callId, toolName: ev.toolName, runtime: ev.runtime,
        status: ev.success ? 'completed' : 'failed', outputSummary: ev.outputSummary, error: ev.error ? { code: String(ev.error['code'] ?? ''), message: String(ev.error['message'] ?? '') } : undefined,
        errorType: ev.errorType, truncated: ev.truncated, durationMs: ev.durationMs, generationId: ev.generationId, conversationId: ev.conversationId })
    }
    // tool.request 防御性忽略（批次 B 起 desktop 请求不再经 chat:event，D6B-08）
  }
  function clearForGeneration(): void { liveOrder.value = liveOrder.value.filter(id => !TERMINAL.includes(records.value[id]?.status ?? 'completed')) }  // A9
  function init(): void {
    if (!unsubscribeEvent) unsubscribeEvent = api.onToolEvent((ev) => upsertLocal(ev))
  }
  async function decide(callId: string, decision: 'allow_once' | 'deny'): Promise<void> { await api.toolDecide({ callId, decision }) }
  async function cancel(callId: string): Promise<void> { await api.toolCancel(callId) }
  async function pickSource(callId: string, sourceId: string): Promise<void> { await api.toolPickSource(callId, sourceId) }
  async function confirmUpload(callId: string): Promise<void> { await api.toolConfirmUpload(callId) }
  function liveRecords(): ToolCallRecord[] { return liveOrder.value.map(id => records.value[id]).filter(Boolean) }
  return { records, liveOrder, captureState, pendingPathSummary, pendingDiff, pendingDataFlowNote, waitingForApproval,
    init, applyBackendEvent, upsertLocal, clearForGeneration, clearApprovalLocal, decide, cancel, pickSource, confirmUpload, liveRecords }
})
```

- [ ] **Step 3: 实现 CyToolCard.vue（数据驱动；只读模式；授权入口；capture 面板分支）**

```vue
<!-- src/renderer/src/components/CyToolCard.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCallRecord } from '@shared/contracts/tool'
import { useToolStore } from '../stores/tool.store'

const props = defineProps<{ record: ToolCallRecord; readonly?: boolean }>()
const emit = defineEmits<{ openApproval: []; cancel: []; pick: [sourceId: string]; confirmUpload: [] }>()
const toolStore = useToolStore()
const STATUS_TEXT: Record<string, string> = {
  requested: '等待授权', awaiting_permission: '等待授权', running: '正在执行', completed: '执行完成',
  failed: '执行失败', rejected: '用户已拒绝', cancelled: '已取消', timeout: '已超时',
}
const statusText = computed(() => STATUS_TEXT[props.record.status] ?? props.record.status)
const isBackend = computed(() => props.record.runtime === 'backend')
const awaiting = computed(() => props.record.status === 'awaiting_permission' && !props.readonly)
const isCapture = computed(() => props.record.toolName === 'desktop.screen.capture')
const pathSummary = computed(() => toolStore.pendingPathSummary && !props.readonly ? toolStore.pendingPathSummary.pathSummary : undefined)
</script>

<template>
  <div class="cy-tool-card" :data-status="record.status" :data-runtime="record.runtime">
    <div class="cy-tool-head">
      <span class="cy-tool-badge" :class="isBackend ? 'is-backend' : 'is-desktop'">{{ isBackend ? '后端' : '此电脑' }}</span>
      <span class="cy-tool-title">{{ record.toolName.startsWith('desktop.') ? record.toolName.slice('desktop.'.length) : record.toolName }}</span>
      <span class="cy-tool-status" data-testid="tool-status">{{ statusText }}</span>
    </div>
    <p v-if="pathSummary" class="cy-tool-path" data-testid="tool-path">{{ pathSummary }}</p>
    <p v-if="record.inputSummary" class="cy-tool-summary">{{ record.inputSummary }}</p>
    <p v-if="record.outputSummary" class="cy-tool-result">{{ record.outputSummary }}<template v-if="record.truncated">…（已截断）</template></p>
    <p v-if="record.error?.message" class="cy-tool-error">{{ record.error.message }}</p>
    <p v-if="record.attachmentCount" class="cy-tool-attachments">含 {{ record.attachmentCount }} 个附件</p>
    <p v-if="record.startedAt" class="cy-tool-time">{{ record.startedAt.slice(0, 19).replace('T', ' ') }}<template v-if="record.finishedAt"> → {{ record.finishedAt.slice(0, 19).replace('T', ' ') }}</template></p>
    <div v-if="!isBackend" class="cy-tool-actions">
      <template v-if="awaiting">
        <button type="button" class="cy-btn cy-btn-approve" data-testid="tool-approve" @click="emit('openApproval')">允许此电脑操作</button>
        <button type="button" class="cy-btn" data-testid="tool-deny" @click="toolStore.decide(record.desktopCallId ?? record.id, 'deny')">拒绝</button>
      </template>
      <button v-if="!['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(record.status)" type="button"
              class="cy-btn cy-btn-cancel" data-testid="tool-cancel" @click="emit('cancel')">取消任务</button>   <!-- H13：独立 v-if（与 awaiting 并存，非 v-else-if）——awaiting 态也有取消入口（Task 8 集成依赖） -->
    </div>
    <div v-if="isCapture && toolStore.captureState && !props.readonly" class="cy-tool-capture" data-testid="tool-capture-panel">
      <div v-if="toolStore.captureState.sources && !toolStore.captureState.preview" class="cy-capture-sources">
        <button v-for="s in toolStore.captureState.sources" :key="s.sourceId" type="button" class="cy-capture-source"
                data-testid="capture-source" @click="emit('pick', s.sourceId)">
          <img :src="s.thumbnailDataUrl" alt="" /><span>{{ s.sourceName }}</span>
        </button>
      </div>
      <div v-else-if="toolStore.captureState.preview" class="cy-capture-preview">
        <img :src="toolStore.captureState.preview.previewDataUrl" alt="截图预览" />
        <button type="button" class="cy-btn cy-btn-approve" data-testid="capture-confirm" @click="emit('confirmUpload')">确认上传</button>
        <button type="button" class="cy-btn" @click="toolStore.cancel(record.desktopCallId ?? record.id)">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cy-tool-card { border: 1px solid var(--cy-border); border-radius: 8px; padding: 8px 10px; margin: 4px 0; font-size: 12px; background: var(--cy-bg-sub); }
.cy-tool-head { display: flex; gap: 8px; align-items: center; }
.cy-tool-badge { padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.cy-tool-badge.is-backend { background: var(--cy-bg-muted); color: var(--cy-text-muted); }
.cy-tool-badge.is-desktop { background: var(--cy-accent-weak, rgba(0,120,255,.15)); color: var(--cy-accent, #1a66ff); }
.cy-tool-status { margin-left: auto; color: var(--cy-text-muted); }
.cy-tool-path, .cy-tool-summary, .cy-tool-result, .cy-tool-error, .cy-tool-attachments, .cy-tool-time { margin: 4px 0 0; color: var(--cy-text-secondary); overflow-wrap: anywhere; }
.cy-tool-error { color: var(--cy-danger, #d33); }
.cy-tool-actions { margin-top: 6px; display: flex; gap: 8px; }
.cy-btn { padding: 3px 10px; border: 1px solid var(--cy-border); border-radius: 6px; background: var(--cy-bg); cursor: pointer; }
.cy-btn-approve { border-color: var(--cy-accent, #1a66ff); color: var(--cy-accent, #1a66ff); }
.cy-capture-sources { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.cy-capture-source { border: 1px solid var(--cy-border); border-radius: 6px; padding: 4px; background: var(--cy-bg); cursor: pointer; }
.cy-capture-source img { width: 120px; height: 90px; object-fit: cover; display: block; }
.cy-capture-preview img { max-width: 100%; border-radius: 6px; }
.cy-capture-preview { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
</style>
```

- [ ] **Step 4: 实现 CyToolApproval.vue（四问/对等按钮/写 Diff/焦点陷阱）**

```vue
<!-- src/renderer/src/components/CyToolApproval.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useToolStore } from '../stores/tool.store'

const toolStore = useToolStore()
const denyBtn = ref<HTMLButtonElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const current = computed(() => toolStore.liveOrder.map(id => toolStore.records[id]).find(r => r?.status === 'awaiting_permission'))
const props = defineProps<{ open: boolean }>()   // 卡片「允许此电脑操作」触发打开（非自动弹出——四问必答流，doc 03 §10）
const open = computed(() => props.open && !!current.value)
const emit = defineEmits<{ close: [] }>()
onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  if (open.value) { trigger.value = document.activeElement as HTMLElement; nextTick(() => denyBtn.value?.focus()) }
})
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) { toolStore.decide(current.value!.desktopCallId ?? current.value!.id, 'deny'); returnToTrigger() }
  if (e.key === 'Tab' && open.value) { trapTab(e) }
}
function trapTab(e: KeyboardEvent) { /* 焦点陷阱：Tab 在面板内循环（CyHistoryViewer 先例） */ }
function returnToTrigger() { trigger.value?.focus?.(); toolStore.clearApprovalLocal?.() }
function allow() { toolStore.decide(current.value!.desktopCallId ?? current.value!.id, 'allow_once'); returnToTrigger() }
function deny() { toolStore.decide(current.value!.desktopCallId ?? current.value!.id, 'deny'); returnToTrigger() }
</script>

<template>
  <div v-if="open" class="cy-approval-overlay" data-testid="tool-approval">
    <div class="cy-approval-box" role="dialog" aria-modal="true" aria-label="工具权限确认">
      <h3>允许此电脑操作？</h3>
      <dl class="cy-approval-questions">
        <dt>AI 想做什么</dt><dd>{{ current!.toolName }} — {{ current!.inputSummary }}</dd>
        <dt>操作哪个资源</dt><dd>{{ toolStore.pendingPathSummary?.pathSummary ?? current!.inputSummary }}</dd>
        <dt>为什么需要</dt><dd>{{ current!.reason ?? 'AI 请求执行此桌面操作以完成你的任务。' }}</dd>
        <dt>哪些数据会发送到后端</dt><dd>{{ toolStore.pendingDataFlowNote?.dataFlowNote ?? '请查看工具说明。' }}</dd>
      </dl>
      <div v-if="toolStore.pendingDiff?.diff" class="cy-approval-diff" data-testid="approval-diff">
        <p class="cy-diff-note">{{ toolStore.pendingDiff.diff.isNewFile ? '新建文件' : '覆盖文件' }} · {{ toolStore.pendingDiff.diff.formatNote }}
          <template v-if="toolStore.pendingDiff.diff.truncated"> · 共 {{ toolStore.pendingDiff.diff.totalLines }} 行，仅显示前 100 行</template></p>
        <pre class="cy-diff-body"><template v-for="(l, i) in toolStore.pendingDiff.diff.lines" :key="i"><span :class="'cy-diff-' + l.kind">{{ l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' ' }}{{ l.text }}</span></template></pre>
      </div>
      <div class="cy-approval-actions">
        <button ref="denyBtn" type="button" class="cy-btn" data-testid="approval-deny" @click="deny">拒绝</button>
        <button type="button" class="cy-btn cy-btn-approve" data-testid="approval-allow" @click="allow">允许一次</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cy-approval-overlay { position: fixed; inset: 0; z-index: 80; background: var(--cy-overlay, rgba(0,0,0,.45)); display: flex; align-items: center; justify-content: center; }
.cy-approval-box { background: var(--cy-bg); border-radius: 10px; padding: 16px 18px; max-width: 520px; width: min(92vw, 520px); max-height: 84vh; overflow: auto; }
.cy-approval-questions { margin: 10px 0; }
.cy-approval-questions dt { font-weight: 600; margin-top: 6px; }
.cy-approval-questions dd { margin: 2px 0 0; color: var(--cy-text-secondary); overflow-wrap: anywhere; }
.cy-approval-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.cy-btn { padding: 6px 16px; border: 1px solid var(--cy-border); border-radius: 6px; background: var(--cy-bg); cursor: pointer; }
.cy-btn-approve { border-color: var(--cy-accent, #1a66ff); color: var(--cy-accent, #1a66ff); }
.cy-diff-note { color: var(--cy-text-muted); margin: 6px 0; }
.cy-diff-body { background: var(--cy-bg-sub); padding: 6px; border-radius: 6px; max-height: 240px; overflow: auto; margin: 0; font-size: 12px; white-space: pre-wrap; }
.cy-diff-added { color: var(--cy-diff-add, #18794e); }
.cy-diff-removed { color: var(--cy-diff-del, #cd2b3a); }
</style>
```
**注**：`clearApprovalLocal` 为 toolStore 内终态清理辅助（终态事件已清 pendingPathSummary；此处防御性调用可选，task review 定）。

- [ ] **Step 5: CyLiveToolCards.vue + CyMessageBubble 归档卡片 + CyChatView 挂载 + tool 角色不渲染空气泡**

```vue
<!-- src/renderer/src/components/CyLiveToolCards.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useToolStore } from '../stores/tool.store'
import CyToolCard from './CyToolCard.vue'
import CyToolApproval from './CyToolApproval.vue'
const toolStore = useToolStore()
const approvalOpen = ref(false)
function openApproval() { approvalOpen.value = true }
function closeApproval() { approvalOpen.value = false }
</script>
<template>
  <div class="cy-live-tools" data-testid="live-tool-cards">
    <CyToolCard v-for="rec in toolStore.liveRecords()" :key="rec.id" :record="rec"
      @open-approval="openApproval"
      @cancel="toolStore.cancel(rec.desktopCallId ?? rec.id)"
      @pick="(sid) => toolStore.pickSource(rec.desktopCallId ?? rec.id, sid)"
      @confirm-upload="() => toolStore.confirmUpload(rec.desktopCallId ?? rec.id)" />
    <CyToolApproval :open="approvalOpen" @close="closeApproval" />
  </div>
</template>
<style scoped>.cy-live-tools { padding: 0 12px; }</style>
```
```typescript
// CyMessageBubble.vue 修改：
// ① assistant 分支 .cy-response-cluster 内、segments 循环之前：
//    <CyToolCard v-for="tc in message.toolCalls" :key="tc.id" :record="tc" readonly />
// ② v-else 非 user 分支加 role==='tool' 判定 → 渲染空占位（不渲染空气泡）：
//    <div v-if="message.role === 'tool'" class="cy-tool-role-placeholder" />
// ③ CyChatView.vue：CyMessageList 与 CyChatInput 之间挂 <CyLiveToolCards />（数据驱动实时区）
```

- [ ] **Step 6: bootstrap 旁路（stores 注入模式 + event 判别键）+ generation 接线 + Live2D + 探针**

```typescript
// bootstrap.ts：tool 事件旁路（live2d.directive 先例——判别键 event，代码 H5；stores 注入模式，BootstrapStores 增 tools）
//   BootstrapStores 增 tools?: { init(): void; applyBackendEvent(e: BackendEvent): void; clearForGeneration(): void }
//   事件分发（live2d 旁路之后）：
//   if (ev.event === 'tool.request' || ev.event === 'tool.started' || ev.event === 'tool.completed') {
//     deps.stores.tools?.applyBackendEvent(ev)
//     return
//   }
//   deps.stores.tools?.init() 在 bootstrap 装配处调用（voiceStore.init 先例位置）
// generation.started 接线（完整 M6）：bootstrap 内订阅 messageStore 或直接在其事件分发处：
//   if (ev.event === 'generation.started') deps.stores.tools?.clearForGeneration()
//   （若 messageStore.applyEvent 已有 generation.started 分支，改在 bootstrap 层先于 applyEvent 旁路，保持消息 store 不依赖工具框架）
// live2d/state-source.ts（getter 层增——代码 M4：getter 在 Live2dStateSourceInputs，compose 收平面布尔）：
//   Live2dStateSourceInputs 增 toolWaiting: () => boolean
//   composeCharacterState 的入参对象增 toolWaiting: boolean（error 判定后）：
//     if (inputs.toolWaiting && !inputs.isGenerating && !inputs.isSpeaking) return 'waiting_permission'
//   isTransient 集合增 'waiting_permission'
// live2d.store.ts setupStateSource：toolWaiting: () => useToolStore().waitingForApproval
// renderer/src/main.ts __cyreneTest 块增：
  getToolState: () => { const s = useToolStore(); return { records: s.records, liveOrder: s.liveOrder, waitingForApproval: s.waitingForApproval, pendingPathSummary: s.pendingPathSummary } },
  getPermissionPending: () => { const s = useToolStore(); return s.liveOrder.map(id => s.records[id]).find(r => r?.status === 'awaiting_permission') ?? null },
```

- [ ] **Step 7: 补 live2d-state-source.spec 增用例（真实断言，spec B-1）+ tool.store.spec 全绿 + typecheck**

```typescript
// live2d-state-source.spec.ts 增（以既有 spec 的输入构造先例为准）
it('toolWaiting=true 且非 generating/speaking → waiting_permission', () => {
  const s = createLive2dStateSource({ connection: () => 'connected', isGenerating: () => false, isSpeaking: () => false, emotion: () => 'happy', toolWaiting: () => true }, push)
  // compose 产物 → waiting_permission（构造以既有用例为准）
})
it('toolWaiting=true 但 isGenerating=true → 不打断（thinking/speaking 优先）', () => {
  const s = createLive2dStateSource({ connection: () => 'connected', isGenerating: () => true, isSpeaking: () => false, emotion: () => 'happy', toolWaiting: () => true }, push)
  // compose 产物不是 waiting_permission
})
it('isTransient 含 waiting_permission（终态回退靠事件驱动，无 timer）', () => { /* 状态机/瞬态集合断言 */ })
```

Run: `pnpm -F @cyrene/desktop test -- run tests/unit/tool.store.spec.ts tests/unit/live2d-state-source.spec.ts && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint`

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/tool.store.ts apps/desktop/src/renderer/src/components/CyToolCard.vue apps/desktop/src/renderer/src/components/CyToolApproval.vue apps/desktop/src/renderer/src/components/CyLiveToolCards.vue apps/desktop/src/renderer/src/components/CyMessageBubble.vue apps/desktop/src/renderer/src/components/CyChatView.vue apps/desktop/src/renderer/src/live2d/state-source.ts apps/desktop/src/renderer/src/stores/live2d.store.ts apps/desktop/src/renderer/src/bootstrap.ts apps/desktop/src/renderer/src/main.ts apps/desktop/tests/unit/tool.store.spec.ts apps/desktop/tests/unit/live2d-state-source.spec.ts
git commit -m "feat(阶段6批次B Task7): Renderer——toolStore 三来路归一化（终态单向/D6B-21 合并/侧信道/只清终态）+ CyToolCard/CyToolApproval/CyLiveToolCards（四问/对等按钮/写 Diff/焦点陷阱/capture 面板）+ 归档卡片+tool 角色不渲染空气泡 + Live2D waiting_permission 接线 + bootstrap 旁路 + __cyreneTest 探针"
```

---

### Task 8: 门禁 + 集成测试 + 文档同步 + 决策记录

**Files:**
- Create: `apps/desktop/tests/integration/electron-tools.spec.ts`
- Modify: 文档（doc 02/03/04/06/07/12/13/16 + README.md + CLAUDE.md，按 spec §5 表）
- Create: `docs/review/2026-08-20-阶段6批次B-决策记录.md`
- Test: 全门禁

**Interfaces:**
- Consumes: Task 1~7 全部；`helpers/app.ts`（launchApp + opts.env）；`__cyreneTest` 探针；`CYRENE_MOCK_TOOL_FLOW`/`CYRENE_MOCK_CAPTURE_SOURCES`/`CYRENE_MOCK_TOOL_ALLOW_ROOT`
- Produces: 集成用例（F-6-24）；决策记录；门禁基线（三态=已开发、未联调）

- [ ] **Step 1: 写集成测试（electron-tools.spec.ts，xvfb-run；fixture/env 注入，spec A-6/代码 H7-H8/M6；wire 断言经 __cyreneMainProbe，完整 M10）**

```typescript
// tests/integration/electron-tools.spec.ts（文件头纪律注释：POLL 常数/禁 force/断言走 expect.poll；真输入 getByLabel('消息输入框')，代码 M6）
import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'   // H14：readFileSync import 补齐
import { launchApp, closeApp, LaunchedApp } from './helpers/app'

const POLL = { timeout: 5000, interval: 200 }
const FIXTURE_ROOT = '/tmp/cyrene-fixtures'
const FIXTURE = `${FIXTURE_ROOT}/note.txt`
const FLOW_READ = JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: FIXTURE } } })

async function ensureFixture(content = 'hello fixture\n'): Promise<void> {
  mkdirSync(FIXTURE_ROOT, { recursive: true }); writeFileSync(FIXTURE, content)
}
afterEach(() => { rmSync(FIXTURE_ROOT, { recursive: true, force: true }) })

async function sendMessage(page: import('playwright').Page): Promise<void> {
  await page.getByLabel('消息输入框').fill('读取我的笔记')
  await page.getByLabel('消息输入框').press('Enter')
}

describe('阶段 6 批次 B 工具流', () => {
  it('桌面工具：拒绝 → 卡片「用户已拒绝」+ wire rejected（__cyreneMainProbe）', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: FLOW_READ, CYRENE_MOCK_TOOL_ALLOW_ROOT: FIXTURE_ROOT } })
    const page = launched.page
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-deny').click()    // 拒绝按钮（对等权重）
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getToolState().liveOrder.length > 0 && (window as any).__cyreneTest.getToolState().records[(window as any).__cyreneTest.getToolState().liveOrder[0]].status), POLL).toBe('rejected')
    // wire 断言：Main 探针读 MockBackend.lastToolStatus（完整 M10）
    await expect.poll(() => launched.app.evaluate(() => (globalThis as any).__cyreneMainProbe.getLastToolStatus()), POLL)
      .toEqual(expect.objectContaining({ status: 'rejected' }))
    await closeApp(launched)
  })
  it('桌面工具：允许一次 → 执行 fixture → 卡片「执行完成」+ 归档', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: FLOW_READ, CYRENE_MOCK_TOOL_ALLOW_ROOT: FIXTURE_ROOT } })
    const page = launched.page
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-approve').click()          // 卡片授权入口 → 权限窗（四问）
    await expect.poll(() => page.getByTestId('approval-deny').count(), POLL).toBe(1)
    await page.getByTestId('approval-allow').click()        // 允许一次
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getToolState().liveOrder.map(id => (window as any).__cyreneTest.getToolState().records[id].status).find(s => s === 'completed')), POLL).toBe('completed')
    await closeApp(launched)
  })
  it('取消路径：点击取消任务 → 已取消 + wire cancelled', async () => {
    await ensureFixture()
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: FLOW_READ, CYRENE_MOCK_TOOL_ALLOW_ROOT: FIXTURE_ROOT } })
    const page = launched.page
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-cancel').click()
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getToolState().liveOrder.map(id => (window as any).__cyreneTest.getToolState().records[id].status).find(s => s === 'cancelled')), POLL).toBe('cancelled')
    await expect.poll(() => launched.app.evaluate(() => (globalThis as any).__cyreneMainProbe.getLastToolStatus()), POLL)
      .toEqual(expect.objectContaining({ status: 'cancelled' }))
    await closeApp(launched)
  })
  it('写冲突 → FILE_CONFLICT → 卡片「执行失败」+ 原文件不变（spec §3.13 核心闭环，A-6）', async () => {
    await ensureFixture('v1\n')
    const flow = JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.write', arguments: { path: FIXTURE, content: 'v2\n' } } })
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: flow, CYRENE_MOCK_TOOL_ALLOW_ROOT: FIXTURE_ROOT } })
    const page = launched.page
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-approve').click()
    await expect.poll(() => page.getByTestId('approval-deny').count(), POLL).toBe(1)
    writeFileSync(FIXTURE, 'v3\n')   // 授权后、执行前外部修改（预读 hash 与原子替换前不一致）
    await page.getByTestId('approval-allow').click()
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getToolState().liveOrder.map(id => (window as any).__cyreneTest.getToolState().records[id].status).find(s => s === 'failed')), POLL).toBe('failed')
    expect(readFileSync(FIXTURE, 'utf8')).toBe('v3\n')   // 原文件不变
    await closeApp(launched)
  })
  it('Backend 工具只读卡片（无授权入口）', async () => {
    const launched = await launchApp(undefined, { env: { CYRENE_MOCK_TOOL_FLOW: JSON.stringify({ kind: 'backend', started: { toolName: 'search_web' }, completed: { success: true, outputSummary: 'ok' } }) } })
    const page = launched.page
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getToolState().records['tc_mock_backend_1']?.status), POLL).toBe('completed')
    expect(await page.getByTestId('tool-approve').count()).toBe(0)
    expect(await page.getByTestId('tool-deny').count()).toBe(0)
    await closeApp(launched)
  })
  it('capture 流程（软断言）：允许 → 源选择 → 预览 → 确认上传 → 终态（A-21/B-1）', async () => {
    const launched = await launchApp(undefined, { env: {
      CYRENE_MOCK_TOOL_FLOW: JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.screen.capture', arguments: {} } }),
      CYRENE_MOCK_CAPTURE_SOURCES: JSON.stringify([{ sourceId: 'screen:0', sourceName: '屏幕 1' }]),
    } })
    const page = launched.page
    await sendMessage(page)
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getPermissionPending()), POLL).not.toBeNull()
    await page.getByTestId('tool-approve').click()
    await page.getByTestId('approval-allow').click()
    await expect.poll(() => page.getByTestId('capture-source').count(), POLL).toBe(1)
    await page.getByTestId('capture-source').click()
    await expect.poll(() => page.getByTestId('capture-confirm').count(), POLL).toBe(1)
    await page.getByTestId('capture-confirm').click()
    await expect.poll(() => page.evaluate(() => (window as any).__cyreneTest.getToolState().liveOrder.map(id => (window as any).__cyreneTest.getToolState().records[id].status).find(s => s === 'completed')), POLL).toBe('completed')
    await closeApp(launched)
  })
})
```
**纪律**：核心闭环（拒绝/允许/取消/写冲突/backend 只读）不做降级（spec R1）；capture 用例软断言（SwiftShader 不稳 → 跳过并记录取舍，spec §3.13 降级条款）；`launchApp` 返回 `{ app, page, userData }`——页面用 `launched.page`、关闭用 `closeApp(launched)`（代码 H7）；`getByLabel('消息输入框')` 对齐 electron-voice 先例（代码 M6）。

- [ ] **Step 2: 跑全门禁**

```bash
pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop test && xvfb-run -a pnpm -F @cyrene/desktop test:integration && pnpm -F @cyrene/desktop build && pnpm -F @cyrene/desktop check:contract
```
期望：单测基线 1639 + 新增（~30+）；集成 98 + electron-tools 新增；check:contract WS 32/32 + 8 warn + REST 15/15（**manifest 不刷新**——raw wire 未变；若实现期意外改了 raw schemas → 先跑 `refresh-wire-manifests.mjs` 再复跑）。

- [ ] **Step 3: 文档同步（spec §5 表逐项）**

- doc 02：§10 领域模型补 `PublicToolEvent` + desktop Main 生命周期；§17 事件表补 tool.status 发送方
- doc 03：§9/§10 卡片双区渲染 + 权限窗落地注记
- doc 04：§2/§6（§6.3 形状对齐）/§7.4 决策链 + F-06/F-07 拍板值/§8 四工具落地（§8.1 句柄→selected-set 注记）/§11 按 D6-08 改写/§13/§14
- doc 06：§3.5 toolStore 落地
- doc 07：§9/§10 落地注记
- doc 12：F-06/07/09/10 拍板关闭（**F-08 保持 `[ ]`**）+ §9.7 批次 B 状态
- doc 16：F-6-07~18/22/24 落地 + changelog
- doc 13：交叉 review 结论
- README/CLAUDE.md：阶段 6 批次 B 状态与计数（三态=已开发、未联调）

- [ ] **Step 4: 写决策记录（docs/review/2026-08-20-阶段6批次B-决策记录.md）**

结构对齐批次 A：§1 批次边界（D6B-01）/§2 预检拍板四项落点（F-06/07/09/10）+ 推荐定案两项（D-§7-4/§7-5）/§3 决策表（D6B-01~22 摘要）/§4 执行期 Rulings（执行偏离逐条）/§5 review 修复记录（契约 H1/M1~M4/L1~L6、一致 A1~A3/B1~B13/L 系列、安全 H-1~H-3/M-1~M-8/L-1~L-7、规范 M1/M2/L1~L5，两轮）/§6 门禁结果（计数实跑）/§7 已知限制与承接（/tmp allowlist 方案、F-08 状态、跨页配对批次裁定、残余风险 M-8 批次 C 评估）/§8 批次验收结论（Task 8 后验收 subagent 填）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/integration/electron-tools.spec.ts docs/02-*.md docs/03-*.md docs/04-*.md docs/06-*.md docs/07-*.md docs/12-*.md docs/13-*.md docs/16-*.md README.md CLAUDE.md docs/review/2026-08-20-阶段6批次B-决策记录.md
git commit -m "feat(阶段6批次B Task8): 门禁收口 + 集成测试 electron-tools（F-6-24：拒绝/允许/取消/backend 只读/capture 软断言）+ 文档同步（doc02/03/04/06/07/12/13/16 + README/CLAUDE）+ 决策记录（D6B-01~22 + Rulings + review 修复记录，三态=已开发、未联调）"
```

- [ ] **Step 6: 批次最终 review 检查项（完整 L4）**

对照 spec §8 验收清单逐项核验（代码位置 + 门禁实跑复现）——由批次最终 review（goal 步骤 8）执行；检查项：① 决策链全分支可测；② 四执行器安全属性（黑名单/原子写/冲突/截图两步）有测试证据；③ IPC 六通道 zod 双端 + 探针就绪；④ 文档同步与决策记录齐备；⑤ 三态=已开发、未联调。

- [ ] **Step 7: 批次最终 review 后补验收结论 commit（验收 subagent 填充决策记录 §8）**

```bash
git commit -am "docs(阶段6批次B): 决策记录补 §8 批次验收结论——验收通过（三态=已开发、未联调）"
```
