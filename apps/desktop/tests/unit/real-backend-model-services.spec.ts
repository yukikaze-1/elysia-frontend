// tests/unit/real-backend-model-services.spec.ts
// Task 4:real-backend 模型/TTS 方法——REST providers/tts 拉取、switch_model/set_tts_voice result 帧 pending 关联、
// server_info.services 归一化、saveModelProfile POST→GET 回读、deleteModelProfile 409 错误映射。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RealBackend, type RealBackendOptions } from '../../src/main/transport/real-backend'
import type { ModelProfileTestCommand, UpsertModelProfileCommand } from '@shared/contracts/model'
import type { BackendEvent } from '@shared/contracts'
import { parseBackendEvent } from '@shared/schemas'
import { CyreneErrorCode } from '@shared/errors'
import { FrameMapper } from '../../src/main/transport/protocol-v2/frame-mapper'

/** 假 socket：记录发送帧，可手动 push 后端帧（message handler 注册后即可 push） */
class FakeWs {
  private handlers: Record<string, (arg?: unknown, arg2?: unknown) => void> = {}
  send = vi.fn()
  close = vi.fn()
  readyState = 1
  on(ev: string, cb: (arg?: unknown, arg2?: unknown) => void): this { this.handlers[ev] = cb; return this }
  push(frame: unknown): void { this.handlers['message']?.(JSON.stringify(frame)) }
}

/** 建立已连接 backend（同步推握手帧使 connect resolve）；可注入 services / RealBackendOptions / fetchImpl */
async function makeBackend(
  services: Record<string, unknown> = {},
  opts: Partial<RealBackendOptions> = {}
): Promise<{ backend: RealBackend; ws: FakeWs }> {
  const ws = new FakeWs()
  const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => ws, ...opts })
  const p = backend.connect({ serverUrl: 'http://test.local', token: 'sk-test' })
  ws.push({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } })
  ws.push({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services, connectionId: 'conn-1' })
  await p
  return { backend, ws }
}

/** fetch 入参 → 请求 URL 文本：生产代码一律传 string；URL/Request 各取其 url 字段
 *（断言本意是「请求了哪个 URL」，String(Request) 只会得到 '[object Request]'）。 */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** 取 mock fetch 记录的 JSON 请求体对象：本后端 REST 一律发 JSON 字符串；形状不符直接抛错，
 *  与原 String(body) + JSON.parse 的失败语义一致（不会静默降级为通过）。 */
function jsonRequestBody(init?: RequestInit): Record<string, unknown> {
  const body = init?.body
  if (typeof body !== 'string') throw new Error(`请求体应为 JSON 字符串，实际为 ${typeof body}`)
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体应为 JSON 对象')
  return { ...parsed }
}

/** 取请求体里的子对象字段（缺失/非对象即抛错，等价于原先点号取属性的 TypeError 失败路径）。 */
function jsonField(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`请求体字段 ${key} 应为 JSON 对象`)
  return { ...value }
}

/** 按路由匹配的假 REST（返回 Response；calls 记录每次请求） */
function mockFetch(
  routes: Array<{ test: (url: string, init?: RequestInit) => boolean; body: unknown; status?: number }>,
  calls: { url: string; init?: RequestInit }[] = []
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = requestUrl(url)
    calls.push({ url: u, init })
    const route = routes.find((r) => r.test(u, init))
    if (!route) throw new Error(`no mock for ${init?.method ?? 'GET'} ${u}`)
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
}

/** rest.py ProvidersResponse wire（providers-mapper 消费形状） */
const PROVIDERS = {
  llm: { deepseek: { models: ['deepseek-v4-flash', 'deepseek-r1'], credentialConfigured: true, runtime: 'backend', capabilities: { auth: 'api_key' } } },
  stt: { 'sensevoice/sense-voice': { models: ['sense-voice'], credentialConfigured: false, runtime: 'backend', capabilities: {} } },
  tts: {},
  custom: {},
  unconfigured: { llm: [{ name: 'openai', env_vars: ['OPENAI_API_KEY'] }] }
}

beforeEach(() => { vi.clearAllMocks() })

