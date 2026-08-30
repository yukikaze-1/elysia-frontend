// 多角色 FE-A：会话/消息角色快照 wire 兼容 + 事件解析 + frame-mapper 映射。
// 退出条件（设计 §17 前端A）：前端能严格接纳新 optional 字段，也能读取旧 fixture（无 character 字段全通过）；
// 旧 UI 不回归由既有全套 spec 保证，此处锁定 wire→领域兼容面。
import { describe, expect, it } from 'vitest'
import { parseRestSessions, parseRestMessage } from '../../src/main/transport/protocol-v2/rest-schemas'
import { parseRawFrame } from '../../src/main/transport/protocol-v2/raw-schemas'
import { parseBackendEvent } from '../../src/shared/schemas/events'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import type { CharacterCatalogChangedEvent, CharacterStateChangedEvent, GenerationStartedEvent } from '@shared/contracts/events'
import type { RestCharacterBindingSnapshot } from '../../src/main/transport/protocol-v2/character-rest-types'

const snapshot: RestCharacterBindingSnapshot = {
  characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2,
  displayName: 'Elysia', presentation: { themeColor: '#ff88aa' }
}

const legacySummary = { conversationId: 'conv-1', title: '旧会话', messageCount: 3, updatedAt: '2026-08-30T00:00:00.000Z', active: true }
const legacyMessage = {
  role: 'assistant', content: '你好', message_id: 'msg-1',
  timestamp: '2026-08-30T00:00:00.000Z', session_id: 'conv-1'
}

describe('REST session summary / message 的 character 快照（CHAR-FE-06/07）', () => {
  it('legacy fixture（无 character）照常通过；带合法 character 通过', () => {
    expect(parseRestSessions({ sessions: [legacySummary], has_more: false }).success).toBe(true)
    expect(parseRestSessions({ sessions: [{ ...legacySummary, character: snapshot }], has_more: false }).success).toBe(true)
    expect(parseRestMessage(legacyMessage).success).toBe(true)
    expect(parseRestMessage({ ...legacyMessage, character: snapshot }).success).toBe(true)
  })
  it('快照缺失字段/revision=0/未知键拒绝（fail-closed）', () => {
    const bad = { characterId: 'ch', characterInstanceId: 'ci', displayName: 'x', presentation: {} } // 缺 characterRevision
    expect(parseRestSessions({ sessions: [{ ...legacySummary, character: bad }], has_more: false }).success).toBe(false)
    expect(parseRestSessions({ sessions: [{ ...legacySummary, character: { ...snapshot, characterRevision: 0 } }], has_more: false }).success).toBe(false)
    expect(parseRestSessions({ sessions: [{ ...legacySummary, character: { ...snapshot, bogus: 1 } }], has_more: false }).success).toBe(false)
  })
  it('mapper：toConversation 携带领域绑定快照；无 character 不产键', () => {
    const mapper = new RestMapper()
    const withChar = mapper.toConversation({ ...legacySummary, character: snapshot })
    expect(withChar.character).toEqual({
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2,
      displayName: 'Elysia', presentation: { themeColor: '#ff88aa' }
    })
    const without = mapper.toConversation(legacySummary)
    expect('character' in without).toBe(false)
  })
  it('mapper：assemble 消息自带快照 → Message.character（CharacterGenerationRef）', () => {
    const mapper = new RestMapper()
    const msg = mapper.toDomainMessage({ ...legacyMessage, character: snapshot } as never, 'conv-1')
    expect(msg.character).toEqual({
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2,
      displayName: 'Elysia', presentation: { themeColor: '#ff88aa' }
    })
    const legacy = mapper.toDomainMessage(legacyMessage as never, 'conv-1')
    expect('character' in legacy).toBe(false)
  })
})

