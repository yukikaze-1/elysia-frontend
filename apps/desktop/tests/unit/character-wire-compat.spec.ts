// 多角色 FE-A：会话/消息角色快照 wire 兼容 + 事件解析 + frame-mapper 映射。
// 退出条件（设计 §17 前端A）：前端能严格接纳新 optional 字段，也能读取旧 fixture（无 character 字段全通过）；
// 旧 UI 不回归由既有全套 spec 保证，此处锁定 wire→领域兼容面。
import { describe, expect, it } from 'vitest'
import { parseRestSessions, parseRestMessage } from '../../src/main/transport/protocol-v2/rest-schemas'
import { parseRawFrame } from '../../src/main/transport/protocol-v2/raw-schemas'
import { parseBackendEvent } from '../../src/shared/schemas/events'
import { SessionPersistenceStateSchema } from '../../src/shared/schemas/persistence'
import { CreateConversationInputSchema } from '../../src/shared/schemas/ipc-response'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import type { AudioSessionCancelledEvent, AudioSessionReadyEvent, AudioSessionStartedEvent, CharacterCatalogChangedEvent, CharacterStateChangedEvent, ExpressionEvent, GenerationStartedEvent, Live2DDirectiveEvent } from '@shared/contracts/events'
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

describe('CreateConversationInput 角色选择（迁移期 optional）', () => {
  it('legacy 空输入与显式 characterId 均通过；未知/空白角色 ID 拒绝', () => {
    expect(CreateConversationInputSchema.safeParse({}).success).toBe(true)
    expect(CreateConversationInputSchema.safeParse({ title: '新会话', characterId: 'ch_elysia' }).success).toBe(true)
    expect(CreateConversationInputSchema.safeParse({ characterId: ' ' }).success).toBe(false)
    expect(CreateConversationInputSchema.safeParse({ characterId: 'ch_elysia', extra: true }).success).toBe(false)
  })
})

describe('REST session summary / message 的 character 快照（CHAR-FE-06/07）', () => {
  it('legacy fixture（无 character）照常通过；带合法 character 通过', () => {
    expect(parseRestSessions({ sessions: [legacySummary], has_more: false }).success).toBe(true)
    const sessions = parseRestSessions({ sessions: [{ ...legacySummary, character: snapshot }], has_more: false })
    expect(sessions.success).toBe(true)
    if (sessions.success) expect(sessions.data.sessions[0].character).toEqual(snapshot)
    expect(parseRestMessage(legacyMessage).success).toBe(true)
    const message = parseRestMessage({ ...legacyMessage, character: snapshot })
    expect(message.success).toBe(true)
    if (message.success) expect(message.data.character).toEqual(snapshot)
  })
  it('快照缺失字段/revision=0/未知键拒绝（fail-closed）', () => {
    const bad = { characterId: 'ch', characterInstanceId: 'ci', displayName: 'x', presentation: {} } // 缺 characterRevision
    expect(parseRestSessions({ sessions: [{ ...legacySummary, character: bad }], has_more: false }).success).toBe(false)
    expect(parseRestSessions({ sessions: [{ ...legacySummary, character: { ...snapshot, characterRevision: 0 } }], has_more: false }).success).toBe(false)
    expect(parseRestSessions({ sessions: [{ ...legacySummary, character: { ...snapshot, bogus: 1 } }], has_more: false }).success).toBe(false)
  })
  it('REST 会话快照镜像拒绝 CSS 全局关键字与随机命名色', () => {
    for (const themeColor of ['inherit', 'currentColor', 'randombrand']) {
      expect(parseRestSessions({
        sessions: [{ ...legacySummary, character: { ...snapshot, presentation: { themeColor } } }],
        has_more: false
      }).success).toBe(false)
    }
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
    const parsed = parseRawFrame({ ...base, messages: [{ ...wsMessage, character: snapshot }] })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.type === 'session') expect(parsed.data.messages[0].character).toEqual(snapshot)
    expect(parseRawFrame({ ...base, messages: [{ ...wsMessage, character: { ...snapshot, bogus: 1 } }] }).success).toBe(false)
  })
  it('raw 快照镜像拒绝危险命名色与全空白文本', () => {
    const wsMessage = { role: 'assistant', content: '你好', message_id: 'msg-1', timestamp: '2026-08-30T00:00:00.000Z' }
    const base = { type: 'session' as const, conversationId: 'conv-1', messages: [wsMessage] }
    expect(parseRawFrame({ ...base, messages: [{ ...wsMessage, character: { ...snapshot, displayName: ' ', presentation: { themeColor: 'inherit' } } }] }).success).toBe(false)
    expect(parseRawFrame({ ...base, messages: [{ ...wsMessage, character: { ...snapshot, presentation: { themeColor: 'randombrand' } } }] }).success).toBe(false)
  })
})

