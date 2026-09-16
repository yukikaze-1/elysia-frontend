// tests/unit/conversation-domain.spec.ts
// `conversation/backend-identity` + `conversation/protocol` 的判别力测试。
//
// 两块判据此前都只在整棵 conversation store 的集成用例里被间接覆盖：
//   · 端点漂移 —— 「换后端必须清保留数据」与「瞬态重连不得清空用户正在看的会话」是一对
//     方向相反的缺陷，只有把两种状态的组合穷举出来才看得出判据是否真的分开；
//   · 协议解析 —— 坏页/坏绑定一旦半写入 items 与缓存，就会以「一条看起来正常的会话」的形态存在。
import { describe, expect, it } from 'vitest'
import type { ConnectionState, Conversation } from '../../src/shared/contracts'
import type { BackendFeatureFlags } from '../../src/shared/contracts/character'
import {
  backendIdentity,
  conversationConnectionSignature,
  createEndpointDrift
} from '../../src/renderer/src/conversation/backend-identity'
import {
  assertNoBindingConflict,
  bindingConflict,
  parseConversationPage,
  parseCreatedConversation,
  profilesEnabledFor
} from '../../src/renderer/src/conversation/protocol'

function conn(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return { status: 'connected', ...overrides }
}

/** 完整的能力集合（BackendFeatureFlags 两字段都必填——新连接整体替换语义）。 */
function features(characterProfiles: boolean, characterStateStream = false): BackendFeatureFlags {
  return { characterProfiles, characterStateStream }
}

function conversation(id: string, character?: Conversation['character']): Conversation {
  return { id, title: `t-${id}`, updatedAt: '2026-01-01T00:00:00.000Z', ...(character ? { character } : {}) }
}

function binding(overrides: Partial<NonNullable<Conversation['character']>> = {}): NonNullable<Conversation['character']> {
  return {
    characterId: 'char-1',
    characterInstanceId: 'inst-1',
    characterRevision: 3,
    displayName: '小夜',
    presentation: {},
    ...overrides
  }
}

describe('backendIdentity：事实域身份的归一化', () => {
  it('URL 身份保留 pathname 与大小写归一（同 host 不同网关不是同一域）', () => {
    expect(backendIdentity(conn({ serverUrl: 'WS://Example.COM:9000/api/' })))
      .toEqual({ key: 'url:ws://example.com:9000/api', authoritative: true })
    expect(backendIdentity(conn({ serverUrl: 'ws://example.com:9000/api' }))?.key)
      .toBe(backendIdentity(conn({ serverUrl: 'ws://example.com:9000/api/' }))?.key)
  })

  it('根路径归一为 "/"；query/fragment 不算另一个后端', () => {
    expect(backendIdentity(conn({ serverUrl: 'ws://h:1?a=1#b' }))?.key).toBe('url:ws://h:1/')
    expect(backendIdentity(conn({ serverUrl: 'ws://h:1/' }))?.key).toBe('url:ws://h:1/')
  })

  it('非法 URL → 退回非权威的连接身份（不抛错、不丢失隔离能力）', () => {
    expect(backendIdentity(conn({ serverUrl: '::not a url::', connectionId: 'c9' })))
      .toEqual({ key: 'connection:c9', authoritative: false })
  })

  it('无 URL 无 connectionId → undefined（无任何身份可用）', () => {
    expect(backendIdentity(conn({ serverUrl: '   ', connectionId: '' }))).toBeUndefined()
  })

  it('签名包含状态/连接 id/端点/角色能力，不含 activeConversationId', () => {
    const base = conversationConnectionSignature(conn({ serverUrl: 'ws://h:1', connectionId: 'c1' }))
    expect(conversationConnectionSignature(conn({ serverUrl: 'ws://h:1', connectionId: 'c1', activeConversationId: 'conv-a' }))).toBe(base)
    expect(conversationConnectionSignature(conn({ serverUrl: 'ws://h:1', connectionId: 'c2' }))).not.toBe(base)
    expect(conversationConnectionSignature(conn({ serverUrl: 'ws://h:1', connectionId: 'c1', features: features(true) }))).not.toBe(base)
  })
})

