// tests/integration/persistence-lifecycle.spec.ts —— spec §5：经 IPC 持久化生命周期（写→读→删）+ 淘汰告知 + IPC 大小上限 + 损坏隔离。
// 断言文件存在 + schemaVersion + 条目结构；草稿/缓存为敏感内容，不读正文断言（只比 schemaVersion/条目数/ID）。
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

// 直接读测试进程可见的 userData 文件（launchApp 返回 userData 根；app userData = join(userData, 'Cyrene')）。
// 不在 app.evaluate 内用 require——eslint no-require-imports 只对 .cjs 关，且测试进程读文件即可。
async function readJsonFile(launched: LaunchedApp, relPath: string): Promise<unknown> {
  return JSON.parse(readFileSync(join(launched.userData, 'Cyrene', relPath), 'utf8'))
}
async function readDir(launched: LaunchedApp, relPath: string): Promise<string[]> {
  return readdirSync(join(launched.userData, 'Cyrene', relPath))
}
function msg(id: string, t: string) {
  return { messageId: id, conversationId: 'conv-1001', role: 'user' as const, content: 'hi', status: 'completed' as const, createdAt: t }
}

describe('持久化生命周期（spec §5）', () => {
  it('persistSession/cacheMessages → 文件出现预期行 + hydrate 回读一致 + deleteConversation purge（含缓存会话列表，评审 P2-1）', async () => {
    // P2-1：预置缓存会话列表含 conv-1001（无该种子断言无从验证删除联动清理列表）
    // 注：deleteConversation 走 MockBackend（仅 conv-1001/conv-1002 存在），故用真实 mock 会话 id（计划写 c1 与 mock 状态不符，偏差）
    const launched = await launchApp([{ relPath: 'app-cache/message-cache-v1.json', content: JSON.stringify({ schemaVersion: 1, conversations: [{ id: 'conv-1001', title: '会话', updatedAt: 't1' }], snapshots: {} }) }])
    try {
      const { page } = launched
      await page.evaluate(() => window.desktopApi.persistSession({ conversationId: 'conv-1001', draft: { text: '草稿', updatedAt: 't1' }, scrollAnchor: { messageId: 'm1', offset: 5 } }))
      // msg() 定义在测试进程（Node），page.evaluate 回调被序列化到渲染进程、无法闭包外部作用域——把消息对象作为 evaluate 参数传入
      await page.evaluate((m) => window.desktopApi.cacheMessages({ conversationId: 'conv-1001', messages: [m], updatedAt: 't1' }), msg('m1', 't1'))
      const drafts = (await readJsonFile(launched, 'app-cache/drafts-v1.json')) as { schemaVersion: number; entries: Record<string, unknown> }
      expect(drafts.schemaVersion).toBe(1)
      expect(Object.keys(drafts.entries)).toContain('conv-1001')
      const cache = (await readJsonFile(launched, 'app-cache/message-cache-v1.json')) as { schemaVersion: number; snapshots: Record<string, { messages: unknown[] }> }
      expect(cache.schemaVersion).toBe(1)
      expect(cache.snapshots['conv-1001'].messages).toHaveLength(1)
      const h = await page.evaluate(() => window.desktopApi.hydratePersistence())
      expect(h.drafts.find((d) => d.conversationId === 'conv-1001')?.text).toBe('草稿')
      expect(h.scrollAnchors['conv-1001']).toEqual({ messageId: 'm1', offset: 5 })
      expect(h.messageSnapshots['conv-1001']).toHaveLength(1)
      expect(h.conversations.some((c) => c.id === 'conv-1001')).toBe(true) // P2-1：删除前缓存列表含 conv-1001
      // deleteConversation → Main purge 草稿+锚点+快照+缓存会话列表（spec §4.5.1 + P2-1 删除联动）
      await page.evaluate(() => window.desktopApi.deleteConversation('conv-1001'))
      const h2 = await page.evaluate(() => window.desktopApi.hydratePersistence())
      expect(h2.drafts.find((d) => d.conversationId === 'conv-1001')).toBeUndefined()
      expect(h2.messageSnapshots['conv-1001']).toBeUndefined()
      expect(h2.conversations.some((c) => c.id === 'conv-1001')).toBe(false) // P2-1：删除联动清理缓存会话列表
    } finally { await closeApp(launched) }
  })

  it('persistSession 触发 50 会话淘汰 → 响应含 evictedConversationIds（P2-1）', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      const last = await page.evaluate(async () => {
        let res: { evictedConversationIds?: string[] } = {}
        for (let i = 0; i < 52; i++) {
          res = await window.desktopApi.persistSession({ conversationId: `c${i}`, draft: { text: `d${i}`, updatedAt: `t${String(i).padStart(3, '0')}` }, scrollAnchor: null })
        }
        return res
      })
      expect(last.evictedConversationIds?.length ?? 0).toBeGreaterThan(0)
    } finally { await closeApp(launched) }
  })

  it('cacheMessages 超 4MiB 整批拒绝（IPC_MESSAGE_TOO_LARGE，P1-2）', async () => {
    const launched = await launchApp()
    try {
      const { page } = launched
      const big = Array.from({ length: 60 }, (_, i) => ({ ...msg(`m${i}`, `t${i}`), content: 'x'.repeat(80_000) }))
      const err = await page.evaluate(async (messages) => {
        try { await window.desktopApi.cacheMessages({ conversationId: 'c1', messages, updatedAt: 't' }); return null }
        catch (e) { return (e as Error).message }
      }, big)
      expect(err).toContain('IPC_MESSAGE_TOO_LARGE')
    } finally { await closeApp(launched) }
  })

  it('损坏恢复：启动前预置非法 JSON 缓存文件 → hydrate 空不抛 + .corrupt-<ts> 隔离文件存在（spec §4.5.2）', async () => {
    const launched = await launchApp([{ relPath: 'app-cache/message-cache-v1.json', content: '{ 损坏 非法 JSON' }])
    try {
      const { page } = launched
      const h = await page.evaluate(() => window.desktopApi.hydratePersistence())
      expect(h.conversations).toEqual([])
      const files = await readDir(launched, 'app-cache')
      expect(files.some((f) => f.startsWith('message-cache-v1.json.corrupt-'))).toBe(true)
    } finally { await closeApp(launched) }
  })
})
