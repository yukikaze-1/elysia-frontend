// tests/unit/ipc-chat-send.spec.ts
//
// 2026-09-16 审计 P2：`clientMessageId` 上行在 IPC 边界被静默剥掉。
//
// 链路原本三缺一：renderer 填（`message.store.ts` 的 send 载荷）→ preload 原样透传
// （`desktop-api.ts` 的 `invokeWithArgs(chatSend, input)`，对**请求**不做校验）→ Main 的
// `chatSendSchema` **没有声明该字段** ⇒ zod 默认 strip 把它丢掉 → `real-backend.ts` 里
// `if (input.clientMessageId)` 永不成立。两份维护文档（doc 16 / doc 18）记「已做/已上行」。
//
// 后果的严重性不在运行期（ACK 的 messageId 是必填、real/mock 恒回 serverMessageId），
// 而在**决策污染**：doc 18 的 C-18-2 跨仓请求建立在这个假前提上。
//
// 故本 spec 断言的是**跨过 IPC 那一跳之后**的值，而不是直接调 adapter（既有
// `real-backend.spec.ts:337-354` 正是直调 adapter，因此对这条缺陷零判别力）。
import { describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '@shared/contracts/ipc'

// `registerChatHandlers` 与 tool-handlers 不同：它不接受注入的注册器，直接调 ipc/registry 的
// `registerHandler`（那会碰真实 ipcMain）。故 mock 掉注册器本身，只收集注册结果——
// 但 `createIpcHandler`（真正做 zod 校验的那一跳）保持**真实**，本 spec 要验的正是它。
const h = vi.hoisted(() => ({
  registered: [] as Array<{ ch: string; ex: (input: unknown) => Promise<unknown>; arity: number }>
}))
vi.mock('../../src/main/ipc/registry', () => ({
  registerHandler: (ch: string, ex: unknown, arity: number) => {
    h.registered.push({ ch, ex: ex as (input: unknown) => Promise<unknown>, arity })
  }
}))

const { registerChatHandlers } = await import('../../src/main/chat/chat-handlers')

function setup(): { send: ReturnType<typeof vi.fn>; byChannel: Map<string, (input: unknown) => Promise<unknown>> } {
  h.registered.length = 0
  const send = vi.fn().mockResolvedValue({ clientRequestId: 'req-1', serverMessageId: 'msg-1' })
  registerChatHandlers({
    svc: { send } as never,
    sanitize: (x: string) => x,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never
  })
  return { send, byChannel: new Map(h.registered.map((r) => [r.ch, r.ex])) }
}

describe('chatSend IPC 边界（2026-09-16 审计 P2：clientMessageId 上行）', () => {
  it('clientMessageId 必须穿过 IPC 边界到达 adapter（schema 不声明就会被 zod strip 掉）', async () => {
    const { send, byChannel } = setup()

    const res = await byChannel.get(IpcChannels.chatSend)!({
      conversationId: 'conv-1', text: '你好', clientRequestId: 'req-1', clientMessageId: 'cmsg-1'
    })

    expect(res).toMatchObject({ ok: true })
    expect(
      send,
      'renderer 填了、preload 透传了，唯独 Main 的 schema 没声明 ⇒ 字段到不了 adapter'
    ).toHaveBeenCalledWith(expect.objectContaining({ clientMessageId: 'cmsg-1' }))
  })

  it('未提供 clientMessageId 时照常通过，且不留下该键（可选字段，不新增必填门）', async () => {
    const { send, byChannel } = setup()

    const res = await byChannel.get(IpcChannels.chatSend)!({
      conversationId: 'conv-1', text: '你好', clientRequestId: 'req-1'
    })

    expect(res).toMatchObject({ ok: true })
    expect(send.mock.calls[0][0]).not.toHaveProperty('clientMessageId')
  })

  it('空串 clientMessageId 被拒（min(1)，与 clientRequestId 同口径）', async () => {
    const { send, byChannel } = setup()

    const res = await byChannel.get(IpcChannels.chatSend)!({
      conversationId: 'conv-1', text: '你好', clientRequestId: 'req-1', clientMessageId: ''
    })

    expect(res).toMatchObject({ ok: false, error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(send).not.toHaveBeenCalled()
  })
})
