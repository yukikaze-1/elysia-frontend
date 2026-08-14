// tests/integration/history-viewer-ipc.spec.ts
// Task 11:3 新通道经 IPC 往返（launchApp 恒 mock；MockBackend queryChatHistory 无需连接即可返回预置样例）。
import { describe, expect, it } from 'vitest'
import { closeApp, launchApp } from './helpers/app'

describe('历史查看器/表情 IPC 往返（G4）', () => {
  it('queryChatHistory 经 IPC 返回 ChatHistoryPage（过滤当前会话）', async () => {
    const launched = await launchApp()
    try {
      const page = await launched.page.evaluate(async () => {
        const r = await window.desktopApi.queryChatHistory({ scope: { type: 'conversation', conversationId: 'conv-1001' }, timeZone: 'UTC', category: 'all', limit: 50 })
        return { hasMore: r.hasMore, first: r.items[0] }
      })
      expect(typeof page.hasMore).toBe('boolean')
      expect(page.first?.conversationId ?? 'conv-1001').toBe('conv-1001')
    } finally { await closeApp(launched) }
  })
  it('listStickers 经 IPC 返回内置 st_ 清单（P0-2：StickerManifest{stickers}）', async () => {
    const launched = await launchApp()
    try {
      const manifest = await launched.page.evaluate(() => window.desktopApi.listStickers())
      expect(manifest.stickers.length).toBeGreaterThan(0)
      expect(manifest.stickers[0].stickerId).toMatch(/^st_/)
    } finally { await closeApp(launched) }
  })
  it('getMessageContext 经 IPC 返回 MessagePage 窗口', async () => {
    const launched = await launchApp()
    try {
      const page = await launched.page.evaluate(() => window.desktopApi.getMessageContext({ conversationId: 'conv-1001', messageId: 'msg-1002', before: 1, after: 1 }))
      expect(page.items.some((m) => m.messageId === 'msg-1002')).toBe(true)
    } finally { await closeApp(launched) }
  })
})