describe('createEndpointDrift：换端点清数据 vs 瞬态中间态只读', () => {
  const A = 'ws://a:1'
  const B = 'ws://b:1'

  it('首次确立权威端点且已有保留数据（出处未证）→ 清（不继承启动缓存）', () => {
    const drift = createEndpointDrift(conn({ status: 'disconnected' }))
    const cleared: string[] = []
    const didClear = drift.observe(conn({ serverUrl: A, connectionId: 'c1' }), () => true, () => cleared.push('clear'))
    expect(didClear).toBe(true)
    expect(cleared).toEqual(['clear'])
    expect(drift.known()?.key).toBe('url:ws://a:1/')
  })

  it('首次确立权威端点但无保留数据 → 不清', () => {
    const drift = createEndpointDrift(conn({ status: 'disconnected' }))
    expect(drift.observe(conn({ serverUrl: A }), () => false, () => { throw new Error('不应清') })).toBe(false)
  })

  it('权威端点未变的重连（新 connectionId、无 URL 中间态）→ 不清', () => {
    const drift = createEndpointDrift(conn({ serverUrl: A, connectionId: 'c1' }))
    expect(drift.observe(conn({ serverUrl: undefined, connectionId: 'c2' }), () => true, () => { throw new Error('不应清') })).toBe(false)
    expect(drift.observe(conn({ serverUrl: A, connectionId: 'c2' }), () => true, () => { throw new Error('不应清') })).toBe(false)
    expect(drift.known()?.key).toBe('url:ws://a:1/')
  })

  it('端点真的换了 → 清（旧后端的列表/绑定/快照不再是关于当前事实的陈述）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: A, connectionId: 'c1' }))
    expect(drift.observe(conn({ serverUrl: B, connectionId: 'c2' }), () => true, () => {})).toBe(true)
    expect(drift.known()?.key).toBe('url:ws://b:1/')
  })

  it('无 URL 中间态不得覆写已知权威端点（否则重连会被误判成无关列表）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: A, connectionId: 'c1' }))
    drift.observe(conn({ serverUrl: undefined, connectionId: 'c2' }), () => true, () => {})
    expect(drift.known()?.key).toBe('url:ws://a:1/')
  })

  it('从未有权威端点时，两个不同连接 id + 保留数据 → 清（不能假定同属一个后端）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: undefined, connectionId: 'c1' }))
    expect(drift.observe(conn({ serverUrl: undefined, connectionId: 'c2' }), () => true, () => {})).toBe(true)
  })

  it('从未有权威端点、同一连接 id 重连 → 不清（同一传输转世）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: undefined, connectionId: 'c1' }))
    // 先记录数据出处为同一连接身份（离线水合 setOfflineCache 的真实形态）
    drift.rememberData(backendIdentity(conn({ serverUrl: undefined, connectionId: 'c1' })))
    expect(drift.observe(conn({ serverUrl: undefined, connectionId: 'c1' }), () => true, () => { throw new Error('不应清') })).toBe(false)
  })

  it('从未有权威端点、保留数据出处未证（纯启动态）→ 首次连接即清', () => {
    const drift = createEndpointDrift(conn({ status: 'disconnected' }))
    expect(drift.observe(conn({ serverUrl: undefined, connectionId: 'c1' }), () => true, () => {})).toBe(true)
  })

  it('有了权威端点后，连接 id 回退不得提交数据（无 URL 的连接状态不是同一后端的证据）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: A, connectionId: 'c1' }))
    expect(drift.canCommit(backendIdentity(conn({ serverUrl: undefined, connectionId: 'c2' })))).toBe(false)
    expect(drift.canCommit(undefined)).toBe(false)
    expect(drift.canCommit(backendIdentity(conn({ serverUrl: A, connectionId: 'c1' })))).toBe(true)
  })

  it('从未有权威端点时允许连接 id 回退提交（启动期可用）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: undefined, connectionId: 'c1' }))
    expect(drift.canCommit(backendIdentity(conn({ serverUrl: undefined, connectionId: 'c1' })))).toBe(true)
  })

  it('rememberData 忽略非权威身份（一旦已知权威端点）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: A, connectionId: 'c1' }))
    // 先让数据出处变成 A —— 之后用非权威身份覆写必须无效：观察非权威状态不应触发清空
    drift.rememberData(backendIdentity(conn({ serverUrl: A })))
    drift.rememberData(backendIdentity(conn({ serverUrl: undefined, connectionId: 'c-new' })))
    expect(drift.observe(conn({ serverUrl: undefined, connectionId: 'c-new' }), () => true, () => { throw new Error('不应清') })).toBe(false)
  })

  it('绑定冲突只在可证明的同一域内比较', () => {
    const drift = createEndpointDrift(conn({ serverUrl: A }))
    const a1 = backendIdentity(conn({ serverUrl: A }))
    const a2 = backendIdentity(conn({ serverUrl: A }))
    const other = backendIdentity(conn({ serverUrl: B }))
    const connectionOnly = backendIdentity(conn({ serverUrl: undefined, connectionId: 'c1' }))
    expect(drift.canCompareBindings(a1, a2)).toBe(true)
    expect(drift.canCompareBindings(a1, other)).toBe(false)
    expect(drift.canCompareBindings(a1, connectionOnly)).toBe(false)   // 权威域不得与无 URL 回退比较
    expect(drift.canCompareBindings(undefined, a1)).toBe(false)
  })

  it('无权威端点时允许在同一传输转世内比较（未知身份互比）', () => {
    const drift = createEndpointDrift(conn({ serverUrl: undefined, connectionId: 'c1' }))
    const c1 = backendIdentity(conn({ serverUrl: undefined, connectionId: 'c1' }))
    const c2 = backendIdentity(conn({ serverUrl: undefined, connectionId: 'c2' }))
    expect(drift.canCompareBindings(c1, c2)).toBe(false)   // key 不同仍不可比
    expect(drift.canCompareBindings(c1, backendIdentity(conn({ serverUrl: undefined, connectionId: 'c1' })))).toBe(true)
  })
})

