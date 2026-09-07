import { describe, expect, it, vi } from 'vitest'
import { RealBackend, type WebSocketLike } from '../../src/main/transport/real-backend'
import { CyreneErrorCode } from '@shared/errors'
import type {
  RestCharacterArchiveResult,
  RestCharacterDetail,
  RestCharacterListResponse,
  RestCharacterMutationResult,
  RestCharacterPreviewResult,
  RestCharacterPublicState,
  RestCharacterRevisionsResponse,
  RestResetEvolutionResult,
  RestCharacterValidationResult,
  RestUserIdentityProfile
} from '../../src/main/transport/protocol-v2/character-rest-types'
import type { CharacterDraft } from '@shared/contracts/character'

class FakeWs implements WebSocketLike {
  private readonly handlers = new Map<string, (arg?: unknown, arg2?: unknown) => void>()
  readonly send = vi.fn()
  readonly close = vi.fn()
  readyState = 1

  on(event: 'open' | 'message' | 'close' | 'error' | 'unexpected-response', callback: (arg?: unknown, arg2?: unknown) => void): void {
    this.handlers.set(event, callback)
  }

  push(frame: unknown): void {
    this.handlers.get('message')?.(JSON.stringify(frame))
  }

  trigger(event: 'close' | 'error'): void {
    this.handlers.get(event)?.()
  }

  handshake(features: Record<string, unknown> = {}): void {
    this.push({ type: 'session', conversationId: 'conversation-1', messages: [], token_stats: { total: 0, byModel: {} } })
    this.push({ type: 'server_info', protocol_version: '2.0', server_version: 'test', features, services: {}, connectionId: 'connection-1' })
  }
}

const profile: RestUserIdentityProfile = {
  userId: 'user-1', displayName: '旅人', preferredAddress: null, pronouns: null,
  locale: 'zh-CN', timezone: 'Asia/Shanghai', initialized: true, defaultCharacterId: 'character-1', revision: 1,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
}

const summary = {
  characterId: 'character-1', source: 'custom' as const, mutable: true, status: 'active' as const,
  currentRevision: 2, displayName: 'Elysia', description: '温柔的同伴', aliases: ['小爱'],
  presentation: { avatarAssetId: null, live2dModelId: 'elysia-live2d', themeColor: '#ff88aa' },
  updatedAt: '2026-09-01T00:00:00.000Z'
}

const detail: RestCharacterDetail = {
  summary,
  current: {
    characterId: 'character-1', revision: 2, schemaVersion: 1, displayName: 'Elysia', description: '温柔的同伴', aliases: ['小爱'],
    promptProfile: {
      corePersonality: '温柔', relationshipStyle: '同伴', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: []
    },
    runtimeDefaults: {
      voice: { providerId: null, voiceId: null }, emotion: { idleExpressions: ['idle'] }, wakeWords: ['你好'],
      proactive: { enabled: false, intervalSeconds: 0, triggers: [] }
    },
    presentation: { avatarAssetId: null, live2dModelId: 'elysia-live2d', themeColor: '#ff88aa' }, openingMessage: null,
    checksum: 'sha256:character-1-v2', compilerVersion: 1, createdBy: 'user', createdAt: '2026-09-01T00:00:00.000Z'
  }
}

const list: RestCharacterListResponse = { items: [summary], has_more: true, cursor: 'next-character' }
const revisions: RestCharacterRevisionsResponse = {
  items: [{ revision: 1, checksum: 'sha256:character-1-v1', createdBy: 'system', createdAt: '2026-08-01T00:00:00.000Z' }],
  has_more: false
}
const mutation: RestCharacterMutationResult = {
  character: detail, stateImpact: { statePolicy: 'preserve', affectedInstances: 0, pendingInstances: 0, resetFields: [] }
}
const archive: RestCharacterArchiveResult = { character: { ...summary, status: 'archived' }, userProfile: profile }
const validation: RestCharacterValidationResult = { valid: false, issues: [{ severity: 'warning', code: 'STYLE', path: '/promptProfile/speakingStyle', message: '建议更具体' }] }
const preview: RestCharacterPreviewResult = { ephemeral: true, reply: '临时回复', model: 'model-1', usage: { input: 3, output: 4, total: 7 } }
const state: RestCharacterPublicState = {
  characterId: 'character-1', characterInstanceId: 'instance-1', characterRevision: 2, stateVersion: 3,
  state: {
    mood: { label: '开心', intensity: 0.4, updatedAt: '2026-09-01T00:00:00.000Z' },
    currentActivity: null, lastInteractionAt: null, proactiveEnabled: false, updatedAt: '2026-09-01T00:00:00.000Z'
  }
}
const resetResult: RestResetEvolutionResult = {
  state: { ...state, stateVersion: 4 },
  resetFields: ['self_l2', 'state_l3', 'speaking_style_c6', 'reflector', 'mood']
}