describe('RealBackend 模型/TTS REST 方法（Task 4）', () => {
  it('listModelProfiles 拉 GET /api/providers 并经 providersToModelProfiles 归一化 + 类型过滤', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const { backend } = await makeBackend({}, { fetchImpl: mockFetch([{ test: (u) => u.includes('/api/providers'), body: PROVIDERS }], calls) })
    const all = await backend.listModelProfiles()
    expect(calls[0]?.url).toContain('/api/providers')
    expect(all.some((p) => p.id === 'deepseek/deepseek-v4-flash' && p.source === 'built_in' && p.credentialStatus === 'configured')).toBe(true)
    expect(all.some((p) => p.id === 'sensevoice/sense-voice/sense-voice')).toBe(true)
    const llmOnly = await backend.listModelProfiles('llm')
    expect(llmOnly.every((p) => p.type === 'llm')).toBe(true)
  })

  it('testModelProfile：POST /api/providers/test → profileId=provider/model + latencyMs', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const { backend } = await makeBackend({}, { fetchImpl: mockFetch([{ test: (u) => u.includes('/api/providers/test'), body: { ok: true, latency_ms: 42 } }], calls) })
    const input: ModelProfileTestCommand = { service: 'llm', provider: 'deepseek', model: 'deepseek-v4-flash', level: 'connectivity' }
    const r = await backend.testModelProfile(input)
    expect(r).toEqual({ profileId: 'deepseek/deepseek-v4-flash', service: 'llm', level: 'connectivity', ok: true, latencyMs: 42 })
    const body = jsonRequestBody(calls[0]?.init)
    expect(body).toEqual({ service: 'llm', provider: 'deepseek', model: 'deepseek-v4-flash', level: 'connectivity' })
  })

  it('saveModelProfile：POST 后跟 GET（save 无 credentialConfigured → 回读真实状态），返回归一化 custom 条目', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const withCustom = { ...PROVIDERS, custom: { llm: [{ name: 'my-llm', base_url: 'https://api.example.com', models: ['m1'], runtime: 'backend', credentialConfigured: true, capabilities: {} }] } }
    const { backend } = await makeBackend({}, {
      fetchImpl: mockFetch([
        { test: (u, init) => u.includes('/api/providers') && init?.method === 'POST', body: { ok: true, data: [] } },
        { test: (u) => u.includes('/api/providers'), body: withCustom }
      ], calls)
    })
    const saved = await backend.saveModelProfile({ type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com', apiKey: 'sk-abc' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[1]?.init?.method).toBeUndefined()   // 回读 GET（restFetch 不显式设 method）
    const postBody = jsonRequestBody(calls[0]?.init)
    expect(postBody).toEqual({ service: 'llm', entry: { name: 'my-llm', base_url: 'https://api.example.com', api_key: 'sk-abc' } })
    expect(saved.id).toBe('custom/my-llm')
    expect(saved.source).toBe('custom')
    expect(saved.credentialStatus).toBe('configured')
    expect(saved.endpointLabel).toBe('api.example.com')
  })

  it('saveModelProfile makeActive → 保存后立即发 switch_model（等 result 帧）', async () => {
    const withCustom = { ...PROVIDERS, custom: { llm: [{ name: 'my-llm', models: ['m1'], credentialConfigured: true, runtime: 'backend', capabilities: {} }] } }
    const { backend, ws } = await makeBackend({}, {
      fetchImpl: mockFetch([
        { test: (u, init) => u.includes('/api/providers') && init?.method === 'POST', body: { ok: true } },
        { test: (u) => u.includes('/api/providers'), body: withCustom }
      ])
    })
    const input: UpsertModelProfileCommand = { type: 'llm', name: 'my-llm', makeActive: true }
    const p = backend.saveModelProfile(input)
    // saveModelProfile 内 POST→GET 是异步链：等一个 macrotask 让 activateModelProfile 发出 switch_model
    await new Promise((r) => setTimeout(r, 0))
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'switch_model', service: 'llm', model: 'custom/my-llm' }))
    ws.push({ type: 'switch_model_result', service: 'llm', model: 'custom/my-llm', ok: true })
    const saved = await p
    expect(saved.id).toBe('custom/my-llm')
  })

  it('saveModelProfile capabilities → POST body capabilities 为 dict（非 string[]；P4-A final review wire 契约）', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const withCustom = { ...PROVIDERS, custom: { llm: [{ name: 'my-llm', base_url: 'https://api.example.com', models: ['m1'], runtime: 'backend', credentialConfigured: true, capabilities: { auth: true, stream: true } }] } }
    const { backend } = await makeBackend({}, {
      fetchImpl: mockFetch([
        { test: (u, init) => u.includes('/api/providers') && init?.method === 'POST', body: { ok: true, data: [] } },
        { test: (u) => u.includes('/api/providers'), body: withCustom }
      ], calls)
    })
    await backend.saveModelProfile({ type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com', capabilities: ['auth', 'stream'] })
    const postBody = jsonRequestBody(calls[0]?.init)
    const entry = jsonField(postBody, 'entry')
    expect(Array.isArray(entry['capabilities'])).toBe(false)
    expect(entry['capabilities']).toEqual({ auth: true, stream: true })
  })

  it('deleteModelProfile：DELETE /api/providers/llm/x；409 body{ok:false,code} → reject 且 details.code 透传', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const { backend } = await makeBackend({}, {
      fetchImpl: mockFetch([{ test: (u) => u.includes('/api/providers/llm/x'), body: { ok: false, code: 'PROFILE_IN_USE', error: 'custom/x 正在使用' }, status: 409 }], calls)
    })
    await expect(backend.deleteModelProfile('llm', 'x')).rejects.toMatchObject({
      code: CyreneErrorCode.UNKNOWN,
      details: { ok: false, code: 'PROFILE_IN_USE', error: 'custom/x 正在使用' }
    })
    expect(calls[0]?.init?.method).toBe('DELETE')
  })

  it('listTtsVoices：GET /api/tts/voices 归一化 + current/source；capabilities dict 展开为键名（rest.py:219）', async () => {
    const { backend } = await makeBackend({}, {
      fetchImpl: mockFetch([{ test: (u) => u.includes('/api/tts/voices'), body: {
        voices: [
          { id: 'v1', name: '晓晓', languages: ['zh'], capabilities: { wav: true, gender: 'female' } },
          { id: 'v2', languages: ['en'] }   // capabilities 缺省 → default {} → 领域 []
        ],
        current: 'v1', source: 'api'
      } }])
    })
    const r = await backend.listTtsVoices()
    expect(r).toEqual({
      voices: [
        { id: 'v1', name: '晓晓', languages: ['zh'], capabilities: ['gender', 'wav'] },
        { id: 'v2', languages: ['en'], capabilities: [] }
      ],
      current: 'v1', source: 'api'
    })
  })

  it('previewTts：POST /api/tts/preview（voice_id wire）→ 返回 raw bytes/mime/durationMs，不落 MediaService', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const base64 = Buffer.from('fake-audio-bytes').toString('base64')
    const { backend } = await makeBackend({}, {
      fetchImpl: mockFetch([{ test: (u) => u.includes('/api/tts/preview'), body: { ok: true, mime: 'audio/wav', audio_base64: base64, duration_ms: 1200 } }], calls)
    })
    const r = await backend.previewTts({ voiceId: 'v1' })
    expect(r.ok).toBe(true)
    expect(r.mime).toBe('audio/wav')
    expect(r.durationMs).toBe(1200)
    expect(Buffer.from(r.bytes as Uint8Array).toString('utf8')).toBe('fake-audio-bytes')
    expect(jsonRequestBody(calls[0]?.init)).toEqual({ voice_id: 'v1' })
  })

  it('previewTts 后端 ok:false → {ok:false, error}；ok 但无音频 → {ok:false,error:试听无音频数据}', async () => {
    const { backend } = await makeBackend({}, {
      fetchImpl: mockFetch([
        { test: (_u, init) => typeof init?.body === 'string' && init.body.includes('bad'), body: { ok: false, error: 'VOICE_NOT_FOUND: 声音不存在' } },
        { test: (u) => u.includes('/api/tts/preview'), body: { ok: true } }
      ])
    })
    const bad = await backend.previewTts({ voiceId: 'bad' })
    expect(bad).toEqual({ ok: false, error: 'VOICE_NOT_FOUND: 声音不存在' })
    const noAudio = await backend.previewTts({ voiceId: 'v1' })
    expect(noAudio).toEqual({ ok: false, error: '试听无音频数据' })
  })

  it('previewTts audio_base64 非空串但解出 0 字节 → {ok:false,error:试听无音频数据}（P4-A final review 空字节 guard）', async () => {
    const { backend } = await makeBackend({}, {
      fetchImpl: mockFetch([{ test: (u) => u.includes('/api/tts/preview'), body: { ok: true, mime: 'audio/wav', audio_base64: '' } }])
    })
    const r = await backend.previewTts({ voiceId: 'v1' })
    expect(r).toEqual({ ok: false, error: '试听无音频数据' })
  })
})

