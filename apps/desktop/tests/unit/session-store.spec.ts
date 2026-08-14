// tests/unit/session-store.spec.ts —— spec §4.4.2/§4.5/§5：草稿配额/淘汰告知/快照去重封顶/top-20/损坏隔离/字节预算/不写正文日志。
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionStore } from '../../src/main/persistence/session-store'
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

  it('不写草稿/消息正文到日志（spy logger 断言无文本）', async () => {
    env = await makeStore()
    await env.s.persistSession({ conversationId: 'c1', draft: { text: 'SECRET_DRAFT_ABC', updatedAt: 't' }, scrollAnchor: null })
    const joined = [...env.logger.info.mock.calls, ...env.logger.warn.mock.calls, ...env.logger.error.mock.calls].map((c) => JSON.stringify(c)).join('\n')
    expect(joined).not.toContain('SECRET_DRAFT_ABC')
  })
})