const draft: CharacterDraft = {
  displayName: 'Elysia', description: '温柔的同伴', aliases: ['小爱'],
  promptProfile: {
    corePersonality: '温柔', relationshipStyle: '同伴', emotionStyle: '', speakingStyle: '自然', conversationInitiative: '', examples: []
  },
  runtimeDefaults: {
    voice: {}, emotion: { idleExpressions: ['idle'] }, wakeWords: ['你好'], proactive: { enabled: false, intervalSeconds: 0, triggers: [] }
  },
  presentation: { live2dModelId: 'elysia-live2d', themeColor: '#ff88aa' }, openingMessage: '欢迎回来'
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('RealBackend 角色 REST 适配器', () => {
  it('按冻结矩阵调用所有角色 REST 路径，并只向上返回领域形状', async () => {
    const socket = new FakeWs()
    const calls: Array<{ method: string; url: string; body?: string; authorization?: string }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const parsed = new URL(url)
      calls.push({
        method: init?.method ?? 'GET', url,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        authorization: typeof init?.headers === 'object' && init.headers !== null
          ? String((init.headers as Record<string, string>).authorization ?? '')
          : undefined
      })
      const key = `${init?.method ?? 'GET'} ${parsed.pathname}`
      switch (key) {
        case 'GET /api/me': return jsonResponse(profile)
        case 'PUT /api/me': return jsonResponse(profile)
        case 'GET /api/characters': return jsonResponse(list)
        case 'GET /api/characters/character-1': return jsonResponse(detail)
        case 'POST /api/characters': return jsonResponse(detail, 201)
        case 'PUT /api/characters/character-1': return jsonResponse(mutation)
        case 'POST /api/characters/character-1/clone': return jsonResponse(detail, 201)
        case 'DELETE /api/characters/character-1': return jsonResponse(archive)
        case 'GET /api/characters/character-1/revisions': return jsonResponse(revisions)
        case 'POST /api/characters/character-1/rollback': return jsonResponse(mutation)
        case 'POST /api/characters/validate': return jsonResponse(validation)
        case 'POST /api/characters/preview': return jsonResponse(preview)
        case 'GET /api/character-instances/instance-1/state': return jsonResponse(state)
        case 'POST /api/character-instances/instance-1/reset-evolution': return jsonResponse(resetResult)
        default: throw new Error(`unexpected request: ${key}`)
      }
    })
    const backend = new RealBackend({ fetchImpl: fetchImpl as unknown as typeof fetch, wsFactory: () => socket })
    const connecting = backend.connect({ serverUrl: 'https://backend.example', token: 'token-1' })
    socket.handshake({ character_profiles: true, character_state_stream: true })
    await connecting

    const domainProfile = await backend.getMe()
    expect(domainProfile).toMatchObject({ userId: 'user-1', defaultCharacterId: 'character-1' })
    expect(domainProfile).not.toHaveProperty('preferredAddress')
    await backend.updateMe({ expectedRevision: 1, displayName: '旅人', locale: 'zh-CN', timezone: 'Asia/Shanghai' })
    await expect(backend.listCharacters({ source: 'custom', status: 'active', search: 'Ely', cursor: 'cursor-1', limit: 10 })).resolves.toMatchObject({ hasMore: true, nextCursor: 'next-character' })
    await expect(backend.getCharacter('character-1')).resolves.toMatchObject({ summary: { characterId: 'character-1' }, current: { revision: 2 } })
    await backend.createCharacter({ draft })
    await backend.updateCharacter({ characterId: 'character-1', expectedRevision: 2, statePolicy: 'preserve', draft })
    await backend.cloneCharacter({ characterId: 'character-1', displayName: 'Elysia Clone' })
    await expect(backend.archiveCharacter('character-1')).resolves.toMatchObject({ character: { status: 'archived' }, userProfile: { userId: 'user-1' } })
    await expect(backend.listCharacterRevisions({ characterId: 'character-1', limit: 20 })).resolves.toMatchObject({ hasMore: false, items: [{ revision: 1 }] })
    await backend.rollbackCharacter({ characterId: 'character-1', targetRevision: 1, expectedRevision: 2, statePolicy: 'reset_evolution' })
    await expect(backend.validateCharacter(draft)).resolves.toMatchObject({ valid: false, issues: [{ path: '/promptProfile/speakingStyle' }] })
    await expect(backend.previewCharacter({ draft, userMessage: '你好，今天过得怎么样？' })).resolves.toMatchObject({ ephemeral: true, reply: '临时回复' })
    await expect(backend.getCharacterState('instance-1')).resolves.toMatchObject({ stateVersion: 3, mood: { intensity: 0.4 } })
    await expect(backend.resetCharacterEvolution({ characterInstanceId: 'instance-1', expectedStateVersion: 3 }))
      .resolves.toMatchObject({ state: { stateVersion: 4, mood: { label: '开心' } }, resetFields: expect.arrayContaining(['mood']) })

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /api/me', 'PUT /api/me', 'GET /api/characters', 'GET /api/characters/character-1', 'POST /api/characters',
      'PUT /api/characters/character-1', 'POST /api/characters/character-1/clone', 'DELETE /api/characters/character-1',
      'GET /api/characters/character-1/revisions', 'POST /api/characters/character-1/rollback', 'POST /api/characters/validate',
      'POST /api/characters/preview', 'GET /api/character-instances/instance-1/state',
      'POST /api/character-instances/instance-1/reset-evolution'
    ])
    expect(calls.every((call) => call.authorization === 'Bearer token-1')).toBe(true)
    expect(new URL(calls[2]!.url).search).toBe('?source=custom&status=active&search=Ely&cursor=cursor-1&limit=10')
    expect(JSON.parse(calls[1]!.body ?? '')).toEqual({ expectedRevision: 1, displayName: '旅人', locale: 'zh-CN', timezone: 'Asia/Shanghai' })
    expect(JSON.parse(calls[4]!.body ?? '')).not.toHaveProperty('draft')
    expect(JSON.parse(calls[11]!.body ?? '')).toHaveProperty('draft')
    expect(JSON.parse(calls[13]!.body ?? '')).toEqual({ expectedStateVersion: 3 })
  })

  it('严格拒绝 malformed 角色响应，并在显式 source 切换后丢弃旧请求', async () => {
    const firstSocket = new FakeWs()
    const secondSocket = new FakeWs()
    const sockets = [firstSocket, secondSocket]
    let call = 0
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      void input
      if (call++ === 0) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        })
      }
      return Promise.resolve(jsonResponse({ ...detail, summary: { ...detail.summary, unexpected: true } }))
    })
    const backend = new RealBackend({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      wsFactory: () => sockets.shift() ?? secondSocket
    })
    const firstConnect = backend.connect({ serverUrl: 'https://backend.example', token: 'token-a' })
    firstSocket.handshake({ character_profiles: true })
    await firstConnect
    const oldRequest = backend.getMe()

    const secondConnect = backend.connect({ serverUrl: 'https://backend.example', token: 'token-b' })
    secondSocket.handshake({ character_profiles: true })
    await secondConnect
    await expect(oldRequest).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    await expect(backend.getCharacter('character-1')).rejects.toMatchObject({ code: CyreneErrorCode.SCHEMA_VALIDATION_FAILED })
    await backend.disconnect()
  })

  it('reset endpoint 的 request/response 均 fail closed，并保留状态 mapper 边界', async () => {
    const socket = new FakeWs()
    const fetchImpl = vi.fn(async (): Promise<Response> => jsonResponse({
      ...resetResult,
      state: { ...resetResult.state, state: { ...resetResult.state.state, mood: null } }
    }))
    const backend = new RealBackend({ fetchImpl: fetchImpl as unknown as typeof fetch, wsFactory: () => socket })
    const connecting = backend.connect({ serverUrl: 'https://backend.example', token: 'token-1' })
    socket.handshake({ character_profiles: true })
    await connecting

    await expect(backend.resetCharacterEvolution({ characterInstanceId: 'instance-1', expectedStateVersion: 3 }))
      .rejects.toMatchObject({ code: CyreneErrorCode.SCHEMA_VALIDATION_FAILED })
    await expect(backend.resetCharacterEvolution({ characterInstanceId: 'instance-1', expectedStateVersion: 0 }))
      .rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await backend.disconnect()
  })

  it('同一 source 的 socket reconnect 也会让旧角色 REST 响应失效', async () => {
    const socket = new FakeWs()
    let resolveResponse!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve }))
    const backend = new RealBackend({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      wsFactory: () => socket,
      reconnectBaseDelayMs: 60_000
    })
    const connected = backend.connect({ serverUrl: 'https://backend.example', token: 'token-a' })
    socket.handshake({ character_profiles: true })
    await connected

    const oldRequest = backend.getMe()
    socket.trigger('close')
    resolveResponse(jsonResponse(profile))
    await expect(oldRequest).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    await backend.disconnect()
  })
})
