// tests/unit/session-store.spec.ts —— spec §4.4.2/§4.5/§5：草稿配额/淘汰告知/快照去重封顶/top-20/损坏隔离/字节预算/不写正文日志。
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore, describeSchemaProblem } from '../../src/main/persistence/session-store'
import { toWriteFailure } from '../../src/main/persistence/write-failure'
import { CyreneError, CyreneErrorCode } from '@shared/errors'
import type { Conversation, Message } from '@shared/contracts'

function msg(id: string, createdAt: string, extra = ''): Message {
  return { messageId: id, conversationId: 'c1', role: 'user', content: `hi${extra}`, status: 'completed', createdAt }
}
function conv(id: string, updatedAt: string): Conversation { return { id, title: id, updatedAt } }

async function makeStore(activeConv = 'c1') {
  const base = await mkdtemp(join(tmpdir(), 'cyrene-session-'))
  const safeRoot = await realpath(base)
  const counts: string[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const s = new SessionStore({
    appCache: base, safeRoot, logger: logger as never,
    countDiagnostic: (code: string) => { counts.push(code) },
    getActiveConversationId: () => activeConv
  })
  await s.load()
  return { s, base, counts, logger }
}

describe('SessionStore（spec §4.4.2/§4.5）', () => {
  let env: { s: SessionStore; base: string; counts: string[]; logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } | undefined
  afterEach(async () => { if (env) await rm(env.base, { recursive: true, force: true }); env = undefined })

  it('persistSession 写草稿+锚点，hydrate 读回一致；文件出现且含 schemaVersion', async () => {
    env = await makeStore()
    await env.s.persistSession({ conversationId: 'c1', draft: { text: '你好', updatedAt: 't1' }, scrollAnchor: { messageId: 'm1', offset: 5 } })
    const h = env.s.hydrate()
    expect(h.drafts.find((d) => d.conversationId === 'c1')?.text).toBe('你好')
    expect(h.scrollAnchors['c1']).toEqual({ messageId: 'm1', offset: 5 })
    const raw = JSON.parse(await readFile(join(env.base, 'drafts-v1.json'), 'utf8'))
    expect(raw.schemaVersion).toBe(1)
  })

  it('单草稿 UTF-8 >100KB 拒绝 DRAFT_LIMIT_EXCEEDED（权威校验，防御 untrusted renderer）', async () => {
    env = await makeStore()
    const big = '汉'.repeat(1024 * 40) // ~120KB 字节
    await expect(env.s.persistSession({ conversationId: 'c1', draft: { text: big, updatedAt: 't' }, scrollAnchor: null }))
      .rejects.toMatchObject({ code: 'DRAFT_LIMIT_EXCEEDED' })
  })

  it('>50 条目淘汰 updatedAt 最旧非激活条目，淘汰项经 evictedConversationIds 返回（P2-1）', async () => {
    env = await makeStore('keep')
    for (let i = 0; i < 52; i++) {
      const id = i === 0 ? 'keep' : `c${i}`
      await env.s.persistSession({ conversationId: id, draft: { text: `d${i}`, updatedAt: `t${String(i).padStart(3, '0')}` }, scrollAnchor: null })
    }
    const h = env.s.hydrate()
    expect(h.drafts.length).toBe(50)
    expect(h.drafts.some((d) => d.conversationId === 'keep')).toBe(true) // 激活会话不淘汰
    expect(env.counts).toContain('draft:evicted')
  })

  it('cacheMessages 逐条 MessageSchema 校验丢非法 + 计数；同 messageId 去重不重复', async () => {
    env = await makeStore()
    await env.s.cacheMessages({ conversationId: 'c1', messages: [msg('m1', 't1'), msg('m1', 't1'), { ...msg('bad', 't2'), messageId: '' }], updatedAt: 't' })
    const h = env.s.hydrate()
    expect(h.messageSnapshots['c1']).toHaveLength(1)
    expect(h.messageSnapshots['c1'][0].messageId).toBe('m1')
    expect(env.counts).toContain('cache:drop-invalid')
  })

  it('cacheMessages 整批字节 >4MiB 拒绝 IPC_MESSAGE_TOO_LARGE（P1-2）', async () => {
    env = await makeStore()
    const big = Array.from({ length: 60 }, () => msg(`m${Math.random()}`, 't', 'x'.repeat(80_000))) // 60×80KB ≈ 4.8MB
    await expect(env.s.cacheMessages({ conversationId: 'c1', messages: big, updatedAt: 't' })).rejects.toMatchObject({ code: 'IPC_MESSAGE_TOO_LARGE' })
  })

  it('每会话快照 ≤300 封顶（保留最新 createdAt）；top-20 会话淘汰含快照', async () => {
    env = await makeStore()
    const many = Array.from({ length: 350 }, (_, i) => msg(`m${i}`, `t${String(i).padStart(3, '0')}`))
    await env.s.cacheMessages({ conversationId: 'c1', messages: many, updatedAt: 't' })
    expect(env.s.hydrate().messageSnapshots['c1']).toHaveLength(300)
    for (let i = 0; i < 25; i++) await env.s.syncConversationList([conv(`c${i}`, `u${i}`)])
    const h = env.s.hydrate()
    expect(h.conversations).toHaveLength(20)
    expect(h.conversations.every((c) => c.id !== 'c0')).toBe(true)
  })

  it('purgeConversation 联动清草稿+锚点+快照+缓存会话列表（评审 P2-1，syncConversationList 是并集合并不 purge 会残留）', async () => {
    env = await makeStore()
    await env.s.persistSession({ conversationId: 'c1', draft: { text: 'x', updatedAt: 't1' }, scrollAnchor: { messageId: 'm1', offset: 5 } })
    await env.s.cacheMessages({ conversationId: 'c1', messages: [msg('m1', 't1')], updatedAt: 't1' })
    await env.s.syncConversationList([conv('c1', 'u1')])
    await env.s.purgeConversation('c1')
    const h = env.s.hydrate()
    expect(h.drafts.find((d) => d.conversationId === 'c1')).toBeUndefined()
    expect(h.scrollAnchors['c1']).toBeUndefined()
    expect(h.messageSnapshots['c1']).toBeUndefined()
    expect(h.conversations.some((c) => c.id === 'c1')).toBe(false) // P2-1：缓存会话列表同步移除
  })

  it('整文件 JSON 损坏 → 隔离重建 .corrupt-<ts> + 空缓存，不抛错不阻塞', async () => {
    env = await makeStore()
    await rm(env.base, { recursive: true, force: true })
    const base2 = await mkdtemp(join(tmpdir(), 'cyrene-session2-'))
    const safeRoot2 = await realpath(base2)
    const s2 = new SessionStore({
      appCache: base2, safeRoot: safeRoot2, logger: env.logger as never,
      countDiagnostic: () => {}, getActiveConversationId: () => undefined
    })
    // P2-4：必须 mode 0600 写入——openSafeFile 在 POSIX 对 existing-read 校验权限位（0400 且无 group/other），
    // 默认 0644 会先抛 SafeOpenError（权限路径）而非 JSON.parse 失败；0600 才走真实「整文件损坏 → 隔离重建」分支
    await writeFile(join(base2, 'message-cache-v1.json'), '{ 损坏 非法 JSON', { encoding: 'utf8', mode: 0o600 })
    await s2.load()
    expect(s2.hydrate().conversations).toHaveLength(0)
    const files = await readdir(base2)
    expect(files.some((f) => f.startsWith('message-cache-v1.json.corrupt-'))).toBe(true)
    await rm(base2, { recursive: true, force: true })
  })

  it('条目级 schema 失败丢条目不污染整文件（损坏不污染）', async () => {
    env = await makeStore()
    await env.s.cacheMessages({ conversationId: 'c1', messages: [msg('ok', 't')], updatedAt: 't' })
    const raw = JSON.parse(await readFile(join(env.base, 'message-cache-v1.json'), 'utf8'))
    raw.snapshots.c1.messages.push({ messageId: '', conversationId: 'c1', role: 'user', status: 'completed', createdAt: 't' })
    // P2-4 同款：mode 0600 写入——0644 带 group/other 位会先触发 openSafeFile 权限拒绝（整文件隔离），而非逐条丢弃路径
    await writeFile(join(env.base, 'message-cache-v1.json'), JSON.stringify(raw), { encoding: 'utf8', mode: 0o600 })
    const s2 = new SessionStore({
      appCache: env.base, safeRoot: await realpath(env.base), logger: env.logger as never,
      countDiagnostic: () => {}, getActiveConversationId: () => undefined
    })
    await s2.load()
    const snap = s2.hydrate().messageSnapshots['c1']
    expect(snap).toHaveLength(1)
    expect(snap[0].messageId).toBe('ok')
  })

  it('hydrate 响应字节预算降级（超 4MiB → 截断正文保留骨架，P1-2）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-session3-'))
    const safeRoot3 = await realpath(base)
    const counts: string[] = []
    const s2 = new SessionStore({
      appCache: base, safeRoot: safeRoot3, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => undefined
    })
    // 直接注入大快照文件（绕过 cacheMessages 入参限制，构造 >4MiB 水合状态）；P2-4 同款：mode 0600 否则 openSafeFile 权限拒绝
    await writeFile(join(base, 'message-cache-v1.json'), JSON.stringify({
      schemaVersion: 1,
      conversations: [{ id: 'c1', title: 'A', updatedAt: 't' }],
      snapshots: { c1: { messages: [{ messageId: 'm1', conversationId: 'c1', role: 'user', content: 'x'.repeat(5 * 1024 * 1024), status: 'completed', createdAt: 't' }], updatedAt: 't', lastSyncAt: 't' } }
    }), { encoding: 'utf8', mode: 0o600 })
    await s2.load()
    const h = s2.hydrate()
    expect(h.messageSnapshots['c1'][0].content!.length).toBeLessThanOrEqual(2000) // ② 截断正文保留元数据
    expect(counts).toContain('hydrate:degraded')
    await rm(base, { recursive: true, force: true })
  })

  it('hydrate 草稿字节裁剪：50×100KB 草稿超 4MiB → lastActive 优先、按 updatedAt 保留最近 N + 降级计数（评审 P1-1）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-session4-'))
    const safeRoot4 = await realpath(base)
    const counts: string[] = []
    const s2 = new SessionStore({
      appCache: base, safeRoot: safeRoot4, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => 'c0'
    })
    // 直接注入 drafts 文件（50 会话 × 100KB，构造 >4MiB 草稿态；persistSession 单条 100KB 上限允许此规模）
    const entries: Record<string, { text: string; updatedAt: string }> = {}
    for (let i = 0; i < 50; i++) entries[`c${i}`] = { text: 'x'.repeat(100 * 1024), updatedAt: `t${String(i).padStart(3, '0')}` }
    await writeFile(join(base, 'drafts-v1.json'), JSON.stringify({ schemaVersion: 1, entries, scrollAnchors: {}, lastActiveConversationId: 'c0' }), { encoding: 'utf8', mode: 0o600 })
    await s2.load()
    const h = s2.hydrate()
    expect(counts).toContain('hydrate:drafts-degraded') // 降级计数（含快照降级 'hydrate:degraded'）
    expect(h.drafts.some((d) => d.conversationId === 'c0')).toBe(true) // 激活会话草稿优先保留（updatedAt 最旧但激活优先）
    expect(h.drafts.length).toBeLessThan(50) // 50×100KB=5MB → 裁到预算内
    expect(h.drafts.length).toBeGreaterThan(0)
    expect(h.drafts.length * 100 * 1024).toBeLessThanOrEqual(4 * 1024 * 1024) // 出参 ≤4MiB 不变量（近似：条数 × 100KB）
    await rm(base, { recursive: true, force: true })
  })

  it('hydrate 多会话大快照（≥2）+ 5MB 草稿 → 降级不抛错、出参 ≤4MiB（评审 P1：≥2 快照分支自引用 bug）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-session5-'))
    const safeRoot5 = await realpath(base)
    const counts: string[] = []
    const s2 = new SessionStore({
      appCache: base, safeRoot: safeRoot5, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => 'c0'
    })
    // 3 个会话各 300 条 5KB 消息（≈4.5MB 快照）+ 50×100KB 草稿（5MB）→ 远超 4MiB；≥2 快照触发降级循环（旧实现自引用 bug 在此抛 TypeError）
    const snapshots: Record<string, unknown> = {}
    for (let i = 0; i < 3; i++) {
      snapshots[`c${i}`] = {
        messages: Array.from({ length: 300 }, (_, j) => ({ messageId: `m${i}-${j}`, conversationId: `c${i}`, role: 'user' as const, content: 'x'.repeat(5 * 1024), status: 'completed' as const, createdAt: `t${i}-${j}` })),
        updatedAt: `t${i}`, lastSyncAt: `t${i}`
      }
    }
    await writeFile(join(base, 'message-cache-v1.json'), JSON.stringify({
      schemaVersion: 1,
      conversations: [{ id: 'c0', title: 'A', updatedAt: 't0' }, { id: 'c1', title: 'B', updatedAt: 't1' }, { id: 'c2', title: 'C', updatedAt: 't2' }],
      snapshots
    }), { encoding: 'utf8', mode: 0o600 })
    const entries: Record<string, { text: string; updatedAt: string }> = {}
    for (let i = 0; i < 50; i++) entries[`d${i}`] = { text: 'x'.repeat(100 * 1024), updatedAt: `td${String(i).padStart(3, '0')}` }
    await writeFile(join(base, 'drafts-v1.json'), JSON.stringify({ schemaVersion: 1, entries, scrollAnchors: {}, lastActiveConversationId: 'c0' }), { encoding: 'utf8', mode: 0o600 })
    await s2.load()
    const h = s2.hydrate() // 不得抛错
    expect(counts).toContain('hydrate:degraded')
    expect(counts).toContain('hydrate:drafts-degraded')
    expect(h.drafts.length).toBeLessThan(50)
    expect(h.drafts.length).toBeGreaterThan(0)
    const approx = h.drafts.reduce((n, d) => n + d.text.length, 0)
      + Object.values(h.messageSnapshots).reduce((n, msgs) => n + msgs.reduce((n2, m) => n2 + (m.content?.length ?? 0), 0), 0)
    expect(approx).toBeLessThanOrEqual(4 * 1024 * 1024) // 出参 ≤4MiB（近似下界，stateBytes 含元数据只会更接近上限）
    await rm(base, { recursive: true, force: true })
  })

  it('不写草稿/消息正文到日志（spy logger 断言无文本）', async () => {
    env = await makeStore()
    await env.s.persistSession({ conversationId: 'c1', draft: { text: 'SECRET_DRAFT_ABC', updatedAt: 't' }, scrollAnchor: null })
    const joined = [...env.logger.info.mock.calls, ...env.logger.warn.mock.calls, ...env.logger.error.mock.calls].map((c) => JSON.stringify(c)).join('\n')
    expect(joined).not.toContain('SECRET_DRAFT_ABC')
  })

  // —— H-11a（2026-09-11）：并发写同一文件不得丢写/失败 ——
  //
  // 本 store 有多条写同一文件的路径，而 chat-service 侧三条都是 fire-and-forget。
  // 修复前临时名固定 + 无写序列化；本轮实测 Windows 上并发写同一路径会以
  // `EPERM: operation not permitted, rename` 失败（5/20），争用在**目标文件**而非临时文件上。
  it('并发 persistSession / setActiveConversation 写同一 drafts 文件：全部成功且最终态是最新一次写', async () => {
    env = await makeStore()
    const results = await Promise.allSettled([
      env.s.persistSession({ conversationId: 'c1', draft: { text: 'a', updatedAt: 't1' }, scrollAnchor: null }),
      env.s.setActiveConversation('c1'),
      env.s.persistSession({ conversationId: 'c2', draft: { text: 'b', updatedAt: 't2' }, scrollAnchor: null }),
      env.s.setActiveConversation('c2'),
      env.s.persistSession({ conversationId: 'c3', draft: { text: 'c', updatedAt: 't3' }, scrollAnchor: null })
    ])
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected, `并发写出现失败：${rejected.map((r) => String((r as PromiseRejectedResult).reason)).join(' | ')}`).toEqual([])

    // 落盘内容必须是最后一次调用时的完整内存态（三条草稿都在，lastActive 为最后一次设置的值）
    const raw = JSON.parse(await readFile(join(env.base, 'drafts-v1.json'), 'utf8')) as {
      entries: Record<string, { text: string }>; lastActiveConversationId?: string
    }
    expect(Object.keys(raw.entries).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(raw.entries['c3'].text).toBe('c')
    expect(raw.lastActiveConversationId).toBe('c2')
  })

  it('并发 cacheMessages / syncConversationList 写同一 cache 文件：全部成功且无撕裂', async () => {
    env = await makeStore()
    const results = await Promise.allSettled([
      env.s.cacheMessages({ conversationId: 'c1', messages: [msg('m1', '2026-01-01T00:00:00Z')], updatedAt: 'u1' }),
      env.s.syncConversationList([conv('c1', 'u1'), conv('c2', 'u2')]),
      env.s.cacheMessages({ conversationId: 'c2', messages: [msg('m2', '2026-01-02T00:00:00Z')], updatedAt: 'u2' })
    ])
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected, `并发写出现失败：${rejected.map((r) => String((r as PromiseRejectedResult).reason)).join(' | ')}`).toEqual([])
    // 可解析 = 没有半截 JSON 落盘（原子替换的核心承诺）
    const raw = JSON.parse(await readFile(join(env.base, 'message-cache-v1.json'), 'utf8')) as { snapshots: Record<string, unknown> }
    expect(Object.keys(raw.snapshots).sort()).toEqual(['c1', 'c2'])
  })
})

