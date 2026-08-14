// tests/unit/sticker-contract.spec.ts
// 阶段3 联调前整改 D3（spec §4.4）：后端 category=sticker 真实形状响应 → Schema → IPC 双 schema → Mapper → History Store 可展示 + 跳转。
// env=node：fixture 驱动，无后端；store 用 setDesktopApi 注入（既有注入方式）。
import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { parseRestSearchMessages } from '../../src/main/transport/protocol-v2/rest-schemas'
import { RestMapper } from '../../src/main/transport/protocol-v2/rest-mapper'
import { chatQueryHistorySchema } from '../../src/main/ipc/channels'
import { ChatHistoryPageSchema } from '../../src/shared/schemas/ipc-response'
import { setDesktopApi } from '../../src/renderer/src/stores/desktop-api'
import { useHistoryViewerStore } from '../../src/renderer/src/stores/historyViewer.store'

/** 后端 SearchMessagesResponse 真实形状（无 resource/kind/url；None 可选字段省略——wire_dict 行为） */
const realStickerSearch = {
  items: [
    // 纯贴图消息：snippet 空串、无 responseId/segmentId
    { conversationId: 'c1', messageId: 'm1', role: 'user', timestamp: '2026-08-14T04:00:00.000Z', snippet: '' },
    // 文字+贴图消息：snippet 非空，responseId 有值、segmentId 省略
    { conversationId: 'c2', messageId: 'm2', role: 'assistant', responseId: 'gen-9', timestamp: '2026-08-14T05:00:00.000Z', snippet: '给你发了张表情' }
  ],
  has_more: false
}

describe('D3 贴图真实契约（category=sticker 真实形状）', () => {
  it('真实形状过严格 Schema（.strict 拒多余键，不伪造富化）', () => {
    const parsed = parseRestSearchMessages(realStickerSearch)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.items).toHaveLength(2)
      expect(parsed.data.items[0].snippet).toBe('')      // 空 snippet 可过
      expect('resource' in parsed.data.items[0]).toBe(false)  // 真实形状无 resource 键（类型上亦无此键）
    }
  })

  it('Mapper 产可展示 ChatHistoryItem（空 snippet 缺省；conversationId/messageId 可跳转）', () => {
    const parsed = parseRestSearchMessages(realStickerSearch)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const mapper = new RestMapper()
      const page = { items: parsed.data.items.map((i) => mapper.toChatHistoryItem(i)), hasMore: false }
      expect(page.items[0]).toMatchObject({ hitId: 'c1:m1:', conversationId: 'c1', messageId: 'm1', senderLabel: 'user' })
      expect(page.items[0].snippet).toBeUndefined()       // 空 snippet 不写字段（组件显示「（无文本命中）」）
      expect(page.items[1].snippet).toBe('给你发了张表情')
      expect(page.items[1].responseId).toBe('gen-9')
      // IPC 响应方向：ChatHistoryPageSchema 校验通过
      const respOk = ChatHistoryPageSchema.safeParse(page)
      expect(respOk.success).toBe(true)
    }
  })

  it('请求方向：store 构造的 sticker 查询过 chatQueryHistorySchema', () => {
    const query = {
      scope: { type: 'all_conversations' as const },
      timeZone: 'Asia/Shanghai',
      category: 'sticker' as const,
      limit: 20
    }
    const ok = chatQueryHistorySchema.safeParse(query)
    expect(ok.success).toBe(true)
  })

  it('History Store：sticker 搜索页可展示 + jumpTo 返回跳转字段', async () => {
    setActivePinia(createPinia())
    const parsed = parseRestSearchMessages(realStickerSearch)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const mapper = new RestMapper()
    const page = { items: parsed.data.items.map((i) => mapper.toChatHistoryItem(i)), hasMore: false }
    setDesktopApi({ queryChatHistory: async () => page } as never)
    const s = useHistoryViewerStore()
    s.openViewer('sticker')
    s.$patch({ category: 'sticker' })
    await s.submitQuery()
    expect(s.hasSearched).toBe(true)
    expect(s.items).toHaveLength(2)
    const hit = s.items[0]
    const jump = s.jumpTo(hit)
    expect(jump).toEqual({ conversationId: 'c1', messageId: 'm1', segmentId: undefined })
  })
})
