// tests/unit/message-resend-regenerate.spec.ts
// 消息操作行（doc 03 §7.5，2026-09-13）：重新发送 / 重新生成。
//
// 本文件把三条**规格原话**变成断言：
//   ① doc 12 C-03「重发同一请求不会创建两条用户消息」——重发**不新增气泡**（照搬 send() 会新增）；
//   ② doc 02 §19「同一 clientRequestId + 同摘要重发 → 返回原 ACK、不重复生成」——已确认的消息重发**复用**原 id；
//   ③ doc 02 §16.2「中断后用新 clientRequestId 重新生成」——失败消息重发与重新生成**铸新 id**。
// 另有 busy 门（生成中不得与在途请求争同一个 accumulator）与不可用判据（附件/贴图/无正文）。
//
// env=node：store 经 stores/desktop-api 注入 mock api（与 message.store.spec 同一 harness）。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMessageStore } from '../../src/renderer/src/stores/message.store'
import { useConversationStore } from '../../src/renderer/src/stores/conversation.store'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { createDesktopApiMock } from './helpers/desktop-api'
import type { Message } from '@shared/contracts'

const mockApi = createDesktopApiMock()
vi.spyOn(console, 'warn').mockImplementation(() => {})

function userMessage(over: Partial<Message> = {}): Message {
  return {
    messageId: 'u-1',
    conversationId: 'conv-1',
    role: 'user',
    content: '你好',
    status: 'acknowledged',
    clientMessageId: 'orig-req-id',
    createdAt: '2026-09-13T00:00:00.000Z',
    ...over
  }
}

function assistantMessage(over: Partial<Message> = {}): Message {
  return {
    messageId: 'a-1',
    conversationId: 'conv-1',
    role: 'assistant',
    status: 'completed',
    createdAt: '2026-09-13T00:00:01.000Z',
    assistantSegments: [{ segmentId: 's-1', segmentIndex: 0, channel: 'public_reply', kind: 'text', text: '在的', completed: true }],
    ...over
  }
}

/** 种入 store：走 loadSnapshot（store 的公开装载入口，含 conversationId 校验与 (createdAt,messageId) 排序），
 *  不伪造事件类型——首版用凭空造的 'message.appended' 事件种入，结果什么都没进去，7 条用例齐红。 */
function seed(...msgs: Message[]): void {
  useMessageStore().loadSnapshot('conv-1', msgs)
}

describe('messageStore：重新发送（doc 03 §7.5 / doc 12 C-03）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.clearAllMocks()
    useConversationStore().$patch({ currentId: 'conv-1' })
  })

  it('failed 消息重发：铸**新** clientRequestId、状态 pending→acknowledged、**不新增消息**', async () => {
    const store = useMessageStore()
    seed(userMessage({ status: 'failed' }))
    mockApi.send.mockResolvedValue({ clientRequestId: 'ignored', serverMessageId: 'srv-9' })

    const ok = await store.resendUserMessage('u-1')

    expect(ok).toBe(true)
    expect(mockApi.send).toHaveBeenCalledTimes(1)
    const payload = mockApi.send.mock.calls[0]![0]
    expect(payload).toMatchObject({ conversationId: 'conv-1', text: '你好' })
    expect(payload.clientRequestId, '失败消息的旧 id 从未到达后端 ⇒ 必须换新 id').not.toBe('orig-req-id')
    // 不新增气泡（C-03 的核心不变量）；乐观 key 迁到 serverMessageId，避免留下 local-* 悬挂 id
    expect(store.order.length).toBe(1)
    expect(store.byId['srv-9']?.status).toBe('acknowledged')
    expect(store.byId['srv-9']?.content).toBe('你好')
    expect(store.byId['u-1']).toBeUndefined()
  })

  it('已确认消息重发：**复用**原 clientRequestId（幂等重试，不重复生成）且不新增消息', async () => {
    const store = useMessageStore()
    seed(userMessage({ status: 'acknowledged' }))
    mockApi.send.mockResolvedValue({ clientRequestId: 'orig-req-id' })

    const ok = await store.resendUserMessage('u-1')

    expect(ok).toBe(true)
    expect(mockApi.send.mock.calls[0]![0].clientRequestId).toBe('orig-req-id')
    expect(store.order.length).toBe(1)
    expect(store.byId['u-1']?.status).toBe('acknowledged')
  })

  it('失败路径：状态回 failed + lastError 置位（不静默）', async () => {
    const store = useMessageStore()
    seed(userMessage({ status: 'acknowledged' }))
    mockApi.send.mockRejectedValue(new Error('后端不可用'))

    const ok = await store.resendUserMessage('u-1')

    expect(ok).toBe(false)
    expect(store.byId['u-1']?.status).toBe('failed')
    expect(store.lastError).toBeTruthy()
    expect(store.order.length).toBe(1)
  })

  it('生成中拒绝重发：不调 api.send、状态不变（与输入区禁用发送同一口径）', async () => {
    const store = useMessageStore()
    seed(userMessage({ status: 'acknowledged' }))
    store.activeGenerationId = 'gen-live'

    const ok = await store.resendUserMessage('u-1')

    expect(ok).toBe(false)
    expect(mockApi.send).not.toHaveBeenCalled()
    expect(store.byId['u-1']?.status).toBe('acknowledged')
  })

  it('不可用判据：助手消息 / 无正文 / 带附件 / 贴图消息 一律拒绝且不发请求', async () => {
    const store = useMessageStore()
    seed(
      assistantMessage(),
      userMessage({ messageId: 'u-empty', content: '' }),
      userMessage({ messageId: 'u-att', attachments: [{ attachmentId: 'att-1', kind: 'image', mediaType: 'image/png' }] }),
      userMessage({ messageId: 'u-sticker', content: '', stickerId: 'st-1' })
    )

    expect(await store.resendUserMessage('a-1')).toBe(false)
    expect(await store.resendUserMessage('u-empty')).toBe(false)
    expect(await store.resendUserMessage('u-att')).toBe(false)
    expect(await store.resendUserMessage('u-sticker')).toBe(false)
    expect(await store.resendUserMessage('不存在')).toBe(false)
    expect(mockApi.send).not.toHaveBeenCalled()
  })
})

