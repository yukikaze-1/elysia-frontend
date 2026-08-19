import { describe, expect, it, vi } from 'vitest'
import { createToolStatusSender } from '../../src/main/tools/tool-status-sender'

describe('createToolStatusSender', () => {
  it('发送 + 审计 tool:status-sent', async () => {
    const submit = vi.fn().mockResolvedValue(undefined); const audit: any[] = []
    const s = createToolStatusSender({ adapter: { submitToolResult: submit, uploadToolAttachment: async () => ({ url: 'u', mimeType: 't' }) }, audit: (e) => audit.push(e) })
    await s.send({ callId: 'c1', status: 'result', toolName: 'desktop.file.read', toolVersion: '1.0', runtime: 'desktop', paramHash: 'x'.repeat(64) })
    expect(submit).toHaveBeenCalled()
    expect(audit.at(-1)?.type).toBe('tool:status-sent')
  })
  it('发送失败 → 返回 false（statusSent 由调用方置位）', async () => {
    const s = createToolStatusSender({ adapter: { submitToolResult: async () => { throw new Error('offline') }, uploadToolAttachment: async () => ({ url: 'u', mimeType: 't' }) }, audit: () => {} })
    expect(await s.send({ callId: 'c', status: 'result', toolName: 't', toolVersion: '1', runtime: 'desktop', paramHash: 'h' })).toBe(false)
  })
  it('附件先上传后回填（H1 响应仅 url，mimeType 本地回填）', async () => {
    const upload = vi.fn().mockResolvedValue({ url: 'https://api/up/1' })
    const s = createToolStatusSender({ adapter: { submitToolResult: async () => {}, uploadToolAttachment: upload }, audit: () => {} })
    const att = await s.uploadToolAttachment('c1', new Uint8Array([1]), 'image/png', 'a.png')
    expect(upload).toHaveBeenCalledWith('c1', expect.any(Uint8Array), 'image/png', 'a.png')
    expect(att).toEqual({ url: 'https://api/up/1', mimeType: 'image/png', label: 'a.png' })
  })
})
