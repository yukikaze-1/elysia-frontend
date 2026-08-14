// tests/integration/protocol-media-handler.spec.ts
// Task 17:协议 handler 媒体分支实测（spec §4.4/D1）——launchApp + main 进程 net.fetch 直接命中真实 protocol.handle。
// P2-7：本文件改真集成（不再与 Task 8 media-service.spec 单测重复）——断言的 403/404 决策（host/parseMediaPath/
// MediaService 白名单）都经真实 handler 媒体分支执行；MediaService.stream 的 Range/重签/206 细节由 Task 8 单测覆盖。
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { launchApp, closeApp, type LaunchedApp } from './helpers/app'

let launched: LaunchedApp
beforeAll(async () => { launched = await launchApp() })
afterAll(async () => { if (launched) await closeApp(launched) })

const fetchStatus = (url: string): Promise<number> =>
  launched.app.evaluate(async ({ net }, u) => {
    try { return (await net.fetch(u)).status } catch { return -1 }
  }, url)

describe('protocol.handle 媒体分支（spec §4.4/D1）', () => {
  it('非 renderer host 的媒体前缀仍 404（host 校验先于媒体路由）', async () => {
    expect(await fetchStatus('cyrene://evil/__cyrene-media/attachment/att_1')).toBe(404)
  })
  it('畸形媒体路径 → 403（parseMediaPath 拒，不落到文件服务）', async () => {
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/attachment/att_1/x')).toBe(403)
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/bogus/att_1')).toBe(403)
  })
  it('attachment 分支经 MediaService 决策（非法 attachmentId → 403，非文件服务 404）', async () => {
    // 若媒体分支未接线，该路径会按渲染根文件 404；403 证明 resolveMedia→MediaService.stream 已执行
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/attachment/evil')).toBe(403)
  })
  it('sticker id 白名单外 → 403（MediaService.sticker 白名单经 handler 生效）', async () => {
    expect(await fetchStatus('cyrene://renderer/__cyrene-media/sticker/ST_1')).toBe(403)
  })
})
