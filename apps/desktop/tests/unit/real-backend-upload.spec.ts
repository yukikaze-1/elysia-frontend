// tests/unit/real-backend-upload.spec.ts
// 阶段3 联调前整改 D2（spec §4.3.2）：FormData part 顺序/混合批次/已消歧 kind 透传不串位/响应 kind 权威/取消。
// env=node：fetchImpl 注入捕获 FormData（不真实上传）；connect 用 WS 握手 stub（既有惯例）。
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { describe, expect, it, vi } from 'vitest'
import { RealBackend } from '../../src/main/transport/real-backend'
import { CyreneErrorCode } from '../../src/shared/errors'
import type { UploadContent } from '../../src/main/transport/backend-adapter'
import type { AttachmentKind } from '../../src/shared/contracts/message'

/** 连接用 WS 握手 stub（返回 200 即可，uploadAttachments 不消费 WS 帧） */
async function connectStub(): Promise<{ port: number; close(): void }> {
  const s = createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ server: s, path: '/ws' })
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'session', conversationId: 'conv-1', messages: [], token_stats: { total: 0, byModel: {} } }))
    ws.send(JSON.stringify({ type: 'server_info', protocol_version: '2.0', server_version: '0.4.0', features: {}, services: {}, connectionId: 'conn-1' }))
    ws.send(JSON.stringify({ type: 'expression', expression: 'idle' }))
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { port: (s.address() as AddressInfo).port, close: () => { wss.close(); s.close() } }
}

function uploadBody(files: Array<{ name: string; mediaType: string; kind?: AttachmentKind }>): UploadContent[] {
  return files.map((f) => ({ name: f.name, mediaType: f.mediaType, size: 4, kind: f.kind, bytes: new Uint8Array([1, 2, 3, 4]) }))
}

describe('RealBackend.uploadAttachments multipart（D2）', () => {
  it('FormData part 顺序 kind/files/kind/files…；混合批次 kind 依次 image/video/file', async () => {
    let form: FormData | undefined
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      form = init?.body as FormData
      return new Response(JSON.stringify({ attachments: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.uploadAttachments(uploadBody([
        { name: 'a.png', mediaType: 'image/png', kind: 'image' },
        { name: 'b.mp4', mediaType: 'video/mp4', kind: 'video' },
        { name: 'c.pdf', mediaType: 'application/pdf', kind: 'file' }
      ]))
      expect(form).toBeDefined()
      expect([...form!.entries()].map(([k]) => k)).toEqual(['kind', 'files', 'kind', 'files', 'kind', 'files'])
      expect(form!.getAll('kind')).toEqual(['image', 'video', 'file'])
      expect(form!.getAll('files').map((f) => (f as File).name)).toEqual(['a.png', 'b.mp4', 'c.pdf'])
      await backend.disconnect()
    } finally { close() }
  })

  it('audio/webm + video/webm 已消歧 kind 透传不串位（顺序 audio/video）', async () => {
    let form: FormData | undefined
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      form = init?.body as FormData
      return new Response(JSON.stringify({ attachments: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      await backend.uploadAttachments(uploadBody([
        { name: 'voice.webm', mediaType: 'audio/webm', kind: 'audio' },   // upload-service 已产消歧 hint
        { name: 'clip.webm', mediaType: 'video/webm', kind: 'video' }
      ]))
      expect(form!.getAll('kind')).toEqual(['audio', 'video'])
      expect([...form!.entries()].map(([k]) => k)).toEqual(['kind', 'files', 'kind', 'files'])
      await backend.disconnect()
    } finally { close() }
  })

  it('响应 kind 与 hint 不同 → 以响应值为准（AttachmentInfo.kind 权威）', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ attachments: [{ attachmentId: 'att_9', kind: 'audio', mime: 'audio/webm', size: 4, url: '/api/attachments/att_9', filename: 'a.webm' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const infos = await backend.uploadAttachments(uploadBody([{ name: 'a.webm', mediaType: 'audio/webm', kind: 'video' }]))
      expect(infos[0]).toMatchObject({ attachmentId: 'att_9', kind: 'audio', mime: 'audio/webm' })
      await backend.disconnect()
    } finally { close() }
  })

  it('取消（signal abort）→ reject INVALID_INPUT 附件上传已取消，无迟到发送', async () => {
    const fetchImpl = vi.fn(async (_u, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const { port, close } = await connectStub()
    try {
      const backend = new RealBackend({ now: () => Date.now(), fetchImpl, uploadTimeoutMs: 5000 })
      await backend.connect({ serverUrl: `http://127.0.0.1:${port}`, token: 'tok' })
      const controller = new AbortController()
      const p = backend.uploadAttachments(uploadBody([{ name: 'a.png', mediaType: 'image/png', kind: 'image' }]), { signal: controller.signal })
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))   // C1 修正：等 fetch 进入并注册 abort 监听后再 abort（AbortSignal.any 同步先触发会挂起）
      controller.abort()
      await expect(p).rejects.toMatchObject({ code: CyreneErrorCode.INVALID_INPUT, message: '附件上传已取消' })
      await backend.disconnect()
    } finally { close() }
  })
})
