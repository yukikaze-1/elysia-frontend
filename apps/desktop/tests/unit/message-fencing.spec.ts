// tests/unit/message-fencing.spec.ts
// `message/fencing` 的判别力测试：传输世代签名、会话身份判据、请求 owner 台账。
//
// 这是「会话 A 的响应晚到污染 B」与「上一代请求迟到解锁新一代」两类缺陷的唯一防线。
// 下沉前它只能经整棵 store 集成用例到达；现在可以逐条构造「同一会话不同连接世代」这种
// 集成用例最难摆出的组合。
//
// 注意身份台账的**唯一持有者**是 store 的 `generationSessionById`（响应式表）；本模块只提供
// 判据（`generationSessionMatches`），不另存一份——两处存储会让「这一代属于谁」出现两个答案。
import { describe, expect, it } from 'vitest'
import type { ConnectionState } from '../../src/shared/contracts'
import type { BackendFeatureFlags } from '../../src/shared/contracts/character'
import {
  connectionSignatureFor,
  createRequestOwners,
  generationSessionMatches,
  type GenerationSessionIdentity
} from '../../src/renderer/src/message/fencing'

function conn(overrides: Partial<ConnectionState> = {}): ConnectionState {
  return { status: 'connected', serverUrl: 'ws://127.0.0.1:9/ws', connectionId: 'conn-1', protocolVersion: '2', ...overrides }
}

/** 完整的能力集合（BackendFeatureFlags 两字段都必填——新连接整体替换语义）。 */
function features(characterProfiles: boolean, characterStateStream = false): BackendFeatureFlags {
  return { characterProfiles, characterStateStream }
}

describe('connectionSignatureFor：什么算「另一条消息事件流」', () => {
  it('同状态同端点同连接的两次快照 → 同一签名（重连抖动不乱清）', () => {
    expect(connectionSignatureFor(conn())).toBe(connectionSignatureFor(conn()))
  })

  it('connectionId 变化即换签名（connected → connected 的传输转世）', () => {
    expect(connectionSignatureFor(conn())).not.toBe(connectionSignatureFor(conn({ connectionId: 'conn-2' })))
  })

  it('端点 / 协议版本 / 状态 / 能力集合任一变化都换签名', () => {
    const base = connectionSignatureFor(conn())
    expect(connectionSignatureFor(conn({ serverUrl: 'ws://127.0.0.1:9/other' }))).not.toBe(base)
    expect(connectionSignatureFor(conn({ protocolVersion: '3' }))).not.toBe(base)
    expect(connectionSignatureFor(conn({ status: 'disconnected' }))).not.toBe(base)
    expect(connectionSignatureFor(conn({ features: features(true) }))).not.toBe(base)
    expect(connectionSignatureFor(conn({ features: features(false, true) }))).not.toBe(base)
  })

  it('activeConversationId 有意**不**参与签名：它是聊天选中项，不是传输转世', () => {
    const withA = conn({ activeConversationId: 'conv-a' })
    const withB = conn({ activeConversationId: 'conv-b' })
    expect(connectionSignatureFor(withA)).toBe(connectionSignatureFor(withB))
  })

  it('能力字段为 false 或缺省都归一到 false（不因 undefined/true 抖动产生假换世代）', () => {
    expect(connectionSignatureFor(conn({ features: undefined })))
      .toBe(connectionSignatureFor(conn({ features: features(false) })))
  })
})

describe('createRequestOwners：latest-wins 与 revoke', () => {
  it('新请求使旧 owner 立即失效，旧请求的 finally 不得解锁新请求（double-send 场景）', () => {
    const owners = createRequestOwners()
    const first = owners.acquire()
    const second = owners.acquire()
    expect(owners.isCurrent(first)).toBe(false)
    expect(owners.isCurrent(second)).toBe(true)
    owners.release(first)                 // 旧请求 settle
    expect(owners.isCurrent(second)).toBe(true)   // 未被误释放
  })

  it('revokeAll 后旧 owner 的 release 是幂等 no-op', () => {
    const owners = createRequestOwners()
    const owner = owners.acquire()
    owners.revokeAll()
    expect(owners.isCurrent(owner)).toBe(false)
    owners.release(owner)
    const next = owners.acquire()
    expect(owners.isCurrent(next)).toBe(true)
  })

  it('当代 owner 释放后可立即重新登记（串行重试不被永久锁死）', () => {
    const owners = createRequestOwners()
    const first = owners.acquire()
    owners.release(first)
    const second = owners.acquire()
    expect(owners.isCurrent(second)).toBe(true)
    owners.release(second)
    expect(owners.isCurrent(second)).toBe(false)
  })
})


describe('generationSessionMatches：捕获的会话身份 vs 当前会话身份', () => {
  const captured: GenerationSessionIdentity = { conversationId: 'conv-a', connectionEpoch: 1, connectionSignature: 'sig-1' }

  it('三个字段都相等 → 成立', () => {
    expect(generationSessionMatches(captured, { ...captured })).toBe(true)
    expect(generationSessionMatches(captured, captured)).toBe(true)
  })

  it('会话 A 的请求、切到 B 后响应到达 → 不成立（A 不得污染 B）', () => {
    expect(generationSessionMatches(captured, { ...captured, conversationId: 'conv-b' })).toBe(false)
  })

  it('同一会话、连接换了世代（epoch 递增）→ 不成立', () => {
    expect(generationSessionMatches(captured, { ...captured, connectionEpoch: 2 })).toBe(false)
  })

  it('同一会话、同一 epoch、签名变了（connected A → connected B）→ 不成立', () => {
    expect(generationSessionMatches(captured, { ...captured, connectionSignature: 'sig-2' })).toBe(false)
  })

  it('空会话 id 也必须逐字相等（未激活时捕获的是空串，不得与任何具体会话相配）', () => {
    const blank: GenerationSessionIdentity = { conversationId: '', connectionEpoch: 1, connectionSignature: 'sig-1' }
    expect(generationSessionMatches(blank, blank)).toBe(true)
    expect(generationSessionMatches(blank, { ...blank, conversationId: 'conv-a' })).toBe(false)
  })

  it('判据不依赖对象身份：结构相同的两个捕获值互相匹配（身份台账唯一持有者是 store）', () => {
    expect(generationSessionMatches(captured, { conversationId: 'conv-a', connectionEpoch: 1, connectionSignature: 'sig-1' })).toBe(true)
  })
})
