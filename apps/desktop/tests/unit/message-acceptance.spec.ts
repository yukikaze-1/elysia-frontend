// tests/unit/message-acceptance.spec.ts
// `message/domain` + `message/acceptance` 的判别力测试：角色身份判据与归档消息准入。
//
// 准入判据横跨三条来源（replay / REST 页 / 离线快照），任何一条放松都会让无法归属的角色快照
// 或被改写会话 id 的消息进入消息表，并随后续分页/缓存/去重一路传播。此前它只能在 store 集成里
// 用整批 fixture 间接验证。
import { describe, expect, it } from 'vitest'
import type { CharacterBindingSnapshot, Message } from '../../src/shared/contracts'
import {
  acceptArchivedMessages,
  validateMessageConversationIds,
  type ArchiveAcceptanceContext
} from '../../src/renderer/src/message/acceptance'
import { characterIdentityTuple, isCancellationCode, sameCharacterInstance } from '../../src/renderer/src/message/domain'

const BINDING: CharacterBindingSnapshot = {
  characterId: 'char-1',
  characterInstanceId: 'inst-1',
  characterRevision: 3,
  displayName: '小夜',
  presentation: {}
}

function context(profiles: boolean, binding: CharacterBindingSnapshot | undefined = BINDING): ArchiveAcceptanceContext {
  return {
    profilesEnabled: () => profiles,
    bindingFor: (conversationId) => (conversationId === 'conv-1' ? binding : undefined)
  }
}

function assistant(messageId: string, extra: Partial<Message> = {}): Message {
  return { messageId, conversationId: 'conv-1', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z', ...extra } as Message
}

describe('characterIdentityTuple：三个字段必须同时成立', () => {
  it('合法三元组原样返回', () => {
    expect(characterIdentityTuple({ characterId: 'c', characterInstanceId: 'i', characterRevision: 1 })).toEqual(['c', 'i', 1])
  })

  it.each([
    ['缺 characterId', { characterInstanceId: 'i', characterRevision: 1 }],
    ['缺 characterInstanceId', { characterId: 'c', characterRevision: 1 }],
    ['缺 characterRevision', { characterId: 'c', characterInstanceId: 'i' }],
    ['空串 characterId', { characterId: '', characterInstanceId: 'i', characterRevision: 1 }],
    ['revision 非整数', { characterId: 'c', characterInstanceId: 'i', characterRevision: 1.5 }],
    ['revision 为 0', { characterId: 'c', characterInstanceId: 'i', characterRevision: 0 }],
    ['revision 为负', { characterId: 'c', characterInstanceId: 'i', characterRevision: -1 }],
    ['revision 为 NaN', { characterId: 'c', characterInstanceId: 'i', characterRevision: Number.NaN }]
  ])('%s → undefined（fail-closed，不拿半份身份归属消息）', (_label, value) => {
    expect(characterIdentityTuple(value)).toBeUndefined()
  })
})

describe('sameCharacterInstance：不比 revision', () => {
  it('同角色同实例、不同 revision 仍算同实例（follow_latest 历史版本合法）', () => {
    expect(sameCharacterInstance(
      { characterId: 'char-1', characterInstanceId: 'inst-1' },
      { characterId: 'char-1', characterInstanceId: 'inst-1' }
    )).toBe(true)
  })

  it('跨角色或跨实例 → false', () => {
    expect(sameCharacterInstance({ characterId: 'char-2', characterInstanceId: 'inst-1' }, BINDING)).toBe(false)
    expect(sameCharacterInstance({ characterId: 'char-1', characterInstanceId: 'inst-2' }, BINDING)).toBe(false)
  })
})

describe('isCancellationCode：正式码 + legacy 兼容', () => {
  it('GENERATION_CANCELLED 与 legacy CANCELLED 都识别；其它码与 undefined 不识别', () => {
    expect(isCancellationCode('GENERATION_CANCELLED')).toBe(true)
    expect(isCancellationCode('CANCELLED')).toBe(true)
    expect(isCancellationCode('GENERATION_TIMEOUT')).toBe(false)
    expect(isCancellationCode(undefined)).toBe(false)
  })
})

describe('acceptArchivedMessages：legacy（profiles 关闭）', () => {
  it('非 assistant 与非角色消息一律原样收下', () => {
    const result = acceptArchivedMessages(context(false), [
      assistant('a1', { character: undefined }),
      { messageId: 'u1', conversationId: 'conv-1', role: 'user', createdAt: '2026-01-01T00:00:02.000Z' } as Message
    ], 'replay')
    expect(result.ok).toBe(true)
    expect(result.ok && result.messages.map((m) => m.messageId)).toEqual(['a1', 'u1'])
  })

  it('收下的是副本，调用方对象与表内对象不共享引用', () => {
    const source = assistant('a1')
    const result = acceptArchivedMessages(context(false), [source], 'replay')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0]).not.toBe(source)
    expect(result.messages[0]).toEqual(source)
  })
})

