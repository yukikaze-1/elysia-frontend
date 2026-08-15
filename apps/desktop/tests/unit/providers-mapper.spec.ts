import { describe, expect, it } from 'vitest'
import { providersToModelProfiles, type ProvidersResponseWire } from '../../src/main/transport/providers-mapper'

const WIRE: ProvidersResponseWire = {
  llm: { deepseek: { models: ['deepseek-v4-flash', 'deepseek-r1'], credentialConfigured: true, runtime: 'backend', capabilities: { auth: 'api_key' } } },
  stt: { 'sensevoice/sense-voice': { models: ['sense-voice'], credentialConfigured: false, runtime: 'backend', capabilities: {} } },
  tts: {},
  custom: { llm: [{ name: 'my-llm', base_url: 'https://api.example.com', models: ['m1'], runtime: 'backend', credentialConfigured: true, capabilities: {} }] },
  unconfigured: { llm: [{ name: 'openai', env_vars: ['OPENAI_API_KEY'] }] }
}

describe('providersToModelProfiles', () => {
  it('内置 provider 每 model 展开一条，id=<provider>/<model>', () => {
    const out = providersToModelProfiles(WIRE)
    const deepseek = out.filter((p) => p.provider === 'deepseek')
    expect(deepseek).toHaveLength(2)
    expect(deepseek[0].id).toBe('deepseek/deepseek-v4-flash')
    expect(deepseek[0].source).toBe('built_in')
    expect(deepseek[0].credentialStatus).toBe('configured')
  })

  it('custom 条目一条，id=custom/<name>，provider=custom', () => {
    const out = providersToModelProfiles(WIRE).filter((p) => p.source === 'custom')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('custom/my-llm')
    expect(out[0].provider).toBe('custom')
    expect(out[0].model).toBe('my-llm')
    expect(out[0].endpointLabel).toBe('api.example.com')
  })

  it('custom base_url 全量携带 baseUrl（scheme/path 保留）；endpointLabel 仍为 host 脱敏（P4-A final review）', () => {
    const wire: ProvidersResponseWire = {
      ...WIRE,
      custom: { llm: [{ name: 'my-llm', base_url: 'http://api.example.com:8080/v1', models: [], runtime: 'backend', credentialConfigured: false, capabilities: {} }] }
    }
    const out = providersToModelProfiles(wire).filter((p) => p.source === 'custom')
    expect(out).toHaveLength(1)
    expect(out[0].baseUrl).toBe('http://api.example.com:8080/v1')
    expect(out[0].endpointLabel).toBe('api.example.com:8080')
  })

  it('empty models 的 provider 展开为一条（model 用 provider 名兜底），不会静默丢弃', () => {
    const wire: ProvidersResponseWire = { ...WIRE, stt: { x: { models: [], credentialConfigured: false, runtime: 'backend', capabilities: {} } } }
    const out = providersToModelProfiles(wire)
    expect(out.some((p) => p.id === 'x/x')).toBe(true)
  })
})
