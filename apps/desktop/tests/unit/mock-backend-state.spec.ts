import { describe, expect, it } from 'vitest'
import { MockBackend } from '../../src/main/transport/mock-backend'

describe('MockBackend 连接状态', () => {
  it('getConnectionState 初始 disconnected,connect 后 connected', async () => {
    const b = new MockBackend()
    expect(b.getConnectionState().status).toBe('disconnected')
    await b.connect({ serverUrl: 'mock://test' })
    expect(b.getConnectionState().status).toBe('connected')
    await b.disconnect()
    expect(b.getConnectionState().status).toBe('disconnected')
  })

  it('connect/disconnect 触发 onConnectionStateChange', async () => {
    const states: string[] = []
    const b = new MockBackend({ onConnectionStateChange: (s) => states.push(s.status) })
    await b.connect({ serverUrl: 'mock://test' })
    await b.disconnect()
    expect(states).toContain('connected')
    expect(states).toContain('disconnected')
  })
})

describe('MockBackend 附件确定性（spec §3.2 MockBackend 需扩展）', () => {
  it('uploadAttachments 返回确定性 AttachmentInfo（kind 权威，size 用客户端声明）', async () => {
    const mb = new MockBackend({ now: () => new Date('2026-08-14T00:00:00Z') })
    await mb.connect({ serverUrl: 'mock://local' })
    const infos = await mb.uploadAttachments([{ name: 'a.png', mediaType: 'image/png', size: 2, bytes: new Uint8Array([0x89, 0x50]) }])
    expect(infos).toHaveLength(1)
    expect(infos[0].attachmentId).toMatch(/^att_/)
    expect(infos[0].kind).toBe('image')
    expect(infos[0].size).toBe(2)
    expect(infos[0].url).toMatch(/^\/api\/attachments\/att_/)
    expect(infos[0].filename).toBe('a.png')
  })
  it('signAttachmentUrl 返回假签名 URL（可解析、expiresAt 为注入时钟 ISO）', async () => {
    const mb = new MockBackend({ now: () => new Date('2026-08-14T00:00:00Z') })
    await mb.connect({ serverUrl: 'mock://local' })
    const r = await mb.signAttachmentUrl('att_1')
    expect(r.url).toContain('/api/attachments/att_1?')
    expect(r.url).toContain('sig=')
    expect(r.expiresAt).toBe('2026-08-14T00:00:00.000Z')
  })
})