describe('generation 事件角色身份（CHAR-FE-08）', () => {
  it('legacy generation.started（无身份）照常通过；带身份通过；revision=0 拒绝', () => {
    const legacy = { eventId: 'e1', sequence: 1, event: 'generation.started', generationId: 'g1', messageId: 'm1', responseId: 'g1', conversationId: 'c1' }
    expect(parseBackendEvent(legacy).success).toBe(true)
    const withId = { ...legacy, characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2 }
    const parsed = parseBackendEvent(withId)
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.event === 'generation.started') {
      expect(parsed.data.characterId).toBe('ch_elysia')
      expect(parsed.data.characterInstanceId).toBe('ci_1')
      expect(parsed.data.characterRevision).toBe(2)
    }
    expect(parseBackendEvent({ ...legacy, characterRevision: 0 }).success).toBe(false)
    expect(parseBackendEvent({ ...legacy, revision: 2 }).success).toBe(false)
    expect(parseRawFrame({ type: 'generation.started', generationId: 'g1', messageId: 'm1', conversationId: 'c1', revision: 2 }).success).toBe(false)
  })
  it('generation.completed/failed 同样拒绝未知顶层字段与模糊 revision', () => {
    const completed = {
      eventId: 'e2', sequence: 2, event: 'generation.completed', generationId: 'g1', responseId: 'r1',
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2
    }
    const failed = {
      eventId: 'e3', sequence: 3, event: 'generation.failed', generationId: 'g1',
      error: { code: 'FAILED', message: 'bad' }, characterId: 'ch_elysia', characterRevision: 2
    }
    expect(parseBackendEvent({ ...completed, extra: true }).success).toBe(false)
    expect(parseBackendEvent({ ...failed, extra: true }).success).toBe(false)
    expect(parseBackendEvent({ ...completed, revision: 2 }).success).toBe(false)
    expect(parseBackendEvent({ ...failed, revision: 2 }).success).toBe(false)
  })
  it('与后端 wire validator 一致：角色身份允许全缺省/完整三元组，但拒绝部分三元组', () => {
    const identity = { characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2 }
    const frames: Record<string, unknown>[] = [
      { type: 'generation.started', generationId: 'g1', messageId: 'm1', ...identity },
      {
        type: 'generation.completed', generationId: 'g1', messageId: 'm1', channel: 'public_reply',
        finishReason: 'stop', usage: { rounds: [], turn_total: 0 }, model: 'model', ...identity
      },
      {
        type: 'generation.failed', generationId: 'g1', code: 'FAILED', message: 'bad', retryable: false,
        details: {}, ...identity
      },
      { type: 'expression', expression: 'happy', ...identity },
      { type: 'live2d.directive', state: 'happy', ...identity },
      { type: 'audio_start', stream_id: 7, format: 'wav', ...identity }
    ]
    for (const frame of frames) {
      expect(parseRawFrame(frame).success).toBe(true)
      for (const field of ['characterId', 'characterInstanceId', 'characterRevision']) {
        const partial = { ...frame }
        delete partial[field]
        expect(parseRawFrame(partial).success, `${String(frame.type)} missing ${field}`).toBe(false)
      }
    }
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
  it('frame-mapper：state.changed 完整 view 映射，optional null 归一 undefined', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({
      type: 'character.state.changed', conversationId: 'c1',
      characterId: 'ch_elysia', characterInstanceId: 'ci_1', characterRevision: 2, stateVersion: 8,
      state: { mood: { label: '平静', intensity: 0.2, updatedAt: '2026-08-30T00:00:00.000Z' }, currentActivity: null, lastInteractionAt: null, proactiveEnabled: false, updatedAt: '2026-08-30T00:00:00.000Z' }
    }) as CharacterStateChangedEvent
    expect(ev.event).toBe('character.state.changed')
    expect(ev.stateVersion).toBe(8)
    expect(ev.state.mood).toEqual({ label: '平静', intensity: 0.2, updatedAt: '2026-08-30T00:00:00.000Z' })
    expect('currentActivity' in ev.state).toBe(false)
    expect(ev.sequence).toBeGreaterThan(0)
  })
  it('frame-mapper：catalog.changed 直映', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({
      type: 'character.catalog.changed', characterId: 'ch_1', currentRevision: 3, status: 'archived', updatedAt: '2026-08-30T00:00:00.000Z'
    }) as CharacterCatalogChangedEvent
    expect(ev).toMatchObject({ event: 'character.catalog.changed', characterId: 'ch_1', currentRevision: 3, status: 'archived' })
    expect(parseBackendEvent({ ...ev, connectionScopeId: 'scope-a' }).success).toBe(true)
    expect(parseBackendEvent({ ...ev, connectionScopeId: '' }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.catalog.changed', characterId: 'ch_1', currentRevision: 3, status: 'archived',
      updatedAt: '2026-08-30T00:00:00.000Z', connectionScopeId: 'scope-a'
    }).success).toBe(false)
  })
  it('parseRawFrame：新帧 strict 校验——intensity 越界/未知键/revision=0 拒绝', () => {
    expect(parseRawFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 1,
      state: { mood: { label: '开心', intensity: 1.5, updatedAt: '2026-08-30T00:00:00.000Z' }, proactiveEnabled: true, updatedAt: '2026-08-30T00:00:00.000Z' }
    }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 0, stateVersion: 1, state: { proactiveEnabled: true, updatedAt: '2026-08-30T00:00:00.000Z' }
    }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.catalog.changed', characterId: 'ch', currentRevision: 1, status: 'hidden', updatedAt: '2026-08-30T00:00:00.000Z'
    }).success).toBe(false)
  })
  it('parseRawFrame：state.changed 的 mood 必填且非 null', () => {
    const base = {
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 1,
      state: { proactiveEnabled: true, updatedAt: '2026-08-30T00:00:00.000Z' }
    }
    expect(parseRawFrame(base).success).toBe(false)
    expect(parseRawFrame({ ...base, state: { ...base.state, mood: null } }).success).toBe(false)
    expect(parseRawFrame({
      ...base,
      state: { ...base.state, mood: { label: '平静', intensity: 0.2, updatedAt: '2026-08-30T00:00:00.000Z' } }
    }).success).toBe(true)
  })
  it('parseBackendEvent：领域事件经 IPC schema 校验通过（state 为完整 view）', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const ev = mapper.mapFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 2,
      state: { mood: { label: '平静', intensity: 0.2, updatedAt: '2026-08-30T00:00:00.000Z' }, proactiveEnabled: false, updatedAt: '2026-08-30T00:00:00.000Z' }
    })
    expect(ev).not.toBeNull()
    const parsed = parseBackendEvent(ev)
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.event === 'character.state.changed') {
      expect(parsed.data.characterId).toBe('ch')
      expect(parsed.data.characterInstanceId).toBe('ci')
      expect(parsed.data.characterRevision).toBe(1)
      expect(parsed.data.state.mood?.label).toBe('平静')
    }
    expect(parseBackendEvent({ ...ev, connectionScopeId: 'scope-a' }).success).toBe(true)
    expect(parseBackendEvent({ ...ev, connectionScopeId: '' }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 2, connectionScopeId: 'scope-a',
      state: { proactiveEnabled: false, updatedAt: '2026-08-30T00:00:00.000Z' }
    }).success).toBe(false)
  })
  it('角色状态/目录时间拒绝占位或非 UTC 时区', () => {
    expect(parseRawFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 1,
      state: { proactiveEnabled: true, updatedAt: 't' }
    }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.state.changed', conversationId: 'c1', characterId: 'ch', characterInstanceId: 'ci',
      characterRevision: 1, stateVersion: 1,
      state: { proactiveEnabled: true, updatedAt: '2026-08-30T00:00:00+08:00' }
    }).success).toBe(false)
    expect(parseRawFrame({
      type: 'character.catalog.changed', characterId: 'ch', currentRevision: 1,
      status: 'active', updatedAt: '2026-08-30'
    }).success).toBe(false)
    expect(parseBackendEvent({
      eventId: 'e1', sequence: 1, event: 'character.catalog.changed', characterId: 'ch',
      currentRevision: 1, status: 'active', updatedAt: 't'
    }).success).toBe(false)
  })
})

