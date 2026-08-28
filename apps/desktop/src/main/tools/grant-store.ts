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
    && x.source === 'directory'   // FINAL-LOW：与 PermissionGrantSchema literal 对齐——缺 source 的 grant 不装载（否则 tool:grants 响应校验整体拒、设置页授权管理击穿）
    && (x.revokeSource === undefined || x.revokeSource === 'user' || x.revokeSource === 'expired')   // 二值枚举对齐
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
    catch (e) { deps.logger?.warn('grant:save-failed', { message: e instanceof Error ? e.message : String(e) }) }   // C-10：非 Error 抛掷归一；fail-open
  }

  function auditGrant(type: string, grant: PermissionGrant, extra: Record<string, unknown> = {}): void {
    deps.audit({ ts: new Date().toISOString(), type, runtime: 'desktop', toolId: grant.id, toolName: grant.toolName,
      permissionGrantId: grant.id, backendIdentity: grant.backendIdentity, ...extra })   // 去强转：AuditEvent 扩展后字段全兼容（Task 3 F-3）
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
    // V-20/FINAL-HIGH：平台门控比较（对齐 tool-policy.ts:36 先例）——win32 toLowerCase + 反斜杠分隔符、
    // posix 直比 + 正斜杠（防 posix 大小写不同目录互相命中；Windows canonical 路径为反斜杠，硬编码 '/' 恒不命中）
    const sep = deps.platform === 'windows' ? '\\' : '/'
    const eq = deps.platform === 'windows'
      ? (a: string, b: string) => { const la = a.toLowerCase(); const lb = b.toLowerCase(); return la === lb || la.startsWith(lb + sep) }
      : (a: string, b: string) => a === b || a.startsWith(b + sep)
    return grants.find((g) => !g.revokedAt && g.expiresAt > now() && g.toolName === toolName
      && g.backendIdentity === identity
      && eq(realPath, g.scope.directory))   // 目录段边界（等于或以目录+分隔符开头）
  }

  return { list, add, revoke, matches, prune }
}
