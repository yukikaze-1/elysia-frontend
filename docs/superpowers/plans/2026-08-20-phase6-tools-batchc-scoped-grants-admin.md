# 阶段 6 批次 C（allow_scoped 目录授权 + 设置页授权管理 + 复核项收口）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop P0 四工具的 read/write 新增「允许指定目录」目录授权（有效期 + 撤销 + 后端身份绑定，settings.json tools 子树持久化），决策链 step 8 前置 grant 匹配自动执行；设置页「安全与权限」子页落地（授权管理 + 完整审批历史查看器 + 命令模板空态 F-08 关闭）；L-1~L-8 批次 B 复核项收口 + M-1/M3 确认/否决；GET tools/calls real 实现 + mock 降级；门禁全绿；三态仍 = 已开发、未联调。

**Architecture:** GrantStore（Main 侧 grant 仓库，settings.tools.grants 读写 + grant:* 审计）注入 tool-service 决策链 step 8（grant 匹配 → auto 无窗）；「允许指定目录」创建流经 IPC `tool:grant-directory` → Main 目录选择器 → grant 落盘 → 当前请求自动执行；`tool-history.ts` 回读 audit JSONL 供设置页审批历史；四 IPC 通道全 zod 双端 + isTrustedSender。

**Tech Stack:** Electron + Vue 3 + TypeScript + Vite + vitest + zod ^4.0.0 + jsdiff（既有）+ crypto.randomUUID。

**Spec:** `docs/superpowers/specs/2026-08-20-phase6-tools-batchc-scoped-grants-admin-design.md`（binding，2 轮 review 通过；计划从 spec 出发，冲突以 spec 为准）

## Global Constraints

- 三态纪律：本批为 mock 驱动代码批，**三态 = 已开发、未联调**（真实 Windows Electron 联调归开发者批次后）；一切文档不得标「已完成/已真实联调」。
- docs 全部中文；文档同步按 spec §5 表执行；本批不改 raw wire → `rawSchemasFingerprint()` 不变 → manifest 不刷新；REST 段 15→16（`DesktopCallStatus` 入 `REST_TARGET_MODELS`）。
- 安全硬约束（spec §4）：黑名单永远压过 grant（step 5 先拒不触 step 8）；`expiresAt` 必填且 ttl 白名单（`GRANT_TTL_OPTIONS_MS as const`，schema union + Main 双校验）；grant 绑定后端身份（`new URL(serverUrl).origin`）；目录段边界匹配；grant:created 审计 summary 不含目录绝对路径；写 grant 命中只读 Diff 无确认按钮。
- 代码纪律（spec R12/R14）：grantDirectory 入口 `if (!deps.grants) throw`；`run` 后 `promoteQueue` 恒执行（try/finally）；revoke 未知 id → `GRANT_NOT_FOUND`（handler 先查存在性）、已撤销 → no-op 幂等成功。
- 环境：pnpm 命令前 `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.23.0`（Node 22.23.0，engines `>=22.23.0 <23`）；集成测试 `xvfb-run -a pnpm -F @cyrene/desktop test:integration`。
- 永不 push（开发者手动）；不做 `desktop.command.run` 注册；capture 恒强确认无 grant 面；select 已 automatic 无 grant 面。
- 验收清单（spec §8）：settings.tools 子树 / GrantStore / 决策链 step 8 / CySecurityPane + IPC 四通道 / L-1~L-8 + TOCTOU 守卫 / M-1 确认 M-3 否决 / GET tools/calls + reconnect / 门禁全绿 / 文档同步 + 决策记录 / 三态。

---

### Task 1: 契约层——PermissionGrant + settings.tools 子树

**Files:**
- Modify: `apps/desktop/src/shared/contracts/tool.ts`（增 PermissionGrant/ToolsSettings/GRANT_TTL_OPTIONS_MS/GRANT_DEFAULT_TTL_MS）
- Modify: `apps/desktop/src/shared/contracts/voice.ts`（SettingsState 增 tools、SettingsPatch 增 tools?）
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`（PermissionGrantSchema/ToolsSettingsSchema/ToolsSettingsPatchSchema/SettingsStateSchema/SettingsPatchSchema/DEFAULT_TOOLS/DEFAULT_SETTINGS）
- Modify: `apps/desktop/src/main/settings/settings-service.ts`（save merge 增 tools）
- Create: `apps/desktop/tests/unit/settings-tools.spec.ts`

**Interfaces:**
- Consumes: 无（最底层）。
- Produces: `PermissionGrant { id; toolName: 'desktop.file.read'|'desktop.file.write'; scope: { directory: string }; backendIdentity: string; expiresAt: number; createdAt: string; source: 'directory'; revokeSource?: 'user'|'expired'; revokedAt?: string }`；`ToolsSettings { grants: PermissionGrant[] }`；`GRANT_TTL_OPTIONS_MS = [3600_000, 86_400_000, 604_800_000, 2_592_000_000] as const`；`GRANT_DEFAULT_TTL_MS = 86_400_000`；`PermissionGrantSchema`/`ToolsSettingsSchema`（default `{grants:[]}`）/`ToolsSettingsPatchSchema`（无 default）/`DEFAULT_TOOLS`。Task 2/6/7 依赖。

- [ ] **Step 1: 写失败测试 `settings-tools.spec.ts`**

```typescript
// tests/unit/settings-tools.spec.ts（node；纯 schema/类型层 + SettingsService save merge）
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStateSchema, SettingsPatchSchema, ToolsSettingsSchema, ToolsSettingsPatchSchema, PermissionGrantSchema, DEFAULT_SETTINGS, DEFAULT_TOOLS } from '../../src/shared/schemas/ipc-response'
import type { SettingsState, SettingsPatch } from '../../src/shared/contracts/voice'
import type { PermissionGrant, ToolsSettings } from '../../src/shared/contracts/tool'
import { SettingsService } from '../../src/main/settings/settings-service'

const GRANT: PermissionGrant = {
  id: 'grant-abc', toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' },
  backendIdentity: 'http://localhost:8000', expiresAt: 1_750_000_000_000, createdAt: '2026-08-20T00:00:00.000Z',
  source: 'directory',
}