describe('RealBackend switch/set_tts_voice result 帧 pending 关联（Task 4）', () => {
  it('activateModelProfile 发 switch_model 帧，result ok → resolve；并 emit switch_model.result 事件', async () => {
    const { backend, ws } = await makeBackend()
    const events: BackendEvent[] = []
    backend.subscribe((e) => events.push(e))
    const p = backend.activateModelProfile({ profileId: 'deepseek/deepseek-v4-flash', service: 'llm' })
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'switch_model', service: 'llm', model: 'deepseek/deepseek-v4-flash' }))
    ws.push({ type: 'switch_model_result', service: 'llm', model: 'deepseek/deepseek-v4-flash', ok: true })
    await expect(p).resolves.toBeUndefined()
    expect(events.some((e) => e.event === 'switch_model.result' && e.model === 'deepseek/deepseek-v4-flash' && e.ok === true)).toBe(true)
  })

  it('activateModelProfile result ok:false + error "<CODE>: <msg>" → reject 且 details.backendCode 解析（D-A14）', async () => {
    const { backend, ws } = await makeBackend()
    const p = backend.activateModelProfile({ profileId: 'deepseek/deepseek-v4-flash', service: 'llm' })
    ws.push({ type: 'switch_model_result', service: 'llm', model: 'deepseek/deepseek-v4-flash', ok: false, error: 'MODEL_UNAVAILABLE: 模型当前不可用' })
    await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.UNKNOWN, message: '模型当前不可用', details: { backendCode: 'MODEL_UNAVAILABLE' } })
  })

  it('switch_model 同服务二次激活 → 旧 pending reject GENERATION_CONFLICT', async () => {
    const { backend, ws } = await makeBackend()
    const first = backend.activateModelProfile({ profileId: 'deepseek/deepseek-v4-flash', service: 'llm' })
    const second = backend.activateModelProfile({ profileId: 'deepseek/deepseek-r1', service: 'llm' })
    await expect(first).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    ws.push({ type: 'switch_model_result', service: 'llm', model: 'deepseek/deepseek-r1', ok: true })
    await expect(second).resolves.toBeUndefined()
  })

  it('setTtsVoice 发 set_tts_voice 帧，result ok → resolve', async () => {
    const { backend, ws } = await makeBackend()
    const p = backend.setTtsVoice({ voice: 'v1' })
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'set_tts_voice', voice: 'v1' }))
    ws.push({ type: 'set_tts_voice_result', ok: true, voice: 'v1' })
    await expect(p).resolves.toBeUndefined()
  })

  it('setTtsVoice result voice 不匹配 → 忽略（D-A14），匹配帧到达才 resolve', async () => {
    const { backend, ws } = await makeBackend()
    let settled = false
    const p = backend.setTtsVoice({ voice: 'v1' }).then(() => { settled = true })
    ws.push({ type: 'set_tts_voice_result', ok: true, voice: 'v2' })   // 不匹配 → pending 保持
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    ws.push({ type: 'set_tts_voice_result', ok: true, voice: 'v1' })
    await expect(p).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it('setTtsVoice 失败帧（voice 缺省省略 + ok:false）→ reject 解析错误，不误报 10s 超时（P4-A final review）', async () => {
    const { backend, ws } = await makeBackend()
    const p = backend.setTtsVoice({ voice: 'v1' })
    // 后端 SetTtsVoiceResultMessage 失败时 voice 恒缺省（ok:False + error）→ 权威失败帧也须结算 pending
    ws.push({ type: 'set_tts_voice_result', ok: false, error: 'VOICE_NOT_FOUND: 未知音色' })
    await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.UNKNOWN, message: '未知音色', details: { backendCode: 'VOICE_NOT_FOUND' } })
  })

  it('setTtsVoice 快速二次调用：旧 pending supersede（GENERATION_CONFLICT），第二次正常 resolve（防旧 timer 跨清新 pending）', async () => {
    const { backend, ws } = await makeBackend()
    const first = backend.setTtsVoice({ voice: 'v1' })
    const second = backend.setTtsVoice({ voice: 'v2' })
    await expect(first).rejects.toMatchObject({ code: CyreneErrorCode.GENERATION_CONFLICT })
    ws.push({ type: 'set_tts_voice_result', ok: true, voice: 'v2' })
    await expect(second).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 5))   // 旧 v1 timer 已被 clearTimeout，不误清新 pending/不误报 TIMEOUT
  })

  it('switch/set_tts_voice 超时 → TIMEOUT（switchTimeoutMs 可注入）', async () => {
    const { backend } = await makeBackend({}, { switchTimeoutMs: 20 })
    await expect(backend.activateModelProfile({ profileId: 'm1', service: 'llm' })).rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
    await expect(backend.setTtsVoice({ voice: 'v1' })).rejects.toMatchObject({ code: CyreneErrorCode.TIMEOUT })
  })

  it('未连接时 activateModelProfile → NOT_CONNECTED guard', async () => {
    const backend = new RealBackend({ now: () => Date.now(), wsFactory: () => new FakeWs() })
    await backend.setToken('t')
    await expect(backend.activateModelProfile({ profileId: 'm1', service: 'llm' })).rejects.toMatchObject({ code: CyreneErrorCode.NOT_CONNECTED })
    await expect(backend.setTtsVoice({ voice: 'v1' })).rejects.toMatchObject({ code: CyreneErrorCode.NOT_CONNECTED })
  })
})