describe('会话/消息持久化 optional character 扩展（§12.1）', () => {
  const persistedMessage = {
    messageId: 'msg-1', conversationId: 'conv-1', role: 'assistant' as const,
    status: 'completed' as const, createdAt: '2026-08-30T00:00:00.000Z',
    assistantSegments: [{ segmentId: 'seg-1', segmentIndex: 0, channel: 'public_reply' as const, kind: 'text' as const, text: '你好', completed: true }]
  }
  const persistedConversation = { id: 'conv-1', title: '旧会话', updatedAt: '2026-08-30T00:00:00.000Z' }

  it('旧 cache（无 character）与新 cache（会话/消息带快照）均可读', () => {
    const legacy = {
      drafts: [], scrollAnchors: {}, conversations: [persistedConversation],
      messageSnapshots: { 'conv-1': [persistedMessage] }
    }
    expect(SessionPersistenceStateSchema.safeParse(legacy).success).toBe(true)
    const parsed = SessionPersistenceStateSchema.safeParse({
      ...legacy,
      conversations: [{ ...persistedConversation, character: snapshot }],
      messageSnapshots: { 'conv-1': [{ ...persistedMessage, character: snapshot }] }
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.conversations[0].character).toEqual(snapshot)
      expect(parsed.data.messageSnapshots['conv-1'][0].character).toEqual(snapshot)
    }
  })

  it('缓存中的角色快照仍遵守严格字段与 characterRevision 口径', () => {
    const legacy = {
      drafts: [], scrollAnchors: {}, conversations: [persistedConversation],
      messageSnapshots: { 'conv-1': [persistedMessage] }
    }
    expect(SessionPersistenceStateSchema.safeParse({
      ...legacy,
      conversations: [{ ...persistedConversation, character: { ...snapshot, revision: 2 } }]
    }).success).toBe(false)
  })
})

