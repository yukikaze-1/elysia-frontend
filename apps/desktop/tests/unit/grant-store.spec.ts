// tests/unit/grant-store.spec.ts（node；settings mock + 注入 now/normalizeDirectory/isBlacklisted/backendIdentity）
// F-4 修复：mkSettings.load 用「同步可读 thenable」——createGrantStore 构造期 eager load 同步填充缓存，
// 测试无需 await（与 tool-service step 8 的同步 matches 用法一致）。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { createGrantStore } from '../../src/main/tools/grant-store'
import type { PermissionGrant } from '../../src/shared/contracts/tool'
import type { SettingsService } from '../../src/main/settings/settings-service'
import type { AuditEvent } from '../../src/main/diagnostics/audit'

/** "任意字符串" 非对称匹配器：vitest 把 `expect.any` 的返回类型声明成 `any`，放进 `PermissionGrant`
 *  这类具名契约会命中 no-unsafe-assignment；运行时 `expect.any(String)` 就是这个匹配器，故收窄到 string。 */
const anyString = (): string => expect.any(String) as string

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
  // 审计回调按 GrantStoreDeps 的真实签名 `(ev: AuditEvent) => void` 标注——裸 `vi.fn()` 的调用实参是 `any`
  const audit: Mock<(ev: AuditEvent) => void> = vi.fn()
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
function grant(over: Partial<PermissionGrant> = {}): PermissionGrant {  return { id: 'grant-a', toolName: 'desktop.file.read', scope: { directory: '/home/u/docs' },
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
      type: 'grant:created', permissionGrantId: g.id, backendIdentity: 'http://localhost:8000'
    }))
    const createdAudit = audit.mock.calls[0][0]
    expect(createdAudit.summary).toContain('目录授权（工具 desktop.file.read，有效期至')   // 原为 expect.stringContaining——vitest 把它的返回类型声明成 any
    expect(createdAudit.summary).not.toContain('/home/u')   // F-5：无目录路径
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
  it('matches：Windows 大小写不敏感 + 反斜杠分隔符（F-13/V-20/FINAL-HIGH——真实 Windows 路径形状）', () => {
    // V-20 修复：不再恒 toLowerCase（posix 上大小写不同的真实目录不得互相命中）——matches 按 deps.platform 选择比较器
    // FINAL-HIGH 修复：Windows canonical 路径为反斜杠（path.win32.resolve/realpathSync.native 产物）——分隔符按平台取，
    //   硬编码 '/' 使 C:\...\a.txt.startsWith(C:\... + '/') 恒 false（子目录匹配全断）
    const win = mkStore([], 'http://h', 'windows')
    win.store.add({ toolName: 'desktop.file.read', scope: { directory: 'C:\\Users\\Me\\Docs' }, backendIdentity: 'http://h', expiresAt: now + 1000, source: 'directory' })
    expect(win.store.matches('desktop.file.read', 'c:\\users\\me\\docs\\a.txt')).toBeDefined()   // win32 大小写不敏感 + 反斜杠子目录命中
    expect(win.store.matches('desktop.file.read', 'c:\\users\\me\\docs')).toBeDefined()          // 等于目录命中
    expect(win.store.matches('desktop.file.read', 'c:\\users\\me\\docs2\\a.txt')).toBeUndefined()   // 段边界不误配
    expect(win.store.matches('desktop.file.read', 'C:\\Users\\Me\\Docs2\\a.txt')).toBeUndefined()
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
    // F-2 负方向：backendIdentity() undefined → 恒不匹配（fail-safe）。
    // 注：JS 默认参数在显式传 undefined 时仍生效（mkStore 第二参缺省 'http://localhost:8000'）——故此处绕过 mkStore
    // 直接构造（backendIdentity: () => undefined），对齐 symlink / save fail-open 用例的直构夹具形态。
    const none = createGrantStore({ settings: mkSettings([grant()]), audit: vi.fn(),
      normalizeDirectory: (raw) => raw.replace(/\/+$/, ''), isBlacklisted: () => false,
      backendIdentity: () => undefined, now: () => now, logger: { warn: vi.fn() } })
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
    expect(store.list().find((g) => g.id === 'grant-exp')).toMatchObject({ revokedAt: anyString(), revokeSource: 'expired' })  })
  it('revoke（N-5/F-9）：未过期 → user 分支；已过期 → expired 分支；已撤销 → no-op 不覆写不重复审计', () => {
    const { store, audit } = mkStore([grant()])
    const r1 = store.revoke('grant-a')
    expect(r1).toMatchObject({ revokeSource: 'user', revokedAt: anyString() })
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