describe('bindingConflict：会话绑定不可被刷新改写', () => {
  it('同身份同 revision 同快照 → 无冲突', () => {
    expect(bindingConflict(binding(), binding())).toBeUndefined()
  })

  it('跨角色 / 跨实例 → identity', () => {
    expect(bindingConflict(binding(), binding({ characterId: 'char-2' }))).toBe('identity')
    expect(bindingConflict(binding(), binding({ characterInstanceId: 'inst-2' }))).toBe('identity')
  })

  it('revision 回退 → revision（follow_latest 只能前进）', () => {
    expect(bindingConflict(binding({ characterRevision: 5 }), binding({ characterRevision: 4 }))).toBe('revision')
  })

  it('revision 前进 → 无冲突（follow_latest 正常前进）', () => {
    expect(bindingConflict(binding({ characterRevision: 3 }), binding({ characterRevision: 4 }))).toBeUndefined()
  })

  it('同 revision 下 displayName / presentation 变化 → snapshot（不是改写既有快照的合法方式）', () => {
    expect(bindingConflict(binding(), binding({ displayName: '改名' }))).toBe('snapshot')
    expect(bindingConflict(binding(), binding({ presentation: { themeColor: '#fff' } }))).toBe('snapshot')
  })
})

describe('assertNoBindingConflict：整页校验先于合并', () => {
  it('同页重复 id → 协议错误（即使绑定完全相同）', () => {
    expect(() => assertNoBindingConflict([], [conversation('c1'), conversation('c1')], false)).toThrow(/重复会话/)
  })

  it('compareBindings=false 时不比较快照冲突（legacy 后端）', () => {
    expect(() => assertNoBindingConflict(
      [conversation('c1', binding({ characterRevision: 9 }))],
      [conversation('c1', binding({ characterRevision: 1 }))],
      false
    )).not.toThrow()
  })

  it('compareBindings=true 时冲突快照 → 协议错误，且**不**写入调用方已有的 byId 之外的状态', () => {
    expect(() => assertNoBindingConflict(
      [conversation('c1', binding({ characterRevision: 9 }))],
      [conversation('c1', binding({ characterRevision: 1 }))],
      true
    )).toThrow(/冲突的角色绑定快照/)
  })

  it('同页内后一条与前面新写入的一条冲突也会被抓住（在 incoming 内部累积比较）', () => {
    expect(() => assertNoBindingConflict(
      [],
      [conversation('c1', binding()), conversation('c1', binding({ characterId: 'char-2' }))],
      true
    )).toThrow(/重复会话/)   // 同页重复 id 先命中
  })

  it('同页不同 id、各自合法 → 不抛', () => {
    expect(() => assertNoBindingConflict([], [conversation('c1', binding()), conversation('c2', binding())], true)).not.toThrow()
  })
})

describe('parseConversationPage / parseCreatedConversation', () => {
  it('坏页（items 缺字段）→ 抛协议错误，不半写入', () => {
    expect(() => parseConversationPage({ items: [{ id: 42 }], hasMore: false }, false)).toThrow(/会话列表响应格式无效/)
  })

  it('合法页原样解析并保留 nextCursor 缺省语义', () => {
    const page = parseConversationPage({ items: [conversation('c1')], hasMore: true }, false)
    expect(page.items.map((c) => c.id)).toEqual(['c1'])
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBeUndefined()
  })

  it('角色模式下列表项缺绑定 → 抛（列表也是角色绑定协议的一部分）', () => {
    expect(() => parseConversationPage({ items: [conversation('c1')], hasMore: false }, true)).toThrow(/缺少角色绑定|格式无效/)
  })

  it('角色模式下 create 绑定的 characterId 与请求不一致 → 抛', () => {
    expect(() => parseCreatedConversation(conversation('c1', binding()), 'char-other', true)).toThrow(/与请求不一致/)
  })

  it('角色模式下 create 绑定一致 → 通过；legacy 模式不校验绑定', () => {
    expect(parseCreatedConversation(conversation('c1', binding()), 'char-1', true).id).toBe('c1')
    expect(parseCreatedConversation(conversation('c1'), undefined, false).id).toBe('c1')
  })

  it('profilesEnabledFor 只在 connected 且能力为真时为真', () => {
    expect(profilesEnabledFor(conn({ features: features(true) }))).toBe(true)
    expect(profilesEnabledFor(conn({ status: 'reconnecting', features: features(true) }))).toBe(false)
    expect(profilesEnabledFor(conn({ status: 'connected', features: features(false) }))).toBe(false)
  })
})