// —— H-11b（2026-09-11）：持久化损坏路径改 fail-closed ——
// 修复前：`schemaVersion` 声明了却从不读；隔离改名失败被 `.catch(() => {})` 吞掉，
// 于是「原文件仍在磁盘上 → 内存态被清空 → 下一次击键无痕覆写」这条静默数据销毁路径成立。
describe('SessionStore 损坏路径 fail-closed（H-11b）', () => {
  async function makeRaw(base: string, counts: string[], logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
    const s = new SessionStore({
      appCache: base, safeRoot: await realpath(base), logger: logger as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => 'c1'
    })
    return { s, logger }
  }

  it('describeSchemaProblem：非对象 / 版本不符 / 兼容 三态（版本此前从不被读）', () => {
    expect(describeSchemaProblem(null)).toBe('not-an-object')
    expect(describeSchemaProblem([1, 2])).toBe('not-an-object')
    expect(describeSchemaProblem('x')).toBe('not-an-object')
    expect(describeSchemaProblem({})).toBe('schema-version-mismatch:undefined')
    expect(describeSchemaProblem({ schemaVersion: 2 })).toBe('schema-version-mismatch:2')
    expect(describeSchemaProblem({ schemaVersion: 1 })).toBeUndefined()
  })

  it('版本不符的文件被隔离而非静默当空态（原文件保留在 .corrupt-*）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-h11b-'))
    const counts: string[] = []
    // 旧/外来 schema：字段名变化正是「旧数据不迁移」决策预期的情形
    await writeFile(join(base, 'drafts-v1.json'), JSON.stringify({ schemaVersion: 99, entries: { c1: { text: '旧格式草稿', updatedAt: 't' } } }), { encoding: 'utf8', mode: 0o600 })
    const { s } = await makeRaw(base, counts)
    await s.load()
    expect(s.hydrate().drafts).toHaveLength(0)                  // 内存态重建为空
    const files = await readdir(base)
    expect(files.some((n) => n.includes('.corrupt-session-'))).toBe(true)   // 但原文件被保留
    expect(files).not.toContain('drafts-v1.json')
    await rm(base, { recursive: true, force: true })
  })

  it('隔离失败 → 进入降级态 + 拒绝写入（原文件绝不被覆写）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-h11b2-'))
    const counts: string[] = []
    const raw = JSON.stringify({ schemaVersion: 99, entries: { c1: { text: '必须保住', updatedAt: 't' } } })
    await writeFile(join(base, 'drafts-v1.json'), raw, { encoding: 'utf8', mode: 0o600 })
    const { s } = await makeRaw(base, counts)
    // 注入隔离失败（模拟 AV/备份代理/只读目录下 rename 失败）
    const isolation = (s as unknown as { isolation: { isolate(): Promise<string> } }).isolation
    isolation.isolate = async () => { throw new Error('EPERM: rename denied') }
    await s.load()
    expect(s.getLastError()?.file).toBe('drafts-v1.json')
    expect(counts).toContain('persistence:degraded')
    // 关键：拒绝写入 —— 此前会走到 writeDrafts 并把原文件覆写成空态
    await expect(s.persistSession({ conversationId: 'c1', draft: { text: '新内容', updatedAt: 't2' }, scrollAnchor: null }))
      .rejects.toThrow(/持久化已降级/)
    // 原文件逐字节未变
    expect(await readFile(join(base, 'drafts-v1.json'), 'utf8')).toBe(raw)
    await rm(base, { recursive: true, force: true })
  })
  it('未降级时 getLastError 为 undefined 且写入正常（不误报）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-h11b3-'))
    const counts: string[] = []
    const { s } = await makeRaw(base, counts)
    await s.load()
    expect(s.getLastError()).toBeUndefined()
    await s.persistSession({ conversationId: 'c1', draft: { text: 'ok', updatedAt: 't' }, scrollAnchor: null })
    expect(s.hydrate().drafts.find((d) => d.conversationId === 'c1')?.text).toBe('ok')
    expect(counts).not.toContain('persistence:degraded')
    await rm(base, { recursive: true, force: true })
  })

  // 接缝覆盖：走**真实** isolation 实现（不是注入替身），确认失败会一路传到降级态。
  // safeRoot 指向别处 → assertContained 拒绝 → isolate 上抛 → SessionStore 进入降级态。
  it('真实隔离失败（safeRoot 不含该文件）→ 降级态 + 拒绝写入（覆盖 store↔isolation 接缝）', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-h11b4-'))
    const other = await mkdtemp(join(tmpdir(), 'cyrene-h11b4-root-'))
    const counts: string[] = []
    const raw = JSON.stringify({ schemaVersion: 99, entries: { c1: { text: '必须保住', updatedAt: 't' } } })
    await writeFile(join(base, 'drafts-v1.json'), raw, { encoding: 'utf8', mode: 0o600 })
    const s = new SessionStore({
      appCache: base, safeRoot: await realpath(other), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => 'c1'
    })
    await s.load()
    expect(s.getLastError(), '真实隔离失败必须进入降级态').toBeDefined()
    expect(counts).toContain('persistence:degraded')
    await expect(s.persistSession({ conversationId: 'c1', draft: { text: '新', updatedAt: 't2' }, scrollAnchor: null }))
      .rejects.toThrow(/持久化已降级/)
    expect(await readFile(join(base, 'drafts-v1.json'), 'utf8'), '原文件逐字节未变').toBe(raw)
    await rm(base, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  })
})