describe('messageStore：重新生成（doc 03 §7.5 / doc 02 §16.2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setDesktopApi(mockApi)
    vi.clearAllMocks()
    useConversationStore().$patch({ currentId: 'conv-1' })
  })

  it('取该回复之前最近的一条**有正文的**用户消息，恒用新 clientRequestId，不新增消息', async () => {
    const store = useMessageStore()
    seed(
      userMessage({ messageId: 'u-1', content: '第一条' }),
      assistantMessage({ messageId: 'a-1' }),
      // 一条**无正文**的用户消息（例如纯贴图）：向前找时必须跳过它
      userMessage({ messageId: 'u-2', content: '', stickerId: 'st-1' }),
      assistantMessage({ messageId: 'a-2' })
    )
    mockApi.send.mockResolvedValue({ clientRequestId: 'new' })

    const ok = await store.regenerateFrom('a-2')

    expect(ok).toBe(true)
    expect(mockApi.send).toHaveBeenCalledTimes(1)
    const payload = mockApi.send.mock.calls[0]![0]
    expect(payload.text, '应跳过无正文的 u-2、取 u-1').toBe('第一条')
    expect(payload.conversationId).toBe('conv-1')
    expect(payload.clientRequestId).not.toBe('orig-req-id')
    expect(store.order.length, '重生成不得新增用户气泡').toBe(4)
  })

  it('拒绝：目标不是助手消息 / 之前没有可用的用户消息 / 生成中', async () => {
    const store = useMessageStore()
    seed(userMessage({ messageId: 'u-1' }), assistantMessage({ messageId: 'a-1' }))

    expect(await store.regenerateFrom('u-1'), '用户消息没有"重新生成"语义').toBe(false)
    expect(await store.regenerateFrom('不存在')).toBe(false)
    expect(await store.regenerateFrom('a-1')).toBe(true) // 正常路径（下面单独断言拒绝）
    mockApi.send.mockClear()

    store.activeGenerationId = 'gen-live'
    expect(await store.regenerateFrom('a-1')).toBe(false)
    expect(mockApi.send).not.toHaveBeenCalled()
  })

  it('之前没有用户消息（会话首条就是助手回复）→ 拒绝且不发请求', async () => {
    const store = useMessageStore()
    seed(assistantMessage({ messageId: 'a-1' }))
    expect(await store.regenerateFrom('a-1')).toBe(false)
    expect(mockApi.send).not.toHaveBeenCalled()
  })

  it('失败路径：lastError 置位并返回 false（不静默吞）', async () => {
    const store = useMessageStore()
    seed(userMessage({ messageId: 'u-1' }), assistantMessage({ messageId: 'a-1' }))
    mockApi.send.mockRejectedValue(new Error('连接已断开'))

    expect(await store.regenerateFrom('a-1')).toBe(false)
    expect(store.lastError).toBeTruthy()
  })
})