describe('ToolsSettingsSchema', () => {
  it('default：无 tools 字段 → 空 grants（旧文件兼容，version 1 不触发损坏）', () => {
    // 全量合法旧文件形状（voice 五必填 + dictation.insertMode——F-1 修复：缺字段 parse 恒失败）
    const parsed = SettingsStateSchema.parse({ ...DEFAULT_SETTINGS })
    expect(parsed.tools).toEqual({ grants: [] })
    const legacy = SettingsStateSchema.parse({ ...DEFAULT_SETTINGS, tools: undefined } as never)   // 显式无 tools（default 兜底）
    expect(legacy.tools).toEqual({ grants: [] })
  })
  it('grant 形状 strict：未知字段拒、toolName 二值、revokeSource 二值可选', () => {
    expect(PermissionGrantSchema.safeParse(GRANT).success).toBe(true)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, toolName: 'desktop.screen.capture' }).success).toBe(false)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, revokeSource: 'user', revokedAt: '2026-08-20T01:00:00.000Z' }).success).toBe(true)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, extra: 1 }).success).toBe(false)
    expect(PermissionGrantSchema.safeParse({ ...GRANT, backendIdentity: undefined }).success).toBe(false)   // backendIdentity 必填
  })
})
describe('SettingsPatchSchema', () => {
  it('tools patch 无默认：单字段 patch 不注入默认 grants（IP-1）', () => {
    const patch: SettingsPatch = { voice: { enabled: false } }
    const parsed = SettingsPatchSchema.parse(patch)
    expect(parsed.voice).toEqual({ enabled: false })
    expect(parsed.tools).toBeUndefined()
  })
  it('tools patch 接受完整 grants 替换', () => {
    const parsed = SettingsPatchSchema.parse({ tools: { grants: [GRANT] } })
    expect(parsed.tools?.grants).toHaveLength(1)
  })
  it('ToolsSettingsPatchSchema 无 default（zod4 下 .default().partial() 不存在，必须独立 schema）', () => {
    expect(ToolsSettingsSchema.parse({}).grants).toEqual([])        // 顶层有 default
    expect(ToolsSettingsPatchSchema.safeParse({}).success).toBe(true)  // patch 无 default 也接受空对象
  })
})
describe('DEFAULT_SETTINGS', () => {
  it('含 tools 空子树 + version 1', () => {
    expect(DEFAULT_SETTINGS.tools).toEqual({ grants: [] })
    expect(DEFAULT_SETTINGS.version).toBe(1)
  })
  it('类型层：SettingsState 含 tools、SettingsPatch 含 tools?（编译期）', () => {
    const s: SettingsState = DEFAULT_SETTINGS
    expect(s.tools.grants).toEqual([])
  })
})
describe('SettingsService.save tools merge（spec §3.8——不丢 voice/live2d）', () => {
  it('voice patch 不丢 tools；tools patch 不丢 voice/live2d/dictation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-settings-tools-'))
    try {
      const svc = new SettingsService({ dir, safeRoot: dir, logger: { warn: vi.fn() } as never })
      const tools: ToolsSettings = { grants: [GRANT] }
      const s1 = await svc.save({ tools })
      expect(s1.tools).toEqual(tools)
      expect(s1.voice).toEqual(DEFAULT_SETTINGS.voice)   // tools patch 不污染 voice
      const s2 = await svc.save({ voice: { enabled: false } })
      expect(s2.tools).toEqual(tools)                    // voice patch 不丢 tools
      expect(s2.voice.enabled).toBe(false)
      const s3 = await svc.save({})
      expect(s3.tools).toEqual(tools)                    // 空 patch 保持现值
      // 落盘内容：新实例重载保留 tools（原子写 + load 对称）
      const svc2 = new SettingsService({ dir, safeRoot: dir, logger: { warn: vi.fn() } as never })
      expect((await svc2.load()).tools).toEqual(tools)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- settings-tools`
Expected: FAIL——`Cannot find module '../../src/shared/schemas/ipc-response'` 的 tools 字段/Schema 不存在、`SettingsState` 无 tools 属性（typecheck 也报）。

- [ ] **Step 3: 实现契约层**

`apps/desktop/src/shared/contracts/tool.ts` 追加：

```typescript
/** 阶段 6 批次 C（D6C-03）：目录授权 grant（settings.tools.grants 持久化）。 */
export interface PermissionGrant {
  id: string                    // 'grant-' + crypto.randomUUID()（无状态跨重启唯一，不需持久化计数器）
  toolName: 'desktop.file.read' | 'desktop.file.write'
  scope: { directory: string }  // realpath 规范化目录（匹配基准）
  backendIdentity: string       // 授权时连接指纹 = new URL(serverUrl).origin（F-2：切换端点不再匹配）
  expiresAt: number             // epoch ms
  createdAt: string             // ISO
  source: 'directory'
  revokeSource?: 'user' | 'expired'
  revokedAt?: string            // 置位后不再匹配（灰显保留）
}
export interface ToolsSettings { grants: PermissionGrant[] }
/** TTL 白名单（1h/24h/7d/30d，校验权威 Main；schema union + tool-service 双校验，F-3/F-18） */
export const GRANT_TTL_OPTIONS_MS = [3600_000, 86_400_000, 604_800_000, 2_592_000_000] as const
export type GrantTtlMs = (typeof GRANT_TTL_OPTIONS_MS)[number]
/** 默认 24h（仅供 UI 默认选中；Main 不接受缺省 ttlMs） */
export const GRANT_DEFAULT_TTL_MS: GrantTtlMs = 86_400_000
```

`apps/desktop/src/shared/contracts/voice.ts`（import 行 + 类型）：

```typescript
import type { Live2DSettings } from './live2d'
import type { ToolsSettings } from './tool'   // 新增
// ...
export interface SettingsState {
  version: 1
  voice: VoiceSettings
  dictation: DictationSettings
  live2d: Live2DSettings
  tools: ToolsSettings   // 阶段 6 批次 C（D6C-02）：目录授权子树
}
export type SettingsPatch = Partial<{ voice: Partial<VoiceSettings>; dictation: Partial<DictationSettings>; live2d: Partial<Live2DSettings>; tools: Partial<ToolsSettings> }>
```

`apps/desktop/src/shared/schemas/ipc-response.ts`（放在 Live2D settings 块之后、DEFAULT_LIVE2D 之前；**片段均带 `export`——F-14 修复**）：

```typescript
// —— 阶段 6 批次 C：目录授权 grant 子树（D6C-02/03）——
// 子 schema 不注 z.ZodType（保留 .default()/可选形状，ipc-response.ts:248-249 纪律）。
// PermissionGrantSchema 内层 .strict()：单条畸形 → 整文件 settings corrupt 重建（与 voice/live2d 同款风险，
// 装载期逐条校验剔除——spec §3.2 N-8）。
export const PermissionGrantSchema = z.object({
  id: z.string().min(1),
  toolName: z.enum(['desktop.file.read', 'desktop.file.write']),
  scope: z.object({ directory: z.string().min(1) }).strict(),
  backendIdentity: z.string().min(1),
  expiresAt: z.number().int().positive(),
  createdAt: z.string().min(1),
  source: z.literal('directory'),
  revokeSource: z.enum(['user', 'expired']).optional(),
  revokedAt: z.string().optional(),
}).strict()
export const ToolsSettingsSchema = z.object({ grants: z.array(PermissionGrantSchema) }).default({ grants: [] })
// IP-1：patch 子 schema 无 default（zod 4 中 .default() 包装后无 .partial() 方法，必须独立新建）
export const ToolsSettingsPatchSchema = z.object({ grants: z.array(PermissionGrantSchema).optional() })
export const DEFAULT_TOOLS: ToolsSettings = { grants: [] }
```

`SettingsStateSchema` 增 `tools: ToolsSettingsSchema`；`SettingsPatchSchema` 增 `tools: ToolsSettingsPatchSchema.optional()`；`DEFAULT_SETTINGS` 增 `tools: DEFAULT_TOOLS`。需在文件顶部 import 区补 `import type { ToolsSettings } from '../contracts/tool'`（查现有 import 风格对齐）。

`apps/desktop/src/main/settings/settings-service.ts` 的 `save()` merge 表达式：

```typescript
const next: SettingsState = {
  ...this.state,
  ...patch,
  voice: { ...this.state.voice, ...patch.voice },
  dictation: { ...this.state.dictation, ...patch.dictation },
  live2d: { ...this.state.live2d, ...patch.live2d },
  tools: { ...this.state.tools, ...patch.tools }   // 阶段 6 批次 C：tools 子树 merge（对齐 live2d 既有模式）
}
```

- [ ] **Step 4: 运行验证通过**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- settings-tools && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（新增 spec 全绿 + typecheck 0 错——settings-service.spec 既有用例需保持全绿：save 不带 tools patch 时 merge 不破坏既有子树）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/contracts/tool.ts apps/desktop/src/shared/contracts/voice.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/main/settings/settings-service.ts apps/desktop/tests/unit/settings-tools.spec.ts
git commit -m "feat(阶段6批次C Task1): 契约层——PermissionGrant/ToolsSettings + GRANT_TTL_OPTIONS_MS + SettingsState.tools 子树（version 1 向后兼容 + ToolsSettingsPatchSchema 无默认 IP-1 + save merge）"
```

---

### Task 2: GrantStore + tool-history（Main 新模块）

**Files:**
- Create: `apps/desktop/src/main/tools/grant-store.ts`
- Create: `apps/desktop/src/main/tools/tool-history.ts`
- Create: `apps/desktop/tests/unit/grant-store.spec.ts`
- Create: `apps/desktop/tests/unit/tool-history.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `PermissionGrant`/`ToolsSettings`；`SettingsService`（`main/settings/settings-service.ts` 的 `load()`/`save(patch)`）；`AuditEvent`（`main/diagnostics/audit.ts`）；`isPathBlacklisted`/`normalizeToolPath`（`main/tools/tool-policy.ts`）。
- Produces: `createGrantStore(deps)` → `{ list, add, revoke, matches, prune }`；`readAuditEvents(dir, opts)`（Task 6 handler 用）。

- [ ] **Step 1: 写失败测试 `grant-store.spec.ts`**

```typescript
// tests/unit/grant-store.spec.ts（node；settings mock + 注入 now/normalizeDirectory/isBlacklisted/backendIdentity）
// F-4 修复：mkSettings.load 用「同步可读 thenable」——createGrantStore 构造期 eager load 同步填充缓存，
// 测试无需 await（与 tool-service step 8 的同步 matches 用法一致）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGrantStore } from '../../src/main/tools/grant-store'
import type { PermissionGrant, ToolsSettings } from '../../src/shared/contracts/tool'
import type { SettingsService } from '../../src/main/settings/settings-service'

/** 同步可读 thenable：then 回调立即执行（微任务=同步语义），createGrantStore 构造期缓存即刻填充（F-4） */
function syncResolve<T>(value: T): Promise<T> {
  return { then: (cb: (v: T) => unknown) => { cb(value); return Promise.resolve() } } as unknown as Promise<T>
}
function mkSettings(grants: PermissionGrant[] = []): SettingsService {
  const state = { version: 1 as const, voice: {}, dictation: {}, live2d: {}, tools: { grants } } as never
  return { load: vi.fn(() => syncResolve(state)), save: vi.fn(async () => state) } as unknown as SettingsService
}
let now = 1_750_000_000_000
function mkStore(grants: PermissionGrant[] = [], identity: string | undefined = 'http://localhost:8000', platform: 'posix' | 'windows' = 'posix') {
  const audit = vi.fn()
  const warn = vi.fn()   // V-16 修复：warn 提升至 mkStore 顶部（settings 无 logger——原夹具从 settings 取 undefined 必炸）
  const settings = mkSettings(grants)
  const store = createGrantStore({
    settings,
    audit,
    normalizeDirectory: (raw) => raw.replace(/\/+$/, ''),   // 测试注入：去尾斜杠即「规范化」
    isBlacklisted: (real) => real.startsWith('/etc') || real.startsWith('/tmp'),
    backendIdentity: () => identity,
    now: () => now,
    platform,   // V-20 修复：matches 按平台门控比较（posix 直比 / win32 toLowerCase）
    logger: { warn },
  })
  return { store, audit, settings, warn }
}
function grant(over: Partial<PermissionGrant> = {}): PermissionGrant {
  return { id: 'grant-a', toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' },
    backendIdentity: 'http://localhost:8000', expiresAt: now + 86_400_000, createdAt: '2026-08-20T00:00:00.000Z',
    source: 'directory', ...over }
}

describe('grant-store', () => {
  beforeEach(() => { now = 1_750_000_000_000 })
  it('add：id 生成（grant- 前缀）+ createdAt + 审计 grant:created（summary 不含目录路径但含 backendIdentity）', () => {
    const { store, audit, settings } = mkStore()
    const g = store.add({ toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' }, backendIdentity: 'http://localhost:8000', expiresAt: now + 1000, source: 'directory' })
    expect(g.id.startsWith('grant-')).toBe(true)
    expect(g.createdAt).toBeTruthy()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'grant:created', permissionGrantId: g.id, backendIdentity: 'http://localhost:8000',
      summary: expect.stringContaining('目录授权（工具 desktop.file.read，有效期至') as never,
    }))
    expect(audit.mock.calls[0][0].summary).not.toContain('/home/u')   // F-5：无目录路径
    expect(settings.save).toHaveBeenCalledWith({ tools: { grants: [g] } })   // 全量 tools 子树提交
  })
  it('add 幂等（N-6）：同 toolName+目录+身份+未撤销未过期 → 返回既有不重复创建', () => {
    const existing = grant()
    const { store, settings } = mkStore([existing])
    const g = store.add({ toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' }, backendIdentity: 'http://localhost:8000', expiresAt: now + 1000, source: 'directory' })
    expect(g.id).toBe('grant-a')
    expect(settings.save).not.toHaveBeenCalled()
  })
  it('add 黑名单复核：/etc 目录 → PATH_BLOCKLISTED（用户无法授权黑名单）', () => {
    const { store } = mkStore()
    expect(() => store.add({ toolName: 'desktop.file.read', scope: { directory: '/etc' }, backendIdentity: 'x', expiresAt: now + 1000, source: 'directory' }))
      .toThrowError(expect.objectContaining({ code: 'PATH_BLOCKLISTED' }))
  })
  it('add 存储归一化（V-1）：raw 带尾斜杠 → 存储去尾斜杠值，matches 命中', () => {
    const { store } = mkStore()
    const g = store.add({ toolName: 'desktop.file.read', scope: { directory: '/home/u/docs/' }, backendIdentity: 'http://localhost:8000', expiresAt: now + 1000, source: 'directory' })
    expect(g.scope.directory).toBe('/home/u/docs')
    expect(store.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeDefined()
  })
  it('V-1 补充：symlink 目录归一化（注入 normalizeDirectory 模拟 realpath 解链）', () => {
    // 测试注入的 normalizeDirectory 语义 = realpath 规范化——symlink 由注入函数解链（真实实现 normalizeToolPath 全链 realpath）
    const audit = vi.fn()
    const settings = mkSettings()
    const store = createGrantStore({ settings, audit,
      normalizeDirectory: (raw) => raw.startsWith('/link/') ? raw.replace('/link/', '/real/') : raw.replace(/\/+$/, ''),
      isBlacklisted: () => false, backendIdentity: () => 'http://h', now: () => now, logger: { warn: vi.fn() } })
    const g = store.add({ toolName: 'desktop.file.read', scope: { directory: '/link/docs' }, backendIdentity: 'http://h', expiresAt: now + 1000, source: 'directory' })
    expect(g.scope.directory).toBe('/real/docs')
    expect(store.matches('desktop.file.read', '/real/docs/a.txt')).toBeDefined()
    expect(store.matches('desktop.file.read', '/link/docs/a.txt')).toBeUndefined()   // 请求侧 realpath 已解链 → 与存储归一化值比较
  })
  it('matches：目录段边界（等于/子目录命中；/docs2 不误配）+ 工具匹配 + 身份匹配', () => {
    const { store } = mkStore([grant()])
    expect(store.matches('desktop.file.read', '/home/u/docs')).toBeDefined()
    expect(store.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeDefined()
    expect(store.matches('desktop.file.read', '/home/u/docs2/a.txt')).toBeUndefined()
    expect(store.matches('desktop.file.write', '/home/u/docs/a.txt')).toBeUndefined()
  })
  it('matches：Windows 大小写不敏感（F-13/V-20——平台门控：win32 toLowerCase、posix 直比）', () => {
    // V-20 修复：不再恒 toLowerCase（posix 上大小写不同的真实目录不得互相命中）——matches 按 deps.platform 选择比较器
    const win = mkStore([], 'http://h', 'windows')
    win.store.add({ toolName: 'desktop.file.read', scope: { directory: '/HOME/U/DOCS' }, backendIdentity: 'http://h', expiresAt: now + 1000, source: 'directory' })
    expect(win.store.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeDefined()   // win32 大小写不敏感命中
    expect(win.store.matches('desktop.file.read', '/home/u/DOCS2/a.txt')).toBeUndefined()
    const posix = mkStore([], 'http://h', 'posix')
    posix.store.add({ toolName: 'desktop.file.read', scope: { directory: '/HOME/U/DOCS' }, backendIdentity: 'http://h', expiresAt: now + 1000, source: 'directory' })
    expect(posix.store.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeUndefined()   // posix 大小写敏感：不命中（防授权面越界）
    expect(posix.store.matches('desktop.file.read', '/HOME/U/DOCS/a.txt')).toBeDefined()
  })
  it('matches：后端身份（F-2）——身份变更不匹配 / backendIdentity() undefined 不匹配 / 同 origin 不同路径后缀仍匹配（V-13 正方向）', () => {
    const { store } = mkStore([grant()], 'http://localhost:8000')
    expect(store.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeDefined()
    const other = mkStore([grant()], 'http://other:9000').store
    expect(other.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeUndefined()
    const none = mkStore([grant()], undefined).store
    expect(none.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeUndefined()
    // 注：grant.backendIdentity 存的是授权时 origin 指纹；同 origin 不同路径后缀 → 身份相等 → 仍匹配（F-11 正方向）
    // （身份比较是字符串相等，origin 归一在装配层 new URL(serverUrl).origin 完成——本测试断言「同指纹 + 目录命中 → 匹配」）
    const same = mkStore([{ ...grant(), backendIdentity: 'http://localhost:8000' }], 'http://localhost:8000').store
    expect(same.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeDefined()
  })
  it('matches：撤销/过期不匹配 + 惰性 prune 审计 grant:expired（F-9）', () => {
    const { store, audit } = mkStore([grant({ id: 'grant-exp' })])
    now += 86_400_001   // 过期
    expect(store.matches('desktop.file.read', '/home/u/docs/a.txt')).toBeUndefined()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'grant:expired', permissionGrantId: 'grant-exp' }))
    expect(store.list().find((g) => g.id === 'grant-exp')).toMatchObject({ revokedAt: expect.any(String), revokeSource: 'expired' })
  })
  it('revoke（N-5/F-9）：未过期 → user 分支；已过期 → expired 分支；已撤销 → no-op 不覆写不重复审计', () => {
    const { store, audit } = mkStore([grant()])
    const r1 = store.revoke('grant-a')
    expect(r1).toMatchObject({ revokeSource: 'user', revokedAt: expect.any(String) })
    const r2 = store.revoke('grant-a')
    expect(r2).toBeUndefined()   // 已撤销 no-op
    expect(audit).toHaveBeenCalledTimes(1)   // 仅 grant:revoked 一次
    const exp = mkStore([grant({ id: 'grant-e2' })])
    now += 86_400_001
    const r3 = exp.store.revoke('grant-e2')
    expect(r3).toMatchObject({ revokeSource: 'expired' })
    expect(exp.audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'grant:expired' }))
  })
  it('list：prune 后返回全量（活动 + 灰显）', () => {
    const { store } = mkStore([grant(), grant({ id: 'grant-b', revokedAt: 'x', revokeSource: 'user' })])
    expect(store.list().map((g) => g.id)).toEqual(['grant-a', 'grant-b'])
  })
  it('N-8 装载期逐条校验：畸形 grant（expiresAt NaN / directory 空 / toolName 非法）静默剔除 + 日志', () => {
    const bad1 = grant({ id: 'g-bad1', expiresAt: Number.NaN })
    const bad2 = grant({ id: 'g-bad2', scope: { directory: '' } })
    const bad3 = grant({ id: 'g-bad3', toolName: 'desktop.screen.capture' as never })
    const { store, warn } = mkStore([bad1, bad2, bad3, grant({ id: 'g-ok' })])
    expect(store.list().map((g) => g.id)).toEqual(['g-ok'])   // 畸形剔除、合法保留
    expect(warn).toHaveBeenCalled()   // settings:grant-invalid 日志（logger.warn 至少一次）
  })
  it('save fail-open：落盘失败不阻塞操作（add 内存生效 + 审计已发 + 不抛）', () => {
    const audit = vi.fn()
    const settings = mkSettings()
    ;(settings.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    const store = createGrantStore({ settings, audit, normalizeDirectory: (r) => r.replace(/\/+$/, ''),
      isBlacklisted: () => false, backendIdentity: () => 'http://h', now: () => now, logger: { warn: vi.fn() } })
    expect(() => store.add({ toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' }, backendIdentity: 'http://h', expiresAt: now + 1000, source: 'directory' })).not.toThrow()
    expect(store.list()).toHaveLength(1)   // 内存生效
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'grant:created' }))   // 审计已发
  })
})
```

`tool-history.spec.ts`：

```typescript
// tests/unit/tool-history.spec.ts（node；mkdtemp 写假 audit JSONL）
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAuditEvents, HISTORY_DAYS, HISTORY_MAX } from '../../src/main/tools/tool-history'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cy-hist-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('tool-history', () => {
  it('HISTORY_DAYS=7 / HISTORY_MAX=200 常量存在', () => {
    expect(HISTORY_DAYS).toBe(7); expect(HISTORY_MAX).toBe(200)
  })
  it('回读：readdir 倒序 + 过滤 tool:*+grant:* + ts 倒序 + limit', () => {
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), [
      JSON.stringify({ ts: '2026-08-20T10:00:00Z', type: 'tool:decision', callId: 'c1' }),
      JSON.stringify({ ts: '2026-08-20T11:00:00Z', type: 'chat:send', summary: 'x' }),   // 非 tool/grant 过滤
      JSON.stringify({ ts: '2026-08-20T12:00:00Z', type: 'grant:created', permissionGrantId: 'g1' }),
    ].join('\n'))
    writeFileSync(join(dir, 'audit-2026-08-19.jsonl'), JSON.stringify({ ts: '2026-08-19T10:00:00Z', type: 'tool:terminal', status: 'completed' }) + '\n')
    const rows = readAuditEvents(dir, { limit: 10 })
    expect(rows.map((r) => r.ts)).toEqual(['2026-08-20T12:00:00Z', '2026-08-20T10:00:00Z', '2026-08-19T10:00:00Z'])   // ts 倒序 + 过滤
    expect(rows.map((r) => r.type)).toEqual(['grant:created', 'tool:decision', 'tool:terminal'])
  })
  it('HISTORY_DAYS 边界：超 7 天文件不读', () => {
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), JSON.stringify({ ts: '2026-08-20T10:00:00Z', type: 'tool:decision' }) + '\n')
    writeFileSync(join(dir, 'audit-2026-08-12.jsonl'), JSON.stringify({ ts: '2026-08-12T10:00:00Z', type: 'tool:decision' }) + '\n')   // 8 天前
    const rows = readAuditEvents(dir, { limit: 10 })
    expect(rows).toHaveLength(1)
  })
  it('HISTORY_MAX 合并总量上限 + 损坏行跳过不崩溃', () => {
    const lines: string[] = []
    for (let i = 0; i < 250; i++) lines.push(JSON.stringify({ ts: `2026-08-20T${String(i).padStart(2, '0')}:00:00Z`, type: 'tool:decision' }))
    lines.splice(100, 0, '{broken json')
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), lines.join('\n'))
    const rows = readAuditEvents(dir, { limit: 500 })
    expect(rows).toHaveLength(HISTORY_MAX)
  })
  it('逐文件流式读满即停：大文件 + 小 limit', () => {
    writeFileSync(join(dir, 'audit-2026-08-20.jsonl'), Array.from({ length: 500 }, (_, i) => JSON.stringify({ ts: `2026-08-20T00:${String(i % 60).padStart(2, '0')}:00Z`, type: 'tool:decision' })).join('\n'))
    const rows = readAuditEvents(dir, { limit: 30 })
    expect(rows).toHaveLength(30)
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- grant-store tool-history`
Expected: FAIL——`Cannot find module '../../src/main/tools/grant-store'`。

- [ ] **Step 3: 实现 grant-store.ts（F-3：完整实现，非 stub）**

```typescript
// src/main/tools/grant-store.ts
// 阶段 6 批次 C（D6C-03/05/06）：目录授权 grant 仓库——settings.tools.grants 读写 + grant:* 审计 + 黑名单复核。
// 纪律：add/revoke/prune 改动后 settings.save({ tools: { grants } })（全量 tools 子树，patch merge 不 clobber voice/live2d）；
// save 失败 fail-open（内存生效 + 审计 + 日志）；grant:* 事件经 deps.audit 直调（不进 auditToolEvent——ToolAuditInput.type 闭合 5 值 union）。
// 构造时序（F-4）：createGrantStore 立即 void deps.settings.load().then(快照填充)——构造期同步填充缓存
// （生产装配 settingsSvc.load() 先于 createGrantStore；单测 load 为同步可读 thenable）。
import { randomUUID } from 'node:crypto'
import type { SettingsService } from '../settings/settings-service'
import type { AuditEvent } from '../diagnostics/audit'
import type { PermissionGrant } from '@shared/contracts/tool'
import { ToolServiceError } from './tool-service'

export interface GrantStoreDeps {
  settings: SettingsService
  audit: (ev: AuditEvent) => void
  normalizeDirectory: (raw: string) => string   // realpath 规范化（黑名单复核前调用，抛 PATH_UNSAFE）
  isBlacklisted: (real: string) => boolean      // 黑名单复核闭包（F-3：调用方放宽形态 isPathBlacklisted + allowRoots）
  backendIdentity: () => string | undefined     // 当前连接指纹（F-2：serverUrl origin；断连 undefined → 不匹配）
  platform?: 'posix' | 'windows'                // V-20：matches 比较平台门控（posix 直比 / win32 toLowerCase——对齐 tool-policy 先例；缺省 posix）
  now?: () => number                            // 注入（测试）
  logger?: { warn(msg: string, extra?: Record<string, unknown>): void }
}
export interface GrantStore {
  list(): PermissionGrant[]
  add(g: Omit<PermissionGrant, 'id' | 'createdAt'>): PermissionGrant
  revoke(id: string): PermissionGrant | undefined
  matches(toolName: string, realPath: string): PermissionGrant | undefined
  prune(): void
}

const TOOL_NAMES = ['desktop.file.read', 'desktop.file.write'] as const

/** N-8：装载期逐条形状校验（expiresAt 有限正数 / directory 非空 / toolName 二值 / backendIdentity 非空）——越界剔除 */
function isValidGrantShape(g: unknown): g is PermissionGrant {
  if (typeof g !== 'object' || g === null) return false
  const x = g as Record<string, unknown>
  return typeof x.id === 'string' && (TOOL_NAMES as readonly string[]).includes(x.toolName as string)
    && typeof (x.scope as Record<string, unknown> | undefined)?.directory === 'string'
    && ((x.scope as Record<string, unknown>).directory as string).length > 0
    && typeof x.backendIdentity === 'string' && x.backendIdentity.length > 0
    && typeof x.expiresAt === 'number' && Number.isFinite(x.expiresAt) && x.expiresAt > 0
    && typeof x.createdAt === 'string'
}

export function createGrantStore(deps: GrantStoreDeps): GrantStore {
  const now = () => deps.now?.() ?? Date.now()
  let grants: PermissionGrant[] = []   // 内部缓存（快照）

  // 构造期 eager load：settings 已 load 完成（Task 8 装配保证）；单测同步 thenable 即刻填充（F-4）
  void deps.settings.load().then((s) => {
    const raw = (s as unknown as { tools?: { grants?: unknown[] } }).tools?.grants ?? []
    const valid: PermissionGrant[] = []
    for (const g of raw) {
      if (isValidGrantShape(g)) valid.push(g)
      else deps.logger?.warn('settings:grant-invalid', { id: typeof (g as Record<string, unknown> | null)?.id === 'string' ? (g as Record<string, unknown>).id : undefined })
    }
    grants = valid
  }).catch(() => {})   // load 失败 → 空 grants（fail-open，不阻塞启动）

  async function persist(next: PermissionGrant[]): Promise<void> {
    grants = next
    try { await deps.settings.save({ tools: { grants: next } } as never) }
    catch (e) { deps.logger?.warn('grant:save-failed', { message: (e as Error).message }) }   // fail-open
  }

  function auditGrant(type: string, grant: PermissionGrant, extra: Record<string, unknown> = {}): void {
    deps.audit({ ts: new Date().toISOString(), type, runtime: 'desktop', toolId: grant.id, toolName: grant.toolName,
      permissionGrantId: grant.id, backendIdentity: grant.backendIdentity, ...extra } as unknown as AuditEvent)
  }

  function prune(): void {
    let changed = false
    for (const g of grants) {
      if (!g.revokedAt && g.expiresAt <= now()) {
        g.revokedAt = new Date().toISOString(); g.revokeSource = 'expired'; changed = true
        auditGrant('grant:expired', g)
      }
    }
    if (changed) void persist(grants)
  }

  function list(): PermissionGrant[] {
    prune()
    return [...grants]
  }

  function add(g: Omit<PermissionGrant, 'id' | 'createdAt'>): PermissionGrant {
    const normalized = deps.normalizeDirectory(g.scope.directory)   // V-1：存储归一化值
    if (deps.isBlacklisted(normalized)) throw new ToolServiceError('PATH_BLOCKLISTED', '目录在黑名单中，无法授权')
    // N-6 幂等：同 toolName + 同归一化目录 + 同身份 + 未撤销未过期 → 返回既有（不落盘不审计）
    const dup = grants.find((x) => x.toolName === g.toolName && x.scope.directory === normalized
      && x.backendIdentity === g.backendIdentity && !x.revokedAt && x.expiresAt > now())
    if (dup) return dup
    const grant: PermissionGrant = { ...g, scope: { directory: normalized }, id: `grant-${randomUUID()}`, createdAt: new Date().toISOString() }
    auditGrant('grant:created', grant, { summary: `目录授权（工具 ${grant.toolName}，有效期至 ${new Date(grant.expiresAt).toISOString()}）` })   // F-5：无目录路径
    void persist([...grants, grant])
    return grant
  }

  function revoke(id: string): PermissionGrant | undefined {
    const g = grants.find((x) => x.id === id)
    if (!g || g.revokedAt) return undefined   // 未知 / 已撤销 → no-op（N-5）
    if (g.expiresAt <= now()) {
      g.revokedAt = new Date().toISOString(); g.revokeSource = 'expired'   // F-9：已过期走 expired 分支
      auditGrant('grant:expired', g)
    } else {
      g.revokedAt = new Date().toISOString(); g.revokeSource = 'user'
      auditGrant('grant:revoked', g, { cancelSource: 'user' })
    }
    void persist(grants)
    return g
  }

  function matches(toolName: string, realPath: string): PermissionGrant | undefined {
    prune()
    const identity = deps.backendIdentity()   // F-2：断连 undefined → 恒不匹配（fail-safe）
    if (identity === undefined) return undefined
    // V-20：平台门控比较（对齐 tool-policy.ts:36 先例）——win32 toLowerCase、posix 直比（防 posix 大小写不同目录互相命中）
    const eq = deps.platform === 'windows'
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + '/')
      : (a: string, b: string) => a === b || a.startsWith(b + '/')
    return grants.find((g) => !g.revokedAt && g.expiresAt > now() && g.toolName === toolName
      && g.backendIdentity === identity
      && eq(realPath, g.scope.directory))   // 目录段边界（等于或以目录+分隔符开头）
  }

  return { list, add, revoke, matches, prune }
}
```

**实现说明（F-4/F-3 定案）**：`createGrantStore` 构造期 `void deps.settings.load().then(...)` 填充缓存（生产装配 `settingsSvc.load()` 已在 Task 8 上移先于 grantStore 创建；单测 load 用同步可读 thenable 即刻填充）——方法全同步（`deps.grants?.matches(...)` 在 tool-service step 8 同步调用）。N-8 装载期校验在构造期快照落缓存前逐条 `isValidGrantShape`（越界剔除 + `settings:grant-invalid` 日志）。`persist` 同步更新内存缓存 + 异步落盘（fail-open）。**matches 按 deps.platform 平台门控比较（V-20/N-7：win32 toLowerCase / posix 直比——对齐 tool-policy.ts:36 先例，防 posix 大小写不同目录互相命中）**。**AuditEvent 扩展（permissionGrantId/toolName/backendIdentity/allow_scoped）在 Task 3 Step 3 一并落地**（本文件经 `as unknown as AuditEvent` 强转先通过编译）。

- [ ] **Step 4: 实现 tool-history.ts**

```typescript
// src/main/tools/tool-history.ts
// 阶段 6 批次 C（D6C-08）：审批历史只读回读——audit JSONL 逐行 parse，过滤 tool:* / grant:*。
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HISTORY_DAYS = 7        // F-4：天数边界（readdir 按文件名倒序取最近 N 天）
export const HISTORY_MAX = 200       // 合并结果总量上限（逐文件流式读满即停）

const AUDIT_DATE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export interface HistoryEntry {
  ts: string; type: string; callId?: string; toolId?: string; status?: string
  permissionDecision?: string; permissionGrantId?: string; backendIdentity?: string
  riskLevel?: string; cancelSource?: string; errorCode?: string; summary?: string
  toolName?: string   // 契约 F-5：AuditEvent 扩展后回读携带
}

export async function readAuditEvents(dir: string, opts: { limit?: number; days?: number } = {}): Promise<HistoryEntry[]> {
  const limit = Math.min(opts.limit ?? HISTORY_MAX, HISTORY_MAX)
  const days = opts.days ?? HISTORY_DAYS
  let files: string[]
  try { files = (await readdir(dir)).filter((f) => AUDIT_DATE_RE.test(f)).sort().reverse() }   // 文件名倒序（日期新→旧）
  catch { return [] }   // 目录不存在 → 空态（不阻塞设置页，fail-open）
  const cutoff = Date.now() - days * 86_400_000
  const entries: HistoryEntry[] = []
  for (const file of files) {
    if (entries.length >= limit) break
    const [, y, m, d] = file.match(AUDIT_DATE_RE)!
    const dayMs = new Date(`${y}-${m}-${d}T00:00:00Z`).getTime()
    if (dayMs < cutoff) continue   // 超 HISTORY_DAYS 边界
    let text: string
    try { text = await readFile(join(dir, file), 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (entries.length >= limit) break
      if (!line.trim()) continue
      let raw: Record<string, unknown>
      try { raw = JSON.parse(line) as Record<string, unknown> } catch { continue }   // 损坏行跳过不崩溃
      if (typeof raw.type !== 'string' || !(raw.type.startsWith('tool:') || raw.type.startsWith('grant:'))) continue
      entries.push({
        ts: typeof raw.ts === 'string' ? raw.ts : '', type: raw.type,
        callId: str(raw.callId), toolId: str(raw.toolId), status: str(raw.status),
        permissionDecision: str(raw.permissionDecision), permissionGrantId: str(raw.permissionGrantId),
        backendIdentity: str(raw.backendIdentity), riskLevel: str(raw.riskLevel),
        cancelSource: str(raw.cancelSource), errorCode: str(raw.errorCode), summary: str(raw.summary),
        toolName: str(raw.toolName),
      })
    }
  }
  return entries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit)   // ts 倒序
}
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined }
```

- [ ] **Step 5: 运行验证通过**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- grant-store tool-history && pnpm -F @cyrene/desktop typecheck`
Expected: PASS。若 grant-store.spec 的「add 幂等不落盘」因实现为「always persist」失败 → 按 spec 语义修正实现（幂等命中不落盘不审计）。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/main/tools/grant-store.ts apps/desktop/src/main/tools/tool-history.ts apps/desktop/tests/unit/grant-store.spec.ts apps/desktop/tests/unit/tool-history.spec.ts
git commit -m "feat(阶段6批次C Task2): GrantStore（settings.tools 读写 + grant:* 审计 + 黑名单复核 + 目录段边界 + 后端身份匹配 + 幂等 + 装载期校验）+ tool-history（audit JSONL 回读 HISTORY_DAYS/HISTORY_MAX）"
```

---

### Task 3: tool-service 决策链 step 8 grant 匹配 + grantDirectory 创建流 + L-1/L-3/L-7/L-8 + AuditEvent 扩展 + listRecent

**Files:**
- Modify: `apps/desktop/src/main/tools/tool-service.ts`（ToolServiceDeps 增 grants/pickDirectory/backendIdentity；handleRequest step 8；grantDirectory；L-1 驱逐；L-3 run 入口守卫；L-7 confirmUpload 顺序；**listRecent includeNonTerminalAlways（F-2 符合性）**；**audit() 闭包补 toolName（F-3 完整性）**）
- Modify: `apps/desktop/src/main/diagnostics/audit.ts`（AuditEvent 增 permissionGrantId/toolName/backendIdentity + permissionDecision union 增 'allow_scoped'，F-3 完整性）
- Modify: `apps/desktop/src/main/tools/tool-audit.ts`（ToolAuditInput 同步扩展，F-3 完整性）
- Modify: `apps/desktop/tests/unit/tool-service.spec.ts`（新增批次 C 用例；**复用既有 mkService/mkReq/FIXTURES helper——F-5 修复：不存在 mkDeps/rec，全部路径用 FIXTURES 真实目录**）

**Interfaces:**
- Consumes: Task 2 的 `GrantStore`；`ToolServiceDeps` 既有结构。
- Produces: `ToolService.grantDirectory(callId, ttlMs): Promise<void>`；L-1 `MAX_RECORDS = 200` + `evictIfNeeded`；L-3 run 入口守卫；L-7 confirmUpload 顺序；step 8 grant 匹配 + allow_scoped 审计；listRecent 非终态全量；AuditEvent 扩展。Task 6 handler 消费 grantDirectory；**queryStatus 字段整体推迟到 Task 5**（Task 3 不加——消除占位类型与代码块矛盾，F-1 完整性）。

- [ ] **Step 1: 写失败测试（tool-service.spec.ts 增补块）**

```typescript
// 追加到 tests/unit/tool-service.spec.ts 末尾的 describe('批次 C：grant 目录授权')
// F-5 修复：复用既有 mkService/mkReq/FIXTURES（tests/unit/tool-service.spec.ts:30-45）——mkService 返回
//   { svc, events, audit, submitStatus }；路径全部用既有 FIXTURES（'/tmp/cyrene-fixtures'，beforeEach mkdirSync
//   创建 + mkService 默认 allowRoots: [FIXTURES] 豁免 /tmp 黑名单——V-12 修复：不重声明同名常量，直接复用文件级 FIXTURES）。
// F-1 修复：本 task 不涉及 queryStatus（推迟 Task 5）；grants 经 mkService({ grants: ... }) 注入。
import { GRANT_TTL_OPTIONS_MS } from '../../src/shared/contracts/tool'   // 文件头 import 区追加

function mkGrantStore(store: Partial<import('../../src/main/tools/grant-store').GrantStore> = {}) {
  const real = { list: () => [], add: () => { throw new Error('stub') }, revoke: () => undefined,
    matches: () => undefined, prune: () => {} }
  return { ...real, ...store } as import('../../src/main/tools/grant-store').GrantStore
}

describe('批次 C：grant 目录授权', () => {
  it('step 8：write grant 命中 → auto 执行无窗 + 审计 allow_scoped + permissionGrantId=匹配 grant.id（N-7）', async () => {
    const audit = vi.fn()
    const g = { id: 'grant-1', toolName: 'desktop.file.write', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockResolvedValue({ output: { path: join(FIXTURES, 'f.txt'), bytesWritten: 2 }, summary: '覆盖 f.txt' })
    const { svc, events } = mkService({ audit, executorOverride: exec, grants: mkGrantStore({ matches: () => g }) })
    await svc.handleRequest(mkReq({ callId: 'call_1', toolName: 'desktop.file.write', arguments: { path: join(FIXTURES, 'f.txt'), content: 'v2' } }))
    expect(exec).toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:decision', permissionDecision: 'allow_scoped', permissionGrantId: 'grant-1' }))
    // auto 路径事件携带 rec.diff（F-11 一致 b——write 命中 preReadForDiff 已算）
    expect(events.some((e) => e.status === 'running')).toBe(true)   // V-15：mkService 返回 { svc, events, ... }——events 为独立数组，svc 无 _events
    expect(events.some((e) => e.diff !== undefined)).toBe(true)
  })
  it('step 8：grant 匹配优先于 selected-set 豁免（F-8 一致）——真双命中 → allow_scoped（V-9 修复：isExempt 是 selectedSet 查表，须经真实 select 执行器写入）', async () => {
    const audit = vi.fn()
    const target = join(FIXTURES, 'a.txt')
    const g = { id: 'grant-2', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    // 先真实 select（automatic → auto → 真实 select 执行器 → selectedAdd 写入 selectedSet——mkService 默认 allowRoots: [FIXTURES] 放行 /tmp）
    const { svc } = mkService({
      audit, pickFile: async () => ({ canceled: false, path: target }),
      grants: mkGrantStore({ matches: () => g }),
    })
    await svc.handleRequest(mkReq({ callId: 'call_sel', sourceCallId: 'tc_sel', toolName: 'desktop.file.select', arguments: {} }))   // N-1：独立 sourceCallId——selectedSet 现含 target
    // 再发 read（同路径）：isExempt(target) true 且 grant 命中 → 双命中 → 审计 allow_scoped（grant 优先）
    await svc.handleRequest(mkReq({ callId: 'call_2', sourceCallId: 'tc_2', toolName: 'desktop.file.read', arguments: { path: target } }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ permissionDecision: 'allow_scoped', permissionGrantId: 'grant-2' }))
  })
  it('step 8：grant 未命中 → 原 prompt 逻辑（awaiting + 权限窗）', async () => {
    const { svc } = mkService({ grants: mkGrantStore({ matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_3', toolName: 'desktop.file.write', arguments: { path: join(FIXTURES, 'f.txt'), content: 'v2' } }))
    expect(svc.getRecord('call_3')?.status).toBe('awaiting_permission')
  })
  it('step 8：capture 恒强确认（有 grant 也不匹配——工具名二值 guard）（F-6 符合性）', async () => {
    const audit = vi.fn()
    const { svc } = mkService({ audit, grants: mkGrantStore({ matches: () => ({ id: 'grant-x', toolName: 'desktop.screen.capture' as never, scope: { directory: FIXTURES }, backendIdentity: 'h', expiresAt: 1, createdAt: 'x', source: 'directory' as const }) }) })
    await svc.handleRequest(mkReq({ callId: 'call_cap', toolName: 'desktop.screen.capture', arguments: {} }))
    expect(svc.getRecord('call_cap')?.status).toBe('awaiting_permission')   // capture 走 prompt（isExempt 只对 read）
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ permissionDecision: 'allow_scoped' }))
  })
  it('step 8：黑名单优先（F-6 符合性）——黑名单路径 + grant 命中 → PATH_BLOCKLISTED（无 allow_scoped）', async () => {
    const audit = vi.fn()
    const { svc } = mkService({ audit, grants: mkGrantStore({ matches: () => ({ id: 'grant-e', toolName: 'desktop.file.read', scope: { directory: '/etc' }, backendIdentity: 'h', expiresAt: 1, createdAt: 'x', source: 'directory' as const }) }) })
    await svc.handleRequest(mkReq({ callId: 'call_bl', toolName: 'desktop.file.read', arguments: { path: '/etc/passwd' } }))
    expect(svc.getRecord('call_bl')?.status).toBe('rejected')   // step 5 黑名单拒（grant 不可达）
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ permissionDecision: 'allow_scoped' }))
  })
  it('grantDirectory：pickDirectory 注入 → 授权后自动执行 + 审计 allow_scoped（D6C-05；抽查修复：状态化 matches——handleRequest 阶段 grant 未命中→awaiting，grantDirectory add 后激活→F-1 复核命中→执行）', async () => {
    const audit = vi.fn()
    let grantActive = false
    const g = { id: 'grant-3', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const { svc } = mkService({ audit, executorOverride: exec, backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: FIXTURES }), grants: mkGrantStore({ add: () => { grantActive = true; return g }, matches: () => (grantActive ? g : undefined) }) })
    await svc.handleRequest(mkReq({ callId: 'call_4', sourceCallId: 'tc_4', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    expect(svc.getRecord('call_4')?.status).toBe('awaiting_permission')   // grant 未激活 → prompt
    await svc.grantDirectory('call_4', GRANT_TTL_OPTIONS_MS[1])
    expect(exec).toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:decision', permissionDecision: 'allow_scoped', permissionGrantId: 'grant-3' }))
  })
  it('grantDirectory：取消 → grant 不创建、保持 awaiting（F-1 miss 前路径）', async () => {
    const audit = vi.fn()
    const { svc } = mkService({ audit, backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: true }), grants: mkGrantStore() })
    await svc.handleRequest(mkReq({ callId: 'call_5', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.grantDirectory('call_5', GRANT_TTL_OPTIONS_MS[1])
    expect(svc.getRecord('call_5')?.status).toBe('awaiting_permission')
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tool:decision' }))
  })
  it('grantDirectory：F-1 picked 目录 ≠ 请求目标 → grant 已建但不执行、保持 awaiting', async () => {
    const exec = vi.fn()
    const other = mkdtempSync(join(tmpdir(), 'cy-other-'))
    const g = { id: 'grant-4', toolName: 'desktop.file.read', scope: { directory: other }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const { svc } = mkService({ executorOverride: exec, backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: other }), grants: mkGrantStore({ add: () => g, matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_6', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.grantDirectory('call_6', GRANT_TTL_OPTIONS_MS[1])
    expect(exec).not.toHaveBeenCalled()
    expect(svc.getRecord('call_6')?.status).toBe('awaiting_permission')
  })
  it('grantDirectory：F-3 ttl 非白名单 → INVALID_ARGUMENTS（先注 grants 再断 ttl——F-8 修复）；F-14 grants 缺省 → TOOL_STATE_INVALID 不崩溃', async () => {
    const { svc } = mkService({ backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: FIXTURES }), grants: mkGrantStore() })
    await svc.handleRequest(mkReq({ callId: 'call_7', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await expect(svc.grantDirectory('call_7', 2 ** 53)).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' })
    const { svc: svc2 } = mkService({ backendIdentity: () => 'http://h', pickDirectory: async () => ({ canceled: false, path: FIXTURES }) })   // grants undefined
    await svc2.handleRequest(mkReq({ callId: 'call_8', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await expect(svc2.grantDirectory('call_8', GRANT_TTL_OPTIONS_MS[1])).rejects.toMatchObject({ code: 'TOOL_STATE_INVALID' })
  })
  it('grantDirectory：N-4 断连 → 不创建；V-5 dialog 后身份复核不匹配 → 不创建', async () => {
    const add = vi.fn()
    let identity: string | undefined = undefined
    const { svc } = mkService({ backendIdentity: () => identity, pickDirectory: async () => ({ canceled: false, path: FIXTURES }), grants: mkGrantStore({ add }) })
    await svc.handleRequest(mkReq({ callId: 'call_9', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.grantDirectory('call_9', GRANT_TTL_OPTIONS_MS[1])
    expect(add).not.toHaveBeenCalled()
    expect(svc.getRecord('call_9')?.status).toBe('awaiting_permission')
    let identity2: string | undefined = 'http://a'
    const add2 = vi.fn()
    const { svc: svc2 } = mkService({ backendIdentity: () => identity2, pickDirectory: async () => { identity2 = 'http://b'; return { canceled: false, path: FIXTURES } }, grants: mkGrantStore({ add: add2 }) })
    await svc2.handleRequest(mkReq({ callId: 'call_10', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc2.grantDirectory('call_10', GRANT_TTL_OPTIONS_MS[1])
    expect(add2).not.toHaveBeenCalled()
  })
  it('grantDirectory：F-6 定时器清理 + N-1 dialog 挂起期间 expire → 不执行仅一次终态（F-6 符合性）', async () => {
    const audit = vi.fn()
    let resolvePick!: (v: { canceled: boolean; path?: string }) => void
    const pick = new Promise<{ canceled: boolean; path?: string }>((r) => { resolvePick = r })
    const g = { id: 'grant-5', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    // N-2 修复：matches 恒 undefined（grant 无需在 handleRequest 命中——否则记录即 auto 执行、awaiting 定时器永不设置）；
    //   add mock 保留（grantDirectory 授权流经 add → 但 dialog 后 status 复核（N-1）在 matches 前已返回，matches 不被授权流使用）
    const { svc, events } = mkService({ audit, backendIdentity: () => 'http://h', pickDirectory: () => pick, grants: mkGrantStore({ add: () => g, matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_n1', sourceCallId: 'tc_n1', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') }, expiresAt: Date.now() + 50 }))   // 短 TTL
    const p = svc.grantDirectory('call_n1', GRANT_TTL_OPTIONS_MS[1])   // dialog 挂起
    await new Promise((r) => setTimeout(r, 100))   // 等 expiresAt 定时器触发（expire → timeout 终态）
    resolvePick({ canceled: false, path: FIXTURES })
    await p
    const rec = svc.getRecord('call_n1')!
    expect(['timeout', 'cancelled']).toContain(rec.status)   // 已终态（不复活）
    // 仅一次终态：events 中终态事件（cancelled/timeout）只出现一次（V-15：events 为 mkService 返回的独立数组）
    const term = events.filter((e) => ['cancelled', 'timeout', 'completed', 'failed', 'rejected'].includes(e.status))
    expect(term).toHaveLength(1)
  })
  it('grantDirectory：F-16 run 抛错 → promoteQueue 恒执行（队列头不被卡死——V-17 修复：状态化 matches + awaiting 重发事件观测）', async () => {
    // V-17：matches 状态化（handleRequest 阶段 grant 未激活 → 两条记录均停 awaiting 入队；grantDirectory 时激活）
    let grantActive = false
    const g = { id: 'grant-6', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockRejectedValue(new Error('boom'))
    const { svc, events } = mkService({
      executorOverride: exec, backendIdentity: () => 'http://h',
      pickDirectory: async () => ({ canceled: false, path: FIXTURES }),
      grants: mkGrantStore({ matches: () => (grantActive ? g : undefined), add: () => { grantActive = true; return g } }),
    })
    await svc.handleRequest(mkReq({ callId: 'call_f16a', sourceCallId: 'tc_f16a', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') } }))
    await svc.handleRequest(mkReq({ callId: 'call_f16b', sourceCallId: 'tc_f16b', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'b.txt') } }))   // 队列第二位（N-1：独立 sourceCallId）
    expect(svc.getRecord('call_f16a')?.status).toBe('awaiting_permission')
    expect(svc.getRecord('call_f16b')?.status).toBe('awaiting_permission')
    await svc.grantDirectory('call_f16a', GRANT_TTL_OPTIONS_MS[1])   // run 抛错被 run() 内部 catch → failed；finally promoteQueue
    expect(svc.getRecord('call_f16a')?.status).toBe('failed')
    // promoteQueue 可观测副作用 = dequeueNext 对下一 awaiting 记录重发 awaiting 事件（对齐既有 M-3 口径）
    const awaitingForB = events.filter((e) => e.status === 'awaiting_permission' && e.desktopCallId === 'call_f16b')   // N-3：emit 的 id = sourceCallId——按 desktopCallId 过滤
    expect(awaitingForB.length).toBeGreaterThanOrEqual(1)   // 队列晋升 → f16b 重发 awaiting（若队列卡死则无此事件）
  })
  it('L-1 records 驱逐：>200 逐最旧终态（F-8 修复：grant 命中 auto → 终态；N-1：每条独立 sourceCallId）', async () => {
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const g = { id: 'grant-l1', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const { svc } = mkService({ executorOverride: exec, grants: mkGrantStore({ matches: () => g }) })
    for (let i = 0; i < 205; i++) {
      await svc.handleRequest(mkReq({ callId: `call_${i}`, sourceCallId: `tc_${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `f${i}.txt`) } }))
    }
    const recs = svc.listRecent(500)
    expect(recs.length).toBeLessThanOrEqual(200)   // 205 条终态 → 驱逐至 ≤200
  })
  it('L-1 补充：awaiting/running 永不逐出（D6C-09a——V-16 修复：同一 svc 内先终态后 awaiting；N-1：每条独立 sourceCallId）', async () => {
    // 同一 svc：先 grant 命中（matches → g）造 205 条终态，再换 matches → undefined 造 3 条 awaiting——断言 awaiting 仍全量在 listRecent
    let grantHit = true
    const g = { id: 'grant-l1b', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const { svc } = mkService({ executorOverride: exec, grants: mkGrantStore({ matches: () => (grantHit ? g : undefined) }) })
    for (let i = 0; i < 205; i++) await svc.handleRequest(mkReq({ callId: `call_a${i}`, sourceCallId: `tc_a${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `f${i}.txt`) } }))
    grantHit = false   // 之后请求走 prompt → awaiting
    for (let i = 0; i < 3; i++) await svc.handleRequest(mkReq({ callId: `call_w${i}`, sourceCallId: `tc_w${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `w${i}.txt`) } }))
    const recs = svc.listRecent(500)
    expect(recs.filter((r) => r.status === 'awaiting_permission')).toHaveLength(3)   // awaiting 永不逐出
    expect(recs.length).toBeLessThanOrEqual(200 + 3)   // 终态被逐至 ~200，awaiting 保留
  })
  it('L-3 run 入口守卫：已终态记录直接拒绝（N-1——终态复活防护，F-6 修复：真实触达守卫）', async () => {
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const g = { id: 'grant-l3', toolName: 'desktop.file.read', scope: { directory: FIXTURES }, backendIdentity: 'http://h', expiresAt: Date.now() + 1000, createdAt: 'x', source: 'directory' as const }
    // N-2 修复：matches 恒 undefined（记录先停 awaiting + expiresAt 定时器设置——grant 命中会即 auto 执行，timeout 永不发生）
    const { svc } = mkService({ executorOverride: exec, grants: mkGrantStore({ add: () => g, matches: () => undefined }) })
    await svc.handleRequest(mkReq({ callId: 'call_11', sourceCallId: 'tc_11', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'a.txt') }, expiresAt: Date.now() + 50 }))   // 短 TTL
    await new Promise((r) => setTimeout(r, 100))   // expire → timeout 终态
    expect(svc.getRecord('call_11')?.status).toBe('timeout')
    // grantDirectory 路径（F-1 复核前有 dialog 后 status 复核 + run 入口守卫双层防护）——已终态不复活
    await svc.grantDirectory('call_11', GRANT_TTL_OPTIONS_MS[1]).catch(() => {})
    expect(exec).not.toHaveBeenCalled()
    expect(svc.getRecord('call_11')?.status).toBe('timeout')   // 不被覆写为 running
  })
  it('L-7 confirmUpload 终态 emit 无陈旧 capture 字段（V-6 修复：真实断言，复用既有 capture 用例先例——tool-service.spec.ts:300-334 pickSource/confirmUpload 形态）', async () => {
    // 对齐既有 capture 用例：enumerateSources 注入 + pickSource + confirmUpload——断言 completed 事件载荷 captureSources/capturePreview 为 undefined
    // （既有用例已建立 capture 会话；本用例在其流程后断言终态事件字段——实现期按既有 describe 内 helper 直接转写）
    const { svc, events } = mkService({ enumerateSources: async () => [{ sourceId: 's1', sourceName: '屏', thumbnailDataUrl: 'data:image/png;base64,AA==' }] })
    await svc.handleRequest(mkReq({ callId: 'call_cap2', toolName: 'desktop.screen.capture', arguments: {} }))
    await svc.decide('call_cap2', 'allow_once')
    await svc.pickSource('call_cap2', 's1')
    await svc.confirmUpload('call_cap2')
    const terminalEv = events.filter((e) => ['completed', 'failed'].includes(e.status)).at(-1)
    expect(terminalEv).toBeDefined()
    expect(terminalEv.captureSources).toBeUndefined()   // L-7：emit 前已清
    expect(terminalEv.capturePreview).toBeUndefined()
  })
  it('L-2 水合数据源：listRecent 非终态不设 20 上限（F-2 符合性：includeNonTerminalAlways；N-1：每条独立 sourceCallId）', async () => {
    const exec = vi.fn().mockResolvedValue({ output: { cancelled: true }, summary: 'x' })
    const { svc } = mkService({ executorOverride: exec, grants: mkGrantStore({ matches: () => undefined }) })
    // 25 条 awaiting（非终态）——listRecent(20) 必须全量返回（awaiting 不被 20 上限截断）
    for (let i = 0; i < 25; i++) await svc.handleRequest(mkReq({ callId: `call_h${i}`, sourceCallId: `tc_h${i}`, toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, `h${i}.txt`) } }))
    const recs = svc.listRecent(20)
    expect(recs.filter((r) => r.status === 'awaiting_permission')).toHaveLength(25)   // 非终态全量
    expect(recs).toHaveLength(25)   // 无终态可补足 → 仅非终态
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- tool-service`
Expected: FAIL——`ToolServiceDeps` 无 grants/backendIdentity/pickDirectory、`svc.grantDirectory` 不存在、step 8 无 grant 匹配。

- [ ] **Step 3: 实现 tool-service.ts 改造 + AuditEvent 扩展（F-3 完整性）+ listRecent（F-2）**

```typescript
// ToolServiceDeps 增（接口尾部）——F-1 修复：queryStatus 整体推迟 Task 5，本 task 不加：
export interface ToolServiceDeps {
  // ...既有字段...
  grants?: import('./grant-store').GrantStore      // 批次 C（D6C-04）：grant 仓库（缺省 → 无 grant 面）
  pickDirectory?: (opts: { title: string }) => Promise<{ canceled: boolean; path?: string }>   // D6C-05 创建流注入
  backendIdentity?: () => string | undefined       // F-2：当前连接指纹（grant 创建时绑定；index.ts 懒绑定闭包）
}

// ToolService 接口增：
grantDirectory(callId: string, ttlMs: number): Promise<void>

// 常量区增：
export const MAX_RECORDS = 200   // L-1（D6C-09a）

// audit.ts（main/diagnostics/audit.ts）——F-3 完整性：AuditEvent 增三可选字段 + union 扩展：
//   permissionDecision?: 'allow_once' | 'deny' | 'allow_scoped'   （原两值 → 三值）
//   permissionGrantId?: string
//   toolName?: string
//   backendIdentity?: string
// tool-audit.ts ToolAuditInput 同步：permissionDecision 三值 + permissionGrantId?/toolName?/backendIdentity? 可选。

// tool-service 内部 audit() 闭包（F-3：审批历史按工具过滤数据源——补 toolName）：
function audit(type: string, rec: ToolRecord, extra: Record<string, unknown> = {}): void {
  deps.audit({ ts: new Date().toISOString(), type, runtime: 'desktop', toolId: rec.id, toolName: rec.toolName,
    callId: rec.desktopCallId, status: rec.status, summary: rec.inputSummary, ...extra } as unknown as AuditEvent)
}

// handleRequest step 8 改造（替换既有 decision 段）——F-8 一致：grant 优先于豁免：
// 8 授权判定（D6C-04/F-8）：grant 匹配优先于 selected-set 豁免；capture 恒强确认；黑名单优先（step 5 已拒）
const grant = (req.toolName === 'desktop.file.read' || req.toolName === 'desktop.file.write') && realPath
  ? deps.grants?.matches(req.toolName, realPath) : undefined
const decision = tool.permissionMode === 'automatic' ? 'auto'
  : grant ? 'auto'
  : (req.toolName === 'desktop.file.read' && realPath && isExempt(realPath)) ? 'auto'
  : 'prompt'
if (decision === 'auto') {
  if (grant) audit('tool:decision', rec, { permissionDecision: 'allow_scoped', permissionGrantId: grant.id, riskLevel: tool.localRisk })   // N-7：grant 命中审计（豁免命中不审计 allow_scoped）
  await run(rec, tool)
} else { /* 既有 awaiting + expiresAt 定时器路径不变 */ }

// 记录创建处补 L-1 驱逐（records.set 之后）：
evictIfNeeded()
function evictIfNeeded(): void {
  if (records.size <= MAX_RECORDS) return
  const terminal = [...records.values()].filter((r) => ['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(r.status))
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))   // 最旧优先
  for (const rec of terminal) {
    if (records.size <= MAX_RECORDS) break
    records.delete(rec.id)
    if (rec.desktopCallId) byCallId.delete(rec.desktopCallId)
    const t = timers.get(rec.id); if (t) { clearTimeout(t); timers.delete(rec.id) }
  }
}

// listRecent 增 includeNonTerminalAlways（F-2 符合性：非终态全量 + 终态补足到 limit——L-2 水合数据源）：
function listRecent(limit = 20): PublicToolEvent[] {
  const all = [...records.values()].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  const TERMINAL = ['completed', 'failed', 'rejected', 'cancelled', 'timeout']
  const nonTerminal = all.filter((r) => !TERMINAL.includes(r.status))
  const terminal = all.filter((r) => TERMINAL.includes(r.status)).slice(0, Math.max(0, limit - nonTerminal.length))
  return [...nonTerminal, ...terminal].map((rec) => ({ /* 既有映射不变 */ }))
}
// tool-handlers.ts:26 调用处 `deps.tools.listRecent(20)` 不变（listRecent 语义自带非终态全量）。

// run() 入口守卫（N-1/L-3 前移——置于 `rec.status = 'running'` 之前）：
async function run(rec: ToolRecord, tool: RegisteredTool): Promise<void> {
  if (rec.status !== 'requested' && rec.status !== 'awaiting_permission') return   // N-1/L-3：已终态记录整体拒绝（防定时器过期后复活）
  rec.status = 'running'; rec.startedAt ??= new Date().toISOString()
  // ...既有 body 不变...

// grantDirectory 新函数（D6C-05/§3.3 定案代码）——F-14 修复：ttl 校验用显式收窄：
async function grantDirectory(callId: string, ttlMs: number): Promise<void> {
  if (!deps.grants) throw new ToolServiceError('TOOL_STATE_INVALID', '目录授权不可用')   // F-14
  const id = idOf(callId); const rec = id ? records.get(id) : undefined
  if (!rec || rec.status !== 'awaiting_permission') throw new ToolServiceError('TOOL_STATE_INVALID', 'callId 不在等待授权态')
  const tool = deps.registry.get(rec.toolName)!
  if (tool.toolName !== 'desktop.file.read' && tool.toolName !== 'desktop.file.write') throw new ToolServiceError('TOOL_STATE_INVALID', '该工具不支持目录授权')
  if (!rec.realPath) throw new ToolServiceError('PATH_UNSAFE', '目标路径不可用')
  if (!(GRANT_TTL_OPTIONS_MS as readonly number[]).includes(ttlMs)) throw new ToolServiceError('INVALID_ARGUMENTS', 'ttl 不在授权选项内')   // F-3 双保险（显式收窄，无 as never）
  const identity = deps.backendIdentity?.()   // N-4
  if (!identity) return   // 断连 → 不创建（保持 awaiting；fail-closed）
  const picked = deps.pickDirectory ? await deps.pickDirectory({ title: '选择授权目录' }) : { canceled: true }
  if (picked.canceled || !picked.path) return   // 取消 → 保持 awaiting
  if (rec.status !== 'awaiting_permission') return   // N-1：dialog 期间已终态 → 不建不 run
  if (deps.backendIdentity?.() !== identity) return   // V-5：dialog 期间连接切换 → 不创建
  const grant = deps.grants.add({ toolName: rec.toolName, scope: { directory: picked.path }, backendIdentity: identity, expiresAt: Date.now() + ttlMs, source: 'directory' })   // add 内含黑名单复核 + N-6 幂等 + V-1 归一化
  if (!(rec.realPath && deps.grants.matches(rec.toolName, rec.realPath))) return   // F-1：picked 不覆盖目标 → grant 已建不执行
  audit('tool:decision', rec, { permissionDecision: 'allow_scoped', permissionGrantId: grant.id })
  const t = timers.get(rec.id); if (t) { clearTimeout(t); timers.delete(rec.id) }   // F-6
  try { await run(rec, tool) } finally { promoteQueue(rec.id) }   // F-16
}

// confirmUpload（L-7）：终态 emit 前清 capture 字段（现清在 emit 后——前移）
// 现状对照：`emit(rec)` 后再清 `rec.captureSources/rec.capturePreview`——改为 emit 前清（对齐 terminal() 先例）

// returned 接口增 grantDirectory
return { handleRequest, decide, cancel, listRecent, pickSource, confirmUpload, reconnect, shutdown, getRecord, grantDirectory }
```

- [ ] **Step 4: 运行验证通过**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- tool-service && pnpm -F @cyrene/desktop typecheck`
Expected: PASS（新增用例 + 既有 37 例全绿——注意既有用例的 step 8 行为不变：grants 缺省时 `deps.grants?.matches` 短路 → 原 prompt 语义）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/tools/tool-service.ts apps/desktop/tests/unit/tool-service.spec.ts
git commit -m "feat(阶段6批次C Task3): tool-service 决策链 step 8 grant 匹配（优先于豁免）+ grantDirectory 创建流（F-1/F-3/F-6/F-14/F-16/N-1/N-4/V-5 守卫全落地）+ L-1 驱逐 + L-3 run 入口守卫 + L-7 confirmUpload 顺序"
```

---

### Task 4: L-4/L-6 收口 + 新文件写 TOCTOU 守卫 + text-diff 截断

**Files:**
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（case 'tool.request' 包 try/catch，L-4；**RealBackendOptions 增 `logger?: { warn(msg: string, extra?: Record<string, unknown>): void }` 可选字段——F-3 修复：现无 logger 字段，typecheck 必挂**）
- Modify: `apps/desktop/src/main/tools/text-diff.ts`（MAX_DIFF_LINE_BYTES 截断，L-6）
- Modify: `apps/desktop/src/main/tools/tool-executors.ts`（新文件写 TOCTOU 守卫，D6C-10 facts 修正）
- Modify: `apps/desktop/tests/unit/text-diff.spec.ts`、`apps/desktop/tests/unit/tool-executors.spec.ts`、`apps/desktop/tests/unit/real-backend.spec.ts`（**L-4 失败测试，F-12 修复**——查既有 real-backend*.spec 夹具模式）

**Interfaces:**
- Consumes: 无新依赖。
- Produces: `text-diff.ts` 增 `MAX_DIFF_LINE_BYTES = 2000` 导出 + 单行截断；`tool-executors.writeFile` 增 `rec.diff?.isNewFile && existsSync → FILE_CONFLICT`；`RealBackendOptions.logger?`。Task 6/8 无依赖。

- [ ] **Step 1: 写失败测试**

```typescript
// text-diff.spec.ts 追加：
it('L-6：单行超 MAX_DIFF_LINE_BYTES 截断 + 标记（D6C-09f）', () => {
  const long = 'x'.repeat(3000) + '\n'
  const r = computeTextDiff('', long)
  const longest = Math.max(...r.lines.map((l) => l.text.length))
  expect(longest).toBeLessThanOrEqual(2000 + '…（已截断）'.length)
  expect(r.lines.some((l) => l.text.includes('（已截断）'))).toBe(true)
})

// tool-executors.spec.ts 追加（write describe 内）：
it('D6C-10 新文件写 TOCTOU 守卫：授权时不存在（rec.diff.isNewFile）→ 执行前被创建 → FILE_CONFLICT（原文件不变）', async () => {
  const p = join(tmp, 'new-toc.txt')
  const ex = createExecutors(mkDeps())
  const r = rec('desktop.file.write', { path: p, content: 'v2' })
  r.diff = { lines: [], added: 0, removed: 0, truncated: false, totalLines: 0, formatNote: '新建文件', isNewFile: true }   // 授权时不存在
  writeFileSync(p, 'v3')   // 执行前被创建
  await expect(ex.execute(r, p)).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
  expect(readFileSync(p, 'utf8')).toBe('v3')   // 原文件不变
})

// real-backend.spec.ts 追加（V-13/N-5 修复：夹具用真实 helper——makeOpts（:75）/fakeWs（:356）/mockFetch（:372），
//   makeBackend 为零参签名（:72）不传参——正确构造为 `new RealBackend(makeOpts({...}))`；connect 必填 serverUrl；
//   坏帧注入落为可执行代码（对齐既有 connect 用例形态 spec:280 区域））：
it('L-4：case tool.request mapper 抛错 → logger.warn + 丢帧不崩溃 + onToolRequest 不触发', async () => {
  const logger = { warn: vi.fn() }
  const onToolRequest = vi.fn()
  const b = new RealBackend(makeOpts({ logger, onToolRequest }))
  await b.connect({ serverUrl: 'http://127.0.0.1:1', token: 't' })   // 既有 connect 夹具（fakeWs + server_info 编排）
  // 注入非法 tool.request 帧（expiresAt 非 ISO 串 → Date.parse NaN → mapper 校验失败 → catch）——按既有 handleFrame 直调形态：
  b['handleFrame']({ type: 'tool.request', callId: 'call_bad', toolName: 'desktop.file.read', toolVersion: '1.0',
    runtime: 'desktop', sourceCallId: 'tc_bad', arguments: { path: '/x' }, riskLevel: 'medium',
    permissionRequired: true, approvalAuthority: 'client', paramHash: 'h', expiresAt: 'not-a-date' } as never)
  expect(onToolRequest).not.toHaveBeenCalled()   // 帧被丢弃
  expect(logger.warn).toHaveBeenCalledWith('tool.request:parse-failed', expect.objectContaining({ message: expect.any(String) }))
  // 后续合法帧仍正常处理（连接不崩）——既有 case 的 tool.request 用例随后执行可过
})
```

- [ ] **Step 2: 运行验证失败**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- text-diff tool-executors`
Expected: FAIL——text-diff 无截断、writeFile 无守卫。

- [ ] **Step 3: 实现**

`text-diff.ts`：

```typescript
export const MAX_DIFF_LINE_BYTES = 2000   // L-6（D6C-09f）：单行 text 超限截断（防 2MiB 单行经 awaiting 事件压垮 Renderer）
// computeTextDiff 内 lines.push 处：
for (const text of seg) {
  if (lines.length >= MAX_DIFF_LINES) break
  const clipped = Buffer.byteLength(text, 'utf8') > MAX_DIFF_LINE_BYTES
    ? text.slice(0, MAX_DIFF_LINE_BYTES) + '…（已截断）'
    : text
  lines.push({ kind, text: clipped })
}
```

`tool-executors.ts` writeFile（`const exists = fs.existsSync(p)` 之后补）：

```typescript
// D6C-10（facts 修正）：授权时文件不存在（preReadForDiff 置 isNewFile）、执行前被创建 → 拒绝覆盖（原文件保持）
if (exists && rec.diff?.isNewFile) throw new ToolExecError('FILE_CONFLICT', '文件已被创建，未覆盖')
```

`real-backend.ts` case 'tool.request' 包 try/catch（L-4）：

```typescript
case 'tool.request': {
  // 批次 C（L-4，D6C-09d）：解析/提炼失败 → warn + 丢弃该帧不崩溃（不 catch 后继续 emit——失败即协议异常）
  try {
    const ev = this.mapper?.mapFrame(frame)
    if (!ev) return
    this.onToolRequest?.({ callId: frame.callId, sourceCallId: frame.sourceCallId, toolName: frame.toolName,
      toolVersion: frame.toolVersion, runtime: 'desktop', arguments: frame.arguments, reason: frame.reason,
      expiresAt: Date.parse(frame.expiresAt), paramHash: frame.paramHash })
  } catch (e) {
    this.options.logger?.warn('tool.request:parse-failed', { message: (e as Error).message })
  }
  return
}
```

- [ ] **Step 4: 运行验证通过 + 提交**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- text-diff tool-executors real-backend && pnpm -F @cyrene/desktop typecheck`

```bash
git add apps/desktop/src/main/tools/text-diff.ts apps/desktop/src/main/tools/tool-executors.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/tests/unit/text-diff.spec.ts apps/desktop/tests/unit/tool-executors.spec.ts
git commit -m "feat(阶段6批次C Task4): L-4 tool.request try-catch + L-6 diff 单行截断（MAX_DIFF_LINE_BYTES=2000）+ D6C-10 新文件写 TOCTOU 守卫（isNewFile+existsSync → FILE_CONFLICT）"
```

---

### Task 5: GET /api/tools/calls/{callId} + reconnect queryStatus（real/mock + REST 15→16）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/backend.ts`（DesktopCallStatus + RepoCallStatus 类型）
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`（DesktopCallStatusSchema）
- Modify: `apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts`（复导出 DesktopCallStatusSchema，V-12）
- Modify: `apps/desktop/src/main/transport/backend-adapter.ts`（BackendAdapter 接口增 getToolCallStatus）
- Modify: `apps/desktop/src/main/transport/real-backend.ts`（getToolCallStatus 实现）
- Modify: `apps/desktop/src/main/transport/mock-backend.ts`（getToolCallStatus → null）
- Modify: `apps/desktop/src/main/tools/tool-service.ts`（**ToolServiceDeps 增 `queryStatus?: (callId: string) => Promise<DesktopCallStatus | null>`（本 task 首次加入）+ reconnect queryStatus 三分支接线——F-1 修复：Task 3 未加该字段，类型矛盾消除**）
- Modify: `apps/desktop/scripts/check-backend-contract.mjs`（REST_TARGET_MODELS 增 DesktopCallStatusSchema——**F-10 修复：对象映射 `DesktopCallStatus: ['DesktopCallStatusSchema']`，非数组条目**）
- Create: `apps/desktop/tests/unit/real-backend-tools.spec.ts`
- Modify: `apps/desktop/tests/unit/tool-service.spec.ts`（**reconnect queryStatus 三分支测试——F-4 修复：从 Task 5 移入，放对文件**）

**Interfaces:**
- Consumes: Task 3 的 tool-service（queryStatus 字段本 task 加入）。
- Produces: `DesktopCallStatus`/`RepoCallStatus`/`DesktopCallStatusSchema`；`BackendAdapter.getToolCallStatus`；`ToolServiceDeps.queryStatus` + reconnect 三分支。Task 6/8 无依赖。

- [ ] **Step 1: 写失败测试 `real-backend-tools.spec.ts`**

```typescript
// tests/unit/real-backend-tools.spec.ts（node；查既有 real-backend-*.spec.ts 的 mock fetch/ws 模式，对齐夹具）
import { describe, expect, it, vi } from 'vitest'
import { RealBackend } from '../../src/main/transport/real-backend'
import { DesktopCallStatusSchema } from '../../src/shared/schemas/ipc-response'

// 对齐既有 real-backend 测试的构造模式（fake fetchImpl + fakeWs + 手动 connect——N-8：真实夹具为 fakeWs 非 FakeWebSocket）
function mkBackend(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  // ... 对齐 tests/unit/real-backend-live2d.spec.ts 或 real-backend.spec.ts 的既有构造 helper ...
  return new RealBackend({ serverUrl: 'http://localhost:8000', token: 'tok', fetchImpl, onProtocolWarning: vi.fn(), onError: vi.fn(), logger: { warn: vi.fn() } } as never)
}

describe('批次 C：getToolCallStatus', () => {
  it('GET 组装 + DesktopCallStatusSchema 解析（repo 9 值全分支，契约 F-2）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      callId: 'call_1', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop',
      paramHash: 'abc', status: 'expired', createdAt: '2026-08-20T00:00:00Z', expiresAt: '2026-08-21T00:00:00Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const b = mkBackend(fetchImpl)
    const r = await b.getToolCallStatus('call_1')
    expect(r).toMatchObject({ callId: 'call_1', status: 'expired' })
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/api/tools/calls/call_1', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer tok' }) }))
  })
  it('schema strict：未知字段拒 / 缺必填拒 / succeeded/failed 合法', () => {
    const base = { callId: 'c', toolName: 't', toolVersion: '1', runtime: 'desktop', paramHash: 'h', status: 'succeeded', createdAt: 'x', expiresAt: 'y' }
    expect(DesktopCallStatusSchema.safeParse(base).success).toBe(true)
    expect(DesktopCallStatusSchema.safeParse({ ...base, status: 'pending' }).success).toBe(true)   // repo 9 值含 pending
    expect(DesktopCallStatusSchema.safeParse({ ...base, status: 'result' }).success).toBe(false)   // wire 六态不入 repo 枚举
    expect(DesktopCallStatusSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(DesktopCallStatusSchema.safeParse({ ...base, createdAt: undefined }).success).toBe(false)
  })
  it('非 2xx / 断连 / 解析失败 → null 降级', async () => {
    const b500 = mkBackend(vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    expect(await b500.getToolCallStatus('call_1')).toBeNull()
    const bBad = mkBackend(vi.fn().mockResolvedValue(new Response('{"status":"x"}', { status: 200, headers: { 'content-type': 'application/json' } })))
    expect(await bBad.getToolCallStatus('call_1')).toBeNull()
  })
})

// —— 以下追加到 tests/unit/tool-service.spec.ts（F-4 修复：reconnect 三分支测试放 tool-service.spec，
//    非 real-backend-tools.spec——spec §3.8 归属 tool-service.spec.ts 行；复用 mkService/mkReq/FIXTURES）——
describe('批次 C：reconnect queryStatus 三分支（D6C-11）', () => {
  it('expired → terminal(timeout) + wire cancelled；cancelled/rejected → terminal(cancelled)；succeeded/null → 保持 awaiting（禁止自动执行）', async () => {
    const mk = (status: string | null) => mkService({
      queryStatus: async () => (status === null ? null : { callId: 'call_r', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'h', status: status as never, createdAt: 'x', expiresAt: 'y' }),
      grants: mkGrantStore({ matches: () => undefined }),
    })
    // 建立 awaiting 记录后调 reconnect()：
    const { svc: sExp } = mk('expired')
    await sExp.handleRequest(mkReq({ callId: 'call_r1', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r1.txt') } }))
    await sExp.reconnect()
    expect(sExp.getRecord('call_r1')?.status).toBe('timeout')
    const { svc: sCan } = mk('cancelled')
    await sCan.handleRequest(mkReq({ callId: 'call_r2', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r2.txt') } }))
    await sCan.reconnect()
    expect(sCan.getRecord('call_r2')?.status).toBe('cancelled')
    const { svc: sOk } = mk('succeeded')
    await sOk.handleRequest(mkReq({ callId: 'call_r3', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r3.txt') } }))
    await sOk.reconnect()
    expect(sOk.getRecord('call_r3')?.status).toBe('awaiting_permission')   // succeeded → 保持本地态（禁止自动执行，doc 02 §16.2）
    const { svc: sNull } = mk(null)
    await sNull.handleRequest(mkReq({ callId: 'call_r4', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r4.txt') } }))
    await sNull.reconnect()
    expect(sNull.getRecord('call_r4')?.status).toBe('awaiting_permission')   // null → 保持
  })
  it('queryStatus 未注入（undefined）→ reconnect 不查询（mock 装配路径）', async () => {
    const { svc } = mkService({ grants: mkGrantStore({ matches: () => undefined }) })   // 无 queryStatus
    await svc.handleRequest(mkReq({ callId: 'call_r5', toolName: 'desktop.file.read', arguments: { path: join(FIXTURES, 'r5.txt') } }))
    await svc.reconnect()
    expect(svc.getRecord('call_r5')?.status).toBe('awaiting_permission')   // 不查不动作
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- real-backend-tools tool-service`
Expected: FAIL——`DesktopCallStatus`/`DesktopCallStatusSchema` 不存在、`getToolCallStatus` 不存在。

- [ ] **Step 3: 实现**

`shared/contracts/backend.ts` 追加：

```typescript
// 阶段 6 批次 C（D6C-11，契约 F-2）：GET /api/tools/calls/{callId} 响应——repo 9 值枚举（非 ToolWireStatus 六态！）
export type RepoCallStatus = 'pending' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'expired' | 'offline'
export interface DesktopCallStatus {
  callId: string; toolName: string; toolVersion: string; runtime: string; paramHash: string
  status: RepoCallStatus; createdAt: string; expiresAt: string
  result?: Record<string, unknown>; error?: Record<string, unknown>
}
```

`shared/schemas/ipc-response.ts` 追加（文件尾部，import `DesktopCallStatus` 类型）：

```typescript
// —— 阶段 6 批次 C：GET tools/calls 响应 schema（D6C-11，镜像 frontend_contract/contract.raw.ts:1586-1610）——
export const RepoCallStatusSchema = z.enum(['pending', 'accepted', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired', 'offline'])
export const DesktopCallStatusSchema: z.ZodType<DesktopCallStatus> = z.object({
  callId: z.string(), toolName: z.string(), toolVersion: z.string(), runtime: z.string(), paramHash: z.string(),
  status: RepoCallStatusSchema, createdAt: z.string(), expiresAt: z.string(),
  result: z.record(z.string(), z.unknown()).optional(), error: z.record(z.string(), z.unknown()).optional(),
}).strict()
```

`rest-schemas.ts` 尾部复导出（V-12：check:contract REST 段解析目标）：

```typescript
export { DesktopCallStatusSchema } from '../../../shared/schemas/ipc-response'   // 路径以实际相对深度为准
```

`backend-adapter.ts` 接口增：

```typescript
/** 批次 C（D6C-11）：查询桌面调用服务端状态；缺端点/断连/非 2xx → null 降级 */
getToolCallStatus(callId: string): Promise<import('@shared/contracts/backend').DesktopCallStatus | null>
```

`real-backend.ts`：

```typescript
async getToolCallStatus(callId: string): Promise<DesktopCallStatus | null> {
  if (!this.serverUrl || this.state.status === 'disconnected') return null
  try {
    const res = await this.restFetch(`/api/tools/calls/${encodeURIComponent(callId)}`)   // GET 复用（restFetch 缺省 method GET）
    const parsed = DesktopCallStatusSchema.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  } catch { return null }   // 降级：任何失败不阻断
}
```

`mock-backend.ts`：

```typescript
async getToolCallStatus(_callId: string): Promise<DesktopCallStatus | null> {
  return null   // mock 无端点（D6C-11/R6：记录取舍；装配不注入 queryStatus → tool-service 不查）
}
```

`tool-service.ts` reconnect 三分支接线（queryStatus 字段本 task 首次加入——V-18 措辞修复，无 Task 3 占位）：

```typescript
async function reconnect(): Promise<void> {
  selectedSet.clear()
  for (const rec of records.values()) {
    if (['completed', 'failed', 'rejected', 'cancelled', 'timeout'].includes(rec.status) && !rec.statusSent) {
      const wire = toWire(rec.status) ?? 'cancelled'
      void wireSend(rec, wire, rec.attachments?.length ? { attachments: rec.attachments } : {})
    }
  }
  // 批次 C（D6C-11）：awaiting 记录查询服务端状态（注入 queryStatus 才查；mock 不注入 → 不查）
  if (deps.queryStatus) {
    for (const rec of records.values()) {
      if (rec.status !== 'awaiting_permission' || !rec.desktopCallId) continue
      const st = await deps.queryStatus(rec.desktopCallId).catch(() => null)
      if (!st) continue   // null/失败 → 保持本地态（禁止自动执行，doc 02 §16.2）
      if (st.status === 'expired') { terminal(rec, 'timeout', { code: 'EXPIRED', message: '服务端已过期' }, 'timeout', 'cancelled'); continue }
      if (st.status === 'cancelled' || st.status === 'rejected') { terminal(rec, 'cancelled', undefined, 'backend', 'cancelled'); continue }
      // succeeded/failed/pending/accepted/running/offline → 保持本地态
    }
  }
}
```

`check-backend-contract.mjs` `REST_TARGET_MODELS`（~line 156）追加第 16 项——**F-10 修复：真实结构为对象映射 `ModelName: [schema路径段]`，非数组条目**：

```javascript
// 在 TtsPreviewResult 条目后追加（现有 15 项全为 `Name: ['SchemaName']` 形态）：
DesktopCallStatus: ['DesktopCallStatusSchema'],
```

（复导出保证 `mod['DesktopCallStatusSchema']` 命中 rest-schemas.ts——V-12；required/roles 由 rest.py 的 Optional 注解自动推导，无条目级配置。）

- [ ] **Step 4: 运行验证通过**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- real-backend-tools tool-service && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop check:contract`
Expected: PASS——check:contract REST 段 **15/16**（DesktopCallStatus 新条目解析成功）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/contracts/backend.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/main/transport/protocol-v2/rest-schemas.ts apps/desktop/src/main/transport/backend-adapter.ts apps/desktop/src/main/transport/real-backend.ts apps/desktop/src/main/transport/mock-backend.ts apps/desktop/src/main/tools/tool-service.ts apps/desktop/scripts/check-backend-contract.mjs apps/desktop/tests/unit/real-backend-tools.spec.ts
git commit -m "feat(阶段6批次C Task5): GET /api/tools/calls/{callId}——DesktopCallStatus repo 9 值契约 + real 实现/mock 降级 + reconnect queryStatus 三分支（expired→timeout/cancelled→cancelled/其余保持）+ REST_TARGET_MODELS 15→16"
```

---

### Task 6: IPC 四通道 + preload + 白名单/类型镜像（Main 接线）

**Files:**
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`（IpcChannels 增 toolGrantDirectory/toolGrants/toolGrantRevoke/toolHistory）
- Modify: `apps/desktop/src/shared/schemas/ipc-response.ts`（grantDirectorySchema union ttl/ grantListResponseSchema/ grantRevokeSchema/ historyEntrySchema/ historyResponseSchema/ toolHistoryQuerySchema）
- Modify: `apps/desktop/src/main/ipc/tool-handlers.ts`（deps 增 grants/history + 4 handler + decide/cancel .catch L-8）
- Modify: `apps/desktop/src/main/ipc/handlers.ts`（registerToolHandlers 调用处传 grants/history）
- Modify: `apps/desktop/src/main/index.ts`（装配顺序：settingsSvc 上移 + createGrantStore + backendIdentity 同源闭包 + tool-history + env 桥）
- Modify: `apps/desktop/src/main/connection/connection-config.ts`（无需改——getEndpoint 已有）
- Modify: `apps/desktop/src/preload/desktop-api.ts`（4 方法）
- Modify: `apps/desktop/src/preload/index.d.ts`（4 键）
- Modify: `apps/desktop/src/renderer/src/stores/desktop-api.types.ts`（DesktopApiLike 4 键）
- Modify: `apps/desktop/tests/unit/ipc-tool-handlers.spec.ts`（注册顺序断言 5→9 通道）
- Modify: `apps/desktop/tests/integration/ipc-security.spec.ts`（白名单 63→67）

**Interfaces:**
- Consumes: Task 1 的 grants schemas + Task 2 的 GrantStore/readAuditEvents + Task 3 的 grantDirectory。
- Produces: `api.toolGrantDirectory/toolListGrants/toolRevokeGrant/toolListHistory`（preload）；renderer 消费（Task 7）。

- [ ] **Step 1: 写失败测试**

```typescript
// ipc-tool-handlers.spec.ts 追加（deps 增 grants/history fake）——F-10 修复：既有 2 处 deps 字面量（:17/:31）
// `registerToolHandlers({ tools: tools as never, sanitize: (x) => x }, reg)` 需补新必填字段（grants/history/auditDir），
// 否则新 deps 类型下编译失败——实现期统一改为
// `registerToolHandlers({ tools: tools as never, sanitize: (x) => x, grants: fakeGrantStore, history: fakeHistory, auditDir: '/tmp/audit' }, reg)`
// N-4 修复：夹具脚手架 define 于 describe 顶层（既有文件 registered/reg/byChannel 为各 it 内局部——需提升）：
//   const fakeGrantStore = { list: () => [{ id: 'grant-1', toolName: 'desktop.file.read', scope: { directory: '/d' },
//     backendIdentity: 'http://h', expiresAt: 1, createdAt: 'x', source: 'directory' as const, revokedAt: 'x', revokeSource: 'user' as const }],
//     add: () => ({ id: 'grant-n' }), revoke: () => undefined, matches: () => undefined, prune: () => {} } as never
//   const fakeHistory = vi.fn().mockResolvedValue([{ ts: 'x', type: 'tool:decision' }])
//   function setupRegister(toolsOver: Partial<typeof tools> = {}): { registered: Array<{ ch: string; ex: unknown; arity: number }>; byChannel: Map<string, (input: unknown) => Promise<unknown>> } {
//     const registered: Array<{ ch: string; ex: unknown; arity: number }> = []
//     const byChannel = new Map<string, (input: unknown) => Promise<unknown>>()
//     const reg = (ch: string, ex: unknown, arity: number) => { registered.push({ ch, ex, arity }); byChannel.set(ch, ex as (input: unknown) => Promise<unknown>) }
//     registerToolHandlers({ tools: { ...tools, ...toolsOver } as never, sanitize: (x: string) => x, grants: fakeGrantStore, history: fakeHistory, auditDir: '/tmp/audit' }, reg as never)
//     return { registered, byChannel }
//   }
//   const { registered, byChannel } = setupRegister()
it('批次 C：四新通道注册 + 顺序断言扩展为九通道（F-7）', () => {
  const chs = registered.map((r) => r.ch)
  expect(chs).toEqual([IpcChannels.toolDecide, IpcChannels.toolCancel, IpcChannels.toolList, IpcChannels.toolPickSource, IpcChannels.toolConfirmUpload,
    IpcChannels.toolGrantDirectory, IpcChannels.toolGrants, IpcChannels.toolGrantRevoke, IpcChannels.toolHistory])
  expect(registered.map((r) => r.arity)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
})
it('批次 C：toolGrantDirectory ttl 非白名单 → SCHEMA_VALIDATION_FAILED（F-3）', () => {
  const res = byChannel.get(IpcChannels.toolGrantDirectory)!({ callId: 'c', ttlMs: 2 ** 53 })
  expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
  const ok = byChannel.get(IpcChannels.toolGrantDirectory)!({ callId: 'c', ttlMs: 86_400_000 })
  expect(ok).toMatchObject({ ok: true })
})
it('批次 C：toolGrantRevoke 未知 id → GRANT_NOT_FOUND；已撤销 → no-op 成功（V-28）', async () => {
  // grants fake.list 返回 [{ id: 'grant-1', ..., revokedAt: 'x' }]——handler 先查存在性（V-28 区分机制）
  const miss = await byChannel.get(IpcChannels.toolGrantRevoke)!({ id: 'nope' })
  expect(miss).toMatchObject({ ok: false, error: { code: 'GRANT_NOT_FOUND' } })
  const hit = await byChannel.get(IpcChannels.toolGrantRevoke)!({ id: 'grant-1' })
  expect(hit).toMatchObject({ ok: true })   // 已撤销 → revoke 内部 no-op 幂等成功
})
it('批次 C：toolHistory 回读接线（deps.history 调用）', async () => {
  const res = await byChannel.get(IpcChannels.toolHistory)!({ limit: 50 })
  expect(res).toMatchObject({ ok: true })
  expect(fakeHistory).toHaveBeenCalledWith('/tmp/audit', { limit: 50 })
  expect(res).toHaveProperty('data')   // historyEntrySchema 数组
})
it('批次 C：decide/cancel handler .catch 无 unhandled rejection（L-8）', async () => {
  // tools.decide reject → handler 返回结构化错误不抛（executor.ts:41-57 CyreneError lifting 既有兜底）
  const { byChannel: bc2 } = setupRegister({ decide: vi.fn().mockRejectedValue(new Error('boom')) })
  const res = await bc2.get(IpcChannels.toolDecide)!({ callId: 'c', decision: 'allow_once' })
  expect(res).toMatchObject({ ok: false })   // 错误被结构化上提，无 unhandled rejection
})

// ipc-security.spec.ts 白名单：63 → 67（补 toolGrantDirectory/toolListGrants/toolRevokeGrant/toolListHistory）
```

- [ ] **Step 2: 运行验证失败**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- ipc-tool-handlers ipc-security`
Expected: FAIL——通道不存在、白名单断言 63 vs 实际 67 不匹配。

- [ ] **Step 3: 实现**

`shared/contracts/ipc.ts` IpcChannels 追加：

```typescript
toolGrantDirectory: 'tool:grant-directory',   // 批次 C（D6C-12）
toolGrants: 'tool:grants',
toolGrantRevoke: 'tool:grant-revoke',
toolHistory: 'tool:history',
```

`shared/schemas/ipc-response.ts` 追加（task 1 的 PermissionGrantSchema 之后）：

```typescript
// —— 批次 C：grant IPC schemas（D6C-12/F-3）——
export const GrantTtlOptionsSchema = z.union([z.literal(3600_000), z.literal(86_400_000), z.literal(604_800_000), z.literal(2_592_000_000)])
export const GrantDirectorySchema = z.object({ callId: z.string().min(1), ttlMs: GrantTtlOptionsSchema }).strict()
export const GrantListResponseSchema = z.array(PermissionGrantSchema)
export const GrantRevokeSchema = z.object({ id: z.string().min(1) }).strict()
export const HistoryEntrySchema = z.object({
  ts: z.string(), type: z.string(), callId: z.string().optional(), toolId: z.string().optional(),
  status: z.string().optional(), permissionDecision: z.string().optional(), permissionGrantId: z.string().optional(),
  backendIdentity: z.string().optional(), riskLevel: z.string().optional(), cancelSource: z.string().optional(),
  errorCode: z.string().optional(), summary: z.string().optional(), toolName: z.string().optional(),
}).strict()
export const HistoryResponseSchema = z.array(HistoryEntrySchema)
export const ToolHistoryQuerySchema = z.object({ limit: z.number().int().positive().max(200).optional() }).strict()
```

`tool-handlers.ts`：

```typescript
export function registerToolHandlers(
  deps: { tools: ToolService; sanitize: MessageSanitizer; grants: import('./grant-store').GrantStore; history: (dir: string, opts: { limit?: number }) => Promise<HistoryEntry[]>; auditDir: string },
  register: typeof registerHandler = registerHandler,
): void {
  // ...既有五通道不变，decide/cancel 的 fn 包 .catch（L-8）：
  // register(IpcChannels.toolDecide, createIpcHandler(PermissionDecisionSchema, z.undefined(), async (input) => {
  //   await deps.tools.decide(input.callId, input.decision).catch((e) => { throw e })
  // }, { sanitize: deps.sanitize }), 1)
  // —— L-8 实际形态：createIpcHandler 已捕获 rejection 转结构化错误（executor.ts:41-57 CyreneError lifting）；
  //    unhandled rejection 噪音源自调用方未 await——handler 层 Promise.resolve(fn).catch 收敛见 executor 既有实现，
  //    本批在 fn 内 await + 不产生额外裸 promise（若既有 executor 已兜底则本项仅测试断言）。
  // 新四通道：
  register(IpcChannels.toolGrantDirectory, createIpcHandler(GrantDirectorySchema, z.undefined(), async (input) => {
    await deps.tools.grantDirectory(input.callId, input.ttlMs)
  }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolGrants, createIpcHandler(z.object({}).strict(), GrantListResponseSchema, async () => deps.grants.list(), { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolGrantRevoke, createIpcHandler(GrantRevokeSchema, z.undefined(), async (input) => {
    if (!deps.grants.list().some((g) => g.id === input.id)) throw new ToolServiceError('GRANT_NOT_FOUND', '授权不存在')   // V-28：未知 → 拒绝；已撤销 → revoke 内部 no-op
    deps.grants.revoke(input.id)
  }, { sanitize: deps.sanitize }), 1)
  register(IpcChannels.toolHistory, createIpcHandler(ToolHistoryQuerySchema, HistoryResponseSchema, async (input) =>
    deps.history(deps.auditDir, { limit: input.limit }), { sanitize: deps.sanitize }), 1)
}
```

`handlers.ts` 调用处补 `grants: deps.grants, history: readAuditEvents, auditDir`。

`index.ts` 装配改造（V-4 HIGH 定案 + F-4 platform 变量 + F-5 mock 身份修复）：

```typescript
// —— 批次 C（V-4）：settingsSvc 上移（settings 不依赖 toolSvc，无环）——
// 原 :269-270 的 settingsSvc 创建 + load 上移至 createToolService（:211）之前；
const settingsSvc = new SettingsService({ dir: dirs.config, safeRoot, logger })
await settingsSvc.load()
// F-4：显式定义 platform 变量（现为 :213 内联字面量，无独立变量）——顺带用于 createToolService 与 normalizeDirectory
const platform: 'posix' | 'windows' = process.platform === 'win32' ? 'windows' : 'posix'
// backendIdentity 同源闭包（V-3）：单一定义供 GrantStore + tool-service 两处注入
const backendIdentity = () => { const u = connConfig.getEndpoint(); return u ? u.origin : undefined }
// 注意：connConfig 创建于 :246（settingsSvc 之后）——backendIdentity 闭包懒求值，创建顺序无关（仅 grant 创建时调用）。
// 黑名单放宽（F-3）：toolAllowRoot 声明于 :208（toolSvc 前）——可被 GrantStore 闭包引用
const grantStore = createGrantStore({
  settings: settingsSvc,
  audit,
  normalizeDirectory: (raw) => normalizeToolPath(raw, { platform }).realPath,   // 目录存在性：dialog 只返回存在目录；失败抛 PATH_UNSAFE
  isBlacklisted: (real) => isPathBlacklisted(real) && !(toolAllowRoot ?? []).some((r) => real === r || real.startsWith(r + '/')),   // F-3：调用方放宽形态（tool-service.ts:403 同款）
  backendIdentity,
  platform,   // V-20：matches 平台门控（win32 toLowerCase / posix 直比）
  logger,
})
// createToolService 增：
//   platform,   // 替换 :213 内联字面量
//   grants: grantStore,
//   backendIdentity,
//   pickDirectory: (opts) => dialog.showOpenDialog({ properties: ['openDirectory'], title: opts.title }),   // Main 默认实现
//   queryStatus: useMock ? undefined : (callId) => adapter.getToolCallStatus(callId),   // D6C-11：mock 不注入 → 不查（Task 5 加入字段）
// env 桥（useMock 门控）：
const grantDirectoryPath = useMock ? parseMockGrantDirectoryEnv(process.env.CYRENE_MOCK_GRANT_DIRECTORY) : undefined
//   → 注入 pickDirectory: grantDirectoryPath ? async () => ({ canceled: false, path: grantDirectoryPath }) : dialog 默认
// mock backendIdentity env（N-3/V-2 惰性读取）——F-5 修复：'mock://local' 非特殊 scheme，new URL(...).origin 为 'null'，
//   不具 origin 语义——mock 身份用固定常量 'mock://local'（决策记录注明「mock 身份为固定常量非 origin」）：
//   mock 装配 backendIdentity: () => (process.env.CYRENE_MOCK_GRANT_BACKEND_IDENTITY ?? 'mock://local')
//     —— real 装配 backendIdentity 同源闭包如上；env 闭包内每次调用实时读取（V-2：集成测试中途翻转）
// registerHandlers 调用处增：grants: grantStore, history: readAuditEvents, auditDir: dirs.audit
```

`env-bridge.ts`（或 index.ts 内联）增：

```typescript
export function parseMockGrantDirectoryEnv(v: string | undefined): string | undefined {
  if (!v) return undefined
  try { const p = JSON.parse(v); return typeof p === 'string' && p.length > 0 ? p : undefined } catch { return undefined }
}
```

`preload/desktop-api.ts` 增（对齐 toolDecide 模式）：

```typescript
async function toolGrantDirectory(input: { callId: string; ttlMs: number }): Promise<void> {
  await unwrap(await invokeWithArgs(IpcChannels.toolGrantDirectory, input), z.undefined())
}
async function toolListGrants(): Promise<PermissionGrant[]> {
  return unwrap(await invokeWithArgs(IpcChannels.toolGrants, {}), GrantListResponseSchema)
}
async function toolRevokeGrant(id: string): Promise<void> {
  await unwrap(await invokeWithArgs(IpcChannels.toolGrantRevoke, { id }), z.undefined())
}
async function toolListHistory(limit?: number): Promise<HistoryEntry[]> {
  return unwrap(await invokeWithArgs(IpcChannels.toolHistory, limit === undefined ? {} : { limit }), HistoryResponseSchema)
}
// export 对象 548-553 区补四键
```

`preload/index.d.ts` + `stores/desktop-api.types.ts` 同步四键（F-5）。`ipc-security.spec.ts` 白名单 63→67（F-5/R-B11）。

- [ ] **Step 4: 运行验证通过**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- ipc-tool-handlers ipc-security && pnpm -F @cyrene/desktop typecheck`
Expected: PASS——白名单 67 键、九通道注册顺序、四新 schema 全过。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/shared/schemas/ipc-response.ts apps/desktop/src/main/ipc/tool-handlers.ts apps/desktop/src/main/ipc/handlers.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/renderer/src/stores/desktop-api.types.ts apps/desktop/tests/unit/ipc-tool-handlers.spec.ts apps/desktop/tests/integration/ipc-security.spec.ts
git commit -m "feat(阶段6批次C Task6): IPC 四通道（grant-directory/grants/grant-revoke/history）zod 双端 + settingsSvc 装配上移 + GrantStore 接线 + backendIdentity 同源闭包 + env 桥（GRANT_DIRECTORY/BACKEND_IDENTITY useMock 门控）+ preload 四方法 + 白名单 63→67 + 类型镜像"
```

---

### Task 7: Renderer——toolStore 水合/四方法 + CyToolApproval 第三入口 + CySecurityPane + 只读 Diff 卡

**Files:**
- Modify: `apps/desktop/src/shared/contracts/tool.ts`（**F-7 修复：ToolCallRecord 增 `diff?: PublicToolEvent['diff']`——现无 diff 字段，CyToolCard 只读 Diff 需契约改动**）
- Modify: `apps/desktop/src/renderer/src/stores/tool.store.ts`（init 水合 L-2/F-15 + grantDirectory/listGrants/revokeGrant/listHistory + **F-7：upsertLocal 增 `ev.diff ? record.diff = ev.diff` 同步写入 record（不经侧信道、终态不清——pendingDiff 侧信道仍保留给权限窗）**）
- Modify: `apps/desktop/src/renderer/src/components/CyToolApproval.vue`（第三入口「允许指定目录」+ TTL select + 提交禁用 L-8）
- Create: `apps/desktop/src/renderer/src/components/CySecurityPane.vue`
- Modify: `apps/desktop/src/renderer/src/components/CySettingsView.vue`（security 真页接线）
- Modify: `apps/desktop/src/renderer/src/components/CyToolCard.vue`（写 grant 命中只读 Diff 展示，F-4——用 `record.diff`（F-7 契约改动后存在））
- Modify: `apps/desktop/src/renderer/src/bootstrap.ts`（stores.tools.init 调用形态——F-9 修复：裸调用 `stores.tools?.init()` 即可，init 改 async 无需类型改动（`() => Promise<void>` 可赋值给 `(): void`））
- Create: `apps/desktop/tests/unit/cy-security-pane.spec.ts`
- Modify: `apps/desktop/tests/unit/tool.store.spec.ts`、`apps/desktop/tests/unit/cy-tool-approval.spec.ts`、`apps/desktop/tests/unit/cy-tool-card.spec.ts`（存在则增补，否则新建——只读 Diff 渲染断言）

**Interfaces:**
- Consumes: Task 6 的 preload 四方法。
- Produces: `toolStore.grantDirectory/listGrants/revokeGrant/listHistory`；CySecurityPane 三分区。Task 8 集成测试消费。

- [ ] **Step 1: 写失败测试（F-11 修复：每条 it 补最小可执行断言，禁止注释空壳）**

```typescript
// tool.store.spec.ts 追加（happy-dom）：
it('L-2 水合：init 先 await toolList 再订阅事件（F-15 定序）——水合记录归位', async () => {
  const listEv = { id: 'tc_1', desktopCallId: 'call_1', toolName: 'desktop.file.read', title: '读取文件', runtime: 'desktop' as const, status: 'awaiting_permission' as const, occurredAt: 'x' }
  setDesktopApi({ toolList: vi.fn().mockResolvedValue([listEv]), onToolEvent: vi.fn().mockReturnValue(() => {}) } as unknown as DesktopApiLike)
  await store.init()
  expect(store.records['tc_1']).toMatchObject({ status: 'awaiting_permission' })
})
it('批次 C：grantDirectory/listGrants/revokeGrant/listHistory 调 api（F-23 命名映射）', async () => {
  const api2 = { toolGrantDirectory: vi.fn(), toolListGrants: vi.fn().mockResolvedValue([]), toolRevokeGrant: vi.fn(), toolListHistory: vi.fn().mockResolvedValue([]) } as unknown as DesktopApiLike
  setDesktopApi(api2)
  await store.grantDirectory('call_1', 86_400_000)
  expect(api2.toolGrantDirectory).toHaveBeenCalledWith({ callId: 'call_1', ttlMs: 86_400_000 })
  await store.listGrants()
  expect(api2.toolListGrants).toHaveBeenCalled()
  await store.revokeGrant('g1')
  expect(api2.toolRevokeGrant).toHaveBeenCalledWith('g1')
  await store.listHistory(50)
  expect(api2.toolListHistory).toHaveBeenCalledWith(50)
})
it('F-7：upsertLocal 同步写 record.diff（终态不清——grant 命中只读 Diff 数据源）', async () => {
  const ev = { id: 'tc_1', desktopCallId: 'call_1', toolName: 'desktop.file.write', title: '写入', runtime: 'desktop' as const, status: 'completed' as const, diff: { lines: [{ kind: 'added' as const, text: 'x\n' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'f', isNewFile: false }, occurredAt: 'x' }
  setDesktopApi({ onToolEvent: vi.fn().mockReturnValue(() => {}) } as unknown as DesktopApiLike)
  await store.init()
  store.upsertLocal(ev)
  expect(store.records['tc_1']?.diff).toEqual(ev.diff)   // 终态记录保留 diff（只读 Diff 卡数据源）
})

// cy-tool-approval.spec.ts 追加（happy-dom）：
it('「允许指定目录」仅 read/write awaiting 显示（D6C-05）', async () => {
  const read = mount(CyToolApproval, { props: { open: true }, global: { plugins: [pinia] } })   // 注入 store.records awaiting read
  expect(read.find('[data-testid="approval-grant-dir"]').exists()).toBe(true)
  const cap = mount(CyToolApproval, { props: { open: true }, global: { plugins: [pinia] } })   // awaiting capture
  expect(cap.find('[data-testid="approval-grant-dir"]').exists()).toBe(false)
})
it('TTL select 默认 24h + 确认 → grantDirectory(callId, ttlMs)（F-18）', async () => {
  const spy = vi.spyOn(toolStore, 'grantDirectory').mockResolvedValue(undefined)
  const w = mount(CyToolApproval, { props: { open: true }, global: { plugins: [pinia] } })   // awaiting read 记录（既有 mount 模式）
  await w.find('[data-testid="approval-grant-dir"]').trigger('click')
  expect((w.find('[data-testid="grant-ttl-select"]').element as HTMLSelectElement).value).toBe(String(GRANT_DEFAULT_TTL_MS))   // 默认 24h
  await w.find('[data-testid="approval-grant-confirm"]').trigger('click')
  expect(spy).toHaveBeenCalledWith('call_1', 86_400_000)   // GRANT_DEFAULT_TTL_MS
})
it('提交期间禁用（L-8 防抖）', async () => {
  let resolveGrant!: () => void
  vi.spyOn(toolStore, 'grantDirectory').mockImplementation(() => new Promise((r) => { resolveGrant = r }) as never)
  const w = mount(CyToolApproval, { props: { open: true }, global: { plugins: [pinia] } })
  await w.find('[data-testid="approval-grant-dir"]').trigger('click')
  await w.find('[data-testid="approval-grant-confirm"]').trigger('click')
  expect((w.find('[data-testid="approval-grant-confirm"]').attributes() as Record<string, string | undefined>).disabled).toBeDefined()   // pending 时禁用
  resolveGrant()
  await nextTick()
  expect((w.find('[data-testid="approval-grant-confirm"]').attributes() as Record<string, string | undefined>).disabled).toBeUndefined()   // 完成恢复
})

// cy-security-pane.spec.ts（新，happy-dom）——N-6 修复：测试头完整样板（对齐 cy-tool-approval.spec.ts 头部形态）
// // @vitest-environment happy-dom
// import { describe, expect, it, vi, beforeEach } from 'vitest'
// import { mount, flushPromises } from '@vue/test-utils'
// import { nextTick } from 'vue'
// import { createPinia, setActivePinia } from 'pinia'
// import CySecurityPane from '../../src/renderer/src/components/CySecurityPane.vue'
// import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
// const api = { toolListGrants: vi.fn().mockResolvedValue([GRANT_ACTIVE]), toolListHistory: vi.fn().mockResolvedValue([HIST_ENTRY]), toolRevokeGrant: vi.fn() }
// beforeEach(() => { setActivePinia(createPinia()); setDesktopApi(api as never); vi.clearAllMocks(); api.toolListGrants.mockResolvedValue([GRANT_ACTIVE]); api.toolListHistory.mockResolvedValue([HIST_ENTRY]) })
//   GRANT_ACTIVE = { id:'g1', toolName:'desktop.file.read', scope:{directory:'/home/u/docs'}, backendIdentity:'http://localhost:8000', expiresAt: Date.now()+86400000, createdAt:'x', source:'directory' }
//   HIST_ENTRY = { ts:'2026-08-20T10:00:00Z', type:'tool:decision', toolName:'desktop.file.read', status:'completed', permissionDecision:'allow_scoped', permissionGrantId:'g1', summary:'（已脱敏摘要）' }
// ① 三分区渲染：mount → [data-testid="grants-list"] / [data-testid="history-list"] / [data-testid="command-templates-empty"] 均存在
it('三分区渲染（授权管理/审批历史/命令模板空态）', async () => {
  const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
  await flushPromises()
  expect(w.find('[data-testid="grants-list"]').exists()).toBe(true)
  expect(w.find('[data-testid="history-list"]').exists()).toBe(true)
  expect(w.find('[data-testid="command-templates-empty"]').exists()).toBe(true)
})
// ② 授权管理：活动 grant 卡片 + 后端身份（N-2）+ 撤销 → api.toolRevokeGrant
it('授权管理：活动 grant 卡片显示后端身份 + 撤销按钮 → revokeGrant(id)', async () => {
  const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
  await flushPromises()
  expect(w.find('[data-testid="grant-g1"]').exists()).toBe(true)
  expect(w.find('[data-testid="grant-backend"]').text()).toBe('http://localhost:8000')   // N-2
  await w.find('[data-testid="grant-revoke"]').trigger('click')
  await flushPromises()
  expect(api.toolRevokeGrant).toHaveBeenCalledWith('g1')
  expect(api.toolListGrants).toHaveBeenCalled()   // 刷新
})
// ③ 灰显：revokedAt 条目 is-revoked 类 + revokeSource 标注 + 无撤销按钮（F-25）
it('已撤销/已过期灰显 + revokeSource 标注 + 无撤销按钮（F-25）', async () => {
  api.toolListGrants.mockResolvedValue([{ ...GRANT_ACTIVE, id: 'g2', revokedAt: 'x', revokeSource: 'user' }])
  const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
  await flushPromises()
  expect(w.find('[data-testid="grant-g2"]').classes()).toContain('is-revoked')
  expect(w.find('[data-testid="grant-revoked-source"]').text()).toBe('已撤销')
  expect(w.find('[data-testid="grant-revoke"]').exists()).toBe(false)
})
// ④ 空态文案（授权管理）
it('授权管理空态：「暂无长期授权…」', async () => {
  api.toolListGrants.mockResolvedValue([])
  const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
  await flushPromises()
  expect(w.find('[data-testid="grants-empty"]').text()).toContain('暂无长期授权')
})
// ⑤ 审批历史：过滤按工具 + 搜索匹配 summary
it('审批历史：条目渲染 + 工具过滤 + 搜索', async () => {
  api.toolListHistory.mockResolvedValue([HIST_ENTRY, { ...HIST_ENTRY, toolName: 'desktop.file.write', ts: '2026-08-20T11:00:00Z' }])
  const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
  await flushPromises()
  expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(2)
  await w.find('[data-testid="history-tool-filter"]').setValue('desktop.file.write')
  await flushPromises()
  expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(1)
  await w.find('[data-testid="history-tool-filter"]').setValue('all')
  await w.find('[data-testid="history-search"]').setValue('脱敏')
  await flushPromises()
  expect(w.findAll('[data-testid="history-list"] li')).toHaveLength(2)   // summary 均含「脱敏」
})
// ⑥ allow_scoped 跳转撤销（F-21）：permissionGrantId 活动 → 点击 → api.toolRevokeGrant(permissionGrantId)
it('allow_scoped 条目「撤销此授权」→ revokeGrant(permissionGrantId)', async () => {
  const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
  await flushPromises()
  await w.find('[data-testid="history-jump-revoke"]').trigger('click')
  await flushPromises()
  expect(api.toolRevokeGrant).toHaveBeenCalledWith('g1')   // permissionGrantId
})
// ⑦ 命令模板空态（F-08）
it('命令模板空态文案（F-08）', async () => {
  const w = mount(CySecurityPane, { global: { plugins: [pinia] } })
  await flushPromises()
  expect(w.find('[data-testid="command-templates-empty"]').text()).toContain('未启用受控命令执行')
})

// cy-tool-card.spec.ts（新建或增补，happy-dom）——F-11c：
it('F-4 只读 Diff：completed 记录携带 diff → 渲染只读 Diff 块无确认按钮', async () => {
  const rec = { id: 'tc_1', toolName: 'desktop.file.write', runtime: 'desktop' as const, status: 'completed' as const, diff: { lines: [{ kind: 'added' as const, text: 'x\n' }], added: 1, removed: 0, truncated: false, totalLines: 1, formatNote: 'f', isNewFile: false }, startedAt: 'x' }
  const w = mount(CyToolCard, { props: { record: rec as never }, global: { plugins: [pinia] } })
  expect(w.find('[data-testid="tool-diff-readonly"]').exists()).toBe(true)
  expect(w.find('[data-testid="approval-diff"]').exists()).toBe(false)   // 无确认按钮
})
```

- [ ] **Step 2: 运行验证失败**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- tool.store cy-tool-approval cy-security-pane`
Expected: FAIL——store 无四方法、组件不存在。

- [ ] **Step 3: 实现**

`tool.store.ts`：

```typescript
// L-2/F-15：先 await 水合完毕再订阅（防旧快照覆盖新事件；水合快照 = Main 权威快照）
async function init(): Promise<void> {
  if (unsubscribeEvent) return
  const list = await api.toolList().catch(() => [])   // 水合失败 fail-open（不阻塞启动）
  for (const ev of list) if (!TERMINAL.includes(ev.status)) upsertLocal(ev)   // 非终态必水合（终态可选；upsertLocal 幂等）
  unsubscribeEvent = api.onToolEvent((ev) => upsertLocal(ev))
}
// 批次 C 四方法（F-23 命名映射）：
async function grantDirectory(callId: string, ttlMs: number): Promise<void> {
  await api.toolGrantDirectory({ callId, ttlMs })
}
async function listGrants(): Promise<PermissionGrant[]> {
  return api.toolListGrants()
}
async function revokeGrant(id: string): Promise<void> {
  await api.toolRevokeGrant(id)
}
async function listHistory(limit?: number): Promise<HistoryEntry[]> {
  return api.toolListHistory(limit)
}
// returned 增四方法；init 类型 Promise<void>（bootstrap 的 void stores.tools?.init() 兼容）
```

`bootstrap.ts`：`stores.tools?.init()` 已是 void 调用——若 `BootstrapStores.tools.init(): void` 类型签名需改为 `void | Promise<void>`（查 line 29 类型，Promise<void> 兼容 void 调用）。

`CyToolApproval.vue` 增（对齐既有按钮区）：

```vue
<!-- actions 区（61-64 现有两按钮后）增第三入口：仅 read/write -->
<button v-if="isGrantable" class="cy-approval-btn cy-approval-grant" data-testid="approval-grant-dir"
  :disabled="granting" @click="openGrantPicker = true">允许指定目录</button>
<!-- grant 选择子面板（openGrantPicker 时显示）：TTL select + 确认 -->
<div v-if="openGrantPicker" class="cy-approval-grant-box" data-testid="approval-grant-box">
  <label class="cy-approval-grant-label" for="grant-ttl">有效期</label>
  <select id="grant-ttl" data-testid="grant-ttl-select" :value="String(GRANT_DEFAULT_TTL_MS)" @change="ttlMs = Number(($event.target as HTMLSelectElement).value)">
    <option v-for="t in GRANT_TTL_OPTIONS_MS" :key="t" :value="String(t)">{{ ttlLabel(t) }}</option>
  </select>
  <button class="cy-approval-btn cy-approval-confirm" data-testid="approval-grant-confirm" :disabled="granting" @click="confirmGrant">确认授权</button>
  <button class="cy-approval-btn" data-testid="approval-grant-cancel" :disabled="granting" @click="openGrantPicker = false">取消</button>
</div>
<!-- script：isGrantable = current && (current.toolName==='desktop.file.read'||current.toolName==='desktop.file.write')；-->
<!-- ttlMs ref 初值 GRANT_DEFAULT_TTL_MS；granting ref；confirmGrant → granting=true → await toolStore.grantDirectory(cid, ttlMs) → emit('close')（失败 → 保持 open + 错误提示，granting=false）-->
<!-- ttlLabel：3600_000→'1 小时'，86_400_000→'24 小时'，604_800_000→'7 天'，2_592_000_000→'30 天' -->
```

`CySecurityPane.vue`（新建，对齐 CyLive2DPane 布局纪律 .cy-l2d-pane/.cy-l2d-group 样式复用或同构）：

```vue
<template>
  <section class="cy-security-pane" aria-label="安全与权限">
    <h3 class="cy-l2d-title">安全与权限</h3>
    <!-- ① 授权管理 -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">授权管理</h4>
      <p v-if="!grants.length" class="cy-security-empty" data-testid="grants-empty">暂无长期授权。在工具权限确认时选择「允许指定目录」可添加。授权存储在本机，可随时撤销。</p>
      <ul v-else class="cy-security-grants" data-testid="grants-list">
        <li v-for="g in grants" :key="g.id" class="cy-security-grant" :class="{ 'is-revoked': !!g.revokedAt }" :data-testid="`grant-${g.id}`">
          <span class="cy-security-grant-name">{{ g.toolName.replace('desktop.file.', '') }}</span>
          <span class="cy-security-grant-dir">{{ g.scope.directory }}</span>
          <span class="cy-security-grant-backend" data-testid="grant-backend">{{ g.backendIdentity }}</span>
          <span class="cy-security-grant-exp">{{ expiryLabel(g) }}</span>
          <span v-if="g.revokedAt" class="cy-security-grant-revoked" data-testid="grant-revoked-source">{{ g.revokeSource === 'expired' ? '已过期' : '已撤销' }}</span>
          <button v-else class="cy-security-btn" data-testid="grant-revoke" @click="revoke(g.id)">撤销</button>
        </li>
      </ul>
    </div>
    <!-- ② 审批历史 -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">审批历史</h4>
      <div class="cy-security-filters">
        <select v-model="toolFilter" data-testid="history-tool-filter"><option value="all">全部工具</option><option value="desktop.file.read">读取</option><option value="desktop.file.write">写入</option><option value="desktop.screen.capture">截图</option></select>
        <input v-model="search" class="cy-security-search" data-testid="history-search" placeholder="搜索摘要/ID" />
      </div>
      <p v-if="!filtered.length" class="cy-security-empty" data-testid="history-empty">暂无审批历史。桌面工具执行记录将在此显示。</p>
      <ul v-else class="cy-security-history" data-testid="history-list">
        <li v-for="h in filtered" :key="h.ts + h.callId" class="cy-security-history-item">
          <span class="cy-security-history-ts">{{ fmtTs(h.ts) }}</span>
          <span class="cy-security-history-name">{{ h.toolName ?? h.type }}</span>
          <span class="cy-security-history-status">{{ h.status ?? '' }}</span>
          <span class="cy-security-history-summary">{{ h.summary ?? '' }}</span>
          <button v-if="h.permissionDecision === 'allow_scoped' && activeGrant(h.permissionGrantId)" class="cy-security-btn" data-testid="history-jump-revoke" @click="revoke(h.permissionGrantId!)">撤销此授权</button>
        </li>
      </ul>
    </div>
    <!-- ③ 命令模板空态（F-08 关闭） -->
    <div class="cy-l2d-group">
      <h4 class="cy-l2d-sub">命令模板</h4>
      <p class="cy-security-empty" data-testid="command-templates-empty">未启用受控命令执行。桌面工具仅包括文件选择/读取/写入与屏幕捕获，不支持任意命令执行。</p>
    </div>
  </section>
</template>
<!-- script setup：
  grants ref ← toolStore.listGrants()（onMounted 载入）；revoke(id) → await toolStore.revokeGrant(id) → 重新 listGrants()；
  history ref ← toolStore.listHistory(200)（onMounted）；toolFilter/search refs → filtered computed；
  activeGrant(id) → grants.some(g => g.id === id && !g.revokedAt && !isExpired(g))；
  expiryLabel：revokedAt ? 灰显来源 : `至 ${fmtTs(expiresAt)}` -->
```

`CyToolCard.vue` 增只读 Diff（F-4）：

```vue
<!-- awaiting 之外、completed 且 record.diff 存在（grant 命中自动执行路径）→ 只读 Diff 信息条 -->
<div v-if="record.diff && !isBackend" class="cy-tool-diff-readonly" data-testid="tool-diff-readonly">
  <span class="cy-tool-diff-note">{{ record.diff.formatNote }}</span>
  <pre class="cy-diff-body" data-testid="tool-diff-body"><template v-for="(l, i) in record.diff.lines" :key="i"><span :class="`cy-diff-${l.kind}`">{{ l.text }}</span></template></pre>
</div>
<!-- 注：record.diff 来自 PublicToolEvent.diff（tool:event 照常携带）——无确认按钮、纯只读展示 -->
```

`CySettingsView.vue`：`<CySecurityPane v-else-if="activeNav === 'security'" />`（插在 v-else 前，占位 div 后不再兜 security）。

- [ ] **Step 4: 运行验证通过**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test -- tool.store cy-tool-approval cy-security-pane cy-tool-card && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/stores/tool.store.ts apps/desktop/src/renderer/src/components/CyToolApproval.vue apps/desktop/src/renderer/src/components/CySecurityPane.vue apps/desktop/src/renderer/src/components/CySettingsView.vue apps/desktop/src/renderer/src/components/CyToolCard.vue apps/desktop/src/renderer/src/bootstrap.ts apps/desktop/tests/unit/tool.store.spec.ts apps/desktop/tests/unit/cy-tool-approval.spec.ts apps/desktop/tests/unit/cy-security-pane.spec.ts
git commit -m "feat(阶段6批次C Task7): Renderer——toolStore L-2 水合定序 + 四方法 + CyToolApproval 第三入口（TTL select/防抖）+ CySecurityPane 三分区（授权管理/审批历史/命令模板空态）+ CyToolCard 只读 Diff 卡 + CySettingsView security 真页"
```

---

### Task 8: 集成测试 + 门禁收口 + 文档同步 + 决策记录

**Files:**
- Modify: `apps/desktop/tests/integration/electron-tools.spec.ts`（增 7 用例）
- Modify: `docs/02`、`docs/03`、`docs/04`、`docs/06`、`docs/07`、`docs/11`、`docs/12`、`docs/16`、`docs/13`、`README.md`、`CLAUDE.md`（spec §5 表）
- Create: `docs/review/2026-08-20-阶段6批次C-决策记录.md`

**Interfaces:**
- Consumes: Task 1~7 全部。
- Produces: 验收证据 + 三态结论（已开发、未联调）。

- [ ] **Step 1: 写失败集成测试（electron-tools.spec.ts 追加 7 用例——F-11 修复：每条含可执行断言，read 闭环为完整参照）**

```typescript
// 对齐既有 helper：connectAndActivateFirst/sendMessage/probeStatus/launchApp + env 注入
// 新增 env：CYRENE_MOCK_GRANT_DIRECTORY（单 JSON 字符串路径）+ CYRENE_MOCK_GRANT_BACKEND_IDENTITY（N-3）
// FIXTURE_GRANT_DIR = '/tmp/cyrene-fixtures'（与 allowRoots 同根——fixture 目录在黑名单 /tmp 内，经 allowRoots 放宽 + grant 目录授权）

it('目录授权闭环（read）：允许指定目录 → 自动执行 + audit allow_scoped；再次触发同目录 read 无权限窗（D6C-05/F-1）', async () => {
  const launched = await launchApp(undefined, { env: {
    CYRENE_MOCK_TOOL_FLOW: JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.read', arguments: { path: FIXTURE } } }),
    CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
    CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
  } })
  const { page } = launched
  await connectAndActivateFirst(page)
  await sendMessage(page)   // 第一次 → 权限窗
  await page.waitForSelector('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-confirm"]')
  await page.waitForSelector('[data-testid="tool-status"]')
  // 卡片「执行完成」；再次发送 → 无权限窗自动执行
  await sendMessage(page)
  await page.waitForTimeout(500)
  expect(await page.locator('[data-testid="tool-approval"]').count()).toBe(0)
  expect(await probeStatus(page)).toMatchObject({ status: 'completed' })
  // wire 断言：mock lastToolStatus 至少 result（grant 自动执行路径）
  const last = await launched.app.evaluate(() => globalThis.__cyreneMainProbe.getLastToolStatus?.())
  expect(['result', 'running']).toContain(last?.status)
})
it('目录授权闭环（write + 只读 Diff，F-11 一致 a）：授权写目录 → 再次 write 无权限窗 + 卡片只读 Diff 出现（无确认按钮）', async () => {
  const launched = await launchApp(undefined, { env: {
    CYRENE_MOCK_TOOL_FLOW: JSON.stringify({ kind: 'desktop', request: { toolName: 'desktop.file.write', arguments: { path: FIXTURE, content: 'v2\n' } } }),
    CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
    CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
  } })
  const { page } = launched
  await connectAndActivateFirst(page)
  await sendMessage(page)   // 第一次 → 权限窗 → 授权
  await page.waitForSelector('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-confirm"]')
  await page.waitForSelector('[data-testid="tool-status"]')
  await sendMessage(page)   // 第二次 → grant 命中自动执行
  await page.waitForTimeout(500)
  expect(await page.locator('[data-testid="tool-approval"]').count()).toBe(0)   // 无权限窗
  expect(await page.locator('[data-testid="tool-diff-readonly"]').count()).toBeGreaterThan(0)   // 只读 Diff 卡
  expect(await page.locator('[data-testid="approval-diff"]').count()).toBe(0)   // 无确认按钮
})
it('授权撤销：建立 grant → 设置页撤销 → 再次触发 read 权限窗重新出现 + wire 断言', async () => {
  const launched = await launchApp(undefined, { env: { /* 同 read 闭环 env */ } })
  const { page } = launched
  await connectAndActivateFirst(page)
  await sendMessage(page)
  await page.waitForSelector('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-confirm"]')
  await page.waitForSelector('[data-testid="tool-status"]')
  // 打开设置 → security → 撤销
  // （打开设置入口——查既有集成测试打开 CySettingsView 的模式，如点击设置按钮/快捷键；按既有模式写）
  await page.click('[data-testid="settings-open"]')   // 按实际入口 testid 调整
  await page.click('[data-testid="nav-security"]')
  await page.waitForSelector('[data-testid="grant-revoke"]')
  await page.click('[data-testid="grant-revoke"]')
  await page.click('[data-testid="settings-close"]')   // 按实际入口调整
  await sendMessage(page)   // 再触发
  await page.waitForSelector('[data-testid="tool-approval"]')   // 权限窗重新出现
  const last = await launched.app.evaluate(() => globalThis.__cyreneMainProbe.getLastToolStatus?.())
  expect(last?.status).not.toBe('result')   // 未自动执行
})
it('审批历史查看器（含历史跳转撤销完整链，F-21）：事件出现 + 过滤 + 跳转撤销 → grant 失效', async () => {
  // 建立 grant（同 read 闭环：发送 → 权限窗 → 允许指定目录 → 确认）→ 至少一次 tool:decision 事件入审计
  const launched = await launchApp(undefined, { env: {
    CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
    CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
    CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
  } })
  const { page } = launched
  await connectAndActivateFirst(page)
  await sendMessage(page)
  await page.waitForSelector('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-confirm"]')
  await page.waitForSelector('[data-testid="tool-status"]')
  // 打开设置 → security → 审批历史
  await page.click('[data-testid="settings-open"]')
  await page.click('[data-testid="nav-security"]')
  const items = await page.locator('[data-testid="history-list"] li').count()
  expect(items).toBeGreaterThan(0)   // tool:decision 事件出现
  // 过滤按工具（全部/read/write/capture select）→ read 过滤后条目 ≥1
  await page.selectOption('[data-testid="history-tool-filter"]', 'desktop.file.read')
  await page.waitForTimeout(200)
  expect(await page.locator('[data-testid="history-list"] li').count()).toBeGreaterThan(0)
  // allow_scoped 条目「撤销此授权」点击 → grant 失效 → 再触发 read → 权限窗重新出现
  await page.click('[data-testid="history-jump-revoke"]')
  await page.waitForTimeout(300)
  await page.click('[data-testid="settings-close"]')
  await sendMessage(page)
  await page.waitForSelector('[data-testid="tool-approval"]')   // 撤销后权限窗重新出现
})
it('命令模板空态（F-08 关闭）', async () => {
  const launched = await launchApp(undefined, { env: {} })   // 无需工具 flow
  const { page } = launched
  await connectAndActivateFirst(page)
  await page.click('[data-testid="settings-open"]')
  await page.click('[data-testid="nav-security"]')
  const empty = await page.locator('[data-testid="command-templates-empty"]').textContent()
  expect(empty).toContain('未启用受控命令执行')
})
it('黑名单目录拒：mock pickDirectory 返回 /etc → 确认后卡片保持 awaiting + 无 grant 落盘', async () => {
  const launched = await launchApp(undefined, { env: {
    CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
    CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
    CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify('/etc'),   // 黑名单目录
  } })
  const { page } = launched
  await connectAndActivateFirst(page)
  await sendMessage(page)
  await page.waitForSelector('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-confirm"]')
  await page.waitForTimeout(500)
  // 卡片保持 awaiting（grant add 抛 PATH_BLOCKLISTED → IPC 结构化错误，不关闭权限窗）
  const pending = await page.evaluate(() => globalThis.__cyreneTest.getPermissionPending())
  expect(pending).not.toBeNull()
})
it('后端身份不匹配（N-3）：授权后翻转 CYRENE_MOCK_GRANT_BACKEND_IDENTITY → 权限窗重新出现', async () => {
  const launched = await launchApp(undefined, { env: {
    CYRENE_MOCK_TOOL_FLOW: FLOW_READ,
    CYRENE_MOCK_TOOL_ALLOW_ROOT: JSON.stringify([FIXTURE_ROOT]),
    CYRENE_MOCK_GRANT_DIRECTORY: JSON.stringify(FIXTURE_ROOT),
  } })
  const { page } = launched
  await connectAndActivateFirst(page)
  await sendMessage(page)
  await page.waitForSelector('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-dir"]')
  await page.click('[data-testid="approval-grant-confirm"]')
  await page.waitForSelector('[data-testid="tool-status"]')
  // 翻转 mock 身份（V-2 惰性读取：闭包每次调用实时读 env——Main 进程 env 可经 app.evaluate 写）
  await launched.app.evaluate(() => { (process.env as Record<string, string | undefined>).CYRENE_MOCK_GRANT_BACKEND_IDENTITY = 'http://other' })
  await sendMessage(page)
  await page.waitForSelector('[data-testid="tool-approval"]')   // 身份不匹配 → 权限窗重新出现
  // 测试末复位（V-2 隔离：防残留 grant 命中后续用例）
  await launched.app.evaluate(() => { delete (process.env as Record<string, string | undefined>).CYRENE_MOCK_GRANT_BACKEND_IDENTITY })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `nvm use 22.23.0 >/dev/null && xvfb-run -a pnpm -F @cyrene/desktop test:integration`
Expected: FAIL——7 新用例未过（先修代码侧问题直至全绿；既有 104 用例不得回归）。

- [ ] **Step 3: 门禁全绿**

Run: `nvm use 22.23.0 >/dev/null && pnpm -F @cyrene/desktop test && pnpm -F @cyrene/desktop typecheck && pnpm -F @cyrene/desktop lint && pnpm -F @cyrene/desktop build && pnpm -F @cyrene/desktop check:contract`
Expected: 全绿（**REST 15/16**；WS 32/32 + 8 未纳 warn；manifest 不刷新）。

- [ ] **Step 4: 文档同步（spec §5 表逐项）**

- `docs/02` §16.2：GET tools/calls 前端实现注记 + repo 枚举 9 值表述修正 + rest-schemas 导出注记；
- `docs/03`：CySecurityPane 三分区 + CyToolApproval 第三入口 + 只读 Diff 卡；
- `docs/04`：§7.2/§7.3 授权范围落地（目录授权+有效期+撤销+后端身份绑定）；§7.4 PermissionGrant 形状改写对照表 + 「参数限制」降级为「目录范围约束」；§14 历史查看器落地 + AuditEvent permissionGrantId/toolName/backendIdentity；§8.3 只读 Diff 补注（F-4）；
- `docs/06` §14：settings.tools 子树 + GrantStore 边界；
- `docs/07` §9：后端身份绑定 + tool:grants 全路径暴露面 + backendIdentity 审计暴露注记 + settings.json 篡改即全量失守（N-8）；
- `docs/11`：「安全与权限」子树改写（授权管理/审批历史/命令模板空态；沙盒/黑名单 UI 不落地 D6B-14）；
- `docs/12`：F-08 关闭 + §9.7 批次 C 状态；
- `docs/16`：F-6 批次 C 状态 + changelog 行；
- `docs/13`：本批决策交叉 review 结论；
- `README.md`/`CLAUDE.md`：阶段 6 批次 C 状态 + 测试计数（三态 = 已开发、未联调）。

- [ ] **Step 5: 决策记录 `docs/review/2026-08-20-阶段6批次C-决策记录.md`**

内容：D6C-01~13 定案表（含 F-1~F-9/N-1~N-9/可行 F-1~F-11/契约 F-1~F-11/一致 F-1~F-25/V-1~V-28 全部 review 修复记录 + 维度:编号映射 R13）+ Rulings（执行期决策）+ 门禁结果 + 三态结论 + 联调承接清单（真实 Windows Electron 联调 / GET tools/calls 真实链路 / paramHash 浮点复核 / capture 真实 desktopCapturer）。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/tests/integration/electron-tools.spec.ts docs/02-Cyrene-前后端通信协议与前端数据结构-v0.2.md docs/03-Cyrene-UI与交互设计-v0.2.md docs/04-Cyrene-Desktop工具与权限交互设计-v0.2.md docs/06-Cyrene-状态管理与本地存储-v0.2.md docs/07-Cyrene-安全设计-v0.2.md docs/11-Cyrene-设置中心详细设计-v0.2.md docs/12-Cyrene-前端开发启动清单与分阶段实施计划-v0.1.md docs/13-Cyrene-前端文档交叉Review与修订记录-v0.1.md docs/16-Cyrene-前端实施任务清单与进度跟踪.md README.md CLAUDE.md docs/review/2026-08-20-阶段6批次C-决策记录.md
git commit -m "feat(阶段6批次C Task8): 集成测试 7 用例（目录授权 read/write/撤销/历史跳转撤销/空态/黑名单拒/身份不匹配）+ 门禁收口 + 文档同步（doc02/03/04/06/07/11/12/13/16 + README/CLAUDE）+ 决策记录（三态=已开发、未联调）"
```

---

## 执行纪律

- 每 task 完成后跑 `pnpm -F @cyrene/desktop typecheck` + 相关 spec 测试；Task 8 收口全门禁。
- **空壳测试禁止（F-11/F-7）：所有新 `it()` 必须有至少 1 个可执行 `expect` 断言——注释规格不算测试；Step 4「运行验证通过」前检查无空体用例。**
- 偏离 §0 决策 → 按推荐执行 → 记入决策记录 → 最终报告汇报。
- spec/plan review 上限 20 轮；最终 commit review 上限 5 轮。
- 本批体积 ≈ 批次 B（F-24）：八 task 按五段分组（Task 1~2 授权子系统契约与仓库 → Task 3~4 决策链与收口 → Task 5 GET/reconnect → Task 6~7 Main/Renderer 接线与 UI → Task 8 集成与文档）。
- 集成测试失败首查：`connectAndActivateFirst` 缺失 / env 格式（JSON 数组 vs 单值）/ `__cyreneMainProbe` 断言对象形状——对齐批次 B Task 8 教训。
- mock 身份 `'mock://local'` 为固定常量（非 origin 语义——F-5 修复；决策记录注明）。