// —— H-11b renderer 半边（2026-09-13）：降级/写失败必须能被 Renderer 区分并展示 ——
//
// 修复前的用户可见症状：Main 拒绝写入 → 错误码是泛化的 `UNKNOWN`（executor 兜底成「内部错误」），
// Renderer 的 `draft.store.persistNow` 又无条件 fail-open 吞掉 —— 用户看到的就是"什么都没有"，
// 直到重启才发现草稿全丢。本组用例钉住三件事：① 降级有**专属**码；② 降级态随 hydrate 出到 Renderer，
// 且**不含绝对路径**；③ 单次写失败也有专属码且不带路径。
describe('持久化故障的用户可见性（H-11b renderer 半边，2026-09-13）', () => {
  async function makeDegraded() {
    const base = await mkdtemp(join(tmpdir(), 'cyrene-h11b5-'))
    const counts: string[] = []
    const raw = JSON.stringify({ schemaVersion: 99, entries: { c1: { text: '必须保住', updatedAt: 't' } } })
    await writeFile(join(base, 'drafts-v1.json'), raw, { encoding: 'utf8', mode: 0o600 })
    const s = new SessionStore({
      appCache: base, safeRoot: await realpath(base), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      countDiagnostic: (code: string) => { counts.push(code) }, getActiveConversationId: () => 'c1'
    })
    // 注入隔离失败的真实形态（AV/备份代理/只读目录下 rename 失败）
    const isolation = (s as unknown as { isolation: { isolate(): Promise<string> } }).isolation
    isolation.isolate = async () => { throw new Error(`EPERM: rename denied, ${join(base, 'drafts-v1.json')}`) }
    await s.load()
    return { s, base, counts, raw }
  }

  it('降级拒绝写入 → 错误码是 PERSISTENCE_DEGRADED（不再是泛化 UNKNOWN）', async () => {
    const { s, base } = await makeDegraded()
    try {
      await expect(s.persistSession({ conversationId: 'c1', draft: { text: '新', updatedAt: 't2' }, scrollAnchor: null }))
        .rejects.toMatchObject({ code: 'PERSISTENCE_DEGRADED' })
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('降级态随 hydrate 出到 Renderer，且投影不含绝对路径（只给基名 + 封闭触发标签）', async () => {
    const { s, base, raw } = await makeDegraded()
    try {
      const h = s.hydrate()
      expect(h.persistenceDegraded, '降级态必须能被 Renderer 看到').toBeDefined()
      expect(h.persistenceDegraded?.file).toBe('drafts-v1.json')
      expect(h.persistenceDegraded?.reason).toBe('schema-version-mismatch:99')
      // 关键不变量（Main 是路径边界）：投影里不得出现临时根路径或盘符
      const serialized = JSON.stringify(h.persistenceDegraded)
      expect(serialized).not.toContain(base)
      expect(serialized).not.toMatch(/[/\\]{1,2}[^\s"]*[\\/]/)
      expect(serialized).not.toMatch(/[A-Za-z]:\\/)
      // 而内部诊断仍保留完整原文（含路径），两边不混淆
      expect(s.getLastError()?.reason).toContain('isolate-failed:')
      expect(s.getLastError()?.reason).toContain(base)
      // 原文件仍在磁盘上（"保现场"不是靠渲染层措辞，而是真的没写）
      expect(await readFile(join(base, 'drafts-v1.json'), 'utf8')).toBe(raw)
    } finally { await rm(base, { recursive: true, force: true }) }
  })

  it('未降级时 hydrate 不含 persistenceDegraded 字段（不误报）', async () => {
    const healthy = await makeStore()
    try {
      const h = healthy.s.hydrate()
      expect(h.persistenceDegraded).toBeUndefined()
      expect('persistenceDegraded' in h).toBe(false)
    } finally { await rm(healthy.base, { recursive: true, force: true }) }
  })

  it('真实写失败（父目录消失）→ PERSISTENCE_WRITE_FAILED，且 message 不含路径', async () => {
    const failing = await makeStore()
    const base = failing.base
    await rm(base, { recursive: true, force: true })   // 目录整体消失：atomicWriteFile 的 realpath/包含性复核失败
    let caught: unknown
    try {
      await failing.s.persistSession({ conversationId: 'c1', draft: { text: 'x', updatedAt: 't' }, scrollAnchor: null })
    } catch (e) { caught = e }
    expect(caught).toMatchObject({ code: 'PERSISTENCE_WRITE_FAILED' })
    const message = (caught as Error).message
    expect(message).not.toContain(base)
    expect(message).not.toMatch(/[/\\]/)
  })

  // 纯函数直测：把「哪些码可展示」这条纪律钉在映射函数上，而不是靠集成用例碰运气
  it('toWriteFailure：只采纳 errno 形状的码，且绝不带原文/路径', () => {
    expect(toWriteFailure(Object.assign(new Error('ENOSPC: no space left, open /tmp/x'), { code: 'ENOSPC' })))
      .toMatchObject({ code: 'PERSISTENCE_WRITE_FAILED', message: '本地保存失败（ENOSPC）' })
    expect(toWriteFailure(new Error('父目录逃逸安全根（/tmp/secret）')))
      .toMatchObject({ code: 'PERSISTENCE_WRITE_FAILED', message: '本地保存失败' })
    // 非 errno 形状的 code（含路径分隔符/小写/超长）一律不采纳，防把畸形值透出去
    for (const bad of ['/tmp/x', 'enospc', 'A'.repeat(33), 'E NOSPACE']) {
      expect((toWriteFailure(Object.assign(new Error('x'), { code: bad })) as Error).message).toBe('本地保存失败')
    }
    // 已有语义码不覆盖（配额/大小/降级各有专属码，调用方依赖它们）
    const semantic = new CyreneError(CyreneErrorCode.DRAFT_LIMIT_EXCEEDED, '草稿超过 100KB 上限')
    expect(toWriteFailure(semantic)).toBe(semantic)
  })
})