describe('WS 回放消息 character 快照（raw session 帧）', () => {
  it('legacy fixture 通过；带快照通过；未知键拒绝', () => {
    // raw session item 无 session_id（REST 专有字段，strict 会拒）——WS 形状独立构造
    const wsMessage = { role: 'assistant', content: '你好', message_id: 'msg-1', timestamp: '2026-08-30T00:00:00.000Z' }
    const base = { type: 'session' as const, conversationId: 'conv-1', messages: [wsMessage] }
    expect(parseRawFrame(base).success).toBe(true)
    expect(parseRawFrame({ ...base, messages: [{ ...wsMessage, character: snapshot }] }).success).toBe(true)
    expect(parseRawFrame({ ...base, messages: [{ ...wsMessage, character: { ...snapshot, bogus: 1 } }] }).success).toBe(false)
  })
})

describe('generation 事件角色身份（CHAR-FE-08）', () => {
  it('legacy generation.started（无身份）照常通过；带身份通过；revision=0 拒绝', () => {
    const legacy = { eventId: 'e1', sequence: 1, event: 'generation.started', generationId: 'g1', messageId: 'm1', responseId: 'g1', conversationId: 'c1' }
    expect(parseBackendEvent(legacy).success).toBe(true)
    const withId = { ...legacy, characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2 }
    const parsed = parseBackendEvent(withId)
    expect(parsed.success).toBe(true)
    expect(parseBackendEvent({ ...legacy, characterRevision: 0 }).success).toBe(false)
  })
  it('frame-mapper：started/completed/failed 身份透传（undefined 不写键）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const started = mapper.mapFrame({
      type: 'generation.started', generationId: 'g1', messageId: 'm1', conversationId: 'c1',
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2
    }) as GenerationStartedEvent
    expect(started.characterId).toBe('ch_elysia')
    expect(started.characterInstanceId).toBe('ci_1')
    expect(started.characterRevision).toBe(2)
    const legacy = mapper.mapFrame({ type: 'generation.started', generationId: 'g2', messageId: 'm2', conversationId: 'c1' }) as GenerationStartedEvent
    expect('characterId' in legacy).toBe(false)
  })
})

describe('character.state.changed / character.catalog.changed（§7.1/CHAR-FE-09）', () => {
  it('frame-mapper：state.changed 完整 view 映射，null 归一 undefined', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({
      type: 'character.state.changed', conversationId: 'c1',
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2, stateVersion: 8,
      state: { mood: null, currentActivity: null, lastInteractionAt: null, proactiveEnabled: false, updatedAt: 't' }
    }) as CharacterStateChangedEvent
    expect(ev.event).toBe('character.state.changed')
    expect(ev.stateVersion).toBe(8)
    expect('mood' in ev.state).toBe(false)
    expect('currentActivity' in ev.state).toBe(false)
    expect(ev.sequence).toBeGreaterThan(0)
  })
  it('frame-mapper：catalog.changed 直映', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({
      type: 'character.catalog.changed', characterId: 'ch_1', currentRevision: 3, status: 'archived', updatedAt: 't'
    }) as CharacterCatalogChangedEvent
    expect(ev).toMatchObject({ event: 'character.catalog.changed', characterId: 'ch_1', currentRevision: 3, status: 'archived' })
  })
  it('parseRawFrame：新帧 strict 校验——intensity 越界/未知键/revision=0 拒绝', () => {
    expect(parseRawFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 1,
      state: { mood: { label: '开心', intensity: 1.5, updatedAt: 't' }, proactiveEnabled: true, updatedAt: 't' }
    }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 0, stateVersion: 1, state: { proactiveEnabled: true, updatedAt: 't' }
    }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.catalog.changed', characterId: 'ch', currentRevision: 1, status: 'hidden', updatedAt: 't'
    }).success).toBe(false)
  })
  it('parseBackendEvent：领域事件经 IPC schema 校验通过（state 为完整 view）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 2,
      state: { mood: { label: '平静', intensity: 0.2, updatedAt: 't' }, proactiveEnabled: false, updatedAt: 't' }
    })
    expect(ev).not.toBeNull()
    expect(parseBackendEvent(ev).success).toBe(true)
  })
})
