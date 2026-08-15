import { describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'

function makeBackend() { return new MockBackend({}) }

describe('MockBackend model services', () => {
  it('listModelProfiles 返回三类内置 + 空 custom', async () => {
    const p = await makeBackend().listModelProfiles()
    expect(p.some((x) => x.type === 'llm' && x.builtIn)).toBe(true)
    expect(p.some((x) => x.type === 'stt')).toBe(true)
    expect(p.some((x) => x.type === 'tts')).toBe(true)
    expect(p.some((x) => x.source === 'custom')).toBe(false)
  })
  it('saveModelProfile 后 custom 出现在列表；同名更新幂等', async () => {
    const b = makeBackend()
    await b.saveModelProfile({ type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com', apiKey: 'k', makeActive: false })
    const list = await b.listModelProfiles('llm')
    expect(list.filter((x) => x.source === 'custom')).toHaveLength(1)
    expect(list.find((x) => x.id === 'custom/my-llm')?.credentialStatus).toBe('configured')
    await b.saveModelProfile({ type: 'llm', name: 'my-llm', baseUrl: 'https://api.example.com', apiKey: 'k2', makeActive: false })
    expect((await b.listModelProfiles('llm')).filter((x) => x.source === 'custom')).toHaveLength(1)
  })
  it('saveModelProfile 后 custom 条目携带全量 baseUrl（编辑回填用；P4-A final review）', async () => {
    const b = makeBackend()
    await b.saveModelProfile({ type: 'llm', name: 'my-llm', baseUrl: 'http://api.example.com:8080/v1', apiKey: 'k' })
    const p = (await b.listModelProfiles('llm')).find((x) => x.id === 'custom/my-llm')
    expect(p?.baseUrl).toBe('http://api.example.com:8080/v1')
    expect(p?.endpointLabel).toBe('api.example.com:8080')
  })
  it('previewTts 返回合法 WAV（RIFF 头 + 44 字节头 + 静音数据），<audio> 可解码（P4-A final review）', async () => {
    const r = await makeBackend().previewTts({})
    expect(r.ok).toBe(true)
    expect(r.mime).toBe('audio/wav')
    const bytes = r.bytes as Uint8Array
    expect(bytes.byteLength).toBeGreaterThan(44)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
  })
  it('deleteModelProfile 激活中 → PROFILE_IN_USE', async () => {
    const b = makeBackend()
    await b.activateModelProfile({ profileId: 'custom/my-llm', service: 'llm' })
    await expect(b.deleteModelProfile('llm', 'my-llm')).rejects.toMatchObject({ details: { code: 'PROFILE_IN_USE' } })
  })
  it('setTtsVoice 更新 currentVoice，activateModelProfile 更新 active 选择', async () => {
    const b = makeBackend()
    await b.setTtsVoice({ voice: 'v2' })
    expect((await b.listTtsVoices()).current).toBe('v2')
    await b.activateModelProfile({ profileId: 'deepseek/deepseek-v4-flash', service: 'llm' })
    expect(b.getActiveModelSelection().llmProfileId).toBe('deepseek/deepseek-v4-flash')
  })
})