describe('acceptArchivedMessages：profiles 开启（fail-closed）', () => {
  it('合法角色快照原样收下', () => {
    const result = acceptArchivedMessages(context(true), [
      assistant('a1', { character: { characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 2 } })
    ], 'replay')
    expect(result.ok).toBe(true)
  })

  it('历史 revision 快照原样保留（不因比会话 binding 旧而拒，也不改写 revision）', () => {
    const result = acceptArchivedMessages(context(true), [
      assistant('a1', { character: { characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 1 } })
    ], 'rest')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0].character?.characterRevision).toBe(1)
  })

  it('replay/REST 缺角色快照 → 整批拒绝（远端不得凭空发明归属）', () => {
    for (const source of ['replay', 'rest'] as const) {
      const result = acceptArchivedMessages(context(true), [assistant('a1')], source)
      expect(result.ok, source).toBe(false)
      expect(!result.ok && result.reason).toBe('message.character')
    }
  })

  it('snapshot 缺角色快照 → 容忍（本地快照可早于角色归属能力落地）', () => {
    const result = acceptArchivedMessages(context(true), [assistant('a1')], 'snapshot')
    expect(result.ok).toBe(true)
  })

  it('present-but-malformed 快照在**三条来源**里一律拒（含 snapshot）', () => {
    for (const source of ['replay', 'rest', 'snapshot'] as const) {
      const result = acceptArchivedMessages(context(true), [
        assistant('a1', { character: { characterId: 'char-1', characterInstanceId: '', characterRevision: 1 } })
      ], source)
      expect(result.ok, source).toBe(false)
    }
  })

  it('跨角色 / 跨实例快照被拒（引用属于别的角色实例）', () => {
    for (const ref of [
      { characterId: 'char-2', characterInstanceId: 'inst-1', characterRevision: 3 },
      { characterId: 'char-1', characterInstanceId: 'inst-9', characterRevision: 3 }
    ]) {
      const result = acceptArchivedMessages(context(true), [assistant('a1', { character: ref })], 'replay')
      expect(result.ok, JSON.stringify(ref)).toBe(false)
    }
  })

  it('会话无绑定（binding 缺失）→ 拒：不得在未知绑定下落地一条角色消息', () => {
    // 用一个当前上下文无绑定的会话 id（bindingFor 对它返回 undefined）
    const result = acceptArchivedMessages(context(true, undefined), [
      {
        messageId: 'a1', conversationId: 'conv-unbound', role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z',
        character: { characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 3 }
      } as Message
    ], 'replay')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('message.character')
  })

  it('整批原子性：一页里夹一条坏消息 → 整批拒绝，**不**部分接受（否则会推进游标并静默丢一条）', () => {
    const result = acceptArchivedMessages(context(true), [
      assistant('good', { character: { characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 3 } }),
      assistant('bad', { character: { characterId: 'char-2', characterInstanceId: 'inst-1', characterRevision: 3 } })
    ], 'rest')
    expect(result.ok).toBe(false)
  })

  it('legacy 模式下同一批只跳过坏条、收下好条（不整批拒）', () => {
    const result = acceptArchivedMessages(context(false), [assistant('a1'), assistant('a2')], 'rest')
    expect(result.ok).toBe(true)
    expect(result.ok && result.messages).toHaveLength(2)
  })

  it('user 消息即使带畸形 character 也照收（归属只约束 assistant 归档）', () => {
    const result = acceptArchivedMessages(context(true), [
      { messageId: 'u1', conversationId: 'conv-1', role: 'user', createdAt: '2026-01-01T00:00:01.000Z', character: { characterId: 'x' } } as unknown as Message
    ], 'replay')
    expect(result.ok).toBe(true)
  })

  it('服务端给出的快照被复制：调用方事后改写原对象不影响已收下的副本', () => {
    const source = assistant('a1', { character: { characterId: 'char-1', characterInstanceId: 'inst-1', characterRevision: 2 } })
    const result = acceptArchivedMessages(context(true), [source], 'replay')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    source.character!.displayName = '被改写'
    expect(result.messages[0].character?.displayName).not.toBe('被改写')
  })
})

describe('validateMessageConversationIds：不得用信封 id 改写消息自身 id', () => {
  it('全部一致 → 通过并返回副本', () => {
    const source = assistant('a1')
    const result = validateMessageConversationIds([source], 'conv-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0]).not.toBe(source)
    expect(result.messages[0].conversationId).toBe('conv-1')
  })

  it('异会话 id → 拒（迟到异流页不得混入）', () => {
    const result = validateMessageConversationIds([assistant('a1', { conversationId: 'conv-2' })], 'conv-1')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('message.conversation')
  })

  it('空串 / 非字符串 conversationId → 拒（此前只判不一致，空串会被静默信封化）', () => {
    for (const bad of ['', undefined, 42 as unknown as string]) {
      const result = validateMessageConversationIds(
        [{ messageId: 'a1', conversationId: bad, role: 'assistant', createdAt: '2026-01-01T00:00:01.000Z' } as unknown as Message],
        'conv-1'
      )
      expect(result.ok, String(bad)).toBe(false)
    }
  })

  it('空批次 → 通过（空页是合法页，由调用方按 hasMore 处理）', () => {
    const result = validateMessageConversationIds([], 'conv-1')
    expect(result.ok).toBe(true)
    expect(result.ok && result.messages).toEqual([])
  })

  it('批次里任意一条不一致即整批拒（不留部分信封化的页）', () => {
    const result = validateMessageConversationIds([assistant('a1'), assistant('a2', { conversationId: 'conv-2' })], 'conv-1')
    expect(result.ok).toBe(false)
  })
})