describe('expression / directive / audio 的角色身份（§7.4/§7.5）', () => {
  const identity = {
    conversationId: 'conv-1', generationId: 'g1', characterId: 'ch_elysia',
    characterInstanceId: 'ci_1', characterRevision: 2
  }

  it('raw expression/directive/audio_start 接纳 identity，顶层模糊 revision 一律拒绝', () => {
    const expression = parseRawFrame({ type: 'expression', expression: 'happy', intensity: 0.5, ...identity })
    const directive = parseRawFrame({ type: 'live2d.directive', state: 'happy', ...identity })
    const audioStart = parseRawFrame({ type: 'audio_start', stream_id: 7, format: 'wav', ...identity })
    expect(expression.success).toBe(true)
    expect(directive.success).toBe(true)
    expect(audioStart.success).toBe(true)
    if (expression.success && expression.data.type === 'expression') expect(expression.data.characterId).toBe('ch_elysia')
    if (directive.success && directive.data.type === 'live2d.directive') expect(directive.data.characterInstanceId).toBe('ci_1')
    if (audioStart.success && audioStart.data.type === 'audio_start') expect(audioStart.data.characterRevision).toBe(2)
    for (const frame of [
      { type: 'expression', expression: 'happy', ...identity },
      { type: 'live2d.directive', state: 'happy', ...identity },
      { type: 'audio_start', stream_id: 7, format: 'wav', ...identity }
    ]) {
      expect(parseRawFrame({ ...frame, revision: 2 }).success).toBe(false)
    }
  })

  it('FrameMapper 保留 expression/directive identity；legacy expression 仍按握手兼容忽略', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    expect(mapper.mapFrame({ type: 'expression', expression: 'idle' })).toBeNull()
    const expression = mapper.mapFrame({ type: 'expression', expression: 'happy', intensity: 0.5, ...identity }) as ExpressionEvent
    expect(expression).toMatchObject({ event: 'expression', expression: 'happy', intensity: 0.5, ...identity })
    const directive = mapper.mapFrame({ type: 'live2d.directive', state: 'happy', ...identity }) as Live2DDirectiveEvent
    expect(directive).toMatchObject({ event: 'live2d.directive', state: 'happy', ...identity })
  })

  it('audio_start 建立 stream → identity，audio_cancelled 映射时续接并释放 identity', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    const started = mapper.mapFrame({ type: 'audio_start', stream_id: 7, format: 'wav', ...identity }) as AudioSessionStartedEvent
    expect(started).toMatchObject({ event: 'audio.session.started', streamId: 7, format: 'wav', ...identity })
    const cancelled = mapper.mapFrame({ type: 'audio_cancelled', stream_id: 7 }) as AudioSessionCancelledEvent
    expect(cancelled).toMatchObject({ event: 'audio.session.cancelled', streamId: 7, ...identity })
    const afterCancel = mapper.mapFrame({ type: 'audio_cancelled', stream_id: 7 }) as AudioSessionCancelledEvent
    expect(afterCancel).not.toHaveProperty('characterId')
  })

  it('audio_end 后的 ready 纯组装路径同样续接 identity，并在释放后不污染下一条流', () => {
    const mapper = new FrameMapper({ connectionId: 'conn-1' })
    mapper.mapFrame({ type: 'audio_start', stream_id: 7, format: 'wav', ...identity })
    const ready = mapper.stampEvent<AudioSessionReadyEvent>({
      event: 'audio.session.ready', streamId: 7, url: 'cyrene://audio/x'
    })
    expect(ready).toMatchObject({ event: 'audio.session.ready', streamId: 7, ...identity })
    const next = mapper.stampEvent<AudioSessionReadyEvent>({
      event: 'audio.session.ready', streamId: 7, url: 'cyrene://audio/y'
    })
    expect(next).not.toHaveProperty('characterId')
  })

  it('领域表现/TTS schema 接纳身份并拒绝模糊 revision', () => {
    const expression = parseBackendEvent({ eventId: 'e1', sequence: 1, event: 'expression', expression: 'happy', ...identity })
    const directive = parseBackendEvent({ eventId: 'e2', sequence: 2, event: 'live2d.directive', state: 'happy', ...identity })
    const started = parseBackendEvent({ eventId: 'e3', sequence: 3, event: 'audio.session.started', streamId: 7, ...identity })
    const ready = parseBackendEvent({ eventId: 'e4', sequence: 4, event: 'audio.session.ready', streamId: 7, url: 'cyrene://audio/x', ...identity })
    const cancelled = parseBackendEvent({ eventId: 'e5', sequence: 5, event: 'audio.session.cancelled', streamId: 7, ...identity })
    expect(expression.success).toBe(true)
    expect(directive.success).toBe(true)
    expect(started.success).toBe(true)
    expect(ready.success).toBe(true)
    expect(cancelled.success).toBe(true)
    if (expression.success && expression.data.event === 'expression') expect(expression.data.characterId).toBe('ch_elysia')
    if (directive.success && directive.data.event === 'live2d.directive') expect(directive.data.characterRevision).toBe(2)
    if (started.success && started.data.event === 'audio.session.started') expect(started.data.characterInstanceId).toBe('ci_1')
    if (ready.success && ready.data.event === 'audio.session.ready') expect(ready.data.characterId).toBe('ch_elysia')
    if (cancelled.success && cancelled.data.event === 'audio.session.cancelled') expect(cancelled.data.characterRevision).toBe(2)
    expect(parseBackendEvent({ eventId: 'e6', sequence: 6, event: 'expression', expression: 'happy', ...identity, revision: 2 }).success).toBe(false)
  })
})
