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

/** fetch 入参 → 请求 URL 文本：生产代码一律传 string；URL/Request 各取其 url 字段
 *（断言本意是「请求了哪个 URL」，String(Request) 只会得到 '[object Request]'）。 */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

describe('RealBackend 角色 REST 适配器', () => {
  it('按冻结矩阵调用所有角色 REST 路径，并只向上返回领域形状', async () => {
    const socket = new FakeWs()
    const calls: Array<{ method: string; url: string; body?: string; authorization?: string }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = requestUrl(input)
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
    // vitest 的 expect.arrayContaining 返回类型被 @vitest/expect 声明为 any；按“未知期望值”如实收成
    // unknown 再放进断言对象（匹配器运行时行为不变，仅阻断 any 扩散）。
    const resetFieldsMatcher: unknown = expect.arrayContaining(['mood'])
    await expect(backend.resetCharacterEvolution({ characterInstanceId: 'instance-1', expectedStateVersion: 3 }))
      .resolves.toMatchObject({ state: { stateVersion: 4, mood: { label: '开心' } }, resetFields: resetFieldsMatcher })

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /api/me', 'PUT /api/me', 'GET /api/characters', 'GET /api/characters/character-1', 'POST /api/characters',
      'PUT /api/characters/character-1', 'POST /api/characters/character-1/clone', 'DELETE /api/characters/character-1',
      'GET /api/characters/character-1/revisions', 'POST /api/characters/character-1/rollback', 'POST /api/characters/validate',
      'POST /api/characters/preview', 'GET /api/character-instances/instance-1/state',
      'POST /api/character-instances/instance-1/reset-evolution'
    ])
    expect(calls.every((call) => call.authorization === 'Bearer token-1')).toBe(true)
    expect(new URL(calls[2].url).search).toBe('?source=custom&status=active&search=Ely&cursor=cursor-1&limit=10')
    expect(JSON.parse(calls[1].body ?? '')).toEqual({ expectedRevision: 1, displayName: '旅人', locale: 'zh-CN', timezone: 'Asia/Shanghai' })
    expect(JSON.parse(calls[4].body ?? '')).not.toHaveProperty('draft')
    expect(JSON.parse(calls[11].body ?? '')).toHaveProperty('draft')
    expect(JSON.parse(calls[13].body ?? '')).toEqual({ expectedStateVersion: 3 })
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

  /**
   * H-11c（P1-6，2026-09-11 修复）：**同一 source 的 socket 重连不再作废已完成的 REST 响应**。
   *
   * 本条用例原先名称为「同一 source 的 socket reconnect 也会让旧角色 REST 响应失效」并把旧行为锁死。
   * 那是**过宽**的：栅栏的职责是阻止**另一个后端**的数据进入领域，而重连只是换了条 WS 连接。
   * 原行为的实际后果是——fetch 未被 abort、服务端副作用已提交，客户端却报"连接来源已切换，请重试"，
   * 对非幂等写（上传/建会话/保存）会诱导用户重试并产生**重复副作用**。
   *
   * 前提（用户确认的产品事实）：本项目**只面向一个后端**（服务端唯一），
   * 故"同一 source 的重连"与"换源"必须区分对待。
   */
  it('同一 source 的 socket reconnect **不再**作废已完成的 REST 响应（H-11c）', async () => {
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

    const inFlight = backend.getMe()
    socket.trigger('close')          // 同一 source 的 socket 重连（source scope 未变）
    resolveResponse(jsonResponse(profile))

    // 已完成的 200 必须被接受——丢弃它等于把已提交的服务端副作用报成失败
    await expect(inFlight).resolves.toMatchObject({ displayName: profile.displayName ?? expect.anything() })
    await backend.disconnect()
  })

  it('**换源**（connect 到另一个 serverUrl）仍作废在途 REST 响应——栅栏职责未被削弱', async () => {
    const socketA = new FakeWs()
    let resolveResponse!: (response: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve }))
    const backend = new RealBackend({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      wsFactory: () => socketA,
      reconnectBaseDelayMs: 60_000
    })
    const connected = backend.connect({ serverUrl: 'https://backend.example', token: 'token-a' })
    socketA.handshake({ character_profiles: true })
    await connected

    const inFlight = backend.getMe()
    // 换到另一个后端：这才是栅栏要拦的情形
    const second = new FakeWs()
    ;(backend as unknown as { options: { wsFactory: () => unknown } }).options.wsFactory = () => second
    const reconnected = backend.connect({ serverUrl: 'https://other-backend.example', token: 'token-b' })
    second.handshake({ character_profiles: true })
    await reconnected.catch(() => { /* 换源实现细节不属本用例断言面 */ })
    resolveResponse(jsonResponse(profile))

    await expect(inFlight).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    await backend.disconnect()
  })

  // 回归（2026-09-10 真机）：网络层失败此前经裸 `throw e` 穿透——e 是 fetch 的原生 TypeError
  // （Chromium 文案 `Failed to fetch`，无错误码），契约按 code 匹配落空，界面把该文本原样显示。
  // 现由 restFailure 归一为 NOT_CONNECTED：有码、可映射、文案可操作。
  it('回归：网络层失败归一为 NOT_CONNECTED，不得让 fetch 原生文本穿透', async () => {
    const socket = new FakeWs()
    const nativeError = new TypeError('Failed to fetch')
    const fetchImpl = vi.fn(async () => { throw nativeError })
    const backend = new RealBackend({ fetchImpl: fetchImpl as unknown as typeof fetch, wsFactory: () => socket })
    const connecting = backend.connect({ serverUrl: 'https://backend.example', token: 'token-1' })
    socket.handshake({ character_profiles: true, character_state_stream: true })
    await connecting

    const rejection = await backend.getCharacterState('instance-1').then(
      () => { throw new Error('应当 reject') },
      (e: unknown) => e as { code?: string; message?: string; name?: string }
    )
    expect(rejection.code).toBe(CyreneErrorCode.NOT_CONNECTED)
    // 关键：原始原生文本不得出现在对外 message 中
    expect(rejection.message ?? '').not.toContain('Failed to fetch')
    expect(rejection.message ?? '').toContain('无法连接后端')

    // 已有业务语义的错误必须原样保留（兜底不得覆盖 HTTP/超时/取消等）：
    // restFailure 对 CyreneError 是恒等透传，故用 404 走一遍真实链路验证。
    const httpSocket = new FakeWs()
    const httpError = vi.fn(async () => jsonResponse({ code: 'SESSION_NOT_FOUND', message: '会话不存在' }, 404))
    const backend2 = new RealBackend({ fetchImpl: httpError as unknown as typeof fetch, wsFactory: () => httpSocket })
    const connecting2 = backend2.connect({ serverUrl: 'https://backend.example', token: 'token-1' })
    httpSocket.handshake({ character_profiles: true, character_state_stream: true })
    await connecting2
    await expect(backend2.getCharacterState('instance-1')).rejects.toMatchObject({ code: CyreneErrorCode.NOT_FOUND })

    await backend.disconnect()
    await backend2.disconnect()
  })
})