describe('RealBackend server_info.services 归一化（Task 4）', () => {
  it('getActiveModelSelection 从握手 server_info.services 归一化返回（string model / null 缺省 三态）', async () => {
    const { backend } = await makeBackend({
      llm: { model: 'deepseek/deepseek-v4-flash' },
      stt: { model: null },
      tts: { model: 'tts-voice-1' }
    })
    expect(backend.getActiveModelSelection()).toEqual({ llmProfileId: 'deepseek/deepseek-v4-flash', ttsProfileId: 'tts-voice-1' })
  })

  it('normalizeServices 防御：非对象 entry / 非 string model 忽略，不直接赋值原始 record', async () => {
    const { backend } = await makeBackend({
      llm: 'bad-shape',
      stt: { model: 123 },
      tts: {},
      extra: { model: 'ignored' }
    })
    expect(backend.getActiveModelSelection()).toEqual({})
  })
})

describe('FrameMapper result 帧 → 领域事件（Task 4）', () => {
  const mapper = new FrameMapper({ connectionId: 'test-conn' })

  it('switch_model_result → switch_model.result 事件过 parseBackendEvent（带 envelope）', () => {
    const ev = mapper.mapFrame({ type: 'switch_model_result', service: 'llm', model: 'deepseek/deepseek-v4-flash', ok: true, error: 'X: y' })
    expect(ev).toMatchObject({ event: 'switch_model.result', service: 'llm', model: 'deepseek/deepseek-v4-flash', ok: true, error: 'X: y' })
    expect(ev && parseBackendEvent(ev).success).toBe(true)
    // ok 事件无 error 字段（省略展开）
    const okEv = mapper.mapFrame({ type: 'switch_model_result', service: 'tts', model: 'm', ok: false })
    expect('error' in (okEv as object)).toBe(false)
  })

  it('set_tts_voice_result → set_tts_voice.result 事件过 parseBackendEvent（voice 可选）', () => {
    const ev = mapper.mapFrame({ type: 'set_tts_voice_result', ok: true, voice: 'v1' })
    expect(ev).toMatchObject({ event: 'set_tts_voice.result', ok: true, voice: 'v1' })
    expect(ev && parseBackendEvent(ev).success).toBe(true)
    const noVoice = mapper.mapFrame({ type: 'set_tts_voice_result', ok: false, error: 'E: 失败' })
    expect(noVoice).toMatchObject({ event: 'set_tts_voice.result', ok: false, error: 'E: 失败' })
    expect('voice' in (noVoice as object)).toBe(false)
    expect(noVoice && parseBackendEvent(noVoice).success).toBe(true)
  })
})
